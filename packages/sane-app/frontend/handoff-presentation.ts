import type { HandoffStatus } from "sane-core/contracts";
export { assignmentLabel as phaseLabel } from "./assignment-semantics";
export { isHandoffTool, sentHandoffs, receivedHandoff } from "../shared/conversation/handoff-matching";

export const handoffStatusLabel: Record<HandoffStatus, string> = { awaiting_approval: "Awaiting approval", queued: "Queued", acceptance_unknown: "Acceptance unconfirmed", accepted: "Accepted", running: "Running", completed: "Completed", failed: "Failed" };
