import type { Event } from "./history";
import type { WorkerRecord } from "./worker-contract";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";

/** Final response, not the run's reasoning, tools, or intermediate commentary.
 * OC events are replaceable message snapshots; CC results already contain the
 * final response. Keep every text part of that response, with no size cap. */
export function workerOutput(events: Event[]): string | undefined {
  const messages = new Map<string, string[]>();
  let result: string | undefined;
  let buffer = "";
  for (const event of events) {
    let data = event.data as any;
    // The CLI log reader emits oversized JSON lines as raw stream fragments.
    // Reassemble them rather than losing a long report at that framing boundary.
    if (event.kind === "stdout" && typeof data === "string") {
      if (!buffer && !data.trimStart().startsWith("{")) continue;
      buffer += data;
      try { data = JSON.parse(buffer); buffer = ""; } catch { continue; }
    } else if (event.kind === "stdout") buffer = "";
    if (event.kind === "stdout" && isClaudeRootRecord(data) && data?.type === "result" && typeof data.result === "string") result = data.result;
    if (event.kind === "message" && isClaudeRootRecord(data) && data?.role === "assistant") {
      messages.set(data.messageId ?? String(event.seq), (data.parts ?? []).filter((p: any) => p.type === "text" && typeof p.text === "string").map((p: any) => p.text));
    }
    // Preserve a failed/interrupted CC run's final assistant response even when
    // it did not emit a terminal result. CLI blocks may share a message ID.
    if (event.kind === "stdout" && isClaudeRootRecord(data) && data?.type === "assistant") {
      const key = data.message?.id ?? data.uuid ?? String(event.seq);
      const content = data.message?.content ?? data.content;
      const parts: string[] = typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((p: any) => p.type === "text" && typeof p.text === "string").map((p: any) => p.text) : [];
      if (parts.length) messages.set(key, [...(messages.get(key) ?? []), ...parts]);
    }
  }
  if (result !== undefined) return result;
  return [...messages.values()].findLast(parts => parts.some(text => text.length))?.join("\n\n");
}

/** Repair legacy previews from their authoritative logs without changing result
 * identity, revision, notification state, or replaying an already delivered turn. */
export function restoreWorkerOutput(worker: WorkerRecord, eventsForRun: (runId: string) => Event[]): Partial<WorkerRecord> | undefined {
  if (!worker.results?.length) return;
  let changed = false;
  const results = worker.results.map(result => {
    const log = result.outcome.log;
    // Only the old persisted 4,000-character tails need rehydrating. Avoid
    // rescanning every completed transcript on each normal status/outbox tick.
    if (!log || result.outcome.summary.length !== 4000) return result;
    const output = workerOutput(eventsForRun(log.runId).filter(e => e.runId === log.runId && e.sessionId === log.sessionId));
    if (output === undefined || output === result.outcome.summary || !output.endsWith(result.outcome.summary)) return result;
    changed = true;
    return { ...result, outcome: { ...result.outcome, summary: output } };
  });
  return changed ? { results, outcome: results[0]!.outcome } : undefined;
}
