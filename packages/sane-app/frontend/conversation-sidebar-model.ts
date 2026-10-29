import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import { defaultFilterFor, filterConversations, type ConversationFilterState, type WorkstreamMembership } from "./conversation-filter";
import { buildWorkstreamMap } from "./conversation-filter-dialog";
import { useMessageHitsState, useWorkstreamOverviewState } from "./conversation-hooks";
import { conversationQueryKey } from "./conversation-listing";
import { conversationGroupPageSize } from "./conversation-group-listing";
import type { Conversation, SessionCatalogQuery } from "./types";
import { workerReference as knownWorker, useWorkerDiscovery, directWorkerCounts } from "./worker-client";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { workstreamCheckout } from "./workstream-checkout";
import { readWorkstreamSelection, saveWorkstreamSelection } from "./workstream-selection-storage";
import { readWorkstreamMembership, saveWorkstreamMembership } from "./workstream-membership-storage";
import { workspaceEpoch } from "./workspace-store";
import { refreshWorkspaceActivation, resolveWorkspaceActivation, workspaceSelectionBlocked } from "./workspace-activation";
import { conversationSidebarBinding, conversationSidebarBucketDirectory, type WorktreeBucket } from "./conversation-sidebar-buckets";

export type ConversationSidebarMode = "chat" | "history";

export type WorkspaceSelectionModel = {
  workstreamId: string | null;
  overview: WorkstreamOverview | null;
  loading: boolean;
  error: string;
  blocked: boolean;
  selectionError: string;
  setOpen: (open: boolean) => void;
  isOpen: () => boolean;
  selectWorkspace: (workspaceId: string, preferredWorktreeId?: string) => boolean;
  goWorkspace: (workspaceId: string) => boolean;
  selectWorktree: (worktreeId: string, workspaceId?: string) => void;
  selectWorkstream: (workstreamId: string | null) => void;
};

type SidebarContext = { workspaceId: string | null; worktreeId: string | null; workstreamId: string | null; filter: ConversationFilterState };
const contextDefaults = (workspaceId: string | null, worktreeId: string | null, workstreamId: string | null) => ({
  ...defaultFilterFor(workspaceId, workstreamId ? null : worktreeId),
  workstreamId: workstreamId ? `workstream:${workstreamId}` : "all",
});
function rebaseContext(context: SidebarContext, workspaceId: string | null, worktreeId: string | null): SidebarContext {
  if (context.workspaceId === workspaceId && context.worktreeId === worktreeId) return context;
  // Moving between worktrees keeps explicit workspace filters and workstream scope.
  if (context.workspaceId === workspaceId) return { ...context, worktreeId };
  return { workspaceId, worktreeId, workstreamId: null, filter: contextDefaults(workspaceId, worktreeId, null) };
}

/** Mount once in the shell; pass the same model to desktop and drawer sidebars. */
export function useConversationSidebarModel(state: State, mode: ConversationSidebarMode, selectedId: string | null = state.selected) {
  const workerDiscovery = useWorkerDiscovery();
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const auth = workspaceEpoch();
  const nav = repository.navigation;
  const [savedContext, setContext] = useState<SidebarContext>(() => ({ workspaceId: nav.workspaceId, worktreeId: nav.worktreeId, workstreamId: null, filter: contextDefaults(nav.workspaceId, nav.worktreeId, null) }));
  const [selectionRestored, setSelectionRestored] = useState(false);
  const [worktreeSelectionVersion, setWorktreeSelectionVersion] = useState(0);
  const [expansion, setExpansion] = useState<{ auth: typeof auth; values: Record<string, boolean> }>({ auth, values: {} });
  const expandedWorktrees = expansion.auth === auth ? expansion.values : {};
  const setWorktreeExpanded = useCallback((key: string, expanded: boolean) => {
    setExpansion(previous => ({ auth, values: { ...(previous.auth === auth ? previous.values : {}), [key]: expanded } }));
  }, [auth]);
  const currentWorktreeKey = nav.workspaceId && nav.worktreeId ? `${nav.workspaceId}:${nav.worktreeId}` : null;
  const isWorktreeExpanded = useCallback((key: string) => expandedWorktrees[key] ?? key === currentWorktreeKey, [expandedWorktrees, currentWorktreeKey]);
  useEffect(() => {
    if (currentWorktreeKey) setWorktreeExpanded(currentWorktreeKey, true);
  }, [currentWorktreeKey, worktreeSelectionVersion, setWorktreeExpanded]);
  const context = rebaseContext(savedContext, nav.workspaceId, nav.worktreeId);
  const { filter } = context;
  // Fence resets by scope: an explicit modal selection updates navigation and
  // filters together, so this effect cannot overwrite its workstream filter.
  useEffect(() => { setContext(current => rebaseContext(current, nav.workspaceId, nav.worktreeId)); }, [nav.workspaceId, nav.worktreeId]);
  useEffect(() => {
    if (!repository.ready || selectionRestored) return;
    const current = catalog.snapshot();
    if (!current.ready) return;
    const saved = readWorkstreamSelection();
    const { workspaceId, worktreeId } = current.navigation;
    if (saved && saved.workspaceId === workspaceId) {
      // Restore context only, never re-run selection or move the browsing checkout.
      setContext({ workspaceId, worktreeId, workstreamId: saved.workstreamId, filter: saved.filter });
    }
    setSelectionRestored(true);
  }, [repository.ready, selectionRestored]);
  const setFilter = useCallback((filter: ConversationFilterState) => {
    const { workspaceId, worktreeId } = catalog.snapshot().navigation;
    setSelectionRestored(true);
    const next = { ...rebaseContext(savedContext, workspaceId, worktreeId), filter };
    saveWorkstreamSelection(workspaceId, next.workstreamId, filter);
    setContext(next);
  }, [savedContext]);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const selectorOpenRef = useRef(false);
  const [selectionError, setSelectionError] = useState("");
  const setOpen = useCallback((open: boolean) => { selectorOpenRef.current = open; setSelectorOpen(open); if (open) setSelectionError(""); }, []);
  const isOpen = useCallback(() => selectorOpenRef.current, []);
  const sidebarActive = nav.view === "chat" || nav.view === "history" || nav.view === "terminal" || nav.view === "browser";
  const workspace = repository.workspaces.find(w => w.workspaceId === nav.workspaceId);
  const overviewState = useWorkstreamOverviewState(nav.workspaceId, workspace?.kind === "repository" && (sidebarActive || selectorOpen || !!context.workstreamId));
  const { overview } = overviewState;
  useEffect(() => {
    if (!selectionRestored || !repository.ready || auth !== workspaceEpoch()) return;
    const current = catalog.snapshot();
    if (!current.ready || current.navigation.workspaceId !== context.workspaceId || current.navigation.worktreeId !== context.worktreeId) return;
    // Loading and transient failures are not evidence that a stream was deleted.
    if (overview && !overviewState.loading && !overviewState.error) {
      const streams = new Set(overview.workstreams.map(w => w.workstream.id));
      const workstreamId = context.workstreamId && !streams.has(context.workstreamId) ? null : context.workstreamId;
      const membership = context.filter.workstreamId;
      const membershipId = membership.startsWith("workstream:") ? membership.slice("workstream:".length) : membership;
      const filter = context.filter.workspaceId === context.workspaceId && !["all", "unknown", "unassigned"].includes(membership) && !streams.has(membershipId)
        ? { ...context.filter, workstreamId: "all" } : context.filter;
      if (workstreamId !== context.workstreamId || filter !== context.filter) {
        saveWorkstreamSelection(context.workspaceId, workstreamId, filter);
        setContext(saved => saved.workspaceId === context.workspaceId && saved.workstreamId === context.workstreamId && saved.filter === context.filter
          ? { ...saved, workstreamId, filter } : saved);
        return;
      }
    }
    saveWorkstreamSelection(context.workspaceId, context.workstreamId, context.filter);
  }, [auth, selectionRestored, repository.ready, context.workspaceId, context.worktreeId, context.workstreamId, context.filter, overview, overviewState.loading, overviewState.error]);
  const selectContext = (workspaceId: string | null, worktreeId: string | null, workstreamId: string | null) => {
    if (auth !== workspaceEpoch() || workspaceSelectionBlocked() || !catalog.snapshot().ready) return;
    setSelectionError("");
    // Explicit choices win over pending restoration and are saved synchronously.
    setSelectionRestored(true);
    const filter = contextDefaults(workspaceId, worktreeId, workstreamId);
    saveWorkstreamSelection(workspaceId, workstreamId, filter);
    catalog.navigate({ workspaceId, worktreeId, filePath: null, comparison: null });
    setContext({ workspaceId, worktreeId, workstreamId, filter });
  };
  const activateWorkspace = (workspaceId: string, direct: boolean, preferredWorktreeId?: string) => {
    if (auth !== workspaceEpoch()) return false;
    const resolved = resolveWorkspaceActivation(workspaceId, preferredWorktreeId);
    if ("error" in resolved) { setSelectionError(resolved.error); return false; }
    setSelectionError("");
    const current = catalog.snapshot();
    const currentWorktreeAvailable = current.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.worktrees
      .some(worktree => worktree.worktreeId === current.navigation.worktreeId && worktree.state === "available");
    if (!direct && preferredWorktreeId === undefined && current.navigation.workspaceId === workspaceId && currentWorktreeAvailable) return true;
    if (workspaceSelectionBlocked()) return false;
    const { target } = resolved;
    const filter = contextDefaults(target.workspaceId, target.worktreeId, null);
    setSelectionRestored(true);
    store.choose(target.conversationId ?? "");
    saveWorkstreamSelection(target.workspaceId, null, filter);
    setContext({ workspaceId: target.workspaceId, worktreeId: target.worktreeId, workstreamId: null, filter });
    catalog.navigate({ ...target, filePath: null, comparison: null, ...(direct ? { view: "chat" as const } : {}) });
    refreshWorkspaceActivation(target, false, setSelectionError);
    return true;
  };
  const workspaceSelection: WorkspaceSelectionModel = {
    workstreamId: context.workstreamId, overview, loading: overviewState.loading, error: overviewState.error,
    blocked: state.phase !== "ready" || state.sending || !state.conversationsReady,
    selectionError, setOpen, isOpen,
    selectWorkspace: (workspaceId, preferredWorktreeId) => activateWorkspace(workspaceId, false, preferredWorktreeId),
    goWorkspace: workspaceId => activateWorkspace(workspaceId, true),
    selectWorktree: (worktreeId, workspaceId) => {
      if (auth !== workspaceEpoch() || workspaceSelectionBlocked() || !catalog.snapshot().ready) return;
      const current = catalog.snapshot();
      const workspace = current.workspaces.find(w => w.workspaceId === (workspaceId ?? current.navigation.workspaceId));
      if (!workspace?.worktrees.some(t => t.worktreeId === worktreeId && t.state === "available")) return;
      // Both the picker and sidebar select an exact checkout and clear workstream scope.
      selectContext(workspace.workspaceId, worktreeId, null);
      // Explicit checkout selection (including Cmd+1…9) focuses one panel.
      // Collapsing siblings keeps their cached pages/cursors intact.
      setExpansion({ auth, values: { [`${workspace.workspaceId}:${worktreeId}`]: true } });
      setWorktreeSelectionVersion(version => version + 1);
    },
    selectWorkstream: workstreamId => {
      if (auth !== workspaceEpoch() || workspaceSelectionBlocked()) return;
      const current = catalog.snapshot();
      if (!workstreamId) { selectContext(current.navigation.workspaceId, current.navigation.worktreeId, null); return; }
      if (current.navigation.workspaceId !== nav.workspaceId) return;
      const stream = overview?.workstreams.find(w => w.workstream.id === workstreamId)?.workstream;
      if (!stream) return;
      const workspace = current.workspaces.find(w => w.workspaceId === current.navigation.workspaceId);
      const tree = workstreamCheckout(workspace, stream);
      selectContext(current.navigation.workspaceId, tree?.worktreeId ?? current.navigation.worktreeId, workstreamId);
    },
  };
  const deferredQuery = useDeferredValue(filter.query);
  const deferred = useMemo(() => ({ ...filter, query: deferredQuery }), [filter, deferredQuery]);
  const searching = !!deferred.query.trim();
  const grouped = !searching && typeof store.setConversationGroups === "function";
  const query = useMemo<SessionCatalogQuery>(() => ({
    mode,
    workspaceId: deferred.workspaceId === "all" || deferred.workspaceId === null ? undefined : deferred.workspaceId,
    worktreeId: deferred.worktreeId === "all" || deferred.worktreeId === null ? undefined : deferred.worktreeId,
    harness: deferred.harness,
    status: deferred.status,
    workstreamId: deferred.workstreamId,
    phase: deferred.phase,
    showDeleted: !!deferred.showDeleted,
    query: deferred.query,
    limit: grouped ? conversationGroupPageSize(mode) : 50,
  }), [mode, deferred, grouped]);
  const queryKey = conversationQueryKey(query);
  const directory = state.conversationGroupDirectory;
  const directoryCurrent = directory?.queryKey === queryKey;
  const directoryReady = !!directoryCurrent && !directory?.loading && !directory?.error;
  const bucketDirectory = useMemo(() => conversationSidebarBucketDirectory(repository.workspaces, nav.workspaceId, nav.worktreeId, deferred,
    directoryCurrent ? directory?.groups ?? [] : [], directoryReady), [repository.workspaces, nav.workspaceId, nav.worktreeId, deferred, directoryCurrent, directory?.groups, directoryReady]);
  const groupQuery = useCallback((bucket: Pick<WorktreeBucket, "workspaceId" | "worktreeId">): SessionCatalogQuery => ({ ...query,
    workspaceId: bucket.workspaceId ?? "unavailable", worktreeId: bucket.worktreeId ?? "unavailable", limit: conversationGroupPageSize(query.mode) }), [query]);
  const groupPage = useCallback((bucket: Pick<WorktreeBucket, "workspaceId" | "worktreeId">) => state.conversationGroups?.[conversationQueryKey(groupQuery(bucket))], [state.conversationGroups, groupQuery]);
  // Key the effect by value: directory loading and page publications must not
  // repeatedly reschedule the same expanded heads.
  const expandedQueriesKey = JSON.stringify(bucketDirectory.flatMap(group => group.buckets.filter(bucket => isWorktreeExpanded(bucket.key)).map(groupQuery)));
  const expandedQueries = useMemo<SessionCatalogQuery[]>(() => JSON.parse(expandedQueriesKey), [expandedQueriesKey]);
  useEffect(() => {
    if (!repository.ready || state.phase !== "ready" || auth !== workspaceEpoch() || !sidebarActive) return;
    if (grouped) store.setConversationGroups(query, expandedQueries);
    else store.setConversationQuery?.(query);
  }, [query, grouped, expandedQueries, auth, repository.ready, state.phase, sidebarActive]);
  // The known-cache union also contains selected, worker, notification and search
  // targets. Only matching page IDs are sidebar rows on paginated clients.
  const paginated = !!state.conversationPage && Array.isArray(state.conversationPageIds);
  const pageCurrent = state.conversationPage?.queryKey === queryKey;
  const page = paginated && !grouped ? {
    ...state.conversationPage!,
    loading: !pageCurrent || state.conversationPage!.loading,
    loadingMore: pageCurrent && state.conversationPage!.loadingMore,
    error: pageCurrent ? state.conversationPage!.error : "",
    hasMore: pageCurrent && state.conversationPage!.hasMore,
  } : null;
  const cachedMembership = useMemo(() => repository.ready ? readWorkstreamMembership(nav.workspaceId) : null, [auth, repository.ready, nav.workspaceId, overview]);
  // Membership is derived solely from the overview, not the chat polling list.
  const workstreamMap = useMemo(() => overview ? buildWorkstreamMap(overview, []) : cachedMembership ?? new Map<string, WorkstreamMembership>(), [overview, cachedMembership]);
  useEffect(() => {
    const current = catalog.snapshot();
    if (auth === workspaceEpoch() && repository.ready && current.ready && current.navigation.workspaceId === nav.workspaceId && nav.workspaceId && overview && !overviewState.error) saveWorkstreamMembership(nav.workspaceId, workstreamMap);
  }, [auth, repository.ready, nav.workspaceId, overview, overviewState.error, workstreamMap]);
  const membershipLoading = overviewState.loading && !overview && !cachedMembership;
  const hitMembershipPending = (deferred.workstreamId !== "all" || deferred.phase !== "all") && !overview && !cachedMembership;
  const membershipPending = !grouped && !paginated && hitMembershipPending;
  const membershipError = membershipPending ? overviewState.error : "";
  const visible = useMemo<Conversation[]>(() => {
    if (grouped) {
      const known = new Map(state.conversations.map(conversation => [conversation.id, conversation]));
      const ids = new Set(bucketDirectory.flatMap(group => group.buckets.flatMap(bucket => (groupPage(bucket)?.ids ?? []).filter(id => {
        const conversation = known.get(id);
        return conversation && conversationSidebarBinding(conversation, repository.workspaces).key === bucket.key;
      }))));
      return [...ids].flatMap(id => known.has(id) ? [known.get(id)!] : []);
    }
    if (paginated) {
      if (!pageCurrent) return [];
      const known = new Map(state.conversations.map(conversation => [conversation.id, conversation]));
      // IDs are already newest first, with every filter applied by the server.
      return state.conversationPageIds!.flatMap((id: string) => {
        const conversation = known.get(id);
        return conversation ? [conversation] : [];
      });
    }
    return membershipPending ? [] : filterConversations(
      [...state.conversations].reverse().filter(c => mode === "history" || (c.agentKind !== "worker" && !c.worker && !knownWorker(c.id))),
      deferred,
      { workstreamMap, includeReplaced: mode === "history" },
    );
  }, [grouped, bucketDirectory, groupPage, repository.workspaces, state.conversations, state.conversationPageIds, paginated, pageCurrent, deferred, workstreamMap, workerDiscovery, mode, membershipPending]);
  // Only explicit selected rows may be added outside exact page IDs. This is a
  // local eligibility check, not another listing or a reason to drain cursors.
  const filterEligible = useMemo(() => {
    if (hitMembershipPending) return [];
    const inScope = state.conversations.filter(conversation => {
      const { workspaceId, worktreeId } = conversationSidebarBinding(conversation, repository.workspaces);
      if (deferred.workspaceId === "unavailable") {
        if (workspaceId !== null) return false;
      } else if (deferred.workspaceId && deferred.workspaceId !== "all" && deferred.workspaceId !== workspaceId) return false;
      if (deferred.worktreeId === "unavailable") {
        if (worktreeId !== null) return false;
      } else if (deferred.worktreeId && deferred.worktreeId !== "all" && deferred.worktreeId !== worktreeId) return false;
      return mode === "history" || (conversation.agentKind !== "worker" && !conversation.worker && !knownWorker(conversation.id));
    });
    return filterConversations(inScope, { ...deferred, query: "", workspaceId: "all", worktreeId: "all" }, { workstreamMap, includeReplaced: mode === "history" });
  }, [hitMembershipPending, state.conversations, repository.workspaces, mode, deferred, workstreamMap, workerDiscovery]);
  // Membership snapshots cover the browsing workspace only. Off-page rows from
  // another workspace cannot be classified as "unknown" just because that
  // workspace's memberships have not been loaded. Server page rows stay valid.
  const membershipFilterActive = deferred.workstreamId !== "all" || !!deferred.phase && deferred.phase !== "all";
  const pinEligible = filterEligible.filter(conversation => !membershipFilterActive
    || conversationSidebarBinding(conversation, repository.workspaces).workspaceId === nav.workspaceId);
  const pinCandidates = grouped ? pinEligible : [];
  // Keep this identity across flat search so clearing it does not reopen a
  // panel the user explicitly collapsed before searching.
  const selectedPin = pinEligible.find(conversation => conversation.id === selectedId);
  const selectedBucketKey = selectedPin ? conversationSidebarBinding(selectedPin, repository.workspaces).key : null;
  useEffect(() => {
    if (selectedBucketKey) setWorktreeExpanded(selectedBucketKey, true);
  }, [selectedId, selectedBucketKey, setWorktreeExpanded]);
  const messageSearch = useMessageHitsState(deferred.query, deferred.workspaceId, deferred.worktreeId, queryKey);
  const messageHits = messageSearch.hits;
  const hits = useMemo(() => {
    if (hitMembershipPending) return [];
    const eligible = new Set(filterEligible.map(conversation => conversation.id));
    return messageHits.filter(hit => eligible.has(hit.sessionId));
  }, [messageHits, filterEligible, hitMembershipPending]);
  const messageHitsLoading = messageSearch.loading || (!!messageHits.length && hitMembershipPending && !overviewState.error);
  const messageHitsError = messageSearch.error || (messageHits.length > 0 && hitMembershipPending ? overviewState.error : "");
  const workerCounts = useMemo(() => {
    const counts = directWorkerCounts();
    for (const conversation of state.conversations) counts.set(conversation.id, Math.max(conversation.directWorkerCount ?? 0, counts.get(conversation.id) ?? 0));
    return counts;
  }, [workerDiscovery, state.conversations]);
  const groups = useMemo(() => {
    const list = [...repository.workspaces.map(w => ({ id: w.workspaceId as string | null, name: w.name })), { id: null, name: "Unavailable workspace · recorded history" }];
    return list.sort((a, b) => Number(b.id === nav.workspaceId) - Number(a.id === nav.workspaceId));
  }, [repository.workspaces, nav.workspaceId]);
  const defaults = contextDefaults(nav.workspaceId, nav.worktreeId, context.workstreamId);
  const activeFilterCount = (filter.harness !== "all" ? 1 : 0) + (filter.status !== "all" ? 1 : 0) + (filter.workstreamId !== "all" ? 1 : 0) + (filter.phase !== "all" ? 1 : 0) + (filter.showDeleted ? 1 : 0)
    + (filter.workspaceId === defaults.workspaceId && filter.worktreeId === defaults.worktreeId ? 0 : 1);
  const scoped = deferred.workspaceId !== "all" && deferred.workspaceId !== "unavailable";
  return { repository, nav, filter, setFilter, defaults, workspaceSelection, worktreeSelectionVersion, overview, workstreamMap, membershipLoading, membershipPending, membershipError, visible, hits, messageHitsLoading, messageHitsError, page, workerCounts, groups, scoped, activeFilterCount,
    grouped, searching, bucketDirectory, groupQuery, groupPage, pinCandidates, isWorktreeExpanded, setWorktreeExpanded,
    directoryLoading: grouped && (!directoryCurrent || !!directory?.loading), directoryError: grouped && directoryCurrent ? directory?.error ?? "" : "", directoryReady };
}

export type ConversationSidebarModel = ReturnType<typeof useConversationSidebarModel>;
