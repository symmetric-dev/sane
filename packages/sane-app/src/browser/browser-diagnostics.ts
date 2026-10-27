import { BROWSER_LIMITS as L, sanitizeBrowserDiagnosticUrl, type BrowserConsoleSeverity, type BrowserConsoleEntry as ConsoleEntry, type BrowserNetworkEntry as NetworkEntry, type BrowserDiagnosticsPage as DiagnosticsPage, type BrowserDiagnosticsSummary as DiagnosticsSummary } from "../../shared/browser-host-contract";
import type { CdpClient } from "./cdp-client";
export type { BrowserConsoleSeverity } from "../../shared/browser-host-contract";
export type BrowserConsoleEntry = ConsoleEntry & { source: "console" | "exception" | "log"; truncated: boolean };
export type BrowserNetworkEntry = NetworkEntry & { finished: boolean };
export type BrowserDiagnosticsCursor = { collectionStartedAt: string; earliestAvailableSeq: number; nextSeq: number; truncatedCount: number };
export type BrowserDiagnosticsPage<T> = DiagnosticsPage<T> & { workspaceId: string };
export type BrowserDiagnosticsSummary = DiagnosticsSummary & { workspaceId: string; tabId: string; targetId: string; generation: number; console: BrowserDiagnosticsCursor; network: BrowserDiagnosticsCursor };
export type BrowserDiagnosticsCdp = Pick<CdpClient, "send" | "onEvent" | "onSessionEvent" | "onClose" | "closed">;
const MAX_ENTRIES = L.consoleMaxEntries, MAX_BYTES = L.consoleMaxBytes;
const textBytes = (text: string) => Buffer.byteLength(text, "utf8");
function cap(text: string, bytes: number): string {
  if (textBytes(text) <= bytes) return text;
  let result = "", used = 0;
  for (const char of text) {
    const size = textBytes(char);
    if (used + size > bytes) break;
    result += char; used += size;
  }
  return result;
}
export const sanitizeBrowserUrl = sanitizeBrowserDiagnosticUrl;
class DiagnosticRing<T extends { seq: number }> {
  private rows: { value: T; bytes: number }[] = [];
  private bytes = 0;
  nextSeq = 1;
  truncatedCount = 0;
  constructor(readonly collectionStartedAt: string) {}
  append(value: Omit<T, "seq">, replaced?: (entry: T) => boolean): T {
    if (replaced) {
      const index = this.rows.findIndex(row => replaced(row.value));
      if (index !== -1) this.bytes -= this.rows.splice(index, 1)[0]!.bytes;
    }
    const entry = { ...value, seq: this.nextSeq++ } as T;
    const bytes = textBytes(JSON.stringify(entry));
    this.rows.push({ value: entry, bytes }); this.bytes += bytes;
    while (this.rows.length > MAX_ENTRIES || this.bytes > MAX_BYTES) { this.bytes -= this.rows.shift()!.bytes; this.truncatedCount++; }
    return entry;
  }
  entries(): T[] { return this.rows.map(row => ({ ...row.value })); }
  cursor(): BrowserDiagnosticsCursor {
    return { collectionStartedAt: this.collectionStartedAt, earliestAvailableSeq: this.rows[0]?.value.seq ?? this.nextSeq, nextSeq: this.nextSeq, truncatedCount: this.truncatedCount };
  }
}
type NetworkRequest = { entry: BrowserNetworkEntry; startedAt: number; redirectIndex: number; sessionId: string };

export class BrowserDiagnostics {
  private consoleRing: DiagnosticRing<BrowserConsoleEntry>;
  private networkRing: DiagnosticRing<BrowserNetworkEntry>;
  private requests = new Map<string, NetworkRequest>();
  private cleanups = new Set<() => void>();
  constructor(readonly workspaceId: string, readonly tabId: string, private generation: number, private targetId: string) {
    const now = new Date().toISOString();
    this.consoleRing = new DiagnosticRing(now); this.networkRing = new DiagnosticRing(now);
  }
  private identity() { return { workspaceId: this.workspaceId, tabId: this.tabId, targetId: this.targetId, generation: this.generation }; }
  recordConsole(input: { severity: BrowserConsoleSeverity; source: BrowserConsoleEntry["source"]; text: string; url?: string; lineNumber?: number }): BrowserConsoleEntry {
    const text = cap(input.text, L.consoleEntryMaxBytes);
    return this.consoleRing.append({ timestamp: new Date().toISOString(), severity: input.severity, source: input.source, text, truncated: text !== input.text, ...(input.url ? { url: sanitizeBrowserUrl(input.url) } : {}), ...(input.lineNumber === undefined ? {} : { lineNumber: input.lineNumber }) });
  }
  queryConsole({ afterSeq = 0, limit = 100, severity }: { afterSeq?: number; limit?: number; severity?: BrowserConsoleSeverity | BrowserConsoleSeverity[] } = {}): BrowserDiagnosticsPage<BrowserConsoleEntry> {
    const levels = severity === undefined ? undefined : Array.isArray(severity) ? severity : [severity];
    return { ...this.identity(), ...this.consoleRing.cursor(), entries: this.consoleRing.entries().filter(entry => entry.seq > afterSeq && (!levels || levels.includes(entry.severity))).slice(0, this.limit(limit)) };
  }
  queryNetwork({ afterSeq = 0, limit = 100, onlyFailed = false }: { afterSeq?: number; limit?: number; onlyFailed?: boolean } = {}): BrowserDiagnosticsPage<BrowserNetworkEntry> {
    return { ...this.identity(), ...this.networkRing.cursor(), entries: this.networkRing.entries().filter(entry => entry.seq > afterSeq && (!onlyFailed || entry.failed)).slice(0, this.limit(limit)) };
  }
  private limit(value: number) { return Number.isFinite(value) ? Math.max(0, Math.min(MAX_ENTRIES, Math.floor(value))) : 100; }
  summary(): BrowserDiagnosticsSummary {
    const console = this.consoleRing.cursor(), network = this.networkRing.cursor();
    return { ...this.identity(), collectionStartedAt: console.collectionStartedAt, consoleNextSeq: console.nextSeq, consoleTruncatedCount: console.truncatedCount, networkNextSeq: network.nextSeq, networkTruncatedCount: network.truncatedCount, console, network };
  }
  reset(newGeneration: number, targetId: string): void {
    if (!Number.isSafeInteger(newGeneration) || newGeneration <= this.generation) throw new Error("Browser diagnostics generation must increase");
    if (targetId !== this.targetId) this.detach();
    this.generation = newGeneration; this.targetId = targetId;
    const now = new Date().toISOString();
    this.consoleRing = new DiagnosticRing(now); this.networkRing = new DiagnosticRing(now); this.requests.clear();
  }
  detach(): void { for (const cleanup of [...this.cleanups]) cleanup(); this.cleanups.clear(); }
  private network(event: string, params: Record<string, any>, sessionId: string) {
    const id = JSON.stringify([sessionId, params.requestId]);
    let request = this.requests.get(id);
    if (event === "Network.requestWillBeSent") {
      const redirectIndex = params.redirectResponse && request ? request.redirectIndex + 1 : 0;
      if (params.redirectResponse && request) {
        const durationMs = Math.max(0, (Number(params.timestamp) - request.startedAt) * 1000);
        this.networkRing.append({ ...request.entry, status: Number(params.redirectResponse.status), durationMs: Number.isFinite(durationMs) ? durationMs : undefined, finished: true }, entry => entry.requestId === request!.entry.requestId);
      }
      const entry: BrowserNetworkEntry = { seq: 0, timestamp: new Date().toISOString(), requestId: redirectIndex ? `${id}:${redirectIndex}` : id, method: cap(String(params.request?.method ?? ""), 128), url: sanitizeBrowserUrl(String(params.request?.url ?? "")), resourceType: cap(String(params.type ?? ""), 128), failed: false, finished: false };
      request = { entry, startedAt: Number(params.timestamp), redirectIndex, sessionId }; this.requests.delete(id); this.requests.set(id, request);
    } else if (!request) return;
    if (event === "Network.responseReceived") {
      request.entry.status = Number(params.response?.status);
      request.entry.resourceType = cap(String(params.type ?? request.entry.resourceType ?? ""), 128);
      request.entry.failed = request.entry.status >= 400;
    }
    if (event === "Network.loadingFinished" || event === "Network.loadingFailed") {
      request.entry.finished = true;
      const duration = (Number(params.timestamp) - request.startedAt) * 1000;
      if (Number.isFinite(duration)) request.entry.durationMs = Math.max(0, duration);
      if (event === "Network.loadingFailed") { request.entry.failed = true; request.entry.failureText = cap(String(params.errorText ?? "Request failed"), 8192); }
    }
    request.entry = this.networkRing.append(request.entry, entry => entry.requestId === request!.entry.requestId);
    if (request.entry.finished) this.requests.delete(id);
    const retained = new Set(this.networkRing.entries().map(entry => entry.requestId));
    for (const [key, pending] of this.requests) if (!retained.has(pending.entry.requestId)) this.requests.delete(key);
  }
  async attachBeforeNavigation(cdp: BrowserDiagnosticsCdp, cdpSessionId: string, options: { beforeResumeChild?: (sessionId: string, targetInfo: Record<string, any>) => Promise<boolean | void> } = {}): Promise<() => void> {
    this.detach();
    const sessions = new Map<string, { parent?: string; listeners: (() => void)[] }>();
    let disposed = false;
    const active = () => !disposed;
    const removeSession = (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      for (const off of session.listeners.splice(0)) off();
      sessions.delete(sessionId);
      for (const [childId, child] of sessions) if (child.parent === sessionId) removeSession(childId);
      for (const [key, request] of this.requests) if (request.sessionId === sessionId) this.requests.delete(key);
    };
    const cleanup = () => { disposed = true; for (const sessionId of [...sessions.keys()]) removeSession(sessionId); this.cleanups.delete(cleanup); };
    this.cleanups.add(cleanup);
    const enable = async (sessionId: string, page = true, parent?: string): Promise<void> => {
      if (!active() || sessions.has(sessionId)) return;
      const session = { parent, listeners: [] as (() => void)[] };
      sessions.set(sessionId, session);
      const attached = () => active() && sessions.has(sessionId);
      const listen = (method: string, handler: (params: Record<string, any>) => void) => {
        session.listeners.push(cdp.onSessionEvent(sessionId, event => { if (attached()) handler(event.params); }, method));
      };
      listen("Runtime.consoleAPICalled", params => {
        const severity: BrowserConsoleSeverity = params.type === "error" || params.type === "assert" ? "error" : params.type === "warning" || params.type === "warn" ? "warn" : params.type === "info" ? "info" : "log";
        const text = (Array.isArray(params.args) ? params.args : []).map((arg: Record<string, any>) => {
          if (typeof arg.value === "string") return arg.value;
          if (arg.value !== undefined) { try { return JSON.stringify(arg.value); } catch {} }
          return String(arg.unserializableValue ?? arg.description ?? arg.type ?? "");
        }).join(" ");
        this.recordConsole({ source: "console", severity, text });
      });
      listen("Runtime.exceptionThrown", params => {
        const details = params.exceptionDetails ?? {};
        this.recordConsole({ source: "exception", severity: "exception", text: String(details.exception?.description ?? details.text ?? "Uncaught exception"), url: details.url, lineNumber: details.lineNumber });
      });
      listen("Log.entryAdded", params => {
        const entry = params.entry ?? {}, level = entry.level;
        this.recordConsole({ source: "log", severity: level === "error" ? "error" : level === "warning" ? "warn" : level === "verbose" ? "log" : "info", text: String(entry.text ?? ""), url: entry.url, lineNumber: entry.lineNumber });
      });
      for (const event of ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"]) listen(event, params => this.network(event, params, sessionId));
      listen("Target.detachedFromTarget", params => { if (typeof params.sessionId === "string") removeSession(params.sessionId); });
      listen("Target.attachedToTarget", params => {
        if (typeof params.sessionId !== "string") return;
        void (async () => {
          if (options.beforeResumeChild && await options.beforeResumeChild(params.sessionId, params.targetInfo ?? {}) === false) return;
          if (!attached()) return;
          const type = params.targetInfo?.type;
          await enable(params.sessionId, type === "iframe" || type === "page", sessionId);
          if (attached() && sessions.has(params.sessionId)) await cdp.send("Runtime.runIfWaitingForDebugger", {}, { sessionId: params.sessionId });
        })().catch(error => {
          if (active()) this.recordConsole({ source: "log", severity: "error", text: `Child diagnostics attachment failed: ${error instanceof Error ? error.message : "CDP error"}` });
          removeSession(params.sessionId);
          if (typeof params.targetInfo?.targetId === "string") void cdp.send("Target.closeTarget", { targetId: params.targetInfo.targetId }).catch(() => {});
        });
      });
      for (const domain of page ? ["Runtime", "Log", "Page", "Network"] : ["Runtime", "Network"]) {
        if (!attached()) return;
        await cdp.send(`${domain}.enable`, {}, { sessionId });
      }
      if (attached() && page) await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { sessionId });
    };
    try { await enable(cdpSessionId); return cleanup; } catch (error) { cleanup(); throw error; }
  }
}
