import type { BranchOperation } from "./branches";
import type { Session } from "./history";
import { readFramework } from "sane-core/sane-framework";

/** Native forks inherit canonical instructions. Changing their bytes merely to
 * announce a fork makes OpenCode append the entire entry to model history.
 * Only migration from historical startup instructions needs this notice; retain
 * it on descendants of that migration so their inherited entry stays stable. */
export function branchContextDynamic(sessionId: string, dynamic: string, operations: readonly BranchOperation[], sessions: readonly Pick<Session, "sessionId" | "saneExecution" | "saneContext">[], continuation = () => readFramework("branch-continuation").text): string {
  const visited = new Set<string>();
  while (true) {
    if (visited.has(sessionId)) throw new Error("Cyclic branch context ancestry");
    visited.add(sessionId);
    const branch = operations.find(op => op.destinationId === sessionId && op.canonicalActivation && op.state === "completed");
    if (!branch) return dynamic;
    const source = sessions.find(session => session.sessionId === branch.sourceId);
    // Missing historical metadata cannot establish an already-canonical source.
    if (!source?.saneExecution || !source.saneContext?.package) return `${dynamic}\n\n${continuation()}`;
    sessionId = branch.sourceId;
  }
}
