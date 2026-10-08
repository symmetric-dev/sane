import { expect, test } from "bun:test";
import { AgentLaunchConfigurationError } from "./agent-launch";
import { ClaudeRunService, hookEvents, type ClaudeRunDependencies, type ClaudeRunRuntime } from "./claude-run-service";
import type { Event, Run, Session } from "./history";
import type { RunOwner } from "./run-owner";
import { createDispatchEvidence } from "./dispatch-evidence";

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

for (const refuse of [false, true]) test(`CC durable submission hook runs before spawn and cannot fabricate native acceptance (refuse=${refuse})`, async () => {
  const f = fixture();
  const evidence = createDispatchEvidence({ runId: f.run.runId, nativeCommandId: null, source: { harnessId: "claude-code", sessionId: f.run.sessionId, authorityId: "fixture", nativeSessionId: nativeId, cwd: f.run.cwd } }, {
    beforeNative: () => { f.calls.push("durable-intent"); if (refuse) throw new Error("disk refused"); }, outcome: () => {},
  }, f.deps.failClosed);
  f.owner.dispatchEvidence = evidence;
  await f.service().execute(f.owner, "hello", true, f.accepted); evidence.finish();
  if (refuse) { expect(f.calls).not.toContain("spawn"); expect(evidence.snapshot().submission).toBe("not-submitted"); }
  else { expect(f.calls.indexOf("durable-intent")).toBeLessThan(f.calls.indexOf("spawn")); expect(evidence.snapshot()).toMatchObject({ submission: "submitted", nativeAcceptance: "unknown" }); }
});

test("CC spawn/admission before failed stdin is possible submission, not definite non-submission", async () => {
  const f = fixture(); f.child.stdin.write = () => { throw new Error("stdin failed"); };
  const evidence = createDispatchEvidence({ runId: f.run.runId, nativeCommandId: null, source: { harnessId: "claude-code", sessionId: f.run.sessionId, authorityId: "fixture", nativeSessionId: nativeId, cwd: f.run.cwd } }, {}, f.deps.failClosed);
  f.owner.dispatchEvidence = evidence;
  await f.service().execute(f.owner, "hello", true, f.accepted); evidence.finish();
  expect(f.ready[0]).toBe(true); expect(evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
  expect(f.calls.filter(call => call === "spawn")).toHaveLength(1);
});

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
  if (stage === "storage") expect(statusData(f).at(-1)).toMatchObject({ reason: "Storage failure; operator reconciliation required" });
  expect(statusData(f).at(-1)).not.toHaveProperty("termination");
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
  expect(statusData(f).at(-1)?.termination).toEqual({ kind: "unconfirmed", cause: "process-group" });
});

test("synchronous stdin failure observes independently rejecting consumers and stops the child", async () => {
  const f = fixture(new ReadableStream({ start(c) { c.error(new Error("stdout failure")); } }), new ReadableStream({ start(c) { c.error(new Error("stderr failure")); } }));
  Object.assign(f.child.stdin, { write: () => { throw new Error("stdin failure"); } });
  await f.service().execute(f.owner, "hello", false, f.accepted);
  expect(f.run.status).toBe("failed"); expect(f.direct).toEqual(["SIGTERM"]); expect(f.state.retained).toBe(true);
  expect(f.owner.streamsDrained).toBe(false); expect(f.state.reconciliationRequired).toBe(true);
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

test("local proof binds the original child, group, observed exit and successfully consumed EOF", async () => {
  const f = fixture(), service = f.service();
  expect(service.readLocalSettlement(f.owner).ready).toBe(false);
  await service.execute(f.owner, "hello", false, f.accepted);
  const proof = service.readLocalSettlement(f.owner);
  expect(proof).toMatchObject({ ready: true, kind: "terminated", evidence: { runId: f.run.runId, sessionId: f.run.sessionId,
    nativeSessionId: nativeId, childPid: f.child.pid, groupPid: -f.child.pid, exitObserved: true, exitCode: 0,
    exitSignal: null, termination: "not-requested", streamsDrained: true, lifecycleFinished: true, terminal: { status: "completed", cause: "result-success" } } });
  expect(proof.evidence && Object.isFrozen(proof.evidence)).toBe(true);
  expect(proof.evidence && Object.isFrozen(proof.evidence.terminal)).toBe(true);
  expect(service.readLocalIdle(f.run.sessionId)).toEqual({ ready: true });
  // No metadata field can mint a capability for a copied/imported owner.
  expect(service.readLocalSettlement({ ...f.owner, run: { ...f.run }, streamsDrained: true }).ready).toBe(false);
});

for (const mutation of ["status", "run", "child", "pid", "identity"] as const) test(`local proof refuses ${mutation} replacement and remains latched`, async () => {
  const f = fixture(), service = f.service(); await service.execute(f.owner, "hello", false, f.accepted);
  const originalRun = f.owner.run, originalPid = f.child.pid;
  if (mutation === "status") f.run.status = "failed";
  if (mutation === "run") f.owner.run = { ...f.run };
  if (mutation === "child") f.owner.child = { ...f.child } as typeof f.child;
  if (mutation === "pid") Object.assign(f.child, { pid: 555555 });
  if (mutation === "identity") f.run.runId = "replacement";
  expect(service.readLocalSettlement(f.owner).ready).toBe(false);
  f.owner.run = originalRun; f.run.status = "completed"; f.run.runId = "22222222-2222-4222-8222-222222222222";
  f.owner.child = f.child; Object.assign(f.child, { pid: originalPid });
  expect(service.readLocalSettlement(f.owner).ready).toBe(false);
});

test("exit-zero result failure is runtime failed evidence, never inferred as success", async () => {
  const f = fixture(bytes([wire({ ...success, is_error: true, subtype: "error_max_turns" })])), service = f.service();
  await service.execute(f.owner, "hello", false, f.accepted);
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { exitCode: 0, terminal: { status: "failed", cause: "result-failure" } } });
  f.run.status = "completed"; f.owner.streamsDrained = true;
  expect(service.readLocalSettlement(f.owner).ready).toBe(false);
});

test("framework rejection is captured as its own exit-zero runtime failure", async () => {
  const f = fixture(), service = f.service(); f.session.saneContext = { version: 1, framework: "framework" };
  await service.execute(f.owner, "hello", false, f.accepted);
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { exitCode: 0, terminal: { status: "failed", cause: "framework-rejected" } } });
});

for (const cause of ["stop-requested", "service-closing"] as const) test(`signaled child interruption records actual service cause ${cause}`, async () => {
  const f = fixture(), exit = pending<number>(), launched = pending<void>(); Object.assign(f.child, { exited: exit.promise, signalCode: "SIGTERM" });
  const service = f.service(), execution = service.execute(f.owner, "hello", false, accepted => { if (accepted) launched.resolve(); });
  await launched.promise;
  if (cause === "stop-requested") f.owner.stopRequested = true; else f.state.closing = true;
  exit.resolve(143); await execution;
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { exitObserved: true, exitCode: 143, exitSignal: "SIGTERM", terminal: { status: "interrupted", cause } } });
});

test("stop during preparation produces exact local withheld evidence without a created child", async () => {
  const f = fixture(), preparing = pending<void>(), continuePreparation = pending<string>();
  f.deps.execution = () => { preparing.resolve(); return continuePreparation.promise; };
  const service = f.service(), execution = service.execute(f.owner, "hello", false, f.accepted);
  await preparing.promise; expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
  f.owner.stopRequested = true; expect(await service.terminate(f.owner)).toBe(true);
  continuePreparation.resolve("/checkout"); await execution;
  expect(f.owner.nativeDispatched).toBe(false);
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, kind: "withheld", evidence: { childPid: null, nativeAttempted: false, exitObserved: false, streamsDrained: true, terminal: { status: "interrupted", cause: "stop-requested" } } });
  expect(service.readLocalIdle(f.run.sessionId)).toEqual({ ready: true });
});

for (const mode of ["stream-error", "emit-rejection", "emit-throw"] as const) test(`successful EOF proof is blocked by ${mode}, even with exited child and forged drain`, async () => {
  const f = fixture(mode === "stream-error" ? new ReadableStream({ start(c) { c.error(new Error("reader failed")); } }) : bytes([wire(success)]));
  const emit = f.deps.emit;
  if (mode === "emit-rejection") f.deps.emit = (run, kind, data) => kind === "stdout" ? Promise.reject(new Error("journal rejected")) : emit(run, kind, data);
  if (mode === "emit-throw") f.deps.emit = (run, kind, data) => { if (kind === "stdout") throw new Error("journal threw"); return emit(run, kind, data); };
  const service = f.service(); await service.execute(f.owner, "hello", false, f.accepted);
  expect(f.owner.streamsDrained).toBe(false); expect(f.state.reconciliationRequired).toBe(true);
  f.owner.streamsDrained = true;
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { streamsDrained: false, exitObserved: true } });
  expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
});

test("stream timeout cannot certify local drainage even when late EOF eventually arrives", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const f = fixture(new ReadableStream({ start(c) { controller = c; } })), draining = pending<void>();
  f.child.stdin.write = () => { throw new Error("stdin failed"); };
  const sleep = f.runtime.sleep; f.runtime.sleep = ms => { if (ms === 2200) draining.resolve(); return sleep(ms); };
  const service = f.service(), execution = service.execute(f.owner, "hello", false, f.accepted);
  await draining.promise; f.drainTimeout.resolve(); await execution;
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { streamsDrained: false } });
  controller.close(); await Promise.resolve(); await Promise.resolve();
  expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
});

test("termination acknowledgement is pending until the service promise resolves true", async () => {
  const f = fixture(), exit = pending<number>(), launched = pending<void>(), sleeping = pending<void>(), step = pending<void>();
  Object.assign(f.child, { exited: exit.promise }); f.runtime.sleep = ms => ms === 20 ? (sleeping.resolve(), step.promise) : f.drainTimeout.promise;
  const service = f.service(), execution = service.execute(f.owner, "hello", false, accepted => { if (accepted) launched.resolve(); });
  await launched.promise; f.owner.stopRequested = true; const stopping = service.terminate(f.owner); await sleeping.promise;
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { termination: "pending", exitObserved: false } });
  exit.resolve(143); step.resolve(); expect(await stopping).toBe(true); await execution;
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { termination: "confirmed", terminal: { status: "interrupted", cause: "stop-requested" } } });
  // A newly assigned Promise is not the observed service acknowledgement.
  f.owner.stopping = Promise.resolve(true); expect(service.readLocalSettlement(f.owner).ready).toBe(false);
});

test("false termination and permission-error group probes never certify local release", async () => {
  const f = fixture(); f.runtime.kill = () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
  const service = f.service(); await service.execute(f.owner, "hello", false, f.accepted);
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { termination: "unconfirmed", terminal: { status: "failed", cause: "termination-unconfirmed" } } });
  expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
});

for (const mode of ["hook-refusal", "async-hook", "spawn", "spawn-throw", "legacy"] as const) test(`nativeDispatched truthfully marks the earliest possible native boundary: ${mode}`, async () => {
  const f = fixture(); let hooks = 0;
  if (mode !== "legacy") f.owner.dispatchEvidence = { beforeNative: mode === "async-hook" ? async () => { hooks++; throw new Error("async refusal"); } : () => { hooks++; expect(f.owner.nativeDispatched).toBe(false); if (mode === "hook-refusal") throw new Error("refused"); }, outcome: () => {}, withheld: () => {} };
  const spawn = f.runtime.spawn; f.runtime.spawn = (args, options) => { expect(f.owner.nativeDispatched).toBe(true); if (mode === "spawn-throw") throw new Error("spawn unknown"); return spawn(args, options); };
  const service = f.service(); await service.execute(f.owner, "hello", false, f.accepted);
  expect(hooks).toBe(mode === "legacy" ? 0 : 1);
  expect(f.owner.nativeDispatched).toBe(mode !== "hook-refusal" && mode !== "async-hook");
  if (mode === "spawn-throw") { expect(service.readLocalSettlement(f.owner).ready).toBe(false); expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false); }
});

test("preparing idle capability rechecks the exact held owner through both pre-intent validations", async () => {
  const f = fixture(), preparing = pending<void>(), proceed = pending<string>();
  f.deps.execution = () => { preparing.resolve(); return proceed.promise; };
  let validations = 0;
  const spawn = f.runtime.spawn;
  f.runtime.spawn = (args, options) => {
    expect(f.owner.nativeDispatched).toBe(true);
    expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false);
    return spawn(args, options);
  };
  const service = f.service();
  const validate = () => {
    expect(f.owner.child).toBeUndefined(); expect(f.owner.nativeDispatched).toBe(false);
    expect(service.readLocalIdle(f.run.sessionId, f.owner)).toEqual({ ready: true });
    // An exempt preparation is never removed from aggregate supervision.
    expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false); validations++;
  };
  f.owner.beforeSend = validate;
  f.owner.dispatchEvidence = { beforeNative: validate, outcome: () => {}, withheld: () => {} };
  const execution = service.execute(f.owner, "hello", false, f.accepted);
  await preparing.promise;
  expect(f.owner.child).toBeUndefined(); expect(f.owner.nativeDispatched).toBe(false);
  expect(service.readLocalIdle(f.run.sessionId, f.owner)).toEqual({ ready: true });
  for (const flag of ["stopRequested", "cancelling", "settled"] as const) {
    f.owner[flag] = true; expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false); f.owner[flag] = false;
  }
  f.owner.stopping = Promise.resolve(true); expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false); f.owner.stopping = undefined;
  f.run.status = "failed"; expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false); f.run.status = "running";
  f.state.owns = false; expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false); f.state.owns = true;
  for (const flag of ["closing", "storageFailed", "retained"] as const) {
    f.state[flag] = true; expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false); f.state[flag] = false;
  }
  expect(service.readLocalIdle(f.run.sessionId, f.owner)).toEqual({ ready: true });
  expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
  proceed.resolve("/checkout"); await execution;
  expect(validations).toBe(2); expect(f.run).toMatchObject({ status: "completed" });
  expect(service.readLocalIdle(f.run.sessionId)).toEqual({ ready: true });
});

test("preparing idle capability denies clones, foreign sessions and every other preparation or unknown attempt", async () => {
  const f = fixture(), firstHeld = pending<void>(), secondHeld = pending<void>(), firstProceed = pending<string>(), secondProceed = pending<string>();
  const second: RunOwner = { run: { ...f.run, runId: "second" }, done: Promise.resolve(), settled: false };
  let executions = 0;
  f.deps.owns = owner => owner === f.owner || owner === second;
  f.deps.execution = () => {
    if (++executions === 1) { firstHeld.resolve(); return firstProceed.promise; }
    if (executions === 2) { secondHeld.resolve(); return secondProceed.promise; }
    return Promise.resolve("/checkout");
  };
  f.runtime.spawn = () => { throw new Error("spawn unknown"); };
  const service = f.service(), firstExecution = service.execute(f.owner, "first", false, f.accepted);
  await firstHeld.promise;
  expect(service.readLocalIdle(f.run.sessionId, f.owner)).toEqual({ ready: true });
  expect(service.readLocalIdle(f.run.sessionId, { ...f.owner, run: { ...f.run } }).ready).toBe(false);
  expect(service.readLocalIdle(f.run.sessionId, { ...f.owner, run: { ...f.run, sessionId: "foreign" } }).ready).toBe(false);
  expect(service.readLocalIdle("foreign", f.owner).ready).toBe(false);
  const secondExecution = service.execute(second, "second", false, () => {});
  await secondHeld.promise;
  expect(service.readLocalIdle(f.run.sessionId, second).ready).toBe(false);
  expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false);
  firstProceed.resolve("/checkout"); await firstExecution;
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { nativeAttempted: true, childPid: null, lifecycleFinished: true } });
  expect(service.readLocalIdle(f.run.sessionId, second).ready).toBe(false);
  second.stopRequested = true; secondProceed.resolve("/checkout"); await secondExecution;
  expect(service.readLocalSettlement(second).ready).toBe(true);
  expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
});

test("preparing idle capability closes immediately after durable intent without upgrading unresolved claims", async () => {
  for (const mode of ["source-change", "spawn-throw"] as const) {
    const f = fixture(); let intentReturned = false, gapChecked = false, spawnChecked = false;
    const evidence = dispatchEvidence(f, () => {
      expect(service.readLocalIdle(f.run.sessionId, f.owner)).toEqual({ ready: true });
    });
    f.owner.dispatchEvidence = { ...evidence, beforeNative: () => { evidence.beforeNative(); intentReturned = true; } };
    f.deps.session = id => {
      if (intentReturned && !gapChecked) {
        gapChecked = true;
        expect(f.owner.nativeDispatched).toBe(false); expect(f.owner.child).toBeUndefined();
        expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false);
        expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
        if (mode === "source-change") f.session.nativeSessionId = foreignNativeId;
      }
      return id === f.session.sessionId ? f.session : undefined;
    };
    f.runtime.spawn = () => {
      expect(f.owner.nativeDispatched).toBe(true); expect(f.owner.child).toBeUndefined();
      expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false);
      spawnChecked = true;
      throw new Error("spawn unknown");
    };
    const service = f.service(); await service.execute(f.owner, "hello", false, f.accepted); evidence.finish();
    expect(gapChecked).toBe(true); expect(f.owner.child).toBeUndefined();
    expect(spawnChecked).toBe(mode === "spawn-throw");
    expect(f.owner.nativeDispatched).toBe(mode === "spawn-throw");
    expect(service.readLocalIdle(f.run.sessionId, f.owner).ready).toBe(false);
    expect(service.readLocalSettlement(f.owner).ready).toBe(false);
    // Known no-child completion can retire local supervision, never a durable
    // unresolved claim. A spawn throw cannot even prove local aggregate idle.
    expect(service.readLocalIdle(f.run.sessionId).ready).toBe(mode === "source-change");
    expect(evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
  }
});

test("all original groups per conversation must be absent, not only the last owner", async () => {
  const f = fixture(), launched = pending<void>(), exit = pending<number>();
  const first = f.owner, second: RunOwner = { ...f.owner, run: { ...f.run, runId: "second" }, done: Promise.resolve() };
  const secondChild = { ...f.child, pid: 123456, exited: Promise.resolve(0), stdout: bytes([wire(success)]), stderr: bytes() } as typeof f.child;
  Object.assign(f.child, { exited: exit.promise });
  let alive = true, spawns = 0;
  f.deps.owns = () => true;
  f.runtime.spawn = () => ++spawns === 1 ? f.child : secondChild;
  f.runtime.kill = (pid, signal) => { if (pid === -f.child.pid && alive) { if (signal === 0) throw Object.assign(new Error("permission"), { code: "EPERM" }); return; } gone(); };
  const service = f.service(), execution = service.execute(first, "hello", false, accepted => { if (accepted) launched.resolve(); });
  await launched.promise;
  expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
  await service.execute(second, "hello", false, () => {});
  expect(service.readLocalSettlement(second).ready).toBe(true);
  expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
  exit.resolve(0); await execution;
  expect(service.readLocalIdle(f.run.sessionId).ready).toBe(false);
  alive = false; expect(service.readLocalIdle(f.run.sessionId)).toEqual({ ready: true });
  expect(service.readLocalSettlement(first).ready).toBe(false); // Failed termination is not upgraded by idle.
});

for (const mode of ["result", "framework", "exit", "missing-result", "launch"] as const) test(`terminal DTO setter cannot relabel runtime ${mode} failure as completed`, async () => {
  const f = fixture(mode === "result" ? bytes([wire({ ...success, is_error: true })]) : mode === "missing-result" ? bytes() : bytes([wire(success)]));
  if (mode === "framework") f.session.saneContext = { version: 1, framework: "required framework" };
  if (mode === "exit") Object.assign(f.child, { exited: Promise.resolve(7) });
  if (mode === "launch") f.runtime.spawn = () => { throw new Error("spawn uncertain"); };
  let status: Run["status"] = "running";
  Object.defineProperty(f.run, "status", { configurable: true, get: () => status, set: value => { status = value === "failed" ? "completed" : value; } });
  // Wire-looking DTO fields/getters are not runtime observations either.
  for (const property of ["cause", "result", "exitCode"]) Object.defineProperty(f.run, property, { get: () => { throw new Error(`DTO ${property} must not be read`); } });
  const service = f.service(); await service.execute(f.owner, "hello", mode !== "framework", f.accepted);
  expect(f.run.status).toBe("completed");
  const cause = mode === "result" ? "result-failure" : mode === "framework" ? "framework-rejected" : mode === "exit" ? "nonzero-exit" : mode === "missing-result" ? "missing-result" : "launch-stream-shutdown-failure";
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { terminal: { status: "failed", cause } } });
  expect(statusData(f).at(-1)?.status).toBe("failed"); expect(f.session.lastStatus).toBe("failed");
  // Immediate DTO disagreement is latched, even if repaired before proof read.
  Object.defineProperty(f.run, "status", { value: "failed", writable: true });
  expect(service.readLocalSettlement(f.owner).ready).toBe(false);
});

for (const initial of ["result-failure", "service-closing", "stop-requested"] as const) test(`classification captures ${initial} before DTO setter changes service flags`, async () => {
  const f = fixture(initial === "result-failure" ? bytes([wire({ ...success, is_error: true })]) : bytes([wire(success)]));
  const accepted = (value: boolean) => {
    f.accepted(value);
    if (value && initial === "service-closing") f.state.closing = true;
    if (value && initial === "stop-requested") f.owner.stopRequested = true;
  };
  let status: Run["status"] = "running";
  Object.defineProperty(f.run, "status", { get: () => status, set: value => {
    status = value;
    if (value !== "running") { f.state.closing = false; f.owner.stopRequested = initial === "result-failure"; }
  } });
  const service = f.service(); await service.execute(f.owner, "hello", true, accepted);
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { terminal: { status: initial === "result-failure" ? "failed" : "interrupted", cause: initial } } });
});

test("observed signal cannot produce completed runtime proof even with exit-zero success", async () => {
  const f = fixture(); Object.assign(f.child, { signalCode: "SIGTERM" });
  const service = f.service(); await service.execute(f.owner, "hello", true, f.accepted);
  expect(f.run.status).toBe("failed");
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { exitCode: 0, exitSignal: "SIGTERM", terminal: { status: "failed", cause: "signal-exit" } } });
  expect(statusData(f).at(-1)?.error).toBe("CLI terminated by signal SIGTERM");
});

const dispatchEvidence = (f: ReturnType<typeof fixture>, beforeNative?: () => void) => createDispatchEvidence({ runId: f.run.runId, nativeCommandId: null,
  source: { harnessId: "claude-code", sessionId: f.run.sessionId, authorityId: "fixture", nativeSessionId: nativeId, cwd: f.run.cwd } }, { beforeNative }, f.deps.failClosed);
const foreignNativeId = "44444444-4444-4444-8444-444444444444";

for (const drift of ["mutable-native", "replacement-native", "session-cwd", "run-cwd", "run-id", "session-id", "authority", "harness"] as const) test(`suspended persist source pin denies ${drift} before native intent or spawn`, async () => {
  const f = fixture(bytes([wire({ ...success, session_id: foreignNativeId })])), persisting = pending<void>(), proceed = pending<void>();
  let persists = 0;
  f.deps.persist = async () => { if (++persists === 1) { persisting.resolve(); await proceed.promise; } };
  f.owner.beforeSend = () => {}; // No injected guard is necessary for source safety.
  const evidence = dispatchEvidence(f); f.owner.dispatchEvidence = evidence;
  const service = f.service(), execution = service.execute(f.owner, "original prompt", true, f.accepted);
  await persisting.promise;
  if (drift === "mutable-native") f.session.nativeSessionId = foreignNativeId;
  if (drift === "replacement-native") { const replacement = { ...f.session, nativeSessionId: foreignNativeId }; f.deps.session = () => replacement; }
  if (drift === "session-cwd") f.session.cwd = "/foreign";
  if (drift === "run-cwd") f.run.cwd = "/foreign";
  if (drift === "run-id") f.run.runId = "foreign-run";
  if (drift === "session-id") f.run.sessionId = "foreign-session";
  if (drift === "authority") f.session.authorityId = "foreign-authority";
  if (drift === "harness") f.session.harness = "opencode";
  proceed.resolve(); await execution; evidence.finish();
  expect(f.calls).not.toContain("spawn"); expect(f.ready).not.toContain(true); expect(f.owner.nativeDispatched).toBe(false);
  expect(statusData(f).at(-1)).toMatchObject({ status: "failed", code: "dispatch-source-mismatch" });
  expect(evidence.snapshot()).toMatchObject({ submission: "not-submitted", nativeAcceptance: "not-accepted" });
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { nativeSessionId: nativeId, cwd: "/checkout", nativeAttempted: false } });
});

for (const stage of ["status", "submission", "execution", "framework-file", "agent", "session-context", "session-file", "settings", "execution-context", "launch", "final-execution"] as const) test(`fresh source validation after asynchronous ${stage} prevents cross-source spawn`, async () => {
  const f = fixture(); f.run.agent = "design";
  f.session.saneContext = { version: 1, framework: "framework" };
  const change = () => { f.session.nativeSessionId = foreignNativeId; };
  const emit = f.deps.emit; f.deps.emit = async (run, kind, data) => { await emit(run, kind, data); if (kind === stage) change(); };
  if (stage === "execution" || stage === "final-execution") {
    let checks = 0; f.deps.execution = async () => { if (++checks === (stage === "execution" ? 1 : 2)) change(); return "/checkout"; };
  }
  const write = f.runtime.writeSettings; f.runtime.writeSettings = async (path, text) => {
    await write(path, text);
    if (stage === "framework-file" && path.endsWith(".session-start.md") || stage === "session-file" && path.endsWith(".sane-session.md") || stage === "settings" && path.endsWith(".settings.json")) change();
  };
  if (stage === "agent") { const settings = f.runtime.agentSettings; f.runtime.agentSettings = async (...args) => { change(); return settings(...args); }; }
  f.deps.saneSession = async () => { if (stage === "session-context") change(); return "session context"; };
  if (stage === "execution-context") f.deps.executionContext = async () => { change(); return { executionCheckout: "/checkout", workstreamId: null, artifactsRoot: null }; };
  const service = f.service(); await service.execute(f.owner, "original prompt", false, f.accepted);
  expect(f.calls).not.toContain("spawn"); expect(f.ready).not.toContain(true);
  expect(statusData(f).at(-1)?.code).toBe("dispatch-source-mismatch"); expect(service.readLocalSettlement(f.owner).ready).toBe(false);
});

for (const boundary of ["beforeSend", "beforeNative"] as const) test(`synchronous ${boundary} source mutation is refused without false dispatch evidence`, async () => {
  const f = fixture(); let intentCalls = 0;
  const evidence = dispatchEvidence(f, () => { intentCalls++; if (boundary === "beforeNative") f.session.nativeSessionId = foreignNativeId; });
  f.owner.dispatchEvidence = evidence;
  f.owner.beforeSend = () => { if (boundary === "beforeSend") f.session.nativeSessionId = foreignNativeId; };
  const service = f.service(); await service.execute(f.owner, "hello", true, f.accepted); evidence.finish();
  expect(f.calls).not.toContain("spawn"); expect(f.owner.nativeDispatched).toBe(false); expect(f.ready).not.toContain(true);
  expect(intentCalls).toBe(boundary === "beforeNative" ? 1 : 0);
  expect(evidence.snapshot()).toMatchObject({ submission: boundary === "beforeNative" ? "unknown" : "not-submitted", nativeAcceptance: boundary === "beforeNative" ? "unknown" : "not-accepted" });
  expect(statusData(f).at(-1)?.code).toBe("dispatch-source-mismatch"); expect(service.readLocalSettlement(f.owner).ready).toBe(false);
  f.session.nativeSessionId = nativeId;
  expect(service.readLocalSettlement(f.owner).ready).toBe(false);
  await expect(service.execute(f.owner, "do not replay", true, f.accepted)).rejects.toThrow("cannot be replaced or replayed");
});

test("spawn exception after durable intent remains unknown and nativeDispatched stays true", async () => {
  const f = fixture(), evidence = dispatchEvidence(f); f.owner.dispatchEvidence = evidence;
  f.runtime.spawn = () => { throw new Error("spawn effect uncertain"); };
  const service = f.service(); await service.execute(f.owner, "hello", true, f.accepted); evidence.finish();
  expect(evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
  expect(f.owner.nativeDispatched).toBe(true); expect(service.readLocalSettlement(f.owner).ready).toBe(false);
});

test("result consumers retain launched native pin when the current Session replaces the captured object", async () => {
  const foreign = { ...success, session_id: foreignNativeId };
  const f = fixture(bytes([wire(foreign)])), replacement = { ...f.session };
  const spawn = f.runtime.spawn; f.runtime.spawn = (args, options) => {
    // The stale entry object no longer represents the live Session. Using it
    // here would wrongly authorize B's result for the originally launched A.
    f.session.nativeSessionId = foreignNativeId;
    f.deps.session = () => replacement;
    return spawn(args, options);
  };
  const service = f.service(); await service.execute(f.owner, "original text", true, f.accepted);
  expect(f.spawned()?.args[f.spawned()!.args.indexOf("--resume") + 1]).toBe(nativeId);
  expect(f.run.status).toBe("failed"); expect(statusData(f).at(-1)?.reason).toBe("CLI session identity mismatch or missing session_id");
  expect(f.records.find(record => record.kind === "stdout")?.data).toEqual(foreign);
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { nativeSessionId: nativeId, terminal: { status: "failed", cause: "result-failure" } } });
});

test("live source mutation after spawn cannot certify original-source success", async () => {
  const f = fixture(bytes([wire({ ...success, session_id: foreignNativeId })])), evidence = dispatchEvidence(f); f.owner.dispatchEvidence = evidence;
  const service = f.service(); await service.execute(f.owner, "original prompt", true, accepted => { f.accepted(accepted); if (accepted) f.session.nativeSessionId = foreignNativeId; }); evidence.finish();
  expect(f.spawned()?.args).toContain(nativeId); expect(f.spawned()?.args).not.toContain(foreignNativeId);
  expect(f.calls).toContain("stdin:original prompt"); expect(f.run.status).toBe("failed");
  expect(evidence.snapshot()).toMatchObject({ submission: "submitted", nativeAcceptance: "unknown" });
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { nativeSessionId: nativeId, nativeAttempted: true } });
});

test("source change during final metadata persist invalidates otherwise completed local proof", async () => {
  const f = fixture(); let persists = 0;
  f.deps.persist = async () => { if (++persists === 2) f.deps.session = () => ({ ...f.session, nativeSessionId: foreignNativeId }); };
  const service = f.service(); await service.execute(f.owner, "hello", true, f.accepted);
  expect(f.run.status).toBe("completed");
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { nativeSessionId: nativeId, terminal: { status: "completed", cause: "result-success" } } });
});

test("matching Session replacement and immutable entry launch flags preserve ordinary resume", async () => {
  const f = fixture(); f.run.model = "original-model"; f.run.effort = "high";
  f.deps.persist = async () => { f.deps.session = () => ({ ...f.session }); f.run.model = "later-model"; f.run.effort = "low"; };
  const service = f.service(); await service.execute(f.owner, "hello", true, f.accepted);
  expect(f.run.status).toBe("completed");
  expect(f.spawned()?.args).toContain("original-model"); expect(f.spawned()?.args).not.toContain("later-model"); expect(f.spawned()?.args).toContain("high");
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { nativeSessionId: nativeId } });
});

for (const foreign of [false, true]) test(`legacy new session pins a preselected CLI ID rather than borrowing result identity (foreign=${foreign})`, async () => {
  const f = fixture(); delete f.session.nativeSessionId;
  Object.assign(f.child, { stdout: bytes([wire({ ...success, session_id: foreign ? foreignNativeId : f.run.runId })]) });
  const service = f.service(); await service.execute(f.owner, "first prompt only", false, f.accepted);
  expect(f.spawned()?.args[f.spawned()!.args.indexOf("--session-id") + 1]).toBe(f.run.runId);
  expect(f.spawned()?.args).not.toContain("--resume"); expect(f.calls).toContain("stdin:first prompt only");
  expect(f.run.status).toBe(foreign ? "failed" : "completed"); expect(f.deps.session(f.run.sessionId)?.nativeSessionId).toBe(foreign ? undefined : f.run.runId);
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { nativeSessionId: f.run.runId, terminal: { status: foreign ? "failed" : "completed", cause: foreign ? "result-failure" : "result-success" } } });
});

test("resume with no established native source is withheld, never treated as a new session", async () => {
  const f = fixture(); delete f.session.nativeSessionId;
  await f.service().execute(f.owner, "do not create a replacement", true, f.accepted);
  expect(f.spawned()).toBeUndefined(); expect(f.owner.nativeDispatched).toBe(false); expect(statusData(f).at(-1)?.code).toBe("dispatch-source-mismatch");
});

test("native source accessor is captured once, not separately for supervision and launch", async () => {
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.session, "nativeSessionId", { get: () => ++reads === 1 ? nativeId : foreignNativeId });
  const service = f.service(); await service.execute(f.owner, "do not borrow another source", true, f.accepted);
  expect(f.spawned()).toBeUndefined(); expect(statusData(f).at(-1)?.code).toBe("dispatch-source-mismatch");
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: false, evidence: { nativeSessionId: nativeId } });
});

test("post-intent source mutation cannot hide its original evidence hook by replacing the owner field", async () => {
  const f = fixture(), evidence = dispatchEvidence(f, () => { f.session.nativeSessionId = foreignNativeId; f.owner.dispatchEvidence = undefined; });
  f.owner.dispatchEvidence = evidence;
  await f.service().execute(f.owner, "hello", true, f.accepted); evidence.finish();
  expect(f.spawned()).toBeUndefined(); expect(f.owner.nativeDispatched).toBe(false);
  expect(evidence.snapshot()).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown" });
});

for (const preflight of [1, 2]) test(`execution checkout discovery ${preflight} cannot rebind the entry cwd`, async () => {
  const f = fixture(); let executions = 0;
  f.deps.execution = async () => ++executions === preflight ? "/foreign-checkout" : "/checkout";
  const service = f.service(); await service.execute(f.owner, "keep original checkout", true, f.accepted);
  expect(f.spawned()).toBeUndefined(); expect(f.run.cwd).toBe("/checkout");
  expect(statusData(f).at(-1)?.code).toBe("dispatch-source-mismatch"); expect(service.readLocalSettlement(f.owner).ready).toBe(false);
});

test("hook credentials cannot be borrowed by a changed native source", async () => {
  const f = fixture(), exit = pending<number>(), launched = pending<void>(); Object.assign(f.child, { exited: exit.promise });
  const service = f.service(), execution = service.execute(f.owner, "original prompt", true, value => { if (value) launched.resolve(); });
  await launched.promise; f.session.nativeSessionId = foreignNativeId;
  expect(await service.ingestHook("Stop", { runId: f.run.runId, payload: { hook_event_name: "Stop", session_id: foreignNativeId } }, secret)).toMatchObject({ status: 400 });
  expect(f.records.some(record => record.kind === "hook")).toBe(false);
  exit.resolve(0); await execution; expect(service.readLocalSettlement(f.owner).ready).toBe(false);
});

test("legacy new-session hooks use the preselected launch ID before result delivery assigns metadata", async () => {
  const f = fixture(), exit = pending<number>(), launched = pending<void>(); delete f.session.nativeSessionId;
  Object.assign(f.child, { exited: exit.promise, stdout: bytes([wire({ ...success, session_id: f.run.runId })]) });
  const service = f.service(), execution = service.execute(f.owner, "first prompt", false, value => { if (value) launched.resolve(); });
  await launched.promise;
  expect(await service.ingestHook("Stop", { runId: f.run.runId, payload: { hook_event_name: "Stop", session_id: f.run.runId } }, secret)).toMatchObject({ status: 200 });
  exit.resolve(0); await execution;
  expect(service.readLocalSettlement(f.owner)).toMatchObject({ ready: true, evidence: { nativeSessionId: f.run.runId, terminal: { status: "completed", cause: "result-success" } } });
});
