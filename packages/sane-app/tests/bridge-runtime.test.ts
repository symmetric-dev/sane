/** Real HTTP bridge wiring, entirely offline: isolated installation/store/repo,
 * registered loopback fake OpenCode HTTP service, and a test-owned Claude script.
 * Never builds assets, ensures a managed service, or invokes installed CLIs/models.
 * Run this file alone: startup selectors/password are saved and restored below.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, type Options } from "../src/bridge";
import { initializeAppStore } from "../src/app-store";
import { acquireData, acquireInstallation, validateOwnershipPaths, type OwnershipHandle } from "../src/installation-ownership";
import type { NativeMessage } from "../src/opencode";
import { capabilitiesFor, getHarnessDescriptor, type Harness } from "../shared/conversation/harness-capabilities";
import { RepositoryRouter, WorkstreamAdapterError } from "../src/workstreams";
import { CatalogService } from "../src/catalog";
import { discoverRepository, initializeRepository } from "sane-core/server";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const TIMEOUT = 30000;
const PASSWORD = "offline-bridge-fixture-password";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const savedEnv = new Map<string, string | undefined>();
let root = "", repoDir = "", dataDir = "", cliLog = "", cookie = "";
let options: Options;
let app: Awaited<ReturnType<typeof start>> | undefined;
let native: Bun.Server<undefined> | undefined;
type Call = { path: string; method: string; body?: any; authorization: string | null };
type FakeSession = { info: any; messages: NativeMessage[]; inbox: any[]; active: boolean };
const calls: Call[] = [];
const sessions = new Map<string, FakeSession>();
const pendingInteractions = new Map<string, { permissions: any[]; forms: any[] }>();
let nativeAvailable = true;
const nativePassword = "fixture-native-password";
const nativeAuthorization = `Basic ${Buffer.from(`opencode:${nativePassword}`).toString("base64")}`;

// Same minimal validated asset closure as the compaction-bridge fixture. It
// lives under this test's installation, never the repository's public/assets.
function fixtureAssets(packageDir: string) {
  const files = { "bun.lock": "", "public/index.html": "<!doctype html><html><body>offline runtime fixture</body></html>" };
  mkdirSync(join(packageDir, "public"), { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(packageDir, name), value);
  const recipe = { version: 1, target: "browser", format: "esm", naming: "app.[ext]", minify: true, define: { "process.env.NODE_ENV": '"production"' } };
  const inputs = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])), $recipe: hash(JSON.stringify(recipe)), $bun: hash(Bun.version) }).sort(([a], [b]) => a.localeCompare(b)));
  const generation = crypto.randomUUID(), assets = join(packageDir, "public", "assets"), dir = join(assets, generation), js = "// offline runtime fixture\n";
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "app.js"), js);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ format: "sane-app-assets", version: 1, generation, fingerprint: hash(JSON.stringify(inputs)), inputs, outputs: { "app.js": hash(js) } }));
  writeFileSync(join(assets, "current.json"), JSON.stringify({ format: "sane-app-assets-current", version: 1, generation }));
}

function complete(id: string, outcome = "succeeded") {
  const session = sessions.get(id)!;
  const command = session.messages.at(-1)!;
  const time = command.time.created + 1;
  if (outcome === "succeeded") session.messages.push({ id: `msg_answer_${command.id}`, type: "assistant", time: { created: time, completed: time + 1 }, model: session.info.model,
    content: [
      { id: "fixture-reasoning", type: "reasoning", text: "offline reasoning" },
      { id: "fixture-tool", type: "tool", name: "fixture-only", state: { status: "completed", input: { local: true }, content: "offline tool output" } },
      { id: "fixture-text", type: "text", text: `offline answer: ${command.text}` },
    ] });
  session.messages.push({ id: `msg_idle_${command.id}`, type: "idle", time: { created: time + 2 }, outcome });
  session.active = false; session.info.time.updated = time + 2; session.info.outcome = outcome;
}

async function fakeNative(req: Request) {
  const url = new URL(req.url), path = url.pathname;
  const input = req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
  calls.push({ path: path + url.search, method: req.method, body: input, authorization: req.headers.get("authorization") });
  if (req.headers.get("authorization") !== nativeAuthorization) return Response.json({ error: "fixture credentials required" }, { status: 401 });
  if (path === "/api/info") return Response.json({ version: "2.0.18", pid: process.pid });
  if (path === "/api/model") return nativeAvailable ? Response.json({ data: [{ id: "offline", providerID: "fixture", name: "Offline fixture", enabled: true, variants: [{ id: "bounded" }] }] }) : Response.json({ error: "offline fixture disconnected" }, { status: 503 });
  if (path === "/api/agent") return Response.json({ data: [{ id: "sane/assistant/engineering", model: { providerID: "fixture", id: "offline", variant: "bounded" } }] });
  if (path === "/api/session/active") return Response.json({ data: Object.fromEntries([...sessions].filter(([, s]) => s.active).map(([id]) => [id, { type: "running" }])) });
  if (path === "/api/session" && req.method === "POST") {
    const id = `ses_fixture_${sessions.size + 1}`, time = 1700000000000 + sessions.size * 1000;
    const info = { id, ...input, time: { created: time, updated: time } };
    sessions.set(id, { info, messages: [], inbox: [], active: false });
    return Response.json({ data: info });
  }
  const match = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(path);
  const session = match && sessions.get(match[1]!);
  if (!session) return Response.json({ error: `Unexpected fixture route: ${path}` }, { status: 404 });
  switch (match![2]) {
    case undefined: return Response.json({ data: session.info });
    case "model": session.info.model = input.model; return Response.json({ data: session.info });
    case "inbox": return Response.json({ data: session.inbox });
    case "synthetic": {
      // Held without a run until the next prompt commits it ahead of that prompt.
      const pending = { id: input.id, sessionID: match![1], time: { created: session.info.time.updated + 1 }, type: "synthetic", payload: { text: input.text, description: input.description, metadata: input.metadata }, delivery: "steer" };
      session.inbox.push(pending);
      return Response.json({ data: pending });
    }
    case "permission": return Response.json({ data: pendingInteractions.get(match![1]!)?.permissions ?? [] });
    case "form": return Response.json({ data: pendingInteractions.get(match![1]!)?.forms ?? [] });
    case "message": return Response.json({ data: [...session.messages].reverse(), cursor: { next: null } });
    case "prompt": {
      const time = session.info.time.updated + 10;
      if (session.active && input.delivery === "queue") {
        const pending = { id: input.id, sessionID: match![1], type: "user", time: { created: time }, delivery: "queue", payload: { text: input.text } };
        session.inbox.push(pending);
        return Response.json({ data: pending });
      }
      for (const pending of session.inbox.splice(0)) session.messages.push({ id: pending.id, type: "synthetic", text: pending.payload.text, description: pending.payload.description, metadata: pending.payload.metadata, time: { created: time - 1 } } as NativeMessage);
      session.messages.push({ id: input.id, type: "user", text: input.text, time: { created: time } });
      session.active = true; session.info.time.updated = time;
      if (!input.text.startsWith("hold for ")) complete(match![1]!);
      return Response.json({ data: { id: input.id, time: { created: time } } });
    }
    case "interrupt": complete(match![1]!, "interrupted"); return Response.json({ interrupted: true });
    default: {
      const exactMessage = /^message\/([^/]+)$/.exec(match![2]!);
      if (exactMessage && req.method === "GET") {
        const message = session.messages.find(message => message.id === decodeURIComponent(exactMessage[1]!));
        return message ? Response.json({ data: message }) : Response.json({ error: "Message not committed" }, { status: 404 });
      }
      const exactInput = /^inbox\/([^/]+)$/.exec(match![2]!);
      if (exactInput && req.method === "DELETE") {
        session.inbox = session.inbox.filter(input => input.id !== decodeURIComponent(exactInput[1]!));
        return new Response(null, { status: 204 });
      }
      const reply = /^(permission|form)\/([^/]+)\/reply$/.exec(match![2]!);
      if (reply && req.method === "POST") {
        const state = pendingInteractions.get(match![1]!)!, key = reply[1] === "permission" ? "permissions" : "forms";
        state[key] = state[key].filter(item => item.id !== decodeURIComponent(reply[2]!));
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: `Unexpected fixture route: ${path}` }, { status: 404 });
    }
  }
}

async function api(path: string, data?: unknown, overrides: { method?: string; headers?: Record<string, string>; anonymous?: boolean } = {}) {
  const res = await fetch(`${app!.origin}${path}`, {
    method: overrides.method ?? (data === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", origin: app!.origin, ...(!overrides.anonymous && cookie ? { cookie } : {}), ...overrides.headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: "error", signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: await res.json() as any, headers: res.headers };
}
async function login() {
  const reply = await api("/api/login", { password: PASSWORD }, { anonymous: true });
  expect(reply.status).toBe(200);
  cookie = reply.headers.get("set-cookie")!.split(";")[0]!;
  return reply;
}
async function until<T>(label: string, action: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 300; i++) { const value = await action(); if (value !== undefined) return value; await Bun.sleep(25); }
  throw new Error(`Offline fixture timed out: ${label}`);
}
async function waitIdle(id: string) {
  return until("session idle", async () => {
    const session = (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === id);
    return session?.lastStatus !== "running" && session?.availability?.canSend ? session : undefined;
  });
}
const mutations = () => calls.filter(c => c.method === "POST");
const prompts = () => calls.filter(c => c.path.endsWith("/prompt"));
const invocations = (): any[] => existsSync(cliLog) ? readFileSync(cliLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const disk = (name: string) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const storedRun = (runId: string) => disk("metadata.json").runs.find((run: any) => run.runId === runId);
async function nativeContinuationFixture() {
  await login();
  const created = await api("/api/sessions", { harness: "opencode", model: "fixture/offline", effort: "bounded", cwd: repoDir, prompt: "offline before native continuation" });
  expect(created.status).toBe(202);
  const { sessionId, nativeSessionId, runId } = created.body;
  expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
  const original = storedRun(runId);
  expect(original).toMatchObject({ runId, status: "completed", nativePhase: "accepted" });
  const originalEvents = (await api(`/api/runs/${runId}/events`)).body.events;
  // Warm live-history and activity caches while the exact App command is idle.
  expect((await api(`/api/sessions/${sessionId}/transcript`)).status).toBe(200);
  const fake = sessions.get(nativeSessionId)!;
  const time = fake.info.time.updated + 10;
  const report: NativeMessage = { id: `msg_report_${crypto.randomUUID().replaceAll("-", "")}`, type: "synthetic", text: "<subagent-completed>Offline child finished its assigned work.</subagent-completed>", metadata: { notice: "subagent-completed" }, time: { created: time } };
  const assistant: NativeMessage = { id: `msg_continuation_${crypto.randomUUID().replaceAll("-", "")}`, type: "assistant", model: fake.info.model, time: { created: time + 1 }, content: [{ id: "continuation-text", type: "text", text: "offline native continuation streaming" }] };
  fake.messages.push(report, assistant); fake.active = true; fake.info.time.updated = time + 1;
  const listed = await until("native continuation activity cache refresh", async () => {
    const response = await api("/api/sessions");
    expect(response.status).toBe(200);
    const row = response.body.sessions.find((row: any) => row.sessionId === sessionId);
    return row?.nativeActivity === "active" ? row : undefined;
  });
  expect(listed).toMatchObject({ lastStatus: "running", nativeActivity: "active", availability: { canSend: true, nativeQueue: true } });
  expect(disk("metadata.json").sessions.find((row: any) => row.sessionId === sessionId)).toMatchObject({ lastStatus: "completed", lastRunId: runId });
  expect(storedRun(runId)).toEqual(original);
  return { sessionId, nativeSessionId, runId, fake, report, assistant, original, originalEvents };
}
function consumeQueuedInput(nativeSessionId: string, commandId: string) {
  const fake = sessions.get(nativeSessionId)!;
  const index = fake.inbox.findIndex(input => input.id === commandId);
  expect(index).toBeGreaterThanOrEqual(0);
  const [input] = fake.inbox.splice(index, 1);
  expect(input).toMatchObject({ id: commandId, sessionID: nativeSessionId, type: "user", delivery: "queue" });
  fake.messages.push({ id: input.id, type: "user", text: input.payload.text, time: input.time });
  fake.active = true; fake.info.time.updated = Math.max(fake.info.time.updated, input.time.created);
}
async function fixtureSession(harness: Harness) {
  const response = await api("/api/sessions");
  expect(response.status).toBe(200);
  const session = response.body.sessions.find((s: any) => s.harness === harness && !s.attachment && s.lastStatus === "completed");
  expect(session).toBeDefined();
  return session;
}
function interactionFixture(nativeId: string) {
  // IDs deliberately overlap: only the explicit discriminant may select a route.
  pendingInteractions.set(nativeId, {
    permissions: [{ id: "fixture-input", action: "Read fixture", resources: [repoDir], message: "Offline permission" }],
    forms: [{ id: "fixture-input", title: "Offline question", fields: [{ id: "choice", type: "text", label: "Choice" }] }],
  });
}
const sideEffects = () => ({ nativeMutations: mutations().length, claudeInvocations: invocations().length, sessions: disk("metadata.json").sessions.length, runs: disk("metadata.json").runs.length });
function claudeHistoryFixture() {
  const id = crypto.randomUUID(), userId = crypto.randomUUID(), assistantId = crypto.randomUUID();
  const project = join(root, "claude-profile", "projects", repoDir.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${id}.jsonl`), [
    { type: "user", uuid: userId, parentUuid: null, sessionId: id, cwd: repoDir, isSidechain: false, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "offline imported Claude turn" } },
    { type: "assistant", uuid: assistantId, parentUuid: userId, sessionId: id, cwd: repoDir, isSidechain: false, timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "offline imported Claude answer" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  return id;
}

describe.serial("bridge runtime (isolated offline HTTP native fixtures)", () => {
  beforeAll(async () => {
    const names = Object.keys(process.env).filter(name => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_API_KEY|CLAUDE_CODE_BASE_URL|CLAUDE_CODE_CUSTOM_MODEL_OPTION|AWS_BEARER_TOKEN_BEDROCK|OPENAI_API_KEY|OPENAI_BASE_URL)/.test(name));
    for (const name of [...names, "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PROJECT_DIR_NAME", "SANE_APP_PASSWORD", "OPENCODE_TOKEN"]) { savedEnv.set(name, process.env[name]); delete process.env[name]; }
    root = realpathSync(mkdtempSync(join(TEMP, "bridge-runtime-")));
    const packageDir = join(root, "installation"), profileRoot = join(root, "claude-profile"), registrationFile = join(root, "oc", "service.json");
    repoDir = join(root, "repo"); dataDir = join(root, "appdata"); cliLog = join(root, "claude-invocations.jsonl");
    fixtureAssets(packageDir); mkdirSync(repoDir); mkdirSync(profileRoot); mkdirSync(join(root, "oc"));
    if (await Bun.spawn(["git", "init", repoDir], { stdout: "ignore", stderr: "ignore" }).exited !== 0) throw new Error("fixture git init failed");
    process.env.CLAUDE_CONFIG_DIR = profileRoot; process.env.SANE_APP_PASSWORD = PASSWORD;
    // An ambient explicit token must never override registration credentials.
    process.env.OPENCODE_TOKEN = "must-not-be-used";
    native = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fakeNative });
    writeFileSync(registrationFile, JSON.stringify({ id: "offline-runtime-fixture", version: "2.0.18", pid: process.pid, url: `http://127.0.0.1:${native.port}`, password: nativePassword }));
    const stub = join(root, "claude-stub.mjs");
    writeFileSync(stub, [
      `#!${process.execPath}`,
      `import { appendFileSync } from "node:fs";`,
      `const args = process.argv.slice(2), prompt = await Bun.stdin.text();`,
      `const i = args.findIndex(a => a === "--session-id" || a === "--resume"), session_id = args[i + 1];`,
      `const payload = { hook_event_name: "UserPromptSubmit", session_id, prompt };`,
      `const probe = async (secret, value, event = "UserPromptSubmit") => { const r = await fetch(process.env.CC_WEB_HOOK_URL + "/hooks/" + event, { method: "POST", headers: { "content-type": "application/json", "x-cc-web-secret": secret, host: "untrusted.invalid", origin: "https://untrusted.invalid" }, body: JSON.stringify({ runId: process.env.CC_WEB_RUN_ID, payload: value }), signal: AbortSignal.timeout(5000) }); return r.status; };`,
      `const hookStatuses = [await probe("wrong", payload), await probe(process.env.CC_WEB_HOOK_SECRET, { ...payload, session_id: "wrong" }), await probe(process.env.CC_WEB_HOOK_SECRET, { ...payload, hook_event_name: "Stop" }), await probe(process.env.CC_WEB_HOOK_SECRET, payload)];`,
      `appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify({ args, prompt, cwd: process.cwd(), profileRoot: process.env.CLAUDE_CONFIG_DIR, runId: process.env.CC_WEB_RUN_ID, hookStatuses, leakedPassword: process.env.SANE_APP_PASSWORD ?? null, leakedToken: process.env.OPENCODE_TOKEN ?? null }) + "\\n");`,
      `console.log(JSON.stringify({ type: "system", subtype: "init", session_id }));`,
      `console.log(JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), session_id, message: { role: "assistant", content: [{ type: "text", text: "offline Claude answer: " + prompt }] } }));`,
      `console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id, result: "offline Claude OK" }));`,
      "",
    ].join("\n")); chmodSync(stub, 0o755);
    options = { host: "127.0.0.1", port: 0, cwd: repoDir, dataDir, claudeBin: stub, packageDir, noBuild: true, allowRemote: false, reconcileInterrupted: false,
      nativeSources: { cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot }, oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile } } };
    const installation = acquireInstallation(validateOwnershipPaths(packageDir, dataDir), { phase: "setup" });
    let data: OwnershipHandle | undefined;
    try { data = acquireData(installation, { phase: "setup", createDataParent: true }); initializeAppStore(dataDir, options.nativeSources); }
    finally { try { data?.release(); } finally { installation.release(); } }
    app = await start(options);
  }, TIMEOUT);

  afterAll(async () => {
    try { await app?.close(); } finally {
      try { await native?.stop(true); } finally {
        for (const [name, value] of savedEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        if (root) rmSync(root, { recursive: true, force: true });
      }
    }
  }, TIMEOUT);

  test("HTTP auth/config, Host and Origin guards, cookie login/logout revocation", async () => {
    const anonymousConfig = (await api("/api/config", undefined, { anonymous: true })).body;
    expect(anonymousConfig).toMatchObject({ authRequired: true, authenticated: false, cwd: null });
    for (const key of ["capabilities", "agents", "agentProfiles", "harnesses"]) expect(anonymousConfig).not.toHaveProperty(key);
    expect(calls).toHaveLength(0); // unauthenticated config cannot discover native state
    expect((await api("/api/sessions", undefined, { anonymous: true })).status).toBe(401);
    expect((await api("/api/config", undefined, { headers: { host: "untrusted.invalid", "x-forwarded-host": new URL(app!.origin).host } })).body).toEqual({ error: "Host rejected" });
    expect((await api("/api/login", { password: PASSWORD }, { headers: { origin: "https://untrusted.invalid" } })).body).toEqual({ error: "Origin rejected" });
    expect((await api("/api/login", { password: "wrong" })).status).toBe(401);
    const signedIn = await login();
    expect(signedIn.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/");
    const config = await api("/api/config");
    expect(config.status).toBe(200); expect(config.body).toMatchObject({ authenticated: true, cwd: repoDir });
    expect(config.body.harnesses.find((h: any) => h.id === "opencode")).toMatchObject({ available: true, connected: true });
    expect(calls.every(c => c.authorization === nativeAuthorization)).toBe(true);
    expect(mutations()).toHaveLength(0);
    expect((await api("/api/logout", {}, { headers: { origin: "" } })).status).toBe(403);
    expect((await api("/api/sessions")).status).toBe(200); // rejected logout did not revoke
    const revoked = cookie;
    const loggedOut = await api("/api/logout", {});
    expect(loggedOut.status).toBe(200); expect(loggedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await api("/api/sessions", undefined, { headers: { cookie: revoked } })).status).toBe(401);
    expect((await api("/api/logout", {}, { anonymous: true })).status).toBe(200);
    await login();
  }, TIMEOUT);

  // Can run independently with -t 'performance polling route wiring'; no native session or restart required.
  test("performance polling route wiring keeps overview/list/status/handoffs read-only and inspect/create full", async () => {
    await login();
    // Keep the existing admission fixture's repository uninitialized/App-only.
    const pollingRepo = join(root, "polling-repo"); mkdirSync(pollingRepo);
    const git = Bun.spawnSync(["git", "init", "-q", pollingRepo]);
    expect(git.exitCode).toBe(0);
    const registration = await api("/api/workspaces", { cwd: pollingRepo });
    expect(registration.status).toBe(201);
    const workspaceId = registration.body.workspaceId, qs = new URLSearchParams({ workspaceId }).toString();
    expect((await api(`/api/workstreams/init?${qs}`, {})).body.state).toBe("ready");
    const created = await api(`/api/workstreams?${qs}`, { id: "polling-route-fixture", title: "Polling route fixture", type: "feature" });
    expect(created.status).toBe(200);
    expect((await api(`/api/workstreams/overview?${qs}`)).status).toBe(200); // warm the real adapter
    const full = spyOn(RepositoryRouter.prototype, "forWorkspace").mockImplementation(async () => { throw new WorkstreamAdapterError(409, "full-route-sentinel", "Unexpected full adapter read"); });
    try {
      const overview = await api(`/api/workstreams/overview?${qs}`);
      expect(overview.status).toBe(200); expect(overview.body.conversations).toEqual([]);
      expect(overview.body.workstreams.map((s: any) => s.workstream.id)).toEqual(["polling-route-fixture"]);
      const list = await api(`/api/workstreams?${qs}`);
      expect(list.status).toBe(200); expect(list.body.map((w: any) => w.id)).toEqual(["polling-route-fixture"]);
      const status = await api(`/api/workstreams/status?${qs}&id=polling-route-fixture`);
      expect(status.status).toBe(200); expect(status.body).toEqual(overview.body.workstreams[0]);
      const handoffs = await api(`/api/handoffs?${qs}`);
      expect(handoffs.status).toBe(200); expect(handoffs.body).toEqual({ handoffs: [], problems: {} });
      expect(full).not.toHaveBeenCalled();
      // Inspect must not be silently replaced by a polling adapter lookup.
      const inspect = spyOn(RepositoryRouter.prototype, "inspect").mockImplementation(async () => { throw new WorkstreamAdapterError(409, "inspect-route-sentinel", "Full inspection boundary"); });
      try {
        const response = await api(`/api/workstreams/inspect?${qs}`);
        expect(response.status).toBe(409); expect(response.body.code).toBe("inspect-route-sentinel");
      } finally { inspect.mockRestore(); }
      const mutation = await api(`/api/workstreams?${qs}`, { id: "must-use-full", title: "Mutation boundary", type: "issue" });
      expect(mutation.status).toBe(409); expect(mutation.body.code).toBe("full-route-sentinel");
    } finally { full.mockRestore(); }
    const polling = spyOn(RepositoryRouter.prototype, "forPolling").mockImplementation(async () => { throw new WorkstreamAdapterError(409, "polling-route-sentinel", "Polling boundary"); });
    try {
      const mutation = await api(`/api/workstreams?${qs}`, { id: "full-mutation-fixture", title: "Full mutation fixture", type: "issue" });
      expect(mutation.status).toBe(200); expect(mutation.body.id).toBe("full-mutation-fixture");
      const inspect = await api(`/api/workstreams/inspect?${qs}`);
      expect(inspect.status).toBe(200); expect(inspect.body.state).toBe("ready");
      const overview = await api(`/api/workstreams/overview?${qs}`);
      expect(overview.status).toBe(409); expect(overview.body.code).toBe("polling-route-sentinel");
    } finally { polling.mockRestore(); }
  }, TIMEOUT);

  test("performance handoff poller enumerates warm repositories without full catalog listing and retains handle validation", async () => {
    await login();
    const pollingRepo = join(root, "warm-handoff-polling-repo"); mkdirSync(pollingRepo);
    expect(Bun.spawnSync(["git", "init", "-q", pollingRepo]).exitCode).toBe(0);
    initializeRepository(discoverRepository(pollingRepo));
    const registration = await api("/api/workspaces", { cwd: pollingRepo });
    expect(registration.status).toBe(201);
    const workspaceId = registration.body.workspaceId, qs = new URLSearchParams({ workspaceId }).toString();
    const originalPolling = RepositoryRouter.prototype.forPolling;
    let adapter: Awaited<ReturnType<typeof originalPolling>> | undefined;
    const polling = spyOn(RepositoryRouter.prototype, "forPolling").mockImplementation(async function(this: RepositoryRouter, id: string) {
      const result = await originalPolling.call(this, id);
      if (id === workspaceId) adapter = result;
      return result;
    });
    try {
      expect((await api(`/api/workstreams/overview?${qs}`)).status).toBe(200);
      expect(adapter).toBeDefined();
      const list = spyOn(CatalogService.prototype, "list"), get = spyOn(CatalogService.prototype, "get"), binding = spyOn(CatalogService.prototype, "binding"), validation = spyOn(adapter!.domain, "validatePolling");
      try {
        polling.mockClear();
        await until("two background handoff polls on the warm repository", async () => polling.mock.calls.filter(([id]) => id === workspaceId).length >= 2 && validation.mock.calls.length >= 2 ? true : undefined);
        // No HTTP catalog/workstream calls occurred while waiting. These accesses
        // therefore measure real consumeHandoffs ticks, not a fabricated poller.
        expect(validation.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(list).not.toHaveBeenCalled();
        expect(get.mock.calls.filter(([id]) => id === workspaceId)).toEqual([]);
        expect(binding.mock.calls.filter(([id]) => id === workspaceId)).toEqual([]);
        // The browser workspace API still performs ordinary full catalog listing.
        const browserList = await api("/api/workspaces");
        expect(browserList.status).toBe(200);
        expect(browserList.body.workspaces.some((w: any) => w.workspaceId === workspaceId)).toBe(true);
        expect(list).toHaveBeenCalledTimes(1);
        expect(get.mock.calls.some(([id]) => id === workspaceId)).toBe(true);
        expect(binding.mock.calls.some(([id]) => id === workspaceId)).toBe(true);
      } finally { for (const spy of [list, get, binding, validation]) spy.mockRestore(); }
    } finally { polling.mockRestore(); }
  }, TIMEOUT);

  test("performance handoff poller routes new repositories and changed selections through full polling misses", async () => {
    await login();
    const pollingRepo = join(root, "new-handoff-polling-repo"); mkdirSync(pollingRepo);
    expect(Bun.spawnSync(["git", "init", "-q", pollingRepo]).exitCode).toBe(0);
    initializeRepository(discoverRepository(pollingRepo));
    const originalPolling = RepositoryRouter.prototype.forPolling, originalGet = CatalogService.prototype.get;
    const active = new Set<string>(), resolved = new Set<string>(), lookups: { workspaceId: string; insidePolling: boolean }[] = [];
    let selectedCatalog: CatalogService | undefined;
    const polling = spyOn(RepositoryRouter.prototype, "forPolling").mockImplementation(async function(this: RepositoryRouter, id: string) {
      active.add(id);
      try { const result = await originalPolling.call(this, id); resolved.add(id); return result; }
      finally { active.delete(id); }
    });
    const get = spyOn(CatalogService.prototype, "get").mockImplementation(async function(this: CatalogService, id: string) {
      selectedCatalog = this;
      lookups.push({ workspaceId: id, insidePolling: active.has(id) });
      return originalGet.call(this, id);
    });
    try {
      // Do not warm via an HTTP overview: discovery must originate in the timer.
      const registration = await api("/api/workspaces", { cwd: pollingRepo });
      expect(registration.status).toBe(201);
      const workspaceId = registration.body.workspaceId;
      await until("new repository opened by background polling", async () => resolved.has(workspaceId) ? true : undefined);
      const misses = lookups.filter(lookup => lookup.workspaceId === workspaceId);
      expect(misses.length).toBeGreaterThan(0);
      expect(misses.every(lookup => lookup.insidePolling)).toBe(true);
      expect(polling.mock.calls.some(([id]) => id === workspaceId)).toBe(true);
      const workspace = (selectedCatalog as any).catalog.workspaces.find((w: any) => w.workspaceId === workspaceId);
      // Authoritative selection/revision changes cannot be treated as capabilities.
      workspace.worktrees[0].bindingRevision = crypto.randomUUID();
      lookups.length = 0; resolved.delete(workspaceId);
      await until("changed selection validated by background polling", async () => resolved.has(workspaceId) ? true : undefined);
      const changedSelection = lookups.filter(lookup => lookup.workspaceId === workspaceId);
      expect(changedSelection.length).toBeGreaterThan(0);
      expect(changedSelection.every(lookup => lookup.insidePolling)).toBe(true);
    } finally { get.mockRestore(); polling.mockRestore(); }
  }, TIMEOUT);

  test("OpenCode admission, selected launch, prompt completion and normalized transcript survive restart", async () => {
    const created = await api("/api/sessions", { harness: "opencode", agent: "engineering", model: "fixture/offline", effort: "bounded", cwd: repoDir, prompt: "offline OC first turn" });
    expect(created.status).toBe(202);
    const { sessionId, nativeSessionId, runId } = created.body;
    expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
    const launch = calls.find(c => c.path === "/api/session" && c.method === "POST")!;
    expect(launch.body).toEqual({ location: { directory: repoDir }, agent: "sane/assistant/engineering", model: { providerID: "fixture", id: "offline", variant: "bounded" } });
    const run = (await api(`/api/sessions/${sessionId}/runs`)).body.runs[0];
    expect(run).toMatchObject({ runId, status: "completed", nativePhase: "accepted", cwd: repoDir, model: "fixture/offline", effort: "bounded" });
    expect(prompts()).toHaveLength(1); expect(prompts()[0]!.body).toEqual({ id: run.nativeCommandId, text: "offline OC first turn" });
    const recorded = (await api(`/api/runs/${runId}/events`)).body.events;
    expect(recorded.filter((e: any) => e.kind === "submission")).toHaveLength(1);
    expect(recorded.filter((e: any) => e.kind === "message")).toHaveLength(2);
    expect(recorded.find((e: any) => e.kind === "message" && e.data.role === "assistant").data).toMatchObject({ status: "completed", model: "fixture/offline", parts: [
      { id: "fixture-reasoning", type: "reasoning", text: "offline reasoning" },
      { id: "fixture-tool", type: "tool", name: "fixture-only", status: "completed", input: { local: true }, output: "offline tool output" },
      { id: "fixture-text", type: "text", text: "offline answer: offline OC first turn" },
    ] });
    const page = (await api(`/api/sessions/${sessionId}/transcript`)).body;
    expect(page.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(page.messages[0].parts[0].text).toBe("offline OC first turn");
    expect(page.messages[1].parts.some((p: any) => p.text === "offline answer: offline OC first turn")).toBe(true);
    const beforeMutations = mutations().length;
    await app!.close(); app = undefined; app = await start(options);
    expect((await api("/api/sessions")).status).toBe(401); // tokens are process-generation scoped
    await login();
    const restored = (await api(`/api/sessions/${sessionId}/transcript`)).body;
    expect(restored.messages.map((m: any) => ({ id: m.id, role: m.role, parts: m.parts }))).toEqual(page.messages.map((m: any) => ({ id: m.id, role: m.role, parts: m.parts })));
    expect(mutations()).toHaveLength(beforeMutations);
    const resumed = await api("/api/sessions", { sessionId, prompt: "offline OC resumed turn" });
    expect(resumed.status).toBe(202); expect(resumed.body.nativeSessionId).toBe(nativeSessionId);
    expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
    expect(calls.filter(c => c.path === "/api/session" && c.method === "POST")).toHaveLength(1);
    expect((await api(`/api/sessions/${sessionId}/transcript`)).body.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(invocations()).toHaveLength(0);
  }, TIMEOUT);

  test("native continuation projects live synthetic and streaming transcript without reopening the completed exact run", async () => {
    const fixture = await nativeContinuationFixture();
    const { sessionId, runId, fake, report, assistant, original, originalEvents } = fixture;
    const before = calls.length;
    try {
      const first = await until("native continuation transcript cache refresh", async () => {
        const response = await api(`/api/sessions/${sessionId}/transcript`);
        expect(response.status).toBe(200);
        return response.body.messages.some((message: any) => message.id === assistant.id) ? response.body : undefined;
      });
      expect(first.messages.find((message: any) => message.id === report.id)).toMatchObject({ runId: "native-import", role: "system", parts: [{ type: "text", text: report.text }] });
      const streaming = first.messages.find((message: any) => message.id === assistant.id);
      expect(streaming).toMatchObject({ runId: "native-import", role: "assistant", status: "running", parts: [{ type: "text", text: "offline native continuation streaming" }] });
      assistant.content![0]!.text = "offline native continuation updated live";
      const updated = await until("same native continuation assistant live update", async () => {
        const response = await api(`/api/sessions/${sessionId}/transcript`);
        expect(response.status).toBe(200);
        const message = response.body.messages.find((message: any) => message.id === assistant.id);
        return message?.parts[0]?.text === "offline native continuation updated live" ? message : undefined;
      });
      expect(updated).toMatchObject({ id: streaming.id, runId: "native-import", status: "running" });
      expect(updated.version).not.toBe(streaming.version);
      assistant.time.completed = fake.info.time.updated + 1; fake.active = false; fake.info.time.updated++;
      await until("native continuation transcript terminal update", async () => {
        const response = await api(`/api/sessions/${sessionId}/transcript`);
        expect(response.status).toBe(200);
        const message = response.body.messages.find((message: any) => message.id === assistant.id);
        return message?.status === "completed" && message.runId === "native-import" ? true : undefined;
      });
      expect((await waitIdle(sessionId)).nativeActivity).toBe("idle");
      expect(storedRun(runId)).toEqual(original);
      expect((await api(`/api/sessions/${sessionId}/runs`)).body.runs).toEqual([original]);
      expect((await api(`/api/runs/${runId}/events`)).body.events).toEqual(originalEvents);
      expect(calls.slice(before).every(call => call.method === "GET")).toBe(true);
    } finally { fake.active = false; }
  }, TIMEOUT);

  test("native continuation queues a fresh durable exact user run without model selection and unlocks normal send after consumption", async () => {
    const { sessionId, nativeSessionId, runId, fake, assistant, original, originalEvents } = await nativeContinuationFixture();
    const before = calls.length;
    try {
      const queued = await api("/api/sessions", { sessionId, prompt: "offline queued behind native continuation" });
      expect(queued.status).toBe(202);
      expect(queued.body.runId).not.toBe(runId);
      expect(queued.body.nativeSessionId).toBe(nativeSessionId);
      const newRun = await until("native continuation queued exact prompt accepted", async () => {
        const run = storedRun(queued.body.runId);
        return run?.nativePhase === "accepted" && fake.inbox.some(input => input.id === run.nativeCommandId) ? run : undefined;
      });
      expect(newRun).toMatchObject({ sessionId, status: "running", nativeDelivery: "queue", model: "fixture/offline", effort: "bounded" });
      expect(newRun.nativeCommandId).not.toBe(original.nativeCommandId);
      expect(fake.messages.some(message => message.id === newRun.nativeCommandId)).toBe(false);
      expect(calls.slice(before).filter(call => call.method === "POST")).toEqual([expect.objectContaining({ path: `/api/session/${nativeSessionId}/prompt`, body: { id: newRun.nativeCommandId, text: "offline queued behind native continuation", delivery: "queue" } })]);
      const waiting = await until("native continuation exact queue waiting journal", async () => {
        const response = await api(`/api/runs/${newRun.runId}/events`);
        return response.body.events.some((event: any) => event.kind === "status" && event.data.reason?.includes("waiting for native continuation")) ? response.body.events : undefined;
      });
      expect(waiting.filter((event: any) => event.kind === "submission")).toHaveLength(1);
      expect((await api("/api/sessions", { sessionId, prompt: "must not overtake the queued run" })).status).toBe(409);
      // An unrelated continuation's idle boundary must not complete our pending input.
      assistant.time.completed = fake.info.time.updated + 1;
      fake.messages.push({ id: `msg_continuation_idle_${newRun.nativeCommandId}`, type: "idle", outcome: "succeeded", time: { created: fake.info.time.updated + 2 } });
      fake.active = false; fake.info.time.updated += 2;
      const reads = calls.filter(call => call.path === `/api/session/${nativeSessionId}/inbox`).length;
      await until("pending exact queue observed after unrelated native idle", async () => calls.filter(call => call.path === `/api/session/${nativeSessionId}/inbox`).length > reads ? true : undefined);
      expect(storedRun(newRun.runId).status).toBe("running");
      expect(calls.slice(before).some(call => call.path.includes("/model") || call.method === "PATCH")).toBe(false);
      consumeQueuedInput(nativeSessionId, newRun.nativeCommandId); complete(nativeSessionId);
      const idle = await waitIdle(sessionId);
      expect(idle).toMatchObject({ lastRunId: newRun.runId, lastStatus: "completed", nativeActivity: "idle", availability: { canSend: true } });
      expect(idle.availability.nativeQueue).not.toBe(true);
      expect(storedRun(newRun.runId)).toMatchObject({ status: "completed", nativeDelivery: "queue", nativeCommandId: newRun.nativeCommandId });
      expect(storedRun(runId)).toEqual(original);
      expect((await api(`/api/runs/${runId}/events`)).body.events).toEqual(originalEvents);
      const events = (await api(`/api/runs/${newRun.runId}/events`)).body.events;
      expect(events.filter((event: any) => event.kind === "message" && event.data.role === "user").map((event: any) => event.data.messageId)).toEqual([newRun.nativeCommandId]);
      expect(events.some((event: any) => event.kind === "message" && event.data.messageId === assistant.id)).toBe(false);
      expect(events.at(-1).data.status).toBe("completed");
      const next = await api("/api/sessions", { sessionId, prompt: "offline ordinary send after native continuation" });
      expect(next.status).toBe(202);
      expect((await waitIdle(sessionId)).lastRunId).toBe(next.body.runId);
      expect(storedRun(next.body.runId).nativeDelivery).toBeUndefined();
      expect(prompts().at(-1)!.body).toEqual({ id: storedRun(next.body.runId).nativeCommandId, text: "offline ordinary send after native continuation" });
    } finally { fake.active = false; }
  }, TIMEOUT);

  test("native continuation pending queued cancellation deletes only the exact inbox input without interrupting existing work", async () => {
    const { sessionId, nativeSessionId, runId, fake, assistant, original, originalEvents } = await nativeContinuationFixture();
    try {
      const queued = await api("/api/sessions", { sessionId, prompt: "offline cancel pending native continuation queue" });
      expect(queued.status).toBe(202);
      const newRun = await until("native continuation cancellable pending queue", async () => {
        const run = storedRun(queued.body.runId);
        return run?.nativePhase === "accepted" && fake.inbox.some(input => input.id === run.nativeCommandId) ? run : undefined;
      });
      expect(newRun).toMatchObject({ status: "running", nativeDelivery: "queue" });
      const other = { id: `msg_other_${crypto.randomUUID().replaceAll("-", "")}`, sessionID: nativeSessionId, type: "user", delivery: "queue", time: { created: fake.info.time.updated + 20 }, payload: { text: "unrelated native queued user" } };
      fake.inbox.push(other);
      const messages = structuredClone(fake.messages), before = calls.length;
      const canceled = await api(`/api/sessions/${sessionId}/cancel`, {});
      expect(canceled.status).toBe(200); expect(canceled.body).toEqual({ interrupted: true });
      await until("native continuation exact queued run interrupted", async () => storedRun(newRun.runId).status === "interrupted" ? true : undefined);
      const cancelCalls = calls.slice(before);
      expect(cancelCalls.filter(call => call.method !== "GET")).toEqual([expect.objectContaining({ method: "DELETE", path: `/api/session/${nativeSessionId}/inbox/${newRun.nativeCommandId}` })]);
      expect(cancelCalls.some(call => call.path.includes("/interrupt"))).toBe(false);
      expect(cancelCalls.some(call => call.method === "GET" && call.path === `/api/session/${nativeSessionId}/message/${newRun.nativeCommandId}`)).toBe(true);
      expect(fake.inbox).toEqual([other]); expect(fake.active).toBe(true); expect(fake.messages).toEqual(messages);
      expect(assistant.time.completed).toBeUndefined();
      expect(storedRun(runId)).toEqual(original);
      expect((await api(`/api/runs/${runId}/events`)).body.events).toEqual(originalEvents);
      const listed = await until("native continuation remains active after exact queue cancellation", async () => {
        const row = (await api("/api/sessions")).body.sessions.find((row: any) => row.sessionId === sessionId);
        return row?.availability.canSend ? row : undefined;
      });
      expect(listed).toMatchObject({ lastStatus: "running", nativeActivity: "active", availability: { canSend: true, nativeQueue: true } });
      expect(storedRun(newRun.runId)).toMatchObject({ status: "interrupted", nativeDelivery: "queue" });
    } finally { fake.active = false; fake.inbox = []; }
  }, TIMEOUT);

  test("OpenCode busy owner rejects a second prompt; Stop journals interruption and releases the slot", async () => {
    const created = await api("/api/sessions", { harness: "opencode", prompt: "hold for stop", cwd: repoDir });
    expect(created.status).toBe(202);
    const { sessionId, nativeSessionId, runId } = created.body;
    await until("fake native prompt admitted", async () => sessions.get(nativeSessionId)?.active ? true : undefined);
    const count = prompts().length;
    expect((await api("/api/sessions", { sessionId, prompt: "must not dispatch" })).status).toBe(409);
    expect(prompts()).toHaveLength(count);
    expect((await api(`/api/sessions/${sessionId}/cancel`, {})).body).toEqual({ interrupted: true });
    expect((await waitIdle(sessionId)).lastStatus).toBe("interrupted");
    const events = (await api(`/api/runs/${runId}/events`)).body.events;
    expect(events.some((e: any) => e.kind === "status" && e.data.connection === "stopping")).toBe(true);
    expect(events.at(-1).data.status).toBe("interrupted");
    expect((await api(`/api/sessions/${sessionId}/cancel`, {})).body.interrupted).toBe(false);
    expect(calls.filter(c => c.path === `/api/session/${nativeSessionId}/interrupt?resume=false`)).toHaveLength(1);
    const next = await api("/api/sessions", { sessionId, prompt: "offline after stop" });
    expect(next.status).toBe(202); expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
  }, TIMEOUT);

  test("closing detaches OpenCode; restart observes the exact command without creation, replay or interrupt", async () => {
    const created = await api("/api/sessions", { harness: "opencode", prompt: "hold for restart", cwd: repoDir });
    expect(created.status).toBe(202);
    const { sessionId, nativeSessionId, runId } = created.body;
    await until("durable accepted phase and first native message", async () => {
      const response = await api(`/api/runs/${runId}/events`);
      return disk("metadata.json").runs.find((r: any) => r.runId === runId)?.nativePhase === "accepted" && response.body.events.some((e: any) => e.kind === "message") ? true : undefined;
    });
    const before = mutations().length;
    await app!.close(); app = undefined;
    expect(sessions.get(nativeSessionId)!.active).toBe(true);
    expect(disk("metadata.json").runs.find((r: any) => r.runId === runId).status).toBe("running");
    expect(mutations()).toHaveLength(before);
    complete(nativeSessionId); // native finishes while no App bridge is attached
    app = await start(options); await login();
    expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
    expect(mutations()).toHaveLength(before);
    const events = (await api(`/api/runs/${runId}/events`)).body.events;
    expect(events.filter((e: any) => e.kind === "submission")).toHaveLength(1);
    expect(events.filter((e: any) => e.kind === "message" && e.data.role === "user")).toHaveLength(1);
    expect(events.filter((e: any) => e.kind === "message" && e.data.role === "assistant")).toHaveLength(1);
    expect(events.at(-1).data.status).toBe("completed");
    expect((await api(`/api/sessions/${sessionId}/transcript`)).body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
  }, TIMEOUT);

  test("fake Claude ordinary prompt/resume uses selected source, stdout and native hook-secret boundary", async () => {
    const nativeMutations = mutations().length;
    const created = await api("/api/sessions", { harness: "claude-code", prompt: "offline CC first turn", cwd: repoDir, model: "opus", effort: "high" });
    expect(created.status).toBe(202);
    const { sessionId, nativeSessionId, runId } = created.body;
    expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
    const first = invocations()[0];
    expect(first).toMatchObject({ prompt: "offline CC first turn", cwd: repoDir, profileRoot: join(root, "claude-profile"), runId, hookStatuses: [403, 400, 400, 200], leakedPassword: null, leakedToken: null });
    expect(flag(first.args, "--session-id")).toBe(nativeSessionId);
    expect(flag(first.args, "--model")).toBe("opus"); expect(flag(first.args, "--effort")).toBe("high");
    const settings = JSON.parse(readFileSync(flag(first.args, "--settings"), "utf8"));
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("hooks/forward.ts");
    const events = (await api(`/api/runs/${runId}/events`)).body.events;
    expect(events.filter((e: any) => e.kind === "hook")).toHaveLength(1);
    expect(events.find((e: any) => e.kind === "hook").data).toMatchObject({ event: "UserPromptSubmit", payload: { session_id: nativeSessionId, prompt: "offline CC first turn" } });
    expect(events.at(-1).data).toMatchObject({ status: "completed", exitCode: 0, resultSeen: true });
    const transcript = (await api(`/api/sessions/${sessionId}/transcript`)).body;
    expect(transcript.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(transcript.messages[1].parts[0].text).toBe("offline Claude answer: offline CC first turn");
    // Hooks route before browser auth/Host/Origin, but still require a live secret.
    expect((await api("/hooks/Stop", { runId, payload: {} }, { anonymous: true, headers: { host: "untrusted.invalid", origin: "https://untrusted.invalid" } })).status).toBe(403);
    expect((await api("/hooks/Stop", undefined, { anonymous: true })).status).toBe(403);
    expect((await api("/hooks/NotAHook", {}, { anonymous: true })).status).toBe(400);
    const resumed = await api("/api/sessions", { sessionId, prompt: "offline CC resumed turn" });
    expect(resumed.status).toBe(202); expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
    const second = invocations()[1];
    expect(flag(second.args, "--resume")).toBe(nativeSessionId); expect(second.args).not.toContain("--session-id");
    expect(flag(second.args, "--model")).toBe("opus"); expect(flag(second.args, "--effort")).toBe("high");
    expect(second.hookStatuses).toEqual([403, 400, 400, 200]);
    expect(mutations()).toHaveLength(nativeMutations);
  }, TIMEOUT);

  test("config advertises the complete registry matrix even when OpenCode is disconnected", async () => {
    const connected = await api("/api/config");
    expect(connected.status).toBe(200);
    expect(connected.body.harnesses.map((h: any) => h.id).sort()).toEqual(["claude-code", "opencode"]);
    const cc = connected.body.harnesses.find((h: any) => h.id === "claude-code");
    const oc = connected.body.harnesses.find((h: any) => h.id === "opencode");
    // Existing wire flags must retain their values as the registry adds policies.
    expect(cc.capabilities).toMatchObject({ cancelRun: true, permissionReplies: false, questionReplies: false, modelSelection: true, effortValues: ["low", "medium", "high", "xhigh", "max"] });
    expect(oc.capabilities).toMatchObject({ cancelRun: true, permissionReplies: true, questionReplies: true, modelSelection: true });
    expect(cc).toMatchObject({ available: true, connected: true });
    expect(oc).toMatchObject({ available: true, connected: true });
    const before = sideEffects();
    let disconnected: any;
    try {
      nativeAvailable = false;
      const response = await api("/api/config");
      expect(response.status).toBe(200);
      disconnected = response.body.harnesses.find((h: any) => h.id === "opencode");
      expect(disconnected).toMatchObject({ available: false, connected: false, state: "unavailable" });
      expect(disconnected.capabilities).toEqual(oc.capabilities);
      expect(sideEffects()).toEqual(before);
    } finally {
      nativeAvailable = true;
      await until("OpenCode config reconnected", async () => (await api("/api/config")).body.harnesses.find((h: any) => h.id === "opencode")?.connected ? true : undefined);
    }
    for (const harness of [cc, oc, disconnected]) {
      expect(getHarnessDescriptor(harness.id)).toBeDefined();
      expect(harness.capabilities).toEqual(capabilitiesFor(harness.id));
    }
  }, TIMEOUT);

  test("unknown explicit harnesses cannot create, resume, override a profile, or attach", async () => {
    const cc = await fixtureSession("claude-code");
    const config = await api("/api/config");
    const profile = config.body.agentProfiles.profiles.find((p: any) => p.harness === "claude-code" && p.kind === "base");
    expect(profile).toBeDefined();
    const before = sideEffects(), statuses: number[] = [];
    for (const harness of ["future-harness", "", 42, {}, null]) {
      const reply = await api("/api/sessions", { harness, prompt: "must not create a native session", cwd: repoDir });
      statuses.push(reply.status);
      // Keep a pre-hardening baseline failure isolated from subsequent cases.
      if (reply.status === 202) await waitIdle(reply.body.sessionId);
    }
    for (const extra of [{ sessionId: cc.sessionId }, { profileId: profile.id }]) {
      const reply = await api("/api/sessions", { harness: "future-harness", prompt: "must not override native identity", ...extra });
      statuses.push(reply.status);
      if (reply.status === 202) await waitIdle(reply.body.sessionId);
    }
    for (const harness of ["future-harness", "", 42, {}, null]) statuses.push((await api("/api/sessions/attach", { harness, nativeSessionId: "ses_fixture_unknown", cwd: repoDir })).status);
    expect(statuses).toEqual(Array(12).fill(400));
    expect(sideEffects()).toEqual(before);
  }, TIMEOUT);

  test("Claude interactions are an empty GET and unsupported replies without native dispatch", async () => {
    const cc = await fixtureSession("claude-code"), before = sideEffects(), nativeReads = calls.length;
    const inbox = await api(`/api/sessions/${cc.sessionId}/interactions`);
    expect(inbox.status).toBe(200); expect(inbox.body).toEqual({ interactions: [] });
    for (const reply of [{ type: "permission", decision: "once" }, { type: "question", answer: { choice: "offline" } }]) {
      const response = await api(`/api/sessions/${cc.sessionId}/interactions/fixture-input/reply`, reply);
      expect(response.status).toBe(501); expect(response.body.error).toBeTruthy();
    }
    expect(calls).toHaveLength(nativeReads);
    expect(sideEffects()).toEqual(before);
  }, TIMEOUT);

  test("OpenCode lists native permissions/questions and routes same-ID replies by type", async () => {
    const oc = await fixtureSession("opencode"), before = mutations().length, ccBefore = invocations().length;
    interactionFixture(oc.nativeSessionId);
    try {
      const inbox = await api(`/api/sessions/${oc.sessionId}/interactions`);
      expect(inbox.status).toBe(200);
      expect(inbox.body.interactions).toMatchObject([
        { id: "fixture-input", type: "permission", title: "Read fixture", options: [{ id: "once" }, { id: "always" }, { id: "reject" }] },
        { id: "fixture-input", type: "question", title: "Offline question", fields: [{ id: "choice" }] },
      ]);
      const path = `/api/sessions/${oc.sessionId}/interactions/fixture-input/reply`;
      expect((await api(path, { type: "permission", decision: "once", message: "offline permission reply" })).body).toEqual({ ok: true });
      expect((await api(path, { type: "question", answer: { choice: "offline question reply" } })).body).toEqual({ ok: true });
      expect(mutations().slice(before).map(({ path, body }) => ({ path, body }))).toEqual([
        { path: `/api/session/${oc.nativeSessionId}/permission/fixture-input/reply`, body: { decision: "once", message: "offline permission reply" } },
        { path: `/api/session/${oc.nativeSessionId}/form/fixture-input/reply`, body: { answer: { choice: "offline question reply" } } },
      ]);
      expect((await api(`/api/sessions/${oc.sessionId}/interactions`)).body).toEqual({ interactions: [] });
      expect(invocations()).toHaveLength(ccBefore);
    } finally { pendingInteractions.delete(oc.nativeSessionId); }
  }, TIMEOUT);

  test("OpenCode explicitly rejects invalid reply discriminants/payloads before native mutations", async () => {
    const oc = await fixtureSession("opencode"), before = sideEffects();
    interactionFixture(oc.nativeSessionId);
    try {
      const path = `/api/sessions/${oc.sessionId}/interactions/fixture-input/reply`, statuses: number[] = [];
      for (const reply of [
        { type: "form", answer: { choice: "must not route as question" } },
        { type: "future-interaction", decision: "once", answer: {} },
        { decision: "once" }, { type: null, answer: {} }, null,
        { type: "permission", decision: "invalid" }, { type: "permission", decision: "once", message: 42 },
        { type: "question", answer: [] }, { type: "question", answer: "invalid" },
      ]) statuses.push((await api(path, reply)).status);
      expect(sideEffects()).toEqual(before);
      expect(pendingInteractions.get(oc.nativeSessionId)!.permissions).toHaveLength(1);
      expect(pendingInteractions.get(oc.nativeSessionId)!.forms).toHaveLength(1);
      expect(statuses).toEqual(Array(9).fill(400));
    } finally { pendingInteractions.delete(oc.nativeSessionId); }
  }, TIMEOUT);

  test("OpenCode custom compaction instructions and /compact prompts reject without submitting", async () => {
    const oc = await fixtureSession("opencode"), before = sideEffects();
    const response = await api(`/api/sessions/${oc.sessionId}/compact`, { requestId: crypto.randomUUID(), instructions: "unsupported custom instructions" });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("instructions");
    const command = await api("/api/sessions", { sessionId: oc.sessionId, prompt: "/compact unsupported custom instructions" });
    expect(command.status).toBe(400); expect(command.body.code).toBe("compact-action-required");
    expect(sideEffects()).toEqual(before);
  }, TIMEOUT);

  test("cancel never interrupts externally active attached OpenCode without an App-owned run", async () => {
    const nativeId = "ses_fixture_external_cancel", time = 1700000200000;
    sessions.set(nativeId, { info: { id: nativeId, location: { directory: repoDir }, time: { created: time, updated: time } }, active: false, inbox: [],
      messages: [{ id: "msg_fixture_external_user", type: "user", text: "offline external turn", time: { created: time } }] });
    complete(nativeId);
    const before = sideEffects();
    const attached = await api("/api/sessions/attach", { harness: "opencode", nativeSessionId: nativeId, cwd: repoDir });
    expect(attached.status).toBe(201);
    expect(sideEffects()).toEqual({ ...before, sessions: before.sessions + 1 });
    sessions.get(nativeId)!.active = true;
    try {
      const cancel = await api(`/api/sessions/${attached.body.sessionId}/cancel`, {});
      expect(cancel.status).toBe(200);
      expect(cancel.body).toMatchObject({ interrupted: false });
      expect(cancel.body.reason).toContain("No active App-owned run");
      expect(sessions.get(nativeId)!.active).toBe(true);
      expect(mutations()).toHaveLength(before.nativeMutations);
      expect(invocations()).toHaveLength(before.claudeInvocations);
      expect((await api(`/api/sessions/${attached.body.sessionId}/runs`)).body.runs).toEqual([]);
    } finally { sessions.get(nativeId)!.active = false; }
  }, TIMEOUT);

  test("Claude branches require a first prompt and reject imported history/native-message selection", async () => {
    const cc = await fixtureSession("claude-code"), before = sideEffects();
    const blank = await api(`/api/sessions/${cc.sessionId}/branch`, { requestId: crypto.randomUUID(), runId: cc.lastRunId, replace: false, prompt: "   " });
    expect(blank.status).toBe(400); expect(blank.body.error).toContain("first message");
    const nativeSelection = await api(`/api/sessions/${cc.sessionId}/branch?messageId=msg_fixture_answer`);
    expect(nativeSelection.status).toBe(200); expect(nativeSelection.body).toMatchObject({ eligible: false });
    expect(nativeSelection.body.reason).toContain("completed run");
    const attached = await api("/api/sessions/attach", { harness: "claude-code", nativeSessionId: claudeHistoryFixture(), cwd: repoDir });
    expect(attached.status).toBe(201);
    const unavailable = await api(`/api/sessions/${attached.body.sessionId}/branch`);
    expect(unavailable.status).toBe(200); expect(unavailable.body).toMatchObject({ eligible: false });
    expect(unavailable.body.reason).toContain("imported");
    const submit = await api(`/api/sessions/${attached.body.sessionId}/branch`, { requestId: crypto.randomUUID(), replace: false, prompt: "must not fork imported Claude" });
    expect(submit.status).toBe(400); expect(submit.body.error).toBeTruthy();
    expect(sideEffects()).toEqual({ ...before, sessions: before.sessions + 1 });
  }, TIMEOUT);

  test("OpenCode model catalog rejection stays inside the bridge JSON error boundary", async () => {
    const before = sideEffects(), nativeReads = calls.length;
    const path = `/api/harnesses/opencode/models?cwd=${encodeURIComponent(repoDir)}`;
    try {
      nativeAvailable = false;
      const response = await api(path);
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.body).toEqual({ error: "OpenCode API returned HTTP 503" });
      expect(calls.slice(nativeReads).some(c => c.method === "GET" && c.path === `/api/model?location%5Bdirectory%5D=${encodeURIComponent(repoDir)}`)).toBe(true);
      expect(sideEffects()).toEqual(before);
    } finally {
      nativeAvailable = true;
      const recovered = await until("OpenCode model catalog recovered", async () => {
        const response = await api(path);
        return response.status === 200 ? response : undefined;
      });
      expect(recovered.body).toEqual({ models: [{ id: "fixture/offline", name: "Offline fixture", efforts: [{ id: "bounded", name: "bounded" }] }] });
      expect(sideEffects()).toEqual(before);
    }
  }, TIMEOUT);

  test("unknown and Claude model catalogs reject explicitly without native fallback", async () => {
    const before = sideEffects(), nativeReads = calls.length;
    for (const [harness, status, code] of [["future-harness", 400, "unknown-harness"], ["claude-code", 501, "unsupported-harness-operation"]] as const) {
      const response = await api(`/api/harnesses/${harness}/models?cwd=${encodeURIComponent(repoDir)}`);
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.body).toEqual({ error: harness === "claude-code" ? getHarnessDescriptor(harness)!.operations.listModels.reason : "Unknown harness", code });
    }
    expect(calls).toHaveLength(nativeReads);
    expect(sideEffects()).toEqual(before);
  }, TIMEOUT);
});
