import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { catalog } from "./catalog";
import { store, type State } from "./store";
import type { Conversation } from "./types";
import { workspaceEpoch } from "./workspace-store";
import { workerReference } from "./worker-client";
import { browserTabs } from "./browser-tabs";
import { readBrowserPairs, writeBrowserPairs } from "./browser-pair-client";
import { isBrowserPairSession, type BrowserPairSession, type BrowserPairTarget } from "../shared/browser-pair-contract";

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
export function captureBrowserPairIntent(state: State, repository: Repository, sessionId: string): BrowserPairIntent | null {
  const conversation = state.conversations.find(item => item.id === sessionId);
  if (state.phase !== "ready" || !state.config?.authenticated || typeof state.config.storeId !== "string" || !state.conversationsReady || !conversation || conversation.replacedBy
    || conversation.worker || workerReference(sessionId) || conversation.agentKind === "worker" || conversation.attachment?.state === "pending"
    || conversation.association !== "resolved") return null;
  const browsing = worktreeIdentity(repository, repository.navigation.workspaceId, repository.navigation.worktreeId);
  const execution = worktreeIdentity(repository, conversation.workspaceId, conversation.worktreeId);
  const workspaceId = repository.navigation.workspaceId;
  const tabs = browserTabs.snapshot(workspaceId);
  const tab = tabs.tabs.find(tab => tab.id === tabs.activeId);
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
export function useBrowserPair(state: State, repository: Repository) {
  useSyncExternalStore(browserTabs.subscribe, () => browserTabs.snapshot(repository.navigation.workspaceId));
  const [pin, setPin] = useState<BrowserPairIntent | null>(null);
  const unlinking = useRef(false);
  const [unlinkBusy, setUnlinkBusy] = useState(false);
  const active = !!pin && browserPairIntentMatches(pin, state, repository, true);
  // Invalidity takes effect during render, before cleanup; a later visit cannot revive the pin.
  useEffect(() => { if (pin && !active) setPin(null); }, [pin, active]);
  const pair = (sessionId: string, expected?: BrowserPairIntent): boolean => {
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
      setPin(value => value === expected ? null : value);
    } finally { unlinking.current = false; setUnlinkBusy(false); }
  };
  return { active, sessionId: active ? pin?.sessionId : undefined, canPair: canPairBrowserConversation(state, repository, state.selected), pair, clear: () => setPin(null), unlink, unlinkBusy };
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
