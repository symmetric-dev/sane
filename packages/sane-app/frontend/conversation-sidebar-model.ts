import { useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import type { State } from "./store";
import { defaultFilterFor, filterConversations } from "./conversation-filter";
import { buildWorkstreamMap } from "./conversation-filter-dialog";
import { useMessageHits, useWorkstreamOverview } from "./conversation-hooks";
import { workerReference as knownWorker, useWorkerDiscovery, directWorkerCounts } from "./worker-client";

export type ConversationSidebarMode = "chat" | "history";

/** Mount once in the shell; pass the same model to desktop and drawer sidebars. */
export function useConversationSidebarModel(state: State, mode: ConversationSidebarMode) {
  const workerDiscovery = useWorkerDiscovery();
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const nav = repository.navigation;
  const [filter, setFilter] = useState(() => defaultFilterFor(nav.workspaceId, nav.worktreeId));
  // Mode and presentation changes deliberately do not reset the filters.
  useEffect(() => { setFilter(defaultFilterFor(nav.workspaceId, nav.worktreeId)); }, [nav.workspaceId, nav.worktreeId]);
  const sidebarActive = nav.view === "chat" || nav.view === "history" || nav.view === "terminal";
  const overview = useWorkstreamOverview(nav.workspaceId, sidebarActive);
  const deferred = useDeferredValue(filter);
  const workstreamMap = useMemo(() => buildWorkstreamMap(overview, state.conversations), [overview, state.conversations]);
  const visible = useMemo(() => filterConversations(
    [...state.conversations].reverse().filter(c => mode === "history" || !knownWorker(c.id)),
    deferred,
    { workstreamMap, includeReplaced: mode === "history" },
  ), [state.conversations, deferred, workstreamMap, workerDiscovery, mode]);
  const messageHits = useMessageHits(deferred.query, deferred.workspaceId, deferred.worktreeId);
  const hits = useMemo(() => messageHits.filter(hit => mode === "history" || (!knownWorker(hit.sessionId) && !state.conversations.find(c => c.id === hit.sessionId)?.replacedBy)), [messageHits, mode, state.conversations, workerDiscovery]);
  const workerCounts = useMemo(() => {
    const counts = directWorkerCounts();
    for (const conversation of state.conversations) counts.set(conversation.id, Math.max(conversation.directWorkerCount ?? 0, counts.get(conversation.id) ?? 0));
    return counts;
  }, [workerDiscovery, state.conversations]);
  const groups = useMemo(() => {
    const list = [...repository.workspaces.map(w => ({ id: w.workspaceId as string | null, name: w.name })), { id: null, name: "Unavailable workspace · recorded history" }];
    return list.sort((a, b) => Number(b.id === nav.workspaceId) - Number(a.id === nav.workspaceId));
  }, [repository.workspaces, nav.workspaceId]);
  const defaults = defaultFilterFor(nav.workspaceId, nav.worktreeId);
  const activeFilterCount = (filter.harness !== "all" ? 1 : 0) + (filter.status !== "all" ? 1 : 0) + (filter.workstreamId !== "all" ? 1 : 0) + (filter.phase !== "all" ? 1 : 0) + (filter.showDeleted ? 1 : 0)
    + (filter.workspaceId === defaults.workspaceId && filter.worktreeId === defaults.worktreeId ? 0 : 1);
  const scoped = deferred.workspaceId !== "all" && deferred.workspaceId !== "unavailable";
  return { repository, nav, filter, setFilter, overview, workstreamMap, visible, hits, workerCounts, groups, scoped, activeFilterCount };
}

export type ConversationSidebarModel = ReturnType<typeof useConversationSidebarModel>;
