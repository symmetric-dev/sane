import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "./workspace-controller";
import { workspaceEpoch, workspaceFailure } from "./workspace-store";
import { copyDestination, FileOperationDialog, type FileOperation } from "./workspace-file-actions";
import { useWorkspaceSearchContext } from "./workspace-search";
import { useRegisterCommand } from "./application-commands";
import { FILE_SHORTCUTS } from "./shortcut-definitions";

type Controller = ReturnType<typeof useWorkspace>;
export function workspaceFileScopeKey(scope: Controller["scope"]) {
  return scope ? JSON.stringify([scope.id, scope.workspace.workspaceId, scope.generation, scope.auth]) : "";
}
type FileTarget = { path: string; kind: "file" | "directory"; tree: HTMLElement };
type FileClipboard = { scopeKey: string; path: string; revision: string };
type OperationRequest = { scopeKey: string; kind: FileOperation; source: string; destination?: string; revision?: string; tree?: HTMLElement };
type Notice = { scopeKey: string; text: string; error?: boolean };

/** Resolve the actual keyboard owner, never the unrelated file open in the editor. */
function fileTarget(target: EventTarget | null, scopeKey: string): FileTarget | null {
  if (!(target instanceof HTMLElement) || target.closest('input, textarea, select, [contenteditable="true"], .cm-editor, .xterm, [hidden], [inert]')) return null;
  const row = target.closest<HTMLElement>("[data-workspace-file-kind]");
  const tree = row?.closest<HTMLElement>("[data-workspace-file-tree]");
  if (!row || !tree || tree.dataset.workspaceScope !== scopeKey) return null;
  const kind = row.dataset.workspaceFileKind;
  return kind === "file" || kind === "directory" ? { path: row.dataset.workspaceFilePath ?? "", kind, tree } : null;
}

const FileOperationsContext = createContext<ReturnType<typeof useFileOperations> | null>(null);
export const useWorkspaceFileOperations = () => useContext(FileOperationsContext);

function useFileOperations() {
  const controller = useWorkspace(), search = useWorkspaceSearchContext();
  const { scope, view, root } = controller, scopeKey = workspaceFileScopeKey(scope);
  const sidebarAvailable = !!scope && view === "code" && search?.mode !== "search";
  const [operation, setOperation] = useState<OperationRequest | null>(null);
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const acquisition = useRef(0), inFlight = useRef(false);
  const restore = useRef<{ scopeKey: string; tree: HTMLElement; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const identity = useRef({ scope, view, sidebarAvailable }); identity.current = { scope, view, sidebarAvailable };
  const current = () => !!scope && identity.current.scope === scope && scope.auth === workspaceEpoch();
  const activeOperation = operation?.scopeKey === scopeKey && view === "code" ? operation : null;
  const activeClipboard = clipboard?.scopeKey === scopeKey ? clipboard : null;
  const busy = preparing === scopeKey || !!activeOperation;
  function clearRestore() { if (restore.current?.timer) clearTimeout(restore.current.timer); restore.current = null; }

  useEffect(() => {
    acquisition.current++; inFlight.current = false;
    setClipboard(null); setOperation(null); setNotice(null); setPreparing(null); clearRestore();
    return clearRestore;
  }, [scopeKey]);
  useEffect(() => { setOperation(null); setNotice(null); clearRestore(); }, [view, search?.mode]);
  // Renaming/deleting a copied source through any entry point invalidates its reference.
  useEffect(() => {
    if (activeClipboard && !root?.buffers.has(activeClipboard.path)) setClipboard(null);
  });

  function open(kind: FileOperation, source = "", destination?: string, revision?: string) {
    if (!current() || view !== "code" || busy || inFlight.current) return;
    const target = fileTarget(document.activeElement, scopeKey);
    setNotice(null);
    setOperation({ scopeKey, kind, source, destination, revision, tree: target?.tree });
  }
  async function copy(path: string) {
    if (!current() || !sidebarAvailable || busy || inFlight.current) return;
    inFlight.current = true;
    const request = ++acquisition.current;
    setPreparing(scopeKey); setNotice(null); setClipboard(null);
    try {
      const buffer = await controller.prepareFile(path);
      if (!buffer || !current() || request !== acquisition.current || !identity.current.sidebarAvailable) return;
      const file = buffer.disk ?? buffer.file;
      if (!file.revision) throw new Error("This file cannot be copied. Files must be no larger than 256 KiB.");
      setClipboard({ scopeKey, path, revision: file.revision });
      setNotice({ scopeKey, text: `Copied file reference: ${path}. Paste copies saved disk contents, not unsaved edits.` });
    } catch (error) {
      if (current() && request === acquisition.current) setNotice({ scopeKey, text: workspaceFailure(error), error: true });
    } finally {
      if (request === acquisition.current) { inFlight.current = false; setPreparing(null); }
    }
  }
  function paste(target: FileTarget) {
    if (!activeClipboard || !sidebarAvailable) return;
    const parent = target.kind === "directory" ? target.path : target.path.split("/").slice(0, -1).join("/");
    const sourceParent = activeClipboard.path.split("/").slice(0, -1).join("/");
    const name = (parent === sourceParent ? copyDestination(activeClipboard.path) : activeClipboard.path).split("/").at(-1)!;
    open("copy", activeClipboard.path, parent ? `${parent}/${name}` : name, activeClipboard.revision);
  }
  function close() {
    clearRestore();
    if (activeOperation?.tree?.isConnected) {
      const tree = activeOperation.tree;
      restore.current = { scopeKey, tree, timer: setTimeout(() => restoreTreeFocus(tree, true), 1500) };
    }
    setOperation(null);
  }
  function restoreTreeFocus(tree: HTMLElement | null, fallback = false) {
    const pending = restore.current;
    if (!tree || !pending || pending.scopeKey !== scopeKey || pending.tree !== tree || !tree.isConnected || !current() || !identity.current.sidebarAvailable) return;
    const focused = root?.codeTree.focusedItem;
    const path = focused?.slice(focused.indexOf(":") + 1);
    const rows = [...tree.querySelectorAll<HTMLElement>("[data-workspace-file-kind]")];
    const target = rows.find(row => row.dataset.workspaceFilePath === path && !row.hasAttribute("aria-disabled"));
    // Lazy tree hydration may still be loading the resulting file.
    if (!target && path && !fallback) return;
    clearRestore();
    const parent = path?.split("/").slice(0, -1).join("/");
    (target ?? rows.find(row => row.dataset.workspaceFileKind === "directory" && row.dataset.workspaceFilePath === parent) ?? rows.find(row => !row.hasAttribute("aria-disabled")) ?? tree).focus();
  }
  return { controller, scopeKey, sidebarAvailable, busy, clipboard: activeClipboard, operation: activeOperation,
    notice: notice?.scopeKey === scopeKey && view === "code" ? notice : null,
    open, copy, paste, close, restoreTreeFocus,
    focusedTarget: () => fileTarget(document.activeElement, scopeKey),
    eligibleTarget: (event: KeyboardEvent) => fileTarget(event.target, scopeKey),
  };
}

/** One clipboard/dialog/command owner above both desktop sidebar and mobile drawer. */
export function WorkspaceFileShortcuts({ children }: { children: ReactNode }) {
  const actions = useFileOperations(), operation = actions.operation;
  return <FileOperationsContext.Provider value={actions}>
    {(["rename", "delete", "copy", "paste"] as const).map(kind => <SidebarFileCommand key={kind} kind={kind} actions={actions} />)}
    {children}
    {operation && <FileOperationDialog key={`${operation.scopeKey}:${operation.kind}:${operation.source}`}
      operation={operation.kind} source={operation.source} initialDestination={operation.destination} expectedRevision={operation.revision} close={actions.close}
      restoreFocus={operation.tree ? () => operation.tree?.isConnected ? operation.tree : null : undefined} />}
  </FileOperationsContext.Provider>;
}

function SidebarFileCommand({ kind, actions }: { kind: "rename" | "delete" | "copy" | "paste"; actions: ReturnType<typeof useFileOperations> }) {
  const current = useRef(actions); current.current = actions;
  useRegisterCommand(useMemo(() => ({
    ...FILE_SHORTCUTS[kind], contexts: ["application"] as const, priority: 20,
    available: () => {
      const value = current.current;
      return value.sidebarAvailable && !value.busy && !!value.controller.scope && value.controller.scope.auth === workspaceEpoch() && (kind !== "paste" || !!value.clipboard);
    },
    keyboardEligible: (event: KeyboardEvent) => {
      const value = current.current, target = value.eligibleTarget(event), focused = value.focusedTarget();
      if (!target || !focused || focused.path !== target.path || focused.tree !== target.tree || (kind !== "paste" && target.kind !== "file")) return false;
      const buffer = value.controller.root?.buffers.get(target.path);
      return !buffer?.saving && !buffer?.checking;
    },
    action: () => {
      const value = current.current, target = value.focusedTarget();
      if (!target) return;
      if (kind === "paste") value.paste(target);
      else if (target.kind === "file") {
        if (kind === "copy") void value.copy(target.path);
        else value.open(kind, target.path);
      }
    },
  }), [kind]));
  return null;
}
