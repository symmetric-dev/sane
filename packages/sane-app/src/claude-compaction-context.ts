import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";
import type { CompactionContext } from "./compaction-context";

/** Read only native structured boundaries and hook attachments. Model prose,
 * even an exact copy of the restoration, never counts as hook delivery. The
 * caller supplies the original profile/session locator, not a model path. */
export function claudeCompactionRestorationNeeded(context: CompactionContext, path: string): readonly boolean[] {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) throw new Error("Native compaction transcript is unavailable");
    let compacted = false;
    const delivered = new Set<string>();
    const record = (line: string) => {
      if (!line.trim()) return;
      const row = JSON.parse(line);
      if (!isClaudeRootRecord(row)) return;
      if (row.type === "relocated") throw new Error("Relocated native history cannot qualify compaction restoration");
      if (row.sessionId !== undefined && row.sessionId !== context.message.binding.nativeSessionId)
        throw new Error("Compaction transcript belongs to another native session");
      if (row.type === "system" && row.subtype === "compact_boundary") { compacted = true; delivered.clear(); }
      if (!compacted || row.type !== "attachment" || row.attachment?.type !== "hook_additional_context") return;
      const pending: unknown[] = [row.attachment];
      while (pending.length) {
        const value = pending.pop();
        if (typeof value === "string" && context.parts.includes(value)) delivered.add(value);
        else if (value && typeof value === "object") pending.push(...Object.values(value));
      }
    };
    // Transcript storage does not shrink when native context is compacted. Read
    // a fixed file extent with bounded memory, not a 16 MiB whole-file import
    // limit that would itself prevent long conversations from compacting.
    // Normal boundary records and our <10k hook outputs fit in this line budget;
    // enormous tool-result records cannot establish either kind of evidence.
    const bytes = Buffer.alloc(64 * 1024), decoder = new TextDecoder("utf-8", { fatal: true });
    let position = 0, pending = "", oversized = false;
    while (position < stat.size) {
      const count = readSync(file, bytes, 0, Math.min(bytes.length, stat.size - position), position);
      if (!count) throw new Error("Native compaction transcript ended during its bounded read");
      position += count;
      const text = decoder.decode(bytes.subarray(0, count), { stream: true });
      let start = 0, end: number;
      while ((end = text.indexOf("\n", start)) >= 0) {
        const tail = text.slice(start, end);
        if (!oversized && pending.length + tail.length <= 1024 * 1024) record(pending + tail);
        pending = ""; oversized = false; start = end + 1;
      }
      if (!oversized) {
        pending += text.slice(start);
        if (pending.length > 1024 * 1024) { pending = ""; oversized = true; }
      }
    }
    // A live CLI can be appending the last record while SessionStart runs.
    // Incomplete final JSON is never evidence of an existing attachment.
    return context.parts.map(part => compacted && !delivered.has(part));
  } finally { closeSync(file); }
}
