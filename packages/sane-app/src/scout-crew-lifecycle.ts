import type { CanonicalAgentOperations } from "./canonical-agent-operations";
import { managedWorkerRoles } from "./managed-worker-lifecycle";
export { managedWorkerRoles, managedWorkerCoordination, managedWorkerWaiting, managedWorkerWaiting as scoutCrewWaiting } from "./managed-worker-lifecycle";
export { workerBlocksParentGate } from "./worker-protocol";

/** Compatibility for existing callers; managed coordination is shared across worker roles. */
export function managedScoutCrew(policy: CanonicalAgentOperations | undefined) {
  return policy?.spec.name === "sane/worker/scout-crew" && managedWorkerRoles(policy) !== undefined;
}
