import type { ConversationRef, Handoff, HandoffStatus, Phase } from "sane-core/contracts";

/** Read-only chat presentation; never changes delivery or lifecycle state. */
export type HandoffParty = { sessionId: string | null; title: string; phases: Phase[]; ref: ConversationRef | null };
export type HandoffHistoryEntry = { id: number; status: HandoffStatus; at: string; evidence?: string };
export type HandoffPresentation = {
  handoff: Handoff;
  sender: HandoffParty;
  recipient: HandoffParty;
  workstreamTitle: string;
  deliveries: { runId: string; commandId: string | null }[];
  history: HandoffHistoryEntry[];
  problem?: string;
};
export type HandoffProjection = { handoffs: HandoffPresentation[]; error?: string };
