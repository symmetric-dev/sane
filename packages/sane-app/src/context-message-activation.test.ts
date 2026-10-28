import { describe, expect, mock, test } from "bun:test";
import type { StoredSaneAgentIdentity } from "sane-core/agent-catalog";
import type { DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { parseCanonicalAgentOperations } from "./canonical-agent-operations";
import { validateCanonicalActivation } from "./canonical-activation-validation";
import type { CanonicalExecutionSnapshot } from "./canonical-execution-store";
import { composeContextMessage, type ContextMessageBinding } from "./context-message";
import {
  assertContextMessageActivation, contextMessageJournalSnapshot, ContextMessageActivationError, decodeContextMessageActivationPairing,
  type ContextMessageActivationExpected, type ContextMessageActivationRetention,
} from "./context-message-activation";
import { assertContextMessageCurrent, prepareContextMessage } from "./context-message-engine";
import { decodeContextMessageDispatchObservation, recordContextMessageSubmission, type ContextMessageEvidenceSnapshot } from "./context-message-evidence";
import { contextAsset, contextHash, type ContextPackage } from "./context-package";
import type { Event } from "./history";

// Entirely offline: actual composer/record codecs and pinned synthetic bytes;
// no adapters, stores, filesystem fixtures, transport or native processes.
const clone = <T>(value: T): T => structuredClone(value);
const protectedCoverage = { state: "complete" as const, source: "protected/activation-run/journal" };
const uuid = "12345678-1234-4123-8123-123456789abc";
function fixture(harnessId: "claude-code" | "opencode" = "opencode", identity: StoredSaneAgentIdentity = { kind: "assistant", role: "engineering" }, upgrade = false, free = false) {
  const binding: ContextMessageBinding = { harnessId, sessionId: "app-session", authorityId: "authority", nativeSessionId: harnessId === "opencode" ? "ses_native" : uuid, cwd: "/synthetic/checkout" };
  const dispatch: DispatchIdentity = { source: binding, runId: "activation-run", nativeCommandId: harnessId === "opencode" ? "msg_activation" : null, requestId: "activation-request" };
  const roleText = "Selected role bytes é😀";
  const policy = parseCanonicalAgentOperations(`---\ndescription: Synthetic policy\n---\n${roleText}`, `sane/${identity.kind}/${identity.role}`);
  const executionBody = { schema: 1 as const, policy, children: [] };
  const execution: CanonicalExecutionSnapshot = { ...executionBody, revision: contextHash(JSON.stringify(executionBody)) };
  const assets = [contextAsset(`role.${identity.kind}.${identity.role}`, "synthetic/role", roleText, "role"),
    contextAsset("framework.core", "synthetic/core", "Core conventions", "framework")];
  const initial = identity.kind === "assistant" ? [`sane-assistant-${identity.role}-pickup`] : [];
  if (identity.kind === "assistant") {
    assets.push(contextAsset("framework.assistant", "synthetic/assistant", "Assistant conventions", "framework"));
    if (identity.role === "planning" || identity.role === "execution") assets.push(contextAsset("framework.assignment-discipline", "synthetic/discipline", "Assignment conventions", "framework"));
    assets.push(contextAsset(initial[0]!, "synthetic/pickup", "Initial Pickup", "procedure"));
  } else assets.push(contextAsset(`worker-procedure.${identity.role}`, "synthetic/worker", "Worker procedure", "procedure"));
  const body = { schema: 1 as const, identity, assets, initial };
  const bundle: ContextPackage = { ...body, revision: contextHash(JSON.stringify(body)) };
  const paths = Object.fromEntries(assets.map(asset => [asset.id, `/synthetic/pinned/${asset.id}.md`]));
  const message = composeContextMessage({ binding, body: "Authored activation body\r\n", origin: identity.kind === "worker" ? "worker-launch" : upgrade ? "context-update" : "activation",
    placement: { kind: "bootstrap", ...(identity.kind === "worker" ? { workerMode: free ? "free" as const : "assigned" as const } : {}) }, context: { bundle, paths },
    session: { id: "session", category: "session", text: "Current protected membership", source: "owner/session", revision: "membership-1", reason: "Activation Session" },
    ...(identity.kind === "worker" ? { assignment: { id: "worker-assignment", category: "worker-assignment" as const, text: "Bounded worker task", source: "owner/assignment", revision: "assignment-1", reason: "Worker launch" } } : {}),
  });
  const messageId = dispatch.nativeCommandId ?? `${dispatch.runId}:user`;
  const submission = recordContextMessageSubmission(message, { messageId, text: message.transport.text }, dispatch);
  const expected: ContextMessageActivationExpected = { binding, identity, context: { schema: 1, revision: bundle.revision, delivery: "standing-native-role", ...(upgrade ? { activation: "upgrade" as const } : {}) }, execution: { schema: 1, revision: execution.revision } };
  const association = decodeContextMessageActivationPairing({ ...expected, schema: 1, type: "context-message-activation-pairing", dispatch,
    messageId, transportSha256: message.transport.sha256, intent: identity.kind === "worker" ? "worker-launch" : upgrade ? "assistant-upgrade" : "assistant-activation", source: protectedCoverage.source });
  const event = (kind: Event["kind"], data: unknown, seq = 1): Event => ({ kind, data, seq, sessionId: binding.sessionId, runId: dispatch.runId, time: "2026-10-26T00:00:00.000Z" });
  const observation = (submission: DispatchSubmissionEvidence["submission"], nativeAcceptance: DispatchSubmissionEvidence["nativeAcceptance"] = "unknown") => decodeContextMessageDispatchObservation({ schema: 1, type: "context-message-dispatch", messageId,
    transportSha256: message.transport.sha256, boundary: "run-initial", stage: submission === "attempted" ? "before-native" : "outcome", evidence: { ...dispatch, submission, nativeAcceptance } });
  const events = [event("submission", submission, 1), event("context", observation("attempted"), 2),
    event("context", observation("submitted", harnessId === "opencode" ? "accepted" : "unknown"), 3), event("context", association, 4)];
  const retention: ContextMessageActivationRetention = { binding, coverage: { state: "complete", source: "protected/later-runs-and-native-continuity" }, nativeContext: "retained", runs: [{ runId: dispatch.runId, sessionId: binding.sessionId, operation: "prompt" }] };
  const snapshot = contextMessageJournalSnapshot(events, protectedCoverage);
  return { expected, dispatch, binding, bundle, execution, association, submission, observation, events, snapshot, retention, event, message };
}
type Fixture = ReturnType<typeof fixture>;
function snapshot(events: readonly Event[]): ContextMessageEvidenceSnapshot {
  return contextMessageJournalSnapshot(events.map((event, index) => ({ ...event, seq: index + 1 })), protectedCoverage);
}
function assert(f: Fixture, evidence = f.snapshot, retention = f.retention) {
  return assertContextMessageActivation({ expected: f.expected, snapshot: evidence, retention });
}
function refuses(action: () => unknown, code: ContextMessageActivationError["code"] = "context-activation-unproven") {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(ContextMessageActivationError);
    expect((error as ContextMessageActivationError).code).toBe(code);
    return;
  }
  throw new Error("Expected activation refusal");
}

describe("activation pairing record codec", () => {
  test("exact immutable JSON roundtrip retains complete refs, not a delivered flag or prompt copy", () => {
    const f = fixture(), supplied = clone(f.association);
    const decoded = decodeContextMessageActivationPairing(JSON.parse(JSON.stringify(supplied)));
    expect(decoded).toEqual(supplied);
    expect(decoded).not.toBe(supplied);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.dispatch.source)).toBe(true);
    expect(Object.isFrozen(decoded.context)).toBe(true);
    expect(Object.isFrozen(supplied)).toBe(false);
    expect(Object.hasOwn(decoded, "delivered")).toBe(false);
    expect(JSON.stringify(decoded)).not.toContain(f.submission.text);
  });

  for (const field of ["root", "binding", "dispatch", "dispatch.source", "identity", "context", "execution"]) test(`rejects extra keys in ${field}`, () => {
    const value: any = clone(fixture().association);
    const target = field === "root" ? value : field.split(".").reduce((object, key) => object[key], value);
    target.extra = true;
    refuses(() => decodeContextMessageActivationPairing(value));
  });
  for (const field of Object.keys(fixture().association)) test(`rejects missing ${field}`, () => {
    const value: any = clone(fixture().association); delete value[field];
    refuses(() => decodeContextMessageActivationPairing(value));
  });
  const changes: [string, (value: any) => void][] = [
    ["schema", v => { v.schema = 2; }], ["type", v => { v.type = "canonical-activation"; }],
    ["context revision", v => { v.context.revision = "BAD"; }], ["execution revision", v => { v.execution.revision = "a".repeat(63); }],
    ["transport hash", v => { v.transportSha256 = "A".repeat(64); }], ["context schema", v => { v.context.schema = 0; }],
    ["execution schema", v => { v.execution.schema = "1"; }], ["delivery marker", v => { v.context.delivery = "context-message"; }],
    ["activation marker", v => { v.context.activation = "yes"; }], ["undefined marker", v => { v.context.activation = undefined; }],
    ["utility identity", v => { v.identity = { kind: "utility", role: "session-namer" }; }], ["role kind mismatch", v => { v.identity.kind = "worker"; }],
    ["unknown role", v => { v.identity.role = "not-a-role"; }], ["intent", v => { v.intent = "worker-launch"; }],
    ["blank source", v => { v.source = " "; }], ["empty message ID", v => { v.messageId = ""; }],
    ["null authority", v => { v.binding.authorityId = v.dispatch.source.authorityId = null; }],
    ["unknown harness", v => { v.binding.harnessId = v.dispatch.source.harnessId = "synthetic"; }],
    ["foreign dispatch binding", v => { v.dispatch.source = { ...v.dispatch.source, cwd: "/synthetic/other" }; }], ["OC native message ID", v => { v.dispatch.nativeCommandId = "msg_other"; }],
    ["null OC native message ID", v => { v.dispatch.nativeCommandId = null; }], ["null request ID", v => { v.dispatch.requestId = null; }],
  ];
  for (const [name, change] of changes) test(`rejects invalid ${name}`, () => {
    const value = clone(fixture().association); change(value);
    refuses(() => decodeContextMessageActivationPairing(value));
  });
  test("CC accepts only the correlated initial or UUID live-input message identity", () => {
    const f = fixture("claude-code");
    expect(decodeContextMessageActivationPairing({ ...f.association, messageId: `${f.dispatch.runId}:user:${uuid}` }).messageId).toEndWith(uuid);
    for (const messageId of ["foreign:user", `${f.dispatch.runId}:user:fake`]) refuses(() => decodeContextMessageActivationPairing({ ...f.association, messageId }));
  });
});

describe("read-only protected activation pairing", () => {
  for (const harness of ["claude-code", "opencode"] as const) test(`${harness} real composed bootstrap returns its honest transport/admission fact`, async () => {
    const f = fixture(harness);
    // This is the full independent pair check required BEFORE bridge persistence.
    await validateCanonicalActivation({ saneContext: { version: 1, framework: "synthetic", package: f.expected.context }, saneExecution: f.expected.execution }, f.expected.identity,
      { context: { load: async () => ({ bundle: f.bundle }) }, execution: { load: async () => f.execution } });
    const result = assert(f);
    expect(result.association).toEqual(f.association);
    expect(result.restart.fact).toBe(harness === "claude-code" ? "submitted-unconfirmed" : "accepted");
    expect(result.restart.composition).toEqual(f.submission.composition);
    expect(result.restart.provenance.every(value => value.source === protectedCoverage.source)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.restart)).toBe(true);
  });
  test("OC transport-only submission never masquerades as native acceptance", () => {
    const f = fixture(), events = clone(f.events);
    events[2]!.data = f.observation("submitted");
    refuses(() => assert(f, snapshot(events)));
  });
  test("CC explicitly accepted facts remain accepted", () => {
    const f = fixture("claude-code"), events = clone(f.events);
    events[2]!.data = f.observation("submitted", "accepted");
    expect(assert(f, snapshot(events)).restart.fact).toBe("accepted");
  });
  test("CC live upgrade requires its actual UUID submission and own message boundary", () => {
    const f = fixture("claude-code", { kind: "assistant", role: "engineering" }, true);
    const messageId = `${f.dispatch.runId}:user:${uuid}`;
    const submission = recordContextMessageSubmission(f.message, { messageId, text: f.message.transport.text, liveInput: true }, f.dispatch);
    const events = clone(f.events);
    events[0]!.data = submission;
    for (const event of events.slice(1)) event.data = { ...(event.data as object), messageId,
      ...(event.seq !== 4 ? { boundary: "message" } : {}) };
    expect(assert(f, snapshot(events)).restart.fact).toBe("submitted-unconfirmed");
    events[1]!.data = { ...(events[1]!.data as object), boundary: "run-initial" };
    refuses(() => assert(f, snapshot(events)));
  });
  for (const harness of ["claude-code", "opencode"] as const) test(`${harness} upgrade delivery marker and intent are pinned exactly`, () => {
    const f = fixture(harness, { kind: "assistant", role: "engineering" }, true);
    expect(assert(f).association.intent).toBe("assistant-upgrade");
    const wrong = clone(f.expected); delete wrong.context.activation;
    refuses(() => assertContextMessageActivation({ expected: wrong, snapshot: f.snapshot, retention: f.retention }));
    const changed = { ...clone(f.association), intent: "assistant-activation" };
    refuses(() => decodeContextMessageActivationPairing(changed));
  });
  for (const free of [false, true]) test(`worker ${free ? "free" : "assigned"} launch preserves role kind and worker bootstrap`, () => {
    const f = fixture("opencode", { kind: "worker", role: "implementer" }, false, free);
    expect(assert(f).association.intent).toBe("worker-launch");
    expect(f.message.segments.some(segment => segment.category === "worker-assignment")).toBe(true);
  });

  test("no evidence, legacy canonical receipts, run success and prepare-only cannot establish activation", () => {
    const f = fixture();
    for (const events of [[], [f.event("status", { status: "completed" })], [f.event("context", { type: "canonical-activation", delivered: true })],
      [f.event("submission", { messageId: f.association.messageId, text: f.submission.text }), f.event("context", f.association)],
      [f.events[0]!, f.events[3]!]]) refuses(() => assert(f, snapshot(events)));
  });
  test("attempt-only, unknown, withheld and explicit non-acceptance fail closed", () => {
    const f = fixture();
    const cases = [[f.events[0]!, f.events[1]!, f.events[3]!],
      [f.events[0]!, f.events[1]!, f.event("context", f.observation("unknown")), f.events[3]!],
      [f.events[0]!, f.event("context", f.observation("not-submitted", "not-accepted")), f.events[3]!],
      [f.events[0]!, f.events[1]!, f.event("context", f.observation("submitted", "not-accepted")), f.events[3]!]];
    for (const events of cases) refuses(() => assert(f, snapshot(events)));
  });
  test("accepted outcome without its durable before-native intent cannot activate", () => {
    const f = fixture();
    refuses(() => assert(f, snapshot([f.events[0]!, f.events[2]!, f.events[3]!])));
  });
  test("a later unknown outcome cannot borrow an earlier accepted fact", () => {
    const f = fixture();
    refuses(() => assert(f, snapshot([...f.events, f.event("context", f.observation("unknown"))])));
  });
  for (const state of ["partial", "unavailable"] as const) test(`${state} journal coverage fails closed`, () => {
    const f = fixture();
    refuses(() => assert(f, { ...f.snapshot, coverage: { ...protectedCoverage, state } }));
  });
  test("missing snapshot/retention produces domain refusal, not a storage mutation", () => {
    const f = fixture();
    refuses(() => assertContextMessageActivation({ expected: f.expected } as any));
    refuses(() => assertContextMessageActivation({ expected: f.expected, snapshot: f.snapshot } as any), "context-retention-unproven");
  });
  for (const key of ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"] as const) test(`trusted ${key} mismatch cannot be inherited/copied implicitly`, () => {
    const f = fixture(), expected = { ...clone(f.expected), binding: { ...f.binding, [key]: f.binding[key] + "-other" } };
    refuses(() => assertContextMessageActivation({ expected, snapshot: f.snapshot, retention: f.retention }));
  });
  for (const key of ["identity", "context", "execution"] as const) test(`trusted ${key} pin mismatch refuses`, () => {
    const f = fixture();
    const expected: ContextMessageActivationExpected = key === "identity"
      ? { ...f.expected, identity: { kind: "assistant", role: "planning" } }
      : { ...f.expected, [key]: { ...f.expected[key], revision: "f".repeat(64) } };
    refuses(() => assertContextMessageActivation({ expected, snapshot: f.snapshot, retention: f.retention }));
  });
  test("duplicate and foreign associations cannot be selected away", () => {
    const f = fixture();
    refuses(() => assert(f, snapshot([...f.events, f.event("context", f.association)])));
    const other = clone(f.association); other.execution.revision = "f".repeat(64);
    refuses(() => assert(f, snapshot([...f.events, f.event("context", other)])));
    const changed = clone(f.events); changed[3]!.data = { ...f.association, source: "another/journal" };
    refuses(() => assert(f, snapshot(changed)));
  });

  const tamper: [string, (events: Event[]) => void][] = [
    ["transport bytes", events => { (events[0]!.data as any).text += "changed"; }],
    ["transport pin", events => { (events[3]!.data as any).transportSha256 = "f".repeat(64); }],
    ["package revision", events => { (events[3]!.data as any).context.revision = "f".repeat(64); }],
    ["submission request ID", events => { (events[0]!.data as any).composition.dispatch.requestId += "-other"; }],
    ["submission native ID", events => { (events[0]!.data as any).composition.dispatch.nativeCommandId = "msg_other"; }],
    ["observation native ID", events => { (events[2]!.data as any).evidence.nativeCommandId = "msg_other"; }],
    ["observation source", events => { (events[2]!.data as any).evidence.source.nativeSessionId += "-other"; }],
    ["observation message ID", events => { (events[2]!.data as any).messageId = "msg_other"; }],
    ["observation hash", events => { (events[2]!.data as any).transportSha256 = "e".repeat(64); }],
    ["observation run", events => { (events[2]!.data as any).evidence.runId = "other-run"; }],
    ["foreign journal run", events => { events[2]!.runId = "other-run"; }],
    ["foreign journal session", events => { events[2]!.sessionId = "other-session"; }],
  ];
  for (const [name, change] of tamper) test(`rejects changed ${name}`, () => {
    const f = fixture(), events = clone(f.events); change(events);
    refuses(() => assert(f, snapshot(events)));
  });
  test("plain body-only cannot qualify as bootstrap even with submitted/accepted evidence", () => {
    const f = fixture(), events = clone(f.events);
    const message = composeContextMessage({ binding: f.binding, origin: "activation", body: "[SANE CONTEXT MESSAGE v1] role bytes", placement: { kind: "body-only" } });
    events[0]!.data = recordContextMessageSubmission(message, { messageId: f.association.messageId, text: message.transport.text }, f.dispatch);
    for (const event of events.slice(1)) (event.data as any).transportSha256 = message.transport.sha256;
    refuses(() => assert(f, snapshot(events)));
  });
  test("self-consistent bootstrap for another role cannot borrow the paired identity", () => {
    const f = fixture(), other = fixture("opencode", { kind: "assistant", role: "planning" });
    const events = clone(other.events), association = { ...clone(f.association), context: other.expected.context, transportSha256: other.message.transport.sha256 };
    events[3]!.data = association;
    refuses(() => assertContextMessageActivation({ expected: { ...f.expected, context: other.expected.context }, snapshot: snapshot(events), retention: f.retention }));
  });
  test("association cannot precede its actual standard submission", () => {
    const f = fixture();
    refuses(() => assert(f, snapshot([f.events[3]!, ...f.events.slice(0, 3)])));
  });
});

describe("protected coverage and retention", () => {
  test("helper takes dispatch observations ONLY from actual structured context journal events", () => {
    const f = fixture();
    const events = [...f.events, f.event("message", { text: "context-message-dispatch accepted" }), f.event("hook", f.observation("submitted", "accepted"))];
    const input = events.map((event, index) => ({ ...event, seq: index + 1 }));
    const projected = contextMessageJournalSnapshot(input, protectedCoverage);
    expect(projected.observations).toHaveLength(2);
    expect(projected.observations.map(value => value.order)).toEqual([2, 3]);
    expect(Object.isFrozen(input)).toBe(false);
    expect(assert(f, projected).restart.fact).toBe("accepted");
  });
  test("detached, omitted, duplicated or foreign-source observation side channels refuse", () => {
    const f = fixture();
    for (const observations of [[], f.snapshot.observations.slice(1), [...f.snapshot.observations, f.snapshot.observations[0]!],
      f.snapshot.observations.map(value => ({ ...value, source: "other/protected-source" })),
      f.snapshot.observations.map(value => ({ ...value, order: value.order + 1 }))]) refuses(() => assert(f, { ...f.snapshot, observations }));
  });
  test("helper refuses missing, duplicate, unordered or cross-run protected ordinals", () => {
    const f = fixture();
    for (const events of [[f.events[1]!], [f.events[0]!, f.events[0]!], [...f.events].reverse(), f.events.filter(event => event.seq !== 2),
      [...f.events, { ...f.event("status", {}), seq: 5, runId: "another-run" }]]) refuses(() => contextMessageJournalSnapshot(events, protectedCoverage));
  });
  const changes: [string, (value: any) => void][] = [
    ["unknown native continuity", value => { value.nativeContext = "unknown"; }], ["native reset", value => { value.nativeContext = "reset"; }],
    ["missing native continuity", value => { delete value.nativeContext; }], ["partial retention coverage", value => { value.coverage.state = "partial"; }],
    ["unavailable metadata", value => { value.coverage.state = "unavailable"; }], ["missing source", value => { value.coverage.source = ""; }],
    ["foreign native binding", value => { value.binding.nativeSessionId += "-other"; }], ["missing runs", value => { value.runs = []; }],
    ["activation run omitted", value => { value.runs[0].runId = "later-run"; }], ["foreign run", value => { value.runs[0].sessionId = "other-session"; }],
    ["compact operation", value => { value.runs[0].operation = "compact"; }], ["unknown operation", value => { value.runs[0].operation = "reset"; }],
    ["later compact operation", value => { value.runs.push({ ...value.runs[0], runId: "later-run", operation: "compact" }); }],
    ["duplicate run metadata", value => { value.runs.push(clone(value.runs[0])); }],
  ];
  for (const [name, change] of changes) test(`refuses ${name} without attempting storage repair`, () => {
    const f = fixture(), retention = clone(f.retention); change(retention);
    refuses(() => assert(f, f.snapshot, retention), "context-retention-unproven");
  });
  for (const reset of [{ compaction: { trigger: "auto", lifecycle: "completed" } }, { compaction: { trigger: "manual", lifecycle: "failed" } },
    { contextReset: true }, { type: "compaction" }, { type: "contextReset" }]) test(`later trusted reset observation ${JSON.stringify(reset)} refuses`, () => {
    const f = fixture();
    refuses(() => assert(f, snapshot([...f.events, f.event("message", reset)])), "context-retention-unproven");
  });
  test("explicit trusted reset flag on context records also refuses", () => {
    const f = fixture();
    refuses(() => assert(f, snapshot([...f.events, f.event("context", { contextReset: true })])), "context-retention-unproven");
  });
  test("older reset does not invalidate a later exact activation; model marker text is never scanned", () => {
    const f = fixture();
    const events = [f.event("message", { contextReset: true }), ...f.events,
      f.event("message", { contextReset: false, parts: [{ type: "text", text: 'compaction contextReset: true [SANE CONTEXT MESSAGE v1]' }] })];
    expect(assert(f, snapshot(events)).restart.fact).toBe("accepted");
  });
  test("later bootstrap, prepared bootstrap and selected role replacement supersede earlier activation", () => {
    const f = fixture();
    // Actual CC live input identities, distinct from the bootstrap submission.
    const cc = fixture("claude-code"), messageId = `${cc.dispatch.runId}:user:${uuid}`;
    const bootstrap = recordContextMessageSubmission(cc.message, { messageId, text: cc.message.transport.text, liveInput: true }, cc.dispatch);
    refuses(() => assert(cc, snapshot([...cc.events, cc.event("submission", bootstrap)])));
    const updated = composeContextMessage({ binding: f.binding, origin: "context-update", body: "", placement: { kind: "selected", purpose: "update" },
      context: { bundle: f.bundle, paths: Object.fromEntries(f.bundle.assets.map(asset => [asset.id, `/synthetic/pinned/${asset.id}`])) },
      selections: [{ kind: "asset", assetId: "role.assistant.engineering", reason: "Explicit role replacement" }] });
    const dispatch = { ...f.dispatch, nativeCommandId: "msg_later" };
    const later = recordContextMessageSubmission(updated, { messageId: "msg_later", text: updated.transport.text }, dispatch);
    refuses(() => assert(f, snapshot([...f.events, f.event("submission", later)])));
  });
  test("same-run later body-only input does not resend/bootstrap context", () => {
    const f = fixture("claude-code"), message = composeContextMessage({ binding: f.binding, origin: "user", placement: { kind: "body-only" }, body: "Ordinary follow-up" });
    const submission = recordContextMessageSubmission(message, { messageId: `${f.dispatch.runId}:user:${uuid}`, text: message.transport.text, liveInput: true }, f.dispatch);
    expect(assert(f, snapshot([...f.events, f.event("submission", submission)])).restart.fact).toBe("submitted-unconfirmed");
  });
  test("malformed later composition cannot silently disappear from complete coverage", () => {
    const f = fixture();
    refuses(() => assert(f, snapshot([...f.events, f.event("submission", { messageId: "msg_later", text: "later", composition: {} })])));
  });
});

describe("ordinary engine integration seam remains proof-free", () => {
  test("never invokes unused injected context, execution or historical activation callbacks", async () => {
    const f = fixture("claude-code"), forbidden = mock(() => { throw new Error("Inactive proof dependency must not run"); });
    const ordinary = { body: "\uFEFF  exact authored 😀\r\n", binding: f.binding, origin: "user" as const, placement: { kind: "body-only" as const } };
    const preparation = Object.assign({ kind: "ordinary" as const,
      guards: { assertOwnership() {}, assertSource() {}, assertNotCancelled() {} }, readCurrentOrdinary: () => clone(ordinary),
    }, { context: { load: forbidden }, execution: { load: forbidden }, readCurrentContext: forbidden, packageProvider: forbidden,
      readActivation: forbidden, policy: { kind: "sane", assertDurableActivationPairing: forbidden, validateExecution: forbidden } });
    const result = await prepareContextMessage(ordinary, preparation);
    expect(await assertContextMessageCurrent(result, preparation)).toBe(result);
    expect(result.transport.text).toBe(ordinary.body);
    expect(result.segments).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
  });
});
