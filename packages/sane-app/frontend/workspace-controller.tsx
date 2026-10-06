import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { GitComparison, WorkspaceDiff, WorkspaceFile } from "../src/workspace-contract";
import type { WorktreeResolution as Workspace } from "../src/catalog-contract";
import type { EditorView } from "@codemirror/view";
import { EditorView as CodeMirrorView } from "@codemirror/view";
import { searchSelection, type WorkspaceLocation } from "./workspace-location";
import { workspaceClient, WorkspaceError } from "./workspace-client";
import { catalog, worktreeScope, type CatalogNavigation } from "./catalog";
import { acquireWorktreeDirectories, type DirectoryResult, type DirectoryRequest, type WorktreeDirectories } from "./workspace-directory-cache";
export type { DirectoryResult } from "./workspace-directory-cache";
import { fencePath, notifyWorkspace, openBuffer, pathFence, refreshBuffer, renameBuffer, requestFence, rootState, subscribeWorkspace, workspaceEpoch, workspaceFailure, workspaceSnapshot, type Buffer, type TreePresentation } from "./workspace-store";

export type ActiveView = CatalogNavigation["view"];
export type WorkspaceActivation = { view: "code"; path: string; location?: WorkspaceLocation; source?: "files" | "search" } | { view: "git"; path: string; comparison: GitComparison };
const DIRECTORY_SWEEP_MS = 5_000;
const WORKSPACE_SOURCE_UNAVAILABLE = "Workspace source changed or is unavailable. Retry workspace resolution or choose an available worktree; unsaved buffers remain in memory.";
const WORKSPACE_AUTH_EXPIRED = "Sign-in expired. Reconnect or sign in again; unsaved buffers remain in memory.";
type Scope = {
  id: string; workspace: Workspace; auth: number; generation: number; bindingRevision?: string;
  reader: WorktreeDirectories;
  // Accept existing synchronous subscribers as well as awaited tree refreshes.
  directories: Map<string, DirectoryRequest>; invalidators: Set<(path: string) => unknown>;
  directoryRevalidators: Set<() => Promise<void>>;
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
  const resolvedSelection = resolved?.id === conversationId && resolved.bindingRevision === bindingRevision ? resolved : undefined;
  const scope = resolvedSelection?.auth === workspaceEpoch() && resolvedSelection.reader.current() ? resolvedSelection : undefined;
  const revoked = !!resolvedSelection && !scope;
  const scopeError = revoked ? resolvedSelection.auth !== workspaceEpoch() ? WORKSPACE_AUTH_EXPIRED : WORKSPACE_SOURCE_UNAVAILABLE : "";
  const latestScope = useRef<Scope | undefined>(scope); latestScope.current = scope;
  const workspace = scope?.workspace;
  const root = workspace ? rootState(workspace) : undefined;
  const selected = root?.selected ?? "", comparisonKind = root?.comparison ?? "unstaged";
  const buffer = root?.buffers.get(selected);
  const selectionKey = scope ? JSON.stringify([scope.generation, workspace!.workspaceId, view, selected, comparisonKind, openAttempt]) : "";
  const currentScope = (candidate: Scope) => candidate.id === identity.current.conversationId && candidate.bindingRevision === identity.current.bindingRevision && candidate.generation === generation.current && candidate.auth === workspaceEpoch() && candidate.reader.current();

  useEffect(() => {
    const request = ++generation.current, auth = workspaceEpoch();
    let active = true;
    const owns = () => active && request === generation.current && identity.current.conversationId === conversationId && identity.current.bindingRevision === bindingRevision;
    const current = () => owns() && auth === workspaceEpoch();
    setResolved(null); setError(""); setDiff(null); setLocalCompare(null); setOpening(null); pendingLocation.current = null; setLocationNotice("");
    setResolving(!!conversationId);
    const lease = conversationId ? acquireWorktreeDirectories(conversationId, bindingRevision) : undefined;
    if (lease) void lease.ready.then(reader => {
      const workspace = reader.workspace;
      if (current()) {
        if (!reader.current()) throw new Error(WORKSPACE_SOURCE_UNAVAILABLE);
        const root = rootState(workspace), bookmark = catalog.state.navigation;
        if (bookmark.filePath !== null) root.selected = bookmark.filePath;
        if (bookmark.comparison !== null) root.comparison = bookmark.comparison;
        setResolved({ id: conversationId!, workspace, auth, generation: request, bindingRevision, reader, directories: reader.directories, invalidators: new Set(), directoryRevalidators: new Set() });
      }
    }).catch(error => {
      // The shared service handles 401 before rejecting. Still settle this
      // consumer's loading/error state, but never publish stale resolved metadata.
      if (owns()) { setResolving(false); setError(workspaceFailure(error)); }
    }).finally(() => { if (owns()) setResolving(false); });
    return () => { active = false; lease?.release(); generation.current++; selectionRequest.current++; };
  }, [conversationId, bindingRevision, resolveAttempt]);

  useEffect(() => {
    if (!resolvedSelection) return;
    if (!revoked) {
      setError(previous => previous === WORKSPACE_SOURCE_UNAVAILABLE ? "" : previous);
      return;
    }
    // Retire presentation/read continuations, not the original mutation owner.
    // Its root and lease remain available for already committed disk results to
    // reconcile buffers and dirty original/current directory maps independently.
    selectionRequest.current++; pendingLocation.current = null;
    setResolving(false); setOpening(null); setDiffLoading(null); setDiff(null);
    setLocalCompare(null); setCodeActivation(undefined); setLocationNotice("");
    setError(scopeError);
  }, [resolvedSelection, revoked, scopeError]);

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

  // One directory freshness owner for both desktop/mobile trees. HT retains its
  // own children cache, so the subscribers reconcile only loaded, reachable rows;
  // expiring the HTTP cache alone would never cause HT to call its loader again.
  useEffect(() => {
    if (!scope || view !== "code") return;
    let active = true, busy = false;
    const refresh = async () => {
      if (!active || busy || document.hidden || !currentScope(scope)) return;
      busy = true;
      try { await runDirectoryCallbacks(scope, [...scope.directoryRevalidators]); }
      finally { busy = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), DIRECTORY_SWEEP_MS);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [scope, view]);

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
    const result = await scope.reader.listDirectory(path);
    if (!currentScope(scope)) return { error: "Workspace changed. Reopen its files." };
    return result;
  }
  function directoryNeedsRefresh(path: string, result: DirectoryResult | undefined) {
    return !!scope && currentScope(scope) && scope.reader.directoryNeedsRefresh(path, result);
  }
  async function runDirectoryCallbacks(target: Scope, callbacks: (() => unknown)[]) {
    // Wait for every tree, even if one fails; don't let a rejected HT refresh
    // turn a committed disk mutation into a failed file operation.
    const results = await Promise.allSettled(callbacks.map(callback => Promise.resolve().then(callback)));
    if (currentScope(target) && results.some(result => result.status === "rejected")) {
      setError("Could not refresh workspace files. Use Refresh to try again.");
    }
  }
  async function invalidateDirectories(target: Scope, paths: Iterable<string>, mutation = false, dirty = true) {
    const callbacks: (() => unknown)[] = [];
    const values = [...paths];
    if (dirty) target.reader.invalidate(values, mutation);
    for (const path of values) {
      for (const invalidate of target.invalidators) callbacks.push(() => invalidate(path));
    }
    await runDirectoryCallbacks(target, callbacks);
  }
  async function retryDirectory(path: string) {
    if (!scope || !currentScope(scope)) return;
    await invalidateDirectories(scope, [path]);
  }
  async function refreshDirectories() {
    if (!scope || !currentScope(scope)) return;
    await invalidateDirectories(scope, scope.directories.keys());
  }
  function updateTree(mode: "code" | "git", update: Partial<TreePresentation>) {
    if (!scope || !root || !currentScope(scope)) return;
    Object.assign(mode === "code" ? root.codeTree : root.gitTree, update);
    notifyWorkspace();
  }
  async function compareDisk(reload = false) {
    if (!scope || !root || !currentScope(scope) || !buffer || buffer.checking || buffer.saving) return;
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
    const invalidateMutationDirectories = (directories: Set<string>) => {
      // Returning to this worktree may have installed fresh tree/cache owners
      // while the request still holds its initiating scope.
      const scopes = new Set([scope, visibleOwner()].filter((value): value is Scope => !!value));
      const dirtied = new Set<Map<string, DirectoryRequest>>();
      for (const target of scopes) {
        // invalidateDirectories dirties records synchronously before its first
        // await. Its task owns/awaits tree reconciliation, independently of the
        // committed mutation: slow listings must not hold file reservations,
        // sourceBuffer.saving, dialog completion, or navigation hostage.
        const dirty = !dirtied.has(target.directories); dirtied.add(target.directories);
        void invalidateDirectories(target, directories, true, dirty).catch(() => {
          // Expected callback failures are handled inside runDirectoryCallbacks;
          // retain a fenced fallback for unexpected task failures as well.
          if (currentScope(target)) setError("Could not refresh workspace files. Use Refresh to try again.");
        });
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
      invalidateMutationDirectories(new Set(operation === "delete" ? [parent(source)] : operation === "create" ? [parent(path)] : [parent(source), parent(path)]));
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
        invalidateMutationDirectories(new Set([parent(source)]));
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
  return { conversationId, view, scope, workspace, root, buffer, selected, error: scopeError || error, resolving: !revoked && resolving, diffEditor,
    opening: !!scope && opening === selectionKey, diffLoading: !!scope && diffLoading === selectionKey,
    comparison: scope && diff?.key === selectionKey ? diff.value : null,
    localCompare: !!scope && localCompare === selectionKey, closeCompare: () => setLocalCompare(null),
    activate, navigateView, codeActivation: codeActivation?.scope === scope ? codeActivation : undefined,
    locationNotice: scope ? locationNotice : "", listDirectory, directoryNeedsRefresh, retryDirectory, refreshDirectories, compareDisk, updateTree, prepareFile, mutateFile,
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
