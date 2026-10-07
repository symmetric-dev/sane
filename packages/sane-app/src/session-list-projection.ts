import type { BranchOperation } from "./branches";
import type { ConversationReadiness } from "./conversation-coordinator";
import type { WorkerDelivery, WorkerRecord } from "./worker-contract";

/** One synchronous response's detached store reads. Never an execution authority. */
export function sessionListProjection(workers: readonly WorkerRecord[], deliveries: readonly WorkerDelivery[], branches: readonly BranchOperation[], otherOccupancy: Iterable<string>) {
  const workerSessions = new Map(workers.map(w => [w.sessionId, { id: w.id, parent: { sessionId: w.parent.sessionId, runId: w.parent.runId, toolCallId: w.parent.toolCallId } }]));
  const workerCounts = new Map<string, number>(), children = new Map<string, string[]>();
  const occupancy = new Set(otherOccupancy), deliveryParents = new Set<string>();
  for (const worker of workers) {
    workerCounts.set(worker.parent.sessionId, (workerCounts.get(worker.parent.sessionId) ?? 0) + 1);
    const siblings = children.get(worker.parent.sessionId) ?? [];
    siblings.push(worker.sessionId); children.set(worker.parent.sessionId, siblings);
    // Occupancy deliberately follows the existing outcome predicate, not state.
    if (!worker.outcome) occupancy.add(worker.sessionId);
  }
  for (const delivery of deliveries) if (["claimed", "acceptance-unknown"].includes(delivery.state)) {
    deliveryParents.add(delivery.parentSessionId); occupancy.add(delivery.parentSessionId);
  }
  const pending = new Map<string, BranchOperation>(), replaced = new Map<string, BranchOperation>(), origins = new Map<string, string>();
  const roots = new Set<string>(), branchParents = new Set<string>();
  for (const branch of branches) {
    // Store lookups use find(): preserve their first matching record.
    if (branch.state !== "failed" && !origins.has(branch.destinationId)) origins.set(branch.destinationId, branch.sourceId);
    if (branch.state === "completed" && branch.replace && !replaced.has(branch.sourceId)) replaced.set(branch.sourceId, branch);
    if (!["completed", "failed"].includes(branch.state)) for (const id of [branch.sourceId, branch.destinationId]) if (!pending.has(id)) pending.set(id, branch);
    if (branch.state !== "failed" && (branch.state !== "completed" || branch.replace)) roots.add(branch.sourceId);
  }
  for (const root of roots) {
    // WorkerService.tree includes historical descendants but excludes its root,
    // even for cycles. Track each root separately: another root may include it.
    const seen = new Set([root]), queue = [root];
    for (let i = 0; i < queue.length; i++) for (const child of children.get(queue[i]!) ?? []) if (!seen.has(child)) {
      seen.add(child); queue.push(child); branchParents.add(child);
    }
  }
  return { workerSessions, workerCounts, branches, pending, replaced, origins, branchParents, deliveryParents, occupancy };
}

export type SessionListProjection = ReturnType<typeof sessionListProjection>;

/** Adapts the coordinator's zero-argument occupancy callback for a single
 * inspectReadiness call. The callback/result are strictly synchronous; restore
 * before returning (or throwing), so no snapshot survives an await or reaches
 * a later admission/dispatch check. Callers pass the projection explicitly. */
export class SessionListReadinessScope {
  current?: SessionListProjection;
  inspect(context: SessionListProjection, read: () => ConversationReadiness): ConversationReadiness {
    const previous = this.current;
    this.current = context;
    try { return read(); }
    finally { this.current = previous; }
  }
}
