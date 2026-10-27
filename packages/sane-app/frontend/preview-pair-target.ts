import { useSyncExternalStore } from "react";
import { isPairTarget, pairTargetKey, samePairTarget, type PairTarget } from "../shared/resource-pair-contract";
import { browserTabLabel, browserTabs, type BrowserTabs } from "./browser-tabs";
import { catalog } from "./catalog";

export type PairRepository = ReturnType<typeof catalog.snapshot>;

/** A binding revision fences both checkout replacement and root changes. */
export function pairWorktreeIdentity(repository: PairRepository, workspaceId?: string | null, worktreeId?: string | null): string | null {
  const tree = repository.workspaces.find(item => item.workspaceId === workspaceId)?.worktrees.find(item => item.worktreeId === worktreeId);
  return repository.ready && workspaceId && tree?.state === "available"
    ? JSON.stringify([workspaceId, worktreeId, tree.bindingRevision, tree.root]) : null;
}

/** Source and Notebook are presentations, not different resources. No file is opened here. */
export function previewPairTarget(repository: PairRepository, tabs: BrowserTabs, allowChatBrowser = false): PairTarget | null {
  const { workspaceId, worktreeId, filePath, view } = repository.navigation;
  if (!workspaceId || !pairWorktreeIdentity(repository, workspaceId, worktreeId)) return null;
  if (view === "code") {
    const target = { kind: "file" as const, workspaceId, worktreeId, path: filePath };
    return isPairTarget(target) ? target : null;
  }
  if (view !== "browser" && !(allowChatBrowser && view === "chat")) return null;
  const tab = tabs.tabs.find(item => item.id === tabs.activeId);
  const target = { kind: "browser" as const, workspaceId, tabId: tab?.id };
  return isPairTarget(target) ? target : null;
}

export function previewPairTargetLabel(target: PairTarget | null, tabs?: BrowserTabs): string {
  if (!target) return "Preview";
  if (target.kind === "file") return target.path;
  const index = tabs?.tabs.findIndex(tab => tab.id === target.tabId) ?? -1;
  return index < 0 || !tabs ? "Browser tab" : browserTabLabel(tabs.tabs[index]!, index);
}

/** Stable resource/binding identity; presentation changes deliberately do not fence a file. */
export function previewPairNavigationIdentity(repository: PairRepository, target: PairTarget): string | null {
  const { workspaceId, worktreeId } = repository.navigation;
  const browsing = pairWorktreeIdentity(repository, workspaceId, worktreeId);
  if (!browsing || workspaceId !== target.workspaceId || target.kind === "file" && worktreeId !== target.worktreeId) return null;
  return JSON.stringify([browsing, pairTargetKey(target)]);
}

/** Discovery may select another resource, but never another checkout or a closed tab. */
export function previewPairTargetAvailable(repository: PairRepository, tabs: BrowserTabs, target: PairTarget): boolean {
  return !!previewPairNavigationIdentity(repository, target)
    && (target.kind === "file" || tabs.tabs.some(tab => tab.id === target.tabId));
}

export function previewPairTargetMatches(repository: PairRepository, tabs: BrowserTabs, target: PairTarget, allowChatBrowser = false): boolean {
  const current = previewPairTarget(repository, tabs, allowChatBrowser);
  return !!current && samePairTarget(current, target);
}

export function usePreviewPairTarget(repository: PairRepository) {
  const tabs = useSyncExternalStore(browserTabs.subscribe, () => browserTabs.snapshot(repository.navigation.workspaceId));
  const target = previewPairTarget(repository, tabs);
  return { target, targetLabel: previewPairTargetLabel(target, tabs) };
}
