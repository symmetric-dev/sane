import type { CanonicalAgentOperations } from "./canonical-agent-operations";
import { workerResults, workerTerminal, type WorkerRecord } from "./worker-contract";

/** Explicit opt-in in new execution packages, never inferred from a mutable role file. */
export function managedScoutCrew(policy: CanonicalAgentOperations | undefined) {
  return policy?.spec.name === "sane/worker/scout-crew" && policy.permissions.some(p => p.action === "sane_worker_start" && p.resource === "*" && p.effect === "allow");
}

/** Acceptance alone is not synthesis: pending/ambiguous outcomes must reach the crew first. */
export function scoutCrewWaiting(children: WorkerRecord[]) {
  return children.some(child => !workerTerminal(child) || !workerResults(child).length || workerResults(child).some(result => !["delivered", "wait-consumed"].includes(result.notification.state)));
}
