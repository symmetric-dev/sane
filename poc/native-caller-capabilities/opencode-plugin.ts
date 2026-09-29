import { Plugin } from "@opencode/plugin";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { clientModules } from "./deps";
import { fields, hash, record, root } from "./evidence";

export default Plugin.define({
  id: "native-caller-capabilities",
  async setup(ctx) {
    const dir = root(typeof ctx.options.evidence === "string" ? ctx.options.evidence : undefined);
    const registration = ctx.options.registration;
    if (typeof registration !== "string" || !isAbsolute(registration)) throw new Error("Explicit absolute managed registration path required");
    const { Service, OpenCode } = await clientModules();
    await ctx.tool.transform(editor => editor.add({
      name: "native_caller_probe",
      description: "Capture native caller IDs and compare the explicitly configured managed source; no model-authored identity arguments.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, caller) => {
        const evidence: Record<string, any> = {
          caller: fields(caller, ["sessionID", "messageID", "id", "agent"]),
          pluginLocation: ctx.location.directory, registration,
          session: null, selectedSession: null, association: "unavailable", exactHostProof: "unavailable",
        };
        try {
          const local = await ctx.session.get({ sessionID: caller.sessionID });
          evidence.session = { ...fields(local, ["id", "parentID"]), directory: local.location?.directory ?? null };
          const before = readFileSync(registration, "utf8");
          const info = JSON.parse(before);
          // Correct registration shape is {id?, version?, url, pid, password?}.
          // Password/URL/raw errors are never persisted or returned.
          evidence.registrationInfo = fields(info, ["id", "pid", "version"]);
          const endpoint = await Service.discover({ file: registration });
          if (!endpoint) evidence.association = "managed-unavailable";
          else {
            evidence.endpointFingerprint = hash(endpoint.url);
            const address = new URL(endpoint.url);
            const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname);
            evidence.endpointIsLoopback = loopback;
            const selected = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
            const remote = await selected.session.get({ sessionID: caller.sessionID }, { signal: AbortSignal.timeout(10000) });
            evidence.selectedSession = { ...fields(remote, ["id", "parentID"]), directory: remote.location?.directory ?? null };
            const stable = before === readFileSync(registration, "utf8") && info.url === endpoint.url;
            evidence.registrationStable = stable;
            const match = local.id === caller.sessionID && remote.id === local.id && remote.location?.directory === local.location?.directory && (remote.parentID ?? null) === (local.parentID ?? null);
            evidence.association = !stable ? "registration-changed" : match ? "session-match-at-selected-endpoint" : "session-mismatch";
            evidence.pidComparison = info.pid === process.pid ? "same" : "different";
            if (stable && match && loopback && info.pid === process.pid) evidence.exactHostProof = "same-local-process-pid-and-healthy-registration";
            // A worker PID can differ from its host. Do not call this a proved host mismatch.
          }
        } catch { evidence.association = "unavailable-read-discovery-or-session-lookup"; }
        const event = record(dir, "opencode.caller", evidence);
        return { content: JSON.stringify({ event, ...evidence }) };
      },
    }));
  },
});
