import type { Conversation } from "./types";

export type LegacyItem = {
  id: string; conversationId: string; runId: string; title: string;
  status: "completed" | "failed" | "interrupted"; time: string;
  workspaceId?: string | null; worktreeId?: string | null;
};
export type LegacyRecord = {
  identity: string; conversationId: string; runId: string;
  phase: "active" | "other" | "settled"; observedActive: boolean;
  bornAt: number; touchedAt: number; readAt: number; item?: LegacyItem;
};
export type LegacyReceipt = { conversationId: string; runId: string; acceptedAt: number; identity?: string };
export type LegacyState = {
  floor: number; records: Map<string, LegacyRecord>; reads: Map<string, number>;
  accepted: Map<string, LegacyReceipt>; tombstones: Set<string>; mappings: Map<string, string>;
};
export const LEGACY_PREFIX = "sane.notifications.v1:";
export const text = (v: unknown, limit = 1024): v is string => typeof v === "string" && !!v.trim() && v.length <= limit;
export const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const date = (v: unknown): v is string => text(v, 64) && Number.isFinite(Date.parse(v));
export const terminal = (v: unknown): v is LegacyItem["status"] => v === "completed" || v === "failed" || v === "interrupted";
export const active = (v: unknown) => v === "starting" || v === "running";
export const legacyIdentity = (c: Conversation) => JSON.stringify([c.id, c.harness, c.nativeSessionId ?? c.id, c.cwd]);
export const legacyKey = (r: Pick<LegacyRecord, "identity" | "runId">) => JSON.stringify([r.identity, r.runId]);
export const receiptKey = (r: Pick<LegacyReceipt, "conversationId" | "runId">) => JSON.stringify([r.conversationId, r.runId]);
export const freshLegacy = (): LegacyState => ({ floor: 0, records: new Map(), reads: new Map(), accepted: new Map(), tombstones: new Set(), mappings: new Map() });

function identity(v: unknown, conversationId?: string): v is string {
  if (!text(v, 8192)) return false;
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) && a.length === 4 && text(a[0]) && text(a[1], 64) && text(a[2])
      && typeof a[3] === "string" && a[3].length <= 4096 && (conversationId === undefined || a[0] === conversationId)
      && JSON.stringify(a) === v;
  } catch { return false; }
}
function occurrence(v: unknown): v is string {
  if (!text(v, 20000)) return false;
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) && a.length === 2 && identity(a[0]) && text(a[1]) && JSON.stringify(a) === v;
  } catch { return false; }
}
export function parseLegacyKey(value: unknown): { identity: string; conversationId: string; runId: string } | null {
  if (!occurrence(value)) return null;
  const [nativeIdentity, runId] = JSON.parse(value) as [string, string];
  const tuple = JSON.parse(nativeIdentity) as [string, string, string, string];
  return { identity: nativeIdentity, conversationId: tuple[0], runId };
}
function record(v: unknown, v1: boolean): LegacyRecord | null {
  if (!object(v) || !text(v.conversationId) || !identity(v.identity, v.conversationId) || !text(v.runId)
    || !["active", "other", "settled"].includes(v.phase as string)
    || !v1 && typeof v.observedActive !== "boolean"
    || !integer(v.bornAt) || !integer(v.touchedAt) || !integer(v.readAt)) return null;
  const r: LegacyRecord = { identity: v.identity, conversationId: v.conversationId, runId: v.runId,
    phase: v.phase as LegacyRecord["phase"], observedActive: v1 ? v.phase === "active" || v.item !== undefined : v.observedActive as boolean,
    bornAt: v.bornAt, touchedAt: v.touchedAt, readAt: v.readAt };
  if (v.item !== undefined) {
    const i = v.item;
    if (r.phase !== "settled" || !object(i) || i.id !== legacyKey(r) || i.conversationId !== r.conversationId
      || i.runId !== r.runId || !text(i.title, 256) || !terminal(i.status) || !date(i.time)
      || ![i.workspaceId, i.worktreeId].every(id => id === undefined || id === null || text(id))) return null;
    r.item = { id: i.id as string, conversationId: r.conversationId, runId: r.runId, title: i.title,
      status: i.status, time: new Date(i.time).toISOString(),
      ...(i.workspaceId !== undefined ? { workspaceId: i.workspaceId as string | null } : {}),
      ...(i.worktreeId !== undefined ? { worktreeId: i.worktreeId as string | null } : {}) };
  }
  return r;
}
function receipt(v: unknown): LegacyReceipt | null {
  if (!object(v) || !text(v.conversationId) || !text(v.runId) || !integer(v.acceptedAt)
    || v.identity !== undefined && !identity(v.identity, v.conversationId)) return null;
  return { conversationId: v.conversationId, runId: v.runId, acceptedAt: v.acceptedAt,
    ...(v.identity !== undefined ? { identity: v.identity as string } : {}) };
}

/** Invalid individual legacy rows are skipped, not allowed to poison valid evidence. */
export function decodeLegacy(value: unknown, scope?: string): LegacyState {
  const v: unknown = typeof value === "string"
    ? value.length <= 4 * 1024 * 1024 ? JSON.parse(value) : null : value;
  if (!object(v) || ![1, 2].includes(v.version as number) || scope !== undefined && v.scope !== scope
    || !integer(v.floor) || !Array.isArray(v.records)) throw new Error("Invalid legacy notification storage.");
  const state = freshLegacy(); state.floor = v.floor;
  for (const raw of v.records) {
    const r = record(raw, v.version === 1);
    if (r) { state.records.set(legacyKey(r), r); if (r.readAt) state.reads.set(legacyKey(r), r.readAt); }
  }
  if (Array.isArray(v.reads)) for (const pair of v.reads) {
    if (Array.isArray(pair) && pair.length === 2 && occurrence(pair[0]) && integer(pair[1]) && pair[1] > 0) state.reads.set(pair[0], pair[1]);
  }
  if (Array.isArray(v.accepted)) for (const raw of v.accepted) {
    const r = receipt(raw); if (r) state.accepted.set(receiptKey(r), r);
  }
  if (scope === undefined && Array.isArray(v.tombstones)) for (const key of v.tombstones) if (occurrence(key)) state.tombstones.add(key);
  if (scope === undefined && Array.isArray(v.mappings)) for (const pair of v.mappings) {
    if (Array.isArray(pair) && pair.length === 2 && occurrence(pair[0]) && text(pair[1], 16384)) {
      state.mappings.set(pair[0], pair[1]); state.tombstones.add(pair[0]);
    }
  }
  return state;
}
export function serializeLegacy(s: LegacyState) {
  return { version: 2, floor: s.floor, records: [...s.records.values()], reads: [...s.reads],
    accepted: [...s.accepted.values()], tombstones: [...s.tombstones], mappings: [...s.mappings] };
}
export function mergeLegacy(a: LegacyState, b: LegacyState): void {
  a.floor = Math.max(a.floor, b.floor);
  for (const key of b.tombstones) a.tombstones.add(key);
  for (const [key, id] of b.mappings) if (!a.mappings.has(key)) a.mappings.set(key, id);
  for (const [key, at] of b.reads) a.reads.set(key, Math.max(at, a.reads.get(key) ?? 0));
  for (const [key, r] of b.accepted) {
    const old = a.accepted.get(key);
    a.accepted.set(key, { ...r, acceptedAt: Math.min(r.acceptedAt, old?.acceptedAt ?? r.acceptedAt),
      ...((old?.identity ?? r.identity) ? { identity: old?.identity ?? r.identity } : {}) });
  }
  for (const [key, r] of b.records) {
    if (a.tombstones.has(key)) continue;
    const old = a.records.get(key);
    const winner = old && (old.phase === "settled" && r.phase !== "settled" || old.touchedAt > r.touchedAt) ? old : r;
    a.records.set(key, { ...winner, observedActive: !!old?.observedActive || r.observedActive,
      bornAt: Math.min(old?.bornAt ?? r.bornAt, r.bornAt), touchedAt: Math.max(old?.touchedAt ?? 0, r.touchedAt),
      readAt: Math.max(old?.readAt ?? 0, r.readAt) });
  }
  for (const key of a.tombstones) a.records.delete(key);
}

export function observeLegacy(s: LegacyState, c: Conversation): void {
  if (!text(c.lastRunId)) return;
  const id = legacyIdentity(c), key = legacyKey({ identity: id, runId: c.lastRunId });
  if (s.tombstones.has(key)) return;
  const status = c.lastRunStatus ?? c.status, old = s.records.get(key), now = Math.max(1, Date.now());
  const allowed = !c.worker && c.agentKind !== "worker" && !c.hidden && !c.replacedBy && c.lastRunOperation !== "compact";
  const accepted = s.accepted.get(receiptKey({ conversationId: c.id, runId: c.lastRunId }));
  if (accepted && !accepted.identity && text(c.nativeSessionId)) accepted.identity = id;
  const r: LegacyRecord = { identity: id, conversationId: c.id, runId: c.lastRunId,
    phase: terminal(status) ? "settled" : active(status) ? "active" : "other",
    observedActive: !!old?.observedActive || allowed && (active(status) || accepted?.identity === id),
    bornAt: old?.bornAt ?? now, touchedAt: now, readAt: Math.max(old?.readAt ?? 0, s.reads.get(key) ?? 0) };
  if (allowed && terminal(status)) r.item = { id: key, conversationId: c.id, runId: c.lastRunId,
    title: c.title?.trim().slice(0, 256) || "Conversation", status,
    time: new Date(date(c.lastRunEndedAt) ? c.lastRunEndedAt : date(c.updatedAt) ? c.updatedAt : old?.item?.time ?? now).toISOString(),
    ...(c.workspaceId !== undefined ? { workspaceId: c.workspaceId } : {}),
    ...(c.worktreeId !== undefined ? { worktreeId: c.worktreeId } : {}) };
  if (!record(r, false)) return;
  const incoming = freshLegacy(); incoming.records.set(key, r);
  mergeLegacy(s, incoming);
  const merged = s.records.get(key);
  if (old && merged && old.phase === merged.phase && old.observedActive === merged.observedActive
    && old.readAt === merged.readAt && JSON.stringify(old.item) === JSON.stringify(merged.item)) s.records.set(key, old);
}
