import type { BranchOperation } from "./branches";
import type { Session } from "./history";

const continuation = "\n\nThis is a branch continuation. Preserve the lifecycle stage and task state evidenced by the copied conversation and the user's branch message. Do not restart Pickup merely because canonical context was activated. Copied SANE startup instructions and role snapshots are historical; use the current pinned role and private procedure index for execution.";

/** Native forks inherit canonical instructions. Changing their bytes merely to
 * announce a fork makes OpenCode append the entire entry to model history.
 * Only migration from historical startup instructions needs this notice; retain
 * it on descendants of that migration so their inherited entry stays stable. */
export function branchContextDynamic(sessionId: string, dynamic: string, operations: readonly BranchOperation[], sessions: readonly Pick<Session, "sessionId" | "saneExecution" | "saneContext">[]): string {
  const visited = new Set<string>();
  while (true) {
    if (visited.has(sessionId)) throw new Error("Cyclic branch context ancestry");
    visited.add(sessionId);
    const branch = operations.find(op => op.destinationId === sessionId && op.canonicalActivation && op.state === "completed");
    if (!branch) return dynamic;
    const source = sessions.find(session => session.sessionId === branch.sourceId);
    // Missing historical metadata cannot establish an already-canonical source.
    if (!source?.saneExecution || !source.saneContext?.package) return dynamic + continuation;
    sessionId = branch.sourceId;
  }
}
