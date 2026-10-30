import { WorkspaceEditor, WorkspaceDiffEditor } from "./workspace-editor";
import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { dirty, saveBuffer } from "./workspace-store";
import { useWorkspace } from "./workspace-controller";
import { useEffect, useRef, useState } from "react";
import { FiArrowDown, FiArrowUp, FiChevronDown } from "react-icons/fi";
import { ShellDialog } from "./shell-dialog";
import { FileOperationDialog, type FileOperation } from "./workspace-file-actions";
import { WorkspaceSearchPanel, useWorkspaceSearchContext } from "./workspace-search";
import { useWorkspaceFileOperations } from "./workspace-file-shortcuts";
import { GitDiffPreview } from "./git-review";
import { gitReadRevision } from "./git-invalidation";
import { NotebookConfigureAction, NotebookFileView, NotebookToolbarSlot } from "./notebook-preview";
import { imagePreviewMimeType } from "../shared/image-preview-contract";
import { WorkspaceImagePreview } from "./workspace-image-preview";
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
export function WorkspaceHeader({ notebookControls = true }: { notebookControls?: boolean }) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [operation, setOperation] = useState<{ kind: FileOperation; source: string } | null>(null);
  const controller = useWorkspace();
  const search = useWorkspaceSearchContext();
  const operations = useWorkspaceFileOperations();
  const { view, root, buffer, selected, scope, localCompare } = controller;
  const image = !!imagePreviewMimeType(selected);
  useEffect(() => { setActionsOpen(false); setOperation(null); }, [scope, view]);
  const diff = controller.comparison;
  const searchResults = view === "code" && search?.mode === "search" && !search.showingFile;
  const textDiff = view === "code" ? localCompare && buffer && !buffer.missing && buffer.disk?.text !== null : diff && !diff.reason && !diff.modeOnly && diff.before !== null && diff.after !== null && diff.before !== diff.after;
  const openOperation = (kind: FileOperation, source: string) => { setActionsOpen(false); if (operations) operations.open(kind, source); else setOperation({ kind, source }); };
  return <>
    <div className="conversation-heading workspace-heading"><span title={selected || undefined}>{view === "code" ? search?.mode === "search" ? "Search" : "Files" : "Git"}{selected && (search?.mode !== "search" || search.showingFile || view !== "code") ? ` · ${selected}` : ""}{buffer && dirty(buffer) ? " •" : ""}</span>{(view === "git" && selected || localCompare) && <small>{localCompare ? "Disk → Local unsaved buffer" : root?.comparison}</small>}</div>
    {view === "code" && !searchResults && notebookControls && <NotebookToolbarSlot />}
    {!searchResults && (textDiff || view === "code" && scope || view === "git" && canOpenInCode(controller)) && <button type="button" className="file-actions-opener" aria-haspopup="dialog" aria-label={view === "code" ? "File actions" : "Change actions"} onClick={() => setActionsOpen(true)}><span>{view === "code" ? "File actions" : "Change actions"}</span><FiChevronDown size={13} aria-hidden="true" /></button>}
    {operation && scope && view === "code" && <FileOperationDialog key={`${scope.generation}:${scope.workspace.workspaceId}:${operation.kind}:${operation.source}`} operation={operation.kind} source={operation.source} close={() => setOperation(null)} />}
    {actionsOpen && <ShellDialog title={view === "code" ? "File actions" : "Change actions"} close={() => setActionsOpen(false)}><p className="context-path">{selected}</p><div className="workspace-header-actions">
      {textDiff && <><button aria-label="Previous change" title="Previous change" onClick={() => { if (controller.diffEditor.current) goToPreviousChunk(controller.diffEditor.current); setActionsOpen(false); }}><FiArrowUp size={12} aria-hidden="true" /> Previous change</button><button aria-label="Next change" title="Next change" onClick={() => { if (controller.diffEditor.current) goToNextChunk(controller.diffEditor.current); setActionsOpen(false); }}><FiArrowDown size={12} aria-hidden="true" /> Next change</button></>}
      {view === "code" && scope && <button type="button" disabled={operations?.busy} onClick={() => openOperation("create", "")}>New file</button>}
      {view === "code" && scope && <NotebookConfigureAction />}
      {view === "code" && buffer && scope && <>
        {!image && <><span className="workspace-file-meta">{buffer.file.eol.toUpperCase()}{buffer.file.bom ? " · BOM" : ""}</span>
        {localCompare && <button onClick={() => { controller.closeCompare(); setActionsOpen(false); }}>Back to editor</button>}
        <button disabled={buffer.saving || !dirty(buffer) || !buffer.file.editable || buffer.missing} onClick={() => { void saveBuffer(scope.id, scope.workspace, buffer); setActionsOpen(false); }}>{buffer.saving ? "Saving…" : "Save"}</button>
        <button disabled={buffer.checking || buffer.saving} onClick={() => { void controller.compareDisk(); setActionsOpen(false); }}>Compare disk</button>
        <button disabled={buffer.checking || buffer.saving || buffer.missing} onClick={() => { if (window.confirm(`Reload ${buffer.path} from disk? Unsaved edits will be discarded.`)) { void controller.compareDisk(true); setActionsOpen(false); } }}>Reload</button></>}
        {image && <><button onClick={() => { controller.retrySelection(); setActionsOpen(false); }}>Reload image</button>{!buffer.file.revision && <span className="workspace-file-meta">File actions require a file no larger than 256 KiB.</span>}</>}
        <button type="button" disabled={operations?.busy || buffer.checking || buffer.saving || buffer.missing || !buffer.file.revision} onClick={() => openOperation("rename", selected)}>Rename file</button>
        <button type="button" disabled={operations?.busy || buffer.checking || buffer.saving || buffer.missing || !buffer.file.revision} onClick={() => openOperation("copy", selected)}>Copy file</button>
        <button type="button" className="workspace-delete" disabled={operations?.busy || buffer.checking || buffer.saving || buffer.missing || !buffer.file.revision} onClick={() => openOperation("delete", selected)}>Delete file</button>
      </>}
      {view === "git" && canOpenInCode(controller) && <button onClick={() => { controller.activate({ view: "code", path: selected }); setActionsOpen(false); }}>Open in Files</button>}
    </div></ShellDialog>}
  </>;
}

/** The active-view controller may stop presenting a diff without invalidating it. */
function useRetainedGitDiff(controller: ReturnType<typeof useWorkspace>) {
  const { scope, root, selected, view, comparison } = controller;
  // The controller subscribes to Git invalidations even outside Git. Include both
  // their revision and local mutation versions, never the active shell leaf.
  const identity = JSON.stringify([scope?.id, scope?.generation, scope?.auth, scope?.bindingRevision,
    scope?.workspace.workspaceId, scope?.workspace.root, root?.generation, selected, root?.comparison,
    root?.gitVersion, scope ? gitReadRevision(scope.id, scope.workspace.bindingRevision) : null]);
  type Observation = { scope: typeof scope; identity: string; generation: number };
  const observations = useRef(new WeakMap<NonNullable<typeof comparison>, Observation>());
  const retained = useRef<Observation & { diff: typeof comparison }>({ scope, identity, generation: 0, diff: null });
  if (retained.current.scope !== scope || retained.current.identity !== identity) {
    retained.current = { scope, identity, generation: retained.current.generation + 1, diff: null };
  }
  // A completed listing can authoritatively remove the selection. A temporarily
  // null controller diff (view change / same-selection refresh) cannot do so.
  const selectionAbsent = root?.git && !root.git.entries.some(entry => entry.path === selected && entry.comparisons.includes(root.comparison));
  if (selectionAbsent) retained.current.diff = null;
  if (view === "git" && scope && comparison) {
    let observation = observations.current.get(comparison);
    if (!observation) {
      observation = { scope, identity, generation: retained.current.generation };
      observations.current.set(comparison, observation);
    }
    // A local Git version can advance before the controller clears its old
    // result. Never relabel that already-observed object with the new fence.
    if (!selectionAbsent && observation.scope === scope && observation.identity === identity && observation.generation === retained.current.generation
      && comparison.path === selected && comparison.comparison === root?.comparison) retained.current.diff = comparison;
  }
  return { diff: retained.current.diff, identity };
}

export function WorkspaceView({ presentation }: { presentation?: "code" | "git" }) {
  const controller = useWorkspace();
  const { conversationId, workspace, selected, view, buffer, error } = controller;
  const search = useWorkspaceSearchContext();
  const gitPresentation = useRetainedGitDiff(controller);
  const presentedView = presentation ?? (view === "git" ? "git" : "code");
  const sourceDiffEditor = useRef(controller.diffEditor.current), gitDiffEditor = useRef(controller.diffEditor.current);
  useEffect(() => {
    // Retained hidden comparisons must not own the active header's navigation.
    controller.diffEditor.current = view === "code" ? sourceDiffEditor.current : view === "git" ? gitDiffEditor.current : null;
  });
  // The controller deliberately keys comparisons by the ACTIVE leaf. Leaving
  // Files must not replace its hidden Source editor or retire its notebook.
  const comparisonIdentity = JSON.stringify([controller.scope?.generation, controller.scope?.auth, workspace?.workspaceId, selected]);
  const sourceComparison = useRef({ identity: comparisonIdentity, active: controller.localCompare });
  if (sourceComparison.current.identity !== comparisonIdentity || view === "code") {
    sourceComparison.current = { identity: comparisonIdentity, active: controller.localCompare };
  }
  const localCompare = sourceComparison.current.active;
  if (!conversationId) return <section className="workspace-empty"><h2>Open a workspace</h2><p>Choose a repository or directory from the workspace switcher above to browse Files and Git.</p></section>;
  if (!workspace) return <section className="workspace-empty"><h2>{controller.resolving ? "Opening workspace…" : "Workspace unavailable"}</h2>{error && <p role="alert">{error}</p>}{!controller.resolving && <button onClick={controller.retryResolve}>Retry workspace</button>}</section>;
  return <section className="workspace-view" aria-label={presentedView === "code" ? "Files workspace" : "Git changes"}>
    {error && <div className="workspace-notice workspace-error" role="alert">{error} <button onClick={controller.retrySelection}>Retry</button> <button onClick={controller.retryResolve}>Reopen workspace</button></div>}
    {controller.locationNotice && <div className="workspace-notice" role="status">{controller.locationNotice}</div>}
    {buffer?.error && <div className="workspace-notice workspace-error" role="alert">{buffer.error} <button onClick={controller.retryResolve}>Reopen workspace</button></div>}
    {buffer?.disk && <div className="workspace-notice">Disk changed. Local edits are preserved. Compare disk, then reload explicitly to discard local changes.</div>}
    <div className="workspace-presentation" hidden={presentedView !== "code"}>
      <WorkspaceSearchPanel><NotebookFileView sourceComparison={localCompare} toolbarVisible={view === "code" && !(search?.mode === "search" && !search.showingFile)}>{!selected ? <div className="workspace-empty"><h2>Open a file to begin</h2><p>Choose a file in the sidebar or create one with New file. Edit UTF-8 files up to 256 KiB. Save explicitly with Cmd+S / Ctrl+S.</p></div>
      : !buffer ? <div className="workspace-empty"><p>{controller.opening ? "Opening file…" : "The selected file could not be opened."}</p>{!controller.opening && <button onClick={controller.retrySelection}>Retry file</button>}</div>
      : imagePreviewMimeType(selected) ? <WorkspaceImagePreview />
      : localCompare ? buffer.disk?.text === null || buffer.missing ? <p className="workspace-notice">Disk contents unavailable for comparison.</p> : <WorkspaceDiffEditor viewRef={sourceDiffEditor} path={buffer.path} before={buffer.disk?.text ?? buffer.baseText} after={buffer.state.doc.toString()} label="Disk → Local unsaved buffer" />
      : !buffer.file.editable ? <div className="workspace-empty"><h2>File cannot be edited</h2><p>{buffer.file.reason || "Unsupported file"}. Only existing, writable UTF-8 text files up to 256 KiB are editable.</p></div>
      : <WorkspaceEditor key={`${workspace.root}\0${buffer.path}`} state={buffer.state} onView={buffer.attach} />}</NotebookFileView></WorkspaceSearchPanel>
    </div>
    <div className="workspace-presentation" hidden={presentedView !== "git"}>
      {controller.diffLoading && gitPresentation.diff && <div className="workspace-notice" role="status">Refreshing diff…</div>}
      <GitDiffPreview key={gitPresentation.identity} diff={gitPresentation.diff} loading={controller.diffLoading && !gitPresentation.diff} selectedPath={selected} viewRef={gitDiffEditor} unsaved={Boolean(buffer && dirty(buffer))} />
    </div>
  </section>;
}
