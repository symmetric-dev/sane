import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FiMoreHorizontal, FiX } from "react-icons/fi";
import { LuUnlink } from "react-icons/lu";
import { PenroseTriangle } from "./penrose-triangle";
import { store, useShellState, type State } from "./store";
import { catalog } from "./catalog";
import { worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { WorkspaceHeader, WorkspaceProvider, WorkspaceSidebar, WorkspaceView, workspaceHasDirtyBuffers, resetWorkspaceState } from "./workspace";
import type { ActiveView } from "./workspace-controller";
import { TerminalHeader, TerminalProvider, TerminalView } from "./terminal";
import { WorkspaceShell } from "./workspace-shell";
import { ChatFlowLayoutProvider } from "./chat-flow-layout";
import { ShellDialog } from "./shell-dialog";
import type { ArtifactSelection } from "./workstreams";
import { WorkstreamArtifact } from "./workstream-artifact";
import { HistoryDetail } from "./history-view";
import { ConfigMenu, ConfigView } from "./config-view";
import { ConversationSidebar, useConversationSidebarModel } from "./conversation-sidebar";
import { conversationSidebarGroups } from "./conversation-sidebar-buckets";
import { compareConversationActivity } from "./conversation-activity";
import { ChatWorktreeShortcuts } from "./chat-worktree-shortcuts";
import { NewConversationShortcut } from "./new-conversation-shortcut";
import { ConversationHeading } from "./conversation-heading";
import type { WorkstreamOverview } from "../src/workstreams-contract";
import { Facts, LoadedTranscriptDiagnostics, NativeHistoryDetails, NativeUsage, RunDetails, Thread, Usage } from "./thread";
import { ContextualNavigation, Drawer, FilesModeControl, Icon, SidebarToggleCommand, ViewNavigationCommands, viewGroup } from "./nav";
import { harnessName } from "./types";
import { ApplicationCommandProvider } from "./application-commands";
import { WorkspaceSearchFeature } from "./workspace-search";
import { NotebookToolbarProvider } from "./notebook-preview";
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
import { BrowserHeader, BrowserProvider, BrowserSidebar, BrowserView } from "./browser-view";
import { PreviewPairSidebar } from "./preview-pair-layout";
import { usePreviewViewState } from "./preview-view-state";
import { workspaceRememberedSelection } from "./workspace-store";
import { BROWSER_PAIR_COMPACT_MEDIA, canPairBrowserConversation, captureBrowserPairIntent, useBrowserPair, useBrowserPairCompact, type BrowserPairIntent } from "./browser-pair";
import { useBrowserPairMenu } from "./browser-pair-menu";
import type { BrowserPairMode } from "../shared/browser-pair-contract";
import { BrowserPairDialog } from "./browser-pair-dialog";
import { SystemPromptDetails } from "./system-prompt";
import { SaneContextDetails } from "./sane-context";
import { wakePolls } from "./poll-wake";

// Manual recovery shares the config-scoped restore owner with automatic retries.
const hydrateCatalog = () => catalog.retryHydration();

export function App() {
  const state = useShellState();
  const inbox = usePushInbox();
  const [hydratedConfig, setHydratedConfig] = useState<State["config"]>();
  useEffect(() => chromePush.start(), []);
  useEffect(() => {
    store.start();
    // Focus/BFCache restoration may not produce a visibility transition on
    // mobile. Coalesce ready reads and re-arm startup if hiding interrupted it.
    const refreshVisible = () => {
      if (document.hidden) return;
      // Hidden teardown removes the chat's wake subscription. Request a read
      // directly as well, so focus-only restoration can re-arm that scheduler.
      store.reconnect();
      wakePolls();
    };
    window.addEventListener("online", store.reconnect);
    window.addEventListener("focus", refreshVisible);
    window.addEventListener("pageshow", refreshVisible);
    document.addEventListener("visibilitychange", store.reconnect);
    return () => {
      window.removeEventListener("online", store.reconnect);
      window.removeEventListener("focus", refreshVisible);
      window.removeEventListener("pageshow", refreshVisible);
      document.removeEventListener("visibilitychange", store.reconnect);
    };
  }, []);
  useEffect(() => {
    if (state.phase !== "ready") { setHydratedConfig(undefined); return; }
    const config = state.config;
    let active = true;
    const current = () => active && store.snapshot().phase === "ready" && store.snapshot().config === config;
    // Restore selection without replacing the independently bookmarked browsing pair.
    const stop = catalog.startHydration(bookmark => {
      if (current()) store.choose(bookmark.conversationId ?? "");
    }, current, () => { if (current()) setHydratedConfig(config); });
    return () => { active = false; stop(); };
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
  const pair = useBrowserPair(state, repository, hydrationReady);
  const [pairDialog, setPairDialog] = useState<{ intent: BrowserPairIntent; name: string; mode: BrowserPairMode } | null>(null);
  const paired = pair.active;
  const compactPair = useBrowserPairCompact();
  const { pane: pairPane, setPane: setPairPane, sidebarHidden, setSidebarHidden } = usePreviewViewState(state, repository);
  const [desktopTranscript, setDesktopTranscript] = useState<HTMLDivElement | null>(null);
  const [inlineTranscript, setInlineTranscript] = useState<HTMLDivElement | null>(null);
  const restoreResourceFocus = useRef(false);
  const navigationFocus = useRef<HTMLElement | null>(null);
  const presentationIntent = useRef(0);
  const requestedRevealIntent = useRef<number | null>(null);
  const nativeParent = state.conversations.find(conversation => conversation.id === state.selected);
  const nativeParentSessionId = nativeParent?.id ?? "";
  const nativeSubagents = useNativeSubagentFeature(nativeParentSessionId, !!nativeParentSessionId && !!nativeParent, view === "chat" || paired, JSON.stringify([nativeParentSessionId, nativeParent?.nativeSessionId, nativeParent?.harness]));
  const [drawer, setDrawer] = useState<"sidebar" | "details" | "context" | "application" | null>(null);
  const toggleSidebar = useCallback(() => {
    presentationIntent.current++;
    if (window.matchMedia(paired ? BROWSER_PAIR_COMPACT_MEDIA : "(max-width:700px)").matches) {
      if (paired) setPairPane("preview");
      setDrawer(current => current === "sidebar" ? null : "sidebar");
    }
    else {
      // Do not leave keyboard focus in a sidebar that is about to become inert.
      if (document.activeElement?.closest(".sidebar")) document.querySelector<HTMLButtonElement>(".sidebar-toggle")?.focus();
      setSidebarHidden(current => !current);
    }
  }, [paired, setPairPane, setSidebarHidden]);
  const [artifact, setArtifact] = useState<ArtifactSelection | null>(null);
  const artifactReturn = useRef<{ workspaceId: string | null; worktreeId: string | null; filePath: string | null } | null>(null);
  const [historyPreview, setHistoryPreview] = useState<string | null>(null);
  const [reviewRequest, setReviewRequest] = useState<DocumentReviewRequest | null>(null);
  const reviewSerial = useRef(0);
  const choiceSerial = useRef(0);
  const [navigationError, setNavigationError] = useState("");
  useEffect(() => {
    if (!paired) return;
    nativeSubagents.back();
  }, [paired]);
  const handledRestore = useRef(0);
  useEffect(() => {
    const activation = pair.restoreActivation;
    if (!paired || !activation || handledRestore.current === activation.serial) return;
    handledRestore.current = activation.serial;
    if (activation.revealHistory && requestedRevealIntent.current === presentationIntent.current) { setPairPane("conversation"); setSidebarHidden(false); }
  }, [paired, pair.restoreActivation, setPairPane, setSidebarHidden]);
  const reviewRequestHandled = useCallback((requestId: number) => setReviewRequest(current => current?.requestId === requestId ? null : current), []);
  const mode = view === "history" ? "history" : "chat";
  // The desktop sidebar and mobile drawer share one filter/search state owner.
  const sidebarModel = useConversationSidebarModel(state, mode, mode === "history" ? historyPreview ?? state.selected : state.selected);
  const selectorIsOpen = sidebarModel.workspaceSelection.isOpen;
  useEffect(() => {
    const previous = artifactReturn.current;
    if (!previous || previous.workspaceId !== workspaceId || previous.worktreeId !== worktreeId || repository.navigation.filePath !== null) setArtifact(null);
  }, [workspaceId, worktreeId, repository.navigation.filePath]);
  useEffect(() => { setHistoryPreview(null); }, [workspaceId, worktreeId]);
  useEffect(() => {
    if (view !== "history") return;
    if (historyPreview && state.conversations.some(conversation => conversation.id === historyPreview)) return;
    // Per-worktree page unions have no global ordering. Use only eligible,
    // already-loaded sidebar rows and the same normalized bucket identities.
    const scoped = conversationSidebarGroups(sidebarModel, "history", historyPreview)
      .flatMap(group => group.buckets)
      .filter(bucket => bucket.workspaceId === workspaceId && bucket.worktreeId === worktreeId)
      .flatMap(bucket => bucket.pinned ? [...bucket.conversations, bucket.pinned] : bucket.conversations).sort(compareConversationActivity);
    setHistoryPreview(scoped.find(conversation => conversation.id === state.selected)?.id ?? scoped[0]?.id ?? null);
  }, [view, workspaceId, worktreeId, state.selected, state.conversations, sidebarModel.visible, sidebarModel.filter, sidebarModel.groups, repository.workspaces, historyPreview]);
  useEffect(() => { if (!selectorIsOpen()) setDrawer(null); }, [state.selected, selectorIsOpen]);
  useEffect(() => {
    if ((view !== "chat" && !paired) || nativeSubagents.active || state.compactDialog) setDrawer(current => current === "context" ? null : current);
  }, [view, paired, nativeSubagents.active, state.compactDialog]);
  useEffect(() => {
    if (!reviewRequest) return;
    // Read the settled stores: starting a review also selects its chat in this turn.
    const current = store.snapshot();
    const target = current.conversations.find(conversation => conversation.id === reviewRequest.sessionId);
    const currentView = catalog.snapshot().navigation.view;
    if ((currentView !== "chat" && !paired) || current.selected !== reviewRequest.sessionId || !target || target.replacedBy || target.workspaceId !== reviewRequest.workspaceId) reviewRequestHandled(reviewRequest.requestId);
  }, [reviewRequest, view, paired, state.selected, state.conversations, reviewRequestHandled]);
  const navigate = (next: ActiveView, options: { restorePair?: boolean } = {}) => {
    choiceSerial.current++;
    const previousView = catalog.snapshot().navigation.view;
    if (previousView !== next) navigationFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // File/tree/search navigation must never select a saved conversation. The
    // resource controller invalidates a changed file; same-file navigation can
    // keep its explicit pin. Saved links are selected explicitly in the menu.
    if (next === "browser" || next === "code") pair.cancelRestore();
    else pair.clear();
    setNavigationError(""); if (next !== "chat" && !((next === "browser" || next === "code") && paired)) setReviewRequest(null);
    const navigation = catalog.snapshot().navigation;
    const tree = catalog.snapshot().workspaces.find(workspace => workspace.workspaceId === navigation.workspaceId)?.worktrees.find(tree => tree.worktreeId === navigation.worktreeId);
    const remembered = previousView !== next && (next === "code" || next === "git") && navigation.filePath === null && navigation.workspaceId && tree?.state === "available"
      ? workspaceRememberedSelection(navigation.workspaceId, tree.worktreeId, tree.bindingRevision, tree.root) : null;
    setArtifact(null); catalog.navigate({ view: next, ...(remembered?.path ? { filePath: remembered.path, comparison: remembered.comparison } : {}) }); setDrawer(null);
    if (options.restorePair && previousView !== next && (next === "browser" || next === "code")) {
      requestedRevealIntent.current = presentationIntent.current;
      pair.requestRestore({ sessionId: store.snapshot().selected, revealHistory: previousView === "chat" });
    }
  };
  const openChat = () => { pair.clear(); setNavigationError(""); setArtifact(null); setDrawer(null); catalog.navigate({ view: "chat", conversationId: store.snapshot().selected || null }); };
  const unpair = () => { setNavigationError(""); void pair.unlink().catch(error => setNavigationError(error instanceof Error ? error.message : "Could not remove the resource link. Check stored links before trying again.")); };
  const exitPair = () => {
    presentationIntent.current++;
    restoreResourceFocus.current = true;
    pair.clear(); setDrawer(null); setPairPane("preview");
  };
  useLayoutEffect(() => {
    if (!restoreResourceFocus.current || paired) return;
    restoreResourceFocus.current = false;
    const target = [...document.querySelectorAll<HTMLButtonElement>('.browser-sidebar [role="tab"][aria-selected="true"], .workspace-tree-row[aria-selected="true"], .sidebar-toggle')]
      .find(button => !button.disabled && !button.closest("[hidden], [inert]") && button.getClientRects().length > 0);
    target?.focus({ preventScroll: true });
  }, [paired, pairPane, sidebarHidden, view]);
  useLayoutEffect(() => {
    const previous = navigationFocus.current, focused = document.activeElement;
    navigationFocus.current = null;
    const hiddenFocus = focused instanceof HTMLElement && !!focused.closest("[hidden], [inert]");
    const lostFocus = previous && (focused === previous || focused === document.body) && (!previous.isConnected || !!previous.closest("[hidden], [inert]"));
    if (hiddenFocus || lostFocus) document.querySelector<HTMLButtonElement>(".sidebar-toggle")?.focus({ preventScroll: true });
  }, [view, sidebarHidden, paired, pairPane]);
  const startPair = (id = store.snapshot().selected, mode: BrowserPairMode = "replace") => {
    const current = store.snapshot(), repository = catalog.snapshot();
    if (!canPairBrowserConversation(current, repository, id)) return;
    pair.cancelRestore();
    const intent = captureBrowserPairIntent(current, repository, id);
    const conversation = current.conversations.find(item => item.id === id);
    if (intent && conversation) setPairDialog({ intent, name: conversation.title || `Conversation · ${id.slice(0, 8)}`, mode });
  };
  const confirmPair = (id: string, intent: BrowserPairIntent) => {
    if (!pair.pair(id, intent)) return false;
    presentationIntent.current++;
    nativeSubagents.back(); setNavigationError(""); setArtifact(null); setDrawer(null);
    setSidebarHidden(false); setPairPane("conversation");
    return true;
  };
  const pairMenu = useBrowserPairMenu({ state, model: sidebarModel, pairedSessionId: pair.sessionId,
    interact: pair.cancelRestore, openSession: confirmPair, addSession: id => startPair(id, "add"),
    removed: id => { if (pair.active && (id === null || id === pair.sessionId)) exitPair(); },
  });
  // Native child activity belongs to full Chat, not the paired composer footer.
  const nativeSubagentNavigation = { ...nativeSubagents, open: (...args: Parameters<typeof nativeSubagents.open>) => { if (paired) openChat(); nativeSubagents.open(...args); } };
  const choose = (id: string) => {
    const current = store.snapshot(), navigation = catalog.snapshot().navigation;
    if (current.sending || current.phase !== "ready") return;
    const serial = ++choiceSerial.current;
    setNavigationError("");
    if (id !== reviewRequest?.sessionId) setReviewRequest(null);
    if (id && !current.conversations.some(conversation => conversation.id === id)) {
      const ownsChoice = () => serial === choiceSerial.current && store.snapshot().phase === "ready"
        && store.snapshot().config === current.config && !store.snapshot().sending
        && store.snapshot().selected === current.selected && store.snapshot().drafts === current.drafts
        && catalog.snapshot().navigation === navigation;
      void store.ensureConversations([id], AbortSignal.timeout(25000)).then(() => {
        if (!ownsChoice()) return;
        if (store.openConversation(id)) setDrawer(null);
        else setNavigationError("This conversation is no longer in the active catalog. Archived history is preserved.");
      }).catch(() => {
        if (ownsChoice()) setNavigationError("Could not load this conversation. Select it again to retry.");
      });
      return;
    }
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
  const openArtifact = (selection: ArtifactSelection) => {
    pair.clear(); setReviewRequest(null);
    const { workspaceId, worktreeId, filePath } = catalog.snapshot().navigation;
    artifactReturn.current = { workspaceId, worktreeId, filePath };
    setArtifact(selection); catalog.navigate({ view: "code", filePath: null, comparison: null }); setDrawer(null);
  };
  const closeArtifact = () => {
    setArtifact(null);
    const previous = artifactReturn.current, navigation = catalog.snapshot().navigation;
    if (previous && previous.workspaceId === navigation.workspaceId && previous.worktreeId === navigation.worktreeId) catalog.navigate({ filePath: previous.filePath });
    artifactReturn.current = null;
  };
  const startDocumentReview = (launch: DocumentReviewLaunch) => {
    const current = store.snapshot();
    const target = current.conversations.find(conversation => conversation.id === launch.sessionId);
    if (current.sending || !target || target.replacedBy || target.workspaceId !== launch.workspaceId) return;
    setReviewRequest({ ...launch, requestId: ++reviewSerial.current });
    setArtifact(null); setDrawer(null);
    store.openConversation(launch.sessionId);
  };
  const navigateView = (next: ActiveView) => navigate(next, { restorePair: true });
  const navigation = <ContextualNavigation state={state} activeView={view} onNavigate={navigateView} />;
  const workspaceSelection = {
    ...sidebarModel.workspaceSelection,
    goWorkspace: (id: string) => {
      if (!sidebarModel.workspaceSelection.goWorkspace(id)) return false;
      nativeSubagents.back(); setReviewRequest(null); setArtifact(null);
      return true;
    },
  };
  const group = viewGroup(view);
  const conversationSidebar = <ConversationSidebar
    state={state} model={sidebarModel} mode={mode} selectedId={mode === "history" ? historyPreview : state.selected}
    onChoose={choose} onPreview={id => { setHistoryPreview(id); setDrawer(null); }}
    onHistory={id => { navigate("history"); setHistoryPreview(id); }}
    onConnect={view === "chat" || view === "browser" || view === "code" ? startPair : undefined}
    canConnect={conversation => canPairBrowserConversation(state, repository, conversation.id)}
  />;
  const previewSidebar = view === "browser" || view === "code" && !artifact;
  const resourceLabel = view === "browser" ? "Tabs" : "Files";
  const resources = view === "browser" ? <BrowserSidebar onSelect={() => setDrawer(null)} />
    : <><FilesModeControl activeView={view} onNavigate={navigate} /><WorkspaceSidebar /></>;
  const changePairPane = (pane: "preview" | "conversation") => { presentationIntent.current++; setPairPane(pane); };
  const setSidebarPane = (pane: "preview" | "conversation") => { changePairPane(pane); if (compactPair && pane === "conversation") setDrawer(null); };
  const pairActions = <>{pairMenu.button}{paired && <button type="button" className="icon-button browser-pair-icon-button" aria-label="Exit paired view" title="Exit paired view (keep saved links)" onClick={exitPair}><FiX size={16} aria-hidden="true" /></button>}</>;
  const sidebar = previewSidebar ? <PreviewPairSidebar label={resourceLabel} paired={paired} pane={pairPane} setPane={setSidebarPane} resources={resources} actions={pairActions} />
    : group === "chat" ? conversationSidebar
    : group === "files" ? resources
    : <ConfigMenu onSelect={() => { setArtifact(null); setDrawer(null); }} />;
  const browserWorkspaceId = repository.ready && repository.workspaces.some(item => item.workspaceId === workspaceId) ? workspaceId : null;
  return <NativeSubagentContext.Provider value={nativeSubagentNavigation}><ApplicationCommandProvider><NotebookToolbarProvider><WorkspaceProvider view={view} navigate={navigate}><ChatFileNavigationProvider navigate={navigate} pairedSessionId={pair.sessionId}><WorkspaceQuickOpenFeature><WorkspaceSearchFeature><WorkspaceFileShortcuts><TerminalProvider view={view}><BrowserProvider workspaceId={browserWorkspaceId}>
    <PushNavigation state={state} inbox={inbox} hydrationReady={hydrationReady} openNotification={openNotification} />
    <ViewNavigationCommands onNavigate={navigateView} />
    <SidebarToggleCommand onToggle={toggleSidebar} />
    <NewConversationShortcut isSelectionOpen={selectorIsOpen} onNew={() => { pair.clear(); nativeSubagents.back(); setArtifact(null); choose(""); }} />
    {view === "chat" && <ChatWorktreeShortcuts model={sidebarModel} onChoose={id => { nativeSubagents.back(); choose(id); }} />}
    <ChatFlowLayoutProvider scope={view === "chat" && !nativeSubagents.active ? { sessionId: state.selected, nativeSessionId: nativeParent?.nativeSessionId, harness: nativeParent?.harness, workspaceId, worktreeId } : null}>
    <WorkspaceShell view={view} sidebar={sidebar} navigation={navigation} paired={paired} resourceSidebar={previewSidebar}
      desktopSidebar={previewSidebar ? <PreviewPairSidebar label={resourceLabel} paired={paired} pane={pairPane} setPane={setSidebarPane} resources={resources} actions={pairActions}
        history={<><BrowserPairToolbar state={state} pane={pairPane} setPane={changePairPane} unpair={unpair} unpairBusy={pair.unlinkBusy} exitPair={exitPair} linkedSessions={null} openContext={() => setDrawer("context")} /><div className="browser-pair-transcript" ref={setDesktopTranscript} /></>} /> : undefined}
      onOpenNotification={openNotification}
      workspaceSelection={workspaceSelection}
      retryCatalog={hydrateCatalog} sidebarOpen={drawer === "sidebar"}
      sidebarHidden={sidebarHidden} toggleSidebar={toggleSidebar}
      openSidebar={() => { presentationIntent.current++; if (compactPair) setPairPane("preview"); setDrawer("sidebar"); }} closeSidebar={() => { presentationIntent.current++; setDrawer(null); }}
      header={<ShellHeader state={state} view={view} artifact={artifact} notebookControls={!paired || !compactPair || pairPane === "preview"} overview={sidebarModel.overview} overviewWorkspaceId={workspaceId} openDetails={() => setDrawer("details")} openContext={() => setDrawer("context")} openApplication={() => setDrawer("application")} />}
      notices={<><ShellNotices state={state} view={view} openDetails={() => setDrawer("details")} />{pair.restoreError && <p className="notice error" role="alert">{pair.restoreError} <button type="button" onClick={pair.dismissRestoreError}>Dismiss</button></p>}{navigationError && <p className="notice error" role="alert">{navigationError} <button type="button" onClick={() => setNavigationError("")}>Dismiss</button></p>}</>}
    >
      <ShellContent state={state} view={view} workspaceId={workspaceId} artifact={artifact} closeArtifact={closeArtifact} openArtifact={openArtifact}
        paired={paired} compactPair={compactPair} pairPane={pairPane} setPairPane={changePairPane} openChat={openChat} unpair={unpair} unpairBusy={pair.unlinkBusy} exitPair={exitPair} linkedSessions={pairMenu.button}
        transcriptTarget={paired ? compactPair ? inlineTranscript : desktopTranscript : null} transcriptVisible={!paired || pairPane === "conversation" && (compactPair || !sidebarHidden)}
        inlineTranscriptRef={setInlineTranscript} openContext={() => setDrawer("context")}
        historyPreview={historyPreview} choose={choose} signOut={signOut} navigation={null} startDocumentReview={startDocumentReview} reviewRequest={reviewRequest} reviewRequestHandled={reviewRequestHandled} />
    </WorkspaceShell>
    </ChatFlowLayoutProvider>
    {pairMenu.overlays}
    {pairDialog && <BrowserPairDialog intent={pairDialog.intent} name={pairDialog.name} initialMode={pairDialog.mode} pair={confirmPair} close={() => setPairDialog(null)} />}
    {drawer === "application" && <ApplicationDialog state={state} signOut={signOut} close={() => setDrawer(null)} />}
    {drawer === "details" && !nativeSubagents.active && <ConversationDetails state={state} close={() => setDrawer(null)} />}
    {drawer === "context" && (view === "chat" || paired) && !nativeSubagents.active && !state.compactDialog && <ContextDialog state={state} close={() => setDrawer(null)} />}
    {(view === "chat" || paired) && !nativeSubagents.active && <CompactDialog state={state} />}
  </BrowserProvider></TerminalProvider></WorkspaceFileShortcuts></WorkspaceSearchFeature></WorkspaceQuickOpenFeature></ChatFileNavigationProvider></WorkspaceProvider></NotebookToolbarProvider></ApplicationCommandProvider></NativeSubagentContext.Provider>;
}

function ShellHeader({ state, view, artifact, notebookControls, overview, overviewWorkspaceId, openDetails, openContext, openApplication }: {
  state: State; view: ActiveView; artifact: ArtifactSelection | null; openDetails: () => void; openContext: () => void; openApplication: () => void;
  overview: WorkstreamOverview | null; overviewWorkspaceId: string | null;
  notebookControls: boolean;
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
   else heading = <WorkspaceHeader notebookControls={notebookControls} />;
  return <>{heading}{view !== "browser" && <button type="button" className="icon-button application-opener" aria-label="Application menu" aria-haspopup="dialog" onClick={openApplication}><FiMoreHorizontal size={16} aria-hidden="true" /><span className={`connection-dot ${state.connected ? "online" : ""}`} /></button>}</>;
}

function ShellNotices({ state, view, openDetails }: { state: State; view: ActiveView; openDetails: () => void }) {
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const nativeSubagents = useNativeSubagents();
  const conversation = state.conversations.find(item => item.id === state.selected);
  const workspace = repository.workspaces.find(item => item.workspaceId === conversation?.workspaceId);
  const worktree = workspace?.worktrees.find(item => item.worktreeId === conversation?.worktreeId);
  const mismatch = conversation && (conversation.workspaceId !== repository.navigation.workspaceId || conversation.worktreeId !== repository.navigation.worktreeId);
  return <>
    {!repository.ready && repository.error && <div className="connection-notice" role="status">Workspace navigation unavailable. {repository.error}<button type="button" onClick={hydrateCatalog}>Retry</button></div>}
    {state.connectionError && (view !== "chat" || nativeSubagents?.active) && <div className="connection-notice" role="status">{state.connectionError}<button type="button" onClick={store.reconnect}>Reconnect</button></div>}
    {mismatch && view !== "terminal" && view !== "browser" && !(view === "chat" && nativeSubagents?.active) && <div className="execution-context" role="status">
      <span title={worktree ? `${worktreeLabel(worktree)} · ${worktree.root}` : conversation.cwd}>Runs in: {worktree ? worktreeDisplay(worktree) : conversation.cwd || "Unavailable worktree"}</span>
      {conversation.workspaceId && conversation.worktreeId ? <button type="button" disabled={state.sending} onClick={() => catalog.navigate({ workspaceId: conversation.workspaceId, worktreeId: conversation.worktreeId, filePath: null, comparison: null })}>Browse execution worktree</button> : <button type="button" onClick={openDetails}>Execution details</button>}
    </div>}
  </>;
}

/** Hidden chat stays mounted: switching views must not destroy native input state. */
function ShellContent({ state, view, workspaceId, artifact, closeArtifact, openArtifact, historyPreview, choose, signOut, navigation, startDocumentReview, reviewRequest, reviewRequestHandled, paired, compactPair, pairPane, setPairPane, openChat, unpair, unpairBusy, exitPair, linkedSessions, transcriptTarget, transcriptVisible, inlineTranscriptRef, openContext }: {
  state: State; view: ActiveView; workspaceId: string | null; artifact: ArtifactSelection | null;
  closeArtifact: () => void; openArtifact: (selection: ArtifactSelection) => void;
  historyPreview: string | null; choose: (id: string) => void; signOut: () => void; navigation: ReactNode;
  startDocumentReview: (launch: DocumentReviewLaunch) => void; reviewRequest: DocumentReviewRequest | null; reviewRequestHandled: (requestId: number) => void;
  paired: boolean; compactPair: boolean; pairPane: "preview" | "conversation"; setPairPane: (pane: "preview" | "conversation") => void;
  openChat: () => void; unpair: () => void; unpairBusy: boolean; exitPair: () => void; transcriptTarget: HTMLElement | null; transcriptVisible: boolean;
  inlineTranscriptRef: (element: HTMLDivElement | null) => void; openContext: () => void;
  linkedSessions: ReactNode;
}) {
  const nativeSubagents = useNativeSubagents();
  const child = nativeSubagents?.active;
  const chatSurface = useRef<HTMLDivElement>(null);
  const filesVisible = (view === "code" || view === "git") && !artifact;
  const [retainedFiles, setRetainedFiles] = useState<{ visited: boolean; presentation: "code" | "git" }>({ visited: false, presentation: "code" });
  const filesPresentation = view === "git" ? "git" : view === "code" && !artifact ? "code" : retainedFiles.presentation;
  if (filesVisible && (!retainedFiles.visited || retainedFiles.presentation !== filesPresentation)) setRetainedFiles({ visited: true, presentation: filesPresentation });
  const filesHidden = !filesVisible || paired && compactPair && pairPane !== "preview";
  useLayoutEffect(() => {
    const surface = chatSurface.current;
    const main = surface?.parentElement;
    if (!paired || !surface || !main) return;
    // Only the compact transcript reserves overlay space. The preview remains
    // full-height beneath the existing, never-reparented composer.
    const measure = () => {
      const region = main.querySelector<HTMLElement>(".paired-preview-region:not([hidden]), .browser-pair-inline:not([hidden])");
      if (region) {
        const available = Math.max(0, main.getBoundingClientRect().bottom - region.getBoundingClientRect().top);
        main.style.setProperty("--browser-pair-content-height", `${available}px`);
      }
      main.style.setProperty("--browser-pair-composer-height", `${surface.getBoundingClientRect().height}px`);
    };
    const observer = new ResizeObserver(measure);
    // Header/toolbar wrapping also changes the space available to tall requests.
    for (const element of main.children) observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      main.style.removeProperty("--browser-pair-composer-height");
      main.style.removeProperty("--browser-pair-content-height");
    };
  }, [paired, compactPair, pairPane]);
  return <>
    {paired && compactPair && <BrowserPairToolbar state={state} pane={pairPane} setPane={setPairPane} unpair={unpair} unpairBusy={unpairBusy} exitPair={exitPair} linkedSessions={linkedSessions} openContext={openContext} />}
    {view === "chat" && child && <div className="chat-surface"><NativeSubagentView key={nativeSubagentVirtualKey(child.summary)} /></div>}
    {(view === "history" || viewGroup(view) === "settings" || view === "code" && !!artifact) && <div className="shell-content paired-preview-region" hidden={paired && compactPair && pairPane !== "preview"} inert={paired && compactPair && pairPane !== "preview"}>
      {view === "history" && <HistoryDetail state={state} previewId={historyPreview} onOpen={choose} />}
      {viewGroup(view) === "settings" && <ConfigView state={state} signOut={signOut} workspaceId={workspaceId} openArtifact={openArtifact} openConversation={choose} startDocumentReview={startDocumentReview} />}
      {view === "code" && artifact && artifact.workspaceId === workspaceId && <WorkstreamArtifact artifact={artifact} close={closeArtifact} />}
    </div>}
    <div className="shell-content paired-preview-region" hidden={filesHidden} inert={filesHidden}>
      {(retainedFiles.visited || filesVisible) && <WorkspaceView presentation={filesPresentation} />}
    </div>
    {view === "terminal" && <TerminalView navigation={navigation} />}
    <div className="paired-preview-region" hidden={view !== "browser" || (paired && compactPair && pairPane !== "preview")} inert={view !== "browser" || (paired && compactPair && pairPane !== "preview")}>
      <BrowserView key={workspaceId ?? "no-workspace"} active={view === "browser"} />
    </div>
    <div className="browser-pair-inline" ref={inlineTranscriptRef} hidden={!paired || !compactPair || pairPane !== "conversation"} inert={!paired || !compactPair || pairPane !== "conversation"} />
    {/* Keep the mounted owners in a fixed DOM order that also matches keyboard navigation. */}
    <div className="chat-surface" ref={chatSurface} hidden={(view !== "chat" && !paired) || !!child} inert={(view !== "chat" && !paired) || !!child}><Thread state={state} active={(view === "chat" || paired) && !child} paired={paired} transcriptTarget={transcriptTarget} transcriptVisible={transcriptVisible} onOpenChatFlow={openChat} navigation={navigation} reviewRequest={reviewRequest} reviewRequestHandled={reviewRequestHandled} /></div>
  </>;
}

function BrowserPairToolbar({ state, pane, setPane, unpair, unpairBusy, exitPair, linkedSessions, openContext }: {
  state: State; pane: "preview" | "conversation"; setPane: (pane: "preview" | "conversation") => void;
  unpair: () => void; unpairBusy: boolean; exitPair: () => void; openContext: () => void;
  linkedSessions: ReactNode;
}) {
  const conversation = state.conversations.find(item => item.id === state.selected);
  return <section className="browser-pair-toolbar" aria-label="Paired conversation controls">
    <div className="browser-pair-title-row">
      <div className="browser-pair-heading"><strong title={conversation?.title || conversation?.id}>{conversation?.title || `Conversation · ${conversation?.id.slice(0, 8)}`}</strong></div>
      <button type="button" className="icon-button browser-pair-icon-button" aria-label="Exit paired view" title="Exit paired view (keep saved links)" onClick={exitPair}><FiX size={16} aria-hidden="true" /></button>
    </div>
    <div className="browser-pair-actions">
      <button type="button" className="icon-button browser-pair-icon-button" aria-label="Unpair" title="Remove this conversation’s link to this resource" disabled={unpairBusy} onClick={unpair}><LuUnlink size={16} aria-hidden="true" /></button>
      {linkedSessions}
      <ContextControl state={state} open={openContext} />
    </div>
    <div className="browser-pair-pane-toggle" role="group" aria-label="Paired view">
      <button type="button" aria-pressed={pane === "preview"} onClick={() => setPane("preview")}>Preview</button>
      <button type="button" aria-pressed={pane === "conversation"} onClick={() => setPane("conversation")}>Agent history</button>
    </div>
  </section>;
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
    {state.selected && state.phase === "ready" && state.config?.authenticated && <SaneContextDetails key={JSON.stringify([state.config.storeId, state.selected, conversation?.harness, conversation?.authorityId, conversation?.nativeSessionId, conversation?.cwd])} config={state.config} sessionId={state.selected} />}
    {state.selected && state.phase === "ready" && state.config?.authenticated && <SystemPromptDetails key={JSON.stringify([state.config.storeId, state.selected])} config={state.config} sessionId={state.selected} runs={state.runs} />}
    <NativeHistoryDetails state={state} />
    <section className="detail-section"><h3>{state.transcriptPaged ? "Run summaries" : "Runs & diagnostics"} <span className="muted">{state.runs.length}</span></h3>{state.runs.length ? [...state.runs].reverse().map(run => <RunDetails key={run.id} run={run} loadedMessages={state.messages} />) : <p className="muted">{state.transcriptPaged ? "No recorded runs." : "Run IDs and raw events will appear here."}</p>}{state.transcriptPaged && <LoadedTranscriptDiagnostics messages={state.messages} runs={state.runs} />}</section>
  </Drawer>;
}
