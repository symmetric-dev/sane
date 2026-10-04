import type { CompactionMetadata, MessageSnapshot } from "./native-contract";

const text = (message: MessageSnapshot) => message.parts.every(part => part.type === "text") ? message.parts.map(part => part.type === "text" ? part.text : "").join("\n\n") : "";

/** Only whole native command envelopes qualify, never tags quoted in prose. */
function command(value: string): CompactionMetadata["command"] | undefined {
  const tags = [...value.trim().matchAll(/<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>/g)];
  if (!tags.length || value.replace(/<(command-name|command-message|command-args)>[\s\S]*?<\/\1>/g, "").trim()) return;
  const fields = new Map(tags.map(match => [match[1], match[2]]));
  if (fields.size !== tags.length || fields.get("command-name")?.trim() !== "/compact") return;
  return { name: "/compact", ...(fields.has("command-args") ? { args: fields.get("command-args") } : {}), ...(fields.has("command-message") ? { message: fields.get("command-message") } : {}) };
}
function wrapped(value: string, tag: string): string | undefined {
  return new RegExp(`^<${tag}>([\\s\\S]*?)<\\/${tag}>$`).exec(value.trim())?.[1];
}
function summary(message: MessageSnapshot) {
  // Compatibility with already imported snapshots, before the raw flag was
  // retained. This is considered only immediately adjacent to a real boundary.
  return message.compactionSummary || message.role === "user" && /^This session is being continued from a previous conversation that ran out of context\./.test(text(message));
}

/** Group presentation artifacts around a proven main-thread native boundary.
 * Does not infer completion from English stdout, change reset evidence, or
 * consume unrelated commands/user turns. Original persisted history is intact. */
export function claudeCompactionHistory(messages: readonly MessageSnapshot[]): MessageSnapshot[] {
  const result = [...messages], consumed = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    const boundary = messages[index]!;
    if (!boundary.compaction || !boundary.contextReset || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(boundary.messageId)) continue;
    const metadata = { ...boundary.compaction };
    let info = metadata.command ? { ...metadata.command } : undefined;
    let hasCommand = !!metadata.command;
    const take = (at: number, before: boolean): boolean => {
      if (consumed.has(at)) return false;
      const message = messages[at];
      if (!message || message.compaction || message.role !== "user" && message.role !== "system") return false;
      const value = text(message);
      const cmd = command(value);
      const output = wrapped(value, "local-command-stdout");
      const notice = wrapped(value, "local-command-caveat");
      if (cmd && !hasCommand) { info = { ...info, ...cmd }; hasCommand = true; }
      else if (!before && value && summary(message)) metadata.summary = value;
      else if (!before && output !== undefined && /^\s*Compacted\b/.test(output) && info?.output === undefined) info = { name: "/compact", ...info, output };
      else if (notice !== undefined && info?.notice === undefined) info = { name: "/compact", ...info, notice };
      else return false;
      consumed.add(at);
      return true;
    };
    // CLI versions persist the command either before the boundary or after the
    // continuation summary. Stop at the first ordinary conversation message.
    for (let at = index - 1; at >= 0 && take(at, true); at--) { /* adjacent envelopes */ }
    for (let at = index + 1; at < messages.length && take(at, false); at++) { /* adjacent envelopes */ }
    if (info) metadata.command = info;
    result[index] = { ...boundary, compaction: metadata };
  }
  return result.filter((_, index) => !consumed.has(index));
}
