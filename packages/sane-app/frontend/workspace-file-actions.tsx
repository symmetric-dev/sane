import { useState, useSyncExternalStore } from "react";
import { ShellDialog } from "./shell-dialog";
import { useWorkspace } from "./workspace-controller";
import { dirty, workspaceEpoch } from "./workspace-store";
import { WorkspaceError } from "./workspace-client";
import { catalog, worktreeScope } from "./catalog";
import { store } from "./store";
import { executionPrefix, pathInsertion, safeRelativePath } from "./chat-path-token";
import { executionRelativePath } from "./workspace-path-matcher";

export type FileOperation = "create" | "copy" | "delete" | "rename";
const titles = { create: "New file", copy: "Copy file", delete: "Delete file", rename: "Rename file" };
export function copyDestination(path: string) {
  const slash = path.lastIndexOf("/"), dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}-copy${path.slice(dot)}` : `${path}-copy`;
}

function fileChatReference(controller: ReturnType<typeof useWorkspace>) {
  const { scope, buffer, selected, root } = controller;
  const state = store.snapshot(), repository = catalog.snapshot();
  const navigation = repository.navigation;
  const conversation = state.conversations.find(item => item.id === state.selected);
  if (!scope || scope.auth !== workspaceEpoch() || !scope.reader.current() || !buffer || buffer.path !== selected
    || controller.view !== "code" || navigation.view !== "code" || !navigation.workspaceId || !navigation.worktreeId
    || scope.id !== worktreeScope(navigation.workspaceId, navigation.worktreeId) || root?.selected !== selected
    || buffer.missing || buffer.error || root?.mutations.has(selected) || !selected || !safeRelativePath(selected)) {
    return "Open an available file before adding a reference.";
  }
  if (state.phase !== "ready" || !state.config?.authenticated || !repository.ready || state.loading || state.sending || state.actionBusy) {
    return "Wait for Chat to finish loading or sending before adding a reference.";
  }
  if (state.selected && (!conversation || conversation.replacedBy || conversation.association !== "resolved")) {
    return "Choose an available conversation before adding a reference.";
  }
  const workspaceId = state.selected ? conversation?.workspaceId : repository.navigation.workspaceId;
  const worktreeId = state.selected ? conversation?.worktreeId : repository.navigation.worktreeId;
  const worktree = repository.workspaces.find(item => item.workspaceId === workspaceId)?.worktrees.find(item => item.worktreeId === worktreeId);
  if (!workspaceId || !worktreeId || scope.id !== worktreeScope(workspaceId, worktreeId) || worktree?.state !== "available"
    || worktree.bindingRevision !== scope.workspace.bindingRevision || worktree.root !== scope.workspace.root) {
    return "Choose a chat in this worktree before adding a reference.";
  }
  const cwd = state.selected ? conversation!.cwd : store.draft().cwd || worktree.root;
  const prefix = executionPrefix(worktree.root, cwd);
  if (prefix === undefined) return "Choose a chat execution directory inside this worktree before adding a reference.";
  // A file outside a nested execution directory needs its absolute path. This
  // is plain prompt text, just like @ autocomplete, not a contents attachment.
  const path = executionRelativePath(selected, prefix) ?? `${worktree.root.replace(/\/$/, "")}/${selected}`;
  return { text: pathInsertion(path, false, false), selected: state.selected,
    key: JSON.stringify([store.draftKey(), state.config.storeId, workspaceEpoch(), worktree.bindingRevision, cwd]) };
}

/** Explicit file selection bypasses recursive discovery and its ignore policy. */
export function AddFileToChat({ close }: { close: () => void }) {
  const controller = useWorkspace();
  useSyncExternalStore(store.subscribe, store.snapshot);
  useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const target = fileChatReference(controller);
  return <>
    <button type="button" disabled={typeof target === "string"}
      title={typeof target === "string" ? target : "Add this file's path to the chat draft. File contents and unsaved edits are not attached; nothing is sent."}
      onClick={() => {
        const current = fileChatReference(controller);
        if (typeof target === "string" || typeof current === "string" || current.key !== target.key || current.text !== target.text) return;
        const text = store.draft().text;
        store.setDraft({ text: text + (text && !/\s$/.test(text) ? "\n" : "") + current.text + " " }, current.selected);
        close();
        controller.navigateView("chat");
      }}>Add to chat</button>
    {typeof target === "string" && <p className="muted">{target}</p>}
  </>;
}

export function FileOperationDialog({ operation, source, close, initialDestination, expectedRevision, restoreFocus }: { operation: FileOperation; source: string; close: () => void; initialDestination?: string; expectedRevision?: string; restoreFocus?: () => HTMLElement | null }) {
  const controller = useWorkspace(), buffer = controller.root?.buffers.get(source);
  const [path, setPath] = useState(operation === "rename" ? source.split("/").at(-1)! : initialDestination ?? (operation === "copy" ? copyDestination(source) : ""));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [committed, setCommitted] = useState(false);
  return <ShellDialog title={titles[operation]} close={() => { if (!busy) close(); }} closeDisabled={busy} restoreFocus={restoreFocus} className="workspace-file-dialog">
    <form onSubmit={async event => {
      event.preventDefault(); if (busy || committed) return;
      setBusy(true); setError("");
      try {
        if (operation === "rename" && (!path || path === "." || path === ".." || /[/\\\u0000-\u001f\u007f]/.test(path))) throw new Error("Enter a filename only, without folders or path separators.");
        const destination = operation === "rename" ? `${source.slice(0, source.lastIndexOf("/") + 1)}${path}` : path;
        if (await controller.mutateFile(operation, destination, source, expectedRevision)) close();
      }
      catch (error) { setError(error instanceof Error ? error.message : "File operation failed."); if (error instanceof WorkspaceError && error.code === "rename-committed") setCommitted(true); }
      finally { setBusy(false); }
    }}>
      {operation !== "create" && <p className="context-path">{source}</p>}
      {operation === "delete" ? <><p>Permanently delete this file from disk? This cannot be undone in the editor.</p>{buffer && dirty(buffer) && <p className="notice error">This file has unsaved edits. Deleting it will also discard those edits.</p>}</> : <>
        <div className="interaction-field"><label htmlFor="file-destination">{operation === "copy" ? "Copy to" : operation === "rename" ? "New filename" : "File path"}</label><input id="file-destination" autoFocus required value={path} disabled={busy || committed} placeholder={operation === "rename" ? "notes.md" : "docs/notes.md"} onChange={event => setPath(event.target.value)} maxLength={operation === "rename" ? 255 : 4096} aria-describedby="file-destination-help" />
          <small id="file-destination-help">{operation === "rename" ? "Use a filename only. The file stays in its current folder; existing files will not be overwritten." : "Use a workspace-relative path in an existing folder. Existing files will not be overwritten."}</small></div>
        {operation === "copy" && <p className="muted">Copies saved disk contents{buffer && dirty(buffer) ? "; unsaved edits are not included" : ""}.</p>}
      </>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <footer className="dialog-actions"><button type="button" disabled={busy} onClick={close}>{committed ? "Close" : "Cancel"}</button><button type="submit" className={operation === "delete" ? "workspace-delete" : ""} disabled={busy || committed || operation !== "delete" && !path}>{busy ? "Working…" : committed ? "Refresh required" : titles[operation]}</button></footer>
    </form>
  </ShellDialog>;
}
