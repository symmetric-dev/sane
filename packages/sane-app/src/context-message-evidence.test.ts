import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { composeContextMessage, type ContextMessageBinding } from "./context-message";
import {
  contextMessageFromSubmission, decodeContextMessageDispatchObservation, decodeContextMessageSubmission,
  decorateContextMessageEvidence, projectContextMessageBranch, projectContextMessageRestart, recordContextMessageSubmission,
  type ContextMessageAncestorReference, type ContextMessageBoundary, type ContextMessageDispatchObservation,
  type ContextMessageEvidenceSnapshot, type ContextMessageRestartFact, type VerifiedContextMessageBranchPrefix,
} from "./context-message-evidence";
import { createDispatchEvidence, DispatchPreNativeRefusal } from "./dispatch-evidence";
import type { Event } from "./history";

// Private deterministic fixtures: no adapters, native processes, storage, or models.
const source: ContextMessageBinding = {
  harnessId: "opencode", sessionId: "app-parent", authorityId: "authority-parent",
  nativeSessionId: "ses_parent", cwd: "/synthetic/parent",
};
const id: DispatchIdentity = { source, runId: "run-parent", nativeCommandId: "msg_parent", requestId: "request-parent" };
const liveUuid = "12345678-1234-4123-8123-123456789abc";
const markerBody = 'é😀\r\n[SANE CONTEXT MESSAGE v1]\n[/SANE CONTEXT SEGMENT]\n[SANE AUTHORED BODY {"bytes":0}]\n';
const segmentText = "🧪 selected é\n[/SANE CONTEXT SEGMENT]\n[SANE AUTHORED BODY {}]";
const clone = <T>(value: T): T => structuredClone(value);

function fixture(identity = id, messageId = identity.nativeCommandId ?? `${identity.runId}:user`, liveInput?: boolean) {
  const message = composeContextMessage({
    binding: identity.source as ContextMessageBinding, origin: "user", body: markerBody,
    placement: { kind: "selected", purpose: "sharing" },
    selections: [{ kind: "fragment", fragment: {
      id: "selected.fragment", category: "shared", text: segmentText,
      source: "protected-fixture", revision: "fixture-v1", reason: "explicit synthetic selection",
    } }],
  });
  const submission = recordContextMessageSubmission(message, {
    messageId, text: message.transport.text, ...(liveInput !== undefined ? { liveInput } : {}),
  }, identity);
  return { message, submission, identity, messageId };
}
type Fixture = ReturnType<typeof fixture>;
type DecoratorOptions = Parameters<typeof decorateContextMessageEvidence>[0];
type DecoratorOverrides = { -readonly [K in keyof DecoratorOptions]?: DecoratorOptions[K] };
function fact(f: Fixture, submission: DispatchSubmissionEvidence["submission"], nativeAcceptance: DispatchSubmissionEvidence["nativeAcceptance"] = "unknown"): DispatchSubmissionEvidence {
  return { ...f.identity, submission, nativeAcceptance };
}
function observation(f: Fixture, submission: DispatchSubmissionEvidence["submission"], nativeAcceptance: DispatchSubmissionEvidence["nativeAcceptance"] = "unknown", boundary: ContextMessageBoundary = "message"): ContextMessageDispatchObservation {
  return decodeContextMessageDispatchObservation({ schema: 1, type: "context-message-dispatch", messageId: f.messageId,
    transportSha256: f.message.transport.sha256, boundary, stage: submission === "attempted" ? "before-native" : "outcome",
    evidence: fact(f, submission, nativeAcceptance) });
}
function event(f: Fixture, data: unknown = f.submission, seq = 1): Event {
  return { seq, time: "2026-10-25T00:00:00.000Z", sessionId: f.identity.source.sessionId, runId: f.identity.runId, kind: "submission", data };
}
function snapshot(f: Fixture, values: readonly unknown[] = []): ContextMessageEvidenceSnapshot {
  return { coverage: { state: "complete", source: "protected-owner-snapshot" }, events: [event(f)],
    observations: values.map((value, index) => ({ source: "protected-owner-journal", order: index + 2, value })) };
}
function project(f: Fixture, input = snapshot(f)) {
  return projectContextMessageRestart({ identity: f.identity, messageId: f.messageId }, input);
}
function capture(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected synchronous failure");
}
function lifecycle(f = fixture(), overrides: DecoratorOverrides = {}) {
  const calls: string[] = [];
  const persisted: ContextMessageDispatchObservation[] = [];
  const decoratorFailures: unknown[] = [], ownerFailures: unknown[] = [];
  const hooks = decorateContextMessageEvidence({
    submission: f.submission, boundary: "message",
    hooks: { beforeNative: () => { calls.push("original:before"); }, outcome: () => { calls.push("original:outcome"); } },
    readActualSubmission: () => { calls.push("actual"); return { identity: f.identity, messageId: f.messageId, text: f.submission.text }; },
    persist: (_submission, value) => { calls.push(`persist:${value.stage}`); persisted.push(value); },
    failClosed: error => { decoratorFailures.push(error); }, ...overrides,
  });
  const owner = createDispatchEvidence(f.identity, hooks, error => { ownerFailures.push(error); });
  return { owner, hooks, calls, persisted, decoratorFailures, ownerFailures };
}

describe("context message submission metadata", () => {
  test("strict JSON roundtrip stores one outgoing text copy, immutable metadata, and lossless UTF-8 ranges", () => {
    const f = fixture();
    const decoded = decodeContextMessageSubmission(JSON.parse(JSON.stringify(f.submission)));
    expect(contextMessageFromSubmission(decoded)).toEqual(f.message);
    expect(decoded.text).toBe(f.message.transport.text);
    expect(JSON.stringify(decoded).split(JSON.stringify(decoded.text).slice(1, -1)).length - 1).toBe(1);
    expect(Object.hasOwn(decoded.composition.body, "text")).toBe(false);
    expect(Object.hasOwn(decoded.composition.transport, "text")).toBe(false);
    expect(decoded.composition.segments.every(item => !Object.hasOwn(item, "text"))).toBe(true);
    for (const [range, text] of [[decoded.composition.body.range, markerBody], [decoded.composition.segments[0]!.range, segmentText]] as const) {
      expect(Buffer.from(decoded.text).subarray(range.offset, range.offset + range.length).toString("utf8")).toBe(text);
      expect(range.length).toBe(Buffer.byteLength(text));
    }
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.composition.dispatch.source)).toBe(true);
    expect(Object.isFrozen(decoded.composition.segments[0]!.range)).toBe(true);
  });

  for (const location of ["root", "composition", "dispatch", "source", "body", "body-range", "transport", "segment", "provenance", "segment-range"] as const) {
    test(`rejects unknown fields in ${location}`, () => {
      const value = clone(fixture().submission) as any;
      const targets = { root: value, composition: value.composition, dispatch: value.composition.dispatch,
        source: value.composition.dispatch.source, body: value.composition.body, "body-range": value.composition.body.range,
        transport: value.composition.transport, segment: value.composition.segments[0], provenance: value.composition.segments[0].provenance,
        "segment-range": value.composition.segments[0].range };
      targets[location].extra = "not allowed";
      expect(() => decodeContextMessageSubmission(value)).toThrow();
    });
  }
  const tamperCases: [string, (value: any) => void][] = [
    ["text bytes", v => { v.text += " "; }], ["transport hash", v => { v.composition.transport.sha256 = "0".repeat(64); }],
    ["body hash", v => { v.composition.body.sha256 = "0".repeat(64); }], ["segment hash", v => { v.composition.segments[0].sha256 = "0".repeat(64); }],
    ["selection hash", v => { v.composition.selectionHash = "0".repeat(64); }], ["byte length", v => { v.composition.transport.byteLength++; }],
    ["UTF-8 split body", v => { v.composition.body.range.offset++; v.composition.body.range.length--; }],
    ["UTF-8 split segment", v => { v.composition.segments[0].range.offset++; v.composition.segments[0].range.length--; }],
    ["negative range", v => { v.composition.body.range.offset = -1; }], ["fractional range", v => { v.composition.body.range.length = 0.5; }],
    ["overflow range", v => { v.composition.body.range.length = Number.MAX_SAFE_INTEGER; }],
    ["segment provenance", v => { v.composition.segments[0].provenance.revision = "other"; }],
    ["legacy version", v => { v.composition.schema = 0; }], ["missing field", v => { delete v.composition.selectionHash; }],
    ["invalid live flag", v => { v.liveInput = "true"; }], ["empty queue ID", v => { v.queuedFollowupId = ""; }],
  ];
  for (const [name, mutate] of tamperCases) test(`rejects tampered ${name}`, () => {
    const value = clone(fixture().submission); mutate(value);
    expect(() => decodeContextMessageSubmission(value)).toThrow();
  });
  test("marker-looking body-only bytes remain ordinary authored content", () => {
    const message = composeContextMessage({ binding: source, origin: "user", placement: { kind: "body-only" }, body: markerBody });
    const submission = recordContextMessageSubmission(message, { messageId: "msg_parent", text: markerBody }, id);
    expect(contextMessageFromSubmission(submission).segments).toEqual([]);
    expect(submission.text).toBe(markerBody);
  });
  test("does not mutate caller metadata while decoding", () => {
    const value = clone(fixture().submission);
    const decoded = decodeContextMessageSubmission(value);
    expect(decoded).not.toBe(value);
    expect(Object.isFrozen(value)).toBe(false);
  });
  test("actual transport bytes and pinned source must match the composition", () => {
    const f = fixture();
    expect(() => recordContextMessageSubmission(f.message, { messageId: f.messageId, text: f.submission.text + "\n" }, id)).toThrow();
    for (const key of Object.keys(source) as (keyof ContextMessageBinding)[]) {
      const foreign = { ...id, source: { ...source, [key]: `other-${key}` } };
      expect(() => recordContextMessageSubmission(f.message, { messageId: f.messageId, text: f.submission.text }, foreign)).toThrow();
    }
  });
  test("OC requires the actual native command message identity", () => {
    const f = fixture();
    expect(() => recordContextMessageSubmission(f.message, { messageId: "msg_other", text: f.submission.text }, id)).toThrow();
    expect(() => fixture({ ...id, nativeCommandId: null }, "msg_parent")).toThrow();
  });
  test("CC initial and UUID live messages retain distinct per-message identities", () => {
    const cc = { ...id, source: { ...source, harnessId: "claude-code" }, nativeCommandId: null };
    expect(fixture(cc, `${cc.runId}:user`).submission.liveInput).toBeUndefined();
    expect(fixture(cc, `${cc.runId}:user:${liveUuid}`, true).submission.liveInput).toBe(true);
    for (const [messageId, live] of [[`${cc.runId}:user`, true], [`${cc.runId}:user:${liveUuid}`, false], [`${cc.runId}:user:not-uuid`, true], ["foreign:user", false]] as const) {
      expect(() => fixture(cc, messageId, live)).toThrow();
    }
  });
});

describe("decorator composes the existing dispatch evidence lifecycle", () => {
  test("original hooks and synchronous persistence finish before native continuation; one owner forbids replay", () => {
    const f = fixture(), h = lifecycle(f);
    expect(h.owner.boundaryState().phase).toBe("fresh");
    h.owner.beforeNative(); h.calls.push("native");
    expect(h.calls).toEqual(["actual", "original:before", "persist:before-native", "native"]);
    expect(h.owner.snapshot()).toEqual(fact(f, "attempted"));
    h.owner.outcome("submitted", "accepted");
    expect(h.calls.slice(-3)).toEqual(["actual", "original:outcome", "persist:outcome"]);
    expect(h.persisted.map(value => value.evidence.submission)).toEqual(["attempted", "submitted"]);
    expect(() => h.owner.beforeNative()).toThrow("replay forbidden");
    h.owner.finish(); h.owner.finish();
    expect(h.persisted).toHaveLength(2);
    expect(h.decoratorFailures).toEqual([]); expect(h.ownerFailures).toEqual([]);
  });
  test("decorator itself does not implement a second admission state machine", () => {
    const f = fixture(), h = lifecycle(f);
    // Direct hooks validate/persist facts; only the existing owner gates transitions.
    h.hooks.beforeNative!(fact(f, "attempted")); h.hooks.beforeNative!(fact(f, "attempted"));
    expect(h.persisted).toHaveLength(2);
    expect(h.owner.boundaryState().phase).toBe("fresh");
    h.owner.beforeNative();
    expect(h.persisted).toHaveLength(3);
  });
  test("original hooks receive existing exact-shape facts, not extended composition identities", () => {
    const f = fixture(), received: DispatchSubmissionEvidence[] = [];
    const h = lifecycle(f, { hooks: { beforeNative: value => { received.push(value); }, outcome: value => { received.push(value); } } });
    h.owner.beforeNative(); h.owner.outcome("submitted", "accepted");
    expect(received).toEqual([fact(f, "attempted"), fact(f, "submitted", "accepted")]);
    for (const value of received) {
      expect(Object.keys(value).sort()).toEqual(["source", "runId", "nativeCommandId", "requestId", "submission", "nativeAcceptance"].sort());
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
  test("only an original synchronous intent refusal is certified, unchanged and without attempt/persistence/failClosed", () => {
    const refusal = new DispatchPreNativeRefusal(new Error("durably paused by owner"));
    let persists = 0;
    const h = lifecycle(fixture(), { hooks: { beforeNative: () => { throw refusal; } }, persist: () => { persists++; } });
    expect(capture(() => h.owner.beforeNative())).toBe(refusal);
    expect(h.owner.refused()).toBe(true); expect(h.owner.recognizesRefusal(refusal)).toBe(true);
    expect(h.owner.recognizesRefusal(new DispatchPreNativeRefusal(new Error(refusal.message)))).toBe(false);
    expect(h.owner.snapshot().submission).toBe("not-submitted");
    expect(h.owner.boundaryState()).toEqual({ phase: "withheld", withholdingObserved: false });
    expect(persists).toBe(0); expect(h.decoratorFailures).toEqual([]); expect(h.ownerFailures).toEqual([]);
  });

  for (const site of ["actual", "original-before", "persist-before", "original-outcome", "persist-outcome"] as const) {
    for (const refusalClass of [false, true]) test(`${site} ${refusalClass ? "refusal-class" : "ordinary"} failure fails closed unless original intent certifies`, () => {
      const failure = refusalClass ? new DispatchPreNativeRefusal(new Error(`failure:${site}`)) : new Error(`failure:${site}`);
      const overrides: DecoratorOverrides = {};
      if (site === "actual") overrides.readActualSubmission = () => { throw failure; };
      if (site === "original-before") overrides.hooks = { beforeNative: () => { throw failure; } };
      if (site === "original-outcome") overrides.hooks = { outcome: () => { throw failure; } };
      if (site.startsWith("persist")) overrides.persist = (_submission, value) => {
        if (value.stage === (site === "persist-before" ? "before-native" : "outcome")) throw failure;
      };
      const h = lifecycle(fixture(), overrides);
      const outcomeSite = site.endsWith("outcome");
      if (outcomeSite) h.owner.beforeNative();
      const propagated = capture(() => outcomeSite ? h.owner.outcome("submitted", "accepted") : h.owner.beforeNative());
      const certified = site === "original-before" && refusalClass;
      const wrapped = !outcomeSite && refusalClass && !certified;
      if (wrapped) {
        expect(propagated).toBeInstanceOf(Error);
        expect(propagated).not.toBeInstanceOf(DispatchPreNativeRefusal);
        expect(propagated).not.toBe(failure);
        expect((propagated as Error).cause).toBe(failure);
      } else expect(propagated).toBe(failure);
      expect(h.decoratorFailures).toEqual(certified ? [] : [propagated]);
      // This assertion catches laundering a persistence/identity exception into the
      // outer owner's special certified-refusal path merely because of its class.
      expect(h.owner.refused()).toBe(certified);
      expect(h.owner.recognizesRefusal(propagated)).toBe(certified);
      expect({ certifiedRefusal: h.owner.recognizesRefusal(failure), ownerFailClosedCalled: h.ownerFailures.includes(propagated) })
        .toEqual({ certifiedRefusal: certified, ownerFailClosedCalled: !certified });
    });
  }
  test("failClosed exceptions never replace the original failure identity", () => {
    const original = new Error("original storage failure"), secondary = new Error("failClosed failed");
    const h = lifecycle(fixture(), { persist: () => { throw original; }, failClosed: () => { throw secondary; } });
    expect(capture(() => h.owner.beforeNative())).toBe(original);
    expect(h.ownerFailures).toEqual([original]);
  });
  test("a failing failure callback cannot recertify a wrapped non-owner refusal", () => {
    const original = new DispatchPreNativeRefusal(new Error("persistence did not certify intent"));
    const secondary = new DispatchPreNativeRefusal(new Error("failure callback did not certify intent"));
    const h = lifecycle(fixture(), { persist: () => { throw original; }, failClosed: () => { throw secondary; } });
    const propagated = capture(() => h.owner.beforeNative());
    expect(propagated).toBeInstanceOf(Error);
    expect(propagated).not.toBeInstanceOf(DispatchPreNativeRefusal);
    expect((propagated as Error).cause).toBe(original);
    expect(h.owner.refused()).toBe(false);
    expect(h.owner.recognizesRefusal(original)).toBe(false);
    expect(h.owner.recognizesRefusal(secondary)).toBe(false);
    expect(h.ownerFailures).toEqual([propagated]);
    expect(h.persisted).toEqual([]);
  });
  for (const changed of ["messageId", "text", "harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd", "runId", "nativeCommandId", "requestId"] as const) {
    test(`rejects actual ${changed} mismatch before original hook or persistence`, () => {
      const f = fixture();
      const actual = { identity: clone(f.identity), messageId: f.messageId, text: f.submission.text } as any;
      if (changed === "messageId" || changed === "text") actual[changed] += "-foreign";
      else if (Object.hasOwn(source, changed)) actual.identity.source[changed] += "-foreign";
      else actual.identity[changed] += "-foreign";
      const h = lifecycle(f, { readActualSubmission: () => actual });
      const error = capture(() => h.owner.beforeNative());
      expect(h.decoratorFailures).toEqual([error]); expect(h.ownerFailures).toEqual([error]);
      expect(h.calls).toEqual([]); expect(h.persisted).toEqual([]);
    });
  }
  test("supplied dispatch fact is also bound exactly, not only readActualSubmission", () => {
    const f = fixture(), h = lifecycle(f);
    const error = capture(() => h.hooks.beforeNative!({ ...fact(f, "attempted"), requestId: "foreign" }));
    expect(h.decoratorFailures).toEqual([error]); expect(h.persisted).toEqual([]);
  });
  for (const site of ["actual", "original-before", "persist-before", "original-outcome", "persist-outcome", "failClosed"] as const) {
    test(`promise-returning ${site} is rejected synchronously and its rejection is handled`, async () => {
      const rejection = new Error(`async rejection:${site}`);
      let promise: Promise<never> | undefined;
      const asyncHook = () => { promise = Promise.reject(rejection); return promise; };
      const overrides: DecoratorOverrides = {};
      if (site === "actual") overrides.readActualSubmission = asyncHook as unknown as NonNullable<typeof overrides.readActualSubmission>;
      if (site === "original-before") overrides.hooks = { beforeNative: asyncHook };
      if (site === "original-outcome") overrides.hooks = { outcome: asyncHook };
      if (site.startsWith("persist")) overrides.persist = (_submission, value) => {
        if (value.stage === (site === "persist-before" ? "before-native" : "outcome")) return asyncHook();
      };
      if (site === "failClosed") {
        overrides.persist = () => { throw rejection; };
        overrides.failClosed = asyncHook;
      }
      const h = lifecycle(fixture(), overrides);
      const outcomeSite = site.endsWith("outcome");
      if (outcomeSite) h.owner.beforeNative();
      const error = capture(() => outcomeSite ? h.owner.outcome("submitted", "accepted") : h.owner.beforeNative());
      if (site === "failClosed") expect(error).toBe(rejection);
      else expect((error as Error).message).toContain("synchronously");
      expect(promise).toBeDefined();
      // Let the runtime's unhandled-rejection reporting observe the same turn.
      // No test catch is attached to this promise: production must consume it.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(h.owner.refused()).toBe(false);
    });
  }
  test("an async original intent rejection carrying refusal class is not a certified refusal", async () => {
    const refusal = new DispatchPreNativeRefusal(new Error("not synchronously certified"));
    const h = lifecycle(fixture(), { hooks: { beforeNative: () => Promise.reject(refusal) } });
    const error = capture(() => h.owner.beforeNative());
    expect(error).not.toBe(refusal); expect(h.owner.refused()).toBe(false);
    expect(h.decoratorFailures).toEqual([error]); expect(h.ownerFailures).toEqual([error]);
    await new Promise<void>(resolve => setImmediate(resolve));
  });
  test("custom rejecting thenables also fail synchronously without unhandled rejection", async () => {
    const rejection = new Error("thenable persistence is not synchronous"); let consumed = false;
    const thenable = { then(_resolve: unknown, reject: (reason: unknown) => void) { consumed = true; reject(rejection); } };
    const h = lifecycle(fixture(), { persist: () => thenable });
    const error = capture(() => h.owner.beforeNative());
    expect((error as Error).message).toContain("synchronously");
    expect(h.decoratorFailures).toEqual([error]); expect(h.ownerFailures).toEqual([error]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(consumed).toBe(true);
  });

  for (const acceptance of ["accepted", "not-accepted", "unknown"] as const) {
    test(`existing submitted/${acceptance} semantics and weaker updates survive decoration`, () => {
      const f = fixture(), h = lifecycle(f);
      h.owner.beforeNative(); h.owner.outcome("submitted", acceptance); h.owner.outcome("unknown"); h.owner.finish();
      expect(h.owner.snapshot()).toEqual(fact(f, "submitted", acceptance));
      expect(h.persisted).toHaveLength(2);
      if (acceptance !== "unknown") expect(() => h.owner.outcome("submitted", acceptance === "accepted" ? "not-accepted" : "accepted")).toThrow();
    });
  }
  test("acceptance can strengthen submitted-unconfirmed but cannot contradict an exact fact", () => {
    const h = lifecycle(); h.owner.beforeNative(); h.owner.outcome("submitted"); h.owner.outcome("submitted", "accepted");
    expect(h.persisted).toHaveLength(3);
    expect(() => h.owner.outcome("submitted", "not-accepted")).toThrow();
    expect(h.persisted).toHaveLength(3);
  });
  test("explicit withholding is observed only on successful finish and closes native admission", () => {
    const h = lifecycle(); h.owner.withheld(); h.owner.finish();
    expect(h.owner.boundaryState()).toEqual({ phase: "withheld", withholdingObserved: true });
    expect(h.persisted.map(value => value.evidence.submission)).toEqual(["not-submitted"]);
    expect(() => h.owner.beforeNative()).toThrow();
  });
  test("failed withholding persistence never sets durable withholdingObserved", () => {
    const failure = new Error("withholding observation could not be persisted");
    const h = lifecycle(fixture(), { persist: () => { throw failure; } });
    h.owner.withheld();
    expect(capture(() => h.owner.finish())).toBe(failure);
    expect(h.owner.boundaryState()).toEqual({ phase: "withheld", withholdingObserved: false });
    expect(h.decoratorFailures).toEqual([failure]); expect(h.ownerFailures).toEqual([failure]);
  });
  test("legacy finish and unresolved native attempt remain unknown, not definite non-submission", () => {
    const legacy = lifecycle(); legacy.owner.finish();
    expect(legacy.owner.snapshot().submission).toBe("unknown"); expect(legacy.owner.boundaryState().phase).toBe("unconfirmed");
    expect(() => legacy.owner.beforeNative()).toThrow();
    const attempted = lifecycle(); attempted.owner.beforeNative(); attempted.owner.finish();
    expect(attempted.owner.snapshot().submission).toBe("unknown");
    expect(attempted.persisted.map(value => value.evidence.submission)).toEqual(["attempted", "unknown"]);
    expect(() => attempted.owner.withheld()).toThrow();
  });
  test("CC initial hooks cannot certify live input in the same run", () => {
    const cc = { ...id, source: { ...source, harnessId: "claude-code" }, nativeCommandId: null };
    const initial = fixture(cc, `${cc.runId}:user`), live = fixture(cc, `${cc.runId}:user:${liveUuid}`, true);
    const initialOwner = lifecycle(initial, { boundary: "run-initial" }); initialOwner.owner.beforeNative(); initialOwner.owner.outcome("submitted");
    expect(() => lifecycle(live, { boundary: "run-initial" })).toThrow();
    const liveOwner = lifecycle(live); liveOwner.owner.beforeNative(); liveOwner.owner.outcome("submitted");
    expect(liveOwner.persisted[0]!.messageId).toBe(live.messageId);
    expect(initialOwner.persisted[0]!.messageId).not.toBe(liveOwner.persisted[0]!.messageId);
  });
  for (const stage of ["before-native", "outcome"] as const) test(`partial persistence at ${stage} fails closed without fabricated durable certainty`, () => {
    const f = fixture(), durable = snapshot(f), values: unknown[] = [];
    const failure = new Error("second protected write failed"); let reconciliation = false;
    const h = lifecycle(f, {
      persist: (_submission, value) => { if (value.stage === stage) throw failure; values.push(value); },
      failClosed: () => { reconciliation = true; },
    });
    if (stage === "outcome") h.owner.beforeNative();
    expect(capture(() => stage === "before-native" ? h.owner.beforeNative() : h.owner.outcome("submitted", "accepted"))).toBe(failure);
    expect(reconciliation).toBe(true);
    const partial = { ...durable, coverage: { ...durable.coverage, state: "partial" as const, reason: "partial owner commit" },
      observations: values.map((value, index) => ({ source: "owner", order: index + 2, value })) };
    expect(project(f, partial).fact).toBe("unknown");
    expect(project(f, snapshot(f, values)).fact).toBe(stage === "before-native" ? "prepared-only" : "attempt-unresolved");
  });
});

describe("restart evidence is conservative per-message projection, not activation or retry policy", () => {
  const stateCases: [string, (f: Fixture) => unknown[], ContextMessageRestartFact][] = [
    ["prepared", () => [], "prepared-only"], ["withheld", f => [observation(f, "not-submitted", "not-accepted")], "withheld"],
    ["attempt", f => [observation(f, "attempted")], "attempt-unresolved"],
    ["attempt with unknown outcome", f => [observation(f, "attempted"), observation(f, "unknown")], "attempt-unresolved"],
    ["submitted", f => [observation(f, "attempted"), observation(f, "submitted")], "submitted-unconfirmed"],
    ["rejected", f => [observation(f, "attempted"), observation(f, "submitted", "not-accepted")], "submitted-not-accepted"],
    ["accepted", f => [observation(f, "attempted"), observation(f, "submitted", "accepted")], "accepted"],
    ["legacy unknown", f => [observation(f, "unknown")], "unknown"],
  ];
  for (const [name, values, expected] of stateCases) test(`projects ${name} without resend/activation/consumption claims`, () => {
    const f = fixture(), result = project(f, snapshot(f, values(f)));
    expect(result.fact).toBe(expected); expect(result.composition).toEqual(f.submission.composition);
    expect(result.identity).toEqual(id); expect(result.provenance[0]).toEqual({ source: "protected-owner-snapshot", sequence: 1, kind: "submission" });
    for (const forbidden of ["resend", "retry", "activate", "fresh", "consumed", "destinationSubmission"]) expect(Object.hasOwn(result, forbidden)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
  });
  test("complete absence is no-evidence, explicitly not a freshness claim", () => {
    const f = fixture(); const result = project(f, { ...snapshot(f), events: [] });
    expect(result.fact).toBe("no-evidence"); expect(result.reason).toContain("not a fresh-session claim");
    expect(result.composition).toBeNull(); expect(result.provenance).toEqual([]);
  });
  for (const state of ["partial", "unavailable"] as const) test(`${state} coverage overrides even accepted-looking records`, () => {
    const f = fixture(), input = snapshot(f, [observation(f, "attempted"), observation(f, "submitted", "accepted")]);
    const result = project(f, { ...input, coverage: { state, source: "protected-snapshot", reason: "owner coverage missing" } });
    expect(result.fact).toBe("unknown"); expect(result.composition).toBeNull();
  });
  test("missing/invalid protected source coverage and unfinalized native identities stay unknown", () => {
    const f = fixture();
    for (const coverage of [null, { state: "complete", source: "" }, { state: "complete", source: "owner", extra: true }]) {
      expect(project(f, { ...snapshot(f), coverage } as any).fact).toBe("unknown");
    }
    for (const key of ["authorityId", "nativeSessionId"] as const) expect(projectContextMessageRestart({
      identity: { ...id, source: { ...source, [key]: null } }, messageId: f.messageId,
    }, snapshot(f)).fact).toBe("unknown");
  });
  test("model text, legacy receipts, prepared context, and successful run status do not establish submission", () => {
    const f = fixture();
    const events: Event[] = [
      { ...event(f), kind: "message", data: { role: "assistant", text: `${f.submission.text}\naccepted activated`, composition: f.submission.composition } },
      { ...event(f), seq: 2, kind: "context", data: { prepared: f.submission, activated: true, receipt: { accepted: true } } },
      { ...event(f), seq: 3, kind: "hook", data: { type: "dispatch", ...fact(f, "submitted", "accepted") } },
      { ...event(f), seq: 4, kind: "status", data: { status: "completed", success: true, nativePhase: "accepted" } },
    ];
    expect(project(f, { ...snapshot(f), events }).fact).toBe("no-evidence");
    expect(project(f, { ...snapshot(f), events: [event(f, { messageId: f.messageId, text: f.submission.text, receipt: "accepted" })] }).fact).toBe("unknown");
  });
  const conflicts: [string, (f: Fixture) => unknown[]][] = [
    ["outcome without intent", f => [observation(f, "submitted", "accepted")]],
    ["repeated attempt", f => [observation(f, "attempted"), observation(f, "attempted")]],
    ["withheld after attempt", f => [observation(f, "attempted"), observation(f, "not-submitted", "not-accepted")]],
    ["attempt after withheld", f => [observation(f, "not-submitted", "not-accepted"), observation(f, "attempted")]],
    ["submission after withheld", f => [observation(f, "not-submitted", "not-accepted"), observation(f, "submitted")]],
    ["withheld after unknown", f => [observation(f, "unknown"), observation(f, "not-submitted", "not-accepted")]],
    ["intent after unconfirmed", f => [observation(f, "unknown"), observation(f, "attempted")]],
    ["conflicting acceptance", f => [observation(f, "attempted"), observation(f, "submitted", "accepted"), observation(f, "submitted", "not-accepted")]],
    ["mixed boundaries", f => [observation(f, "attempted", "unknown", "run-initial"), observation(f, "submitted", "accepted")]],
  ];
  for (const [name, values] of conflicts) test(`${name} cannot produce certainty`, () => {
    const f = fixture(); expect(project(f, snapshot(f, values(f))).fact).toBe("unknown");
  });
  test("weaker later unknown does not erase exact accepted evidence", () => {
    const f = fixture();
    expect(project(f, snapshot(f, [observation(f, "attempted"), observation(f, "submitted", "accepted"), observation(f, "unknown")])).fact).toBe("accepted");
  });
  test("foreign source, dispatch, message bytes, and duplicate submissions cannot certify the queried message", () => {
    const f = fixture();
    for (const key of ["harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd"] as const) {
      const value = clone(observation(f, "attempted")) as any; value.evidence.source[key] += "-foreign";
      expect(project(f, snapshot(f, [value])).fact).toBe("unknown");
    }
    for (const key of ["nativeCommandId", "requestId"] as const) {
      const value = clone(observation(f, "attempted")) as any; value.evidence[key] += "-foreign";
      expect(project(f, snapshot(f, [value])).fact).toBe("unknown");
    }
    const hashMismatch = { ...observation(f, "attempted"), transportSha256: "0".repeat(64) };
    expect(project(f, snapshot(f, [hashMismatch])).fact).toBe("unknown");
    expect(project(f, { ...snapshot(f), events: [event(f), event(f, f.submission, 2)] }).fact).toBe("unknown");
    const otherIdentity = { ...f.submission, composition: { ...f.submission.composition, dispatch: { ...id, requestId: "foreign" } } };
    expect(project(f, { ...snapshot(f), events: [event(f, otherIdentity)] }).fact).toBe("unknown");
  });
  test("observations without an exact submission record stay unknown", () => {
    const f = fixture();
    expect(project(f, { ...snapshot(f, [observation(f, "attempted"), observation(f, "submitted", "accepted")]), events: [] }).fact).toBe("unknown");
  });
  test("well-formed unrelated message/run observations never certify this message", () => {
    const f = fixture(), other = fixture({ ...id, runId: "other-run", nativeCommandId: "msg_other" });
    expect(project(f, snapshot(f, [observation(other, "attempted"), observation(other, "submitted", "accepted")])).fact).toBe("prepared-only");
  });
  for (const order of [[2, 2], [3, 2], [2, 1.5], [2, Number.NaN], [-1, 2]]) test(`rejects non-strict protected observation order ${order}`, () => {
    const f = fixture(), input = snapshot(f, [observation(f, "attempted"), observation(f, "submitted", "accepted")]);
    expect(project(f, { ...input, observations: input.observations.map((value, index) => ({ ...value, order: order[index]! })) }).fact).toBe("unknown");
  });
  test("malformed foreign-looking observations cannot silently vanish from complete coverage", () => {
    const f = fixture();
    const values = [null, {}, { ...observation(f, "unknown"), messageId: "foreign", extra: true },
      { ...observation(f, "unknown"), messageId: "foreign", evidence: { ...fact(f, "unknown"), source: null } }];
    for (const value of values) expect(project(f, snapshot(f, [observation(f, "attempted"), observation(f, "submitted", "accepted"), value])).fact).toBe("unknown");
  });
  for (const seq of [0, -1, 0.5, Number.NaN]) test(`invalid submission sequence ${seq} is unknown`, () => {
    const f = fixture(); expect(project(f, { ...snapshot(f), events: [event(f, f.submission, seq)] }).fact).toBe("unknown");
  });
  test("initial CC observations from the same run cannot certify live background input", () => {
    const cc = { ...id, source: { ...source, harnessId: "claude-code" }, nativeCommandId: null };
    const initial = fixture(cc, `${cc.runId}:user`), live = fixture(cc, `${cc.runId}:user:${liveUuid}`, true);
    const oldValues = [observation(initial, "attempted", "unknown", "run-initial"), observation(initial, "submitted", "unknown", "run-initial")];
    expect(project(live, snapshot(live, oldValues)).fact).toBe("prepared-only");
    expect(project(live, snapshot(live, oldValues.map(value => ({ ...value, messageId: live.messageId })))).fact).toBe("unknown");
    expect(project(live, snapshot(live, [observation(live, "attempted"), observation(live, "submitted")])).fact).toBe("submitted-unconfirmed");
  });
});

describe("strict correlated observation codec", () => {
  test("roundtrip strips no identity or outcome fields and freezes recursively", () => {
    const value = observation(fixture(), "submitted", "accepted");
    const decoded = decodeContextMessageDispatchObservation(JSON.parse(JSON.stringify(value)));
    expect(decoded).toEqual(value); expect(Object.isFrozen(decoded.evidence.source)).toBe(true);
  });
  for (const [submission, acceptance, stage] of [
    ["not-submitted", "accepted", "outcome"], ["not-submitted", "unknown", "outcome"],
    ["attempted", "accepted", "before-native"], ["unknown", "not-accepted", "outcome"],
    ["attempted", "unknown", "outcome"], ["submitted", "accepted", "before-native"],
    ["invented", "unknown", "outcome"], ["submitted", "invented", "outcome"],
  ]) test(`rejects contradictory ${submission}/${acceptance}/${stage}`, () => {
    const value = observation(fixture(), "unknown");
    expect(() => decodeContextMessageDispatchObservation({ ...value, stage, evidence: { ...value.evidence, submission, nativeAcceptance: acceptance } })).toThrow();
  });
  test("rejects unknown fields, malformed hashes, stages and boundaries", () => {
    const value = observation(fixture(), "attempted");
    for (const corrupt of [{ ...value, extra: true }, { ...value, evidence: { ...value.evidence, extra: true } },
      { ...value, transportSha256: "not-a-hash" }, { ...value, stage: "done" }, { ...value, boundary: "run-success" }]) {
      expect(() => decodeContextMessageDispatchObservation(corrupt)).toThrow();
    }
  });
});

const destination: ContextMessageBinding = { ...source, sessionId: "app-child", nativeSessionId: "ses_child", cwd: "/synthetic/child" };
function branchFixture() {
  const f = fixture();
  const reference: ContextMessageAncestorReference = { identity: f.identity, messageId: f.messageId, transportSha256: f.message.transport.sha256 };
  const proof: VerifiedContextMessageBranchPrefix = {
    schema: 1, type: "verified-context-message-branch-prefix", branchId: "branch-edge-one", source, destination,
    state: "completed", reset: "none", verification: { kind: "exact-prefix", source: "protected-native-fork", reference: "fork-proof-one" },
    throughMessageId: f.messageId, prefix: [reference],
  };
  const parent = snapshot(f, [observation(f, "attempted"), observation(f, "submitted", "accepted")]);
  return { f, reference, proof, options: { destination, verifiedPrefix: proof as unknown, requiredAncestors: [reference], parent } };
}

describe("one-edge verified branch prefix inheritance", () => {
  test("retains original accepted parent source and facts, never fabricates a destination submission", () => {
    const b = branchFixture(), before = clone(b.options);
    const result = projectContextMessageBranch(b.options);
    expect(result.fact).toBe("inherited"); expect(result.lineage).toEqual(b.proof);
    expect(result.ancestors).toHaveLength(1);
    expect(result.ancestors[0]!.reference).toEqual(b.reference);
    expect(result.ancestors[0]!.evidence.identity.source).toEqual(source);
    expect(result.ancestors[0]!.evidence.fact).toBe("accepted");
    expect(result.ancestors[0]!.evidence.identity.source).not.toEqual(destination);
    expect(Object.hasOwn(result, "submission")).toBe(false); expect(Object.hasOwn(result, "activated")).toBe(false);
    expect(b.options).toEqual(before); expect(Object.isFrozen(result.ancestors[0]!.evidence)).toBe(true);
    const child = { ...id, source: destination, runId: "run-child", nativeCommandId: "msg_child" };
    expect(projectContextMessageRestart({ identity: child, messageId: "msg_child" }, b.options.parent).fact).toBe("no-evidence");
  });
  test("transport-only parent evidence remains unconfirmed when inherited", () => {
    const b = branchFixture();
    const result = projectContextMessageBranch({ ...b.options, parent: snapshot(b.f, [observation(b.f, "attempted"), observation(b.f, "submitted")]) });
    expect(result.fact).toBe("inherited"); expect(result.ancestors[0]!.evidence.fact).toBe("submitted-unconfirmed");
  });
  const badProofs: [string, (proof: any) => unknown][] = [
    ["missing proof", () => null], ["claimed activation instead of proof", () => ({ activated: true })],
    ["incomplete fork", p => ({ ...p, state: "pending" })], ["reset", p => ({ ...p, reset: "completed" })],
    ["missing reset information", p => { delete p.reset; return p; }],
    ["unverified prefix", p => ({ ...p, verification: { ...p.verification, kind: "assumed" } })],
    ["empty verification source", p => ({ ...p, verification: { ...p.verification, source: "" } })],
    ["missing verification reference", p => ({ ...p, verification: { kind: "exact-prefix", source: "owner" } })],
    ["wrong selected boundary", p => ({ ...p, throughMessageId: "msg_outside" })],
    ["empty prefix", p => ({ ...p, prefix: [] })], ["duplicate prefix", p => ({ ...p, prefix: [...p.prefix, ...p.prefix] })],
    ["destination equals source", p => ({ ...p, destination: p.source })],
    ["wrong destination", p => ({ ...p, destination: { ...destination, nativeSessionId: "ses_foreign" } })],
    ["foreign prefix source", p => ({ ...p, source: { ...source, authorityId: "foreign" } })],
    ["unknown proof field", p => ({ ...p, activated: true })],
    ["unknown prefix field", p => ({ ...p, prefix: [{ ...p.prefix[0], accepted: true }] })],
  ];
  for (const [name, mutate] of badProofs) test(`${name} fails conservatively`, () => {
    const b = branchFixture();
    const result = projectContextMessageBranch({ ...b.options, verifiedPrefix: mutate(clone(b.proof)) });
    expect(result.fact).toBe("unknown"); expect(result.lineage).toBeNull(); expect(result.ancestors).toEqual([]);
  });
  test("required parent outside the selected boundary or hash cannot be inherited", () => {
    const b = branchFixture();
    for (const ref of [{ ...b.reference, messageId: "msg_outside" }, { ...b.reference, transportSha256: "0".repeat(64) },
      { ...b.reference, identity: { ...id, runId: "foreign-run" } }]) {
      expect(projectContextMessageBranch({ ...b.options, requiredAncestors: [ref] }).fact).toBe("unknown");
    }
    const forged = { ...b.reference, transportSha256: "0".repeat(64) };
    expect(projectContextMessageBranch({ ...b.options, requiredAncestors: [forged], verifiedPrefix: { ...b.proof, prefix: [forged] } }).fact).toBe("unknown");
  });
  test("empty or duplicated required selection is not inheritance proof", () => {
    const b = branchFixture();
    for (const refs of [[], [b.reference, b.reference]]) expect(projectContextMessageBranch({ ...b.options, requiredAncestors: refs }).fact).toBe("unknown");
  });
  for (const coverage of ["partial", "unavailable"] as const) test(`${coverage} parent coverage cannot establish inheritance even with accepted rows`, () => {
    const b = branchFixture();
    expect(projectContextMessageBranch({ ...b.options, parent: { ...b.options.parent, coverage: { state: coverage, source: "owner" } } }).fact).toBe("unknown");
  });
  for (const state of ["no-evidence", "prepared-only", "withheld", "attempt-unresolved", "submitted-not-accepted", "unknown"] as const) {
    test(`${state} parent cannot establish copied admitted context`, () => {
      const b = branchFixture();
      const values = state === "withheld" ? [observation(b.f, "not-submitted", "not-accepted")]
        : state === "attempt-unresolved" ? [observation(b.f, "attempted")]
        : state === "submitted-not-accepted" ? [observation(b.f, "attempted"), observation(b.f, "submitted", "not-accepted")]
        : state === "unknown" ? [observation(b.f, "unknown")] : [];
      const parent = snapshot(b.f, values);
      expect(projectContextMessageBranch({ ...b.options, parent: state === "no-evidence" ? { ...parent, events: [] } : parent }).fact).toBe("unknown");
    });
  }
  test("all selected ancestors are checked within a longer exact prefix", () => {
    const b = branchFixture(), second = fixture({ ...id, runId: "run-second", nativeCommandId: "msg_second" });
    const secondRef = { identity: second.identity, messageId: second.messageId, transportSha256: second.message.transport.sha256 };
    const proof = { ...b.proof, throughMessageId: second.messageId, prefix: [b.reference, secondRef] };
    const parent = { ...b.options.parent, events: [...b.options.parent.events, event(second, second.submission, 4)],
      observations: [...b.options.parent.observations,
        { source: "owner", order: 5, value: observation(second, "attempted") },
        { source: "owner", order: 6, value: observation(second, "submitted", "accepted") }] };
    expect(projectContextMessageBranch({ ...b.options, verifiedPrefix: proof, parent, requiredAncestors: [b.reference, secondRef] }).ancestors).toHaveLength(2);
    expect(projectContextMessageBranch({ ...b.options, verifiedPrefix: proof, parent: { ...parent, events: b.options.parent.events }, requiredAncestors: [b.reference, secondRef] }).fact).toBe("unknown");
  });
  test("one edge does not turn inherited grandparent facts into a child submission or transitive proof", () => {
    const b = branchFixture();
    const inherited = projectContextMessageBranch(b.options); expect(inherited.fact).toBe("inherited");
    const grandchild = { ...destination, sessionId: "app-grandchild", nativeSessionId: "ses_grandchild" };
    // Passing a projection itself is not a native verified prefix proof.
    expect(projectContextMessageBranch({ ...b.options, destination: grandchild, verifiedPrefix: inherited }).fact).toBe("unknown");
    // Relabeling the edge source to the child cannot relabel original parent facts.
    expect(projectContextMessageBranch({ ...b.options, destination: grandchild,
      verifiedPrefix: { ...b.proof, source: destination, destination: grandchild } }).fact).toBe("unknown");
    const childIdentity = { ...id, source: destination, runId: "run-child", nativeCommandId: "msg_child" };
    const childRef = { ...b.reference, identity: childIdentity, messageId: "msg_child" };
    expect(projectContextMessageBranch({ ...b.options, destination: grandchild, requiredAncestors: [childRef],
      verifiedPrefix: { ...b.proof, source: destination, destination: grandchild, throughMessageId: "msg_child", prefix: [childRef] } }).fact).toBe("unknown");
  });
});
