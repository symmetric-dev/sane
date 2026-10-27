import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { BROWSER_LIMITS, type BrowserCapability } from "../../shared/browser-host-contract";
import { CdpClient } from "./cdp-client";

export type ChromiumSupervisorOptions = { dataDir?: string; startupTimeoutMs?: number; commandTimeoutMs?: number; shutdownTimeoutMs?: number };
type Resource = {
  profileDir?: string; child?: Bun.Subprocess<"ignore", "ignore", "pipe">; client?: CdpClient;
  exited: boolean; expectedExit: boolean; crashReported: boolean;
  abort: AbortController; cleanup?: Promise<void>;
};
let hostSupervisor: ChromiumSupervisor | undefined;

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}

export async function discoverChromiumExecutable(): Promise<string | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const override = process.env.SANE_CHROMIUM_BIN;
  if (override) {
    const path = isAbsolute(override) ? override : resolve(override);
    return await executable(path) ? path : null;
  }
  const paths = process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
    "/opt/homebrew/bin/chromium", "/usr/local/bin/chromium",
  ] : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome", "/snap/bin/chromium"];
  for (const path of paths) if (await executable(path)) return path;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "Google Chrome.app/Contents/MacOS/Google Chrome"]) {
      const path = resolve(directory, name);
      if (await executable(path)) return path;
    }
  }
  return null;
}

export async function getChromiumCapability(): Promise<BrowserCapability> {
  if (process.env.SANE_HOST_BROWSER === "0") return { available: false, reason: "Host browser is disabled by SANE_HOST_BROWSER=0" };
  if (process.platform !== "darwin" && process.platform !== "linux") return { available: false, reason: "Host Chromium requires macOS or Linux" };
  const executablePath = await discoverChromiumExecutable();
  return executablePath ? { available: true, executablePath } : { available: false, reason: process.env.SANE_CHROMIUM_BIN ? "SANE_CHROMIUM_BIN does not name an executable Chromium file" : "No local Chrome or Chromium executable found; set SANE_CHROMIUM_BIN" };
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2147483647) throw new Error("Chromium timeout must be a positive bounded number");
  return value;
}

export class ChromiumSupervisor {
  private resource?: Resource;
  private starting?: Promise<CdpClient>;
  private stopping?: Promise<void>;
  private closed = false;
  private crashListeners = new Set<(reason: string) => void>();
  private startupTimeoutMs: number;
  private commandTimeoutMs: number;
  private shutdownTimeoutMs: number;

  constructor(private options: ChromiumSupervisorOptions = {}) {
    this.startupTimeoutMs = boundedTimeout(options.startupTimeoutMs ?? 15000);
    this.commandTimeoutMs = boundedTimeout(options.commandTimeoutMs ?? 10000);
    this.shutdownTimeoutMs = boundedTimeout(options.shutdownTimeoutMs ?? 2000);
  }

  capability(): Promise<BrowserCapability> { return getChromiumCapability(); }
  get client(): CdpClient | null { return this.resource?.client && !this.resource.client.closed ? this.resource.client : null; }

  onCrash(listener: (reason: string) => void): () => void {
    this.crashListeners.add(listener);
    return () => { this.crashListeners.delete(listener); };
  }

  start(): Promise<CdpClient> {
    if (this.closed || this.stopping) return Promise.reject(new Error("Chromium supervisor is closing or stopping"));
    if (process.env.SANE_HOST_BROWSER === "0") return Promise.reject(new Error("Host browser is disabled by SANE_HOST_BROWSER=0"));
    if (this.starting) return this.starting;
    if (this.client) return Promise.resolve(this.client);
    if (this.resource) return Promise.reject(new Error("Previous Chromium cleanup must finish before starting"));
    if (hostSupervisor && hostSupervisor !== this) return Promise.reject(new Error("A Chromium process is already supervised on this host"));
    hostSupervisor = this;
    const resource: Resource = { exited: false, expectedExit: false, crashReported: false, abort: new AbortController() };
    this.resource = resource;
    this.starting = this.launch(resource).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private check(resource: Resource) {
    if (resource.abort.signal.aborted) throw resource.abort.signal.reason;
  }

  private async launch(resource: Resource): Promise<CdpClient> {
    const timer = setTimeout(() => resource.abort.abort(new Error("Chromium startup timed out")), this.startupTimeoutMs);
    const deadline = Date.now() + this.startupTimeoutMs;
    try {
      const capability = await this.capability();
      this.check(resource);
      if (!capability.available || !capability.executablePath) throw new Error(capability.reason ?? "Chromium is unavailable");
      const directory = this.options.dataDir ?? tmpdir();
      if (this.options.dataDir) await mkdir(directory, { recursive: true, mode: 0o700 });
      this.check(resource);
      resource.profileDir = await mkdtemp(join(directory, "sane-chromium-"));
      this.check(resource);
      const viewport = BROWSER_LIMITS.defaultViewport;
      resource.child = Bun.spawn([capability.executablePath,
        "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
        "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--disable-sync", "--disable-extensions", "--disable-component-update", "--disable-popup-blocking=false",
        "--mute-audio", `--window-size=${viewport.width},${viewport.height}`, `--user-data-dir=${resource.profileDir}`, "about:blank",
      ], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      void resource.child.exited.then(code => {
        resource.exited = true;
        if (!resource.expectedExit) this.crashed(resource, `Chromium exited unexpectedly (${code})`);
      }, () => { if (!resource.expectedExit) this.crashed(resource, "Could not observe Chromium process exit"); });
      const endpoint = await this.endpoint(resource);
      this.check(resource);
      const client = await CdpClient.connect(endpoint, { connectTimeoutMs: Math.max(1, deadline - Date.now()), commandTimeoutMs: this.commandTimeoutMs, signal: resource.abort.signal });
      resource.client = client;
      if (resource.abort.signal.aborted) { client.close(); this.check(resource); }
      client.onClose(reason => { if (!resource.expectedExit) this.crashed(resource, `Chromium CDP connection lost: ${reason.message}`); });
      const version = await client.send<{ product?: string; protocolVersion?: string }>("Browser.getVersion", {}, { timeoutMs: Math.max(1, Math.min(this.commandTimeoutMs, deadline - Date.now())) });
      this.check(resource);
      if (!version.product || !version.protocolVersion) throw new Error("Chromium did not return a valid Browser.getVersion response");
      return client;
    } catch (error) {
      await this.cleanup(resource);
      throw error;
    } finally { clearTimeout(timer); }
  }

  private endpoint(resource: Resource): Promise<string> {
    const reader = resource.child!.stderr.getReader();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const abort = () => {
        if (!settled) { settled = true; reject(resource.abort.signal.reason ?? new Error("Chromium startup aborted")); }
        void reader.cancel().catch(() => {});
      };
      resource.abort.signal.addEventListener("abort", abort, { once: true });
      if (resource.abort.signal.aborted) abort();
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)[\r\n]/.exec(buffer);
            if (!settled && match) { settled = true; resolve(match[1]!); }
            buffer = buffer.slice(-16384);
          }
          if (!settled) { settled = true; reject(new Error("Chromium stderr closed before a DevTools endpoint was announced")); }
        } catch (error) {
          if (!settled) { settled = true; reject(error); }
          else if (!resource.expectedExit && !resource.abort.signal.aborted) this.crashed(resource, "Chromium stderr transport failed");
        } finally {
          resource.abort.signal.removeEventListener("abort", abort);
          reader.releaseLock();
        }
      })();
    });
  }

  private crashed(resource: Resource, reason: string) {
    if (resource.crashReported || resource.expectedExit) return;
    resource.crashReported = true;
    resource.expectedExit = true;
    resource.abort.abort(new Error(reason));
    resource.client?.close(new Error(reason));
    for (const listener of [...this.crashListeners]) { try { listener(reason); } catch {} }
    void this.cleanup(resource).catch(() => {});
  }

  private cleanup(resource: Resource): Promise<void> {
    if (resource.cleanup) return resource.cleanup;
    resource.expectedExit = true;
    resource.abort.abort(new Error("Chromium stopped"));
    resource.client?.close();
    resource.cleanup = (async () => {
      const child = resource.child;
      if (child) {
        const groupAlive = () => {
          try { process.kill(-child.pid, 0); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
        };
        const signal = (value: NodeJS.Signals) => {
          try { process.kill(-child.pid, value); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          if (!resource.exited) { try { child.kill(value); } catch {} }
        };
        for (const value of ["SIGTERM", "SIGKILL"] as const) {
          signal(value);
          const deadline = Date.now() + this.shutdownTimeoutMs;
          while ((!resource.exited || groupAlive()) && Date.now() < deadline) await Bun.sleep(25);
          if (resource.exited && !groupAlive()) break;
        }
        if (!resource.exited || groupAlive()) throw new Error("Chromium process-group exit unconfirmed; temporary profile retained and restart refused");
      }
      if (resource.profileDir) await rm(resource.profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      if (this.resource === resource) this.resource = undefined;
      if (hostSupervisor === this) hostSupervisor = undefined;
    })();
    return resource.cleanup;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const resource = this.resource;
    if (!resource) return Promise.resolve();
    resource.expectedExit = true;
    resource.abort.abort(new Error("Chromium stopped"));
    resource.client?.close();
    this.stopping = (async () => {
      try { await this.starting; } catch {}
      await this.cleanup(resource);
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stop();
    this.crashListeners.clear();
  }
}
