import { expect, test } from "bun:test";
import { createPendingInputBridge, type PendingInputBridge, type PendingInputBridgeDependencies } from "./pending-input-bridge";
import type { PendingInputResumeCommit } from "./pending-input-service";
import type { DispatchLifecycle } from "./harness-dispatch";
import type { RunOwner } from "./run-owner";

// The coordinator delegates only its queue policy to this bridge. These tests
// exercise that narrow release-policy exception, not native release authority.
function fixture(harness: "claude-code" | "opencode") {
  const source = { harnessId: harness, sessionId: "conversation", authorityId: "authority", nativeSessionId: "native", cwd: "/repo" };
  const configuration = { profileId: harness === "claude-code" ? "base:cc" : "base:oc" };
  const pins = { configuration, launch: configuration, context: null };
  const prepared = { binding: { harness, conversationId: source.sessionId, authorityId: source.authorityId, nativeSessionId: source.nativeSessionId, cwd: source.cwd }, configuration };
  const identity = { source, runId: "previous-run", nativeCommandId: harness === "opencode" ? "command" : null, requestId: "previous-request" };
  const evidence = { ...identity, submission: "submitted", nativeAcceptance: "unknown" };
  const owner = { run: { runId: identity.runId, sessionId: source.sessionId, cwd: source.cwd, nativeCommandId: identity.nativeCommandId, status: "failed", ...configuration }, settled: true, cancelling: false, stopRequested: true } as RunOwner;
  const previous = { itemId: "previous", requestId: identity.requestId, chainId: "chain", state: "settled", snapshot: { pins, prepared },
    claim: { identity, evidence, uncertain: false }, history: { kind: "settled", status: "failed" }, receipt: { revision: 1 } };
  const head = { itemId: "head", requestId: "next-request", request: { conversationId: source.sessionId }, chainId: "chain", state: "waiting", snapshot: { pins, prepared }, receipt: { revision: 2 } };
  const request = { conversationId: source.sessionId, requestId: "resume-request" }, receipt = { revision: 5 };
  const record = { conversationId: source.sessionId, revision: 5, items: [previous, head], operations: [{ kind: "resume", request, result: receipt }] };
  const view = { snapshot: { revision: 5, items: [head] }, chain: { chainId: "chain" }, pause: null as null | object, recoveryRequired: false,
    lastAuthorization: { chainId: "chain" }, lastPredecessorRunId: identity.runId };
  let current: RunOwner | undefined, reconciliation = false, localReady = true;
  let bridge: PendingInputBridge;
  const lifecycle = { owner, done: new Promise<void>(() => {}), submissionEvidence: () => evidence } as unknown as DispatchLifecycle<RunOwner>;
  const deps = {
    store: { inspect: () => view, lookup: (_cid: string, id: string) => ({ item: id === identity.requestId ? previous : head }), readRecords: () => ({ conversations: [record] }) },
    coordinator: { owns: (candidate: RunOwner) => current === candidate, getOwner: () => current, hasReconciliation: () => reconciliation,
      inspectReadiness: (input: Parameters<PendingInputBridge["allowsReadiness"]>[0]) => ({ ready: bridge.allowsReadiness(input) }) },
    run: () => owner.run, submissionSafety: () => {}, readLocalSettlement: () => ({ ready: localReady, kind: "terminated" }),
  } as unknown as PendingInputBridgeDependencies;
  bridge = createPendingInputBridge(deps);
  bridge.recordLifecycle(source.sessionId, lifecycle);
  const commit = { request, receipt, chainId: "chain", head, preflight: { pins, validate: () => {} } } as unknown as PendingInputResumeCommit;
  const input = { conversationId: source.sessionId, intent: { kind: "user-prompt" as const, requestId: identity.requestId }, phase: "dispatch" as const };
  return { bridge, owner, previous, head, record, view, evidence, commit, input,
    release: () => bridge.releasedReadiness(owner, input).ready,
    setForeignOwner: () => { current = { ...owner, run: { ...owner.run, runId: "foreign" } }; },
    setReconciliation: () => { reconciliation = true; }, setLocalUnproven: () => { localReady = false; } };
}

for (const harness of ["claude-code", "opencode"] as const) {
  test(`${harness} submitted failed predecessor release requires live explicit consent and original owner scope`, () => {
    const f = fixture(harness);
    expect(f.release()).toBe(false);
    f.bridge.resumeCommitted(f.commit);
    expect(f.bridge.allowsReadiness(f.input)).toBe(false);
    expect(f.release()).toBe(true);
    expect(f.owner.stopRequested).toBe(true);
    expect(f.head.state).toBe("waiting");
  });

  for (const barrier of ["stale", "uncertain", "source-drift", "foreign-owner", "reconciliation", "restart", "unsettled", "cancelling"] as const) {
    test(`${harness} submitted resume refuses ${barrier}`, () => {
      const f = fixture(harness);
      f.bridge.resumeCommitted(f.commit);
      switch (barrier) {
        case "stale": f.record.revision++; f.view.snapshot.revision++; break;
        case "uncertain": f.previous.claim.uncertain = true; break;
        case "source-drift": f.head.snapshot.prepared.binding.cwd = "/changed"; break;
        case "foreign-owner": f.setForeignOwner(); break;
        case "reconciliation": f.setReconciliation(); break;
        case "restart": f.view.recoveryRequired = true; break;
        case "unsettled": f.owner.settled = false; break;
        case "cancelling": f.owner.cancelling = true; break;
      }
      expect(f.release()).toBe(false);
      if (barrier === "stale") {
        f.record.revision--; f.view.snapshot.revision--;
        expect(f.release()).toBe(false); // restoring metadata cannot renew revoked consent
      }
    });
  }
}

test("Claude submitted resume still requires original local service terminal capability", () => {
  const f = fixture("claude-code");
  f.bridge.resumeCommitted(f.commit);
  f.setLocalUnproven();
  expect(f.release()).toBe(false);
});
