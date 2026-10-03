import type { ReconciledHistory } from "../src/reconcile";
import type { Conversation, Message, Run } from "./types";
import type { PagedTranscript } from "./transcript-pages";

export const conversationKey = (conversation: Conversation) => JSON.stringify([conversation.id, conversation.harness, conversation.nativeSessionId ?? conversation.id, conversation.cwd]);
export type ConversationSnapshot = { runs: Map<string, Run>; messages: Message[]; nativeHistory: ReconciledHistory | null | undefined; nativeHistoryLoaded: boolean; transcript?: PagedTranscript | null };

/** Copy only what consume mutates. Event payloads, usage snapshots, and nested
 * tool input/output are immutable evidence; copying their retained logs each
 * active poll is unnecessary. Tool-result entries are replaced, never mutated. */
export function cloneRunForConsume(run: Run): Run {
  return { ...run,
    messages: run.messages.map(message => ({ ...message, ...(message.nativeIds ? { nativeIds: [...message.nativeIds] } : {}), parts: message.parts.map(part => ({ ...part })) })),
    events: [...run.events], seen: new Set(run.seen), resultKeys: new Set(run.resultKeys),
    observedEfforts: [...run.observedEfforts], toolResults: new Map(run.toolResults),
  };
}

/** Approximate retained heap, including reducer diagnostics and collection overhead.
 * Walk only on departure, stop at the budget, and never serialize the transcript. */
function retainedBytes(value: unknown, limit: number): number {
  const seen = new Set<object>();
  let bytes = 0;
  const visit = (value: unknown): void => {
    if (bytes > limit) return;
    if (typeof value === "string") { bytes += 16 + value.length * 2; return; }
    if (value === null || typeof value !== "object") { bytes += 8; return; }
    if (seen.has(value)) return;
    seen.add(value); bytes += 64;
    if (value instanceof Map) {
      for (const [key, entry] of value) { bytes += 32; visit(key); visit(entry); if (bytes > limit) break; }
    } else if (value instanceof Set || Array.isArray(value)) {
      for (const entry of value) { bytes += 16; visit(entry); if (bytes > limit) break; }
    } else {
      for (const key of Object.keys(value)) { bytes += 16 + key.length * 2; visit((value as Record<string, unknown>)[key]); if (bytes > limit) break; }
    }
  };
  visit(value);
  return bytes;
}

/** Inactive conversations only. Taking an entry transfers ownership, so neither
 * the live reducer nor a later poll can mutate an inactive cached snapshot. */
export class ConversationCache {
  private entries = new Map<string, { id: string; snapshot: ConversationSnapshot; bytes: number }>();
  private bytes = 0;
  constructor(private maxEntries = 8, private maxBytes = 32 * 1024 * 1024) {}
  clear() { this.entries.clear(); this.bytes = 0; }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.bytes; this.entries.delete(key); }
    return entry;
  }
  invalidate(id: string) { for (const [key, entry] of this.entries) if (entry.id === id) this.remove(key); }
  prune(conversations: Conversation[]) {
    const keys = new Set(conversations.map(conversationKey));
    for (const key of this.entries.keys()) if (!keys.has(key)) this.remove(key);
  }
  put(conversation: Conversation, snapshot: ConversationSnapshot) {
    this.invalidate(conversation.id);
    let bytes: number;
    try { bytes = retainedBytes(snapshot, this.maxBytes); } catch { return; }
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    // structuredClone preserves Sets, Maps, aliases, and incomplete stdout buffers.
    // Keep no references to the published state or an in-flight poll.
    let copy: ConversationSnapshot;
    try { copy = structuredClone(snapshot); } catch { return; }
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
    this.entries.set(conversationKey(conversation), { id: conversation.id, snapshot: copy, bytes });
    this.bytes += bytes;
  }
  take(conversation: Conversation) { return this.remove(conversationKey(conversation))?.snapshot; }
}
