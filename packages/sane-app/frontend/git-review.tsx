import { useLayoutEffect, useMemo, useRef, useState, type RefObject, type SetStateAction } from "react";
import type { EditorView } from "@codemirror/view";
import { hotkeysCoreFeature, syncDataLoaderFeature } from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import type { GitComparison, GitEntry, WorkspaceDiff, WorkspaceGit } from "../src/workspace-contract";
import { WorkspaceDiffEditor } from "./workspace-editor";
import "./workspace.css";
import "./git-review.css";

const groups = ["staged", "unstaged", "untracked"] as const;
type GitNode = { kind: "directory" | "group" | "file" | "notice"; path: string; name: string; comparison?: GitComparison; entry?: GitEntry };
const gitId = (kind: GitNode["kind"], comparison: GitComparison, path: string) => `${kind}:${comparison}:${path}`;
const isFolder = (node: GitNode) => node.kind === "directory" || node.kind === "group";
const missingNode: GitNode = { kind: "notice", path: "", name: "Updating changes…" };

/** Optional shell bookmark adapter. Standalone consumers need no external tree state. */
export type GitTreePresentation = {
  state: { expandedItems: string[]; focusedItem: string | null };
  setExpandedItems: (value: SetStateAction<string[]>) => void;
  setFocusedItem: (value: SetStateAction<string | null>) => void;
};

export type GitChangesTreeProps = {
  git: WorkspaceGit | undefined;
  selectedPath: string;
  comparison: GitComparison;
  onSelect: (path: string, comparison: GitComparison) => void;
  disabled?: boolean;
  presentation?: GitTreePresentation;
  isUnsaved?: (path: string) => boolean;
  error?: string;
};

/** A controlled file selection with independent expansion and keyboard focus. */
export function GitChangesTree({ git, selectedPath, comparison, onSelect, disabled = false, presentation, isUnsaved, error }: GitChangesTreeProps) {
  const [expandedItems, setExpandedItems] = useState<string[]>(() => groups.map(group => gitId("group", group, "")));
  const [focusedItem, setFocusedItem] = useState<string | null>(null);
  const ownedPresentation = { state: { expandedItems, focusedItem }, setExpandedItems, setFocusedItem };
  const current = presentation ?? ownedPresentation;
  const focusedElement = useRef<HTMLElement | null>(null);
  const previousFocus = useRef<{ node: GitNode; index: number } | null>(null);
  const hierarchy = useMemo(() => {
    const nodes = new Map<string, GitNode>(), children = new Map<string, string[]>();
    nodes.set("root", { kind: "directory", path: "", name: "Changes" });
    children.set("root", []);
    const add = (id: string, node: GitNode, parent: string) => {
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
        // Comparison is part of the identity: partially staged files have two rows.
        add(gitId("file", comparison, entry.path), { kind: "file", path: entry.path, name: parts.at(-1)!, comparison, entry }, parent);
      }
    }
    for (const ids of children.values()) if (ids !== children.get("root")) ids.sort((a, b) => {
      const left = nodes.get(a)!, right = nodes.get(b)!;
      return Number(isFolder(right)) - Number(isFolder(left)) || left.name.localeCompare(right.name);
    });
    return { nodes, children };
  }, [git]);
  const tree = useTree<GitNode>({
    rootItemId: "root", ...current,
    getItemName: item => item.getItemData().name,
    isItemFolder: item => isFolder(item.getItemData()),
    onPrimaryAction: item => {
      const node = item.getItemData();
      if (!disabled && node.kind === "file") onSelect(node.path, node.comparison!);
    },
    dataLoader: { getItem: id => hierarchy.nodes.get(id) ?? missingNode, getChildren: id => hierarchy.children.get(id) ?? [] },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });
  useLayoutEffect(() => { tree.rebuildTree(); }, [tree, hierarchy]);
  useLayoutEffect(() => {
    const items = tree.getItems();
    const focused = items.find(item => item.getId() === tree.getState().focusedItem);
    if (focused) previousFocus.current = { node: focused.getItemData(), index: focused.getItemMeta().index };
    else if (items.length && tree.getState().focusedItem !== null) {
      const previous = previousFocus.current;
      // Follow a moved file if visible, otherwise its containing folder/group,
      // the controlled selection, or the closest surviving row.
      const replacement = items.find(item => previous?.node.kind === "file" && item.getItemData().kind === "file" && item.getItemData().path === previous.node.path)
        ?? items.findLast(item => {
          const node = item.getItemData();
          return previous && isFolder(node) && node.comparison === previous.node.comparison && (!node.path || previous.node.path.startsWith(`${node.path}/`));
        })
        ?? items.find(item => item.getId() === gitId("file", comparison, selectedPath))
        ?? items[Math.min(previous?.index ?? 0, items.length - 1)];
      replacement?.setFocused();
    }
    // Only restore DOM focus if a focused row was removed, never steal it from
    // a dialog, editor, or operation button outside the tree.
    if (focusedElement.current && !focusedElement.current.isConnected && (document.activeElement === document.body || !document.activeElement)) {
      const next = tree.getItems().find(item => item.isFocused())?.getElement();
      if (next) { next.focus(); focusedElement.current = next; }
    }
  });
  if (!git) return <p className="workspace-tree-status" role={error ? "alert" : "status"}>{error || "Loading changes…"}</p>;
  if (!git.available) return <p className="workspace-tree-status">{git.reason || "This workspace is not in a Git repository."}</p>;
  const items = tree.getItems(), visibleFocus = items.some(item => item.isFocused());
  return <div className="git-changes-tree">
    <div {...tree.getContainerProps("Changed files")} className="workspace-tree" aria-multiselectable={false} aria-disabled={disabled || undefined}
      onFocusCapture={event => { focusedElement.current = event.target as HTMLElement; }}>
      {items.map(item => {
        const node = item.getItemData(), folder = isFolder(node), entry = node.entry;
        const selected = node.kind === "file" && selectedPath === node.path && comparison === node.comparison;
        const unsaved = node.kind === "file" && isUnsaved?.(node.path);
        const metadata = [entry ? node.comparison === "staged" ? entry.index : entry.worktree : "", entry?.conflict ? "Conflict · text diff unavailable" : "", entry?.submodule ? "Submodule · text diff unavailable" : "", entry?.originalPath ? `from ${entry.originalPath}` : "", entry?.renameOutsideWorkspace ? "Rename outside workspace · text diff unavailable" : "", unsaved ? "Unsaved" : ""].filter(Boolean).join(" · ");
        return <button {...item.getProps()} key={item.getId()} type="button" className={`workspace-tree-row${selected ? " is-selected" : ""}${node.kind === "group" ? " is-group" : ""}`}
          aria-selected={selected} aria-disabled={disabled || node.kind === "notice" || undefined} aria-label={[node.name, metadata].filter(Boolean).join(" · ")}
          tabIndex={item.isFocused() || (!visibleFocus && item.getItemMeta().index === 0) ? 0 : -1}
          onFocus={() => { if (!item.isFocused()) item.setFocused(); }}
          style={{ paddingLeft: `${8 + item.getItemMeta().level * 15}px` }} title={[node.path, metadata].filter(Boolean).join("\n")}>
          <span className="workspace-tree-glyph" aria-hidden="true">{folder ? item.isExpanded() ? <FiChevronDown size={12} /> : <FiChevronRight size={12} /> : node.kind === "file" ? "·" : "—"}</span>
          <span className="workspace-tree-label"><span>{node.name}{unsaved ? " •" : ""}</span>{metadata && <small>{metadata}</small>}</span>
        </button>;
      })}
    </div>
    {!git.entries.length && <p className="workspace-tree-status">No changes in this workspace.</p>}
    {git.truncated && <p className="workspace-tree-status">Change listing is truncated.</p>}
  </div>;
}

export type GitDiffPreviewProps = {
  diff: WorkspaceDiff | null;
  loading?: boolean;
  error?: string;
  selectedPath?: string;
  viewRef: RefObject<EditorView | null>;
  unsaved?: boolean;
};

/** Saved Git contents only; null content is never treated as an empty file. */
export function GitDiffPreview({ diff, loading = false, error, selectedPath, viewRef, unsaved = false }: GitDiffPreviewProps) {
  const label = diff?.comparison === "staged" ? "HEAD → Index" : diff?.comparison === "untracked" ? "Empty → Working tree" : "Index → Working tree";
  const hasSelection = Boolean(selectedPath === undefined ? diff?.path : selectedPath);
  return <div className="git-diff-preview">
    {error && <div className="workspace-notice workspace-error" role="alert">{error}</div>}
    {loading ? <div className="workspace-empty" role="status">Loading diff…</div>
      : !hasSelection ? <div className="workspace-empty"><h2>Select a changed file</h2><p>Review staged, unstaged, and untracked saved contents.</p></div>
      : !diff || selectedPath && selectedPath !== diff.path ? <div className="workspace-empty"><h2>No changes for this selection</h2><p>Select a file from one of the change groups.</p></div>
      : <>
        <div className="workspace-notice">{diff.comparison} · {label} · {diff.beforeMode ?? "absent"} → {diff.afterMode ?? "absent"}{diff.originalPath ? ` · renamed from ${diff.originalPath}` : ""}{unsaved ? " · Unsaved local edits are not shown" : ""}</div>
        <div className="workspace-notice">Saved contents only. Text is LF-normalized and BOM-free; line-ending and BOM changes may not appear.</div>
        {diff.reason ? <div className="workspace-empty"><h2>Text diff unavailable</h2><p>{diff.reason}</p></div>
          : diff.before === null || diff.after === null ? <div className="workspace-empty">Text contents unavailable.</div>
          : diff.modeOnly ? <div className="workspace-empty"><h2>File mode changed</h2><p>Text contents are unchanged.</p></div>
          : diff.before === diff.after ? <div className="workspace-empty">No text changes.</div>
          : <WorkspaceDiffEditor viewRef={viewRef} path={diff.path} before={diff.before} after={diff.after} label={label} />}
      </>}
  </div>;
}
