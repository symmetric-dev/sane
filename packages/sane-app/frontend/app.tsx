import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FiMoreHorizontal } from "react-icons/fi";
import { PenroseTriangle } from "./penrose-triangle";
import { store, useShellState, type State } from "./store";
import { catalog } from "./catalog";
import { worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { WorkspaceHeader, WorkspaceProvider, WorkspaceSidebar, WorkspaceView, workspaceHasDirtyBuffers, resetWorkspaceState } from "./workspace";
import type { ActiveView } from "./workspace-controller";
import { TerminalHeader, TerminalProvider, TerminalView } from "./terminal";
import { WorkspaceShell } from "./workspace-shell";
import { ShellDialog } from "./shell-dialog";
import type { ArtifactSelection } from "./workstreams";
import { WorkstreamArtifact } from "./workstream-artifact";
import { HistoryDetail } from "./history-view";
import { ConfigMenu, ConfigView } from "./config-view";
import { ConversationSidebar, useConversationSidebarModel } from "./conversation-sidebar";
import { ConversationHeading } from "./conversation-heading";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { Facts, LoadedTranscriptDiagnostics, NativeHistoryDetails, NativeUsage, RunDetails, Thread, Usage } from "./thread";
import { ContextualNavigation, Drawer, FilesModeControl, Icon, SidebarToggleCommand, ViewNavigationCommands, viewGroup } from "./nav";
import { harnessName } from "./types";
import { ApplicationCommandProvider } from "./application-commands";
import { WorkspaceSearchButton, WorkspaceSearchFeature } from "./workspace-search";
import { WorkspaceQuickOpenFeature } from "./workspace-quick-open";
import { WorkspaceFileShortcuts } from "./workspace-file-shortcuts";
import type { DocumentReviewLaunch, DocumentReviewRequest } from "./document-review-launch";
import { CompactDialog, ContextControl, ContextDialog } from "./compaction-ui";
import { NativeSubagentContext, nativeSubagentVirtualKey, useNativeSubagentFeature, useNativeSubagents } from "./native-subagent-feature";
import { NativeSubagentView } from "./native-subagent-view";
import { InstallApp } from "./pwa-install-view";
import { DeviceNotifications } from "./chrome-push-view";
import { chromePush } from "./chrome-push";
import { PushNavigation, usePushInbox, type PushInbox } from "./push-navigation";
import { notificationStore } from "./notifications";
import { notificationContextKey } from "./notification-source";
import { ChatFileNavigationProvider } from "./chat-file-link";
import { BrowserFooter, BrowserHeader, BrowserProvider, BrowserSidebar, BrowserView } from "./browser-view";

// Restore selection without replacing the independently bookmarked browsing pair.
const hydrateCatalog = () => void catalog.hydrate(bookmark => store.choose(bookmark.conversationId ?? ""));

export function App() {
  const state = useShellState();
  const inbox = usePushInbox();
  const [hydratedConfig, setHydratedConfig] = useState<State["config"]>();
  useEffect(() => chromePush.start(), []);
  useEffect(() => {
    store.start();
    window.addEventListener("online", store.reconnect);
    document.addEventListener("visibilitychange", store.reconnect);
    return () => {
      window.removeEventListener("online", store.reconnect);
      document.removeEventListener("visibilitychange", store.reconnect);
    };
  }, []);
  useEffect(() => {
    if (state.phase !== "ready") { setHydratedConfig(undefined); return; }
    const config = state.config;
    let active = true;
    void catalog.hydrate(bookmark => {
      if (store.snapshot().phase === "ready" && store.snapshot().config === config) store.choose(bookmark.conversationId ?? "");
    }).then(() => { if (active && store.snapshot().config === config) setHydratedConfig(config); });
    return () => { active = false; };
  }, [state.phase, state.config]);
  const signOut = () => {
    if (workspaceHasDirtyBuffers() && !window.confirm("Discard unsaved workspace changes and sign out?")) return;
    chromePush.beginSignOut();
    resetWorkspaceState();
    void store.logout();
  };
  return <>{inbox.notice && <div className="connection-notice" role="status">{inbox.notice}<button type="button" onClick={inbox.dismiss}>Dismiss</button></div>}
    {state.phase === "ready" ? <ReadyWorkspace state={state} signOut={signOut} inbox={inbox} hydrationReady={!!hydratedConfig && hydratedConfig === state.config} /> : <AuthScreen state={state} />}</>;
}

function AuthScreen({ state }: { state: State }) {
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  return <main className="auth-screen"><div className="auth-card">
    <span className="welcome-mark" aria-hidden="true"><PenroseTriangle size={44} /></span>
    <p className="eyebrow">YOUR LOCAL BRIDGE</p>
    <h1>{state.phase === "login" ? "Welcome back." : "Connecting your workspace."}</h1>
    <p className="muted">{state.phase === "login" ? "Enter your bridge password to pick up where you left off." : "A quiet place to work with your local coding assistants."}</p>
    {state.phase === "login" && <form onSubmit={async event => {
      event.preventDefault(); setLoggingIn(true);
      await store.login(password); setPassword(""); setLoggingIn(false);
    }}>
      <label htmlFor="password">Bridge password</label>
      <input id="password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={event => setPassword(event.target.value)} />
      <button className="primary-button" disabled={loggingIn}>{loggingIn ? "Signing in…" : "Open workspace"}</button>
    </form>}
    {(state.authError || state.connectionError) && <p className="notice error" role="alert">{state.authError || state.connectionError}</p>}
  </div></main>;
}

function ReadyWorkspace({ state, signOut, inbox, hydrationReady }: { state: State; signOut: () => void; inbox: PushInbox; hydrationReady: boolean }) {
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const { view, workspaceId, worktreeId } = repository.navigation;
  const nativeParent = state.conversations.find(conversation => conversation.id === state.selected);
  const nativeParentSessionId = nativeParent?.id ?? "";
  const nativeSubagents = useNativeSubagentFeature(nativeParentSessionId, !!nativeParentSessionId && nativeParent?.harness === "claude-code", view === "chat", JSON.stringify([nativeParentSessionId, nativeParent?.nativeSessionId, nativeParent?.harness]));
  const [drawer, setDrawer] = useState<"sidebar" | "details" | "context" | "application" | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const toggleSidebar = useCallback(() => {
    if (window.matchMedia("(max-width:700px)").matches) setDrawer(current => current === "sidebar" ? null : "sidebar");
    else {
      // Do not leave keyboard focus in a sidebar that is about to become inert.
      if (document.activeElement?.closest(".sidebar")) document.querySelector<HTMLButtonElement>(".sidebar-toggle")?.focus();
      setSidebarHidden(current => !current);
    }
  }, []);
  const [artifact, setArtifact] = useState<ArtifactSelection | null>(null);
  const [historyPreview, setHistoryPreview] = useState<string | null>(null);
  const [reviewRequest, setReviewRequest] = useState<DocumentReviewRequest | null>(null);
  const reviewSerial = useRef(0);
  const reviewRequestHandled = useCallback((requestId: number) => setReviewRequest(current => current?.requestId === requestId ? null : current), []);
  const mode = view === "history" ? "history" : "chat";
  // The desktop sidebar and mobile drawer share one filter/search state owner.
  const sidebarModel = useConversationSidebarModel(state, mode);
  const selectorIsOpen = sidebarModel.workspaceSelection.isOpen;
  useEffect(() => { setArtifact(null); }, [workspaceId, worktreeId, repository.navigation.filePath]);
  useEffect(() => { setHistoryPreview(null); }, [workspaceId, worktreeId]);
  useEffect(() => {
    if (view !== "history") return;
    if (historyPreview && state.conversations.some(conversation => conversation.id === historyPreview)) return;
    const scoped = state.conversations.filter(conversation => conversation.workspaceId === workspaceId && conversation.worktreeId === worktreeId);
    setHistoryPreview(scoped.find(conversation => conversation.id === state.selected)?.id ?? scoped.at(-1)?.id ?? null);
  }, [view, workspaceId, worktreeId, state.selected, state.conversations, historyPreview]);
  useEffect(() => { if (!selectorIsOpen()) setDrawer(null); }, [state.selected, selectorIsOpen]);
  useEffect(() => {
    if (view !== "chat" || nativeSubagents.active || state.compactDialog) setDrawer(current => current === "context" ? null : current);
  }, [view, nativeSubagents.active, state.compactDialog]);
  useEffect(() => {
    if (!reviewRequest) return;
    // Read the settled stores: starting a review also selects its chat in this turn.
    const current = store.snapshot();
    const target = current.conversations.find(conversation => conversation.id === reviewRequest.sessionId);
    if (catalog.snapshot().navigation.view !== "chat" || current.selected !== reviewRequest.sessionId || !target || target.replacedBy || target.workspaceId !== reviewRequest.workspaceId) reviewRequestHandled(reviewRequest.requestId);
  }, [reviewRequest, view, state.selected, state.conversations, reviewRequestHandled]);
  const navigate = (next: ActiveView) => { if (next !== "chat") setReviewRequest(null); setArtifact(null); catalog.navigate({ view: next }); setDrawer(null); };
  const choose = (id: string) => {
    if (store.snapshot().sending) return;
    if (id !== reviewRequest?.sessionId) setReviewRequest(null);
    store.openConversation(id); setDrawer(null);
  };
  const openNotification = (id: string) => {
    const current = store.snapshot();
    const target = current.conversations.find(conversation => conversation.id === id);
    if (current.phase !== "ready" || current.sending || !current.conversationsReady || !catalog.snapshot().ready || !target || target.replacedBy) return false;
    const candidate = notificationStore.captureOpen(id);
    const capture = candidate?.contextKey === notificationContextKey(target) ? candidate : null;
    if (!store.openConversation(id, { deferAck: true })) return false;
    if (store.snapshot().selected !== id || catalog.snapshot().navigation.view !== "chat") return false;
    // Reset scope using the newly opened session's live browsing pair, without
    // workspace activation choosing a different (more recent) conversation.
    sidebarModel.workspaceSelection.selectWorkstream(null);
    nativeSubagents.back(); setReviewRequest(null); setArtifact(null); setDrawer(null);
    const opened = store.snapshot(), navigation = catalog.snapshot().navigation;
    const destination = opened.conversations.find(conversation => conversation.id === id);
    if (opened.phase !== "ready" || opened.config !== current.config || opened.selected !== id || !destination
      || notificationContextKey(destination) !== notificationContextKey(target)
      || navigation.view !== "chat" || navigation.conversationId !== id
      || navigation.workspaceId !== (target.workspaceId ?? null) || navigation.worktreeId !== (target.worktreeId ?? null)) return false;
    if (capture) notificationStore.acknowledgeCaptured(capture);
    return true;
  };
  const openArtifact = (selection: ArtifactSelection) => { setReviewRequest(null); setArtifact(selection); catalog.navigate({ view: "code" }); setDrawer(null); };
  const startDocumentReview = (launch: DocumentReviewLaunch) => {
    const current = store.snapshot();
    const target = current.conversations.find(conversation => conversation.id === launch.sessionId);
    if (current.sending || !target || target.replacedBy || target.workspaceId !== launch.workspaceId) return;
    setReviewRequest({ ...launch, requestId: ++reviewSerial.current });
    setArtifact(null); setDrawer(null);
    store.openConversation(launch.sessionId);
  };
  const navigation = <ContextualNavigation state={state} activeView={view} onNavigate={navigate} />;
  const workspaceSelection = {
    ...sidebarModel.workspaceSelection,
    goWorkspace: (id: string) => {
      if (!sidebarModel.workspaceSelection.goWorkspace(id)) return false;
      nativeSubagents.back(); setReviewRequest(null); setArtifact(null);
      return true;
    },
  };
  const group = viewGroup(view);
  const sidebar = group === "chat" ? <ConversationSidebar
    state={state} model={sidebarModel} mode={mode} selectedId={mode === "history" ? historyPreview : state.selected}
    onChoose={choose} onPreview={id => { setHistoryPreview(id); setDrawer(null); }}
    onHistory={() => navigate(view === "history" ? "chat" : "history")}
  /> : group === "files" ? <><FilesModeControl activeView={view} onNavigate={navigate} /><WorkspaceSidebar /></>
    : group === "browser" ? <BrowserSidebar onSelect={() => setDrawer(null)} />
    : <ConfigMenu onSelect={() => { setArtifact(null); setDrawer(null); }} />;
  const browserWorkspaceId = repository.ready && repository.workspaces.some(item => item.workspaceId === workspaceId) ? workspaceId : null;
  return <NativeSubagentContext.Provider value={nativeSubagents}><ApplicationCommandProvider><WorkspaceProvider view={view} navigate={navigate}><ChatFileNavigationProvider navigate={navigate}><WorkspaceQuickOpenFeature><WorkspaceSearchFeature><WorkspaceFileShortcuts><TerminalProvider view={view}><BrowserProvider workspaceId={browserWorkspaceId}>
    <PushNavigation state={state} inbox={inbox} hydrationReady={hydrationReady} openNotification={openNotification} />
    <ViewNavigationCommands onNavigate={navigate} />
    <SidebarToggleCommand onToggle={toggleSidebar} />
    <WorkspaceShell view={view} sidebar={sidebar}
      onOpenNotification={openNotification}
      workspaceSelection={workspaceSelection}
      retryCatalog={hydrateCatalog} sidebarOpen={drawer === "sidebar"}
      sidebarHidden={sidebarHidden} toggleSidebar={toggleSidebar}
      openSidebar={() => setDrawer("sidebar")} closeSidebar={() => setDrawer(null)}
      header={<ShellHeader state={state} view={view} artifact={artifact} overview={sidebarModel.overview} overviewWorkspaceId={workspaceId} openDetails={() => setDrawer("details")} openContext={() => setDrawer("context")} openApplication={() => setDrawer("application")} />}
      notices={<ShellNotices state={state} view={view} openDetails={() => setDrawer("details")} />}
    >
      <ShellContent state={state} view={view} workspaceId={workspaceId} artifact={artifact} closeArtifact={() => setArtifact(null)} openArtifact={openArtifact}
        historyPreview={historyPreview} choose={choose} signOut={signOut} navigation={navigation} startDocumentReview={startDocumentReview} reviewRequest={reviewRequest} reviewRequestHandled={reviewRequestHandled} />
    </WorkspaceShell>
    {drawer === "application" && <ApplicationDialog state={state} signOut={signOut} close={() => setDrawer(null)} />}
    {drawer === "details" && !nativeSubagents.active && <ConversationDetails state={state} close={() => setDrawer(null)} />}
    {drawer === "context" && view === "chat" && !nativeSubagents.active && !state.compactDialog && <ContextDialog state={state} close={() => setDrawer(null)} />}
    {view === "chat" && !nativeSubagents.active && <CompactDialog state={state} />}
  </BrowserProvider></TerminalProvider></WorkspaceFileShortcuts></WorkspaceSearchFeature></WorkspaceQuickOpenFeature></ChatFileNavigationProvider></WorkspaceProvider></ApplicationCommandProvider></NativeSubagentContext.Provider>;
}

function ShellHeader({ state, view, artifact, overview, overviewWorkspaceId, openDetails, openContext, openApplication }: {
  state: State; view: ActiveView; artifact: ArtifactSelection | null; openDetails: () => void; openContext: () => void; openApplication: () => void;
  overview: WorkstreamOverview | null; overviewWorkspaceId: string | null;
}) {
  const conversation = state.conversations.find(item => item.id === state.selected);
  const nativeSubagents = useNativeSubagents();
  let heading: ReactNode;
   if (view === "chat" && nativeSubagents?.active) heading = <><div className="conversation-heading">Native subagent · {nativeSubagents.summary?.name ?? nativeSubagents.summary?.toolName}</div><span className="harness-badge">Read-only activity</span></>;
   else if (view === "chat") heading = <>
    <ConversationHeading conversation={conversation} selectedId={state.selected} overview={overview} overviewWorkspaceId={overviewWorkspaceId} />
    <span className="harness-badge">{harnessName(store.harness())}</span>
    <ContextControl state={state} open={openContext} />
    <button type="button" className="details-button" aria-label="Conversation details" onClick={openDetails}><Icon name="details" /><span>Details</span></button>
  </>;
  else if (view === "terminal") heading = <TerminalHeader />;
  else if (view === "browser") heading = <BrowserHeader />;
  else if (view === "history") heading = <div className="conversation-heading">History</div>;
  else if (viewGroup(view) === "settings") heading = <div className="conversation-heading">{view === "workstreams" ? "Settings · Workstreams" : "Settings"}</div>;
  else if (artifact && view === "code") heading = <div className="conversation-heading">Files · Read-only workstream artifact</div>;
  else heading = <WorkspaceHeader />;
  return <>{heading}{viewGroup(view) === "files" && <WorkspaceSearchButton />}<button type="button" className="icon-button application-opener" aria-label="Application menu" aria-haspopup="dialog" onClick={openApplication}><FiMoreHorizontal size={16} aria-hidden="true" /><span className={`connection-dot ${state.connected ? "online" : ""}`} /></button></>;
}

function ShellNotices({ state, view, openDetails }: { state: State; view: ActiveView; openDetails: () => void }) {
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const nativeSubagents = useNativeSubagents();
  const conversation = state.conversations.find(item => item.id === state.selected);
  const workspace = repository.workspaces.find(item => item.workspaceId === conversation?.workspaceId);
  const worktree = workspace?.worktrees.find(item => item.worktreeId === conversation?.worktreeId);
  const mismatch = conversation && (conversation.workspaceId !== repository.navigation.workspaceId || conversation.worktreeId !== repository.navigation.worktreeId);
  return <>
    {state.connectionError && (view !== "chat" || nativeSubagents?.active) && <div className="connection-notice" role="status">{state.connectionError}<button type="button" onClick={store.reconnect}>Reconnect</button></div>}
    {mismatch && view !== "terminal" && view !== "browser" && !(view === "chat" && nativeSubagents?.active) && <div className="execution-context" role="status">
      <span title={worktree ? `${worktreeLabel(worktree)} · ${worktree.root}` : conversation.cwd}>Runs in: {worktree ? worktreeDisplay(worktree) : conversation.cwd || "Unavailable worktree"}</span>
      {conversation.workspaceId && conversation.worktreeId ? <button type="button" disabled={state.sending} onClick={() => catalog.navigate({ workspaceId: conversation.workspaceId, worktreeId: conversation.worktreeId, filePath: null, comparison: null })}>Browse execution worktree</button> : <button type="button" onClick={openDetails}>Execution details</button>}
    </div>}
  </>;
}

/** Hidden chat stays mounted: switching views must not destroy native input state. */
function ShellContent({ state, view, workspaceId, artifact, closeArtifact, openArtifact, historyPreview, choose, signOut, navigation, startDocumentReview, reviewRequest, reviewRequestHandled }: {
  state: State; view: ActiveView; workspaceId: string | null; artifact: ArtifactSelection | null;
  closeArtifact: () => void; openArtifact: (selection: ArtifactSelection) => void;
  historyPreview: string | null; choose: (id: string) => void; signOut: () => void; navigation: ReactNode;
  startDocumentReview: (launch: DocumentReviewLaunch) => void; reviewRequest: DocumentReviewRequest | null; reviewRequestHandled: (requestId: number) => void;
}) {
  const nativeSubagents = useNativeSubagents();
  const child = nativeSubagents?.active;
  return <>
    <div className="chat-surface" hidden={view !== "chat" || !!child} inert={view !== "chat" || !!child}><Thread state={state} active={view === "chat" && !child} navigation={navigation} reviewRequest={reviewRequest} reviewRequestHandled={reviewRequestHandled} /></div>
    {view === "chat" && child && <div className="chat-surface"><NativeSubagentView key={nativeSubagentVirtualKey(child.summary)} /></div>}
    {view !== "chat" && view !== "terminal" && view !== "browser" && <div className="shell-content">
      {view === "history" && <HistoryDetail state={state} previewId={historyPreview} onOpen={choose} />}
      {viewGroup(view) === "settings" && <ConfigView state={state} signOut={signOut} workspaceId={workspaceId} openArtifact={openArtifact} openConversation={choose} startDocumentReview={startDocumentReview} />}
      {view === "code" && artifact && artifact.workspaceId === workspaceId ? <WorkstreamArtifact artifact={artifact} close={closeArtifact} /> : (view === "code" || view === "git") && <WorkspaceView />}
    </div>}
    {view === "terminal" && <TerminalView navigation={navigation} />}
    <BrowserView key={workspaceId ?? "no-workspace"} active={view === "browser"} />
    {view === "browser" ? <BrowserFooter navigation={navigation} /> : view !== "chat" && view !== "terminal" && <footer className="shell-content-footer">{navigation}</footer>}
  </>;
}

function ApplicationDialog({ state, signOut, close }: { state: State; signOut: () => void; close: () => void }) {
  return <ShellDialog title="Application" close={close}>
    <div className="application-status"><span className={`connection-dot ${state.connected ? "online" : ""}`} /><span>{state.connected ? "Local bridge connected" : "Connecting to bridge"}</span></div>
    <details className="application-connection"><summary>Connection details</summary><p className="muted">{state.connectionError || (state.connected ? "Connected to the local bridge." : "Waiting for the local bridge.")}</p><button type="button" className="text-button" onClick={store.reconnect}>Reconnect</button></details>
    <InstallApp />
    <DeviceNotifications />
    {state.config?.authRequired && <button type="button" className="application-signout" disabled={state.sending} onClick={signOut}>Sign out</button>}
  </ShellDialog>;
}

function ConversationDetails({ state, close }: { state: State; close: () => void }) {
  const conversation = state.conversations.find(item => item.id === state.selected);
  const latestUsage = [...state.runs].reverse().find(run => run.operation !== "compact" && run.usage)?.usage;
  const nativeUsageRun = [...state.runs].reverse().find(run => run.operation !== "compact" && run.nativeUsage);
  return <Drawer title="Conversation details" close={close}>
    <section className="detail-section"><p className="eyebrow">EXECUTION WORKTREE</p>
      {!state.selected ? <label className="directory-label">Launch directory<input value={store.draft().cwd} placeholder="Selected worktree root or a subdirectory" onChange={event => store.setDraft({ cwd: event.target.value })} /><small>Defaults to the selected worktree root. Optionally choose a directory inside that worktree.</small></label> : <Facts values={[["Conversation ID", state.selected], ["Harness", harnessName(store.harness())], ["Agent", store.conversationProfileLabel(state.selected)], ["Native session ID", conversation?.nativeSessionId], ["Launch directory", conversation?.cwd], ["Workspace", conversation?.workspaceId || "Unavailable"], ["Worktree", conversation?.worktreeId || "Unavailable"]]} />}
      <p className="muted">Each follow-up uses this conversation’s fixed execution directory and harness. Browsing another worktree does not retarget it.</p>
      {conversation?.association !== "resolved" && state.selected && <p className="notice" role="status">Execution workspace unavailable. Recorded history remains accessible.</p>}
    </section>
    {state.transcriptPaged ? <section className="detail-section"><h3>Current context snapshot</h3>{state.transcript?.summary.usage ? <Facts values={[["Input context tokens", state.transcript.summary.usage.tokens.toLocaleString()], ["Reported model", state.transcript.summary.usage.model], ["Model window capacity", state.contextUsage?.capacity.toLocaleString() ?? "Unavailable"], ["Reported at", new Date(state.transcript.summary.usage.time).toLocaleString()], ["Snapshot", state.transcript.summary.usage.stale ? "Stale while compacting" : "Last reported"]]} /> : <p className="muted">Unavailable</p>}</section> : <section className="detail-section"><h3>Latest reported usage</h3>{store.harness() === "opencode" ? <>{nativeUsageRun && nativeUsageRun.id !== state.runs.at(-1)?.id && <p className="muted">Showing an earlier run’s snapshot; the latest run has no reported usage yet.</p>}<NativeUsage run={nativeUsageRun} /></> : <>{latestUsage && latestUsage.runId !== state.runs.at(-1)?.id && <p className="muted">A newer run has no result snapshot yet. Showing an earlier run.</p>}<Usage snapshot={latestUsage} /></>}</section>}
    <NativeHistoryDetails state={state} />
    <section className="detail-section"><h3>{state.transcriptPaged ? "Run summaries" : "Runs & diagnostics"} <span className="muted">{state.runs.length}</span></h3>{state.runs.length ? [...state.runs].reverse().map(run => <RunDetails key={run.id} run={run} loadedMessages={state.messages} />) : <p className="muted">{state.transcriptPaged ? "No recorded runs." : "Run IDs and raw events will appear here."}</p>}{state.transcriptPaged && <LoadedTranscriptDiagnostics messages={state.messages} runs={state.runs} />}</section>
  </Drawer>;
}
