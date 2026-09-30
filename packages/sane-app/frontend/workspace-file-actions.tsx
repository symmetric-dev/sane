import { useState } from "react";
import { ShellDialog } from "./shell-dialog";
import { useWorkspace } from "./workspace-controller";
import { dirty } from "./workspace-store";

export type FileOperation = "create" | "copy" | "delete";
const titles = { create: "New file", copy: "Copy file", delete: "Delete file" };
export function copyDestination(path: string) {
  const slash = path.lastIndexOf("/"), dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}-copy${path.slice(dot)}` : `${path}-copy`;
}

export function FileOperationDialog({ operation, source, close }: { operation: FileOperation; source: string; close: () => void }) {
  const controller = useWorkspace(), buffer = controller.root?.buffers.get(source);
  const [path, setPath] = useState(operation === "copy" ? copyDestination(source) : "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <ShellDialog title={titles[operation]} close={() => { if (!busy) close(); }} className="workspace-file-dialog">
    <form onSubmit={async event => {
      event.preventDefault(); if (busy) return;
      setBusy(true); setError("");
      try { if (await controller.mutateFile(operation, path, source)) close(); }
      catch (error) { setError(error instanceof Error ? error.message : "File operation failed."); }
      finally { setBusy(false); }
    }}>
      {operation !== "create" && <p className="context-path">{source}</p>}
      {operation === "delete" ? <><p>Permanently delete this file from disk? This cannot be undone in the editor.</p>{buffer && dirty(buffer) && <p className="notice error">This file has unsaved edits. Deleting it will also discard those edits.</p>}</> : <>
        <div className="interaction-field"><label htmlFor="file-destination">{operation === "copy" ? "Copy to" : "File path"}</label><input id="file-destination" autoFocus required value={path} disabled={busy} placeholder="docs/notes.md" onChange={event => setPath(event.target.value)} maxLength={4096} aria-describedby="file-destination-help" />
          <small id="file-destination-help">Use a workspace-relative path in an existing folder. Existing files will not be overwritten.</small></div>
        {operation === "copy" && <p className="muted">Copies saved disk contents{buffer && dirty(buffer) ? "; unsaved edits are not included" : ""}.</p>}
      </>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <footer className="dialog-actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" className={operation === "delete" ? "workspace-delete" : ""} disabled={busy || operation !== "delete" && !path}>{busy ? "Working…" : titles[operation]}</button></footer>
    </form>
  </ShellDialog>;
}
