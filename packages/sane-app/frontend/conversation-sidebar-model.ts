import { useCallback, useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import type { State } from "./store";
import { defaultFilterFor, filterConversations, type ConversationFilterState, type WorkstreamMembership } from "./conversation-filter";
import { buildWorkstreamMap } from "./conversation-filter-dialog";
import { useMessageHits, useWorkstreamOverviewState } from "./conversation-hooks";
import { workerReference as knownWorker, useWorkerDiscovery, directWorkerCounts } from "./worker-client";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { workstreamCheckout } from "./workstream-checkout";
import { readWorkstreamSelection, saveWorkstreamSelection } from "./workstream-selection-storage";
import { readWorkstreamMembership, saveWorkstreamMembership } from "./workstream-membership-storage";
import { workspaceEpoch } from "./workspace-store";

export type ConversationSidebarMode = "chat" | "history";

export type WorkspaceSelectionModel = {
  workstreamId: string | null;
  overview: WorkstreamOverview | null;
  loading: boolean;
  error: string;
  setOpen: (open: boolean) => void;
  selectWorkspace: (workspaceId: string) => void;
  selectWorktree: (worktreeId: string) => void;
  selectWorkstream: (workstreamId: string | null) => void;
};

type SidebarContext = { workspaceId: string | null; worktreeId: string | null; workstreamId: string | null; filter: ConversationFilterState };
const contextDefaults = (workspaceId: string | null, worktreeId: string | null, workstreamId: string | null) => ({
  ...defaultFilterFor(workspaceId, workstreamId ? null : worktreeId),
  workstreamId: workstreamId ? `workstream:${workstreamId}` : "all",
});
function rebaseContext(context: SidebarContext, workspaceId: string | null, worktreeId: string | null): SidebarContext {
  if (context.workspaceId === workspaceId && context.worktreeId === worktreeId) return context;
  // Opening a member session on another checkout must not lose workstream scope.
  if (context.workspaceId === workspaceId && context.workstreamId) return { ...context, worktreeId };
  return { workspaceId, worktreeId, workstreamId: null, filter: defaultFilterFor(workspaceId, worktreeId) };
}

/** Mount once in the shell; pass the same model to desktop and drawer sidebars. */
export function useConversationSidebarModel(state: State, mode: ConversationSidebarMode) {
  const workerDiscovery = useWorkerDiscovery();
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const auth = workspaceEpoch();
  const nav = repository.navigation;
  const [savedContext, setContext] = useState<SidebarContext>(() => ({ workspaceId: nav.workspaceId, worktreeId: nav.worktreeId, workstreamId: null, filter: defaultFilterFor(nav.workspaceId, nav.worktreeId) }));
  const [selectionRestored, setSelectionRestored] = useState(false);
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
  const sidebarActive = nav.view === "chat" || nav.view === "history" || nav.view === "terminal";
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
    // Explicit choices win over pending restoration and are saved synchronously.
    setSelectionRestored(true);
    const filter = contextDefaults(workspaceId, worktreeId, workstreamId);
    saveWorkstreamSelection(workspaceId, workstreamId, filter);
    catalog.navigate({ workspaceId, worktreeId, filePath: null, comparison: null });
    setContext({ workspaceId, worktreeId, workstreamId, filter });
  };
  const workspaceSelection: WorkspaceSelectionModel = {
    workstreamId: context.workstreamId, overview, loading: overviewState.loading, error: overviewState.error, setOpen: setSelectorOpen,
    selectWorkspace: workspaceId => {
      const target = catalog.snapshot().workspaces.find(w => w.workspaceId === workspaceId);
      if (!target || workspaceId === catalog.snapshot().navigation.workspaceId) return;
      selectContext(workspaceId, target.worktrees.find(t => t.state === "available")?.worktreeId ?? target.worktrees[0]?.worktreeId ?? null, null);
    },
    selectWorktree: worktreeId => {
      const current = catalog.snapshot();
      const workspace = current.workspaces.find(w => w.workspaceId === current.navigation.workspaceId);
      if (workspace?.worktrees.some(t => t.worktreeId === worktreeId && t.state === "available")) selectContext(current.navigation.workspaceId, worktreeId, null);
    },
    selectWorkstream: workstreamId => {
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
  const deferred = useDeferredValue(filter);
  const cachedMembership = useMemo(() => repository.ready ? readWorkstreamMembership(nav.workspaceId) : null, [auth, repository.ready, nav.workspaceId, overview]);
  // Membership is derived solely from the overview, not the chat polling list.
  const workstreamMap = useMemo(() => overview ? buildWorkstreamMap(overview, []) : cachedMembership ?? new Map<string, WorkstreamMembership>(), [overview, cachedMembership]);
  useEffect(() => {
    const current = catalog.snapshot();
    if (auth === workspaceEpoch() && repository.ready && current.ready && current.navigation.workspaceId === nav.workspaceId && nav.workspaceId && overview && !overviewState.error) saveWorkstreamMembership(nav.workspaceId, workstreamMap);
  }, [auth, repository.ready, nav.workspaceId, overview, overviewState.error, workstreamMap]);
  const membershipPending = (deferred.workstreamId !== "all" || deferred.phase !== "all") && !overview && !cachedMembership;
  const membershipError = membershipPending ? overviewState.error : "";
  const visible = useMemo(() => membershipPending ? [] : filterConversations(
    [...state.conversations].reverse().filter(c => mode === "history" || !knownWorker(c.id)),
    deferred,
    { workstreamMap, includeReplaced: mode === "history" },
  ), [state.conversations, deferred, workstreamMap, workerDiscovery, mode, membershipPending]);
  const messageHits = useMessageHits(deferred.query, deferred.workspaceId, deferred.worktreeId);
  const hits = useMemo(() => {
    if (membershipPending) return [];
    const eligible = new Set(filterConversations(state.conversations.filter(c => mode === "history" || !knownWorker(c.id)), { ...deferred, query: "" }, { workstreamMap, includeReplaced: mode === "history" }).map(c => c.id));
    return messageHits.filter(hit => eligible.has(hit.sessionId));
  }, [messageHits, mode, state.conversations, deferred, workstreamMap, workerDiscovery, membershipPending]);
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
  return { repository, nav, filter, setFilter, defaults, workspaceSelection, overview, workstreamMap, membershipPending, membershipError, visible, hits, workerCounts, groups, scoped, activeFilterCount };
}

export type ConversationSidebarModel = ReturnType<typeof useConversationSidebarModel>;
