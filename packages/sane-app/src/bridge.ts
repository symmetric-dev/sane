import { readFile, writeFile, rename, appendFile, stat, readdir, realpath } from "node:fs/promises";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { resolveAppConfig } from "./app-config";
import { buildAssets, validateAssets } from "./asset-build";
import { acquireInstallation, acquireData, validateOwnershipPaths, type OwnershipHandle } from "./installation-ownership";
import { claudeSourceRoot } from "./claude-source";
import { decodeLog, validModel, validEffort, validVariant, uuid, efforts, type Status, type Session, type Run, type Event, type Metadata } from "./history";
import { OpenCodeAdapter, OpenCodeError, normalizeMessage } from "./opencode";
import { WorkspaceService, WorkspaceError, workspaceError } from "./workspace";
import { CatalogService } from "./catalog";
import { TerminalService, type TerminalSocketData } from "./terminal";
import { RepositoryRouter, WorkstreamAdapterError, authenticatedWorkstreamRoute, validateWorkstreamInput, flushAndCloseWorkstreams } from "./workstreams";
import { validateAppStore, assertSourceConfiguration, atomicAppRecord, type SourceConfiguration } from "./app-store";
import { AdmissionService } from "./admission";
import { HandoffService, handoffRecipientTitle, projectHandoffEnqueue, projectHandoffStatus, slotSessionIndex } from "./handoff";
import { DomainError } from "sane-core/server";
import { readClaudeHistory, coveredNativeRuns, type ReconciledHistory } from "./reconcile";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const hookEvents = ["SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse", "PermissionRequest", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "CwdChanged"] as const;
export type Options = { host: string; port: number; cwd: string; dataDir: string; claudeBin: string; nativeSources: SourceConfiguration; allowRemote: boolean; publicOrigin?: string; reconcileInterrupted: boolean; maxConcurrentRuns?: number; packageDir?: string; noBuild?: boolean };
export function parseOptions(args: string[]): Options {
  return runtimeOptions(resolveAppConfig(args, { packageDir: root, invocationCwd: process.cwd() }));
}
export function runtimeOptions(resolved: ReturnType<typeof resolveAppConfig>): Options {
  const { config: c, operational } = resolved;
  return { host: c.server.host, port: c.server.port, cwd: c.defaultExecutionCwd, dataDir: c.dataDir,
    claudeBin: c.native.claude.executable, allowRemote: c.server.allowRemote, publicOrigin: c.server.publicOrigin ?? undefined,
    maxConcurrentRuns: c.maxConcurrentRuns, reconcileInterrupted: operational.reconcileInterrupted, noBuild: operational.noBuild,
    nativeSources: { cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: c.native.claude.profileRoot },
      oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: c.native.opencode.registrationFile } } };
}
export function startupSummary(o: Options): string {
  return ["SANE App startup configuration:", `  Invocation cwd: ${process.cwd()}`, `  Default execution cwd: ${o.cwd}`, `  App data: ${o.dataDir}`,
    `  Native mode: Claude executable ${o.claudeBin}; configured managed OpenCode registration`,
    `  Listener: ${o.host}:${o.port}; public origin: ${o.publicOrigin ?? "listener origin"}`,
    "  Workstreams: explicit per-workspace inspect/init; no implicit project initialization",
  ].join("\n");
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
  const paths = validateOwnershipPaths(options.packageDir ?? root, options.dataDir);
  const installation = acquireInstallation(paths, { phase: "starting", reconcileInterrupted: options.reconcileInterrupted });
  let data: OwnershipHandle | undefined;
  let bridge: Awaited<ReturnType<typeof startOwned>> | undefined;
  const retain = () => { try { data?.retain(); } finally { installation.retain(); } };
  const release = () => { data?.release(); installation.release(); };
  try {
    data = acquireData(installation, { phase: "starting", reconcileInterrupted: options.reconcileInterrupted });
    options = { ...options, dataDir: paths.dataDir! };
    assertSourceConfiguration(validateAppStore(options.dataDir).sources, options.nativeSources);
    installation.update("build");
    const assets = options.noBuild ? validateAssets({ packageDir: paths.packageDir }) : await buildAssets({ packageDir: paths.packageDir, ownership: installation });
    installation.update("starting");
    bridge = await startOwned(options, assets.assetsDir, paths.packageDir, retain);
    const listener = { host: options.host, port: bridge.port! };
    installation.update("serving", listener); data.update("serving", listener);
    const running = bridge;
    let closing: Promise<void> | undefined;
    return { origin: running.origin, port: running.port, close() {
      return closing ??= (async () => {
        try { installation.update("draining"); data!.update("draining"); await running.close(); }
        catch (error) { retain(); throw error; }
        release();
      })();
    } };
  } catch (error) {
    if (bridge) { try { await bridge.close(); } catch { retain(); } }
    release(); throw error;
  }
}
async function startOwned(options: Options, assetsDir: string, packageDir: string, retainOwnership: () => void) {
  const indexHtml = await readFile(join(packageDir, "public", "index.html"), "utf8");
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 16;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 256) throw new Error("max-concurrent-runs must be an integer from 1 to 256");
  const store = validateAppStore(options.dataDir);
  assertSourceConfiguration(store.sources, options.nativeSources);
  if (options.nativeSources.cc.harness !== "cc" || options.nativeSources.oc.harness !== "oc") throw new Error("Invalid configured native harnesses");
  const claudeRoot = options.nativeSources.cc.profileRoot;
  if (process.env.CLAUDE_CONFIG_DIR !== undefined && claudeSourceRoot() !== claudeRoot) throw new Error("Contradictory native selector: CLAUDE_CONFIG_DIR");
  if (process.env.CLAUDE_CODE_PROJECT_DIR_NAME) throw new Error("Unsupported native selector: CLAUDE_CODE_PROJECT_DIR_NAME");
  const oc = new OpenCodeAdapter(undefined, undefined, options.nativeSources.oc.registrationFile);
  const nativeSource = (harness?: string) => store.sources[harness === "opencode" ? "oc" : "cc"].authorityId ?? "unavailable";
  const forbidden = Object.keys(process.env).filter(k => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_CUSTOM_MODEL_OPTION|AWS_BEARER_TOKEN_BEDROCK|OPENAI_API_KEY|OPENAI_BASE_URL)/.test(k));
  if (forbidden.length) throw new Error(`Remove API/provider overrides: ${forbidden.join(", ")}`);
  try { if (!(await stat(options.cwd)).isDirectory()) throw new Error(); }
  catch { throw new Error(`Execution cwd must be an existing directory: ${options.cwd}. Set --cwd to the intended checkout.`); }
  const remote = !loopback(options.host); const password = process.env.SANE_APP_PASSWORD;
  if (options.publicOrigin && !loopback(new URL(options.publicOrigin).hostname) && !password) throw new Error("A non-loopback public origin requires SANE_APP_PASSWORD");
  if (remote && (!options.allowRemote || !password || !options.publicOrigin)) throw new Error("Remote host requires --allow-remote, SANE_APP_PASSWORD and --public-origin https://...");
  if (options.publicOrigin) { const u = new URL(options.publicOrigin); if ((u.protocol !== "https:" && !(u.protocol === "http:" && loopback(u.hostname) && !remote)) || u.origin !== options.publicOrigin || u.username || u.password) throw new Error("public-origin must be an exact HTTPS origin (or HTTP loopback origin for a local SSH forward)"); }
  let retainOwner = false;
  let router: RepositoryRouter | undefined;
  try {
  const metadataPath = join(options.dataDir, "metadata.json");
  const meta: Metadata = store.metadata;
  const catalog = new CatalogService(options.dataDir, () => meta.sessions);
  for (const session of meta.sessions) if (session.attachment && session.attachment.source !== nativeSource(session.harness)) throw new Error("Attached native authority source changed; restore the original native store/service configuration");
  await catalog.load();
  // Artifacts are readable only through the domain API, even when its state is
  // outside App data. Use a canonical root for both ordinary Code entry points.
  router = new RepositoryRouter(catalog, store.sources);
  const admissions = new AdmissionService(options.dataDir, store.admissions, store.sources, catalog, router);
  const execution = async (sessionId: string) => { const a = admissions.get(sessionId); if (!a) throw new WorkstreamAdapterError(409, "admission-missing", "Conversation has no durable admission"); return router!.execution(a); };
  const domainProtectedPaths: string[] = [];
  const workspace = new WorkspaceService(async id => {
    const session = meta.sessions.find(session => session.sessionId === id);
    if (!session) return undefined;
    const a = catalog.association(id);
    if (a.association === "unresolved") throw new WorkspaceError(409, "association-unresolved", "Conversation workspace is unresolved; historical logs remain available");
    const binding = await catalog.binding(a.workspaceId, a.worktreeId);
    if ((await catalog.discover(session.cwd)).root !== binding.cwd) throw new WorkspaceError(409, "cwd-worktree-mismatch", "Conversation cwd binding changed");
    return { cwd: session.cwd, protectedPaths: [...binding.protectedPaths, ...domainProtectedPaths] };
  }, options.dataDir);
  const worktrees = new WorkspaceService(async key => {
    const [workspaceId, worktreeId] = key.split("/");
    const binding = await catalog.binding(workspaceId!, worktreeId!);
    return { ...binding, protectedPaths: [...binding.protectedPaths, ...domainProtectedPaths] };
  }, options.dataDir);
  const events = new Map<string, Event[]>();
  const secrets = new Map<string, string>();
  type Owner = { run: Run; native?: boolean; child?: Bun.Subprocess<"pipe", "pipe", "pipe">; done: Promise<void>; settled: boolean; stopping?: Promise<boolean>; cancel?: Promise<{ interrupted: boolean }>; cancelling?: boolean; stopRequested?: boolean; submission?: Promise<unknown> };
  // Durable validation forbids aliases for a qualified native ID. New IDs are
  // reserved before awaits, then retained until the selected owner's lifecycle ends.
  const owners = new Map<string, Owner>();
  const admitting = new Set<string>();
  const attaching = new Set<string>();
  const attachmentTasks = new Set<Promise<void>>();
  const handoffReservations = new Set<string>();
  const handoffAcknowledgements = new Set<string>();
  const handoffDispatches = new Map<string, Promise<void>>();
  function releaseOwner(owner: Owner) {
    // A delayed native interrupt must finish before a replacement can acquire
    // this conversation, even if terminal observation arrived first.
    if (!retainOwner && owner.settled && !owner.cancelling && owners.get(owner.run.sessionId) === owner) owners.delete(owner.run.sessionId);
  }
  let closing = false, storageFailed = false;
  const handoffs = new HandoffService(admissions, catalog, router, store.sources, () => meta.sessions, () => {
    if (closing || storageFailed || meta.reconciliationRequired) throw new WorkstreamAdapterError(503, "handoff-owner-unavailable", "App execution owner is unavailable");
  }, store.manifest.storeId);
  const handoffToken = crypto.randomUUID();
  async function nativeHandoff(req: Request) {
    if (req.method !== "POST" || req.headers.has("origin") || !equal(req.headers.get("authorization") ?? "", `Bearer ${handoffToken}`)) return json({ error: "Native authorization required" }, 401);
    try {
      if (closing || storageFailed || meta.reconciliationRequired) return json({ error: "App execution owner unavailable" }, 503);
      const input = await body(req);
      if (input?.operation === "enqueue") return json({ handoff: projectHandoffEnqueue(await handoffs.enqueue(input.caller, input.input)) }, 202);
      if (input?.operation === "status") { const handoff = await handoffs.status(input.caller, input.requestId); return json({ handoff: handoff ? projectHandoffStatus(handoff) : handoff, ...(handoff && handoffProblems.has(handoff.id) ? { problem: handoffProblems.get(handoff.id) } : {}) }); }
      return json({ error: "Unknown handoff operation" }, 400);
    } catch (error) { return error instanceof DomainError || error instanceof WorkstreamAdapterError ? json({ error: error.message, code: error.code }, error instanceof WorkstreamAdapterError ? error.status : error.code === "INVALID_INPUT" ? 400 : 409) : json({ error: "Handoff admission unavailable" }, 503); }
  }
  async function prepareHandoffRecipient(workspaceId: string, handoffId: string) {
    // Only the createNew path below runs `create`; reply/attach deliveries
    // (already-bound recipients) never reach it, so only handoff-created
    // sessions get auto-titles and existing sessions are never renamed.
    let created = false;
    const handoff = await handoffs.prepareRecipient(workspaceId, handoffId, async h => {
      created = true;
      const sessionId = h.recipient.sessionId, cwd = h.recipient.checkout.path, harness = h.recipient.harness === "oc" ? "opencode" : "claude-code";
      if (closing || storageFailed || admitting.has(sessionId) || owners.has(sessionId)) throw new WorkstreamAdapterError(409, "recipient-unavailable", "Recipient admission unavailable");
      admitting.add(sessionId);
      try {
        let a = admissions.get(sessionId);
        if (!a) {
          const association = await catalog.register(cwd);
          a = await admissions.begin({ sessionId, operation: "create", harness: h.recipient.harness, cwd, nativeId: harness === "opencode" ? null : crypto.randomUUID(), workspaceId: association.workspaceId, worktreeId: association.worktreeId });
        }
        if (a.source.authorityId !== h.recipient.authorityId || a.binding.executionCheckout !== cwd || a.binding.domain.mode !== "repository" || a.binding.domain.repositoryId !== h.repositoryId) throw new WorkstreamAdapterError(409, "recipient-mismatch", "Reserved recipient binding changed");
        if (closing || storageFailed) throw new WorkstreamAdapterError(503, "recipient-unavailable", "App execution owner unavailable");
        if (a.state === "intent") a = await admissions.createNative(sessionId, async () => (await oc.create(cwd)).id);
        if (!a.nativeId || a.state === "native_creation_unknown") throw new WorkstreamAdapterError(409, "native_creation_unknown", "Reconcile recipient creation before retry");
        if (!meta.sessions.some(s => s.sessionId === sessionId)) {
          meta.sessions.push({ sessionId, nativeSessionId: a.nativeId, harness, authorityId: a.source.authorityId, cwd, lastStatus: "unknown", lastRunId: null });
          await persist();
        }
        await catalog.associate(sessionId, cwd, a.binding.workspaceId, a.binding.worktreeId);
        await admissions.register(sessionId);
        if (a.state !== "ready") admissions.ready(sessionId);
      } finally { admitting.delete(sessionId); }
    });
    if (created) {
      // Title the new recipient `<Role> #<n>` (legacy counting, minus the
      // `[workstream]` prefix): n is the 1-based position among this
      // workstream's assignments for the same phase, oldest first, counting
      // ended assignments. Untitled-only: a retried preparation never renames.
      const session = meta.sessions.find(s => s.sessionId === handoff.recipient.sessionId);
      if (session && !session.title && handoff.recipient.ref) {
        const ref = handoff.recipient.ref;
        const status = (await router!.forWorkspace(workspaceId)).domain.getWorkstreamStatus(handoff.workstreamId);
        const assignment = status.activePhases.find(a => a.phase === handoff.input.to && a.ref.harness === ref.harness && a.ref.authorityId === ref.authorityId && a.ref.nativeId === ref.nativeId);
        session.title = handoffRecipientTitle(handoff.input.to, slotSessionIndex([...status.phaseHistory, ...status.activePhases], handoff.input.to, assignment?.id ?? ""));
        await persist();
      }
    }
    return handoff;
  }
  function availability(sessionId?: string, capacity = true, delivery = false, preparation = false): { canSend: boolean; reason?: string; code?: string } {
    if (storageFailed) return { canSend: false, reason: "Storage unavailable; operator reconciliation required" };
    if (meta.reconciliationRequired) return { canSend: false, reason: "Operator reconciliation required: restart with --reconcile-interrupted after verifying previous CLI processes are stopped" };
    if (closing) return { canSend: false, reason: "Bridge is shutting down" };
    if (sessionId && !delivery && (handoffReservations.has(sessionId) || handoffDispatches.has(sessionId))) return { canSend: false, reason: "Recipient has an active or uncertain handoff", code: "handoff-pending" };
    const admission = sessionId ? admissions.get(sessionId) : undefined;
    if (admission && admission.state !== "ready" && !(preparation && admission.state === "identity_known" && admission.nativeId)) return { canSend: false, reason: "Admission pending; explicit known-identity retry is required", code: "admission-pending" };
    if (sessionId && meta.sessions.find(s => s.sessionId === sessionId)?.attachment?.state === "pending") return { canSend: false, reason: "Attachment incomplete. Retry Attach with the same harness, native ID and execution directory; no run is permitted.", code: "attachment-pending" };
    if (sessionId && (owners.has(sessionId) || admitting.has(sessionId))) return { canSend: false, reason: "This conversation already has an active run or reconciliation", code: "conversation-busy" };
    const occupied = new Set([...owners.keys(), ...admitting, ...handoffDispatches.keys()]);
    if (capacity && !(delivery && sessionId && handoffDispatches.has(sessionId)) && occupied.size >= maxConcurrentRuns) return { canSend: false, reason: `Bridge capacity reached (${maxConcurrentRuns} concurrent runs/requests); retry when a slot is free`, code: "capacity" };
    return { canSend: true };
  }
  let serial = Promise.resolve();
  function persist() {
    // Capture at enqueue time. A later concurrent admission must not leak into
    // an earlier metadata write before its first log record reaches the queue.
    const snapshot = JSON.stringify(meta);
    return enqueue(async () => { await writeFile(`${metadataPath}.tmp`, snapshot, { mode: 0o600 }); await rename(`${metadataPath}.tmp`, metadataPath); });
  }
  function failClosed() {
    storageFailed = true; retainOwner = true; meta.reconciliationRequired = true;
    // Ownership records are the durable sentinel even if every later disk
    // write fails. Reopening requires process exit and explicit reconciliation.
    for (const owner of owners.values()) if (owner.child) void terminate(owner);
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
  // Display title for list responses: stored title wins (handoff `<Role> #<n>`
  // or a previously persisted first prompt). Otherwise derive from the
  // earliest submission event so a refresh shows names without opening each
  // conversation. Never persists here; POST persists for new prompts.
  const titleFromPrompt = (prompt: unknown): string | undefined => {
    if (typeof prompt !== "string") return undefined;
    const line = prompt.split("\n")[0]!.trim().slice(0, 200);
    return line ? line : undefined;
  };
  const displayTitle = (session: Session): string | undefined => {
    if (session.title) return session.title;
    const runs = meta.runs.filter(r => r.sessionId === session.sessionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const run of runs) {
      for (const event of events.get(run.runId) ?? []) {
        if (event.kind !== "submission") continue;
        const title = titleFromPrompt((event.data as { text?: unknown })?.text);
        if (title) return title;
      }
    }
    return undefined;
  };
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
    for (const item of (req.headers.get("cookie") ?? "").split(";")) { const [key, value] = item.trim().split("="); if (key === "sane_app" && value && cookies.has(value)) return value; }
    return password ? undefined : localTerminalToken;
  };
  const terminals = new TerminalService(catalog, token => cookies.has(token) || !password && token === localTerminalToken);
  let origin = "";
  const authenticated = (req: Request) => !password || (req.headers.get("cookie") ?? "").split(";").some(s => { const [k, v] = s.trim().split("="); return k === "sane_app" && !!v && cookies.has(v); });
  async function consume(run: Run, nativeSessionId: string, stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr", result: { seen: boolean; error: boolean; diagnostic?: string }) {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let pending = "";
    async function line(text: string) {
      if (!text) return;
      let data: any = text;
      if (kind === "stdout") {
        try { data = JSON.parse(text); } catch {}
        if ((data?.type === "system" && data.subtype === "init") || data?.type === "result") {
          if (data.session_id !== nativeSessionId) { result.error = true; result.diagnostic = "CLI session identity mismatch or missing session_id"; }
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
      if (closing) throw new Error("Closing before launch");
      const session = meta.sessions.find(s => s.sessionId === run.sessionId)!;
      run.cwd = await execution(session.sessionId);
      const secret = crypto.randomUUID() + crypto.randomUUID(); secrets.set(run.runId, secret);
      const hooks = Object.fromEntries(hookEvents.map(event => [event, [{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(join(root, "hooks/forward.ts"))} ${quote(event)}`, timeout: 3 }] }]]));
      const settingsPath = join(options.dataDir, `${run.runId}.settings.json`);
      await enqueue(() => writeFile(settingsPath, JSON.stringify({ hooks }), { mode: 0o600 }));
      if (closing || storageFailed || owner.stopRequested) throw new Error("Closing before launch");
      const args = [options.claudeBin, "-p", "--output-format", "stream-json", "--verbose", resume ? "--resume" : "--session-id", session.nativeSessionId!, "--settings", settingsPath];
      if (run.model !== undefined) args.push("--model", run.model);
      if (run.effort !== undefined) args.push("--effort", run.effort);
      // Do not carry the launching shell's bridge credentials or SANE/native
      // session context into a fresh app-owned invocation. Native HOME/hooks stay shared.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !/^(CC_WEB_|OPENCODE_SERVER_|OPENCODE_SESSION_ID$|OPENCODE_TOKEN$|SANE_|BUN_INSPECT|NODE_OPTIONS$)/i.test(name))) as Record<string, string>;
      run.cwd = await execution(session.sessionId);
      const child = Bun.spawn(args, {
        cwd: run.cwd, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...env, CLAUDE_CONFIG_DIR: claudeRoot, CLAUDE_CODE_PROJECT_DIR_NAME: "", CC_WEB_HOOK_URL: `http://127.0.0.1:${hookServer.port}`, CC_WEB_RUN_ID: run.runId, CC_WEB_HOOK_SECRET: secret },
      });
      owner.child = child;
      ready(true);
      streams = [consume(run, session.nativeSessionId!, child.stdout, "stdout", result), consume(run, session.nativeSessionId!, child.stderr, "stderr", result)];
      // Observe both consumers immediately, including the loser on rejection.
      const output = Promise.all([child.exited, ...streams]);
      // Attach the observer before writing, since a synchronous stdin failure
      // must not leave an independently rejecting stream promise behind.
      void output.catch(() => {});
      child.stdin.write(prompt);
      const [exit] = await Promise.all([output.then(values => values[0] as number), child.stdin.end()]);
      if (groupAlive(owner) && !(await terminate(owner))) throw new Error("Process group termination unconfirmed");
      run.status = closing || owner.stopRequested ? "interrupted" : !storageFailed && exit === 0 && result.seen && !result.error ? "completed" : "failed";
      run.endedAt = new Date().toISOString(); meta.sessions.find(s => s.sessionId === run.sessionId)!.lastStatus = run.status;
      await emit(run, "status", { status: run.status, exitCode: exit, resultSeen: result.seen, ...(result.diagnostic ? { reason: result.diagnostic } : {}) });
    } catch {
      ready(false);
      const stopped = await terminate(owner);
      run.status = stopped && (closing || owner.stopRequested) ? "interrupted" : "failed";
      run.endedAt = new Date().toISOString(); meta.sessions.find(s => s.sessionId === run.sessionId)!.lastStatus = run.status;
      try { await emit(run, "status", { status: run.status, reason: !stopped ? "Process termination unconfirmed; operator reconciliation required" : storageFailed ? "Storage failure; operator reconciliation required" : "CLI launch, stream, or shutdown failure" }); } catch { failClosed(); }
    } finally {
      ready(false);
      // Consumers can still be unwinding after a failure. Do not free the slot
      // until both finish; a timeout keeps the ownership sentinel in place.
      const drained = await Promise.race([Promise.allSettled(streams).then(() => true), Bun.sleep(2200).then(() => false)]);
      if (!drained) { retainOwner = true; meta.reconciliationRequired = true; }
      run.endedAt = new Date().toISOString(); meta.sessions.find(s => s.sessionId === run.sessionId)!.lastStatus = run.status;
      try { await persist(); } catch { failClosed(); }
       secrets.delete(run.runId);
    }
  }
  async function finishNative(owner: Owner, status: Status, reason?: string) {
    owner.run.status = status; owner.run.endedAt = new Date().toISOString();
    meta.sessions.find(s => s.sessionId === owner.run.sessionId)!.lastStatus = status;
    await emit(owner.run, "status", { status, ...(reason ? { reason } : {}) });
    await persist();
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
        const snapshot = await oc.snapshot(session.nativeSessionId!, run.nativeCommandId!, session.cwd);
        if (closing || storageFailed) break;
        if (run.nativePhase !== "accepted" && (snapshot.pending || snapshot.messages.some(m => m.id === run.nativeCommandId))) { run.nativePhase = "accepted"; await persist(); }
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
  async function executeNative(owner: Owner, prompt: string, resume: boolean, ready: (accepted: boolean) => void) {
    const run = owner.run; const session = meta.sessions.find(s => s.sessionId === run.sessionId)!;
    let promptAttempted = false;
    try {
      await emit(run, "status", { status: "running" });
      await emit(run, "submission", { messageId: run.nativeCommandId, text: prompt });
      await persist();
      if (closing || owner.stopRequested) { await finishNative(owner, "interrupted", "Stopped before native submission"); ready(false); return; }
      run.cwd = await execution(session.sessionId);
      await oc.assertIdle(session.nativeSessionId!, run.cwd);
      await oc.select(session.nativeSessionId!, run.model, run.effort);
      if (closing || owner.stopRequested) { await finishNative(owner, "interrupted", "Stopped before native submission"); ready(false); return; }
      run.nativePhase = "sending"; await persist();
      if (closing || storageFailed || owner.stopRequested) throw new Error("Bridge unavailable before native submission");
      run.cwd = await execution(session.sessionId);
      // Native command ID is durable before the request. A timeout is ambiguous:
       // keep this conversation's slot and reconcile, never replay automatically.
      ready(true);
      try {
        promptAttempted = true;
        const submission = oc.prompt(session.nativeSessionId!, run.nativeCommandId!, prompt);
        owner.submission = submission;
        const admitted = await submission;
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
      if (!promptAttempted) await finishNative(owner, owner.stopRequested ? "interrupted" : "failed", error instanceof Error ? error.message : "Native preparation failed");
      else throw error;
    } finally { ready(false); }
  }
  const handoffProblems = new Map<string, string>();
  async function reconcileHandoff(workspaceId: string, id: string) {
    const domain = (await router!.forWorkspace(workspaceId)).domain;
    let h = domain.getHandoff(id);
    if (h.recipient.ownerId !== store.manifest.storeId || !h.runId || ["queued", "completed", "failed"].includes(h.status)) return h;
    const run = meta.runs.find(r => r.runId === h.runId && r.sessionId === h.recipient.sessionId);
    if (!run) return h;
    const records = events.get(run.runId) ?? [];
    const accepted = h.recipient.harness === "oc" ? run.nativeCommandId === h.nativeCommandId && run.nativePhase === "accepted" : records.some(e => e.kind === "stdout" && (e.data as any)?.session_id === h.recipient.ref?.nativeId && ((e.data as any)?.type === "result" || (e.data as any)?.type === "system" && (e.data as any)?.subtype === "init"));
    const advance = (status: typeof h.status, evidence: string) => { h = domain.advanceHandoff(h.id, h.revision, { status, evidence }, { actor: { kind: "system" }, correlationId: h.id }); };
    if (h.status === "acceptance_unknown" && accepted) advance("accepted", `Native acceptance recorded in App run ${run.runId}`);
    const executing = h.recipient.harness === "cc" ? accepted : records.some(e => e.kind === "message" && (e.data as any)?.role === "assistant");
    if (h.status === "accepted" && run.status === "running" && executing) advance("running", `Native execution observed in App run ${run.runId}`);
    if (run.status === "completed" && accepted) advance("completed", `Correlated native terminal success in App run ${run.runId}`);
    else if (run.status === "failed") advance("failed", `Terminal failure recorded in App run ${run.runId}`);
    else if (run.status === "interrupted" && h.recipient.harness === "oc") advance("failed", `Native interruption recorded in App run ${run.runId}`);
    else if (run.status === "interrupted") handoffProblems.set(h.id, "Execution interrupted; inspect native state and acknowledge termination with the handoff reconcile endpoint");
    if (["completed", "failed"].includes(h.status)) handoffReservations.delete(h.recipient.sessionId);
    return h;
  }
  async function dispatchHandoff(workspaceId: string, id: string) {
    let h = (await router!.forWorkspace(workspaceId)).domain.getHandoff(id);
    if (!availability(h.recipient.sessionId, true, true, true).canSend || handoffReservations.has(h.recipient.sessionId)) return;
    h = await prepareHandoffRecipient(workspaceId, id);
    const session = meta.sessions.find(s => s.sessionId === h.recipient.sessionId)!;
    if (session.attachment && session.harness !== "opencode" && !handoffAcknowledgements.has(h.id)) throw new WorkstreamAdapterError(409, "native-acknowledgement-required", "Confirm external Claude execution is stopped with the handoff acknowledge endpoint before delivery");
    if (!availability(session.sessionId, true, true).canSend || handoffReservations.has(session.sessionId)) return;
    admitting.add(session.sessionId);
    try {
      const cwd = await execution(session.sessionId);
      if (session.harness === "opencode") await oc.assertIdle(session.nativeSessionId!, cwd);
      if (closing || storageFailed || meta.reconciliationRequired) return;
      const domain = (await router!.forWorkspace(workspaceId)).domain;
      const recipientContext = domain.resolveContext(h.recipient.ref!);
      const senderSlots = domain.getStatus(h.workstreamId).activePhases.filter(a => a.ref.harness === h.sender.harness && a.ref.authorityId === h.sender.authorityId && a.ref.nativeId === h.sender.nativeId).map(a => a.phase);
      const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd, status: "running", createdAt: new Date().toISOString() };
      const commandId = session.harness === "opencode" ? `msg_${crypto.randomUUID().replaceAll("-", "")}` : `${run.runId}:user`;
      h = domain.advanceHandoff(h.id, h.revision, { status: "acceptance_unknown", attemptId: crypto.randomUUID(), nativeCommandId: commandId, runId: run.runId }, { actor: { kind: "system" }, correlationId: h.id });
      handoffReservations.add(session.sessionId);
      if (process.env.SANE_TEST_FAULT === "handoff-drop-run") {
        // Test-only crash simulation (C9): the handoff row above is persisted
        // as acceptance_unknown, but the App run below is never persisted or
        // submitted — matching a crash on the persistence/submission boundary.
        // The explicit retry endpoint then proves nonacceptance without
        // resending. Never active unless explicitly gated.
        return;
      }
      handoffAcknowledgements.delete(h.id);
      const resume = !!session.lastRunId || !!session.attachment;
      if (session.harness === "opencode") { run.nativeCommandId = commandId; run.nativePhase = "preparing"; }
      const finished = Promise.withResolvers<void>();
      const owner: Owner = { run, native: session.harness === "opencode", done: finished.promise, settled: false };
      owners.set(session.sessionId, owner);
      session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
      const prompt = [`SANE handoff ${h.id}`, `Repository: ${domain.primaryCheckout}`, `Workstream: ${h.workstreamId}`, `Artifacts: ${recipientContext.artifactsRoot}`, `Destination: ${h.input.to}`, `From: ${JSON.stringify(h.sender)}`, `Sender slots: ${JSON.stringify(senderSlots)}`, `Recipient: ${JSON.stringify(h.recipient.ref)}`, `Execution checkout: ${cwd}`, h.input.createNew ? "Begin pickup for the assigned role using repository context and the references below." : "Continue this conversation using the request and references below.", "This delivery does not approve artifacts or lifecycle changes. Work independently; any reply is a separate optional asynchronous handoff to the qualified sender. Do not wait for a reply after sending.", "", h.input.message].join("\n");
      void (owner.native ? executeNative(owner, prompt, resume, () => {}) : execute(owner, prompt, resume, () => {})).catch(async () => { failClosed(); await terminate(owner); }).finally(async () => {
        try { if (!storageFailed) await reconcileHandoff(workspaceId, h.id); } catch { failClosed(); }
        owner.settled = true; releaseOwner(owner); finished.resolve();
      });
      handoffProblems.delete(h.id);
    } finally { admitting.delete(session.sessionId); }
  }
  let handoffTask: Promise<void> | undefined;
  async function consumeHandoffs() {
    for (const w of (await catalog.list()).workspaces.filter(w => w.kind === "repository")) {
      if (closing || storageFailed) return;
      let deliveries;
      try { deliveries = await handoffs.list(w.workspaceId); } catch { continue; }
      for (const h of deliveries.filter(h => h.recipient.ownerId === store.manifest.storeId && !["queued", "completed", "failed"].includes(h.status))) handoffReservations.add(h.recipient.sessionId);
      for (const h of deliveries.filter(h => h.recipient.ownerId === store.manifest.storeId && !["completed", "failed"].includes(h.status))) {
        if (closing || storageFailed) return;
        try {
          if (h.status === "queued") {
            const sessionId = h.recipient.sessionId;
            if (handoffDispatches.has(sessionId) || handoffReservations.has(sessionId) || !availability(sessionId, true, true, true).canSend) continue;
            const task = Promise.resolve().then(() => dispatchHandoff(w.workspaceId, h.id))
              .catch(error => { handoffProblems.set(h.id, error instanceof Error ? error.message : "Handoff execution unavailable"); })
              .finally(() => { handoffDispatches.delete(sessionId); });
            handoffDispatches.set(sessionId, task);
          } else await reconcileHandoff(w.workspaceId, h.id);
        }
        catch (error) { handoffProblems.set(h.id, error instanceof Error ? error.message : "Handoff execution unavailable"); }
      }
    }
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
        const session = meta.sessions.find(s => s.sessionId === run.sessionId);
        if (!session?.nativeSessionId || session.harness !== "claude-code" || !payload || typeof payload !== "object" || payload.hook_event_name !== event || payload.session_id !== session.nativeSessionId) return json({ error: "Hook association mismatch" }, 400);
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
        return json({ authRequired: !!password, authenticated: signedIn, cwd: signedIn ? options.cwd : null, oneShot: true, ...(signedIn ? { capabilities: { concurrency: { scope: "conversation", limit: maxConcurrentRuns, perConversation: 1, sharedCheckoutWrites: true }, cancelRun: true, midRunInput: false, permissionReplies: true, attachments: false, modelSelection: true, effortValues: efforts, terminal: terminals.capability }, harnesses: [
          { id: "claude-code", name: "Claude Code", available: true, connected: true, state: "available", capabilities: { cancelRun: true, permissionReplies: false, questionReplies: false, modelSelection: true, effortValues: efforts } },
          { id: "opencode", name: "OpenCode", ...await oc.connection(options.cwd), capabilities: { cancelRun: true, permissionReplies: true, questionReplies: true, modelSelection: true } },
        ] } : {}) });
      }
      if (path === "/api/login" && req.method === "POST") { const input = await body(req); if (password && (typeof input.password !== "string" || !equal(input.password, password))) return json({ error: "Invalid password" }, 401); const token = crypto.randomUUID(); cookies.add(token); return json({ authenticated: true }, 200, { "set-cookie": `sane_app=${token}; HttpOnly; SameSite=Strict; Path=/${expected.protocol === "https:" ? "; Secure" : ""}` }); }
      if (path === "/api/logout" && req.method === "POST") {
        for (const s of (req.headers.get("cookie") ?? "").split(";")) { const [k,v] = s.trim().split("="); if (k === "sane_app" && v) { cookies.delete(v); terminals.revoke(v); } }
        if (!password) { const old = localTerminalToken; localTerminalToken = crypto.randomUUID(); terminals.revoke(old); }
        return json({ authenticated: false }, 200, { "set-cookie": "sane_app=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
      }
      if (path.startsWith("/api/") && !authenticated(req)) return json({ error: "Authentication required" }, 401);
      if (path === "/api/handoffs" && req.method === "GET") { const listed = await handoffs.list(url.searchParams.get("workspaceId") ?? ""); return json({ handoffs: listed, problems: Object.fromEntries(listed.filter(h => handoffProblems.has(h.id)).map(h => [h.id, handoffProblems.get(h.id)])) }); }
      const handoffAction = /^\/api\/handoffs\/([^/]+)\/(retry|acknowledge|reconcile)$/.exec(path);
      if (handoffAction && req.method === "POST") {
        const input = await body(req), domain = (await router!.forWorkspace(input.workspaceId)).domain;
        const h = await reconcileHandoff(input.workspaceId, handoffAction[1]!);
        if (h.recipient.ownerId !== store.manifest.storeId) return json({ error: "Handoff belongs to another App store" }, 409);
        if (handoffAction[2] === "reconcile") {
          const run = meta.runs.find(r => r.runId === h.runId && r.sessionId === h.recipient.sessionId);
          if (h.recipient.harness !== "cc" || !run || run.status !== "interrupted" || !["acceptance_unknown", "accepted", "running"].includes(h.status) || input.nativeStopped !== true || owners.has(h.recipient.sessionId) || !availability(undefined, false).canSend) return json({ error: "Interrupted Claude run, reconciled App ownership, and explicit nativeStopped acknowledgement required" }, 409);
          const result = domain.advanceHandoff(h.id, h.revision, { status: "failed", evidence: `Operator confirmed interrupted Claude run ${run.runId} stopped; delivery outcome not claimed successful` }, { actor: { kind: "system" }, correlationId: h.id });
          handoffReservations.delete(h.recipient.sessionId); handoffProblems.delete(h.id);
          return json({ handoff: result });
        }
        if (handoffAction[2] === "acknowledge") {
          if (h.status !== "queued" || input.nativeStopped !== true) return json({ error: "Queued delivery and explicit nativeStopped acknowledgement required" }, 409);
          handoffAcknowledgements.add(h.id);
          return json({ handoff: h }, 202);
        }
        if (h.status !== "acceptance_unknown" || !h.runId || meta.runs.some(r => r.runId === h.runId) || owners.has(h.recipient.sessionId) || admitting.has(h.recipient.sessionId) || !availability(undefined, false).canSend) return json({ error: "Nonacceptance is not proven; reconcile the original native run without resending" }, 409);
        const retried = domain.advanceHandoff(h.id, h.revision, { status: "queued", retry: true, evidence: `App ${store.manifest.storeId} has no persisted run ${h.runId}; execution requires persisted run metadata before native submission` }, { actor: { kind: "system" }, correlationId: h.id });
        handoffReservations.delete(h.recipient.sessionId);
        return json({ handoff: retried }, 202);
      }
      if (path === "/api/workstreams" || path.startsWith("/api/workstreams/")) {
        // Host/Origin checks above have already accepted this exact request.
        return await authenticatedWorkstreamRoute(req, request => authenticated(request) ? null : json({ error: "Authentication required" }, 401), async () => {
          const workspaceId = url.searchParams.get("workspaceId");
          if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
          if (path === "/api/workstreams/inspect" && req.method === "GET") return router!.inspect(workspaceId);
          if (path === "/api/workstreams/init" && req.method === "POST") return router!.initialize(workspaceId);
          const workstreams = await router!.forWorkspace(workspaceId);
          if (path === "/api/workstreams/overview" && req.method === "GET") {
            if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
            return workstreams.overview(meta.sessions.filter(s => catalog.association(s.sessionId).workspaceId === workspaceId));
          }
          if (path === "/api/workstreams" && req.method === "GET") return workstreams.list();
          const operation = path.slice("/api/workstreams/".length);
          if (req.method === "GET" && operation === "status") return workstreams.status(url.searchParams.get("id") ?? "");
          if (req.method !== "POST") throw new WorkstreamAdapterError(405, "method-not-allowed", "Method not allowed");
          const input = await body(req);
          if (operation === "artifacts/write") throw new WorkstreamAdapterError(405, "read-only-artifacts", "App workstream artifacts are read-only");
          if (operation === "manage") {
            if (!workspaceId) throw new WorkstreamAdapterError(400, "workspace-required", "Select a repository workspace");
            if (!input || !["associate", "phase/assign", "phase/end"].includes(input.operation)) throw new WorkstreamAdapterError(400, "invalid-request", "Unknown management action");
            validateWorkstreamInput(input.operation, { ...input, sessionId: "qualified-native-reference" });
            const target = input.ref && workstreams.appSessionId(input.ref, meta.sessions);
            const available = availability(target || undefined, false);
            if (!available.canSend) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason!);
            return workstreams.manage(input.ref, input.operation, input);
          }
          validateWorkstreamInput(path === "/api/workstreams" ? "create" : operation, input);
           if (path === "/api/workstreams") return workstreams.create({ id: input.id, title: input.title, type: input.type, defaultCheckout: input.defaultCheckout });
          if (operation === "default-checkout") return workstreams.setDefaultCheckout(input.id, input.checkout);
          if (operation === "target") return workstreams.resolveTarget(input.id, input.phase, input.target);
          if (operation === "artifacts/list") return workstreams.listArtifacts(input.id);
          if (operation === "artifacts/read") return { content: workstreams.readArtifact(input.id, input.path) };
          if (!["conversation", "associate", "phase/assign", "phase/end", "context"].includes(operation)) throw new WorkstreamAdapterError(404, "not-found", "Unknown workstream operation");
          const session = meta.sessions.find(s => s.sessionId === input.sessionId);
          if (!session) throw new WorkstreamAdapterError(404, "not-found", "Unknown App conversation");
          const admission = admissions.get(session.sessionId);
          if (!admission || admission.binding.workspaceId !== workspaceId) throw new WorkstreamAdapterError(409, "repository-mismatch", "Conversation belongs to another workspace");
          await router!.forAdmission(admission, workspaceId);
          if (operation === "conversation") return workstreams.conversation(session);
          if (operation === "context") return workstreams.invocation(session);
          const available = availability(session.sessionId, false);
          if (!available.canSend) throw new WorkstreamAdapterError(409, "bridge-busy", available.reason!);
          if (operation === "associate") return workstreams.associate(session, input.workstreamId);
          if (operation === "phase/assign") return workstreams.assignPhase(session, input.phase);
          return workstreams.endPhase(session, input.assignmentId);
        });
      }
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
      const aliasMatch = /^\/api\/workspaces\/([^/]+)\/worktrees\/([^/]+)\/alias$/.exec(path);
      if (aliasMatch) {
        try {
          if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405);
          const workspaceId = decodeURIComponent(aliasMatch[1]!), worktreeId = decodeURIComponent(aliasMatch[2]!);
          const input = await body(req);
          return json({ workspace: await catalog.setAlias(workspaceId, worktreeId, input?.alias ?? null) });
        } catch (error) { const failure = workspaceError(error); return json({ error: failure.message, code: failure.code }, failure.status); }
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
      if (path === "/api/sessions" && req.method === "GET") return json({ sessions: meta.sessions.map(s => ({ ...s, title: displayTitle(s), admission: admissions.get(s.sessionId), ...catalog.association(s.sessionId), availability: availability(s.sessionId) })), admissions: admissions.list(), availability: availability() });
      const admissionRoute = /^\/api\/sessions\/([^/]+)\/(enroll|retry-admission)$/.exec(path);
      if (admissionRoute && req.method === "POST") {
        const sessionId = admissionRoute[1]!, session = meta.sessions.find(s => s.sessionId === sessionId);
        if (!session) return json({ error: "Unknown conversation" }, 404);
        if (closing || storageFailed || owners.has(sessionId) || admitting.has(sessionId)) return json({ error: "Conversation unavailable" }, 409);
        admitting.add(sessionId);
        try {
          if (admissionRoute[2] === "enroll") await admissions.enroll(sessionId);
          const pending = admissions.get(sessionId)!;
          // Do not confuse uncertain creation with same-known-identity retry.
          if (!pending.nativeId) return json({ error: "Native creation identity is unknown; operator inspection required", code: "native_creation_unknown" }, 409);
          if (session.harness === "opencode") await oc.assertIdle(pending.nativeId, pending.binding.executionCheckout);
          else if (!(await readClaudeHistory(pending.nativeId, pending.binding.executionCheckout, claudeRoot)).length && pending.operation !== "create") return json({ error: "Native history unavailable" }, 409);
          await admissions.register(sessionId); await persist(); admissions.ready(sessionId);
          return json({ admission: admissions.get(sessionId) });
        } finally { admitting.delete(sessionId); }
      }
      if (path === "/api/sessions/attach" && req.method === "POST") {
        const input = await body(req);
        const harness = input?.harness, nativeSessionId = input?.nativeSessionId, cwd = input?.cwd;
        if (!["claude-code", "opencode"].includes(harness) || (harness === "claude-code" ? !uuid(nativeSessionId) : typeof nativeSessionId !== "string" || !/^ses[a-zA-Z0-9_-]{1,200}$/.test(nativeSessionId)) || typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return json({ error: "Provide harness, valid native session ID and absolute execution directory" }, 400);
        const key = `${harness}:${nativeSessionId}`;
        let session = meta.sessions.find(s => (s.harness ?? "claude-code") === harness && (s.nativeSessionId ?? s.sessionId) === nativeSessionId);
        if (session && session.attachment?.state !== "pending") return json({ error: "Native conversation is already attached", sessionId: session.sessionId }, 409);
        if (session && session.cwd !== cwd) return json({ error: "Attachment execution directory cannot change" }, 409);
        if (attaching.has(key)) return json({ error: "Attachment is already in progress" }, 409);
        const available = availability();
        if (!available.canSend) return json({ error: available.reason }, available.code === "capacity" ? 429 : 409);
        const sessionId = session?.sessionId ?? crypto.randomUUID();
        if (meta.sessions.some(s => s.sessionId === sessionId && s !== session)) return json({ error: "App session identity collision" }, 409);
        attaching.add(key); admitting.add(sessionId);
        const attachmentDone = Promise.withResolvers<void>(); attachmentTasks.add(attachmentDone.promise);
        try {
          if (await realpath(cwd) !== cwd) throw new OpenCodeError("Use the canonical native execution directory", 409);
          const discovered = await catalog.discover(cwd);
          if (discovered.root !== cwd || !discovered.commonDir) throw new OpenCodeError("Attachment requires the actual repository checkout root", 409);
          if (input.workspaceId !== undefined || input.worktreeId !== undefined) {
            if (typeof input.workspaceId !== "string" || typeof input.worktreeId !== "string" || (await catalog.binding(input.workspaceId, input.worktreeId)).cwd !== cwd) throw new OpenCodeError("Selected worktree differs from native execution directory", 409);
          }
          const catalogSelection = await catalog.register(cwd);
          if (!admissions.get(sessionId)) await admissions.begin({ sessionId, operation: "attach", harness: harness === "opencode" ? "oc" : "cc", nativeId: nativeSessionId, cwd, workspaceId: catalogSelection.workspaceId, worktreeId: catalogSelection.worktreeId });
          const candidate: Session = session ?? { sessionId, nativeSessionId, authorityId: nativeSource(harness), harness, cwd, lastStatus: "unknown", lastRunId: null, attachment: { state: "pending", source: nativeSource(harness) } };
          const native = harness === "opencode" ? await oc.history(nativeSessionId, cwd) : { messages: await readClaudeHistory(nativeSessionId, cwd, claudeRoot), activity: "unknown" as const };
          if (!native.messages.length) throw new OpenCodeError("Native transcript is empty; nothing attached", 409);
          if (native.activity === "active") throw new OpenCodeError("Native conversation is active or has pending input; finish it in OpenCode before attaching", 409);
          if (closing || storageFailed) throw new OpenCodeError("Bridge unavailable", 503);
          // Durable intent precedes cross-store registration. A crash/failure leaves
          // a visible, non-executable pending row; explicit same-identity retry only.
          if (!session) { session = candidate; meta.sessions.push(session); }
          session.attachment = { state: "pending", source: nativeSource(harness) }; await persist();
          const history: ReconciledHistory = { sessionId, nativeSessionId, importedAt: new Date().toISOString(), ...native, coveredRunIds: [], reason: harness === "opencode" ? "Attached read-only native snapshot; activity is a point-in-time observation. Reconcile after external work." : "Attached read-only Claude transcript; active execution and run outcome are unknown. Confirm external Claude is stopped before each App submission." };
          const historyPath = join(options.dataDir, `${sessionId}.native-history.json`);
          await enqueue(async () => { await writeFile(`${historyPath}.tmp`, JSON.stringify(history), { mode: 0o600 }); await rename(`${historyPath}.tmp`, historyPath); });
          const association = await catalog.associate(sessionId, cwd, input.workspaceId, input.worktreeId);
          if (closing || storageFailed) throw new OpenCodeError("Attachment interrupted by shutdown; retry explicitly", 503);
          await admissions.register(sessionId);
          session.attachment = { state: "ready", source: nativeSource(harness) }; await persist();
          admissions.ready(sessionId);
          return json({ sessionId, nativeSessionId, harness, ...association, history }, 201);
        } catch (error) {
          if (session?.attachment) { session.attachment = { ...session.attachment, state: "pending", error: error instanceof Error ? error.message : "Attachment failed" }; if (!storageFailed) await persist().catch(() => {}); }
          return json({ error: error instanceof Error ? error.message : "Attachment unavailable", ...(session ? { sessionId, attachment: "pending", recovery: "Retry Attach with the same identity and cwd after resolving the error. No prompt was sent." } : {}) }, error instanceof OpenCodeError || error instanceof WorkstreamAdapterError || error instanceof WorkspaceError ? error.status : error instanceof DomainError && error.code !== "STORAGE_ERROR" ? 409 : 503);
        } finally { attaching.delete(key); admitting.delete(sessionId); attachmentDone.resolve(); attachmentTasks.delete(attachmentDone.promise); }
      }
      if (path === "/api/sessions" && req.method === "POST") {
        const input = await body(req);
        if (!input || typeof input.prompt !== "string" || !input.prompt.trim() || (input.cwd !== undefined && typeof input.cwd !== "string") || (input.sessionId !== undefined && typeof input.sessionId !== "string")) return json({ error: "Invalid request" }, 400);
        let session = input.sessionId ? meta.sessions.find(s => s.sessionId === input.sessionId) : undefined;
        if (input.sessionId !== undefined && !session) return json({ error: "Unknown session" }, 404);
        const harness = input.harness ?? session?.harness ?? "claude-code";
        if (!["claude-code", "opencode"].includes(harness)) return json({ error: "Unknown harness" }, 400);
        if (session && (session.harness ?? "claude-code") !== harness) return json({ error: "Session harness cannot change" }, 400);
        if (session?.attachment && harness === "claude-code" && input.nativeStopped !== true) return json({ error: "Claude activity is unknown. Explicitly acknowledge external execution is stopped before each App submission.", code: "native-acknowledgement-required" }, 409);
        if (input.model !== undefined && !validModel(input.model)) return json({ error: "Invalid model ID" }, 400);
        if (input.effort !== undefined && !(harness === "opencode" ? validVariant(input.effort) : validEffort(input.effort))) return json({ error: harness === "opencode" ? "Invalid native variant ID" : "effort must be low, medium, high, xhigh, or max" }, 400);
        if (harness === "opencode" && input.model !== undefined) oc.model(input.model, input.effort);
        if (harness === "opencode" && !session && input.effort !== undefined && input.model === undefined) return json({ error: "Select a model before selecting a variant" }, 400);
        // Conversation-level defaults: an omitted follow-up inherits the stored
        // selection instead of silently dropping to native default. Stored values
        // were validated when first sent, so only shape-check an inherited OC model.
        const model = input.model ?? session?.model;
        const effort = input.effort ?? session?.effort;
        if (harness === "opencode" && input.model === undefined && model !== undefined) oc.model(model, effort);
        const selectedBinding = !session && input.cwd === undefined && typeof input.workspaceId === "string" && typeof input.worktreeId === "string" ? await catalog.binding(input.workspaceId, input.worktreeId) : undefined;
        const cwd = resolve(input.cwd ?? session?.cwd ?? selectedBinding?.cwd ?? options.cwd);
        try { if (!(await stat(cwd)).isDirectory()) throw 0; } catch { return json({ error: "cwd must be an existing directory" }, 400); }
        if (session && session.cwd !== cwd) return json({ error: "Session cwd cannot change" }, 400);
        const conversationId = session?.sessionId ?? crypto.randomUUID();
        const available = availability(conversationId);
        if (!available.canSend) return json({ error: available.reason, code: available.code }, available.code === "capacity" ? 429 : 409);
        admitting.add(conversationId);
        try {
        if (session) await execution(session.sessionId);
        const association = await catalog.associate(conversationId, cwd, input.workspaceId, input.worktreeId);
        const resume = !!session;
        if (!session) {
          if (association.association !== "resolved") throw new WorkstreamAdapterError(409, "association-unresolved", "Execution association unavailable");
          await admissions.begin({ sessionId: conversationId, operation: "create", harness: harness === "opencode" ? "oc" : "cc", cwd, nativeId: harness === "opencode" ? null : crypto.randomUUID(), workspaceId: association.workspaceId, worktreeId: association.worktreeId });
          if (harness === "opencode") await admissions.createNative(conversationId, async () => (await oc.create(cwd, input.model, input.effort)).id);
          const a = admissions.get(conversationId)!;
          session = { sessionId: conversationId, harness, nativeSessionId: a.nativeId!, authorityId: a.source.authorityId, cwd, lastStatus: "unknown", lastRunId: null, ...(input.model !== undefined ? { model: input.model } : {}), ...(input.effort !== undefined ? { effort: input.effort } : {}) };
          meta.sessions.push(session); await persist();
          await admissions.register(conversationId);
          admissions.ready(conversationId);
        }
        if (session?.harness === "opencode") await oc.assertIdle(session.nativeSessionId!, cwd);
        if (closing || storageFailed || meta.reconciliationRequired) return json({ error: "Bridge unavailable" }, 409);
        // Update stored defaults on every send carrying them; an omitted
        // follow-up never erases them (the run below inherits them instead).
        if (input.model !== undefined) session.model = input.model;
        if (input.effort !== undefined) session.effort = input.effort;
        // First prompt becomes the durable list title for untitled sessions
        // (handoff `<Role> #<n>` titles already set stay untouched).
        if (!session.title) {
          const firstTitle = titleFromPrompt(input.prompt);
          if (firstTitle) { session.title = firstTitle; await persist(); }
        }
        const run: Run = { runId: crypto.randomUUID(), sessionId: conversationId, cwd, status: "running", createdAt: new Date().toISOString(), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
        const finished = Promise.withResolvers<void>();
        const accepted = Promise.withResolvers<boolean>();
        const owner: Owner = { run, native: harness === "opencode", done: finished.promise, settled: false };
        owners.set(conversationId, owner);
        if (harness === "opencode") {
          run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`; run.nativePhase = "preparing";
        }
        session.lastRunId = run.runId; session.lastStatus = "running"; meta.runs.push(run); events.set(run.runId, []);
        // Install the complete lifecycle promise before any asynchronous work.
        void (harness === "opencode" ? executeNative(owner, input.prompt, resume, accepted.resolve) : execute(owner, input.prompt, resume, accepted.resolve)).catch(async () => {
          failClosed(); await terminate(owner); accepted.resolve(false);
        }).finally(() => { owner.settled = true; releaseOwner(owner); finished.resolve(); });
        if (!(await accepted.promise)) return json({ error: "Run could not start; operator reconciliation may be required" }, 503);
        return json({ sessionId: run.sessionId, runId: run.runId, harness, nativeSessionId: session.nativeSessionId, ...association }, 202);
        } finally { admitting.delete(conversationId); }
      }
      const reconciliation = /^\/api\/sessions\/([^/]+)\/(reconcile|native-history)$/.exec(path);
      if (reconciliation) {
        const session = meta.sessions.find(s => s.sessionId === reconciliation[1]);
        if (!session) return json({ error: "Unknown session" }, 404);
        const historyPath = join(options.dataDir, `${session.sessionId}.native-history.json`);
        if (reconciliation[2] === "native-history" && req.method === "GET") {
          try { return json({ history: JSON.parse(await readFile(historyPath, "utf8")) }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return json({ history: null }); throw error; }
        }
        if (reconciliation[2] !== "reconcile" || req.method !== "POST") return json({ error: "Method not allowed" }, 405);
        const available = availability(session.sessionId);
        if (!available.canSend) return json({ error: available.reason }, available.code === "capacity" ? 429 : 409);
        admitting.add(session.sessionId);
        try {
          await execution(session.sessionId);
          const nativeSessionId = session.nativeSessionId ?? session.sessionId;
          const native = session.harness === "opencode" ? await oc.history(nativeSessionId, session.cwd) : { messages: await readClaudeHistory(nativeSessionId, session.cwd, claudeRoot), activity: "unknown" as const };
          if (!native.messages.length) return json({ error: "Native transcript is empty; previous history preserved" }, 409);
          if (closing || storageFailed) return json({ error: "Bridge unavailable" }, 503);
          const history: ReconciledHistory = { sessionId: session.sessionId, nativeSessionId, importedAt: new Date().toISOString(), ...native,
            coveredRunIds: coveredNativeRuns(session, meta.runs, native.messages),
            reason: session.harness === "opencode" ? "Read-only native history snapshot. Activity is a point-in-time observation; Reconcile again for later changes. Stop external work in OpenCode." : "Read-only Claude transcript. Active execution, message timestamps and run outcome are not exposed by the SDK history API. Ensure the external Claude conversation is stopped before sending here." };
          await enqueue(async () => { await writeFile(`${historyPath}.tmp`, JSON.stringify(history), { mode: 0o600 }); await rename(`${historyPath}.tmp`, historyPath); });
          return json({ history });
        } catch (error) { return json({ error: error instanceof Error ? error.message : "Native reconciliation unavailable" }, error instanceof OpenCodeError && error.status === 409 ? 409 : 503); }
        finally { admitting.delete(session.sessionId); }
      }
      const interactionMatch = /^\/api\/sessions\/([^/]+)\/interactions(?:\/([^/]+)\/reply)?$/.exec(path);
      const cancelMatch = /^\/api\/sessions\/([^/]+)\/cancel$/.exec(path);
      if (interactionMatch || cancelMatch) {
        const session = meta.sessions.find(s => s.sessionId === (interactionMatch ?? cancelMatch)![1]);
        if (!session) return json({ error: "Unknown session" }, 404);
        if (cancelMatch && req.method === "POST") {
          if (closing || storageFailed) return json({ error: "Bridge unavailable; cancellation state must be checked in the native harness" }, 503);
          const owner = owners.get(session.sessionId);
          if (!owner) return json({ interrupted: false, status: session.lastStatus, reason: "No active App-owned run; external execution must be stopped in its native harness" });
          if (!owner.cancel) {
          owner.cancelling = true;
          owner.cancel = (async () => {
            owner.stopRequested = true;
            if (owner.run.status === "running") await emit(owner.run, "status", { status: "running", connection: "stopping", reason: "Stop requested; waiting for terminal evidence" });
            if (owners.get(session.sessionId) !== owner || owner.run.status !== "running") return { interrupted: false };
            if (owner.native) {
              if (!owner.submission && owner.run.nativePhase === "preparing") return { interrupted: true };
              // Do not interrupt before an in-flight prompt has been admitted.
              await owner.submission?.catch(() => {});
              if (owners.get(session.sessionId) !== owner || owner.run.status !== "running") return { interrupted: false };
              return await oc.cancel(session.nativeSessionId!);
            }
            const stopped = await terminate(owner);
            return { interrupted: stopped };
          })().finally(() => { owner.cancelling = false; releaseOwner(owner); });
          }
          const attempt = owner.cancel;
          try { return json(await attempt); }
          catch (error) {
            // An explicit retry is allowed after an ambiguous network failure;
            // concurrent requests still share the same in-flight attempt.
            if (owner.cancel === attempt) owner.cancel = undefined;
            if (owner.run.status === "running") await emit(owner.run, "status", { status: "running", connection: "unconfirmed", reason: "Stop acknowledgement unavailable; execution state remains unconfirmed" });
            throw error;
          }
        }
        if (session.harness !== "opencode") return interactionMatch && req.method === "GET" ? json({ interactions: [] }) : json({ error: "Claude Code one-shot mode does not support this operation" }, 501);
        if (interactionMatch && !interactionMatch[2] && req.method === "GET") return json({ interactions: await oc.interactions(session.nativeSessionId!) });
        if (interactionMatch?.[2] && req.method === "POST") { await oc.reply(session.nativeSessionId!, decodeURIComponent(interactionMatch[2]), await body(req)); return json({ ok: true }); }
        return json({ error: "Method not allowed" }, 405);
      }
      const visibilityMatch = /^\/api\/sessions\/([^/]+)\/(hide|unhide)$/.exec(path);
      if (visibilityMatch && req.method === "POST") {
        // Soft-delete: the sidebar hides the conversation, but history rows,
        // runs, logs, admissions and catalog associations are retained and the
        // conversation stays fully usable (runs, handoffs, navigation).
        const session = meta.sessions.find(s => s.sessionId === visibilityMatch[1]);
        if (!session) return json({ error: "Unknown conversation" }, 404);
        session.hidden = visibilityMatch[2] === "hide";
        await persist();
        return json({ ok: true, sessionId: session.sessionId, hidden: session.hidden });
      }
      const runsMatch = /^\/api\/sessions\/([^/]+)\/runs$/.exec(path);
      if (runsMatch && req.method === "GET") { if (!meta.sessions.some(s => s.sessionId === runsMatch[1])) return json({ error: "Unknown session" }, 404); return json({ runs: meta.runs.filter(r => r.sessionId === runsMatch[1]) }); }
      const eventMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(path);
      if (eventMatch && req.method === "GET") { const run = meta.runs.find(r => r.runId === eventMatch[1]); if (!run) return json({ error: "Unknown run" }, 404); const after = Number(url.searchParams.get("after") ?? 0); if (!Number.isSafeInteger(after) || after < 0) return json({ error: "Invalid cursor" }, 400); const list = events.get(run.runId)!.filter(e => e.seq > after); return json({ events: list, nextCursor: list.at(-1)?.seq ?? after, status: run.status }); }
      if (path === "/api/sessions/search" && req.method === "GET") {
        // Best-effort message-body search over in-memory event logs plus
        // persisted native-history snapshots. Metadata filters always work
        // client-side even when this endpoint returns no body hits.
        // Bounds: query 1-200 chars, ≤200 sessions, ≤20 recent runs/session,
        // ≤500 recent events/run, ≤50 results. Tool/reasoning parts stripped.
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return json({ results: [] });
        if (q.length > 200) return json({ error: "Query too long" }, 400);
        const limitRaw = Number(url.searchParams.get("limit") ?? 20);
        const limit = Number.isSafeInteger(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
        const workspaceFilter = url.searchParams.get("workspaceId"), worktreeFilter = url.searchParams.get("worktreeId");
        const lowered = q.toLowerCase();
        const snippetFor = (text: string): string | null => {
          const at = text.toLowerCase().indexOf(lowered);
          if (at < 0) return null;
          const start = Math.max(0, at - 60), end = Math.min(text.length, at + q.length + 60);
          return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`.slice(0, 240);
        };
        const textOf = (data: unknown): string[] => {
          if (typeof data === "string") return data.length <= 20000 ? [data] : [];
          if (!data || typeof data !== "object" || Array.isArray(data)) return [];
          const record = data as Record<string, any>;
          // Submission events carry {messageId, text}; message snapshots carry parts.
          if (typeof record.text === "string" && typeof record.messageId === "string") return record.text.length <= 20000 ? [record.text] : [];
          if (Array.isArray(record.parts)) {
            const out: string[] = [];
            for (const part of record.parts) {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string" && part.text.length <= 20000) out.push(part.text);
            }
            return out;
          }
          if (record.message && typeof record.message === "object") return textOf(record.message);
          if (Array.isArray(record.content)) {
            const out: string[] = [];
            for (const part of record.content) {
              if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") out.push(part.text);
            }
            return out;
          }
          if (record.type === "result" && typeof record.result === "string") return [record.result];
          if (typeof record.prompt === "string") return [record.prompt];
          return [];
        };
        const results: { sessionId: string; runId?: string; snippet: string; score: number }[] = [];
        const sessions = meta.sessions.slice(-200);
        for (const session of sessions) {
          if (results.length >= limit) break;
          const association = catalog.association(session.sessionId);
          if (workspaceFilter && association.workspaceId !== workspaceFilter) continue;
          if (worktreeFilter && association.worktreeId !== worktreeFilter) continue;
          // Title hits are metadata; body endpoint still surfaces one snippet.
          if (session.title && snippetFor(session.title)) {
            results.push({ sessionId: session.sessionId, snippet: snippetFor(session.title)!, score: 0.9 });
            if (results.length >= limit) break;
          }
          const runs = meta.runs.filter(r => r.sessionId === session.sessionId).slice(-20);
          for (const run of runs) {
            if (results.length >= limit) break;
            const list = (events.get(run.runId) ?? []).slice(-500);
            for (const event of list) {
              if (results.length >= limit) break;
              if (event.kind !== "submission" && event.kind !== "message" && event.kind !== "stdout") continue;
              for (const text of textOf(event.data)) {
                const snippet = snippetFor(text);
                if (snippet) {
                  // Earlier runs rank lower; title-adjacent score stays highest.
                  const score = event.kind === "submission" ? 0.8 : 0.5;
                  results.push({ sessionId: session.sessionId, runId: run.runId, snippet, score });
                  break;
                }
              }
              // One hit per event keeps the cap meaningful across long logs.
              if (results.length && results.at(-1)?.runId === run.runId && results.at(-1)?.sessionId === session.sessionId) {
                // Allow multiple events per run but stop scanning this run after 3 hits.
                if (results.filter(r => r.runId === run.runId).length >= 3) break;
              }
            }
          }
          if (results.length >= limit) break;
          // Attached/reconciled native snapshots not yet covered by run events.
          try {
            const raw = await readFile(join(options.dataDir, `${session.sessionId}.native-history.json`), "utf8");
            const parsed = JSON.parse(raw);
            const messages = Array.isArray(parsed?.messages) ? parsed.messages.slice(-100) : [];
            for (const message of messages) {
              if (results.length >= limit) break;
              for (const text of textOf(message)) {
                const snippet = snippetFor(text);
                if (snippet) { results.push({ sessionId: session.sessionId, snippet, score: 0.4 }); break; }
              }
              if (results.filter(r => r.sessionId === session.sessionId && !r.runId).length >= 2) break;
            }
          } catch { /* Missing snapshot: in-memory events are the source. */ }
        }
        return json({ results: results.slice(0, limit) });
      }
      if (/^\/api\/(?:runs|sessions)\/[^/]+\/input$/.test(path) && req.method === "POST") return json({ error: "One-shot mode does not support interactive input" }, 501);
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Method not allowed" }, 405);
      let file: string;
      if (path === "/") return new Response(req.method === "HEAD" ? null : indexHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
      else {
        let assetPath: string;
        try { assetPath = decodeURIComponent(path); } catch { return json({ error: "Not found" }, 404); }
        if (!assetPath.startsWith("/assets/") || assetPath.includes("\\") || assetPath.includes("\0") || assetPath.split("/").slice(2).some(part => !part || part.startsWith("."))) return json({ error: "Not found" }, 404);
        const assetsRoot = assetsDir;
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
    } catch (error) { return error instanceof WorkstreamAdapterError ? json({ error: error.message, code: error.code }, error.status) : error instanceof DomainError ? json({ error: error.message, code: error.code }, error.code === "NOT_FOUND" ? 404 : 409) : error instanceof WorkspaceError ? json({ error: error.message, code: error.code }, error.status) : error instanceof OpenCodeError ? json({ error: error.message }, [400, 404, 409].includes(error.status) ? error.status : 503) : json({ error: "Invalid request" }, 400); }
  }
  const server = Bun.serve<TerminalSocketData>({ hostname: options.host, port: options.port, maxRequestBodySize: 1024 * 1024, websocket: terminals.websocket, fetch: (req, srv) => handle(req, srv, (request, data) => srv.upgrade(request, { data })) });
  let hookServer: Bun.Server<undefined>;
   try { hookServer = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 1024 * 1024, fetch: async (req, srv) => new URL(req.url).pathname === "/native/handoffs" ? nativeHandoff(req) : new URL(req.url).pathname.startsWith("/hooks/") ? (await handle(req, srv)) ?? json({ error: "Not found" }, 404) : json({ error: "Not found" }, 404) }); }
  catch (error) { await server.stop(true); throw error; }
  origin = options.publicOrigin ?? `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${server.port}`;
  try { atomicAppRecord(options.dataDir, "native-handoff.json", { version: 1, url: `http://127.0.0.1:${hookServer.port}/native/handoffs`, token: handoffToken, pid: process.pid }); }
  catch (error) { await server.stop(true); await hookServer.stop(true); throw error; }
  // Start recovery only after both listeners are acquired. A port-bind failure
  // must not leave observers writing after startup releases the ownership lock.
  for (const recovering of meta.runs.filter(r => r.status === "running" && meta.sessions.find(s => s.sessionId === r.sessionId)?.harness === "opencode")) {
    const finished = Promise.withResolvers<void>();
    const owner: Owner = { run: recovering, native: true, done: finished.promise, settled: false }; owners.set(recovering.sessionId, owner);
    void (recovering.nativePhase === "preparing" ? finishNative(owner, "failed", "Bridge restarted before native submission") : monitorNative(owner))
      .catch(() => { failClosed(); }).finally(() => { owner.settled = true; releaseOwner(owner); finished.resolve(); });
  }
  let closePromise: Promise<void> | undefined;
  for (const w of (await catalog.list()).workspaces.filter(w => w.kind === "repository")) {
    try { for (const h of await handoffs.list(w.workspaceId)) if (h.recipient.ownerId === store.manifest.storeId && !["queued", "completed", "failed"].includes(h.status)) handoffReservations.add(h.recipient.sessionId); } catch {}
  }
  const handoffTimer = setInterval(() => {
    if (closing || storageFailed || handoffTask) return;
    handoffTask = consumeHandoffs().catch(() => { failClosed(); }).finally(() => { handoffTask = undefined; });
  }, 500);
  return { origin, port: server.port, handoffs, prepareHandoffRecipient, close() {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(handoffTimer);
    closePromise = (async () => {
    await handoffTask;
    await Promise.all(handoffDispatches.values());
    await terminals.close();
    if (attachmentTasks.size) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const attachmentsDrained = await Promise.race([Promise.all([...attachmentTasks]).then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 12000); })]);
      clearTimeout(timeout);
      if (!attachmentsDrained) failClosed();
    }
    await Promise.all([...owners.values()].map(async owner => {
    if (owner.native) {
      // Let any outstanding bounded HTTP request finish before releasing local
      // storage ownership. This waits for the adapter, never for native work.
       const detached = await Promise.race([Promise.all([owner.done, owner.cancel?.catch(() => {})]).then(() => true), Bun.sleep(12000).then(() => false)]);
      if (!detached) retainOwner = true;
    }
    if (owner && !owner.native) {
      // execute checks closing after every prelaunch await; no future spawn is
      // possible even if preparation outlives this bounded shutdown.
      if (owner.child) await terminate(owner);
      const done = await Promise.race([owner.done.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!done || (owner.child && groupAlive(owner))) { retainOwner = true; meta.reconciliationRequired = true; }
    }
    }));
    if (retainOwner && !storageFailed) {
      // Best effort only: ownership remains if storage is broken or blocked.
      await Promise.race([persist().catch(() => { failClosed(); }), Bun.sleep(500)]);
    }
    const flushed = await Promise.race([serial.then(() => true), Bun.sleep(500).then(() => false)]);
    if (!flushed) retainOwner = true;
    await server.stop(true); await hookServer.stop(true);
    await flushAndCloseWorkstreams(() => catalog.flush(), () => router?.close(), () => { retainOwner = true; });
    if (retainOwner) throw new Error("Shutdown did not drain safely; ownership retained. Explicit reconciliation required after process exit.");
    })();
    return closePromise;
  } };
  } catch (error) {
    try { await router?.close(); } catch { retainOwner = true; }
    if (retainOwner) retainOwnership();
    throw error;
  }
}
