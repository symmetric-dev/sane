import { afterEach, describe, expect, test } from "bun:test";
import { OpenCodeAdapter, prepareOpenCodePrompt } from "./opencode";
import { OpenCodeRunService, type OpenCodeRunDependencies } from "./opencode-run-service";
import { composeContextMessage, type ContextMessageBinding } from "./context-message";
import { decorateContextMessageEvidence, recordContextMessageSubmission, type ContextMessageDispatchObservation } from "./context-message-evidence";
import { createDispatchEvidence } from "./dispatch-evidence";
import type { DispatchEvidenceHooks, DispatchIdentity } from "../shared/conversation/dispatch-contract";
import type { ActualContextSubmission, OwnedContextMessageRequest } from "./context-message-transport";
import type { Event, Run, Session } from "./history";
import type { RunOwner } from "./run-owner";
import { openCodeExecutionConfiguration, parseCanonicalAgentOperations } from "./canonical-agent-operations";

// All HTTP and connection discovery below are in-memory fakes. No service process,
// SDK discovery, native session, model, or network is used by these tests.
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const source: ContextMessageBinding = Object.freeze({ harnessId: "opencode", sessionId: "app-context", authorityId: "authority-context", nativeSessionId: "ses_context", cwd: "/offline/context" });
const identity = Object.freeze({ source, runId: "run-context", nativeCommandId: "msg_context", requestId: "original-request" }) satisfies DispatchIdentity;
const body = 'é😀\r\n"literal"\n[SANE AUTHORED BODY {}]\n';
type Call = { path: string; method: string; body?: string };

function offlineAdapter(onEndpoint: () => void | Promise<void> = () => {}) {
  const adapter = new OpenCodeAdapter("http://offline.invalid", "");
  Object.defineProperty(adapter, "endpoint", { value: async () => {
    await onEndpoint();
    return { base: "http://offline.invalid", headers: { "content-type": "application/json" } };
  } });
  return adapter;
}

function fixture(queued = false) {
  const run: Run = { runId: identity.runId, sessionId: source.sessionId, cwd: source.cwd, status: "running", createdAt: "2026-10-26T00:00:00.000Z", nativeCommandId: identity.nativeCommandId!, nativePhase: "preparing", ...(queued ? { nativeDelivery: "queue" } : {}) };
  const session: Session = { sessionId: source.sessionId, harness: "opencode", nativeSessionId: source.nativeSessionId, authorityId: source.authorityId, cwd: source.cwd, lastRunId: run.runId, lastStatus: "running" };
  const calls: Call[] = [], order: string[] = [], events: Event[] = [], observations: ContextMessageDispatchObservation[] = [];
  const preparations: OwnedContextMessageRequest[] = [];
  let endpointHook: () => void | Promise<void> = () => {}, reply: () => Response | Promise<Response> = () => json({ data: queued
    ? { id: run.nativeCommandId, sessionID: source.nativeSessionId, type: "user", delivery: "queue", time: { created: 123 } }
    : { id: run.nativeCommandId, time: { created: 123 } } });
  const adapter = offlineAdapter(() => endpointHook());
  adapter.assertIdle = async () => { order.push("idle"); };
  adapter.select = async (_id, model, effort) => { order.push(`select:${model}:${effort}`); };
  adapter.preflightNativeSession = async () => { order.push("preflight"); };
  globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = { path: new URL(String(url)).pathname, method: init?.method ?? "GET", body: init?.body as string | undefined };
    calls.push(call); order.push(`fetch:${call.path}`);
    if (call.path === "/api/rpc/sane-execution/configure") {
      const input = JSON.parse(call.body!).input;
      return json({ output: { sessionID: input.sessionID, agent: input.agent, nativeChildren: input.nativeChildren.map((child: { id: string }) => child.id) } });
    }
    return reply();
  }, { preconnect: originalFetch.preconnect });
  let decorated: DispatchEvidenceHooks = {};
  const lifecycle = createDispatchEvidence(identity, {
    beforeNative: fact => decorated.beforeNative?.(fact), outcome: fact => decorated.outcome?.(fact),
  }, () => { order.push("fail-closed"); });
  const owner: RunOwner = { run, native: true, settled: false, done: Promise.resolve(), contextIdentity: identity,
    beforeSend: () => { order.push("before-send"); }, dispatchEvidence: lifecycle,
    ...(queued ? { nativeDeliveryPolicy: "native-queued-handoff", nativeQueuedHandoff: Object.freeze({ ...identity, nativeCommandId: identity.nativeCommandId!, requestId: identity.requestId!, origin: "queued-user" }) } : {}),
  };
  let preparedCurrent = true;
  let readBoundActual: (() => ActualContextSubmission) | undefined;
  owner.contextMessages = Object.freeze({ prepare: async (request, guard) => {
    guard(); preparations.push(request); order.push("prepare");
    const message = composeContextMessage({ binding: source, origin: queued ? "queued-user" : "user", body: request.body,
      placement: { kind: "selected", purpose: "sharing" }, selections: [{ kind: "fragment", fragment: {
        id: "context.fixture", category: "shared", text: "Selected context 🧪\r\n", source: "protected-offline-fixture", revision: "fixture-v1", reason: "explicit offline selection",
      } }] });
    return { message, assertCurrent: async () => { guard(); if (!preparedCurrent) throw new Error("Prepared selection changed"); },
      bindActual: readActual => {
        order.push("bind");
        readBoundActual = readActual;
        const actual = readActual();
        expect(actual.identity).toBe(owner.contextIdentity!);
        const submission = recordContextMessageSubmission(message, { messageId: actual.messageId, text: actual.text,
          ...(request.queuedFollowupId ? { queuedFollowupId: request.queuedFollowupId } : {}) }, actual.identity);
        decorated = decorateContextMessageEvidence({ submission, boundary: request.boundary, readActualSubmission: readActual,
          hooks: { beforeNative: () => { order.push("original-before-native"); }, outcome: () => { order.push("original-outcome"); } },
          persist: (_submission, observation) => {
            if (!events.some(event => event.kind === "submission" && (event.data as { messageId: string }).messageId === submission.messageId)) throw new Error("Missing reserved standard submission");
            observations.push(observation); order.push(`evidence:${observation.stage}`);
          },
          failClosed: () => { order.push("composition-fail-closed"); } });
        return submission;
      }, beforeMessageNative: () => { throw new Error("Initial OC prompt must use the original lifecycle"); },
      messageOutcome: () => { throw new Error("Initial OC prompt must use the original lifecycle"); },
    };
  } });
  const deps: OpenCodeRunDependencies = {
    oc: adapter, closing: () => false, storageFailed: () => false, currentOwner: () => owner, session: () => session, events: () => events,
    failClosed: error => { throw new Error("Offline OpenCode invariant failed", { cause: error }); },
    emit: async (_run, kind, data) => { order.push(`emit:${kind}`); events.push({ seq: events.length + 1, time: run.createdAt, runId: run.runId, sessionId: run.sessionId, kind, data }); },
    persist: async () => { order.push(`persist:${run.nativePhase}`); }, execution: async () => source.cwd,
    executionContext: async () => ({ workstreamId: null, artifactsRoot: source.cwd, executionCheckout: source.cwd }),
    compactExecution: async () => source.cwd, refreshCompactHistory: async () => {}, assertWorkerDeliverySubmission: () => {}, workerHasRun: () => false, sleep: async () => {},
  };
  const service = new OpenCodeRunService(deps);
  service.monitorNative = async () => { order.push("monitor"); };
  service.monitorNativeCompact = async () => { order.push("monitor-compact"); };
  return { run, session, owner, lifecycle, adapter, service, deps, calls, order, events, preparations, observations,
    endpoint: (hook: typeof endpointHook) => { endpointHook = hook; }, response: (hook: typeof reply) => { reply = hook; },
    stale: () => { preparedCurrent = false; }, execute: (text = body) => service.executeNative(owner, text, false, () => {}),
    readActual: () => { if (!readBoundActual) throw new Error("No bound actual reader"); return readBoundActual(); } };
}

function expectOriginalOutcome(f: ReturnType<typeof fixture>, acceptance: "accepted" | "unknown") {
  const submissions = f.events.filter(event => event.kind === "submission");
  expect(submissions).toHaveLength(1);
  const submission = submissions[0]!.data as ReturnType<typeof recordContextMessageSubmission>;
  expect(submission.composition.dispatch).toEqual(identity);
  expect(f.readActual()).toEqual({ identity, messageId: submission.messageId, text: submission.text });
  const correlation = { schema: 1, type: "context-message-dispatch", messageId: submission.messageId,
    transportSha256: submission.composition.transport.sha256, boundary: "run-initial" } as const;
  const final = { ...identity, submission: acceptance === "accepted" ? "submitted" : "unknown", nativeAcceptance: acceptance } as const;
  expect(f.lifecycle.snapshot()).toEqual(final);
  expect(f.observations[0]).toEqual({ ...correlation, stage: "before-native", evidence: { ...identity, submission: "attempted", nativeAcceptance: "unknown" } });
  const outcomes = f.observations.slice(1);
  expect(outcomes.length).toBeGreaterThan(0);
  // The coordinator and service can both observe the same uncertainty. The real
  // journal deduplicates identical facts; neither observer may replay intent or
  // downgrade uncertainty to definite withholding (or fabricate acceptance).
  for (const observation of outcomes) expect(observation).toEqual({ ...correlation, stage: "outcome", evidence: final });
  expect(f.order.filter(value => value === "original-before-native")).toHaveLength(1);
  expect(f.order.filter(value => value === "bind")).toHaveLength(1);
  expect(f.preparations).toHaveLength(1);
}

describe("OC immutable wire boundary", () => {
  test("pure packet serializes once; callback sees exactly the body passed to fetch", async () => {
    const adapter = offlineAdapter();
    const packet = prepareOpenCodePrompt(source.nativeSessionId, identity.nativeCommandId!, body);
    expect(Object.isFrozen(packet)).toBe(true);
    let observed = "", sent = "";
    globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent = init!.body as string; expect(sent).toBe(observed);
      return json({ data: { id: identity.nativeCommandId, time: { created: 1 } } });
    }, { preconnect: originalFetch.preconnect });
    await adapter.prompt(source.nativeSessionId, identity.nativeCommandId!, body, wire => { observed = wire; }, undefined, packet);
    expect(sent).toBe(packet.body);
    expect(JSON.parse(sent)).toEqual({ id: identity.nativeCommandId, text: body });
  });

  test("generic request runs toJSON before callback, and never rebuilds afterward", async () => {
    const adapter = offlineAdapter(), order: string[] = [];
    let value = "before", serialized = 0, sent = "";
    globalThis.fetch = Object.assign(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => { sent = init!.body as string; order.push("fetch"); return json({}); }, { preconnect: originalFetch.preconnect });
    await adapter.request("/offline", "POST", { toJSON: () => { serialized++; order.push("serialize"); return { value }; } }, () => { order.push("before-send"); value = "after"; });
    expect(serialized).toBe(1); expect(JSON.parse(sent)).toEqual({ value: "before" });
    expect(order).toEqual(["serialize", "before-send", "fetch"]);
    await expect(adapter.request("/offline", "POST", {}, () => { throw new Error("withheld"); })).rejects.toThrow("withheld");
    await expect(adapter.request("/offline", "POST", {}, async () => {})).rejects.toThrow("synchronously");
    expect(order.filter(value => value === "fetch")).toHaveLength(1);
  });

  for (const drift of ["id", "text", "source", "delivery"] as const) test(`packet ${drift} drift prevents POST`, async () => {
    const f = fixture();
    const packet = prepareOpenCodePrompt(drift === "source" ? "ses_other" : source.nativeSessionId, drift === "id" ? "msg_other" : identity.nativeCommandId!, drift === "text" ? "other" : body, drift === "delivery" ? "queue" : undefined);
    await expect(f.adapter.prompt(source.nativeSessionId, identity.nativeCommandId!, body, undefined, undefined, packet)).rejects.toThrow("packet differs");
    expect(f.calls).toHaveLength(0);
  });
});

describe("OC owner-composed submission", () => {
  for (const refusal of ["cancel", "status-failure"] as const) test(`${refusal} during initial status completes before preparation/binding without unpaired evidence`, async () => {
    const f = fixture(), statusStarted = Promise.withResolvers<void>(), statusCommit = Promise.withResolvers<void>();
    const emit = f.deps.emit; let firstStatus = true;
    f.deps.emit = async (run, kind, data) => {
      await emit(run, kind, data);
      if (kind === "status" && firstStatus) { firstStatus = false; statusStarted.resolve(); await statusCommit.promise; }
    };
    const executing = f.execute(); await statusStarted.promise;
    expect(f.preparations).toHaveLength(0); expect(f.order).not.toContain("bind");
    if (refusal === "cancel") { f.owner.stopRequested = true; statusCommit.resolve(); }
    else statusCommit.reject(new Error("Offline status commit failed"));
    await executing;
    f.lifecycle.finish();
    expect(f.calls).toHaveLength(0);
    expect(f.events.filter(event => event.kind === "submission")).toHaveLength(0);
    expect(f.order).not.toContain("bind"); expect(f.observations).toHaveLength(0);
    expect(f.lifecycle.snapshot().submission).toBe("not-submitted");
    expect(f.order).not.toContain("fail-closed"); expect(f.order).not.toContain("composition-fail-closed");
  });

  test("binding immediately reserves the standard submission before a cancellation microtask", async () => {
    const f = fixture(), messages = f.owner.contextMessages!;
    f.owner.contextMessages = Object.freeze({ prepare: async (request, guard) => {
      const prepared = await messages.prepare(request, guard);
      return { ...prepared, bindActual: readActual => {
        const submission = prepared.bindActual(readActual);
        queueMicrotask(() => { f.order.push("binding-microtask"); f.owner.stopRequested = true; });
        return submission;
      } };
    } });
    await f.execute(); f.lifecycle.finish();
    const bound = f.order.indexOf("bind");
    expect(f.order.indexOf("emit:status")).toBeLessThan(f.order.indexOf("prepare"));
    expect(f.order[bound + 1]).toBe("emit:submission");
    expect(f.order.indexOf("emit:submission")).toBeLessThan(f.order.indexOf("binding-microtask"));
    expect(f.calls).toHaveLength(0); expect(f.events.filter(event => event.kind === "submission")).toHaveLength(1);
    expect(f.lifecycle.snapshot().submission).toBe("not-submitted");
    expect(f.observations).toHaveLength(1); expect(f.observations[0]!.evidence.submission).toBe("not-submitted");
    expect(f.order).not.toContain("fail-closed"); expect(f.order).not.toContain("composition-fail-closed");
  });

  test("one exact composed submission, original evidence hooks, no synthetic or instruction PUT", async () => {
    const f = fixture(); await f.execute();
    const submissions = f.events.filter(event => event.kind === "submission");
    expect(submissions).toHaveLength(1);
    const submission = submissions[0]!.data as ReturnType<typeof recordContextMessageSubmission>;
    expect(submission.text).not.toBe(body);
    expect(submission.composition.dispatch).toEqual(identity);
    expect(f.preparations).toEqual([{ messageId: identity.nativeCommandId, body, boundary: "run-initial" }]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.path).toBe("/api/session/ses_context/prompt");
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ id: identity.nativeCommandId, text: submission.text });
    expect(f.order.indexOf("emit:status")).toBeLessThan(f.order.indexOf("emit:submission"));
    expect(f.order.indexOf("emit:submission")).toBeLessThan(f.order.indexOf("persist:preparing"));
    expect(f.order.indexOf("persist:sending")).toBeLessThan(f.order.indexOf("before-send"));
    expect(f.order.indexOf("evidence:before-native")).toBeLessThan(f.order.indexOf("fetch:/api/session/ses_context/prompt"));
    expect(f.observations.map(value => value.stage)).toEqual(["before-native", "outcome"]);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("accepted");
    expect(f.run.nativePhase).toBe("accepted");
  });

  for (const outcome of ["accepted", "unknown"] as const) {
    for (const drift of ["stop", "configuration", "settlement-and-shutdown"] as const) test(`original ${outcome} evidence survives ${drift} before acknowledgement`, async () => {
      const f = fixture();
      f.response(() => {
        if (drift === "stop") { f.owner.stopRequested = true; f.owner.cancelling = true; }
        if (drift === "configuration") { f.session.model = "offline/changed"; f.session.cwd = "/offline/changed"; f.run.model = "offline/changed"; }
        if (drift === "settlement-and-shutdown") {
          f.owner.settled = true; f.run.status = "interrupted";
          f.deps.closing = () => true; f.deps.currentOwner = () => undefined;
        }
        const actual = f.readActual(), sent = JSON.parse(f.calls[0]!.body!);
        expect(actual).toEqual({ identity, messageId: sent.id, text: sent.text });
        expect(actual.identity).toBe(identity);
        if (outcome === "unknown") throw new Error("Offline acknowledgement unavailable after drift");
        return json({ data: { id: identity.nativeCommandId, time: { created: 123 } } });
      });
      await f.execute();
      expect(f.calls).toHaveLength(1);
      expect(f.readActual().text).toBe(JSON.parse(f.calls[0]!.body!).text);
      expectOriginalOutcome(f, outcome);
      expect(f.lifecycle.snapshot().submission).toBe(outcome === "accepted" ? "submitted" : "unknown");
      expect(f.lifecycle.snapshot().nativeAcceptance).toBe(outcome);
      expect(f.order).not.toContain("composition-fail-closed");
    });
  }

  test("empty authored sharing comment still sends its nonempty selected context transport", async () => {
    const f = fixture(); await f.execute("");
    expect(f.preparations[0]!.body).toBe("");
    expect(f.calls).toHaveLength(1);
    const submission = f.events.find(event => event.kind === "submission")!.data as ReturnType<typeof recordContextMessageSubmission>;
    expect(submission.composition.body.range.length).toBe(0);
    expect(submission.text.length).toBeGreaterThan(0);
    expect(JSON.parse(f.calls[0]!.body!).text).toBe(submission.text);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("accepted");
  });

  for (const drift of ["run-object", "run-id", "command-id", "identity-reference", "capability-reference"] as const) test(`evidence reader still rejects changed original ${drift} association`, async () => {
    const f = fixture(); await f.execute();
    if (drift === "run-object") f.owner.run = { ...f.run };
    if (drift === "run-id") f.run.runId = "run_other";
    if (drift === "command-id") f.run.nativeCommandId = "msg_other";
    if (drift === "identity-reference") f.owner.contextIdentity = { ...identity };
    if (drift === "capability-reference") f.owner.contextMessages = { ...f.owner.contextMessages! };
    expect(() => f.readActual()).toThrow("Original native submission association changed");
  });

  for (const drift of ["cancel", "identity-reference", "request-id", "command-id", "source", "prepared-selection"] as const) test(`${drift} after an await prevents native POST`, async () => {
    const f = fixture();
    if (drift === "prepared-selection") {
      f.deps.execution = async () => { f.stale(); return source.cwd; };
    } else f.endpoint(() => {
      if (drift === "cancel") f.owner.stopRequested = true;
      if (drift === "identity-reference") f.owner.contextIdentity = Object.freeze({ ...identity });
      if (drift === "request-id") f.owner.contextIdentity = Object.freeze({ ...identity, requestId: "other-request" });
      if (drift === "command-id") f.run.nativeCommandId = "msg_other";
      if (drift === "source") f.session.cwd = "/offline/other";
    });
    await f.execute();
    expect(f.calls).toHaveLength(0);
    expect(f.owner.nativeDispatched).not.toBe(true);
    expect(f.lifecycle.boundaryState().phase).toBe("withheld");
    expect(f.run.status).toBe(drift === "cancel" ? "interrupted" : "failed");
  });

  test("ordinary prompt requires owner capability and never falls back", async () => {
    const f = fixture(); delete f.owner.contextMessages;
    await f.execute(); expect(f.calls).toHaveLength(0); expect(f.preparations).toHaveLength(0);
    expect(f.events.some(event => event.kind === "submission")).toBe(false);
    expect(f.run.status).toBe("failed");
  });

  test("ordinary prompt without its original dispatch evidence refuses before preparation or POST", async () => {
    const f = fixture(); delete f.owner.dispatchEvidence;
    await f.execute();
    expect(f.calls).toHaveLength(0); expect(f.preparations).toHaveLength(0); expect(f.order).not.toContain("bind");
    expect(f.events.some(event => event.kind === "submission")).toBe(false); expect(f.run.status).toBe("failed");
    expect(f.events.filter(event => event.kind === "status").map(event => event.data)).toEqual([
      { status: "failed", reason: expect.stringMatching(/dispatch evidence/i) },
    ]);
  });

  test("dispatch evidence reference drift before native boundary refuses instead of borrowing replacement hooks", async () => {
    const f = fixture();
    f.endpoint(() => { f.owner.dispatchEvidence = { beforeNative: () => { throw new Error("Wrong lifecycle"); }, outcome: () => { throw new Error("Wrong lifecycle"); }, withheld: () => { throw new Error("Wrong lifecycle"); } }; });
    await f.execute();
    expect(f.calls).toHaveLength(0); expect(f.lifecycle.boundaryState().phase).toBe("withheld");
    expect(f.order).not.toContain("original-before-native");
  });

  test("async owner beforeSend is refused synchronously without fetch or native intent", async () => {
    const f = fixture(); f.owner.beforeSend = async () => { await Promise.resolve(); };
    await f.execute(); f.lifecycle.finish();
    expect(f.calls).toHaveLength(0); expect(f.lifecycle.snapshot().submission).toBe("not-submitted");
    expect(f.order).not.toContain("original-before-native"); expect(f.order).not.toContain("fail-closed");
  });

  test("a synchronous beforeSend cancellation is withheld before original native intent", async () => {
    const f = fixture(); f.owner.beforeSend = () => { f.owner.stopRequested = true; };
    await f.execute(); f.lifecycle.finish();
    expect(f.calls).toHaveLength(0); expect(f.lifecycle.snapshot().submission).toBe("not-submitted");
    expect(f.order).not.toContain("original-before-native"); expect(f.order).not.toContain("fail-closed");
  });

  test("a stop immediately after original native intent retains unknown rather than definite withholding", async () => {
    const f = fixture(), evidence = f.owner.dispatchEvidence!;
    f.owner.dispatchEvidence = { ...evidence, beforeNative: () => { evidence.beforeNative(); f.owner.stopRequested = true; } };
    await f.execute(); f.lifecycle.finish();
    expect(f.calls).toHaveLength(0); expect(f.lifecycle.boundaryState().phase).toBe("possible-native");
    expect(f.lifecycle.snapshot().submission).toBe("unknown");
    expectOriginalOutcome(f, "unknown");
    expect(f.order).not.toContain("fail-closed"); expect(f.order).not.toContain("composition-fail-closed");
  });

  for (const drift of ["text", "id"] as const) test(`retained transport callback ${drift} drift fails closed before original intent`, async () => {
    const f = fixture(), prepare = f.adapter.preparePromptSubmission.bind(f.adapter);
    const failures: unknown[] = [], failClosed = f.deps.failClosed;
    let sends = 0;
    f.deps.failClosed = error => { failures.push(error); failClosed(error); };
    f.adapter.preparePromptSubmission = async (...args) => {
      const handle = await prepare(...args);
      return Object.freeze({ send: beforeSubmit => {
        sends++;
        return handle.send(encoded => {
          expect(encoded).toBe(args[4].body);
          const actual = JSON.parse(encoded); actual[drift] = "changed";
          beforeSubmit(JSON.stringify(actual));
        });
      } });
    };
    await f.execute(); f.lifecycle.finish();
    expect(sends).toBe(1); expect(f.calls).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: "wrong-wire", message: "Actual native wire differs from the bound submission" });
    expect(f.order).not.toContain("original-before-native");
    expect(f.owner.nativeDispatched).not.toBe(true); expect(f.run.status).toBe("failed");
    expect(f.lifecycle.boundaryState().phase).toBe("withheld");
    expect(f.lifecycle.snapshot()).toEqual({ ...identity, submission: "not-submitted", nativeAcceptance: "not-accepted" });
    const submission = f.events.find(event => event.kind === "submission")!.data as ReturnType<typeof recordContextMessageSubmission>;
    expect(f.observations).toEqual([{ schema: 1, type: "context-message-dispatch", messageId: identity.nativeCommandId,
      transportSha256: submission.composition.transport.sha256, boundary: "run-initial", stage: "outcome", evidence: f.lifecycle.snapshot() }]);
    expect(f.readActual()).toEqual({ identity, messageId: identity.nativeCommandId, text: submission.text });
  });

  test("selection drift inside final beforeSend guard prevents POST", async () => {
    const f = fixture(); f.owner.beforeSend = () => { f.owner.contextIdentity = { ...identity }; };
    await f.execute(); expect(f.calls).toHaveLength(0);
    expect(f.lifecycle.snapshot().nativeAcceptance).not.toBe("accepted");
  });

  for (const queued of [false, true]) test(`canonical execution payload remains independent and unchanged (queued=${queued})`, async () => {
    const f = fixture(queued);
    const policy = parseCanonicalAgentOperations("---\ndescription: offline assistant\nmode: primary\npermission:\n  task:\n    sane/worker/implementer: allow\n  bash: deny\n---\nParent instructions", "sane/assistant/engineering");
    const child = parseCanonicalAgentOperations("---\ndescription: offline child\nmode: subagent\npermission:\n  '*': allow\n---\nChild instructions", "sane/worker/implementer");
    f.session.agent = f.run.agent = "engineering"; f.session.agentKind = f.run.agentKind = "assistant";
    f.session.model = f.run.model = "offline/model"; f.session.effort = f.run.effort = "high";
    const protocol = { id: "explicit-v1" as const, operations: ["message-child" as const], executionRevision: "e", contextRevision: "c", runtimeCapabilities: [] };
    f.deps.canonicalExecution = async () => ({ schema: 1, policy, children: [child], revision: "offline-revision" });
    f.deps.explicitProtocol = () => protocol;
    await f.execute();
    const expected = openCodeExecutionConfiguration({ policy, children: [child], sessionID: source.nativeSessionId, directory: source.cwd, model: "offline/model", effort: "high", protocol });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ input: { ...expected, ...(queued ? { readOnly: true } : {}) } });
    expect(expected.model).toEqual({ providerID: "offline", id: "model", variant: "high" });
    expect(expected.nativeChildren[0]!.system).toBe("Child instructions");
    expect(expected.nativeChildren[0]!.permissions.slice(-4).every(rule => rule.effect === "deny")).toBe(true);
    expect(f.calls.map(call => call.path)).toEqual(["/api/rpc/sane-execution/configure", "/api/session/ses_context/prompt"]);
  });
});

describe("OC read-only migration cleanliness proof", () => {
  for (const entries of [[], [{ key: "other.context", value: "not owned by SANE" }]]) test(`successful scoped list proves absence (${entries.length} unrelated entries)`, async () => {
    const adapter = offlineAdapter(), calls: Call[] = [];
    globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = new URL(String(url)).pathname; calls.push({ path, method: init?.method ?? "GET" });
      return json({ data: path.endsWith("/instructions/entries") ? entries : { id: source.nativeSessionId, location: { directory: source.cwd } } });
    }, { preconnect: originalFetch.preconnect });
    await adapter.assertUserContextChannelClean(source.nativeSessionId, source.cwd);
    expect(calls.map(call => call.method)).toEqual(["GET", "GET"]);
    expect(calls[1]!.path).toBe("/api/experimental/session/ses_context/instructions/entries");
  });

  for (const failure of ["legacy-entry", "legacy-null", "duplicate", "missing-value", "malformed", "unsupported-404", "foreign-source"] as const) test(`${failure} refuses without cleanup or inferred absence`, async () => {
    const adapter = offlineAdapter(), methods: string[] = [];
    globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      if (!new URL(String(url)).pathname.endsWith("/instructions/entries")) return json({ data: { id: source.nativeSessionId, location: { directory: failure === "foreign-source" ? "/offline/other" : source.cwd } } });
      if (failure === "unsupported-404") return new Response(null, { status: 404 });
      const entry = { key: "sane.context", value: failure === "legacy-null" ? null : "legacy bytes" };
      return json({ data: failure === "malformed" ? {} : failure === "missing-value" ? [{ key: "other" }] : failure === "duplicate" ? [entry, entry] : [entry] });
    }, { preconnect: originalFetch.preconnect });
    await expect(adapter.assertUserContextChannelClean(source.nativeSessionId, source.cwd)).rejects.toMatchObject({ status: 409 });
    expect(methods.every(method => method === "GET")).toBe(true);
    if (failure === "foreign-source") expect(methods).toHaveLength(1);
  });
});

describe("OC strict queued handoff and compact isolation", () => {
  for (const repeatContradiction of [false, true]) test(`accepted queue contradiction during cancellation stays unsafe after later terminal (repeat=${repeatContradiction})`, async () => {
    const f = fixture(true), cancellationWait = Promise.withResolvers<void>(), clearCancellation = Promise.withResolvers<void>();
    const terminalWait = Promise.withResolvers<void>(), shutdown = Promise.withResolvers<void>(), cancel = Promise.withResolvers<boolean>();
    let reads = 0, lastObservation: "contradiction" | "terminal" = "contradiction", resolved = false;
    const contradictionEvents = () => f.events.filter(event => (event.data as { nativeQueuedHandoffProtocolMismatch?: boolean })?.nativeQueuedHandoffProtocolMismatch === true);
    f.adapter.observeCommand = async (_id, commandId) => {
      reads++;
      if (reads === 1 || repeatContradiction && reads === 2) {
        if (reads === 1) { f.owner.stopRequested = true; f.owner.cancelling = true; f.owner.stopping = cancel.promise; }
        lastObservation = "contradiction";
        return { messages: [], pending: false, observation: { kind: "protocol-contradiction", reason: "Original inbox receipt contradicts queue protocol" } };
      }
      lastObservation = "terminal";
      return { messages: [{ id: commandId, type: "user", text: body, time: { created: 123 } }], pending: false,
        observation: { kind: "exact-terminal", outcome: "succeeded" } };
    };
    f.deps.sleep = async () => {
      if (reads === 1) {
        cancellationWait.resolve(); await clearCancellation.promise;
        f.owner.cancelling = false; f.owner.stopping = undefined; cancel.resolve(true);
      } else if (lastObservation === "terminal") { terminalWait.resolve(); await shutdown.promise; }
    };
    f.service.monitorNative = async owner => { f.order.push("monitor"); await OpenCodeRunService.prototype.monitorNative.call(f.service, owner); };
    const executing = f.execute().then(() => { resolved = true; });
    await Promise.race([cancellationWait.promise, executing.then(() => { throw new Error("Owner settled before cancellation observation"); })]);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("accepted"); expect(f.run.nativePhase).toBe("accepted");
    expect(f.owner.cancelling).toBe(true); expect(f.owner.nativeHandoffProtocolUnsafe).toBe(true);
    expect(contradictionEvents()).toHaveLength(1); expect(f.run.status).toBe("running"); expect(resolved).toBe(false);
    // The contradiction's status and metadata are committed before the cancel wait.
    expect(f.order.at(-1)).toBe("persist:accepted");
    clearCancellation.resolve();
    await Promise.race([terminalWait.promise, executing.then(() => { throw new Error("Unsafe terminal snapshot released original ownership"); })]);
    expect(reads).toBe(repeatContradiction ? 3 : 2); expect(f.owner.cancelling).toBe(false);
    expect(f.owner.nativeHandoffProtocolUnsafe).toBe(true); expect(contradictionEvents()).toHaveLength(1);
    expect(f.run.status).toBe("running"); expect(resolved).toBe(false); expect(f.owner.settled).toBe(false);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("accepted"); // Preserve the earlier fact, never clear the unsafe overlay.
    expect(f.calls).toHaveLength(1);
    f.deps.closing = () => true; shutdown.resolve(); await executing;
    expect(f.run.status).toBe("running"); expect(f.owner.nativeHandoffProtocolUnsafe).toBe(true);
    expect(f.events.some(event => event.kind === "status" && (event.data as { status?: string }).status === "completed")).toBe(false);
  });

  for (const acknowledgement of ["accepted", "unknown"] as const) test(`Stop during queued ${acknowledgement} acknowledgement keeps original read-only monitor until native terminal proof`, async () => {
    const f = fixture(true), posted = Promise.withResolvers<void>(), ack = Promise.withResolvers<Response>();
    const activeObserved = Promise.withResolvers<void>(), allowReconciliation = Promise.withResolvers<void>(), cancel = Promise.withResolvers<boolean>();
    let active = true, activityReads = 0, sleeps = 0, resolved = false;
    const receipt = { id: identity.nativeCommandId, sessionID: source.nativeSessionId, type: "user" as const, delivery: "queue" as const, time: { created: 123 } };
    f.response(() => { posted.resolve(); return ack.promise; });
    f.adapter.activity = async (id, cwd) => {
      expect(id).toBe(source.nativeSessionId); expect(cwd).toBe(source.cwd); activityReads++;
      return { session: { id, location: { directory: cwd }, time: { created: 0, updated: 1 } }, active, pending: active };
    };
    f.adapter.observeCommand = async (id, commandId, cwd, policy) => {
      expect(commandId).toBe(identity.nativeCommandId); expect(policy).toBe("native-queued-handoff");
      const state = await f.adapter.activity(id, cwd);
      return state.active
        ? { messages: [], pending: true, pendingInput: receipt, observation: { kind: "pending", input: receipt } }
        : { messages: [{ id: commandId, type: "user", text: body, time: { created: 123 } }], pending: false, observation: { kind: "exact-terminal", outcome: "succeeded" } };
    };
    f.deps.sleep = async () => {
      if (++sleeps === 1) {
        activeObserved.resolve(); await allowReconciliation.promise;
        f.owner.cancelling = false; f.owner.stopping = undefined; cancel.resolve(true);
      } else active = false;
    };
    f.service.monitorNative = async owner => { f.order.push("monitor"); await OpenCodeRunService.prototype.monitorNative.call(f.service, owner); };
    const executing = f.execute().then(() => { resolved = true; });
    await posted.promise;
    f.owner.stopRequested = true; f.owner.cancelling = true; f.owner.stopping = cancel.promise;
    if (acknowledgement === "accepted") ack.resolve(json({ data: receipt }));
    else ack.reject(new Error("Offline acknowledgement lost while Stop awaits submission"));
    await Promise.race([activeObserved.promise, executing.then(() => { throw new Error("Original owner settled before native observation"); })]);
    expect(f.order).toContain("monitor"); expect(resolved).toBe(false);
    expect(f.run.status).toBe("running"); expect(f.owner.settled).toBe(false); expect(f.deps.currentOwner(source.sessionId)).toBe(f.owner);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe(acknowledgement);
    expect(f.calls).toHaveLength(1);
    allowReconciliation.resolve(); await executing;
    expect(activityReads).toBe(3); expect(f.run.status).toBe("completed");
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("accepted"); // Original exact inbox receipt recovers a lost ack.
    expect(f.calls.map(call => call.path)).toEqual(["/api/session/ses_context/prompt"]);
    expect(f.order.filter(value => value === "preflight")).toHaveLength(1);
    expect(f.order.some(value => value.startsWith("select:"))).toBe(false);
  });

  test("malformed queued acknowledgement during Stop persists unsafe protocol and retains monitor despite later terminal history", async () => {
    const f = fixture(true), observation = Promise.withResolvers<void>(), shutdown = Promise.withResolvers<void>();
    let resolved = false;
    f.response(() => {
      f.owner.stopRequested = true;
      return json({ data: { id: identity.nativeCommandId, time: { created: 123 } } }); // Not a queue-policy receipt.
    });
    f.adapter.observeCommand = async (_id, commandId) => ({
      messages: [{ id: commandId, type: "user", text: body, time: { created: 123 } }], pending: false,
      observation: { kind: "exact-terminal", outcome: "succeeded" },
    });
    f.deps.sleep = async () => { observation.resolve(); await shutdown.promise; };
    f.service.monitorNative = async owner => { f.order.push("monitor"); await OpenCodeRunService.prototype.monitorNative.call(f.service, owner); };
    const executing = f.execute().then(() => { resolved = true; });
    await Promise.race([observation.promise, executing.then(() => { throw new Error("Unsafe owner settled before shutdown retention"); })]);
    expect(f.owner.nativeHandoffProtocolUnsafe).toBe(true); expect(f.order).toContain("monitor");
    expect(f.run.status).toBe("running"); expect(resolved).toBe(false);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("unknown");
    const protocolEvents = f.events.filter(event => (event.data as { nativeQueuedHandoffProtocolMismatch?: boolean })?.nativeQueuedHandoffProtocolMismatch === true);
    expect(protocolEvents).toHaveLength(1);
    expect(f.order.indexOf("monitor")).toBeGreaterThan(f.order.lastIndexOf("persist:sending"));
    expect(f.calls).toHaveLength(1);
    f.deps.closing = () => true; shutdown.resolve(); await executing;
    expect(f.run.status).toBe("running"); expect(f.owner.nativeHandoffProtocolUnsafe).toBe(true);
    expect(f.events.some(event => event.kind === "status" && (event.data as { status?: string }).status === "completed")).toBe(false);
  });

  for (const boundary of ["owner-loss", "shutdown", "storage-failed", "outcome-policy-refusal"] as const) test(`actual queued protocol contradiction survives ${boundary} without replay`, async () => {
    const f = fixture(true), evidence = f.owner.dispatchEvidence!;
    if (boundary === "outcome-policy-refusal") f.owner.dispatchEvidence = { ...evidence, outcome: (submission, acceptance) => {
      evidence.outcome(submission, acceptance); throw new Error("Original owner refused follow-on policy after recording the fact");
    } };
    f.response(() => {
      f.owner.stopRequested = true; f.owner.cancelling = true;
      if (boundary === "owner-loss") f.deps.currentOwner = () => undefined;
      if (boundary === "shutdown") f.deps.closing = () => true;
      if (boundary === "storage-failed") f.deps.storageFailed = () => true;
      return json({ data: { id: identity.nativeCommandId, time: { created: 123 } } });
    });
    if (boundary === "outcome-policy-refusal") await expect(f.execute()).rejects.toThrow("Original owner refused follow-on policy");
    else await f.execute();
    expect(f.owner.nativeHandoffProtocolUnsafe).toBe(true); expect(f.calls).toHaveLength(1);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("unknown");
    const protocolEvents = f.events.filter(event => (event.data as { nativeQueuedHandoffProtocolMismatch?: boolean })?.nativeQueuedHandoffProtocolMismatch === true);
    expect(protocolEvents).toHaveLength(boundary === "storage-failed" ? 0 : 1);
    expect(f.order).not.toContain("monitor");
  });

  for (const outcome of ["accepted", "unknown"] as const) test(`queued original ${outcome} fact is recorded after cancellation, owner loss, and shutdown`, async () => {
    const f = fixture(true);
    f.response(() => {
      f.owner.stopRequested = true; f.owner.cancelling = true; f.owner.settled = true;
      f.deps.currentOwner = () => undefined; f.deps.closing = () => true;
      if (outcome === "unknown") throw new Error("Offline response lost after cancellation");
      return json({ data: { id: identity.nativeCommandId, sessionID: source.nativeSessionId, type: "user", delivery: "queue", time: { created: 123 } } });
    });
    await f.execute(); f.lifecycle.finish();
    expect(f.calls).toHaveLength(1); expect(f.order).not.toContain("monitor");
    expectOriginalOutcome(f, outcome);
    expect(f.lifecycle.snapshot().submission).toBe(outcome === "accepted" ? "submitted" : "unknown");
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe(outcome);
    expect(f.run.nativePhase).toBe("sending");
    expect(f.order).not.toContain("fail-closed"); expect(f.order).not.toContain("composition-fail-closed");
  });

  for (const drift of ["policy", "configuration"] as const) test(`queued immutable acknowledgement is observed before mutable ${drift} gates`, async () => {
    const f = fixture(true);
    f.response(() => {
      if (drift === "policy") f.owner.nativeDeliveryPolicy = "idle-only";
      else f.session.model = "offline/changed";
      return json({ data: { id: identity.nativeCommandId, sessionID: source.nativeSessionId, type: "user", delivery: "queue", time: { created: 123 } } });
    });
    await expect(f.execute()).rejects.toThrow();
    expect(f.calls).toHaveLength(1); expect(f.order).not.toContain("monitor");
    expect(f.observations.map(value => value.evidence.nativeAcceptance)).toEqual(["unknown", "accepted"]);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("accepted");
  });

  test("queued outcome calls captured original evidence even if the owner's capability is subsequently replaced", async () => {
    const f = fixture(true);
    f.response(() => {
      f.owner.settled = true;
      f.owner.dispatchEvidence = { beforeNative: () => { throw new Error("Wrong lifecycle"); }, outcome: () => { throw new Error("Wrong lifecycle"); }, withheld: () => { throw new Error("Wrong lifecycle"); } };
      return json({ data: { id: identity.nativeCommandId, sessionID: source.nativeSessionId, type: "user", delivery: "queue", time: { created: 123 } } });
    });
    await f.execute();
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("accepted"); expect(f.calls).toHaveLength(1);
    expect(f.observations.map(value => value.stage)).toEqual(["before-native", "outcome"]);
  });

  test("strict handoff uses same packet and original receipt identity without idle/selection", async () => {
    const f = fixture(true); await f.execute();
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(f.calls[0]!.body!).delivery).toBe("queue");
    expect(f.preparations[0]!.queuedFollowupId).toBe(identity.requestId);
    expect(f.order).toContain("preflight"); expect(f.order).not.toContain("idle");
    expect(f.order.some(value => value.startsWith("select:"))).toBe(false);
    expect(f.lifecycle.snapshot().nativeAcceptance).toBe("accepted");
  });

  for (const failure of ["missing-policy-receipt", "foreign-id", "empty", "malformed-json", "body-read", "timeout"] as const) test(`queued ${failure} remains unknown without resend`, async () => {
    const f = fixture(true);
    f.response(() => {
      if (failure === "timeout") throw new Error("offline timeout");
      if (failure === "body-read") return { ok: true, status: 200, text: async () => { throw new Error("offline read failure"); } } as unknown as Response;
      if (failure === "malformed-json") return new Response("not JSON");
      if (failure === "empty") return new Response(null, { status: 204 });
      return json({ data: failure === "foreign-id" ? { id: "msg_other", sessionID: source.nativeSessionId, type: "user", delivery: "queue", time: { created: 1 } } : { id: identity.nativeCommandId, time: { created: 1 } } });
    });
    await f.execute();
    expect(f.calls).toHaveLength(1); expect(f.run.status).toBe("running"); expect(f.run.nativePhase).toBe("sending");
    expect(f.lifecycle.snapshot().submission).toBe("unknown"); expect(f.lifecycle.snapshot().nativeAcceptance).toBe("unknown");
    expect(f.order).toContain("monitor");
  });

  test("handoff source/policy mutation still fails strict pins", async () => {
    const f = fixture(true); f.endpoint(() => { f.owner.nativeQueuedHandoff = { ...f.owner.nativeQueuedHandoff!, requestId: "changed" }; });
    await f.execute(); expect(f.calls).toHaveLength(0); expect(f.run.status).toBe("failed");
  });

  test("compact does not prepare or submit a context message; preserves coalesced native ID", async () => {
    const f = fixture(); f.run.operation = "compact";
    f.run.compact = { requestId: "compact-app-request", nativeRequestId: identity.nativeCommandId! };
    delete f.owner.contextMessages; delete f.owner.contextIdentity;
    f.response(() => json({ data: { id: "msg_coalesced", sessionID: source.nativeSessionId, type: "compaction", delivery: "queue", time: { created: 456 } } }));
    await f.service.executeNativeCompact(f.owner);
    expect(f.preparations).toHaveLength(0); expect(f.events.some(event => event.kind === "submission")).toBe(false);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.path).toBe("/api/session/ses_context/compact");
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ id: identity.nativeCommandId, delivery: "queue" });
    expect(f.run.compact.nativeRequestId).toBe(identity.nativeCommandId); expect(f.run.compact.nativeAdmittedId).toBe("msg_coalesced");
    expect(f.run.nativePhase).toBe("accepted"); expect(f.order).toContain("monitor-compact");
  });
});

describe("OC qualified native history prefix", () => {
  for (const qualified of [false, true]) {
    for (const revertedAt of ["initial", "final"] as const) test(`${qualified ? "qualified" : "ordinary"} history with ${revertedAt} session revert`, async () => {
      const adapter = offlineAdapter(); let sessionReads = 0, pageReads = 0;
      const storedMessage = { id: identity.nativeCommandId, type: "user", text: body, time: { created: 1 } };
      globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(init?.method ?? "GET").toBe("GET");
        const path = new URL(String(url)).pathname;
        if (path === "/api/session/active") return json({ data: {} });
        if (path.endsWith("/inbox")) return json({ data: [] });
        if (path.endsWith("/message")) { pageReads++; return json({ data: [storedMessage], cursor: { next: null } }); }
        sessionReads++;
        const reverted = revertedAt === "initial" || sessionReads > 1;
        // Stable timestamps deliberately do NOT certify an unreverted prefix.
        return json({ data: { id: source.nativeSessionId, location: { directory: source.cwd }, time: { created: 0, updated: 10 },
          ...(reverted ? { revert: { messageID: identity.nativeCommandId } } : {}) } });
      }, { preconnect: originalFetch.preconnect });
      const reading = adapter.history(source.nativeSessionId, source.cwd, qualified ? { requireUnreverted: true } : undefined);
      if (qualified) {
        await expect(reading).rejects.toThrow("Native history is reverted");
        expect(pageReads).toBe(revertedAt === "initial" ? 0 : 1);
      } else {
        const history = await reading;
        expect(history.rawMessages).toEqual([storedMessage]); expect(history.activity).toBe("idle");
        expect(sessionReads).toBe(2);
      }
    });
  }

  test("qualified history permits explicit null revert in both activity snapshots", async () => {
    const adapter = offlineAdapter(); let sessionReads = 0;
    globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/session/active") return json({ data: {} });
      if (path.endsWith("/inbox")) return json({ data: [] });
      if (path.endsWith("/message")) return json({ data: [], cursor: { next: null } });
      sessionReads++;
      return json({ data: { id: source.nativeSessionId, location: { directory: source.cwd }, time: { created: 0, updated: 10 }, revert: null } });
    }, { preconnect: originalFetch.preconnect });
    const history = await adapter.history(source.nativeSessionId, source.cwd, { requireUnreverted: true });
    expect(history.rawMessages).toEqual([]); expect(sessionReads).toBe(2);
  });
});
