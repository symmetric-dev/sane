import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { GitComparison, WorkspaceDiff, WorkspaceList } from "../src/workspace-contract";
import type { NavigationBookmark, WorktreeResolution as Workspace } from "../src/catalog-contract";
import type { EditorView } from "@codemirror/view";
import { workspaceClient, WorkspaceError } from "./workspace-client";
import { catalog, worktreeScope } from "./catalog";
import { notifyWorkspace, openBuffer, refreshBuffer, rootState, subscribeWorkspace, workspaceEpoch, workspaceFailure, workspaceSnapshot, type TreePresentation } from "./workspace-store";

export type ActiveView = NavigationBookmark["view"];
export type WorkspaceActivation = { view: "code"; path: string } | { view: "git"; path: string; comparison: GitComparison };
type DirectoryResult = { listing?: WorkspaceList; error?: string };
type DirectoryRequest = { result?: DirectoryResult; promise?: Promise<DirectoryResult> };
type Scope = {
  id: string; workspace: Workspace; auth: number; generation: number;
  directories: Map<string, DirectoryRequest>; invalidators: Set<(path: string) => void>;
};

function useController(conversationId: string | null, view: ActiveView, navigate: (view: ActiveView) => void, bindingRevision?: string) {
  useSyncExternalStore(subscribeWorkspace, workspaceSnapshot);
  const [resolved, setResolved] = useState<Scope | null>(null);
  const [error, setError] = useState(""), [resolving, setResolving] = useState(false);
  const [resolveAttempt, setResolveAttempt] = useState(0), [openAttempt, setOpenAttempt] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ key: string; value: WorkspaceDiff | null } | null>(null);
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [localCompare, setLocalCompare] = useState<string | null>(null);
  const generation = useRef(0), selectionRequest = useRef(0);
  const diffEditor = useRef<EditorView | null>(null);
  // Render-time identity prevents previous-conversation callbacks from landing before effect cleanup.
  const identity = useRef({ conversationId, view });
  identity.current = { conversationId, view };
  const scope = resolved?.id === conversationId && resolved.auth === workspaceEpoch() ? resolved : undefined;
  const workspace = scope?.workspace;
  const root = workspace ? rootState(workspace) : undefined;
  const selected = root?.selected ?? "", comparisonKind = root?.comparison ?? "unstaged";
  const buffer = root?.buffers.get(selected);
  const selectionKey = scope ? JSON.stringify([scope.generation, workspace!.workspaceId, view, selected, comparisonKind, openAttempt]) : "";
  const currentScope = (candidate: Scope) => candidate.id === identity.current.conversationId && candidate.generation === generation.current && candidate.auth === workspaceEpoch();

  useEffect(() => {
    const request = ++generation.current, auth = workspaceEpoch();
    let active = true;
    const current = () => active && request === generation.current && auth === workspaceEpoch() && identity.current.conversationId === conversationId;
    setResolved(null); setError(""); setDiff(null); setLocalCompare(null); setOpening(null);
    setResolving(!!conversationId);
    if (conversationId) void workspaceClient.resolve(conversationId).then(workspace => {
      if (current()) {
        const root = rootState(workspace), bookmark = catalog.state.navigation;
        if (bookmark.filePath !== null) root.selected = bookmark.filePath;
        if (bookmark.comparison !== null) root.comparison = bookmark.comparison;
        setResolved({ id: conversationId, workspace, auth, generation: request, directories: new Map(), invalidators: new Set() });
      }
    }).catch(error => {
      if (current()) { setResolving(false); setError(workspaceFailure(error)); }
    }).finally(() => { if (current()) setResolving(false); });
    return () => { active = false; generation.current++; selectionRequest.current++; };
  }, [conversationId, bindingRevision, resolveAttempt]);

  useEffect(() => {
    if (view !== "code" || !scope || !selected || buffer) return;
    let active = true;
    const request = ++selectionRequest.current;
    const current = () => active && currentScope(scope) && request === selectionRequest.current && root!.selected === selected && identity.current.view === "code";
    setOpening(selectionKey); setError("");
    void openBuffer(scope.id, scope.workspace, selected, current).catch(error => {
      if (current()) { setOpening(null); setError(workspaceFailure(error)); }
    }).finally(() => { if (current()) setOpening(null); });
    return () => { active = false; };
  }, [scope, view, selected, openAttempt]);

  // Exactly one refresh owner, independent of how many sidebar trees are mounted.
  useEffect(() => {
    if (!scope || !root || (view !== "code" && view !== "git")) return;
    let active = true, busy = false;
    const request = selectionRequest.current;
    const current = () => active && currentScope(scope) && request === selectionRequest.current && identity.current.view === view && root.selected === selected && root.comparison === comparisonKind;
    const refresh = async () => {
      if (document.hidden || busy || !current()) return;
      busy = true;
      try {
        const existing = root.buffers.get(selected);
        if (existing) await refreshBuffer(scope.id, scope.workspace, existing, false, current);
        if (!current()) return;
        if (view === "git") {
          const git = await workspaceClient.git(scope.id, scope.workspace.workspaceId);
          if (!current()) return;
          root.git = git; notifyWorkspace();
          const entry = git.entries.find(entry => entry.path === selected);
          const value = selected && entry?.comparisons.includes(comparisonKind)
            ? await workspaceClient.diff(scope.id, scope.workspace.workspaceId, selected, comparisonKind) : null;
          if (current()) { setDiff({ key: selectionKey, value }); setError(""); }
        }
      } catch (error) {
        if (current()) { setDiffLoading(null); setError(workspaceFailure(error)); }
      } finally {
        if (current()) { busy = false; setDiffLoading(null); }
      }
    };
    if (view === "git") { setDiff(null); setDiffLoading(selectionKey); }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [scope, view, selected, comparisonKind, openAttempt]);

  function activate(target: WorkspaceActivation) {
    if (!scope || !root || !currentScope(scope)) return;
    selectionRequest.current++;
    root.selected = target.path;
    if (target.view === "git") root.comparison = target.comparison;
    setError(""); setLocalCompare(null); setDiff(null); setOpening(null);
    setOpenAttempt(value => value + 1);
    notifyWorkspace();
    catalog.navigate({ filePath: target.path, comparison: target.view === "git" ? target.comparison : root.comparison });
    // Always call navigation, including reactivation of the current leaf (mobile drawer close).
    navigate(target.view);
  }

  async function listDirectory(path: string): Promise<DirectoryResult> {
    if (!scope || !currentScope(scope)) return { error: "Workspace changed. Reopen its files." };
    const cached = scope.directories.get(path);
    if (cached?.result) return cached.result;
    if (cached?.promise) return cached.promise;
    const request: DirectoryRequest = {};
    scope.directories.set(path, request);
    const current = () => currentScope(scope) && scope.directories.get(path) === request;
    request.promise = (async () => {
      try {
        const listing = await workspaceClient.list(scope.id, scope.workspace.workspaceId, path);
        if (!current()) return {};
        request.result = { listing };
        return request.result;
      } catch (error) {
        if (!current()) return {};
        const result = { error: workspaceFailure(error) };
        if (current()) {
          request.result = result;
          if (error instanceof WorkspaceError && error.code === "workspace-changed") setError(result.error);
        }
        return result; // Never reject into Headless Tree: rejected loaders leave loading state stuck.
      } finally { if (current()) request.promise = undefined; }
    })();
    return request.promise;
  }
  function retryDirectory(path: string) {
    if (!scope || !currentScope(scope)) return;
    scope.directories.delete(path);
    scope.invalidators.forEach(invalidate => invalidate(path));
  }
  function refreshDirectories() {
    if (!scope) return;
    for (const path of [...scope.directories.keys()]) retryDirectory(path);
  }
  function updateTree(mode: "code" | "git", update: Partial<TreePresentation>) {
    if (!scope || !root || !currentScope(scope)) return;
    Object.assign(mode === "code" ? root.codeTree : root.gitTree, update);
    notifyWorkspace();
  }
  async function compareDisk(reload = false) {
    if (!scope || !root || !buffer || buffer.checking || buffer.saving) return;
    const request = selectionRequest.current, path = selected;
    const current = () => currentScope(scope) && request === selectionRequest.current && root.selected === path && identity.current.view === "code";
    await refreshBuffer(scope.id, scope.workspace, buffer, reload, current);
    if (current()) setLocalCompare(reload ? null : selectionKey);
  }
  return { conversationId, view, scope, workspace, root, buffer, selected, error: error || (resolved && resolved.auth !== workspaceEpoch() ? "Sign-in expired. Reconnect or sign in again; unsaved buffers remain in memory." : ""), resolving, diffEditor,
    opening: opening === selectionKey, diffLoading: diffLoading === selectionKey,
    comparison: diff?.key === selectionKey ? diff.value : null,
    localCompare: localCompare === selectionKey, closeCompare: () => setLocalCompare(null),
    activate, listDirectory, retryDirectory, refreshDirectories, compareDisk, updateTree,
    retryResolve: () => setResolveAttempt(value => value + 1), retrySelection: () => setOpenAttempt(value => value + 1),
  };
}
const WorkspaceContext = createContext<ReturnType<typeof useController> | null>(null);
export function WorkspaceProvider({ view, navigate, children }: { view: ActiveView; navigate: (view: ActiveView) => void; children: ReactNode }) {
  const { navigation, workspaces } = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const selectedWorktree = workspaces.find(w => w.workspaceId === navigation.workspaceId)?.worktrees.find(w => w.worktreeId === navigation.worktreeId);
  const id = navigation.workspaceId && navigation.worktreeId ? worktreeScope(navigation.workspaceId, navigation.worktreeId) : null;
  const controller = useController(id, view, navigate, selectedWorktree?.bindingRevision);
  return <WorkspaceContext.Provider value={controller}>{children}</WorkspaceContext.Provider>;
}
// Shared shell/chat seam for future actions; only existing file navigation is modeled here.
export function useWorkspace() {
  const controller = useContext(WorkspaceContext);
  if (!controller) throw new Error("WorkspaceProvider is required");
  return controller;
}
