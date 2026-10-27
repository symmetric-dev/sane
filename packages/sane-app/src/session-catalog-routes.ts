import type { SessionCatalogGroupsResponse, SessionCatalogPageInfo } from "../shared/conversation/session-catalog";
import { json } from "./bridge-http";
import type { Association, WorkspaceRecord, WorktreeRecord } from "./catalog-contract";
import type { Event, Run, Session } from "./history";
import { sessionCatalogGroupsQuery, sessionCatalogQuery, sessionSummaryIds, type SessionCatalog, type SessionCatalogMembership } from "./session-catalog";
import type { SessionListProjection } from "./session-list-projection";
import { sessionListResponse, type SessionListAvailability, type SessionListResponseInput, type SessionListRow } from "./session-list-response";
import type { WorkstreamAdapter } from "./workstreams";

/** Registered identity metadata only; this is not a filesystem capability. */
export interface RegisteredWorkspace {
  readonly workspaceId: WorkspaceRecord["workspaceId"];
  readonly worktrees: readonly Pick<WorktreeRecord, "worktreeId" | "state">[];
}

export interface SessionCatalogRoutePorts {
  /** The existing owner-scoped selection instance retains cursor ownership. */
  selection: Pick<SessionCatalog, "needsMembership" | "select" | "groups">;
  registeredWorkspaces(): Promise<readonly RegisteredWorkspace[]>;
  registeredWorkspace(id: string): Promise<RegisteredWorkspace>;
  association(id: string): Association;
  /** Live read-only references, captured again after all asynchronous reads. */
  current(): {
    sessions: readonly Session[];
    active: readonly Session[];
    runs: readonly Run[];
    events: ReadonlyMap<string, readonly Event[]>;
  };
  /** The root resolves polling readers and handles only its known absence errors. */
  openMembership(id: string): Promise<((sessions: readonly Session[]) => ReturnType<WorkstreamAdapter["overview"]>) | undefined>;
  /** The root owns demand, deferred refresh, and synchronous evidence capture. */
  capturePresentation(): {
    indexes: SessionListProjection;
    native: { value: SessionListResponseInput["native"]["active"]; error?: never } | { value?: never; error: string };
  };
  projectRow(session: Session, summary: boolean, indexes: SessionListProjection): SessionListRow;
  globalAvailability(indexes: SessionListProjection): SessionListAvailability;
  followupPending(requestId: string): boolean;
  isRetired(session: Session): boolean;
  isWorkerSession(id: string): boolean;
}

export function matchesSessionCatalogRoute(req: Request, url: URL): boolean {
  return req.method === "GET" && (url.pathname === "/api/sessions"
    || url.pathname === "/api/sessions/summaries" || url.pathname === "/api/sessions/groups");
}

/** HTTP parsing and synchronous catalog projection, without execution authority. */
export function createSessionCatalogRoute(ports: SessionCatalogRoutePorts) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    if (!matchesSessionCatalogRoute(req, url)) return null;
    const directory = url.pathname === "/api/sessions/groups";
    const targeted = url.pathname === "/api/sessions/summaries";
    const query = directory ? sessionCatalogGroupsQuery(url.searchParams)
      : !targeted && (url.searchParams.has("limit") || url.searchParams.has("cursor")) ? sessionCatalogQuery(url.searchParams) : undefined;
    const requestedIds = targeted ? sessionSummaryIds(url.searchParams) : undefined;
    const summary = targeted || url.searchParams.get("summary") === "1";
    // Missing filesystem state does not erase a recorded tree's identity.
    // Normalize only grouping identity, never the source association DTO.
    const registered = query && (directory || query.workspaceId === "unavailable" || query.worktreeId === "unavailable")
      ? await ports.registeredWorkspaces() : undefined;
    const registeredTrees = registered ? new Map(registered.map(workspace => [workspace.workspaceId,
      new Set(workspace.worktrees.map(tree => tree.worktreeId))])) : undefined;
    const groupAssociation = (id: string) => {
      const association = ports.association(id), trees = registeredTrees?.get(association.workspaceId ?? "");
      if (!trees) return { workspaceId: null, worktreeId: null };
      return { workspaceId: association.workspaceId, worktreeId: trees.has(association.worktreeId!) ? association.worktreeId : null };
    };
    // Resolve readers only for filtered snapshots that need domain membership.
    // Do not retain this early session view across the asynchronous reads.
    const membershipReaders = new Map<string, (sessions: readonly Session[]) => ReturnType<WorkstreamAdapter["overview"]>>();
    if (query && ports.selection.needsMembership(query)) {
      const workspaceIds = new Set(ports.current().active.filter(session => query.workspaceId !== "unavailable" || !groupAssociation(session.sessionId).workspaceId)
        .map(session => ports.association(session.sessionId).workspaceId)
        .filter((id): id is string => !!id && (!registeredTrees || registeredTrees.has(id))
          && (query.workspaceId === "all" || query.workspaceId === "unavailable" || query.workspaceId === id)));
      for (const workspaceId of workspaceIds) {
        const reader = await ports.openMembership(workspaceId);
        if (reader) membershipReaders.set(workspaceId, reader);
      }
    }
    const availableWorktrees = new Set<string>();
    if (query?.availableOnly) {
      const workspaces = query.workspaceId !== "all" && query.workspaceId !== "unavailable"
        ? [await ports.registeredWorkspace(query.workspaceId)] : registered ?? await ports.registeredWorkspaces();
      for (const workspace of workspaces) for (const tree of workspace.worktrees) if (tree.state === "available") {
        availableWorktrees.add(JSON.stringify([workspace.workspaceId, tree.worktreeId]));
      }
    }
    // All asynchronous reads precede this view. Membership, policy, selection,
    // row projection and DTO construction consume it synchronously below.
    const view = ports.current();
    const active = view.active;
    const membership = new Map<string, SessionCatalogMembership>();
    for (const [workspaceId, reader] of membershipReaders) {
      const overview = reader(active.filter(session => ports.association(session.sessionId).workspaceId === workspaceId));
      const refKey = (ref: { harness: string; authorityId: string; nativeId: string }) => JSON.stringify([ref.harness, ref.authorityId, ref.nativeId]);
      const phases = new Map<string, string[]>();
      for (const assignment of overview.workstreams.flatMap(workstream => workstream.activePhases)) {
        const key = refKey(assignment.ref), values = phases.get(key) ?? [];
        values.push(assignment.phase); phases.set(key, values);
      }
      for (const row of overview.conversations) if (row.sessionId) membership.set(row.sessionId, {
        workstreamId: row.conversation?.workstreamId ?? null, phases: row.ref ? phases.get(refKey(row.ref)) ?? [] : [],
      });
    }
    const { indexes, native } = ports.capturePresentation();
    let selected = active;
    let page: SessionCatalogPageInfo | undefined;
    const missing: { sessionId: string; reason: "retired" | "not-found" }[] = [];
    if (requestedIds) {
      const current = new Map(view.sessions.map(session => [session.sessionId, session]));
      selected = requestedIds.flatMap(sessionId => {
        const session = current.get(sessionId);
        if (!session || ports.isRetired(session)) {
          missing.push({ sessionId, reason: session ? "retired" : "not-found" }); return [];
        }
        return [session];
      });
    } else if (query) {
      const visible = (session: Session) => {
        if (query.availableOnly) {
          const association = ports.association(session.sessionId);
          if (association.association !== "resolved" || !availableWorktrees.has(JSON.stringify([association.workspaceId, association.worktreeId]))) return false;
        }
        const replaced = indexes.replaced.has(session.sessionId);
        if (query.mode === "chat" && (session.agentKind === "worker" || ports.isWorkerSession(session.sessionId) || replaced)) return false;
        return query.showDeleted || !session.hidden || query.mode === "history" && replaced;
      };
      const filterInput = { sessions: active, runs: view.runs, events: view.events, membership,
        association: (id: string) => ports.association(id), groupAssociation, visible,
        status: (session: Session) => session.harness === "opencode" && native.value?.[session.nativeSessionId!]
          ? "running" : session.lastStatus,
      };
      if (directory) return json({ groups: ports.selection.groups(query, filterInput),
        availability: ports.globalAvailability(indexes),
      } satisfies SessionCatalogGroupsResponse);
      const selection = ports.selection.select(query, filterInput);
      selected = selection.sessions; page = selection.page;
    }
    // Selection precedes per-row policy, admission, followup and DTO projection.
    const rows = selected.map(session => ports.projectRow(session, summary, indexes));
    return json({ ...sessionListResponse({
      rows, presentation: summary ? "summary" : "full", runs: view.runs, events: view.events, indexes,
      native: { active: native.value ?? {}, error: native.error ?? "" },
      availability: ports.globalAvailability(indexes),
    }, { followupPending: requestId => ports.followupPending(requestId) }), ...(page ? { page } : {}), ...(targeted ? { missing } : {}) });
  };
}
