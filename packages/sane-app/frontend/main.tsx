import { createRoot } from "react-dom/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { FiMoreHorizontal, FiZap } from "react-icons/fi";
import { store } from "./store";
import { WorkspaceHeader, WorkspaceProvider, WorkspaceSidebar, WorkspaceView, workspaceHasDirtyBuffers, resetWorkspaceState } from "./workspace";
import type { ActiveView } from "./workspace-controller";
import { TerminalHeader, TerminalProvider, TerminalSidebar, TerminalView } from "./terminal";
import { catalog } from "./catalog";
import { CatalogSelector, worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { ShellDialog } from "./shell-dialog";
import { WorkstreamsView, type ArtifactSelection } from "./workstreams";
import { WorkstreamArtifact } from "./workstream-artifact";
import { formatTitle } from "./conversation-filter";
import { HistoryDetail, HistoryList } from "./history-view";
import { ConfigMenu, ConfigView } from "./config-view";
import { History } from "./history-sidebar";
import { Facts, NativeUsage, RunDetails, Thread, Usage } from "./thread";
import { Drawer, Icon, SidebarFooter } from "./nav";
import { harnessName } from "./types";
import "./style.css";
import "./catalog.css";
import "./agents.css";
import "./workers.css";

const basename = (path?: string | null) => path?.split("/").filter(Boolean).at(-1) || path || "Conversation";

function App() {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [drawer, setDrawer] = useState<"history" | "details" | "application" | null>(null);
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const activeView = repository.navigation.view;
  const [artifact, setArtifact] = useState<ArtifactSelection | null>(null);
  const [historyPreview, setHistoryPreview] = useState<string | null>(null);
  useEffect(() => {
    if (activeView !== "history") return;
    if (historyPreview && state.conversations.some(c => c.id === historyPreview)) return;
    if (state.selected && state.conversations.some(c => c.id === state.selected)) setHistoryPreview(state.selected);
    else if (state.conversations.length) setHistoryPreview([...state.conversations].reverse()[0]!.id);
    else setHistoryPreview(null);
  }, [activeView, state.selected, state.conversations, historyPreview]);
  useEffect(() => { setArtifact(null); }, [repository.navigation.workspaceId, repository.navigation.worktreeId, repository.navigation.filePath]);
  const openArtifact = (selection: ArtifactSelection) => { setArtifact(selection); catalog.navigate({ view: "code" }); };
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  useEffect(() => { store.start(); window.addEventListener("online", store.reconnect); document.addEventListener("visibilitychange", store.reconnect); return () => { window.removeEventListener("online", store.reconnect); document.removeEventListener("visibilitychange", store.reconnect); }; }, []);
  // Restore chat directly: the history-selection action also changes browsing and view.
  const hydrate = () => void catalog.hydrate(bookmark => store.choose(bookmark.conversationId ?? ""));
  useEffect(() => { if (state.phase === "ready") hydrate(); }, [state.phase]);
  const navigate = (view: ActiveView) => { setArtifact(null); catalog.navigate({ view }); setDrawer(null); };
  const choose = (id: string) => {
    if (state.sending) return;
    store.openConversation(id); setDrawer(null);
  };
  useEffect(() => { setDrawer(null); }, [state.selected]);
  const signOut = () => {
    if (workspaceHasDirtyBuffers() && !window.confirm("Discard unsaved workspace changes and sign out?")) return;
    resetWorkspaceState();
    setArtifact(null);
    setDrawer(null);
    void store.logout();
  };
  if (state.phase !== "ready") return <main className="auth-screen"><div className="auth-card"><span className="welcome-mark" aria-hidden="true"><FiZap size={44} aria-hidden="true" /></span><p className="eyebrow">YOUR LOCAL BRIDGE</p><h1>{state.phase === "login" ? "Welcome back." : "Connecting your workspace."}</h1><p className="muted">{state.phase === "login" ? "Enter your bridge password to pick up where you left off." : "A quiet place to work with your local coding assistants."}</p>{state.phase === "login" && <form onSubmit={async event => { event.preventDefault(); setLoggingIn(true); await store.login(password); setPassword(""); setLoggingIn(false); }}><label htmlFor="password">Bridge password</label><input id="password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={e => setPassword(e.target.value)} /><button className="primary-button" disabled={loggingIn}>{loggingIn ? "Signing in…" : "Open workspace"}</button></form>}{(state.authError || state.connectionError) && <p className="notice error" role="alert">{state.authError || state.connectionError}</p>}</div></main>;
  const conversation = state.conversations.find(c => c.id === state.selected);
  const executionWorkspace = repository.workspaces.find(w => w.workspaceId === conversation?.workspaceId);
  const executionWorktree = executionWorkspace?.worktrees.find(w => w.worktreeId === conversation?.worktreeId);
  const browsingMismatch = conversation && (conversation.workspaceId !== repository.navigation.workspaceId || conversation.worktreeId !== repository.navigation.worktreeId);
  const latestUsage = [...state.runs].reverse().find(r => r.usage)?.usage;
  const nativeUsageRun = [...state.runs].reverse().find(r => r.nativeUsage);
  return <WorkspaceProvider view={activeView} navigate={navigate}><TerminalProvider view={activeView}><div className={`app-shell view-${activeView}`}>
    <aside className="sidebar"><SidebarFooter state={state} activeView={activeView} onNavigate={navigate} /><div className="sidebar-body">{activeView === "chat" ? <History state={state} onChoose={choose} /> : activeView === "history" ? <HistoryList state={state} previewId={historyPreview} onPreview={setHistoryPreview} /> : activeView === "terminal" ? <TerminalSidebar /> : activeView === "workstreams" ? <p className="muted history-empty">Repository workstreams<br />Browse and manage explicit associations.</p> : activeView === "config" ? <ConfigMenu /> : <WorkspaceSidebar />}</div></aside>
    <main className="main"><header className="topbar"><button className="icon-button mobile-menu" aria-label="Open workspace navigation" onClick={() => setDrawer("history")}><Icon name="menu" /></button><CatalogSelector retry={hydrate} />{activeView === "chat" ? <><div className="conversation-heading"><span title={conversation?.title || undefined}>{conversation?.title ? formatTitle(conversation.title, basename(conversation.cwd)) : state.selected ? "Conversation" : "New conversation"}</span></div><span className="harness-badge">{harnessName(store.harness())}</span><button className="details-button" aria-label="Conversation details" onClick={() => setDrawer("details")}><Icon name="details" /><span>Details</span></button></> : activeView === "terminal" ? <TerminalHeader /> : activeView === "workstreams" ? <div className="conversation-heading">Workstreams</div> : activeView === "history" ? <div className="conversation-heading">History</div> : activeView === "config" ? <div className="conversation-heading">Settings</div> : artifact && activeView === "code" ? <div className="conversation-heading">Code · Read-only workstream artifact</div> : <WorkspaceHeader />}<button type="button" className="icon-button application-opener" aria-label="Application menu" aria-haspopup="dialog" onClick={() => setDrawer("application")}><FiMoreHorizontal size={16} aria-hidden="true" /><span className={`connection-dot ${state.connected ? "online" : ""}`} /></button></header>{state.connectionError && <div className="connection-notice" role="status">{state.connectionError}<button type="button" onClick={store.reconnect}>Reconnect</button></div>}{browsingMismatch && activeView !== "terminal" && <div className="execution-context" role="status"><span title={executionWorktree ? `${worktreeLabel(executionWorktree)} · ${executionWorktree.root}` : conversation.cwd}>Runs in: {executionWorktree ? worktreeDisplay(executionWorktree) : conversation.cwd || "Unavailable worktree"}</span>{conversation.workspaceId && conversation.worktreeId ? <button type="button" disabled={state.sending} onClick={() => catalog.navigate({ workspaceId: conversation.workspaceId, worktreeId: conversation.worktreeId, filePath: null, comparison: null })}>Browse execution worktree</button> : <button type="button" onClick={() => setDrawer("details")}>Execution details</button>}</div>}<div className="chat-surface" style={{ display: activeView === "chat" ? undefined : "none" }}><Thread state={state} /></div>{activeView === "workstreams" && <WorkstreamsView workspaceId={repository.navigation.workspaceId} openArtifact={openArtifact} />}{activeView === "history" && <HistoryDetail state={state} previewId={historyPreview} onOpen={choose} />}{activeView === "config" && <ConfigView state={state} signOut={signOut} />}{activeView === "code" && artifact && artifact.workspaceId === repository.navigation.workspaceId ? <WorkstreamArtifact artifact={artifact} close={() => setArtifact(null)} /> : (activeView === "code" || activeView === "git") && <WorkspaceView />}{activeView === "terminal" && <TerminalView />}</main>
    {drawer === "history" && <Drawer title={activeView === "chat" ? "Conversations" : activeView === "history" ? "History" : activeView === "code" ? "Files" : activeView === "terminal" ? "Terminal" : activeView === "workstreams" ? "Workstreams" : activeView === "config" ? "Settings" : "Changes"} close={() => setDrawer(null)}>{activeView === "chat" ? <History state={state} onChoose={choose} /> : activeView === "history" ? <HistoryList state={state} previewId={historyPreview} onPreview={id => { setHistoryPreview(id); setDrawer(null); }} /> : activeView === "terminal" ? <TerminalSidebar /> : activeView === "workstreams" ? <p className="muted">Browse workstreams in the selected repository workspace.</p> : activeView === "config" ? <ConfigMenu onSelect={() => setDrawer(null)} /> : <WorkspaceSidebar />}<SidebarFooter state={state} activeView={activeView} onNavigate={navigate} /></Drawer>}
    {drawer === "application" && <ShellDialog title="Application" close={() => setDrawer(null)}><div className="application-status"><span className={`connection-dot ${state.connected ? "online" : ""}`} /><span>{state.connected ? "Local bridge connected" : "Connecting to bridge"}</span></div><details className="application-connection"><summary>Connection details</summary><p className="muted">{state.connectionError || (state.connected ? "Connected to the local bridge." : "Waiting for the local bridge.")}</p><button type="button" className="text-button" onClick={store.reconnect}>Reconnect</button></details>{state.config?.authRequired && <button type="button" className="application-signout" disabled={state.sending} onClick={signOut}>Sign out</button>}</ShellDialog>}
    {drawer === "details" && <Drawer title="Conversation details" close={() => setDrawer(null)}>
      <section className="detail-section"><p className="eyebrow">EXECUTION WORKTREE</p>{!state.selected ? <label className="directory-label">Launch directory<input value={store.draft().cwd} placeholder="Selected worktree root or a subdirectory" onChange={e => store.setDraft({ cwd: e.target.value })} /><small>Defaults to the selected worktree root. Optionally choose a directory inside that worktree.</small></label> : <Facts values={[["Conversation ID", state.selected], ["Harness", harnessName(store.harness())], ["Agent", store.conversationProfile(state.selected)?.label ?? (store.agent() || "Base")], ["Native session ID", conversation?.nativeSessionId], ["Launch directory", conversation?.cwd], ["Workspace", conversation?.workspaceId || "Unavailable"], ["Worktree", conversation?.worktreeId || "Unavailable"]]} />}<p className="muted">Each follow-up uses this conversation’s fixed execution directory and harness. Browsing another worktree does not retarget it.</p>{conversation?.association !== "resolved" && state.selected && <p className="notice" role="status">Execution workspace unavailable. Recorded history remains accessible.</p>}</section>
      <section className="detail-section"><h3>Latest reported usage</h3>{store.harness() === "opencode" ? <>{nativeUsageRun && nativeUsageRun.id !== state.runs.at(-1)?.id && <p className="muted">Showing an earlier run’s snapshot; the latest run has no reported usage yet.</p>}<NativeUsage run={nativeUsageRun} /></> : <>{latestUsage && latestUsage.runId !== state.runs.at(-1)?.id && <p className="muted">A newer run has no result snapshot yet. Showing an earlier run.</p>}<Usage snapshot={latestUsage} /></>}</section>
      <section className="detail-section"><h3>Runs & diagnostics <span className="muted">{state.runs.length}</span></h3>{state.runs.length ? [...state.runs].reverse().map(run => <RunDetails key={run.id} run={run} />) : <p className="muted">Run IDs and raw events will appear here.</p>}</section>
    </Drawer>}
  </div></TerminalProvider></WorkspaceProvider>;
}

createRoot(document.getElementById("root")!).render(<App />);
