import { describe, expect, test } from "bun:test";
import {
  ConversationCoordinator, type ConversationAdmissionLease, type ConversationCoordinatorOptions,
  type ConversationOperationIntent, type ConversationOwner,
} from "./conversation-coordinator";

type Owner = ConversationOwner;
const prompt: ConversationOperationIntent = { kind: "user-prompt" };
function owner(sessionId = "a", runId = "run-1"): Owner {
  return { run: { sessionId, runId }, settled: false };
}
function fixture(options: Partial<ConversationCoordinatorOptions<Owner>> = {}) {
  return new ConversationCoordinator<Owner>({ maxConcurrentRuns: 2, ...options });
}
function reserve(coordinator: ConversationCoordinator<Owner>, ids = ["a"], intent = prompt, predecessor?: Owner): ConversationAdmissionLease {
  const result = coordinator.reserveAdmission({ conversationIds: ids, intent, predecessor });
  if (!result.ready) throw new Error(`${result.code}: ${result.reason}`);
  return result.lease;
}
function install(coordinator: ConversationCoordinator<Owner>, value = owner()) {
  const lease = reserve(coordinator, [value.run.sessionId]);
  expect(coordinator.installOwner(lease, value)).toEqual({ ready: true });
  expect(coordinator.releaseAdmission(lease)).toBe(true);
  return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("identity-bound conversation arbitration", () => {
  test("startup classification blocks every ordinary intent and install but permits exact observation adoption", async () => {
    let ready = true;
    const value = owner("observed"), coordinator = fixture({ startupReady: () => ready, externalOccupancy: () => ["observed"], observationAdmission: candidate => candidate === value ? { ready: true } : { ready: false, code: "observation-unproven", reason: "wrong owner" } });
    const lease = reserve(coordinator); ready = false;
    for (const kind of ["user-prompt", "worker-launch", "worker-report", "handoff", "branch-recovery", "prepare-recipient"] as const) expect(coordinator.reserveAdmission({ conversationIds: ["b"], intent: { kind } })).toMatchObject({ ready: false, code: "startup-classifying" });
    expect(coordinator.installOwner(lease, owner())).toMatchObject({ ready: false, code: "startup-classifying" });
    expect(coordinator.adoptObservedOwner(value)).toEqual({ ready: true });
    ready = true; expect(coordinator.installOwner(lease, owner())).toEqual({ ready: true });
    await coordinator.close(); expect(coordinator.reserveAdmission({ conversationIds: ["b"], intent: prompt })).toMatchObject({ ready: false, code: "bridge-closing" });
  });
  test("observation adoption is denied by default and never weakens retained-state admission", () => {
    const coordinator = fixture({ retained: () => true, externalOccupancy: () => ["a"] });
    expect(coordinator.adoptObservedOwner(owner())).toMatchObject({ ready: false, code: "observation-unproven" });
    expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: { kind: "recover-run", requestId: "run-1" } })).toMatchObject({ ready: false, code: "reconciliation-required" });
    expect(coordinator.hasOwner("a")).toBe(false);
  });

  test("private exact-run proof adopts existing observation under retained state without dispatch leases or extra capacity", () => {
    const value = owner(), coordinator = fixture({ maxConcurrentRuns: 1, retained: () => true, externalOccupancy: () => ["a", "a"],
      observationAdmission: candidate => candidate.run === value.run ? { ready: true } : { ready: false, code: "observation-unproven", reason: "Not the pinned startup run" },
    });
    expect(coordinator.adoptObservedOwner({ ...value, run: { ...value.run } })).toMatchObject({ ready: false, code: "observation-unproven" });
    expect(coordinator.adoptObservedOwner(value)).toEqual({ ready: true });
    expect(coordinator.owns(value)).toBe(true); expect(coordinator.hasAdmission("a")).toBe(false);
    expect([...coordinator.occupiedConversationIds()]).toEqual(["a"]);
    expect(coordinator.adoptObservedOwner(value)).toMatchObject({ ready: false, code: "conversation-busy" });
    for (const kind of ["user-prompt", "handoff", "recover-run"] as const) {
      expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: { kind } })).toMatchObject({ ready: false, code: "reconciliation-required" });
    }
    expect(coordinator.reserveAdmission({ conversationIds: ["b"], intent: prompt }).ready).toBe(false);
  });

  test("observation requires independent existing occupancy and preserves closing/storage proof blockers", async () => {
    let storageFailed = true;
    const coordinator = fixture({ externalOccupancy: () => ["a"], observationAdmission: () => storageFailed
      ? { ready: false, code: "storage-unavailable", reason: "Storage unavailable" } : { ready: true },
    });
    expect(coordinator.adoptObservedOwner(owner())).toMatchObject({ ready: false, code: "storage-unavailable" });
    storageFailed = false; await coordinator.close();
    expect(coordinator.adoptObservedOwner(owner())).toMatchObject({ ready: false, code: "bridge-closing" });
    const absent = fixture({ observationAdmission: () => ({ ready: true }) });
    expect(absent.adoptObservedOwner(owner())).toMatchObject({ ready: false, code: "observation-unproven" });
    expect(absent.hasOwner("a")).toBe(false);
  });

  test("stale/copy/foreign lease releases cannot remove a newer reservation", () => {
    const coordinator = fixture(), old = reserve(coordinator);
    expect(coordinator.releaseAdmission({ ...old })).toBe(false);
    expect(fixture().releaseAdmission(old)).toBe(false);
    expect(coordinator.releaseAdmission(old)).toBe(true);
    const current = reserve(coordinator);
    expect(coordinator.releaseAdmission(old)).toBe(false);
    expect(coordinator.holdsAdmission(current, "a")).toBe(true);
    expect(coordinator.installOwner(old, owner())).toMatchObject({ ready: false, code: "admission-stale" });
  });

  test("competing requests cannot acquire or recheck another request's reservation", () => {
    const coordinator = fixture(), lease = reserve(coordinator);
    expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: prompt })).toMatchObject({ ready: false, code: "conversation-busy" });
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: prompt, phase: "dispatch" })).toMatchObject({ ready: false, code: "conversation-busy" });
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: prompt, phase: "dispatch", lease })).toEqual({ ready: true });
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: { kind: "compact" }, phase: "dispatch", lease })).toMatchObject({ ready: false, code: "admission-intent" });
    expect(coordinator.inspectReadiness({ conversationId: "b", intent: prompt, phase: "dispatch", lease })).toMatchObject({ ready: false, code: "admission-stale" });
  });

  test("multi-conversation acquisition and extension roll back fully on contention", () => {
    const coordinator = fixture({ maxConcurrentRuns: 4 }), competing = reserve(coordinator, ["b"]);
    expect(coordinator.reserveAdmission({ conversationIds: ["a", "b"], intent: { kind: "branch" } })).toMatchObject({ ready: false, code: "conversation-busy" });
    expect(coordinator.hasAdmission("a")).toBe(false);
    const source = reserve(coordinator, ["a"], { kind: "branch", requestId: "branch-1" });
    expect(coordinator.extendAdmission(source, ["c", "b"])).toMatchObject({ ready: false, code: "conversation-busy" });
    expect(coordinator.hasAdmission("c")).toBe(false);
    expect(coordinator.holdsAdmission(source, "a")).toBe(true);
    coordinator.releaseAdmission(competing);
    expect(coordinator.extendAdmission(source, ["b", "c", "c"])).toEqual({ ready: true });
    expect(coordinator.leaseConversationIds(source)).toEqual(["a", "b", "c"]);
    expect(coordinator.releaseAdmission(source)).toBe(true);
    expect([...coordinator.admissionSessionIds()]).toEqual([]);
  });

  test("later domain denial and multi-target capacity failure install no partial locks", () => {
    const coordinator = fixture({ policy: input => input.conversationId === "b" ? { ready: false, code: "branch-pending", reason: "Finishing branch" } : undefined });
    expect(coordinator.reserveAdmission({ conversationIds: ["a", "b"], intent: { kind: "branch" } })).toEqual({ ready: false, code: "branch-pending", reason: "Finishing branch" });
    expect([...coordinator.admissionSessionIds()]).toEqual([]);
    const small = fixture({ maxConcurrentRuns: 1 });
    expect(small.reserveAdmission({ conversationIds: ["a", "b"], intent: { kind: "branch" } })).toMatchObject({ ready: false, code: "capacity" });
    const source = reserve(small, ["a"], { kind: "branch" });
    expect(small.extendAdmission(source, ["b"])).toMatchObject({ ready: false, code: "capacity" });
    expect(small.leaseConversationIds(source)).toEqual(["a"]);
  });

  test("owner release requires current identity, settlement, and completed cancellation", () => {
    let retained = false;
    const coordinator = fixture({ retained: () => retained }), old = install(coordinator);
    expect(coordinator.releaseOwner(old)).toBe(false);
    old.settled = true; old.cancelling = true;
    expect(coordinator.releaseOwner(old)).toBe(false);
    expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: prompt })).toMatchObject({ ready: false, code: "conversation-busy" });
    old.cancelling = false; retained = true;
    expect(coordinator.releaseOwner(old)).toBe(false);
    expect(coordinator.inspectReadiness({ intent: prompt, phase: "enqueue" })).toMatchObject({ ready: false, code: "reconciliation-required" });
    retained = false;
    expect(coordinator.releaseOwner(old)).toBe(true);
    const current = install(coordinator, owner("a", "run-2"));
    expect(coordinator.releaseOwner(old)).toBe(false);
    expect(coordinator.getOwner("a")).toBe(current);
    expect(coordinator.owns(old)).toBe(false);
    expect([...coordinator.owners()]).toEqual([current]);
    expect([...coordinator.ownerSessionIds()]).toEqual(["a"]);
  });

  test("installation is synchronous and never overwrites an active owner", async () => {
    const coordinator = fixture(), lease = reserve(coordinator), value = owner();
    let observed: Owner | undefined;
    const competing = Promise.resolve().then(() => { observed = coordinator.getOwner("a"); });
    const decision = coordinator.installOwner(lease, value);
    expect(decision).toEqual({ ready: true });
    expect(coordinator.getOwner("a")).toBe(value);
    expect(coordinator.installOwner(lease, owner("a", "other"))).toMatchObject({ ready: false, code: "conversation-busy" });
    await competing;
    expect(observed).toBe(value);
    coordinator.releaseAdmission(lease);
    expect(coordinator.occupiedConversationIds().size).toBe(1);
  });

  test("installation rechecks live safety without dropping and reacquiring admission", () => {
    let unsafe = false;
    const coordinator = fixture({ policy: () => unsafe ? { ready: false, code: "workstream-action-pending", reason: "Repository phase action" } : undefined });
    const lease = reserve(coordinator);
    unsafe = true;
    expect(coordinator.installOwner(lease, owner())).toEqual({ ready: false, code: "workstream-action-pending", reason: "Repository phase action" });
    expect(coordinator.hasOwner("a")).toBe(false);
    expect(coordinator.holdsAdmission(lease, "a")).toBe(true);
    unsafe = false;
    expect(coordinator.installOwner(lease, owner())).toEqual({ ready: true });
  });

  test("specific domain failure reasons survive the retained-ownership fallback", () => {
    const coordinator = fixture({ retained: () => true, policy: () => ({ ready: false, code: "storage-unavailable", reason: "Storage unavailable; operator reconciliation required" }) });
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: prompt, phase: "enqueue" })).toEqual({ ready: false, code: "storage-unavailable", reason: "Storage unavailable; operator reconciliation required" });
    expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: prompt })).toMatchObject({ ready: false, code: "storage-unavailable" });
  });
});

describe("capacity and readiness", () => {
  test("reconciliation token identity rejects copies, foreign and stale clears", () => {
    const coordinator = fixture(), first = install(coordinator);
    expect(() => coordinator.beginReconciliation(owner())).toThrow("current owner");
    const old = coordinator.beginReconciliation(first);
    expect(() => coordinator.beginReconciliation(first)).toThrow("existing barrier");
    expect(coordinator.endReconciliation({ ...old })).toBe(false);
    expect(fixture().endReconciliation(old)).toBe(false);
    first.settled = true; expect(coordinator.releaseOwner(first)).toBe(true);
    expect(coordinator.hasReconciliation("a")).toBe(true);
    expect(coordinator.endReconciliation(old)).toBe(true);
    const second = install(coordinator, owner("a", "run-2")), current = coordinator.beginReconciliation(second);
    expect(coordinator.endReconciliation(old)).toBe(false);
    expect([...coordinator.reconciliationSessionIds()]).toEqual(["a"]);
    expect(coordinator.endReconciliation(current)).toBe(true);
  });

  test("reconciliation blocks every readiness phase and installation, even with an exact admission lease", () => {
    const coordinator = fixture(), lease = reserve(coordinator), value = owner();
    expect(coordinator.installOwner(lease, value)).toEqual({ ready: true });
    const token = coordinator.beginReconciliation(value);
    value.settled = true; expect(coordinator.releaseOwner(value)).toBe(true);
    for (const phase of ["enqueue", "admission", "dispatch"] as const) {
      for (const intent of [prompt, { kind: "worker-report" }, { kind: "handoff" }] as const) {
        expect(coordinator.inspectReadiness({ conversationId: "a", intent, phase })).toMatchObject({ ready: false, code: "reconciliation-pending" });
      }
    }
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: { kind: "inspect-idle" }, phase: "admission" })).toMatchObject({ ready: false, code: "reconciliation-pending" });
    expect(coordinator.installOwner(lease, owner("a", "next"))).toMatchObject({ ready: false, code: "reconciliation-pending" });
    expect(coordinator.hasOwner("a")).toBe(false);
    expect(coordinator.endReconciliation(token)).toBe(true);
    expect(coordinator.installOwner(lease, owner("a", "next"))).toEqual({ ready: true });
  });

  test("barriers keep deduplicated capacity occupied after owner/admission release", () => {
    const coordinator = fixture({ maxConcurrentRuns: 1, externalOccupancy: () => ["a", "a"] });
    const lease = reserve(coordinator), value = owner();
    expect(coordinator.installOwner(lease, value)).toEqual({ ready: true });
    const token = coordinator.beginReconciliation(value);
    expect([...coordinator.occupiedConversationIds()]).toEqual(["a"]);
    coordinator.releaseAdmission(lease); value.settled = true; coordinator.releaseOwner(value);
    expect([...coordinator.occupiedConversationIds()]).toEqual(["a"]);
    expect(coordinator.reserveAdmission({ conversationIds: ["b"], intent: prompt })).toMatchObject({ ready: false, code: "capacity" });
    expect(coordinator.inspectReadiness({ conversationId: "b", intent: prompt, phase: "enqueue" })).toEqual({ ready: true });
    expect(coordinator.endReconciliation(token)).toBe(true);
  });

  test("a barrier alone retains capacity and prevents partial multi-conversation extension", () => {
    const coordinator = fixture(), value = install(coordinator);
    const token = coordinator.beginReconciliation(value);
    value.settled = true; coordinator.releaseOwner(value);
    expect([...coordinator.occupiedConversationIds()]).toEqual(["a"]);
    expect(coordinator.reserveAdmission({ conversationIds: ["b", "a"], intent: { kind: "branch" } })).toMatchObject({ ready: false, code: "reconciliation-pending" });
    expect(coordinator.hasAdmission("b")).toBe(false);
    const lease = reserve(coordinator, ["b"], { kind: "branch" });
    expect(coordinator.extendAdmission(lease, ["c", "a"])).toMatchObject({ ready: false });
    expect(coordinator.hasAdmission("c")).toBe(false);
    expect(coordinator.holdsAdmission(lease, "b")).toBe(true);
    coordinator.endReconciliation(token); coordinator.releaseAdmission(lease);
    expect(coordinator.occupiedConversationIds().size).toBe(0);
  });

  test("shutdown permits existing-owner reconciliation bookkeeping but never clears a retained barrier", async () => {
    const coordinator = fixture(), value = install(coordinator);
    await coordinator.close();
    const token = coordinator.beginReconciliation(value);
    value.settled = true; expect(coordinator.releaseOwner(value)).toBe(true);
    expect(coordinator.hasReconciliation("a")).toBe(true);
    expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: prompt })).toMatchObject({ ready: false, code: "bridge-closing" });
    expect(coordinator.endReconciliation(token)).toBe(true);
  });

  test("deduplicates domain occupancy, owners, and leases; same-session continuation adds no slot", () => {
    const external = ["a", "a", "b", "b"];
    const coordinator = fixture({ externalOccupancy: () => external }), lease = reserve(coordinator);
    expect(coordinator.installOwner(lease, owner())).toEqual({ ready: true });
    expect([...coordinator.occupiedConversationIds()].sort()).toEqual(["a", "b"]);
    expect(coordinator.reserveAdmission({ conversationIds: ["c"], intent: { kind: "handoff" } })).toMatchObject({ ready: false, code: "capacity" });
    const continuation = reserve(coordinator, ["b"], { kind: "worker-report" });
    expect(coordinator.installOwner(continuation, owner("b"))).toEqual({ ready: true });
    expect(coordinator.occupiedConversationIds().size).toBe(2);
    const snapshot = coordinator.occupiedConversationIds() as Set<string>;
    snapshot.clear();
    expect(coordinator.occupiedConversationIds().size).toBe(2);
  });

  test("new enqueue readiness ignores contention/capacity but still evaluates safety and owns no slot", () => {
    let unsafe = false;
    const seen: string[] = [];
    const coordinator = fixture({ maxConcurrentRuns: 1, policy: input => {
      seen.push(input.phase);
      return unsafe ? { ready: false, code: "attachment-pending", reason: "Retry Attach" } : undefined;
    } });
    install(coordinator);
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: prompt, phase: "admission" })).toMatchObject({ ready: false, code: "conversation-busy" });
    expect(coordinator.inspectReadiness({ conversationId: "b", intent: prompt, phase: "dispatch" })).toMatchObject({ ready: false, code: "capacity" });
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: prompt, phase: "enqueue" })).toEqual({ ready: true });
    expect(coordinator.inspectReadiness({ conversationId: "b", intent: prompt, phase: "enqueue" })).toEqual({ ready: true });
    expect([...coordinator.admissionSessionIds()]).toEqual([]);
    expect(coordinator.occupiedConversationIds().size).toBe(1);
    unsafe = true;
    expect(coordinator.inspectReadiness({ conversationId: "b", intent: prompt, phase: "enqueue" })).toEqual({ ready: false, code: "attachment-pending", reason: "Retry Attach" });
    expect(seen).toContain("enqueue");
    unsafe = false;
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: { kind: "compact" }, phase: "enqueue" })).toMatchObject({ ready: false, code: "enqueue-unsupported" });
  });

  test("legacy followup retains exact predecessor reservation and capacity across settlement", () => {
    const coordinator = fixture({ maxConcurrentRuns: 1, canRetainPredecessor: () => true });
    const predecessor = install(coordinator);
    const retained = coordinator.reserveAdmission({ conversationIds: ["a"], intent: prompt, predecessor });
    if (!retained.ready) throw new Error(retained.reason);
    expect(retained.queueAfterRunId).toBe("run-1");
    expect(coordinator.occupiedConversationIds().size).toBe(1);
    expect(coordinator.installOwner(retained.lease, owner("a", "run-2"))).toMatchObject({ ready: false, code: "conversation-busy" });
    expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: prompt, predecessor })).toMatchObject({ ready: false, code: "conversation-busy" });
    predecessor.settled = true;
    expect(coordinator.releaseOwner(predecessor)).toBe(true);
    expect(coordinator.hasAdmission("a")).toBe(true);
    expect(coordinator.reserveAdmission({ conversationIds: ["b"], intent: prompt })).toMatchObject({ ready: false, code: "capacity" });
    expect(coordinator.inspectReadiness({ conversationId: "a", intent: prompt, phase: "dispatch", lease: retained.lease })).toEqual({ ready: true });
    const next = owner("a", "run-2");
    expect(coordinator.installOwner(retained.lease, next)).toEqual({ ready: true });
    coordinator.releaseAdmission(retained.lease);
    expect(coordinator.releaseOwner(predecessor)).toBe(false);
    expect(coordinator.owns(next)).toBe(true);
  });

  test("predecessor retention is not a generalized capacity or busy bypass", () => {
    const coordinator = fixture({ canRetainPredecessor: () => true }), predecessor = install(coordinator);
    for (const intent of [{ kind: "compact" }, { kind: "handoff" }, { kind: "worker-report" }] as const) {
      expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent, predecessor })).toMatchObject({ ready: false, code: "conversation-busy" });
    }
    expect(coordinator.reserveAdmission({ conversationIds: ["b"], intent: prompt, predecessor })).toMatchObject({ ready: false, code: "admission-predecessor" });
    expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: prompt, predecessor: owner() })).toMatchObject({ ready: false, code: "conversation-busy" });
    predecessor.cancelling = true;
    expect(coordinator.reserveAdmission({ conversationIds: ["a"], intent: prompt, predecessor })).toMatchObject({ ready: false, code: "conversation-busy" });
    const ineligible = fixture();
    const other = install(ineligible);
    expect(ineligible.reserveAdmission({ conversationIds: ["a"], intent: prompt, predecessor: other })).toMatchObject({ ready: false, code: "conversation-busy" });
  });

  test("idle inspection cannot reserve capacity; maintenance cannot install a run", () => {
    const coordinator = fixture({ maxConcurrentRuns: 1 });
    install(coordinator);
    expect(coordinator.inspectReadiness({ intent: { kind: "inspect-idle" }, phase: "admission" })).toEqual({ ready: true });
    expect(coordinator.inspectReadiness({ intent: prompt, phase: "admission" })).toMatchObject({ ready: false, code: "capacity" });
    expect(coordinator.reserveAdmission({ conversationIds: ["b"], intent: { kind: "inspect-idle" } as unknown as ConversationOperationIntent })).toMatchObject({ ready: false, code: "admission-intent" });
    const maintenance = fixture(), lease = reserve(maintenance, ["a"], { kind: "history-refresh" });
    expect(maintenance.installOwner(lease, owner())).toMatchObject({ ready: false, code: "admission-intent" });
    expect(maintenance.hasOwner("a")).toBe(false);
  });
});

describe("coalesced asynchronous wakes", () => {
  test("same-turn wakes coalesce; wakes during an awaited pass cause one more pass", async () => {
    const entered = deferred(), resume = deferred();
    let passes = 0;
    const coordinator = fixture({ wake: { dispatch: async () => {
      passes++;
      if (passes === 1) { entered.resolve(); await resume.promise; }
    }, onError: error => { throw error; } } });
    coordinator.requestWake(); coordinator.requestWake(); coordinator.requestWake();
    expect(passes).toBe(0);
    await entered.promise;
    coordinator.requestWake(); coordinator.requestWake();
    resume.resolve();
    await coordinator.drainWake();
    expect(passes).toBe(2);
  });

  test("wake at pass completion is not lost and errors are reported without orphan rejection", async () => {
    const done = deferred();
    const errors: unknown[] = [];
    let passes = 0;
    let coordinator: ConversationCoordinator<Owner>;
    coordinator = fixture({ wake: { dispatch: async () => {
      passes++;
      if (passes === 1) {
        await done.promise;
        queueMicrotask(() => coordinator.requestWake());
        throw new Error("domain unavailable");
      }
    }, onError: error => { errors.push(error); } } });
    coordinator.requestWake();
    done.resolve();
    await coordinator.drainWake();
    expect(passes).toBe(2);
    expect(errors).toHaveLength(1);
    coordinator.requestWake();
    await coordinator.drainWake();
    expect(passes).toBe(3);
  });

  test("close gates scheduled dispatch and future installation synchronously", async () => {
    let passes = 0;
    const coordinator = fixture({ wake: { dispatch: () => { passes++; }, onError: () => {} } });
    const lease = reserve(coordinator);
    coordinator.requestWake();
    const closing = coordinator.close();
    coordinator.requestWake();
    expect(coordinator.installOwner(lease, owner())).toMatchObject({ ready: false, code: "bridge-closing" });
    expect(coordinator.reserveAdmission({ conversationIds: ["b"], intent: prompt })).toMatchObject({ ready: false, code: "bridge-closing" });
    await closing;
    expect(passes).toBe(0);
    expect(coordinator.releaseAdmission(lease)).toBe(true);
    await coordinator.drainWake();
    expect(passes).toBe(0);
  });

  test("close aborts/drains an in-flight pass, suppresses dirty rerun and post-await dispatch", async () => {
    const entered = deferred(), resume = deferred();
    let passes = 0, installations = 0, aborted = false;
    let coordinator: ConversationCoordinator<Owner>;
    const leaseHolder: { lease?: ConversationAdmissionLease } = {};
    coordinator = fixture({ wake: { dispatch: async signal => {
      passes++; entered.resolve();
      await resume.promise;
      aborted = signal.aborted;
      if (coordinator.installOwner(leaseHolder.lease!, owner()).ready) installations++;
    }, onError: () => {} } });
    leaseHolder.lease = reserve(coordinator);
    coordinator.requestWake();
    await entered.promise;
    coordinator.requestWake();
    let drained = false;
    const closing = coordinator.close().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    resume.resolve();
    await closing;
    expect(aborted).toBe(true);
    expect(passes).toBe(1);
    expect(installations).toBe(0);
  });

  test("identity-guarded releases wake asynchronously; external closing gate suppresses all passes", async () => {
    let externalClosing = false, passes = 0;
    const coordinator = fixture({ isClosing: () => externalClosing, wake: { dispatch: () => { passes++; }, onError: () => {} } });
    const value = install(coordinator);
    await coordinator.drainWake();
    expect(passes).toBe(1);
    value.settled = true;
    expect(coordinator.releaseOwner(value)).toBe(true);
    expect(passes).toBe(1);
    await coordinator.drainWake();
    expect(passes).toBe(2);
    externalClosing = true;
    coordinator.requestWake();
    await coordinator.drainWake();
    expect(passes).toBe(2);
  });
});
