import { expect, test } from "bun:test";
import { createDispatchEvidence, DispatchPreNativeRefusal } from "./dispatch-evidence";
import type { DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";

const identity = { source: { harnessId: "fixture", sessionId: "conversation", authorityId: "authority", nativeSessionId: "native", cwd: "/fixture" }, runId: "stable-run", nativeCommandId: "stable-command" };

test("certified synchronous fresh refusal is exact, permanently withheld and records honest finish while paused", () => {
  const cause = new Error("durably paused drift"), refusal = new DispatchPreNativeRefusal(cause);
  const outcomes: DispatchSubmissionEvidence[] = []; let paused = false, failures = 0, attempts = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: () => { attempts++; paused = true; throw refusal; }, outcome: value => {
    expect(paused).toBe(true); outcomes.push(value);
  } }, () => failures++);
  expect(evidence.recognizesRefusal(refusal)).toBe(false);
  expect(() => evidence.beforeNative()).toThrow(refusal);
  expect(refusal.cause).toBe(cause); expect(evidence.recognizesRefusal(refusal)).toBe(true);
  expect(evidence.recognizesRefusal(new DispatchPreNativeRefusal(cause))).toBe(false);
  expect(evidence.recognizesRefusal(undefined)).toBe(false);
  expect(() => evidence.beforeNative()).toThrow("replay forbidden");
  evidence.finish(); evidence.finish();
  expect(attempts).toBe(1); expect(failures).toBe(0);
  expect(outcomes).toEqual([{ ...identity, submission: "not-submitted", nativeAcceptance: "not-accepted" }]);
});

for (const error of [new Error("unknown"), Object.assign(new Error("impostor"), { code: "context-changed" }),
  Object.assign(new Error("marker impostor"), { name: "DispatchPreNativeRefusal" })]) test(`uncertified boundary ${error.message} remains fatal`, () => {
  let failures = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: () => { throw error; } }, () => failures++);
  expect(() => evidence.beforeNative()).toThrow(error); expect(evidence.recognizesRefusal(error)).toBe(false);
  evidence.finish(); expect(failures).toBe(1);
});

for (const possibleNative of [false, true]) test(`nominal marker from outcome is fatal ${possibleNative ? "after possible native" : "outside fresh boundary"}`, () => {
  const refusal = new DispatchPreNativeRefusal(new Error("not a certified outcome")); let failures = 0;
  const evidence = createDispatchEvidence(identity, { outcome: () => { throw refusal; } }, () => failures++);
  if (possibleNative) evidence.beforeNative(); else evidence.withheld();
  expect(() => evidence.finish()).toThrow(refusal); expect(failures).toBe(1);
  expect(evidence.recognizesRefusal(refusal)).toBe(false);
});

test("even the exact recognized refusal from a later outcome hook is fatal", () => {
  const refusal = new DispatchPreNativeRefusal(new Error("paused")); let failures = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: () => { throw refusal; }, outcome: () => { throw refusal; } }, () => failures++);
  expect(() => evidence.beforeNative()).toThrow(refusal); expect(failures).toBe(0);
  expect(() => evidence.finish()).toThrow(refusal); expect(failures).toBe(1);
});

test("async rejection or thenable inspection cannot certify a nominal refusal", () => {
  const refusal = new DispatchPreNativeRefusal(new Error("async refusal"));
  for (const hook of [async () => { throw refusal; }, () => ({ get then() { throw refusal; } })]) {
    let failures = 0;
    const evidence = createDispatchEvidence(identity, { beforeNative: hook }, () => failures++);
    expect(() => evidence.beforeNative()).toThrow(); expect(evidence.recognizesRefusal(refusal)).toBe(false);
    evidence.finish(); expect(failures).toBe(1);
  }
});

test("durable intent precedes possible submission and a refused write remains definitely not submitted", () => {
  const outcomes: DispatchSubmissionEvidence[] = []; let failures = 0;
  let attempts = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: () => { attempts++; throw new Error("intent write refused"); }, outcome: value => outcomes.push(value) }, () => failures++);
  expect(() => evidence.beforeNative()).toThrow("intent write refused");
  const refused = evidence.snapshot(); expect(() => evidence.beforeNative()).toThrow("replay forbidden"); expect(evidence.snapshot()).toBe(refused);
  evidence.finish(); evidence.finish();
  expect(attempts).toBe(1);
  expect(failures).toBe(1); expect(outcomes).toEqual([{ ...identity, submission: "not-submitted", nativeAcceptance: "not-accepted" }]);
});

test("attempt with no further proof is unknown, correlated, immutable and cannot be replayed", () => {
  const outcomes: DispatchSubmissionEvidence[] = [], calls: string[] = [];
  const evidence = createDispatchEvidence(identity, { beforeNative: value => { calls.push("durable-intent"); expect(value.submission).toBe("attempted"); }, outcome: value => outcomes.push(value) }, () => calls.push("failed"));
  evidence.beforeNative(); expect(evidence.snapshot().submission).toBe("attempted"); evidence.finish();
  expect(outcomes[0]).toEqual({ ...identity, submission: "unknown", nativeAcceptance: "unknown" });
  expect(Object.isFrozen(outcomes[0]!.source)).toBe(true); expect(() => evidence.beforeNative()).toThrow("replay forbidden"); expect(calls).toEqual(["durable-intent"]);
});

test("postsubmission evidence write failure fails closed without losing local proof or enabling retry", () => {
  let failed = 0;
  const evidence = createDispatchEvidence(identity, { outcome: () => { throw new Error("evidence disk failed"); } }, () => failed++);
  evidence.beforeNative(); expect(() => evidence.outcome("submitted", "accepted")).toThrow("evidence disk failed");
  expect(failed).toBe(1); expect(evidence.snapshot()).toMatchObject({ submission: "submitted", nativeAcceptance: "accepted" });
  evidence.outcome("unknown"); expect(evidence.snapshot().nativeAcceptance).toBe("accepted");
  expect(() => evidence.beforeNative()).toThrow("replay forbidden");
});

test("async durable hooks are rejected synchronously rather than racing native delivery", () => {
  let failed = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: async () => {} }, () => failed++);
  expect(() => evidence.beforeNative()).toThrow("synchronously"); evidence.finish();
  expect(failed).toBe(1); expect(evidence.snapshot().submission).toBe("not-submitted");
});

test("withholding closes native admission immediately and repeated finish cannot reopen it", () => {
  const outcomes: DispatchSubmissionEvidence[] = []; let attempts = 0, failures = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: () => { attempts++; }, outcome: value => outcomes.push(value) }, () => failures++);
  expect(evidence.boundaryState()).toEqual({ phase: "fresh", withholdingObserved: false });
  evidence.withheld(); const withheld = evidence.snapshot();
  expect(evidence.boundaryState()).toEqual({ phase: "withheld", withholdingObserved: false });
  expect(() => evidence.beforeNative()).toThrow("replay forbidden");
  expect(() => evidence.outcome("unknown")).toThrow("contradicts native boundary");
  expect(evidence.snapshot()).toBe(withheld); expect(outcomes).toEqual([]);
  evidence.finish(); const finished = evidence.snapshot(); evidence.finish(); evidence.withheld();
  expect(evidence.boundaryState()).toEqual({ phase: "withheld", withholdingObserved: true });
  expect(() => evidence.beforeNative()).toThrow("replay forbidden");
  expect(evidence.snapshot()).toBe(finished); expect(attempts).toBe(0); expect(failures).toBe(0);
  expect(outcomes).toEqual([{ ...identity, submission: "not-submitted", nativeAcceptance: "not-accepted" }]);
});

test("weaker acceptance reports journal proven acceptance rather than downgrading it", () => {
  const outcomes: DispatchSubmissionEvidence[] = [];
  const evidence = createDispatchEvidence(identity, { outcome: value => outcomes.push(value) }, () => {});
  evidence.beforeNative(); evidence.outcome("submitted", "accepted");
  evidence.outcome("submitted"); evidence.outcome("submitted", "unknown");
  expect(outcomes).toHaveLength(3);
  for (const outcome of outcomes) expect(outcome).toMatchObject({ submission: "submitted", nativeAcceptance: "accepted" });
  expect(evidence.snapshot()).toBe(outcomes[2]!);
  evidence.outcome("unknown"); evidence.finish();
  expect(outcomes).toHaveLength(3); expect(evidence.snapshot().nativeAcceptance).toBe("accepted");
});

test("weaker submission can independently strengthen acceptance without erasing delivery", () => {
  const outcomes: DispatchSubmissionEvidence[] = [];
  const evidence = createDispatchEvidence(identity, { outcome: value => outcomes.push(value) }, () => {});
  evidence.beforeNative(); evidence.outcome("submitted"); evidence.outcome("unknown", "accepted");
  expect(outcomes).toHaveLength(2);
  expect(outcomes[1]).toMatchObject({ submission: "submitted", nativeAcceptance: "accepted" });
  expect(evidence.snapshot()).toBe(outcomes[1]!);
});

test("contradictory exact acceptance and invalid outcome calls do not mutate evidence or invoke hooks", () => {
  const outcomes: DispatchSubmissionEvidence[] = []; let failures = 0;
  const evidence = createDispatchEvidence(identity, { outcome: value => outcomes.push(value) }, () => failures++);
  evidence.beforeNative(); evidence.outcome("submitted", "accepted"); const proven = evidence.snapshot();
  for (const submission of ["submitted", "unknown"] as const) expect(() => evidence.outcome(submission, "not-accepted")).toThrow("contradicts established proof");
  expect(() => evidence.outcome("not-submitted", "not-accepted")).toThrow("contradicts native boundary");
  expect(() => evidence.outcome("attempted")).toThrow("Only beforeNative");
  expect(() => evidence.withheld()).toThrow("Cannot prove non-submission");
  expect(evidence.snapshot()).toBe(proven); expect(outcomes).toEqual([proven]); expect(failures).toBe(0);
});

test("known non-acceptance is not erased by an unknown acceptance update", () => {
  const outcomes: DispatchSubmissionEvidence[] = [];
  const evidence = createDispatchEvidence(identity, { outcome: value => outcomes.push(value) }, () => {});
  evidence.beforeNative(); evidence.outcome("submitted", "not-accepted"); evidence.outcome("submitted");
  expect(outcomes[1]).toMatchObject({ submission: "submitted", nativeAcceptance: "not-accepted" });
  const proven = evidence.snapshot(); expect(() => evidence.outcome("submitted", "accepted")).toThrow("contradicts established proof");
  expect(evidence.snapshot()).toBe(proven); expect(outcomes).toHaveLength(2);
});

test("a weaker acceptance write failure preserves local proof and still fails closed", () => {
  const outcomes: DispatchSubmissionEvidence[] = []; let failures = 0, refuse = false;
  const evidence = createDispatchEvidence(identity, { outcome: value => { outcomes.push(value); if (refuse) throw new Error("disk failed"); } }, () => failures++);
  evidence.beforeNative(); evidence.outcome("submitted", "accepted"); refuse = true;
  expect(() => evidence.outcome("submitted")).toThrow("disk failed");
  expect(failures).toBe(1); expect(outcomes[1]).toMatchObject({ submission: "submitted", nativeAcceptance: "accepted" });
  evidence.outcome("unknown"); evidence.finish();
  expect(evidence.snapshot()).toMatchObject({ submission: "submitted", nativeAcceptance: "accepted" });
  expect(() => evidence.beforeNative()).toThrow("replay forbidden"); expect(outcomes).toHaveLength(2);
});

test("unknown outcomes do not reintroduce attempted intent or invent Claude Code acceptance", () => {
  const outcomes: DispatchSubmissionEvidence[] = [];
  const evidence = createDispatchEvidence({ ...identity, nativeCommandId: null, source: { ...identity.source, harnessId: "claude-code" } }, { outcome: value => outcomes.push(value) }, () => {});
  evidence.beforeNative(); evidence.outcome("unknown"); const unknown = evidence.snapshot();
  expect(() => evidence.outcome("attempted")).toThrow("Only beforeNative"); expect(evidence.snapshot()).toBe(unknown);
  evidence.outcome("submitted"); evidence.finish();
  expect(evidence.snapshot()).toMatchObject({ submission: "submitted", nativeAcceptance: "unknown" });
  expect(outcomes).toHaveLength(2);
});

test("legacy completion stays unknown and closes native admission without proving withholding", () => {
  const outcomes: DispatchSubmissionEvidence[] = []; let attempts = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: () => { attempts++; }, outcome: value => outcomes.push(value) }, () => {});
  evidence.finish(); const unknown = evidence.snapshot(); evidence.finish();
  expect(() => evidence.beforeNative()).toThrow("replay forbidden");
  expect(() => evidence.withheld()).toThrow("Cannot prove non-submission");
  expect(() => evidence.outcome("not-submitted", "not-accepted")).toThrow("Unconfirmed completion");
  expect(evidence.snapshot()).toBe(unknown); expect(attempts).toBe(0);
  expect(outcomes).toEqual([{ ...identity, submission: "unknown", nativeAcceptance: "unknown" }]);
});

test("explicit non-submission closes admission and inconsistent evidence is rejected before writes", () => {
  const outcomes: DispatchSubmissionEvidence[] = []; let attempts = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: () => { attempts++; }, outcome: value => outcomes.push(value) }, () => {});
  const fresh = evidence.snapshot();
  expect(() => evidence.outcome("not-submitted", "accepted")).toThrow("Non-submission requires non-acceptance");
  expect(evidence.snapshot()).toBe(fresh); expect(outcomes).toEqual([]);
  evidence.outcome("not-submitted", "not-accepted");
  expect(() => evidence.beforeNative()).toThrow("replay forbidden"); expect(attempts).toBe(0);
});

test("native intent hook cannot reenter admission or mutate evidence before its write succeeds", () => {
  let calls = 0;
  const evidence = createDispatchEvidence(identity, { beforeNative: () => {
    calls++; const fresh = evidence.snapshot();
    expect(() => evidence.beforeNative()).toThrow("replay forbidden");
    expect(() => evidence.withheld()).toThrow("Cannot prove non-submission");
    expect(() => evidence.finish()).toThrow("during native intent write");
    expect(() => evidence.outcome("submitted")).toThrow("Only beforeNative");
    expect(evidence.snapshot()).toBe(fresh);
  } }, () => {});
  evidence.beforeNative(); expect(calls).toBe(1);
  expect(evidence.snapshot()).toMatchObject({ submission: "attempted", nativeAcceptance: "unknown" });
});
