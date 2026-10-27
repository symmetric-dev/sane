import { BrowserControlBroker } from "./browser-control-broker";
import { BrowserDiagnostics, sanitizeBrowserUrl, type BrowserDiagnosticsCdp } from "./browser-diagnostics";
import { BrowserGrantRegistry } from "./browser-grant-registry";
import { BROWSER_LIMITS as L, validateBrowserNavigationUrl, type BrowserTabState as TabState, type BrowserTabStatus } from "../../shared/browser-host-contract";
import type { ChromiumSupervisor } from "./chromium-supervisor";

export type BrowserTabLifecycle = BrowserTabStatus;
export type BrowserTabState = TabState & {
  cdpSessionId: string | null;
  lastBlockedNavigation?: { url: string; timestamp: string };
};
type Tab = { state: BrowserTabState; broker: BrowserControlBroker; diagnostics?: BrowserDiagnostics; cleanups: Set<() => void>; sessions: Set<string>; sessionCleanups: Map<string, () => void>; sessionTargets: Map<string, string>; targets: Set<string>; frameId?: string; navigationUrl: string; targetClosed: boolean };
type Workspace = { workspaceId: string; browserContextId?: string; ready: Promise<string>; viewerCount: number; activeGrantCount: number; idleSince: number | null; closing: boolean };
export type BrowserContextRegistryOptions = {
  cdp: BrowserDiagnosticsCdp;
  publicOrigin: string;
  loopbackOrigin: string;
  grants?: BrowserGrantRegistry;
  onChange?: (state: BrowserTabState) => void;
  onError?: (error: unknown) => void;
  idleTimeoutMs?: number;
  supervisor?: Pick<ChromiumSupervisor, "onCrash" | "start">;
  subscribeSupervisorExit?: (callback: (reason: string) => void) => () => void;
};
export class BrowserContextError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const key = (workspaceId: string, tabId: string) => JSON.stringify([workspaceId, tabId]);
const MAX_WORKSPACES = L.maxWorkspaceContexts, MAX_TABS = L.maxTabsPerWorkspace, IDLE_MS = L.idleContextReclaimMs;

export class BrowserContextRegistry {
  private cdp: BrowserDiagnosticsCdp;
  private readonly workspaces = new Map<string, Workspace>();
  private readonly tabs = new Map<string, Tab>();
  private readonly transitions = new Set<string>();
  private readonly cleanups: (() => void)[] = [];
  private readonly connectionCleanups: (() => void)[] = [];
  private readonly blockedOrigins = new Set<string>();
  private readonly blockedPopupTargets = new Set<string>();
  private readonly loopbackPort: string;
  private readonly idleTimeoutMs: number;
  private idleTimer?: ReturnType<typeof setInterval>;
  private disposed = false;
  constructor(private readonly options: BrowserContextRegistryOptions) {
    this.cdp = options.cdp;
    const publicUrl = new URL(options.publicOrigin), loopback = new URL(options.loopbackOrigin);
    if (![publicUrl, loopback].every(url => (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash)) throw new BrowserContextError(400, "browser-control-origin", "Browser control origins must be HTTP or HTTPS origins without credentials or paths");
    this.blockedOrigins.add(publicUrl.origin); this.blockedOrigins.add(loopback.origin);
    this.loopbackPort = loopback.port || (loopback.protocol === "https:" ? "443" : "80");
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_MS;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) throw new BrowserContextError(400, "browser-idle-timeout", "Browser idle timeout must be positive");
    this.bindConnection();
    if (options.grants) {
      this.cleanups.push(options.grants.onRevoke(grant => {
        this.tabs.get(key(grant.workspaceId, grant.tabId))?.broker.revokeAgentLease(grant.sessionId);
      }));
      this.cleanups.push(options.grants.onChange((workspaceId, count) => this.setActiveGrantCount(workspaceId, count)));
    }
    if (options.supervisor) this.cleanups.push(options.supervisor.onCrash(reason => this.handleChromiumExit(reason)));
    if (options.subscribeSupervisorExit) this.cleanups.push(options.subscribeSupervisorExit(reason => this.handleChromiumExit(reason)));
    this.startIdleTimer();
  }
  private bindConnection() {
    for (const cleanup of this.connectionCleanups.splice(0)) cleanup();
    this.connectionCleanups.push(this.cdp.onEvent(({ params }) => {
      const info = params.targetInfo as Record<string, any> | undefined;
      if (info?.openerId) this.background(this.blockPopup(info));
    }, "Target.targetCreated"));
    this.connectionCleanups.push(this.cdp.onEvent(({ params }) => {
      const tab = this.findTarget(String(params.targetId));
      if (tab && tab.state.targetId === params.targetId) this.crash(tab, `Browser target crashed${params.status ? `: ${params.status}` : ""}`);
      else if (tab) for (const [sessionId, targetId] of tab.sessionTargets) if (targetId === params.targetId) tab.sessionCleanups.get(sessionId)?.();
    }, "Target.targetCrashed"));
    this.connectionCleanups.push(this.cdp.onEvent(({ params }) => {
      this.blockedPopupTargets.delete(String(params.targetId));
      const tab = this.findTarget(String(params.targetId));
      if (tab && tab.state.targetId === params.targetId) { tab.targetClosed = true; this.crash(tab, "Browser target was destroyed; restart the tab explicitly"); }
    }, "Target.targetDestroyed"));
    this.connectionCleanups.push(this.cdp.onEvent(event => {
      const info = event.params.targetInfo as Record<string, any> | undefined;
      if (!event.sessionId && info?.openerId) this.background(this.blockPopup(info));
    }, "Target.attachedToTarget"));
    this.connectionCleanups.push(this.cdp.onEvent(({ params }) => {
      const sessionId = String(params.sessionId);
      for (const tab of this.tabs.values()) if (tab.sessionTargets.has(sessionId)) {
        if (sessionId === tab.state.cdpSessionId) this.crash(tab, "Browser CDP session detached; restart the tab explicitly");
        else tab.sessionCleanups.get(sessionId)?.();
      }
    }, "Target.detachedFromTarget"));
    this.connectionCleanups.push(this.cdp.onEvent(({ params }) => {
      const info = params.targetInfo as Record<string, any> | undefined;
      const tab = info && this.findTarget(String(info.targetId));
      if (tab && tab.state.targetId === info!.targetId) { tab.state.title = String(info!.title ?? "").slice(0, 8192); this.emit(tab); }
    }, "Target.targetInfoChanged"));
    this.connectionCleanups.push(this.cdp.onClose(reason => this.handleChromiumExit(reason.message)));
  }
  private background(promise: Promise<unknown>) { void promise.catch(error => this.options.onError?.(error)); }
  private transientCdpError(tab: Tab, sessionId: string, error: unknown): boolean {
    if (!tab.sessions.has(sessionId) || tab.state.status !== "starting" && tab.state.status !== "running") return true;
    const message = error instanceof Error ? error.message : String(error);
    return /invalid (?:interception|request|fetch request)\s*id|(?:request|resource|frame|session).*(?:not found|no longer|cancell?ed|detached|destroyed|closed)|no (?:resource|frame|session).*(?:found|exist)|(?:target|session) (?:closed|detached|destroyed)|can only.*(?:paused|intercepted)/i.test(message);
  }
  private safetyTask(tab: Tab, promise: Promise<unknown>) {
    this.background(promise.catch(error => {
      this.crash(tab, `Browser safety enforcement failed: ${error instanceof Error ? error.message : "CDP error"}`);
      if (tab.state.targetId) this.background(this.cdp.send("Target.closeTarget", { targetId: tab.state.targetId }));
      throw error;
    }));
  }
  private snapshot(tab: Tab): BrowserTabState { return structuredClone({ ...tab.state, control: tab.broker.snapshot(), diagnostics: tab.diagnostics?.summary() ?? tab.state.diagnostics }); }
  private emit(tab: Tab) { try { this.options.onChange?.(this.snapshot(tab)); } catch (error) { this.options.onError?.(error); } }
  private absent(workspaceId: string, tabId: string): BrowserTabState {
    return { capability: { available: !this.disposed && !this.cdp.closed }, workspaceId, tabId, browserContextId: null, targetId: null, cdpSessionId: null, generation: 0, documentId: 0, status: "absent", url: "about:blank", title: "", viewport: { ...L.defaultViewport }, control: { mode: "stopped", controllerAttachmentId: null, agentSessionId: null, leaseGeneration: 0, pausedByHuman: false, updatedAt: new Date().toISOString() }, diagnostics: { collectionStartedAt: null, consoleNextSeq: 1, consoleTruncatedCount: 0, networkNextSeq: 1, networkTruncatedCount: 0 }, viewerCount: 0, screencastActive: false };
  }
  getTab(workspaceId: string, tabId: string): BrowserTabState { const tab = this.tabs.get(key(workspaceId, tabId)); return tab ? this.snapshot(tab) : this.absent(workspaceId, tabId); }
  listTabs(workspaceId: string): BrowserTabState[] { return [...this.tabs.values()].filter(tab => tab.state.workspaceId === workspaceId).map(tab => this.snapshot(tab)); }
  getBroker(workspaceId: string, tabId: string): BrowserControlBroker {
    const tab = this.requireTab(workspaceId, tabId);
    if (tab.state.status !== "running") throw new BrowserContextError(409, "browser-tab-stopped", "Browser control requires a running tab");
    return tab.broker;
  }
  getDiagnostics(workspaceId: string, tabId: string): BrowserDiagnostics {
    const diagnostics = this.requireTab(workspaceId, tabId).diagnostics;
    if (!diagnostics) throw new BrowserContextError(409, "browser-diagnostics-unavailable", "Browser diagnostics have not started");
    return diagnostics;
  }
  private requireTab(workspaceId: string, tabId: string): Tab {
    const tab = this.tabs.get(key(workspaceId, tabId));
    if (!tab) throw new BrowserContextError(404, "browser-tab-absent", "Start the browser tab explicitly");
    return tab;
  }
  private findTarget(targetId: string): Tab | undefined { return [...this.tabs.values()].find(tab => tab.targets.has(targetId)); }
  assertAllowedUrl(value: string): string {
    const checked = validateBrowserNavigationUrl(value, [...this.blockedOrigins]);
    if (!checked.ok) throw new BrowserContextError(403, "browser-navigation-blocked", checked.reason);
    if (checked.url === "about:blank") return checked.url;
    const url = new URL(checked.url);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    const loopback = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "[::1]" || host.startsWith("[::ffff:7f") || host.startsWith("[::ffff:127.") || host === "0.0.0.0" || host === "[::]";
    if (url.protocol !== "http:" && url.protocol !== "https:" || this.blockedOrigins.has(url.origin) || loopback && port === this.loopbackPort) throw new BrowserContextError(403, "browser-navigation-blocked", "Navigation to this scheme or SANE control origin is blocked");
    return url.toString();
  }
  private allowed(value: string): boolean { try { this.assertAllowedUrl(value); return true; } catch { return false; } }
  private async workspace(workspaceId: string): Promise<Workspace> {
    if (this.disposed) throw new BrowserContextError(503, "browser-shutdown", "Browser registry is closed");
    const previous = this.workspaces.get(workspaceId);
    if (previous) {
      if (previous.closing) throw new BrowserContextError(409, "browser-context-closing", "Workspace browser context is being reclaimed");
      await previous.ready;
      return previous;
    }
    if (this.workspaces.size >= MAX_WORKSPACES) throw new BrowserContextError(429, "browser-workspace-limit", "At most 8 workspace browser contexts can run concurrently");
    const workspace: Workspace = { workspaceId, ready: Promise.resolve(""), viewerCount: 0, activeGrantCount: this.options.grants?.countForWorkspace(workspaceId) ?? 0, idleSince: Date.now(), closing: false };
    this.workspaces.set(workspaceId, workspace);
    workspace.ready = (async () => {
      let browserContextId: string | undefined;
      try {
        if (this.cdp.closed && this.options.supervisor) {
          this.cdp = await this.options.supervisor.start(); this.bindConnection();
        }
        ({ browserContextId } = await this.cdp.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: false }));
        workspace.browserContextId = browserContextId;
        await this.cdp.send("Browser.resetPermissions", { browserContextId });
        await this.cdp.send("Browser.grantPermissions", { browserContextId, permissions: [] });
        for (const name of L.deniedPermissions) await this.cdp.send("Browser.setPermission", { browserContextId, permission: { name }, setting: "denied" });
        await this.cdp.send("Browser.setDownloadBehavior", { browserContextId, behavior: "deny" });
        await this.cdp.send("Target.setDiscoverTargets", { discover: true });
        if (workspace.closing || this.disposed || this.workspaces.get(workspaceId) !== workspace) throw new BrowserContextError(409, "browser-context-stopped", "Workspace browser context stopped during startup");
        this.updateIdle(workspace);
        return browserContextId;
      } catch (error) {
        if (browserContextId) { try { await this.cdp.send("Target.disposeBrowserContext", { browserContextId }); } catch (cleanupError) { this.options.onError?.(cleanupError); } }
        if (this.workspaces.get(workspaceId) === workspace) this.workspaces.delete(workspaceId);
        throw error;
      }
    })();
    await workspace.ready;
    return workspace;
  }
  async startTab(workspaceId: string, tabId: string, url = "about:blank"): Promise<BrowserTabState> {
    const id = key(workspaceId, tabId);
    this.assertAllowedUrl(url);
    if (!workspaceId || !tabId) throw new BrowserContextError(400, "browser-target", "Workspace and tab identifiers are required");
    if (this.tabs.has(id)) throw new BrowserContextError(409, "browser-tab-exists", "Browser tab already exists; use explicit Restart tab");
    return this.start(workspaceId, tabId, url);
  }
  async restartTab(workspaceId: string, tabId: string, url?: string): Promise<BrowserTabState> {
    const previous = this.requireTab(workspaceId, tabId);
    const destination = url ?? previous.navigationUrl;
    this.assertAllowedUrl(destination);
    return this.start(workspaceId, tabId, destination, previous);
  }
  private async start(workspaceId: string, tabId: string, url: string, previous?: Tab): Promise<BrowserTabState> {
    const id = key(workspaceId, tabId);
    if (this.transitions.has(id)) throw new BrowserContextError(409, "browser-tab-busy", "Browser tab lifecycle operation is already pending");
    const activeTabs = this.listTabs(workspaceId).filter(tab => tab.status !== "closed" || this.transitions.has(key(workspaceId, tab.tabId)));
    if ((!previous || previous.state.status === "closed") && activeTabs.length >= MAX_TABS) throw new BrowserContextError(429, "browser-tab-limit", "At most 8 host tabs can exist per workspace");
    this.transitions.add(id);
    let tab: Tab | undefined;
    try {
      if (previous) await this.stop(previous, "Browser tab explicitly restarted");
      const state: BrowserTabState = { ...this.absent(workspaceId, tabId), generation: (previous?.state.generation ?? 0) + 1, documentId: previous?.state.documentId ?? 0, viewerCount: previous?.state.viewerCount ?? 0, status: "starting" };
      tab = { state, broker: new BrowserControlBroker(workspaceId, tabId, () => {
        state.control = tab!.broker.snapshot();
        this.emit(tab!);
      }, previous?.broker.snapshot().leaseGeneration ?? 0), cleanups: new Set(), sessions: new Set(), sessionCleanups: new Map(), sessionTargets: new Map(), targets: new Set(), navigationUrl: "about:blank", targetClosed: false };
      this.tabs.set(id, tab); this.emit(tab);
      const workspace = await this.workspace(workspaceId);
      if (state.status !== "starting" || workspace.closing) throw new BrowserContextError(409, "browser-tab-stopped", "Browser tab stopped during startup");
      state.browserContextId = await workspace.ready;
      this.setViewerCount(workspaceId, this.listTabs(workspaceId).reduce((sum, tab) => sum + tab.viewerCount, 0));
      const { targetId } = await this.cdp.send<{ targetId: string }>("Target.createTarget", { browserContextId: state.browserContextId, url: "about:blank", background: false });
      state.targetId = targetId; tab.targets.add(targetId);
      const { sessionId } = await this.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      state.cdpSessionId = sessionId;
      tab.sessionTargets.set(sessionId, targetId);
      tab.diagnostics = new BrowserDiagnostics(workspaceId, tabId, state.generation, targetId);
      await this.installSafety(tab, sessionId, true);
      await this.cdp.send("Emulation.setDeviceMetricsOverride", { ...state.viewport, mobile: false }, { sessionId });
      await tab.diagnostics.attachBeforeNavigation(this.cdp, sessionId, { beforeResumeChild: async (childSessionId, info) => {
        if (info.openerId && await this.blockPopup(info)) return false;
        if (state.status !== "starting" && state.status !== "running") return false;
        if (typeof info.targetId === "string") { tab!.targets.add(info.targetId); tab!.sessionTargets.set(childSessionId, info.targetId); }
        await this.installSafety(tab!, childSessionId, false, info.type === "iframe" || info.type === "page");
        return true;
      } });
      if (state.status !== "starting" || workspace.closing || this.disposed) throw new BrowserContextError(409, "browser-tab-stopped", "Browser tab stopped during startup");
      await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, { sessionId });
      if (state.status !== "starting" || workspace.closing || this.disposed) throw new BrowserContextError(409, "browser-tab-stopped", "Browser tab stopped during startup");
      state.status = "running"; state.capability = { available: true }; this.emit(tab);
      if (url !== "about:blank") await this.navigate(workspaceId, tabId, url);
      return this.snapshot(tab);
    } catch (error) {
      if (tab) {
        this.crash(tab, error instanceof Error ? error.message : "Browser tab startup failed");
        if (tab.state.targetId) { try { await this.cdp.send("Target.closeTarget", { targetId: tab.state.targetId }); } catch (cleanupError) { this.options.onError?.(cleanupError); } }
      }
      throw error;
    } finally { this.transitions.delete(id); }
  }
  async navigate(workspaceId: string, tabId: string, value: string): Promise<BrowserTabState> {
    const tab = this.requireTab(workspaceId, tabId), url = this.assertAllowedUrl(value);
    if (tab.state.status !== "running" || !tab.state.cdpSessionId) throw new BrowserContextError(409, "browser-tab-stopped", "Browser tab is not running");
    const result = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url }, { sessionId: tab.state.cdpSessionId });
    if (result.errorText) throw new BrowserContextError(409, "browser-navigation-failed", result.errorText);
    return this.snapshot(tab);
  }
  private async installSafety(tab: Tab, sessionId: string, topLevel: boolean, page = true) {
    if (tab.sessions.has(sessionId)) return;
    tab.sessions.add(sessionId);
    const listeners: (() => void)[] = [];
    const cleanup = () => {
      for (const off of listeners.splice(0)) off();
      tab.sessions.delete(sessionId); tab.sessionCleanups.delete(sessionId); tab.cleanups.delete(cleanup);
      const targetId = tab.sessionTargets.get(sessionId);
      if (targetId) tab.targets.delete(targetId);
      tab.sessionTargets.delete(sessionId);
    };
    tab.cleanups.add(cleanup); tab.sessionCleanups.set(sessionId, cleanup);
    const active = () => tab.sessions.has(sessionId) && (tab.state.status === "starting" || tab.state.status === "running");
    const listen = (method: string, handler: (params: Record<string, any>) => void) => listeners.push(this.cdp.onSessionEvent(sessionId, event => { if (active()) handler(event.params); }, method));
    if (topLevel) {
      listen("Inspector.targetCrashed", () => this.crash(tab, "Browser target crashed; restart the tab explicitly"));
      listen("Inspector.detached", params => this.crash(tab, `Browser inspector detached${params.reason ? `: ${params.reason}` : ""}; restart the tab explicitly`));
    } else {
      listen("Inspector.targetCrashed", cleanup);
      listen("Inspector.detached", cleanup);
    }
    listen("Fetch.requestPaused", params => {
      const url = String(params.request?.url ?? "");
      const ignoreTransient = (error: unknown) => { if (!this.transientCdpError(tab, sessionId, error)) throw error; };
      if ((params.resourceType === "Document" || /^https?:\/\//i.test(url)) && !this.allowed(url)) {
        tab.state.lastBlockedNavigation = { url: sanitizeBrowserUrl(url), timestamp: new Date().toISOString() }; this.emit(tab);
        this.safetyTask(tab, this.cdp.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, { sessionId }).catch(ignoreTransient));
      } else this.background(this.cdp.send("Fetch.continueRequest", { requestId: params.requestId }, { sessionId }).catch(ignoreTransient));
    });
    listen("Page.frameRequestedNavigation", params => {
      if (!this.allowed(String(params.url))) this.safetyTask(tab, this.blockFrame(tab, sessionId, String(params.frameId), String(params.url)));
    });
    listen("Page.frameNavigated", params => {
      const frame = params.frame;
      if (!frame || typeof frame.url !== "string") return;
      if (topLevel && !frame.parentId) {
        tab.frameId = frame.id; tab.state.documentId++;
        if (this.allowed(frame.url)) tab.navigationUrl = frame.url;
        tab.state.url = sanitizeBrowserUrl(frame.url); this.emit(tab);
      }
      if (!this.allowed(frame.url)) this.safetyTask(tab, this.blockFrame(tab, sessionId, String(frame.id), frame.url));
    });
    listen("Page.navigatedWithinDocument", params => {
      if (topLevel && params.frameId === tab.frameId && typeof params.url === "string") {
        if (this.allowed(params.url)) tab.navigationUrl = params.url;
        tab.state.url = sanitizeBrowserUrl(params.url); this.emit(tab);
        const { documentId, url } = tab.state;
        void this.cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: "document.title", returnByValue: true }, { sessionId }).then(({ result }) => {
          if (!active() || tab.state.documentId !== documentId || tab.state.url !== url || typeof result?.value !== "string") return;
          const title = result.value.slice(0, 8192);
          if (tab.state.title !== title) { tab.state.title = title; this.emit(tab); }
        }).catch(() => {});
      }
      if (typeof params.url === "string" && !this.allowed(params.url)) this.safetyTask(tab, this.blockFrame(tab, sessionId, String(params.frameId), params.url));
    });
    listen("Page.javascriptDialogOpening", params => {
      const message = String(params.message ?? "").slice(0, 8192);
      const type = params.type === "confirm" || params.type === "prompt" || params.type === "beforeunload" ? params.type : "alert";
      tab.state.lastDialog = { type, message, url: sanitizeBrowserUrl(String(params.url ?? "about:blank")), dismissedAt: new Date().toISOString() };
      tab.diagnostics?.recordConsole({ severity: "warn", source: "log", text: `Dismissed browser ${type}: ${message}` });
      this.safetyTask(tab, this.cdp.send("Page.handleJavaScriptDialog", { accept: false }, { sessionId })); this.emit(tab);
    });
    listen("Page.fileChooserOpened", params => {
      tab.diagnostics?.recordConsole({ severity: "warn", source: "log", text: "Blocked browser file chooser" });
      if (params.backendNodeId) this.safetyTask(tab, this.cdp.send("DOM.setFileInputFiles", { files: [], backendNodeId: params.backendNodeId }, { sessionId }));
    });
    await this.cdp.send("Inspector.enable", {}, { sessionId });
    await this.cdp.send("Fetch.enable", { patterns: [
      { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
      { urlPattern: "http://*", requestStage: "Request" },
      { urlPattern: "https://*", requestStage: "Request" },
    ] }, { sessionId });
    if (page) {
      await this.cdp.send("Page.enable", {}, { sessionId });
      await this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, { sessionId });
      await this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, { sessionId });
    }
  }
  private async blockFrame(tab: Tab, sessionId: string, frameId: string, url: string) {
    tab.state.lastBlockedNavigation = { url: sanitizeBrowserUrl(url), timestamp: new Date().toISOString() };
    tab.diagnostics?.recordConsole({ severity: "warn", source: "log", text: `Blocked browser navigation: ${sanitizeBrowserUrl(url)}` });
    this.emit(tab);
    try {
      await this.cdp.send("Page.stopLoading", {}, { sessionId }).catch(error => { if (!this.transientCdpError(tab, sessionId, error)) throw error; });
      await this.cdp.send("Page.navigate", { url: "about:blank", frameId }, { sessionId });
    } catch (error) {
      if ((tab.state.status !== "starting" && tab.state.status !== "running") || !tab.state.cdpSessionId) return;
      const tree = await this.cdp.send<{ frameTree: { frame: { url: string } } }>("Page.getFrameTree", {}, { sessionId: tab.state.cdpSessionId }).catch(checkError => {
        if (!this.transientCdpError(tab, tab.state.cdpSessionId!, checkError)) this.options.onError?.(checkError);
        return null;
      });
      if (!this.allowed(tree?.frameTree.frame.url ?? tab.state.url)) throw error;
      if (!this.transientCdpError(tab, sessionId, error)) this.options.onError?.(error);
    }
  }
  private async blockPopup(info: Record<string, any>): Promise<boolean> {
    const opener = this.findTarget(String(info.openerId));
    if (!opener || typeof info.targetId !== "string") return false;
    if (this.blockedPopupTargets.has(info.targetId)) return true;
    this.blockedPopupTargets.add(info.targetId);
    while (this.blockedPopupTargets.size > L.networkMaxEntries) this.blockedPopupTargets.delete(this.blockedPopupTargets.values().next().value!);
    opener.state.lastBlockedPopup = { openerTabId: opener.state.tabId, url: sanitizeBrowserUrl(String(info.url ?? "about:blank")), blockedAt: new Date().toISOString() };
    opener.diagnostics?.recordConsole({ severity: "warn", source: "log", text: `Blocked browser popup: ${opener.state.lastBlockedPopup.url}` });
    this.emit(opener);
    const result = await this.cdp.send<{ success?: boolean }>("Target.closeTarget", { targetId: info.targetId });
    if (result.success === false) throw new BrowserContextError(503, "browser-popup-close", "Could not confirm blocked browser popup closure");
    return true;
  }
  private detach(tab: Tab) {
    tab.diagnostics?.detach();
    for (const cleanup of [...tab.cleanups]) cleanup();
    tab.sessions.clear(); tab.sessionCleanups.clear(); tab.sessionTargets.clear(); tab.targets.clear();
  }
  private crash(tab: Tab, reason: string) {
    if (tab.state.status !== "starting" && tab.state.status !== "running") return;
    tab.state.status = "crashed"; tab.state.reason = reason; tab.state.generation++; tab.state.screencastActive = false;
    tab.broker.markStopped(); this.detach(tab);
    if (tab.diagnostics && tab.state.targetId) tab.diagnostics.reset(tab.state.generation, tab.state.targetId);
    this.emit(tab);
  }
  handleChromiumExit(reason = "Supervised Chromium exited; restart the tab explicitly"): void {
    for (const workspace of this.workspaces.values()) workspace.closing = true;
    this.workspaces.clear();
    this.blockedPopupTargets.clear();
    for (const tab of this.tabs.values()) {
      tab.state.capability = { available: false, reason };
      this.crash(tab, reason);
    }
  }
  private async stop(tab: Tab, reason: string) {
    tab.state.status = "closed"; tab.state.reason = reason; tab.state.generation++; tab.state.screencastActive = false;
    tab.broker.markStopped(); this.detach(tab);
    if (tab.diagnostics && tab.state.targetId) tab.diagnostics.reset(tab.state.generation, tab.state.targetId);
    this.emit(tab);
    if (tab.state.targetId && !tab.targetClosed && !this.cdp.closed && this.workspaces.get(tab.state.workspaceId)?.browserContextId === tab.state.browserContextId) {
      const result = await this.cdp.send<{ success?: boolean }>("Target.closeTarget", { targetId: tab.state.targetId });
      if (result.success === false) throw new BrowserContextError(503, "browser-target-close", "Could not confirm browser target closure");
    }
    tab.targetClosed = true;
  }
  async closeTab(workspaceId: string, tabId: string, reason = "Browser tab explicitly closed"): Promise<BrowserTabState> {
    const id = key(workspaceId, tabId);
    if (this.transitions.has(id)) throw new BrowserContextError(409, "browser-tab-busy", "Browser tab lifecycle operation is already pending");
    const tab = this.requireTab(workspaceId, tabId);
    this.transitions.add(id);
    try { await this.stop(tab, reason); return this.snapshot(tab); } finally { this.transitions.delete(id); }
  }
  setViewerCount(workspaceId: string, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new BrowserContextError(400, "browser-viewer-count", "Viewer count must be a nonnegative integer");
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) { workspace.viewerCount = count; this.updateIdle(workspace); }
  }
  setTabViewerCount(workspaceId: string, tabId: string, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new BrowserContextError(400, "browser-viewer-count", "Viewer count must be a nonnegative integer");
    const tab = this.requireTab(workspaceId, tabId);
    tab.state.viewerCount = count;
    this.setViewerCount(workspaceId, this.listTabs(workspaceId).reduce((sum, state) => sum + state.viewerCount, 0));
    this.emit(tab);
  }
  setActiveGrantCount(workspaceId: string, count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new BrowserContextError(400, "browser-grant-count", "Grant count must be a nonnegative integer");
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) { workspace.activeGrantCount = count; this.updateIdle(workspace); }
  }
  private updateIdle(workspace: Workspace) {
    if (workspace.viewerCount || workspace.activeGrantCount) workspace.idleSince = null;
    else workspace.idleSince ??= Date.now();
  }
  workspaceActivity(workspaceId: string) {
    const workspace = this.workspaces.get(workspaceId);
    return workspace ? { viewerCount: workspace.viewerCount, activeGrantCount: workspace.activeGrantCount, idleSince: workspace.idleSince } : null;
  }
  startIdleTimer(): void {
    if (this.idleTimer || this.disposed) return;
    this.idleTimer = setInterval(() => this.background(this.reclaimIdleContexts()), Math.min(60_000, this.idleTimeoutMs));
    this.idleTimer.unref();
  }
  async reclaimIdleContexts(now = Date.now()): Promise<void> {
    for (const workspace of [...this.workspaces.values()]) {
      if (workspace.closing || workspace.idleSince === null || workspace.viewerCount || workspace.activeGrantCount || now - workspace.idleSince < this.idleTimeoutMs) continue;
      if ([...this.transitions].some(id => JSON.parse(id)[0] === workspace.workspaceId)) continue;
      await this.disposeWorkspace(workspace.workspaceId, "Idle workspace browser context reclaimed");
    }
  }
  async disposeWorkspace(workspaceId: string, reason = "Workspace browser context closed"): Promise<void> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace || workspace.closing) return;
    workspace.closing = true;
    try {
      for (const tab of this.tabs.values()) if (tab.state.workspaceId === workspaceId && tab.state.status !== "closed") {
        tab.state.status = "closed"; tab.state.reason = reason; tab.state.generation++; tab.state.screencastActive = false;
        tab.broker.markStopped(); this.detach(tab);
        if (tab.diagnostics && tab.state.targetId) tab.diagnostics.reset(tab.state.generation, tab.state.targetId);
        this.emit(tab);
      }
      let revocationError: unknown;
      try { this.options.grants?.revokeAllForWorkspace(workspaceId); } catch (error) { revocationError = error; }
      const browserContextId = await workspace.ready;
      await this.cdp.send("Target.disposeBrowserContext", { browserContextId });
      this.workspaces.delete(workspaceId);
      if (revocationError) throw revocationError;
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const cleanup of this.connectionCleanups.splice(0)) cleanup();
    const results = await Promise.allSettled([...this.workspaces.keys()].map(workspaceId => this.disposeWorkspace(workspaceId)));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, "Could not dispose every workspace browser context");
  }
}
