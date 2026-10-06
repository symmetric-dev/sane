import { expect, test } from "bun:test";
import { AgentLaunchConfigurationError } from "./agent-launch";
import { ClaudeRunService, hookEvents, type ClaudeRunDependencies, type ClaudeRunRuntime } from "./claude-run-service";
import type { Event, Run, Session } from "./history";
import type { RunOwner } from "./run-owner";

const nativeId = "11111111-1111-4111-8111-111111111111";
const success = { type: "result", session_id: nativeId, subtype: "success", is_error: false };
const wire = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
const gone = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
const bytes = (chunks: string[] = []) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
const pending = <T>() => Promise.withResolvers<T>();

function fixture(stdout = bytes([wire(success)]), stderr = bytes()) {
  const run: Run = { runId: "22222222-2222-4222-8222-222222222222", sessionId: "33333333-3333-4333-8333-333333333333", cwd: "/checkout", createdAt: new Date().toISOString(), status: "running" };
  const session: Session = { sessionId: run.sessionId, cwd: run.cwd, harness: "claude-code", nativeSessionId: nativeId, lastRunId: run.runId, lastStatus: "running" };
  const owner: RunOwner = { run, done: Promise.resolve(), settled: false };
  const records: Event[] = [], calls: string[] = [], ready: boolean[] = [], sleeps: number[] = [];
  const signals: [number, NodeJS.Signals | 0][] = [], direct: NodeJS.Signals[] = [];
  const drainTimeout = pending<unknown>();
  const state = { closing: false, storageFailed: false, retained: false, reconciliationRequired: false, owns: true, failClosed: 0, refreshed: 0 };
  const writes: [string, string][] = [];
  let spawned: { args: string[]; options: Parameters<ClaudeRunRuntime["spawn"]>[1] } | undefined;
  const child = {
    pid: 987654,
    exited: Promise.resolve(0), stdout, stderr,
    stdin: { write: (prompt: string) => { calls.push(`stdin:${prompt}`); return prompt.length; }, end: () => Promise.resolve() },
    kill: (signal: NodeJS.Signals) => { direct.push(signal); },
  } as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
  const deps: ClaudeRunDependencies = {
    session: id => id === session.sessionId ? session : undefined,
    run: id => id === run.runId ? run : undefined,
    events: () => records,
    owns: candidate => candidate === owner && state.owns,
    closing: () => state.closing,
    storageFailed: () => state.storageFailed,
    retained: () => state.retained,
    requireReconciliation: () => { state.retained = state.reconciliationRequired = true; },
    failClosed: () => { state.failClosed++; state.storageFailed = state.retained = state.reconciliationRequired = true; },
    emit: async (run, kind, data) => { calls.push(`emit:${kind}`); records.push({ runId: run.runId, sessionId: run.sessionId, kind, data, seq: records.length + 1, time: new Date().toISOString() }); },
    persist: async () => { calls.push("persist"); },
    enqueue: async action => { calls.push("enqueue"); await action(); },
    execution: async () => { calls.push("execution"); return "/checkout"; },
    executionContext: async () => ({ executionCheckout: "/checkout", workstreamId: null, artifactsRoot: null }),
    compactExecution: async () => { calls.push("compactExecution"); return "/checkout"; },
    refreshCompactHistory: async () => { state.refreshed++; },
    assertWorkerDeliverySubmission: () => { calls.push("workerGate"); },
    saneSession: async () => null,
  };
  const runtime: ClaudeRunRuntime = {
    spawn: (args, options) => { calls.push("spawn"); spawned = { args, options }; return child; },
    kill: (pid, signal) => { signals.push([pid, signal]); gone(); },
    sleep: async ms => { sleeps.push(ms); if (ms === 2200) await drainTimeout.promise; },
    randomUUID: () => "secret-uuid",
    execPath: "/runtime's bun",
    env: { HOME: "/home", PATH: "/bin", CLAUDE_CONFIG_DIR: "/old", CC_WEB_HOOK_SECRET: "old-secret", OPENCODE_SERVER_URL: "old", OPENCODE_SESSION_ID: "old", OPENCODE_TOKEN: "old", SANE_CALLER_CONTEXT: "old", BUN_INSPECT: "old", NODE_OPTIONS: "old", UNRELATED: "kept", OMITTED: undefined },
    writeSettings: async (path, content) => { writes.push([path, content]); },
    agentSettings: async () => ({ agent: "sane-design", permissions: { allow: ["Read"], deny: ["Bash"] }, agentFile: { path: "/claude/agents/sane-design.md", sha256: "0".repeat(64) } }),
  };
  // Construct after tests have customized callbacks/primitives. This also makes
  // every test's runtime independent, with no global Bun/process mocks.
  const service = () => new ClaudeRunService({ dataDir: "/app", claudeRoot: "/claude", claudeBin: "/fake-claude", packageRoot: "/package's root", hookUrl: () => "http://127.0.0.1:4567" }, deps, runtime);
  const accepted = (value: boolean) => { calls.push(`ready:${value}`); ready.push(value); };
  return { run, session, owner, child, deps, runtime, state, records, calls, ready, sleeps, signals, direct, writes, drainTimeout, service, accepted, spawned: () => spawned };
}

const statusData = (f: ReturnType<typeof fixture>) => f.records.filter(record => record.kind === "status").map(record => record.data as Record<string, unknown>);
const hookInput = (f: ReturnType<typeof fixture>, event = "Stop") => ({ runId: f.run.runId, payload: { hook_event_name: event, session_id: nativeId } });
const secret = "secret-uuidsecret-uuid";

test("successful owned launch preserves journal order, flags, settings, credentials and ready callbacks", async () => {
  const f = fixture(); f.run.agent = "design"; f.run.model = "model"; f.run.effort = "high";
  await f.service().execute(f.owner, "hello", true, f.accepted);
  expect(f.run.status).toBe("completed"); expect(f.session.lastStatus).toBe("completed"); expect(f.run.endedAt).toBeString();
  expect(f.ready).toEqual([true, false]);
  expect(f.calls.slice(0, 9)).toEqual(["emit:status", "emit:submission", "persist", "execution", "enqueue", "emit:launch", "execution", "workerGate", "spawn"]);
  expect(f.calls.indexOf("ready:true")).toBeLessThan(f.calls.indexOf("stdin:hello"));
  expect(f.spawned()?.args).toEqual(["/fake-claude", "-p", "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose", "--resume", nativeId, "--settings", `/app/${f.run.runId}.settings.json`, "--agent", "sane-design", "--model", "model", "--effort", "high"]);
  expect(f.spawned()?.options).toEqual({ cwd: "/checkout", detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { HOME: "/home", PATH: "/bin", UNRELATED: "kept", CLAUDE_CONFIG_DIR: "/claude", CLAUDE_CODE_PROJECT_DIR_NAME: "", CC_WEB_HOOK_URL: "http://127.0.0.1:4567", CC_WEB_RUN_ID: f.run.runId, CC_WEB_HOOK_SECRET: secret, CC_WEB_HOOK_ERRORS: `/app/${f.run.runId}.hook-errors.jsonl` } });
  const settings = JSON.parse(f.writes[0]![1]);
  expect(Object.keys(settings.hooks)).toEqual([...hookEvents]);
  expect(settings.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "'/runtime'\\''s bun' '/package'\\''s root/hooks/forward.ts' 'Stop'", timeout: 3 });
  expect(settings.permissions).toEqual({ allow: ["Read"], deny: ["Bash"] });
  expect(f.owner.child).toBe(f.child); expect(f.owner.settled).toBe(false); // bridge releases ownership
});

test("installed source gate can withhold a Claude launch after final asynchronous execution preflight", async () => {
  const f = fixture(); let executions = 0;
  f.deps.execution = async () => { executions++; return "/checkout"; };
  f.owner.beforeSend = () => { expect(executions).toBe(2); throw new Error("installed source changed"); };
  await f.service().execute(f.owner, "immutable input", true, f.accepted);
  expect(f.calls).not.toContain("spawn"); expect(f.owner.child).toBeUndefined();
  expect(f.run.status).toBe("failed"); expect(f.ready).not.toContain(true);
  expect(f.owner.streamsDrained).toBe(true); expect(f.state.failClosed).toBe(0);
});

test("stream decoding preserves UTF-8, EOF partial lines, plain stderr and large pending chunks", async () => {
  const encoded = new TextEncoder().encode(`\n${JSON.stringify({ text: "é" })}\n${wire(success)}`), at = encoded.indexOf(0xc3) + 1;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoded.slice(0, at)); c.enqueue(encoded.slice(at)); c.close(); } });
  const f = fixture(stdout, bytes(["\n", "x".repeat(1024 * 1024 + 1), "tail\n", '{"stderr":true}']));
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.records.filter(e => e.kind === "stdout").map(e => e.data)).toEqual([{ text: "é" }, success]);
  expect(f.records.filter(e => e.kind === "stderr").map(e => e.data)).toEqual(["x".repeat(1024 * 1024 + 1), "tail", '{"stderr":true}']);
  expect(f.run.status).toBe("completed"); expect(f.spawned()?.args).toContain("--session-id");
});

const invalidResults: [string, unknown[], string | undefined][] = [
  ["missing result", [{ type: "system", subtype: "init", session_id: nativeId }], undefined],
  ["duplicate result", [success, success], "Duplicate CLI result"],
  ["missing result identity", [{ ...success, session_id: undefined }], "CLI session identity mismatch or missing session_id"],
  ["wrong init identity", [{ type: "system", subtype: "init", session_id: "wrong" }, success], "CLI session identity mismatch or missing session_id"],
  ["error result", [{ ...success, is_error: true }], "CLI result is not an explicit success"],
  ["implicit success", [{ ...success, is_error: undefined }], "CLI result is not an explicit success"],
  ["failed subtype", [{ ...success, subtype: "error" }], "CLI result is not an explicit success"],
];
for (const [name, rows, reason] of invalidResults) test(`fails closed on ${name}`, async () => {
  const f = fixture(bytes([wire(...rows)]));
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("failed"); expect(statusData(f).at(-1)?.reason).toBe(reason);
  expect(f.state.reconciliationRequired).toBe(false);
});

test("exit code and stdout result, never stderr JSON, decide success", async () => {
  const exit = fixture(); Object.assign(exit.child, { exited: Promise.resolve(1) });
  await exit.service().execute(exit.owner, "hello", false, exit.accepted);
  expect(exit.run.status).toBe("failed"); expect(statusData(exit).at(-1)?.exitCode).toBe(1);
  const stderr = fixture(bytes(), bytes([wire(success)]));
  await stderr.service().execute(stderr.owner, "hello", false, stderr.accepted);
  expect(stderr.run.status).toBe("failed"); expect(statusData(stderr).at(-1)?.resultSeen).toBe(false);
});

for (const stage of ["before preparation", "settings", "second execution", "owner lost", "worker gate", "closing", "storage"] as const) test(`no spawn when stopped/unavailable at ${stage}`, async () => {
  const f = fixture();
  if (stage === "before preparation") f.owner.stopRequested = true;
  if (stage === "settings") f.runtime.writeSettings = async () => { f.owner.stopRequested = true; };
  if (stage === "second execution") { let checks = 0; f.deps.execution = async () => { if (++checks === 2) f.owner.stopRequested = true; return "/checkout"; }; }
  if (stage === "owner lost") f.state.owns = false;
  if (stage === "worker gate") f.deps.assertWorkerDeliverySubmission = () => { throw new Error("withheld"); };
  if (stage === "closing") f.deps.persist = async () => { f.state.closing = true; };
  if (stage === "storage") f.runtime.writeSettings = async () => { f.state.storageFailed = true; };
  const service = f.service(); await service.execute(f.owner, "hello", false, f.accepted);
  expect(f.spawned()).toBeUndefined(); expect(f.ready).toEqual([false, false]);
  expect(f.run.status).toBe(["before preparation", "settings", "second execution", "closing"].includes(stage) ? "interrupted" : "failed");
  expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 403 });
});

test("ordinary /compact is rejected; dedicated compact uses compact preflight and separate evidence/refresh", async () => {
  const prompt = fixture(); await prompt.service().execute(prompt.owner, " /COMPACT instructions", true, prompt.accepted);
  expect(prompt.spawned()).toBeUndefined(); expect(prompt.records.some(e => e.kind === "submission")).toBe(false);
  const f = fixture(); f.run.operation = "compact"; f.run.compact = { requestId: "44444444-4444-4444-8444-444444444444" };
  await f.service().execute(f.owner, "/compact instructions", true, f.accepted);
  expect(f.calls.filter(c => c === "compactExecution")).toHaveLength(2); expect(f.calls).not.toContain("execution");
  expect(f.records.some(e => e.kind === "submission")).toBe(false); expect(f.state.refreshed).toBe(1);
  expect(f.run.status).toBe("completed"); expect(statusData(f).at(-1)).toMatchObject({ compactionLifecycle: "unconfirmed", reason: "CLI ended without native compaction outcome evidence; do not automatically resend" });
});

test("compact prelaunch failure and worker delivery record explicit non-submission", async () => {
  const f = fixture(); f.run.operation = "compact"; f.owner.workerDeliveryId = "delivery"; f.owner.stopRequested = true;
  await f.service().execute(f.owner, "/compact", true, f.accepted);
  expect(statusData(f)).toContainEqual({ status: "interrupted", operation: "compact", compactNotSubmitted: true, reason: "CLI launch, stream, or shutdown failure", error: "Closing before launch" });
  expect(statusData(f).at(-1)).toEqual({ status: "interrupted", workerDeliveryNotSubmitted: "delivery" });
  expect(f.state.refreshed).toBe(0);
});

test("installed agent error is returned as launchError rather than a generic failure", async () => {
  const f = fixture(); f.run.agent = "design"; f.runtime.agentSettings = async () => { throw new AgentLaunchConfigurationError("reinstall design"); };
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.owner.launchError).toBe("reinstall design"); expect(statusData(f).at(-1)?.reason).toBe("reinstall design"); expect(f.spawned()).toBeUndefined();
});

test("ready resolves at spawn, not completion; prelaunch terminate is not cached", async () => {
  const f = fixture(), preparation = pending<string>(), exit = pending<number>(), launched = pending<void>();
  f.deps.execution = () => preparation.promise; Object.assign(f.child, { exited: exit.promise });
  const service = f.service(), execution = service.execute(f.owner, "hello", false, value => { f.accepted(value); if (value) launched.resolve(); });
  expect(await service.terminate(f.owner)).toBe(true); expect(f.owner.stopping).toBeUndefined(); expect(f.ready).toEqual([]);
  preparation.resolve("/checkout"); await launched.promise;
  expect(f.ready).toEqual([true]); expect(f.run.status).toBe("running");
  exit.resolve(0); await execution; expect(f.ready).toEqual([true, false]);
});

test("hook authentication is active only during launch lifetime and checks exact session association", async () => {
  const f = fixture(), exit = pending<number>(), launched = pending<void>(); Object.assign(f.child, { exited: exit.promise });
  const service = f.service(); expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 403 });
  const execution = service.execute(f.owner, "hello", false, value => { if (value) launched.resolve(); }); await launched.promise;
  expect(await service.ingestHook("Unknown", hookInput(f), secret)).toEqual({ status: 400, body: { error: "Unknown hook" } });
  expect(await service.ingestHook("Stop", hookInput(f), "wrong")).toEqual({ status: 403, body: { error: "Forbidden" } });
  expect(await service.ingestHook("Stop", { ...hookInput(f), runId: "unknown" }, secret)).toMatchObject({ status: 403 });
  for (const payload of [undefined, null, "not an object", {}, { hook_event_name: "Stop", session_id: "wrong" }, { hook_event_name: "Notification", session_id: nativeId }]) {
    expect(await service.ingestHook("Stop", { runId: f.run.runId, payload }, secret)).toEqual({ status: 400, body: { error: "Hook association mismatch" } });
  }
  f.session.harness = "opencode"; expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 400 }); f.session.harness = "claude-code";
  f.owner.stopRequested = true; // Hooks remain valid while output is still draining.
  expect(await service.ingestHook("Stop", hookInput(f), secret)).toEqual({ status: 200, body: { ok: true } });
  expect(f.records.filter(e => e.kind === "hook").map(e => e.data)).toEqual([{ event: "Stop", payload: hookInput(f).payload }]);
  exit.resolve(0); await execution;
  expect(f.run.status).toBe("interrupted"); expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 403 });
});

test("hook journal errors propagate to the HTTP wrapper instead of reporting ok", async () => {
  const f = fixture(), exit = pending<number>(), launched = pending<void>(); Object.assign(f.child, { exited: exit.promise });
  const emit = f.deps.emit; f.deps.emit = async (run, kind, data) => { if (kind === "hook") throw new Error("hook journal unavailable"); await emit(run, kind, data); };
  const service = f.service(), execution = service.execute(f.owner, "hello", false, value => { if (value) launched.resolve(); }); await launched.promise;
  await expect(service.ingestHook("Stop", hookInput(f), secret)).rejects.toThrow("hook journal unavailable");
  exit.resolve(0); await execution;
});

test("hook secret is allocated during preparation and removed after a stopped settings write", async () => {
  const f = fixture(), writing = pending<void>(), settings = pending<void>();
  f.runtime.writeSettings = async () => { writing.resolve(); await settings.promise; };
  const service = f.service(), execution = service.execute(f.owner, "hello", false, f.accepted); await writing.promise;
  expect(f.owner.child).toBeUndefined();
  expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 200 });
  f.owner.stopRequested = true; expect(await service.terminate(f.owner)).toBe(true); expect(f.owner.stopping).toBeUndefined();
  settings.resolve(); await execution;
  expect(f.run.status).toBe("interrupted"); expect(f.spawned()).toBeUndefined();
  expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 403 });
});

for (const unavailable of ["closing", "storageFailed"] as const) test(`live ${unavailable} after spawn controls terminal status and compact refresh`, async () => {
  const f = fixture(), exit = pending<number>(), launched = pending<void>(); Object.assign(f.child, { exited: exit.promise });
  f.run.operation = "compact"; f.run.compact = { requestId: "44444444-4444-4444-8444-444444444444" };
  const service = f.service(), execution = service.execute(f.owner, "/compact", true, value => { if (value) launched.resolve(); }); await launched.promise;
  f.state[unavailable] = true; exit.resolve(0); await execution;
  expect(f.run.status).toBe(unavailable === "closing" ? "interrupted" : "failed"); expect(f.state.refreshed).toBe(0);
  expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 403 });
});

test("only ESRCH proves process-group absence; unknown errors and EPERM retain liveness", () => {
  const f = fixture(); f.owner.child = f.child;
  for (const code of ["EPERM", undefined]) { f.runtime.kill = () => { throw Object.assign(new Error("uncertain"), { code }); }; expect(f.service().groupAlive(f.owner)).toBe(true); }
  f.runtime.kill = gone; expect(f.service().groupAlive(f.owner)).toBe(false);
});

test("termination waits for child exit AND group absence, escalates, and shares a single attempt", async () => {
  const f = fixture(), exit = pending<number>(); f.owner.child = f.child; Object.assign(f.child, { exited: exit.promise }); let alive = true;
  f.runtime.kill = (pid, signal) => { f.signals.push([pid, signal]); if (signal === "SIGKILL") { alive = false; exit.resolve(0); } if (signal === 0 && !alive) gone(); };
  const service = f.service(), first = service.terminate(f.owner); expect(service.terminate(f.owner)).toBe(first);
  expect(await first).toBe(true); expect(f.direct).toEqual(["SIGTERM", "SIGKILL"]);
  expect(f.sleeps.filter(ms => ms === 20)).toHaveLength(51); expect(f.state.retained).toBe(false);
  expect(f.signals.every(([pid]) => pid === -f.child.pid)).toBe(true);
});

test("termination does not confuse direct child exit with group exit", async () => {
  const f = fixture(); f.owner.child = f.child; f.runtime.kill = (pid, signal) => { f.signals.push([pid, signal]); };
  expect(await f.service().terminate(f.owner)).toBe(false);
  expect(f.direct).toEqual(["SIGTERM", "SIGKILL"]); expect(f.sleeps).toHaveLength(100);
  expect(f.state.retained).toBe(true); expect(f.state.reconciliationRequired).toBe(true);
});

test("termination cannot be confirmed when the exited promise rejects, even if group is gone", async () => {
  const f = fixture(); f.owner.child = f.child; Object.assign(f.child, { exited: Promise.reject(new Error("wait failed")) });
  expect(await f.service().terminate(f.owner)).toBe(false); expect(f.state.reconciliationRequired).toBe(true);
});

test("direct signal errors are ignored but sleep failures require reconciliation", async () => {
  const f = fixture(); f.owner.child = f.child; Object.assign(f.child, { kill: () => { throw new Error("already gone"); } });
  expect(await f.service().terminate(f.owner)).toBe(true);
  const broken = fixture(); broken.owner.child = broken.child; broken.runtime.sleep = async () => { throw new Error("sleep failure"); };
  expect(await broken.service().terminate(broken.owner)).toBe(false); expect(broken.state.reconciliationRequired).toBe(true);
});

test("a surviving descendant triggers supervision even after successful child output", async () => {
  const f = fixture(); let alive = true;
  f.runtime.kill = (pid, signal) => { f.signals.push([pid, signal]); if (signal === "SIGTERM") alive = false; if (signal === 0 && !alive) gone(); };
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.direct).toEqual(["SIGTERM"]); expect(f.run.status).toBe("completed"); expect(f.state.retained).toBe(false);
});

test("unconfirmed group termination fails the run and retains ownership", async () => {
  const f = fixture(); f.runtime.kill = () => {};
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("failed"); expect(f.state.reconciliationRequired).toBe(true);
  expect(statusData(f).at(-1)?.reason).toBe("Process termination unconfirmed; operator reconciliation required");
});

test("synchronous stdin failure observes independently rejecting consumers and stops the child", async () => {
  const f = fixture(new ReadableStream({ start(c) { c.error(new Error("stdout failure")); } }), new ReadableStream({ start(c) { c.error(new Error("stderr failure")); } }));
  Object.assign(f.child.stdin, { write: () => { throw new Error("stdin failure"); } });
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("failed"); expect(f.direct).toEqual(["SIGTERM"]); expect(f.state.retained).toBe(false);
  expect(f.ready).toEqual([true, false, false]);
});

test("stream drainage timeout retains sentinel and retires hook secret only after drainage attempt", async () => {
  const stdout = pending<ReadableStreamDefaultController<Uint8Array>>();
  const f = fixture(new ReadableStream({ start(c) { stdout.resolve(c); } }));
  Object.assign(f.child.stdin, { write: () => { throw new Error("stdin failure"); } });
  const draining = pending<void>(), sleep = f.runtime.sleep;
  f.runtime.sleep = async ms => { if (ms === 2200) draining.resolve(); return sleep(ms); };
  const service = f.service(), execution = service.execute(f.owner, "hello", false, f.accepted); await draining.promise;
  expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 200 });
  f.drainTimeout.resolve(); await execution;
  expect(f.state.retained).toBe(true); expect(f.state.reconciliationRequired).toBe(true);
  expect(await service.ingestHook("Stop", hookInput(f), secret)).toMatchObject({ status: 403 });
  (await stdout.promise).close(); // Finish the isolated consumer after the bound.
});

test("failure to journal terminal status or final metadata fails closed", async () => {
  const f = fixture(); f.owner.stopRequested = true; const emit = f.deps.emit;
  f.deps.emit = async (run, kind, data) => { if (kind === "status" && (data as any).status !== "running") throw new Error("write failed"); await emit(run, kind, data); };
  await f.service().execute(f.owner, "hello", false, f.accepted); expect(f.state.failClosed).toBe(1);
  const persist = fixture(); let writes = 0; persist.deps.persist = async () => { if (++writes === 2) throw new Error("metadata failed"); };
  const service = persist.service(); await service.execute(persist.owner, "hello", false, persist.accepted);
  expect(persist.state.failClosed).toBe(1); expect(persist.state.reconciliationRequired).toBe(true);
  expect(await service.ingestHook("Stop", hookInput(persist), secret)).toMatchObject({ status: 403 });
});

for (const blocked of ["retained", "closing", "storageFailed"] as const) test(`compact history refresh withheld while ${blocked}`, async () => {
  const f = fixture(); f.run.operation = "compact"; f.state[blocked] = true;
  await f.service().execute(f.owner, "/compact", true, f.accepted);
  expect(f.state.refreshed).toBe(0);
});

test("SDK indexed root results with gaps, missing UUIDs and identical text complete the same run", async () => {
  const rows = [{ ...success, result_index: 2, result: "same" }, { ...success, result_index: 9, result: "same" }];
  const f = fixture(bytes([wire(...rows)]));
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("completed");
  expect(f.records.filter(e => e.kind === "stdout").map(e => e.data)).toEqual(rows);
  expect(statusData(f).at(-1)).toMatchObject({ status: "completed", resultSeen: true, exitCode: 0 });
});

for (const [name, rows, reason] of [
  ["reused index", [{ ...success, result_index: 0, uuid: "first" }, { ...success, result_index: 0, uuid: "second" }], "Duplicate CLI result"],
  ["invalid negative index", [{ ...success, result_index: -1 }], "Invalid CLI result_index"],
  ["invalid string index", [{ ...success, result_index: "0" }], "Invalid CLI result_index"],
  ["invalid fractional index", [{ ...success, result_index: 1.5 }], "Invalid CLI result_index"],
  ["legacy then indexed", [success, { ...success, result_index: 1 }], "Duplicate CLI result"],
  ["indexed then legacy", [{ ...success, result_index: 0 }, success], "Duplicate CLI result"],
  ["mismatched indexed identity", [{ ...success, result_index: 0, session_id: "foreign" }], "CLI session identity mismatch or missing session_id"],
] as const) test(`indexed supervision fails closed on ${name}`, async () => {
  const f = fixture(bytes([wire(...rows)]));
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("failed");
  expect(statusData(f).at(-1)?.reason).toBe(reason);
  expect(f.state.reconciliationRequired).toBe(false);
});

test("child indexed results cannot satisfy or poison root supervision", async () => {
  const child = { ...success, session_id: "foreign", result_index: 0, parent_tool_use_id: "child", is_error: true };
  const root = fixture(bytes([wire(child, { ...success, result_index: 0 }, child, { ...success, result_index: 4 })]));
  await root.service().execute(root.owner, "hello", false, root.accepted);
  expect(root.run.status).toBe("completed");
  const onlyChild = fixture(bytes([wire(child)]));
  await onlyChild.service().execute(onlyChild.owner, "hello", false, onlyChild.accepted);
  expect(onlyChild.run.status).toBe("failed");
  expect(statusData(onlyChild).at(-1)?.resultSeen).toBe(false);
});

test("native indexed failure remains authoritative even after a later successful reply", async () => {
  const f = fixture(bytes([wire({ ...success, result_index: 0, subtype: "error_max_turns", is_error: true, result: "error text" }, { ...success, result_index: 4, result: "useful reply" })]));
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("failed");
  expect(statusData(f).at(-1)).toMatchObject({ reason: "CLI result is not an explicit success", resultSubtype: "error_max_turns", isError: true, result: "error text" });
});

for (const delivered of [false, true]) test(`framework indexed supervision requires exact SessionStart delivery: ${delivered}`, async () => {
  const context = "framework\n\nassignment";
  const hook = { type: "system", subtype: "hook_response", hook_event: "SessionStart", outcome: "success", stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: delivered ? context : "wrong" } }) };
  const f = fixture(bytes([wire(hook, { type: "system", subtype: "init", session_id: nativeId }, { ...success, result_index: 0, result: "reply" })]));
  f.session.saneContext = { version: 1, framework: "framework", assignment: "assignment" };
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe(delivered ? "completed" : "failed");
  if (!delivered) expect(statusData(f).at(-1)?.reason).toBe("SANE framework SessionStart hook did not succeed");
  expect(f.spawned()).toBeDefined();
});

test("required framework cannot complete on an indexed result without hook delivery or native init", async () => {
  const f = fixture(bytes([wire({ ...success, result_index: 0, result: "reply" })]));
  f.session.saneContext = { version: 1, framework: "framework" };
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("failed");
});
