import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FiArrowRight, FiCheck, FiChevronDown, FiFolder, FiGitBranch } from "react-icons/fi";
import type { WorktreeRecord, WorkspaceCreationInput } from "../src/catalog-contract";
import { catalog } from "./catalog";
import { useStore } from "./store";
import { ShellDialog } from "./shell-dialog";
import { useRegisterCommand, type CommandContext } from "./application-commands";
import { navigationKeyShortcuts } from "./navigation-hotkeys";
import { WORKSPACE_SELECTOR_SHORTCUT, shortcutHint } from "./shortcut-definitions";
import type { WorkspaceSelectionModel } from "./conversation-sidebar-model";
import { workstreamCheckout } from "./workstream-checkout";

export const worktreeLabel = (worktree: WorktreeRecord) => worktree.branch || (worktree.detached ? "Detached HEAD" : worktree.root.split("/").filter(Boolean).at(-1) || worktree.root);
const parentDirectory = (path: string) => { const clean = path.replace(/\/+$/, ""); return path ? clean.slice(0, clean.lastIndexOf("/")) || "/" : ""; };

export const worktreeShort = (worktree: WorktreeRecord): string => {
  const label = worktreeLabel(worktree);
  if (label.startsWith("refs/heads/")) return label.slice("refs/heads/".length) || label;
  if (label.startsWith("refs/")) return label.slice("refs/".length) || label;
  return label;
};

export const worktreeDisplay = (worktree: WorktreeRecord): string => {
  const alias = worktree.alias?.trim();
  return alias || worktreeShort(worktree);
};

export function CatalogSelector({ retry, selection, onGo }: { retry: () => void; selection?: WorkspaceSelectionModel; onGo?: () => void }) {
  const state = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const chatCwd = useStore(s => s.config?.cwd ?? "");
  const [panel, setPanel] = useState<"context" | "directory" | "create" | null>(null);
  const [search, setSearch] = useState(""), [cwd, setCwd] = useState(""), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState("");
  const [aliasDraft, setAliasDraft] = useState(""), [aliasBusy, setAliasBusy] = useState(false);
  const [selectionMode, setSelectionMode] = useState<"worktree" | "workstream">("workstream");
  const [streamSearch, setStreamSearch] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [parent, setParent] = useState(""), [name, setName] = useState(""), [unconfirmed, setUnconfirmed] = useState(false);
  const creationRequest = useRef<WorkspaceCreationInput | null>(null);
  const creationPending = useRef(false);
  const parentInput = useRef<HTMLInputElement>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width:700px)").matches);
  const detailsId = useId();
  const dialogIntent = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const workspaceChoices = useRef<HTMLElement>(null);
  const workspaceSearch = useRef<HTMLInputElement>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const { navigation } = state;
  const workspace = state.workspaces.find(w => w.workspaceId === navigation.workspaceId);
  const worktree = workspace?.worktrees.find(w => w.worktreeId === navigation.worktreeId);
  const close = () => { dialogIntent.current++; setPanel(null); };
  const show = () => { dialogIntent.current++; setSearch(""); setStreamSearch(""); setSelectionMode("workstream"); setDetailsOpen(false); setFeedback(""); setPanel("context"); };
  const onOpenChange = selection?.setOpen;
  useEffect(() => {
    if (!panel) return;
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [!!panel, onOpenChange]);
  useRegisterCommand(useMemo(() => ({
    ...WORKSPACE_SELECTOR_SHORTCUT,
    contexts: ["application", "input", "editor", "terminal", "modal"] as const,
    keyboardEligible: (event: KeyboardEvent, context: CommandContext) => {
      if (context !== "modal") return true;
      const dialog = event.target instanceof Element ? event.target.closest('dialog[open], [role="dialog"][aria-modal="true"]') : null;
      return !!panel && !!dialog && !!container.current?.contains(dialog);
    },
    available: () => true, action: () => { if (!creationPending.current) panel ? close() : show(); },
  }), [panel]));
  useEffect(() => { setAliasDraft(worktree?.alias ?? ""); }, [workspace?.workspaceId, worktree?.worktreeId, worktree?.alias, panel]);
  useEffect(() => { setStreamSearch(""); }, [navigation.workspaceId]);
  useEffect(() => { setDetailsOpen(false); }, [navigation.workspaceId]);
  useEffect(() => {
    if (panel === "context") {
      setDetailsOpen(false);
      (mobile ? workspaceChoices.current : workspaceSearch.current)?.focus();
    }
  }, [panel, mobile]);
  useEffect(() => {
    const query = window.matchMedia("(max-width:700px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  useEffect(() => { setFeedback(""); }, [navigation.workspaceId, navigation.worktreeId]);
  useEffect(() => { if (panel === "create") parentInput.current?.focus(); }, [panel]);
  const mode = workspace?.kind === "repository" && selection ? selectionMode : "worktree";
  const locked = busy || aliasBusy || !!selection?.blocked;
  const currentIntent = (intent: number, workspaceId: string, worktreeId?: string) => {
    const nav = catalog.snapshot().navigation;
    return intent === dialogIntent.current && nav.workspaceId === workspaceId && (!worktreeId || nav.worktreeId === worktreeId);
  };
  const chooseWorkspace = (workspaceId: string) => {
    if (locked) return;
    if (selection) selection.selectWorkspace(workspaceId);
    else {
      const target = state.workspaces.find(w => w.workspaceId === workspaceId);
      if (target && workspaceId !== navigation.workspaceId) catalog.navigate({ workspaceId, worktreeId: target.worktrees.find(t => t.state === "available")?.worktreeId ?? target.worktrees[0]?.worktreeId ?? null, filePath: null, comparison: null });
    }
    setFeedback("");
  };
  const goWorkspace = (workspaceId: string) => {
    if (locked || !selection?.goWorkspace(workspaceId)) return;
    close();
    onGo?.();
  };
  const chooseWorktree = (worktreeId: string) => {
    if (selection) selection.selectWorktree(worktreeId);
    else catalog.navigate({ worktreeId, filePath: null, comparison: null });
    setFeedback("");
  };
  const display = worktree ? worktreeDisplay(worktree) : null;
  const fullRef = worktree ? worktreeLabel(worktree) : null;
  const openerLabel = workspace?.name ?? (navigation.workspaceId ? "Unavailable workspace" : "Open workspace");
  const openerTitle = worktree ? `${fullRef} · ${worktree.root}` : workspace?.worktrees[0] ? `${workspace.worktrees[0].root}` : undefined;
  const openerAria = workspace ? (worktree ? `Workspace ${workspace.name}, worktree ${display}: ${fullRef} · ${worktree.root}` : `Workspace ${workspace.name}: Choose worktree`) : "Open workspace";
  const selectedStream = selection?.overview?.workstreams.find(w => w.workstream.id === selection.workstreamId)?.workstream;
  const streamTree = workstreamCheckout(workspace, selectedStream);
  const workspaces = state.workspaces.filter(w => `${w.name} ${w.worktrees.map(t => t.root).join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const streams = selection?.overview?.workstreams
    .filter(({ workstream: w }) => `${w.title} ${w.id} ${w.defaultCheckout?.path ?? ""}`.toLowerCase().includes(streamSearch.toLowerCase()))
    .sort((a, b) => Date.parse(b.workstream.createdAt) - Date.parse(a.workstream.createdAt) || a.workstream.id.localeCompare(b.workstream.id)) ?? [];
  const refreshWorktrees = workspace && <button type="button" className="text-button" disabled={locked || !workspace.worktrees.length} onClick={async () => {
      const root = worktree?.root ?? workspace.worktrees[0]?.root;
      if (!root) return;
      const intent = dialogIntent.current;
      setBusy(true); setFeedback("");
      const refreshed = await catalog.refresh(workspace.workspaceId, root);
      setBusy(false);
      if (currentIntent(intent, workspace.workspaceId) && refreshed) setFeedback("Worktrees refreshed.");
    }}>{busy ? "Refreshing…" : "Refresh worktrees"}</button>;
  const aliasEditor = workspace && worktree && <section className="context-alias" aria-label="Worktree alias">
    <label>Worktree alias<input value={aliasDraft} maxLength={80} placeholder={worktreeShort(worktree)} disabled={locked} onChange={event => setAliasDraft(event.target.value)} /></label>
    <div className="context-alias-actions">
      <button type="button" disabled={locked || aliasDraft.trim() === (worktree.alias ?? "") || aliasDraft.trim().length > 80} onClick={async () => {
        const trimmed = aliasDraft.trim();
        if (trimmed.length > 80) { setFeedback("Alias must be 1-80 characters."); return; }
        const intent = dialogIntent.current;
        setAliasBusy(true); setFeedback("");
        const ok = await catalog.setAlias(workspace.workspaceId, worktree.worktreeId, trimmed || null);
        setAliasBusy(false);
        if (ok && currentIntent(intent, workspace.workspaceId, worktree.worktreeId)) setFeedback(trimmed ? "Alias saved." : "Alias cleared.");
      }}>{aliasBusy ? "Saving…" : "Save alias"}</button>
      {worktree.alias && <button type="button" className="text-button" disabled={locked} onClick={async () => {
        const intent = dialogIntent.current;
        setAliasBusy(true); setFeedback("");
        const ok = await catalog.setAlias(workspace.workspaceId, worktree.worktreeId, null);
        setAliasBusy(false);
        if (ok && currentIntent(intent, workspace.workspaceId, worktree.worktreeId)) { setAliasDraft(""); setFeedback("Alias cleared."); }
      }}>Clear</button>}
    </div>
    <small className="muted">Short name for this worktree. Defaults to the short branch name.</small>
  </section>;
  const notices = <>
    {feedback && <p className="context-feedback" role="status">{feedback}</p>}
    {selection?.selectionError && <p className="notice error" role="alert">{selection.selectionError}</p>}
    {state.error && <p className="notice error" role="status">{state.error}{!state.ready && <button type="button" onClick={retry}>Retry</button>}</p>}
    {panel === "context" && workspace?.kind === "repository" && selection?.loading && <p className="muted" role="status">Loading workstreams…</p>}
    {panel === "context" && workspace?.kind === "repository" && selection?.error && <p className="notice error" role="status">Workstreams could not refresh. {selection.error} Retrying automatically.</p>}
  </>;
  return <div className="context-switcher" ref={container}>
    <button type="button" className="workspace-opener" aria-haspopup="dialog" aria-label={openerAria} aria-keyshortcuts={navigationKeyShortcuts("ArrowDown")} title={[openerTitle, `Toggle workspace selection (${shortcutHint(WORKSPACE_SELECTOR_SHORTCUT)})`].filter(Boolean).join(" · ")} onClick={show}><span className="workspace-opener-label"><span className="workspace-opener-title">{openerLabel}</span>{workspace && <span className="workspace-opener-checkout">{display ?? "Choose worktree"}</span>}</span><FiChevronDown size={13} aria-hidden="true" /></button>
    {panel && <ShellDialog title={panel === "create" ? "New workspace" : panel === "directory" ? "Open directory" : "Workspace"} bare={panel === "context"} className={panel === "context" ? "workspace-context-dialog" : ""} initialFocus={panel === "context" ? () => mobile ? workspaceChoices.current : workspaceSearch.current : undefined} closeDisabled={panel === "create" && busy} close={close}>
      {panel === "create" ? <form className="open-directory" aria-busy={busy} onSubmit={async event => {
        event.preventDefault();
        if (locked || creationPending.current || !parent.trim() || !name.trim()) return;
        const intent = dialogIntent.current;
        const input = creationRequest.current ?? { requestId: crypto.randomUUID(), parent: parent.trim(), name: name.trim() };
        creationRequest.current = input; creationPending.current = true;
        setBusy(true); setFeedback("");
        try {
          const outcome = await catalog.create(input, () => intent === dialogIntent.current && !selectionRef.current?.blocked, selection ? result => selectionRef.current?.selectWorkspace(result.workspaceId, result.worktreeId) ?? false : undefined);
          if (intent !== dialogIntent.current) return;
          setUnconfirmed(outcome === "unconfirmed");
          if (outcome === "activated" || outcome === "created") { creationRequest.current = null; setParent(""); setName(""); }
          if (outcome === "activated") close();
          else if (outcome === "created") { dialogIntent.current++; setPanel("context"); setFeedback("Workspace created. Select it from the workspace list to open it."); }
        } finally { creationPending.current = false; setBusy(false); }
      }}>
        <label>Parent directory<input ref={parentInput} autoFocus required value={parent} placeholder="/absolute/path/to/projects" disabled={busy || unconfirmed} onChange={event => { setParent(event.target.value); creationRequest.current = null; }} /></label>
        <label>Folder name<input required value={name} maxLength={200} placeholder="my-project" disabled={busy || unconfirmed} onChange={event => { setName(event.target.value); creationRequest.current = null; }} /></label>
        {parent.trim() && name.trim() && <p className="context-path">Destination: {parent.trim().replace(/\/$/, "")}/{name.trim()}</p>}
        <p className="muted">Creates a new folder, a Git repository on main, and SANE workstream state. Adds /.sane/ to .gitignore. No initial commit is made. Choose an existing parent outside other Git repositories.</p>
        {unconfirmed && <p className="notice" role="status">The request may already have completed. Check creation to retrieve its outcome without creating the folder again.</p>}
        <div className="dialog-actions"><button type="button" disabled={busy} onClick={() => { dialogIntent.current++; setPanel("context"); }}>Back</button><button type="submit" disabled={locked || !parent.trim() || !name.trim()}>{busy ? "Creating…" : unconfirmed ? "Check creation" : "Create workspace"}</button></div>
      </form> : panel === "directory" ? <form className="open-directory" aria-busy={busy} onSubmit={async event => {
        event.preventDefault();
        if (locked || !cwd.trim()) return;
        const intent = dialogIntent.current;
        setBusy(true);
        const opened = await catalog.open(cwd.trim(), () => intent === dialogIntent.current && !selectionRef.current?.blocked, selection ? result => selectionRef.current?.selectWorkspace(result.workspaceId, result.worktreeId) ?? false : undefined);
        setBusy(false);
        if (opened && intent === dialogIntent.current) {
          close();
        }
      }}><label>Directory path<input autoFocus required value={cwd} placeholder="/absolute/path/to/project" onChange={event => setCwd(event.target.value)} /></label><p className="muted">Open a local repository or folder. Repositories include their main and linked worktrees; other folders open as directory workspaces.</p><div className="dialog-actions"><button type="button" disabled={locked} onClick={() => { dialogIntent.current++; setPanel("context"); }}>Back</button><button type="submit" disabled={locked || !cwd.trim()}>{busy ? "Opening…" : "Open directory"}</button></div></form> : <>
        <div className="workspace-context-heading">
          <div>{workspace && <><h3>{workspace.name}</h3><p className="muted">{workspace.kind === "repository" ? "Repository workspace" : "Directory workspace"}</p></>}</div>
          <button type="button" className="icon-button" aria-label="Close workspace" onClick={close}>×</button>
        </div>
        <div className="workspace-context-panel">
        <aside className="workspace-context-sidebar" aria-label="Workspace selection">
          <label className="workspace-search"><span className="sr-only">Search workspace names and paths</span><input ref={workspaceSearch} autoFocus={!mobile} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search workspaces…" /></label>
          <nav ref={workspaceChoices} tabIndex={-1} className="workspace-choices" aria-label="Existing workspaces" aria-busy={state.loading}>{workspaces.map(w => <div className="workspace-choice-row" key={w.workspaceId}>
            <button type="button" className="workspace-choice-select" aria-current={w.workspaceId === navigation.workspaceId ? "true" : undefined} disabled={locked} onClick={() => chooseWorkspace(w.workspaceId)} title={w.worktrees[0]?.root}>
            <span className="workspace-choice-heading"><FiFolder size={14} aria-hidden="true" /><span>{w.name}</span>{w.workspaceId === navigation.workspaceId && <FiCheck size={14} aria-hidden="true" />}</span>
            <small>{w.worktrees[0]?.root || "Unavailable directory"}</small>
            </button>
            {selection && <button type="button" className="workspace-choice-go" aria-label={`Open ${w.name} in Chat`} title={`Open ${w.name} in Chat`} disabled={locked || !w.worktrees.length} onClick={() => goWorkspace(w.workspaceId)}><FiArrowRight size={18} aria-hidden="true" /></button>}
          </div>)}{state.loading && <p className="muted" role="status">Loading workspaces…</p>}{!state.loading && !workspaces.length && <p className="muted" role="status">{search ? "No matching workspaces." : "No workspaces yet."}</p>}</nav>
          <div className="workspace-directory-actions">
            <button type="button" className="secondary-directory" disabled={locked} onClick={() => { dialogIntent.current++; if (!creationRequest.current) { setParent(parentDirectory(worktree?.root || chatCwd || "")); setName(""); } setFeedback(""); setPanel("create"); }}>New workspace…</button>
            <button type="button" className="secondary-directory" disabled={locked} onClick={() => { dialogIntent.current++; setCwd(worktree?.root || chatCwd || ""); setPanel("directory"); }}>Open directory…</button>
          </div>
        </aside>
        <div className="workspace-context-detail">
          {notices}
          {workspace ? <>
            {mobile && <button type="button" className="context-detail-toggle" aria-expanded={detailsOpen} aria-controls={detailsId} onClick={() => setDetailsOpen(open => !open)}>Worktrees and workstreams<FiChevronDown size={16} aria-hidden="true" /></button>}
            <div id={detailsId} className="context-detail-content" hidden={mobile && !detailsOpen}>
            <div className="context-selection-modes" role="group" aria-label="Select checkout via">
              <button type="button" aria-pressed={mode === "worktree"} disabled={locked} onClick={() => { setSelectionMode("worktree"); if (selection?.workstreamId) selection.selectWorkstream(null); }}>Worktree</button>
              <button type="button" aria-pressed={mode === "workstream"} disabled={locked || workspace.kind !== "repository" || !selection} onClick={() => setSelectionMode("workstream")}>Workstream</button>
            </div>
            {mode === "workstream" ? <section className="context-selection-section" aria-label="Workstream selection">
              <label className="workspace-search"><span className="sr-only">Search workstreams</span><input value={streamSearch} onChange={event => setStreamSearch(event.target.value)} placeholder="Search workstreams…" /></label>
              <div className="context-selection-list">{streams.map(({ workstream: stream }) => {
                const tree = workstreamCheckout(workspace, stream);
                const selected = stream.id === selection?.workstreamId;
                return <button type="button" key={stream.id} className={selected ? "selected" : ""} aria-pressed={selected} disabled={locked} onClick={() => { selection?.selectWorkstream(stream.id); setFeedback(""); }}>
                  <span className="context-choice-heading"><span>{stream.title || stream.id}</span>{selected && <FiCheck size={14} aria-hidden="true" />}</span>
                  <small>{stream.id} · {stream.lifecycle.status}</small>
                  <small title={stream.defaultCheckout?.path}>{tree ? `Checkout: ${worktreeDisplay(tree)}` : stream.defaultCheckout ? "Default checkout unavailable · browsing unchanged" : "No default checkout · browsing unchanged"}</small>
                </button>;
              })}</div>
              {!selection?.loading && !selection?.error && !streams.length && <p className="muted">{streamSearch ? "No matching workstreams." : "No workstreams yet. Manage workstreams in Settings."}</p>}
              {selection?.workstreamId && <div className="context-workstream-scope">
                {selectedStream && !streamTree && <p className="notice" role="status">{selectedStream.defaultCheckout ? `The default checkout (${selectedStream.defaultCheckout.path}) is unavailable. Browsing remains unchanged.` : "No default checkout is configured. Browsing remains unchanged."}</p>}
                {!selection?.loading && selection?.overview && !selectedStream && <p className="notice" role="status">The selected workstream is no longer listed. Clear the selection to show other sessions.</p>}
                <button type="button" className="text-button" disabled={locked} onClick={() => selection?.selectWorkstream(null)}>Clear workstream selection</button>
              </div>}
            </section> : <section className="context-selection-section" aria-label="Worktree selection">
              <div className="context-selection-list">{workspace.worktrees.map(tree => <button type="button" key={tree.worktreeId} className={tree.worktreeId === navigation.worktreeId ? "selected" : ""} aria-pressed={tree.worktreeId === navigation.worktreeId} disabled={locked || tree.state !== "available"} onClick={() => chooseWorktree(tree.worktreeId)}>
                <span className="context-choice-heading"><FiGitBranch size={14} aria-hidden="true" /><span>{worktreeDisplay(tree)}</span>{tree.worktreeId === navigation.worktreeId && <FiCheck size={14} aria-hidden="true" />}</span>
                <small title={worktreeLabel(tree)}>{worktreeShort(tree)}{tree.state !== "available" ? " · Unavailable" : ""}</small><small title={tree.root}>{tree.root}</small>
              </button>)}</div>
              {!workspace.worktrees.length && <p className="muted">No worktrees available. Open a directory to rediscover this workspace.</p>}
              <p className="muted">Direct selection scopes sessions to this worktree.</p>
            </section>}
            <section className="context-checkout-summary" aria-label="Browsing checkout">
              <h4>Browsing checkout</h4>
              {worktree ? <><strong>{display}</strong><small>{fullRef}</small><small className="context-path" title={worktree.root}>{worktree.root}</small></> : <p className="muted">{navigation.worktreeId ? "Selected worktree unavailable." : "Choose a worktree."}</p>}
              {worktree?.state === "invalid" && <p className="notice" role="status">{worktree.reason || "Worktree unavailable. History and local drafts remain accessible."}</p>}
              {selection?.workstreamId && streamTree && streamTree.worktreeId !== navigation.worktreeId && <p className="muted">Workstream default: {worktreeDisplay(streamTree)}. Select the workstream again to browse its default checkout.</p>}
              <p className="muted">The open conversation keeps its execution directory and membership.</p>
            </section>
            <section className="context-worktree-config" aria-label="Worktree configuration"><h4>Worktree configuration</h4>{aliasEditor}{refreshWorktrees}</section>
            </div>
          </> : <p className="muted">{navigation.workspaceId ? "This workspace is unavailable. Choose another workspace or open a directory." : "Choose a workspace or open a directory to get started."}</p>}
        </div>
        </div>
      </>}
      {panel !== "context" && notices}
    </ShellDialog>}
    {state.error && !panel && <button type="button" className="context-error" aria-label={`Workspace or navigation error: ${state.error}`} title={state.error} onClick={show}>!</button>}
  </div>;
}
