import { useCallback, useState, type SetStateAction } from "react";
import type { State } from "./store";
import type { PairRepository } from "./preview-pair-target";
import type { PreviewPairPane } from "./preview-pair-layout";
import { workspaceEpoch } from "./workspace-store";

type ViewState = { pane: PreviewPairPane; sidebarHidden: boolean };
const initial: ViewState = { pane: "preview", sidebarHidden: false };
const apply = <T,>(next: SetStateAction<T>, previous: T): T => typeof next === "function" ? (next as (value: T) => T)(previous) : next;

/** In-memory presentation only; neither a saved pairing nor an access grant. */
export function usePreviewViewState(state: State, repository: PairRepository) {
  const { workspaceId, worktreeId, view } = repository.navigation;
  const tree = repository.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.worktrees.find(tree => tree.worktreeId === worktreeId);
  const authority = JSON.stringify([state.config?.storeId, workspaceEpoch()]);
  const key = JSON.stringify([workspaceId, worktreeId, tree?.bindingRevision, tree?.root, view === "git" ? "code" : view]);
  const [saved, setSaved] = useState<{ authority: string; views: Record<string, ViewState> }>({ authority, views: {} });
  const current = saved.authority === authority ? saved.views[key] ?? initial : initial;
  const update = useCallback((change: (previous: ViewState) => ViewState) => {
    setSaved(value => {
      const views = value.authority === authority ? value.views : {};
      return { authority, views: { ...views, [key]: change(views[key] ?? initial) } };
    });
  }, [authority, key]);
  const setPane = useCallback((pane: SetStateAction<PreviewPairPane>) => update(previous => ({ ...previous, pane: apply(pane, previous.pane) })), [update]);
  const setSidebarHidden = useCallback((hidden: SetStateAction<boolean>) => update(previous => ({ ...previous, sidebarHidden: apply(hidden, previous.sidebarHidden) })), [update]);
  return { pane: current.pane, setPane, sidebarHidden: current.sidebarHidden, setSidebarHidden };
}
