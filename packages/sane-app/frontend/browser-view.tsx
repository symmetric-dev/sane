import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FiExternalLink, FiGlobe, FiGrid, FiInfo, FiPlus, FiRefreshCw, FiX } from "react-icons/fi";
import { browserTabs, browserTabLabel, browserUrl, MAX_BROWSER_TABS, type BrowserTab, type BrowserTabs } from "./browser-tabs";
import { ShellDialog } from "./shell-dialog";
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

export function BrowserSidebar({ onSelect }: { onSelect: () => void }) {
  const { workspaceId, state } = useBrowser();
  return <section className="browser-sidebar" aria-label="Browser tabs">
    <header><h2>Browser tabs</h2><small>{state.tabs.length} / {MAX_BROWSER_TABS}</small></header>
    <p className="muted">URLs saved on this device, per workspace.</p>
    <div className="browser-tab-list" role="tablist" aria-label="Open browser tabs" aria-orientation="vertical">{state.tabs.map((tab, index) => {
      const label = browserTabLabel(tab, index);
      return <div className={`browser-tab-row${state.activeId === tab.id ? " selected" : ""}`} key={tab.id}>
        <button type="button" role="tab" aria-selected={state.activeId === tab.id} aria-controls={`browser-panel-${tab.id}`} title={tab.url || label} onClick={() => {
          if (workspaceId) browserTabs.update(workspaceId, current => ({ ...current, activeId: tab.id }));
          onSelect();
        }} onKeyDown={event => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !workspaceId) return;
          event.preventDefault();
          const next = state.tabs[event.key === "Home" ? 0 : event.key === "End" ? state.tabs.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + state.tabs.length) % state.tabs.length]!;
          browserTabs.update(workspaceId, current => ({ ...current, activeId: next.id }));
          const list = event.currentTarget.closest('[role="tablist"]');
          list?.querySelector<HTMLButtonElement>(`[data-browser-tab="${next.id}"]`)?.focus();
        }} data-browser-tab={tab.id} tabIndex={state.activeId === tab.id ? 0 : -1}><FiGlobe size={15} aria-hidden="true" /><span>{label}</span></button>
        <button type="button" className="icon-button" aria-label={`Close ${label}`} onClick={() => { if (workspaceId) browserTabs.close(workspaceId, tab.id); }}><FiX size={14} aria-hidden="true" /></button>
      </div>;
    })}</div>
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
  return workspaceId && tab ? <BrowserAddress key={JSON.stringify([workspaceId, tab.id])} workspaceId={workspaceId} tab={tab} reload={() => reload(tab.id)} /> : <div className="conversation-heading">Browser <small>Workspace preview</small></div>;
}

export function BrowserFooter({ navigation }: { navigation: ReactNode }) {
  const [limitationsOpen, setLimitationsOpen] = useState(false);
  return <footer className="shell-content-footer browser-footer">
    <button type="button" className="browser-help-button" aria-haspopup="dialog" onClick={() => setLimitationsOpen(true)}><FiInfo size={16} aria-hidden="true" />Preview limitations</button>
    {navigation}
    {limitationsOpen && <ShellDialog title="Preview limitations" close={() => setLimitationsOpen(false)}>
      <ul className="browser-limitations">
        <li>Preview trusted workspace apps only.</li>
        <li>Localhost points to this device, not the SANE server. Use a reachable HTTPS URL for remote access.</li>
        <li>Previews retain the app’s origin for scripts and storage, but sites may still block embedding, third-party cookies or HTTP content inside HTTPS. Use Open externally when a site cannot be embedded.</li>
        <li>The address shows the URL you entered, not navigation inside the page.</li>
      </ul>
    </ShellDialog>}
  </footer>;
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
        {state.tabs.map((item, index) => <BrowserFrame key={item.id} tab={item} label={browserTabLabel(item, index)} visible={multiple || item.id === tab.id} selected={item.id === tab.id} multiple={multiple} visited={visited} reload={reloads[item.id] ?? 0} select={() => browserTabs.update(workspaceId, current => ({ ...current, activeId: item.id }))} />)}
      </div>
    </>}
    {state.storageError && <p className="browser-notice" role="status">{state.storageError}</p>}
  </section>;
}

function BrowserAddress({ workspaceId, tab, reload }: { workspaceId: string; tab: BrowserTab; reload: () => void }) {
  const [draft, setDraft] = useState(tab.url), [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(tab.url); setError(""); if (!tab.url) input.current?.focus(); }, [tab.url]);
  return <form className="browser-address" onSubmit={event => {
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

function BrowserFrame({ tab, label, visible, selected, multiple, visited, reload, select }: { tab: BrowserTab; label: string; visible: boolean; selected: boolean; multiple: boolean; visited: boolean; reload: number; select: () => void }) {
  // Apply the same-origin guard to restored tabs too, not only URL submissions.
  const isSaneOrigin = !!tab.url && new URL(tab.url).origin === window.location.origin;
  return <div className={`browser-frame${selected ? " selected" : ""}`} id={`browser-panel-${tab.id}`} role="tabpanel" aria-label={label} hidden={!visible} inert={!visible}>
    {multiple && <header><button type="button" className="browser-pane-select" aria-pressed={selected} title={tab.url || label} onClick={select}>{label}</button></header>}
    {tab.url && visited && !isSaneOrigin ? <iframe key={JSON.stringify([tab.url, reload, PREVIEW_SANDBOX])} src={tab.url} title={label} sandbox={PREVIEW_SANDBOX} referrerPolicy="no-referrer" /> : <div className="browser-empty"><p>{isSaneOrigin ? "Open SANE itself externally rather than inside its preview." : tab.url ? "Opening preview…" : "Enter a URL above to open this tab."}</p>{multiple && !selected && <button type="button" onClick={select}>Select tab</button>}</div>}
  </div>;
}
