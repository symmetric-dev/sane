import type { Conversation, Message, PendingTurn } from "./types";
export { transcriptMessages } from "../shared/conversation/transcript";

/** Bridge the acknowledgement-to-history gap, never deduplicating by prompt text. */
export function messagesWithPendingTurn(messages: Message[], turn?: PendingTurn | null): Message[] {
  if (!turn || turn.runId && messages.some(message => message.runId === turn.runId && message.role === "user")) return messages;
  const pending: Message = { id: turn.id, runId: turn.runId ?? turn.id, role: "user", parts: [{ type: "text", text: turn.text }], time: turn.time, status: "completed" };
  const result = [...messages];
  const response = turn.runId ? messages.findIndex(message => message.runId === turn.runId) : -1;
  result.splice(response >= 0 ? response : result.length, 0, pending);
  return result;
}

/** Queue input remains recoverable independently of transcript paging and run
 * outcomes. A recorded submission replaces its receipt by identity, not text. */
export function messagesWithQueuedFollowups(messages: Message[], conversation?: Conversation): Message[] {
  const queued = (conversation?.queuedFollowups ?? []).filter(receipt => {
    if (receipt.sessionId !== conversation?.id) return false;
    if (receipt.state !== "dispatched") return true;
    return receipt.runId === conversation.lastRunId && !messages.some(message => message.runId === receipt.runId && message.role === "user");
  }).map((receipt): Message => ({ id: `queued:${receipt.requestId}`, runId: receipt.runId ?? receipt.afterRunId,
    role: "user", parts: [{ type: "text", text: receipt.prompt }], time: receipt.time, status: "completed", queuedFollowup: receipt,
    version: `${receipt.requestId}:${receipt.state}:${receipt.runId ?? ""}` }));
  return queued.length ? [...messages, ...queued] : messages;
}
