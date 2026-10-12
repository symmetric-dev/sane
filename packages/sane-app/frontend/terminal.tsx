import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { catalog } from "./catalog";
import { worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { subscribeWorkspace, workspaceEpoch, workspaceSnapshot } from "./workspace-store";
import { TerminalSession, emptyTerminal, type TerminalPresentation, type TerminalSelection } from "./terminal-client";
import type { ActiveView } from "./workspace-controller";
import { FiCopy, FiInfo, FiLock, FiRefreshCw, FiTerminal, FiTrash2, FiUnlock } from "react-icons/fi";
import { ShellDialog } from "./shell-dialog";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";

type TerminalContextValue = { selection: TerminalSelection | null; label: string; fullTitle?: string; unavailable: string; host: RefObject<HTMLDivElement | null>; session: RefObject<TerminalSession | null>; presentation: TerminalPresentation };
const TerminalContext = createContext<TerminalContextValue | null>(null);
function useTerminal() { const value = useContext(TerminalContext); if (!value) throw new Error("TerminalProvider is required"); return value; }

export function TerminalProvider({ view, children }: { view: ActiveView; children: ReactNode }) {
  const repository = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  useSyncExternalStore(subscribeWorkspace, workspaceSnapshot);
  const workspace = repository.workspaces.find(w => w.workspaceId === repository.navigation.workspaceId);
  const tree = workspace?.worktrees.find(t => t.worktreeId === repository.navigation.worktreeId);
  const selection = repository.ready && workspace && tree?.state === "available" ? { workspaceId: workspace.workspaceId, worktreeId: tree.worktreeId, bindingRevision: tree.bindingRevision, root: tree.root } : null;
  const key = JSON.stringify([selection?.workspaceId, selection?.worktreeId, selection?.bindingRevision, workspaceEpoch(), view === "terminal"]);
  const identity = useRef(key); identity.current = key;
  const host = useRef<HTMLDivElement>(null), session = useRef<TerminalSession | null>(null);
  const [result, setResult] = useState<{ key: string; value: TerminalPresentation } | null>(null);
  useEffect(() => {
    if (view !== "terminal" || !selection || !host.current) return;
    const owner = new TerminalSession(host.current, selection, value => { if (identity.current === key) setResult({ key, value }); }, () => identity.current === key);
    session.current = owner;
    return () => { session.current = null; owner.dispose(); };
  }, [key]);
  const unavailable = !repository.ready ? repository.error || "Loading workspace selection…" : !workspace || !tree ? "Choose a workspace and worktree above to open its terminal." : tree.state !== "available" ? tree.reason || "This worktree is unavailable. Refresh or select another worktree." : "";
  return <TerminalContext.Provider value={{ selection, label: tree ? worktreeDisplay(tree) : "No worktree selected", fullTitle: tree ? `${worktreeLabel(tree)} · ${tree.root}` : undefined, unavailable, host, session, presentation: result?.key === key ? result.value : emptyTerminal() }}>{children}</TerminalContext.Provider>;
}

export function TerminalHeader() {
  const { selection, label, fullTitle } = useTerminal();
  return <div className="conversation-heading terminal-heading"><span>Terminal</span><small title={fullTitle ?? selection?.root}>{selection ? `Started in: ${label}` : "Select a worktree"}</small></div>;
}

export function TerminalSidebar() {
  const { selection, label } = useTerminal();
  const root = selection?.root;
  const shortRoot = root?.split("/").filter(Boolean).at(-1) || root;
  return <section className="terminal-sidebar" aria-label="Terminal workspace"><p className="eyebrow">WORKTREE TERMINAL</p><h2>{label}</h2>{selection && <p title={root}>{shortRoot}</p>}<p>One terminal per worktree, shared across conversations and devices.</p><p>Leaving this view releases your keyboard. The shell keeps running while the bridge is alive.</p></section>;
}

export function TerminalView({ navigation, exit }: { navigation?: ReactNode; exit?: () => void }) {
  const { selection, unavailable, host, session, presentation: p } = useTerminal();
  const root = useRef<HTMLElement>(null);
  const infoButton = useRef<HTMLButtonElement>(null);
  const [info, setInfo] = useState(false);
  const state = p.state;
  const exists = !!state?.terminalId && state.status !== "absent" && state.status !== "closed";
  const running = state?.status === "running";
  const acceptingInput = running && !state.ptyClosed;
  const status = p.busy ? "Opening terminal…" : !state ? "Terminal" : state.status === "exited" ? `Exited${state.exitCode !== null ? ` · code ${state.exitCode}` : ""}` : state.status === "overloaded" ? "Stopped · output limit reached" : state.status === "closed" ? "Closed" : !exists ? "Not started" : !p.connected ? "Disconnected" : !p.ready ? "Restoring screen…" : state.ptyClosed ? "PTY closed · shell exit pending" : p.controlling ? "Keyboard here" : "Viewing";
  const canAct = !!selection && !!state?.capability.available && !p.busy;
  const canInteract = canAct && acceptingInput && p.connected && p.ready && !p.controlling;
  useEffect(() => {
    if (info) return;
    let released = false;
    const enter = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const region = root.current?.closest(".terminal-composer") ?? root.current;
      if (!target || !region?.contains(target) || target.closest("[hidden], [inert]") || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]') && !target.closest(".xterm")) return;
      if (event.key === "Escape" && (p.controlling || exit)) {
        // Capture before xterm can translate Escape into shell input. Holding
        // the key must not advance from release to exit on an auto-repeat.
        event.preventDefault(); event.stopPropagation();
        if (event.repeat) return;
        if (p.controlling && !released) { released = true; session.current?.release(); root.current?.focus({ preventScroll: true }); }
        else exit?.();
      } else if (event.key === "i" && canInteract && !event.repeat) {
        event.preventDefault(); event.stopPropagation(); session.current?.claim();
      }
    };
    document.addEventListener("keydown", enter, true);
    return () => document.removeEventListener("keydown", enter, true);
  }, [canInteract, info, session, p.controlling, exit]);
  return <section ref={root} className="terminal-view" aria-label="Worktree terminal" tabIndex={0}>
    {!selection ? <div className="terminal-empty"><h2>{unavailable.startsWith("Loading") ? "Opening workspace…" : "Select an available worktree"}</h2><p>{unavailable}</p></div> : <>
      {!exists && <div className="terminal-empty"><h2>{p.busy ? "Opening terminal…" : state?.status === "closed" ? "Terminal closed" : "A shell for this worktree"}</h2><p>{state?.capability.available === false ? state.capability.reason || "Terminal support is unavailable on this bridge." : state?.status === "closed" ? "This terminal was closed. Restart it explicitly to open a new shell." : "Opening this view starts a new shell at the selected worktree root when none exists. Use Start terminal to retry if startup fails."}</p>{state && state.capability.available && <button type="button" disabled={!canAct} onClick={() => void session.current?.action(state.terminalId ? "restart" : "start")}>{state.terminalId ? "Restart terminal" : "Start terminal"}</button>}</div>}
      <div className={`terminal-scroll${exists ? "" : " terminal-dormant"}`} aria-hidden={!exists}><div ref={host} className="terminal-canvas" /></div>
    </>}
    {p.error && <p className="terminal-message error" role="alert">{p.error}</p>}
    {state?.reason && <p className="terminal-message" role="status">{state.reason}</p>}
    <footer className="terminal-local-footer workstream-status-toolbar">
      <div className="terminal-footer-details">
        <span className="terminal-mode" role="status">{p.controlling ? <FiUnlock aria-hidden="true" /> : <FiLock aria-hidden="true" />}{status}</span>
        <button ref={infoButton} type="button" className="text-button" title="Terminal info" aria-label="Terminal info" aria-haspopup="dialog" onClick={() => setInfo(true)}><FiInfo size={15} aria-hidden="true" /></button>
        {p.controlling && <div className="terminal-touch-keys" aria-label="Terminal keys"><button type="button" onClick={() => session.current?.focus()}>Keyboard</button><button type="button" onClick={() => session.current?.interrupt()}>Ctrl C</button>{([["Esc", "\u001b"], ["Tab", "\t"], ["←", "\u001b[D"], ["↓", "\u001b[B"], ["↑", "\u001b[A"], ["→", "\u001b[C"]] as const).map(([label, data]) => <button type="button" key={label} aria-label={label === "Esc" ? "Escape" : label} onClick={() => session.current?.key(data)}>{label}</button>)}</div>}
      </div>
      <div className="terminal-footer-controls">
        <div className="terminal-footer-actions">
          {exists && <button type="button" className="text-button" title="Copy selection" aria-label="Copy selection" disabled={!p.hasSelection} onClick={() => void session.current?.copySelection()}><FiCopy size={15} aria-hidden="true" /></button>}
          {p.copyFeedback && <span role="status">{p.copyFeedback}</span>}
          {acceptingInput && p.ready && (p.controlling ? <button type="button" className="text-button" title="Release keyboard" onClick={() => session.current?.release()}><FiLock aria-hidden="true" />Lock</button> : <button type="button" className="terminal-interact" disabled={!canInteract} title={state.controllerId ? "Take control here (i)" : "Interact (i)"} aria-keyshortcuts="i" onClick={() => session.current?.claim()}><FiTerminal aria-hidden="true" />Interact<kbd>i</kbd></button>)}
          {exists && !acceptingInput && <button type="button" className="text-button" disabled={!canAct} onClick={() => void session.current?.action("restart")}><FiRefreshCw aria-hidden="true" />Restart</button>}
          {selection && !p.busy && (!p.connected || p.error) && <button type="button" className="text-button" onClick={() => session.current?.reconnect()}><FiRefreshCw aria-hidden="true" />Reconnect</button>}
        </div>
        {navigation && <div className="terminal-footer-navigation">{navigation}</div>}
      </div>
    </footer>
    {info && <ShellDialog title="Terminal info" close={() => setInfo(false)} restoreFocus={() => infoButton.current}><div className="terminal-info">
      <p>One terminal per worktree, shared across conversations and devices.</p>
      <p>{p.controlling ? "Your keyboard controls the shared shell. Escape or Lock releases your keyboard without stopping the shell." : "Viewing does not send input or change terminal size. Press i with the terminal focused to interact."}</p>
      <p>Escape releases keyboard control first. Press Escape again while locked to exit to chat. Use the on-screen Esc key to send Escape to the shell.</p>
      <p>Interact takes keyboard control here, including when another device currently controls the terminal. Leaving this flow releases control; the shell keeps running while the bridge is alive.</p>
      {selection && <p className="muted">Started in: {selection.root}</p>}
      {p.geometry && <p className="muted">Terminal size: {p.geometry.cols} × {p.geometry.rows}</p>}
      {exists && <button type="button" className="text-button" disabled={!canAct} onClick={() => { if (window.confirm("Close this worktree’s terminal for everyone? The shell will be stopped.")) { void session.current?.action("close"); setInfo(false); } }}><FiTrash2 aria-hidden="true" />Close terminal</button>}
    </div></ShellDialog>}
  </section>;
}
