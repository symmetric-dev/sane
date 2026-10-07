import { expect, test } from "bun:test";
import { sessionListProjection, SessionListReadinessScope } from "./session-list-projection";
import { ConversationCoordinator, type ConversationOwner } from "./conversation-coordinator";
import { WorkerService } from "./workers";
import type { WorkerRecord, WorkerDelivery } from "./worker-contract";
import type { BranchOperation } from "./branches";

const worker = (sessionId: string, parent: string, outcome = false) => ({ id: sessionId, sessionId, parent: { sessionId: parent, runId: "run", toolCallId: "tool" }, ...(outcome ? { outcome: { status: "completed" } } : {}) }) as WorkerRecord;
const branch = (sourceId: string, state: BranchOperation["state"], replace = false, destinationId = `${sourceId}-destination`) => ({ id: `${sourceId}-${state}`, sourceId, destinationId, state, replace }) as BranchOperation;
const delivery = (parentSessionId: string, state: WorkerDelivery["state"]) => ({ parentSessionId, state }) as WorkerDelivery;

test("session-list indexes match historical tree membership and first-match branch lookups", () => {
  const workers = [worker("grandchild", "child", true), worker("child", "root", true), worker("root", "grandchild"), worker("other", "unrelated"), worker("self", "self")];
  const service = { store: { list: () => workers } } as WorkerService;
  // Includes reversed ancestry, terminal workers, root exclusion, cycles,
  // multiple branch roots and every branch state/replace combination.
  for (const state of ["reserved", "creation_unknown", "confirmed", "completed", "failed"] as const) for (const replace of [false, true]) {
    for (const branches of [[branch("root", state, replace)], [branch("root", state, replace), branch("child", "reserved"), branch("self", "reserved")]]) {
      const read = sessionListProjection(workers, [], branches, []);
      for (const id of ["root", "child", "grandchild", "other", "self", "absent", ...branches.map(b => b.destinationId)]) {
        const legacy = branches.some(op => op.state !== "failed" && (op.state !== "completed" || op.replace) && WorkerService.prototype.tree.call(service, op.sourceId).some(w => w.sessionId === id));
        expect(read.branchParents.has(id)).toBe(legacy);
        expect(read.pending.get(id)).toEqual(branches.find(op => !["completed", "failed"].includes(op.state) && (op.sourceId === id || op.destinationId === id)));
        expect(read.replaced.get(id)).toEqual(branches.find(op => op.sourceId === id && op.replace && op.state === "completed"));
        expect(read.origins.get(id)).toBe(branches.find(op => op.destinationId === id && op.state !== "failed")?.sourceId);
      }
    }
  }
  const duplicates = [branch("a", "failed", false, "dest"), branch("b", "reserved", false, "dest"), branch("c", "reserved", false, "dest"), branch("a", "completed", true), branch("a", "completed", true, "second")];
  const read = sessionListProjection(workers, [], duplicates, []);
  expect(read.pending.get("dest")).toBe(duplicates[1]);
  expect(read.origins.get("dest")).toBe("b");
  expect(read.replaced.get("a")).toBe(duplicates[3]);
  expect(read.workerCounts.get("root")).toBe(1);
  expect(read.workerSessions.get("child")).toEqual({ id: "child", parent: { sessionId: "root", runId: "run", toolCallId: "tool" } });
});

test("session-list readiness preserves blockers/capacity and restores live execution after each inspection", async () => {
  const workers = [worker("busy-worker", "parent"), worker("finished-worker", "parent", true)];
  let deliveries = [delivery("claimed", "claimed"), delivery("unknown", "acceptance-unknown"), delivery("done", "delivered"), delivery("withheld", "not-submitted")];
  const scope = new SessionListReadinessScope();
  const snapshot = sessionListProjection(structuredClone(workers), structuredClone(deliveries), [], ["busy-worker", "external"]);
  expect([...snapshot.occupancy]).toEqual(["busy-worker", "external", "claimed", "unknown"]);
  let startupReady = true, retained = false, liveReads = 0;
  const coordinator = new ConversationCoordinator<ConversationOwner>({
    maxConcurrentRuns: 4, startupReady: () => startupReady, retained: () => retained,
    externalOccupancy: () => scope.current?.occupancy ?? (++liveReads, sessionListProjection(workers, deliveries, [], ["external"]).occupancy),
    policy: options => {
      const blocked = scope.current ? scope.current.deliveryParents.has(options.conversationId!) : deliveries.some(d => d.parentSessionId === options.conversationId && ["claimed", "acceptance-unknown"].includes(d.state));
      return blocked ? { ready: false, code: "worker-delivery-pending", reason: "Worker report continuation is reserved or acceptance is unconfirmed; inspect worker delivery evidence" } : undefined;
    },
  });
  const inspect = (conversationId?: string) => coordinator.inspectReadiness({ conversationId, intent: { kind: "user-prompt" }, phase: "admission" });
  for (const id of [undefined, "fresh", "busy-worker", "claimed", "unknown", "done", "withheld"]) {
    const live = inspect(id), reads = liveReads;
    expect(scope.inspect(snapshot, () => inspect(id))).toEqual(live);
    expect(liveReads).toBe(reads);
    expect(scope.current).toBeUndefined();
  }
  expect(scope.inspect(snapshot, () => inspect("claimed"))).toMatchObject({ ready: false, code: "worker-delivery-pending" });
  retained = true;
  expect(scope.inspect(snapshot, () => inspect("claimed"))).toEqual(inspect("claimed"));
  expect(scope.inspect(snapshot, () => inspect("fresh"))).toMatchObject({ ready: false, code: "reconciliation-required" });
  startupReady = false;
  expect(scope.inspect(snapshot, () => inspect("claimed"))).toMatchObject({ ready: false, code: "startup-classifying" });
  startupReady = true; retained = false;
  expect(() => scope.inspect(snapshot, () => { throw new Error("projection failed"); })).toThrow("projection failed");
  expect(scope.current).toBeUndefined();
  await Promise.resolve();
  deliveries = [];
  const admitted = coordinator.reserveAdmission({ conversationIds: ["claimed"], intent: { kind: "user-prompt" } });
  expect(admitted.ready).toBe(true);
  if (!admitted.ready) throw new Error(admitted.reason);
  deliveries = [delivery("claimed", "acceptance-unknown")];
  expect(coordinator.installOwner(admitted.lease, { run: { sessionId: "claimed", runId: "run" }, settled: false })).toMatchObject({ ready: false, code: "worker-delivery-pending" });
  expect(coordinator.hasOwner("claimed")).toBe(false);
});
