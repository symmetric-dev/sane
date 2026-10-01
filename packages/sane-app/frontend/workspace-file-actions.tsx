import { useState } from "react";
import { ShellDialog } from "./shell-dialog";
import { useWorkspace } from "./workspace-controller";
import { dirty } from "./workspace-store";
import { WorkspaceError } from "./workspace-client";

export type FileOperation = "create" | "copy" | "delete" | "rename";
const titles = { create: "New file", copy: "Copy file", delete: "Delete file", rename: "Rename file" };
export function copyDestination(path: string) {
  const slash = path.lastIndexOf("/"), dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}-copy${path.slice(dot)}` : `${path}-copy`;
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
