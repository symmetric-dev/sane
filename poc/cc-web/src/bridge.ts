import { mkdir, readFile, writeFile, rename, appendFile, stat, rm, readdir, realpath } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { decodeLog, validateMetadata, validateOwner, validModel, validEffort, validVariant, efforts, type Status, type Session, type Run, type Event, type Metadata } from "./history";
import { OpenCodeAdapter, OpenCodeError, normalizeMessage } from "./opencode";
import { WorkspaceService, WorkspaceError, workspaceError } from "./workspace";
import { CatalogService } from "./catalog";
import { TerminalService, type TerminalSocketData } from "./terminal";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const hookEvents = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "CwdChanged"] as const;
export type Options = { host: string; port: number; cwd: string; dataDir: string; claudeBin: string; opencodeUrl?: string; allowRemote: boolean; publicOrigin?: string; reconcileInterrupted: boolean };
export function parseOptions(args: string[]): Options {
  const o: Options = { host: "127.0.0.1", port: 8787, cwd: process.cwd(), dataDir: join(root, ".data"), claudeBin: "claude", allowRemote: false, reconcileInterrupted: false };
  const names: Record<string, keyof Options> = { "--host": "host", "--port": "port", "--cwd": "cwd", "--data-dir": "dataDir", "--claude-bin": "claudeBin", "--opencode-url": "opencodeUrl", "--public-origin": "publicOrigin" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-remote") o.allowRemote = true;
    else if (args[i] === "--reconcile-interrupted") o.reconcileInterrupted = true;
    else {
      const name = names[args[i]!]; const value = args[++i];
      if (!name || !value) throw new Error("Unknown option or missing value");
      (o as unknown as Record<string, unknown>)[name] = name === "port" ? Number(value) : value;
    }
  }
  if (!Number.isInteger(o.port) || o.port < 0 || o.port > 65535) throw new Error("Invalid port");
  o.cwd = resolve(o.cwd); o.dataDir = resolve(o.dataDir);
  return o;
}
const loopback = (host: string) => ["127.0.0.1", "::1", "localhost", "[::1]", "::ffff:127.0.0.1"].includes(host);
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
async function body(req: Request): Promise<any> {
  if (Number(req.headers.get("content-length")) > 1024 * 1024) throw new Error("Body too large");
  const reader = req.body?.getReader(); if (!reader) throw new Error("Missing body");
  let size = 0; const parts: Uint8Array[] = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new Error("Body too large"); } parts.push(value); }
  return JSON.parse(Buffer.concat(parts).toString());
}
export async function start(options: Options) {
  const oc = new OpenCodeAdapter(options.opencodeUrl);
  const forbidden = Object.keys(process.env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_CUSTOM_MODEL_OPTION|AWS_BEARER_TOKEN_BEDROCK|OPENAI_API_KEY|OPENAI_BASE_URL)/.test(k));
  if (forbidden.length) throw new Error(`Remove API/provider overrides: ${forbidden.join(", ")}`);
  if (!(await stat(options.cwd)).isDirectory()) throw new Error("cwd must be a directory");
  const remote = !loopback(options.host); const password = process.env.CC_WEB_PASSWORD;
  if (remote && (!options.allowRemote || !password || !options.publicOrigin)) throw new Error("Remote host requires --allow-remote, CC_WEB_PASSWORD and --public-origin https://...");
  if (options.publicOrigin) { const u = new URL(options.publicOrigin); if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback(u.hostname) && !remote)) || u.origin !== options.publicOrigin || u.username || u.password) throw new Error("public-origin must be an exact HTTPS origin (or HTTP loopback origin for a local SSH forward)"); }
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(options.dataDir, "owner.lock");
  const gate = join(options.dataDir, "owner-acquisition.lock");
  // Serialize both ownership acquisition and stale-owner reclamation. A crash
  // inside this tiny section leaves a conservative manual-cleanup gate.
  try { await mkdir(gate); } catch { throw new Error("Data directory ownership is being acquired; if stale, verify bridge/CLI processes stopped before removing owner-acquisition.lock"); }
  try {
    let owner: { pid: number } | undefined;
    try { owner = validateOwner(JSON.parse(await readFile(lockPath, "utf8"))); } catch (e: any) { if (e.code !== "ENOENT") throw new Error("Invalid owner.lock schema; operator reconciliation required"); }
    if (owner) {
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (e: any) { if (e.code === "ESRCH") alive = false; }
      if (alive) throw new Error("Data directory is owned by a live bridge process");
      if (!options.reconcileInterrupted) {
        // A dead bridge cannot own native OC execution. Its durable run can be
        // resumed by observation without asking users to stop the shared server.
        let nativeOnly = false;
        try {
          const prior = validateMetadata(JSON.parse(await readFile(join(options.dataDir, "metadata.json"), "utf8")));
          const running = prior.runs.filter(r => r.status === "running");
          nativeOnly = !prior.reconciliationRequired && running.length > 0 && running.every(r => prior.sessions.find(s => s.sessionId === r.sessionId)?.harness === "opencode");
        } catch { /* Preserve the existing conservative CC reconciliation gate. */ }
        if (!nativeOnly) throw new Error("Stale data-directory owner: verify surviving CLI processes stopped, then restart with --reconcile-interrupted");
      }
      await rm(lockPath);
    }
    await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  } finally { await rm(gate, { recursive: true, force: true }); }
  let retainOwner = false;
  try {
  const metadataPath = join(options.dataDir, "metadata.json");
  let meta: Metadata;
  try { meta = validateMetadata(JSON.parse(await readFile(metadataPath, "utf8"))); } catch (e: any) {
    if (e.code !== "ENOENT") throw new Error(`Cannot load metadata: ${e.message}`);
    if ((await readdir(options.dataDir)).some(name => name.endsWith(".jsonl") || name.endsWith(".settings.json"))) throw new Error("Cannot load metadata: missing file with existing run history");
    meta = { sessions: [], runs: [], reconciliationRequired: false };
  }
  const catalog = new CatalogService(options.dataDir, () => meta.sessions);
  await catalog.load();
  const workspace = new WorkspaceService(async id => {
    const session = meta.sessions.find(session => session.sessionId === id);
    if (!session) return undefined;
    const a = catalog.association(id);
    if (a.association === "unresolved") throw new WorkspaceError(409, "association-unresolved", "Conversation workspace is unresolved; historical logs remain available");
    const binding = await catalog.binding(a.workspaceId, a.worktreeId);
    if ((await catalog.discover(session.cwd)).root !== binding.cwd) throw new WorkspaceError(409, "cwd-worktree-mismatch", "Conversation cwd binding changed");
    return { cwd: session.cwd, protectedPaths: binding.protectedPaths };
  }, options.dataDir);
  const worktrees = new WorkspaceService(async key => {
    const [workspaceId, worktreeId] = key.split("/");
    return catalog.binding(workspaceId!, worktreeId!);
  }, options.dataDir);
  const events = new Map<string, Event[]>();
  const secrets = new Map<string, string>();
  type Owner = { run: Run; native?: boolean; child?: Bun.Subprocess<"pipe", "pipe", "pipe">; done: Promise<void>; settled: boolean; stopping?: Promise<boolean> };
  let active: Owner | undefined;
  let closing = false, storageFailed = false;
  function availability(): { canSend: boolean; reason?: string } {
    if (storageFailed) return { canSend: false, reason: "Storage unavailable; operator reconciliation required" };
    if (meta.reconciliationRequired) return { canSend: false, reason: "Operator reconciliation required: restart with --reconcile-interrupted after verifying previous CLI processes are stopped" };
    if (closing) return { canSend: false, reason: "Bridge is shutting down" };
    if (active) return { canSend: false, reason: "A run is already active" };
    return { canSend: true };
  }
  let serial = Promise.resolve();
  function persist() { return enqueue(async () => { await writeFile(`${metadataPath}.tmp`, JSON.stringify(meta), { mode: 0o600 }); await rename(`${metadataPath}.tmp`, metadataPath); }); }
  function failClosed() {
    storageFailed = true; retainOwner = true; meta.reconciliationRequired = true;
    // The existing owner.lock is the durable sentinel even if every later disk
    // write fails. Reopening requires process exit and explicit reconciliation.
    if (active?.child) void terminate(active);
  }
  function enqueue(fn: () => Promise<void>) {
    const next = serial.then(async () => { if (storageFailed) throw new Error("Storage unavailable; operator reconciliation required"); await fn(); });
    serial = next.catch(() => { failClosed(); });
    return next;
  }
  function groupAlive(owner: Owner): boolean {
    if (!owner.child) return false;
    try { process.kill(-owner.child.pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; }
  }
  function signal(owner: Owner, value: NodeJS.Signals) {
    if (!owner.child) return;
    // Only the process group created by this live bridge is ever signalled.
    try { process.kill(-owner.child.pid, value); } catch { /* It may already have exited. */ }
    try { owner.child.kill(value); } catch { /* Also cover the direct child. */ }
  }
  function terminate(owner: Owner): Promise<boolean> {
    if (owner.stopping) return owner.stopping;
    owner.stopping = (async () => {
      if (!owner.child) return true;
      let exited = false;
      void owner.child.exited.then(() => { exited = true; }, () => {});
      for (const value of ["SIGTERM", "SIGKILL"] as const) {
        signal(owner, value);
        for (let i = 0; i < 50; i++) { if (exited && !groupAlive(owner)) return true; await Bun.sleep(20); }
      }
      retainOwner = true; meta.reconciliationRequired = true;
      return false;
    })().catch(() => { retainOwner = true; meta.reconciliationRequired = true; return false; });
    return owner.stopping;
  }
  function emit(run: Run, kind: Event["kind"], data: unknown) {
    const list = events.get(run.runId)!;
    const event: Event = { seq: (list.at(-1)?.seq ?? 0) + 1, time: new Date().toISOString(), runId: run.runId, sessionId: run.sessionId, kind, data };
    list.push(event);
    return enqueue(() => appendFile(join(options.dataDir, `${run.runId}.jsonl`), JSON.stringify(event) + "\n", { mode: 0o600 }));
  }
  for (const run of meta.runs) {
    const logPath = join(options.dataDir, `${run.runId}.jsonl`);
    let raw: string;
    try { raw = await readFile(logPath, "utf8"); } catch (e: any) { throw new Error(`Cannot load historical event log for ${run.runId}: ${e.code === "ENOENT" ? "missing file" : "read failed"}`); }
    const decoded = decodeLog(raw, run); const list = decoded.events;
    if (decoded.repaired !== undefined) await enqueue(() => writeFile(logPath, decoded.repaired!, { mode: 0o600 }));
    events.set(run.runId, list);
    if (run.status === "running" && meta.sessions.find(s => s.sessionId === run.sessionId)?.harness !== "opencode") {
      run.status = "interrupted"; run.endedAt = new Date().toISOString(); meta.reconciliationRequired = true;
      const session = meta.sessions.find(s => s.sessionId === run.sessionId)!; session.lastStatus = "interrupted";
      await emit(run, "status", { status: "interrupted", reason: "server restarted; verify old CLI process has stopped" });
    }
  }
  if (options.reconcileInterrupted) meta.reconciliationRequired = false;
  await persist();
  const cookies = new Set<string>();
  let localTerminalToken = crypto.randomUUID();
  const terminalToken = (req: Request) => {
    for (const item of (req.headers.get("cookie") ?? "").split(";")) { const [key, value] = item.trim().split("="); if (key === "cc_web" && value && cookies.has(value)) return value; }
    return password ? undefined : localTerminalToken;
  };
  const terminals = new TerminalService(catalog, token => cookies.has(token) || !password && token === localTerminalToken);
  let origin = "";
  const authenticated = (req: Request) => !password || (req.headers.get("cookie") ?? "").split(";").some(s => { const [k, v] = s.trim().split("="); return k === "cc_web" && !!v && cookies.has(v); });
  async function consume(run: Run, stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr", result: { seen: boolean; error: boolean; diagnostic?: string }) {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
    async function line(text: string) {
      if (!text) return;
      let data: any = text;
      if (kind === "stdout") {
        try { data = JSON.parse(text); } catch {}
        if ((data?.type === "system" && data.subtype === "init") || data?.type === "result") {
          if (data.session_id !== run.sessionId) { result.error = true; result.diagnostic = "CLI session identity mismatch or missing session_id"; }
        }
        if (data?.type === "result") {
          if (result.seen) { result.error = true; result.diagnostic = "Duplicate CLI result"; }
          result.seen = true;
          if (data.subtype !== "success" || data.is_error !== false) { result.error = true; result.diagnostic ??= "CLI result is not an explicit success"; }
        }
      }
      await emit(run, kind, data);
    }
    while (true) { const { value, done } = await reader.read(); if (done) break; pending += decoder.decode(value, { stream: true }); let at: number; while ((at = pending.indexOf("\n")) >= 0) { await line(pending.slice(0, at)); pending = pending.slice(at + 1); } if (pending.length > 1024 * 1024) { await line(pending); pending = ""; } }
    pending += decoder.decode(); await line(pending);
  }
  async function execute(owner: Owner, prompt: string, resume: boolean, ready: (accepted: boolean) => void) {
    const run = owner.run;
    const result: { seen: boolean; error: boolean; diagnostic?: string } = { seen: false, error: false };
    let streams: Promise<unknown>[] = [];
    try {
      // Write the first log record before publishing its metadata reference.
      await emit(run, "status", { status: "running" });
      await emit(run, "submission", { messageId: `${run.runId}:user`, text: prompt });
      await persist();
      ready(true);
      if (closing) throw new Error("Closing before launch");
      const secret = crypto.randomUUID() + crypto.randomUUID(); secrets.set(run.runId, secret);
      const hooks = Object.fromEntries(hookEvents.map(event => [event, [{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(join(root, "hooks/forward.ts"))} ${quote(event)}`, timeout: 3 }] }]]));
      const settingsPath = join(options.dataDir, `${run.runId}.settings.json`);
      await enqueue(() => writeFile(settingsPath, JSON.stringify({ hooks }), { mode: 0o600 }));
      if (closing || storageFailed) throw new Error("Closing before launch");
      const args = [options.claudeBin, "-p", "--output-format", "stream-json", "--verbose", resume ? "--resume" : "--session-id", run.sessionId, "--settings", settingsPath];
      if (run.model !== undefined) args.push("--model", run.model);
      if (run.effort !== undefined) args.push("--effort", run.effort);
      const child = Bun.spawn(args, {
        cwd: run.cwd, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, CC_WEB_PASSWORD: undefined, OPENCODE_TOKEN: undefined, CC_WEB_HOOK_URL: `http://127.0.0.1:${hookServer.port}`, CC_WEB_RUN_ID: run.runId, CC_WEB_HOOK_SECRET: secret },
      });
      owner.child = child;
      streams = [consume(run, child.stdout, "stdout", result), consume(run, child.stderr, "stderr", result)];
      // Observe both consumers immediately, including the loser on rejection.
      const output = Promise.all([child.exited, ...streams]);
      // Attach the observer before writing, since a synchronous stdin failure
      // must not leave an independently rejecting stream promise behind.
      void output.catch(() => {});
      child.stdin.write(prompt);
      const [exit] = await Promise.all([output.then(values => values[0] as number), child.stdin.end()]);
      if (groupAlive(owner) && !(await terminate(owner))) throw new Error("Process group termination unconfirmed");
      run.status = closing ? "interrupted" : !storageFailed && exit === 0 && result.seen && !result.error ? "completed" : "failed";
      await emit(run, "status", { status: run.status, exitCode: exit, resultSeen: result.seen, ...(result.diagnostic ? { reason: result.diagnostic } : {}) });
    } catch {
      ready(false);
      await terminate(owner);
      run.status = closing ? "interrupted" : "failed";
      try { await emit(run, "status", { status: run.status, reason: storageFailed ? "Storage failure; operator reconciliation required" : "CLI launch, stream, or shutdown failure" }); } catch { failClosed(); }
    } finally {
      ready(false);
      // Consumers can still be unwinding after a failure. Do not free the slot
      // until both finish; a timeout keeps the ownership sentinel in place.
      const drained = await Promise.race([Promise.allSettled(streams).then(() => true), Bun.sleep(2200).then(() => false)]);
      if (!drained) { retainOwner = true; meta.reconciliationRequired = true; }
      run.endedAt = new Date().toISOString(); meta.sessions.find(s => s.sessionId === run.sessionId)!.lastStatus = run.status;
      try { await persist(); } catch { failClosed(); }
      if (!retainOwner && active === owner) active = undefined;
    }
  }
  async function finishNative(owner: Owner, status: Status, reason?: string) {
    owner.run.status = status; owner.run.endedAt = new Date().toISOString();
    meta.sessions.find(s => s.sessionId === owner.run.sessionId)!.lastStatus = status;
    await emit(owner.run, "status", { status, ...(reason ? { reason } : {}) });
    await persist();
    if (active === owner) active = undefined;
  }
  async function monitorNative(owner: Owner) {
    const run = owner.run;
    const session = meta.sessions.find(s => s.sessionId === run.sessionId)!;
    const snapshots = new Map<string, string>();
    for (const event of events.get(run.runId) ?? []) if (event.kind === "message") {
      const data = event.data as { messageId: string }; snapshots.set(data.messageId, JSON.stringify(data));
    }
    let lastError = "";
    while (!closing && !storageFailed && run.status === "running") {
      try {
        const snapshot = await oc.snapshot(session.nativeSessionId!, run.nativeCommandId!);
        if (closing || storageFailed) break;
        for (const message of snapshot.messages) {
          const normalized = normalizeMessage(message); if (!normalized) continue;
          const encoded = JSON.stringify(normalized);
          if (snapshots.get(normalized.messageId) !== encoded) { await emit(run, "message", normalized); snapshots.set(normalized.messageId, encoded); }
        }
        if (lastError && (snapshot.messages.length || snapshot.pending)) { await emit(run, "status", { status: "running", connection: "connected", reason: "Native state reconnected" }); lastError = ""; }
        if (snapshot.outcome && ["succeeded", "failed", "interrupted"].includes(snapshot.outcome)) {
          await finishNative(owner, snapshot.outcome === "succeeded" ? "completed" : snapshot.outcome as Status); break;
        }
        if (!snapshot.messages.length && !snapshot.pending && run.nativePhase === "sending" && !lastError) {
          lastError = "Prompt acceptance remains unconfirmed; reconnecting to native history without resending";
          await emit(run, "status", { status: "running", connection: "unconfirmed", reason: lastError });
        }
      } catch (error) {
        if (storageFailed || closing) break;
        const reason = error instanceof Error ? error.message : "Native reconciliation unavailable";
        if (lastError !== reason) { await emit(run, "status", { status: "running", connection: "unavailable", reason }); lastError = reason; }
      }
      await Bun.sleep(1000);
    }
  }
  async function executeNative(owner: Owner, prompt: string, ready: (accepted: boolean) => void) {
    const run = owner.run; const session = meta.sessions.find(s => s.sessionId === run.sessionId)!;
    try {
      await emit(run, "status", { status: "running" });
      await emit(run, "submission", { messageId: run.nativeCommandId, text: prompt });
      await persist();
      if (closing) { await finishNative(owner, "failed", "Bridge closed before native submission"); ready(false); return; }
      await oc.select(session.nativeSessionId!, run.model, run.effort);
      if (closing) { await finishNative(owner, "failed", "Bridge closed before native submission"); ready(false); return; }
      run.nativePhase = "sending"; await persist();
      // Native command ID is durable before the request. A timeout is ambiguous:
      // keep the global slot and reconcile, never send a duplicate automatically.
      ready(true);
      try {
        const admitted = await oc.prompt(session.nativeSessionId!, run.nativeCommandId!, prompt);
        run.nativePhase = "accepted"; run.nativeAcceptedAt = admitted.time.created; await persist();
      } catch (error) {
        if (error instanceof OpenCodeError && [400, 401, 403, 404, 409].includes(error.status)) {
          await finishNative(owner, "failed", error.message); return;
        }
        await emit(run, "status", { status: "running", connection: "unconfirmed", reason: error instanceof Error ? error.message : "Native submission unconfirmed" });
      }
      await monitorNative(owner);
    } catch (error) {
      ready(false);
      if (storageFailed) return;
      if (run.nativePhase === "preparing") await finishNative(owner, "failed", error instanceof Error ? error.message : "Native preparation failed");
      else throw error;
    } finally { ready(false); }
  }
  // Native execution survives this bridge. Recover only the catalog's own run.
  const recovering = meta.runs.find(r => r.status === "running" && meta.sessions.find(s => s.sessionId === r.sessionId)?.harness === "opencode");
  if (recovering) {
    const finished = Promise.withResolvers<void>();
    const owner: Owner = { run: recovering, native: true, done: finished.promise, settled: false }; active = owner;
    void (recovering.nativePhase === "preparing" ? finishNative(owner, "failed", "Bridge restarted before native submission") : monitorNative(owner))
      .catch(() => { failClosed(); }).finally(() => { owner.settled = true; finished.resolve(); });
  }
  async function handle(req: Request, srv: Pick<Bun.Server<undefined>, "requestIP" | "port">, upgrade?: (req: Request, data: TerminalSocketData) => boolean): Promise<Response | undefined> {
    try {
      const url = new URL(req.url); const path = url.pathname;
      if (path.startsWith("/hooks/")) {
        if (req.method !== "POST" || !loopback(srv.requestIP(req)?.address ?? "")) return json({ error: "Forbidden" }, 403);
        const event = decodeURIComponent(path.slice(7)); if (!(hookEvents as readonly string[]).includes(event)) return json({ error: "Unknown hook" }, 400);
        const input = await body(req); const run = meta.runs.find(r => r.runId === input.runId); const secret = secrets.get(input.runId);
        if (!run || !secret || !equal(req.headers.get("x-cc-web-secret") ?? "", secret)) return json({ error: "Forbidden" }, 403);
        const payload = input.payload;
        if (!payload || typeof payload !== "object" || payload.hook_event_name !== event || payload.session_id !== run.sessionId) return json({ error: "Hook association mismatch" }, 400);
        await emit(run, "hook", { event, payload }); return json({ ok: true });
      }
      const expected = new URL(origin);
      // A same-machine HTTPS proxy may preserve the public Host or rewrite it
      // to its loopback upstream. Trust only the configured origin or this
      // listener's concrete loopback authorities, never forwarded headers.
      const host = req.headers.get("host");
      const loopbackProxy = !!options.publicOrigin && !remote && loopback(srv.requestIP(req)?.address ?? "") &&
        [`localhost:${srv.port}`, `127.0.0.1:${srv.port}`, `[::1]:${srv.port}`].includes(host ?? "");
      if (host !== expected.host && !loopbackProxy) return json({ error: "Host rejected" }, 403);
      if (!["GET", "HEAD"].includes(req.method) && req.headers.get("origin") !== origin) return json({ error: "Origin rejected" }, 403);
      if (path === "/api/config" && req.method === "GET") {
        const signedIn = authenticated(req);
        return json({ authRequired: !!password, authenticated: signedIn, cwd: signedIn ? options.cwd : null, oneShot: true, ...(signedIn ? { capabilities: { concurrency: { scope: "bridge", limit: 1 }, cancelRun: true, midRunInput: false, permissionReplies: true, attachments: false, modelSelection: true, effortValues: efforts, terminal: terminals.capability }, harnesses: [
          { id: "claude-code", name: "Claude Code", available: true, connected: true, state: "available", capabilities: { cancelRun: false, permissionReplies: false, questionReplies: false, modelSelection: true, effortValues: efforts } },
          { id: "opencode", name: "OpenCode", ...await oc.connection(options.cwd), capabilities: { cancelRun: true, permissionReplies: true, questionReplies: true, modelSelection: true } },
        ] } : {}) });
      }
      if (path === "/api/login" && req.method === "POST") { const input = await body(req); if (password && (typeof input.password !== "string" || !equal(input.password, password))) return json({ error: "Invalid password" }, 401); const token = crypto.randomUUID(); cookies.add(token); return json({ authenticated: true }, 200, { "set-cookie": `cc_web=${token}; HttpOnly; SameSite=Strict; Path=/${expected.protocol === "https:" ? "; Secure" : ""}` }); }
      if (path === "/api/logout" && req.method === "POST") {
        for (const s of (req.headers.get("cookie") ?? "").split(";")) { const [k,v] = s.trim().split("="); if (k === "cc_web" && v) { cookies.delete(v); terminals.revoke(v); } }
        if (!password) { const old = localTerminalToken; localTerminalToken = crypto.randomUUID(); terminals.revoke(old); }
        return json({ authenticated: false }, 200, { "set-cookie": "cc_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      }
      if (path.startsWith("/api/") && !authenticated(req)) return json({ error: "Authentication required" }, 401);
      const terminalMatch = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/terminal(?:\/(socket|close|restart))?$/.exec(path);
      if (terminalMatch) {
        const workspaceId = decodeURIComponent(terminalMatch[1]!), worktreeId = decodeURIComponent(terminalMatch[2]!), operation = terminalMatch[3];
        // No query-string credentials or mutable cwd/directory overrides.
        if (url.search) return json({ error: "Terminal routes do not accept query parameters", code: "terminal-query" }, 400);
        if (operation === "socket") {
          if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
          if (req.headers.get("origin") !== origin) return json({ error: "Origin rejected" }, 403);
          if (!upgrade || req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "WebSocket upgrade required" }, 426);
          const token = terminalToken(req);
          if (!token) return json({ error: "Authentication required" }, 401);
          const data = await terminals.prepare(workspaceId, worktreeId, token);
          if (closing || terminalToken(req) !== token) { terminals.cancelUpgrade(data); return json({ error: "Attachment authorization changed" }, 401); }
          try { if (upgrade(req, data)) return undefined; } catch { terminals.cancelUpgrade(data); return json({ error: "WebSocket upgrade failed" }, 400); }
          terminals.cancelUpgrade(data); return json({ error: "WebSocket upgrade failed" }, 400);
        }
        if (!operation && req.method === "GET") {
          const token = terminalToken(req), state = await terminals.get(workspaceId, worktreeId);
          if (!token || terminalToken(req) !== token) return json({ error: "Authentication revoked" }, 401);
          return json(state);
        }
        if (req.method === "POST") {
          const token = terminalToken(req), input = await body(req);
          return json(await terminals.change(workspaceId, worktreeId, operation === "close" ? "close" : operation === "restart" ? "restart" : "start", input, () => !closing && !!token && terminalToken(req) === token));
        }
        return json({ error: "Method not allowed" }, 405);
      }
      if (path === "/api/navigation") {
        if (req.method === "GET") return json(catalog.getNavigation());
        if (req.method === "PUT") return json(await catalog.putNavigation(await body(req)));
        return json({ error: "Method not allowed" }, 405);
      }
      if (path === "/api/workspaces") {
        if (req.method === "GET") return json(await catalog.list());
        if (req.method === "POST") { const input = await body(req); return json(await catalog.register(input?.cwd), 201); }
        return json({ error: "Method not allowed" }, 405);
      }
      const catalogMatch = /^\/api\/workspaces\/([^/]+)(?:\/worktrees\/([^/]+)(?:\/(list|file|git|diff))?)?$/.exec(path);
      if (catalogMatch) {
        try {
          const workspaceId = decodeURIComponent(catalogMatch[1]!), worktreeId = catalogMatch[2] && decodeURIComponent(catalogMatch[2]), operation = catalogMatch[3];
          if (!worktreeId && req.method === "GET") return json(await catalog.get(workspaceId));
          const key = `${workspaceId}/${worktreeId}`, revision = url.searchParams.get("workspaceId") ?? url.searchParams.get("bindingRevision"), filePath = url.searchParams.get("path") ?? "";
          if (!operation && worktreeId && req.method === "GET") { const resolved = await worktrees.resolve(key); return json({ ...resolved, catalogWorkspaceId: workspaceId, worktreeId, bindingRevision: resolved.workspaceId }); }
          if (operation === "list" && req.method === "GET") return json(await worktrees.list(key, revision, filePath));
          if (operation === "file" && req.method === "GET") return json(await worktrees.file(key, revision, filePath));
          if (operation === "file" && req.method === "PUT") { const input = await body(req); return json(await worktrees.write(key, { ...input, workspaceId: input?.bindingRevision ?? input?.workspaceId })); }
          if (operation === "git" && req.method === "GET") return json(await worktrees.status(key, revision));
          if (operation === "diff" && req.method === "GET") return json(await worktrees.diff(key, revision, filePath, url.searchParams.get("comparison") ?? ""));
          return json({ error: "Method not allowed" }, 405);
        } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
      }
      const workspaceMatch = /^\/api\/sessions\/([^/]+)\/workspace(?:\/(list|file|git|diff))?$/.exec(path);
      if (workspaceMatch) {
        try {
          const sessionId = decodeURIComponent(workspaceMatch[1]!);
          const operation = workspaceMatch[2], workspaceId = url.searchParams.get("workspaceId"), filePath = url.searchParams.get("path") ?? "";
          if (!operation && req.method === "GET") return json(await workspace.resolve(sessionId));
          if (operation === "list" && req.method === "GET") return json(await workspace.list(sessionId, workspaceId, filePath));
          if (operation === "file" && req.method === "GET") return json(await workspace.file(sessionId, workspaceId, filePath));
          if (operation === "file" && req.method === "PUT") return json(await workspace.write(sessionId, await body(req)));
          if (operation === "git" && req.method === "GET") return json(await workspace.status(sessionId, workspaceId));
          if (operation === "diff" && req.method === "GET") return json(await workspace.diff(sessionId, workspaceId, filePath, url.searchParams.get("comparison") ?? ""));
          return json({ error: "Method not allowed", code: "method-not-allowed" }, 405);
        } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
      }
      if (path === "/api/harnesses/opencode/models" && req.method === "GET") {
        const cwd = resolve(url.searchParams.get("cwd") ?? options.cwd);
        return json({ models: await oc.models(cwd) });
      }
      if (path === "/api/sessions" && req.method === "GET") return json({ sessions: meta.sessions.map(s => ({ ...s, ...catalog.association(s.sessionId) })), availability: availability() });
      if (path === "/api/sessions" && req.method === "POST") {
        const input = await body(req);
        if (!input || typeof input.prompt !== "string" || !input.prompt.trim() || (input.cwd !== undefined && typeof input.cwd !== "string") || (input.sessionId !== undefined && typeof input.sessionId !== "string")) return json({ error: "Invalid request" }, 400);
        let session = input.sessionId ? meta.sessions.find(s => s.sessionId === input.sessionId) : undefined;
        if (input.sessionId !== undefined && !session) return json({ error: "Unknown session" }, 404);
        const harness = input.harness ?? session?.harness ?? "claude-code";
        if (!["claude-code", "opencode"].includes(harness)) return json({ error: "Unknown harness" }, 400);
        if (session && (session.harness ?? "claude-code") !== harness) return json({ error: "Session harness cannot change" }, 400);
        if (input.model !== undefined && !validModel(input.model)) return json({ error: "Invalid model ID" }, 400);
        if (input.effort !== undefined && !(harness === "opencode" ? validVariant(input.effort) : validEffort(input.effort))) return json({ error: harness === "opencode" ? "Invalid native variant ID" : "effort must be low, medium, high, xhigh, or max" }, 400);
        if (harness === "opencode" && input.model !== undefined) oc.model(input.model, input.effort);
        if (harness === "opencode" && !session && input.effort !== undefined && input.model === undefined) return json({ error: "Select a model before selecting a variant" }, 400);
        const selectedBinding = !session && input.cwd === undefined && typeof input.workspaceId === "string" && typeof input.worktreeId === "string" ? await catalog.binding(input.workspaceId, input.worktreeId) : undefined;
        const cwd = resolve(input.cwd ?? session?.cwd ?? selectedBinding?.cwd ?? options.cwd);
        try { if (!(await stat(cwd)).isDirectory()) throw 0; } catch { return json({ error: "cwd must be an existing directory" }, 400); }
        if (session && session.cwd !== cwd) return json({ error: "Session cwd cannot change" }, 400);
        const conversationId = session?.sessionId ?? crypto.randomUUID();
        const association = await catalog.associate(conversationId, cwd, input.workspaceId, input.worktreeId);
        const available = availability();
        if (!available.canSend) return json({ error: available.reason }, 409);
        const run: Run = { runId: crypto.randomUUID(), sessionId: conversationId, cwd, status: "running", createdAt: new Date().toISOString(), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}) };
        const finished = Promise.withResolvers<void>();
        const accepted = Promise.withResolvers<boolean>();
        const owner: Owner = { run, native: harness === "opencode", done: finished.promise, settled: false };
        active = owner;
        const resume = !!session;
        if (harness === "opencode") {
          run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`; run.nativePhase = "preparing";
          try {
            // Reserve the bridge-wide slot before any network work.
            if (!session) {
              const native = await oc.create(cwd, input.model, input.effort);
              session = { sessionId: run.sessionId, harness, nativeSessionId: native.id, cwd, lastStatus: "running", lastRunId: run.runId }; meta.sessions.push(session);
            }
          } catch (error) { if (active === owner) active = undefined; owner.settled = true; finished.resolve(); throw error; }
        }
        if (!session) { session = { sessionId: run.sessionId, harness: "claude-code", nativeSessionId: run.sessionId, cwd, lastStatus: "running", lastRunId: run.runId }; meta.sessions.push(session); }
        session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
        // Install the complete lifecycle promise before any asynchronous work.
        void (harness === "opencode" ? executeNative(owner, input.prompt, accepted.resolve) : execute(owner, input.prompt, resume, accepted.resolve)).catch(async () => {
          failClosed(); await terminate(owner); accepted.resolve(false);
        }).finally(() => { owner.settled = true; finished.resolve(); });
        if (!(await accepted.promise)) return json({ error: "Run could not start; operator reconciliation may be required" }, 503);
        return json({ sessionId: run.sessionId, runId: run.runId, harness, nativeSessionId: session.nativeSessionId, ...association }, 202);
      }
      const interactionMatch = /^\/api\/sessions\/([^/]+)\/interactions(?:\/([^/]+)\/reply)?$/.exec(path);
      const cancelMatch = /^\/api\/sessions\/([^/]+)\/cancel$/.exec(path);
      if (interactionMatch || cancelMatch) {
        const session = meta.sessions.find(s => s.sessionId === (interactionMatch ?? cancelMatch)![1]);
        if (!session) return json({ error: "Unknown session" }, 404);
        if (session.harness !== "opencode") return interactionMatch && req.method === "GET" ? json({ interactions: [] }) : json({ error: "Claude Code one-shot mode does not support this operation" }, 501);
        if (cancelMatch && req.method === "POST") {
          if (active?.run.sessionId !== session.sessionId) return json({ error: "Session has no active app run" }, 409);
          return json(await oc.cancel(session.nativeSessionId!));
        }
        if (interactionMatch && !interactionMatch[2] && req.method === "GET") return json({ interactions: await oc.interactions(session.nativeSessionId!) });
        if (interactionMatch?.[2] && req.method === "POST") { await oc.reply(session.nativeSessionId!, decodeURIComponent(interactionMatch[2]), await body(req)); return json({ ok: true }); }
        return json({ error: "Method not allowed" }, 405);
      }
      const runsMatch = /^\/api\/sessions\/([^/]+)\/runs$/.exec(path);
      if (runsMatch && req.method === "GET") { if (!meta.sessions.some(s => s.sessionId === runsMatch[1])) return json({ error: "Unknown session" }, 404); return json({ runs: meta.runs.filter(r => r.sessionId === runsMatch[1]) }); }
      const eventMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
      if (eventMatch && req.method === "GET") { const run = meta.runs.find(r => r.runId === eventMatch[1]); if (!run) return json({ error: "Unknown run" }, 404); const after = Number(url.searchParams.get("after") ?? 0); if (!Number.isSafeInteger(after) || after < 0) return json({ error: "Invalid cursor" }, 400); const list = events.get(run.runId)!.filter(e => e.seq > after); return json({ events: list, nextCursor: list.at(-1)?.seq ?? after, status: run.status }); }
      if (/^\/api\/(?:runs|sessions)\/[^/]+\/input$/.test(path) && req.method === "POST") return json({ error: "One-shot mode does not support interactive input" }, 501);
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
      let file: string;
      if (path === "/") file = join(root, "public", "index.html");
      else {
        let assetPath: string;
        try { assetPath = decodeURIComponent(path); } catch { return json({ error: "Not found" }, 404); }
        if (!assetPath.startsWith("/assets/") || assetPath.includes("\\") || assetPath.includes("\0") || assetPath.split("/").slice(2).some(part => !part || part.startsWith("."))) return json({ error: "Not found" }, 404);
        const assetsRoot = join(root, "public", "assets");
        file = resolve(assetsRoot, assetPath.slice("/assets/".length));
        if (!file.startsWith(assetsRoot + "/")) return json({ error: "Not found" }, 404);
        try {
          const canonicalRoot = await realpath(assetsRoot);
          file = await realpath(file);
          if (!file.startsWith(canonicalRoot + "/")) return json({ error: "Not found" }, 404);
        } catch { return json({ error: "Not found" }, 404); }
      }
      try { if (!(await stat(file)).isFile()) return json({ error: "Not found" }, 404); }
      catch { return json({ error: "Not found" }, 404); }
      const asset = Bun.file(file);
      return new Response(req.method === "HEAD" ? null : asset, { headers: { "content-type": asset.type, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    } catch (error) { return error instanceof WorkspaceError ? json({ error: error.message, code: error.code }, error.status) : error instanceof OpenCodeError ? json({ error: error.message }, [400, 404, 409].includes(error.status) ? error.status : 503) : json({ error: "Invalid request" }, 400); }
  }
  const server = Bun.serve<TerminalSocketData>({ hostname: options.host, port: options.port, maxRequestBodySize: 1024 * 1024, websocket: terminals.websocket, fetch: (req, srv) => handle(req, srv, (request, data) => srv.upgrade(request, { data })) });
  let hookServer: Bun.Server<undefined>;
  try { hookServer = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024 * 1024, fetch: (req, srv) => new URL(req.url).pathname.startsWith("/hooks/") ? handle(req, srv) : json({ error: "Not found" }, 404) }); }
  catch (error) { await server.stop(true); throw error; }
  origin = options.publicOrigin ?? `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${server.port}`;
  let closePromise: Promise<void> | undefined;
  return { origin, port: server.port, close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
    await terminals.close();
    const owner = active;
    if (owner?.native) {
      // Let any outstanding bounded HTTP request finish before releasing local
      // storage ownership. This waits for the adapter, never for native work.
      const detached = await Promise.race([owner.done.then(() => true), Bun.sleep(12000).then(() => false)]);
      if (!detached) retainOwner = true;
    }
    if (owner && !owner.native) {
      // execute checks closing after every prelaunch await; no future spawn is
      // possible even if preparation outlives this bounded shutdown.
      if (owner.child) await terminate(owner);
      const done = await Promise.race([owner.done.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!done || (owner.child && groupAlive(owner))) { retainOwner = true; meta.reconciliationRequired = true; }
    }
    if (retainOwner && !storageFailed) {
      // Best effort only: owner.lock remains if storage is broken or blocked.
      await Promise.race([persist().catch(() => { failClosed(); }), Bun.sleep(500)]);
    }
    const flushed = await Promise.race([serial.then(() => true), Bun.sleep(500).then(() => false)]);
    if (!flushed) retainOwner = true;
    await server.stop(true); await hookServer.stop(true);
    await catalog.flush();
    if (!retainOwner) await rm(lockPath, { force: true });
    })();
    return closePromise;
  } };
  } catch (error) { if (!retainOwner) await rm(lockPath, { force: true }); throw error; }
}
