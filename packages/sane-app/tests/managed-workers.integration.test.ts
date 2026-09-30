/**
 * Opt-in, real installed-tool integration. No mocked executor/transcript.
 * Run ONLY this file with AGENT_LIVE=1, NATIVE_OC_MODEL and NATIVE_CC_MODEL.
 * Uses the ownership/store/workspace setup from native-handoff/native-recovery,
 * and the real installer from agent-skill-install. Never discovers/stops the
 * user's OC service: the registration, HOME and XDG directories are disposable.
 * Two scenarios, three App runs each (not a token or internal model-turn cap).
 */
import { describe, test, expect } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { installSaneAlpha } from "../../sane-cli/src/install-sane";
import { installSaneAgentContextPackages } from "../../sane-cli/src/install-sane-agent-context-packages";
import { nativeIntegrationConfiguration } from "../../sane-cli/src/native-configuration";
import { resolveAppConfig } from "../src/app-config";
import { start, type Options } from "../src/bridge";
import { initializeAppStore } from "../src/app-store";
import { acquireData, acquireInstallation, validateOwnershipPaths } from "../src/installation-ownership";
import { seedAgentProfiles } from "../src/agent-profiles-contract";
import { OpenCodeAdapter } from "../src/opencode";

const PKG = realpathSync(join(import.meta.dir, ".."));
const LIVE = process.env.AGENT_LIVE === "1";
const TRACE = process.env.NATIVE_WORKER_TRACE === "1";
const liveTest = LIVE && !TRACE ? test : test.skip;
const SCENARIO_MS = 240_000;
const BOOT_MS = 180_000;
const CLEANUP_MS = 90_000;
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Live prerequisite: set ${name} to an inexpensive available model ID; no model fallback`);
  return value;
}
async function poll<T>(label: string, deadline: number, read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await Bun.sleep(250);
  }
  throw new Error(`${label}: deadline exceeded; last=${JSON.stringify(last)?.slice(0, 2500)}`);
}

async function scenario(parentHarness: "claude-code" | "opencode", diagnostic = false) {
  const ocModel = required("NATIVE_OC_MODEL"), ccModel = required("NATIVE_CC_MODEL");
  const ambient = resolveAppConfig([], { packageDir: PKG, invocationCwd: process.cwd() });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sane-worker-live-")));
  const home = join(root, "home"), repo = join(root, "repo"), dataDir = join(root, "appdata");
  const cc = join(home, ".claude"), ocConfig = join(home, ".config/opencode");
  const registration = join(home, ".local/state/opencode/service.json");
  const tracePath = join(root, "native-worker-callbacks.jsonl");
  const readTrace = (): any[] => existsSync(tracePath) ? readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  let serviceProcess: Bun.Subprocess | undefined;
  const serviceLog = join(home, ".local/share/opencode/log/opencode.log");
  const serviceStdout = join(root, "opencode-service.stdout.log"), serviceStderr = join(root, "opencode-service.stderr.log");
  const tail = (path: string) => existsSync(path) ? readFileSync(path, "utf8").slice(-8000) : "";
  const startupDiagnostics = () => ({ stdout: tail(serviceStdout), stderr: tail(serviceStderr), log: tail(serviceLog) });
  let app: Awaited<ReturnType<typeof start>> | undefined;
  let parentId: string | undefined;
  let releaseGate!: () => void;
  const gateReleased = new Promise<void>(resolve => { releaseGate = resolve; });
  const nonce = crypto.randomUUID(), result = `WORKER-RESULT-${crypto.randomUUID()}`;
  let gateRequested = false;
  const gate = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(request) {
    if (new URL(request.url).pathname !== `/${nonce}`) return new Response("not found", { status: 404 });
    gateRequested = true;
    await gateReleased;
    return new Response(result);
  } });
  const evidence: Record<string, unknown> = { parentHarness, root };
  let cleanupSucceeded = false;
  let startupTimedOut = false;
  async function api(path: string, body?: unknown): Promise<any> {
    const response = await fetch(`${app!.origin}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { origin: app!.origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(value).slice(0, 1500)}`);
    return value;
  }
  try {
    const bootDeadline = Date.now() + BOOT_MS;
    for (const path of [home, repo, dataDir, dirname(registration)]) mkdirSync(path, { recursive: true });
    // Explicit authorization for this fixture's one MCP action. Production agent
    // settings and permission modes remain unchanged; headless CC cannot prompt.
    mkdirSync(join(repo, ".claude"), { recursive: true });
    json(join(repo, ".claude/settings.local.json"), { permissions: { allow: ["mcp__sane__sane_worker_start"] } });
    const git = Bun.spawn(["git", "init", repo], { stdout: "ignore", stderr: "pipe" });
    const gitTimer = setTimeout(() => git.kill(), 10_000);
    try { expect(await git.exited).toBe(0); } finally { clearTimeout(gitTimer); }
    // Current working-tree CLI/plugin closure, installed only into this test home.
    await installSaneAlpha({ homeDirectory: home, write: () => {} });
    await installSaneAgentContextPackages({ homeDirectory: home, write: () => {} });
    if (diagnostic) {
      // Instrument only the disposable installed copy. The original executor,
      // qualification, transport and rejection behavior run unchanged.
      const pluginPath = join(ocConfig, "plugins/sane/index.ts");
      let source = readFileSync(pluginPath, "utf8");
      const replaceOnce = (from: string, to: string) => {
        if (source.split(from).length !== 2) throw new Error(`Diagnostic fixture instrumentation anchor changed: ${from.slice(0, 80)}`);
        source = source.replace(from, to);
      };
      source = `import { appendFileSync as appendWorkerTrace } from "node:fs"\n` + source;
      const record = (kind: string, value: string, extra: string) => `appendWorkerTrace(${JSON.stringify(tracePath)}, JSON.stringify({ kind: ${JSON.stringify(kind)}, sessionID: ${value}.sessionID, messageID: ${value}.messageID, id: ${value}.id, agent: ${value}.agent, ${extra} }) + "\\n", { mode: 0o600 })`;
      replaceOnce("  async setup(ctx) {", `  async setup(ctx) {\n    await ctx.tool.hook("execute.before", event => { if (event.tool === "execute") ${record("outer-before", "event", "tool: event.tool")}; })\n    await ctx.tool.hook("execute.after", event => { if (event.tool === "execute") ${record("outer-after", "event", "tool: event.tool")}; })`);
      const executor = "execute: async (input, tool) => ({ content: JSON.stringify(await workerNativeCaller(await qualifyWorker(tool, operation), operation, input, ctx.options.appConnectionFile as string)) }),";
      replaceOnce(executor, `execute: async (input, tool) => { ${record("sane-callback", "tool", "operation")}; return ({ content: JSON.stringify(await workerNativeCaller(await qualifyWorker(tool, operation), operation, input, ctx.options.appConnectionFile as string)) }); },`);
      writeFileSync(pluginPath, source);
    }
    // The installer declares dependencies; the real 2.0.20 service does not
    // install them when loading this local plugin. Reuse the installed workspace
    // packages (and their real transitive closures), with no network install or
    // replacement plugin. Links live only inside the disposable profile.
    for (const [name, source] of [
      ["@opencode/plugin", join(PKG, "../../node_modules/@opencode/plugin")],
      ["@opencode/client", join(PKG, "node_modules/@opencode/client")],
      ["@modelcontextprotocol/sdk", join(PKG, "../sane-cli/node_modules/@modelcontextprotocol/sdk")],
    ]) {
      const destination = join(ocConfig, "node_modules", name!);
      mkdirSync(dirname(destination), { recursive: true });
      symlinkSync(realpathSync(source!), destination, "dir");
    }
    // Preserve projected frontmatter and per-agent permission files exactly.
    // Only the installed fixture body is narrowed to a deterministic marker task.
    for (const path of [join(cc, "agents/sane-worker-scout.md"), join(ocConfig, "agents/sane/worker/scout.md")]) {
      const source = readFileSync(path, "utf8"), frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(source)?.[0];
      if (!frontmatter) throw new Error(`Installed scout frontmatter missing: ${path}`);
      writeFileSync(path, `${frontmatter}\nPerform only the supplied integration task. Execute its one read-only command, then return its exact output and end your turn. Do not delegate or load skills.\n`);
    }
    const sourceCc = process.env.NATIVE_CLAUDE_PROFILE ?? ambient.config.native.claude.profileRoot;
    // Copy authentication, never native sessions/service registrations. On macOS
    // Claude may instead use the user's existing keychain credentials.
    for (const name of [".credentials.json", ".claude.json"]) {
      if (existsSync(join(sourceCc, name))) copyFileSync(join(sourceCc, name), join(cc, name));
    }
    const auth = process.env.NATIVE_OC_AUTH_FILE ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "opencode/auth.json");
    // V2 stores current accounts in SQLite. auth.json is only a legacy import
    // source, not a live mirror of the user's currently connected providers.
    evidence.ocAuthenticationSource = { legacyImportPath: auth, exists: existsSync(auth), providerConfigSupplied: !!process.env.NATIVE_OC_CONFIG };
    if (existsSync(auth)) {
      mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
      copyFileSync(auth, join(home, ".local/share/opencode/auth.json"));
    }
    const configuration = nativeIntegrationConfiguration({ pluginDirectory: join(ocConfig, "plugins/sane"), registrationFile: registration,
      profileRoot: cc, bindingRoot: join(root, "bindings"), bunExecutable: process.execPath, appConnectionFile: join(dataDir, "native-handoff.json") });
    mkdirSync(join(root, "bindings"), { recursive: true, mode: 0o700 });
    // Optional JSON provider config for installations whose models need custom
    // providers. Its permissions are retained; plugins are the current installer.
    const providerConfig = process.env.NATIVE_OC_CONFIG ? JSON.parse(readFileSync(process.env.NATIVE_OC_CONFIG, "utf8")) : {};
    json(join(ocConfig, "opencode.json"), { ...providerConfig, ...configuration.opencode, model: ocModel });
    const sourceSettings = join(sourceCc, "settings.json");
    const settings = existsSync(sourceSettings) ? JSON.parse(readFileSync(sourceSettings, "utf8")) : {};
    json(join(cc, "settings.json"), { ...settings, hooks: configuration.claudeSettings.hooks });
    json(join(root, "mcp.json"), configuration.claudeMcp);
    // Transparent launcher, not a harness stub: exec the actual configured CLI.
    const claudeBin = process.env.NATIVE_CLAUDE_BIN ?? ambient.config.native.claude.executable;
    const launcher = join(root, "claude");
    writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quote(join(root, "claude-argv.txt"))}\nexec ${quote(claudeBin)} --strict-mcp-config --mcp-config ${quote(join(root, "mcp.json"))} "$@"\n`);
    chmodSync(launcher, 0o700);
    // Service.ensure's `file` selects discovery, not the child's port or CLI
    // registration flag. XDG_STATE_HOME determines the CLI registration path.
    // A fresh service otherwise still binds the shared default port (49374).
    const serviceEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !/^(OPENCODE_|SANE_|CC_WEB_)/.test(name))),
      HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
      // XDG_CONFIG_HOME already discovers opencode.json. Also setting
      // OPENCODE_CONFIG loaded that same document twice in config.get().
      OPENCODE_CONFIG_DIR: ocConfig,
      PATH: `${join(home, ".local/bin")}:${process.env.PATH ?? ""}`,
    };
    const ocBin = process.env.NATIVE_OPENCODE_BIN ?? "opencode";
    // Reserve a kernel-selected port until the isolated service configuration
    // is written. If another process wins the release/bind race, fail explicitly.
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved", { status: 503 }) });
    const servicePort = reservation.port!;
    try {
      const configure = Bun.spawn([ocBin, "service", "set", "port", String(servicePort)], {
        cwd: repo, env: serviceEnv, stdin: "ignore", stdout: Bun.file(join(root, "opencode-config.stdout.log")), stderr: Bun.file(join(root, "opencode-config.stderr.log")),
      });
      const timer = setTimeout(() => configure.kill("SIGKILL"), 15_000);
      try {
        const exit = await configure.exited;
        if (exit !== 0) throw new Error(`Isolated service port configuration failed (${exit}): ${tail(join(root, "opencode-config.stderr.log"))}\n${tail(serviceLog)}`);
      } finally { clearTimeout(timer); }
    } finally { reservation.stop(true); }
    // One owned foreground service process, with retained diagnostics. Unlike
    // ensure(), this does not retry failed contenders for two minutes or leave
    // unregistered contenders without a cleanup handle.
    serviceProcess = Bun.spawn([ocBin, "serve", "--service"], {
      cwd: repo, env: serviceEnv, stdin: "ignore", stdout: Bun.file(serviceStdout), stderr: Bun.file(serviceStderr),
    });
    evidence.serviceStartup = { pid: serviceProcess.pid, port: servicePort, registration, serviceLog, serviceStdout, serviceStderr };
    try {
      const endpoint = await poll("isolated OpenCode service readiness (45s, one launch)", Date.now() + 45_000, async () => {
        if (serviceProcess!.exitCode !== null || serviceProcess!.signalCode !== null || /level=ERROR[^\n]*cli process failed/.test(tail(serviceLog))) {
          throw new Error(`OpenCode service failed before readiness (exit=${serviceProcess!.exitCode}, signal=${serviceProcess!.signalCode})`);
        }
        if (existsSync(registration)) {
          const registered = JSON.parse(readFileSync(registration, "utf8"));
          if (registered.pid !== serviceProcess!.pid) throw new Error("Isolated registration PID differs from the owned service process");
        }
        return Service.discover({ file: registration });
      }, value => value !== undefined);
      expect(new URL(endpoint!.url).port).toBe(String(servicePort));
      // No session or model turn: fail before launching the paid CC parent if
      // the configured agent or real installed plugin is unavailable. Preserve
      // exact IDs; do not recover by selecting a builtin/different agent.
      const client = OpenCode.make({ baseUrl: endpoint!.url, headers: Service.headers(endpoint!) });
      const location = { directory: repo };
      const installedPath = join(ocConfig, "agents/sane/worker/scout.md");
      const preflightStarted = Date.now(), preflightDeadline = preflightStarted + 30_000;
      let attempts = 0;
      // The registered HTTP service can answer empty snapshot catalogs while
      // location plugin initialization is still running (including no builtins).
      // Wait for both exact prerequisites, not just HTTP readiness. Errors are
      // terminal; only absent/pending catalog entries get this bounded wait.
      await poll("native agent/plugin readiness before any model turn (30s)", preflightDeadline, async () => {
        if (serviceProcess!.exitCode !== null || serviceProcess!.signalCode !== null) throw new Error("Owned service exited during native preflight");
        const request = { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, preflightDeadline - Date.now()))) };
        const [agents, plugins, config, models] = await Promise.all([
          client.agent.list({ location }, request), client.plugin.list({ location }, request), client.config.get({ location }, request), client.model.list({ location }, request),
        ]);
        const preflight = {
          attempts: ++attempts, elapsedMs: Date.now() - preflightStarted,
          location: agents.location,
          installedAgent: { path: installedPath, frontmatter: /^---\r?\n[\s\S]*?\r?\n---/.exec(readFileSync(installedPath, "utf8"))?.[0] },
          agents: agents.data.map(a => ({ id: a.id, name: a.name, mode: a.mode, hidden: a.hidden })),
          plugins: plugins.data.map(p => ({ id: p.id, source: p.source, state: p.state })),
          requestedModel: ocModel,
          modelReady: models.data.some(m => `${m.providerID}/${m.id}` === ocModel && m.enabled),
          providerModels: models.data.filter(m => m.providerID === ocModel.split("/")[0]).map(m => ({ id: `${m.providerID}/${m.id}`, enabled: m.enabled })),
          // Directory entries contain exactly type/path in the installed SDK.
          // Keep both; never serialize provider configuration or credentials.
          config: config.map(c => c.type === "document" ? { type: c.type, path: c.path, agentIds: Object.keys(c.info.agents ?? {}) } : { ...c }),
        };
        if (attempts === 1) evidence.nativePreflightInitial = preflight;
        evidence.nativePreflight = preflight;
        const failures = plugins.data.filter(p => p.state.status === "failed");
        if (failures.length) throw new Error(`Native plugin initialization failed: ${JSON.stringify(preflight.plugins)}`);
        return preflight;
      }, value => value.modelReady && value.agents.some(a => a.id === "sane/worker/scout") && value.plugins.some(p => p.id === "sane" && p.state.status === "active"));
    } catch (error) {
      const diagnostics = startupDiagnostics();
      evidence.serviceStartupFailure = diagnostics;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nFixture: ${root}\n${JSON.stringify(diagnostics, null, 2)}`);
    }
    const options: Options = { host: "127.0.0.1", port: 0, cwd: repo, dataDir, claudeBin: launcher, allowRemote: false,
      reconcileInterrupted: false, maxConcurrentRuns: 2, maxWorkersPerCheckout: 1,
      nativeSources: { cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: cc },
        oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: registration } } };
    const paths = validateOwnershipPaths(PKG, dataDir), installation = acquireInstallation(paths, { phase: "setup" });
    try {
      const data = acquireData(installation, { phase: "setup", createDataParent: true });
      try { initializeAppStore(dataDir, options.nativeSources); } finally { data.release(); }
    } finally { installation.release(); }
    const profiles = seedAgentProfiles();
    const workerHarness = parentHarness === "claude-code" ? "opencode" : "claude-code";
    for (const profile of profiles.profiles) {
      if (profile.id === "worker:scout") profile.harness = workerHarness;
      profile.model = profile.harness === "opencode" ? ocModel : ccModel;
      profile.effort = "";
    }
    json(join(dataDir, "agents.json"), profiles);
    const starting = start(options);
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    // start() has no abort API. If it finishes after the startup deadline, close
    // that late handle as well; retain the fixture until ownership is settled.
    const lateHandle = starting.then(async handle => {
      if (startupTimedOut) { await handle.close(); return; }
      return handle;
    });
    void lateHandle.catch(error => console.error("late test App cleanup failed", error));
    try {
      app = await Promise.race([lateHandle, new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => { startupTimedOut = true; reject(new Error("Live startup exceeded 180s budget")); }, Math.max(1, bootDeadline - Date.now()));
      })]);
    } finally { clearTimeout(startupTimer); }
    if (!app) throw new Error("Live App did not start");
    if (Date.now() >= bootDeadline) throw new Error("Live startup exceeded 180s budget");
    const workspace = await api("/api/workspaces", { cwd: repo });
    const workspaceId = workspace.workspaceId ?? workspace.workspace?.workspaceId ?? workspace.id;
    expect(typeof workspaceId).toBe("string");
    await api(`/api/workstreams/inspect?workspaceId=${workspaceId}`);
    await api(`/api/workstreams/init?workspaceId=${workspaceId}`, {});
    const deadline = Date.now() + (diagnostic ? 60_000 : SCENARIO_MS);
    // Gate response is unknown to both models until after the first parent run
    // completes. No prompt-echo can satisfy the result assertion.
    const command = `curl --fail --silent --show-error --max-time 210 http://127.0.0.1:${gate.port}/${nonce}`;
    const workerPrompt = `Integration task in ${repo}. Run exactly this one read-only command: ${command}. Return its exact output, then end your turn. No other tools or work.`;
    const started = await api("/api/sessions", { cwd: repo, harness: parentHarness,
      profileId: parentHarness === "claude-code" ? "base:cc" : "base:oc",
      prompt: diagnostic
        ? 'Diagnostic task: make exactly ONE Code Mode execute call. Its JavaScript must call the installed tools.sane_worker_status({}) exactly TWICE, sequentially, catching each rejection independently so the second call still executes. Use: const results = []; for (let i = 0; i < 2; i++) { try { results.push(await tools.sane_worker_status({})); } catch { results.push("STATUS-REJECTED"); } } return results; After execute returns, reply TRACE-DONE and end your turn. No other tools, worker starts, delegation, shell commands, file changes, or retries. Tool rejection is expected and must not trigger recovery.'
        : `Call sane_worker_start exactly once with ${JSON.stringify({ worker: "scout", prompt: workerPrompt })}. Use the installed SANE tool, not a shell or native subagent. After the tool returns, say PARENT-IDLE and immediately end this turn. Do not wait, poll, acknowledge, or call any other tool. When automatic worker report-back resumes you, output the exact worker result from that notification and end your turn without tools.` });
    parentId = started.sessionId;
    expect(typeof parentId).toBe("string");
    const runs = async (id: string) => (await api(`/api/sessions/${id}/runs`)).runs as any[];
    const events = async (id: string) => (await api(`/api/runs/${id}/events?after=0`)).events as any[];
    const initial = await poll("parent must end its turn", deadline, async () => (await runs(parentId!)).find(r => r.runId === started.runId), r => r && r.status !== "running");
    if (diagnostic) {
      const trace = readTrace();
      evidence.callbackTrace = trace;
      evidence.diagnosticOnly = true;
      evidence.parentRun = { sessionId: parentId, runId: started.runId, nativeCommandId: initial.nativeCommandId, status: initial.status };
      const before = trace.filter(r => r.kind === "outer-before"), after = trace.filter(r => r.kind === "outer-after"), callbacks = trace.filter(r => r.kind === "sane-callback");
      if (before.length !== 1 || after.length !== 1 || callbacks.length !== 2 || callbacks.some(r => r.operation !== "status")) {
        throw new Error(`Code Mode diagnostic incomplete: require one execute before/after and two actual status callbacks; got ${JSON.stringify(trace)}. Fixture: ${root}`);
      }
      expect(initial.status).toBe("completed");
      for (const row of trace) for (const field of ["sessionID", "messageID", "id", "agent"]) expect(typeof row[field] === "string" && row[field].length > 0).toBe(true);
      expect(after[0]).toEqual({ ...before[0], kind: "outer-after" });
      expect(callbacks.every(r => r.sessionID === before[0].sessionID)).toBe(true);
      expect(trace.indexOf(before[0]) < trace.indexOf(callbacks[0])).toBe(true);
      expect(trace.indexOf(callbacks[1]) < trace.indexOf(after[0])).toBe(true);
      const snapshot = await new OpenCodeAdapter(undefined, undefined, registration).snapshot(before[0].sessionID, initial.nativeCommandId, repo);
      const visible = snapshot.messages.filter(m => m.type === "assistant").flatMap(m => (m.content ?? []).filter(p => p.type === "tool").map(p => ({ messageID: m.id, id: p.id, tool: p.name })));
      evidence.visibleNativeTools = visible; // No JavaScript, prompt, input, or output bodies.
      expect(visible).toEqual([{ messageID: before[0].messageID, id: before[0].id, tool: "execute" }]);
      evidence.callbackIdentity = { idsUnique: new Set(callbacks.map(r => r.id)).size === callbacks.length,
        idsEqualOuter: callbacks.map(r => r.id === before[0].id), messageIDsEqualOuter: callbacks.map(r => r.messageID === before[0].messageID) };
      expect((await api(`/api/sessions/${parentId}/workers`)).workers).toHaveLength(0);
      expect(await runs(parentId!)).toHaveLength(1);
      return; // Diagnostic success is never a worker/report-back integration pass.
    }
    const launchEvidence = await events(started.runId);
    evidence.parentEvents = launchEvidence;
    const permissionDenials = launchEvidence.filter(e => e.kind === "stdout").flatMap(e => {
      const data = e.data;
      if (data?.type === "system" && data.subtype === "permission_denied") {
        return [{ tool: data.tool_name, toolCallId: data.tool_use_id, message: data.message }];
      }
      if (data?.type === "result" && Array.isArray(data.permission_denials)) {
        return data.permission_denials.map((denial: any) => ({ tool: denial.tool_name, toolCallId: denial.tool_use_id }));
      }
      return [];
    });
    if (permissionDenials.length) {
      evidence.permissionDenials = permissionDenials;
      throw new Error(`Live native-tool permission prerequisite unmet: ${JSON.stringify(permissionDenials)}. Fixture: ${root}. ` +
        "The fixture explicitly allows only mcp__sane__sane_worker_start. Inspect the denied tool and effective settings; existing ask/deny rules and permission modes remain authoritative.");
    }
    if (initial.status !== "completed") {
      const diagnostics = launchEvidence.flatMap<Record<string, unknown>>(e => {
        const data = e.data;
        if (e.kind === "stdout" && data?.type === "assistant" && data.is_api_error_message) {
          return [{ kind: "native-api-error", error: data.error,
            message: (data.message?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n").slice(0, 1200) }];
        }
        if (e.kind === "stdout" && data?.type === "result") {
          return [{ kind: "native-result", subtype: data.subtype, isError: data.is_error, terminalReason: data.terminal_reason,
            message: typeof data.result === "string" ? data.result.slice(0, 1200) : undefined }];
        }
        if (e.kind === "status" && data?.reason) return [{ kind: "app-status", message: String(data.reason).slice(0, 1200) }];
        if (e.kind === "stderr") return [{ kind: "native-stderr", message: (typeof data === "string" ? data : JSON.stringify(data)).slice(0, 1200) }];
        return [];
      });
      evidence.parentFailure = { status: initial.status, diagnostics };
      const authHint = diagnostics.some(d => "error" in d && d.error === "authentication_failed")
        ? " Restore valid authentication in NATIVE_CLAUDE_PROFILE (or the configured source profile) before rerunning; this fixture copies credentials and does not log in or repair OAuth refresh state."
        : "";
      throw new Error(`Parent run ${started.runId} ${initial.status}: ${JSON.stringify(diagnostics)}. Fixture: ${root}.${authHint}`);
    }
    expect(initial.status).toBe("completed");
    const before = await poll("native worker launch and gate request", deadline, async () => {
      const b = await api(`/api/sessions/${parentId}/workers`);
      if (!b.workers.length) throw new Error(`Parent ended without a durable worker reservation. Inspect its real tool result: ${JSON.stringify(launchEvidence).slice(-6000)}`);
      const failed = b.workers.find((w: any) => ["failed", "interrupted", "uncertain", "waiting"].includes(w.state));
      if (failed) {
        const workerEvents = failed.runId ? await events(failed.runId) : [];
        const diagnostics = workerEvents.flatMap<Record<string, unknown>>(e => {
          const data = e.data;
          if (e.kind === "message" && data?.role !== "user") return [{ kind: e.kind, error: data.error,
            parts: (data.parts ?? []).filter((p: any) => p.error !== undefined || p.type === "text").map((p: any) => ({ type: p.type, error: p.error, text: p.text?.slice(0, 1200) })) }];
          if (e.kind === "stdout" && (data?.type === "result" || data?.is_api_error_message)) return [{ kind: "native-error", error: data.error, result: data.result, message: data.message?.content }];
          if (e.kind === "stderr" || e.kind === "status") return [{ kind: e.kind, data }];
          return [];
        });
        // Some native failures (e.g. ModelUnavailableError before a model step)
        // have no assistant error message. Preserve correlated server evidence.
        const nativeErrors = existsSync(serviceLog) ? readFileSync(serviceLog, "utf8").split("\n")
          .filter(line => failed.child?.nativeId && line.includes(`sessionID=${failed.child.nativeId}`) && /level=(ERROR|WARN)/.test(line))
          .slice(-3).map(line => line.slice(0, 2000)) : [];
        evidence.workerFailure = { worker: failed, events: workerEvents, diagnostics, nativeErrors };
        throw new Error(`Worker ${failed.id} ${failed.state} before gate: ${JSON.stringify({ diagnostics, nativeErrors, error: failed.error })}. Fixture: ${root}`);
      }
      return b;
    }, b => b.workers.length > 0 && gateRequested);
    expect(before.workers).toHaveLength(1);
    expect(before.deliveries).toHaveLength(0);
    const worker = before.workers[0];
    expect(worker.state).toBe("running");
    expect(worker.parent.sessionId).toBe(parentId);
    expect(worker.parent.runId).toBe(started.runId);
    expect(worker.checkout).toBe(repo);
    expect(worker.launch).toMatchObject({ harness: workerHarness, profileId: "worker:scout", agent: workerHarness === "opencode" ? "sane/worker/scout" : "sane-worker-scout", model: workerHarness === "opencode" ? ocModel : ccModel });
    expect(worker.child.harness).toBe(workerHarness === "opencode" ? "oc" : "cc");
    if (workerHarness === "opencode") {
      const nativeWorker = await new OpenCodeAdapter(undefined, undefined, registration).session(worker.child.nativeId);
      expect(nativeWorker.agent).toBe("sane/worker/scout");
      expect(nativeWorker.location?.directory).toBe(repo);
    } else {
      expect(readFileSync(join(root, "claude-argv.txt"), "utf8")).toContain("--agent\nsane-worker-scout\n");
    }
    const parentEvents = launchEvidence;
    if (parentHarness === "opencode") {
      const native = new OpenCodeAdapter(undefined, undefined, registration);
      const snapshot = await native.snapshot(worker.parent.native.nativeId, initial.nativeCommandId, repo);
      const tools = snapshot.messages.filter(m => m.type === "assistant").flatMap(m => m.content ?? []).filter(p => p.type === "tool");
      const invocation = worker.parent.invocation;
      expect(invocation.toolCallId).toBe(worker.parent.toolCallId);
      expect(invocation.opencode.operation).toBe("start");
      expect(invocation.opencode.invocationId).toMatch(/^[a-f0-9-]{36}$/);
      const parentMessage = snapshot.messages.find(m => m.id === invocation.messageId && m.type === "assistant");
      expect(parentMessage).toBeDefined();
      const expectedTool = invocation.opencode.wrapper === "execute" ? "execute" : "sane_worker_start";
      expect(parentMessage!.content?.filter(p => p.type === "tool" && p.id === worker.parent.toolCallId).map(p => p.name)).toEqual([expectedTool]);
      expect(tools.filter(p => p.id === worker.parent.toolCallId)).toHaveLength(1);
      evidence.nativeWorkerDispatch = { operation: invocation.opencode.operation, invocationId: invocation.opencode.invocationId,
        messageId: invocation.messageId, visibleToolCallId: worker.parent.toolCallId, visibleTool: expectedTool };
    } else {
      const calls = parentEvents.filter(e => e.kind === "stdout" && e.data?.type === "assistant" && !e.data.parent_tool_use_id)
        .flatMap(e => e.data.message?.content ?? []).filter(p => p.type === "tool_use");
      expect(calls.filter(p => p.name === "mcp__sane__sane_worker_start").map(p => p.id)).toEqual([worker.parent.toolCallId]);
    }
    releaseGate();
    const finished = await poll("durable report-back", deadline, () => api(`/api/sessions/${parentId}/workers`), b => b.deliveries.some((d: any) => d.state === "delivered"));
    expect(finished.workers).toHaveLength(1);
    expect(finished.deliveries).toHaveLength(1);
    const delivery = finished.deliveries[0];
    expect(delivery.parentSessionId).toBe(parentId);
    expect(delivery.native).toEqual(worker.parent.native);
    expect(delivery.workerIds).toEqual([worker.id]);
    expect(delivery.run.runId).not.toBe(started.runId);
    const final = await poll("report-back parent run", deadline, async () => (await runs(parentId!)).find(r => r.runId === delivery.run.runId), r => r && r.status !== "running");
    expect(final.status).toBe("completed");
    if (parentHarness === "opencode") expect(final.nativeCommandId).not.toBe(initial.nativeCommandId);
    expect(final.createdAt >= initial.endedAt).toBe(true);
    expect((await runs(parentId!)).length).toBe(2);
    expect((await runs(worker.sessionId)).length).toBe(1);
    const durable = (await api(`/api/sessions/${parentId}/workers`)).workers[0];
    expect(durable.outcome.status).toBe("completed");
    expect(durable.outcome.summary).toContain(result);
    const reportEvents = await events(final.runId);
    if (parentHarness === "claude-code") {
      const init = reportEvents.find(e => e.kind === "stdout" && e.data?.type === "system" && e.data?.subtype === "init");
      expect(init?.data.session_id).toBe(worker.parent.native.nativeId);
    }
    // Exclude submission records: assert an actual assistant response, not the
    // notification prompt or a model's claim that it launched a worker.
    const assistantOutput = reportEvents.filter(e => e.kind === "stdout" && e.data?.type === "assistant" || e.kind === "message" && e.data?.role === "assistant");
    expect(JSON.stringify(assistantOutput)).toContain(result);
    evidence.worker = durable; evidence.delivery = delivery; evidence.parentRuns = await runs(parentId!);
  } finally {
    releaseGate();
    try {
      if (app && parentId) {
        await api(`/api/sessions/${parentId}/cancel`, {});
        await api(`/api/sessions/${parentId}/workers/cancel`, { all: true });
      }
    } finally {
      try { await app?.close(); cleanupSucceeded = true; }
      finally {
        try {
          // Registration alone is not ownership. Only stop our exact launch.
          if (serviceProcess && existsSync(registration)) {
            const registered = JSON.parse(readFileSync(registration, "utf8"));
            if (registered.pid !== serviceProcess.pid) throw new Error("Refusing to stop a service not owned by this fixture");
            await Service.stop({ file: registration, pty: "clear" });
          }
        }
        catch (error) { cleanupSucceeded = false; throw error; }
        finally {
          // Also covers startup failures before any registration was published.
          if (serviceProcess && serviceProcess.exitCode === null && serviceProcess.signalCode === null) {
            serviceProcess.kill("SIGTERM");
            const timer = setTimeout(() => serviceProcess!.kill("SIGKILL"), 5000);
            try { await serviceProcess.exited; } finally { clearTimeout(timer); }
          }
          // Native logging is buffered: the failure-time tail may predate all
          // service entries. Capture again after owned-process exit/flush.
          if (evidence.serviceStartupFailure) evidence.serviceStartupFailureAfterShutdown = startupDiagnostics();
          if (evidence.workerFailure) evidence.workerFailureAfterShutdown = startupDiagnostics();
          gate.stop(true);
          if (process.env.NATIVE_EVIDENCE_DIR) {
            mkdirSync(process.env.NATIVE_EVIDENCE_DIR, { recursive: true });
            if (diagnostic) { evidence.diagnosticOnly = true; evidence.callbackTrace = readTrace(); }
            json(join(process.env.NATIVE_EVIDENCE_DIR, diagnostic ? "managed-workers-codemode-diagnostic.json" : `managed-workers-${parentHarness}.json`), evidence);
          }
          if (cleanupSucceeded && !startupTimedOut && process.env.NATIVE_KEEP_FIXTURES !== "1") rmSync(root, { recursive: true, force: true });
        }
      }
    }
  }
}

describe.serial("managed workers: real installed native tools", () => {
  for (const harness of ["claude-code", "opencode"] as const) {
    liveTest(`${harness} parent → cross-harness worker → same-parent report-back${TRACE ? " (skipped: diagnostic-only mode)" : LIVE ? "" : " (skipped: AGENT_LIVE!=1)"}`, () => scenario(harness), BOOT_MS + SCENARIO_MS + CLEANUP_MS);
  }
  (LIVE && TRACE ? test : test.skip)("diagnostic only: OC Code Mode native callback ancestry (requires AGENT_LIVE=1 NATIVE_WORKER_TRACE=1)",
    () => scenario("opencode", true), BOOT_MS + 60_000 + CLEANUP_MS);
});
