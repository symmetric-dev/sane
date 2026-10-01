import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { FiChevronDown, FiChevronRight, FiRefreshCw, FiPlus } from "react-icons/fi";
import { asyncDataLoaderFeature, hotkeysCoreFeature, syncDataLoaderFeature, type TreeInstance } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import type { GitComparison, GitEntry, WorkspaceEntry } from "../src/workspace-contract";
import { dirty } from "./workspace-store";
import { useWorkspace } from "./workspace-controller";
import { FileOperationDialog } from "./workspace-file-actions";
import { WorkspaceSearchFiles, useWorkspaceSearchContext } from "./workspace-search";

type TreeNode = {
  kind: WorkspaceEntry["kind"] | "group" | "error" | "notice";
  path: string; name: string; comparison?: GitComparison; entry?: GitEntry; detail?: string;
};
const codeId = (kind: TreeNode["kind"], path: string) => `${kind}:${path}`;
const gitId = (kind: TreeNode["kind"], comparison: GitComparison, path: string) => `${kind}:${comparison}:${path}`;
const groups = ["staged", "unstaged", "untracked"] as const;
const isFolder = (node: TreeNode) => node.kind === "directory" || node.kind === "group";
const loadingNode: TreeNode = { kind: "notice", path: "", name: "Loading…" };
const apply = <T,>(value: SetStateAction<T>, previous: T) => typeof value === "function" ? (value as (previous: T) => T)(previous) : value;

function usePresentation(mode: "code" | "git") {
  const controller = useWorkspace(), presentation = controller.root![mode === "code" ? "codeTree" : "gitTree"];
  return {
    state: { expandedItems: presentation.expandedItems, focusedItem: presentation.focusedItem },
    setExpandedItems: (value: SetStateAction<string[]>) => controller.updateTree(mode, { expandedItems: apply(value, presentation.expandedItems) }),
    setFocusedItem: (value: SetStateAction<string | null>) => controller.updateTree(mode, { focusedItem: apply(value, presentation.focusedItem) }),
  };
}

function TreeRows({ tree, mode }: { tree: TreeInstance<TreeNode>; mode: "code" | "git" }) {
  const { root } = useWorkspace();
  const items = tree.getItems();
  // Preserve shared focus during lazy hydration; a missing row still leaves a usable tab stop.
  const visibleFocus = items.some(item => item.isFocused());
  return <div {...tree.getContainerProps(mode === "code" ? "Workspace files" : "Changed files")} className="workspace-tree" aria-multiselectable={false}>
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
        style={{ paddingLeft: `${8 + item.getItemMeta().level * 15}px` }} title={[node.path, metadata].filter(Boolean).join("\n")}>
        <span className="workspace-tree-glyph" aria-hidden="true">{folder ? item.isExpanded() ? <FiChevronDown size={12} aria-hidden="true" /> : <FiChevronRight size={12} aria-hidden="true" /> : node.kind === "error" ? <FiRefreshCw size={12} aria-hidden="true" /> : node.kind === "file" ? "·" : "—"}</span>
        <span className="workspace-tree-label"><span>{node.name}{unsaved ? " •" : ""}</span>{metadata && <small>{metadata}</small>}</span>
        {item.isLoading() && <span className="workspace-tree-loading" role="status">…</span>}
      </button>;
    })}
  </div>;
}

function CodeTree() {
  const controller = useWorkspace(), presentation = usePresentation("code");
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
    dataLoader: {
      getItem: (id): TreeNode => ({ kind: "directory", path: id.slice(id.indexOf(":") + 1), name: "Workspace" }),
      getChildrenWithData: async id => {
        const path = id.slice(id.indexOf(":") + 1);
        const { listing, error } = await controller.listDirectory(path);
        if (error) return [{ id: codeId("error", path), data: { kind: "error" as const, path, name: "Could not load folder · Retry", detail: error } }];
        if (!listing) return [];
        const nodes: { id: string; data: TreeNode }[] = listing.entries.map(entry => ({ id: codeId(entry.kind, entry.path), data: { ...entry, detail: entry.kind === "symlink" ? "Symlink · unavailable" : entry.kind === "other" ? "Unsupported" : undefined } }));
        if (listing.truncated) nodes.push({ id: codeId("notice", path), data: { kind: "notice", path, name: "Folder listing truncated", detail: "Open a subfolder to narrow the list." } });
        else if (!nodes.length) nodes.push({ id: codeId("notice", path), data: { kind: "notice", path, name: "Empty folder" } });
        return nodes;
      },
    },
    features: [asyncDataLoaderFeature, hotkeysCoreFeature],
  });
  useEffect(() => {
    const scope = controller.scope!;
    const invalidate = (path: string) => {
      const id = codeId("directory", path);
      // Let any in-flight loader settle before invalidating; HT coalesces invalidation while loading.
      void tree.loadChildrenIds(id).then(() => tree.getItemInstance(id).invalidateChildrenIds());
    };
    scope.invalidators.add(invalidate);
    return () => { scope.invalidators.delete(invalidate); };
  }, [controller.scope, tree]);
  return <>{tree.getState().loadingItemChildrens.includes(codeId("directory", "")) && <p className="workspace-tree-status" role="status">Loading files…</p>}<TreeRows tree={tree} mode="code" /></>;
}

function GitTree() {
  const controller = useWorkspace(), presentation = usePresentation("git"), git = controller.root!.git;
  const hierarchy = useMemo(() => {
    const nodes = new Map<string, TreeNode>(), children = new Map<string, string[]>();
    nodes.set("root", { kind: "directory", path: "", name: "Changes" });
    children.set("root", []);
    const add = (id: string, node: TreeNode, parent: string) => {
      if (nodes.has(id)) return;
      nodes.set(id, node); children.set(id, []); children.get(parent)!.push(id);
    };
    for (const comparison of groups) {
      const entries = git?.entries.filter(entry => entry.comparisons.includes(comparison)) ?? [];
      const group = gitId("group", comparison, "");
      add(group, { kind: "group", path: "", comparison, name: `${comparison[0].toUpperCase()}${comparison.slice(1)} (${entries.length})` }, "root");
      for (const entry of entries) {
        const parts = entry.path.split("/");
        let parent = group;
        for (let index = 0; index < parts.length - 1; index++) {
          const path = parts.slice(0, index + 1).join("/"), id = gitId("directory", comparison, path);
          add(id, { kind: "directory", path, comparison, name: parts[index]! }, parent); parent = id;
        }
        add(gitId("file", comparison, entry.path), { kind: "file", path: entry.path, name: parts.at(-1)!, comparison, entry }, parent);
      }
    }
    for (const ids of children.values()) if (ids !== children.get("root")) ids.sort((a, b) => {
      const left = nodes.get(a)!, right = nodes.get(b)!;
      return Number(isFolder(right)) - Number(isFolder(left)) || left.name.localeCompare(right.name);
    });
    return { nodes, children };
  }, [git]);
  const tree = useTree<TreeNode>({
    rootItemId: "root", ...presentation,
    getItemName: item => item.getItemData().name,
    isItemFolder: item => isFolder(item.getItemData()),
    onPrimaryAction: item => {
      const node = item.getItemData();
      if (node.kind === "file") controller.activate({ view: "git", path: node.path, comparison: node.comparison! });
    },
    dataLoader: { getItem: id => hierarchy.nodes.get(id) ?? loadingNode, getChildren: id => hierarchy.children.get(id) ?? [] },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });
  useEffect(() => { tree.rebuildTree(); }, [tree, hierarchy]);
  if (!git) return <p className="workspace-tree-status" role="status">{controller.error || "Loading changes…"}</p>;
  if (!git.available) return <p className="workspace-tree-status">{git.reason || "This workspace is not in a Git repository."}</p>;
  return <><TreeRows tree={tree} mode="git" />{!git.entries.length && <p className="workspace-tree-status">No changes in this workspace.</p>}{git.truncated && <p className="workspace-tree-status">Change listing is truncated.</p>}</>;
}

export function WorkspaceSidebar() {
  const [creating, setCreating] = useState(false);
  const controller = useWorkspace(), { view, scope, workspace } = controller;
  const search = useWorkspaceSearchContext(), searching = view === "code" && search?.mode === "search";
  useEffect(() => { setCreating(false); }, [scope, view]);
  return <section className="workspace-sidebar" aria-label={view === "code" ? "Code files" : "Git changes"}>
    {creating && scope && view === "code" && <FileOperationDialog key={`${scope.generation}:${workspace!.workspaceId}`} operation="create" source="" close={() => setCreating(false)} />}
    <div className="workspace-sidebar-content">
      {!searching && <div className="workspace-sidebar-heading"><h2>{view === "code" ? "Files" : "Changes"}</h2></div>}
      {workspace && <p className="workspace-sidebar-root" title={workspace.root}>{workspace.root.split("/").filter(Boolean).at(-1) || workspace.root}</p>}
      {view === "git" && <p className="workspace-disclaimer">Saved contents; unsaved editor changes are not included.</p>}
      {!scope ? <p className="workspace-tree-status">{controller.resolving ? "Opening workspace…" : controller.error || "Open a workspace to browse its files."}</p>
        : view === "code" ? searching ? <WorkspaceSearchFiles /> : <CodeTree key={`${scope.generation}:${workspace!.workspaceId}`} /> : <GitTree key={`${scope.generation}:${workspace!.workspaceId}`} />}
    </div>
    {!searching && <footer className="workspace-sidebar-actions" aria-label="File shortcuts">
      {view === "code" && <button type="button" className="new-chat" disabled={!scope} onClick={() => setCreating(true)}><FiPlus size={16} aria-hidden="true" />New file</button>}
      <button type="button" className="history-sidebar-button" disabled={!scope} onClick={view === "code" ? controller.refreshDirectories : controller.retrySelection} aria-label={view === "code" ? "Refresh files" : "Refresh changes"}><FiRefreshCw size={14} aria-hidden="true" />Refresh</button>
    </footer>}
  </section>;
}
