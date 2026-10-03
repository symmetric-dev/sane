import type { TranscriptCompaction, TranscriptMessage, TranscriptPage, TranscriptRefresh, TranscriptSummary, TranscriptRunMetadata } from "../src/transcript-contract";
import type { Harness, Message, ModelChoice, Run } from "./types";
import type { ContextUsageSnapshot } from "./context-usage";

export type TranscriptIsland = { key: string; messages: TranscriptMessage[]; coverage: TranscriptPage["coverage"]; continuation: TranscriptPage["continuation"]; scope?: "target"; observedEndBoundary: boolean; endRevision: string };
export type PagedTranscript = { summary: TranscriptSummary; islands: TranscriptIsland[]; metadataRevision?: string; compactions: TranscriptCompaction[]; target?: TranscriptPage["target"] };
export type PageRequest = { island: string; direction: "older" | "newer" };
export class TranscriptCoverageError extends Error {}
export const pageMessages = (pages?: PagedTranscript | null) => pages?.islands.flatMap(island => island.messages) ?? [];
const summary = ({ sessionId, revision, epoch, usage, nativeHistoryImportedAt }: TranscriptSummary): TranscriptSummary => ({ sessionId, revision, epoch, usage, nativeHistoryImportedAt });
const preserve = (old: TranscriptMessage | undefined, next: TranscriptMessage): TranscriptMessage => old?.version === next.version ? old : next;

export const canonicalCount = (pages: PagedTranscript) => Math.max(0, ...pages.islands.map(island => island.coverage.totalMessages));

/** Canonical epoch-scoped ranges, not native clocks or cursor interpretation,
 * establish order, overlap AND adjacency. Receipt fences protect newer loaded
 * versions from delayed responses; independent reads never regress usage. */
export function mergePage(previous: PagedTranscript | null | undefined, page: TranscriptPage, edge?: PageRequest, latest = false, independent = false, protectedIds: ReadonlySet<string> = new Set(), preserveSummary = independent): PagedTranscript {
  const same = previous?.summary.sessionId === page.sessionId && previous.summary.epoch === page.epoch;
  const old = same ? previous! : undefined;
  const { firstIndex, lastIndex, totalMessages } = page.coverage;
  if (!Number.isSafeInteger(totalMessages) || totalMessages < 0 || (page.messages.length ? firstIndex === null || lastIndex === null || !Number.isSafeInteger(firstIndex) || !Number.isSafeInteger(lastIndex) || firstIndex < 0 || lastIndex >= totalMessages || lastIndex - firstIndex + 1 !== page.messages.length : firstIndex !== null || lastIndex !== null || totalMessages !== 0)) throw new TranscriptCoverageError("Invalid canonical transcript coverage.");
  if (page.coverage.firstId !== (page.messages[0]?.id ?? null) || page.coverage.lastId !== (page.messages.at(-1)?.id ?? null)) throw new TranscriptCoverageError("Transcript coverage anchor identity mismatch.");
  const nextSummary = preserveSummary && old ? old.summary : summary(page);
  // Streaming-free polls must not copy or inspect the full retained content.
  if (latest && old && page.revision === old.summary.revision && totalMessages === canonicalCount(old) && old.islands.some(island => firstIndex !== null && island.coverage.firstIndex! <= firstIndex && island.coverage.lastIndex === lastIndex && island.endRevision === page.revision)) return old;
  const incoming: TranscriptIsland = { key: page.coverage.firstId ?? "empty", messages: page.messages, coverage: page.coverage, continuation: page.continuation,
    observedEndBoundary: lastIndex !== null && lastIndex + 1 < totalMessages && !page.continuation.newer, endRevision: page.revision, ...(page.target ? { scope: "target" as const } : {}) };
  const ordered = [...(old?.islands.filter(island => island.messages.length) ?? []), incoming].filter(island => island.messages.length).sort((a, b) => a.coverage.firstIndex! - b.coverage.firstIndex!);
  const groups: TranscriptIsland[][] = [];
  for (const island of ordered) {
    const group = groups.at(-1);
    if (!group || island.coverage.firstIndex! > Math.max(...group.map(entry => entry.coverage.lastIndex!)) + 1) groups.push([island]);
    else group.push(island);
  }
  const islands = groups.map(group => {
    const hasIncoming = group.includes(incoming);
    if (!hasIncoming && group.length === 1) return group[0]!;
    const existing = group.filter(island => island !== incoming);
    const start = Math.min(...group.map(island => island.coverage.firstIndex!));
    const end = Math.max(...group.map(island => island.coverage.lastIndex!));
    const base = existing.find(island => island.key === edge?.island) ?? existing[0];
    // At equal edges prefer established observations for independent (possibly
    // delayed) pages. A genuine range extension necessarily supplies its edge.
    const first = independent && existing.find(island => island.coverage.firstIndex === start) || (hasIncoming && incoming.coverage.firstIndex === start ? incoming : group.find(island => island.coverage.firstIndex === start)!);
    const last = independent && existing.find(island => island.coverage.lastIndex === end) || (hasIncoming && incoming.coverage.lastIndex === end ? incoming : group.find(island => island.coverage.lastIndex === end)!);
    let messages: TranscriptMessage[];
    if (base && existing.length === 1 && base.coverage.firstIndex === start && base.coverage.lastIndex === end) {
      // Contained pages don't copy all loaded messages. Only a changed envelope
      // that passes its receipt fence needs a shallow replacement array.
      messages = base.messages;
      for (let index = 0; index < incoming.messages.length; index++) {
        const position = firstIndex! - start + index, oldMessage = messages[position]!, next = incoming.messages[index]!;
        if (oldMessage.id !== next.id) throw new TranscriptCoverageError("Transcript range identity mismatch.");
        const replacement = protectedIds.has(next.id) ? oldMessage : preserve(oldMessage, next);
        if (replacement !== oldMessage) { if (messages === base.messages) messages = [...messages]; messages[position] = replacement; }
      }
    } else {
      messages = new Array(end - start + 1);
      for (const island of existing) island.messages.forEach((message, index) => { messages[island.coverage.firstIndex! - start + index] = message; });
      if (hasIncoming) incoming.messages.forEach((message, index) => {
        const position = firstIndex! - start + index, previous = messages[position];
        if (previous && previous.id !== message.id) throw new TranscriptCoverageError("Transcript range identity mismatch.");
        messages[position] = previous && protectedIds.has(message.id) ? previous : preserve(previous, message);
      });
    }
    return { key: base?.key ?? incoming.key, scope: latest && hasIncoming || existing.some(island => !island.scope) ? undefined : base?.scope ?? incoming.scope, messages,
      coverage: { firstId: messages[0]!.id, lastId: messages.at(-1)!.id, firstIndex: start, lastIndex: end, totalMessages: Math.max(...group.map(island => island.coverage.totalMessages)), olderCursor: first.coverage.olderCursor, newerCursor: last.coverage.newerCursor },
      continuation: { older: first.continuation.older, newer: last.continuation.newer }, observedEndBoundary: last.observedEndBoundary, endRevision: last.endRevision };
  });
  if (!islands.length) islands.push(incoming);
  return { summary: nextSummary, islands, metadataRevision: old?.metadataRevision, compactions: old?.compactions ?? [], target: page.target ?? old?.target };
}

export function refreshPages(pages: PagedTranscript, refresh: TranscriptRefresh, protectedIds: ReadonlySet<string> = new Set(), preserveSummary = false): PagedTranscript {
  const updates = new Map(refresh.upserts.map(message => [message.id, message]));
  const removed = new Set(refresh.removedIds);
  if (removed.size) throw new TranscriptCoverageError("Loaded transcript messages were removed without an epoch reset.");
  return { ...pages, summary: preserveSummary ? pages.summary : summary(refresh), islands: updates.size ? pages.islands.map(island => {
    let messages = island.messages;
    island.messages.forEach((message, index) => {
      const replacement = updates.has(message.id) && !protectedIds.has(message.id) ? preserve(message, updates.get(message.id)!) : message;
      if (replacement !== message) { if (messages === island.messages) messages = [...messages]; messages[index] = replacement; }
    });
    return messages === island.messages ? island : { ...island, messages };
  }) : pages.islands };
}

/** A tail-at-observation false continuation is NOT a proven turn boundary once
 * canonical output has grown beyond it. Non-tail observed boundaries remain
 * valid within this epoch; structural edits require a reset. */
export function turnBoundaryKnown(pages: PagedTranscript, island: TranscriptIsland, source: Message): boolean {
  const later = island.messages.slice(island.messages.findIndex(message => message.id === source.id) + 1);
  if (later.some(message => message.role === "user" || source.runId !== "native-import" && message.runId !== source.runId)) return true;
  return !island.continuation.newer && (island.observedEndBoundary || island.coverage.lastIndex === canonicalCount(pages) - 1 && island.endRevision === pages.summary.revision);
}

const metadataFields = ["id", "conversationId", "cwd", "status", "createdAt", "endedAt", "model", "effort", "agent", "agentKind", "nativeAgentSelected", "profileId", "saneContextVersion", "harness", "nativeSessionId", "nativeCommandId", "operation", "compact", "nativeConnection", "nativeReason"] as const satisfies readonly (keyof TranscriptRunMetadata)[];
export function sameRunMetadata(previous: Run, next: TranscriptRunMetadata): boolean {
  return metadataFields.every(key => Object.hasOwn(previous, key) === Object.hasOwn(next, key) && equalValue(previous[key], next[key]));
}

/** Plain API projections only; never traverse retained message/reducer logs. */
export function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left), other = Object.keys(right);
  return keys.length === other.length && keys.every(key => Object.hasOwn(right, key) && equalValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Capacity is separate catalog evidence for OC, never a fabricated denominator. */
export function pagedUsage(pages: PagedTranscript | null | undefined, harness: Harness, models: ModelChoice[]): ContextUsageSnapshot | null {
  const usage = pages?.summary.usage;
  if (!usage) return null;
  const capacity = harness === "opencode" ? models.find(model => model.id === usage.model)?.contextWindow : usage.capacity;
  if (!capacity || !Number.isFinite(capacity) || capacity <= 0) return null;
  return { tokens: usage.tokens, model: usage.model, time: usage.time, capacity, percentage: usage.tokens / capacity * 100, ...(usage.stale ? { stale: true } : {}) };
}
