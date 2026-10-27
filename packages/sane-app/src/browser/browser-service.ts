import { mkdir, readdir, readFile, lstat, unlink, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  BROWSER_LIMITS as L, BROWSER_MCP_TOOLS, type BrowserMcpCredentialFile, type BrowserMcpToolName,
  type BrowserCapability, type BrowserTabState, type BrowserServerMessage, type BrowserNativeCaller,
  type BrowserClientMessage, type BrowserSnapshotInput, type BrowserSnapshotNode, type BrowserSnapshotResult,
  type BrowserScreenshotInput, type BrowserScreenshotResult, type BrowserConsoleLogsInput,
  type BrowserNetworkRequestsInput, type BrowserNavigateInput, type BrowserClickInput, type BrowserTypeInput,
  type BrowserScrollInput, type BrowserAgentMutationInput, type BrowserGrantScope, type BrowserKeyEventInput,
} from "../../shared/browser-host-contract";
import { body, equal, json } from "../bridge-http";
import { BrowserContextRegistry, BrowserContextError, type BrowserTabState as RegistryState } from "./browser-context-registry";
import { BrowserControlError, type BrowserHumanInputKind } from "./browser-control-broker";
import { BrowserGrantRegistry, BrowserGrantError, type BrowserGrantTarget, type BrowserSessionIdentity } from "./browser-grant-registry";
import { ChromiumSupervisor, getChromiumCapability } from "./chromium-supervisor";
import type { CdpClient } from "./cdp-client";

type Attachment = {
  id: string; token: string; tab: Tab; socket?: Bun.ServerWebSocket<BrowserSocketData>;
  dead: boolean; visible: boolean; pending: Set<number>; discardedSeq: number; timer?: ReturnType<typeof setTimeout>;
  buttons: Map<string, { x: number; y: number }>; keys: Map<string, BrowserKeyEventInput>; touching: boolean; modifiers: number;
  window: number; messages: number; operations: number;
};
type Frame = { sessionId: number; waiting: Set<Attachment>; timer: ReturnType<typeof setTimeout> };
type Stream = { cdp: CdpClient; sessionId: string; active: boolean; desired: boolean; syncing?: Promise<void>; off: () => void; frames: Map<number, Frame> };
type Element = { backendNodeId: number; bounds?: BrowserSnapshotNode["bounds"] };
type References = { identity: string; next: number; byRef: Map<string, Element>; byNode: Map<number, string> };
type PressedInput = { buttons: Map<string, { x: number; y: number }>; keys: Map<string, BrowserKeyEventInput>; touching: boolean; modifiers: number };
type Tab = { workspaceId: string; tabId: string; attachments: Set<Attachment>; seq: number; stream?: Stream; refs?: References; previous?: RegistryState; agentBusy: boolean; agentInput: PressedInput };
export type BrowserSocketData = { browserAttachment: Attachment };
export type BrowserArtifact = { artifactId: string; workspaceId: string; tabId: string; capturedAt: string; mimeType: "image/png" | "image/jpeg"; bytes: number; path: string };
export type BrowserServiceOptions = {
  dataDir: string; validToken: (token: string) => boolean;
  getOrigins: () => { publicOrigin: string; loopbackOrigin: string };
  validateSession?: (target: BrowserGrantTarget, identity: BrowserSessionIdentity) => undefined;
  onError?: (error: unknown) => void;
};
const key = (workspaceId: string, tabId: string) => JSON.stringify([workspaceId, tabId]);
const grantKey = (target: BrowserGrantTarget, sessionId: string) => JSON.stringify([target.workspaceId, target.tabId, sessionId]);
const identity = (state: RegistryState) => JSON.stringify([state.targetId, state.generation, state.documentId]);
function fail(status: number, code: string, message: string): never { throw new BrowserContextError(status, code, message); }
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : fail(400, "browser-input", "Expected a finite number");
const integer = (value: unknown, min: number, max: number): number => {
  const n = finite(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, "browser-input", "Number is outside the supported range");
  return n;
};
const text = (value: unknown, max = 8192): string => typeof value === "string" && value.length <= max ? value : fail(400, "browser-input", "Expected bounded text");
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : fail(400, "browser-input", "Expected an object");
const artifactIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class BrowserService {
  capability: BrowserCapability = { available: false, reason: "Checking local Chromium availability" };
  private readonly grants = new BrowserGrantRegistry();
  private readonly grantOwners = new Map<string, { target: BrowserGrantTarget; sessionId: string; token: string }>();
  private readonly sessionCredentials = new Map<string, { token: string; session: BrowserSessionIdentity; target?: BrowserGrantTarget }>();
  private readonly sessionTokensBySessionId = new Map<string, string>();
  private hookUrl?: string;
  private hostToken?: string;
  private readonly tabs = new Map<string, Tab>();
  private supervisor?: ChromiumSupervisor;
  private registry?: BrowserContextRegistry;
  private initializing?: Promise<BrowserContextRegistry>;
  private closing = false;
  private closePromise?: Promise<void>;
  private captures = 0;
  private artifactSerial: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BrowserServiceOptions) {
    void getChromiumCapability().then(capability => { this.capability = capability; }, error => {
      this.capability = { available: false, reason: "Could not discover local Chromium" }; this.options.onError?.(error);
    });
    this.grants.onChange(workspaceId => {
      for (const tab of this.tabs.values()) if (tab.workspaceId === workspaceId) this.broadcast(tab);
    });
    this.grants.onRevoke(grant => {
      this.grantOwners.delete(grantKey(grant, grant.sessionId));
      const token = this.sessionTokensBySessionId.get(grant.sessionId), credential = token ? this.sessionCredentials.get(token) : undefined;
      if (credential && !this.grants.listForSession(grant.sessionId).some(active => !credential.target || active.workspaceId === credential.target.workspaceId && active.tabId === credential.target.tabId)) this.revokeSessionCredential(grant.sessionId);
    });
  }
  setHookEndpoint(url: string, hostToken: string) {
    this.hookUrl = url; this.hostToken = hostToken;
    for (const credential of this.sessionCredentials.values()) this.issueSessionCredential(credential.session, credential.target);
  }
  issueSessionCredential(session: BrowserSessionIdentity, target?: BrowserGrantTarget): string {
    if (this.closing) fail(503, "browser-shutdown", "Browser service is closing");
    const sessionId = text(session.sessionId, 256);
    if (!sessionId || sessionId === "." || sessionId === ".." || /[/\\\0]/.test(sessionId)) fail(400, "browser-session", "Invalid browser session identity");
    const token = this.sessionTokensBySessionId.get(sessionId) ?? randomBytes(32).toString("hex");
    const boundTarget = target ?? this.sessionCredentials.get(token)?.target;
    if (this.hookUrl) {
      const directory = join(this.options.dataDir, "browser-mcp-sessions"), path = join(directory, `${sessionId}.json`);
      mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
      const temporary = join(directory, `.${sessionId}.${crypto.randomUUID()}.tmp`);
      const credential: BrowserMcpCredentialFile = { version: 1, url: this.hookUrl, token, pid: process.pid, sessionId, ...boundTarget };
      try { writeFileSync(temporary, JSON.stringify(credential), { mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
      finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.onError?.(error); } }
    }
    this.sessionCredentials.set(token, { token, session: { ...session }, ...(boundTarget ? { target: { ...boundTarget } } : {}) });
    this.sessionTokensBySessionId.set(sessionId, token);
    return token;
  }
  private revokeSessionCredential(sessionId: string) {
    const token = this.sessionTokensBySessionId.get(sessionId);
    if (!token) return;
    this.sessionCredentials.delete(token); this.sessionTokensBySessionId.delete(sessionId);
    try { unlinkSync(join(this.options.dataDir, "browser-mcp-sessions", `${sessionId}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.options.onError?.(error); }
  }
  private tab(workspaceId: string, tabId: string): Tab {
    if (!workspaceId || !tabId || workspaceId.length > 256 || tabId.length > 256) fail(400, "browser-target", "Invalid browser target");
    const id = key(workspaceId, tabId);
    let tab = this.tabs.get(id);
    if (!tab) { tab = { workspaceId, tabId, attachments: new Set(), seq: 0, agentBusy: false, agentInput: { buttons: new Map(), keys: new Map(), touching: false, modifiers: 0 } }; this.tabs.set(id, tab); }
    return tab;
  }
  private async initialize(): Promise<BrowserContextRegistry> {
    if (this.closing) fail(503, "browser-shutdown", "Browser service is closing");
    if (this.registry) return this.registry;
    if (!this.initializing) this.initializing = (async () => {
      this.capability = await getChromiumCapability();
      if (!this.capability.available) fail(503, "browser-unavailable", this.capability.reason ?? "Chromium unavailable");
      if (this.closing) fail(503, "browser-shutdown", "Browser service is closing");
      this.supervisor ??= new ChromiumSupervisor({ dataDir: this.options.dataDir });
      const cdp = await this.supervisor.start();
      if (this.closing) fail(503, "browser-shutdown", "Browser service is closing");
      this.registry = new BrowserContextRegistry({ cdp, ...this.options.getOrigins(), grants: this.grants,
        supervisor: this.supervisor, onChange: state => this.changed(state), onError: this.options.onError });
      return this.registry;
    })().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  get(workspaceId: string, tabId: string): BrowserTabState {
    const tab = this.tabs.get(key(workspaceId, tabId));
    const current = this.registry?.getTab(workspaceId, tabId);
    if (current) {
      const { cdpSessionId, ...state } = current;
      return { ...state, capability: { ...this.capability }, viewerCount: [...tab?.attachments ?? []].filter(a => !!a.socket && !a.dead).length, screencastActive: !!tab?.stream?.active };
    }
    return { capability: { ...this.capability }, workspaceId, tabId, browserContextId: null, targetId: null,
      status: "absent", generation: 0, documentId: 0, url: "about:blank", title: "", viewport: { ...L.defaultViewport },
      control: { mode: "stopped", controllerAttachmentId: null, agentSessionId: null, leaseGeneration: 0, updatedAt: new Date().toISOString() },
      diagnostics: { collectionStartedAt: null, consoleNextSeq: 1, consoleTruncatedCount: 0, networkNextSeq: 1, networkTruncatedCount: 0 }, viewerCount: 0, screencastActive: false };
  }
  async start(workspaceId: string, tabId: string, url = "about:blank", check: () => void = () => {}) {
    const registry = await this.initialize();
    check();
    this.tab(workspaceId, tabId);
    await registry.startTab(workspaceId, tabId, text(url));
    return this.get(workspaceId, tabId);
  }
  async restart(workspaceId: string, tabId: string, url?: string, check: () => void = () => {}) {
    const registry = await this.initialize();
    check();
    await registry.restartTab(workspaceId, tabId, url === undefined ? undefined : text(url));
    return this.get(workspaceId, tabId);
  }
  async closeTab(workspaceId: string, tabId: string) {
    await this.requireRegistry().closeTab(workspaceId, tabId);
    return this.get(workspaceId, tabId);
  }
  private requireRegistry(): BrowserContextRegistry {
    if (this.closing) fail(503, "browser-shutdown", "Browser service is closing");
    return this.registry ?? fail(409, "browser-tab-absent", "Start the browser tab explicitly");
  }
  private running(workspaceId: string, tabId: string): RegistryState & { targetId: string; cdpSessionId: string } {
    const state = this.requireRegistry().getTab(workspaceId, tabId);
    if (state.status !== "running" || !state.targetId || !state.cdpSessionId) fail(409, "browser-tab-stopped", "Browser tab is not running");
    return state as RegistryState & { targetId: string; cdpSessionId: string };
  }
  private client(): CdpClient { return this.supervisor?.client ?? fail(409, "browser-disconnected", "Chromium is disconnected; restart the tab explicitly"); }
  private assertCurrent(state: RegistryState, document = true) {
    const current = this.running(state.workspaceId, state.tabId);
    if (current.targetId !== state.targetId || current.generation !== state.generation) fail(409, "browser-stale-target", "Browser target or control generation changed");
    if (document && current.documentId !== state.documentId) fail(409, "browser-stale-document", "Browser document changed; take a new snapshot");
  }
  private changed(state: RegistryState) {
    const tab = this.tab(state.workspaceId, state.tabId), previous = tab.previous;
    tab.previous = state;
    if (tab.refs?.identity !== identity(state)) tab.refs = undefined;
    if (previous?.cdpSessionId && (previous.control.mode === "agent-owned" && (state.control.mode !== "agent-owned" || state.control.leaseGeneration !== previous.control.leaseGeneration) || state.cdpSessionId !== previous.cdpSessionId || state.status !== "running")) {
      void this.releaseInputs(tab.agentInput, previous.cdpSessionId).catch(error => this.options.onError?.(error));
    }
    for (const a of tab.attachments) if (a.buttons.size || a.keys.size || a.touching || a.modifiers) {
      if (state.control.controllerAttachmentId !== a.id || state.control.mode !== "human-owned" || state.cdpSessionId !== previous?.cdpSessionId || state.status !== "running") {
        if (previous?.cdpSessionId) void this.releaseInputs(a, previous.cdpSessionId).catch(error => this.options.onError?.(error));
      }
    }
    const cdp = this.supervisor?.client;
    if (tab.stream && (state.status !== "running" || state.cdpSessionId !== tab.stream.sessionId || tab.stream.cdp !== cdp)) this.disposeStream(tab);
    if (!tab.stream && state.status === "running" && state.cdpSessionId && cdp) {
      const stream: Stream = { cdp, sessionId: state.cdpSessionId, active: false, desired: false, frames: new Map(), off: () => {} };
      tab.stream = stream;
      stream.off = cdp.onSessionEvent(stream.sessionId, event => this.frame(tab, stream, event.params), "Page.screencastFrame");
    }
    this.syncStream(tab); this.broadcast(tab);
    for (const a of tab.attachments) {
      if (state.lastDialog && state.lastDialog.dismissedAt !== previous?.lastDialog?.dismissedAt) this.send(a, { type: "dialog", generation: state.generation, dialog: state.lastDialog });
      if (state.lastBlockedPopup && state.lastBlockedPopup.blockedAt !== previous?.lastBlockedPopup?.blockedAt) this.send(a, { type: "popup-blocked", generation: state.generation, popup: state.lastBlockedPopup });
    }
  }
  private broadcast(tab: Tab) {
    const state = this.get(tab.workspaceId, tab.tabId);
    for (const a of tab.attachments) this.send(a, { type: "state", state });
  }
  private send(a: Attachment, message: BrowserServerMessage): boolean {
    if (a.dead || !a.socket) return false;
    if (!this.options.validToken(a.token)) { this.disconnect(a, 4401, "Authentication revoked"); return false; }
    try {
      if (a.socket.getBufferedAmount() > L.screenshotMaxBytes * 2 || a.socket.send(JSON.stringify(message)) === 0 || a.socket.getBufferedAmount() > L.screenshotMaxBytes * 2) {
        this.disconnect(a, 1013, "Slow browser viewer; reconnect"); return false;
      }
      return true;
    } catch { this.disconnect(a, 1011, "Socket send failed"); return false; }
  }
  private syncStream(tab: Tab) {
    const stream = tab.stream;
    if (!stream) return;
    const desired = !this.closing && this.get(tab.workspaceId, tab.tabId).status === "running" && [...tab.attachments].some(a => !a.dead && a.socket && a.visible);
    if (!desired && stream.desired && stream.syncing) void stream.cdp.sendSession(stream.sessionId, "Page.stopScreencast").catch(error => this.options.onError?.(error));
    stream.desired = desired;
    if (!stream.desired) for (const [seq, frame] of stream.frames) this.finishFrame(tab, stream, seq, frame);
    if (stream.syncing) return;
    stream.syncing = (async () => {
      while (stream.active !== stream.desired) {
        const desired = stream.desired;
        const viewport = this.get(tab.workspaceId, tab.tabId).viewport;
        await stream.cdp.sendSession(stream.sessionId, desired ? "Page.startScreencast" : "Page.stopScreencast", desired ? {
          format: "jpeg", quality: 80, maxWidth: viewport.width * viewport.deviceScaleFactor,
          maxHeight: viewport.height * viewport.deviceScaleFactor, everyNthFrame: 1,
        } : {});
        if (desired) await stream.cdp.sendSession(stream.sessionId, "Page.bringToFront").catch(() => {});
        stream.active = desired;
        if (tab.stream === stream) this.broadcast(tab);
      }
    })().catch(error => {
      stream.active = false; stream.desired = false;
      this.options.onError?.(error);
      for (const a of tab.attachments) this.send(a, { type: "error", code: "browser-screencast", message: "Browser streaming failed; reconnect or restart the tab" });
    }).finally(() => { stream.syncing = undefined; });
  }
  private disposeStream(tab: Tab) {
    const stream = tab.stream;
    if (!stream) return;
    tab.stream = undefined; stream.desired = false; stream.off();
    for (const [seq, frame] of stream.frames) this.finishFrame(tab, stream, seq, frame);
    void stream.cdp.sendSession(stream.sessionId, "Page.stopScreencast").catch(() => {});
    stream.active = false;
  }
  private finishFrame(tab: Tab, stream: Stream, seq: number, frame: Frame) {
    if (!stream.frames.delete(seq)) return;
    clearTimeout(frame.timer);
    for (const a of frame.waiting) { a.pending.delete(seq); a.discardedSeq = Math.max(a.discardedSeq, seq); }
    frame.waiting.clear();
    void stream.cdp.sendSession(stream.sessionId, "Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(error => { if (tab.stream === stream) this.options.onError?.(error); });
  }
  private frame(tab: Tab, stream: Stream, params: Record<string, unknown>) {
    if (typeof params.sessionId !== "number") return;
    const seq = ++tab.seq;
    const frame: Frame = { sessionId: params.sessionId, waiting: new Set(), timer: setTimeout(() => {
      for (const a of [...frame.waiting]) this.disconnect(a, 1013, "Browser frame acknowledgement timeout");
      this.finishFrame(tab, stream, seq, frame);
    }, 5000) };
    frame.timer.unref(); stream.frames.set(seq, frame);
    if (stream.frames.size > 2 || typeof params.data !== "string" || params.data.length > Math.ceil(L.screenshotMaxBytes / 3) * 4) {
      this.finishFrame(tab, stream, seq, frame); return;
    }
    const state = this.get(tab.workspaceId, tab.tabId);
    if (stream.desired && state.status === "running") {
      const viewers = [...tab.attachments].filter(a => !a.dead && a.socket && a.visible);
      for (const a of viewers) { a.pending.add(seq); frame.waiting.add(a); }
      for (const a of viewers) {
        if (a.pending.size > 2) { this.disconnect(a, 1013, "Browser frame window exceeded"); continue; }
        if (!this.send(a, { type: "frame", seq, generation: state.generation, documentId: state.documentId, format: "jpeg", data: params.data,
          metadata: params.metadata as Extract<BrowserServerMessage, { type: "frame" }>["metadata"] })) { a.pending.delete(seq); frame.waiting.delete(a); }
      }
    }
    if (!frame.waiting.size) this.finishFrame(tab, stream, seq, frame);
  }
  private forgetFrames(a: Attachment) {
    const stream = a.tab.stream;
    for (const seq of a.pending) a.discardedSeq = Math.max(a.discardedSeq, seq);
    if (stream) for (const seq of a.pending) {
      const frame = stream.frames.get(seq);
      if (frame) { frame.waiting.delete(a); if (!frame.waiting.size) this.finishFrame(a.tab, stream, seq, frame); }
    }
    a.pending.clear();
  }
  async prepare(workspaceId: string, tabId: string, token: string): Promise<BrowserSocketData> {
    this.running(workspaceId, tabId);
    if (!this.options.validToken(token)) fail(401, "browser-auth", "Authentication revoked");
    const tab = this.tab(workspaceId, tabId);
    if (tab.attachments.size >= L.maxAttachmentsPerTab) fail(429, "browser-attachments", "Browser attachment limit reached");
    const a: Attachment = { id: crypto.randomUUID(), token, tab, dead: false, visible: true, pending: new Set(), discardedSeq: 0, buttons: new Map(), keys: new Map(), touching: false, modifiers: 0, window: Date.now(), messages: 0, operations: 0 };
    tab.attachments.add(a);
    a.timer = setTimeout(() => this.disconnect(a, 1013, "Browser upgrade timeout"), 5000); a.timer.unref();
    return { browserAttachment: a };
  }
  cancelUpgrade(data: BrowserSocketData) { this.detach(data.browserAttachment); }
  revoke(token: string) {
    for (const tab of this.tabs.values()) for (const a of [...tab.attachments]) if (a.token === token) this.disconnect(a, 4401, "Signed out");
    for (const owner of [...this.grantOwners.values()]) if (owner.token === token) {
      try { this.revokeGrant(owner.target, owner.sessionId); } catch (error) { this.options.onError?.(error); }
    }
  }
  private disconnect(a: Attachment, code: number, reason: string) {
    if (a.dead) return;
    this.detach(a); try { a.socket?.close(code, reason); } catch {}
    if ([1008, 1009, 1011, 1013, 4401].includes(code)) this.options.onError?.(new Error(`Browser viewer disconnected (${code}): ${reason} [workspace=${a.tab.workspaceId} tab=${a.tab.tabId}]`));
  }
  private detach(a: Attachment) {
    if (a.dead) return;
    a.dead = true; clearTimeout(a.timer); this.forgetFrames(a); a.tab.attachments.delete(a);
    const state = this.registry?.getTab(a.tab.workspaceId, a.tab.tabId);
    if (state?.cdpSessionId) void this.releaseInputs(a, state.cdpSessionId).catch(error => this.options.onError?.(error));
    if (state?.status === "running") {
      this.registry!.getBroker(a.tab.workspaceId, a.tab.tabId).detachAttachment(a.id);
    }
    if (state && state.status !== "absent") this.registry!.setTabViewerCount(a.tab.workspaceId, a.tab.tabId, [...a.tab.attachments].filter(a => !!a.socket).length);
    this.syncStream(a.tab); this.broadcast(a.tab);
  }
  private releaseInputs(a: PressedInput, sessionId: string): Promise<unknown> {
    const cdp = this.supervisor?.client, commands: Promise<unknown>[] = [];
    if (cdp) {
      for (const [button, position] of a.buttons) commands.push(cdp.sendSession(sessionId, "Input.dispatchMouseEvent", { type: "mouseReleased", button, ...position, buttons: 0, modifiers: 0, clickCount: 1 }));
      for (const event of a.keys.values()) commands.push(cdp.sendSession(sessionId, "Input.dispatchKeyEvent", { ...event, type: "keyUp", text: undefined, unmodifiedText: undefined, modifiers: 0 }));
      for (const [bit, key, code] of [[1, "Alt", "AltLeft"], [2, "Control", "ControlLeft"], [4, "Meta", "MetaLeft"], [8, "Shift", "ShiftLeft"]] as const) {
        if (a.modifiers & bit) commands.push(cdp.sendSession(sessionId, "Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers: 0 }));
      }
      if (a.touching) commands.push(cdp.sendSession(sessionId, "Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }));
    }
    a.buttons.clear(); a.keys.clear(); a.touching = false; a.modifiers = 0;
    return Promise.all(commands);
  }
  readonly websocket: Bun.WebSocketHandler<BrowserSocketData> = {
    maxPayloadLength: 65536, backpressureLimit: L.screenshotMaxBytes * 2, closeOnBackpressureLimit: true,
    perMessageDeflate: false, idleTimeout: 60, sendPings: true,
    open: socket => {
      const a = socket.data.browserAttachment; a.socket = socket; clearTimeout(a.timer); a.timer = undefined;
      if (a.dead || this.closing || !this.options.validToken(a.token)) { this.disconnect(a, 4401, "Attachment unavailable"); socket.close(4401, "Attachment unavailable"); return; }
      const state = this.registry?.getTab(a.tab.workspaceId, a.tab.tabId);
      if (state?.status !== "running") { this.disconnect(a, 1008, "Browser tab stopped"); return; }
      this.send(a, { type: "hello", attachmentId: a.id, state: this.get(a.tab.workspaceId, a.tab.tabId) });
      if (!a.dead) this.registry!.setTabViewerCount(a.tab.workspaceId, a.tab.tabId, [...a.tab.attachments].filter(a => !!a.socket && !a.dead).length);
      this.syncStream(a.tab);
    },
    message: (socket, raw) => this.message(socket.data.browserAttachment, raw),
    close: socket => this.detach(socket.data.browserAttachment),
    drain: socket => { const a = socket.data.browserAttachment; if (!this.options.validToken(a.token)) this.disconnect(a, 4401, "Authentication revoked"); },
  };
  private message(a: Attachment, raw: string | Buffer) {
    if (a.dead) return;
    if (!this.options.validToken(a.token)) { this.disconnect(a, 4401, "Authentication revoked"); return; }
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536) { this.disconnect(a, 1009, "Expected bounded JSON text"); return; }
    try {
      const message = record(JSON.parse(raw)) as BrowserClientMessage;
      if (message.type === "ack") {
        if (!Number.isSafeInteger(message.seq) || message.seq <= 0) { this.disconnect(a, 1008, "Unexpected frame acknowledgement"); return; }
        if (!a.pending.delete(message.seq)) {
          if (message.seq <= a.discardedSeq) return;
          this.disconnect(a, 1008, "Unexpected frame acknowledgement"); return;
        }
        const stream = a.tab.stream, frame = stream?.frames.get(message.seq);
        if (stream && frame) { frame.waiting.delete(a); if (!frame.waiting.size) this.finishFrame(a.tab, stream, message.seq, frame); }
        return;
      }
      if (Date.now() - a.window > 1000) { a.window = Date.now(); a.messages = 0; }
      if (++a.messages > 600 || a.operations >= 128) { this.disconnect(a, 1013, "Browser input backlog exceeded"); return; }
      if (message.type === "visibility") {
        if (typeof message.visible !== "boolean") fail(400, "browser-visibility", "Expected viewer visibility");
        a.visible = message.visible; if (!a.visible) this.forgetFrames(a); this.syncStream(a.tab); return;
      }
      const state = this.running(a.tab.workspaceId, a.tab.tabId);
      if (!("generation" in message) || message.generation !== state.generation) fail(409, "browser-stale-control", "Browser generation changed; refresh the state");
      const broker = this.requireRegistry().getBroker(state.workspaceId, state.tabId), generation = state.control.leaseGeneration;
      if (message.type === "claim" || message.type === "take" || message.type === "release") { broker[message.type](a.id, generation); this.broadcast(a.tab); return; }
      if (message.type === "pause-agent") { broker.onHumanInput(a.id, "pause"); this.broadcast(a.tab); return; }
      if (message.type === "resume-agent") {
        const sessionId = text(message.agentSessionId, 256);
        const grant = this.listGrants(state.workspaceId, state.tabId).find(grant => grant.sessionId === sessionId && grant.scope === "control");
        if (!grant) fail(403, "browser-grant-required", "An explicit Control grant is required");
        this.agentTarget(grant, "control", { workspaceId: state.workspaceId, tabId: state.tabId });
        if (state.control.controllerAttachmentId && state.control.controllerAttachmentId !== a.id) fail(403, "browser-viewer", "Take control before resuming the agent");
        broker.resumeAgent(sessionId, generation); this.broadcast(a.tab); return;
      }
      let operation: Promise<unknown>;
      if (message.type === "navigate") {
        this.validateNavigation(message);
        broker.onHumanInput(a.id, "navigate");
        operation = this.navigate(state.workspaceId, state.tabId, message, () => this.assertViewer(a, state.cdpSessionId));
      } else if (["pointer", "wheel", "key", "touch"].includes(message.type)) {
        const input = this.input(message, state, a);
        broker.onHumanInput(a.id, input.kind);
        this.assertViewer(a, state.cdpSessionId);
        this.trackInput(a, input.method, input.params);
        operation = this.client().sendSession(state.cdpSessionId, input.method, input.params);
      } else fail(400, "browser-message", "Unknown browser message");
      a.operations++;
      void operation.catch(error => this.operationError(a, error)).finally(() => { a.operations--; });
    } catch (error) { this.operationError(a, error); }
  }
  private operationError(a: Attachment, error: unknown) {
    const known = error instanceof BrowserContextError || error instanceof BrowserControlError || error instanceof BrowserGrantError;
    this.send(a, { type: "error", code: known ? error.code : "browser-operation", message: known ? error.message : "Browser operation failed" });
    if (!known) this.options.onError?.(error);
  }
  private assertViewer(a: Attachment, sessionId: string) {
    if (a.dead || !this.options.validToken(a.token)) fail(401, "browser-auth", "Viewer authorization changed");
    const state = this.running(a.tab.workspaceId, a.tab.tabId);
    if (state.cdpSessionId !== sessionId || state.control.mode !== "human-owned" || state.control.controllerAttachmentId !== a.id) fail(409, "browser-stale-control", "Viewer control changed");
  }
  private point(state: BrowserTabState, x: unknown, y: unknown) {
    return { x: Math.max(0, Math.min(state.viewport.width, finite(x))), y: Math.max(0, Math.min(state.viewport.height, finite(y))) };
  }
  private input(message: BrowserClientMessage, state: BrowserTabState, pressed: PressedInput): { method: string; params: Record<string, unknown>; kind: BrowserHumanInputKind } {
    if (!("event" in message)) return fail(400, "browser-input", "Expected an input event");
    const e = record(message.event), modifiers = e.modifiers === undefined ? 0 : integer(e.modifiers, 0, 15);
    if (message.type === "pointer" || message.type === "wheel") {
      const position = this.point(state, e.x, e.y);
      if (message.type === "wheel") return { method: "Input.dispatchMouseEvent", kind: "wheel", params: { type: "mouseWheel", ...position, modifiers, deltaX: finite(e.deltaX), deltaY: finite(e.deltaY) } };
      if (!["mousePressed", "mouseReleased", "mouseMoved"].includes(e.type) || e.button !== undefined && !["none", "left", "middle", "right", "back", "forward"].includes(e.button)) fail(400, "browser-input", "Invalid pointer event");
      if (e.pointerType !== undefined && e.pointerType !== "mouse" && e.pointerType !== "pen") fail(400, "browser-input", "Invalid pointer type");
      const button = e.button ?? (e.type === "mouseMoved" ? "none" : "left");
      if (e.type !== "mouseMoved" && button === "none") fail(400, "browser-input", "A pressed or released mouse button is required");
      const buttonBits: Record<string, number> = { none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 };
      let buttons = [...pressed.buttons.keys()].reduce((mask, name) => mask | buttonBits[name]!, 0);
      if (e.type === "mousePressed") buttons |= buttonBits[button]!;
      if (e.type === "mouseReleased") buttons &= ~buttonBits[button]!;
      return { method: "Input.dispatchMouseEvent", kind: e.type, params: { type: e.type, ...position, modifiers, button, buttons: e.buttons === undefined ? buttons : integer(e.buttons, 0, 31), clickCount: e.clickCount === undefined ? 1 : integer(e.clickCount, 0, 3), pointerType: e.pointerType ?? "mouse" } };
    }
    if (message.type === "key") {
      if (!["keyDown", "keyUp", "rawKeyDown", "char"].includes(e.type)) fail(400, "browser-input", "Invalid key event");
      const params: Record<string, unknown> = { type: e.type, modifiers };
      for (const name of ["key", "code", "text", "unmodifiedText"]) if (e[name] !== undefined) params[name] = text(e[name]);
      for (const name of ["windowsVirtualKeyCode", "nativeVirtualKeyCode"]) if (e[name] !== undefined) params[name] = integer(e[name], 0, 65535);
      if (e.location !== undefined) params.location = integer(e.location, 0, 3);
      for (const name of ["autoRepeat", "isKeypad"]) if (e[name] !== undefined) { if (typeof e[name] !== "boolean") fail(400, "browser-input", "Invalid key flag"); params[name] = e[name]; }
      return { method: "Input.dispatchKeyEvent", kind: e.type, params };
    }
    if (message.type === "touch") {
      if (!["touchStart", "touchMove", "touchEnd", "touchCancel"].includes(e.type) || !Array.isArray(e.touchPoints) || e.touchPoints.length > 10) fail(400, "browser-input", "Invalid touch event");
      const touchPoints = e.touchPoints.map((value: unknown) => {
        const p = record(value), result: Record<string, unknown> = this.point(state, p.x, p.y);
        if (p.id !== undefined) result.id = integer(p.id, 0, 2147483647);
        for (const name of ["radiusX", "radiusY", "rotationAngle", "force"]) if (p[name] !== undefined) {
          const value = finite(p[name]);
          if (value < 0 || name === "force" && value > 1 || name === "rotationAngle" && value > 360) fail(400, "browser-input", "Invalid touch geometry");
          result[name] = value;
        }
        return result;
      });
      if ((e.type === "touchEnd" || e.type === "touchCancel") && touchPoints.length) fail(400, "browser-input", "Touch end events must have no touch points");
      return { method: "Input.dispatchTouchEvent", kind: e.type, params: { type: e.type, touchPoints, modifiers } };
    }
    return fail(400, "browser-input", "Invalid input event");
  }
  private trackInput(a: PressedInput, method: string, params: Record<string, unknown>) {
    a.modifiers = typeof params.modifiers === "number" ? params.modifiers : 0;
    if (method === "Input.dispatchMouseEvent") {
      if (params.type === "mousePressed" && params.button !== "none") a.buttons.set(String(params.button), { x: Number(params.x), y: Number(params.y) });
      if (params.type === "mouseReleased") a.buttons.delete(String(params.button));
      if (params.type === "mouseMoved") for (const button of a.buttons.keys()) a.buttons.set(button, { x: Number(params.x), y: Number(params.y) });
    }
    if (method === "Input.dispatchKeyEvent") {
      const id = String(params.code ?? params.key ?? params.windowsVirtualKeyCode ?? "");
      if (params.type === "keyUp") a.keys.delete(id);
      else if (params.type !== "char") { if (a.keys.size >= 32 && !a.keys.has(id)) fail(429, "browser-keys", "Too many pressed keys"); a.keys.set(id, params as BrowserKeyEventInput); }
    }
    if (method === "Input.dispatchTouchEvent") a.touching = params.type !== "touchEnd" && params.type !== "touchCancel";
  }
  private validateNavigation(input: { action: string; url?: string }) {
    if (!["url", "back", "forward", "reload"].includes(input.action)) fail(400, "browser-navigation", "Invalid navigation action");
    if (input.action === "url") this.requireRegistry().assertAllowedUrl(text(input.url));
  }
  async navigate(workspaceId: string, tabId: string, input: { action: "url" | "back" | "forward" | "reload"; url?: string }, check: () => void) {
    this.validateNavigation(input);
    const state = this.running(workspaceId, tabId), cdp = this.client();
    const send = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => { check(); this.assertCurrent(state, false); return cdp.sendSession<T>(state.cdpSessionId, method, params); };
    if (input.action === "url") {
      const result = await send<{ errorText?: string }>("Page.navigate", { url: this.requireRegistry().assertAllowedUrl(input.url!) });
      if (result.errorText) fail(409, "browser-navigation-failed", result.errorText);
    } else if (input.action === "reload") await send("Page.reload");
    else {
      const history = await send<{ currentIndex: number; entries: { id: number; url: string }[] }>("Page.getNavigationHistory");
      const entry = history.entries[history.currentIndex + (input.action === "back" ? -1 : 1)];
      if (!entry) fail(409, "browser-history", "No browser history entry in that direction");
      this.requireRegistry().assertAllowedUrl(entry.url);
      await send("Page.navigateToHistoryEntry", { entryId: entry.id });
    }
    check(); this.assertCurrent(state, false);
    return this.get(workspaceId, tabId);
  }
  async snapshot(workspaceId: string, tabId: string, options: BrowserSnapshotInput = {}): Promise<BrowserSnapshotResult> {
    const state = this.running(workspaceId, tabId), tab = this.tab(workspaceId, tabId), cdp = this.client();
    const limit = options.limit === undefined ? 200 : integer(options.limit, 1, 500);
    const result = await cdp.sendSession<{ nodes: { ignored?: boolean; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; description?: { value?: string }; properties?: { name: string; value: { value?: unknown } }[] }[] }>(state.cdpSessionId, "Accessibility.getFullAXTree");
    this.assertCurrent(state);
    const refs = tab.refs ??= { identity: identity(state), next: 0, byRef: new Map(), byNode: new Map() };
    const roles = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton", "switch", "tab", "treeitem", "scrollbar"]);
    const nodes = result.nodes.filter(node => !node.ignored && node.backendDOMNodeId && (roles.has(node.role?.value ?? "") || node.properties?.some(p => p.name === "focusable" && p.value.value === true)));
    const elements: BrowserSnapshotNode[] = [];
    for (const node of nodes.slice(0, limit)) {
      this.assertCurrent(state);
      const backendNodeId = node.backendDOMNodeId!;
      let ref = refs.byNode.get(backendNodeId);
      if (!ref) {
        if (refs.byRef.size >= 2000) continue;
        ref = `e${++refs.next}`; refs.byNode.set(backendNodeId, ref); refs.byRef.set(ref, { backendNodeId });
      }
      const element = refs.byRef.get(ref)!;
      try { element.bounds = await this.bounds(state, backendNodeId); } catch { this.assertCurrent(state); element.bounds = undefined; }
      const properties = new Map(node.properties?.map(p => [p.name, p.value.value]));
      const checked = properties.get("checked");
      elements.push({ ref, role: String(node.role?.value ?? "generic").slice(0, 256), name: String(node.name?.value ?? "").slice(0, 8192),
        ...(node.value?.value === undefined ? {} : { value: String(node.value.value).slice(0, 8192) }),
        ...(node.description?.value === undefined ? {} : { description: String(node.description.value).slice(0, 8192) }),
        disabled: properties.get("disabled") === true, focused: properties.get("focused") === true,
        ...(checked === undefined ? {} : { checked: checked === "mixed" ? "mixed" as const : checked === true || checked === "true" }), bounds: element.bounds });
    }
    this.assertCurrent(state);
    return { workspaceId, tabId, targetId: state.targetId, generation: state.generation, documentId: state.documentId, url: state.url, title: state.title, viewport: state.viewport, elements, truncated: nodes.length > elements.length };
  }
  private async bounds(state: RegistryState, backendNodeId: number) {
    const { model } = await this.client().sendSession<{ model: { border: number[] } }>(state.cdpSessionId!, "DOM.getBoxModel", { backendNodeId });
    const x = Math.min(...model.border.filter((_, i) => i % 2 === 0)), y = Math.min(...model.border.filter((_, i) => i % 2 === 1));
    const width = Math.max(...model.border.filter((_, i) => i % 2 === 0)) - x, height = Math.max(...model.border.filter((_, i) => i % 2 === 1)) - y;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) fail(409, "browser-element-hidden", "Element has no visible bounds");
    return { x, y, width, height };
  }
  async screenshot(workspaceId: string, tabId: string, options: BrowserScreenshotInput = {}, check: () => void = () => {}): Promise<BrowserScreenshotResult> {
    if (this.captures >= 4) fail(429, "browser-capture-busy", "Too many browser captures");
    if (options.format !== undefined && options.format !== "png" && options.format !== "jpeg") fail(400, "browser-screenshot-format", "Expected PNG or JPEG");
    if (options.fullPage !== undefined && typeof options.fullPage !== "boolean" || options.saveArtifact !== undefined && typeof options.saveArtifact !== "boolean") fail(400, "browser-screenshot", "Invalid screenshot options");
    this.captures++;
    try {
      const state = this.running(workspaceId, tabId), cdp = this.client(), deadline = Date.now() + L.fullPageTimeoutMs;
      const send = <T>(method: string, params: Record<string, unknown> = {}) => {
        check(); this.assertCurrent(state);
        if (Date.now() >= deadline) fail(408, "browser-capture-timeout", "Browser capture timed out");
        return cdp.sendSession<T>(state.cdpSessionId, method, params, { timeoutMs: Math.max(1, deadline - Date.now()) });
      };
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
      if (options.fullPage) {
        const metrics = await send<{ cssContentSize: { x: number; y: number; width: number; height: number } }>("Page.getLayoutMetrics");
        const size = metrics.cssContentSize;
        if (!size || ![size.x, size.y, size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0 || Math.max(size.width, size.height) * state.viewport.deviceScaleFactor > L.fullPageMaxDimension) fail(413, "browser-capture-dimensions", "Full-page capture exceeds the maximum dimension");
        clip = { ...size, scale: 1 };
      }
      const format = options.format ?? "png";
      const { data } = await send<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 80 } : {}), fromSurface: true, captureBeyondViewport: !!options.fullPage, ...(clip ? { clip } : {}) });
      check(); this.assertCurrent(state);
      if (typeof data !== "string" || data.length > Math.ceil(L.screenshotMaxBytes / 3) * 4) fail(413, "browser-capture-size", "Screenshot exceeds 5 MB");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > L.screenshotMaxBytes || bytes.toString("base64") !== data) fail(413, "browser-capture-size", "Invalid or oversized screenshot");
      const result: BrowserScreenshotResult = { workspaceId, tabId, targetId: state.targetId, generation: state.generation, documentId: state.documentId, capturedAt: new Date().toISOString(), viewport: state.viewport, mimeType: format === "png" ? "image/png" : "image/jpeg", data, fullPage: !!options.fullPage };
      if (options.saveArtifact) result.savedArtifactPath = await this.saveArtifact(result, bytes, check);
      return result;
    } finally { this.captures--; }
  }
  private artifactPath() { return join(this.options.dataDir, "browser-artifacts"); }
  private serializeArtifacts<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.artifactSerial.then(operation);
    this.artifactSerial = task.catch(() => {}); return task;
  }
  private async artifacts(): Promise<BrowserArtifact[]> {
    let names: string[];
    try { names = await readdir(this.artifactPath()); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const artifacts: BrowserArtifact[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !artifactIdPattern.test(name.slice(0, -5))) continue;
      const value = JSON.parse(await readFile(join(this.artifactPath(), name), "utf8")) as BrowserArtifact;
      if (value.artifactId !== name.slice(0, -5) || !["image/png", "image/jpeg"].includes(value.mimeType) || typeof value.workspaceId !== "string" || typeof value.tabId !== "string" || typeof value.capturedAt !== "string") fail(503, "browser-artifact-storage", "Invalid browser artifact metadata");
      const path = join(this.artifactPath(), `${value.artifactId}.${value.mimeType === "image/png" ? "png" : "jpeg"}`);
      let info;
      try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (!info.isFile()) fail(503, "browser-artifact-storage", "Invalid browser artifact file");
      artifacts.push({ ...value, path, bytes: info.size });
    }
    return artifacts.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }
  listArtifacts(workspaceId?: string): Promise<BrowserArtifact[]> { return this.serializeArtifacts(async () => (await this.artifacts()).filter(a => !workspaceId || a.workspaceId === workspaceId)); }
  private async artifactUsage() {
    let names: string[];
    try { names = await readdir(this.artifactPath()); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: 0, bytes: 0 }; throw error; }
    let files = 0, bytes = 0;
    for (const name of names) {
      const extension = /\.(png|jpeg)$/.exec(name);
      if (!extension || !artifactIdPattern.test(name.slice(0, -extension[0].length))) continue;
      const info = await lstat(join(this.artifactPath(), name));
      if (!info.isFile()) fail(503, "browser-artifact-storage", "Invalid browser artifact file");
      files++; bytes += info.size;
    }
    return { files, bytes };
  }
  private saveArtifact(result: BrowserScreenshotResult, bytes: Buffer, check: () => void): Promise<string> {
    return this.serializeArtifacts(async () => {
      if (this.closing) fail(503, "browser-shutdown", "Browser service is closing");
      const usage = await this.artifactUsage();
      if (usage.files >= L.savedArtifactsMaxFiles || usage.bytes + bytes.length > L.savedArtifactsMaxBytes) fail(429, "browser-artifact-quota", "Delete saved browser artifacts before exporting more");
      await mkdir(this.artifactPath(), { recursive: true, mode: 0o700 });
      check();
      const artifactId = crypto.randomUUID(), path = join(this.artifactPath(), `${artifactId}.${result.mimeType === "image/png" ? "png" : "jpeg"}`);
      const artifact: BrowserArtifact = { artifactId, workspaceId: result.workspaceId, tabId: result.tabId, capturedAt: result.capturedAt, mimeType: result.mimeType, bytes: bytes.length, path };
      const metadataPath = join(this.artifactPath(), `${artifactId}.json`);
      await writeFile(metadataPath, JSON.stringify(artifact), { mode: 0o600, flag: "wx" });
      try { check(); await writeFile(path, bytes, { mode: 0o600, flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlink(path).catch(() => {});
        await unlink(metadataPath); throw error;
      }
      return path;
    });
  }
  deleteArtifact(artifactId: string, workspaceId?: string, check: () => void = () => {}): Promise<void> {
    return this.serializeArtifacts(async () => {
      if (!artifactIdPattern.test(artifactId)) fail(400, "browser-artifact-id", "Invalid browser artifact identifier");
      const artifact = (await this.artifacts()).find(a => a.artifactId === artifactId && (!workspaceId || a.workspaceId === workspaceId));
      if (!artifact) fail(404, "browser-artifact-absent", "Unknown browser artifact");
      check();
      await unlink(artifact.path); await unlink(join(this.artifactPath(), `${artifactId}.json`));
    });
  }
  consoleLogs(workspaceId: string, tabId: string, query: BrowserConsoleLogsInput = {}) { return this.requireRegistry().getDiagnostics(workspaceId, tabId).queryConsole(query); }
  networkRequests(workspaceId: string, tabId: string, query: BrowserNetworkRequestsInput = {}) { return this.requireRegistry().getDiagnostics(workspaceId, tabId).queryNetwork(query); }
  listGrants(workspaceId: string, tabId: string) { return this.grants.listForTab(workspaceId, tabId); }
  setGrant(target: BrowserGrantTarget, sessionIdentity: BrowserSessionIdentity, scope: BrowserGrantScope, ownerToken?: string) {
    const session = record(sessionIdentity), fields = ["sessionId", "harness", "authorityId", "nativeSessionId"];
    if (Object.keys(session).length !== fields.length || !fields.every(field => typeof session[field] === "string" && session[field].length > 0 && session[field].length <= 256)
      || scope !== "observe" && scope !== "control") fail(400, "browser-grant-input", "Provide an exact session identity and Observe or Control scope");
    if (ownerToken !== undefined && !this.options.validToken(ownerToken)) fail(401, "browser-auth", "Authentication revoked");
    this.running(target.workspaceId, target.tabId);
    this.validateSession(target, sessionIdentity);
    const id = grantKey(target, sessionIdentity.sessionId), token = ownerToken ?? this.grantOwners.get(id)?.token;
    try {
      const grant = this.grants.grant(target, sessionIdentity, scope);
      this.issueSessionCredential(sessionIdentity, target);
      if (scope === "control") this.requireRegistry().getBroker(target.workspaceId, target.tabId).grantAgentControl(sessionIdentity.sessionId);
      return grant;
    }
    finally {
      if (token && this.grants.listForTab(target.workspaceId, target.tabId).some(grant => grant.sessionId === sessionIdentity.sessionId
        && grant.harness === sessionIdentity.harness && grant.authorityId === sessionIdentity.authorityId && grant.nativeSessionId === sessionIdentity.nativeSessionId && grant.scope === scope)) {
        this.grantOwners.set(id, { target: { ...target }, sessionId: sessionIdentity.sessionId, token });
      }
    }
  }
  private validateSession(target: BrowserGrantTarget, session: BrowserSessionIdentity) {
    try { this.options.validateSession?.(target, session); }
    catch (error) {
      if (error instanceof BrowserGrantError || error instanceof BrowserContextError) throw error;
      fail(409, "browser-grant-unavailable", "This conversation is unavailable for browser access");
    }
  }
  revokeGrant(target: BrowserGrantTarget, sessionId: string) { this.grants.revoke(target, sessionId); }
  revokeAllGrants() {
    try { this.grants.revokeAll(); }
    finally { for (const sessionId of this.sessionTokensBySessionId.keys()) this.revokeSessionCredential(sessionId); }
  }
  private agentTarget(session: BrowserSessionIdentity, scope: BrowserGrantScope, target?: BrowserGrantTarget): BrowserGrantTarget {
    const candidates = this.grants.listForSession(session.sessionId).filter(grant => (!target || grant.workspaceId === target.workspaceId && grant.tabId === target.tabId) && this.grants.check(session, scope, grant));
    if (!candidates.length) fail(403, "browser-grant-required", `An explicit browser ${scope} grant for this verified session is required`);
    if (candidates.length !== 1) fail(409, "browser-target-ambiguous", "Session has multiple browser grants; select an authorized target at the transport boundary");
    const resolved = { workspaceId: candidates[0]!.workspaceId, tabId: candidates[0]!.tabId };
    try { this.validateSession(resolved, session); }
    catch (error) { this.revokeGrant(resolved, session.sessionId); throw error; }
    return resolved;
  }
  agentStatus(session: BrowserSessionIdentity, target?: BrowserGrantTarget) {
    const t = this.agentTarget(session, "observe", target);
    const grantedScope: BrowserGrantScope = this.grants.check(session, "control", t) ? "control" : "observe";
    const state = this.get(t.workspaceId, t.tabId);
    const brokerState = this.registry?.getTab(t.workspaceId, t.tabId)?.control;
    const canMutate = grantedScope === "control" && state.status === "running" && state.control.mode !== "paused" && !brokerState?.pausedByHuman && (state.control.mode !== "agent-owned" || state.control.agentSessionId === session.sessionId);
    return { ...state, grantedScope, canMutate };
  }
  async agentSnapshot(session: BrowserSessionIdentity, options: BrowserSnapshotInput = {}, target?: BrowserGrantTarget) {
    const t = this.agentTarget(session, "observe", target), result = await this.snapshot(t.workspaceId, t.tabId, options);
    this.agentTarget(session, "observe", t); return result;
  }
  async agentScreenshot(session: BrowserSessionIdentity, options: BrowserScreenshotInput = {}, target?: BrowserGrantTarget) {
    const t = this.agentTarget(session, "observe", target), result = await this.screenshot(t.workspaceId, t.tabId, { fullPage: options.fullPage, format: options.format, saveArtifact: options.saveArtifact ?? true });
    this.agentTarget(session, "observe", t); return result;
  }
  agentConsoleLogs(session: BrowserSessionIdentity, query: BrowserConsoleLogsInput = {}, target?: BrowserGrantTarget) {
    const t = this.agentTarget(session, "observe", target); return this.consoleLogs(t.workspaceId, t.tabId, query);
  }
  agentNetworkRequests(session: BrowserSessionIdentity, query: BrowserNetworkRequestsInput = {}, target?: BrowserGrantTarget) {
    const t = this.agentTarget(session, "observe", target); return this.networkRequests(t.workspaceId, t.tabId, query);
  }
  private async mutate(session: BrowserSessionIdentity, input: BrowserAgentMutationInput, target: BrowserGrantTarget | undefined,
    operation: (state: RegistryState & { targetId: string; cdpSessionId: string }, check: () => void) => Promise<unknown>, documentId?: number) {
    const t = this.agentTarget(session, "control", target), before = this.running(t.workspaceId, t.tabId), tab = this.tab(t.workspaceId, t.tabId);
    if (documentId !== undefined && documentId !== before.documentId) fail(409, "browser-stale-document", "Browser document changed; take a new snapshot");
    if (input.generation !== before.generation || input.leaseGeneration !== before.control.leaseGeneration) fail(409, "browser-stale-control", "Browser control changed; refresh browser status");
    if (tab.agentBusy) fail(409, "browser-agent-busy", "An agent mutation is already pending for this tab");
    tab.agentBusy = true;
    try {
      const broker = this.requireRegistry().getBroker(t.workspaceId, t.tabId), lease = broker.acquireAgentLease(session.sessionId, true);
      const state = this.running(t.workspaceId, t.tabId);
      const check = (checkDocument = true) => {
        this.agentTarget(session, "control", t); broker.assertAgentLease(session.sessionId, lease.leaseGeneration);
        this.assertCurrent(state, checkDocument && documentId !== undefined);
      };
      check();
      await new Promise<unknown>((resolve, reject) => {
        const aborted = () => { lease.signal.removeEventListener("abort", aborted); reject(lease.signal.reason ?? new BrowserControlError(409, "browser-agent-preempted", "Browser agent lease was revoked")); };
        const finish = () => { lease.signal.removeEventListener("abort", aborted); };
        lease.signal.addEventListener("abort", aborted, { once: true });
        void Promise.resolve().then(() => { check(); return operation(state, check); }).then(
          result => { finish(); resolve(result); }, error => { finish(); reject(error); },
        );
        if (lease.signal.aborted) aborted();
      });
      check(false); return this.get(t.workspaceId, t.tabId);
    } finally {
      const state = this.registry?.getTab(t.workspaceId, t.tabId);
      try {
        if (state?.cdpSessionId && (tab.agentInput.buttons.size || tab.agentInput.keys.size || tab.agentInput.touching || tab.agentInput.modifiers)) await this.releaseInputs(tab.agentInput, before.cdpSessionId);
      } finally { tab.agentBusy = false; }
    }
  }
  agentNavigate(session: BrowserSessionIdentity, input: BrowserNavigateInput, target?: BrowserGrantTarget) {
    this.validateNavigation(input);
    return this.mutate(session, input, target, (state, check) => this.navigate(state.workspaceId, state.tabId, input, check));
  }
  private reference(state: RegistryState, ref: string, documentId: number): Element {
    if (documentId !== state.documentId) fail(409, "browser-stale-document", "Browser document changed; take a new snapshot");
    const refs = this.tabs.get(key(state.workspaceId, state.tabId))?.refs;
    if (!refs || refs.identity !== identity(state)) fail(409, "browser-stale-document", "Element references expired; take a new snapshot");
    return refs.byRef.get(text(ref, 32)) ?? fail(404, "browser-element", "Unknown browser element reference");
  }
  private async elementPoint(state: RegistryState, element: Element, check: () => void) {
    check(); await this.client().sendSession(state.cdpSessionId!, "DOM.scrollIntoViewIfNeeded", { backendNodeId: element.backendNodeId });
    check(); const bounds = await this.bounds(state, element.backendNodeId); check();
    element.bounds = bounds;
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    if (x < 0 || y < 0 || x > state.viewport.width || y > state.viewport.height) fail(409, "browser-element-hidden", "Element is outside the logical viewport");
    return { x, y };
  }
  agentClick(session: BrowserSessionIdentity, input: BrowserClickInput, target?: BrowserGrantTarget) {
    const t = this.agentTarget(session, "control", target), before = this.running(t.workspaceId, t.tabId);
    const element = "ref" in input ? this.reference(before, input.ref, input.documentId) : undefined;
    const point = "x" in input ? this.point(before, input.x, input.y) : undefined;
    return this.mutate(session, input, t, async (state, check) => {
      const position = element ? await this.elementPoint(state, element, check) : point!;
      check();
      const pressed = this.tab(state.workspaceId, state.tabId).agentInput;
      pressed.buttons.set("left", position);
      await this.client().sendSession(state.cdpSessionId, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...position });
      check(); pressed.buttons.delete("left");
      await this.client().sendSession(state.cdpSessionId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...position });
    }, "ref" in input ? input.documentId : undefined);
  }
  agentType(session: BrowserSessionIdentity, input: BrowserTypeInput, target?: BrowserGrantTarget) {
    integer(input.documentId, 0, Number.MAX_SAFE_INTEGER);
    if (input.clear !== undefined && typeof input.clear !== "boolean" || input.submit !== undefined && typeof input.submit !== "boolean") fail(400, "browser-input", "Invalid typing options");
    const t = this.agentTarget(session, "control", target), before = this.running(t.workspaceId, t.tabId), value = text(input.text, 65536);
    const element = input.ref === undefined ? undefined : this.reference(before, input.ref, input.documentId);
    return this.mutate(session, input, t, async (state, check) => {
      const send = (method: string, params: Record<string, unknown>) => {
        check(); this.trackInput(this.tab(state.workspaceId, state.tabId).agentInput, method, params);
        return this.client().sendSession(state.cdpSessionId, method, params);
      };
      if (element) await send("DOM.focus", { backendNodeId: element.backendNodeId });
      if (input.clear) {
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2, commands: ["selectAll"] });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 0 });
        await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      }
      await send("Input.insertText", { text: value });
      if (input.submit) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }
    }, input.documentId);
  }
  agentScroll(session: BrowserSessionIdentity, input: BrowserScrollInput, target?: BrowserGrantTarget) {
    integer(input.documentId, 0, Number.MAX_SAFE_INTEGER);
    const t = this.agentTarget(session, "control", target), before = this.running(t.workspaceId, t.tabId);
    const element = input.ref === undefined ? undefined : this.reference(before, input.ref, input.documentId);
    let deltaX: number, deltaY: number;
    if ("direction" in input) {
      if (!["up", "down", "left", "right"].includes(input.direction) || finite(input.amount) < 0) fail(400, "browser-scroll", "Invalid scroll direction or amount");
      deltaX = input.direction === "left" ? -input.amount : input.direction === "right" ? input.amount : 0;
      deltaY = input.direction === "up" ? -input.amount : input.direction === "down" ? input.amount : 0;
    } else { deltaX = finite(input.deltaX); deltaY = finite(input.deltaY); }
    return this.mutate(session, input, t, async (state, check) => {
      const position = element ? await this.elementPoint(state, element, check) : { x: state.viewport.width / 2, y: state.viewport.height / 2 };
      check(); await this.client().sendSession(state.cdpSessionId, "Input.dispatchMouseEvent", { type: "mouseWheel", ...position, deltaX, deltaY });
    }, input.documentId);
  }
  async handleNativeBroker(req: Request, hostToken: string, resolveCaller?: (caller: BrowserNativeCaller) => BrowserSessionIdentity): Promise<Response> {
    try {
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (req.headers.has("origin")) return json({ error: "Forbidden", code: "browser-auth" }, 403);
      const token = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      const credential = this.sessionCredentials.get(token), host = !!token && equal(token, hostToken) && (!this.hostToken || equal(token, this.hostToken));
      if (!credential && !host) return json({ error: "Unauthorized", code: "browser-auth" }, 401);
      const input = record(await body(req));
      if (input.version !== 1 || !(BROWSER_MCP_TOOLS as readonly unknown[]).includes(input.tool)) fail(400, "browser-input", "Expected a version 1 browser tool request");
      const tool = input.tool as BrowserMcpToolName, args = record(input.arguments ?? {});
      const scope: BrowserGrantScope = ["browser_navigate", "browser_click", "browser_type", "browser_scroll"].includes(tool) ? "control" : "observe";
      let session: BrowserSessionIdentity, target: BrowserGrantTarget | undefined;
      if (credential) {
        if (this.sessionCredentials.get(token) !== credential) fail(401, "browser-auth", "Authentication revoked");
        session = credential.session; target = credential.target;
      } else if (host && Object.hasOwn(input, "caller")) {
        if (!resolveCaller) throw new BrowserGrantError(403, "browser-session-unverified", "This conversation is not an admitted SANE session");
        session = resolveCaller(input.caller as BrowserNativeCaller);
      } else {
        const active = new Map<string, ReturnType<BrowserGrantRegistry["listForTab"]>[number]>();
        for (const tab of this.tabs.values()) for (const grant of this.grants.listForTab(tab.workspaceId, tab.tabId)) {
          if (this.grants.check(grant, scope, grant)) active.set(grantKey(grant, grant.sessionId), grant);
        }
        for (const entry of this.sessionCredentials.values()) for (const grant of this.grants.listForSession(entry.session.sessionId)) {
          if (this.grants.check(grant, scope, grant)) active.set(grantKey(grant, grant.sessionId), grant);
        }
        if (!active.size) fail(403, "browser-grant-required", `An explicit browser ${scope} grant is required`);
        if (active.size > 1) fail(409, "browser-target-ambiguous", "Multiple browser sessions are granted; use a session-bound credential");
        const grant = active.values().next().value!;
        session = { sessionId: grant.sessionId, harness: grant.harness, authorityId: grant.authorityId, nativeSessionId: grant.nativeSessionId };
        target = { workspaceId: grant.workspaceId, tabId: grant.tabId };
      }
      let result: unknown;
      switch (tool) {
        case "browser_status": result = this.agentStatus(session, target); break;
        case "browser_snapshot": result = await this.agentSnapshot(session, args, target); break;
        case "browser_screenshot": result = await this.agentScreenshot(session, args, target); break;
        case "browser_console_logs": result = this.agentConsoleLogs(session, args, target); break;
        case "browser_network_requests": result = this.agentNetworkRequests(session, args, target); break;
        case "browser_navigate": result = await this.agentNavigate(session, args as BrowserNavigateInput, target); break;
        case "browser_click": result = await this.agentClick(session, args as BrowserClickInput, target); break;
        case "browser_type": result = await this.agentType(session, args as BrowserTypeInput, target); break;
        case "browser_scroll": result = await this.agentScroll(session, args as BrowserScrollInput, target); break;
      }
      return json({ ok: true, result });
    } catch (error) { return this.errorResponse(error); }
  }
  async route(req: Request, workspaceId: string, suffix: string, authorized: () => boolean, token: string): Promise<Response> {
    try {
      const check = () => { if (!authorized()) fail(401, "browser-auth", "Authentication revoked"); };
      check();
      const url = new URL(req.url), artifact = /^artifacts(?:\/([^/]+))?$/.exec(suffix);
      if (artifact) {
        if (url.search) fail(400, "browser-query", "Artifact routes do not accept query parameters");
        if (!artifact[1] && req.method === "GET") { const artifacts = await this.listArtifacts(workspaceId); check(); return json({ artifacts }); }
        if (artifact[1] && req.method === "DELETE") { await this.deleteArtifact(decodeURIComponent(artifact[1]), workspaceId, check); return json({ deleted: true }); }
        return json({ error: "Method not allowed" }, 405);
      }
      const match = /^tabs\/([^/]+)(?:\/(restart|close|navigate|screenshot|grants|diagnostics\/console|diagnostics\/network))?$/.exec(suffix);
      if (!match) return json({ error: "Not found" }, 404);
      const tabId = decodeURIComponent(match[1]!), operation = match[2], target = { workspaceId, tabId };
      if (url.search && operation !== "diagnostics/console" && operation !== "diagnostics/network") fail(400, "browser-query", "This browser route does not accept query parameters");
      if (req.method === "GET") {
        let result: unknown;
        if (!operation) result = { ...this.get(workspaceId, tabId), grants: this.listGrants(workspaceId, tabId) };
        else if (operation === "grants") result = { grants: this.listGrants(workspaceId, tabId) };
        else if (operation === "diagnostics/console" || operation === "diagnostics/network") {
          const afterSeq = url.searchParams.has("afterSeq") ? integer(Number(url.searchParams.get("afterSeq")), 0, Number.MAX_SAFE_INTEGER) : undefined;
          const limit = url.searchParams.has("limit") ? integer(Number(url.searchParams.get("limit")), 0, 500) : undefined;
          if (operation === "diagnostics/console") {
            const severity = url.searchParams.get("severity") as BrowserConsoleLogsInput["severity"];
            if (severity && !["log", "info", "warn", "error", "exception"].includes(severity)) fail(400, "browser-severity", "Invalid console severity");
            result = this.consoleLogs(workspaceId, tabId, { afterSeq, limit, severity: severity ?? undefined });
          } else {
            const onlyFailed = url.searchParams.get("onlyFailed");
            if (onlyFailed !== null && onlyFailed !== "true" && onlyFailed !== "false") fail(400, "browser-query", "Invalid failure filter");
            result = this.networkRequests(workspaceId, tabId, { afterSeq, limit, onlyFailed: onlyFailed === "true" });
          }
        } else return json({ error: "Method not allowed" }, 405);
        if (!authorized()) fail(401, "browser-auth", "Authentication revoked");
        return json(result);
      }
      if (operation === "grants" && req.method === "DELETE") {
        const input = record(await body(req));
        if (!authorized()) fail(401, "browser-auth", "Authentication revoked");
        this.revokeGrant(target, text(input.sessionId, 256)); return json({ grants: this.listGrants(workspaceId, tabId) });
      }
      if (operation === "grants" && req.method === "PUT") {
        const input = record(await body(req)), session = record(input.session) as BrowserSessionIdentity;
        if (Object.keys(input).length !== 2 || !Object.hasOwn(input, "session") || !Object.hasOwn(input, "scope")) fail(400, "browser-grant-input", "Provide session and scope only");
        if (!this.options.validateSession) fail(503, "browser-session-validation", "Verified session admission is unavailable");
        if (!authorized()) fail(401, "browser-auth", "Authentication revoked");
        this.setGrant(target, session, input.scope, token); return json({ grants: this.listGrants(workspaceId, tabId) });
      }
      if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
      const input = req.body ? record(await body(req)) : {};
      if (!authorized()) fail(401, "browser-auth", "Authentication revoked");
      let result: unknown;
      if (!operation) result = await this.start(workspaceId, tabId, input.url ?? "about:blank", check);
      else if (operation === "restart") result = await this.restart(workspaceId, tabId, input.url, check);
      else if (operation === "close") result = await this.closeTab(workspaceId, tabId);
      else if (operation === "screenshot") result = await this.screenshot(workspaceId, tabId, input, check);
      else if (operation === "navigate") {
        const state = this.running(workspaceId, tabId);
        if (input.generation !== state.generation) fail(409, "browser-stale-control", "Browser generation changed");
        const attachment = [...this.tab(workspaceId, tabId).attachments].find(a => a.id === input.attachmentId && a.token === token && !a.dead && a.socket && authorized() && this.options.validToken(a.token));
        if (!attachment) fail(403, "browser-viewer", "Navigation requires an active viewer attachment");
        this.validateNavigation(input as BrowserNavigateInput);
        this.requireRegistry().getBroker(workspaceId, tabId).onHumanInput(attachment.id, "navigate");
        result = await this.navigate(workspaceId, tabId, input as BrowserNavigateInput, () => { if (!authorized()) fail(401, "browser-auth", "Authentication revoked"); this.assertViewer(attachment, state.cdpSessionId); });
      } else return json({ error: "Method not allowed" }, 405);
      if (!authorized()) fail(401, "browser-auth", "Authentication revoked");
      return json(result);
    } catch (error) { return this.errorResponse(error); }
  }
  errorResponse(error: unknown): Response {
    if (error instanceof BrowserContextError || error instanceof BrowserControlError || error instanceof BrowserGrantError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof SyntaxError || error instanceof URIError) return json({ error: "Invalid browser request", code: "browser-input" }, 400);
    this.options.onError?.(error); return json({ error: "Browser operation failed", code: "browser-operation" }, 503);
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const errors: unknown[] = [];
      for (const tab of this.tabs.values()) { for (const a of [...tab.attachments]) this.disconnect(a, 1001, "Bridge shutting down"); this.disposeStream(tab); }
      try { this.revokeAllGrants(); } catch (error) { errors.push(error); }
      try { await this.initializing; } catch {}
      try { await this.registry?.close(); } catch (error) { errors.push(error); }
      try { await this.supervisor?.close(); } catch (error) { errors.push(error); }
      await this.artifactSerial;
      this.tabs.clear(); this.grantOwners.clear();
      if (errors.length) throw new AggregateError(errors, "Browser shutdown failed");
    })();
    return this.closePromise;
  }
}
