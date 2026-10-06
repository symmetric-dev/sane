import type { HarnessCapabilities } from "../shared/conversation/harness-capabilities";
import type { State } from "./store";

/** Only actionable, conversation-scoped requests may take over the composer. */
export function pendingInteractions(state: State, capabilities: Partial<HarnessCapabilities>) {
  if (!state.selected || !capabilities.listInteractions || state.conversations.find(item => item.id === state.selected)?.replacedBy) return [];
  return state.interactions.filter(item => item.type === "permission" ? capabilities.permissionReplies : item.type === "question" ? capabilities.questionReplies : false);
}
