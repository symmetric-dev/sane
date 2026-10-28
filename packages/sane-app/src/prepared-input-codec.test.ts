import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { seedAgentProfiles } from "./agent-profiles-contract";
import { decodePreparedUserInput } from "./prepared-input-codec";
import { decodePendingInputSnapshot } from "./pending-input-codec";
import { pendingFixture } from "./pending-input-fixtures";
import { PendingInputStore } from "./pending-input-store";
import { createCanonicalActivation, prepareUserInput, type CanonicalActivation, type UserInputPreparationDependencies } from "./user-input-preparation";
import { CanonicalExecutionStore } from "./canonical-execution-store";
import { ContextPackageStore } from "./context-package-store";
import type { Session } from "./history";

const body = "\uFEFF  Authored 😀\r\n[SANE CONTEXT MESSAGE v1]\n[/SANE CONTEXT SEGMENT]\n";
const id = () => crypto.randomUUID();
const pair = (): CanonicalActivation => ({
  saneExecution: { schema: 1, revision: "a".repeat(64) },
  saneContext: { version: 6, framework: "fixture pinned framework", package: { schema: 1, revision: "b".repeat(64), delivery: "standing-native-role" } },
});
type Options = { harness: "claude-code" | "opencode"; upgrade?: boolean; canonical?: boolean; model?: string; effort?: string; defaults?: { model?: string; effort?: string } };
function fixture(options: Options) {
  const profiles = seedAgentProfiles("2026-10-25T00:00:00.000Z");
  const profile = profiles.profiles.find(profile => profile.id === "template:engineering")!;
  Object.assign(profile, { harness: options.harness, model: options.model ?? "", effort: options.effort ?? "" });
  const authorityId = `sane-native-v1:${options.harness === "opencode" ? "oc" : "cc"}:${"c".repeat(64)}`;
  const session: Session | undefined = options.upgrade ? { sessionId: id(), harness: options.harness, authorityId,
    nativeSessionId: options.harness === "opencode" ? "ses_fixture" : id(), cwd: "/fixture", profileId: options.harness === "opencode" ? "base:oc" : "base:cc",
    model: "old/model", effort: "high", lastRunId: null, lastStatus: "unknown" } : undefined;
  const activation = { ...pair(), ...options.defaults };
  const calls: string[] = [];
  const deps: UserInputPreparationDependencies = {
    profiles, getSession: () => session, defaultCwd: "/fixture", conversationId: id, sourceAuthorityId: () => authorityId,
    selectedDirectory: async () => "/fixture", ensureDirectory: async () => {}, validateOpenCodeModel: () => {},
    resolveOpenCodeLaunch: async (_cwd, settings) => {
      calls.push("native-launch");
      return { agent: settings.agent ?? "build", ...(settings.model ? { model: { providerID: settings.model.split("/")[0]!, id: settings.model.slice(settings.model.indexOf("/") + 1), ...(settings.effort ? { variant: settings.effort } : {}) } } : {}) };
    },
    ...(options.canonical === false ? {} : { prepareCanonicalExecution: async () => { calls.push("canonical"); return activation; } }),
  };
  const request = { prompt: body, profileId: profile.id, ...(session ? { sessionId: session.sessionId } : {}) };
  return { deps, request, calls, activation, session, profile };
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("prepared canonical activation round-trips", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    for (const upgrade of [false, true]) {
      for (const defaults of [undefined, { model: "policy/model", effort: "high" }]) {
        test(`${harness} ${upgrade ? "upgrade" : "creation"}, ${defaults ? "policy defaults" : "no defaults"}`, async () => {
          const f = fixture({ harness, upgrade, defaults });
          const prepared = await prepareUserInput(f.request, f.deps);
          const decoded = decodePreparedUserInput(json(prepared));
          expect(decoded).toEqual(prepared);
          expect(decoded.prompt).toBe(body);
          expect(decoded.configuration.agentKind).toBe("assistant");
          expect(decoded.configuration.nativeAgentSelected).toBe(harness !== "opencode");
          expect(decoded.configuration.saneExecution).toEqual(f.activation.saneExecution);
          expect(decoded.configuration.saneContext?.package?.activation).toBe(upgrade ? "upgrade" : undefined);
          expect(f.activation.saneContext.package?.activation).toBeUndefined();
          expect(decoded.configuration.model).toBe(harness === "opencode" ? defaults?.model : undefined);
          expect(decoded.configuration.effort).toBe(harness === "opencode" ? defaults?.effort : undefined);
          expect(f.calls).toEqual(upgrade || harness === "claude-code" ? ["canonical"] : ["canonical", "native-launch"]);
          if (!upgrade && harness === "opencode") expect(decoded.nativeLaunch?.agent).toBe("build");
          expect(Object.isFrozen(decoded.configuration.saneContext?.package)).toBe(true);
        });
      }
      test(`${harness} ${upgrade ? "upgrade" : "creation"} profile settings override canonical defaults`, async () => {
        const f = fixture({ harness, upgrade, model: "profile/model", effort: "low", defaults: { model: "policy/model", effort: "high" } });
        const prepared = await prepareUserInput(f.request, f.deps);
        expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
        expect(prepared.configuration.model).toBe("profile/model");
        expect(prepared.configuration.effort).toBe("low");
      });
      test(`${harness} ${upgrade ? "upgrade" : "creation"} explicit variant survives model-default fallback`, async () => {
        const f = fixture({ harness, upgrade, effort: "low", defaults: { model: "policy/model", effort: "high" } });
        const prepared = await prepareUserInput(f.request, f.deps);
        expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
        expect(prepared.configuration.effort).toBe("low");
      });
    }
    test(`${harness} legacy creation remains compatible`, async () => {
      const f = fixture({ harness, canonical: false });
      const prepared = await prepareUserInput(f.request, f.deps);
      expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
      expect(prepared.configuration.nativeAgentSelected).toBe(true);
      expect(prepared.configuration.saneExecution).toBeUndefined();
      if (harness === "opencode") expect(prepared.nativeLaunch?.agent).toBe("sane/assistant/engineering");
    });
  }

  for (const mutate of [
    (value: any) => { value.configuration.nativeAgentSelected = true; },
    (value: any) => { delete value.configuration.agentKind; },
    (value: any) => { delete value.configuration.saneContext; },
    (value: any) => { value.configuration.saneExecution.revision = "not-a-hash"; },
    (value: any) => { value.configuration.saneContext.package.activation = "upgrade"; },
    (value: any) => { value.nativeLaunch.agent = "sane/assistant/engineering"; },
    (value: any) => { value.nativeLaunch.agent = "sane/utility/session-namer"; },
    (value: any) => { value.configuration.unrecognized = true; },
    (value: any) => { value.configuration.model = "other/model"; },
    (value: any) => { delete value.nativeLaunch; },
    (value: any) => { delete value.canonicalActivation; },
    (value: any) => { value.canonicalActivation.saneExecution.revision = "e".repeat(64); },
    (value: any) => { value.canonicalActivation.saneContext.package.revision = "e".repeat(64); },
    (value: any) => { value.canonicalActivation.saneContext.framework = "other framework"; },
    (value: any) => { value.canonicalActivation.saneContext.assignment = "worker assignment"; },
    (value: any) => { value.canonicalActivation.other = true; },
    (value: any) => { value.canonicalActivation.model = 42; },
    (value: any) => { value.canonicalActivation.effort = "variant\u007f"; },
  ]) test(`rejects inconsistent canonical creation ${mutate.toString()}`, async () => {
    const f = fixture({ harness: "opencode", defaults: { model: "policy/model", effort: "high" } });
    const value = json(await prepareUserInput(f.request, f.deps));
    expect(() => decodePreparedUserInput(value)).not.toThrow();
    mutate(value);
    expect(() => decodePreparedUserInput(value)).toThrow();
  });

  for (const harness of ["claude-code", "opencode"] as const) {
    test(`${harness} explicit model does not inherit a different policy model's variant`, async () => {
      const f = fixture({ harness, upgrade: true, model: "profile/model", defaults: { model: "policy/model", effort: "high" } });
      const prepared = await prepareUserInput(f.request, f.deps);
      expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
      expect(prepared.configuration.model).toBe("profile/model");
      expect(prepared.configuration.effort).toBeUndefined();
    });
    for (const defaults of [{ effort: "low" }, { model: "sonnet" }, { model: "/model" }, { model: "provider/" }]) {
      test(`${harness} rejects malformed canonical model/variant capture ${JSON.stringify(defaults)}`, async () => {
        const f = fixture({ harness, upgrade: true, defaults });
        const prepared = await prepareUserInput(f.request, f.deps);
        expect(() => decodePreparedUserInput(json(prepared))).toThrow();
      });
    }
    test(`${harness} raw-agent upgrade uses inferred profile selection`, async () => {
      const f = fixture({ harness, upgrade: true });
      const { profileId: _, ...request } = f.request;
      const prepared = await prepareUserInput({ ...request, agent: "engineering" }, f.deps);
      expect(prepared.requested.agent).toBe("engineering");
      expect(prepared.normalized.profileId).toBe("template:engineering");
      expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
    });
    test(`${harness} legacy upgrade preserves its previous omission semantics`, async () => {
      const f = fixture({ harness, upgrade: true, canonical: false });
      const prepared = await prepareUserInput(f.request, f.deps);
      expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
      expect(prepared.configuration.agentKind).toBeUndefined();
      expect(prepared.configuration.nativeAgentSelected).toBeUndefined();
      expect(prepared.configuration.saneExecution).toBeUndefined();
      expect(prepared.canonicalActivation).toBeUndefined();
      expect(prepared.configuration.model).toBeUndefined();
      expect(prepared.configuration.effort).toBeUndefined();
    });
  }
  test("CC does not interpret a pinned OC variant as CC effort", async () => {
    const f = fixture({ harness: "claude-code", upgrade: true, defaults: { model: "policy/model", effort: "thinking-heavy" } });
    const prepared = await prepareUserInput(f.request, f.deps);
    expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
    expect(prepared.configuration.effort).toBeUndefined();
  });
  test("CC profile aliases remain valid independently of qualified canonical defaults", async () => {
    const f = fixture({ harness: "claude-code", model: "sonnet", defaults: { model: "policy/model" } });
    const prepared = await prepareUserInput(f.request, f.deps);
    expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
    expect(prepared.configuration.model).toBe("sonnet");
  });
  test("raw user fields cannot supply an authoritative canonical activation", async () => {
    const f = fixture({ harness: "opencode", canonical: false });
    const prepared = await prepareUserInput({ ...f.request, canonicalActivation: pair(), saneExecution: pair().saneExecution }, f.deps);
    expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
    expect(prepared.canonicalActivation).toBeUndefined();
    expect(prepared.configuration.saneExecution).toBeUndefined();
    expect(prepared.nativeLaunch?.agent).toBe("sane/assistant/engineering");
  });
  for (const harness of ["claude-code", "opencode"] as const) test(`${harness} Base creation does not capture or load canonical activation`, async () => {
    const f = fixture({ harness });
    const prepared = await prepareUserInput({ ...f.request, profileId: harness === "opencode" ? "base:oc" : "base:cc" }, f.deps);
    expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
    expect(prepared.canonicalActivation).toBeUndefined();
    expect(prepared.configuration.agentKind).toBeUndefined();
    expect(f.calls).toEqual(harness === "opencode" ? ["native-launch"] : []);
  });
  test("canonical resolver data is snapshotted before later awaited callbacks", async () => {
    const f = fixture({ harness: "opencode", upgrade: true, defaults: { model: "policy/model", effort: "high" } });
    f.deps.ensureDirectory = async () => { f.activation.saneContext.framework = "mutated after capture"; f.activation.model = "other/model"; };
    const prepared = await prepareUserInput(f.request, f.deps);
    expect(prepared.configuration.saneContext?.framework).toBe("fixture pinned framework");
    expect(prepared.canonicalActivation?.model).toBe("policy/model");
    expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
    expect(Object.isFrozen(prepared.canonicalActivation?.saneContext)).toBe(true);
  });
  test("attached canonical upgrade keeps the existing explicit native-stopped acknowledgement", async () => {
    const f = fixture({ harness: "claude-code", upgrade: true });
    f.session!.attachment = { state: "ready", source: "fixture attach" };
    await expect(prepareUserInput(f.request, f.deps)).rejects.toThrow("Explicitly acknowledge");
    const prepared = await prepareUserInput({ ...f.request, nativeStopped: true }, f.deps);
    expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
    expect(prepared.configuration.attachment).toEqual(f.session!.attachment);
    const missing = json(prepared) as any; missing.nativeStopped = false;
    expect(() => decodePreparedUserInput(missing)).toThrow("native-stopped");
  });
});

describe("real pinned activation preparation", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    for (const upgrade of [false, true]) test(`${harness} ${upgrade ? "upgrade" : "creation"} round-trips the real factory/stores`, async () => {
      const root = realpathSync(mkdtempSync(join("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode", "prepared-codec-activation-")));
      try {
        const f = fixture({ harness, upgrade }), sourceRoot = resolve(import.meta.dir, "../../..");
        const stores = { execution: new CanonicalExecutionStore(sourceRoot, join(root, "execution")), context: new ContextPackageStore(sourceRoot, join(root, "context")) };
        f.deps.prepareCanonicalExecution = role => createCanonicalActivation({ kind: "assistant", role }, stores);
        const prepared = await prepareUserInput(f.request, f.deps);
        expect(decodePreparedUserInput(json(prepared))).toEqual(prepared);
        expect(prepared.configuration.saneContext?.framework).not.toBe("fixture pinned framework");
        expect(prepared.configuration.saneContext?.package?.activation).toBe(upgrade ? "upgrade" : undefined);
        expect(prepared.canonicalActivation?.saneExecution.revision).toBe(prepared.configuration.saneExecution?.revision);
        expect(prepared.prompt).toBe(body);
      } finally { rmSync(root, { recursive: true }); }
    });
  }
});

describe("established canonical queue pins", () => {
  for (const harness of ["claude-code", "opencode"] as const) test(`${harness} retains exact established activation through queue decoding`, async () => {
    const input = await pendingFixture(harness, {}, { agent: "engineering", agentKind: "assistant", nativeAgentSelected: harness !== "opencode", profileId: "template:engineering", ...pair() });
    const decoded = decodePendingInputSnapshot(json(input.snapshot));
    expect(decoded).toEqual(input.snapshot);
    expect(decoded.prepared.configuration).toEqual(decoded.prepared.expectedPrior!.configuration);
    expect(decoded.prepared.prompt).toBe(input.request.text);
    expect(Object.isFrozen(decoded.prepared.configuration.saneExecution)).toBe(true);
    const corrupt = json(input.snapshot) as any;
    corrupt.prepared.configuration.saneExecution.revision = "d".repeat(64);
    expect(() => decodePendingInputSnapshot(corrupt)).toThrow();
    const introduced = json(input.snapshot) as any;
    introduced.prepared.canonicalActivation = pair();
    expect(() => decodePendingInputSnapshot(introduced)).toThrow("new assistant identity");
    expect(decoded.prepared.canonicalActivation).toBeUndefined();
  });
  test("queue still refuses a valid staged canonical upgrade", async () => {
    const f = fixture({ harness: "opencode", upgrade: true });
    const prepared = await prepareUserInput(f.request, f.deps);
    expect(() => decodePreparedUserInput(json(prepared))).not.toThrow();
    const { snapshot } = await pendingFixture("opencode");
    expect(() => decodePendingInputSnapshot({ prepared, pins: snapshot.pins })).toThrow("established resume");
  });
  for (const harness of ["claude-code", "opencode"] as const) {
    test(`${harness} established upgrade marker remains an exact pin`, async () => {
      const activation = pair(); activation.saneContext.package!.activation = "upgrade";
      const input = await pendingFixture(harness, {}, { agent: "engineering", agentKind: "assistant", nativeAgentSelected: harness !== "opencode", profileId: "template:engineering", ...activation });
      expect(decodePendingInputSnapshot(json(input.snapshot))).toEqual(input.snapshot);
    });
    test(`${harness} worker queue preserves worker assignment and native-selection pins`, async () => {
      const activation = pair(); activation.saneContext.assignment = "fixture worker assignment";
      const input = await pendingFixture(harness, {}, { agent: "tester", agentKind: "worker", nativeAgentSelected: harness !== "opencode", profileId: "worker:tester", ...activation });
      expect(decodePendingInputSnapshot(json(input.snapshot))).toEqual(input.snapshot);
    });
    test(`${harness} historical Knowledge queue stays archival`, async () => {
      const input = await pendingFixture(harness, { agent: "knowledge" }, { agent: "knowledge", profileId: "template:knowledge", saneContext: { version: 1, framework: "archived framework" } });
      const decoded = decodePendingInputSnapshot(json(input.snapshot));
      expect(decoded).toEqual(input.snapshot);
      expect(decoded.prepared.configuration.agent).toBe("knowledge");
      expect(decoded.prepared.configuration.agentKind).toBeUndefined();
      expect(decoded.prepared.canonicalActivation).toBeUndefined();
    });
    test(`${harness} canonical queue survives a real durable store reload without reselection`, async () => {
      const root = realpathSync(mkdtempSync(join("/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode", "prepared-codec-queue-")));
      try {
        const input = await pendingFixture(harness, {}, { agent: "engineering", agentKind: "assistant", nativeAgentSelected: harness !== "opencode", profileId: "template:engineering", ...pair() });
        const storeId = id(), stages: string[] = [];
        // Persistence/codec test only: live authority is simulated; no dispatch.
        const store = new PendingInputStore(root, storeId, { validateLive: input => { stages.push(input.stage); } });
        const receipt = store.enqueue(input);
        const records = store.readRecords();
        const reloaded = new PendingInputStore(root, storeId, { validateLive: () => { throw new Error("Reload must not submit or reselect"); } });
        expect(reloaded.readRecords()).toEqual(records);
        expect(reloaded.lookup(input.request.conversationId, input.request.requestId)?.receipt).toEqual(receipt);
        expect(reloaded.lookup(input.request.conversationId, input.request.requestId)?.item.snapshot.prepared.configuration).toEqual(input.snapshot.prepared.configuration);
        expect(reloaded.get(input.request.conversationId).paused).toBe(true);
        expect(stages).toEqual(["enqueue"]);
      } finally { rmSync(root, { recursive: true }); }
    });
  }
});
