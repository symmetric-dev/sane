import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { consume, createRun } from "../shared/conversation/cc-reducer";
import { transcriptMessages } from "../shared/conversation/transcript";
import { contextUsageFor } from "../shared/conversation/context-usage";
import { compactionsFor, compactionPositions } from "../shared/conversation/compaction";
import { sentHandoffs } from "../shared/conversation/handoff-matching";
import type { Message, Run as DisplayRun, RunMetadata } from "../shared/conversation/types";
import type { Event, Run, Session } from "./history";
import type { ReconciledHistory } from "../shared/conversation/native-history-contract";
import { TRANSCRIPT_MAX_MESSAGES, TRANSCRIPT_PAGE_BYTES, type TranscriptCompaction, type TranscriptMessage, type TranscriptMetadataItem, type TranscriptMetadataPage, type TranscriptPage, type TranscriptRefresh, type TranscriptRefreshRequest, type TranscriptRunMetadata, type TranscriptSendAnchor, type TranscriptSummary, type TranscriptUsage } from "./transcript-contract";

export class TranscriptError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const hash = (text: string) => createHash("sha256").update(text).digest("base64url");
const identity = (s: Session) => JSON.stringify([s.sessionId, s.harness, s.authorityId, s.nativeSessionId, s.cwd]);
const selector = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
const invalid = (message: string): never => { throw new TranscriptError(400, "transcript-input", message); };
const reset = (): never => { throw new TranscriptError(409, "transcript-reset", "Transcript coverage changed; reopen latest or repeat the target"); };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const bounded = <T>(value: T, budget = TRANSCRIPT_PAGE_BYTES): T => {
  if (bytes(value) > budget) throw new TranscriptError(413, "transcript-budget", "Transcript identity or metadata exceeds the response budget");
  return value;
};
const warningText = (value: unknown, budget: number): string => {
  if (typeof value !== "string") return "";
  let result = "", size = 0;
  for (const character of value) { const length = Buffer.byteLength(character); if (size + length > budget) break; result += character; size += length; }
  return result;
};

/** Parsed snapshots are reused; stat also detects external atomic replacement.
 * The identity key includes cwd even though the persisted snapshot has no cwd.
 * In-flight reads coalesce. Changed-during-read snapshots fail closed, never
 * publish a mixture of generations. App writes explicitly invalidate the cache. */
export class NativeHistoryCache {
  private entries = new Map<string, { signature: string; value: Promise<ReconciledHistory> }>();
  constructor(private root: string) {}
  invalidate(sessionId: string) { this.entries.delete(sessionId); }
  async get(session: Session): Promise<ReconciledHistory | undefined> {
    const path = join(this.root, `${session.sessionId}.native-history.json`);
    let info: Awaited<ReturnType<typeof stat>>;
    try { info = await stat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.invalidate(session.sessionId); return; } throw error; }
    const signature = JSON.stringify([identity(session), info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
    const existing = this.entries.get(session.sessionId);
    if (existing?.signature === signature) return existing.value;
    const value = (async () => {
      const result = JSON.parse(await readFile(path, "utf8")) as ReconciledHistory;
      const after = await stat(path);
      if (JSON.stringify([identity(session), after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs]) !== signature) throw new TranscriptError(409, "transcript-reset", "Native snapshot changed while reading; retry");
      if (result.sessionId !== session.sessionId || result.nativeSessionId !== session.nativeSessionId || !Array.isArray(result.messages)) throw new Error("Native transcript snapshot identity mismatch");
      return result;
    })();
    const entry = { signature, value }; this.entries.set(session.sessionId, entry);
    try { return await value; }
    catch (error) { if (this.entries.get(session.sessionId) === entry) this.invalidate(session.sessionId); throw error; }
  }
}

type Materialized = { message: Message; json: string; envelope: TranscriptMessage; size: number };
type Projection = {
  identity: string; fingerprint: string; generation: number; history?: ReconciledHistory;
  revision: string; epoch: string; messages: Materialized[]; byId: Map<string, Materialized>;
  items: TranscriptMetadataItem[]; metadataRevision: string; usage: TranscriptUsage | null;
};
type Cursor = { session: string; identity: string; epoch: string; kind: "older" | "newer" | "meta"; anchor?: string; revision?: string; offset?: number };

/** Reducers consume each appended event once, seeded from the bridge's existing
 * startup decode. Polling unchanged evidence never replays event logs or rebuilds
 * the transcript. Dirty projections reuse the existing exact merge/usage helpers. */
export class TranscriptService {
  private secret = randomBytes(32);
  private processId = randomBytes(12).toString("base64url");
  private serial = 0;
  private runs = new Map<string, DisplayRun>();
  private usageEvidence = new Map<string, Event[]>();
  private compactEvidence = new Map<string, Event[]>();
  private usageBuffers = new Map<string, string>();
  private generations = new Map<string, number>();
  private projections = new Map<string, Projection>();
  constructor(private sessions: () => Session[], private storedRuns: () => Run[], private history: Pick<NativeHistoryCache, "get">,
    private resolveSend?: (session: Session, kind: "worker" | "handoff", id: string) => Promise<TranscriptSendAnchor | undefined>) {}
  private metadata(run: Run, session: Session): RunMetadata {
    // compact instructions are potentially huge; metadata remains lightweight.
    const { runId, sessionId, compact, ...rest } = run;
    return { ...rest, id: runId, conversationId: sessionId, harness: session.harness, nativeSessionId: session.nativeSessionId,
      ...(compact ? { compact: { requestId: compact.requestId, nativeRequestId: compact.nativeRequestId, nativeAdmittedId: compact.nativeAdmittedId } } : {}) };
  }
  private projectedMetadata(run: Run, session: Session): TranscriptRunMetadata {
    const display = this.runs.get(run.runId);
    return { ...this.metadata(run, session), nativeConnection: warningText(display?.nativeConnection, 64), nativeReason: warningText(display?.nativeReason, 2048), nativeCompletionBoundary: display?.nativeCompletionBoundary ?? null };
  }
  ingest(run: Run, events: Event[]) {
    const session = this.sessions().find(s => s.sessionId === run.sessionId);
    if (!session) throw new Error("Transcript run has no session");
    let display = this.runs.get(run.runId);
    if (!display) { display = createRun(this.metadata(run, session)); this.runs.set(run.runId, display); }
    Object.assign(display, this.metadata(run, session));
    const appended = events.filter(event => !display!.seen.has(event.seq));
    consume(display, appended);
    for (const event of appended) this.evidence(run, event);
    if (appended.some(event => event.kind !== "stderr")) this.generations.set(run.sessionId, (this.generations.get(run.sessionId) ?? 0) + 1);
  }
  /** Retain small authoritative evidence, not tool outputs/prompts, for pure
   * usage/compaction projection. Raw chunk parsing happens once at ingestion. */
  private evidence(run: Run, event: Event) {
    const usage = this.usageEvidence.get(run.runId) ?? [], compact = this.compactEvidence.get(run.runId) ?? [];
    this.usageEvidence.set(run.runId, usage); this.compactEvidence.set(run.runId, compact);
    const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
    if (event.kind === "message" && object(event.data)) {
      const { parts: _parts, error: _error, ...snapshot } = event.data;
      const small = { ...snapshot, parts: [] };
      usage.push({ ...event, data: small });
      if (snapshot.compaction) compact.push({ ...event, data: small });
      return;
    }
    if (event.kind === "status" && run.operation === "compact") { compact.push(event); return; }
    if (event.kind === "hook" && object(event.data) && object(event.data.payload)) {
      if (["PreCompact", "PostCompact"].includes(event.data.event)) compact.push(event);
      if (event.data.event === "PostCompact") usage.push(event);
      return;
    }
    if (event.kind !== "stdout") return;
    const record = (value: unknown) => {
      if (!object(value)) return;
      const { message, content: _content, result: _result, ...rest } = value;
      const small = { ...rest, ...(object(message) ? { message: { model: message.model, usage: message.usage } } : {}) };
      if (value.type === "assistant" || value.type === "result" || value.type === "system") usage.push({ ...event, data: small });
    };
    if (object(event.data)) {
      record(event.data);
      if (event.data.type === "system" && ["compact_boundary", "status"].includes(event.data.subtype)) compact.push(event);
    } else if (typeof event.data === "string") {
      const text = (this.usageBuffers.get(run.runId) ?? "") + event.data;
      const lines = text.split("\n"); let buffer = lines.pop() ?? "";
      for (const line of lines) { try { record(JSON.parse(line)); } catch { /* Diagnostic only. */ } }
      try { record(JSON.parse(buffer)); buffer = ""; } catch { /* Preserve incomplete usage transport. */ }
      this.usageBuffers.set(run.runId, buffer);
    }
  }
  private token(cursor: Cursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    return `${payload}.${createHmac("sha256", this.secret).update(payload).digest("base64url")}`;
  }
  private decode(value: string, session: Session, p: Projection, kind?: Cursor["kind"]): Cursor {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return invalid("Invalid transcript cursor");
    const [payload, signature] = value.split(".") as [string, string];
    const provided = Buffer.from(signature, "base64url");
    if (provided.length !== 32 || provided.toString("base64url") !== signature || Buffer.from(payload, "base64url").toString("base64url") !== payload) return invalid("Invalid transcript cursor");
    let cursor: Cursor;
    try { cursor = JSON.parse(Buffer.from(payload, "base64url").toString()); } catch { return invalid("Invalid transcript cursor"); }
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || Object.keys(cursor).some(key => !["session", "identity", "epoch", "kind", "anchor", "revision", "offset"].includes(key))
      || !selector(cursor.session) || typeof cursor.identity !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(cursor.identity)
      || typeof cursor.epoch !== "string" || !/^[A-Za-z0-9_-]{16}:e[1-9][0-9]{0,15}$/.test(cursor.epoch)
      || !["older", "newer", "meta"].includes(cursor.kind)
      || cursor.anchor !== undefined && !selector(cursor.anchor)
      || cursor.revision !== undefined && (typeof cursor.revision !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(cursor.revision))
      || cursor.offset !== undefined && (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
      || ["older", "newer"].includes(cursor.kind) && !cursor.anchor
      || cursor.kind === "meta" && (!cursor.revision || cursor.offset === undefined)) return invalid("Invalid transcript cursor");
    if (cursor.session !== session.sessionId) return invalid("Cursor belongs to another conversation");
    // An old signing key cannot be verified after restart. Treat the bounded
    // foreign-generation payload ONLY as a reset hint: never return or use its
    // anchor/offset/identity as accepted navigation authority.
    if (cursor.epoch.split(":")[0] !== this.processId) return reset();
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    if (!timingSafeEqual(provided, expected)) return invalid("Invalid transcript cursor");
    if (cursor.identity !== hash(identity(session))) return reset();
    if (cursor.epoch !== p.epoch) return reset();
    if (kind && cursor.kind !== kind) return invalid("Invalid cursor kind");
    return cursor;
  }
  private cursor(session: Session, p: Projection, fields: Omit<Cursor, "session" | "identity" | "epoch">) {
    return this.token({ session: session.sessionId, identity: hash(identity(session)), epoch: p.epoch, ...fields });
  }
  private materialize(message: Message): Materialized {
    const json = JSON.stringify(message), envelope: TranscriptMessage = { ...message, version: hash(json) };
    return { message, json, size: bytes(envelope), envelope };
  }
  private async project(session: Session): Promise<Projection> {
    const history = await this.history.get(session);
    const stored = this.storedRuns().filter(run => run.sessionId === session.sessionId);
    const fingerprint = JSON.stringify([session, stored]);
    const generation = this.generations.get(session.sessionId) ?? 0;
    const old = this.projections.get(session.sessionId);
    if (old && old.fingerprint === fingerprint && old.generation === generation && old.history === history && old.identity === identity(session)) return old;
    const runs = stored.map(run => {
      let display = this.runs.get(run.runId);
      if (!display) { display = createRun(this.metadata(run, session)); this.runs.set(run.runId, display); }
      Object.assign(display, this.metadata(run, session)); return display;
    });
    const merged = transcriptMessages(history, runs);
    const structural = !old || old.identity !== identity(session) || old.history !== history && !history?.observation || old.messages.length > merged.length || old.messages.some((entry, index) => entry.message.id !== merged[index]?.id);
    const epoch = structural ? `${this.processId}:e${++this.serial}` : old.epoch;
    const messages = merged.map(message => this.materialize(message));
    const byId = new Map(messages.map(entry => [entry.message.id, entry]));
    const compactRuns = runs.map(run => ({ ...run, events: this.compactEvidence.get(run.id) ?? [] }));
    const usageRuns = runs.map(run => ({ ...run, events: this.usageEvidence.get(run.id) ?? [] }));
    const compactions = compactionsFor({ id: session.sessionId, harness: session.harness!, nativeSessionId: session.nativeSessionId }, compactRuns, history);
    const positions = compactionPositions(compactions, merged, history);
    const placements = new Map<string, TranscriptCompaction["placement"]>();
    for (const [id, records] of positions) for (const record of records) {
      const knownNative = !!record.nativeId && !!history?.messages.some(message => message.messageId === record.nativeId);
      const time = record.endedAt ?? record.startedAt;
      const knownTail = !!time && merged.every(message => !!message.time && message.time <= time);
      // An imported final boundary is no longer the transcript tail once a new
      // App response arrives. App evidence observed after import is genuinely
      // later; importedAt is not used as a fabricated native boundary clock.
      const afterImport = !id && knownNative && history && !history.observation ? merged.find(message => message.runId !== "native-import" && message.time > history.importedAt) : undefined;
      placements.set(record.id, id ? { kind: "before-message", messageId: id } : afterImport ? { kind: "before-message", messageId: afterImport.id } : knownNative || knownTail ? { kind: "tail" } : { kind: "unplaced" });
    }
    const compactItems: TranscriptMetadataItem[] = compactions.map(record => {
      const { id, sessionId, harness, runId, nativeId, requestId, nativeRequestId, nativeAdmittedId, trigger, lifecycle, contextReset, startedAt, endedAt, requestedAt, observedAt, preTokens, postTokens, durationMs } = record;
      return { kind: "compaction", compaction: { id, sessionId, harness, runId, nativeId, requestId, nativeRequestId, nativeAdmittedId, trigger, lifecycle, contextReset, startedAt, endedAt, requestedAt, observedAt, preTokens, postTokens, durationMs, placement: placements.get(id) ?? { kind: "unplaced" } } };
    });
    // Reuse exact usage normalization, supplying a sentinel OC capacity purely
    // to extract authoritative model/input tokens; never expose that capacity.
    const models = new Set<string>();
    for (const message of history?.messages ?? []) if (message.model) models.add(message.model);
    for (const run of usageRuns) for (const event of run.events) if (event.kind === "message" && typeof (event.data as any)?.model === "string") models.add((event.data as any).model);
    const reported = contextUsageFor(session.harness!, usageRuns, [...models].map(id => ({ id, name: id, efforts: [], contextWindow: 1 })), history, compactions);
    const usage: TranscriptUsage | null = reported && (session.harness === "opencode" ? { tokens: reported.tokens, model: reported.model, time: reported.time, ...(reported.stale ? { stale: true } : {}) } : reported);
    const items: TranscriptMetadataItem[] = [...stored.map(run => ({ kind: "run" as const, run: this.projectedMetadata(run, session) })), ...compactItems];
    const p: Projection = { identity: identity(session), fingerprint, generation, history, revision: `${this.processId}:r${++this.serial}`, epoch, messages, byId, usage, items, metadataRevision: hash(JSON.stringify(items)) };
    this.projections.set(session.sessionId, p); return p;
  }
  private summary(session: Session, p: Projection): TranscriptSummary {
    return { sessionId: session.sessionId, revision: p.revision, epoch: p.epoch, usage: p.usage, ...(p.history && !p.history.observation ? { nativeHistoryImportedAt: p.history.importedAt } : {}) };
  }
  private limit(query: URLSearchParams, fallback: number) {
    const value = query.get("limit");
    if (value !== null && !/^[1-9][0-9]{0,2}$/.test(value)) return invalid("limit must be 1..100");
    const limit = value === null ? fallback : Number(value);
    if (limit > TRANSCRIPT_MAX_MESSAGES) return invalid("limit must be 1..100");
    return limit;
  }
  private query(query: URLSearchParams, allowed: string[]) {
    for (const key of query.keys()) if (!allowed.includes(key) || query.getAll(key).length !== 1) invalid(`Unknown or duplicate transcript selector: ${key}`);
  }
  async page(session: Session, query: URLSearchParams): Promise<TranscriptPage> {
    this.query(query, ["limit", "cursor", "targetMessageId", "targetRunId", "toolCallId", "targetKind", "targetId"]);
    const limit = this.limit(query, 50), cursorValue = query.get("cursor"), messageId = query.get("targetMessageId"), runId = query.get("targetRunId"), toolId = query.get("toolCallId");
    const targetKind = query.get("targetKind"), targetId = query.get("targetId");
    for (const value of [messageId, runId, toolId, targetId]) if (value !== null && !selector(value)) invalid("Invalid transcript target");
    if (targetKind !== null && targetKind !== "worker" && targetKind !== "handoff" || (targetKind !== null) !== (targetId !== null)) invalid("targetKind and targetId must identify a worker or handoff");
    if (messageId && runId || cursorValue !== null && (messageId || runId || toolId || targetKind) || toolId && !runId && !messageId || targetKind && (messageId || runId || toolId)) invalid("Choose one transcript target or cursor");
    const send = (targetKind === "worker" || targetKind === "handoff") && targetId ? await this.resolveSend?.(session, targetKind, targetId) : undefined;
    if (targetKind && !send) throw new TranscriptError(404, "transcript-target-missing", "Original send does not belong to this conversation");
    const p = await this.project(session), n = p.messages.length;
    let start = 0, end = n, targetIndex: number | undefined, direction: "older" | "newer" = "older";
    let targetTool = toolId ?? undefined;
    if (messageId || runId || send) {
      targetIndex = p.messages.findIndex(({ message }) => {
        if (send) return message.parts.some(part => {
          if (part.type !== "tool") return false;
          const matches = send.kind === "worker" ? message.runId === send.runId && (part.toolCallId === send.toolCallId || part.id === send.toolCallId)
            : sentHandoffs(part, session.sessionId, [send.presentation]).length > 0;
          if (matches) targetTool = part.toolCallId ?? part.id;
          return matches;
        });
        return (!messageId || message.id === messageId || message.nativeIds?.includes(messageId)) && (!runId || message.runId === runId) && (!toolId || message.parts.some(part => part.type === "tool" && (part.toolCallId === toolId || part.id === toolId)));
      });
      if (targetIndex < 0) throw new TranscriptError(404, "transcript-target-missing", "Original send anchor is not recorded in this conversation");
      end = Math.min(n, targetIndex + Math.ceil(limit / 2)); start = Math.max(0, end - limit);
    } else if (cursorValue !== null) {
      const cursor = this.decode(cursorValue, session, p);
      if (cursor.kind !== "older" && cursor.kind !== "newer") return invalid("Invalid page cursor kind");
      const index = p.messages.findIndex(entry => entry.message.id === cursor.anchor);
      if (index < 0) return reset();
      direction = cursor.kind;
      if (direction === "older") { end = index; start = Math.max(0, end - limit); }
      else { start = index + 1; end = Math.min(n, start + limit); }
    } else start = Math.max(0, n - limit);
    // Complete turns up to the hard count limit, without overlapping the cursor
    // anchor. Target pages may expand both ways; the target must never be lost.
    if (direction === "older" || targetIndex !== undefined) while (start > 0 && p.messages[start]?.message.role !== "user" && end - start < TRANSCRIPT_MAX_MESSAGES) start--;
    if (direction === "newer" || targetIndex !== undefined) while (end < n && p.messages[end]?.message.role !== "user" && end - start < TRANSCRIPT_MAX_MESSAGES) end++;
    // Reserve plenty of space for cursor/summary JSON. Select around the target
    // first; for latest/older retain the newest side, for newer the oldest side.
    // The first complete message is always admitted, even over the soft budget.
    // An oversized message occupies the page alone; pagination must make progress.
    const budget = TRANSCRIPT_PAGE_BYTES - 16 * 1024;
    let cost = 0;
    if (targetIndex !== undefined) {
      let left = targetIndex, right = targetIndex + 1; cost = p.messages[targetIndex]!.size;
      while (left > start || right < end) {
        let added = false;
        if (left > start) { const size = p.messages[left - 1]!.size; if (cost + size <= budget) { cost += size; left--; added = true; } }
        if (right < end) { const size = p.messages[right]!.size; if (cost + size <= budget) { cost += size; right++; added = true; } }
        if (!added) break;
      }
      start = left; end = right;
    } else if (direction === "older") {
      let left = end; while (left > start) { const size = p.messages[left - 1]!.size; if (left < end && cost + size > budget) break; cost += size; left--; } start = left;
    } else {
      let right = start; while (right < end) { const size = p.messages[right]!.size; if (right > start && cost + size > budget) break; cost += size; right++; } end = right;
    }
    const firstId = end > start ? p.messages[start]!.message.id : null, lastId = end > start ? p.messages[end - 1]!.message.id : null;
    const response: TranscriptPage = { ...this.summary(session, p), messages: p.messages.slice(start, end).map(entry => entry.envelope),
      coverage: { firstId, lastId, firstIndex: end > start ? start : null, lastIndex: end > start ? end - 1 : null, totalMessages: n,
        olderCursor: start > 0 && firstId ? this.cursor(session, p, { kind: "older", anchor: firstId }) : null, newerCursor: end < n && lastId ? this.cursor(session, p, { kind: "newer", anchor: lastId }) : null },
      continuation: { older: start > 0 && p.messages[start]?.message.role !== "user", newer: end < n && p.messages[end]?.message.role !== "user" },
      ...(targetIndex !== undefined ? { target: { messageId: p.messages[targetIndex]!.message.id, ...(targetTool ? { toolCallId: targetTool } : {}) } } : {}) };
    bounded({ ...response, messages: [] });
    return response;
  }
  async metadataPage(session: Session, query: URLSearchParams): Promise<TranscriptMetadataPage> {
    this.query(query, ["limit", "cursor"]);
    const limit = this.limit(query, 100), p = await this.project(session), token = query.get("cursor");
    const cursor = token === null ? undefined : this.decode(token, session, p, "meta");
    if (cursor && cursor.revision !== p.metadataRevision) return reset();
    let offset = cursor?.offset ?? 0;
    const items: TranscriptMetadataItem[] = []; let cost = 0;
    while (offset < p.items.length && items.length < limit) { const item = p.items[offset]!, size = bytes(item); if (cost + size > TRANSCRIPT_PAGE_BYTES - 16 * 1024) { if (!items.length) throw new TranscriptError(413, "transcript-budget", "Run metadata exceeds the response budget"); break; } items.push(item); cost += size; offset++; }
    return bounded({ ...this.summary(session, p), metadataRevision: p.metadataRevision, items, nextCursor: offset < p.items.length ? this.cursor(session, p, { kind: "meta", offset, revision: p.metadataRevision }) : null });
  }
  async refresh(session: Session, input: TranscriptRefreshRequest): Promise<TranscriptRefresh> {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["epoch", "messages"].includes(key)) || !selector(input.epoch) || !Array.isArray(input.messages) || input.messages.length > TRANSCRIPT_MAX_MESSAGES) return invalid("Invalid transcript refresh request");
    const ids = new Set<string>();
    for (const entry of input.messages) { if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => !["id", "version"].includes(key)) || !selector(entry.id) || !selector(entry.version) || ids.has(entry.id)) return invalid("Invalid or duplicate refresh message"); ids.add(entry.id); }
    const p = await this.project(session); if (input.epoch !== p.epoch) return reset();
    const upserts: TranscriptMessage[] = [], removedIds: string[] = []; let processed = 0, cost = 0;
    for (const requested of input.messages) {
      const entry = p.byId.get(requested.id);
      if (!entry) { const size = bytes(requested.id); if (cost + size > TRANSCRIPT_PAGE_BYTES - 16 * 1024) break; cost += size; removedIds.push(requested.id); processed++; continue; }
      if (entry.envelope.version !== requested.version) {
        // Admit one full oversized UPSERT only when no other payload was emitted.
        if (cost + entry.size > TRANSCRIPT_PAGE_BYTES - 16 * 1024 && (upserts.length || removedIds.length)) break;
        cost += entry.size; upserts.push(entry.envelope);
      }
      processed++;
      if (cost > TRANSCRIPT_PAGE_BYTES - 16 * 1024) break;
    }
    const response: TranscriptRefresh = { ...this.summary(session, p), upserts, removedIds, processed };
    bounded({ ...response, upserts: [] });
    return response;
  }
}
