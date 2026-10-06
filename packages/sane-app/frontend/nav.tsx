import { useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { FiFileText, FiGitBranch, FiGlobe, FiMessageSquare, FiSearch, FiSettings, FiTerminal } from "react-icons/fi";
import type { State } from "./store";
import type { ActiveView } from "./workspace-controller";
import { active } from "./types";
import { useWorkspaceSearchContext } from "./workspace-search";
import { commandHint, useRegisterCommand } from "./application-commands";
import { NAVIGATION_HOTKEYS, navigationBinding, navigationKeyShortcuts } from "./navigation-hotkeys";

export function Icon({ name }: { name: "menu" | "plus" | "close" | "send" | "details" | "down" }) {
  const paths = { menu: "M4 6h16M4 12h16M4 18h16", plus: "M12 5v14M5 12h14", close: "m6 6 12 12M6 18 18 6", send: "M12 19V5m-6 6 6-6 6 6", details: "M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", down: "M12 5v14m-6-6 6 6 6-6" };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function Drawer({ title, children, close, bare = false }: { title: string; children: ReactNode; close: () => void; bare?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous?.isConnected && !previous.closest("[hidden], [inert]")) previous.focus();
    };
  }, []);
  return <dialog ref={ref} className="drawer" aria-modal="true" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="drawer-content">{bare ? <h2 id={titleId} className="sr-only">{title}</h2> : <header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={close}><Icon name="close" /></button></header>}{children}</div></dialog>;
}

export type ViewGroup = "chat" | "files" | "settings" | "browser";
export function viewGroup(view: ActiveView): ViewGroup {
  switch (view) {
    case "code": case "git": return "files";
    case "config": case "workstreams": return "settings";
    case "browser": return "browser";
    default: return "chat";
  }
}

const DESTINATION_ICONS = { chat: FiMessageSquare, terminal: FiTerminal, code: FiFileText, browser: FiGlobe, config: FiSettings };
const DESTINATIONS = NAVIGATION_HOTKEYS.map(item => ({ ...item, Icon: DESTINATION_ICONS[item.id] }));

/** Register once at the shell level, including destinations whose button is hidden. */
export function ViewNavigationCommands({ onNavigate }: { onNavigate: (view: ActiveView) => void }) {
  return <>{DESTINATIONS.map(destination => <ViewNavigationCommand key={destination.id} destination={destination} onNavigate={onNavigate} />)}</>;
}

function ViewNavigationCommand({ destination, onNavigate }: { destination: typeof DESTINATIONS[number]; onNavigate: (view: ActiveView) => void }) {
  useRegisterCommand(useMemo(() => ({
    id: `navigation.${destination.id}`, label: destination.label, binding: navigationBinding(destination.key), scope: { kind: "global" } as const,
    contexts: ["application", "input", "editor", "terminal"] as const,
    available: () => true, action: () => onNavigate(destination.id),
  }), [destination, onNavigate]));
  return null;
}

/** Presentation only: keep the persisted leaf IDs and feature-owned state. */
export function contextualDestinations(view: ActiveView) {
  const current = view === "git" ? "code" : view === "workstreams" ? "config" : view;
  return DESTINATIONS.filter(item => item.id !== current);
}

export function ContextualNavigation({ state, activeView, onNavigate }: { state: State; activeView: ActiveView; onNavigate: (view: ActiveView) => void }) {
  const pending = state.interactions.length;
  const running = state.sending || state.runs.some(run => active(run.status)) || state.conversations.some(conversation => active(conversation.status));
  return <nav className="contextual-navigation" aria-label="View navigation">{contextualDestinations(activeView).map(item => {
    const openChat = item.id === "chat" && (activeView === "terminal" || activeView === "history");
    const label = openChat ? "Open Chat" : item.label;
    return <button type="button" key={item.id} aria-label={label} title={`${label} (${commandHint(navigationBinding(item.key))})`} aria-keyshortcuts={navigationKeyShortcuts(item.key)} onClick={() => onNavigate(item.id)}><item.Icon size={17} aria-hidden="true" />{openChat && <span className="navigation-label">{label}</span>}{item.id === "chat" && (pending > 0 || running) && <span className={`chat-activity${pending ? " pending" : ""}`} role="status"><span className="pulse" />{pending ? `${pending}` : ""}<span className="sr-only">{pending ? `${pending} pending` : "Running"}</span></span>}</button>;
  })}</nav>;
}

export function FilesModeControl({ activeView, onNavigate }: { activeView: ActiveView; onNavigate: (view: ActiveView) => void }) {
  const search = useWorkspaceSearchContext();
  return <nav className={`sidebar-mode-control${search ? " workspace-search-modes" : ""}`} aria-label="Files views">
    <button type="button" aria-pressed={activeView === "code" && search?.mode !== "search"} onClick={() => search?.available ? search.files() : onNavigate("code")}><FiFileText size={15} aria-hidden="true" />Files</button>
    {search && <button type="button" aria-pressed={activeView === "code" && search.mode === "search"} disabled={!search.available} onClick={search.enter}><FiSearch size={15} aria-hidden="true" />Search</button>}
    <button type="button" aria-pressed={activeView === "git"} onClick={() => onNavigate("git")}><FiGitBranch size={15} aria-hidden="true" />Git</button>
  </nav>;
}
