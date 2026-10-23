import type { Conversation } from "./types";

const activityTime = (conversation: Conversation) => {
  const time = conversation.updatedAt ? Date.parse(conversation.updatedAt) : NaN;
  return Number.isFinite(time) ? time : -Infinity;
};

/** Newest first, with a deterministic order for equal or missing timestamps. */
export function compareConversationActivity(a: Conversation, b: Conversation) {
  const left = activityTime(a), right = activityTime(b);
  return left !== right ? left > right ? -1 : 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
