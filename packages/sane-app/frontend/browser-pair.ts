import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import type { Conversation } from "./types";
import { workspaceEpoch } from "./workspace-store";
import { workerReference } from "./worker-client";
import { browserTabs } from "./browser-tabs";
import { readBrowserPairs, writeBrowserPairs } from "./browser-pair-client";
import { isBrowserPairSession, sameBrowserPairSession, type BrowserPairSession, type BrowserPairTarget } from "../shared/browser-pair-contract";

export const BROWSER_PAIR_COMPACT_MEDIA = "(max-width:1000px)";

type Repository = ReturnType<typeof catalog.snapshot>;
export type BrowserPairIntent = {
  sessionId: string;
  session: BrowserPairSession;
  target: BrowserPairTarget;
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
function worktreeIdentity(repository: Repository, workspaceId?: string | null, worktreeId?: string | null) {
  const worktree = repository.workspaces.find(item => item.workspaceId === workspaceId)?.worktrees.find(item => item.worktreeId === worktreeId);
  return repository.ready && workspaceId && worktree?.state === "available"
    ? JSON.stringify([workspaceId, worktreeId, worktree.bindingRevision, worktree.root]) : null;
}
export function captureBrowserPairIntent(state: State, repository: Repository, sessionId: string, tabId?: string): BrowserPairIntent | null {
  const conversation = state.conversations.find(item => item.id === sessionId);
  if (state.phase !== "ready" || !state.config?.authenticated || typeof state.config.storeId !== "string" || !state.conversationsReady || !conversation || conversation.replacedBy
    || conversation.worker || workerReference(sessionId) || conversation.agentKind === "worker" || conversation.attachment?.state === "pending"
    || conversation.association !== "resolved") return null;
  const browsing = worktreeIdentity(repository, repository.navigation.workspaceId, repository.navigation.worktreeId);
  const execution = worktreeIdentity(repository, conversation.workspaceId, conversation.worktreeId);
  const workspaceId = repository.navigation.workspaceId;
  const tabs = browserTabs.snapshot(workspaceId);
  const tab = tabs.tabs.find(tab => tab.id === (tabId ?? tabs.activeId));
  const session = { sessionId: conversation.id, harness: conversation.harness, authorityId: conversation.authorityId, nativeSessionId: conversation.nativeSessionId };
  if (!browsing || !execution || !workspaceId || !tab || !isBrowserPairSession(session)) return null;
  return { sessionId: conversation.id, session, target: { workspaceId, tabId: tab.id }, config: state.config, auth: workspaceEpoch(), identity: identity(conversation), browsing, execution };
}

export function browserPairIntentMatches(intent: BrowserPairIntent, state: State, repository: Repository, paired = false): boolean {
  const current = captureBrowserPairIntent(state, repository, intent.sessionId);
  return !!current && ["chat", "browser"].includes(repository.navigation.view)
    && current.config === intent.config && current.auth === intent.auth && current.identity === intent.identity
    && current.browsing === intent.browsing && current.execution === intent.execution
    && current.target.workspaceId === intent.target.workspaceId && current.target.tabId === intent.target.tabId
    && (!paired || (state.selected === intent.sessionId && repository.navigation.view === "browser" && repository.navigation.conversationId === intent.sessionId));
}

export function canPairBrowserConversation(state: State, repository: Repository, sessionId: string): boolean {
  return !state.sending && ["chat", "browser"].includes(repository.navigation.view) && !!captureBrowserPairIntent(state, repository, sessionId);
}

/** Explicit pin, never a derived retarget to whichever conversation happens to be selected. */
export function useBrowserPair(state: State, repository: Repository, restoreReady: boolean) {
  useSyncExternalStore(browserTabs.subscribe, () => browserTabs.snapshot(repository.navigation.workspaceId));
  const [pin, setPin] = useState<BrowserPairIntent | null>(null);
  const unlinking = useRef(false);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const restoreOperation = useRef<AbortController | null>(null);
  const suppressedEntry = useRef<string | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [restoreRequest, setRestoreRequest] = useState(0);
  const browsing = worktreeIdentity(repository, repository.navigation.workspaceId, repository.navigation.worktreeId);
  const entry = repository.navigation.view === "browser" && browsing
    ? JSON.stringify([state.config?.storeId, workspaceEpoch(), browsing, restoreRequest]) : null;
  const requestRestore = () => { restoreOperation.current?.abort(); suppressedEntry.current = null; setRestoreError(""); setRestoreRequest(value => value + 1); };
  const cancelRestore = () => { suppressedEntry.current = entry; restoreOperation.current?.abort(); setRestoreError(""); };
  const clear = () => { cancelRestore(); setPin(null); };
  const active = !!pin && browserPairIntentMatches(pin, state, repository, true);
  // Invalidity takes effect during render, before cleanup; a later visit cannot revive the pin.
  useEffect(() => { if (pin && !active) setPin(null); }, [pin, active]);
  const pair = (sessionId: string, expected?: BrowserPairIntent): boolean => {
    cancelRestore();
    const state = store.snapshot(), repository = catalog.snapshot();
    if (!canPairBrowserConversation(state, repository, sessionId)) return false;
    const next = captureBrowserPairIntent(state, repository, sessionId);
    if (!next || expected && !browserPairIntentMatches(expected, state, repository)) return false;
    // choose changes only the conversation, never the independently browsed checkout.
    store.choose(sessionId);
    if (!browserPairIntentMatches(next, store.snapshot(), catalog.snapshot()) || store.snapshot().selected !== sessionId) return false;
    catalog.navigate({ view: "browser", conversationId: next.sessionId });
    if (!browserPairIntentMatches(next, store.snapshot(), catalog.snapshot(), true)) return false;
    setPin(next);
    return true;
  };
  const unlink = async () => {
    if (!pin || !active || unlinking.current) return;
    const expected = pin;
    const current = () => browserPairIntentMatches(expected, store.snapshot(), catalog.snapshot(), true);
    unlinking.current = true; setUnlinkBusy(true);
    try {
      const snapshot = await readBrowserPairs(expected.config!.storeId!, expected.target);
      if (!current()) throw new Error("The selected browser tab or conversation changed. No unlink request was sent.");
      await writeBrowserPairs(snapshot, expected.session, "remove");
      if (current()) { cancelRestore(); setPin(value => value === expected ? null : value); }
    } finally { unlinking.current = false; setUnlinkBusy(false); }
  };
  const pairCallback = useRef(pair);
  pairCallback.current = pair;
  useEffect(() => {
    if (!entry) { suppressedEntry.current = null; setRestoreError(""); return; }
    if (!restoreReady || !state.conversationsReady || active || suppressedEntry.current === entry) return;
    const initial = store.snapshot(), navigation = catalog.snapshot().navigation;
    const workspaceId = navigation.workspaceId, config = initial.config, auth = workspaceEpoch();
    const tabs = browserTabs.snapshot(workspaceId);
    if (!workspaceId || !config?.storeId || initial.sending || initial.actionBusy || !tabs.tabs.length) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    restoreOperation.current = controller;
    setRestoreError("");
    const scopeCurrent = () => {
      const current = store.snapshot(), repository = catalog.snapshot();
      return current.phase === "ready" && current.config === config && workspaceEpoch() === auth && repository.ready
        && repository.navigation === navigation && current.selected === initial.selected && current.drafts === initial.drafts
        && !current.sending && !current.actionBusy && browserTabs.snapshot(workspaceId) === tabs
        && worktreeIdentity(repository, navigation.workspaceId, navigation.worktreeId) === browsing;
    };
    const current = () => !signal.aborted && scopeCurrent();
    const check = () => { if (!scopeCurrent()) { suppressedEntry.current = entry; controller.abort(); } };
    const stopStore = store.subscribe(check), stopCatalog = catalog.subscribe(check), stopTabs = browserTabs.subscribe(check);
    const stop = () => { stopStore(); stopCatalog(); stopTabs(); };
    void (async () => {
      // Tabs remain device-local. Only restore links for tabs that still exist;
      // never recreate a closed tab, navigate its URL, or send a chat message.
      const snapshots = await Promise.all(tabs.tabs.map(tab => readBrowserPairs(config.storeId!, { workspaceId, tabId: tab.id }, signal)));
      if (!current()) return;
      const candidates = snapshots.flatMap(snapshot => snapshot.sessions.map(session => ({ session, tabId: snapshot.tabId, revision: snapshot.revision })))
        .sort((a, b) => Date.parse(b.session.lastPairedAt ?? b.session.linkedAt) - Date.parse(a.session.lastPairedAt ?? a.session.linkedAt)
          || a.tabId.localeCompare(b.tabId) || a.session.sessionId.localeCompare(b.session.sessionId));
      for (const candidate of candidates) {
        await store.ensureConversations([candidate.session.sessionId], signal);
        if (!current()) return;
        const intent = captureBrowserPairIntent(store.snapshot(), catalog.snapshot(), candidate.session.sessionId, candidate.tabId);
        if (!intent || !sameBrowserPairSession(intent.session, candidate.session)) continue;
        const latest = await readBrowserPairs(config.storeId!, { workspaceId, tabId: candidate.tabId }, signal);
        if (!current()) return;
        if (latest.revision !== candidate.revision) {
          suppressedEntry.current = entry;
          setRestoreError("Saved browser links changed while restoring. Reopen Browser to load the latest pairing.");
          return;
        }
        const finalIntent = captureBrowserPairIntent(store.snapshot(), catalog.snapshot(), candidate.session.sessionId, candidate.tabId);
        if (!finalIntent || !sameBrowserPairSession(finalIntent.session, candidate.session)) continue;
        // All asynchronous reads are fenced before this synchronous publication.
        // Detach observers so our own tab/selection changes aren't user overrides.
        stop();
        if (!current()) return;
        if (restoreOperation.current === controller) restoreOperation.current = null;
        browserTabs.update(workspaceId, current => ({ ...current, activeId: candidate.tabId, showAll: false }));
        if (!pairCallback.current(candidate.session.sessionId, finalIntent)) setRestoreError("The saved browser pairing is unavailable. Connect an available conversation to continue.");
        return;
      }
      if (candidates.length) setRestoreError("Saved browser links are unavailable. Connect an available conversation to continue.");
      suppressedEntry.current = entry;
    })().catch(() => {
      if (!controller.signal.aborted && scopeCurrent()) {
        suppressedEntry.current = entry;
        setRestoreError("Could not restore the saved browser pairing. Reopen Browser to try again, or connect a conversation manually.");
      }
    }).finally(() => { stop(); controller.abort(); if (restoreOperation.current === controller) restoreOperation.current = null; });
    return () => { stop(); controller.abort(); if (restoreOperation.current === controller) restoreOperation.current = null; };
    // Deliberately entry/readiness-driven, not pin/tab-driven: exit and manual
    // selections must not immediately resurrect the view they just dismissed.
  }, [entry, restoreReady, state.conversationsReady, state.config]);
  return { active, sessionId: active ? pin?.sessionId : undefined, canPair: canPairBrowserConversation(state, repository, state.selected), pair, clear, unlink, unlinkBusy, cancelRestore, requestRestore, restoreError, dismissRestoreError: () => setRestoreError("") };
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
