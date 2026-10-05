import type { Harness } from "./harness-capabilities";

/** Authenticated parent-attention metadata only: never transcript bodies or tool output. */
export const CONVERSATION_UPDATE_MAX_PAGE = 100;
/** Hard UTF-8 budget for the entire response, including bootstrap and coverage. */
export const CONVERSATION_UPDATE_MAX_BYTES = 256 * 1024;

export type ConversationUpdateSource = {
  harness: Harness;
  authorityId: string;
  nativeSessionId: string;
  incarnation?: string;
};
export type ConversationUpdateKind = "reply" | "failed" | "interrupted";
export type ConversationUpdate = {
  id: string;
  /** Durable transport change order, including revisions to existing occurrences. */
  sequence: number;
  /** Immutable order assigned on FIRST observation; revisions never move attention. */
  occurrenceSequence: number;
  revision: number;
  conversationId: string;
  source: ConversationUpdateSource;
  kind: ConversationUpdateKind;
  /** Authoritative native timestamp only; null when the source supplies none. */
  occurredAt: string | null;
  observedAt: string;
  runId?: string;
  nativeBoundaryId?: string;
  messageId?: string;
  historical?: boolean;
  sourceSequence?: number;
  /** Only an evidenced EXACT one-to-one legacy run alias, never inferred from runId.
   * Producers must ensure uniqueness across occurrences; a page cannot prove it. */
  legacyRunId?: string;
};
export type ConversationUpdateCandidate = Omit<ConversationUpdate, "sequence" | "occurrenceSequence" | "revision" | "observedAt"> & {
  observedAt?: string;
};
export type ConversationUpdateCoverage = {
  sourceKey: string;
  state: "ready" | "initializing" | "unavailable" | "unqualified" | "degraded";
  reason?: string;
  baselineThrough?: number;
  through?: number;
};
/** Plain bounded parameters, scoped to the authenticated store's durable epoch. */
export type ConversationUpdateCursor = { epoch: string; after: number };
export type ConversationUpdateFeedRequest = {
  cursor?: ConversationUpdateCursor;
  through?: number;
  limit?: number;
};
export type ConversationUpdateBootstrap = {
  activeRunIds: string[];
  sourceBaselines: { sourceKey: string; through: number }[];
};
export type ConversationUpdatePage = {
  storeId: string;
  epoch: string;
  /** Exclusive retention floor. A cursor below it requires a fresh bootstrap. */
  retainedAfter: number;
  /** Fixed upper bound for this traversal, not the current moving store head. */
  through: number;
  nextCursor: ConversationUpdateCursor;
  hasMore: boolean;
  updates: ConversationUpdate[];
  coverage: ConversationUpdateCoverage[];
  /** Bootstrap returns the first bounded page; drain remaining pages with the
   * same through and nextCursor. Snapshot metadata is not repeated on feed pages. */
  bootstrap?: ConversationUpdateBootstrap;
};
export type ConversationUpdateFeedResponse = ConversationUpdatePage;
export type ConversationUpdateError = { error: string; reason?: string };
/** Optional expectations bind validation to the request/store the caller used. */
export type ConversationUpdatePageExpectations = {
  storeId?: string;
  epoch?: string;
  cursor?: ConversationUpdateCursor;
  through?: number;
  limit?: number;
};

const ID_BYTES = 1024, KEY_BYTES = 16 * 1024, REASON_BYTES = 2048;
const encoder = new TextEncoder();
type ObjectValue = Record<string, unknown>;

function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function keys(value: ObjectValue, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function text(value: unknown, max = ID_BYTES): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
    && encoder.encode(value).byteLength <= max;
}
function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function optional(value: ObjectValue, key: string, validate: (field: unknown) => boolean): boolean {
  return value[key] === undefined || validate(value[key]);
}
/** RFC 3339, with a real calendar date and explicit zone; no Date.parse rollover. */
function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return false;
  const zone = /[+-](\d{2}):(\d{2})$/.exec(value);
  return (!zone || Number(zone[1]) <= 23 && Number(zone[2]) <= 59) && Number.isFinite(Date.parse(value));
}
function boundedJson(value: unknown): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && json.length <= CONVERSATION_UPDATE_MAX_BYTES
      && encoder.encode(json).byteLength <= CONVERSATION_UPDATE_MAX_BYTES;
  } catch { return false; }
}

export function isConversationUpdateSource(value: unknown): value is ConversationUpdateSource {
  return object(value) && keys(value, ["harness", "authorityId", "nativeSessionId", "incarnation"])
    && (value.harness === "claude-code" || value.harness === "opencode")
    && text(value.authorityId) && text(value.nativeSessionId) && optional(value, "incarnation", text);
}

/** Canonical tuple, not delimiter concatenation or a process-local hash. */
export function updateSourceKey(source: ConversationUpdateSource): string {
  if (!isConversationUpdateSource(source)) throw new TypeError("Invalid conversation update source");
  return JSON.stringify([source.harness, source.authorityId, source.nativeSessionId, source.incarnation ?? null]);
}
/** Boundary identity must be authoritative and stable on replay, not its time,
 * kind, revision, message body, or an invented count of terminal messages. */
export function updateOccurrenceId(source: ConversationUpdateSource, boundaryId: string): string {
  if (!text(boundaryId)) throw new TypeError("Invalid conversation update boundary identity");
  return JSON.stringify([updateSourceKey(source), boundaryId]);
}

function sourceKey(value: unknown): value is string {
  if (!text(value, KEY_BYTES)) return false;
  try {
    const tuple: unknown = JSON.parse(value);
    if (!Array.isArray(tuple) || tuple.length !== 4) return false;
    const source = { harness: tuple[0], authorityId: tuple[1], nativeSessionId: tuple[2],
      ...(tuple[3] === null ? {} : { incarnation: tuple[3] }) };
    return isConversationUpdateSource(source) && updateSourceKey(source) === value;
  } catch { return false; }
}

function occurrenceId(value: unknown, source: ConversationUpdateSource): boolean {
  if (!text(value, KEY_BYTES)) return false;
  try {
    const tuple: unknown = JSON.parse(value);
    return Array.isArray(tuple) && tuple.length === 2 && text(tuple[1])
      && tuple[0] === updateSourceKey(source) && updateOccurrenceId(source, tuple[1]) === value;
  } catch { return false; }
}

const candidateKeys = ["id", "conversationId", "source", "kind", "occurredAt", "observedAt", "runId",
  "nativeBoundaryId", "messageId", "historical", "sourceSequence", "legacyRunId"];
function candidateFields(value: ObjectValue): boolean {
  return text(value.conversationId) && isConversationUpdateSource(value.source) && occurrenceId(value.id, value.source)
    && (value.kind === "reply" || value.kind === "failed" || value.kind === "interrupted")
    && (value.occurredAt === null || timestamp(value.occurredAt))
    && optional(value, "observedAt", timestamp)
    && ["runId", "nativeBoundaryId", "messageId", "legacyRunId"].every(key => optional(value, key, text))
    && optional(value, "historical", field => typeof field === "boolean")
    && optional(value, "sourceSequence", integer);
}
export function isConversationUpdateCandidate(value: unknown): value is ConversationUpdateCandidate {
  return object(value) && keys(value, candidateKeys) && candidateFields(value);
}
export function isConversationUpdate(value: unknown): value is ConversationUpdate {
  return object(value) && keys(value, [...candidateKeys, "sequence", "occurrenceSequence", "revision"])
    && candidateFields(value) && timestamp(value.observedAt)
    && integer(value.sequence, 1) && integer(value.occurrenceSequence, 1) && integer(value.revision, 1)
    && value.occurrenceSequence <= value.sequence;
}
export function isConversationUpdateCursor(value: unknown): value is ConversationUpdateCursor {
  return object(value) && keys(value, ["epoch", "after"]) && text(value.epoch) && integer(value.after);
}
export function isConversationUpdateFeedRequest(value: unknown): value is ConversationUpdateFeedRequest {
  return object(value) && keys(value, ["cursor", "through", "limit"])
    && optional(value, "cursor", isConversationUpdateCursor) && optional(value, "through", integer)
    && optional(value, "limit", field => integer(field, 1) && field <= CONVERSATION_UPDATE_MAX_PAGE)
    && (value.through === undefined || value.cursor === undefined
      || (value.cursor as ConversationUpdateCursor).after <= (value.through as number));
}
export function isConversationUpdateCoverage(value: unknown): value is ConversationUpdateCoverage {
  return object(value) && keys(value, ["sourceKey", "state", "reason", "baselineThrough", "through"])
    && sourceKey(value.sourceKey)
    && ["ready", "initializing", "unavailable", "unqualified", "degraded"].includes(value.state as string)
    && optional(value, "reason", field => text(field, REASON_BYTES))
    && optional(value, "baselineThrough", integer) && optional(value, "through", integer)
    && (value.baselineThrough === undefined || value.through === undefined
      || (value.baselineThrough as number) <= (value.through as number));
}
export function isConversationUpdateBootstrap(value: unknown): value is ConversationUpdateBootstrap {
  if (!object(value) || !keys(value, ["activeRunIds", "sourceBaselines"])
    || !Array.isArray(value.activeRunIds) || value.activeRunIds.length > CONVERSATION_UPDATE_MAX_BYTES
    || !Array.isArray(value.sourceBaselines) || value.sourceBaselines.length > CONVERSATION_UPDATE_MAX_BYTES) return false;
  const runs = new Set<string>();
  for (const id of value.activeRunIds) {
    if (!text(id) || runs.has(id)) return false;
    runs.add(id);
  }
  const sources = new Set<string>();
  for (const baseline of value.sourceBaselines) {
    if (!object(baseline) || !keys(baseline, ["sourceKey", "through"])
      || !sourceKey(baseline.sourceKey) || !integer(baseline.through) || sources.has(baseline.sourceKey)) return false;
    sources.add(baseline.sourceKey);
  }
  return boundedJson(value);
}

/** Validates wire shape and ordering, not native qualification or alias evidence.
 * Coverage/source baselines use SOURCE order, not the transport through counter.
 * nextCursor.after is the scanned transport position (may skip compacted changes). */
export function isConversationUpdatePage(value: unknown, expected: ConversationUpdatePageExpectations = {}): value is ConversationUpdatePage {
  if (!object(value) || !keys(value, ["storeId", "epoch", "retainedAfter", "through", "nextCursor",
    "hasMore", "updates", "coverage", "bootstrap"])
    || !text(value.storeId) || !text(value.epoch) || !integer(value.retainedAfter) || !integer(value.through)
    || value.retainedAfter > value.through || !isConversationUpdateCursor(value.nextCursor)
    || value.nextCursor.epoch !== value.epoch || value.nextCursor.after < value.retainedAfter
    || value.nextCursor.after > value.through || typeof value.hasMore !== "boolean"
    || value.hasMore !== (value.nextCursor.after < value.through)
    || !Array.isArray(value.updates) || value.updates.length > CONVERSATION_UPDATE_MAX_PAGE
    || !Array.isArray(value.coverage) || value.coverage.length > CONVERSATION_UPDATE_MAX_BYTES
    || !optional(value, "bootstrap", isConversationUpdateBootstrap)) return false;

  if (expected.storeId !== undefined && (!text(expected.storeId) || expected.storeId !== value.storeId)
    || expected.epoch !== undefined && (!text(expected.epoch) || expected.epoch !== value.epoch)
    || expected.through !== undefined && (!integer(expected.through) || expected.through !== value.through)
    || expected.limit !== undefined && (!integer(expected.limit, 1) || expected.limit > CONVERSATION_UPDATE_MAX_PAGE
      || value.updates.length > expected.limit)) return false;
  let after = value.retainedAfter;
  if (expected.cursor !== undefined) {
    if (!isConversationUpdateCursor(expected.cursor) || expected.cursor.epoch !== value.epoch
      || expected.cursor.after < value.retainedAfter || expected.cursor.after > value.through
      || value.nextCursor.after < expected.cursor.after) return false;
    after = expected.cursor.after;
  }
  if (value.hasMore && value.nextCursor.after <= after) return false;
  const aliases = new Map<string, string>();
  const occurrences = new Map<string, ConversationUpdate>();
  const boundaries = new Map<string, string>();
  for (const update of value.updates) {
    if (!isConversationUpdate(update) || update.sequence <= after || update.sequence > value.nextCursor.after) return false;
    const previous = occurrences.get(update.id);
    if (previous && (previous.occurrenceSequence !== update.occurrenceSequence || previous.revision >= update.revision
      || previous.conversationId !== update.conversationId || updateSourceKey(previous.source) !== updateSourceKey(update.source))) return false;
    if (update.nativeBoundaryId !== undefined) {
      const boundary = boundaries.get(update.id);
      if (boundary !== undefined && boundary !== update.nativeBoundaryId) return false;
      boundaries.set(update.id, update.nativeBoundaryId);
    }
    occurrences.set(update.id, update);
    if (update.legacyRunId !== undefined) {
      // Multiple revisions of the same occurrence are legitimate in a change feed.
      const id = aliases.get(update.legacyRunId);
      if (id !== undefined && id !== update.id) return false;
      aliases.set(update.legacyRunId, update.id);
    }
    after = update.sequence;
  }
  const sources = new Set<string>();
  for (const coverage of value.coverage) {
    if (!isConversationUpdateCoverage(coverage) || sources.has(coverage.sourceKey)) return false;
    sources.add(coverage.sourceKey);
  }
  return boundedJson(value);
}
export function isConversationUpdateError(value: unknown): value is ConversationUpdateError {
  return object(value) && keys(value, ["error", "reason"]) && text(value.error, REASON_BYTES)
    && optional(value, "reason", field => text(field, REASON_BYTES));
}
