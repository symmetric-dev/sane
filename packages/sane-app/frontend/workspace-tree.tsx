import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { FiChevronDown, FiChevronRight, FiRefreshCw, FiPlus, FiUpload } from "react-icons/fi";
import { asyncDataLoaderFeature, hotkeysCoreFeature, type TreeInstance } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import type { GitComparison, GitEntry, WorkspaceEntry } from "../src/workspace-contract";
import { dirty, workspaceEpoch } from "./workspace-store";
import { useWorkspace, type DirectoryResult } from "./workspace-controller";
import { FileOperationDialog } from "./workspace-file-actions";
import { WorkspaceSearchFiles, useWorkspaceSearchContext } from "./workspace-search";
import { useWorkspaceFileOperations, workspaceFileScopeKey } from "./workspace-file-shortcuts";
import { FILE_SHORTCUTS, shortcutHint } from "./shortcut-definitions";
import { GitChangesTree } from "./git-review";
import { ImageUploadDialog } from "./image-upload-dialog";
import type { ImageUploadReceipt } from "../shared/image-upload-contract";

type TreeNode = {
  kind: WorkspaceEntry["kind"] | "group" | "error" | "notice";
  path: string; name: string; comparison?: GitComparison; entry?: GitEntry; detail?: string;
};
const codeId = (kind: TreeNode["kind"], path: string) => `${kind}:${path}`;
const isFolder = (node: TreeNode) => node.kind === "directory" || node.kind === "group";
const loadingNode: TreeNode = { kind: "notice", path: "", name: "Loading…" };
const apply = <T,>(value: SetStateAction<T>, previous: T) => typeof value === "function" ? (value as (previous: T) => T)(previous) : value;
type LoadedDirectory = {
  loaded: boolean; result?: DirectoryResult; nextResult?: DirectoryResult;
  loading?: { promise: Promise<void>; resolve: () => void };
  refresh?: Promise<void>;
};

function usePresentation(mode: "code" | "git") {
  const controller = useWorkspace(), presentation = controller.root![mode === "code" ? "codeTree" : "gitTree"];
  return {
    state: { expandedItems: presentation.expandedItems, focusedItem: presentation.focusedItem },
    setExpandedItems: (value: SetStateAction<string[]>) => controller.updateTree(mode, { expandedItems: apply(value, presentation.expandedItems) }),
    setFocusedItem: (value: SetStateAction<string | null>) => controller.updateTree(mode, { focusedItem: apply(value, presentation.focusedItem) }),
  };
}

function TreeRows({ tree, mode }: { tree: TreeInstance<TreeNode>; mode: "code" | "git" }) {
  const { root, scope } = useWorkspace(), operations = useWorkspaceFileOperations();
  const container = useRef<HTMLDivElement>(null);
  const registerContainer = useCallback((element: HTMLDivElement | null) => { container.current = element; tree.registerElement(element); }, [tree]);
  // Run after the dialog's passive cleanup, which returns focus to this container.
  useEffect(() => { if (mode === "code") operations?.restoreTreeFocus(container.current); });
  const items = tree.getItems();
  // Preserve shared focus during lazy hydration; a missing row still leaves a usable tab stop.
  const visibleFocus = items.some(item => item.isFocused());
  return <div {...tree.getContainerProps(mode === "code" ? "Workspace files" : "Changed files")} ref={registerContainer} className="workspace-tree" aria-multiselectable={false}
    aria-busy={mode === "code" && tree.getState().loadingItemChildrens.length > 0 || undefined}
    data-workspace-file-tree={mode === "code" ? "" : undefined} data-workspace-scope={mode === "code" ? workspaceFileScopeKey(scope) : undefined}
    data-workspace-file-kind={mode === "code" ? "directory" : undefined} data-workspace-file-path={mode === "code" ? "" : undefined}
    tabIndex={mode === "code" ? 0 : undefined}>
    {items.map(item => {
      const node = item.getItemData(), folder = isFolder(node);
      const selected = node.kind === "file" && root!.selected === node.path && (mode === "code" || root!.comparison === node.comparison);
      const buffer = root!.buffers.get(node.path), unsaved = buffer && dirty(buffer);
      const unavailable = node.kind === "symlink" || node.kind === "other" || node.kind === "notice";
      const entry = node.entry;
      const metadata = [node.detail, entry?.conflict ? "Conflict" : entry?.submodule ? "Submodule" : entry ? node.comparison === "staged" ? entry.index : entry.worktree : "", entry?.originalPath ? `from ${entry.originalPath}` : "", entry?.renameOutsideWorkspace ? "Rename outside workspace" : "", unsaved ? "Unsaved" : ""].filter(Boolean).join(" · ");
      return <button {...item.getProps()} key={item.getId()} type="button" className={`workspace-tree-row${selected ? " is-selected" : ""}${node.kind === "group" ? " is-group" : ""}${node.kind === "error" ? " is-error" : ""}`}
        aria-selected={selected} aria-disabled={unavailable || undefined} aria-label={[node.name, metadata].filter(Boolean).join(" · ")} aria-busy={item.isLoading() || undefined}
        tabIndex={item.isFocused() || (!visibleFocus && item.getItemMeta().index === 0) ? 0 : -1}
        onFocus={() => { if (!item.isFocused()) item.setFocused(); }}
        data-workspace-file-kind={mode === "code" ? node.kind : undefined} data-workspace-file-path={mode === "code" ? node.path : undefined}
        style={{ paddingLeft: `${8 + item.getItemMeta().level * 15}px` }} title={[node.path, metadata, mode === "code" && node.kind === "file" ? `Rename: ${shortcutHint(FILE_SHORTCUTS.rename)} · Delete: ${shortcutHint(FILE_SHORTCUTS.delete)} · Copy: ${shortcutHint(FILE_SHORTCUTS.copy)} · Paste: ${shortcutHint(FILE_SHORTCUTS.paste)}` : ""].filter(Boolean).join("\n")}>
        <span className="workspace-tree-glyph" aria-hidden="true">{folder ? item.isExpanded() ? <FiChevronDown size={12} aria-hidden="true" /> : <FiChevronRight size={12} aria-hidden="true" /> : node.kind === "error" ? <FiRefreshCw size={12} aria-hidden="true" /> : node.kind === "file" ? "·" : "—"}</span>
        <span className="workspace-tree-label"><span>{node.name}{unsaved ? " •" : ""}</span>{metadata && <small>{metadata}</small>}</span>
        {item.isLoading() && <span className="workspace-tree-loading" role="status">…</span>}
      </button>;
    })}
  </div>;
}

function CodeTree() {
  const controller = useWorkspace(), presentation = usePresentation("code");
  const [refreshError, setRefreshError] = useState("");
  const directories = useRef(new Map<string, LoadedDirectory>());
  const owner = useRef(controller); owner.current = controller;
  const active = useRef(true);
  const tree = useTree<TreeNode>({
    rootItemId: codeId("directory", ""), ...presentation,
    getItemName: item => item.getItemData().name,
    isItemFolder: item => isFolder(item.getItemData()),
    createLoadingItemData: () => loadingNode,
    onPrimaryAction: item => {
      const node = item.getItemData();
      if (node.kind === "file") controller.activate({ view: "code", path: node.path });
      if (node.kind === "error") controller.retryDirectory(node.path);
    },
    onLoadedChildren: id => {
      const directory = directories.current.get(id)!;
      directory.loaded = true; directory.result = directory.nextResult;
      // This hook runs after HT writes the cache, but before its synchronous
      // rebuild/loading cleanup. Promise continuations run after that cleanup.
      directory.loading?.resolve(); directory.loading = undefined;
    },
    dataLoader: {
      getItem: (id): TreeNode => ({ kind: "directory", path: id.slice(id.indexOf(":") + 1), name: "Workspace" }),
      getChildrenWithData: async id => {
        let directory = directories.current.get(id);
        if (!directory) {
          directory = { loaded: false };
          directories.current.set(id, directory);
        }
        // Track actual initial AND optimistic loads. HT's loadChildrenIds()
        // returns cached ids immediately during optimistic refresh, so it is
        // not an adequate completion fence. Resolve only in onLoadedChildren.
        let resolve!: () => void;
        const promise = new Promise<void>(done => { resolve = done; });
        directory.loading = { promise, resolve };
        const path = id.slice(id.indexOf(":") + 1);
        const result = await controller.listDirectory(path);
        directory.nextResult = result;
        const { listing, error } = result;
        if (error) return [{ id: codeId("error", path), data: { kind: "error" as const, path, name: "Could not load folder · Retry", detail: error } }];
        if (!listing) return [{ id: codeId("error", path), data: { kind: "error" as const, path, name: "Could not load folder · Retry", detail: "Workspace changed. Reopen its files." } }];
        const nodes: { id: string; data: TreeNode }[] = listing.entries.map(entry => ({ id: codeId(entry.kind, entry.path), data: { ...entry, detail: entry.kind === "symlink" ? "Symlink · unavailable" : entry.kind === "other" ? "Unsupported" : undefined } }));
        if (listing.truncated) nodes.push({ id: codeId("notice", path), data: { kind: "notice", path, name: "Folder listing truncated", detail: "Open a subfolder to narrow the list." } });
        else if (!nodes.length) nodes.push({ id: codeId("notice", path), data: { kind: "notice", path, name: "Empty folder" } });
        return nodes;
      },
    },
    features: [asyncDataLoaderFeature, hotkeysCoreFeature],
  });

  function reachable(id: string) {
    return id === codeId("directory", "") || tree.getItems().some(item => item.getId() === id && item.isExpanded());
  }
  function refreshDirectory(id: string): Promise<void> {
    const directory = directories.current.get(id);
    // Never invalidation-load unseen directories. Collapsed/hidden descendants
    // retain their children and reconcile on reachable expansion instead.
    if (!directory || !reachable(id) || (!directory.loaded && !directory.loading)) return Promise.resolve();
    if (directory.refresh) return directory.refresh;
    const path = id.slice(id.indexOf(":") + 1);
    if (!directory.loading && !owner.current.directoryNeedsRefresh(path, directory.result)) return Promise.resolve();
    // Assign ownership before starting, including the no-work completion path.
    directory.refresh = Promise.resolve().then(async () => {
      try {
        if (directory.loading) await directory.loading.promise;
        while (active.current && reachable(id) && owner.current.directoryNeedsRefresh(path, directory.result)) {
          setRefreshError("");
          // Retain cached rows, focus, and expansion. One owned optimistic
          // refresh per directory; shared controller records coalesce HTTP.
          await tree.getItemInstance(id).invalidateChildrenIds(true);
          // Recheck the latest revision: another mutation may land after the
          // loader resolved but before HT applied its children. No duplicate
          // mapping pass is needed when the initial read already caught up.
        }
      } catch (error) {
        if (active.current) setRefreshError("Could not refresh this folder. Use Refresh to try again.");
        throw error;
      } finally { directory.refresh = undefined; }
    });
    return directory.refresh;
  }
  async function revalidateVisible() {
    if (document.hidden) return;
    const ids = [codeId("directory", ""), ...tree.getItems().filter(item => item.isExpanded() && item.getId().startsWith("directory:")).map(item => item.getId())];
    const results = await Promise.allSettled(ids.map(id => refreshDirectory(id)));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  useEffect(() => {
    const scope = controller.scope!;
    active.current = true;
    const invalidate = (path: string) => refreshDirectory(codeId("directory", path));
    scope.invalidators.add(invalidate);
    scope.directoryRevalidators.add(revalidateVisible);
    return () => { active.current = false; scope.invalidators.delete(invalidate); scope.directoryRevalidators.delete(revalidateVisible); };
  }, [controller.scope, tree]);
  // Also covers entering Files, expansion and parent hydration. It does not
  // notify shared workspace/editor state and starts work only for stale caches.
  useEffect(() => { void revalidateVisible().catch(() => {}); });
  return <>{refreshError && <p className="workspace-tree-status workspace-error" role="alert">{refreshError}</p>}{tree.getState().loadingItemChildrens.includes(codeId("directory", "")) && <p className="workspace-tree-status" role="status">Loading files…</p>}<TreeRows tree={tree} mode="code" /></>;
}

function GitTree() {
  const controller = useWorkspace(), presentation = usePresentation("git"), git = controller.root!.git;
  return <GitChangesTree git={git} selectedPath={controller.root!.selected} comparison={controller.root!.comparison}
    presentation={presentation} error={controller.error}
    isUnsaved={path => { const buffer = controller.root!.buffers.get(path); return Boolean(buffer && dirty(buffer)); }}
    onSelect={(path, comparison) => controller.activate({ view: "git", path, comparison })} />;
}

type UploadLaunch = {
  scope: NonNullable<ReturnType<typeof useWorkspace>["scope"]>;
  bindingRevision: string;
  target: { workspaceId: string; worktreeId: string };
  initialDirectory: string;
};

function useFilesImageUpload(controller: ReturnType<typeof useWorkspace>) {
  const { scope, view } = controller;
  const picker = useRef<HTMLInputElement>(null), pending = useRef<UploadLaunch | null>(null);
  const latest = useRef(controller); latest.current = controller;
  const mounted = useRef(true);
  const [upload, setUpload] = useState<(UploadLaunch & { files: File[] }) | null>(null);
  const [notice, setNotice] = useState<{ owner: UploadLaunch; text: string; error?: boolean } | null>(null);
  function current(owner: UploadLaunch) {
    const live = latest.current;
    return mounted.current && live.view === "code" && live.scope === owner.scope
      && live.workspace?.bindingRevision === owner.bindingRevision
      && owner.scope.auth === workspaceEpoch() && owner.scope.reader.current();
  }
  useEffect(() => {
    pending.current = null; setUpload(null); setNotice(null);
    if (picker.current) picker.current.value = "";
  }, [scope, view]);
  useEffect(() => {
    mounted.current = true;
    const input = picker.current;
    const cancel = () => { if (input) input.value = ""; pending.current = null; };
    input?.addEventListener("cancel", cancel);
    return () => { mounted.current = false; pending.current = null; input?.removeEventListener("cancel", cancel); };
  }, []);
  function open() {
    if (!scope || view !== "code" || !picker.current) return;
    const [workspaceId, worktreeId] = JSON.parse(scope.id) as [string, string];
    const focused = controller.root?.codeTree.focusedItem;
    const parent = (path: string) => path.split("/").slice(0, -1).join("/");
    const initialDirectory = focused?.startsWith("directory:") ? focused.slice("directory:".length)
      : focused?.startsWith("file:") ? parent(focused.slice("file:".length)) : parent(controller.root?.selected ?? "");
    const owner: UploadLaunch = { scope, bindingRevision: scope.workspace.bindingRevision, target: { workspaceId, worktreeId }, initialDirectory };
    if (!current(owner)) return;
    // Capture before the native picker yields control. Never rebind a late selection.
    pending.current = owner; setNotice(null); picker.current.value = "";
    try { picker.current.click(); }
    catch {
      pending.current = null; picker.current.value = "";
      if (current(owner)) setNotice({ owner, text: "Could not open the image picker. Try again.", error: true });
    }
  }
  function uploaded(owner: UploadLaunch, receipts: ImageUploadReceipt[]) {
    if (!current(owner)) return;
    const committed = receipts.filter(receipt => receipt.workspaceId === owner.target.workspaceId
      && receipt.worktreeId === owner.target.worktreeId && receipt.bindingRevision === owner.bindingRevision);
    if (!committed.length) return;
    setNotice({ owner, text: `Uploaded ${committed.length} image${committed.length === 1 ? "" : "s"} to workspace files.` });
    // The upload client already publishes committed mutations; only refresh this Files owner.
    void latest.current.refreshDirectories().catch(() => {});
  }
  return {
    open, busy: !!upload && current(upload),
    notice: notice && current(notice.owner) ? notice : null,
    elements: <>
      <input ref={picker} type="file" accept=".png,.jpg,.jpeg,.webp" multiple hidden aria-label="Choose images to upload"
        onChange={event => {
          const files = Array.from(event.currentTarget.files ?? []), owner = pending.current;
          event.currentTarget.value = ""; pending.current = null;
          if (owner && files.length && current(owner)) setUpload({ ...owner, files });
        }} />
      {upload && current(upload) && <ImageUploadDialog target={upload.target} expectedBindingRevision={upload.bindingRevision} files={upload.files} initialDirectory={upload.initialDirectory}
        onUploaded={receipts => uploaded(upload, receipts)} onClose={() => { if (current(upload)) setUpload(null); }} />}
    </>,
  };
}

export function WorkspaceSidebar() {
  const [creating, setCreating] = useState(false);
  const controller = useWorkspace(), { view, scope, workspace } = controller;
  const search = useWorkspaceSearchContext(), searching = view === "code" && search?.mode === "search";
  const operations = useWorkspaceFileOperations();
  const imageUpload = useFilesImageUpload(controller);
  useEffect(() => { setCreating(false); }, [scope, view]);
  return <section className="workspace-sidebar" aria-label={view === "code" ? "Code files" : "Git changes"}>
    {imageUpload.elements}
    {creating && scope && view === "code" && <FileOperationDialog key={`${scope.generation}:${workspace!.workspaceId}`} operation="create" source="" close={() => setCreating(false)} />}
    <div className="workspace-sidebar-content">
      {!searching && <div className="workspace-sidebar-heading"><h2>{view === "code" ? "Files" : "Changes"}</h2></div>}
      {workspace && <p className="workspace-sidebar-root" title={workspace.root}>{workspace.root.split("/").filter(Boolean).at(-1) || workspace.root}</p>}
      {operations?.notice && <p className={`workspace-tree-status${operations.notice.error ? " workspace-error" : ""}`} role={operations.notice.error ? "alert" : "status"}>{operations.notice.text}</p>}
      {imageUpload.notice && <p className={`workspace-tree-status${imageUpload.notice.error ? " workspace-error" : ""}`} role={imageUpload.notice.error ? "alert" : "status"}>{imageUpload.notice.text}</p>}
      {operations?.busy && !operations.operation && <p className="workspace-tree-status" role="status">Reading file for copy…</p>}
      {view === "git" && <p className="workspace-disclaimer">Saved contents; unsaved editor changes are not included.</p>}
      {!scope ? <p className="workspace-tree-status">{controller.resolving ? "Opening workspace…" : controller.error || "Open a workspace to browse its files."}</p>
        : view === "code" ? searching ? <WorkspaceSearchFiles /> : <CodeTree key={`${scope.generation}:${workspace!.workspaceId}`} /> : <GitTree key={`${scope.generation}:${workspace!.workspaceId}`} />}
    </div>
    {!searching && <footer className="workspace-sidebar-actions" aria-label="File shortcuts" style={{ flexWrap: "wrap" }}>
      {view === "code" && <button type="button" className="new-chat" style={{ flexBasis: "100%" }} disabled={!scope || operations?.busy || creating || imageUpload.busy} onClick={imageUpload.open}><FiUpload size={16} aria-hidden="true" />Upload images</button>}
      {view === "code" && <button type="button" className="new-chat" disabled={!scope || operations?.busy || imageUpload.busy} onClick={() => operations ? operations.open("create") : setCreating(true)}><FiPlus size={16} aria-hidden="true" />New file</button>}
      <button type="button" className="history-sidebar-button" disabled={!scope} onClick={view === "code" ? controller.refreshDirectories : controller.retrySelection} aria-label={view === "code" ? "Refresh files" : "Refresh changes"}><FiRefreshCw size={14} aria-hidden="true" />Refresh</button>
    </footer>}
  </section>;
}
