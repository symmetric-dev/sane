export type CdpEvent = { method: string; params: Record<string, unknown>; sessionId?: string };
export type CdpEventHandler = (event: CdpEvent) => void;
export type CdpCommandOptions = { sessionId?: string; timeoutMs?: number };
export type CdpConnectOptions = { connectTimeoutMs?: number; commandTimeoutMs?: number; signal?: AbortSignal };
type Subscription = { handler: CdpEventHandler; method?: string; sessionId?: string };
type Pending = {
  method: string; sessionId?: string; targetId?: string; timer: ReturnType<typeof setTimeout>;
  resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void;
};
type Session = { targetId: string; parentSessionId?: string };

export class CdpError extends Error {
  constructor(message: string, readonly code?: number, readonly method?: string, readonly data?: unknown) {
    super(message); this.name = "CdpError";
  }
}

function timeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2147483647) throw new Error("CDP timeout must be a positive bounded number");
  return value;
}

export class CdpClient {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private subscriptions = new Set<Subscription>();
  private closeListeners = new Set<(reason: Error) => void>();
  private sessions = new Map<string, Session>();
  private invalidSessions = new Map<string, Error>();
  private closedReason?: Error;

  private constructor(private socket: WebSocket, private commandTimeoutMs: number) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", this.receive);
    socket.addEventListener("close", this.transportClosed);
    socket.addEventListener("error", this.transportError);
  }

  static async connect(endpoint: string, options: CdpConnectOptions = {}): Promise<CdpClient> {
    const connectTimeoutMs = timeout(options.connectTimeoutMs ?? 10000);
    const commandTimeoutMs = timeout(options.commandTimeoutMs ?? 10000);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("CDP connection aborted");
    const client = new CdpClient(new WebSocket(endpoint), commandTimeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          client.socket.removeEventListener("open", opened);
          client.socket.removeEventListener("error", failed);
          client.socket.removeEventListener("close", failed);
          options.signal?.removeEventListener("abort", aborted);
          if (error) reject(error); else resolve();
        };
        const opened = () => finish(client.closedReason);
        const failed = () => finish(client.closedReason ?? new Error("CDP connection failed"));
        const aborted = () => finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error("CDP connection aborted"));
        const timer = setTimeout(() => finish(new Error("CDP connection timed out")), connectTimeoutMs);
        client.socket.addEventListener("open", opened);
        client.socket.addEventListener("error", failed);
        client.socket.addEventListener("close", failed);
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) aborted();
        else if (client.socket.readyState === WebSocket.OPEN) opened();
        else if (client.closedReason) failed();
      });
      return client;
    } catch (error) {
      client.close(error instanceof Error ? error : new Error("CDP connection failed"));
      throw error;
    }
  }

  get closed() { return !!this.closedReason; }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, options: CdpCommandOptions = {}): Promise<T> {
    if (this.closedReason) return Promise.reject(this.closedReason);
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP transport is not open"));
    if (options.sessionId && this.invalidSessions.has(options.sessionId)) return Promise.reject(this.invalidSessions.get(options.sessionId));
    if (this.nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error("CDP command IDs exhausted"));
    let timeoutMs: number;
    try { timeoutMs = timeout(options.timeoutMs ?? this.commandTimeoutMs); } catch (error) { return Promise.reject(error); }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new CdpError(`CDP command timed out: ${method}`, undefined, method));
      }, timeoutMs);
      this.pending.set(id, { method, sessionId: options.sessionId, targetId: typeof params.targetId === "string" ? params.targetId : undefined, timer, resolve: result => resolve(result as T), reject });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(options.sessionId ? { sessionId: options.sessionId } : {}) })); }
      catch (error) {
        clearTimeout(timer); this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("CDP command send failed"));
      }
    });
  }

  sendSession<T = Record<string, unknown>>(sessionId: string, method: string, params: Record<string, unknown> = {}, options: Omit<CdpCommandOptions, "sessionId"> = {}): Promise<T> {
    return this.send<T>(method, params, { ...options, sessionId });
  }

  onEvent(handler: CdpEventHandler, method?: string): () => void {
    const subscription = { handler, method };
    this.subscriptions.add(subscription);
    return () => { this.subscriptions.delete(subscription); };
  }

  onSessionEvent(sessionId: string, handler: CdpEventHandler, method?: string): () => void {
    const subscription = { sessionId, handler, method };
    this.subscriptions.add(subscription);
    return () => { this.subscriptions.delete(subscription); };
  }

  off(handler: CdpEventHandler) {
    for (const subscription of this.subscriptions) if (subscription.handler === handler) this.subscriptions.delete(subscription);
  }

  onClose(handler: (reason: Error) => void): () => void {
    if (this.closedReason) { handler(this.closedReason); return () => {}; }
    this.closeListeners.add(handler);
    return () => { this.closeListeners.delete(handler); };
  }

  private invalidateSession(sessionId: string, error: Error) {
    this.invalidSessions.set(sessionId, error);
    this.sessions.delete(sessionId);
    for (const [id, pending] of this.pending) if (pending.sessionId === sessionId) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error);
    }
    for (const [childId, session] of this.sessions) if (session.parentSessionId === sessionId) this.invalidateSession(childId, error);
  }

  private invalidateTarget(targetId: string, error: Error) {
    for (const [sessionId, session] of this.sessions) if (session.targetId === targetId) this.invalidateSession(sessionId, error);
    for (const [id, pending] of this.pending) if (pending.targetId === targetId) {
      clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error);
    }
  }

  private lifecycle(event: CdpEvent) {
    const { method, params, sessionId } = event;
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
      const info = params.targetInfo as Record<string, unknown> | undefined;
      if (info && typeof info.targetId === "string") this.sessions.set(params.sessionId, { targetId: info.targetId, parentSessionId: sessionId });
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") this.invalidateSession(params.sessionId, new CdpError("CDP session detached"));
    if ((method === "Inspector.targetCrashed" || method === "Inspector.detached") && sessionId) this.invalidateSession(sessionId, new CdpError(method === "Inspector.targetCrashed" ? "CDP target crashed" : "CDP session detached"));
    if ((method === "Target.targetCrashed" || method === "Target.targetDestroyed") && typeof params.targetId === "string") this.invalidateTarget(params.targetId, new CdpError(method === "Target.targetCrashed" ? "CDP target crashed" : "CDP target destroyed"));
  }

  private receive = (message: MessageEvent) => {
    if (this.closedReason) return;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(typeof message.data === "string" ? message.data : new TextDecoder().decode(message.data));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw 0;
    } catch { this.close(new CdpError("Invalid CDP transport message")); return; }
    if (typeof data.id === "number") {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id); clearTimeout(pending.timer);
      if (data.error) {
        const error = data.error as { message?: string; code?: number; data?: unknown };
        pending.reject(new CdpError(error.message ?? "CDP command failed", error.code, pending.method, error.data));
      } else {
        const result = (data.result ?? {}) as Record<string, unknown>;
        if (pending.method === "Target.attachToTarget" && pending.targetId && typeof result.sessionId === "string") {
          this.sessions.set(result.sessionId, { targetId: pending.targetId, parentSessionId: pending.sessionId });
        }
        pending.resolve(result);
      }
      return;
    }
    if (typeof data.method !== "string") return;
    const event: CdpEvent = { method: data.method, params: (data.params ?? {}) as Record<string, unknown>, ...(typeof data.sessionId === "string" ? { sessionId: data.sessionId } : {}) };
    this.lifecycle(event);
    for (const subscription of [...this.subscriptions]) {
      if (subscription.sessionId !== undefined && subscription.sessionId !== event.sessionId) continue;
      const method = subscription.method;
      const prefix = method?.endsWith(".*") ? method.slice(0, -1) : method && !method.includes(".") ? `${method}.` : undefined;
      if (method && method !== event.method && (!prefix || !event.method.startsWith(prefix))) continue;
      try { subscription.handler(event); } catch {}
    }
  };

  private transportClosed = (event: CloseEvent) => { this.close(new CdpError(`CDP transport closed (${event.code})${event.reason ? `: ${event.reason}` : ""}`)); };
  private transportError = () => { this.close(new CdpError("CDP transport failed")); };

  close(reason: Error = new CdpError("CDP client closed")) {
    if (this.closedReason) return;
    this.closedReason = reason;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear(); this.sessions.clear(); this.invalidSessions.clear(); this.subscriptions.clear();
    this.socket.removeEventListener("message", this.receive);
    this.socket.removeEventListener("close", this.transportClosed);
    this.socket.removeEventListener("error", this.transportError);
    try { this.socket.close(); } catch {}
    try { (this.socket as WebSocket & { terminate?: () => void }).terminate?.(); } catch {}
    for (const listener of [...this.closeListeners]) { try { listener(reason); } catch {} }
    this.closeListeners.clear();
  }
}
