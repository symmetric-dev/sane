import { projectCompactions } from "./compaction-evidence";
import type { Event, Run as StoredRun } from "../../src/history";
import type { CompactionRecord } from "./native-contract";
import type { ReconciledHistory } from "./native-history-contract";
import type { Harness, Message, Run } from "./types";

export function compactionsFor(conversation: { id: string; harness: Harness; nativeSessionId?: string }, runs: Run[], history?: ReconciledHistory | null, remote: CompactionRecord[] = []): CompactionRecord[] {
  const stored = runs.map(r => ({ ...r, runId: r.id, sessionId: r.conversationId, status: r.status === "starting" ? "running" : r.status === "unknown" ? "interrupted" : r.status })) as StoredRun[];
  const events = runs.flatMap(r => r.events) as Event[];
  const superseded = new Set(events.filter(event => event.kind === "message" && (!history || event.time > history.importedAt)).map(event => (event.data as { messageId?: string } | null)?.messageId));
  const imported = history?.messages.filter(message => !superseded.has(message.messageId));
  const local = projectCompactions({ sessionId: conversation.id, harness: conversation.harness, nativeSessionId: conversation.nativeSessionId }, stored, events, imported);
  const result = [...remote];
  for (const record of local) {
    const index = result.findIndex(other => other.id === record.id || record.nativeId && other.nativeId === record.nativeId || record.requestId && other.requestId === record.requestId);
    if (index < 0) result.push(record);
    else {
      const other = result[index]!;
      // A GET is the admission authority, but a newer durable live boundary must
      // not regress to the requested state from an earlier read.
      const newer = !!record.observedAt && (!other.observedAt || record.observedAt >= other.observedAt) || record.contextReset && !other.nativeId && other.lifecycle !== "failed" && other.lifecycle !== "skipped";
      result[index] = newer ? { ...other, ...record, id: other.id } : { ...record, ...other };
    }
  }
  return result;
}

/** Place imported boundaries using native array order, not import observation
 * timestamps. App-only evidence is anchored by its run, then a genuine clock.
 * Unknown placement stays in a separate trailing lifecycle area. */
export function compactionPositions(records: CompactionRecord[], messages: Message[], history?: ReconciledHistory | null): Map<string, CompactionRecord[]> {
  const positions = new Map<string, CompactionRecord[]>();
  const findMessage = (id: string) => messages.find(m => m.id === id || m.nativeIds?.includes(id));
  for (const record of records) {
    let next: Message | undefined;
    const nativeIndex = record.nativeId ? history?.messages.findIndex(m => m.messageId === record.nativeId) ?? -1 : -1;
    if (nativeIndex >= 0) {
      for (const message of history!.messages.slice(nativeIndex + 1)) { next = findMessage(message.messageId); if (next) break; }
    } else if (record.runId) {
      const evidenceTime = record.endedAt ?? record.startedAt ?? record.observedAt ?? record.requestedAt;
      next = messages.find(m => m.runId === record.runId && evidenceTime && m.time > evidenceTime);
      if (!next && evidenceTime) next = messages.find(m => m.time && m.time > evidenceTime);
    } else {
      const nativeTime = record.endedAt ?? record.startedAt;
      if (nativeTime) next = messages.find(m => m.time && m.time > nativeTime);
    }
    const key = next?.id ?? "";
    positions.set(key, [...(positions.get(key) ?? []), record]);
  }
  for (const records of positions.values()) records.sort((a, b) => {
    const ai = a.nativeId ? history?.messages.findIndex(m => m.messageId === a.nativeId) ?? -1 : -1;
    const bi = b.nativeId ? history?.messages.findIndex(m => m.messageId === b.nativeId) ?? -1 : -1;
    if (ai >= 0 && bi >= 0) return ai - bi;
    const at = a.startedAt ?? a.endedAt, bt = b.startedAt ?? b.endedAt;
    return at && bt ? at.localeCompare(bt) : 0;
  });
  return positions;
}
