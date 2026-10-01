import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_LIMITS, type TerminalClientMessage, type TerminalServerMessage, type TerminalStart, type TerminalState } from "../src/terminal-contract";
import { WorkspaceError } from "./workspace-client";
import { subscribeWorkspace, workspaceEpoch, workspaceFailure } from "./workspace-store";

export type TerminalSelection = { workspaceId: string; worktreeId: string; bindingRevision: string; root: string };
export type TerminalPresentation = { state: TerminalState | null; geometry: { cols: number; rows: number } | null; connected: boolean; ready: boolean; controlling: boolean; busy: boolean; error: string };
export const emptyTerminal = (): TerminalPresentation => ({ state: null, geometry: null, connected: false, ready: false, controlling: false, busy: false, error: "" });
type ScreenMessage = Extract<TerminalServerMessage, { type: "snapshot" | "output" | "resize" }>;

/** One imperative owner of the emulator, attachment, rendering queue and input fence. */
export class TerminalSession {
  private terminal: Terminal;
  private fit = new FitAddon();
  private socket: WebSocket | null = null;
  private abort = new AbortController();
  private disposed = false;
  private auth = workspaceEpoch();
  private attachment = "";
  private connection = 0;
  private restoring = true;
  private released = false;
  private seq: number | null = null;
  private queue: ScreenMessage[] = [];
  private queuedBytes = 0;
  private writing = false;
  private retry?: ReturnType<typeof setTimeout>;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private retryDelay = 1000;
  private observer: ResizeObserver;
  private unsubscribe: () => void;
  private dataSubscription: { dispose(): void };
  private binarySubscription: { dispose(): void };
  private pendingSize = "";
  private inputWindow = 0;
  private inputBytes = 0;
  private inputMessages = 0;
  private presentation = emptyTerminal();
  private base: string;
  constructor(private host: HTMLElement, private selection: TerminalSelection, private publish: (state: TerminalPresentation) => void, private selected: () => boolean) {
    this.base = `/api/workspaces/${encodeURIComponent(selection.workspaceId)}/worktrees/${encodeURIComponent(selection.worktreeId)}/terminal`;
    const tokens = getComputedStyle(host);
    this.terminal = new Terminal({
      cols: 80, rows: 24, scrollback: TERMINAL_LIMITS.scrollback, fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", cursorBlink: false,
      disableStdin: true, convertEol: false, allowProposedApi: false,
      theme: { background: tokens.getPropertyValue("--background").trim() || "#fcfbf9", foreground: tokens.getPropertyValue("--foreground").trim() || "#29282d", cursor: "#635877", cursorAccent: "#fcfbf9", selectionBackground: "#ddd5e9", black: "#29282d", red: "#a74238", green: "#4b8066", yellow: "#946b29", blue: "#426c97", magenta: "#796090", cyan: "#367f83", white: "#ded9d3", brightBlack: "#747078", brightRed: "#bc5147", brightGreen: "#548867", brightYellow: "#a87b31", brightBlue: "#4d7faf", brightMagenta: "#906ea7", brightCyan: "#459295", brightWhite: "#fcfbf9" },
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.open(host);
    this.dataSubscription = this.terminal.onData(data => this.input(data));
    // onBinary contains byte-valued characters, not a UTF-8 string.
    this.binarySubscription = this.terminal.onBinary(data => this.sendBytes(Uint8Array.from(data, char => char.charCodeAt(0) & 255)));
    this.observer = new ResizeObserver(this.scheduleFit);
    this.observer.observe(host.parentElement!);
    window.visualViewport?.addEventListener("resize", this.scheduleFit);
    window.addEventListener("resize", this.scheduleFit);
    window.addEventListener("pagehide", this.leave);
    window.addEventListener("pageshow", this.resume);
    document.addEventListener("visibilitychange", this.visibility);
    this.unsubscribe = subscribeWorkspace(() => { if (workspaceEpoch() !== this.auth) this.dispose(); });
    void this.load(true);
  }
  private current() { return !this.disposed && workspaceEpoch() === this.auth && this.selected(); }
  private update(patch: Partial<TerminalPresentation>) {
    if (!this.current()) return;
    this.presentation = { ...this.presentation, ...patch };
    const controlling = !this.released && this.presentation.ready && this.presentation.connected && this.presentation.state?.status === "running" && !this.presentation.state.ptyClosed && this.presentation.state.controllerId === this.attachment && !!this.attachment;
    this.presentation.controlling = controlling;
    this.terminal.options.disableStdin = !controlling;
    this.terminal.options.cursorBlink = controlling;
    this.publish(this.presentation);
  }
  private async request(action = "", method = "GET") {
    const body: TerminalStart = { bindingRevision: this.selection.bindingRevision, cols: 80, rows: 24 };
    const response = await fetch(this.base + action, { method, credentials: "same-origin", cache: "no-store", signal: this.abort.signal, ...(method !== "GET" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new WorkspaceError(value.error || `Terminal request failed (${response.status}).`, response.status, value.code);
    return value as TerminalState;
  }
  private accept(state: TerminalState) {
    if (state.workspaceId !== this.selection.workspaceId || state.worktreeId !== this.selection.worktreeId || state.bindingRevision !== this.selection.bindingRevision) throw new Error("Worktree changed. Refresh its workspace before opening the terminal.");
    this.update({ state });
  }
  private async load(startMissing = false) {
    if (!this.current()) return;
    this.update({ busy: true });
    try {
      let state = await this.request();
      if (!this.current()) return;
      this.accept(state);
      // Opening the view is the start intent. Reconnect/resume are read-only,
      // and retained closed/exited sessions must never be restarted implicitly.
      if (startMissing && state.capability.available && state.status === "absent" && !state.terminalId) {
        try { state = await this.request("", "POST"); }
        catch (error) {
          // Another viewer may have created the shared shell after our lookup.
          // Attach to it instead of replacing it or retrying the spawn.
          if (this.current() && error instanceof WorkspaceError && error.code === "terminal-exists") state = await this.request();
          else throw error;
        }
        if (!this.current()) return;
        this.accept(state);
      }
      this.update({ busy: false, error: "" });
      if (state.terminalId && state.status !== "closed" && state.status !== "absent") this.attach();
    } catch (error) { if (this.current()) this.update({ busy: false, error: workspaceFailure(error) }); }
  }
  action = async (action: "start" | "restart" | "close") => {
    if (!this.current() || this.presentation.busy) return;
    this.update({ busy: true, error: "" });
    this.detach();
    try {
      const state = await this.request(action === "start" ? "" : `/${action}`, "POST");
      if (!this.current()) return;
      this.accept(state);
      this.update({ busy: false });
      if (state.terminalId && state.status !== "closed" && state.status !== "absent") this.attach();
      else { this.restoring = true; this.terminal.reset(); }
    } catch (error) { if (this.current()) this.update({ busy: false, error: workspaceFailure(error) }); }
  };
  reconnect = () => { if (this.current() && !this.presentation.busy) { this.detach(); void this.load(); } };
  private attach() {
    if (!this.current()) return;
    this.detach();
    const connection = ++this.connection;
    const url = new URL(`${this.base}/socket`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.socket = new WebSocket(url);
    const current = () => this.current() && this.socket === socket && connection === this.connection;
    socket.onmessage = event => {
      if (!current()) return;
      try {
        const message = JSON.parse(event.data) as TerminalServerMessage;
        if (message.type === "hello") {
          this.attachment = message.attachmentId;
          this.released = false;
          this.accept(message.state);
          this.update({ connected: true, error: "" });
        } else if (message.type === "state") {
          const wasControlling = this.presentation.controlling;
          this.accept(message.state);
          if (this.presentation.controlling && !wasControlling) { this.scheduleFit(); this.terminal.focus(); }
        } else if (message.type === "error") this.update({ error: message.message });
        else {
          this.queuedBytes += "data" in message ? message.data.length : 32;
          if (this.queuedBytes > TERMINAL_LIMITS.snapshotBytes * 2 + TERMINAL_LIMITS.backlogBytes * 2 || this.queue.length > 4096) throw new Error("Terminal output fell behind. Reconnecting from a fresh screen.");
          this.queue.push(message);
          this.drain(connection);
        }
      } catch (error) { this.update({ error: error instanceof Error ? error.message : "Terminal stream interrupted." }); socket.close(); }
    };
    socket.onclose = event => {
      if (!current()) return;
      this.socket = null; this.attachment = ""; this.restoring = true;
      this.connection++; this.seq = null; this.queue = []; this.queuedBytes = 0; this.writing = false;
      clearTimeout(this.resizeTimer);
      if (event.code === 4401) { workspaceFailure(new WorkspaceError("Terminal sign-in expired.", 401, "terminal-auth")); return; }
      this.update({ connected: false, ready: false, error: "Terminal disconnected. Reconnecting as a viewer…" });
      this.retry = setTimeout(() => { if (this.current()) void this.load(); }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 10000);
    };
    socket.onerror = () => { if (current()) this.update({ error: "Terminal connection unavailable." }); };
  }
  private drain(connection: number) {
    if (this.writing || !this.current() || connection !== this.connection) return;
    const message = this.queue.shift();
    if (!message) return;
    this.queuedBytes -= "data" in message ? message.data.length : 32;
    if (message.type !== "snapshot" && (this.seq === null || message.seq !== this.seq + 1)) { this.update({ error: "Terminal output sequence changed. Restoring a fresh screen." }); this.socket?.close(); return; }
    this.writing = true;
    const complete = () => {
      if (!this.current() || connection !== this.connection) return;
      this.seq = message.seq;
      this.writing = false;
      if (message.type === "snapshot" || message.type === "resize") this.update({ geometry: { cols: message.cols, rows: message.rows } });
      if (message.type === "snapshot") { this.restoring = false; this.retryDelay = 1000; this.update({ ready: true }); }
      this.send({ type: "ack", seq: message.seq });
      this.drain(connection);
    };
    if (message.type === "snapshot") {
      this.restoring = true;
      this.terminal.write("", () => {
        if (!this.current() || connection !== this.connection) return;
        this.terminal.reset();
        this.geometry(message.cols, message.rows);
        this.terminal.write(message.data, complete);
      });
    } else if (message.type === "resize") {
      this.geometry(message.cols, message.rows);
      // Empty write fences resize ACK behind any pending xterm parser work.
      this.terminal.write("", complete);
    } else {
      const bytes = Uint8Array.from(atob(message.data), char => char.charCodeAt(0));
      this.terminal.write(bytes, complete);
    }
  }
  private geometry(cols: number, rows: number) {
    this.terminal.resize(cols, rows);
    this.host.style.width = "100%";
    this.host.style.minWidth = "0";
    this.host.style.minHeight = "100px";
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (screen) { this.host.style.minWidth = `${screen.offsetWidth}px`; this.host.style.minHeight = `${screen.offsetHeight}px`; }
    this.pendingSize = "";
  }
  private send(message: TerminalClientMessage) {
    if (!this.current() || this.socket?.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.update({ error: "Terminal connection interrupted. Input was not retried." }); this.socket.close(); return false; }
  }
  claim = () => {
    const state = this.presentation.state;
    if (!this.current() || !state || !this.presentation.ready || state.status !== "running" || state.ptyClosed) return;
    this.released = false;
    this.send({ type: state.controllerId ? "take" : "claim", generation: state.generation });
  };
  release = () => {
    const state = this.presentation.state;
    if (state && this.presentation.controlling) this.send({ type: "release", generation: state.generation });
    // Fence input immediately, including before the release acknowledgement.
    this.released = true;
    this.update({ controlling: false });
  };
  private sendBytes(bytes: Uint8Array) {
    if (!this.current() || this.restoring || !this.presentation.controlling || document.hidden) return;
    if (!bytes.length) return;
    if (bytes.length > TERMINAL_LIMITS.inputBytes) { this.update({ error: `Input was not sent. Paste at most ${TERMINAL_LIMITS.inputBytes.toLocaleString()} bytes at a time.` }); return; }
    const now = Date.now();
    if (now - this.inputWindow > 1000) { this.inputWindow = now; this.inputBytes = 0; this.inputMessages = 0; }
    if (this.inputBytes + bytes.length > 65536 || this.inputMessages >= 100) { this.update({ error: "Input was not sent because the input rate limit was reached. Nothing will be replayed." }); return; }
    if (!this.socket || this.socket.bufferedAmount > TERMINAL_LIMITS.inputBytes * 2) { this.update({ error: "Input was not sent because the connection is busy. Nothing will be replayed." }); return; }
    this.inputBytes += bytes.length; this.inputMessages++;
    let data = "";
    for (const byte of bytes) data += String.fromCharCode(byte);
    this.send({ type: "input", generation: this.presentation.state!.generation, data: btoa(data) });
  }
  input = (data: string) => this.sendBytes(new TextEncoder().encode(data));
  focus = () => { if (this.current() && this.presentation.controlling) this.terminal.focus(); };
  key = (data: string) => { this.input(data); if (this.presentation.controlling) this.terminal.focus(); };
  interrupt = () => { if (this.presentation.controlling && !this.restoring) { this.send({ type: "interrupt", generation: this.presentation.state!.generation }); this.terminal.focus(); } };
  private scheduleFit = () => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (!this.current() || !this.presentation.controlling || document.hidden || !this.host.parentElement?.clientWidth) return;
      // Measure the available viewport, not the viewer's shared-size overflow surface.
      this.host.style.minWidth = "0"; this.host.style.minHeight = "0";
      this.host.style.width = "100%";
      const size = this.fit.proposeDimensions();
      if (size) {
        const cols = Math.max(TERMINAL_LIMITS.minCols, Math.min(TERMINAL_LIMITS.cols, size.cols));
        const rows = Math.max(TERMINAL_LIMITS.minRows, Math.min(TERMINAL_LIMITS.rows, size.rows));
        const key = `${cols}:${rows}`;
        if ((cols !== this.terminal.cols || rows !== this.terminal.rows) && key !== this.pendingSize) { this.pendingSize = key; this.send({ type: "resize", generation: this.presentation.state!.generation, cols, rows }); }
      }
      const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
      if (screen) { this.host.style.minWidth = `${screen.offsetWidth}px`; this.host.style.minHeight = `${screen.offsetHeight}px`; }
    }, 120);
  };
  private visibility = () => { if (document.hidden) this.release(); else this.scheduleFit(); };
  private leave = () => this.detach();
  private resume = () => { if (this.current() && !this.socket && !this.presentation.busy) void this.load(); };
  private detach() {
    this.release();
    clearTimeout(this.retry); clearTimeout(this.resizeTimer);
    this.connection++;
    if (this.socket) { this.socket.onclose = null; this.socket.onmessage = null; this.socket.onerror = null; this.socket.close(); }
    this.socket = null; this.attachment = ""; this.restoring = true; this.seq = null;
    this.queue = []; this.queuedBytes = 0; this.writing = false;
    this.update({ connected: false, ready: false });
  }
  dispose = () => {
    if (this.disposed) return;
    this.detach(); this.disposed = true; this.abort.abort();
    this.observer.disconnect(); this.unsubscribe();
    this.dataSubscription.dispose(); this.binarySubscription.dispose();
    window.visualViewport?.removeEventListener("resize", this.scheduleFit);
    window.removeEventListener("resize", this.scheduleFit); window.removeEventListener("pagehide", this.leave);
    window.removeEventListener("pageshow", this.resume);
    document.removeEventListener("visibilitychange", this.visibility);
    this.terminal.dispose();
  };
}
