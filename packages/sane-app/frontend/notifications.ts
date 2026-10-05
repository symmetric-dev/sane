import type { Conversation } from "./types";

export type NotificationItem = {
  id: string; conversationId: string; runId: string; title: string;
  status: "completed" | "failed" | "interrupted"; time: string;
  workspaceId?: string | null; worktreeId?: string | null;
};
export type NotificationSnapshot = { items: NotificationItem[]; unreadCount: number; storageError: string };

type Observation = {
  identity: string; conversationId: string; runId: string;
  phase: "active" | "other" | "settled";
  observedActive: boolean;
  bornAt: number; touchedAt: number; readAt: number; item?: NotificationItem;
};
type AcceptedRun = { conversationId: string; runId: string; acceptedAt: number; identity?: string };
type Saved = { version: 2; scope: string; floor: number; records: Observation[]; reads: [string, number][]; accepted: AcceptedRun[] };
type Memory = { floor: number; records: Map<string, Observation>; reads: Map<string, number>; accepted: Map<string, AcceptedRun>; error: string };
// Keep the existing storage key so v1 evidence migrates in place. The v2
// payload separates terminal metadata (including seeds) from alert evidence.
const PREFIX = "sane.notifications.v1:";
const LIMIT = 1024, MAX_BYTES = 4 * 1024 * 1024;
const RETENTION_ERROR = "Notification retention exceeds its normal limit. Unread, active, accepted-run and read evidence is preserved; persistence is best-effort up to the browser storage size and quota limits.";
const emptySnapshot = (): NotificationSnapshot => {
  const items: NotificationItem[] = [];
  Object.freeze(items);
  return Object.freeze({ items, unreadCount: 0, storageError: "" });
};
const fresh = (): Memory => ({ floor: 0, records: new Map(), reads: new Map(), accepted: new Map(), error: "" });
const text = (value: unknown, limit = 1024): value is string => typeof value === "string" && !!value && value.length <= limit;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const terminal = (value: unknown): value is NotificationItem["status"] => value === "completed" || value === "failed" || value === "interrupted";
const active = (value: unknown) => value === "starting" || value === "running";
const identityFor = (c: Conversation) => JSON.stringify([c.id, c.harness, c.nativeSessionId ?? c.id, c.cwd]);
const occurrence = (record: Pick<Observation, "identity" | "runId">) => JSON.stringify([record.identity, record.runId]);
const receiptKey = (record: Pick<AcceptedRun, "conversationId" | "runId">) => JSON.stringify([record.conversationId, record.runId]);
const eligible = (c: Conversation) => !c.worker && c.agentKind !== "worker" && !c.hidden && !c.replacedBy;

function validIdentity(value: unknown, conversationId?: string): value is string {
  if (!text(value, 8192)) return false;
  try {
    const identity: unknown = JSON.parse(value);
    return Array.isArray(identity) && identity.length === 4 && (conversationId === undefined || identity[0] === conversationId)
      && text(identity[0]) && text(identity[1], 64) && text(identity[2]) && typeof identity[3] === "string" && identity[3].length <= 4096;
  } catch { return false; }
}
function validOccurrence(value: unknown): value is string {
  if (!text(value, 20000)) return false;
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 && validIdentity(parts[0]) && text(parts[1])
      && JSON.stringify(parts) === value;
  } catch { return false; }
}
function validatedAccepted(value: unknown): AcceptedRun | null {
  if (!object(value) || !text(value.conversationId) || !text(value.runId) || !timestamp(value.acceptedAt)
    || value.identity !== undefined && !validIdentity(value.identity, value.conversationId)) return null;
  return { conversationId: value.conversationId, runId: value.runId, acceptedAt: value.acceptedAt,
    ...(value.identity !== undefined ? { identity: value.identity as string } : {}) };
}
function validatedRecord(value: unknown, legacy = false): Observation | null {
  if (!object(value) || !text(value.identity, 8192) || !text(value.conversationId) || !text(value.runId)
    || value.phase !== "active" && value.phase !== "other" && value.phase !== "settled"
    || !legacy && typeof value.observedActive !== "boolean"
    || !timestamp(value.bornAt) || !timestamp(value.touchedAt) || !timestamp(value.readAt)) return null;
  if (!validIdentity(value.identity, value.conversationId)) return null;
  const record: Observation = { identity: value.identity, conversationId: value.conversationId, runId: value.runId,
    phase: value.phase, observedActive: legacy ? value.phase === "active" || value.item !== undefined : value.observedActive as boolean,
    bornAt: value.bornAt, touchedAt: value.touchedAt, readAt: value.readAt };
  if (value.item !== undefined) {
    const item = value.item;
    if (record.phase !== "settled" || !object(item) || item.id !== occurrence(record) || item.conversationId !== record.conversationId
      || item.runId !== record.runId || !text(item.title, 256) || !terminal(item.status) || !date(item.time)
      || ![item.workspaceId, item.worktreeId].every(id => id === undefined || id === null || text(id))) return null;
    record.item = { id: item.id as string, conversationId: record.conversationId, runId: record.runId,
      title: item.title, status: item.status, time: new Date(item.time).toISOString(),
      ...(item.workspaceId !== undefined ? { workspaceId: item.workspaceId as string | null } : {}),
      ...(item.worktreeId !== undefined ? { worktreeId: item.worktreeId as string | null } : {}) };
  }
  return record;
}

function decode(raw: string, scope: string): Saved {
  if (raw.length > MAX_BYTES) throw new Error("Notification storage is too large.");
  const saved: unknown = JSON.parse(raw);
  if (!object(saved) || saved.version !== 1 && saved.version !== 2 || saved.scope !== scope || !timestamp(saved.floor)
    || !Array.isArray(saved.records)) throw new Error("Invalid notification storage.");
  const legacy = saved.version === 1;
  const records = saved.records.map(value => validatedRecord(value, legacy));
  if (records.some(record => !record)) throw new Error("Invalid notification records.");
  const reads: unknown = legacy ? [] : saved.reads, receipts: unknown = legacy ? [] : saved.accepted;
  if (!Array.isArray(reads) || reads.some(value => !Array.isArray(value) || value.length !== 2
    || !validOccurrence(value[0]) || !timestamp(value[1]) || value[1] === 0) || !Array.isArray(receipts)) throw new Error("Invalid notification evidence.");
  const accepted = receipts.map(validatedAccepted);
  if (accepted.some(value => !value)) throw new Error("Invalid accepted runs.");
  // LIMIT is a compaction target, not a decoder rejection threshold: protected
  // evidence may exceed it. MAX_BYTES remains the hard persistence/decode cap.
  return { version: 2, scope, floor: saved.floor, records: records as Observation[], reads: reads as [string, number][], accepted: accepted as AcceptedRun[] };
}

/** Read acknowledgement is a grow-only marker on an occurrence, not deletion of
 * an array item. Activity evidence is independently grow-only, so a terminal
 * seed from one tab can combine with an active observation from another. */
function mergeRecord(a: Observation, b: Observation): Observation {
  const winner = a.phase === "settled" && b.phase !== "settled" ? a
    : b.phase === "settled" && a.phase !== "settled" ? b
      : a.touchedAt > b.touchedAt ? a : b.touchedAt > a.touchedAt ? b
        : JSON.stringify(a).localeCompare(JSON.stringify(b)) >= 0 ? a : b;
  const items = [a.item, b.item].filter((item): item is NotificationItem => !!item)
    .sort((left, right) => right.time.localeCompare(left.time) || JSON.stringify(right).localeCompare(JSON.stringify(left)));
  return { ...winner, bornAt: Math.min(a.bornAt, b.bornAt), touchedAt: Math.max(a.touchedAt, b.touchedAt),
    observedActive: a.observedActive || b.observedActive,
    readAt: Math.max(a.readAt, b.readAt), ...(items[0] ? { item: items[0], phase: "settled" } : {}) };
}

function mergeAccepted(a: AcceptedRun, b: AcceptedRun): AcceptedRun {
  // A stale unbound receipt cannot undo a native binding. Conflicting bindings
  // resolve deterministically; evidence already attached to records is retained.
  const identity = [a.identity, b.identity].filter((value): value is string => value !== undefined).sort()[0];
  return { conversationId: a.conversationId, runId: a.runId, acceptedAt: Math.min(a.acceptedAt, b.acceptedAt),
    ...(identity !== undefined ? { identity } : {}) };
}

class NotificationStore {
  private listeners = new Set<() => void>();
  private scopes = new Map<string, Memory>();
  private scope: string | null = null;
  private memory = fresh();
  private lastRaw: string | null | undefined;
  private state = emptySnapshot();
  private visible: Set<string> | null = null;
  private identities = new Map<string, string>();
  snapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  private publish() {
    const grouped = new Map<string, NotificationItem>();
    if (this.scope !== null) for (const record of this.memory.records.values()) {
      if (!record.observedActive || !record.item || record.readAt || this.memory.reads.has(occurrence(record))
        || this.visible && !this.visible.has(record.identity)) continue;
      const old = grouped.get(record.conversationId), item = record.item;
      if (!old || item.time > old.time || item.time === old.time && item.id > old.id) grouped.set(record.conversationId, item);
    }
    const items = [...grouped.values()].sort((a, b) => b.time.localeCompare(a.time) || b.id.localeCompare(a.id));
    const next = { items, unreadCount: items.length,
      storageError: this.scope === null ? "" : this.memory.error || (this.retainedSize() > LIMIT ? RETENTION_ERROR : "") };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    items.forEach(item => Object.freeze(item)); Object.freeze(items);
    this.state = Object.freeze(next); this.listeners.forEach(fn => fn());
  }

  private prune() {
    for (const [key, record] of this.memory.records) {
      if (record.readAt) this.memory.reads.set(key, Math.max(record.readAt, this.memory.reads.get(key) ?? 0));
      if (this.memory.reads.has(key) || !record.observedActive && record.bornAt <= this.memory.floor) this.memory.records.delete(key);
    }
    const excess = this.retainedSize() - LIMIT;
    if (excess <= 0) return;
    const historical = [...this.memory.records.values()].filter(record => !record.observedActive)
      .sort((a, b) => a.bornAt - b.bornAt || occurrence(a).localeCompare(occurrence(b)));
    for (const record of historical.slice(0, excess)) {
      this.memory.floor = Math.max(this.memory.floor, record.bornAt);
      this.memory.records.delete(occurrence(record));
    }
    // Floors compact only historical seeds. They must never erase unread or
    // observed-active runs, even when imported from an older tab. Read markers
    // are minimal, permanent evidence preventing acknowledged runs resurfacing.
    for (const [key, record] of this.memory.records) if (!record.observedActive && record.bornAt <= this.memory.floor) this.memory.records.delete(key);
  }
  private retainedSize() { return this.memory.records.size + this.memory.reads.size + this.memory.accepted.size; }
  private applyAccepted() {
    for (const [key, record] of this.memory.records) {
      const accepted = this.memory.accepted.get(receiptKey(record));
      if (accepted?.identity === record.identity && !record.observedActive) this.memory.records.set(key, { ...record, observedActive: true });
    }
  }
  private merge(saved: Saved) {
    this.memory.floor = Math.max(this.memory.floor, saved.floor);
    for (const [key, readAt] of saved.reads) this.memory.reads.set(key, Math.max(readAt, this.memory.reads.get(key) ?? 0));
    for (const accepted of saved.accepted) {
      const key = receiptKey(accepted), previous = this.memory.accepted.get(key);
      this.memory.accepted.set(key, previous ? mergeAccepted(previous, accepted) : accepted);
    }
    for (const record of saved.records) {
      const key = occurrence(record), previous = this.memory.records.get(key);
      this.memory.records.set(key, previous ? mergeRecord(previous, record) : record);
    }
    this.applyAccepted(); this.prune();
  }
  private serialized() {
    if (this.scope === null) return "";
    return JSON.stringify({ version: 2, scope: this.scope, floor: this.memory.floor,
      records: [...this.memory.records.values()].sort((a, b) => occurrence(a).localeCompare(occurrence(b))),
      reads: [...this.memory.reads].sort(([a], [b]) => a.localeCompare(b)),
      accepted: [...this.memory.accepted.values()].sort((a, b) => receiptKey(a).localeCompare(receiptKey(b))) } satisfies Saved);
  }
  private storageFailure() {
    this.memory.error = "Notifications are stored in memory only while browser storage is unavailable or invalid. They may not survive a reload or sync across tabs.";
  }
  private readStorage() {
    if (this.scope === null) return;
    try {
      if (typeof window === "undefined") throw new Error("Browser storage unavailable.");
      const raw = window.localStorage.getItem(PREFIX + this.scope);
      if (raw !== this.lastRaw) {
        if (raw !== null) this.merge(decode(raw, this.scope));
        this.lastRaw = raw;
      }
    } catch { this.storageFailure(); }
  }
  private persist() {
    if (this.scope === null) return;
    // Every write unions the latest disk value; storage events also repair a
    // concurrent stale write rather than replacing newer read markers.
    this.readStorage(); this.prune();
    try {
      if (typeof window === "undefined") throw new Error("Browser storage unavailable.");
      const key = PREFIX + this.scope, raw = this.serialized();
      if (raw.length > MAX_BYTES) throw new Error("Notification storage is too large.");
      if (window.localStorage.getItem(key) !== raw) window.localStorage.setItem(key, raw);
      this.lastRaw = raw;
      this.memory.error = "";
    } catch { this.storageFailure(); }
    this.publish();
  }
  private onStorage = (event: StorageEvent) => {
    if (this.scope === null || event.key !== PREFIX + this.scope) return;
    try {
      if (event.storageArea !== window.localStorage) return;
      if (event.newValue !== null) this.merge(decode(event.newValue, this.scope));
    } catch { this.storageFailure(); this.publish(); return; }
    this.persist();
  };

  activate = (scope: string): void => {
    // No localStorage read, event listener or visible persisted data before the
    // owner supplies an authenticated bridge scope.
    if (this.scope === scope) return;
    this.suspend(); this.scope = scope;
    this.memory = this.scopes.get(scope) ?? fresh();
    this.scopes.delete(scope); this.scopes.set(scope, this.memory);
    while (this.scopes.size > 8) {
      const historical = [...this.scopes].find(([key, memory]) => key !== scope && !memory.reads.size && !memory.accepted.size
        && ![...memory.records.values()].some(record => record.observedActive || record.readAt));
      if (!historical) break;
      this.scopes.delete(historical[0]);
    }
    this.readStorage();
    if (typeof window !== "undefined") window.addEventListener("storage", this.onStorage);
    this.publish();
  };
  suspend = (): void => {
    if (typeof window !== "undefined") window.removeEventListener("storage", this.onStorage);
    this.scope = null; this.lastRaw = undefined; this.visible = null; this.identities.clear(); this.publish();
  };

  acceptRun = (conversationId: string, runId: string): void => {
    if (this.scope === null || !text(conversationId) || !text(runId)) return;
    this.readStorage();
    const receipt: AcceptedRun = { conversationId, runId, acceptedAt: Math.max(1, Date.now()) };
    const key = receiptKey(receipt);
    if (this.memory.accepted.has(key)) { this.publish(); return; }
    // Receipts carry no native identity. Retain trusted App/run evidence until
    // an actual listing supplies the matching stable binding, even after reload.
    this.memory.accepted.set(key, receipt); this.persist();
  };

  observe = (conversations: readonly Conversation[]): void => {
    if (this.scope === null) return;
    this.readStorage();
    this.visible = new Set(); this.identities.clear();
    let changed = false;
    const now = Math.max(Date.now(), this.memory.floor + 1);
    // Distinct logical birth times avoid evicting an entire first-load batch
    // when many observations arrive in the same millisecond.
    let birth = now;
    for (const record of this.memory.records.values()) birth = Math.max(birth, record.bornAt);
    for (const c of conversations) {
      const identity = identityFor(c);
      this.identities.set(c.id, identity);
      if (eligible(c)) this.visible.add(identity);
      if (!text(c.lastRunId)) continue;
      const acceptedKey = receiptKey({ conversationId: c.id, runId: c.lastRunId });
      let accepted = this.memory.accepted.get(acceptedKey);
      if (accepted && accepted.identity === undefined && text(c.nativeSessionId) && validIdentity(identity, c.id)) {
        accepted = { ...accepted, identity };
        this.memory.accepted.set(acceptedKey, accepted); changed = true;
      }
      const status = c.lastRunStatus ?? c.status;
      const allowed = eligible(c) && c.lastRunOperation !== "compact";
      const phase: Observation["phase"] = terminal(status) ? "settled" : allowed && active(status) ? "active" : "other";
      const key = occurrence({ identity, runId: c.lastRunId }), previous = this.memory.records.get(key);
      if (this.memory.reads.has(key)) continue;
      const record: Observation = { identity, conversationId: c.id, runId: c.lastRunId, phase,
        observedActive: !!previous?.observedActive || allowed && (active(status) || accepted?.identity === identity),
        bornAt: previous?.bornAt ?? ++birth, touchedAt: Math.max(now, (previous?.touchedAt ?? 0) + 1), readAt: previous?.readAt ?? 0 };
      // Always retain eligible terminal metadata, but publish it only with
      // independent active/receipt evidence. A historical seed alone is silent.
      if (allowed && terminal(status)) {
        const time = date(c.lastRunEndedAt) ? c.lastRunEndedAt : date(c.updatedAt) ? c.updatedAt
          : previous?.item?.status === status ? previous.item.time : new Date(now).toISOString();
        record.item = { id: key, conversationId: c.id, runId: c.lastRunId, title: c.title?.trim().slice(0, 256) || "Conversation", status, time: new Date(time).toISOString(),
          ...(c.workspaceId !== undefined ? { workspaceId: c.workspaceId } : {}), ...(c.worktreeId !== undefined ? { worktreeId: c.worktreeId } : {}) };
      }
      // Validate API-derived persistence too: a malformed projection must not
      // poison all saved records or turn optional storage into a startup gate.
      if (!validatedRecord(record)) continue;
      const merged = previous ? mergeRecord(previous, record) : record;
      if (previous && merged.phase === previous.phase && merged.observedActive === previous.observedActive
        && merged.readAt === previous.readAt && JSON.stringify(merged.item) === JSON.stringify(previous.item)) continue;
      this.memory.records.set(key, merged); changed = true;
    }
    this.applyAccepted();
    if (changed) this.persist(); else this.publish();
  };

  markRead = (conversationId: string): void => {
    if (this.scope === null) return;
    this.readStorage();
    const identity = this.identities.get(conversationId);
    let changed = false;
    for (const [key, record] of this.memory.records) {
      if (record.conversationId !== conversationId || identity && record.identity !== identity
        || !record.observedActive || !record.item || record.readAt || this.memory.reads.has(key)) continue;
      this.memory.reads.set(key, Math.max(1, Date.now())); changed = true;
    }
    if (changed) this.persist(); else this.publish();
  };
}

export const notificationStore = new NotificationStore();
