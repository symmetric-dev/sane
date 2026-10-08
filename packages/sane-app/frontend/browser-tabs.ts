export const MAX_BROWSER_TABS = 8;
const STORAGE_PREFIX = "sane.browser.tabs.v1.";
export type BrowserTab = { id: string; url: string };
export type BrowserTabs = { tabs: BrowserTab[]; activeId: string | null; showAll: boolean; storageError: string };
const empty = (): BrowserTabs => ({ tabs: [], activeId: null, showAll: false, storageError: "" });

/** No proxy: addresses are resolved on the device running the frontend. */
export function browserUrl(input: string): string {
  const text = input.trim();
  if (!text || text.length > 4096 || /[\x00-\x20\x7f]/.test(text)) throw new Error("Enter an HTTP or HTTPS URL without spaces.");
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  const hostWithPort = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(text);
  const url = new URL(!hasScheme || hostWithPort ? `http://${text}` : text);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  return url.href;
}

function load(workspaceId: string): BrowserTabs {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_PREFIX + workspaceId) ?? "null");
    if (saved?.version !== 1 || !Array.isArray(saved.tabs) || saved.tabs.length > MAX_BROWSER_TABS) return empty();
    const ids = new Set<string>();
    const tabs: BrowserTab[] = saved.tabs.map((tab: BrowserTab) => {
      if (!tab || typeof tab.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(tab.id) || ids.has(tab.id) || typeof tab.url !== "string") throw new Error("Invalid saved browser tab");
      ids.add(tab.id);
      return { id: tab.id, url: tab.url ? browserUrl(tab.url) : "" };
    });
    return { tabs, activeId: tabs.some(tab => tab.id === saved.activeId) ? saved.activeId : tabs[0]?.id ?? null, showAll: saved.showAll === true, storageError: "" };
  } catch { return empty(); }
}

const states = new Map<string, BrowserTabs>();
const listeners = new Set<() => void>();
const noWorkspace = empty();
export const browserTabs = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot(workspaceId: string | null): BrowserTabs {
    if (!workspaceId) return noWorkspace;
    if (!states.has(workspaceId)) states.set(workspaceId, load(workspaceId));
    return states.get(workspaceId)!;
  },
  update(workspaceId: string, change: (current: BrowserTabs) => BrowserTabs) {
    const next = { ...change(this.snapshot(workspaceId)), storageError: "" };
    try { localStorage.setItem(STORAGE_PREFIX + workspaceId, JSON.stringify({ version: 1, tabs: next.tabs, activeId: next.activeId, showAll: next.showAll })); }
    catch { next.storageError = "Browser storage is unavailable. Tabs will only be remembered until this page reloads."; }
    states.set(workspaceId, next);
    listeners.forEach(listener => listener());
  },
  add(workspaceId: string) {
    this.update(workspaceId, current => {
      if (current.tabs.length >= MAX_BROWSER_TABS) return current;
      const tab = { id: crypto.randomUUID(), url: "" };
      return { ...current, tabs: [...current.tabs, tab], activeId: tab.id };
    });
  },
  close(workspaceId: string, id: string) {
    this.update(workspaceId, current => {
      const index = current.tabs.findIndex(tab => tab.id === id), tabs = current.tabs.filter(tab => tab.id !== id);
      return { ...current, tabs, activeId: current.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id ?? null : current.activeId };
    });
  },
};

export function browserTabLabel(tab: BrowserTab, index: number): string {
  if (!tab.url) return `New tab ${index + 1}`;
  try { const url = new URL(tab.url); return url.host + (url.pathname === "/" ? "" : url.pathname); }
  catch { return `Tab ${index + 1}`; }
}
