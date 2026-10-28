import { describe, expect, test } from "bun:test";
import type { DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { composeContextMessage, type ContextMessageBinding } from "./context-message";
import type { ContextMessageDispatchObservation, ContextMessageSubmission } from "./context-message-evidence";
import { createOwnedContextMessages, type OwnedContextMessagesDependencies } from "./context-message-owner";
import type { ActualContextSubmission, OwnedContextMessageRequest } from "./context-message-transport";
import { createDispatchEvidence, DispatchPreNativeRefusal } from "./dispatch-evidence";

// Offline fixtures only: the bridge engine, adapter payload and SAME journal are
// independent mocks. No native transports, filesystem writers, or activation state.
const source: ContextMessageBinding = { harnessId: "opencode", sessionId: "app", authorityId: "authority",
  nativeSessionId: "ses_native", cwd: "/synthetic/context-owner" };
const oc: DispatchIdentity = { source, runId: "run", nativeCommandId: "msg_native", requestId: "request" };
const cc: DispatchIdentity = { ...oc, source: { ...source, harnessId: "claude-code" }, nativeCommandId: null };
const uuid = "12345678-1234-4123-8123-123456789abc";
const nextUuid = "12345678-1234-4123-8123-123456789abd";
const body = "é😀\r\n[SANE CONTEXT MESSAGE v1]\n";
const clone = <T>(value: T): T => structuredClone(value);
function fact(identity = oc, submission: DispatchSubmissionEvidence["submission"] = "attempted",
  nativeAcceptance: DispatchSubmissionEvidence["nativeAcceptance"] = "unknown"): DispatchSubmissionEvidence {
  return { ...identity, submission, nativeAcceptance };
}
function capture(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected failure");
}
function fixture(identity = oc, overrides: Partial<OwnedContextMessagesDependencies> = {}) {
  const calls: string[] = [], failures: unknown[] = [];
  const journal: { submission: ContextMessageSubmission; observation: ContextMessageDispatchObservation }[] = [];
  const originalFacts: DispatchSubmissionEvidence[] = [];
  const bound: ContextMessageSubmission[] = [];
  const message = composeContextMessage({ body, binding: identity.source as ContextMessageBinding, origin: "user",
    placement: { kind: "selected", purpose: "sharing" }, selections: [{ kind: "fragment", fragment: {
      id: "shared.fixture", category: "shared", text: "Independently selected 🧪", source: "protected-fixture",
      revision: "fixture-v1", reason: "explicit selection",
    } }] });
  const request: OwnedContextMessageRequest = { messageId: identity.nativeCommandId ?? `${identity.runId}:user`, body,
    boundary: identity.source.harnessId === "claude-code" ? "run-initial" : "message", queuedFollowupId: "queue-original" };
  const deps: OwnedContextMessagesDependencies = {
    readIdentity: () => { calls.push("identity"); return identity; },
    prepare: async (_request, assertCurrent) => {
      calls.push("prepare"); assertCurrent(); await Promise.resolve(); assertCurrent();
      return { message, assertCurrent: async () => { calls.push("engine:assert"); assertCurrent(); await Promise.resolve(); assertCurrent(); } };
    },
    originalHooks: {
      beforeNative: value => { calls.push("original:before"); originalFacts.push(value); },
      outcome: value => { calls.push("original:outcome"); originalFacts.push(value); },
    },
    persist: (submission, observation) => { calls.push(`journal:${observation.stage}`); journal.push({ submission, observation }); },
    assertObservationCurrent: () => { calls.push("observation:assert"); },
    assertBeforeNative: () => {},
    onBound: submission => { calls.push("bound"); bound.push(submission); },
    failClosed: error => { calls.push("failed"); failures.push(error); },
    ...overrides,
  };
  const owned = createOwnedContextMessages(deps);
  const actual = { identity: clone(identity), messageId: request.messageId, text: message.transport.text };
  const read = () => { calls.push("actual"); return actual; };
  const prepare = () => owned.transport.prepare(request, () => {});
  const live = (suffix = uuid): OwnedContextMessageRequest => ({ ...request, messageId: `${identity.runId}:user:${suffix}`,
    boundary: "message", liveInput: true, queuedFollowupId: undefined });
  return { ...owned, deps, identity, calls, failures, journal, originalFacts, bound, request, message, actual, read, prepare, live };
}

describe("bridge-owned context messages", () => {
  test("late binding composes hooks inside the existing lifecycle, preserving journal order and one prompt", async () => {
    const h = fixture();
    const owner = createDispatchEvidence(oc, h.hooks, () => {});
    const prepared = await h.prepare();
    expect(h.journal).toEqual([]); expect(h.originalFacts).toEqual([]);
    const submission = prepared.bindActual(h.read);
    expect(h.bound).toEqual([submission]); expect(h.journal).toEqual([]);
    expect(Object.isFrozen(submission.composition.dispatch.source)).toBe(true);
    expect(Object.isFrozen(h.actual.identity.source)).toBe(false);
    h.calls.length = 0;
    owner.beforeNative(); h.calls.push("native"); owner.outcome("submitted", "accepted");
    expect(h.calls).toEqual([
      "observation:assert", "actual", "identity", "original:before", "journal:before-native", "native",
      "observation:assert", "actual", "identity", "original:outcome", "journal:outcome",
    ]);
    expect(h.journal.map(item => item.observation.evidence)).toEqual([fact(), fact(oc, "submitted", "accepted")]);
    expect(h.journal[0]!.submission).toEqual(submission);
    expect(h.journal.every(item => item.submission === h.journal[0]!.submission)).toBe(true);
    expect(submission.queuedFollowupId).toBe("queue-original");
    expect(Object.hasOwn(submission.composition.transport, "text")).toBe(false);
    expect(Object.hasOwn(submission.composition.body, "text")).toBe(false);
    expect(() => owner.beforeNative()).toThrow("replay forbidden");
    expect(h.failures).toEqual([]);
  });

  test("no initial binding fails closed before native; no unbound outcome invents context metadata", () => {
    const h = fixture();
    const missing = capture(() => h.hooks.beforeNative!(fact()));
    expect(missing).not.toBeInstanceOf(DispatchPreNativeRefusal);
    expect(h.failures).toEqual([missing]);
    h.calls.length = 0;
    h.hooks.outcome!(fact(oc, "not-submitted", "not-accepted"));
    expect(h.calls).toEqual(["original:outcome"]);
    expect(h.journal).toEqual([]);
    h.hooks.outcome!(fact(oc, "unknown"));
    expect(h.originalFacts).toEqual([fact(oc, "not-submitted", "not-accepted"), fact(oc, "unknown")]);
    expect(h.journal).toEqual([]);
  });

  test("policy preparation failures pass through and original withholding does not poison healthy storage", async () => {
    const failure = new Error("current policy refused before composition");
    const h = fixture(oc, { prepare: async () => { throw failure; } });
    const owner = createDispatchEvidence(oc, h.hooks, () => {});
    expect(await h.prepare().catch(error => error)).toBe(failure);
    owner.withheld(); owner.finish();
    expect(h.originalFacts).toEqual([fact(oc, "not-submitted", "not-accepted")]);
    expect(h.failures).toEqual([]); expect(h.journal).toEqual([]); expect(h.bound).toEqual([]);
  });

  test("preparation and bridge guards retain checks across awaits without adding observation cancellation gates", async () => {
    const h = fixture(); let current = true, assertions = 0;
    const assert = () => { assertions++; if (!current) throw new Error("launch no longer current"); };
    const prepared = await h.transport.prepare(h.request, assert);
    expect(assertions).toBe(2);
    const checking = prepared.assertCurrent(); current = false;
    await expect(checking).rejects.toThrow("launch no longer current");
    expect(assertions).toBe(4);
    prepared.bindActual(h.read);
    h.hooks.beforeNative!(fact());
    // Outcome still belongs to the original association after launch cancellation.
    h.hooks.outcome!(fact(oc, "submitted", "accepted"));
    h.hooks.outcome!(fact(oc, "unknown"));
    expect(h.journal.map(item => item.observation.evidence.submission)).toEqual(["attempted", "submitted", "unknown"]);
    expect(h.failures).toEqual([]);
  });

  test("initial prepare reservation rejects concurrent composition, and binding cannot be replaced", async () => {
    const h = fixture();
    const first = h.prepare();
    await expect(h.prepare()).rejects.toThrow("cannot be replaced");
    const prepared = await first;
    const submission = prepared.bindActual(h.read);
    expect(() => prepared.bindActual(h.read)).toThrow("only be bound once");
    expect(h.bound).toEqual([submission]);
    h.hooks.outcome!(fact(oc, "not-submitted", "not-accepted"));
    expect(h.journal[0]!.submission).toEqual(submission);
  });

  for (const changed of ["text", "messageId", "harnessId", "sessionId", "authorityId", "nativeSessionId", "cwd", "runId", "nativeCommandId", "requestId"] as const) {
    for (const boundary of ["bind", "before", "outcome"] as const) test(`rejects actual ${changed} drift at ${boundary}`, async () => {
      const h = fixture(), prepared = await h.prepare();
      if (boundary !== "bind") prepared.bindActual(h.read);
      if (boundary === "outcome") h.hooks.beforeNative!(fact());
      const before = h.journal.length, originals = h.originalFacts.length;
      if (changed === "text" || changed === "messageId") h.actual[changed] += "-foreign";
      else if (Object.hasOwn(source, changed)) (h.actual.identity.source as any)[changed] += "-foreign";
      else (h.actual.identity as any)[changed] += "-foreign";
      const failure = capture(() => boundary === "bind" ? prepared.bindActual(h.read)
        : boundary === "before" ? h.hooks.beforeNative!(fact()) : h.hooks.outcome!(fact(oc, "submitted", "accepted")));
      expect(h.failures).toEqual([failure]);
      expect(h.journal).toHaveLength(before); expect(h.originalFacts).toHaveLength(originals);
      if (boundary !== "bind") expect(h.bound[0]!.composition.dispatch).toEqual(oc);
    });
  }

  test("captured owner reader is independently exact and is rechecked at the native boundary", async () => {
    for (const boundary of ["bind", "before"] as const) {
      let identity = clone(oc);
      const h = fixture(oc, { readIdentity: () => identity }), prepared = await h.prepare();
      if (boundary === "before") prepared.bindActual(h.read);
      identity = { ...identity, requestId: "other-owner" };
      expect(() => boundary === "bind" ? prepared.bindActual(h.read) : h.hooks.beforeNative!(fact())).toThrow("captured dispatch owner");
      expect(h.failures).toHaveLength(1); expect(h.journal).toEqual([]);
    }
  });

  test("bound initial hooks also reject foreign supplied dispatch evidence", async () => {
    const h = fixture(), prepared = await h.prepare(); prepared.bindActual(h.read);
    expect(() => h.hooks.beforeNative!(fact({ ...oc, runId: "other" }))).toThrow();
    expect(h.failures).toHaveLength(1); expect(h.originalFacts).toEqual([]); expect(h.journal).toEqual([]);
  });

  test("observation guards check original storage/source association again after native execution", async () => {
    let associated = true;
    const failure = new Error("original journal association changed");
    const h = fixture(oc, { assertObservationCurrent: () => { if (!associated) throw failure; } });
    (await h.prepare()).bindActual(h.read);
    h.hooks.beforeNative!(fact()); associated = false;
    expect(capture(() => h.hooks.outcome!(fact(oc, "submitted", "accepted")))).toBe(failure);
    expect(h.failures).toEqual([failure]);
    expect(h.journal.map(item => item.observation.evidence.submission)).toEqual(["attempted"]);
    expect(h.originalFacts).toEqual([fact()]);
  });

  test("prepared bytes must retain the requested authored body", async () => {
    const message = composeContextMessage({ binding: source, origin: "user", body: "different authored body", placement: { kind: "body-only" } });
    const h = fixture(oc, { prepare: async () => ({ message, assertCurrent: async () => {} }) });
    await expect(h.prepare()).rejects.toThrow("requested authored body");
    expect(h.failures).toHaveLength(1); expect(h.journal).toEqual([]); expect(h.originalFacts).toEqual([]);
  });

  test("only original synchronous intent refusal retains certification in the existing owner", async () => {
    const refusal = new DispatchPreNativeRefusal(new Error("original durable refusal"));
    const h = fixture(oc, { originalHooks: { beforeNative: () => { throw refusal; } } });
    const owner = createDispatchEvidence(oc, h.hooks, () => {});
    (await h.prepare()).bindActual(h.read);
    expect(capture(owner.beforeNative)).toBe(refusal);
    expect(owner.recognizesRefusal(refusal)).toBe(true);
    expect(h.failures).toEqual([]); expect(h.journal).toEqual([]);
  });

  for (const site of ["actual", "identity", "observation", "bound", "persist"] as const) test(`${site} cannot borrow refusal certification`, async () => {
    const refusal = new DispatchPreNativeRefusal(new Error(`uncertified:${site}`));
    const throwing = () => { throw refusal; };
    const h = fixture(oc, {
      ...(site === "identity" ? { readIdentity: throwing } : {}),
      ...(site === "observation" ? { assertObservationCurrent: throwing } : {}),
      ...(site === "bound" ? { onBound: throwing } : {}),
      ...(site === "persist" ? { persist: throwing } : {}),
    });
    const prepared = await h.prepare();
    const failure = capture(() => {
      prepared.bindActual(site === "actual" ? throwing : h.read);
      h.hooks.beforeNative!(fact());
    });
    expect(failure).toBeInstanceOf(Error); expect(failure).not.toBeInstanceOf(DispatchPreNativeRefusal);
    expect((failure as Error).cause).toBe(refusal); expect(h.failures).toEqual([failure]);
    expect(h.journal).toEqual([]);
  });

  test("reentrant readers and onBound callbacks cannot publish a partial binding even if they swallow the inner failure", async () => {
    for (const site of ["actual", "bound"] as const) {
      let reenter = () => {};
      const h = fixture(oc, site === "bound" ? { onBound: () => reenter() } : {});
      const prepared = await h.prepare();
      reenter = () => { capture(() => prepared.bindActual(h.read)); };
      expect(() => prepared.bindActual(site === "actual" ? () => { reenter(); return h.actual; } : h.read)).toThrow("invalidated by reentry");
      expect(() => h.hooks.beforeNative!(fact())).toThrow("not bound");
      expect(h.journal).toEqual([]); expect(h.originalFacts).toEqual([]);
    }
  });

  for (const site of ["actual", "identity", "observation", "bound", "original-before", "original-outcome", "persist"] as const) {
    test(`async ${site} is rejected synchronously and fails closed`, async () => {
      const asyncHook = () => Promise.reject(new Error(`async:${site}`));
      const h = fixture(oc, {
        ...(site === "identity" ? { readIdentity: asyncHook as unknown as () => DispatchIdentity } : {}),
        ...(site === "observation" ? { assertObservationCurrent: asyncHook } : {}),
        ...(site === "bound" ? { onBound: asyncHook } : {}),
        ...(site === "persist" ? { persist: asyncHook } : {}),
        ...(site === "original-before" ? { originalHooks: { beforeNative: asyncHook } } : {}),
        ...(site === "original-outcome" ? { originalHooks: { outcome: asyncHook } } : {}),
      });
      const prepared = await h.prepare();
      const failure = capture(() => {
        prepared.bindActual(site === "actual" ? asyncHook as unknown as () => ActualContextSubmission : h.read);
        if (site === "original-outcome") h.hooks.outcome!(fact(oc, "not-submitted", "not-accepted"));
        else h.hooks.beforeNative!(fact());
      });
      expect((failure as Error).message).toContain("synchronously");
      expect(h.failures).toEqual([failure]); expect(h.journal).toEqual([]);
      await Promise.resolve();
    });
  }

  test("unbound original outcome callbacks still fail closed when asynchronous", async () => {
    const h = fixture(oc, { originalHooks: { outcome: async () => { throw new Error("async withholding journal"); } } });
    const failure = capture(() => h.hooks.outcome!(fact(oc, "not-submitted", "not-accepted")));
    expect(h.failures).toEqual([failure]); expect(h.journal).toEqual([]);
    await Promise.resolve();
  });

  for (const mode of ["throw", "async"] as const) test(`a ${mode} failClosed callback preserves the original cause`, async () => {
    const original = new DispatchPreNativeRefusal(new Error("physical association failed"));
    const h = fixture(oc, { onBound: () => { throw original; }, failClosed: () => {
      if (mode === "throw") throw new DispatchPreNativeRefusal(new Error("secondary"));
      return Promise.reject(new Error("secondary async"));
    } });
    const prepared = await h.prepare();
    const failure = capture(() => prepared.bindActual(h.read));
    expect(failure).not.toBeInstanceOf(DispatchPreNativeRefusal); expect((failure as Error).cause).toBe(original);
    await Promise.resolve();
  });
});

describe("CC message boundary facts without a new dispatch owner", () => {
  test("live callbacks cannot be prepared for OC or the initial-run boundary", async () => {
    const opencode = fixture();
    await expect(opencode.transport.prepare({ ...opencode.request, liveInput: true }, () => {})).rejects.toThrow("CC live input");
    const claude = fixture(cc);
    await expect(claude.transport.prepare({ ...claude.live(), boundary: "run-initial" }, () => {})).rejects.toThrow("CC live input");
    expect(opencode.failures).toHaveLength(1); expect(claude.failures).toHaveLength(1);
  });

  test("distinct UUID live inputs never re-enter initial/queued hooks or replace the initial binding", async () => {
    const h = fixture(cc), initial = await h.prepare(); initial.bindActual(h.read);
    const owner = createDispatchEvidence(cc, h.hooks, () => {});
    owner.beforeNative(); owner.outcome("submitted");
    for (const suffix of [uuid, nextUuid]) {
      const request = h.live(suffix), prepared = await h.transport.prepare(request, () => {});
      const actual = { ...h.actual, messageId: request.messageId };
      const submission = prepared.bindActual(() => actual);
      expect(submission.liveInput).toBe(true); expect(submission.queuedFollowupId).toBeUndefined();
      prepared.beforeMessageNative(); prepared.messageOutcome("submitted", "unknown");
    }
    expect(h.originalFacts).toEqual([fact(cc), fact(cc, "submitted")]);
    expect(h.journal.map(item => [item.observation.messageId, item.observation.boundary, item.observation.stage])).toEqual([
      ["run:user", "run-initial", "before-native"], ["run:user", "run-initial", "outcome"],
      [`run:user:${uuid}`, "message", "before-native"], [`run:user:${uuid}`, "message", "outcome"],
      [`run:user:${nextUuid}`, "message", "before-native"], [`run:user:${nextUuid}`, "message", "outcome"],
    ]);
    h.hooks.outcome!(fact(cc, "submitted", "accepted"));
    expect(h.journal.at(-1)!.observation.messageId).toBe("run:user");
    expect(h.failures).toEqual([]);
  });

  test("live local withholding before binding or intent never fabricates an attempt", async () => {
    const h = fixture(cc), request = h.live(), prepared = await h.transport.prepare(request, () => {});
    prepared.messageOutcome("not-submitted", "not-accepted");
    expect(h.journal).toEqual([]); expect(h.calls).toEqual(["prepare"]);
    prepared.bindActual(() => ({ ...h.actual, messageId: request.messageId }));
    prepared.messageOutcome("not-submitted", "not-accepted");
    expect(h.journal.map(item => item.observation.evidence.submission)).toEqual(["not-submitted"]);
    expect(h.originalFacts).toEqual([]);
  });
  test("live input synchronously rechecks retained source pins before its message intent", async () => {
    const failure = new Error("retained Session source changed");
    const h = fixture(cc, { assertBeforeNative: () => { throw failure; } });
    const request = h.live(), prepared = await h.transport.prepare(request, () => {});
    h.actual.messageId = request.messageId;
    prepared.bindActual(h.read);
    expect(() => prepared.beforeMessageNative()).toThrow("retained Session source changed");
    expect(h.journal).toEqual([]); expect(h.originalFacts).toEqual([]); expect(h.failures).toEqual([]);
    prepared.messageOutcome("not-submitted", "not-accepted");
    expect(h.journal.map(row => row.observation.stage)).toEqual(["outcome"]);
  });
  test("an asynchronous live source guard cannot slip past the native write boundary", async () => {
    const h = fixture(cc, { assertBeforeNative: async () => {} });
    const request = h.live(), prepared = await h.transport.prepare(request, () => {});
    h.actual.messageId = request.messageId; prepared.bindActual(h.read);
    expect(() => prepared.beforeMessageNative()).toThrow("synchronously");
    expect(h.journal).toEqual([]); expect(h.originalFacts).toEqual([]);
  });

  test("live boundary is service-controlled, not a second admission/activation ledger", async () => {
    const h = fixture(cc), request = h.live(), prepared = await h.transport.prepare(request, () => {});
    prepared.bindActual(() => ({ ...h.actual, messageId: request.messageId }));
    // The service's existing attempt flags forbid replay, not this fact adapter.
    prepared.beforeMessageNative(); prepared.beforeMessageNative();
    expect(h.journal.map(item => item.observation.evidence.submission)).toEqual(["attempted", "attempted"]);
    expect(h.originalFacts).toEqual([]);
  });

  test("live payload drift and identity-reader failures fail closed, never use initial hooks", async () => {
    const h = fixture(cc), request = h.live(), prepared = await h.transport.prepare(request, () => {});
    const actual = { ...h.actual, messageId: request.messageId };
    prepared.bindActual(() => actual); actual.text += "changed";
    expect(() => prepared.beforeMessageNative()).toThrow();
    expect(h.failures).toHaveLength(1); expect(h.originalFacts).toEqual([]); expect(h.journal).toEqual([]);
    let broken = false;
    const refusal = new DispatchPreNativeRefusal(new Error("reader failed"));
    const other = fixture(cc, { readIdentity: () => { if (broken) throw refusal; return cc; } });
    const live = await other.transport.prepare(other.live(), () => {});
    live.bindActual(() => ({ ...other.actual, messageId: other.live().messageId })); broken = true;
    const failure = capture(live.beforeMessageNative);
    expect(failure).not.toBeInstanceOf(DispatchPreNativeRefusal); expect((failure as Error).cause).toBe(refusal);
    expect(other.failures).toEqual([failure]);
  });

  test("a different valid UUID is still the wrong actual message; initial callbacks cannot masquerade as live", async () => {
    const h = fixture(cc), request = h.live(), prepared = await h.transport.prepare(request, () => {});
    expect(() => prepared.bindActual(() => ({ ...h.actual, messageId: h.live(nextUuid).messageId }))).toThrow("requested message identity");
    const initial = await h.prepare(); initial.bindActual(h.read);
    expect(() => initial.beforeMessageNative()).toThrow("CC live");
    expect(() => initial.messageOutcome("submitted")).toThrow("CC live");
    expect(h.journal).toEqual([]); expect(h.originalFacts).toEqual([]);
  });

  test("unbound live execution claims fail closed instead of fabricating composition", async () => {
    const h = fixture(cc), prepared = await h.transport.prepare(h.live(), () => {});
    expect(() => prepared.beforeMessageNative()).toThrow("not bound");
    expect(() => prepared.messageOutcome("submitted")).toThrow("Unbound");
    expect(h.journal).toEqual([]); expect(h.originalFacts).toEqual([]);
  });
});
