import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import Fuse from "fuse.js";
import { equivalentSlots, isStoredSlot } from "sane-core/contracts";
import type { SessionCatalogGroup, SessionCatalogPageInfo, SessionCatalogQuery } from "../shared/conversation/session-catalog";
import type { Association } from "./catalog-contract";
import { ConversationRecencyCache } from "./conversation-recency";
import { uuid, type Event, type Run, type Session } from "./history";
import { sessionDisplayTitle } from "./session-list-response";

const TTL_MS = 10 * 60_000, MAX_SNAPSHOTS = 128, MAX_SNAPSHOT_IDS = 250_000, MAX_TOTAL_IDS = 500_000;
export class SessionCatalogError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const invalid = (message: string): never => { throw new SessionCatalogError(400, "session-catalog-input", message); };
const reset = (): never => { throw new SessionCatalogError(409, "session-catalog-reset", "Conversation catalog cursor is invalid or expired; refresh the first page"); };
type Query = Required<Omit<SessionCatalogQuery, "workspaceId" | "worktreeId" | "cursor">> & { workspaceId: string; worktreeId: string; cursor?: string };
const normalizeWorkstream = (value: string) => value.startsWith("workstream:") ? value.slice("workstream:".length) : value;

/** Strict parsing only on the opt-in route; legacy full-list requests are untouched. */
export function sessionCatalogQuery(params: URLSearchParams): Query {
  const text = (key: string, fallback: string, max = 1024) => {
    const values = params.getAll(key);
    if (values.length > 1) invalid(`Duplicate ${key}`);
    const value = values[0] ?? fallback;
    if (value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(`Invalid ${key}`);
    return value;
  };
  if (text("summary", "") !== "1") invalid("Pagination requires summary=1");
  const rawLimit = text("limit", "50"), limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100) invalid("limit must be between 1 and 100");
  const mode = text("mode", "chat"), harness = text("harness", "all"), status = text("status", "all"), showDeleted = text("showDeleted", "0"), availableOnly = text("availableOnly", "0");
  if (mode !== "chat" && mode !== "history") invalid("Invalid mode");
  if (!["all", "opencode", "claude-code"].includes(harness)) invalid("Invalid harness");
  if (!["all", "starting", "running", "completed", "failed", "interrupted", "unknown"].includes(status)) invalid("Invalid status");
  if (showDeleted !== "0" && showDeleted !== "1") invalid("showDeleted must be 0 or 1");
  if (availableOnly !== "0" && availableOnly !== "1") invalid("availableOnly must be 0 or 1");
  const workspaceId = text("workspaceId", "all") || "all", worktreeId = text("worktreeId", "all") || "all";
  if (workspaceId !== "all" && workspaceId !== "unavailable" && !uuid(workspaceId)) invalid("Invalid workspaceId");
  if (worktreeId !== "all" && worktreeId !== "unavailable" && !uuid(worktreeId)) invalid("Invalid worktreeId");
  return { mode: mode as Query["mode"], harness: harness as Query["harness"], status: status as Query["status"],
    workspaceId, worktreeId, workstreamId: text("workstreamId", "all") || "all",
    phase: text("phase", "all") || "all", query: text("q", "", 2000).trim(), showDeleted: showDeleted === "1", availableOnly: availableOnly === "1", limit,
    ...(params.has("cursor") ? { cursor: text("cursor", "", 512) || reset() } : {}) };
}

export function sessionCatalogGroupsQuery(params: URLSearchParams): Query {
  if (params.has("cursor")) invalid("Group directory does not accept cursor");
  return sessionCatalogQuery(params);
}

export function sessionSummaryIds(params: URLSearchParams): string[] {
  const values = params.getAll("ids");
  if (values.length !== 1) invalid("Provide ids as a comma-separated list of at most 100 UUIDs");
  const ids = values[0]!.split(",");
  if (!ids.length || ids.length > 100 || ids.some(id => !uuid(id))) invalid("Provide ids as a comma-separated list of at most 100 UUIDs");
  return [...new Set(ids)];
}

export type SessionCatalogMembership = { workstreamId: string | null; phases: string[] };
type FilterInput = {
  sessions: readonly Session[];
  runs: readonly Run[];
  events: ReadonlyMap<string, readonly Event[]>;
  association(id: string): Association;
  /** Registered read-model identity, used only by grouping/unavailable selectors. */
  groupAssociation?(id: string): Pick<SessionCatalogGroup, "workspaceId" | "worktreeId">;
  status(session: Session): string;
  visible(session: Session): boolean;
  membership: ReadonlyMap<string, SessionCatalogMembership>;
};
type Snapshot = { scope: string; expiresAt: number; ids: string[]; advanced: boolean };

/** One instance per authenticated bridge/store owner. No payloads, journals,
 * admissions or policy results survive requests. Cursors are owner-secret signed
 * offsets bound to all normalized query fields (including page size). */
export class SessionCatalog {
  private readonly secret = randomBytes(32);
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly recency = new ConversationRecencyCache();
  private retainedIds = 0;

  needsMembership(query: Query) { return !query.cursor && (query.workstreamId !== "all" || query.phase !== "all"); }

  private scope(query: Query) { const { cursor: _, ...scope } = query; return JSON.stringify(scope); }
  private sign(value: string) { return createHmac("sha256", this.secret).update(value).digest("base64url"); }
  private remove(id: string) { const old = this.snapshots.get(id); if (old) this.retainedIds -= old.ids.length; this.snapshots.delete(id); }
  private prune() { const now = Date.now(); for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.remove(id); }

  private inAssociationScope(query: Query, input: FilterInput, session: Session): boolean {
    if (query.workspaceId === "all" && query.worktreeId === "all") return true;
    const association = input.association(session.sessionId);
    const group = query.workspaceId === "unavailable" || query.worktreeId === "unavailable"
      ? input.groupAssociation?.(session.sessionId) ?? association : association;
    if (query.workspaceId === "unavailable" ? !!group.workspaceId : query.workspaceId !== "all" && association.workspaceId !== query.workspaceId) return false;
    if (query.worktreeId === "unavailable" ? !!group.worktreeId : query.worktreeId !== "all" && association.worktreeId !== query.worktreeId) return false;
    return true;
  }

  private matching(query: Query, input: FilterInput): Session[] {
    let hits: Set<string> | undefined;
    if (query.query) {
      const runsBySession = new Map<string, Run[]>();
      for (const run of input.runs) { const rows = runsBySession.get(run.sessionId) ?? []; rows.push(run); runsBySession.set(run.sessionId, rows); }
      const rows = input.sessions.map(session => {
        const harness = session.harness ?? "claude-code";
        return { id: session.sessionId, text: `${sessionDisplayTitle(session, runsBySession.get(session.sessionId) ?? [], input.events) || ""} ${session.cwd} ${session.sessionId} ${harness} ${harness === "opencode" ? "OpenCode OC" : "Claude Code CC"}` };
      });
      // Same fuzzy threshold, location independence and zero-hit substring fallback
      // as conversation-filter.tsx. This is title/identity search, not transcripts.
      try {
        const found = new Fuse(rows, { keys: ["text"], threshold: 0.4, ignoreLocation: true, includeScore: false }).search(query.query);
        if (found.length) hits = new Set(found.map(hit => hit.item.id));
      } catch { /* Preserve the existing substring fallback. */ }
      if (!hits) { const lowered = query.query.toLowerCase(); hits = new Set(rows.filter(row => row.text.toLowerCase().includes(lowered)).map(row => row.id)); }
    }
    return input.sessions.filter(session => {
      if (!input.visible(session) || hits && !hits.has(session.sessionId)) return false;
      if (query.harness !== "all" && (session.harness ?? "claude-code") !== query.harness) return false;
      if (query.status !== "all" && input.status(session) !== query.status) return false;
      if (!this.inAssociationScope(query, input, session)) return false;
      const entry = input.membership.get(session.sessionId);
      if (query.workstreamId === "unknown") { if (entry !== undefined) return false; }
      else if (query.workstreamId === "unassigned") { if (!entry || entry.workstreamId !== null) return false; }
      else if (query.workstreamId !== "all" && (!entry?.workstreamId || normalizeWorkstream(entry.workstreamId) !== normalizeWorkstream(query.workstreamId))) return false;
      if (query.phase !== "all" && !entry?.phases.some(phase => isStoredSlot(phase) && isStoredSlot(query.phase) ? equivalentSlots(phase, query.phase) : phase === query.phase)) return false;
      return true;
    });
  }

  groups(query: Query, input: FilterInput): SessionCatalogGroup[] {
    if (query.cursor) invalid("Group directory does not accept cursor");
    const groups = new Map<string, SessionCatalogGroup>();
    for (const session of this.matching(query, input)) {
      const { workspaceId, worktreeId } = input.groupAssociation?.(session.sessionId) ?? input.association(session.sessionId);
      const key = JSON.stringify([workspaceId, worktreeId]), group = groups.get(key);
      if (group) group.total++;
      else groups.set(key, { workspaceId, worktreeId, total: 1 });
    }
    return [...groups.values()].sort((a, b) => (a.workspaceId ?? "").localeCompare(b.workspaceId ?? "")
      || (a.worktreeId ?? "").localeCompare(b.worktreeId ?? ""));
  }

  private ordered(query: Query, input: FilterInput): string[] {
    const matches = this.matching(query, input);
    const updatedAt = this.recency.project(input.runs, input.events);
    return matches.sort((a, b) => (updatedAt.get(b.sessionId) ?? "").localeCompare(updatedAt.get(a.sessionId) ?? "")
      || a.sessionId.localeCompare(b.sessionId)).map(session => session.sessionId);
  }

  select(query: Query, input: FilterInput): { sessions: Session[]; page: SessionCatalogPageInfo } {
    this.prune();
    const scope = this.scope(query);
    let snapshot: Snapshot, snapshotId: string, offset = 0;
    if (query.cursor) {
      const parts = /^([A-Za-z0-9_-]{24})\.(\d{1,7})\.([A-Za-z0-9_-]{43})$/.exec(query.cursor);
      if (!parts) return reset();
      const payload = `${parts[1]}.${parts[2]}`, expected = this.sign(payload);
      if (!timingSafeEqual(Buffer.from(parts[3]!), Buffer.from(expected))) return reset();
      snapshotId = parts[1]!; offset = Number(parts[2]);
      const found = this.snapshots.get(snapshotId);
      if (!found || found.scope !== scope || offset >= found.ids.length) return reset();
      snapshot = found;
      snapshot.advanced = true;
      // LRU among traversals; head polling must not displace them preferentially.
      this.snapshots.delete(snapshotId); this.snapshots.set(snapshotId, snapshot);
    } else {
      const ids = this.ordered(query, input);
      if (ids.length > MAX_SNAPSHOT_IDS) throw new SessionCatalogError(503, "session-catalog-capacity", "Conversation catalog exceeds snapshot capacity; narrow the filters");
      const reusable = [...this.snapshots].reverse().find(([, candidate]) => candidate.scope === scope
        && candidate.ids.length === ids.length && candidate.ids.every((id, index) => id === ids[index]));
      snapshotId = reusable?.[0] ?? randomBytes(18).toString("base64url");
      snapshot = reusable?.[1] ?? { scope, expiresAt: Date.now() + TTL_MS, ids, advanced: false };
      // One-page lookups (notably workspace activation) need no retained state
      // and must not evict a user who is traversing a larger catalog.
      // Reuse never extends the original TTL. A changed membership/order gets a
      // new frozen snapshot; bounded eviction prefers untraversed polling heads.
      if (!reusable && ids.length > query.limit) {
        while (this.snapshots.size >= MAX_SNAPSHOTS || this.retainedIds + ids.length > MAX_TOTAL_IDS) {
          const victim = [...this.snapshots].find(([, candidate]) => !candidate.advanced)?.[0]
            ?? this.snapshots.keys().next().value!;
          this.remove(victim);
        }
        this.snapshots.set(snapshotId, snapshot); this.retainedIds += ids.length;
      }
    }
    const byId = new Map(input.sessions.map(session => [session.sessionId, session]));
    const sessions: Session[] = [];
    // Frozen membership/order and other filters; retirement, visibility and
    // association scope remain fresh. Skipped entries never shift offsets.
    const eligible = (session: Session) => input.visible(session) && this.inAssociationScope(query, input, session);
    while (offset < snapshot.ids.length && sessions.length < query.limit) {
      const session = byId.get(snapshot.ids[offset++]!);
      if (session && eligible(session)) sessions.push(session);
    }
    let next = offset;
    while (next < snapshot.ids.length) { const session = byId.get(snapshot.ids[next]!); if (session && eligible(session)) break; next++; }
    const hasMore = next < snapshot.ids.length, payload = `${snapshotId}.${next}`;
    return { sessions, page: { kind: "partial", nextCursor: hasMore ? `${payload}.${this.sign(payload)}` : null, hasMore } };
  }
}
