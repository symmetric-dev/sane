import type { Harness, Message } from "./types";

const text = (message: Message) => message.parts.filter(part => part.type === "text").map(part => part.text).join("\n\n");
const isResult = (message: Message) => message.role === "assistant" && message.normalized && message.status === "completed"
  && (message.id.startsWith(`${message.runId}:result:index:`) || message.id.startsWith(`${message.runId}:result:legacy:`));

/** Display the CLI's echoed final text once, on the durable result target.
 * This is presentation only, not an assistant/result identity join. Preserve
 * every message ID, result boundary, tool, reasoning block and run warning. */
export function claudeReplyPresentation(messages: Message[], harness: Harness): Message[] {
  if (harness !== "claude-code") return messages;
  const displayed = messages.slice();
  let candidate: number | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (candidate !== undefined && messages[candidate]!.runId !== message.runId) candidate = undefined;
    if (isResult(message)) {
      const previous = candidate === undefined ? undefined : messages[candidate];
      if (previous && text(message).trim() && text(previous) === text(message)) {
        displayed[candidate!] = { ...previous,
          parts: previous.parts.filter(part => part.type === "tool" || part.type === "reasoning" && part.text.trim()),
          version: `${previous.version ?? ""}:reply-echo:${message.id}` };
      }
      // Identical text at separate completion boundaries is still separate replies.
      candidate = undefined;
    } else if (message.role !== "assistant") candidate = undefined;
    else if (text(message).trim()) candidate = message.id.startsWith(`${message.runId}:assistant:`) ? index : undefined;
  }
  return displayed;
}
