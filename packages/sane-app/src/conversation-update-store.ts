import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicAppRecord } from "./app-store";
import {
  CONVERSATION_UPDATE_MAX_BYTES, CONVERSATION_UPDATE_MAX_PAGE,
  isConversationUpdate, isConversationUpdateBootstrap, isConversationUpdateCandidate,
  isConversationUpdateCoverage, isConversationUpdateFeedRequest, isConversationUpdatePage,
  updateSourceKey,
  type ConversationUpdate, type ConversationUpdateBootstrap, type ConversationUpdateCandidate,
  type ConversationUpdateCoverage, type ConversationUpdateFeedRequest, type ConversationUpdatePage,
} from "../shared/conversation/conversation-updates";

export const CONVERSATION_UPDATE_MAX_ROWS = 8192;
export const CONVERSATION_UPDATE_STORE_BYTES = 16 * 1024 * 1024;
const STATE_BYTES = 256 * 1024;
const encoder = new TextEncoder();
export type UpdateJson = null | boolean | number | string | UpdateJson[] | { [key: string]: UpdateJson };
/** Live cancellation/registration evidence; never cloned or persisted with a transaction. */
export type ConversationUpdateCommitGuard = {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  /** Compare against committed source progress inside the serial store transaction. */
  expectedCheckpoint?: { key: string; through: number | null };
};
/** Native identities require a matching native checkpoint in the same transaction. */
export type ConversationUpdateCommitExtras = { nativeMessages?: { sourceKey: string; ids: readonly string[] } };
export function isConversationUpdateCommitCurrent(guard?: ConversationUpdateCommitGuard): boolean {
  try {
    if (guard === undefined) return true;
    if (!guard || typeof guard !== "object" || Array.isArray(guard)) return false;
    const { signal, isCurrent, expectedCheckpoint } = guard;
    // Structural evidence permits real signals from another realm without
    // accepting arbitrary truthy objects as cancellation protection.
    const validSignal = () => signal === undefined || !!signal && typeof signal === "object" && !Array.isArray(signal)
      && typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function" && typeof signal.removeEventListener === "function";
    if (!validSignal() || isCurrent !== undefined && typeof isCurrent !== "function"
      || expectedCheckpoint !== undefined && !isConversationUpdateExpectedCheckpoint(expectedCheckpoint)) return false;
    if (signal?.aborted || isCurrent !== undefined && !isCurrent.call(guard)) return false;
    return validSignal() && !signal?.aborted;
  }
  catch { return false; }
}
/** Keys must include the qualified source, e.g. JSON.stringify(["app-run", sourceKey, runId]).
 * Checkpoints are NOT retained-row caches: never discard them when pruning rows. */
export type ConversationUpdateCheckpoint = {
  key: string;
  sourceKey: string;
  through: number;
  baselineThrough?: number;
  state?: UpdateJson;
  coverage?: ConversationUpdateCoverage;
};
type RecordValue = {
  version: 1;
  storeId: string;
  epoch: string;
  head: number;
  retainedAfter: number;
  rows: ConversationUpdate[];
  checkpoints: ConversationUpdateCheckpoint[];
  /** Exact identities outlive retained feed rows; never reducer-state tombstones. */
  nativeMessages?: { sourceKey: string; ids: string[] }[];
};
export type ConversationUpdateHealth = { state: "initializing" | "ready" | "unavailable"; reason?: string };
export class ConversationUpdateServiceError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "ConversationUpdateServiceError"; }
  toJSON() { return { error: this.code, reason: this.message }; }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && encoder.encode(value).byteLength <= 16 * 1024
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function checkpointSourceKey(value: unknown): string | undefined {
  if (!text(value)) return undefined;
  try {
    const key: unknown = JSON.parse(value);
    return Array.isArray(key) && key.length >= 2 && key.length <= 4 && key.every(text)
      && isConversationUpdateCoverage({ sourceKey: key[1], state: "ready" }) && JSON.stringify(key) === value ? key[1] : undefined;
  } catch { return undefined; }
}
export function isConversationUpdateExpectedCheckpoint(value: unknown): value is NonNullable<ConversationUpdateCommitGuard["expectedCheckpoint"]> {
  try {
    return object(value) && exact(value, ["key", "through"]) && checkpointSourceKey(value.key) !== undefined
      && (value.through === null || integer(value.through));
  } catch { return false; }
}
function bytes(value: unknown) { return encoder.encode(JSON.stringify(value)).byteLength; }
function json(value: unknown, depth = 0): value is UpdateJson {
  if (depth > 32) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => json(item, depth + 1));
  return object(value) && Object.values(value).every(item => json(item, depth + 1));
}
export function isConversationUpdateCheckpoint(value: unknown): value is ConversationUpdateCheckpoint {
  if (!object(value) || !exact(value, ["key", "sourceKey", "through", "baselineThrough", "state", "coverage"])
    || !text(value.key) || !text(value.sourceKey) || !integer(value.through)
    || !isConversationUpdateCoverage({ sourceKey: value.sourceKey, state: "ready" })
    || value.baselineThrough !== undefined && (!integer(value.baselineThrough) || value.baselineThrough > value.through)
    || value.state !== undefined && (!json(value.state) || bytes(value.state) > STATE_BYTES)
    || value.coverage !== undefined && (!isConversationUpdateCoverage(value.coverage) || value.coverage.sourceKey !== value.sourceKey
       || value.coverage.through !== undefined && value.coverage.through > value.through
       || value.baselineThrough !== undefined && (value.coverage.through === undefined || value.baselineThrough > value.coverage.through)
       || value.coverage.baselineThrough !== undefined && (value.coverage.baselineThrough !== value.baselineThrough
         || value.coverage.through === undefined))) return false;
  return checkpointSourceKey(value.key) === value.sourceKey;
}
function validRecord(value: unknown, storeId: string): value is RecordValue {
  if (!object(value) || !exact(value, ["version", "storeId", "epoch", "head", "retainedAfter", "rows", "checkpoints", "nativeMessages"])
    || value.version !== 1 || value.storeId !== storeId || !text(value.storeId) || !text(value.epoch)
    || encoder.encode(value.storeId).byteLength > 1024 || encoder.encode(value.epoch).byteLength > 1024
    || !integer(value.head) || !integer(value.retainedAfter) || value.retainedAfter > value.head
    || !Array.isArray(value.rows) || value.rows.length > CONVERSATION_UPDATE_MAX_ROWS
    || !Array.isArray(value.checkpoints) || bytes(value) > CONVERSATION_UPDATE_STORE_BYTES) return false;
  let sequence = value.retainedAfter;
  const latest = new Map<string, ConversationUpdate>(), aliases = new Map<string, string>();
  const boundaries = new Map<string, string>();
  for (const row of value.rows) {
    if (!isConversationUpdate(row) || row.sequence <= sequence || row.sequence > value.head) return false;
    const prior = latest.get(row.id);
    if (prior && (prior.occurrenceSequence !== row.occurrenceSequence || prior.revision >= row.revision
      || prior.conversationId !== row.conversationId || updateSourceKey(prior.source) !== updateSourceKey(row.source))) return false;
    if (row.nativeBoundaryId !== undefined) {
      const boundary = boundaries.get(row.id);
      if (boundary !== undefined && boundary !== row.nativeBoundaryId) return false;
      boundaries.set(row.id, row.nativeBoundaryId);
    }
    if (row.legacyRunId) {
      if (aliases.has(row.legacyRunId) && aliases.get(row.legacyRunId) !== row.id) return false;
      aliases.set(row.legacyRunId, row.id);
    }
    latest.set(row.id, row); sequence = row.sequence;
  }
  const keys = new Set<string>();
  for (const checkpoint of value.checkpoints) {
    if (!isConversationUpdateCheckpoint(checkpoint) || keys.has(checkpoint.key)) return false;
    keys.add(checkpoint.key);
  }
  if (value.nativeMessages !== undefined) {
    if (!Array.isArray(value.nativeMessages)) return false;
    const sources = new Set<string>();
    for (const messages of value.nativeMessages) {
      if (!isNativeMessages(messages) || sources.has(messages.sourceKey)) return false;
      sources.add(messages.sourceKey);
    }
  }
  return true;
}
function isNativeMessages(value: unknown): value is { sourceKey: string; ids: string[] } {
  if (!object(value) || !exact(value, ["sourceKey", "ids"])
    || !isConversationUpdateCoverage({ sourceKey: value.sourceKey, state: "ready" })
    || !Array.isArray(value.ids) || value.ids.length > CONVERSATION_UPDATE_STORE_BYTES) return false;
  const ids = new Set<string>();
  for (const id of value.ids) {
    if (!text(id) || ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}
function candidateOf(row: ConversationUpdate): ConversationUpdateCandidate {
  const { sequence: _sequence, occurrenceSequence: _occurrence, revision: _revision, observedAt: _observed, ...candidate } = row;
  return candidate;
}
function sameCandidate(a: ConversationUpdateCandidate, b: ConversationUpdateCandidate) {
  const { observedAt: _a, ...left } = a, { observedAt: _b, ...right } = b;
  // Property order is not semantic; all nested metadata is the canonical source tuple.
  return Object.keys({ ...left, ...right }).every(key => key === "source"
    ? updateSourceKey(left.source) === updateSourceKey(right.source)
    : left[key as keyof typeof left] === right[key as keyof typeof right]);
}

/** Optional derived feed. Its queue and all failures are isolated from the primary journal. */
export class ConversationUpdateStore {
  private record?: RecordValue;
  private health: ConversationUpdateHealth = { state: "initializing" };
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing = false;
  constructor(private readonly dataDir: string, readonly storeId: string,
    private readonly options: { save?: typeof atomicAppRecord; now?: () => string } = {}) {}

  /** ENOENT alone creates an epoch. Invalid or unsafe existing files are never overwritten. */
  load(): boolean {
    if (this.closed || this.closing) return false;
    if (this.record && this.health.state === "ready") return true;
    try {
      let record: unknown;
      try {
        const path = join(this.dataDir, "conversation-updates.json"), stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > CONVERSATION_UPDATE_STORE_BYTES) throw new Error("Unsafe conversation update record");
        record = JSON.parse(readFileSync(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.record) throw error;
        record = { version: 1, storeId: this.storeId, epoch: randomUUID(), head: 0, retainedAfter: 0, rows: [], checkpoints: [] };
        if (!validRecord(record, this.storeId)) throw new Error("Invalid conversation update store identity");
        (this.options.save ?? atomicAppRecord)(this.dataDir, "conversation-updates.json", record);
      }
      if (!validRecord(record, this.storeId)) throw new Error("Corrupt conversation-updates.json; operator reconciliation required");
      this.record = record; this.health = { state: "ready" }; return true;
    } catch { this.health = { state: "unavailable", reason: "Conversation update storage requires reconciliation" }; return false; }
  }
  getHealth(): ConversationUpdateHealth { return { ...this.health }; }
  getHead() {
    if (!this.record || this.health.state !== "ready") return undefined;
    const { storeId, epoch, retainedAfter, head: through } = this.record;
    return { storeId, epoch, retainedAfter, through };
  }
  getCheckpoint(key: string): ConversationUpdateCheckpoint | undefined {
    const found = this.record?.checkpoints.find(checkpoint => checkpoint.key === key);
    return found && structuredClone(found);
  }
  getCheckpoints(): ConversationUpdateCheckpoint[] { return structuredClone(this.record?.checkpoints ?? []); }
  hasNativeMessage(sourceKey: string, messageId: string): boolean {
    return this.record?.nativeMessages?.find(messages => messages.sourceKey === sourceKey)?.ids.includes(messageId) ?? false;
  }
  private commitGuardCurrent(guard?: ConversationUpdateCommitGuard, checkpoint?: ConversationUpdateCheckpoint,
    candidates: readonly ConversationUpdateCandidate[] = [], extras?: ConversationUpdateCommitExtras): boolean {
    if (!isConversationUpdateCommitCurrent(guard)) return false;
    try {
      const expected = guard?.expectedCheckpoint;
      if (expected === undefined) return true;
      if (!isConversationUpdateExpectedCheckpoint(expected)) return false;
      const sourceKey = checkpointSourceKey(expected.key);
      return (!checkpoint || expected.key === checkpoint.key)
        && (checkpoint !== undefined || candidates.every(candidate => updateSourceKey(candidate.source) === sourceKey))
        && (!extras?.nativeMessages || extras.nativeMessages.sourceKey === sourceKey)
        && (this.record?.checkpoints.find(checkpoint => checkpoint.key === expected.key)?.through ?? null) === expected.through;
    } catch { return false; }
  }
  getUpdate(id: string): ConversationUpdate | undefined {
    const row = this.record?.rows.findLast(row => row.id === id);
    return row && structuredClone(row);
  }
  getCoverage(): ConversationUpdateCoverage[] {
    const sources = new Map<string, ConversationUpdateCoverage>();
    for (const checkpoint of this.record?.checkpoints ?? []) {
      const native = JSON.parse(checkpoint.key)[0] === "native";
      const coverage = checkpoint.coverage ?? { sourceKey: checkpoint.sourceKey, state: "ready" as const,
        ...(native ? { through: checkpoint.through } : {}),
        ...(native && checkpoint.baselineThrough !== undefined ? { baselineThrough: checkpoint.baselineThrough } : {}) };
      const prior = sources.get(coverage.sourceKey);
      // Explicit native checkpoints outrank App-run progress (different sequence domains).
      if (!prior || JSON.parse(checkpoint.key)[0] === "native") sources.set(coverage.sourceKey, structuredClone(coverage));
    }
    if (this.health.state !== "ready") for (const coverage of sources.values()) {
      coverage.state = "unavailable"; coverage.reason = this.health.reason ?? "Conversation update storage is initializing";
    }
    return [...sources.values()];
  }
  /** Atomic rows + reducer state + source progress. False means no usable publication;
   * on ambiguous I/O failure stop, rather than overwrite possibly committed disk state.
   * Guard rejection leaves committed state and health untouched. Once synchronous
   * persistence succeeds, later cancellation cannot undo it or change the result. */
  commitCandidates(candidates: readonly ConversationUpdateCandidate[], checkpoint?: ConversationUpdateCheckpoint,
    guard?: ConversationUpdateCommitGuard, extras?: ConversationUpdateCommitExtras): Promise<boolean> {
    if (this.closed || this.closing || !isConversationUpdateCommitCurrent(guard)) return Promise.resolve(false);
    let captured: ConversationUpdateCandidate[], capturedCheckpoint: ConversationUpdateCheckpoint | undefined,
      capturedExtras: ConversationUpdateCommitExtras | undefined;
    try {
      captured = structuredClone([...candidates]); capturedCheckpoint = checkpoint && structuredClone(checkpoint);
      capturedExtras = extras && structuredClone(extras);
    }
    catch { return Promise.resolve(false); }
    const task = this.queue.then(() => {
      if (this.closed || !this.commitGuardCurrent(guard, capturedCheckpoint, captured, capturedExtras) || this.health.state !== "ready" || !this.record) return false;
      let persistenceStarted = false;
      try {
        if (!captured.every(isConversationUpdateCandidate) || capturedCheckpoint && !isConversationUpdateCheckpoint(capturedCheckpoint)) throw new Error("Invalid update transaction");
        if (capturedExtras && (!object(capturedExtras) || !exact(capturedExtras, ["nativeMessages"])
           || capturedExtras.nativeMessages !== undefined && (!isNativeMessages(capturedExtras.nativeMessages)
             || !capturedCheckpoint || JSON.parse(capturedCheckpoint.key)[0] !== "native"
             || capturedExtras.nativeMessages.sourceKey !== capturedCheckpoint.sourceKey))) throw new Error("Invalid native message identities");
        const next = structuredClone(this.record);
        const priorCheckpoint = capturedCheckpoint && next.checkpoints.find(value => value.key === capturedCheckpoint.key);
        if (capturedCheckpoint && priorCheckpoint && (capturedCheckpoint.sourceKey !== priorCheckpoint.sourceKey
          || capturedCheckpoint.through < priorCheckpoint.through
          || priorCheckpoint.baselineThrough !== undefined && capturedCheckpoint.baselineThrough !== priorCheckpoint.baselineThrough)) throw new Error("Checkpoint regression");
        const latest = new Map(next.rows.map(row => [row.id, row]));
        const boundaries = new Map(next.rows.flatMap(row => row.nativeBoundaryId === undefined ? [] : [[row.id, row.nativeBoundaryId] as const]));
        for (let candidate of captured) {
          const prior = latest.get(candidate.id);
          const boundary = boundaries.get(candidate.id);
          if (boundary !== undefined && candidate.nativeBoundaryId !== undefined && candidate.nativeBoundaryId !== boundary) throw new Error("Occurrence native boundary changed");
          // Omission is not retraction of established authoritative identity.
          if (boundary !== undefined && candidate.nativeBoundaryId === undefined) candidate = { ...candidate, nativeBoundaryId: boundary };
          if (capturedCheckpoint && updateSourceKey(candidate.source) !== capturedCheckpoint.sourceKey) throw new Error("Unqualified checkpoint");
          if (capturedCheckpoint && candidate.sourceSequence !== undefined && candidate.sourceSequence > capturedCheckpoint.through) throw new Error("Candidate exceeds its source checkpoint");
          if (capturedCheckpoint && JSON.parse(capturedCheckpoint.key)[0] === "native" && candidate.sourceSequence === undefined) throw new Error("Native occurrence needs a stable source position");
          if (!prior && candidate.sourceSequence !== undefined && priorCheckpoint && candidate.sourceSequence <= priorCheckpoint.through) continue;
          if (prior && prior.sourceSequence !== undefined && candidate.sourceSequence !== undefined && candidate.sourceSequence < prior.sourceSequence) continue;
          if (!prior && next.retainedAfter > 0 && !capturedCheckpoint) throw new Error("Retired occurrence needs a durable replay checkpoint");
          if (prior && (prior.conversationId !== candidate.conversationId || updateSourceKey(prior.source) !== updateSourceKey(candidate.source))) throw new Error("Occurrence identity changed");
          if (prior && sameCandidate(candidateOf(prior), candidate)) continue;
          if (!Number.isSafeInteger(next.head + 1)) throw new Error("Update sequence exhausted");
          const row: ConversationUpdate = { ...candidate, sequence: ++next.head,
            occurrenceSequence: prior?.occurrenceSequence ?? next.head, revision: (prior?.revision ?? 0) + 1,
            observedAt: candidate.observedAt ?? (this.options.now ?? (() => new Date().toISOString()))() };
          if (!isConversationUpdate(row)) throw new Error("Invalid update row");
          next.rows.push(row); latest.set(row.id, row);
          if (row.nativeBoundaryId !== undefined) boundaries.set(row.id, row.nativeBoundaryId);
        }
        if (capturedCheckpoint) {
          const index = next.checkpoints.findIndex(value => value.key === capturedCheckpoint.key);
          if (index < 0) next.checkpoints.push(capturedCheckpoint); else next.checkpoints[index] = capturedCheckpoint;
        }
        if (capturedExtras?.nativeMessages) {
          const { sourceKey, ids } = capturedExtras.nativeMessages;
          const ledger = next.nativeMessages ??= [];
          let messages = ledger.find(messages => messages.sourceKey === sourceKey);
          if (!messages) { messages = { sourceKey, ids: [] }; ledger.push(messages); }
          const known = new Set(messages.ids);
          for (const id of ids) if (!known.has(id)) { messages.ids.push(id); known.add(id); }
        }
        // Keep change versions so fixed-through traversals remain genuine snapshots.
        // Pruning advances an explicit floor; expired traversals must re-bootstrap.
        let size = bytes(next), removed = 0;
        while (removed < next.rows.length && (next.rows.length - removed > CONVERSATION_UPDATE_MAX_ROWS || size > CONVERSATION_UPDATE_STORE_BYTES)) {
          const row = next.rows[removed++]!;
          size -= bytes(row) + (next.rows.length - removed > 0 ? 1 : 0);
          size += String(row.sequence).length - String(next.retainedAfter).length;
          next.retainedAfter = row.sequence;
        }
        if (removed) next.rows = next.rows.slice(removed);
        if (!validRecord(next, this.storeId)) throw new Error("Update checkpoint capacity exhausted or invalid transaction");
        const changed = JSON.stringify(next) !== JSON.stringify(this.record);
        if (!this.commitGuardCurrent(guard, capturedCheckpoint, captured, capturedExtras)) return false;
        if (changed) {
          persistenceStarted = true;
          (this.options.save ?? atomicAppRecord)(this.dataDir, "conversation-updates.json", next);
        }
        this.record = next; return true;
      } catch {
        // Invalid source evidence/budget exhaustion rejects this batch, not the
        // healthy committed store. Only ambiguous persistence poisons its owner.
        if (persistenceStarted) this.health = { state: "unavailable", reason: "Conversation update commit failed; reconciliation required" };
        return false;
      }
    });
    this.queue = task.catch(() => undefined);
    return task.catch(() => false);
  }
  page(request: ConversationUpdateFeedRequest = {}, bootstrap: boolean | ConversationUpdateBootstrap = false,
    coverage: ConversationUpdateCoverage[] = this.getCoverage()): ConversationUpdatePage {
    if (this.health.state !== "ready" || !this.record) throw new ConversationUpdateServiceError("CONVERSATION_UPDATES_UNAVAILABLE", this.health.reason ?? "Conversation update storage is initializing");
    if (!isConversationUpdateFeedRequest(request)) throw new ConversationUpdateServiceError("INVALID_CONVERSATION_UPDATE_REQUEST", "Invalid feed request");
    const { record } = this;
    const through = request.through ?? record.head, after = request.cursor?.after ?? record.retainedAfter;
    if (request.cursor && request.cursor.epoch !== record.epoch || after < record.retainedAfter) throw new ConversationUpdateServiceError("CONVERSATION_UPDATE_CURSOR_EXPIRED", "Fresh bootstrap required");
    if (after > through || through > record.head || through < record.retainedAfter) throw new ConversationUpdateServiceError("INVALID_CONVERSATION_UPDATE_REQUEST", "Invalid feed snapshot bound");
    let snapshot: ConversationUpdateBootstrap | undefined;
    if (bootstrap) snapshot = bootstrap === true ? { activeRunIds: [], sourceBaselines: this.getCoverage().flatMap(item =>
      item.baselineThrough === undefined ? [] : [{ sourceKey: item.sourceKey, through: item.baselineThrough }]) } : structuredClone(bootstrap);
    if (snapshot && !isConversationUpdateBootstrap(snapshot)) throw new ConversationUpdateServiceError("CONVERSATION_UPDATES_UNAVAILABLE", "Invalid authoritative bootstrap");
    const page: ConversationUpdatePage = { storeId: record.storeId, epoch: record.epoch, retainedAfter: record.retainedAfter,
      through, nextCursor: { epoch: record.epoch, after }, hasMore: after < through,
      updates: [], coverage: structuredClone(coverage), ...(snapshot ? { bootstrap: snapshot } : {}) };
    if (bytes(page) > CONVERSATION_UPDATE_MAX_BYTES) throw new ConversationUpdateServiceError("CONVERSATION_UPDATES_UNAVAILABLE", "Feed metadata exceeds response budget");
    const rows = record.rows.filter(row => row.sequence > after && row.sequence <= through);
    for (const row of rows) {
      if (page.updates.length >= (request.limit ?? CONVERSATION_UPDATE_MAX_PAGE)) break;
      const previousAfter = page.nextCursor.after;
      page.updates.push(structuredClone(row)); page.nextCursor.after = row.sequence; page.hasMore = row.sequence < through;
      if (bytes(page) > CONVERSATION_UPDATE_MAX_BYTES) {
        page.updates.pop(); page.nextCursor.after = previousAfter; page.hasMore = previousAfter < through; break;
      }
    }
    if (page.updates.length === rows.length) { page.nextCursor.after = through; page.hasMore = false; }
    if (page.hasMore && page.nextCursor.after === after) throw new ConversationUpdateServiceError("CONVERSATION_UPDATES_UNAVAILABLE", "No update fits the response budget");
    if (!isConversationUpdatePage(page, { cursor: request.cursor, through, limit: request.limit })) throw new ConversationUpdateServiceError("CONVERSATION_UPDATES_UNAVAILABLE", "Invalid feed snapshot");
    return page;
  }
  async flush(): Promise<void> { await this.queue; }
  async close(): Promise<void> { this.closing = true; await this.flush(); this.closed = true; }
}
