import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { nativeMessageId, type Session } from "./history";
import { OpenCodeError, normalizeMessage, type NativeMessage, type OpenCodeAdapter } from "./opencode";
import type { MessageSnapshot } from "./oc-contract";
import type { ReconciledHistory } from "./reconcile";

type Observation = ReconciledHistory & { observation: true };
type Activity = Awaited<ReturnType<OpenCodeAdapter["activity"]>>;
type Cached = {
  identity: string; nativeCreatedAt: number; revert: string; checkedAt: number;
  rawMessages: NativeMessage[]; history: Observation; fingerprint: string;
};
type Flight = { identity: string; value: Promise<ReconciledHistory> };
const freshness = 1000, maxMessages = 10000, maxBytes = 16 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (session: Session) => JSON.stringify([session.sessionId, session.harness, session.authorityId, session.nativeSessionId, session.cwd]);
const invalid = (message: string): never => { throw new OpenCodeError(message); };
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const encoded = (value: unknown) => JSON.stringify(canonical(value));
const unfinished = (message: NativeMessage) => message.type === "assistant"
  ? message.time.completed === undefined || (message.content ?? []).some(part => part.type === "tool" && (part.state === undefined || ["running", "streaming"].includes(part.state.status)))
  : message.type === "compaction" && ["requested", "running"].includes(message.status ?? "");

export class OpenCodeObservationService {
  private entries = new Map<string, Cached>();
  private flights = new Map<string, Flight>();
  private activeValue?: { checkedAt: number; data: Record<string, { type: string }> };
  private activeFlight?: Promise<Record<string, { type: string }>>;
  constructor(private oc: Pick<OpenCodeAdapter, "request" | "activity" | "path">) {}
  async active(): Promise<Record<string, { type: string }>> {
    if (this.activeFlight) return this.activeFlight;
    if (this.activeValue && Date.now() - this.activeValue.checkedAt < freshness) return this.activeValue.data;
    const value = (async () => {
      try {
        const response = await this.oc.request<unknown>("/api/session/active", "GET");
        if (!record(response) || !record(response.data) || Object.entries(response.data).some(([id, state]) => !/^ses[a-zA-Z0-9_-]+$/.test(id) || !record(state) || typeof state.type !== "string" || !state.type)) return invalid("Unsupported native active-session response");
        const data = Object.fromEntries(Object.entries(response.data).map(([id, state]) => [id, { type: (state as { type: string }).type }]));
        this.activeValue = { checkedAt: Date.now(), data }; return data;
      } catch (error) { throw error instanceof OpenCodeError ? error : new OpenCodeError("Native active-session observation unavailable"); }
    })();
    this.activeFlight = value;
    try { return await value; } finally { if (this.activeFlight === value) this.activeFlight = undefined; }
  }
  peek(session: Session): ReconciledHistory | undefined {
    const entry = this.entries.get(session.sessionId);
    return entry?.identity === identity(session) ? entry.history : undefined;
  }
  async get(session: Session): Promise<ReconciledHistory> {
    if (session.harness !== "opencode" || typeof session.nativeSessionId !== "string" || !/^ses[a-zA-Z0-9_-]+$/.test(session.nativeSessionId) || typeof session.sessionId !== "string" || !session.sessionId || typeof session.cwd !== "string" || !isAbsolute(session.cwd) || session.cwd.includes("\0")) return invalid("Invalid native observation identity");
    const signature = identity(session), pending = this.flights.get(session.sessionId);
    if (pending?.identity === signature) return pending.value;
    const previous = this.entries.get(session.sessionId), cached = previous?.identity === signature ? previous : undefined;
    if (!pending && cached && Date.now() - cached.checkedAt < freshness) { this.touch(session.sessionId, cached); return cached.history; }
    const pinned = { ...session }, flight: Flight = { identity: signature, value: undefined! };
    flight.value = (async () => {
      try {
        const next = await this.read(pinned, signature, cached);
        if (identity(session) !== signature || this.flights.get(pinned.sessionId) !== flight) throw new OpenCodeError("Native observation identity changed during the read", 409);
        this.touch(pinned.sessionId, next);
        return next.history;
      } catch (error) { throw error instanceof OpenCodeError ? error : new OpenCodeError("Native live history observation unavailable"); }
    })();
    this.flights.set(pinned.sessionId, flight);
    try { return await flight.value; } finally { if (this.flights.get(pinned.sessionId) === flight) this.flights.delete(pinned.sessionId); }
  }
  private touch(sessionId: string, entry: Cached) {
    this.entries.delete(sessionId); this.entries.set(sessionId, entry);
    while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
  }
  private async read(session: Session, signature: string, previous?: Cached): Promise<Cached> {
    const deadline = performance.now() + 15000;
    const remaining = () => {
      const value = Math.ceil(deadline - performance.now());
      if (value <= 0) return invalid("Native observation exceeded its 15-second budget; no live history published");
      return value;
    };
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
      const timeout = remaining(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OpenCodeError("Native observation exceeded its 15-second budget; no live history published")), timeout); })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    const request = (path: string) => bounded(() => this.oc.request<unknown>(path, "GET", undefined, undefined, remaining()));
    const activity = async () => {
      const state = await bounded(() => this.oc.activity(session.nativeSessionId!, session.cwd));
      if (!record(state) || !record(state.session) || state.session.id !== session.nativeSessionId || state.session.location?.directory !== session.cwd) throw new OpenCodeError("Native observation session identity or directory differs from the pinned conversation", 409);
      if (typeof state.active !== "boolean" || typeof state.pending !== "boolean" || !record(state.session.time) || !timestamp(state.session.time.created) || !timestamp(state.session.time.updated)) return invalid("Unsupported native observation activity response");
      return state;
    };
    const revert = (state: Activity) => encoded((state.session as Activity["session"] & { revert?: unknown }).revert ?? null);
    const before = await activity(), revertFingerprint = revert(before);
    if (previous && previous.nativeCreatedAt !== before.session.time.created) throw new OpenCodeError("Native observation session creation identity changed", 409);
    const oldById = new Map(previous?.rawMessages.map(message => [message.id, message]) ?? []);
    let readCount = 0, normalizedBytes = 0, rawReadBytes = 0;
    const validate = (value: unknown): NativeMessage => {
      if (!record(value) || !nativeMessageId(value.id) || typeof value.type !== "string" || !value.type || !record(value.time) || !timestamp(value.time.created)
        || value.time.completed !== undefined && (!timestamp(value.time.completed) || value.time.completed < value.time.created)
        || value.sessionID !== undefined && value.sessionID !== session.nativeSessionId) return invalid("Invalid native observation message identity or timestamp");
      if (value.metadata !== undefined && !record(value.metadata) || ["text", "status", "reason", "summary", "outcome"].some(key => value[key] !== undefined && typeof value[key] !== "string")) return invalid("Invalid native observation message content");
      if (value.model !== undefined && (!record(value.model) || typeof value.model.id !== "string" || !value.model.id || typeof value.model.providerID !== "string" || !value.model.providerID || value.model.variant !== undefined && typeof value.model.variant !== "string")) return invalid("Invalid native observation message model");
      if (value.content !== undefined && (!Array.isArray(value.content) || value.content.some(part => !record(part) || typeof part.type !== "string" || !part.type || ["id", "name", "text"].some(key => part[key] !== undefined && typeof part[key] !== "string") || part.type === "tool" && part.state !== undefined && (!record(part.state) || typeof part.state.status !== "string" || !part.state.status)))) return invalid("Invalid native observation message parts");
      if (["cost", "preTokens", "postTokens", "durationMs"].some(key => value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || (value[key] as number) < 0))) return invalid("Invalid native observation message usage");
      const message = value as NativeMessage, old = oldById.get(message.id);
      if (old && (old.type !== message.type || old.time.created !== message.time.created)) throw new OpenCodeError("Conflicting immutable native message identity", 409);
      if (++readCount > maxMessages) return invalid("Native observation exceeds its 10,000-message read budget");
      rawReadBytes += Buffer.byteLength(JSON.stringify(message));
      if (rawReadBytes > maxBytes) return invalid("Native observation exceeds its 16 MiB raw read budget");
      const normalized = normalizeMessage(message);
      normalizedBytes += normalized ? Buffer.byteLength(JSON.stringify(normalized)) : 0;
      if (normalizedBytes > maxBytes) return invalid("Native observation exceeds its 16 MiB normalized read budget");
      remaining(); return message;
    };
    const latest = previous?.revert === revertFingerprint ? previous.rawMessages.at(-1)?.id : undefined;
    const fetched = new Map<string, NativeMessage>(), descending: NativeMessage[] = [], cursors = new Set<string>();
    let cursor: string | undefined, found = false, complete = false;
    for (let page = 0; page < 100; page++) {
      const response = await request(this.oc.path(session.nativeSessionId!) + `/message?limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc"}`);
      if (!record(response) || !Array.isArray(response.data) || response.data.length > 100 || !record(response.cursor)
        || response.cursor.next !== undefined && response.cursor.next !== null && (typeof response.cursor.next !== "string" || !response.cursor.next || response.cursor.next.length > 8192)) return invalid("Unsupported native observation history page");
      for (const value of response.data) {
        const message = validate(value), duplicate = fetched.get(message.id);
        if (duplicate) {
          if (encoded(duplicate) !== encoded(message)) throw new OpenCodeError("Conflicting duplicate native observation message", 409);
          continue;
        }
        // Native sequence order, not creation clocks, is authoritative: queued
        // inputs can be admitted before the messages that precede their delivery.
        fetched.set(message.id, message); descending.push(message);
        if (message.id === latest) found = true;
      }
      const next = response.cursor.next as string | null | undefined;
      if (!next) { complete = true; break; }
      if (!response.data.length || cursors.has(next)) return invalid("Native observation history cursor did not advance");
      if (found) break;
      cursors.add(next); cursor = next;
    }
    if (!found && !complete) return invalid("Native observation exceeds its 10,000-message page budget; no partial history published");
    let rawMessages = descending.reverse();
    if (found && previous && !complete) {
      const indices = new Map(previous.rawMessages.map((message, index) => [message.id, index]));
      let first = previous.rawMessages.length, last = -1;
      for (const message of rawMessages) {
        const index = indices.get(message.id);
        if (index === undefined) continue;
        if (index <= last) throw new OpenCodeError("Native observation overlap order changed", 409);
        first = Math.min(first, index); last = index;
      }
      rawMessages = [...previous.rawMessages.slice(0, first), ...rawMessages];
    }
    const refresh = rawMessages.filter(message => !fetched.has(message.id) && unfinished(message));
    const replacements = new Map<string, NativeMessage>();
    for (let offset = 0; offset < refresh.length; offset += 8) {
      const batch = await Promise.all(refresh.slice(offset, offset + 8).map(async message => {
        const response = await request(this.oc.path(session.nativeSessionId!) + `/message/${encodeURIComponent(message.id)}`);
        if (!record(response)) return invalid("Unsupported native observation message response");
        const next = validate(response.data);
        if (next.id !== message.id) throw new OpenCodeError("Native observation message read identity mismatch", 409);
        return next;
      }));
      for (const message of batch) replacements.set(message.id, message);
    }
    rawMessages = rawMessages.map(message => replacements.get(message.id) ?? message);
    if (rawMessages.length > maxMessages) return invalid("Native observation history exceeds 10,000 messages");
    const messages: MessageSnapshot[] = [], ids = new Set<string>();
    let projectionSize = 2, rawSize = 2;
    for (const message of rawMessages) {
      if (ids.has(message.id)) throw new OpenCodeError("Duplicate native observation history identity", 409);
      ids.add(message.id);
      rawSize += Buffer.byteLength(JSON.stringify(message)) + 1;
      if (rawSize > maxBytes) return invalid("Native observation history exceeds its 16 MiB raw budget");
      const normalized = normalizeMessage(message);
      if (normalized) { messages.push(normalized); projectionSize += Buffer.byteLength(JSON.stringify(normalized)) + 1; }
      if (projectionSize > maxBytes) return invalid("Native observation history exceeds its 16 MiB normalized budget");
      remaining();
    }
    const after = await activity();
    if (before.session.time.created !== after.session.time.created || revert(after) !== revertFingerprint) throw new OpenCodeError("Native observation session identity or revert changed during the read", 409);
    const observedActivity = after.active || after.pending ? "active" as const : "idle" as const;
    const fingerprint = createHash("sha256").update(encoded([messages, observedActivity])).digest("hex");
    remaining();
    const history: Observation = previous?.fingerprint === fingerprint ? previous.history : {
      sessionId: session.sessionId, nativeSessionId: session.nativeSessionId!, importedAt: new Date().toISOString(),
      messages, activity: observedActivity, coveredRunIds: [], observation: true,
      reason: "Live read-only native observation; not persisted reconciliation or command ownership evidence",
    };
    return { identity: signature, nativeCreatedAt: after.session.time.created, revert: revertFingerprint, checkedAt: Date.now(), rawMessages, history, fingerprint };
  }
}
