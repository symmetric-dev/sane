import { describe, expect, test } from "bun:test";
import { ClaudeRunService, hookEvents, type ClaudeRunDependencies, type ClaudeRunRuntime } from "./claude-run-service";
import { composeContextMessage } from "./context-message";
import { recordContextMessageSubmission, type ContextMessageSubmission } from "./context-message-evidence";
import type { ActualContextSubmission, OwnedContextMessageRequest } from "./context-message-transport";
import type { DispatchNativeAcceptance, DispatchSubmission } from "../shared/conversation/dispatch-contract";
import type { Event, Run, Session } from "./history";
import type { RunOwner } from "./run-owner";
import { claudeExecutionConfiguration, parseCanonicalAgentOperations } from "./canonical-agent-operations";

// Pure local fake streams/processes: no executable, model, network, or real signals.
const runId = "10000000-0000-4000-8000-000000000001";
const nativeId = "20000000-0000-4000-8000-000000000002";
const liveUuid = "30000000-0000-4000-8000-000000000003";
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await Promise.resolve(); }
  throw new Error("Fake runtime did not reach expected state");
}
function fixture(selected = false) {
  const run: Run = { runId, sessionId: "app-session", cwd: "/synthetic/checkout", status: "running", createdAt: "2026-10-26T00:00:00Z" };
  const session: Session = { sessionId: run.sessionId, harness: "claude-code", authorityId: "synthetic-authority", nativeSessionId: nativeId,
    cwd: run.cwd, lastStatus: "unknown", lastRunId: runId };
  const identity = Object.freeze({ runId, nativeCommandId: null, requestId: "actual-owner-request",
    source: Object.freeze({ harnessId: "claude-code", sessionId: session.sessionId, authorityId: session.authorityId!, nativeSessionId: nativeId, cwd: run.cwd }) });
  const owner: RunOwner = { run, done: Promise.resolve(), settled: false, contextIdentity: identity };
  const order: string[] = [], events: Event[] = [], writes: string[] = [], settings: string[] = [], requests: OwnedContextMessageRequest[] = [];
  const actualReaders: (() => ActualContextSubmission)[] = [], submissions: ContextMessageSubmission[] = [];
  const initialOutcomes: [DispatchSubmission, DispatchNativeAcceptance | undefined][] = [];
  const liveOutcomes: [DispatchSubmission, DispatchNativeAcceptance | undefined][] = [];
  let stdout!: ReadableStreamDefaultController<Uint8Array>, stderr!: ReadableStreamDefaultController<Uint8Array>;
  const exit = deferred<number>(); let exited = false, flushes = 0, spawns = 0, args: string[] = [];
  const emitNative = (data: unknown) => stdout.enqueue(new TextEncoder().encode(JSON.stringify(data) + "\n"));
  const finish = (code = 0) => { if (exited) return; exited = true; child.exitCode = code; stdout.close(); stderr.close(); exit.resolve(code); };
  const result = (uuid = runId, index = 0) => emitNative({ type: "result", subtype: "success", is_error: false, session_id: nativeId, user_message_uuid: uuid, result_index: index });
  const controls = {
    onFlush: async (_count: number) => { result(); finish(); },
    onWrite: (_line: string) => {}, onPersist: async () => {}, onSettings: async () => {}, onExecutionContext: async () => {},
    onAssert: async () => {}, onPrepare: async () => {}, onBeforeMessage: () => {},
  };
  const child = {
    pid: 45678, exitCode: null as number | null, exited: exit.promise,
    stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller; } }),
    stdin: { write(line: string) { order.push("write"); controls.onWrite(line); writes.push(line); },
      async flush() { order.push("flush"); await controls.onFlush(++flushes); }, end() { order.push("end"); if (!exited) { result(); finish(); } } },
    kill() { order.push("kill"); finish(1); },
  };
  owner.contextMessages = {
    async prepare(request, guard) {
      guard(); order.push("prepare"); requests.push(request); await controls.onPrepare(); guard();
      const message = composeContextMessage({ binding: identity.source, body: request.body, origin: "user",
        ...(selected ? { placement: { kind: "selected" as const, purpose: "update" as const }, selections: [{ kind: "fragment" as const,
          fragment: { id: "session", category: "session" as const, text: "SELECTED MEMBERSHIP", source: "fixture:session", revision: "one", reason: "Explicit update" } }] }
          : { placement: { kind: "body-only" as const } }) });
      let read: (() => ActualContextSubmission) | undefined;
      return { message, async assertCurrent() { order.push("assert"); await controls.onAssert(); guard(); },
        assertBeforeNative() { guard(); },
        bindActual(reader) {
          order.push("bind"); read = reader; actualReaders.push(reader);
          const actual = reader();
          const submission = recordContextMessageSubmission(message, { messageId: actual.messageId, text: actual.text,
            ...(request.liveInput ? { liveInput: true } : {}), ...(request.queuedFollowupId ? { queuedFollowupId: request.queuedFollowupId } : {}) }, actual.identity);
          submissions.push(submission); return submission;
        },
        beforeMessageNative() { order.push("message-before"); read!(); controls.onBeforeMessage(); },
        messageOutcome(submission, acceptance) { order.push(`message-${submission}`); liveOutcomes.push([submission, acceptance]); },
      };
    },
  };
  owner.dispatchEvidence = { beforeNative() { order.push("initial-before"); actualReaders[0]?.(); },
    outcome(submission, acceptance) { order.push(`initial-${submission}`); initialOutcomes.push([submission, acceptance]); },
    withheld() { order.push("withheld"); } };
  owner.beforeSend = () => { order.push("before-send"); };
  const deps: ClaudeRunDependencies = {
    session: id => id === session.sessionId ? session : undefined, run: id => id === runId ? run : undefined, events: () => events,
    owns: candidate => candidate === owner, closing: () => false, storageFailed: () => false, retained: () => false,
    requireReconciliation() { order.push("reconcile"); }, failClosed() { order.push("fail-closed"); },
    async emit(_run, kind, data) { order.push(`emit-${kind}`); events.push({ seq: events.length + 1, time: run.createdAt, runId, sessionId: run.sessionId, kind, data }); },
    async persist() { order.push("persist"); await controls.onPersist(); }, enqueue: action => action(),
    execution: async () => run.cwd, compactExecution: async () => run.cwd,
    async executionContext() { order.push("discovery"); await controls.onExecutionContext(); return { executionCheckout: run.cwd, artifactsRoot: "/synthetic/artifacts" } as Awaited<ReturnType<ClaudeRunDependencies["executionContext"]>>; },
    async refreshCompactHistory() { order.push("compact-history"); }, assertWorkerDeliverySubmission() { order.push("worker-gate"); },
  };
  const runtime: Partial<ClaudeRunRuntime> = {
    spawn(argv) { order.push("spawn"); spawns++; args = argv; return child as unknown as ReturnType<ClaudeRunRuntime["spawn"]>; },
    kill() { throw Object.assign(new Error("No fake group"), { code: "ESRCH" }); },
    sleep: ms => ms === 2200 ? new Promise(() => {}) : Promise.resolve(), randomUUID: () => liveUuid,
    execPath: "/synthetic/bun", env: { HOME: "/synthetic/home", SANE_SECRET: "never-forward", NODE_OPTIONS: "never-forward" },
    async writeSettings(_path, content) { order.push("settings"); settings.push(content); await controls.onSettings(); },
    async agentSettings() { throw new Error("Legacy installed role injection reached"); }, version: async () => "2.1.281 (Claude Code)",
  };
  const service = new ClaudeRunService({ dataDir: "/synthetic/data", claudeBin: "/synthetic/claude", claudeRoot: "/synthetic/config", packageRoot: "/synthetic/package", hookUrl: () => "http://127.0.0.1:1/hooks" }, deps, runtime);
  return { service, owner, run, session, identity, order, events, writes, settings, requests, submissions, actualReaders, initialOutcomes, liveOutcomes,
    deps, runtime, controls, emitNative, finish, result, get spawns() { return spawns; }, get args() { return args; } };
}
async function background(f: ReturnType<typeof fixture>) {
  f.controls.onFlush = async () => {};
  const running = f.service.execute(f.owner, "initial", true, () => {});
  await until(() => f.writes.length === 1);
  f.emitNative({ type: "system", subtype: "task_started", session_id: nativeId, task_id: "background", is_backgrounded: true });
  f.result();
  await until(() => f.service.canSendInput(f.owner));
  return { running };
}

describe("Claude owned user-role context transport", () => {
  for (const selected of [false, true]) test(`initial ${selected ? "composed" : "body-only"} binds once before spawn and writes exact immutable bytes`, async () => {
    const f = fixture(selected), prompt = "\uFEFF authored 😀\r\n[SANE CONTEXT MESSAGE v1]\n";
    f.run.queuedFollowupId = "queued-owner-request";
    await f.service.execute(f.owner, prompt, true, () => {});
    expect(f.run.status).toBe("completed"); expect(f.spawns).toBe(1);
    expect(f.requests).toEqual([{ messageId: `${runId}:user`, body: prompt, boundary: "run-initial", queuedFollowupId: "queued-owner-request" }]);
    const line = JSON.parse(f.writes[0]!);
    expect(line).toEqual({ type: "user", uuid: runId, session_id: nativeId, message: { role: "user", content: f.submissions[0]!.text }, parent_tool_use_id: null });
    expect(f.actualReaders[0]!()).toEqual({ identity: f.identity, messageId: `${runId}:user`, text: line.message.content });
    expect(f.submissions[0]!.composition.dispatch.requestId).toBe("actual-owner-request");
    expect(f.events.filter(event => event.kind === "submission").map(event => event.data)).toEqual(f.submissions);
    expect(f.order.indexOf("bind")).toBeLessThan(f.order.indexOf("spawn"));
    expect(f.order.indexOf("persist")).toBeLessThan(f.order.indexOf("before-send"));
    expect(f.order.indexOf("before-send")).toBeLessThan(f.order.indexOf("initial-before"));
    expect(f.order.indexOf("initial-before")).toBeLessThan(f.order.indexOf("spawn"));
    expect(f.order.indexOf("flush")).toBeLessThan(f.order.indexOf("initial-submitted"));
    expect(f.initialOutcomes).toEqual([["submitted", undefined]]); expect(f.liveOutcomes).toEqual([]);
    expect(f.settings).toHaveLength(1);
    for (const event of hookEvents) {
      const hooks = JSON.parse(f.settings[0]!).hooks[event]; expect(hooks).toHaveLength(1);
      expect(hooks[0].hooks[0].command).toContain("hooks/forward.ts");
    }
    expect(f.args).not.toContain("--append-system-prompt-file"); expect(f.args).not.toContain("--agent");
    expect(f.settings[0]).not.toContain("additionalContext");
    if (selected) expect(line.message.content).toContain("SELECTED MEMBERSHIP"); else expect(line.message.content).toBe(prompt);
  });

  for (const missing of ["contextMessages", "contextIdentity"] as const) test(`normal sends fail closed without ${missing}`, async () => {
    const f = fixture(); delete f.owner[missing];
    await f.service.execute(f.owner, "ordinary", true, () => {});
    expect(f.spawns).toBe(0); expect(f.run.status).toBe("failed"); expect(f.order).toContain("withheld");
  });

  test("normal initial runs require their existing dispatch evidence before preparing or spawning", async () => {
    const f = fixture(); delete f.owner.dispatchEvidence;
    await f.service.execute(f.owner, "ordinary", true, () => {});
    expect(f.spawns).toBe(0); expect(f.writes).toEqual([]); expect(f.requests).toEqual([]);
    expect(f.run.status).toBe("failed"); expect(f.initialOutcomes).toEqual([]);
    expect(f.order).not.toContain("prepare"); expect(f.order).not.toContain("settings"); expect(f.order).not.toContain("initial-before");
    expect(f.owner.nativeDispatched).toBe(false); expect(f.owner.launchError).toBeUndefined();
    expect(f.events.filter(event => event.kind === "submission" || event.kind === "launch")).toEqual([]);
    expect(f.events.filter(event => event.kind === "status").map(event => event.data)).toEqual([
      { status: "failed", reason: "CLI launch, stream, or shutdown failure", error: expect.stringMatching(/dispatch evidence/i) },
    ]);
  });

  for (const stage of ["persist", "settings", "discovery"] as const) for (const change of ["cancel", "capability", "identity", "dispatch evidence"] as const) test(`${stage} await rechecks ${change} before initial dispatch`, async () => {
    const f = fixture(); let changed = false;
    const mutate = async () => { if (changed) return; changed = true;
      if (change === "cancel") f.owner.stopRequested = true;
      else if (change === "capability") f.owner.contextMessages = { ...f.owner.contextMessages! };
      else if (change === "dispatch evidence") f.owner.dispatchEvidence = { ...f.owner.dispatchEvidence! };
      else f.owner.contextIdentity = { ...f.identity };
    };
    if (stage === "persist") f.controls.onPersist = mutate;
    if (stage === "settings") f.controls.onSettings = mutate;
    if (stage === "discovery") f.controls.onExecutionContext = mutate;
    await f.service.execute(f.owner, "ordinary", true, () => {});
    expect(f.spawns).toBe(0); expect(f.order).not.toContain("initial-before"); expect(f.order).toContain("withheld");
  });

  for (const evidencePresent of [true, false]) test(`native compact stays raw with ${evidencePresent ? "existing" : "no"} optional dispatch evidence`, async () => {
    const f = fixture(); f.run.operation = "compact";
    if (!evidencePresent) delete f.owner.dispatchEvidence;
    for (const field of ["contextMessages", "contextIdentity"]) Object.defineProperty(f.owner, field, { get() { throw new Error("Compact reached context transport"); } });
    await f.service.execute(f.owner, "/compact preserve decisions", true, () => {});
    expect(f.run.status).toBe("completed"); expect(f.requests).toEqual([]); expect(f.writes).toEqual(["/compact preserve decisions"]);
    expect(f.args).not.toContain("--input-format"); expect(f.order).toContain("end"); expect(f.order).toContain("compact-history");
    expect(f.initialOutcomes).toEqual(evidencePresent ? [["submitted", undefined]] : []);
  });

  test("canonical execution is retained, resumed snapshots disabled, legacy role injection refused", async () => {
    for (const canonical of [false, true]) {
      const f = fixture(); f.run.agent = "engineering"; f.run.agentKind = "assistant";
      f.run.model = "opus"; f.run.effort = "high";
      const policy = parseCanonicalAgentOperations("---\ndescription: Synthetic\nmode: primary\npermission:\n  shell: deny\n---\nROLE MUST NOT BECOME A SYSTEM PROMPT\n", "sane/assistant/engineering");
      if (canonical) f.deps.canonicalExecution = async () => ({ schema: 1, revision: "a".repeat(64), policy, children: [] });
      await f.service.execute(f.owner, "ordinary", true, () => {});
      expect(f.spawns).toBe(canonical ? 1 : 0);
      if (canonical) { expect(f.args).toContain("--system-prompt-snapshot"); expect(f.args[f.args.indexOf("--system-prompt-snapshot") + 1]).toBe("off");
        expect(f.args.join(" ")).not.toContain("ROLE MUST NOT"); expect(f.settings[0]).toContain("permissions");
        expect(f.args.slice(-4)).toEqual(["--model", "opus", "--effort", "high"]); }
    }
  });

  test("canonical native children and explicit protocol permission translation are unchanged", async () => {
    const f = fixture(); f.run.agent = "engineering"; f.run.agentKind = "assistant";
    const policy = parseCanonicalAgentOperations("---\ndescription: Parent\nmode: primary\npermission:\n  task:\n    sane/worker/implementer: allow\n---\nPARENT ROLE\n", "sane/assistant/engineering");
    const child = parseCanonicalAgentOperations("---\ndescription: Child\nmode: subagent\npermission:\n  shell: deny\n---\nNATIVE CHILD ROLE\n", "sane/worker/implementer");
    const protocol = { id: "explicit-v1" as const, operations: ["notify" as const], executionRevision: "execution", contextRevision: "context", runtimeCapabilities: [] };
    f.deps.canonicalExecution = async () => ({ schema: 1, revision: "a".repeat(64), policy, children: [child] });
    f.deps.explicitProtocol = () => protocol;
    const expected = claudeExecutionConfiguration({ policy, children: [child], protocol });
    await f.service.execute(f.owner, "ordinary", true, () => {});
    expect(f.run.status).toBe("completed");
    expect(f.args[f.args.indexOf("--agents") + 1]).toBe(expected.args[1]);
    expect(JSON.parse(f.settings[0]!).permissions).toEqual(expected.permissions);
    expect(expected.permissions.allow).toContain("mcp__sane__sane_worker_notify");
    const definitions = JSON.parse(f.args[f.args.indexOf("--agents") + 1]!);
    expect(definitions[expected.agent].prompt).toBe("");
    expect(Object.values(definitions).some((definition: any) => definition.prompt.includes("NATIVE CHILD ROLE"))).toBe(true);
  });

  test("minimum canonical Claude version remains enforced", async () => {
    const f = fixture(); f.run.agent = "engineering"; f.run.agentKind = "assistant";
    const policy = parseCanonicalAgentOperations("---\ndescription: Synthetic\nmode: primary\n---\nrole\n", "sane/assistant/engineering");
    f.deps.canonicalExecution = async () => ({ schema: 1, revision: "a".repeat(64), policy, children: [] });
    f.runtime.version = async () => "2.1.280";
    // Runtime options are copied at construction; supply version via a new service.
    const service = new ClaudeRunService({ dataDir: "/synthetic/data", claudeBin: "/synthetic/claude", claudeRoot: "/synthetic/config", packageRoot: "/synthetic/package", hookUrl: () => "local" }, f.deps, f.runtime);
    await service.execute(f.owner, "ordinary", true, () => {});
    expect(f.spawns).toBe(0); expect(f.owner.launchError).toContain("2.1.281");
  });

  test("initial stdin flush uncertainty records unknown, never accepted", async () => {
    const f = fixture(); f.controls.onFlush = async () => { throw new Error("uncertain flush"); };
    await f.service.execute(f.owner, "ordinary", true, () => {});
    expect(f.writes).toHaveLength(1); expect(f.initialOutcomes).toEqual([["unknown", undefined]]); expect(f.order).toContain("kill");
  });

  test("live input uses its own UUID, composed bytes and before-write/flush evidence only", async () => {
    const f = fixture(true), { running } = await background(f);
    const flush = deferred(), entered = deferred();
    f.controls.onFlush = async () => { entered.resolve(); await flush.promise; };
    const sending = f.service.sendInput(f.owner, "live 😀\r\n", () => {});
    await entered.promise;
    expect(f.liveOutcomes).toEqual([]); expect(f.writes).toHaveLength(2);
    const line = JSON.parse(f.writes[1]!);
    expect(line.uuid).toBe(liveUuid); expect(line.session_id).toBe(nativeId);
    expect(f.requests[1]).toEqual({ messageId: `${runId}:user:${liveUuid}`, body: "live 😀\r\n", boundary: "message", liveInput: true });
    expect(line.message.content).toBe(f.submissions[1]!.text);
    expect(f.actualReaders[1]!().identity).toBe(f.identity);
    expect(f.order.slice(f.order.lastIndexOf("message-before"), f.order.lastIndexOf("flush") + 1)).toEqual(["message-before", "write", "flush"]);
    expect(f.order.filter(item => item === "initial-before")).toHaveLength(1);
    flush.resolve(); expect(await sending).toEqual({ runId, messageId: `${runId}:user:${liveUuid}` });
    expect(f.liveOutcomes).toEqual([["submitted", undefined]]); expect(f.initialOutcomes).toEqual([["submitted", undefined]]);
    f.finish(); await running;
  });

  for (const stage of ["persist", "write", "flush"] as const) test(`live ${stage} failure classifies non-submission vs uncertainty`, async () => {
    const f = fixture(), { running } = await background(f);
    if (stage === "persist") f.controls.onPersist = async () => { throw new Error("before write"); };
    if (stage === "write") f.controls.onWrite = () => { throw new Error("uncertain write"); };
    if (stage === "flush") f.controls.onFlush = async () => { throw new Error("uncertain flush"); };
    await expect(f.service.sendInput(f.owner, "follow-up", () => {})).rejects.toThrow();
    expect(f.liveOutcomes).toEqual(stage === "persist" ? [["not-submitted", "not-accepted"]] : [["unknown", "unknown"]]);
    expect(f.order.filter(item => item === "initial-before")).toHaveLength(1);
    f.finish(); await running;
  });

  test("live preparation rejects identity replacement without touching native stdin", async () => {
    const f = fixture(), { running } = await background(f);
    f.controls.onPrepare = async () => { f.owner.contextIdentity = { ...f.identity }; };
    await expect(f.service.sendInput(f.owner, "follow-up", () => {})).rejects.toThrow();
    expect(f.writes).toHaveLength(1); expect(f.order).not.toContain("message-before");
    f.owner.contextIdentity = f.identity; f.finish(); await running;
  });

  test("uncertified live intent failure restores the unsent turn without claiming definite withholding", async () => {
    const f = fixture(), { running } = await background(f);
    f.controls.onBeforeMessage = () => { throw new Error("native intent refused"); };
    await expect(f.service.sendInput(f.owner, "follow-up", () => {})).rejects.toThrow("native intent refused");
    // A generic throw during intent may follow a partial evidence write. Without
    // a trusted refusal certificate, the coordinator must not invent an outcome.
    expect(f.writes).toHaveLength(1); expect(f.liveOutcomes).toEqual([]);
    expect(f.order.filter(item => item === "message-before")).toHaveLength(1);
    expect(f.initialOutcomes).toEqual([["submitted", undefined]]);
    expect(f.service.canSendInput(f.owner)).toBe(true); expect(f.order).not.toContain("kill");
    expect(f.order.filter(item => item === "initial-before")).toHaveLength(1);
    f.finish(); await running;
  });

  test("final beforeSend cannot replace the pinned context capability", async () => {
    const f = fixture(); f.owner.beforeSend = () => { f.owner.contextMessages = { ...f.owner.contextMessages! }; };
    await f.service.execute(f.owner, "ordinary", true, () => {});
    expect(f.spawns).toBe(0); expect(f.order).not.toContain("initial-before"); expect(f.order).toContain("withheld");
  });

  test("final beforeSend cannot replace or remove the captured initial dispatch evidence", async () => {
    for (const replace of [false, true]) {
      const f = fixture();
      f.owner.beforeSend = () => { f.owner.dispatchEvidence = replace ? { ...f.owner.dispatchEvidence! } : undefined; };
      await f.service.execute(f.owner, "ordinary", true, () => {});
      expect(f.spawns).toBe(0); expect(f.order).not.toContain("initial-before"); expect(f.order).toContain("withheld");
    }
  });

  test("actual-byte readers retain association observations despite terminal/cancellation/config state", async () => {
    const f = fixture(), { running } = await background(f);
    await f.service.sendInput(f.owner, "follow-up", () => {});
    f.finish(); await running;
    f.owner.stopRequested = true; f.owner.cancelling = true; f.owner.stopping = Promise.resolve(true); f.owner.settled = true;
    f.run.status = "failed"; f.run.model = "changed-after-send"; f.run.effort = "low";
    f.deps.owns = () => false; f.deps.closing = () => true; f.deps.storageFailed = () => true; f.deps.retained = () => true;
    f.owner.beforeSend = () => { throw new Error("Configuration admission must not gate observation"); };
    f.deps.execution = async () => { throw new Error("Execution configuration must not gate observation"); };
    delete f.owner.dispatchEvidence;
    expect(f.actualReaders).toHaveLength(2);
    for (const [index, read] of f.actualReaders.entries()) expect(read()).toEqual({ identity: f.identity,
      messageId: f.submissions[index]!.messageId, text: JSON.parse(f.writes[index]!).message.content });
    f.session.nativeSessionId = "foreign-source";
    for (const read of f.actualReaders) expect(read).toThrow();
  });
});
