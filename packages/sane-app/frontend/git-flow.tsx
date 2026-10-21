import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { EditorView } from "@codemirror/view";
import { goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { FiGitBranch } from "react-icons/fi";
import type { GitComparison, WorkspaceDiff, WorkspaceGit } from "../src/workspace-contract";
import { catalog } from "./catalog";
import { FlowNavigation } from "./flow-navigation";
import { GitChangesTree, GitDiffPreview } from "./git-review";
import { ShellDialog } from "./shell-dialog";
import { workspaceClient } from "./workspace-client";
import { subscribeWorkspace, workspaceBufferIsDirty, workspaceEpoch, workspaceFailure, workspaceSnapshot } from "./workspace-store";
import { gitReadRevision, subscribeGitInvalidations } from "./git-invalidation";
import { acknowledgeGitUnknown, acquireGitOperations, gitOperationsSnapshot, gitTargetCurrent, gitTargetScope, refreshGitOperations, runGitOperation, setGitCommitDraft, subscribeGitOperations, type GitTarget } from "./git-operations-client";
import "./git-flow.css";

/** Called at launch, not at mutation time: browsing changes never retarget this flow. */
export function captureGitTarget(): GitTarget | null {
  const { navigation, workspaces, ready } = catalog.state;
  const workspace = workspaces.find(row => row.workspaceId === navigation.workspaceId);
  const worktree = workspace?.worktrees.find(row => row.worktreeId === navigation.worktreeId);
  return ready && workspace?.kind === "repository" && worktree?.state === "available" ? { workspaceId: workspace.workspaceId, worktreeId: worktree.worktreeId, bindingRevision: worktree.bindingRevision, root: worktree.root, authEpoch: workspaceEpoch() } : null;
}
export function gitTargetUnavailable() {
  if (!catalog.state.ready) return "Workspace catalog is unavailable";
  const workspace = catalog.state.workspaces.find(row => row.workspaceId === catalog.state.navigation.workspaceId);
  if (!workspace) return "Choose a workspace and worktree above";
  if (workspace.kind !== "repository") return "Choose a Git repository above";
  return captureGitTarget() ? undefined : "Choose an available worktree above";
}

type Confirmation = { stale?: boolean } & ({ kind: "stage"; snapshot: string; paths: string[]; includedPaths: string[] } | { kind: "push"; snapshot: string; remote: string; remoteUrl: string; branch: string; setUpstream: boolean });
type MobileView = "changes" | "diff" | "write";
const previewOnlyReasons = new Set<WorkspaceDiff["reason"]>(["binary", "oversize", "invalid-utf8"]);
const comparisons: GitComparison[] = ["staged", "unstaged", "untracked"];
export function GitFlow({ target, back, exit }: { target: GitTarget; back: () => void; exit: () => void }) {
  const messageId = useId();
  const panelId = useId();
  useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  useSyncExternalStore(subscribeWorkspace, workspaceSnapshot);
  const state = useSyncExternalStore(subscribeGitOperations, () => gitOperationsSnapshot(target));
  const revision = useSyncExternalStore(subscribeGitInvalidations, () => gitReadRevision(gitTargetScope(target), target.bindingRevision));
  const [selection, setSelection] = useState<{ path: string; comparison: GitComparison }>({ path: "", comparison: "unstaged" });
  const [preview, setPreview] = useState<{ key: string; diff: WorkspaceDiff | null; loading: boolean; error: string }>({ key: "", diff: null, loading: false, error: "" });
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [remoteChoice, setRemoteChoice] = useState("");
  const [mobileView, setMobileView] = useState<MobileView>("changes");
  const previewPanel = useRef<HTMLElement>(null);
  const focusMobilePreview = useRef(false);
  const editor = useRef<EditorView | null>(null), root = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement | null>(null);
  const previewGeneration = useRef(0);
  const previousGit = useRef<WorkspaceGit | undefined>(undefined);
  const mounted = useRef(true);
  const current = gitTargetCurrent(target), git = current ? state.state?.git : undefined;
  const snapshot = current ? state.state : undefined;
  const previewKey = JSON.stringify([selection.path, selection.comparison, snapshot?.snapshot, revision]);
  const targetValid = useRef(current); targetValid.current = current;
  useEffect(() => { mounted.current = true; root.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); const release = acquireGitOperations(target); return () => { mounted.current = false; release(); previewGeneration.current++; }; }, [target]);
  useEffect(() => { if (!current) setConfirmation(null); }, [current]);
  useEffect(() => {
    // Only a user selecting a file on mobile moves focus into the new pane.
    // Polling and desktop selection must never steal editor or tree focus.
    if (focusMobilePreview.current && mobileView === "diff" && window.matchMedia("(max-width: 640px)").matches) previewPanel.current?.focus({ preventScroll: true });
    focusMobilePreview.current = false;
  }, [mobileView]);
  useEffect(() => {
    // An unchanged background read preserves consent. Once a different snapshot
    // is observed, reopening the confirmation is required even if Git changes back.
    if (snapshot) setConfirmation(value => value && value.snapshot !== snapshot.snapshot && !value.stale ? { ...value, stale: true } : value);
  }, [snapshot?.snapshot]);
  useEffect(() => {
    if (!git?.available) return;
    const previous = previousGit.current;
    previousGit.current = git;
    setSelection(selected => {
      if (!selected.path) return selected;
      const surviving = git.entries.find(row => row.path === selected.path);
      if (surviving?.comparisons.includes(selected.comparison)) return selected;
      // Staging/unstaging moves a row between comparisons; keep its file selected.
      if (surviving?.comparisons.length) return { path: selected.path, comparison: comparisons.find(value => surviving.comparisons.includes(value))! };
      const paths = (value: WorkspaceGit | undefined, comparison: GitComparison) => value?.entries.filter(row => row.comparisons.includes(comparison)).map(row => row.path).sort((a, b) => a.localeCompare(b)) ?? [];
      const oldIndex = Math.max(0, paths(previous, selected.comparison).indexOf(selected.path));
      for (const comparison of [selected.comparison, ...comparisons.filter(value => value !== selected.comparison)]) {
        const remaining = paths(git, comparison);
        if (remaining.length) return { path: remaining[Math.min(oldIndex, remaining.length - 1)]!, comparison };
      }
      return { path: "", comparison: selected.comparison };
    });
  }, [git]);
  useEffect(() => {
    const generation = ++previewGeneration.current;
    const entry = git?.entries.find(row => row.path === selection.path && row.comparisons.includes(selection.comparison));
    if (!entry || !snapshot || !current) { setPreview({ key: previewKey, diff: null, loading: false, error: "" }); return; }
    const version = revision;
    setPreview({ key: previewKey, diff: null, loading: true, error: "" });
    void workspaceClient.diff(gitTargetScope(target), target.bindingRevision, selection.path, selection.comparison).then(diff => {
      if (mounted.current && targetValid.current && generation === previewGeneration.current && version === gitReadRevision(gitTargetScope(target), target.bindingRevision)) setPreview({ key: previewKey, diff, loading: false, error: "" });
    }).catch(error => { if (mounted.current && targetValid.current && generation === previewGeneration.current && version === gitReadRevision(gitTargetScope(target), target.bindingRevision)) setPreview({ key: previewKey, diff: null, loading: false, error: workspaceFailure(error) }); });
  }, [previewKey, current]);
  const diff = preview.key === previewKey ? preview.diff : null;
  const entry = git?.entries.find(row => row.path === selection.path && row.comparisons.includes(selection.comparison));
  const staged = git?.entries.filter(row => row.comparisons.includes("staged")) ?? [];
  const stageable = git?.entries.filter(row => row.comparisons.some(value => value === "unstaged" || value === "untracked")) ?? [];
  const unsafe = git?.entries.some(row => row.conflict || row.submodule || row.renameOutsideWorkspace);
  const blockedReason = !current ? "Target changed or is unavailable. Exit and reopen Git to choose a target." : snapshot?.blockedReason || (!git?.available ? git?.reason || "Git status is unavailable." : git.truncated ? "Changes are truncated. Git operations are disabled to avoid hidden paths." : unsafe ? "Conflicts or unsupported entries require host Git." : "");
  const blocked = !snapshot || !!blockedReason || state.loading || state.busy || !!state.error || state.unknown;
  const previewUnavailable = !!diff?.reason && previewOnlyReasons.has(diff.reason);
  const selectedUnsafe = !!diff && (diff.reason ? !previewOnlyReasons.has(diff.reason) : diff.before === null || diff.after === null);
  const selectedBlocked = blocked || !entry || !diff || selectedUnsafe || preview.loading || !!preview.error;
  const stageAllUnsafe = !!diff && stageable.some(row => row.path === diff.path) && selectedUnsafe;
  const remotes = snapshot?.remotes ?? [];
  const upstreamRemote = remotes.find(remote => snapshot?.upstream?.startsWith(`${remote.name}/`));
  const remote = remotes.find(row => row.name === remoteChoice)?.name ?? upstreamRemote?.name ?? remotes.find(row => row.name === "origin")?.name ?? remotes[0]?.name ?? "";
  // The endpoint deliberately supports only local-branch -> same remote branch.
  const branch = snapshot?.branch ?? "";
  // Read shared buffers only to disclose unsaved text; never change their selection or content.
  const unsaved = workspaceBufferIsDirty(target.workspaceId, target.worktreeId, target.bindingRevision, target.root, selection.path);
  function previewStageAll(button: HTMLButtonElement) {
    if (blocked || stageAllUnsafe || !snapshot || !stageable.length) return;
    trigger.current = button;
    const paths = stageable.map(row => row.path);
    const includedPaths = [...new Set(stageable.flatMap(row => [row.path, ...(row.originalPath ? [row.originalPath] : [])]))].sort();
    // Snapshot/path validation is the mutation boundary. Never fan out one diff
    // request per file, and never replace these explicit operands with add -A.
    setConfirmation({ kind: "stage", snapshot: snapshot.snapshot, paths, includedPaths });
  }
  function selectFile(path: string, comparison: GitComparison) {
    setSelection({ path, comparison });
    focusMobilePreview.current = mobileView !== "diff" && window.matchMedia("(max-width: 640px)").matches;
    setMobileView("diff");
  }
  return <section ref={root} className="workstream-status-composer git-flow" data-mobile-view={mobileView} aria-label="Git flow" aria-busy={state.busy}>
    <header className="workstream-status-heading"><div><FiGitBranch size={16} aria-hidden="true" /><strong>Git</strong><span title={snapshot?.branch || undefined}>{snapshot ? snapshot.branch || "Detached HEAD" : "Loading branch…"}</span></div><FlowNavigation back={back} exit={exit} /></header>
    <div className="git-flow-target"><span title={target.root}>{target.root}</span><small>Captured worktree · saved files only · no agent</small><details className="git-flow-target-details"><summary><span>Worktree: <strong>{target.root.split(/[/\\]/).filter(Boolean).at(-1) || target.root}</strong></span><small>Details</small></summary><p>{target.root}</p><p>Branch: {snapshot ? snapshot.branch || "Detached HEAD" : "Loading branch…"}</p><small>Captured worktree · saved files only · no agent</small></details></div>
    <div className="git-flow-notices" aria-live="polite">
      {state.commitNotice && <p>{state.commitNotice}</p>}
      {state.busy && <p role="status">Git operation in progress. Leaving does not cancel it.</p>}
      {state.loading && <p role="status">Refreshing Git state…</p>}
      {state.result && <p role={state.result.outcome === "succeeded" ? "status" : "alert"}>{state.result.action}: {state.result.message}</p>}
      {state.unknown && <div role="alert"><p>Outcome unknown. Do not repeat the operation blindly. Refresh and inspect host Git before continuing.</p><small>Request: {state.result?.requestId}</small><button type="button" disabled={!state.reconciled || state.loading || state.busy} onClick={() => acknowledgeGitUnknown(target)}>I checked the outcome; allow new actions</button></div>}
      {(state.error || blockedReason) && <p role="alert">{state.error || blockedReason}</p>}
    </div>
    <div className="git-flow-mobile-nav" role="group" aria-label="Git panels">
      <button type="button" aria-pressed={mobileView === "changes"} aria-controls={`${panelId}-changes`} onClick={() => setMobileView("changes")}>Changes <span>({git?.entries.length ?? 0})</span></button>
      <button type="button" aria-pressed={mobileView === "diff"} aria-controls={`${panelId}-diff`} disabled={!selection.path} onClick={() => setMobileView("diff")}>Diff</button>
      <button type="button" aria-pressed={mobileView === "write"} aria-controls={`${panelId}-write`} aria-label={`Commit and push, ${staged.length} staged files`} onClick={() => setMobileView("write")}>Commit &amp; push <span>({staged.length})</span></button>
    </div>
    <div className="git-flow-toolbar"><button type="button" disabled={!current || state.busy || state.loading} onClick={() => void refreshGitOperations(target, true)}>Refresh</button><button className="git-flow-stage-all" type="button" disabled={blocked || stageAllUnsafe || !stageable.length} aria-label={`Review staging all ${stageable.length} unstaged and untracked files`} title={stageAllUnsafe ? "A selected path is unsafe for Git operations; use host Git" : "Review the exact whole-file staging paths"} onClick={event => previewStageAll(event.currentTarget)}>Stage All… ({stageable.length})</button></div>
    <div className="git-flow-review">
      <aside id={`${panelId}-changes`} className="git-flow-changes" aria-label="Changed files"><GitChangesTree git={git} selectedPath={selection.path} comparison={selection.comparison} disabled={state.busy || !current} error={!current ? blockedReason : state.error} isUnsaved={path => workspaceBufferIsDirty(target.workspaceId, target.worktreeId, target.bindingRevision, target.root, path)} onSelect={selectFile} /></aside>
      <section ref={previewPanel} id={`${panelId}-diff`} className="git-flow-preview" tabIndex={-1} aria-label="Selected file changes"><header><span title={selection.path}>{selection.path || "Select a changed file"}{selection.path && ` · ${selection.comparison}`}</span><div><button type="button" disabled={!diff || !!diff.reason} aria-label="Previous change" onClick={() => { if (editor.current) goToPreviousChunk(editor.current); }}>↑</button><button type="button" disabled={!diff || !!diff.reason} aria-label="Next change" onClick={() => { if (editor.current) goToNextChunk(editor.current); }}>↓</button><button type="button" disabled={selectedBlocked} onClick={() => snapshot && void runGitOperation(target, snapshot.snapshot, { action: selection.comparison === "staged" ? "unstage" : "stage", paths: [selection.path] })}>{selection.comparison === "staged" ? "Unstage file" : "Stage file"}</button></div></header>{previewUnavailable && <p className="workspace-notice">Text preview unavailable ({diff?.reason}). Stage/Unstage still operates on the whole saved file; backend safety validation applies.</p>}<GitDiffPreview diff={diff} loading={preview.key === previewKey && preview.loading} error={preview.key === previewKey ? preview.error : undefined} selectedPath={selection.path} viewRef={editor} unsaved={unsaved} /></section>
    </div>
    <footer id={`${panelId}-write`} className="git-flow-write" role="group" aria-label="Commit and push">
      <div className="git-flow-commit"><label htmlFor={messageId}>Commit message</label><textarea id={messageId} rows={2} value={state.draft} disabled={state.busy} onChange={event => setGitCommitDraft(target, event.target.value)} placeholder="Write a commit message" /><div><small>Commits all {staged.length} staged file(s), including files staged outside this flow. No implicit staging.</small><button type="button" disabled={blocked || !staged.length || !state.draft.trim()} onClick={() => snapshot && void runGitOperation(target, snapshot.snapshot, { action: "commit", message: state.draft })}>Commit</button></div></div>
      <div className="git-flow-push"><label>Remote<select value={remote} disabled={blocked} onChange={event => setRemoteChoice(event.target.value)}>{!remotes.length && <option value="">No remote</option>}{remotes.map(row => <option key={row.name} value={row.name}>{row.name}</option>)}</select></label><small>{snapshot?.upstream ? `Upstream: ${snapshot.upstream}` : "No upstream; Push will set it"}{snapshot?.ahead !== null && snapshot?.ahead !== undefined ? ` · ${snapshot.ahead} ahead` : ""}{snapshot?.behind ? ` · ${snapshot.behind} behind` : ""}</small><button type="button" disabled={blocked || !snapshot?.branch || !snapshot.head || !remote || !branch} title={!snapshot?.branch ? "Push requires an attached branch" : !snapshot.head ? "Create a commit before pushing" : "Confirm a normal push"} onClick={event => { if (!snapshot) return; trigger.current = event.currentTarget; setConfirmation({ kind: "push", snapshot: snapshot.snapshot, remote, remoteUrl: remotes.find(row => row.name === remote)?.url ?? "", branch, setUpstream: !snapshot.upstream }); }}>Push…</button></div>
    </footer>
    {confirmation && <ShellDialog title={confirmation.kind === "stage" ? "Stage All preview" : "Confirm push"} close={() => setConfirmation(null)} restoreFocus={() => mounted.current ? trigger.current : document.body} className="git-flow-confirm">
      <p className="git-flow-confirm-root">{target.root}</p>
      {confirmation.kind === "stage" ? <><p>Stage exactly these {confirmation.includedPaths.length} saved paths (whole files, including both endpoints of renames):</p><ul>{confirmation.includedPaths.map(path => <li key={path}>{path}</li>)}</ul><p>Text previews are not required. Binary, oversized, or invalid-UTF8 files may be included without a text preview.</p><p>Conflicts, submodules, symlinks, protected paths, and boundary violations are not supported. The backend validates the complete snapshot and every explicit path before applying this operation; unsafe paths are not silently skipped. No directories or hidden paths are added.</p></> : <><p>Push local <strong>{confirmation.branch}</strong> to remote <strong>{confirmation.remote}</strong>, target branch <strong>{confirmation.branch}</strong>.</p><p className="git-flow-confirm-root">Remote URL: <code>{confirmation.remoteUrl || "Unavailable"}</code></p><p>Uses a normal, non-force push. {confirmation.setUpstream ? "This also sets the upstream. " : ""}Host Git credentials and hooks apply. Nothing is committed automatically.</p></>}
      {confirmation.stale || snapshot && confirmation.snapshot !== snapshot.snapshot ? <p role="alert">Git changed since this confirmation. Cancel, review the new state, and choose the action again.</p> : state.loading ? <p role="status">Refreshing the reviewed Git snapshot…</p> : null}
      <div className="git-flow-confirm-actions"><button type="button" onClick={() => setConfirmation(null)}>Cancel</button><button type="button" disabled={blocked || confirmation.stale || confirmation.snapshot !== snapshot?.snapshot || confirmation.kind === "stage" && stageAllUnsafe} onClick={() => {
        const captured = confirmation; setConfirmation(null);
        void runGitOperation(target, captured.snapshot, captured.kind === "stage" ? { action: "stage", paths: captured.paths } : { action: "push", remote: captured.remote, branch: captured.branch, setUpstream: captured.setUpstream });
      }}>{confirmation.kind === "stage" ? "Stage listed files" : "Push"}</button></div>
    </ShellDialog>}
  </section>;
}
