import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { catalog } from "./catalog";
import { worktreeDisplay, worktreeLabel } from "./catalog-selector";
import { subscribeWorkspace, workspaceEpoch, workspaceSnapshot } from "./workspace-store";
import { TerminalSession, emptyTerminal, type TerminalPresentation, type TerminalSelection } from "./terminal-client";
import type { ActiveView } from "./workspace-controller";
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

export function TerminalView() {
  const { selection, unavailable, host, session, presentation: p } = useTerminal();
  const state = p.state;
  const exists = !!state?.terminalId && state.status !== "absent" && state.status !== "closed";
  const running = state?.status === "running";
  const acceptingInput = running && !state.ptyClosed;
  const status = p.busy ? "Opening terminal…" : !state ? "Terminal" : state.status === "exited" ? `Exited${state.exitCode !== null ? ` · code ${state.exitCode}` : ""}` : state.status === "overloaded" ? "Stopped · output limit reached" : state.status === "closed" ? "Closed" : !exists ? "Not started" : !p.connected ? "Disconnected" : !p.ready ? "Restoring screen…" : state.ptyClosed ? "PTY closed · shell exit pending" : p.controlling ? "Keyboard here" : "Viewing";
  const canAct = !!selection && !!state?.capability.available && !p.busy;
  return <section className="terminal-view" aria-label="Worktree terminal">
    {!selection ? <div className="terminal-empty"><h2>{unavailable.startsWith("Loading") ? "Opening workspace…" : "Select an available worktree"}</h2><p>{unavailable}</p></div> : <>
      {!exists && <div className="terminal-empty"><h2>{p.busy ? "Opening terminal…" : state?.status === "closed" ? "Terminal closed" : "A shell for this worktree"}</h2><p>{state?.capability.available === false ? state.capability.reason || "Terminal support is unavailable on this bridge." : "Start explicitly at the selected worktree root. Switching conversations in this worktree returns to the same shell."}</p>{state && state.capability.available && <button type="button" disabled={!canAct} onClick={() => void session.current?.action(state.terminalId ? "restart" : "start")}>{state.terminalId ? "Restart terminal" : "Start terminal"}</button>}</div>}
      <div className={`terminal-scroll${exists ? "" : " terminal-dormant"}`} aria-hidden={!exists}><div ref={host} className="terminal-canvas" /></div>
    </>}
    {p.error && <p className="terminal-message error" role="alert">{p.error}</p>}
    {state?.reason && <p className="terminal-message" role="status">{state.reason}</p>}
    <footer className="terminal-local-footer">
      <span role="status">{status}</span>
      {exists && p.geometry && <span>{p.geometry.cols} × {p.geometry.rows}</span>}
      <div className="terminal-footer-actions">
        {acceptingInput && p.ready && (p.controlling ? <button type="button" onClick={() => session.current?.release()}>Release keyboard</button> : <button type="button" onClick={() => session.current?.claim()}>{state.controllerId ? "Take control here" : "Use keyboard here"}</button>)}
        {exists && !acceptingInput && <button type="button" disabled={!canAct} onClick={() => void session.current?.action("restart")}>Restart terminal</button>}
        {exists && <button type="button" disabled={!canAct} onClick={() => { if (window.confirm("Close this worktree’s terminal for everyone? The shell will be stopped.")) void session.current?.action("close"); }}>Close terminal</button>}
        {selection && !p.busy && (!p.connected || p.error) && <button type="button" onClick={() => session.current?.reconnect()}>Reconnect</button>}
      </div>
      {p.controlling && <div className="terminal-touch-keys" aria-label="Terminal keys"><button type="button" onClick={() => session.current?.focus()}>Keyboard</button><button type="button" onClick={() => session.current?.interrupt()}>Ctrl C</button>{([["Esc", "\u001b"], ["Tab", "\t"], ["←", "\u001b[D"], ["↓", "\u001b[B"], ["↑", "\u001b[A"], ["→", "\u001b[C"]] as const).map(([label, data]) => <button type="button" key={label} aria-label={label === "Esc" ? "Escape" : label} onClick={() => session.current?.key(data)}>{label}</button>)}</div>}
      <span className="terminal-policy">One terminal per worktree · {p.controlling ? "Your keyboard controls the shared shell." : "Viewing does not send input or change terminal size."}</span>
    </footer>
  </section>;
}
