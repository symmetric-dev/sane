/** Authenticated, read-only unified transcript API. GET may observe live native
 * OpenCode history, but never persists reconciliation or executes native work.
 * Listing + compactState remain execution/availability authority.
 *
 * GET /api/sessions/:id/transcript?limit=50[&cursor=...]
 *   Latest by default; messages are ALWAYS chronological. limit 1..100 is soft:
 *   finish the boundary turn when possible, at most 100 complete messages.
 *   The 512 KiB response budget is soft for message content: select fewer whole
 *   messages, reserving space for response metadata. A single message exceeding
 *   that budget is returned in full, alone, rather than blocking progress.
 *   Identity, cursor, and metadata budgets remain hard. Latest/older pages keep
 *   the newest side; newer pages keep the oldest side; targets are always whole.
 *   A turn larger than either budget is segmented at stable message boundaries;
 *   continuation says whether the first/last turn extends outside this page.
 *   coverage.firstIndex/lastIndex are inclusive zero-based canonical ordinals
 *   for this exact page slice; both are null when empty. totalMessages is the
 *   full canonical count at this response, not the number loaded by the client.
 *   Compare ranges only within the same session/epoch: indices survive tail
 *   appends and in-place UPSERTs; insert/delete/reorder changes reset the epoch.
 *   Use these ranges to order coverage islands and expose gaps without native
 *   timestamps or interpreting opaque cursors. totalMessages may grow within
 *   the same epoch, so a prior response's count is only its observation.
 * GET .../transcript?targetMessageId=... OR targetRunId=...[&toolCallId=...]
 *   Jump around an original send, matching canonical IDs, native aliases, or
 *   toolCallId (including imported CC tools). Worker records provide parent
 *   runId/toolCallId; handoff projections provide their original tool/message
 *   anchor. Both cursors are returned: a jump MUST remain a distinct coverage
 *   island until gaps are filled, not be blindly concatenated with the tail.
 * GET .../transcript?targetKind=worker|handoff&targetId=...
 *   Resolves original send using durable worker parent identity or the existing
 *   handoff tool-envelope matcher. No native-history download is required.
 *   Target messages include every recorded part and full tool input/output.
 *
 * Revisions are process-local opaque values; compare for equality only. epoch
 * changes on history replacement, identity change, or non-tail structural edits.
 * Cursors are signed, session/identity/epoch scoped. 409 transcript-reset means
 * discard coverage/cursors and reopen latest (or explicitly repeat the target).
 * Plain tail append and in-place UPSERTs do not invalidate page cursors.
 * Restarted-generation cursors can only cause a reset, never be accepted.
 * Same-session authenticated identity changes also reset; cross-session,
 * malformed, and forged current-generation cursors remain rejected (400).
 *
 * POST .../transcript/refresh { epoch, messages: [{id,version}, ...] }
 *   Read-only, at most 100 IDs, returning only changed full UPSERT envelopes and
 *   removed IDs. The same soft message-content budget applies: one oversized
 *   UPSERT can be returned in full, alone. Nonempty requests process at least
 *   one entry. If budget is reached, processed < messages.length: repeat with
 *   the unprocessed suffix. On revision change refresh EVERY loaded coverage
 *   island in batches, not just latest, so off-window tool updates cannot stale.
 *   Versions describe the complete recorded message, never a partial payload.
 *
 * GET .../transcript/meta[?limit=100&cursor=...]
 *   Independent lightweight ALL run metadata and compaction placements, paged
 *   together as discriminated items. No logs or reducer state. Drain nextCursor
 *   for all metadata, restart traversal if metadataRevision changes (409).
 *   Message-only streaming updates do not invalidate metadata traversal.
 *   Run items include bounded nativeConnection/nativeReason warnings from the
 *   materialized reducer; warning changes invalidate metadataRevision. Empty
 *   strings explicitly clear warnings so existing metadata merges cannot stale.
 *   Compaction payload excludes large summary/instructions/nativeMetadata;
 *   existing compactState remains the detailed lifecycle authority.
 *
 * Messages always contain the full recorded text, reasoning, and tool payloads.
 * Lazy loading applies to older messages, never to parts of a message.
 */
import type { Message, RunMetadata } from "../shared/conversation/types";
import type { CompactionRecord } from "../shared/conversation/native-contract";

export type TranscriptMessage = Message & {
  version: string;
};
export type TranscriptUsage = {
  tokens: number; model: string; time: string; stale?: boolean;
  /** CC: authoritative log capacity. OC: resolve model via separate catalog. */
  capacity?: number; percentage?: number;
};
export type TranscriptSummary = {
  sessionId: string; revision: string; epoch: string;
  usage: TranscriptUsage | null; nativeHistoryImportedAt?: string;
};
export type TranscriptSendAnchor = { kind: "worker"; runId: string; toolCallId: string } | { kind: "handoff"; presentation: import("./handoff-contract").HandoffPresentation };
export type TranscriptPage = TranscriptSummary & {
  messages: TranscriptMessage[];
  coverage: {
    firstId: string | null; lastId: string | null;
    firstIndex: number | null; lastIndex: number | null; totalMessages: number;
    olderCursor: string | null; newerCursor: string | null;
  };
  continuation: { older: boolean; newer: boolean };
  target?: { messageId: string; toolCallId?: string };
};
export type TranscriptRefreshRequest = { epoch: string; messages: { id: string; version: string }[] };
export type TranscriptRefresh = TranscriptSummary & { upserts: TranscriptMessage[]; removedIds: string[]; processed: number };
export type TranscriptCompaction = Pick<CompactionRecord, "id" | "sessionId" | "harness" | "runId" | "nativeId" | "requestId" | "nativeRequestId" | "nativeAdmittedId" | "trigger" | "lifecycle" | "contextReset" | "startedAt" | "endedAt" | "requestedAt" | "observedAt" | "preTokens" | "postTokens" | "durationMs"> & {
  /** before-message may be off-window: never move that marker to the latest tail. */
  placement: { kind: "before-message"; messageId: string } | { kind: "tail" } | { kind: "unplaced" };
};
export type TranscriptRunMetadata = RunMetadata & {
  /** UTF-8 <=64 bytes; empty string clears a previous connection warning. */
  nativeConnection?: string;
  /** UTF-8 <=2048 bytes; empty string clears a previous status detail. */
  nativeReason?: string;
};
export type TranscriptMetadataItem = { kind: "run"; run: TranscriptRunMetadata } | { kind: "compaction"; compaction: TranscriptCompaction };
export type TranscriptMetadataPage = TranscriptSummary & { metadataRevision: string; items: TranscriptMetadataItem[]; nextCursor: string | null };
export const TRANSCRIPT_MAX_MESSAGES = 100;
/** Soft for complete message content, hard for identity and metadata. */
export const TRANSCRIPT_PAGE_BYTES = 512 * 1024;
