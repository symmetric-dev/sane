import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { FiExternalLink, FiGlobe, FiGrid, FiPlus, FiRefreshCw, FiX } from "react-icons/fi";
import { browserTabs, browserTabLabel, browserUrl, MAX_BROWSER_TABS, type BrowserTab, type BrowserTabs } from "./browser-tabs";
import { ShellDialog } from "./shell-dialog";
import { BrowserHostViewerClient, emptyHostPresentation, hostBrowserTabs, listHostBrowserGrants } from "./browser-host-client";
import { BrowserDiagnosticsPanel } from "./browser-diagnostics-panel";
import type { BrowserKeyEventInput, BrowserPointerEventInput } from "../shared/browser-host-contract";
import "./browser.css";

// App previews need their own origin for module scripts, API calls and storage.
// Other sandbox restrictions remain; preview only trusted workspace apps.
const PREVIEW_SANDBOX = "allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

const BrowserContext = createContext<{ workspaceId: string | null; state: BrowserTabs; reloads: Record<string, number>; reload: (tabId: string) => void } | null>(null);
function useBrowser() {
  const context = useContext(BrowserContext);
  if (!context) throw new Error("BrowserProvider is required");
  return context;
}
export function BrowserProvider({ workspaceId, children }: { workspaceId: string | null; children: ReactNode }) {
  const state = useSyncExternalStore(browserTabs.subscribe, () => browserTabs.snapshot(workspaceId));
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const reload = (tabId: string) => setReloads(current => ({ ...current, [tabId]: (current[tabId] ?? 0) + 1 }));
  return <BrowserContext.Provider value={{ workspaceId, state, reloads, reload }}>{children}</BrowserContext.Provider>;
}

/** Render alongside BrowserHeader in the shell's single browser toolbar. */
export function BrowserTabStrip({ onSelect }: { onSelect?: () => void }) {
  const { workspaceId, state } = useBrowser();
  const atLimit = state.tabs.length >= MAX_BROWSER_TABS;
  const newTabLabel = !workspaceId ? "Select a workspace to open a tab" : atLimit ? `Tab limit reached (${MAX_BROWSER_TABS}). Close a tab to open another.` : "New tab";
  const layoutLabel = state.showAll ? "Show selected tab" : "View all tabs";
  return <section className="browser-tab-strip" aria-label="Browser tabs">
    <BrowserTabList orientation="horizontal" onSelect={onSelect} />
    <div className="browser-tab-actions">
      <button type="button" className="browser-new-tab" aria-label={newTabLabel} title={newTabLabel} disabled={!workspaceId || atLimit} onClick={() => {
        if (workspaceId) browserTabs.add(workspaceId);
        onSelect?.();
      }}><FiPlus size={16} aria-hidden="true" /></button>
      <button type="button" className="browser-layout-toggle" aria-label={layoutLabel} title={layoutLabel} aria-pressed={state.showAll} disabled={!workspaceId || state.tabs.length < 2} onClick={() => {
        if (workspaceId) browserTabs.update(workspaceId, current => ({ ...current, showAll: !current.showAll }));
        onSelect?.();
      }}><FiGrid size={16} aria-hidden="true" /></button>
      <small className="browser-tab-count" aria-label={`${state.tabs.length} of ${MAX_BROWSER_TABS} browser tabs open`} title={atLimit ? newTabLabel : `Up to ${MAX_BROWSER_TABS} tabs`}>{state.tabs.length} / {MAX_BROWSER_TABS}</small>
    </div>
    {atLimit && <span className="sr-only" role="status">Close a tab to open another.</span>}
  </section>;
}

function BrowserTabList({ orientation, onSelect }: { orientation: "horizontal" | "vertical"; onSelect?: () => void }) {
  const { workspaceId, state } = useBrowser();
  const list = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<{ workspaceId: string; tabId: string } | null>(null);
  const renameTab = renaming?.workspaceId === workspaceId ? state.tabs.find(tab => tab.id === renaming.tabId) : undefined;
  useEffect(() => { setRenaming(null); }, [workspaceId]);
  useLayoutEffect(() => {
    if (!restoreFocus.current) return;
    const focusWorkspace = restoreFocus.current;
    restoreFocus.current = null;
    if (focusWorkspace !== workspaceId) return;
    const target = state.activeId ? list.current?.querySelector<HTMLButtonElement>(`[data-browser-tab="${state.activeId}"]`) : list.current?.closest(".browser-tab-strip, .browser-sidebar")?.querySelector<HTMLButtonElement>(".browser-new-tab");
    target?.focus({ preventScroll: true });
  }, [workspaceId, state.tabs, state.activeId]);
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>(`[data-browser-tab="${state.activeId}"]`)?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [workspaceId, state.activeId, state.tabs]);
  return <><div ref={list} className="browser-tab-list" role="tablist" aria-label="Open browser tabs" aria-orientation={orientation}>{state.tabs.map((tab, index) => {
    const label = browserTabLabel(tab, index);
    const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    return <div className={`browser-tab-row${state.activeId === tab.id ? " selected" : ""}`} role="presentation" key={tab.id}>
      <button type="button" role="tab" aria-selected={state.activeId === tab.id} aria-controls={`browser-panel-${tab.id}`} aria-description={state.activeId === tab.id ? "Tap or click to rename this tab." : undefined} aria-haspopup={state.activeId === tab.id ? "dialog" : undefined} title={`${tab.url || label}${state.activeId === tab.id ? "\nTap or click to rename tab" : ""}`} onClick={() => {
        if (!workspaceId) return;
        if (state.activeId === tab.id) {
          setRenaming({ workspaceId, tabId: tab.id });
          return;
        }
        browserTabs.update(workspaceId, current => ({ ...current, activeId: tab.id }));
        onSelect?.();
      }} onKeyDown={event => {
        // Keep navigation on the tab itself: sibling close buttons are ordinary buttons.
        if (![previousKey, nextKey, "Home", "End"].includes(event.key) || !workspaceId || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        const next = state.tabs[event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1 : (index + (event.key === nextKey ? 1 : -1) + state.tabs.length) % state.tabs.length]!;
        browserTabs.update(workspaceId, current => ({ ...current, activeId: next.id }));
        list.current?.querySelector<HTMLButtonElement>(`[data-browser-tab="${next.id}"]`)?.focus({ preventScroll: true });
      }} data-browser-tab={tab.id} tabIndex={state.activeId === tab.id ? 0 : -1}><FiGlobe size={15} aria-hidden="true" /><span>{label}</span></button>
      <button type="button" className="icon-button" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => {
        if (!workspaceId) return;
        restoreFocus.current = workspaceId;
        browserTabs.close(workspaceId, tab.id);
      }}><FiX size={14} aria-hidden="true" /></button>
    </div>;
  })}</div>
    {workspaceId && renameTab && <BrowserRenameDialog key={JSON.stringify([workspaceId, renameTab.id])} workspaceId={workspaceId} tab={renameTab} close={() => setRenaming(null)} />}
  </>;
}

function BrowserRenameDialog({ workspaceId, tab, close }: { workspaceId: string; tab: BrowserTab; close: () => void }) {
  const [alias, setAlias] = useState(tab.alias ?? "");
  const input = useRef<HTMLInputElement>(null);
  return <ShellDialog title="Rename tab" close={close} className="browser-rename-dialog" initialFocus={() => input.current}>
    <form onSubmit={event => {
      event.preventDefault();
      browserTabs.update(workspaceId, current => ({ ...current, tabs: current.tabs.map(item => item.id === tab.id ? { ...item, alias: alias.trim() || undefined } : item) }));
      close();
    }}>
      <label htmlFor={`browser-alias-${tab.id}`}>Tab name</label>
      <input ref={input} id={`browser-alias-${tab.id}`} value={alias} onChange={event => setAlias(event.target.value)} onFocus={event => event.currentTarget.select()} maxLength={80} placeholder="Use the URL as the tab name" autoComplete="off" aria-describedby={`browser-alias-help-${tab.id}`} />
      <p id={`browser-alias-help-${tab.id}`} className="muted">Leave blank to restore the URL-based name.</p>
      <div className="browser-rename-actions"><button type="button" onClick={close}>Cancel</button><button type="submit" className="primary-button">Save</button></div>
    </form>
  </ShellDialog>;
}

export function BrowserSidebar({ onSelect }: { onSelect: () => void }) {
  const { workspaceId, state } = useBrowser();
  return <section className="browser-sidebar" aria-label="Browser tabs">
    <header><h2>Browser tabs</h2><small>{state.tabs.length} / {MAX_BROWSER_TABS}</small></header>
    <p className="muted">URLs saved on this device, per workspace.</p>
    <BrowserTabList orientation="vertical" onSelect={onSelect} />
    <button type="button" className="browser-new-tab" disabled={!workspaceId || state.tabs.length >= MAX_BROWSER_TABS} onClick={() => {
      if (workspaceId) browserTabs.add(workspaceId);
      onSelect();
    }}><FiPlus size={16} aria-hidden="true" />New tab</button>
    {state.tabs.length >= MAX_BROWSER_TABS && <small className="muted">Close a tab to open another.</small>}
    <button type="button" className="browser-layout-toggle" aria-pressed={state.showAll} disabled={state.tabs.length < 2} onClick={() => {
      if (workspaceId) browserTabs.update(workspaceId, current => ({ ...current, showAll: !current.showAll }));
      onSelect();
    }}><FiGrid size={16} aria-hidden="true" />{state.showAll ? "Show selected tab" : "View all tabs"}</button>
  </section>;
}

export function BrowserHeader() {
  const { workspaceId, state, reload } = useBrowser();
  const tab = state.tabs.find(item => item.id === state.activeId);
  return workspaceId && tab ? <div className="browser-mode-address" key={JSON.stringify([workspaceId, tab.id])}>
    <BrowserModeSwitch workspaceId={workspaceId} tab={tab} />
    {(tab.mode ?? "device") === "device" ? <BrowserAddress workspaceId={workspaceId} tab={tab} tabCount={state.tabs.length} reload={() => reload(tab.id)} /> : <span className="browser-locality">Host browser · 1280×800</span>}
  </div> : <div className="conversation-heading">Browser <small>Workspace preview</small></div>;
}

function BrowserModeSwitch({ workspaceId, tab }: { workspaceId: string; tab: BrowserTab }) {
  const [disclosure, setDisclosure] = useState(false);
  const change = (mode: "device" | "host") => browserTabs.update(workspaceId, current => ({ ...current, tabs: current.tabs.map(item => item.id === tab.id ? { ...item, mode } : item) }));
  return <>
    <select className="browser-mode-switch" aria-label="Browser mode" value={tab.mode ?? "device"} onChange={event => { if (event.target.value === "host") setDisclosure(true); else change("device"); }}><option value="device">Device preview</option><option value="host">Host browser</option></select>
    {(tab.mode ?? "device") === "device" && <button type="button" className="browser-open-host" onClick={() => setDisclosure(true)}>Open in Host Browser</button>}
    {disclosure && <ShellDialog title="Open URL in Host Browser" close={() => setDisclosure(false)}>
      <p>Host browser starts a fresh Chromium session on the SANE host, where localhost resolves on the host—not this device. Client cookies, history, unsaved forms, and DOM state are not transferred.</p>
      <p>An existing host tab is reattached without replacing its live state. If no host tab exists, choose Start Host Tab after switching. Switching back to Device preview does not stop the host tab.</p>
      <div className="browser-rename-actions"><button type="button" onClick={() => setDisclosure(false)}>Cancel</button><button type="button" className="primary-button" onClick={() => { change("host"); setDisclosure(false); }}>Switch to Host browser</button></div>
    </ShellDialog>}
  </>;
}

export function BrowserView({ active }: { active: boolean }) {
  const { workspaceId, state, reloads } = useBrowser();
  // Lazily load frames, then preserve their DOM while visiting other main views.
  const [visited, setVisited] = useState(false);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  const tab = state.tabs.find(item => item.id === state.activeId);
  const multiple = state.showAll && state.tabs.length > 1;
  return <section className="browser-view" aria-label="Workspace browser" hidden={!active} inert={!active}>
    {!workspaceId ? <div className="browser-empty"><h2>Select a workspace</h2><p>Choose a workspace above to open and remember its browser tabs.</p></div> : !tab ? <div className="browser-empty"><FiGlobe size={32} aria-hidden="true" /><h2>A browser for this workspace</h2><p>Open a local app or Tailscale HTTPS URL. Up to {MAX_BROWSER_TABS} tabs can stay open.</p><button type="button" className="primary-button" onClick={() => browserTabs.add(workspaceId)}>New tab</button></div> : <>
      <div className={`browser-frames${multiple ? " browser-frames-grid" : ""}`}>
        {state.tabs.map((item, index) => <BrowserFrame key={JSON.stringify([workspaceId, item.id])} workspaceId={workspaceId} active={active} tab={item} label={browserTabLabel(item, index)} visible={multiple || item.id === tab.id} selected={item.id === tab.id} multiple={multiple} visited={visited} reload={reloads[item.id] ?? 0} select={() => browserTabs.update(workspaceId, current => ({ ...current, activeId: item.id }))} />)}
      </div>
    </>}
    {state.storageError && <p className="browser-notice" role="status">{state.storageError}</p>}
  </section>;
}

function BrowserAddress({ workspaceId, tab, tabCount, reload }: { workspaceId: string; tab: BrowserTab; tabCount: number; reload: () => void }) {
  const [draft, setDraft] = useState(tab.url), [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setDraft(tab.url); setError("");
    // Selecting a blank tab with the keyboard must not steal the roving tab focus.
    if (!tab.url && !document.activeElement?.hasAttribute("data-browser-tab")) input.current?.focus();
  }, [tab.url]);
  // Keep half the row for one or two tabs, then yield space to additional tabs.
  const width = Math.max(25, 50 - Math.max(0, tabCount - 2) * 5);
  return <form className="browser-address" style={{ flexBasis: `${width}%` }} onSubmit={event => {
    event.preventDefault();
    try {
      const url = browserUrl(draft);
      if (new URL(url).origin === window.location.origin) throw new Error("Open SANE itself externally rather than inside its preview.");
      browserTabs.update(workspaceId, current => ({ ...current, tabs: current.tabs.map(item => item.id === tab.id ? { ...item, url } : item) }));
      setDraft(url); setError("");
    } catch (problem) { setError(problem instanceof Error && problem.message !== "Invalid URL" ? problem.message : "Enter a valid HTTP or HTTPS URL."); }
  }}>
    <label className="sr-only" htmlFor={`browser-url-${tab.id}`}>Browser URL</label>
    <input ref={input} id={`browser-url-${tab.id}`} value={draft} onChange={event => { setDraft(event.target.value); setError(""); }} maxLength={4096} placeholder="http://localhost:3000 or https://…" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!error} aria-describedby={error ? `browser-error-${tab.id}` : undefined} />
    <button type="submit" className="primary-button">Go</button>
    {tab.url && <a className="browser-external" href={tab.url} target="_blank" rel="noopener noreferrer" aria-label="Open externally" title="Open externally"><FiExternalLink size={17} aria-hidden="true" /></a>}
    <button type="button" className="icon-button browser-refresh" aria-label="Refresh preview" title="Refresh preview" disabled={!tab.url || new URL(tab.url).origin === window.location.origin} onClick={reload}><FiRefreshCw size={17} aria-hidden="true" /></button>
    {error && <p className="browser-address-error" id={`browser-error-${tab.id}`} role="alert">{error}</p>}
  </form>;
}

function BrowserFrame({ workspaceId, active, tab, label, visible, selected, multiple, visited, reload, select }: { workspaceId: string; active: boolean; tab: BrowserTab; label: string; visible: boolean; selected: boolean; multiple: boolean; visited: boolean; reload: number; select: () => void }) {
  // Apply the same-origin guard to restored tabs too, not only URL submissions.
  const isSaneOrigin = !!tab.url && new URL(tab.url).origin === window.location.origin;
  return <div className={`browser-frame${selected ? " selected" : ""}`} id={`browser-panel-${tab.id}`} role="tabpanel" aria-label={label} hidden={!visible} inert={!visible}>
    {multiple && <header><button type="button" className="browser-pane-select" aria-pressed={selected} title={tab.url || label} onClick={select}>{label}</button></header>}
    {tab.mode === "host" && visited ? <HostBrowserFrame workspaceId={workspaceId} tab={tab} visible={active && visible} /> : tab.url && visited && !isSaneOrigin ? <iframe key={JSON.stringify([tab.url, reload, PREVIEW_SANDBOX])} src={tab.url} title={label} sandbox={PREVIEW_SANDBOX} referrerPolicy="no-referrer" /> : <div className="browser-empty"><p>{isSaneOrigin ? "Open SANE itself externally rather than inside its preview." : tab.url ? "Opening preview…" : "Enter a URL above to open this tab."}</p>{multiple && !selected && <button type="button" onClick={select}>Select tab</button>}</div>}
  </div>;
}

const inputModifiers = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
function browserKey(event: KeyboardEvent, type: BrowserKeyEventInput["type"]): BrowserKeyEventInput {
  const text = type === "keyDown" && !event.ctrlKey && !event.metaKey && !event.altKey ? event.key.length === 1 ? event.key : event.key === "Enter" ? "\r" : undefined : undefined;
  return { type, key: event.key, code: event.code, text, modifiers: inputModifiers(event), windowsVirtualKeyCode: event.keyCode, location: event.location, autoRepeat: event.repeat };
}
function HostBrowserFrame({ workspaceId, tab, visible }: { workspaceId: string; tab: BrowserTab; visible: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null), keyboard = useRef<HTMLTextAreaElement>(null), viewer = useRef<BrowserHostViewerClient | null>(null);
  const shown = useRef(visible); shown.current = visible;
  const [presentation, setPresentation] = useState(emptyHostPresentation), [diagnostics, setDiagnostics] = useState(false), [draft, setDraft] = useState(tab.url), [addressError, setAddressError] = useState("");
  const [grantError, setGrantError] = useState("");
  const [dismissedDialog, setDismissedDialog] = useState(""), [dismissedPopup, setDismissedPopup] = useState(""), [resumeSession, setResumeSession] = useState("");
  const composing = useRef(false), committed = useRef("");
  const host = useSyncExternalStore(hostBrowserTabs.subscribe, () => hostBrowserTabs.snapshot(workspaceId, tab.id));
  const state = presentation.state;
  const own = !!presentation.attachmentId && state?.control.controllerAttachmentId === presentation.attachmentId;
  const other = !!state?.control.controllerAttachmentId && !own;
  const running = state?.status === "running", interactive = !!running && presentation.connected && !other;
  const controlGrants = host.grants.filter(grant => grant.scope === "control");
  const resumeId = controlGrants.some(grant => grant.sessionId === resumeSession) ? resumeSession : controlGrants[0]?.sessionId ?? "";
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const client = new BrowserHostViewerClient(element, workspaceId, tab.id, setPresentation); viewer.current = client; client.setVisibility(shown.current);
    const wheel = (event: WheelEvent) => {
      if (!client.canInput()) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (element.clientHeight || 800) : 1;
      client.sendWheel({ ...client.point(event.clientX, event.clientY), deltaX: event.deltaX * scale, deltaY: event.deltaY * scale, modifiers: inputModifiers(event) });
    };
    const touch = (event: TouchEvent) => {
      if (!client.canInput()) return;
      event.preventDefault();
      const points = [...event.touches].map(point => ({ ...client.point(point.clientX, point.clientY), id: point.identifier, force: point.force }));
      if (event.type === "touchend" || event.type === "touchcancel") {
        client.sendTouch({ type: event.type === "touchend" ? "touchEnd" : "touchCancel", touchPoints: [], modifiers: inputModifiers(event) });
        if (points.length && event.type === "touchend") client.sendTouch({ type: "touchStart", touchPoints: points, modifiers: inputModifiers(event) });
      } else client.sendTouch({ type: event.type === "touchstart" ? "touchStart" : "touchMove", touchPoints: points, modifiers: inputModifiers(event) });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) element.addEventListener(name, touch as EventListener, { passive: false });
    return () => {
      client.dispose(); if (viewer.current === client) viewer.current = null;
      element.removeEventListener("wheel", wheel);
      for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"]) element.removeEventListener(name, touch as EventListener);
    };
  }, [workspaceId, tab.id]);
  useEffect(() => { viewer.current?.setVisibility(visible); }, [visible]);
  useEffect(() => { if (state?.url && state.status !== "absent") setDraft(state.url); }, [state?.url, state?.status]);
  useEffect(() => {
    if (!visible || !running) return;
    const controller = new AbortController();
    const refresh = () => { void listHostBrowserGrants(workspaceId, tab.id, controller.signal).then(() => {
      if (!controller.signal.aborted) setGrantError("");
    }).catch(failure => { if (!controller.signal.aborted) setGrantError(failure instanceof Error ? failure.message : "Could not load host browser grants."); }); };
    refresh(); const timer = setInterval(refresh, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [workspaceId, tab.id, visible, running]);
  const pointer = (event: PointerEvent<HTMLCanvasElement>, type: BrowserPointerEventInput["type"]) => {
    const client = viewer.current;
    if (!client?.canInput() || event.pointerType === "touch") return;
    event.preventDefault();
    if (type === "mousePressed") { event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId); }
    client.sendPointer({ type, ...client.point(event.clientX, event.clientY), button: type === "mouseMoved" ? "none" : (["left", "middle", "right", "back", "forward"] as const)[event.button] ?? "left", buttons: event.buttons, modifiers: inputModifiers(event), clickCount: Math.min(3, Math.max(1, event.detail)), pointerType: event.pointerType === "pen" ? "pen" : "mouse" });
  };
  const key = (event: KeyboardEvent, type: BrowserKeyEventInput["type"], textHelper = false) => {
    if (!viewer.current?.canInput() || event.nativeEvent.isComposing || event.key === "Process" || event.key === "Unidentified") return;
    event.stopPropagation();
    if (textHelper && (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey || event.key === "Dead")) return;
    event.preventDefault(); viewer.current.sendKey(browserKey(event, type));
  };
  const status = !state || state.status !== "running" ? "Stopped / Crashed" : state.control.mode === "paused" ? "Agent paused" : state.control.mode === "agent-owned" ? "Agent control" : own ? "Human control (you)" : other ? "Human control (other viewer)" : "Human control (unclaimed)";
  return <div className="browser-host-view">
    <form className="browser-host-toolbar" onSubmit={event => {
      event.preventDefault();
      try { const url = draft === "about:blank" ? draft : browserUrl(draft); if (new URL(url).origin === location.origin) throw new Error("Navigation to the App control origin is blocked."); viewer.current?.sendNavigate("url", url); setAddressError(""); }
      catch (failure) { setAddressError(failure instanceof Error ? failure.message : "Enter a valid URL."); }
    }}>
      <span className="browser-locality">Host browser · 1280×800</span>
      <button type="button" aria-label="Back" disabled={!interactive} onClick={() => viewer.current?.sendNavigate("back")}>←</button><button type="button" aria-label="Forward" disabled={!interactive} onClick={() => viewer.current?.sendNavigate("forward")}>→</button><button type="button" aria-label="Reload host tab" disabled={!interactive} onClick={() => viewer.current?.sendNavigate("reload")}><FiRefreshCw aria-hidden="true" /></button>
      <input aria-label="Host browser URL" value={draft} maxLength={4096} onChange={event => setDraft(event.target.value)} inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!addressError} />
      <button type="submit" disabled={!interactive}>Go</button><button type="button" aria-expanded={diagnostics} onClick={() => setDiagnostics(value => !value)}>Diagnostics</button>
    </form>
    <div className="browser-host-controls">
      <strong role="status">{status}{presentation.connected ? "" : running ? " · disconnected" : ""}</strong>
      {running && <>
        {own ? <button type="button" disabled={!presentation.connected} onClick={() => viewer.current?.release()}>Release</button> : <button type="button" disabled={!presentation.connected} onClick={() => other ? viewer.current?.take() : viewer.current?.claim()}>{other ? "Take control" : "Claim control"}</button>}
        {state.control.mode === "agent-owned" && <><button type="button" disabled={!interactive} onClick={() => viewer.current?.pauseAgent()}>Pause agent</button><button type="button" disabled={!presentation.connected} onClick={() => viewer.current?.take()}>Take over</button></>}
        {(state.control.mode === "paused" || state.control.pausedByHuman) && !!controlGrants.length && <>
          <select aria-label="Session to resume" value={resumeId} onChange={event => setResumeSession(event.target.value)}>{controlGrants.map(grant => <option key={grant.sessionId} value={grant.sessionId}>{grant.harness} · {grant.sessionId.slice(0, 8)}</option>)}</select>
          <button type="button" disabled={!interactive || !resumeId || !!grantError} onClick={() => viewer.current?.resumeAgent(resumeId)}>Resume agent</button>
        </>}
        <button type="button" disabled={!interactive || !presentation.ready} onPointerDown={event => event.preventDefault()} onClick={() => keyboard.current?.focus({ preventScroll: true })}>Keyboard / IME</button>
        <button type="button" disabled={presentation.busy} onClick={() => void viewer.current?.action("close")}>Stop Host Tab</button>
      </>}
      {state?.status === "absent" && <button type="button" disabled={presentation.busy || !state.capability.available} onClick={() => {
        try { const url = !draft.trim() ? undefined : draft === "about:blank" ? draft : browserUrl(draft); setAddressError(""); void viewer.current?.action("start", url); }
        catch (failure) { setAddressError(failure instanceof Error ? failure.message : "Enter a valid URL."); }
      }}>Start Host Tab</button>}
      {(state?.status === "crashed" || state?.status === "closed") && <button type="button" disabled={presentation.busy || !state.capability.available} onClick={() => {
        try { const url = !draft.trim() ? undefined : draft === "about:blank" ? draft : browserUrl(draft); setAddressError(""); void viewer.current?.action("restart", url); }
        catch (failure) { setAddressError(failure instanceof Error ? failure.message : "Enter a valid URL."); }
      }}>Restart Tab</button>}
      <button type="button" disabled={presentation.busy} onClick={() => void viewer.current?.refresh()}>Refresh status</button>
    </div>
    {(presentation.busy || state?.status === "starting") && <p className="browser-host-banner" role="status">Opening host browser…</p>}
    {(state?.reason || !state?.capability.available && state?.capability.reason) && <p className="browser-host-banner" role="status">{state?.reason || state?.capability.reason}</p>}
    {(presentation.error || addressError || grantError) && <p className="browser-host-banner" role="alert">{addressError || presentation.error || grantError}</p>}
    {state?.lastDialog && dismissedDialog !== state.lastDialog.dismissedAt && <div className="browser-host-banner" role="status"><span>Automatically dismissed {state.lastDialog.type}: {state.lastDialog.message}</span><button type="button" onClick={() => setDismissedDialog(state.lastDialog!.dismissedAt)}>Dismiss</button></div>}
    {state?.lastBlockedPopup && dismissedPopup !== state.lastBlockedPopup.blockedAt && <div className="browser-host-banner" role="status"><span>Blocked popup: {state.lastBlockedPopup.url}</span><button type="button" onClick={() => setDismissedPopup(state.lastBlockedPopup!.blockedAt)}>Dismiss</button></div>}
    <div className="browser-host-content">
      <div className="browser-host-surface" data-interactive={interactive}>
        <canvas ref={canvas} width={1280} height={800} tabIndex={interactive && presentation.ready ? 0 : -1} role="application" aria-label="Shared host browser. Claim or take control to interact. Use Keyboard / IME for text composition." onPointerDown={event => pointer(event, "mousePressed")} onPointerMove={event => pointer(event, "mouseMoved")} onPointerUp={event => pointer(event, "mouseReleased")} onContextMenu={event => event.preventDefault()} onKeyDown={event => key(event, "keyDown")} onKeyUp={event => key(event, "keyUp")} />
        {!running && <div className="browser-host-placeholder">{state?.status === "absent" ? "Start Host Tab to open a fresh host Chromium session." : state?.reason || "Host browser is not running."}</div>}
        <textarea ref={keyboard} className="browser-host-ime" aria-label="Host browser keyboard and IME input" tabIndex={-1} disabled={!interactive} defaultValue={"\u200b"} autoComplete="off" autoCapitalize="none" spellCheck={false} onFocus={event => { const length = event.currentTarget.value.length; event.currentTarget.setSelectionRange(length, length); }} onKeyDown={event => key(event, "keyDown", true)} onKeyUp={event => key(event, "keyUp", true)} onCompositionStart={() => { composing.current = true; committed.current = ""; }} onCompositionEnd={event => {
          composing.current = false; committed.current = event.data;
          if (event.data) viewer.current?.sendKey({ type: "char", text: event.data });
          event.currentTarget.value = "\u200b"; queueMicrotask(() => { committed.current = ""; });
        }} onInput={event => {
          const native = event.nativeEvent as InputEvent;
          if (composing.current || native.isComposing) return;
          const text = native.data ?? event.currentTarget.value.replace(/\u200b/g, "");
          if (native.inputType === "insertLineBreak" || native.inputType === "insertParagraph") { viewer.current?.sendKey({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }); viewer.current?.sendKey({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); }
          else if (text && text !== committed.current) viewer.current?.sendKey({ type: "char", text });
          else if (!text && native.inputType.startsWith("delete")) { viewer.current?.sendKey({ type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }); viewer.current?.sendKey({ type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }); }
          committed.current = ""; event.currentTarget.value = "\u200b";
        }} onBlur={() => { composing.current = false; committed.current = ""; }} />
      </div>
      {diagnostics && <BrowserDiagnosticsPanel workspaceId={workspaceId} tabId={tab.id} generation={state?.generation ?? 0} running={!!running} close={() => setDiagnostics(false)} />}
    </div>
  </div>;
}
