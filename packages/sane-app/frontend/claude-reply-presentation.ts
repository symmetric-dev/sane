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
  const candidates = new Map<string, number[]>();
  let runId: string | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    // Never match across runs, user turns or unloaded-history separators.
    if (runId !== message.runId || message.role !== "assistant") candidates.clear();
    runId = message.runId;
    const reply = text(message);
    if (isResult(message)) {
      // Background continuations can flush several results together, and the
      // reducer retains them after the assistant rows. Match each echoed reply
      // against its own preceding text, not just the last assistant message.
      const matches = candidates.get(reply);
      const candidate = matches?.shift();
      const previous = candidate === undefined ? undefined : messages[candidate];
      if (previous && reply.trim()) {
        displayed[candidate!] = { ...previous,
          parts: previous.parts.filter(part => part.type === "tool" || part.type === "reasoning" && part.text.trim()),
          version: `${previous.version ?? ""}:reply-echo:${message.id}` };
      }
      // Consume at most one assistant row per result. Repeated result text
      // remains separate replies; the same assistant cannot hide them all.
      if (!matches?.length) candidates.delete(reply);
    } else if (message.role === "assistant" && reply.trim() && message.id.startsWith(`${message.runId}:assistant:`)) {
      const matches = candidates.get(reply) ?? [];
      matches.push(index); candidates.set(reply, matches);
    }
  }
  return displayed;
}
