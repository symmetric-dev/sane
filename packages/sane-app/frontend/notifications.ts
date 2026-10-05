import type { Conversation } from "./types";
import {
  isConversationUpdate, isConversationUpdateCursor, isConversationUpdatePage, isConversationUpdateSource,
  updateSourceKey, isConversationUpdateCoverage,
  type ConversationUpdate, type ConversationUpdateCursor, type ConversationUpdateSource,
  type ConversationUpdateCoverage,
} from "../shared/conversation/conversation-updates";
import { NotificationDatabase, type NotificationRows } from "./notification-db";
import {
  LEGACY_PREFIX, freshLegacy, decodeLegacy, mergeLegacy, serializeLegacy, observeLegacy,
  legacyIdentity, legacyKey, parseLegacyKey, receiptKey, text, integer, object,
  type LegacyItem, type LegacyState,
} from "./notifications-legacy";

export type NotificationItem = LegacyItem & {
  kind?: "reply" | "failed" | "interrupted" | "legacy";
  sourceKey?: string; groupId?: string; occurrenceSequence?: number;
};
export type NotificationSnapshot = { items: NotificationItem[]; unreadCount: number; storageError: string; feedError?: string };
export type NotificationCapture = Readonly<{
  owner: string; binding: number; conversationId: string;
  sources: readonly string[]; ids: readonly string[]; legacyIds: readonly string[];
}>;
export type NotificationResume = { cursor?: ConversationUpdateCursor; through?: number; seeding: boolean };
type EventRecord = { update: ConversationUpdate; eligible: boolean };
type Accepted = { conversationId: string; runId: string; sourceKey?: string; acceptedAt: number };
type ResumeState = NotificationResume & {
  storeId?: string; baselines: [string, number][]; activeRunIds: string[]; activeBindings: [string, string][];
  coverage: ConversationUpdateCoverage[];
};
type Memory = {
  events: Map<string, EventRecord>; reads: Map<string, number>; accepted: Map<string, Accepted>;
  legacy: LegacyState; resume: ResumeState; storageError: string;
};
const fresh = (): Memory => ({ events: new Map(), reads: new Map(), accepted: new Map(), legacy: freshLegacy(),
  resume: { seeding: true, baselines: [], activeRunIds: [], activeBindings: [], coverage: [] }, storageError: "" });
const STORAGE_ERROR = "Notifications are stored in memory only while browser storage is unavailable or invalid. They may not survive a reload or sync across tabs.";
const LEGACY_ERROR = "Legacy notification history could not be imported. Its browser storage is unavailable or invalid.";
const sameCursor = (a?: ConversationUpdateCursor | null, b?: ConversationUpdateCursor | null) =>
  (a?.epoch ?? null) === (b?.epoch ?? null) && (a?.after ?? null) === (b?.after ?? null);
const acceptedKey = (r: Pick<Accepted, "conversationId" | "runId">) => JSON.stringify([r.conversationId, r.runId]);
const eligible = (c: Conversation) => !c.worker && c.agentKind !== "worker" && !c.hidden && !c.replacedBy;

/** Only catalog-evidenced authority/native identity is used for qualification. */
function catalogSource(c: Conversation): ConversationUpdateSource | undefined {
  const row = c as Conversation & { updateSource?: unknown; authorityId?: string; incarnation?: string };
  if (isConversationUpdateSource(row.updateSource)) return row.updateSource;
  const source = { harness: c.harness, authorityId: row.authorityId, nativeSessionId: c.nativeSessionId,
    ...(row.incarnation !== undefined ? { incarnation: row.incarnation } : {}) };
  return isConversationUpdateSource(source) ? source : undefined;
}
function validSourceKey(value: unknown): value is string {
  if (!text(value, 16384)) return false;
  try {
    const tuple: unknown = JSON.parse(value);
    if (!Array.isArray(tuple) || tuple.length !== 4) return false;
    const source = { harness: tuple[0], authorityId: tuple[1], nativeSessionId: tuple[2], ...(tuple[3] === null ? {} : { incarnation: tuple[3] }) };
    return isConversationUpdateSource(source) && updateSourceKey(source) === value;
  } catch { return false; }
}
function decode(rows: NotificationRows): Memory {
  const m = fresh();
  const meta = rows.resume.get("state");
  if (meta !== undefined) {
    if (!object(meta) || typeof meta.seeding !== "boolean"
      || meta.cursor !== undefined && !isConversationUpdateCursor(meta.cursor)
      || meta.through !== undefined && (!integer(meta.through) || !isConversationUpdateCursor(meta.cursor) || meta.through < meta.cursor.after)
      || meta.storeId !== undefined && !text(meta.storeId)
      || !Array.isArray(meta.activeRunIds) || !meta.activeRunIds.every(id => text(id)) || new Set(meta.activeRunIds).size !== meta.activeRunIds.length
      || !Array.isArray(meta.baselines) || meta.baselines.some(p => !Array.isArray(p) || p.length !== 2 || !validSourceKey(p[0]) || !integer(p[1]))
      || !Array.isArray(meta.activeBindings) || meta.activeBindings.some(p => !Array.isArray(p) || p.length !== 2 || !text(p[0]) || !validSourceKey(p[1]))
      || !Array.isArray(meta.coverage) || !meta.coverage.every(isConversationUpdateCoverage)) {
      throw new Error("Invalid notification resume state");
    }
    m.resume = meta as ResumeState;
  }
  for (const [id, value] of rows.events) {
    if (!object(value) || !isConversationUpdate(value.update) || value.update.id !== id || typeof value.eligible !== "boolean") throw new Error("Invalid notification event");
    m.events.set(id, { update: value.update, eligible: value.eligible });
  }
  for (const [id, at] of rows.reads) {
    if (!text(id, 16384) || !integer(at) || !at) throw new Error("Invalid notification read marker");
    m.reads.set(id, at);
  }
  for (const [key, value] of rows.accepted) {
    if (!object(value) || !text(value.conversationId) || !text(value.runId) || !integer(value.acceptedAt)
      || value.sourceKey !== undefined && !validSourceKey(value.sourceKey)) throw new Error("Invalid notification accepted receipt");
    const r = value as Accepted;
    if (acceptedKey(r) !== key) throw new Error("Invalid notification receipt identity");
    m.accepted.set(key, r);
  }
  const legacy = rows.legacy.get("sidecar");
  if (legacy !== undefined) m.legacy = decodeLegacy(legacy);
  for (const [key, id] of m.legacy.mappings) {
    const old = parseLegacyKey(key), event = m.events.get(id);
    if (!old || !event || event.update.conversationId !== old.conversationId
      || event.update.legacyRunId !== undefined && event.update.legacyRunId !== old.runId) throw new Error("Invalid legacy notification mapping");
    const tuple = JSON.parse(old.identity) as [string, string, string, string];
    if (tuple[1] !== event.update.source.harness || tuple[2] !== event.update.source.nativeSessionId) throw new Error("Invalid legacy notification source mapping");
  }
  return m;
}
function encode(m: Memory, rows: NotificationRows): void {
  rows.resume.set("state", m.resume);
  rows.events = new Map(m.events); rows.reads = new Map(m.reads); rows.accepted = new Map(m.accepted);
  rows.legacy.set("sidecar", serializeLegacy(m.legacy));
}
/** Merge grow-only evidence, never merge a volatile cursor into a durable one. */
function union(m: Memory, other: Memory): void {
  const baselines = new Map(m.resume.baselines);
  for (const [key, through] of other.resume.baselines) baselines.set(key, Math.max(through, baselines.get(key) ?? 0));
  m.resume.baselines = [...baselines];
  m.resume.activeRunIds = [...new Set([...m.resume.activeRunIds, ...other.resume.activeRunIds])];
  const bindings = new Map(other.resume.activeBindings);
  for (const [runId, sourceKey] of m.resume.activeBindings) bindings.set(runId, sourceKey);
  m.resume.activeBindings = [...bindings];
  for (const [id, at] of other.reads) m.reads.set(id, Math.max(at, m.reads.get(id) ?? 0));
  for (const [key, receipt] of other.accepted) {
    const previous = m.accepted.get(key);
    m.accepted.set(key, { ...receipt, ...(previous?.sourceKey ? { sourceKey: previous.sourceKey } : {}),
      acceptedAt: Math.min(receipt.acceptedAt, previous?.acceptedAt ?? receipt.acceptedAt) });
  }
  for (const [id, record] of other.events) {
    const previous = m.events.get(id);
    if (previous && (updateSourceKey(previous.update.source) !== updateSourceKey(record.update.source)
      || previous.update.conversationId !== record.update.conversationId || previous.update.occurrenceSequence !== record.update.occurrenceSequence)) continue;
    const update = previous && previous.update.revision >= record.update.revision ? previous.update : record.update;
    m.events.set(id, { update, eligible: !!previous?.eligible || record.eligible });
  }
  mergeLegacy(m.legacy, other.legacy);
}

class NotificationStore {
  private listeners = new Set<() => void>();
  private scopes = new Map<string, Memory>();
  private scope: string | null = null;
  private legacyScope: string | null = null;
  private binding = 0;
  private memory = fresh();
  private db = new NotificationDatabase();
  private hydration: Promise<void> = Promise.resolve();
  private queue: Promise<unknown> = Promise.resolve();
  private channel: BroadcastChannel | null = null;
  private catalog: Map<string, Conversation> | null = null;
  private feedEnabled = false;
  private feedError = "";
  private state: NotificationSnapshot = Object.freeze({ items: Object.freeze([]) as unknown as NotificationItem[], unreadCount: 0, storageError: "", feedError: "" });
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  ready = (): Promise<void> => this.hydration;
  resume = (): NotificationResume | null => this.scope === null ? null : {
    ...(this.memory.resume.cursor ? { cursor: { ...this.memory.resume.cursor } } : {}),
    ...(this.memory.resume.through !== undefined ? { through: this.memory.resume.through } : {}), seeding: this.memory.resume.seeding,
  };
  setFeedEnabled = (enabled: boolean): void => { this.feedEnabled = enabled; this.publish(); };
  setFeedError = (error: string | null): void => { this.feedError = error ?? ""; this.publish(); };

  private current(owner: string, binding: number) { return this.scope === owner && this.binding === binding; }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work); this.queue = result.catch(() => undefined); return result;
  }
  private sourceVisible(conversationId: string, sourceKey?: string, identity?: string): boolean {
    if (!this.catalog) return true;
    const c = this.catalog.get(conversationId);
    if (!c || !eligible(c)) return false;
    if (identity) return identity === legacyIdentity(c);
    const source = catalogSource(c);
    if (source) return sourceKey === updateSourceKey(source);
    if (sourceKey) {
      try {
        const parts: unknown = JSON.parse(sourceKey);
        return Array.isArray(parts) && parts[0] === c.harness && parts[2] === (c.nativeSessionId ?? c.id);
      } catch { return false; }
    }
    return true;
  }
  private unreadEvents() {
    return [...this.memory.events.values()].filter(r => r.eligible && !this.memory.reads.has(r.update.id)
      && this.sourceVisible(r.update.conversationId, updateSourceKey(r.update.source)));
  }
  private unreadLegacy() {
    return [...this.memory.legacy.records.values()].filter(r => r.item && r.observedActive && !r.readAt
      && !this.memory.legacy.reads.has(legacyKey(r)) && !this.memory.legacy.tombstones.has(legacyKey(r))
      && this.sourceVisible(r.conversationId, undefined, r.identity));
  }
  private publish(): void {
    const grouped = new Map<string, NotificationItem>();
    if (this.scope !== null) {
      for (const r of this.unreadEvents()) {
        const u = r.update, sourceKey = updateSourceKey(u.source), c = this.catalog?.get(u.conversationId);
        const item: NotificationItem = { id: u.id, conversationId: u.conversationId, runId: u.runId ?? u.id,
          title: c?.title?.trim().slice(0, 256) || "Conversation", kind: u.kind,
          status: u.kind === "reply" ? "completed" : u.kind, time: u.occurredAt ?? u.observedAt,
          sourceKey, groupId: sourceKey, occurrenceSequence: u.occurrenceSequence,
          ...(c?.workspaceId !== undefined ? { workspaceId: c.workspaceId } : {}),
          ...(c?.worktreeId !== undefined ? { worktreeId: c.worktreeId } : {}) };
        const old = grouped.get(sourceKey);
        if (!old || (old.occurrenceSequence ?? 0) < u.occurrenceSequence) grouped.set(sourceKey, item);
      }
      for (const r of this.unreadLegacy()) {
        const c = this.catalog?.get(r.conversationId), source = c && catalogSource(c);
        const groupId = source ? updateSourceKey(source) : r.identity;
        const item: NotificationItem = { ...r.item!, kind: "legacy", groupId };
        const old = grouped.get(groupId);
        if (!old || old.kind === "legacy" && (item.time > old.time || item.time === old.time && item.id > old.id)) grouped.set(groupId, item);
      }
    }
    const items = [...grouped.values()].sort((a, b) =>
      (b.occurrenceSequence ?? 0) - (a.occurrenceSequence ?? 0) || b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
    const coverageNotices = [...new Set(this.memory.resume.coverage.filter(coverage => coverage.state !== "ready")
      .map(coverage => coverage.reason || `Conversation update coverage is ${coverage.state}.`))].slice(0, 3);
    const next = { items, unreadCount: items.length, storageError: this.scope === null ? "" : this.memory.storageError,
      feedError: this.scope === null ? "" : [this.feedError, ...coverageNotices].filter(Boolean).join(" ") };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    items.forEach(i => Object.freeze(i)); Object.freeze(items); this.state = Object.freeze(next);
    this.listeners.forEach(fn => fn());
  }

  private importLegacy(m: Memory, owner: string): void {
    if (typeof window === "undefined") return;
    try {
      const legacyScope = this.legacyScope ?? owner;
      const raw = window.localStorage.getItem(LEGACY_PREFIX + legacyScope);
      if (raw !== null) mergeLegacy(m.legacy, decodeLegacy(raw, legacyScope));
    } catch { if (!m.storageError) m.storageError = LEGACY_ERROR; }
  }
  private reconcile(m: Memory): void {
    // Bootstrap activity is receipt evidence, not a cursor. Keep it across a
    // memory-only recovery, and bind it to a listed exact native run when possible.
    const activeBindings = new Map(m.resume.activeBindings);
    for (const c of this.catalog?.values() ?? []) {
      const source = catalogSource(c);
      if (!source || !text(c.lastRunId) || !m.resume.activeRunIds.includes(c.lastRunId)) continue;
      const sourceKey = updateSourceKey(source), bound = activeBindings.get(c.lastRunId);
      if (bound && bound !== sourceKey) continue;
      activeBindings.set(c.lastRunId, sourceKey);
      const receipt: Accepted = { conversationId: c.id, runId: c.lastRunId, sourceKey, acceptedAt: Math.max(1, Date.now()) };
      if (!m.accepted.has(acceptedKey(receipt))) m.accepted.set(acceptedKey(receipt), receipt);
      if (!m.legacy.accepted.has(acceptedKey(receipt))) m.legacy.accepted.set(acceptedKey(receipt), {
        conversationId: c.id, runId: c.lastRunId, acceptedAt: receipt.acceptedAt, identity: legacyIdentity(c),
      });
    }
    for (const [key, receipt] of m.legacy.accepted) {
      const c = this.catalog?.get(receipt.conversationId), source = c && catalogSource(c);
      if (c && !receipt.identity && text(c.nativeSessionId)) receipt.identity = legacyIdentity(c);
      if (c && source && receipt.identity === legacyIdentity(c) && !m.accepted.has(key)) m.accepted.set(key, {
        conversationId: receipt.conversationId, runId: receipt.runId, acceptedAt: receipt.acceptedAt, sourceKey: updateSourceKey(source),
      });
    }
    for (const r of m.legacy.records.values()) {
      const receipt = m.legacy.accepted.get(receiptKey(r));
      if (receipt?.identity === r.identity) r.observedActive = true;
    }
    for (const [key, id] of m.legacy.mappings) {
      const at = m.legacy.reads.get(key);
      if (at) m.reads.set(id, Math.max(at, m.reads.get(id) ?? 0));
    }
    for (const receipt of m.accepted.values()) {
      const c = this.catalog?.get(receipt.conversationId), source = c && catalogSource(c);
      if (!receipt.sourceKey && source) receipt.sourceKey = updateSourceKey(source);
    }
    for (const r of m.events.values()) {
      const u = r.update, sourceKey = updateSourceKey(u.source);
      if (u.runId) {
        const receipt = m.accepted.get(acceptedKey({ conversationId: u.conversationId, runId: u.runId }));
        const c = this.catalog?.get(u.conversationId);
        // A candidate may bind a pending receipt only when its source agrees
        // with the current catalog's native identity (if a catalog is known).
        if (receipt && !receipt.sourceKey && (!c || c.harness === u.source.harness && (c.nativeSessionId ?? c.id) === u.source.nativeSessionId)) receipt.sourceKey = sourceKey;
        if (receipt?.sourceKey === sourceKey) r.eligible = true;
        const currentSource = c && catalogSource(c);
        const sourceMatches = !c || (currentSource ? updateSourceKey(currentSource) === sourceKey
          : c.harness === u.source.harness && (c.nativeSessionId ?? c.id) === u.source.nativeSessionId);
        if (sourceMatches && m.resume.activeRunIds.includes(u.runId)) {
          const bound = activeBindings.get(u.runId);
          if (!bound) activeBindings.set(u.runId, sourceKey);
          if (!bound || bound === sourceKey) r.eligible = true;
        }
      }
    }
    m.resume.activeBindings = [...activeBindings];
    // Canonical alias migration is exact, source-confirmed, and one-to-one
    // across all retained occurrences, not just the incoming page.
    for (const key of new Set([...m.legacy.records.keys(), ...m.legacy.reads.keys()])) {
      if (m.legacy.tombstones.has(key)) continue;
      const legacy = parseLegacyKey(key);
      if (!legacy) continue;
      const old = m.legacy.records.get(key);
      const c = this.catalog?.get(legacy.conversationId), source = c && catalogSource(c);
      if (!c || !source || legacy.identity !== legacyIdentity(c)) continue;
      const sourceKey = updateSourceKey(source);
      const matches = [...m.events.values()].filter(r => r.update.legacyRunId === legacy.runId);
      if (matches.length !== 1) continue;
      const r = matches[0]!;
      if (r.update.conversationId !== legacy.conversationId || updateSourceKey(r.update.source) !== sourceKey) continue;
      if (old?.observedActive) r.eligible = true;
      const readAt = Math.max(old?.readAt ?? 0, m.legacy.reads.get(key) ?? 0);
      if (readAt) m.reads.set(r.update.id, Math.max(readAt, m.reads.get(r.update.id) ?? 0));
      m.legacy.tombstones.add(key); m.legacy.mappings.set(key, r.update.id); m.legacy.records.delete(key);
    }
  }
  /** Used by focus/storage/channel and feed loops; evidence is unioned inside
   * the transaction. A recovery returns to the DB cursor for safe replay. */
  private async refresh(owner: string, binding: number): Promise<void> {
    if (!this.current(owner, binding)) return;
    try {
      const result = await this.db.transaction(owner, rows => {
        const m = decode(rows); union(m, this.memory); m.storageError = "";
        this.importLegacy(m, owner); this.reconcile(m); encode(m, rows); return m;
      }, () => this.current(owner, binding));
      if (!this.current(owner, binding)) return;
      // A synchronous capture/receipt may arrive after the IDB callback but
      // before oncomplete. Keep it visible; its queued write persists it next.
      union(result, this.memory); this.reconcile(result);
      this.memory = result; this.scopes.set(owner, result); this.publish();
    } catch {
      if (!this.current(owner, binding)) return;
      this.memory.storageError = STORAGE_ERROR; this.importLegacy(this.memory, owner); this.reconcile(this.memory); this.publish();
    }
  }
  private onRefresh = (): void => {
    const owner = this.scope, binding = this.binding;
    if (owner !== null) void this.enqueue(() => this.refresh(owner, binding));
  };
  private onStorage = (event: StorageEvent): void => {
    if (this.scope !== null && event.key === LEGACY_PREFIX + this.legacyScope) this.onRefresh();
  };
  // The optional trusted alias lets the parent origin-qualify v3 ownership
  // without losing the old storeId-only localStorage import key.
  activate = (owner: string, legacyScope = owner): void => {
    if (this.scope === owner && this.legacyScope === legacyScope) return;
    this.suspend(); if (!text(owner, 16384) || !text(legacyScope, 16384)) return;
    this.scope = owner; this.legacyScope = legacyScope; const binding = this.binding;
    this.memory = this.scopes.get(owner) ?? fresh(); this.scopes.set(owner, this.memory);
    this.hydration = this.enqueue(() => this.refresh(owner, binding));
    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.onStorage); window.addEventListener("focus", this.onRefresh);
      try {
        if (typeof BroadcastChannel !== "undefined") {
          this.channel = new BroadcastChannel("sane.notifications.v3:" + owner);
          this.channel.onmessage = this.onRefresh;
        }
      } catch { /* optional invalidation; focus/feed transactions still refresh */ }
    }
    this.publish();
  };
  suspend = (): void => {
    this.binding++; this.scope = null; this.legacyScope = null; this.catalog = null; this.feedEnabled = false; this.feedError = "";
    this.channel?.close(); this.channel = null; this.db.close();
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", this.onStorage); window.removeEventListener("focus", this.onRefresh);
    }
    this.publish();
  };
  private notify(): void { try { this.channel?.postMessage("invalidate"); } catch { /* optional */ } }

  /** Retention/epoch recovery clears traversal metadata only, never exact reads
   * or attention evidence. A concurrent tab's newer cursor wins the comparison. */
  resetResume = (): Promise<boolean> => {
    const owner = this.scope, binding = this.binding, expected = this.memory.resume.cursor ? { ...this.memory.resume.cursor } : null;
    if (owner === null) return Promise.resolve(false);
    return this.enqueue(async () => {
      if (!this.current(owner, binding)) return false;
      try {
        const result = await this.db.transaction(owner, rows => {
          const m = decode(rows), matches = sameCursor(m.resume.cursor, expected);
          union(m, this.memory); this.importLegacy(m, owner);
          if (matches) m.resume = { ...m.resume, seeding: true, cursor: undefined, through: undefined };
          this.reconcile(m); encode(m, rows); return { m, matches };
        }, () => this.current(owner, binding));
        if (!this.current(owner, binding)) return false;
        union(result.m, this.memory); this.reconcile(result.m);
        this.memory = result.m; this.scopes.set(owner, result.m); this.publish(); this.notify(); return result.matches;
      } catch {
        if (!this.current(owner, binding)) return false;
        this.memory.resume = { ...this.memory.resume, seeding: true, cursor: undefined, through: undefined };
        this.memory.storageError = STORAGE_ERROR; this.publish(); return true;
      }
    });
  };

  applyPage = (page: unknown, expected: ConversationUpdateCursor | null = null, bootstrap = false): Promise<boolean> => {
    const owner = this.scope, binding = this.binding;
    if (owner === null) return Promise.resolve(false);
    // Clone at admission so callers cannot change an in-flight page/cursor.
    let wire: unknown, captured = expected ? { ...expected } : null;
    try { wire = structuredClone(page); } catch { this.setFeedError("Invalid conversation update page."); return Promise.resolve(false); }
    return this.enqueue(async () => {
      if (!this.current(owner, binding)) return false;
      await this.hydration;
      if (!this.current(owner, binding)) return false;
      const apply = (m: Memory): boolean => {
        if (!sameCursor(m.resume.cursor, captured)) return false;
        const reset = bootstrap && wire && object(wire) && wire.bootstrap !== undefined;
        if (!isConversationUpdatePage(wire, {
          ...(m.resume.storeId ? { storeId: m.resume.storeId } : {}),
          ...(!reset && captured ? { cursor: captured } : {}),
          ...(!reset && m.resume.through !== undefined ? { through: m.resume.through } : {}),
        }) || bootstrap && !wire.bootstrap || !bootstrap && wire.bootstrap !== undefined
          || !reset && !captured || !reset && captured?.epoch !== wire.epoch) throw new Error("Invalid conversation update page.");
        if (reset) {
          m.resume = { seeding: true, baselines: wire.bootstrap!.sourceBaselines.map(b => [b.sourceKey, b.through]),
            activeRunIds: [...new Set([...m.resume.activeRunIds, ...wire.bootstrap!.activeRunIds])],
            activeBindings: m.resume.activeBindings, storeId: wire.storeId, coverage: m.resume.coverage };
        }
        const coverage = new Map(m.resume.coverage.map(c => [c.sourceKey, c]));
        for (const c of wire.coverage) coverage.set(c.sourceKey, c);
        m.resume.coverage = [...coverage.values()];
        const baselines = new Map(m.resume.baselines);
        for (const coverage of wire.coverage) if (coverage.baselineThrough !== undefined) {
          baselines.set(coverage.sourceKey, Math.max(coverage.baselineThrough, baselines.get(coverage.sourceKey) ?? 0));
        }
        for (const u of wire.updates) {
          const old = m.events.get(u.id), sourceKey = updateSourceKey(u.source);
          if (old && (old.update.conversationId !== u.conversationId || updateSourceKey(old.update.source) !== sourceKey
            || old.update.occurrenceSequence !== u.occurrenceSequence)) throw new Error("Conversation occurrence identity changed.");
          if (old && old.update.revision > u.revision) continue;
          const baseline = baselines.get(sourceKey);
          const historical = m.resume.seeding || u.historical === true
            || baseline !== undefined && (u.sourceSequence === undefined || u.sourceSequence <= baseline);
          m.events.set(u.id, { update: old && old.update.revision === u.revision ? old.update : u,
            eligible: old ? old.eligible : !historical });
        }
        m.resume.baselines = [...baselines]; m.resume.cursor = { ...wire.nextCursor };
        m.resume.storeId = wire.storeId; m.resume.through = wire.hasMore ? wire.through : undefined;
        m.resume.seeding = m.resume.seeding && wire.hasMore;
        this.reconcile(m); return true;
      };
      try {
        const result = await this.db.transaction(owner, rows => {
          const m = decode(rows);
          // Cursor comparison is against disk BEFORE unioning volatile data.
          const matches = sameCursor(m.resume.cursor, captured);
          union(m, this.memory); m.storageError = ""; this.importLegacy(m, owner);
          const applied = matches && apply(m); this.reconcile(m); encode(m, rows); return { m, applied };
        }, () => this.current(owner, binding));
        if (!this.current(owner, binding)) return false;
        union(result.m, this.memory); this.reconcile(result.m);
        this.memory = result.m; this.scopes.set(owner, result.m); this.publish(); this.notify();
        return result.applied;
      } catch (error) {
        if (!this.current(owner, binding)) return false;
        // Invalid pages never advance even a volatile cursor. Storage failures
        // still allow the full feed to function, without claiming durability.
        const message = error instanceof Error ? error.message : "";
        if (message === "Invalid conversation update page." || message === "Conversation occurrence identity changed.") {
          this.setFeedError(message); return false;
        }
        this.memory.storageError = STORAGE_ERROR; this.importLegacy(this.memory, owner);
        try {
          // Work on a copy: a failed validation cannot partially apply a page.
          const m = fresh(); union(m, this.memory); m.resume = structuredClone(this.memory.resume); m.storageError = STORAGE_ERROR;
          const applied = apply(m);
          if (applied) { this.memory = m; this.scopes.set(owner, m); }
          this.publish(); return applied;
        } catch { this.setFeedError("Invalid conversation update page."); this.publish(); return false; }
      }
    });
  };

  private writeEvidence(owner: string, binding: number): void {
    void this.enqueue(async () => {
      if (!this.current(owner, binding)) return;
      await this.refresh(owner, binding);
      if (this.current(owner, binding) && this.memory.storageError !== STORAGE_ERROR) this.notify();
    });
  }
  observe = (conversations: readonly Conversation[]): void => {
    if (this.scope === null) return;
    this.catalog = new Map(conversations.map(c => [c.id, c]));
    for (const c of conversations) {
      // In feed mode only unqualified OpenCode retains the legacy run fallback.
      const source = catalogSource(c);
      const unqualified = !source || this.memory.resume.coverage.some(row => row.sourceKey === updateSourceKey(source) && row.state === "unqualified");
      if (!this.feedEnabled || c.harness === "opencode" && unqualified) observeLegacy(this.memory.legacy, c);
    }
    this.reconcile(this.memory); this.publish(); this.writeEvidence(this.scope, this.binding);
  };
  acceptRun = (conversationId: string, runId: string): void => {
    if (this.scope === null || !text(conversationId) || !text(runId)) return;
    const c = this.catalog?.get(conversationId), source = c && catalogSource(c);
    const receipt: Accepted = { conversationId, runId, acceptedAt: Math.max(1, Date.now()), ...(source ? { sourceKey: updateSourceKey(source) } : {}) };
    const key = acceptedKey(receipt), old = this.memory.accepted.get(key);
    if (!old) this.memory.accepted.set(key, receipt);
    if (!this.memory.legacy.accepted.has(key)) this.memory.legacy.accepted.set(key, { conversationId, runId, acceptedAt: receipt.acceptedAt,
      ...(c?.nativeSessionId ? { identity: legacyIdentity(c) } : {}) });
    this.reconcile(this.memory); this.publish(); this.writeEvidence(this.scope, this.binding);
  };
  captureOpen = (conversationId: string): NotificationCapture | null => {
    if (this.scope === null) return null;
    const events = this.unreadEvents().filter(r => r.update.conversationId === conversationId);
    const legacy = this.unreadLegacy().filter(r => r.conversationId === conversationId);
    return Object.freeze({ owner: this.scope, binding: this.binding, conversationId,
      sources: Object.freeze([...new Set([...events.map(r => updateSourceKey(r.update.source)), ...legacy.map(r => r.identity)])]),
      ids: Object.freeze(events.map(r => r.update.id)), legacyIds: Object.freeze(legacy.map(legacyKey)) });
  };
  acknowledgeCaptured = (capture: NotificationCapture | null): void => {
    if (!capture || !this.current(capture.owner, capture.binding)) return;
    const at = Math.max(1, Date.now());
    for (const id of capture.ids) {
      const r = this.memory.events.get(id);
      if (r && r.update.conversationId === capture.conversationId && capture.sources.includes(updateSourceKey(r.update.source))
        && this.sourceVisible(capture.conversationId, updateSourceKey(r.update.source))) this.memory.reads.set(id, Math.max(at, this.memory.reads.get(id) ?? 0));
    }
    for (const id of capture.legacyIds) {
      // The record may already have migrated to a canonical event since capture.
      // Its exact old key remains valid; the private mapping transfers that read.
      const legacy = parseLegacyKey(id);
      if (legacy && legacy.conversationId === capture.conversationId && capture.sources.includes(legacy.identity)
        && this.sourceVisible(capture.conversationId, undefined, legacy.identity)) {
        this.memory.legacy.reads.set(id, Math.max(at, this.memory.legacy.reads.get(id) ?? 0));
      }
    }
    this.reconcile(this.memory);
    this.publish(); this.writeEvidence(capture.owner, capture.binding);
  };
  markRead = (conversationId: string): void => this.acknowledgeCaptured(this.captureOpen(conversationId));
}

export const notificationStore = new NotificationStore();
