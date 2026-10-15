import type { HarnessCapabilities } from "../shared/conversation/harness-capabilities";
import type { State } from "./store";

/** Only actionable, conversation-scoped requests may take over the composer.
 * Handoff approvals attach to the sender sessionId that called sane_handoff,
 * never the recipient, and take over the composer like permission prompts. */
export function pendingInteractions(state: State, capabilities: Partial<HarnessCapabilities>) {
  if (!state.selected || state.conversations.find(item => item.id === state.selected)?.replacedBy) return [];
  const handoffCapable = !!capabilities.listHandoffApprovals && !!capabilities.handoffReplies;
  const listable = (type: string) => type === "permission" ? !!capabilities.permissionReplies && !!capabilities.listInteractions
    : type === "question" ? !!capabilities.questionReplies && !!capabilities.listInteractions
    : type === "handoff-approval" ? handoffCapable : false;
  // Sender approvals may arrive via the dedicated handoff-approvals poll or,
  // for forward compatibility, inside the interactions inbox. Combine both.
  const combined = [...state.interactions, ...(state.handoffApprovals ?? [])];
  const seen = new Set<string>();
  const deduped = combined.filter(item => {
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return deduped.filter(item => listable(item.type));
}
/** Sender-session handoff approvals only, for focused badges and copy. */
export function pendingHandoffApprovals(state: State, capabilities: Partial<HarnessCapabilities>) {
  return pendingInteractions(state, capabilities).filter(item => item.type === "handoff-approval");
}
