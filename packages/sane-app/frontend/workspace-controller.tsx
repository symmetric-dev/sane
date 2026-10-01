import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { GitComparison, WorkspaceDiff, WorkspaceFile, WorkspaceList } from "../src/workspace-contract";
import type { NavigationBookmark, WorktreeResolution as Workspace } from "../src/catalog-contract";
import type { EditorView } from "@codemirror/view";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { searchSelection, type WorkspaceLocation } from "./workspace-location";
import { workspaceClient, WorkspaceError } from "./workspace-client";
import { catalog, worktreeScope } from "./catalog";
import { fencePath, notifyWorkspace, openBuffer, pathFence, refreshBuffer, renameBuffer, requestFence, rootState, subscribeWorkspace, workspaceEpoch, workspaceFailure, workspaceSnapshot, type Buffer, type TreePresentation } from "./workspace-store";

export type ActiveView = NavigationBookmark["view"];
export type WorkspaceActivation = { view: "code"; path: string; location?: WorkspaceLocation; source?: "files" | "search" } | { view: "git"; path: string; comparison: GitComparison };
type DirectoryResult = { listing?: WorkspaceList; error?: string };
type DirectoryRequest = { result?: DirectoryResult; promise?: Promise<DirectoryResult> };
type Scope = {
  id: string; workspace: Workspace; auth: number; generation: number; bindingRevision?: string;
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
  const pendingLocation = useRef<{ scope: Scope; path: string; location: WorkspaceLocation } | null>(null);
  const [locationNotice, setLocationNotice] = useState("");
  const activationRevision = useRef(0);
  const [codeActivation, setCodeActivation] = useState<{ scope: Scope; revision: number; source: "files" | "search" }>();
  // Render-time identity prevents previous-conversation callbacks from landing before effect cleanup.
  const identity = useRef({ conversationId, view, bindingRevision });
  identity.current = { conversationId, view, bindingRevision };
  const scope = resolved?.id === conversationId && resolved.bindingRevision === bindingRevision && resolved.auth === workspaceEpoch() ? resolved : undefined;
  const latestScope = useRef<Scope | undefined>(scope); latestScope.current = scope;
  const workspace = scope?.workspace;
  const root = workspace ? rootState(workspace) : undefined;
  const selected = root?.selected ?? "", comparisonKind = root?.comparison ?? "unstaged";
  const buffer = root?.buffers.get(selected);
  const selectionKey = scope ? JSON.stringify([scope.generation, workspace!.workspaceId, view, selected, comparisonKind, openAttempt]) : "";
  const currentScope = (candidate: Scope) => candidate.id === identity.current.conversationId && candidate.bindingRevision === identity.current.bindingRevision && candidate.generation === generation.current && candidate.auth === workspaceEpoch();

  useEffect(() => {
    const request = ++generation.current, auth = workspaceEpoch();
    let active = true;
    const current = () => active && request === generation.current && auth === workspaceEpoch() && identity.current.conversationId === conversationId && identity.current.bindingRevision === bindingRevision;
    setResolved(null); setError(""); setDiff(null); setLocalCompare(null); setOpening(null); pendingLocation.current = null; setLocationNotice("");
    setResolving(!!conversationId);
    if (conversationId) void workspaceClient.resolve(conversationId).then(workspace => {
      if (current()) {
        const root = rootState(workspace), bookmark = catalog.state.navigation;
        if (bookmark.filePath !== null) root.selected = bookmark.filePath;
        if (bookmark.comparison !== null) root.comparison = bookmark.comparison;
        setResolved({ id: conversationId, workspace, auth, generation: request, bindingRevision, directories: new Map(), invalidators: new Set() });
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
          const gitVersion = root.gitVersion;
          const git = await workspaceClient.git(scope.id, scope.workspace.workspaceId);
          if (!current() || gitVersion !== root.gitVersion) return;
          root.git = git; notifyWorkspace();
          const entry = git.entries.find(entry => entry.path === selected);
          const value = selected && entry?.comparisons.includes(comparisonKind)
            ? await workspaceClient.diff(scope.id, scope.workspace.workspaceId, selected, comparisonKind) : null;
          if (current() && gitVersion === root.gitVersion) { setDiff({ key: selectionKey, value }); setError(""); }
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

  // Mount notification from buffer.attach covers artifact previews, same-file navigation,
  // and file loads that finish before the editor exists. Latest activation wins.
  useEffect(() => {
    const pending = pendingLocation.current;
    if (!pending) return;
    if (!currentScope(pending.scope) || root?.selected !== pending.path) { pendingLocation.current = null; return; }
    if (view !== "code" || localCompare || !buffer?.view) return;
    pendingLocation.current = null;
    const selection = searchSelection(buffer.state, pending.location);
    if (selection) {
      buffer.view.dispatch({ selection, effects: CodeMirrorView.scrollIntoView(selection.anchor, { y: "center" }) });
      setLocationNotice("");
    } else setLocationNotice("Saved search match no longer matches this buffer. Local edits are preserved; search within the editor to find its current location.");
    buffer.view.focus();
  });

  function activate(target: WorkspaceActivation) {
    if (!scope || !root || !currentScope(scope)) return;
    if (target.view === "code") setCodeActivation({ scope, revision: ++activationRevision.current, source: target.source ?? "files" });
    selectionRequest.current++;
    pendingLocation.current = target.view === "code" && target.location ? { scope, path: target.path, location: target.location } : null;
    setLocationNotice("");
    root.selected = target.path;
    if (target.view === "git") root.comparison = target.comparison;
    setError(""); setLocalCompare(null); setDiff(null); setOpening(null);
    setOpenAttempt(value => value + 1);
    notifyWorkspace();
    catalog.navigate({ filePath: target.path, comparison: target.view === "git" ? target.comparison : root.comparison });
    // Always call navigation, including reactivation of the current leaf (mobile drawer close).
    navigate(target.view);
  }

  // Change the shell leaf / dismiss its drawer or artifact without restarting file
  // acquisition or discarding an already queued saved-match location.
  function navigateView(target: ActiveView) {
    if (!scope || !currentScope(scope)) return;
    navigate(target);
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
  // File actions acquire saved metadata without selecting a row or opening an editor.
  async function prepareFile(path: string): Promise<Buffer | undefined> {
    if (!scope || !root || !currentScope(scope)) return;
    const existing = root.buffers.get(path);
    if (root.mutations.has(path) || existing?.saving || existing?.checking || existing?.missing) throw new Error("Wait for pending operations or reload the missing file before trying again.");
    const unchanged = pathFence(root, path), current = requestFence(scope.workspace, () => currentScope(scope) && unchanged());
    try {
      if (existing) {
        await refreshBuffer(scope.id, scope.workspace, existing, false, current);
        if (!current()) return;
        if (existing.error) throw new Error(existing.error);
      }
      const prepared = existing ?? await openBuffer(scope.id, scope.workspace, path, current);
      if (!current() || !prepared) return;
      if (prepared.saving || prepared.checking || prepared.missing) throw new Error("Wait for pending operations or reload the missing file before trying again.");
      if (!(prepared.disk ?? prepared.file).revision) throw new Error("This file has no safe source revision for file operations.");
      return prepared;
    } catch (error) {
      if (!current()) return;
      throw new Error(workspaceFailure(error));
    }
  }
  async function mutateFile(operation: "create" | "copy" | "delete" | "rename", path: string, source = selected, expectedRevision?: string): Promise<boolean> {
    if (!scope || !root || !currentScope(scope)) return false;
    const parent = (value: string) => value.slice(0, Math.max(0, value.lastIndexOf("/")));
    if (operation === "rename" && (parent(path) !== parent(source) || !path || path.startsWith("/") || path === source || /[\\\u0000-\u001f\u007f]/.test(path) || ["", ".", ".."].includes(path.split("/").at(-1)!))) throw new Error("Enter a different filename in the same folder.");
    if (operation === "copy" && path === source) throw new Error("Choose a different destination path.");
    const sourceBuffer = operation === "create" ? undefined : root.buffers.get(source);
    const paths = [...new Set(operation === "create" ? [path] : operation === "delete" ? [source] : [source, path])];
    if (paths.some(value => root.mutations.has(value)) || sourceBuffer?.saving || sourceBuffer?.checking || sourceBuffer?.missing) throw new Error("Wait for pending operations or reload the missing file before trying again.");
    // Never replace another document's cached ownership, including missing/dirty buffers.
    if (operation !== "delete" && root.buffers.has(path)) throw new Error("The destination already has an open document. Choose another filename.");
    const owned = requestFence(scope.workspace);
    const visible = () => currentScope(scope) && identity.current.view === view;
    const visibleOwner = () => {
      const active = latestScope.current, navigation = catalog.state.navigation;
      return active && navigation.workspaceId && navigation.worktreeId && active.id === worktreeScope(navigation.workspaceId, navigation.worktreeId)
        && currentScope(active) && rootState(active.workspace) === root ? active : undefined;
    };
    const invalidateDirectories = (directories: Set<string>) => {
      // Returning to this worktree may have installed fresh tree/cache owners
      // while the request still holds its initiating scope.
      const scopes = new Set([scope, visibleOwner()].filter((value): value is Scope => !!value));
      for (const target of scopes) for (const directory of directories) {
        target.directories.delete(directory);
        target.invalidators.forEach(invalidate => invalidate(directory));
      }
    };
    const reconcileBookmark = (destination: string) => {
      const active = visibleOwner();
      if (!active || catalog.state.navigation.filePath !== source) return;
      selectionRequest.current++; pendingLocation.current = null;
      setLocationNotice(""); setLocalCompare(null); setDiff(null); setOpening(null);
      if (operation === "rename" && identity.current.view === "code") setCodeActivation({ scope: active, revision: ++activationRevision.current, source: "files" });
      catalog.navigate({ filePath: destination });
    };
    const siblings = scope.directories.get(parent(source))?.result?.listing?.entries.filter(entry => entry.kind === "file" || entry.kind === "directory");
    const sourceIndex = siblings?.findIndex(entry => entry.path === source) ?? -1;
    const neighbor = sourceIndex >= 0 ? siblings?.[sourceIndex + 1] ?? siblings?.[sourceIndex - 1] : undefined;
    for (const value of paths) { root.mutations.add(value); fencePath(root, value); }
    if (sourceBuffer) sourceBuffer.saving = true;
    notifyWorkspace();
    try {
      let result: WorkspaceFile | undefined;
      if (operation === "create") result = await workspaceClient.create(scope.id, scope.workspace.workspaceId, path);
      else {
        // Clipboard copies validate their captured DISK revision, independently of
        // the editor baseline (which may intentionally retain older unsaved text).
        const file = expectedRevision !== undefined ? await workspaceClient.file(scope.id, scope.workspace.workspaceId, source) : sourceBuffer?.file ?? await workspaceClient.file(scope.id, scope.workspace.workspaceId, source);
        if (!owned() || !currentScope(scope)) return false;
        if (!file.revision) throw new Error("This file has no safe source revision for file operations.");
        if (expectedRevision !== undefined && file.revision !== expectedRevision) throw new Error("The source file changed since it was copied. Copy it again before pasting.");
        const revision = expectedRevision ?? file.revision;
        if (operation === "copy") result = await workspaceClient.copy(scope.id, scope.workspace.workspaceId, source, path, revision);
        else if (operation === "rename") result = await workspaceClient.rename(scope.id, scope.workspace.workspaceId, source, path, revision);
        else await workspaceClient.delete(scope.id, scope.workspace.workspaceId, source, revision);
      }
      // Disk mutations reconcile their original root even after the user navigates away.
      if (!owned()) return false;
      for (const value of paths) fencePath(root, value);
      root.git = undefined; root.gitVersion++;
      invalidateDirectories(new Set(operation === "delete" ? [parent(source)] : operation === "create" ? [parent(path)] : [parent(source), parent(path)]));
      const selectedSource = root.selected === source;
      const focusedComparison = (["staged", "unstaged", "untracked"] as const).find(comparison => root.gitTree.focusedItem === `file:${comparison}:${source}`);
      if (operation === "delete") {
        root.buffers.delete(source);
        if (selectedSource) root.selected = "";
        root.codeTree.focusedItem = neighbor ? `${neighbor.kind}:${neighbor.path}` : `directory:${parent(source)}`;
        if (focusedComparison) root.gitTree.focusedItem = `group:${focusedComparison}:`;
      } else {
        if (operation === "rename") {
          if (sourceBuffer && result) renameBuffer(root, sourceBuffer, path, result);
          if (selectedSource) root.selected = path;
          if (focusedComparison) root.gitTree.focusedItem = `file:${focusedComparison}:${path}`;
        }
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
          const id = `directory:${parts.slice(0, index).join("/")}`;
          if (!root.codeTree.expandedItems.includes(id)) root.codeTree.expandedItems.push(id);
        }
        root.codeTree.focusedItem = `file:${path}`;
      }
      notifyWorkspace();
      if ((operation === "rename" || operation === "delete") && selectedSource) reconcileBookmark(operation === "delete" ? "" : path);
      if (!visible()) return false;
      if (operation === "create" || operation === "copy") activate({ view: "code", path });
      setOpenAttempt(value => value + 1);
      return true;
    } catch (error) {
      const failure = workspaceFailure(error);
      if (operation === "rename" && error instanceof WorkspaceError && error.code === "rename-committed" && owned()) {
        // The native rename already happened. Never leave an unsaved document
        // pointing at an old basename that another process could recreate.
        for (const value of paths) fencePath(root, value);
        root.git = undefined; root.gitVersion++;
        invalidateDirectories(new Set([parent(source)]));
        if (sourceBuffer) {
          renameBuffer(root, sourceBuffer, path, { ...sourceBuffer.file, path });
          sourceBuffer.error = failure;
          sourceBuffer.missing = true; // Quarantine writes until a destination read reconciles it.
        }
        const selectedSource = root.selected === source;
        if (selectedSource) root.selected = path;
        root.codeTree.focusedItem = `file:${path}`;
        notifyWorkspace();
        if (selectedSource) reconcileBookmark(path);
      }
      if (!currentScope(scope) || !owned()) return false;
      if (error instanceof WorkspaceError) throw error;
      throw new Error(failure);
    } finally {
      // Do not clear a newer operation's reservation after auth/root invalidation.
      if (owned()) {
        for (const value of paths) root.mutations.delete(value);
        if (sourceBuffer) sourceBuffer.saving = false;
        notifyWorkspace();
        if (currentScope(scope) && paths.includes(root.selected)) setOpenAttempt(value => value + 1);
      }
    }
  }
  return { conversationId, view, scope, workspace, root, buffer, selected, error: error || (resolved && resolved.auth !== workspaceEpoch() ? "Sign-in expired. Reconnect or sign in again; unsaved buffers remain in memory." : ""), resolving, diffEditor,
    opening: opening === selectionKey, diffLoading: diffLoading === selectionKey,
    comparison: diff?.key === selectionKey ? diff.value : null,
    localCompare: localCompare === selectionKey, closeCompare: () => setLocalCompare(null),
    activate, navigateView, codeActivation: codeActivation?.scope === scope ? codeActivation : undefined,
    locationNotice, listDirectory, retryDirectory, refreshDirectories, compareDisk, updateTree, prepareFile, mutateFile,
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
