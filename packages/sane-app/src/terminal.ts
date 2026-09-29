import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { Terminal as HeadlessTerminal, type ITerminalAddon } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { CatalogService } from "./catalog";
import { WorkspaceError } from "./workspace";
import { TERMINAL_LIMITS as L, type TerminalCapability, type TerminalState, type TerminalStart, type TerminalClientMessage, type TerminalServerMessage } from "./terminal-contract";

type Socket = Bun.ServerWebSocket<TerminalSocketData>;
export type TerminalSocketData = { attachment: Attachment };
type Delta = Extract<TerminalServerMessage, { type: "output" | "resize" }>;
type Attachment = {
  id: string; token: string; resource: Resource; socket?: Socket; dead: boolean;
  ready: boolean; next: number; awaiting: number | null; timer?: ReturnType<typeof setTimeout>;
  window: number; messages: number; input: number;
};
type Resource = {
  state: TerminalState; cwd: string; screen: HeadlessTerminal; serializer: SerializeAddon;
  pty?: Bun.Terminal; process?: Bun.Subprocess; processExited: boolean; stopping?: Promise<void>;
  seq: number; ring: { message: Delta; bytes: number }[]; ringBytes: number;
  tail: Promise<void>; queuedBytes: number; queuedTasks: number; disposed: boolean;
  boundary: SnapshotBoundary; attachments: Set<Attachment>; inputBudget: number;
  screenBudget: number; partialBytes: number; lastOutputAt: number;
};
function fail(status: number, code: string, message: string): never { throw new WorkspaceError(status, code, message); }
const dimensions = (cols: unknown, rows: unknown) => Number.isInteger(cols) && Number.isInteger(rows) && Number(cols) >= L.minCols && Number(cols) <= L.cols && Number(rows) >= L.minRows && Number(rows) <= L.rows;

/** SerializeAddon does not serialize a partial UTF-8 decoder or VT parser state.
 * Only snapshot at complete byte/parser boundaries; an unterminated control
 * string causes an explicit attach timeout rather than corrupting the replay. */
class SnapshotBoundary {
  private decoder = new TextDecoder();
  private needed = 0;
  private mode: "ground" | "escape" | "intermediate" | "csi" | "osc" | "string" = "ground";
  private stringEscape = false;
  get safe() { return !this.needed && this.mode === "ground"; }
  feed(bytes: Uint8Array) {
    for (const byte of bytes) {
      if (this.needed && byte >= 0x80 && byte <= 0xbf) { this.needed--; continue; }
      this.needed = byte >= 0xc2 && byte <= 0xdf ? 1 : byte >= 0xe0 && byte <= 0xef ? 2 : byte >= 0xf0 && byte <= 0xf4 ? 3 : 0;
    }
    for (const char of this.decoder.decode(bytes, { stream: true })) {
      const c = char.codePointAt(0)!;
      if (c === 0x18 || c === 0x1a || c === 0x9c) { this.mode = "ground"; this.stringEscape = false; continue; }
      if (this.mode === "osc" || this.mode === "string") {
        if (this.stringEscape) {
          this.stringEscape = false;
          if (c === 0x5c) { this.mode = "ground"; continue; }
          // ESC followed by anything but ST aborts the string in xterm's parser.
          this.mode = "escape";
        } else {
          if (c === 0x1b) this.stringEscape = true;
          else if (c === 7 && this.mode === "osc") this.mode = "ground";
          continue;
        }
      }
      if (c === 0x1b) { this.mode = "escape"; continue; }
      if (c === 0x9b) { this.mode = "csi"; continue; }
      if (c === 0x9d) { this.mode = "osc"; continue; }
      if ([0x90, 0x98, 0x9e, 0x9f].includes(c)) { this.mode = "string"; continue; }
      if (this.mode === "escape") {
        if (c === 0x5b) this.mode = "csi";
        else if (c === 0x5d) this.mode = "osc";
        else if ([0x50, 0x58, 0x5e, 0x5f].includes(c)) this.mode = "string";
        else if (c >= 0x20 && c <= 0x2f) this.mode = "intermediate";
        else if (c >= 0x30) this.mode = "ground";
      } else if (this.mode === "intermediate" && c >= 0x30 || this.mode === "csi" && c >= 0x40 && c <= 0x7e) this.mode = "ground";
    }
  }
}

export class TerminalService {
  readonly capability: TerminalCapability = typeof Bun.Terminal === "function" && process.platform !== "win32"
    ? { available: true } : { available: false, reason: "Native Bun.Terminal on macOS/Linux is required" };
  private resources = new Map<string, Resource>();
  private transitions = new Set<string>();
  private pendingReads = 0;
  private closing = false;
  constructor(private catalog: CatalogService, private validToken: (token: string) => boolean) {}
  private key(workspaceId: string, worktreeId: string) { return `${workspaceId}/${worktreeId}`; }
  private state(r: Resource): TerminalState { return { ...r.state, capability: this.capability }; }
  private absent(workspaceId: string, worktreeId: string, bindingRevision: string): TerminalState {
    return { capability: this.capability, workspaceId, worktreeId, bindingRevision, terminalId: null, status: "absent", cols: 80, rows: 24, generation: 0, controllerId: null, exitCode: null, ptyClosed: false };
  }
  private async binding(r: Resource) {
    const b = await this.catalog.binding(r.state.workspaceId, r.state.worktreeId);
    if (b.cwd !== r.cwd || b.bindingRevision !== r.state.bindingRevision) fail(409, "terminal-binding", "Terminal worktree binding changed");
    return b;
  }
  async get(workspaceId: string, worktreeId: string) {
    if (this.pendingReads >= 16) fail(429, "terminal-busy", "Too many terminal lookups or attachments");
    this.pendingReads++;
    try {
      const b = await this.catalog.binding(workspaceId, worktreeId), r = this.resources.get(this.key(workspaceId, worktreeId));
      if (r && (b.cwd !== r.cwd || b.bindingRevision !== r.state.bindingRevision)) fail(409, "terminal-binding", "Terminal worktree binding changed");
      return r ? this.state(r) : this.absent(workspaceId, worktreeId, b.bindingRevision);
    } finally { this.pendingReads--; }
  }
  async change(workspaceId: string, worktreeId: string, action: "start" | "close" | "restart", input: TerminalStart, authorized: () => boolean) {
    const key = this.key(workspaceId, worktreeId);
    if (this.closing) fail(503, "terminal-shutdown", "Bridge is shutting down");
    if (this.transitions.size >= L.terminals) fail(429, "terminal-busy", "Too many terminal lifecycle operations");
    if (this.transitions.has(key)) fail(409, "terminal-busy", "Terminal lifecycle operation is already pending");
    this.transitions.add(key);
    try {
      const binding = await this.catalog.binding(workspaceId, worktreeId);
      if (!input || input.bindingRevision !== binding.bindingRevision) fail(409, "terminal-binding", "Resolve the worktree binding before changing a terminal");
      if (!authorized()) fail(401, "terminal-auth", "Authentication revoked");
      if (this.closing) fail(503, "terminal-shutdown", "Bridge is shutting down");
      const previous = this.resources.get(key);
      if (previous && (binding.cwd !== previous.cwd || binding.bindingRevision !== previous.state.bindingRevision)) fail(409, "terminal-binding", "Terminal worktree binding changed");
      if (action === "close") {
        if (previous) await this.stop(previous, "closed", "Explicitly closed");
        return previous ? this.state(previous) : this.absent(workspaceId, worktreeId, binding.bindingRevision);
      }
      if (!this.capability.available) fail(503, "terminal-unavailable", this.capability.reason!);
      if (action === "start" && previous) fail(409, "terminal-exists", "Terminal already exists; use explicit restart");
      const cols = input.cols ?? 80, rows = input.rows ?? 24;
      if (!dimensions(cols, rows)) fail(400, "terminal-size", "Terminal dimensions are outside the supported range");
      if (!previous && this.resources.size >= L.terminals) fail(429, "terminal-limit", "Terminal resource limit reached; restart the bridge to clear retained resources");
      const requestedShell = process.env.SHELL;
      let shell = requestedShell && isAbsolute(requestedShell) && !requestedShell.includes("\0") ? requestedShell : "/bin/zsh";
      try { await access(shell, constants.X_OK); } catch {
        shell = "/bin/zsh";
        try { await access(shell, constants.X_OK); } catch { fail(503, "terminal-shell", "No executable absolute SHELL or /bin/zsh fallback is available"); }
      }
      if (previous) {
        await this.stop(previous, "closed", "Explicit restart");
        if (!previous.processExited) fail(503, "terminal-cleanup", "Previous shell has not exited; restart refused");
      }
      // Recheck after all asynchronous preparation, immediately before spawn.
      const current = await this.catalog.binding(workspaceId, worktreeId);
      if (current.cwd !== binding.cwd || current.bindingRevision !== binding.bindingRevision) fail(409, "terminal-binding", "Worktree binding changed");
      if (!authorized()) fail(401, "terminal-auth", "Authentication revoked");
      if (this.closing) fail(503, "terminal-shutdown", "Bridge is shutting down");
      if (!previous && this.resources.size >= L.terminals) fail(429, "terminal-limit", "Terminal resource limit reached");
      if (previous) this.dispose(previous);
      const screen = new HeadlessTerminal({ cols, rows, scrollback: L.scrollback, allowProposedApi: true });
      const serializer = new SerializeAddon();
      // Serialize 0.13 targets xterm 5.5's shared core; its public declaration
      // names the browser Terminal, while the implementation supports headless.
      screen.loadAddon(serializer as unknown as ITerminalAddon);
      const r: Resource = { state: { ...this.absent(workspaceId, worktreeId, binding.bindingRevision), terminalId: crypto.randomUUID(), status: "running", cols, rows }, cwd: binding.cwd, screen, serializer, processExited: false, seq: 0, ring: [], ringBytes: 0, tail: Promise.resolve(), queuedBytes: 0, queuedTasks: 0, disposed: false, boundary: new SnapshotBoundary(), attachments: new Set(), inputBudget: 0, screenBudget: 0, partialBytes: 0, lastOutputAt: Date.now() };
      this.resources.set(key, r);
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !/^(CC_WEB_|OPENCODE_SERVER_|OPENCODE_SESSION_ID$|SANE_|BUN_INSPECT|NODE_OPTIONS$)/i.test(name))) as Record<string, string>;
      env.TERM = "xterm-256color"; env.SHELL = shell;
      try {
        r.pty = new Bun.Terminal({ cols, rows, name: "xterm-256color", data: (_, bytes) => this.output(r, bytes), drain: () => { r.inputBudget = 0; }, exit: (_, status) => {
          r.state.ptyClosed = true;
          if (status && !r.state.reason) r.state.reason = "PTY stream closed with an error";
          this.broadcast(r);
        } });
        r.process = Bun.spawn([shell, "-i"], { cwd: binding.cwd, env, terminal: r.pty });
        void r.process.exited.then(async code => {
          r.processExited = true; r.state.exitCode = code;
          if (r.state.status === "running") r.state.status = "exited";
          this.release(r); this.broadcast(r);
          // A reusable Terminal can retain its slave after the shell exits.
          // Drain until quiet, bounded because background jobs can retain it.
          const deadline = Date.now() + 2000;
          do { await Bun.sleep(100); } while (!r.disposed && !r.stopping && Date.now() - r.lastOutputAt < 100 && Date.now() < deadline);
          if (!r.stopping && Date.now() - r.lastOutputAt < 100) r.state.reason = "Shell exited; PTY output drain deadline reached (remaining job output may be truncated)";
          try { r.pty?.close(); } catch {}
          r.state.ptyClosed = true; this.broadcast(r);
        }, () => { void this.stop(r, "closed", "Could not observe shell exit"); });
      } catch {
        r.processExited = true;
        await this.stop(r, "closed", "Native PTY or shell creation failed");
        fail(503, "terminal-spawn", "Native PTY or shell creation failed; explicit restart required");
      }
      return this.state(r);
    } finally { this.transitions.delete(key); }
  }

  private enqueue(r: Resource, bytes: number, task: () => Promise<void> | void): boolean {
    if (r.disposed) return false;
    if (r.queuedBytes + bytes > L.backlogBytes || r.queuedTasks >= 256) { void this.stop(r, "overloaded", "Server terminal backlog exceeded; explicit restart required"); return false; }
    r.queuedBytes += bytes; r.queuedTasks++;
    r.tail = r.tail.then(async () => { if (!r.disposed) await task(); }).catch(() => {
      void this.stop(r, "overloaded", "Terminal processing failed; explicit restart required");
      this.dispose(r);
    }).finally(() => { r.queuedBytes -= bytes; r.queuedTasks--; });
    return true;
  }
  private output(r: Resource, data: Uint8Array) {
    if (r.disposed || r.stopping) return;
    r.lastOutputAt = Date.now();
    if (data.byteLength + r.queuedBytes > L.backlogBytes) { void this.stop(r, "overloaded", "PTY output exceeded server backlog; explicit restart required"); return; }
    for (let offset = 0; offset < data.byteLength; offset += L.chunkBytes) {
      const bytes = Buffer.from(data.subarray(offset, offset + L.chunkBytes));
      if (!this.enqueue(r, bytes.length, async () => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Headless parser timeout")), 5000);
          try { r.screen.write(bytes, () => { clearTimeout(timer); resolve(); }); } catch (e) { clearTimeout(timer); reject(e); }
        });
        if (r.disposed) return;
        r.boundary.feed(bytes);
        r.partialBytes = r.boundary.safe ? 0 : r.partialBytes + bytes.length;
        r.screenBudget += bytes.length;
        // Rows alone do not bound arbitrarily long combining-character cells.
        // Periodically bound the serialized screen too, and independently cap
        // an unfinished escape/string whose parser payload is not serialized.
        if (r.partialBytes > L.backlogBytes || r.screenBudget >= 262144 && Buffer.byteLength(JSON.stringify(r.serializer.serialize({ scrollback: L.scrollback }))) > L.snapshotBytes) {
          void this.stop(r, "overloaded", "Terminal screen/parser retention limit exceeded; explicit restart required"); return;
        }
        if (r.screenBudget >= 262144) r.screenBudget = 0;
        this.delta(r, { type: "output", seq: ++r.seq, data: bytes.toString("base64") });
        this.snapshots(r);
      })) break;
    }
  }
  private delta(r: Resource, message: Delta) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    r.ring.push({ message, bytes }); r.ringBytes += bytes;
    while (r.ringBytes > L.backlogBytes || r.ring.length > 1024) r.ringBytes -= r.ring.shift()!.bytes;
    for (const a of r.attachments) this.pump(a);
  }
  private send(a: Attachment, message: TerminalServerMessage) {
    if (a.dead || !a.socket) return false;
    if (!this.validToken(a.token)) { this.disconnect(a, 4401, "Authentication revoked"); return false; }
    try {
      // Bun queues -1 sends; they are accepted and must never be resent. Only
      // one screen frame is outstanding, gated by application-level completion.
      if (a.socket.getBufferedAmount() > L.snapshotBytes + 65536) { this.disconnect(a, 1013, "Slow connection; attach again for a snapshot"); return false; }
      if (a.socket.send(JSON.stringify(message)) === 0 || a.socket.getBufferedAmount() > L.snapshotBytes + 65536) { this.disconnect(a, 1013, "Slow connection; attach again for a snapshot"); return false; }
      return true;
    } catch { this.disconnect(a, 1011, "Socket send failed"); return false; }
  }
  private waitAck(a: Attachment, seq: number) {
    if (a.timer) clearTimeout(a.timer);
    a.awaiting = seq;
    a.timer = setTimeout(() => this.disconnect(a, 1013, "Screen acknowledgement timeout; attach again"), 15000);
    a.timer.unref();
  }
  private pump(a: Attachment) {
    if (a.dead || !a.ready || a.awaiting !== null) return;
    const r = a.resource;
    if (a.next > r.seq) return;
    const item = r.ring.find(item => item.message.seq === a.next);
    if (!item) { this.disconnect(a, 1013, "Output retention gap; attach again for a snapshot"); return; }
    this.waitAck(a, item.message.seq);
    this.send(a, item.message);
  }
  private snapshots(r: Resource) {
    if (!r.boundary.safe || r.disposed) return;
    const waiting = [...r.attachments].filter(a => !a.dead && a.socket && !a.ready);
    if (!waiting.length) return;
    const data = r.serializer.serialize({ scrollback: L.scrollback });
    // JSON escaping can expand serialized control characters; bound wire size.
    const message: TerminalServerMessage = { type: "snapshot", seq: r.seq, data, cols: r.state.cols, rows: r.state.rows };
    if (Buffer.byteLength(JSON.stringify(message)) > L.snapshotBytes) { for (const a of waiting) this.disconnect(a, 1013, "Screen snapshot limit exceeded"); return; }
    for (const a of waiting) {
      a.ready = true; a.next = r.seq + 1;
      this.waitAck(a, r.seq); this.send(a, message);
    }
  }
  private release(r: Resource) {
    if (r.state.controllerId !== null) { r.state.controllerId = null; r.state.generation++; }
  }
  private broadcast(r: Resource) { if (!r.disposed) for (const a of r.attachments) if (a.socket) this.send(a, { type: "state", state: this.state(r) }); }
  private disconnect(a: Attachment, code: number, reason: string) {
    if (a.dead) return;
    this.detach(a);
    try { a.socket?.close(code, reason); } catch {}
  }
  private detach(a: Attachment) {
    if (a.dead) return;
    a.dead = true; if (a.timer) clearTimeout(a.timer);
    const r = a.resource; r.attachments.delete(a);
    if (r.state.controllerId === a.id) { this.release(r); this.broadcast(r); }
  }
  async prepare(workspaceId: string, worktreeId: string, token: string): Promise<TerminalSocketData> {
    if (this.closing) fail(503, "terminal-shutdown", "Bridge is shutting down");
    const key = this.key(workspaceId, worktreeId), r = this.resources.get(key);
    if (!r) fail(409, "terminal-absent", "Start the terminal explicitly before attaching");
    if (this.pendingReads >= 16) fail(429, "terminal-busy", "Too many terminal lookups or attachments");
    this.pendingReads++;
    try { await this.binding(r); } finally { this.pendingReads--; }
    if (!this.validToken(token)) fail(401, "terminal-auth", "Authentication revoked");
    if (this.closing || r.disposed || this.resources.get(key) !== r || this.transitions.has(key)) fail(409, "terminal-busy", "Terminal lifecycle changed; reload its state");
    if (r.attachments.size >= L.attachments) fail(429, "terminal-attachments", "Terminal attachment limit reached");
    const attachment: Attachment = { id: crypto.randomUUID(), token, resource: r, dead: false, ready: false, next: 0, awaiting: null, window: Date.now(), messages: 0, input: 0 };
    r.attachments.add(attachment);
    attachment.timer = setTimeout(() => this.disconnect(attachment, 1013, "Attach or parser boundary timeout"), 5000);
    attachment.timer.unref();
    return { attachment };
  }
  cancelUpgrade(data: TerminalSocketData) { this.detach(data.attachment); }
  revoke(token: string) { for (const r of this.resources.values()) for (const a of r.attachments) if (a.token === token) this.disconnect(a, 4401, "Signed out"); }
  readonly websocket: Bun.WebSocketHandler<TerminalSocketData> = {
    maxPayloadLength: L.inputBytes * 2,
    backpressureLimit: L.snapshotBytes + 65536,
    closeOnBackpressureLimit: true,
    perMessageDeflate: false,
    idleTimeout: 60,
    sendPings: true,
    open: socket => {
      const a = socket.data.attachment; a.socket = socket;
      if (a.dead || !this.validToken(a.token) || this.closing) { socket.close(4401, "Attachment unavailable"); this.detach(a); return; }
      this.send(a, { type: "hello", attachmentId: a.id, state: this.state(a.resource) });
      this.enqueue(a.resource, 0, () => this.snapshots(a.resource));
    },
    message: (socket, raw) => this.message(socket.data.attachment, raw),
    close: socket => this.detach(socket.data.attachment),
  };
  private message(a: Attachment, raw: string | Buffer) {
    if (a.dead) return;
    if (!this.validToken(a.token)) { this.disconnect(a, 4401, "Authentication revoked"); return; }
    if (typeof raw !== "string" || Buffer.byteLength(raw) > L.inputBytes * 2) { this.disconnect(a, 1009, "Expected bounded JSON text"); return; }
    if (Date.now() - a.window > 1000) { a.window = Date.now(); a.messages = 0; a.input = 0; }
    let message: TerminalClientMessage;
    try { message = JSON.parse(raw); if (!message || typeof message !== "object") throw 0; } catch { this.disconnect(a, 1008, "Invalid terminal message"); return; }
    // Acks are bounded by the single outstanding frame; exempt them from the
    // interactive rate limit so fast output cannot evict a healthy viewer.
    if (message.type === "ack") {
      if (!Number.isSafeInteger(message.seq) || a.awaiting === null || message.seq !== a.awaiting) { this.disconnect(a, 1008, "Unexpected screen acknowledgement"); return; }
      if (a.timer) clearTimeout(a.timer);
      a.next = message.seq + 1; a.awaiting = null; this.pump(a); return;
    }
    if (++a.messages > 120) { this.disconnect(a, 1013, "Input message rate exceeded"); return; }
    const r = a.resource;
    if (!this.enqueue(r, Buffer.byteLength(raw), async () => {
      if (a.dead) return;
      try {
        await this.binding(r);
        if (a.dead || !this.validToken(a.token)) { this.disconnect(a, 4401, "Authentication revoked"); return; }
        if (r.state.status !== "running" || r.state.ptyClosed || r.stopping) fail(409, "terminal-not-running", "Terminal is not accepting input");
        if (!a.ready) fail(409, "terminal-not-ready", "Wait for the initial screen snapshot");
        if (!("generation" in message) || !Number.isSafeInteger(message.generation) || message.generation !== r.state.generation) fail(409, "terminal-stale-control", "Control generation changed; input rejected");
        if (message.type === "claim" || message.type === "take") {
          if (message.type === "claim" && r.state.controllerId !== null && r.state.controllerId !== a.id) fail(409, "terminal-controlled", "Another attachment controls this terminal; explicit take required");
          if (r.state.controllerId !== a.id) { r.state.controllerId = a.id; r.state.generation++; this.broadcast(r); }
          return;
        }
        if (r.state.controllerId !== a.id) fail(403, "terminal-viewer", "Explicitly claim control before sending input");
        if (message.type === "release") { this.release(r); this.broadcast(r); return; }
        if (message.type === "resize") {
          if (!dimensions(message.cols, message.rows)) fail(400, "terminal-size", "Invalid terminal dimensions");
          if (r.state.cols === message.cols && r.state.rows === message.rows) return;
          r.pty!.resize(message.cols, message.rows); r.screen.resize(message.cols, message.rows);
          r.state.cols = message.cols; r.state.rows = message.rows;
          this.delta(r, { type: "resize", seq: ++r.seq, cols: message.cols, rows: message.rows }); this.broadcast(r); return;
        }
        let bytes: Buffer;
        if (message.type === "interrupt") bytes = Buffer.from([3]);
        else if (message.type === "input" && typeof message.data === "string" && message.data.length <= Math.ceil(L.inputBytes / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) {
          bytes = Buffer.from(message.data, "base64");
          if (!bytes.length || bytes.length > L.inputBytes || bytes.toString("base64") !== message.data) fail(400, "terminal-input", "Invalid input bytes");
        } else return fail(400, "terminal-message", "Unknown terminal message or invalid input");
        a.input += bytes.length;
        if (a.input > 65536) fail(429, "terminal-input-rate", "Input byte rate exceeded");
        // Native write accepts all bytes (including internally buffered bytes).
        // Its return value is NOT a flush signal. Conservatively bound bytes
        // since the last documented drain callback, even on runtimes which do
        // not emit drain for immediately-flushed writes.
        if (r.inputBudget + bytes.length > L.backlogBytes) { void this.stop(r, "overloaded", "Native input drain budget exceeded; explicit restart required"); return; }
        r.inputBudget += bytes.length; r.pty!.write(bytes);
      } catch (error) {
        const known = error instanceof WorkspaceError;
        this.send(a, { type: "error", code: known ? error.code : "terminal-operation", message: known ? error.message : "Terminal operation failed" });
        if (known && ["binding-invalid", "terminal-binding", "directory-unavailable", "unknown-worktree", "unknown-workspace"].includes(error.code)) void this.stop(r, "closed", "Worktree binding is unavailable");
      }
    })) this.disconnect(a, 1013, "Terminal operation backlog exceeded");
  }

  private stop(r: Resource, status: "closed" | "overloaded", reason: string): Promise<void> {
    if (r.stopping) return r.stopping;
    r.state.status = status; r.state.reason = reason; this.release(r); this.broadcast(r);
    r.stopping = (async () => {
      const child = r.process;
      // PTY children have their own controlling session/process group. A shell
      // HUP gives zsh a chance to signal jobs; closing the PTY also hangs up its
      // foreground group. Job-control groups and detached/reparented jobs cannot
      // be enumerated or guaranteed dead through Bun.Terminal's public API.
      const signal = (value: NodeJS.Signals) => {
        if (!child || r.processExited) return;
        try { process.kill(-child.pid, value); } catch {}
        try { child.kill(value); } catch {}
      };
      signal("SIGHUP");
      if (child && !r.processExited) await Promise.race([child.exited.catch(() => {}), Bun.sleep(200)]);
      try { r.pty?.close(); } catch {}
      r.state.ptyClosed = true;
      for (const value of ["SIGTERM", "SIGKILL"] as const) {
        if (!child || r.processExited) break;
        signal(value); await Promise.race([child.exited.catch(() => {}), Bun.sleep(500)]);
      }
      if (child && !r.processExited) r.state.reason = `${reason}; shell exit unconfirmed after bounded cleanup`;
      this.broadcast(r);
    })();
    return r.stopping;
  }
  private dispose(r: Resource) {
    if (r.disposed) return;
    for (const a of r.attachments) this.disconnect(a, 1012, "Terminal replaced; attach again");
    r.disposed = true; r.ring = []; r.ringBytes = 0;
    // Let an in-flight write callback finish before disposing parser internals.
    void r.tail.finally(() => r.screen.dispose());
  }
  async close() {
    this.closing = true;
    const all = [...this.resources.values()];
    for (const r of all) for (const a of r.attachments) this.disconnect(a, 1012, "Bridge is shutting down");
    await Promise.all(all.map(r => this.stop(r, "closed", "Bridge is shutting down")));
    for (const r of all) this.dispose(r);
  }
}
