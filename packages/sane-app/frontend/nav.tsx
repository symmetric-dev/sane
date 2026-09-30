import { useEffect, useRef, type ReactNode } from "react";
import { FiCode, FiCopy, FiGitBranch, FiGitMerge, FiMessageSquare, FiSettings, FiTerminal } from "react-icons/fi";
import type { State } from "./store";
import type { ActiveView } from "./workspace-controller";
import { active } from "./types";

export function Icon({ name }: { name: "menu" | "plus" | "close" | "send" | "details" | "down" }) {
  const paths = { menu: "M4 6h16M4 12h16M4 18h16", plus: "M12 5v14M5 12h14", close: "m6 6 12 12M6 18 18 6", send: "M12 19V5m-6 6 6-6 6 6", details: "M12 11v6M12 7h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", down: "M12 5v14m-6-6 6 6 6-6" };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function Drawer({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="drawer" onCancel={close} onClick={event => { if (event.target === event.currentTarget) close(); }}><div className="drawer-content"><header><h2>{title}</h2><button type="button" className="icon-button" aria-label={`Close ${title.toLowerCase()}`} onClick={close}><Icon name="close" /></button></header>{children}</div></dialog>;
}

export function WorkspaceNavigation({ state, activeView, onNavigate }: { state: State; activeView: ActiveView; onNavigate: (view: ActiveView) => void }) {
  const pending = state.interactions.length;
  const running = state.sending || state.runs.some(run => active(run.status)) || state.conversations.some(conversation => active(conversation.status));
  const items = [
    { id: "chat", label: "Chat", Icon: FiMessageSquare },
    { id: "code", label: "Code", Icon: FiCode },
    { id: "git", label: "Git", Icon: FiGitBranch },
    { id: "terminal", label: "Terminal", Icon: FiTerminal },
    { id: "workstreams", label: "Workstreams", Icon: FiGitMerge },
    { id: "history", label: "History", Icon: FiCopy },
    { id: "config", label: "Settings", Icon: FiSettings },
  ] as const;
  return <nav className="workspace-navigation" aria-label="Workspace navigation">{items.map(view => <button type="button" key={view.id} aria-current={activeView === view.id ? "page" : undefined} aria-label={view.label} title={view.label} onClick={() => onNavigate(view.id)}><view.Icon size={17} aria-hidden="true" />{view.id === "chat" && (pending > 0 || running) && <span className={`chat-activity${pending ? " pending" : ""}`} role="status"><span className="pulse" />{pending ? `${pending}` : ""}<span className="sr-only">{pending ? `${pending} pending` : "Running"}</span></span>}</button>)}</nav>;
}

export function SidebarFooter({ state, activeView, onNavigate }: { state: State; activeView: ActiveView; onNavigate: (view: ActiveView) => void }) {
  return <footer className="shell-sidebar-footer"><WorkspaceNavigation state={state} activeView={activeView} onNavigate={onNavigate} /></footer>;
}
