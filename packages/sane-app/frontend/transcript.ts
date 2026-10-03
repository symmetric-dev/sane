import type { Message, PendingTurn } from "./types";
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
