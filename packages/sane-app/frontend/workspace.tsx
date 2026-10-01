import { WorkspaceEditor, WorkspaceDiffEditor } from "./workspace-editor";
import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { dirty, saveBuffer } from "./workspace-store";
import { useWorkspace } from "./workspace-controller";
import { useEffect, useState } from "react";
import { FiArrowDown, FiArrowUp, FiChevronDown } from "react-icons/fi";
import { ShellDialog } from "./shell-dialog";
import { FileOperationDialog, type FileOperation } from "./workspace-file-actions";
import "./workspace.css";
export { WorkspaceProvider } from "./workspace-controller";
export { WorkspaceSidebar } from "./workspace-tree";
export { resetWorkspaceState, workspaceHasDirtyBuffers } from "./workspace-store";

function canOpenInCode(controller: ReturnType<typeof useWorkspace>) {
  const { comparison, root, selected } = controller;
  const entry = root?.git?.entries.find(entry => entry.path === selected);
  return comparison && comparison.afterMode !== null && comparison.afterMode !== "120000" && comparison.afterMode !== "160000" && !comparison.reason && entry?.worktree !== "D";
}

/** Contents of the shell's single topbar, never an additional workspace header. */
export function WorkspaceHeader() {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [operation, setOperation] = useState<{ kind: FileOperation; source: string } | null>(null);
  const controller = useWorkspace();
  const { view, root, buffer, selected, scope, localCompare } = controller;
  useEffect(() => { setActionsOpen(false); setOperation(null); }, [scope, view]);
  const diff = controller.comparison;
  const textDiff = view === "code" ? localCompare && buffer && !buffer.missing && buffer.disk?.text !== null : diff && !diff.reason && !diff.modeOnly && diff.before !== null && diff.after !== null && diff.before !== diff.after;
  return <>
    <div className="conversation-heading workspace-heading"><span title={selected || undefined}>{view === "code" ? "Files" : "Git"}{selected ? ` · ${selected}` : ""}{buffer && dirty(buffer) ? " •" : ""}</span>{(view === "git" && selected || localCompare) && <small>{localCompare ? "Disk → Local unsaved buffer" : root?.comparison}</small>}</div>
    {(textDiff || view === "code" && scope || view === "git" && canOpenInCode(controller)) && <button type="button" className="file-actions-opener" aria-haspopup="dialog" aria-label={view === "code" ? "File actions" : "Change actions"} onClick={() => setActionsOpen(true)}><span>{view === "code" ? "File actions" : "Change actions"}</span><FiChevronDown size={13} aria-hidden="true" /></button>}
    {operation && scope && view === "code" && <FileOperationDialog key={`${scope.generation}:${scope.workspace.workspaceId}:${operation.kind}:${operation.source}`} operation={operation.kind} source={operation.source} close={() => setOperation(null)} />}
    {actionsOpen && <ShellDialog title={view === "code" ? "File actions" : "Change actions"} close={() => setActionsOpen(false)}><p className="context-path">{selected}</p><div className="workspace-header-actions">
      {textDiff && <><button aria-label="Previous change" title="Previous change" onClick={() => { if (controller.diffEditor.current) goToPreviousChunk(controller.diffEditor.current); setActionsOpen(false); }}><FiArrowUp size={12} aria-hidden="true" /> Previous change</button><button aria-label="Next change" title="Next change" onClick={() => { if (controller.diffEditor.current) goToNextChunk(controller.diffEditor.current); setActionsOpen(false); }}><FiArrowDown size={12} aria-hidden="true" /> Next change</button></>}
      {view === "code" && scope && <button type="button" onClick={() => { setActionsOpen(false); setOperation({ kind: "create", source: "" }); }}>New file</button>}
      {view === "code" && buffer && scope && <>
        <span className="workspace-file-meta">{buffer.file.eol.toUpperCase()}{buffer.file.bom ? " · BOM" : ""}</span>
        {localCompare && <button onClick={() => { controller.closeCompare(); setActionsOpen(false); }}>Back to editor</button>}
        <button disabled={buffer.saving || !dirty(buffer) || !buffer.file.editable || buffer.missing} onClick={() => { void saveBuffer(scope.id, scope.workspace, buffer); setActionsOpen(false); }}>{buffer.saving ? "Saving…" : "Save"}</button>
        <button disabled={buffer.checking || buffer.saving} onClick={() => { void controller.compareDisk(); setActionsOpen(false); }}>Compare disk</button>
        <button disabled={buffer.checking || buffer.saving || buffer.missing} onClick={() => { if (window.confirm(`Reload ${buffer.path} from disk? Unsaved edits will be discarded.`)) { void controller.compareDisk(true); setActionsOpen(false); } }}>Reload</button>
        <button type="button" disabled={buffer.checking || buffer.saving || buffer.missing || !buffer.file.revision} onClick={() => { setActionsOpen(false); setOperation({ kind: "copy", source: selected }); }}>Copy file</button>
        <button type="button" className="workspace-delete" disabled={buffer.checking || buffer.saving || buffer.missing || !buffer.file.revision} onClick={() => { setActionsOpen(false); setOperation({ kind: "delete", source: selected }); }}>Delete file</button>
      </>}
      {view === "git" && canOpenInCode(controller) && <button onClick={() => { controller.activate({ view: "code", path: selected }); setActionsOpen(false); }}>Open in Files</button>}
    </div></ShellDialog>}
  </>;
}

export function WorkspaceView() {
  const controller = useWorkspace();
  const { conversationId, workspace, selected, view, buffer, comparison, localCompare, error } = controller;
  if (!conversationId) return <section className="workspace-empty"><h2>Open a workspace</h2><p>Choose a repository or directory from the workspace switcher above to browse Files and Git.</p></section>;
  if (!workspace) return <section className="workspace-empty"><h2>{controller.resolving ? "Opening workspace…" : "Workspace unavailable"}</h2>{error && <p role="alert">{error}</p>}{!controller.resolving && <button onClick={controller.retryResolve}>Retry workspace</button>}</section>;
  return <section className="workspace-view" aria-label={view === "code" ? "Files workspace" : "Git changes"}>
    {error && <div className="workspace-notice workspace-error" role="alert">{error} <button onClick={controller.retrySelection}>Retry</button> <button onClick={controller.retryResolve}>Reopen workspace</button></div>}
    {buffer?.error && <div className="workspace-notice workspace-error" role="alert">{buffer.error} <button onClick={controller.retryResolve}>Reopen workspace</button></div>}
    {buffer?.disk && <div className="workspace-notice">Disk changed. Local edits are preserved. Compare disk, then reload explicitly to discard local changes.</div>}
    {view === "code" ? !selected ? <div className="workspace-empty"><h2>Open a file to begin</h2><p>Choose a file in the sidebar or create one with New file. Edit UTF-8 files up to 256 KiB. Save explicitly with Cmd+S / Ctrl+S.</p></div>
      : !buffer ? <div className="workspace-empty"><p>{controller.opening ? "Opening file…" : "The selected file could not be opened."}</p>{!controller.opening && <button onClick={controller.retrySelection}>Retry file</button>}</div>
      : localCompare ? buffer.disk?.text === null || buffer.missing ? <p className="workspace-notice">Disk contents unavailable for comparison.</p> : <WorkspaceDiffEditor viewRef={controller.diffEditor} path={buffer.path} before={buffer.disk?.text ?? buffer.baseText} after={buffer.state.doc.toString()} label="Disk → Local unsaved buffer" />
      : !buffer.file.editable ? <div className="workspace-empty"><h2>File cannot be edited</h2><p>{buffer.file.reason || "Unsupported file"}. Only existing, writable UTF-8 text files up to 256 KiB are editable.</p></div>
      : <WorkspaceEditor key={`${workspace.root}\0${buffer.path}`} state={buffer.state} onView={buffer.attach} />
      : controller.diffLoading ? <div className="workspace-empty">Loading diff…</div>
      : !selected ? <div className="workspace-empty"><h2>Select a changed file</h2><p>Review staged, unstaged, and untracked saved contents.</p></div>
      : !comparison ? <div className="workspace-empty"><h2>No changes for this selection</h2><p>Select a file from one of the change groups.</p></div>
      : <>
        <div className="workspace-notice">{comparison.comparison} · {comparison.comparison === "staged" ? "HEAD → Index" : comparison.comparison === "untracked" ? "Empty → Working tree" : "Index → Working tree"} · {comparison.beforeMode ?? "absent"} → {comparison.afterMode ?? "absent"}{comparison.originalPath ? ` · renamed from ${comparison.originalPath}` : ""}{buffer && dirty(buffer) ? " · Unsaved local edits are not shown" : ""}</div>
        {comparison.reason ? <div className="workspace-empty"><h2>Text diff unavailable</h2><p>{comparison.reason}</p></div>
          : comparison.modeOnly ? <div className="workspace-empty"><h2>File mode changed</h2><p>Text contents are unchanged.</p></div>
          : comparison.before === comparison.after ? <div className="workspace-empty">No text changes.</div>
          : comparison.before !== null && comparison.after !== null ? <WorkspaceDiffEditor viewRef={controller.diffEditor} path={comparison.path} before={comparison.before} after={comparison.after} label={comparison.comparison === "staged" ? "HEAD → Index" : comparison.comparison === "untracked" ? "Empty → Working tree" : "Index → Working tree"} />
          : <div className="workspace-empty">Text contents unavailable.</div>}
      </>}
  </section>;
}
