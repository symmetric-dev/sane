import type { BrowserClientMessage, BrowserServerMessage, BrowserTabState, BrowserSessionGrant, BrowserGrantScope, BrowserConsoleSeverity, BrowserConsoleLogsResult, BrowserNetworkRequestsResult, BrowserScreenshotResult, BrowserPointerEventInput, BrowserWheelEventInput, BrowserKeyEventInput, BrowserTouchEventInput, BrowserViewport } from "../shared/browser-host-contract";
import type { BrowserPairSession } from "../shared/browser-pair-contract";
import { ApiError, request } from "./cc-client";
import { subscribeWorkspace, workspaceEpoch, workspaceFailure } from "./workspace-store";
import { WorkspaceError } from "./workspace-client";

export type BrowserArtifact = { artifactId: string; workspaceId: string; tabId: string; capturedAt: string; mimeType: "image/png" | "image/jpeg"; bytes: number; path: string };
const base = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/browser`;
const tabPath = (workspaceId: string, tabId: string) => `${base(workspaceId)}/tabs/${encodeURIComponent(tabId)}`;
type HostTab = { state: BrowserTabState | null; grants: BrowserSessionGrant[] };
const emptyHostTab: HostTab = { state: null, grants: [] };
const snapshots = new Map<string, HostTab>(), listeners = new Set<() => void>();
const grantReads = new Map<string, number>();
const cacheKey = (workspaceId: string, tabId: string) => JSON.stringify([workspaceEpoch(), workspaceId, tabId]);
function nextGrantRead(workspaceId: string, tabId: string) {
  const key = cacheKey(workspaceId, tabId), revision = (grantReads.get(key) ?? 0) + 1;
  grantReads.set(key, revision); return () => grantReads.get(key) === revision;
}
export const hostBrowserTabs = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  snapshot(workspaceId: string, tabId: string): HostTab { return snapshots.get(cacheKey(workspaceId, tabId)) ?? emptyHostTab; },
};
function publish(workspaceId: string, tabId: string, patch: Partial<HostTab>) {
  const previous = hostBrowserTabs.snapshot(workspaceId, tabId);
  if (patch.state && previous.state && patch.state.status !== "absent" && (patch.state.generation < previous.state.generation || patch.state.generation === previous.state.generation && patch.state.documentId < previous.state.documentId)) delete patch.state;
  snapshots.set(cacheKey(workspaceId, tabId), { ...previous, ...patch }); listeners.forEach(listener => listener());
}
async function hostRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const auth = workspaceEpoch();
  try { return await request(path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(25000)]) : undefined }); }
  catch (error) {
    if (auth === workspaceEpoch() && !init.signal?.aborted && error instanceof ApiError && error.status === 401) workspaceFailure(new WorkspaceError(error.message, error.status, error.code));
    throw error;
  }
}
async function tabRequest<T>(workspaceId: string, tabId: string, suffix: string, method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return hostRequest(tabPath(workspaceId, tabId) + suffix, { method, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export async function getHostBrowserTab(workspaceId: string, tabId: string, signal?: AbortSignal): Promise<BrowserTabState & { grants: BrowserSessionGrant[] }> {
  const auth = workspaceEpoch(), latest = nextGrantRead(workspaceId, tabId), result = await tabRequest<BrowserTabState & { grants: BrowserSessionGrant[] }>(workspaceId, tabId, "", "GET", undefined, signal);
  if (auth === workspaceEpoch() && !signal?.aborted) publish(workspaceId, tabId, { state: result, ...(latest() ? { grants: result.grants } : {}) });
  return result;
}
export const startHostBrowserTab = (workspaceId: string, tabId: string, url?: string, signal?: AbortSignal) => tabRequest<BrowserTabState>(workspaceId, tabId, "", "POST", { url }, signal);
export const restartHostBrowserTab = (workspaceId: string, tabId: string, url?: string, signal?: AbortSignal) => tabRequest<BrowserTabState>(workspaceId, tabId, "/restart", "POST", { url }, signal);
export const closeHostBrowserTab = (workspaceId: string, tabId: string, signal?: AbortSignal) => tabRequest<BrowserTabState>(workspaceId, tabId, "/close", "POST", {}, signal);
export const navigateHostBrowserTab = (workspaceId: string, tabId: string, input: { generation: number; attachmentId: string; action: "url" | "back" | "forward" | "reload"; url?: string }, signal?: AbortSignal) => tabRequest<BrowserTabState>(workspaceId, tabId, "/navigate", "POST", input, signal);
export const captureHostBrowserScreenshot = (workspaceId: string, tabId: string, options: { fullPage?: boolean; format?: "png" | "jpeg"; saveArtifact?: boolean }, signal?: AbortSignal) => tabRequest<BrowserScreenshotResult>(workspaceId, tabId, "/screenshot", "POST", options, signal);
function queryString(query: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
export const queryHostBrowserConsole = (workspaceId: string, tabId: string, query: { afterSeq?: number; limit?: number; severity?: BrowserConsoleSeverity }, signal?: AbortSignal) => tabRequest<BrowserConsoleLogsResult>(workspaceId, tabId, `/diagnostics/console${queryString(query)}`, "GET", undefined, signal);
export const queryHostBrowserNetwork = (workspaceId: string, tabId: string, query: { afterSeq?: number; limit?: number; onlyFailed?: boolean }, signal?: AbortSignal) => tabRequest<BrowserNetworkRequestsResult>(workspaceId, tabId, `/diagnostics/network${queryString(query)}`, "GET", undefined, signal);
export const listHostBrowserArtifacts = (workspaceId: string, signal?: AbortSignal): Promise<{ artifacts: BrowserArtifact[] }> => hostRequest(`${base(workspaceId)}/artifacts`, { signal });
export const deleteHostBrowserArtifact = (workspaceId: string, artifactId: string, signal?: AbortSignal): Promise<{ deleted: boolean }> => hostRequest(`${base(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}`, { method: "DELETE", signal });
async function grantRequest(workspaceId: string, tabId: string, method: string, body?: unknown, signal?: AbortSignal) {
  const auth = workspaceEpoch(), latest = nextGrantRead(workspaceId, tabId), result = await tabRequest<{ grants: BrowserSessionGrant[] }>(workspaceId, tabId, "/grants", method, body, signal);
  if (auth === workspaceEpoch() && !signal?.aborted && latest()) publish(workspaceId, tabId, { grants: result.grants });
  return result;
}
export const listHostBrowserGrants = (workspaceId: string, tabId: string, signal?: AbortSignal) => grantRequest(workspaceId, tabId, "GET", undefined, signal);
export const setHostBrowserGrant = (workspaceId: string, tabId: string, session: BrowserPairSession, scope: BrowserGrantScope, signal?: AbortSignal) => grantRequest(workspaceId, tabId, "PUT", { session: { sessionId: session.sessionId, harness: session.harness, authorityId: session.authorityId, nativeSessionId: session.nativeSessionId }, scope }, signal);
export const revokeHostBrowserGrant = (workspaceId: string, tabId: string, sessionId: string, signal?: AbortSignal) => grantRequest(workspaceId, tabId, "DELETE", { sessionId }, signal);

export function hostBrowserPoint(canvas: HTMLCanvasElement, viewport: BrowserViewport, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  if (!scale) return { x: 0, y: 0 };
  return { x: Math.max(0, Math.min(viewport.width, (clientX - rect.left - (rect.width - viewport.width * scale) / 2) / scale)), y: Math.max(0, Math.min(viewport.height, (clientY - rect.top - (rect.height - viewport.height * scale) / 2) / scale)) };
}
export type BrowserHostPresentation = { state: BrowserTabState | null; attachmentId: string; connected: boolean; ready: boolean; busy: boolean; error: string };
export const emptyHostPresentation = (): BrowserHostPresentation => ({ state: null, attachmentId: "", connected: false, ready: false, busy: false, error: "" });
type Command = BrowserClientMessage extends infer M ? M extends { generation: number } ? Omit<M, "generation"> : never : never;
type Frame = Extract<BrowserServerMessage, { type: "frame" }>;

export class BrowserHostViewerClient {
  private socket: WebSocket | null = null;
  private abort = new AbortController();
  private disposed = false;
  private auth = workspaceEpoch();
  private visible = true;
  private presentation = emptyHostPresentation();
  private retry?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;
  private inputTimer?: ReturnType<typeof setTimeout>;
  private queue: Command[] = [];
  private releasing = false;
  private frames: Frame[] = [];
  private drawing = false;
  private unsubscribe: () => void;
  constructor(private canvas: HTMLCanvasElement, private workspaceId: string, private tabId: string, private onChange: (state: BrowserHostPresentation) => void) {
    document.addEventListener("visibilitychange", this.visibility);
    this.unsubscribe = subscribeWorkspace(() => { if (workspaceEpoch() !== this.auth) this.dispose(); });
    void this.refresh();
  }
  private current() { return !this.disposed && this.auth === workspaceEpoch(); }
  private update(patch: Partial<BrowserHostPresentation>) {
    if (!this.current()) return;
    this.presentation = { ...this.presentation, ...patch }; this.onChange(this.presentation);
  }
  private accept(state: BrowserTabState) {
    if (state.workspaceId !== this.workspaceId || state.tabId !== this.tabId) throw new Error("Browser target changed.");
    const previous = this.presentation.state;
    if (previous && state.status !== "absent" && (state.generation < previous.generation || state.generation === previous.generation && state.documentId < previous.documentId)) return;
    publish(this.workspaceId, this.tabId, { state });
    const newDocument = previous?.targetId !== state.targetId || previous?.documentId !== state.documentId || state.status !== "running";
    this.update({ state, ...(newDocument ? { ready: false } : {}) });
    if (state.status !== "running") this.canvas.getContext("2d")?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (state.control.controllerAttachmentId !== this.presentation.attachmentId) this.releasing = false;
    if (state.status !== "running" || previous && state.generation !== previous.generation || state.control.controllerAttachmentId && state.control.controllerAttachmentId !== this.presentation.attachmentId) this.clearInput();
  }
  refresh = async () => {
    if (!this.current() || this.presentation.busy) return;
    clearTimeout(this.retry);
    this.update({ busy: true, error: "" });
    try {
      const state = await getHostBrowserTab(this.workspaceId, this.tabId, this.abort.signal);
      if (!this.current()) return;
      this.accept(state); this.update({ busy: false });
      if (state.status === "running" && !this.socket) this.connect();
      else if (state.status !== "running" && this.socket) this.detach();
    } catch (error) {
      if (this.current()) {
        this.update({ busy: false, error: error instanceof Error ? error.message : "Could not load host browser." });
        if (!this.socket && !(error instanceof ApiError && (error.status === 401 || error.status === 403))) this.scheduleReconnect();
      }
    }
  };
  action = async (action: "start" | "restart" | "close", url?: string) => {
    if (!this.current() || this.presentation.busy) return;
    this.update({ busy: true, error: "" }); this.detach();
    try {
      const operation = action === "start" ? startHostBrowserTab : action === "restart" ? restartHostBrowserTab : null;
      const state = operation ? await operation(this.workspaceId, this.tabId, url, this.abort.signal) : await closeHostBrowserTab(this.workspaceId, this.tabId, this.abort.signal);
      if (!this.current()) return;
      this.accept(state); this.update({ busy: false });
      if (state.status === "running") this.connect();
    } catch (error) { if (this.current()) this.update({ busy: false, error: `${error instanceof Error ? error.message : "Host browser action failed."} Refresh status before trying again.` }); }
  };
  private connect() {
    if (!this.current()) return;
    const socket = this.socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${tabPath(this.workspaceId, this.tabId)}/socket`);
    const current = () => this.current() && this.socket === socket;
    socket.onmessage = event => {
      if (!current()) return;
      try {
        const message = JSON.parse(event.data) as BrowserServerMessage;
        if (message.type === "hello") {
          this.update({ attachmentId: message.attachmentId, connected: true, error: "" }); this.accept(message.state);
          this.retryDelay = 1000; this.visibility();
        } else if (message.type === "state") this.accept(message.state);
        else if (message.type === "frame") {
          if (this.frames.length >= 2) throw new Error("Host browser frame backlog exceeded.");
          this.frames.push(message); void this.draw(socket);
        } else if (message.type === "error") { this.clearInput(); this.update({ error: message.message }); }
        else if (this.presentation.state && message.generation === this.presentation.state.generation) {
          if (message.type === "dialog") this.accept({ ...this.presentation.state, lastDialog: message.dialog });
          if (message.type === "popup-blocked") this.accept({ ...this.presentation.state, lastBlockedPopup: message.popup });
        }
      } catch (error) { this.update({ error: error instanceof Error ? error.message : "Host browser stream interrupted." }); socket.close(); }
    };
    socket.onclose = event => {
      if (!current()) return;
      this.socket = null; this.frames = []; this.clearInput();
      this.update({ connected: false, ready: false, attachmentId: "", error: `${event.code === 4401 ? "Host browser sign-in expired." : "Host browser disconnected. Reconnecting as a viewer…"}${event.reason ? ` (${event.reason})` : ""}` });
      if (event.code === 4401) workspaceFailure(new WorkspaceError("Host browser sign-in expired.", 401, "browser-auth"));
      else {
        this.scheduleReconnect();
      }
    };
    socket.onerror = () => { if (current()) this.update({ error: "Host browser connection unavailable." }); };
  }
  private scheduleReconnect() {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => { void this.refresh(); }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 10000);
  }
  private async draw(socket: WebSocket) {
    if (this.drawing) return;
    this.drawing = true;
    try {
      while (this.current() && this.socket === socket && this.frames.length) {
        const frame = this.frames.shift()!, image = new Image();
        image.src = `data:image/${frame.format};base64,${frame.data}`;
        await image.decode();
        if (!this.current() || this.socket !== socket) break;
        const state = this.presentation.state;
        if (state?.status === "running" && state.generation === frame.generation) {
          const { width, height, deviceScaleFactor } = state.viewport;
          if (this.canvas.width !== width * deviceScaleFactor || this.canvas.height !== height * deviceScaleFactor) { this.canvas.width = width * deviceScaleFactor; this.canvas.height = height * deviceScaleFactor; }
          const context = this.canvas.getContext("2d");
          if (!context) throw new Error("Host browser canvas is unavailable.");
          context.drawImage(image, 0, 0, this.canvas.width, this.canvas.height);
          if (!this.presentation.ready) this.update({ ready: true });
        }
        this.send({ type: "ack", seq: frame.seq });
      }
    } catch { if (this.current() && this.socket === socket) { this.update({ error: "Host browser frame could not be rendered. Reconnect to continue." }); socket.close(); } }
    finally { this.drawing = false; if (this.frames.length && this.socket && this.current()) void this.draw(this.socket); }
  }
  private send(message: BrowserClientMessage) {
    if (!this.current() || this.socket?.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.socket.close(); return false; }
  }
  canInput() {
    const { state, connected, ready, attachmentId } = this.presentation;
    return this.current() && !this.releasing && this.visible && document.visibilityState === "visible" && connected && ready && state?.status === "running" && (!state.control.controllerAttachmentId || state.control.controllerAttachmentId === attachmentId);
  }
  ownsControl() { return this.presentation.state?.control.controllerAttachmentId === this.presentation.attachmentId && !!this.presentation.attachmentId; }
  point(clientX: number, clientY: number) { return hostBrowserPoint(this.canvas, this.presentation.state?.viewport ?? { width: 1280, height: 800, deviceScaleFactor: 1 }, clientX, clientY); }
  private enqueue(command: Command, control = false) {
    if (!this.presentation.connected || !control && !this.canInput()) return;
    const last = this.queue.at(-1);
    if (command.type === "pointer" && command.event.type === "mouseMoved" && last?.type === "pointer" && last.event.type === "mouseMoved" || command.type === "touch" && command.event.type === "touchMove" && last?.type === "touch" && last.event.type === "touchMove") this.queue[this.queue.length - 1] = command;
    else if (command.type === "wheel" && last?.type === "wheel") this.queue[this.queue.length - 1] = { ...command, event: { ...command.event, deltaX: last.event.deltaX + command.event.deltaX, deltaY: last.event.deltaY + command.event.deltaY } };
    else if (this.queue.length < 64) this.queue.push(command);
    else { this.clearInput(); this.update({ error: "Host browser input fell behind. Input was not retried." }); this.socket?.close(); return; }
    this.drainInput();
  }
  private drainInput = () => {
    if (this.inputTimer || !this.queue.length) return;
    const state = this.presentation.state, command = this.queue.shift()!;
    if (!state || state.status !== "running") { this.clearInput(); return; }
    if (!this.send({ ...command, generation: state.generation } as BrowserClientMessage)) { this.clearInput(); return; }
    this.inputTimer = setTimeout(() => { this.inputTimer = undefined; this.drainInput(); }, 16);
  };
  private clearInput() { this.queue = []; this.releasing = false; clearTimeout(this.inputTimer); this.inputTimer = undefined; }
  sendPointer = (event: BrowserPointerEventInput) => {
    if (event.type === "mouseMoved" && (!this.ownsControl() || this.presentation.state?.control.mode !== "human-owned")) return;
    this.enqueue({ type: "pointer", event });
  };
  sendWheel = (event: BrowserWheelEventInput) => this.enqueue({ type: "wheel", event });
  sendKey = (event: BrowserKeyEventInput) => this.enqueue({ type: "key", event });
  sendTouch = (event: BrowserTouchEventInput) => this.enqueue({ type: "touch", event });
  sendNavigate = (action: "url" | "back" | "forward" | "reload", url?: string) => {
    const state = this.presentation.state;
    if (!state?.control.controllerAttachmentId || this.ownsControl()) this.enqueue({ type: "navigate", action, url }, true);
  };
  claim = () => this.enqueue({ type: "claim" }, true);
  take = () => this.enqueue({ type: "take" }, true);
  release = () => { if (!this.ownsControl() || this.releasing) return; this.releasing = true; this.queue = []; this.enqueue({ type: "release" }, true); };
  pauseAgent = () => this.enqueue({ type: "pause-agent" }, true);
  resumeAgent = (agentSessionId: string) => this.enqueue({ type: "resume-agent", agentSessionId }, true);
  private visibility = () => {
    const visible = this.visible && document.visibilityState === "visible";
    if (!visible) this.release();
    this.send({ type: "visibility", visible });
  };
  setVisibility = (visible: boolean) => { this.visible = visible; this.visibility(); };
  private detach() {
    clearTimeout(this.retry); this.clearInput();
    const socket = this.socket; this.socket = null; socket?.close(); this.frames = [];
    this.update({ connected: false, ready: false, attachmentId: "" });
  }
  dispose() {
    if (this.disposed) return;
    this.detach(); this.disposed = true; this.abort.abort(); this.unsubscribe();
    document.removeEventListener("visibilitychange", this.visibility);
  }
}
