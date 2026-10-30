import { createContext, useContext, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { catalog } from "./catalog";
import { store, useStore } from "./store";
import { useWorkspace } from "./workspace-controller";
import { dirty, workspaceEpoch, type Buffer } from "./workspace-store";
import { ShellDialog } from "./shell-dialog";
import { notebookFileMapping, notebookFrameUrl, notebookSettings, notebookSettingsKey, readNotebookConfiguration } from "./notebook-preview-settings";
import "./notebook-preview.css";

const NotebookToolbarContext = createContext<{ target: HTMLDivElement | null; setTarget: (element: HTMLDivElement | null) => void } | null>(null);

/** The file view owns its state; only its controls render in the shell header. */
export function NotebookToolbarProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return <NotebookToolbarContext.Provider value={value}>{children}</NotebookToolbarContext.Provider>;
}

export function NotebookToolbarSlot() {
  const toolbar = useContext(NotebookToolbarContext);
  return <div className="notebook-toolbar-slot" ref={toolbar?.setTarget} />;
}

function useNotebookConfiguration() {
  const controller = useWorkspace();
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const appIdentity = useStore(state => JSON.stringify([state.config?.storeId, state.config?.authenticated, state.phase]));
  const [storeId, authenticated, phase] = JSON.parse(appIdentity) as [string | null, boolean | null, string];
  const workspace = controller.workspace;
  const { workspaceId, worktreeId } = repository.navigation;
  const tree = repository.workspaces.find(item => item.workspaceId === workspaceId)?.worktrees.find(item => item.worktreeId === worktreeId);
  const key = storeId && authenticated && phase === "ready" && repository.ready && workspace && controller.scope
    && tree?.state === "available" && workspace.catalogWorkspaceId === workspaceId && workspace.worktreeId === worktreeId
    && workspace.bindingRevision === tree.bindingRevision && workspace.root === tree.root
    ? notebookSettingsKey(storeId, workspace.catalogWorkspaceId, workspace.worktreeId, workspace.bindingRevision, workspace.root) : null;
  const raw = useSyncExternalStore(notebookSettings.subscribe, () => notebookSettings.snapshot(key));
  return { controller, key, raw, ...readNotebookConfiguration(raw) };
}

/** Check live authorities again on user actions, not just the last React render. */
function notebookScopeIsCurrent(model: ReturnType<typeof useNotebookConfiguration>) {
  const scope = model.controller.scope;
  if (!scope || scope.auth !== workspaceEpoch() || !scope.reader.current()) return false;
  const workspace = scope.workspace;
  const app = store.snapshot(), repository = catalog.snapshot();
  const { workspaceId, worktreeId } = repository.navigation;
  const tree = repository.workspaces.find(item => item.workspaceId === workspaceId)?.worktrees.find(item => item.worktreeId === worktreeId);
  return !!app.config?.storeId && app.config.authenticated && app.phase === "ready" && repository.ready
    && workspaceId === workspace.catalogWorkspaceId && worktreeId === workspace.worktreeId
    && tree?.state === "available" && tree.root === workspace.root && tree.bindingRevision === workspace.bindingRevision
    && model.key === notebookSettingsKey(app.config.storeId, workspace.catalogWorkspaceId, workspace.worktreeId, workspace.bindingRevision, workspace.root);
}

function NotebookConfigurationDialog({ close, model }: { close: () => void; model: ReturnType<typeof useNotebookConfiguration> }) {
  const [server, setServer] = useState(model.configuration?.server ?? "");
  const [root, setRoot] = useState(model.configuration?.root ?? "notebooks/");
  const [error, setError] = useState("");
  const serverInput = useRef<HTMLInputElement>(null);
  const current = useRef(model.key); current.current = model.key;
  const initialKey = useRef(model.key);
  const initialRaw = useRef(model.raw);
  const available = !!model.key && model.key === initialKey.current && model.raw === initialRaw.current;
  const persist = (clear = false) => {
    if (!available || !current.current || current.current !== initialKey.current) return;
    if (!notebookScopeIsCurrent(model) || notebookSettings.snapshot(current.current) !== initialRaw.current) {
      setError("The worktree or configuration changed. Close this dialog and reopen configuration.");
      return;
    }
    try {
      if (clear) notebookSettings.clear(current.current);
      else notebookSettings.save(current.current, server, root);
      close();
    } catch (failure) { setError(failure instanceof Error && failure.name === "Error" ? failure.message : "Could not save notebook settings on this device. Check browser storage permissions."); }
  };
  return <ShellDialog title="Configure Notebook view" subtitle="This worktree · this device only" close={close} className="notebook-configuration-dialog" initialFocus={() => serverInput.current}>
    <form className="notebook-configuration" onSubmit={event => { event.preventDefault(); persist(); }}>
      <p>Connect an existing, trusted marimo editor server serving this exact checkout. SANE does not start or install marimo.</p>
      <p className="notebook-scope"><strong>Worktree</strong><span>{model.controller.workspace?.root ?? "Unavailable"}</span></p>
      <label>Marimo server URL<input ref={serverInput} type="url" value={server} onChange={event => setServer(event.target.value)} placeholder="https://marimo.example.com/?access_token=…" required autoComplete="off" spellCheck={false} disabled={!available} /></label>
      <label>Notebook root in this worktree<input value={root} onChange={event => setRoot(event.target.value)} placeholder="notebooks/ (or . for worktree root)" autoComplete="off" spellCheck={false} disabled={!available} /></label>
      <p>The server must be rooted at this folder, not a different checkout. For example, with root <code>notebooks/</code>, <code>notebooks/foo.py</code> opens the server's <code>foo.py</code>. This mapping is your assertion; SANE cannot verify the remote filesystem.</p>
      <p>Paste the full server URL, including <code>?access_token=…</code> if provided by marimo. SANE includes it when opening notebooks, so no separate login tab is needed with a valid token. The URL, including any token, is saved in this browser on this device; only use a trusted device. The server must allow this App to embed it.</p>
      <p className="notebook-warning">Opening a notebook may execute Python on that server with its permissions. Only connect trusted servers and open trusted files.</p>
      {!available && <p role="alert">The worktree or configuration has changed. Close this dialog and reopen configuration for an available worktree.</p>}
      {(error || model.error) && <p className="notebook-error" role="alert">{error || model.error}</p>}
      <footer><button type="button" disabled={!available || !model.raw} onClick={() => persist(true)}>Remove configuration</button><button type="button" onClick={close}>Cancel</button><button type="submit" disabled={!available}>Save configuration</button></footer>
    </form>
  </ShellDialog>;
}

/** File-actions entry point; configuration alone never creates a frame or makes a request. */
export function NotebookConfigureAction() {
  const model = useNotebookConfiguration();
  const [opened, setOpened] = useState<string | null>(null);
  if (opened && opened !== model.key) setOpened(null);
  return <>
    <button type="button" disabled={!model.key} onClick={() => setOpened(model.key)}>Configure Notebook view</button>
    {opened && opened === model.key && <NotebookConfigurationDialog key={opened} model={model} close={() => setOpened(null)} />}
  </>;
}

type PreviewSession = { identity: string; mode: "source" | "notebook"; launch?: { url: string; retry: number }; frameError?: boolean };

function notebookFileAvailability(buffer: Buffer | undefined, path: string) {
  if (!buffer || buffer.path !== path || buffer.missing || buffer.error) return { error: "The selected .py file is missing or unavailable. Reopen the saved file in Source before trying again." };
  // A disk conflict describes the saved file marimo will actually open, rather
  // than the possibly dirty Source baseline. The file API verifies regular-file
  // identity before returning metadata, even for oversize files with no revision.
  const file = buffer.disk ?? buffer.file;
  if (file.path !== path) return { error: "The saved file metadata no longer matches this selection. Reopen the file in Source before trying again." };
  if (file.reason === "oversize") return { oversized: true };
  if (file.reason === "binary" || file.reason === "invalid-utf8" || file.text === null) return { error: "This .py file is binary or has unsupported text contents. Choose a Python text notebook." };
  // Mixed-EOL and read-only text files can still be opened by marimo. Source's
  // editing permissions/revision are not proof of the server's capabilities.
  return { oversized: false };
}

/** Local presentation of navigation.filePath, never a new resource or navigation leaf. */
export function NotebookFileView({ children, sourceComparison = false, toolbarVisible = true }: { children: ReactNode; sourceComparison?: boolean; toolbarVisible?: boolean }) {
  const toolbar = useContext(NotebookToolbarContext);
  const model = useNotebookConfiguration();
  const { controller, configuration } = model;
  const { buffer, selected, scope } = controller;
  // Only a NEW search location retires the notebook and forces Source. Returning
  // to Files for this same path must not undo an already-consumed search intent.
  const searchActivation = useRef(0);
  if (controller.codeActivation?.source === "search") searchActivation.current = controller.codeActivation.revision;
  const identity = JSON.stringify([model.key, model.raw, scope?.generation, scope?.auth, selected, searchActivation.current, sourceComparison]);
  const [session, setSession] = useState<PreviewSession>({ identity, mode: "source" });
  const [configure, setConfigure] = useState<string | null>(null);
  const current = useRef(identity); current.current = identity;
  // Reset during render so a scope/config/file transition cannot show a stale frame,
  // even for one paint or on navigating away and back to an earlier file.
  if (session.identity !== identity) {
    setSession({ identity, mode: "source" });
    if (configure) setConfigure(null);
  }
  const active = session.identity === identity ? session : { identity, mode: "source" as const };
  const sourceId = useId(), notebookId = useId();
  const isPython = selected.endsWith(".py");
  let unavailable = !model.key ? "Notebook view is unavailable for this worktree. Reopen an available worktree." : model.error || (!configuration ? "No marimo server is configured for this worktree on this device." : "");
  if (!unavailable && configuration) {
    try { notebookFileMapping(configuration, selected); }
    catch (failure) { unavailable = failure instanceof Error ? failure.message : "The notebook root mapping is invalid."; }
  }
  const fileAvailability = notebookFileAvailability(buffer, selected);
  if (!unavailable && fileAvailability.error) unavailable = fileAvailability.error;
  // Transient mutations block only NEW launches. They must not retire a retained
  // same-file iframe when Source saves or a copy operation temporarily marks it busy.
  const launchBlocked = unavailable || (buffer?.saving ? "A file operation is in progress. Wait for it to finish before opening the notebook." : "");
  const hasUnsavedChanges = !!buffer && dirty(buffer);
  const currentFile = () => current.current === identity && notebookScopeIsCurrent(model)
    && controller.root?.selected === selected && notebookSettings.snapshot(model.key) === model.raw;
  const activate = () => {
    // Switching presentation is safe even when unavailable; only launch is gated.
    if (current.current !== identity) return;
    setSession(value => ({ ...value, identity, mode: "notebook" }));
  };
  const launch = () => {
    if (launchBlocked || !configuration || !currentFile() || !buffer || notebookFileAvailability(buffer, selected).error || buffer.saving || dirty(buffer) !== hasUnsavedChanges) return;
    // Dirty files are never saved or submitted to marimo. The explicit button below
    // acknowledges opening the server's saved version instead.
    try {
      const url = notebookFrameUrl(configuration, selected);
      setSession({ identity, mode: "notebook", launch: { url, retry: (active.launch?.retry ?? 0) + 1 } });
    } catch { setSession({ identity, mode: "notebook", frameError: true }); }
  };
  if (!isPython) return <>{children}</>;
  const showNotebook = active.mode === "notebook";
  // Missing/unsupported files and invalid configuration retire a running frame;
  // transient saving does not. Resuming after retirement requires an explicit launch.
  const launchIdentity = unavailable ? undefined : active.launch;
  if (unavailable && active.launch) setSession({ identity, mode: active.mode });
  return <div className="notebook-file-view">
    {controller.view === "code" && toolbarVisible && toolbar?.target && createPortal(<div className="notebook-view-switch" role="group" aria-label="File view"><button type="button" aria-pressed={!showNotebook} aria-controls={sourceId} onClick={() => setSession(value => ({ ...value, mode: "source" }))}>Source</button><button type="button" aria-pressed={showNotebook} aria-controls={notebookId} onClick={activate}>Notebook</button></div>, toolbar.target)}
    <div id={sourceId} className="notebook-source" hidden={showNotebook}>{children}</div>
    <section id={notebookId} className="notebook-preview" aria-label="Notebook view" hidden={!showNotebook}>
      {!launchIdentity ? <div className="notebook-launch">
        <h2>Open in marimo</h2>
        {unavailable ? <p role="status">{unavailable}</p> : <>
          <p>The native marimo editor opens the server's saved copy of this file. A .py extension does not guarantee a marimo notebook.</p>
          {fileAvailability.oversized && <p role="status">This regular file exceeds Source's size limit. SANE has not inspected its text or verified that it is a marimo notebook. Marimo will read the server's saved contents.</p>}
          <p className="notebook-warning">Opening may execute Python on the configured server with its permissions. Only open trusted notebooks. Selecting a file or saving this configuration does not start execution. Returning to Source keeps the notebook frame open; closing the view may not stop server-side execution.</p>
          {hasUnsavedChanges && <p role="status">You have unsaved Source edits. Save explicitly in Source first, or open the saved version without these edits. SANE will never save them automatically.</p>}
          {buffer?.disk && <p role="status">The disk file has changed. Marimo will use the server's current saved version, not the Source buffer.</p>}
          {launchBlocked && <p role="status">{launchBlocked}</p>}
          <button type="button" disabled={!!launchBlocked} onClick={launch}>{hasUnsavedChanges ? "Open saved version in marimo" : "Open notebook in marimo"}</button>
        </>}
        {active.frameError && <p className="notebook-error" role="alert">Could not open this notebook. Check the mapping and retry.</p>}
        {model.key && <button type="button" onClick={() => setConfigure(model.key)}>Configure Notebook view</button>}
        <button type="button" onClick={() => setSession(value => ({ ...value, mode: "source" }))}>Back to Source</button>
      </div> : <>
        <div className="notebook-runtime-note"><span>Native marimo · runs on the configured server. Source edits are not synchronized.{hasUnsavedChanges ? " Unsaved Source edits are not included." : ""} A hidden notebook can keep running.</span>{model.key && <button type="button" onClick={() => setConfigure(model.key)}>Configure Notebook view</button>}<button type="button" onClick={() => setSession({ identity, mode: "notebook" })}>Close notebook</button></div>
        <iframe key={`${identity}:${launchIdentity.retry}`} src={launchIdentity.url} title={`Marimo notebook: ${selected}`} className="notebook-frame" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" onError={() => { if (current.current === identity) setSession({ identity, mode: "notebook", frameError: true }); }} />
      </>}
    </section>
    {configure && configure === model.key && <NotebookConfigurationDialog key={configure} model={model} close={() => setConfigure(null)} />}
  </div>;
}
