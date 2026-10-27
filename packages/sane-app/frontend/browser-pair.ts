import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import type { Conversation } from "./types";
import { workspaceEpoch } from "./workspace-store";
import { workerReference } from "./worker-client";
import { browserTabs } from "./browser-tabs";
import { readBrowserPairs, readLinkedPairs, writeBrowserPairs } from "./browser-pair-client";
import { isPairSession, pairTargetKey, samePairSession, samePairTarget, type PairSession, type PairSnapshot, type PairTarget } from "../shared/resource-pair-contract";
import { pairWorktreeIdentity, previewPairTarget, previewPairTargetAvailable, previewPairTargetLabel } from "./preview-pair-target";

// Pairing follows the shell's ordinary compact breakpoint and sidebar geometry.
export const BROWSER_PAIR_COMPACT_MEDIA = "(max-width:700px)";

type Repository = ReturnType<typeof catalog.snapshot>;
export type BrowserPairIntent = {
  sessionId: string;
  session: PairSession;
  target: PairTarget;
  config: State["config"];
  auth: number;
  identity: string;
  browsing: string;
  execution: string;
};

const identity = (conversation: Conversation) => JSON.stringify([
  conversation.id, conversation.harness, conversation.authorityId, conversation.nativeSessionId, conversation.cwd,
  conversation.updateSource?.harness, conversation.updateSource?.authorityId, conversation.updateSource?.nativeSessionId, conversation.updateSource?.incarnation,
]);
function capturePairContext(state: State, repository: Repository, sessionId: string): Omit<BrowserPairIntent, "target"> | null {
  const conversation = state.conversations.find(item => item.id === sessionId);
  if (state.phase !== "ready" || !state.config?.authenticated || typeof state.config.storeId !== "string" || !state.conversationsReady || !conversation || conversation.replacedBy
    || conversation.worker || workerReference(sessionId) || conversation.agentKind === "worker" || conversation.attachment?.state === "pending"
    || conversation.association !== "resolved") return null;
  const browsing = pairWorktreeIdentity(repository, repository.navigation.workspaceId, repository.navigation.worktreeId);
  const execution = pairWorktreeIdentity(repository, conversation.workspaceId, conversation.worktreeId);
  const session = { sessionId: conversation.id, harness: conversation.harness, authorityId: conversation.authorityId, nativeSessionId: conversation.nativeSessionId };
  if (!browsing || !execution || !isPairSession(session)) return null;
  return { sessionId: conversation.id, session, config: state.config, auth: workspaceEpoch(), identity: identity(conversation), browsing, execution };
}
export function captureBrowserPairIntent(state: State, repository: Repository, sessionId: string, requested?: PairTarget | string): BrowserPairIntent | null {
  const context = capturePairContext(state, repository, sessionId);
  if (!context) return null;
  const workspaceId = repository.navigation.workspaceId;
  const tabs = browserTabs.snapshot(workspaceId);
  let target = previewPairTarget(repository, tabs, true);
  // Restore may inspect another existing browser tab, but never another file.
  if (requested && target?.kind === "browser") {
    const candidate = typeof requested === "string" ? { ...target, tabId: requested } : requested;
    if (candidate.kind !== "browser" || candidate.workspaceId !== workspaceId || !tabs.tabs.some(tab => tab.id === candidate.tabId)) return null;
    target = candidate;
  } else if (requested && (typeof requested === "string" || !target || !samePairTarget(requested, target))) return null;
  return target ? { ...context, target } : null;
}

export function browserPairIntentMatches(intent: BrowserPairIntent, state: State, repository: Repository, paired = false): boolean {
  const current = captureBrowserPairIntent(state, repository, intent.sessionId);
  return !!current
    && current.config === intent.config && current.auth === intent.auth && current.identity === intent.identity
    && current.browsing === intent.browsing && current.execution === intent.execution
    && samePairTarget(current.target, intent.target)
    && (!paired || (state.selected === intent.sessionId && repository.navigation.view === (intent.target.kind === "browser" ? "browser" : "code") && repository.navigation.conversationId === intent.sessionId));
}

export function canPairBrowserConversation(state: State, repository: Repository, sessionId: string): boolean {
  return !state.sending && !!captureBrowserPairIntent(state, repository, sessionId);
}

export type BrowserPairRestoreOptions = { sessionId?: string; revealHistory?: boolean };
export type BrowserPairRestoreActivation = { serial: number; revealHistory: boolean; target: PairTarget; sessionId: string };
type RestoreRequest = {
  serial: number;
  revealHistory: boolean;
  initialOnly: boolean;
  context: Omit<BrowserPairIntent, "target">;
  navigation: Repository["navigation"];
  drafts: State["drafts"];
  tabs: ReturnType<typeof browserTabs.snapshot>;
  retained: PairTarget | null;
  controller: AbortController;
  detach: () => void;
};
type InitialRestoreIntent = {
  config: State["config"];
  auth: number;
  sessionId: string;
  session: PairSession | null;
  navigation: Repository["navigation"];
  drafts: State["drafts"];
  tabs: ReturnType<typeof browserTabs.snapshot>;
  browsing: string;
  detach: () => void;
};

function initialRestoreIntentMatches(intent: InitialRestoreIntent): boolean {
  const current = store.snapshot(), repository = catalog.snapshot();
  if (current.phase !== "ready" || current.config !== intent.config || workspaceEpoch() !== intent.auth
    || current.selected !== intent.sessionId || current.drafts !== intent.drafts || current.sending || current.actionBusy
    || repository.navigation !== intent.navigation || browserTabs.snapshot(intent.navigation.workspaceId) !== intent.tabs
    || pairWorktreeIdentity(repository, intent.navigation.workspaceId, intent.navigation.worktreeId) !== intent.browsing) return false;
  const conversation = current.conversations.find(item => item.id === intent.sessionId);
  const session = conversation && { sessionId: conversation.id, harness: conversation.harness, authorityId: conversation.authorityId, nativeSessionId: conversation.nativeSessionId };
  // An off-page summary can arrive later. Once its native identity is known,
  // association readiness may advance, but a replacement identity cannot win.
  if (intent.session) return !!session && isPairSession(session) && samePairSession(intent.session, session);
  if (isPairSession(session)) intent.session = session;
  return true;
}

function restoreRequestMatches(request: RestoreRequest, navigation = request.navigation, tabs = request.tabs): boolean {
  const current = store.snapshot(), repository = catalog.snapshot(), expected = request.context;
  const context = capturePairContext(current, repository, expected.sessionId);
  return !!context && context.config === expected.config && context.auth === expected.auth
    && context.identity === expected.identity && context.browsing === expected.browsing && context.execution === expected.execution
    && samePairSession(context.session, expected.session) && repository.navigation === navigation
    && current.selected === expected.sessionId && current.drafts === request.drafts && !current.sending && !current.actionBusy
    && browserTabs.snapshot(navigation.workspaceId) === tabs;
}

/** Explicit pin, never a derived retarget to whichever conversation happens to be selected. */
export function useBrowserPair(state: State, repository: Repository, restoreReady: boolean) {
  useSyncExternalStore(browserTabs.subscribe, () => browserTabs.snapshot(repository.navigation.workspaceId));
  const [pin, setPin] = useState<BrowserPairIntent | null>(null);
  const invalidPin = useRef<BrowserPairIntent | null>(null);
  const unlinking = useRef(false);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const restoreOperation = useRef<AbortController | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [restoreRequest, setRestoreRequest] = useState<RestoreRequest | null>(null);
  const requested = useRef<RestoreRequest | null>(null);
  const serial = useRef(0);
  const hydrated = useRef<{ config: State["config"]; auth: number } | null>(null);
  const initialRestore = useRef<InitialRestoreIntent | null>(null);
  const [restoreActivation, setRestoreActivation] = useState<BrowserPairRestoreActivation | null>(null);
  const tabs = browserTabs.snapshot(repository.navigation.workspaceId);
  const target = previewPairTarget(repository, tabs);
  const cancelRestore = () => {
    initialRestore.current?.detach(); initialRestore.current = null;
    requested.current?.detach(); requested.current?.controller.abort();
    requested.current = null; restoreOperation.current?.abort(); setRestoreRequest(null); setRestoreError(""); setRestoreActivation(null);
    // Explicit interaction before hydration completes also wins over hydration.
    hydrated.current = { config: store.snapshot().config, auth: workspaceEpoch() };
  };
  // Capture at the explicit entry, not at a later render after a user override.
  const startRestore = (options: BrowserPairRestoreOptions = {}, initialOnly = false) => {
    cancelRestore();
    invalidPin.current = pin; setPin(null);
    const state = store.snapshot(), repository = catalog.snapshot(), navigation = repository.navigation;
    hydrated.current = { config: state.config, auth: workspaceEpoch() };
    const sessionId = options.sessionId ?? state.selected;
    if (sessionId !== state.selected || navigation.view !== "browser" && navigation.view !== "code" || state.sending || state.actionBusy) return;
    const context = capturePairContext(state, repository, sessionId);
    if (!context) return;
    const tabs = browserTabs.snapshot(navigation.workspaceId), retained = previewPairTarget(repository, tabs);
    if (initialOnly && !retained) return;
    const controller = new AbortController();
    const next: RestoreRequest = { serial: ++serial.current, revealHistory: options.revealHistory === true, initialOnly, context, navigation, drafts: state.drafts, tabs, retained, controller, detach: () => {} };
    requested.current = next;
    // Fence immediately, including a select-away/select-back before React runs
    // the effect. The effect takes over these observers without awaiting work.
    const check = () => { if (!restoreRequestMatches(next)) controller.abort(); };
    const stopStore = store.subscribe(check), stopCatalog = catalog.subscribe(check), stopTabs = browserTabs.subscribe(check);
    next.detach = () => { stopStore(); stopCatalog(); stopTabs(); };
    setRestoreRequest(next);
  };
  const requestRestore = (options?: BrowserPairRestoreOptions) => startRestore(options);
  const clear = () => { cancelRestore(); invalidPin.current = pin; setPin(null); };
  const active = !!pin && invalidPin.current !== pin && browserPairIntentMatches(pin, state, repository, true);
  if (pin && !active) invalidPin.current = pin;
  useEffect(() => () => { initialRestore.current?.detach(); requested.current?.detach(); restoreOperation.current?.abort(); }, []);
  useEffect(() => {
    if (!pin) return;
    const check = () => {
      if (browserPairIntentMatches(pin, store.snapshot(), catalog.snapshot(), true)) return;
      invalidPin.current = pin;
      restoreOperation.current?.abort();
      setPin(value => value === pin ? null : value);
    };
    const stopStore = store.subscribe(check), stopCatalog = catalog.subscribe(check), stopTabs = browserTabs.subscribe(check);
    check();
    return () => { stopStore(); stopCatalog(); stopTabs(); };
  }, [pin]);
  // Invalidity takes effect during render, before cleanup; a later visit cannot revive the pin.
  useEffect(() => { if (pin && !active) setPin(value => value === pin ? null : value); }, [pin, active]);
  const pair = (sessionId: string, expected?: BrowserPairIntent): boolean => {
    cancelRestore();
    const state = store.snapshot(), repository = catalog.snapshot();
    if (!canPairBrowserConversation(state, repository, sessionId)) return false;
    const next = captureBrowserPairIntent(state, repository, sessionId);
    if (!next || expected && !browserPairIntentMatches(expected, state, repository)) return false;
    // choose changes only the conversation, never the independently browsed checkout.
    store.choose(sessionId);
    if (!browserPairIntentMatches(next, store.snapshot(), catalog.snapshot()) || store.snapshot().selected !== sessionId) return false;
    catalog.navigate({ view: next.target.kind === "browser" ? "browser" : "code", conversationId: next.sessionId });
    if (!browserPairIntentMatches(next, store.snapshot(), catalog.snapshot(), true)) return false;
    setPin(next);
    return true;
  };
  const unlink = async () => {
    if (!pin || !active || unlinking.current) return;
    const expected = pin;
    const current = () => invalidPin.current !== expected && browserPairIntentMatches(expected, store.snapshot(), catalog.snapshot(), true);
    unlinking.current = true; setUnlinkBusy(true);
    try {
      const snapshot = await readBrowserPairs(expected.config!.storeId!, expected.target);
      if (!current()) throw new Error("The selected resource or conversation changed. No unlink request was sent.");
      await writeBrowserPairs(snapshot, expected.session, "remove");
      if (current()) { cancelRestore(); setPin(value => value === expected ? null : value); }
    } finally { unlinking.current = false; setUnlinkBusy(false); }
  };
  useEffect(() => {
    if (!restoreReady) return;
    const current = store.snapshot(), repository = catalog.snapshot(), config = current.config, auth = workspaceEpoch();
    if (!repository.ready || !config?.authenticated) return;
    if (hydrated.current && hydrated.current.config === config && hydrated.current.auth === auth) return;
    if (initialRestore.current && (initialRestore.current.config !== config || initialRestore.current.auth !== auth)) {
      initialRestore.current.detach(); initialRestore.current = null;
    }
    if (!initialRestore.current) {
      const navigation = repository.navigation, tabs = browserTabs.snapshot(navigation.workspaceId);
      const browsing = pairWorktreeIdentity(repository, navigation.workspaceId, navigation.worktreeId);
      // Capture the hydration destination/session once, before summaries or
      // associations are ready. Never capture a later ordinary selection.
      if (!current.selected || !browsing || !previewPairTarget(repository, tabs)) {
        hydrated.current = { config, auth }; return;
      }
      initialRestore.current = { config, auth, sessionId: current.selected, session: null, navigation, tabs, drafts: current.drafts, browsing, detach: () => {} };
    }
    const initial = initialRestore.current;
    const check = () => {
      if (initialRestore.current !== initial || initialRestoreIntentMatches(initial)) return;
      initial.detach(); initialRestore.current = null;
      hydrated.current = { config: initial.config, auth: initial.auth };
    };
    // Also observe while waiting for an off-page summary, including transient
    // select-away/select-back and navigation overrides between React renders.
    initial.detach();
    const stopStore = store.subscribe(check), stopCatalog = catalog.subscribe(check), stopTabs = browserTabs.subscribe(check);
    initial.detach = () => { stopStore(); stopCatalog(); stopTabs(); };
    check();
    if (initialRestore.current !== initial || !capturePairContext(store.snapshot(), catalog.snapshot(), initial.sessionId)) return;
    // Only successful context capture consumes this initial attempt. The saved
    // target still cannot change: all waiting-state scope fences remain exact.
    startRestore({ sessionId: initial.sessionId }, true);
  }, [restoreReady, state.phase, state.conversationsReady, state.conversations, state.config, repository.ready, repository.workspaces]);
  useEffect(() => {
    if (!restoreReady || !restoreRequest || requested.current !== restoreRequest) return;
    const request = restoreRequest, expected = request.context;
    const { workspaceId, worktreeId, view } = request.navigation;
    const config = expected.config;
    if (!workspaceId || !worktreeId || !config?.storeId) return;
    let navigation = request.navigation, tabs = request.tabs;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, request.controller.signal, AbortSignal.timeout(25000)]);
    restoreOperation.current = controller;
    setRestoreError("");
    const scopeCurrent = () => requested.current === request && restoreRequestMatches(request, navigation, tabs);
    const current = () => !signal.aborted && scopeCurrent();
    const check = () => {
      if (scopeCurrent()) return;
      controller.abort();
    };
    request.detach();
    const stopStore = store.subscribe(check), stopCatalog = catalog.subscribe(check), stopTabs = browserTabs.subscribe(check);
    const stop = () => { stopStore(); stopCatalog(); stopTabs(); };
    check();
    void (async () => {
      if (!current()) return;
      const linked = (snapshot: PairSnapshot) => snapshot.sessions.find(session => samePairSession(session, expected.session));
      // Prefer the exact retained resource even if another link is newer.
      let candidate = request.retained ? await readBrowserPairs(config.storeId!, request.retained, signal) : null;
      if (!current()) return;
      if (!candidate || !linked(candidate)) {
        if (request.initialOnly) return;
        const discovery = await readLinkedPairs(config.storeId!, { workspaceId, worktreeId, kind: view === "browser" ? "browser" : "file" }, expected.session, signal);
        if (!current()) return;
        candidate = discovery.targets.filter(snapshot => linked(snapshot) && previewPairTargetAvailable(catalog.snapshot(), tabs, snapshot.target))
          .sort((a, b) => {
            const first = linked(a)!, second = linked(b)!;
            return Date.parse(second.lastPairedAt ?? second.linkedAt) - Date.parse(first.lastPairedAt ?? first.linkedAt)
              || pairTargetKey(a.target).localeCompare(pairTargetKey(b.target));
          })[0] ?? null;
      }
      if (!candidate || !previewPairTargetAvailable(catalog.snapshot(), tabs, candidate.target)) return;
      const latest = await readBrowserPairs(config.storeId!, candidate.target, signal);
      if (!current()) return;
      if (latest.revision !== candidate.revision || !linked(latest)) {
        setRestoreError("Saved links changed while restoring. Restore again to load the latest pairing.");
        return;
      }
      // Only our own synchronous publication is exempt from the navigation/tab
      // observers, after a fresh exact revision and native identity check.
      stop();
      if (!current()) return;
      const restoredTarget = latest.target;
      if (restoredTarget.kind === "browser" && tabs.activeId !== restoredTarget.tabId) {
        browserTabs.update(workspaceId, value => ({ ...value, activeId: restoredTarget.tabId }));
        const nextTabs = browserTabs.snapshot(workspaceId);
        if (nextTabs.tabs !== tabs.tabs || nextTabs.activeId !== restoredTarget.tabId || nextTabs.showAll !== tabs.showAll) return;
        tabs = nextTabs;
      }
      if (!current()) return;
      const changeFile = restoredTarget.kind === "file" && navigation.filePath !== restoredTarget.path;
      if (changeFile || navigation.conversationId !== expected.sessionId) {
        const nextNavigation = { ...navigation, conversationId: expected.sessionId,
          ...(changeFile && restoredTarget.kind === "file" ? { filePath: restoredTarget.path, comparison: null } : {}) };
        catalog.navigate(nextNavigation);
        const actual = catalog.snapshot().navigation;
        if (Object.keys(nextNavigation).some(key => actual[key as keyof typeof actual] !== nextNavigation[key as keyof typeof nextNavigation])) return;
        navigation = actual;
      }
      if (!current()) return;
      // File candidates must be applied before capture: capture never inspects a
      // different file or selects/replaces another conversation on our behalf.
      const intent = captureBrowserPairIntent(store.snapshot(), catalog.snapshot(), expected.sessionId);
      if (!intent || !samePairTarget(intent.target, restoredTarget) || !samePairSession(intent.session, expected.session)
        || !browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot(), true)) return;
      requested.current = null;
      setPin(intent);
      setRestoreActivation({ serial: request.serial, revealHistory: request.revealHistory, target: restoredTarget, sessionId: expected.sessionId });
    })().catch(() => {
      if (!controller.signal.aborted && !request.controller.signal.aborted && scopeCurrent()) {
        setRestoreError("Could not restore the saved pairing. Restore again to try again, or connect a conversation manually.");
      }
    }).finally(() => { stop(); controller.abort(); if (restoreOperation.current === controller) restoreOperation.current = null; });
    return () => { stop(); controller.abort(); if (restoreOperation.current === controller) restoreOperation.current = null; };
    // Only a new explicit request (or the one hydration request) starts reads.
  }, [restoreRequest, restoreReady]);
  return { active, sessionId: active ? pin?.sessionId : undefined, target, targetLabel: previewPairTargetLabel(target, tabs), pairedTarget: active ? pin?.target : undefined, canPair: canPairBrowserConversation(state, repository, state.selected), pair, clear, unlink, unlinkBusy, cancelRestore, suspend: clear, requestRestore, restoreActivation, restoreError, dismissRestoreError: () => setRestoreError("") };
}

export function useBrowserPairCompact() {
  const [compact, setCompact] = useState(() => window.matchMedia(BROWSER_PAIR_COMPACT_MEDIA).matches);
  useEffect(() => {
    const query = window.matchMedia(BROWSER_PAIR_COMPACT_MEDIA);
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return compact;
}
