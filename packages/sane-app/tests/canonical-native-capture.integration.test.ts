import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Deliberately independent of shared-service discovery and all live-account suites.
// Run: SANE_NATIVE_CAPTURE=1 bun test packages/sane-app/tests/canonical-native-capture.integration.test.ts
const armed = process.env.SANE_NATIVE_CAPTURE === "1";
const temp = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test.skipIf(!armed)("real OpenCode session instructions reach a local mock provider byte-exactly", async () => {
  const root = mkdtempSync(join(temp, "canonical-native-capture-"));
  const save = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2) + "\n");
  console.log(`Native capture evidence: ${root}`);
  const home = join(root, "home"), cwd = join(root, "project");
  for (const path of [home, cwd, "config", "data", "state", "cache"].map(p => p.startsWith("/") ? p : join(root, p))) mkdirSync(path, { recursive: true });
  // Ancestor discovery reaches filesystem root; refuse unexpected configuration.
  for (let path = cwd; ; path = dirname(path)) {
    for (const name of ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc", "AGENTS.md"])
      if (existsSync(join(path, name))) throw new Error(`Unsafe inherited configuration: ${join(path, name)}`);
    if (dirname(path) === path) break;
  }
  const binary = process.env.SANE_NATIVE_CAPTURE_BINARY || "/Users/beto/.bun/bin/opencode";
  // Environment allowlist: no inherited provider credentials, sockets, config overrides or accounts.
  const env = { HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_DB: join(root, "native.db"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root };
  const command = async (args: string[]) => {
    const p = Bun.spawn([binary, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill("SIGKILL"), 10000);
    try { const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code) throw new Error(err); return out; } finally { clearTimeout(timer); }
  };
  const version = (await command(["--version"])).trim();
  expect(version).toBe("opencode v2.0.26");
  const paths = await command(["debug", "paths"]);
  writeFileSync(join(root, "paths.txt"), paths);
  for (const selector of ["home", "data", "config", "cache", "state", "db"]) expect((await command(["debug", "paths", selector])).trim().startsWith(root + "/")).toBe(true);
  const captures: any[] = [], checks: any[] = [], observations: any[] = [];
  let phase = "startup", sessionID = "", native: ReturnType<typeof Bun.spawn> | undefined, base = "", authorization = "";
  let childCall: { root: string; agent: string; sent: boolean } | undefined;
  let holdResponse: Promise<void> | undefined, releaseResponse: (() => void) | undefined;
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const raw = await req.text();
    const capture = { requestId: `request-${captures.length + 1}`, phase, sessionID: req.headers.get("x-capture-session") ?? sessionID, url: req.url, raw, body: JSON.parse(raw), time: new Date().toISOString() };
    captures.push(capture); save("requests.json", captures);
    const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: capture.requestId, object: "chat.completion.chunk", created: 1, model: "capture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    if (holdResponse && phase === "queued-read-only-verification") await holdResponse;
    if (childCall && !childCall.sent && capture.sessionID === childCall.root && phase === "native-child-invocation") {
      expect(capture.body.tools.some((t: any) => t.function?.name === "subagent")).toBe(true);
      childCall.sent = true;
      const args = { agent: childCall.agent, description: "Capture native child role", prompt: "CHILD_INVOCATION_PROMPT. Reply briefly.", background: false };
      return new Response(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_capture_child", type: "function", function: { name: "subagent", arguments: JSON.stringify(args) } }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    }
    const summarizing = capture.body.messages?.some((m: any) => typeof m.content === "string" && m.content.includes("You MUST summarize the conversation above"));
    const content = summarizing ? "## Objective\n- Exercise local request capture.\n\n## Requirements\n- (none)\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- Prior fixture prompts answered.\n### Active\n- Request capture.\n### Blocked\n- (none)\n\n## Next Move\n1. Answer next fixture prompt.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- (none)" : "Local fixture response.";
    return new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  // Independent watchdog ensures Bun's test timeout cannot leave an owned server alive.
  const watchdog = setTimeout(() => { native?.kill("SIGKILL"); provider.stop(true); }, 120000);
  const pluginDirectory = join(root, "execution-plugin"); mkdirSync(pluginDirectory);
  const executionSource = fileURLToPath(new URL("../../../opencode/plugins/sane/execution.ts", import.meta.url));
  const pluginEntry = "@opencode/plugin"; // Native loader supplies the host SDK, never repository's older SDK.
  writeFileSync(join(pluginDirectory, "package.json"), JSON.stringify({ name: "sane-native-capture-wrapper", type: "module", exports: "./index.ts" }));
  writeFileSync(join(pluginDirectory, "index.ts"), `import { Plugin } from ${JSON.stringify(pluginEntry)};\nimport { appendFileSync } from "node:fs";\nimport { registerExecutionOperations } from ${JSON.stringify(executionSource)};\nexport default Plugin.define({ id: "sane-execution-capture", async setup(ctx) { const dispose = await registerExecutionOperations(ctx); const registryObserver = await ctx.agent.transform(editor => { appendFileSync(${JSON.stringify(join(root, "registry-replays.ndjson"))}, JSON.stringify(editor.list()) + "\\n"); }); const observer = await ctx.session.hook("http.request", event => { event.request.headers.set("x-capture-session", event.sessionID); }); return async () => { await registryObserver.dispose(); await observer.dispose(); await dispose(); }; } });\n`);
  // Transparent read observer: preserve exact native result/error; never adapt the protocol.
  const wrapper = readFileSync(join(pluginDirectory, "index.ts"), "utf8").replace("registerExecutionOperations(ctx)", `registerExecutionOperations(new Proxy(ctx, { get(target, key) { if (key !== "agent") return Reflect.get(target, key); return new Proxy(target.agent, { get(agent, method) { if (method !== "get") return Reflect.get(agent, method); return async (...args) => { const result = await agent.get(...args); appendFileSync(${JSON.stringify(join(root, "agent-get-readbacks.ndjson"))}, JSON.stringify({ args, result }) + "\\n"); return result; }; } }); } }))`);
  writeFileSync(join(pluginDirectory, "index.ts"), wrapper);
  save("plugin-source-provenance.json", { wrapper, executionSource, executionSHA256: sha(readFileSync(executionSource, "utf8")), rpcSHA256: sha(readFileSync(join(dirname(executionSource), "execution-rpc.ts"), "utf8")), pluginEntry });
  const config = { plugins: [pluginDirectory], model: "capture/capture", update: "disable", snapshots: false, warming: false,
    experimental: { policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "capture", effect: "allow" }] },
    providers: { capture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "local-fixture-not-a-credential", timeout: 10000 }, models: { capture: { limit: { context: 128000, output: 1024 } } } } } };
  mkdirSync(join(root, "config/opencode"), { recursive: true }); save("configuration.json", config);
  writeFileSync(join(root, "config/opencode/opencode.json"), JSON.stringify(config));
  const stop = async () => { if (!native) return; native.kill("SIGTERM"); const timer = setTimeout(() => native?.kill("SIGKILL"), 3000); try { await native.exited; } finally { clearTimeout(timer); native = undefined; } };
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json", authorization }, signal: AbortSignal.timeout(20000) });
    const text = await response.text(); if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`); const parsed = text ? JSON.parse(text) : undefined; return parsed?.data ?? parsed;
  };
  const start = async () => {
    const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const port = reserve.port; reserve.stop(true); base = `http://127.0.0.1:${port}`;
    native = Bun.spawn([binary, "serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd, env, stdout: Bun.file(join(root, `native-${phase}.stdout`)), stderr: Bun.file(join(root, `native-${phase}.stderr`)) });
    for (let i = 0; i < 100; i++) { try {
      const output = readFileSync(join(root, `native-${phase}.stdout`), "utf8");
      const password = output.match(/server password (\S+)/)?.[1];
      if (!password) throw new Error("Waiting for private server password");
      authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
      const info = await api("/api/info"); save(`info-${phase}.json`, info); return;
    } catch { if (native.exitCode !== null) throw new Error("Native exited at startup"); await Bun.sleep(100); } }
    throw new Error("Native startup timed out");
  };
  const standing = "SANE_CAPTURE_STANDING_α\nExact tabs:\tvalue\r\nEnd standing.";
  const dynamic = "SANE_CAPTURE_DYNAMIC_A\nSession fixture – café.";
  const replacement = "SANE_CAPTURE_DYNAMIC_B\nReplacement bytes: β.";
  const entries = () => `/api/experimental/session/${sessionID}/instructions/entries`;
  const put = (key: string, value: string) => api(`${entries()}/${key}`, "PUT", { value });
  const record = (id: string, summary: string) => checks.push({ id, status: "passed", scope: "real-native/mock-provider request assembly", evidenceKind: "fixture", evidenceRef: join(root, "requests.json"), summary });
  const request = async (name: string, texts: string[], absent: string[] = []) => {
    phase = name; const before = captures.length;
    await api(`/api/session/${sessionID}/prompt`, "POST", { text: `Capture phase ${name}. Reply briefly.` });
    await api(`/api/experimental/session/${sessionID}/wait`, "POST");
    const matching = captures.slice(before).filter(c => c.body.messages?.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes(`Capture phase ${name}`)));
    expect(matching.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const capture of matching) {
      const system = capture.body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
      if (name === "identical-update-resume") expect(capture.body.messages.some((m: any) => m.role === "user" && String(m.content).includes("<system-update>"))).toBe(false);
      for (const text of texts) {
        const updated = text === replacement && !system.includes(text);
        const channel = updated ? capture.body.messages.filter((m: any) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("<system-update>")).map((m: any) => m.content).join("\n") : system;
        if (!channel.includes(text) || channel.split(text).length - 1 !== 1) { problems.push(`Missing or duplicated exact instruction: ${text}`); continue; }
        if (updated) expect(channel.includes('The context under "sane-dynamic" changed and supersedes the previous value:')).toBe(true);
        observations.push({ stage: "effective-model-request", evidenceKind: "fixture", observer: `real OpenCode ${version} -> loopback mock HTTP provider`, evidenceRef: join(root, "requests.json"), requestId: capture.requestId, runId: "native-capture", sessionId: sessionID, channel: updated ? "user system-update exact substring" : "system exact substring", source: "test-owned native session instruction entry", reason: name, text, sha256: sha(text) }); }
      for (const text of absent) if (JSON.stringify(capture.body.messages).includes(text)) problems.push(`Unexpected control instruction: ${text}`);
    }
    if (problems.length) checks.push({ id: name, status: "failed", scope: "real-native/mock-provider request assembly", evidenceKind: "fixture", evidenceRef: join(root, "requests.json"), summary: problems.join("; ") });
    else record(name, "Captured actual native outgoing request; instruction byte equality and multiplicity verified.");
  };
  try {
    await start();
    const schema = await api("/openapi.json"); save("openapi.json", schema);
    const create = () => api("/api/session", "POST", { title: "Local capture fixture", model: { providerID: "capture", id: "capture" }, location: { directory: cwd } });
    sessionID = (await create()).id;
    await put("sane-standing", standing); await put("sane-dynamic", dynamic);
    save("entries-initial.json", await api(entries()));
    await request("initial", [standing, dynamic]);
    await put("sane-standing", standing); await put("sane-dynamic", dynamic);
    await request("identical-update-resume", [standing, dynamic]);
    await put("sane-dynamic", replacement);
    save("entries-replaced.json", await api(entries()));
    await request("replacement", [standing, replacement]);
    await stop(); phase = "restart"; await start();
    save("entries-restarted.json", await api(entries()));
    await request("restart-resume", [standing, replacement]);
    phase = "compaction"; await api(`/api/session/${sessionID}/compact`, "POST", {}); await api(`/api/experimental/session/${sessionID}/wait`, "POST");
    save("post-compaction-session.json", await api(`/api/session/${sessionID}`));
    const exported = await api(`/api/experimental/session/${sessionID}/export`);
    save("post-compaction-export.json", exported);
    const compaction = exported.messages.findLast((m: any) => m.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction.status).toBe("completed");
    record("compaction-completed", `Native compaction record status: ${compaction.status}`);
    await request("post-compaction", [standing, replacement]);
    const mainSession = sessionID; sessionID = (await create()).id;
    await request("ordinary-control", [], [standing, dynamic, replacement, "SANE_CAPTURE_"]);
    save("trace.json", { schema: 1, runId: "native-capture", sessionId: mainSession, status: "completed", records: [] });
    phase = "execution-plugin";
    const plugins = await api("/api/plugin"), registryBefore = await api("/api/agent");
    save("plugins.json", plugins); save("agents-before.json", registryBefore);
    expect(plugins.find((p: any) => p.id === "sane-execution-capture")?.state.status).toBe("active");
    expect(JSON.stringify(registryBefore)).not.toContain("sane/assistant/");
    expect(JSON.stringify(registryBefore)).not.toContain("sane/worker/");
    record("execution-plugin-loaded", "Disposable wrapper loaded repository registerExecutionOperations with native host SDK; no preinstalled SANE agents.");
    const controlID = sessionID, controlBefore = await api(`/api/session/${controlID}`);
    const baselinePermissions = [{ action: "shell", resource: "fixture-preserved", effect: "deny" }];
    sessionID = (await api("/api/session", "POST", { title: "Execution fixture", agent: "build", permissions: baselinePermissions, model: { providerID: "capture", id: "capture" }, location: { directory: cwd } })).id;
    const rpc = async (method: string, input: unknown) => {
      try { const value = await api(`/api/rpc/sane-execution/${method}?location%5Bdirectory%5D=${encodeURIComponent(cwd)}`, "POST", { input }); save(`rpc-${method}-${phase}.json`, value); return value.output; }
      catch (error) { save(`rpc-${method}-${phase}-error.json`, { error: String(error) }); throw error; }
    };
    const executionAgent = `sane-execution-${sha(sessionID)}`;
    const operations = { sessionID, directory: cwd, agent: executionAgent, executionAgent, temperature: 0.23, model: { providerID: "capture", id: "capture" }, permissions: [{ action: "edit", resource: "*", effect: "deny" }], nativeChildren: [] as any[], delegation: {} as Record<string, string>, directChildren: [] as string[] };
    await rpc("configure", operations);
    const configured = await api(`/api/session/${sessionID}`); save("execution-configured.json", configured);
    expect(configured.agent).toBe(operations.executionAgent); expect(configured.permissions).toEqual(baselinePermissions); expect(configured.model.providerID).toBe("capture");
    const generatedRoot = await api(`/api/agent/${operations.executionAgent}`); save("execution-agent.json", generatedRoot);
    expect(generatedRoot.system).toBe(""); expect(generatedRoot.permissions.slice(0, operations.permissions.length)).toEqual(operations.permissions);
    await request("execution-configured-request", [], ["SANE_CAPTURE_"]);
    expect(captures.at(-1).body.temperature).toBeUndefined();
    record("execution-configure", "Repository plugin selected declared empty-system execution agent from initial build session; user overrides preserved, agent policy/model readback and omitted request temperature verified.");
    phase = "read-only-verification";
    const readonlyBefore = await api(`/api/session/${sessionID}`);
    save("readonly-before.json", readonlyBefore);
    try {
      await rpc("configure", { ...operations, readOnly: true });
      expect(await api(`/api/session/${sessionID}`)).toEqual(readonlyBefore);
      record("idle-read-only-verification", "readOnly configure returned receipt and exact session readback was unchanged; queued execution is separately unproven.");
    } catch (error) {
      save("readonly-after.json", await api(`/api/session/${sessionID}`));
      checks.push({ id: "idle-read-only-verification", status: "failed", scope: "real-native execution plugin", evidenceKind: "fixture", evidenceRef: join(root, "rpc-configure-read-only-verification-error.json"), summary: String(error) });
    }
    phase = "execution-child-definition";
    const childID = `sane-private-${sha(sessionID)}-reviewer`, childRole = "SANE_CHILD_ROLE_ONLY_α\nReview the bounded native task.";
    operations.nativeChildren = [{ id: childID, canonicalId: "sane/worker/reviewer", description: "Capture fixture reviewer", system: childRole, permissions: [{ action: "edit", resource: "*", effect: "deny" }], temperature: 0.31, model: { providerID: "capture", id: "capture" }, children: [] }];
    operations.directChildren = [childID]; operations.delegation = { "sane/worker/reviewer": childID };
    operations.permissions.push({ action: "subagent", resource: childID, effect: "allow" });
    await rpc("configure", operations);
    const registryAfter = await api("/api/agent"); save("agents-after.json", registryAfter);
    expect(JSON.stringify(registryAfter)).not.toContain(childRole);
    expect(JSON.stringify(registryAfter)).not.toContain("sane/assistant/");
    expect(await api(`/api/session/${controlID}`)).toEqual(controlBefore);
    record("base-settings-unchanged", "Distinct ordinary session unchanged after another session's execution configuration.");
    phase = "queued-read-only-verification";
    holdResponse = new Promise<void>(resolve => { releaseResponse = resolve; });
    const beforeBusy = captures.length;
    await api(`/api/session/${sessionID}/prompt`, "POST", { text: "Hold this local fixture request." });
    for (let i = 0; captures.length === beforeBusy && i < 100; i++) await Bun.sleep(20);
    expect(captures.length).toBeGreaterThan(beforeBusy);
    await api(`/api/session/${sessionID}/prompt`, "POST", { text: "Queued local fixture request.", delivery: "queue" });
    const queuedBefore = await api(`/api/session/${sessionID}`), inboxBefore = await api(`/api/session/${sessionID}/inbox`);
    save("queued-before.json", { session: queuedBefore, inbox: inboxBefore });
    expect(inboxBefore.length).toBeGreaterThan(0);
    await rpc("configure", { ...operations, readOnly: true });
    expect(await api(`/api/session/${sessionID}`)).toEqual(queuedBefore);
    expect(await api(`/api/session/${sessionID}/inbox`)).toEqual(inboxBefore);
    record("queued-read-only-verification", "Read-only configure while model request held and next prompt queued preserved exact session and inbox readbacks.");
    releaseResponse!(); holdResponse = undefined;
    await api(`/api/experimental/session/${sessionID}/wait`, "POST");
    await stop(); phase = "execution-restart"; await start();
    await rpc("configure", { ...operations, readOnly: true });
    expect((await api(`/api/session/${sessionID}`)).agent).toBe(executionAgent);
    await request("execution-restored-request", [], ["SANE_CAPTURE_"]);
    expect(captures.at(-1).body.temperature).toBeUndefined();
    record("execution-restart-restored", "Fresh process restored durable execution binding and generated definitions; readOnly succeeded without reconfiguration.");
    const procedure = "SANE_PARENT_PROCEDURE_MUST_NOT_REACH_CHILD";
    await put("parent-procedure", procedure);
    phase = "native-child-invocation";
    childCall = { root: sessionID, agent: childID, sent: false };
    const childStart = captures.length;
    await api(`/api/session/${sessionID}/prompt`, "POST", { text: "Invoke the bounded fixture native child." });
    await api(`/api/experimental/session/${sessionID}/wait`, "POST");
    const childCaptures = captures.slice(childStart).filter(c => c.sessionID !== sessionID);
    save("native-child-captures.json", childCaptures);
    save("native-parent-export.json", await api(`/api/experimental/session/${sessionID}/export`));
    expect(childCall.sent).toBe(true); expect(childCaptures.length).toBeGreaterThan(0);
    for (const capture of childCaptures) {
      const child = await api(`/api/session/${capture.sessionID}`); save("native-child-session.json", child);
      expect(child.parentID).toBe(sessionID); expect(child.agent).toBe(childID);
      expect(child.permissions ?? []).toEqual(baselinePermissions);
      const system = capture.body.messages.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
      expect(system.split(childRole).length - 1).toBe(1); expect(JSON.stringify(capture.body.messages)).not.toContain(procedure);
      expect(capture.body.temperature).toBeUndefined();
      expect(capture.body.tools.some((t: any) => ["edit", "write", "patch"].includes(t.function?.name))).toBe(false);
      observations.push({ stage: "effective-model-request", evidenceKind: "fixture", observer: `real OpenCode ${version} loopback HTTP capture; native hook session header`, evidenceRef: join(root, "requests.json"), requestId: capture.requestId, runId: "native-child-capture", sessionId: capture.sessionID, channel: "system", source: "repository execution plugin verified native child role", reason: "Role-only child request, no parent procedure", text: system, sha256: sha(system) });
      save("child-trace.json", { schema: 1, runId: "native-child-capture", sessionId: capture.sessionID, status: "completed", records: [] });
    }
    record("native-child-invocation", "Native subagent tool invoked generated hidden child; actual child request contains role once, no parent procedure, omitted child temperature and pre-snapshot denied edit tools verified.");
    phase = "native-parent-identity-fencing";
    const rogue = await api("/api/session", "POST", { title: "Wrong-parent fixture", agent: childID, model: operations.model, location: { directory: cwd } });
    const beforeRogue = captures.length;
    await api(`/api/session/${rogue.id}/prompt`, "POST", { text: "This unparented child must not reach provider." });
    await api(`/api/experimental/session/${rogue.id}/wait`, "POST");
    const rogueState = await api(`/api/session/${rogue.id}`); save("rogue-child-session.json", rogueState);
    expect(captures.length).toBe(beforeRogue); expect(rogueState.outcome).toBe("failed");
    record("native-parent-identity-fencing", "Selecting child alias without native ancestry failed before any provider request.");
    const executionID = sessionID; sessionID = controlID;
    await request("ordinary-after-configuration", [], [childRole, procedure, executionAgent, childID]);
    expect((await api(`/api/session/${sessionID}`)).permissions).toEqual(controlBefore.permissions);
    save("execution-trace.json", { schema: 1, runId: "native-capture", sessionId: executionID, status: "completed", records: [] });
    expect(checks.filter(c => c.status === "failed")).toEqual([]);
  } catch (error) { checks.push({ id: phase, status: "failed", scope: "real-native/mock-provider", evidenceKind: "fixture", evidenceRef: root, summary: String(error) }); throw error; }
  finally {
    releaseResponse?.();
    await stop(); provider.stop(true);
    clearTimeout(watchdog);
    for (const id of ["queued-read-only-verification", "native-parent-identity-fencing", "native-child-invocation"])
      if (!checks.some(c => c.id === id)) checks.push({ id, status: "incomplete", scope: "real-native execution plugin", evidenceKind: "fixture", evidenceRef: root, summary: "Not reached/proven; inspect execution RPC failure evidence. No production protocol workaround applied." });
    save("evidence.json", { schema: 1, checks, observations });
    save("provenance.json", { schema: 1, runtime: "real-installed-native", provider: "loopback-mock", nativeVersion: version, binary, root, realPaidModelInvoked: false, semanticComplianceTested: false, traceNote: "Empty reporter-compatible trace; no SANE App run or prepared/configured receipts fabricated.", docs: ["https://opencode.ai/v2/docs/providers", "https://opencode.ai/v2/docs/config", "https://opencode.ai/v2/docs/troubleshooting"], configSHA256: sha(JSON.stringify(config)), requests: captures.length, ownedProcessStopped: native === undefined });
    expect(existsSync(join(root, "state/opencode/service.json"))).toBe(false);
  }
}, 150000);
