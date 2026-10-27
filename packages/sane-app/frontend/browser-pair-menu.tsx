import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiLink, FiPlus, FiTrash2, FiX } from "react-icons/fi";
import { browserPairCache, clearBrowserPairs, readBrowserPairs, writeBrowserPairs } from "./browser-pair-client";
import { browserPairIntentMatches, canPairBrowserConversation, captureBrowserPairIntent, type BrowserPairIntent } from "./browser-pair";
import { browserTabs } from "./browser-tabs";
import { pairWorktreeIdentity, previewPairTarget, previewPairTargetLabel } from "./preview-pair-target";
import { getHostBrowserTab, hostBrowserTabs, revokeHostBrowserGrant, setHostBrowserGrant } from "./browser-host-client";
import type { BrowserGrantScope, BrowserSessionGrant } from "../shared/browser-host-contract";
import { catalog } from "./catalog";
import { ConversationSidebarList, type ConversationSidebarModel } from "./conversation-sidebar";
import { ShellDialog } from "./shell-dialog";
import { store, type State } from "./store";
import { workspaceEpoch } from "./workspace-store";
import { pairTargetKey, samePairTarget, samePairSession as sameBrowserPairSession, type PairLink as BrowserPairLink, type PairSession as BrowserPairSession, type PairSnapshot as BrowserPairSnapshot } from "../shared/resource-pair-contract";
import "./browser-pair-menu.css";

type Props = {
  state: State; model: ConversationSidebarModel; pairedSessionId?: string;
  interact: () => void; openSession: (id: string, intent: BrowserPairIntent) => boolean;
  addSession: (id: string) => void; removed: (id: string | null) => void;
};
const sessionRef = (link: BrowserPairSession): BrowserPairSession => ({ sessionId: link.sessionId, harness: link.harness, authorityId: link.authorityId, nativeSessionId: link.nativeSessionId });
const grantMatchesSession = (grant: BrowserSessionGrant, session: BrowserPairSession) => grant.sessionId === session.sessionId && grant.harness === session.harness && grant.authorityId === session.authorityId && grant.nativeSessionId === session.nativeSessionId;

/** One shell-owned controller, scoped to the current browser tab or exact file. */
export function useBrowserPairMenu(props: Props) {
  const { state, model, pairedSessionId } = props;
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const workspaceId = repository.navigation.workspaceId;
  const tabs = useSyncExternalStore(browserTabs.subscribe, () => browserTabs.snapshot(workspaceId));
  const tab = tabs.tabs.find(tab => tab.id === tabs.activeId);
  const target = previewPairTarget(repository, tabs);
  const browserTarget = target?.kind === "browser" ? { workspaceId: target.workspaceId, tabId: target.tabId } : null;
  const storeId = state.config?.storeId ?? "";
  const auth = workspaceEpoch();
  const browsing = pairWorktreeIdentity(repository, workspaceId, repository.navigation.worktreeId);
  const scope = JSON.stringify([auth, storeId, state.config?.authenticated, repository.navigation.view, browsing, target && pairTargetKey(target), browserTarget ? tab?.mode ?? "device" : null]);
  const enabled = state.phase === "ready" && state.config?.authenticated === true && repository.ready && !!storeId && !!target;
  const snapshot = useSyncExternalStore(browserPairCache.subscribe, () => enabled && target ? browserPairCache.snapshot(storeId, target) : null);
  const host = useSyncExternalStore(hostBrowserTabs.subscribe, () => hostBrowserTabs.snapshot(browserTarget?.workspaceId ?? "", browserTarget?.tabId ?? ""));
  // Notebook iframe previews are never host-browser targets and receive no grants.
  const hostMode = !!browserTarget && tab?.mode === "host";
  const [opened, setOpened] = useState<string | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ scope: string; snapshot: BrowserPairSnapshot } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null), menu = useRef<HTMLDivElement>(null);
  const load = useRef<AbortController | null>(null), operation = useRef<AbortController | null>(null);
  const inFlight = useRef(false), focusPending = useRef(false), alive = useRef(false);
  const currentProps = useRef({ props, scope }); currentProps.current = { props, scope };
  const menuId = useId();
  const visible = opened === scope && !!enabled;
  const targetCurrent = () => {
    const current = catalog.snapshot();
    const selectedTarget = previewPairTarget(current, browserTabs.snapshot(current.navigation.workspaceId));
    return workspaceEpoch() === auth && store.snapshot().config === state.config && current.navigation.view === repository.navigation.view
      && pairWorktreeIdentity(current, current.navigation.workspaceId, current.navigation.worktreeId) === browsing
      && !!target && !!selectedTarget && samePairTarget(target, selectedTarget);
  };
  const restoreFocus = () => [anchor.current, ...document.querySelectorAll<HTMLButtonElement>(".browser-pair-menu-trigger")]
    .find(button => button?.isConnected && button.getClientRects().length > 0 && !button.disabled) ?? null;
  const close = (focus = true) => { setOpened(null); if (focus) focusPending.current = true; };
  useEffect(() => {
    if (visible || !focusPending.current) return;
    focusPending.current = false; restoreFocus()?.focus({ preventScroll: true });
  }, [visible, pairedSessionId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; load.current?.abort(); operation.current?.abort(); }; }, []);
  useEffect(() => {
    setOpened(null); setPicker(null); setConfirmation(null); setError(""); setBlocked(false);
    load.current?.abort(); operation.current?.abort();
    if (enabled) void refresh(false);
    return () => { load.current?.abort(); operation.current?.abort(); };
  }, [scope, !!enabled, state.config]);
  useEffect(() => {
    if (!enabled || !hostMode || !visible || !browserTarget) return;
    const controller = new AbortController();
    const refreshHost = () => { void getHostBrowserTab(browserTarget.workspaceId, browserTarget.tabId, controller.signal).catch(failure => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load host browser grants.");
    }); };
    refreshHost(); const timer = setInterval(refreshHost, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [scope, !!enabled, hostMode, visible]);

  async function refresh(summaries: boolean) {
    if (!enabled || !target) return;
    load.current?.abort();
    const controller = new AbortController(); load.current = controller;
    const config = store.snapshot().config;
    const current = () => alive.current && !controller.signal.aborted && currentProps.current.scope === scope && store.snapshot().config === config;
    setLoading(true); setError("");
    try {
      const next = await readBrowserPairs(storeId, target, AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]));
      if (!current()) return;
      setBlocked(false);
      if (summaries && next.sessions.length) await store.ensureConversations(next.sessions.map(link => link.sessionId), controller.signal);
    } catch (failure) {
      if (current()) { setBlocked(true); setError(failure instanceof Error ? failure.message : "Could not load paired sessions."); }
    } finally { if (current()) setLoading(false); }
  }

  async function run(action: (before: BrowserPairSnapshot, signal: AbortSignal, current: () => boolean) => Promise<void>, before = snapshot) {
    if (!enabled || !target || !before || before.storeId !== storeId || !samePairTarget(before.target, target) || inFlight.current || blocked || loading) return;
    const initial = store.snapshot(), navigation = catalog.snapshot().navigation, initialTabs = browserTabs.snapshot(workspaceId), auth = workspaceEpoch();
    const controller = new AbortController(); operation.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
    const current = () => alive.current && !signal.aborted && currentProps.current.scope === scope && workspaceEpoch() === auth && store.snapshot().phase === "ready" && store.snapshot().config?.authenticated === true
      && store.snapshot().config === initial.config && store.snapshot().selected === initial.selected && store.snapshot().drafts === initial.drafts
      && !store.snapshot().sending && !store.snapshot().actionBusy && catalog.snapshot().navigation === navigation
      && pairWorktreeIdentity(catalog.snapshot(), workspaceId, navigation.worktreeId) === browsing
      && (target.kind !== "browser" || browserTabs.snapshot(workspaceId) === initialTabs);
    if (!current()) { controller.abort(); if (operation.current === controller) operation.current = null; return; }
    currentProps.current.props.interact();
    // A manual selection invalidates this operation permanently, even if the
    // user returns to the same conversation before a network receipt arrives.
    const check = () => { if (!current()) controller.abort(); };
    const stopStore = store.subscribe(check), stopCatalog = catalog.subscribe(check), stopTabs = browserTabs.subscribe(check);
    inFlight.current = true; setBusy(true); setError("");
    try { await action(before, signal, current); }
    catch (failure) {
      if (alive.current && currentProps.current.scope === scope) {
        setBlocked(true);
        setError(`${failure instanceof Error ? failure.message : "The change was not confirmed."} Refresh the menu before trying again. No automatic retry will occur.`);
      }
    } finally {
      stopStore(); stopCatalog(); stopTabs();
      inFlight.current = false;
      if (operation.current === controller) operation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  const switchSession = (link: BrowserPairLink) => void run(async (before, signal, current) => {
    await store.ensureConversations([link.sessionId], signal);
    if (!current()) return;
    const intent = captureBrowserPairIntent(store.snapshot(), catalog.snapshot(), link.sessionId);
    if (!intent || !sameBrowserPairSession(intent.session, link)) { setError("This linked conversation is unavailable. Its link can still be removed."); return; }
    // Refresh recency only for an existing link, against the menu's revision.
    // A concurrent unlink cannot be silently undone by a switch.
    await writeBrowserPairs(before, sessionRef(link), "add", signal);
    if (!current() || !browserPairIntentMatches(intent, store.snapshot(), catalog.snapshot())) return;
    if (!currentProps.current.props.openSession(link.sessionId, intent)) throw new Error("Links were saved, but the paired view could not be opened.");
    close();
  });
  const removeSession = (link: BrowserPairLink) => void run(async (before, signal, current) => {
    await writeBrowserPairs(before, sessionRef(link), "remove", signal);
    if (!current()) return;
    currentProps.current.props.removed(link.sessionId); close();
  });
  const clearAll = () => void run(async (before, signal, current) => {
    await clearBrowserPairs(before, signal);
    if (!current()) return;
    setConfirmation(null); currentProps.current.props.removed(null); close();
  }, confirmation?.scope === scope ? confirmation.snapshot : null);
  const changeGrant = (link: BrowserPairLink, grantScope: BrowserGrantScope) => void run(async (_before, signal, current) => {
    if (!hostMode || !browserTarget || host.state?.status !== "running" || !current()) return;
    const existing = host.grants.find(grant => grantMatchesSession(grant, link));
    if (existing?.scope === grantScope) await revokeHostBrowserGrant(browserTarget.workspaceId, browserTarget.tabId, link.sessionId, signal);
    else await setHostBrowserGrant(browserTarget.workspaceId, browserTarget.tabId, sessionRef(link), grantScope, signal);
  });
  const titleFor = (link: BrowserPairLink) => state.conversations.find(item => item.id === link.sessionId && item.harness === link.harness && item.authorityId === link.authorityId && item.nativeSessionId === link.nativeSessionId)?.title || `Conversation · ${link.sessionId.slice(0, 8)}`;
  const locked = busy || blocked || loading || state.sending || state.actionBusy;
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!inFlight.current) close(); return; }
    if (event.key === "Tab") { if (!inFlight.current) { close(false); restoreFocus()?.focus(); } return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : index < 0 ? event.key === "ArrowDown" ? 0 : items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  useLayoutEffect(() => {
    if (!visible || !anchor.current || !menu.current) return;
    const rect = anchor.current.getBoundingClientRect(), width = menu.current.getBoundingClientRect().width;
    const above = Math.max(0, rect.top - 12), below = Math.max(0, window.innerHeight - rect.bottom - 12);
    const height = Math.min(480, menu.current.scrollHeight), upwards = height > below && above > below;
    const maxHeight = Math.min(height, upwards ? above : below);
    setPosition({ top: upwards ? rect.top - 4 - maxHeight : rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), maxHeight });
  }, [visible, snapshot, host, loading, error]);
  useEffect(() => {
    if (!visible) return;
    menu.current?.focus();
    const outside = (event: PointerEvent) => { if (!inFlight.current && !anchor.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close(false); };
    const scroll = (event: Event) => { if (!inFlight.current && !(event.target instanceof Node && menu.current?.contains(event.target))) close(false); };
    document.addEventListener("pointerdown", outside); window.addEventListener("scroll", scroll, true); window.addEventListener("resize", scroll);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", scroll); };
  }, [visible]);

  const button = <button type="button" className="icon-button browser-pair-icon-button browser-pair-menu-trigger" disabled={!enabled} aria-label={`Paired sessions${snapshot ? `: ${snapshot.sessions.length}` : ""}`} title="Paired sessions" aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? menuId : undefined} onClick={event => {
    if (inFlight.current) return;
    if (visible) { close(); return; }
    currentProps.current.props.interact(); anchor.current = event.currentTarget; setPosition(null); setOpened(scope); void refresh(true);
  }}><FiLink size={16} aria-hidden="true" /><span aria-hidden="true">{snapshot ? snapshot.sessions.length : "—"}</span></button>;
  const tabName = previewPairTargetLabel(target, tabs);
  const openPicker = () => {
    if (!enabled || !targetCurrent() || inFlight.current || state.sending || state.actionBusy) return;
    close(false); setPicker(scope); setError(""); currentProps.current.props.interact();
  };
  const overlays = <>
    {visible && createPortal(<div id={menuId} ref={menu} className="browser-pair-menu" role="menu" aria-label={`Paired sessions for ${tabName}`} tabIndex={-1} onKeyDown={onKey} style={position ?? { visibility: "hidden" }}>
      <header><strong>Paired sessions</strong><span title={tabName}>{tabName}</span></header>
      {(loading || busy) && <p className="muted" role="status">{busy ? "Updating paired sessions…" : "Loading paired sessions…"}</p>}
      {hostMode && <p className="muted">Host access is separate from pairing. Observe is read-only; Control permits agent changes. Select an active grant again to revoke it.{host.state?.status !== "running" ? " Start the host tab to enable grants." : ""}</p>}
      {snapshot?.sessions.map(link => <div className="browser-pair-menu-session" role="none" key={link.sessionId}><div className="browser-pair-menu-row" role="none">
        <button type="button" role="menuitemradio" aria-checked={pairedSessionId === link.sessionId} disabled={locked} onClick={() => switchSession(link)} title={titleFor(link)}><span className="browser-pair-menu-check">{pairedSessionId === link.sessionId && <FiCheck size={15} aria-hidden="true" />}</span><span>{titleFor(link)}</span></button>
        <button type="button" role="menuitem" className="browser-pair-menu-remove" aria-label={`Remove ${titleFor(link)} from paired sessions`} title="Remove link" disabled={locked} onClick={() => removeSession(link)}><FiX size={15} aria-hidden="true" /></button>
      </div>{hostMode && <div className="browser-pair-grants" role="group" aria-label={`Host browser access for ${titleFor(link)}`}>
        <span>Host: {host.grants.find(grant => grantMatchesSession(grant, link))?.scope === "control" ? "Control" : host.grants.find(grant => grantMatchesSession(grant, link))?.scope === "observe" ? "Observe" : "None"}</span>
        {(["observe", "control"] as const).map(grantScope => <button type="button" role="menuitemcheckbox" key={grantScope} aria-checked={host.grants.some(grant => grantMatchesSession(grant, link) && grant.scope === grantScope)} disabled={locked || host.state?.status !== "running"} onClick={() => changeGrant(link, grantScope)}>{grantScope === "observe" ? "Observe" : "Control"}</button>)}
      </div>}</div>)}
      {!loading && snapshot && !snapshot.sessions.length && <p className="muted">No sessions are linked to this resource.</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {(error || blocked) && <button type="button" role="menuitem" disabled={busy || loading} onClick={() => void refresh(true)}>Refresh paired sessions</button>}
      <div role="separator" className="browser-pair-menu-separator" />
      <button type="button" role="menuitem" aria-haspopup="dialog" disabled={busy || state.sending || state.actionBusy} onClick={openPicker}><FiPlus size={15} aria-hidden="true" />Add a conversation…</button>
      <div role="separator" className="browser-pair-menu-separator" />
      <button type="button" role="menuitem" className="browser-pair-menu-danger" aria-haspopup="dialog" disabled={locked || !snapshot?.sessions.length} onClick={() => { if (snapshot) setConfirmation({ scope, snapshot }); close(false); }}><FiTrash2 size={15} aria-hidden="true" />Clear all links for this resource…</button>
    </div>, document.body)}
    {picker === scope && enabled && <ShellDialog title="Add paired conversation" subtitle={`Choose a conversation to add to ${tabName}. Existing links will be kept.`} close={() => setPicker(null)} restoreFocus={restoreFocus} className="browser-pair-picker">
      <ConversationSidebarList state={state} model={model} mode="chat" selectedId={pairedSessionId ?? null} onSelect={id => {
        if (currentProps.current.scope !== scope || !targetCurrent() || !canPairBrowserConversation(store.snapshot(), catalog.snapshot(), id)) { setError("The resource or conversation changed. Close the picker and select an available conversation again."); return; }
        setPicker(null); currentProps.current.props.addSession(id);
      }} />
      {error && <p className="notice error" role="alert">{error}</p>}
    </ShellDialog>}
    {confirmation?.scope === scope && enabled && <ShellDialog title="Clear paired sessions for this resource?" close={() => { if (!inFlight.current) setConfirmation(null); }} closeDisabled={busy} restoreFocus={restoreFocus}>
      <p>Remove all {confirmation.snapshot.sessions.length} links from <strong>{tabName}</strong>? Conversations and links to other resources are unchanged.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="browser-pair-menu-confirm"><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className="primary-button" disabled={locked} onClick={clearAll}>{busy ? "Clearing…" : "Clear links"}</button></div>
    </ShellDialog>}
  </>;
  return { button, overlays, openPicker, enabled, target, targetLabel: tabName };
}
