import { expect, test } from "bun:test";
import type { DispatchIdentity, DispatchSource, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import { startDispatchLifecycle, type HarnessDispatchAdapter } from "./harness-dispatch";
import type { RunOwner } from "./run-owner";

async function fixture(change: (owner: RunOwner) => void, afterNative: (owner: RunOwner) => void = () => {}) {
  const source: DispatchSource = { harnessId: "claude-code", sessionId: crypto.randomUUID(), authorityId: "fixture", nativeSessionId: crypto.randomUUID(), cwd: "/fixture" };
  const runId = crypto.randomUUID(), requestId = crypto.randomUUID(), identity: DispatchIdentity = Object.freeze({ source: Object.freeze(source), runId, nativeCommandId: null, requestId });
  let owned = true, effects = 0;
  const failures: unknown[] = [];
  const outcomes: DispatchSubmissionEvidence[] = [];
  const adapter: HarnessDispatchAdapter = { id: "claude-code", automation: {}, readiness: async value => ({ source: value, readiness: { ready: true } }),
    successfulSettlement: async () => ({ ready: true }), execute: async (owner, _prompt, _resume, ready) => {
      change(owner); owner.dispatchEvidence!.beforeNative(); effects++; ready(true); afterNative(owner); owner.dispatchEvidence!.outcome("submitted"); owner.run.status = "completed";
    } };
  const lifecycle = startDispatchLifecycle<RunOwner>(adapter, { source, prompt: "authored", resume: false, origin: "user", requestId }, {
    evidence: { outcome: fact => { outcomes.push(fact); } },
    install: done => ({ run: { runId, sessionId: source.sessionId, cwd: source.cwd, createdAt: new Date().toISOString(), status: "running" }, done, settled: false,
      contextMessages: Object.freeze({ prepare: async () => { throw new Error("This test never composes or invokes a transport"); } }), contextIdentity: identity, assertMetadataCommitted() {} }),
    owns: () => owned, settle: owner => { owner.settled = true; }, release: () => { owned = false; }, terminate: async () => {}, failClosed: error => { failures.push(error); },
    guards: owner => ({ settled: owner.settled, released: !owned, status: owner.run.status, cancelling: false, stopRequested: false, stopping: false, closing: false, storageFailed: !!failures.length, reconciliationRequired: !!failures.length }),
  });
  await lifecycle.done;
  return { lifecycle, effects, failures, outcomes };
}
test("an unchanged context capability stays inside the existing dispatch lifecycle", async () => {
  const f = await fixture(() => {}); expect(f.effects).toBe(1); expect(f.failures).toEqual([]);
});
test("the production lifecycle journals an original outcome before failing settlement for launch-setting drift", async () => {
  const f = await fixture(() => {}, owner => { owner.run.model = "changed-after-native-effect"; });
  expect(f.effects).toBe(1);
  expect(f.outcomes.some(fact => fact.submission === "submitted")).toBe(true);
  expect(f.failures.length).toBeGreaterThan(0);
  expect(f.lifecycle.submissionEvidence().submission).toBe("submitted");
});
test("delivery-policy drift cannot hide the original outcome behind a core configuration gate", async () => {
  const f = await fixture(() => {}, owner => { owner.nativeDeliveryPolicy = "native-queued-handoff"; });
  expect(f.effects).toBe(1);
  expect(f.outcomes.some(fact => fact.submission === "submitted")).toBe(true);
  expect(f.failures.length).toBeGreaterThan(0);
  expect(f.lifecycle.submissionEvidence().submission).toBe("submitted");
});
for (const field of ["contextMessages", "contextIdentity", "assertMetadataCommitted"] as const) test(`replacing installed ${field} cannot reopen native admission`, async () => {
  const f = await fixture(owner => {
    if (field === "contextMessages") owner.contextMessages = Object.freeze({ ...owner.contextMessages! });
    if (field === "contextIdentity") owner.contextIdentity = Object.freeze({ ...owner.contextIdentity! });
    if (field === "assertMetadataCommitted") owner.assertMetadataCommitted = () => {};
  });
  expect(f.effects).toBe(0); expect(f.failures.length).toBeGreaterThan(0);
  expect(() => f.lifecycle.owner.dispatchEvidence!.beforeNative()).toThrow();
});
