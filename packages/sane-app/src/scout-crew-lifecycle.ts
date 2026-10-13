import type { CanonicalAgentOperations } from "./canonical-agent-operations";
import type { WorkerAgentId } from "sane-core/agent-catalog";
import { workerResults, workerTerminal, type WorkerRecord } from "./worker-contract";

/** Explicit opt-in in new execution packages, never inferred from a mutable role file. */
export function managedScoutCrew(policy: CanonicalAgentOperations | undefined) {
  return policy?.spec.name === "sane/worker/scout-crew" && managedWorkerRoles(policy) !== undefined;
}

export function managedWorkerRoles(policy: CanonicalAgentOperations | undefined): readonly WorkerAgentId[] | undefined {
  if (!policy?.permissions.some(p => p.action === "sane_worker_start" && p.resource === "*" && p.effect === "allow")) return;
  if (policy.spec.name === "sane/worker/scout-crew") return ["scout"];
  if (policy.spec.name === "sane/worker/implementer") return ["scout", "researcher"];
}

export function managedWorkerCoordination(policy: CanonicalAgentOperations | undefined): WorkerRecord["coordination"] {
  if (!managedWorkerRoles(policy)) return;
  return managedScoutCrew(policy) ? "scouts" : "workers";
}

/** Acceptance alone is not synthesis: pending/ambiguous outcomes must reach the parent first. */
export function managedWorkerWaiting(children: WorkerRecord[]) {
  return children.some(child => !workerTerminal(child) || !workerResults(child).length || workerResults(child).some(result => !["delivered", "wait-consumed"].includes(result.notification.state)));
}

export const scoutCrewWaiting = managedWorkerWaiting;
