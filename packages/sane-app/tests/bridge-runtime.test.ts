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
import { acquireData, acquireInstallation, validateOwnershipPaths, OwnershipHandle } from "../src/installation-ownership";
import { OpenCodeAdapter, OpenCodeError, OpenCodeSourceMismatchError, OpenCodeUnavailableError, type NativeMessage } from "../src/opencode";
import { ChromePushService } from "../src/chrome-push";
import { capabilitiesFor, getHarnessDescriptor, type Harness } from "../shared/conversation/harness-capabilities";
import { RepositoryRouter, WorkstreamAdapterError } from "../src/workstreams";
import { CatalogService } from "../src/catalog";
import { OpenCodeRunService, type OpenCodeRunDependencies } from "../src/opencode-run-service";
import { ClaudeRunService } from "../src/claude-run-service";
import { WorkerService } from "../src/workers";
import { WorkerStore } from "../src/worker-store";
import { prepareUserInput } from "../src/user-input-preparation";
import { PendingInputStore } from "../src/pending-input-store";
import { PendingInputStorageError } from "../src/pending-input-contract";
import { dispatchSource } from "../src/pending-input-codec";
import { isPendingInputSnapshot } from "../shared/conversation/pending-input-contract";
import { legacyProfileId } from "../src/agent-profiles-contract";
import { WorkspaceError } from "../src/workspace";
import type { NativeQueuedHandoffAdmissionContext, PreparedAdmissionContext, PreparedAdmissionOptions, PreparedAdmissionResult } from "../src/prepared-input-admission";
import type { DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import type { DispatchLifecycle } from "../src/harness-dispatch";
import type { Session } from "../src/history";
import { discoverRepository, initializeRepository } from "sane-core/server";
import * as repository from "sane-core/server";

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
  const recipe = { version: 2, target: "browser", format: "esm", naming: "app.[ext]", minify: true, define: { "process.env.NODE_ENV": '"production"' } };
  const inputs = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])), $recipe: hash(JSON.stringify(recipe)), $bun: hash(Bun.version) }).sort(([a], [b]) => a.localeCompare(b)));
  const generation = crypto.randomUUID(), assets = join(packageDir, "public", "assets"), dir = join(assets, generation), js = "// offline runtime fixture\n";
  mkdirSync(dir, { recursive: true });
  const outputs = { "app.js": js, "push-worker.js": "// offline push worker fixture\n" };
  for (const [name, value] of Object.entries(outputs)) writeFileSync(join(dir, name), value);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ format: "sane-app-assets", version: 1, generation, fingerprint: hash(JSON.stringify(inputs)), inputs, outputs: Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, hash(value)])) }));
  writeFileSync(join(assets, "current.json"), JSON.stringify({ format: "sane-app-assets-current", version: 1, generation }));
}

function startupFixture(name: string): Options {
  const packageDir = join(root, `startup-${name}-installation`), isolatedDataDir = join(root, `startup-${name}-data`);
  fixtureAssets(packageDir);
  const selected = { ...options, packageDir, dataDir: isolatedDataDir, port: 0 };
  const installation = acquireInstallation(validateOwnershipPaths(packageDir, isolatedDataDir), { phase: "setup" });
  let data: OwnershipHandle | undefined;
  try { data = acquireData(installation, { phase: "setup", createDataParent: true }); initializeAppStore(isolatedDataDir, selected.nativeSources); }
  finally { try { data?.release(); } finally { installation.release(); } }
  return selected;
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
      return Response.json({ data: { id: input.id, time: { created: time }, ...(input.delivery === "queue" ? { sessionID: match![1], type: "user", delivery: "queue" } : {}) } });
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
function queueWire(session: Session, text = "phase3 waiting input", requestId = crypto.randomUUID()) {
  return { version: 1, requestId, conversationId: session.sessionId, text,
    source: { harnessId: session.harness!, conversationId: session.sessionId, authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId!, cwd: session.cwd },
    configuration: { cwd: session.cwd, profileId: session.profileId ?? legacyProfileId(session.harness!, session.agent), ...(session.model === undefined ? {} : { model: session.model }), ...(session.effort === undefined ? {} : { effort: session.effort }), ...(session.agent === undefined ? {} : { agent: session.agent }) } };
}
async function queueSession(harness: Harness = "claude-code", initialized = false) {
  await login();
  let cwd: string | undefined;
  if (initialized) {
    cwd = join(root, `fifo-repo-${crypto.randomUUID()}`); mkdirSync(cwd);
    expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
    const registered = await api("/api/workspaces", { cwd }); expect(registered.status).toBe(201);
    expect((await api(`/api/workstreams/init?workspaceId=${registered.body.workspaceId}`, {})).body.state).toBe("ready");
  }
  const created = await api("/api/sessions", { prompt: "phase3 offline queue seed", harness, ...(cwd ? { cwd } : {}) }); expect(created.status).toBe(202); await waitIdle(created.body.sessionId);
  return disk("metadata.json").sessions.find((s: Session) => s.sessionId === created.body.sessionId) as Session;
}
const queuePath = (id: string) => `/api/sessions/${id}/pending-inputs`;
async function isolatedApi(running: Awaited<ReturnType<typeof start>>, path: string, input?: unknown, token = "") {
  const res = await fetch(`${running.origin}${path}`, { method: input === undefined ? "GET" : "POST", headers: { origin: running.origin, "content-type": "application/json", ...(token ? { cookie: token } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.json() as any, cookie: res.headers.get("set-cookie")?.split(";")[0] };
}
async function isolatedLogin(running: Awaited<ReturnType<typeof start>>) { return (await isolatedApi(running, "/api/login", { password: PASSWORD })).cookie!; }
async function isolatedQueueSeed(name: string, initialized: boolean, harness: Harness = "claude-code") {
  const selected = startupFixture(name), cwd = join(root, `${name}-repository`); mkdirSync(cwd);
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  const running = await start({ ...selected, cwd }), token = await isolatedLogin(running);
  const registered = await isolatedApi(running, "/api/workspaces", { cwd }, token);
  if (initialized) expect((await isolatedApi(running, `/api/workstreams/init?workspaceId=${registered.body.workspaceId}`, {}, token)).body.state).toBe("ready");
  const created = await isolatedApi(running, "/api/sessions", { prompt: "offline repository queue classification seed", cwd, harness }, token);
  expect(created.status).toBe(202);
  await until("repository queue seed settled", async () => JSON.parse(readFileSync(join(selected.dataDir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === created.body.runId)?.status === "completed" || undefined);
  const session = JSON.parse(readFileSync(join(selected.dataDir, "metadata.json"), "utf8")).sessions[0] as Session;
  return { selected, running, token, session, discovery: discoverRepository(cwd) };
}
async function closeStorageFailedFixture(f: Awaited<ReturnType<typeof isolatedQueueSeed>>) {
  await expect(f.running.close()).rejects.toThrow("ownership retained");
  const paths = validateOwnershipPaths(f.selected.packageDir!, f.selected.dataDir);
  for (const lock of [paths.installationLock, paths.dataLock!]) expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).phase).toBe("retained");
  // No automatic reconciliation/restart. These test-owned sentinels survive
  // until afterAll explicitly disposes the entire closed, isolated fixture.
}
async function preparedFor(sessionId: string, prompt = "offline explicit prepared input", selectedDataDir = dataDir, selectedCwd = repoDir) {
  const read = (name: string) => JSON.parse(readFileSync(join(selectedDataDir, name), "utf8"));
  const metadata = read("metadata.json"), session = metadata.sessions.find((s: Session) => s.sessionId === sessionId);
  return prepareUserInput({ sessionId, prompt }, {
    profiles: read("agents.json"), getSession: id => metadata.sessions.find((s: Session) => s.sessionId === id), defaultCwd: selectedCwd,
    conversationId: () => crypto.randomUUID(), sourceAuthorityId: () => session.authorityId,
    selectedDirectory: async () => selectedCwd, ensureDirectory: async () => {}, validateOpenCodeModel: () => {},
    resolveOpenCodeLaunch: async () => { throw new Error("Resume must not resolve native launch"); },
  });
}
function admissionContext(patch: Partial<PreparedAdmissionContext> = {}): PreparedAdmissionContext {
  return { intent: { kind: "user-prompt", requestId: crypto.randomUUID() }, origin: "user", runId: crypto.randomUUID(), nativeCommandId: `msg_${crypto.randomUUID().replaceAll("-", "")}`, delivery: "idle-only", ...patch };
}
/** Live in-memory claimed-head capability, independent of the unwired durable
 * consumer. Wire values alone do not authorize the native boundary. */
function handoffClaim(session: Session) {
  const expected: DispatchIdentity = Object.freeze({ runId: crypto.randomUUID(), nativeCommandId: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    requestId: crypto.randomUUID(), source: Object.freeze({ harnessId: session.harness!, sessionId: session.sessionId, authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId!, cwd: session.cwd }) });
  let valid = true, linked = false;
  const hooks: string[] = [], outcomes: DispatchSubmissionEvidence[] = [];
  const assertIdentity = (identity: DispatchIdentity) => { expect(identity).toEqual(expected); if (!valid) throw new WorkstreamAdapterError(409, "claim-invalidated", "Claim invalidated"); };
  const context: NativeQueuedHandoffAdmissionContext = {
    intent: { kind: "user-prompt", requestId: expected.requestId! }, origin: "queued-user", delivery: "native-queued-handoff",
    runId: expected.runId, nativeCommandId: expected.nativeCommandId!,
    validate: identity => { assertIdentity(identity); hooks.push("validate"); },
    link: identity => { assertIdentity(identity); expect(linked).toBe(false); linked = true; hooks.push("link"); },
    evidence: {
      beforeNative: evidence => { const { submission, nativeAcceptance, ...identity } = evidence; assertIdentity(identity); expect(linked).toBe(true); expect(hooks).toContain("publish"); hooks.push("native"); },
      outcome: evidence => { const { submission, nativeAcceptance, ...identity } = evidence; assertIdentity(identity); outcomes.push(evidence); },
    },
  };
  return { context, expected, hooks, outcomes, invalidate: () => { valid = false; } };
}
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
    // Test-owned launch artifacts only; never reads or edits installed context.
    mkdirSync(join(profileRoot, "sane-agent-settings")); mkdirSync(join(profileRoot, "agents"));
    writeFileSync(join(profileRoot, "sane-agent-settings", "sane-assistant-engineering.settings.json"), JSON.stringify({ permissions: { allow: [], deny: [], ask: [] } }));
    writeFileSync(join(profileRoot, "agents", "sane-assistant-engineering.md"), "Offline fake engineering fixture; no installed/native model is invoked.\n");
    if (await Bun.spawn(["git", "init", repoDir], { stdout: "ignore", stderr: "ignore" }).exited !== 0) throw new Error("fixture git init failed");
    process.env.CLAUDE_CONFIG_DIR = profileRoot; process.env.SANE_APP_PASSWORD = PASSWORD;
    // An ambient explicit token must never override registration credentials.
    process.env.OPENCODE_TOKEN = "must-not-be-used";
    native = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fakeNative });
    writeFileSync(registrationFile, JSON.stringify({ id: "offline-runtime-fixture", version: "2.0.18", pid: process.pid, url: `http://127.0.0.1:${native.port}`, password: nativePassword }));
    const stub = join(root, "claude-stub.mjs");
    writeFileSync(stub, [
      `#!${process.execPath}`,
      `import { appendFileSync, existsSync } from "node:fs";`,
      `const args = process.argv.slice(2), prompt = await Bun.stdin.text();`,
      `const i = args.findIndex(a => a === "--session-id" || a === "--resume"), session_id = args[i + 1];`,
      `const payload = { hook_event_name: "UserPromptSubmit", session_id, prompt };`,
      `const probe = async (secret, value, event = "UserPromptSubmit") => { const r = await fetch(process.env.CC_WEB_HOOK_URL + "/hooks/" + event, { method: "POST", headers: { "content-type": "application/json", "x-cc-web-secret": secret, host: "untrusted.invalid", origin: "https://untrusted.invalid" }, body: JSON.stringify({ runId: process.env.CC_WEB_RUN_ID, payload: value }), signal: AbortSignal.timeout(5000) }); return r.status; };`,
      `const hookStatuses = [await probe("wrong", payload), await probe(process.env.CC_WEB_HOOK_SECRET, { ...payload, session_id: "wrong" }), await probe(process.env.CC_WEB_HOOK_SECRET, { ...payload, hook_event_name: "Stop" }), await probe(process.env.CC_WEB_HOOK_SECRET, payload)];`,
      `appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify({ args, prompt, cwd: process.cwd(), profileRoot: process.env.CLAUDE_CONFIG_DIR, runId: process.env.CC_WEB_RUN_ID, hookStatuses, leakedPassword: process.env.SANE_APP_PASSWORD ?? null, leakedToken: process.env.OPENCODE_TOKEN ?? null }) + "\\n");`,
      `console.log(JSON.stringify({ type: "system", subtype: "init", session_id }));`,
      `console.log(JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), session_id, message: { role: "assistant", content: [{ type: "text", text: "offline Claude answer: " + prompt }] } }));`,
      `console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id, result: "offline Claude OK" }));`,
      `if (prompt.startsWith("hold for Claude followup")) { await probe(process.env.CC_WEB_HOOK_SECRET, { hook_event_name: "Stop", session_id }, "Stop"); while (!existsSync(${JSON.stringify(join(root, "claude-release-"))} + process.env.CC_WEB_RUN_ID)) await Bun.sleep(20); }`,
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

  test("coordinator arbitrates awaited user admission against another user and idle-only operations", async () => {
    const session = await fixtureSession("opencode"), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const associate = CatalogService.prototype.associate;
    const mock = spyOn(CatalogService.prototype, "associate").mockImplementation(async function(this: CatalogService, id, cwd, workspaceId, worktreeId) {
      if (id === session.sessionId) { entered.resolve(); await gate.promise; }
      return associate.call(this, id, cwd, workspaceId, worktreeId);
    });
    const before = sideEffects();
    const first = api("/api/sessions", { sessionId: session.sessionId, prompt: "offline lease winner" });
    try {
      await entered.promise;
      const other = await api("/api/sessions", { sessionId: session.sessionId, prompt: "offline lease loser" });
      expect(other.status).toBe(409); expect(other.body.code).toBe("conversation-busy");
      expect((await api(`/api/sessions/${session.sessionId}/compact`, { requestId: crypto.randomUUID() })).status).toBe(409);
      expect((await api(`/api/sessions/${session.sessionId}/enroll`, {})).status).toBe(409);
      expect(sideEffects()).toEqual(before);
    } finally { gate.resolve(); mock.mockRestore(); }
    expect((await first).status).toBe(202);
    await waitIdle(session.sessionId);
  }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const) test(`prepared backend admission exposes stable IDs, exact request lease and independent origin (${harness})`, async () => {
    if (harness === "claude-code") {
      const baseline = await api("/api/sessions", { harness, prompt: "offline explicit prepared baseline" }); expect(baseline.status).toBe(202); await waitIdle(baseline.body.sessionId);
    }
    const session = await fixtureSession(harness), prepared = await preparedFor(session.sessionId), outcomes: DispatchSubmissionEvidence[] = [], hooks: string[] = [];
    const context = admissionContext({ origin: harness === "claude-code" ? "queued-user" : "user", ...(harness === "claude-code" ? { nativeCommandId: undefined } : {}),
      validate: identity => { expect(identity.runId).toBe(context.runId); expect(identity.requestId).toBe(context.intent.requestId); hooks.push("validate"); },
      link: identity => { hooks.push("link"); expect(identity.runId).toBe(context.runId); expect(disk("metadata.json").runs.some((r: any) => r.runId === context.runId)).toBe(false); },
      evidence: { beforeNative: value => { hooks.push("native"); expect(hooks).toContain("link"); expect(hooks).toContain("publish"); expect(value.submission).toBe("attempted"); }, outcome: value => outcomes.push(value) },
    });
    const wrong = app!.preparedInput.reserve({ ...context.intent, requestId: "wrong-request" }, session.sessionId);
    try { await expect(app!.preparedInput.admit(prepared, wrong, { context })).rejects.toThrow("different operation"); }
    finally { app!.preparedInput.release(wrong); }
    const lease = app!.preparedInput.reserve(context.intent, session.sessionId);
    let result, published: DispatchLifecycle | undefined;
    const service = harness === "opencode" ? OpenCodeRunService.prototype : ClaudeRunService.prototype;
    const method = harness === "opencode" ? "executeNative" : "execute";
    const execute = (service as any)[method];
    const monitor = spyOn(service as any, method).mockImplementation(function(this: unknown, ...args: any[]) { expect(published?.owner).toBe(args[0]); return execute.apply(this, args); });
    try { result = await app!.preparedInput.admit(prepared, lease, { context, publish: lifecycle => { expect(published).toBeUndefined(); published = lifecycle; hooks.push("publish"); expect(lifecycle.owner.run.runId).toBe(context.runId); } }); }
    finally { app!.preparedInput.release(lease); }
    expect(result.runId).toBe(context.runId); expect(result.lifecycle.owner.run.queuedFollowupId).toBeUndefined();
    await result.lifecycle.done;
    monitor.mockRestore(); expect(result.lifecycle).toBe(published!); expect(hooks.filter(h => h === "publish")).toHaveLength(1);
    expect(result.lifecycle.submissionEvidence()).toMatchObject({ runId: context.runId, requestId: context.intent.requestId, submission: "submitted", nativeAcceptance: harness === "opencode" ? "accepted" : "unknown" });
    expect(hooks.filter(h => h === "link")).toHaveLength(1); expect(hooks.filter(h => h === "native")).toHaveLength(1);
    expect(outcomes.every(o => o.runId === context.runId && o.source.sessionId === session.sessionId && o.nativeCommandId === (context.nativeCommandId ?? null))).toBe(true);
    expect(await result.lifecycle.successfulSettlement()).toEqual({ ready: true });
    const count = prompts().length, repeat = app!.preparedInput.reserve(context.intent, session.sessionId);
    try { await expect(app!.preparedInput.admit(prepared, repeat, { context })).rejects.toThrow("identity is already in use"); }
    finally { app!.preparedInput.release(repeat); }
    expect(prompts()).toHaveLength(count);
  }, TIMEOUT);

  for (const boundary of ["preflight", "link", "native"] as const) test(`invalidated prepared claim at ${boundary} never sends or creates an extra owner`, async () => {
    const session = await fixtureSession("opencode"), prepared = await preparedFor(session.sessionId), before = sideEffects(), promptCount = prompts().length; let valid = true;
    const context = admissionContext({ validate: () => { if (!valid) throw new WorkstreamAdapterError(409, "claim-invalidated", "Claim invalidated"); }, link: () => { if (boundary === "link") throw new WorkstreamAdapterError(409, "claim-invalidated", "Claim invalidated"); } });
    const lease = app!.preparedInput.reserve(context.intent, session.sessionId);
    const associate = CatalogService.prototype.associate, execute = OpenCodeRunService.prototype.executeNative;
    const preflight = boundary === "preflight" ? spyOn(CatalogService.prototype, "associate").mockImplementation(async function(this: CatalogService, ...args) { const result = await associate.apply(this, args); if (args[0] === session.sessionId) valid = false; return result; }) : undefined;
    const nativeGate = boundary === "native" ? spyOn(OpenCodeRunService.prototype, "executeNative").mockImplementation(async function(this: OpenCodeRunService, ...args) { if (args[0].run.runId === context.runId) valid = false; return execute.apply(this, args); }) : undefined;
    try {
      if (boundary !== "native") await expect(app!.preparedInput.admit(prepared, lease, { context })).rejects.toThrow("Claim invalidated");
      else {
        const result = await app!.preparedInput.admit(prepared, lease, { context }); await result.lifecycle.done;
        expect(result.lifecycle.submissionEvidence().submission).toBe("not-submitted"); expect(result.lifecycle.owner.nativeDispatched).toBe(false);
      }
    } finally { app!.preparedInput.release(lease); preflight?.mockRestore(); nativeGate?.mockRestore(); }
    expect(prompts()).toHaveLength(promptCount);
    expect(disk("metadata.json").runs.length).toBe(before.runs + (boundary === "native" ? 1 : 0));
    expect((await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === session.sessionId).availability.canSend).toBe(true);
  }, TIMEOUT);

  test("bare OC queued-user is refused and idle-only prepared input refuses native activity without fallback", async () => {
    const session = await fixtureSession("opencode"), prepared = await preparedFor(session.sessionId), before = sideEffects(), fake = sessions.get(session.nativeSessionId)!;
    for (const queued of [true, false]) {
      const context = admissionContext({ origin: queued ? "queued-user" : "user" }), lease = app!.preparedInput.reserve(context.intent, session.sessionId);
      fake.active = true;
      try { await expect(app!.preparedInput.admit(prepared, lease, { context })).rejects.toThrow(queued ? "explicit native-queued-handoff policy" : "Idle-only"); }
      finally { fake.active = false; app!.preparedInput.release(lease); }
    }
    expect(sideEffects()).toEqual(before);
  }, TIMEOUT);

  for (const foreignRace of [false, true]) test(`strict prepared OC handoff queues on idle and permits foreign activity after linked claim (${foreignRace})`, async () => {
    const session = await queueSession("opencode"), prepared = await preparedFor(session.sessionId), claim = handoffClaim(session);
    const fake = sessions.get(session.nativeSessionId!)!, before = mutations().length, link = claim.context.link;
    const context = { ...claim.context, link: (identity: DispatchIdentity) => { link(identity); if (foreignRace) fake.active = true; } };
    const lease = app!.preparedInput.reserve(context.intent, session.sessionId);
    let published: DispatchLifecycle | undefined, result!: PreparedAdmissionResult;
    const activity = OpenCodeAdapter.prototype.activity, idle = OpenCodeAdapter.prototype.assertIdle;
    const activityGuard = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(function(this: OpenCodeAdapter, ...args) { if (args[0] === session.nativeSessionId) throw new Error("Post-claim activity guard is forbidden"); return activity.apply(this, args); });
    const idleGuard = spyOn(OpenCodeAdapter.prototype, "assertIdle").mockImplementation(function(this: OpenCodeAdapter, ...args) { if (args[0] === session.nativeSessionId) throw new Error("Post-claim idle guard is forbidden"); return idle.apply(this, args); });
    try {
      result = await app!.preparedInput.admit(prepared, lease, { context, publish: lifecycle => {
        expect(published).toBeUndefined(); published = lifecycle; claim.hooks.push("publish");
        expect(mutations()).toHaveLength(before);
        expect(lifecycle.owner).toMatchObject({ nativeDeliveryPolicy: "native-queued-handoff", nativeQueuedHandoff: { ...claim.expected, origin: "queued-user" }, run: { runId: context.runId, nativeCommandId: context.nativeCommandId, nativeDelivery: "queue" } });
      } });
      expect(result.lifecycle).toBe(published!);
      await until("strict queue acknowledgement", async () => storedRun(result.runId)?.nativePhase === "accepted" || undefined);
      const ownedMutations = mutations().slice(before).filter(call => call.path.startsWith(`/api/session/${session.nativeSessionId}/`));
      expect(ownedMutations).toHaveLength(1); expect(ownedMutations[0]).toMatchObject({ method: "POST", body: { id: context.nativeCommandId, delivery: "queue", text: prepared.prompt } });
      if (foreignRace) {
        expect(fake.inbox.some(input => input.id === context.nativeCommandId)).toBe(true);
        expect(result.lifecycle.owner.run.status).toBe("running");
        consumeQueuedInput(session.nativeSessionId!, context.nativeCommandId); complete(session.nativeSessionId!);
      }
      await result.lifecycle.done;
      expect(result.lifecycle.submissionEvidence()).toMatchObject({ ...claim.expected, submission: "submitted", nativeAcceptance: "accepted" });
      expect(claim.hooks.filter(hook => hook === "link")).toHaveLength(1); expect(claim.hooks.filter(hook => hook === "publish")).toHaveLength(1); expect(claim.hooks.filter(hook => hook === "native")).toHaveLength(1);
    } finally { app!.preparedInput.release(lease); activityGuard.mockRestore(); idleGuard.mockRestore(); fake.active = false; }
    expect(await result!.lifecycle.successfulSettlement()).toEqual({ ready: true });
  }, TIMEOUT);

  test("strict prepared handoff rejects incomplete capabilities, policy, origin and configuration before native preparation/publication", async () => {
    const session = await queueSession("opencode"), prepared = await preparedFor(session.sessionId), before = sideEffects();
    const patches = [
      { delivery: undefined }, { delivery: "unrecognized" }, { origin: "user" }, { origin: "invalid" },
      { intent: { kind: "compact", requestId: crypto.randomUUID() } }, { intent: { kind: "user-prompt" } },
      { runId: undefined }, { nativeCommandId: undefined }, { validate: undefined }, { link: undefined },
      { evidence: undefined }, { evidence: { beforeNative: () => {} } }, { evidence: { outcome: () => {} } },
    ];
    const preflight = spyOn(OpenCodeAdapter.prototype, "preflightNativeSession");
    let publications = 0;
    try {
      for (const patch of patches) {
        const claim = handoffClaim(session), context = { ...claim.context, ...patch } as PreparedAdmissionContext;
        const lease = app!.preparedInput.reserve(claim.context.intent, session.sessionId);
        try { await expect(app!.preparedInput.admit(prepared, lease, { context, publish: () => { publications++; } })).rejects.toMatchObject({ status: 409 }); }
        finally { app!.preparedInput.release(lease); }
        expect(claim.hooks).toEqual([]);
      }
      for (const changed of [
        { ...prepared, configuration: { ...prepared.configuration, model: "fixture/changed" } },
        { ...prepared, normalized: { ...prepared.normalized, effort: "changed" } },
        { ...prepared, stagedUpgrade: { id: "different-profile" } },
        { ...prepared, resume: false },
        { ...prepared, binding: { ...prepared.binding, harness: "claude-code" } },
      ]) {
        const claim = handoffClaim(session), lease = app!.preparedInput.reserve(claim.context.intent, session.sessionId);
        try { await expect(app!.preparedInput.admit(changed as typeof prepared, lease, { context: claim.context, publish: () => { publications++; } })).rejects.toMatchObject({ status: 409 }); }
        finally { app!.preparedInput.release(lease); }
      }
      expect(publications).toBe(0); expect(preflight).not.toHaveBeenCalled(); expect(sideEffects()).toEqual(before);
    } finally { preflight.mockRestore(); }
    expect((await api("/api/sessions")).body.availability.canSend).toBe(true);
  }, TIMEOUT);

  test("strict handoff copies IDs, intent, policy, hooks and synchronous publisher before awaited preflight", async () => {
    const session = await queueSession("opencode"), prepared = await preparedFor(session.sessionId), claim = handoffClaim(session);
    const context = structuredClone({ ...claim.context, validate: undefined, link: undefined, evidence: undefined });
    Object.assign(context, { validate: claim.context.validate, link: claim.context.link, evidence: { ...claim.context.evidence } });
    let published: DispatchLifecycle | undefined;
    const inputOptions: PreparedAdmissionOptions = { context: context as PreparedAdmissionContext, publish: lifecycle => { published = lifecycle; claim.hooks.push("publish"); } };
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), associate = CatalogService.prototype.associate;
    const wait = spyOn(CatalogService.prototype, "associate").mockImplementation(async function(this: CatalogService, ...args) { if (args[0] === session.sessionId) { entered.resolve(); await gate.promise; } return associate.apply(this, args); });
    const lease = app!.preparedInput.reserve(claim.context.intent, session.sessionId), pending = app!.preparedInput.admit(prepared, lease, inputOptions);
    try {
      await entered.promise;
      Object.assign(context, { runId: crypto.randomUUID(), nativeCommandId: "msg_mutated", delivery: "idle-only", origin: "user", validate: () => { throw new Error("Mutable validation used"); }, link: () => { throw new Error("Mutable link used"); } });
      (context.intent as { requestId: string }).requestId = "mutated-request";
      (context as any).evidence.beforeNative = () => { throw new Error("Mutable evidence used"); };
      inputOptions.publish = () => { throw new Error("Mutable publisher used"); };
      gate.resolve(); const result = await pending;
      expect(result.lifecycle).toBe(published!); await result.lifecycle.done;
      expect(result.lifecycle.submissionEvidence()).toMatchObject({ ...claim.expected, submission: "submitted", nativeAcceptance: "accepted" });
    } finally { gate.resolve(); wait.mockRestore(); app!.preparedInput.release(lease); }
  }, TIMEOUT);

  for (const boundary of ["source", "claim", "link"] as const) test(`strict handoff ${boundary} refusal before installation remains a domain error without storage poison`, async () => {
    const session = await queueSession("opencode"), prepared = await preparedFor(session.sessionId), claim = handoffClaim(session);
    const before = sideEffects(), fake = sessions.get(session.nativeSessionId!)!, location = fake.info.location;
    const preflight = OpenCodeAdapter.prototype.preflightNativeSession;
    const gate = spyOn(OpenCodeAdapter.prototype, "preflightNativeSession").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
      await preflight.apply(this, args); if (args[0] === session.nativeSessionId && boundary === "claim") claim.invalidate();
    });
    const context = { ...claim.context, ...(boundary === "link" ? { link: () => { throw new WorkstreamAdapterError(409, "claim-invalidated", "Claim invalidated before link"); } } : {}) };
    const lease = app!.preparedInput.reserve(context.intent, session.sessionId); let publications = 0;
    if (boundary === "source") fake.info.location = { directory: join(root, "wrong-claimed-directory") };
    try {
      await expect(app!.preparedInput.admit(prepared, lease, { context, publish: () => { publications++; } })).rejects.toMatchObject({ status: 409, code: boundary === "source" ? "dispatch-source-mismatch" : "claim-invalidated" });
      expect(publications).toBe(0); expect(sideEffects()).toEqual(before); expect(claim.hooks).not.toContain("link");
    } finally { app!.preparedInput.release(lease); gate.mockRestore(); fake.info.location = location; }
    expect((await api("/api/sessions")).body.availability.canSend).toBe(true);
  }, TIMEOUT);

  test("published strict handoff survives ready(false) and lost ACK without replay, accepting only exact native inbox evidence", async () => {
    const session = await queueSession("opencode"), prepared = await preparedFor(session.sessionId), claim = handoffClaim(session), fake = sessions.get(session.nativeSessionId!)!;
    const context = { ...claim.context, link: (identity: DispatchIdentity) => { claim.context.link(identity); fake.active = true; } };
    const execute = OpenCodeRunService.prototype.executeNative, prompt = OpenCodeAdapter.prototype.promptQueuedHandoff;
    let published: DispatchLifecycle | undefined;
    const unconfirmed = spyOn(OpenCodeRunService.prototype, "executeNative").mockImplementation(function(this: OpenCodeRunService, owner, text, resume, ready) { expect(published?.owner).toBe(owner); ready(false); return execute.call(this, owner, text, resume, ready); });
    const lostAck = spyOn(OpenCodeAdapter.prototype, "promptQueuedHandoff").mockImplementation(async function(this: OpenCodeAdapter, ...args) { await prompt.apply(this, args); throw new OpenCodeUnavailableError("Offline lost queue ACK"); });
    const lease = app!.preparedInput.reserve(context.intent, session.sessionId), before = prompts().length;
    try {
      const result = await app!.preparedInput.admit(prepared, lease, { context, publish: lifecycle => { published = lifecycle; claim.hooks.push("publish"); } });
      expect(result.lifecycle).toBe(published!); expect(await result.lifecycle.admission).toEqual({ state: "unconfirmed" });
      await until("exact queue evidence recovered read-only", async () => result.lifecycle.submissionEvidence().nativeAcceptance === "accepted" || undefined);
      expect(prompts()).toHaveLength(before + 1);
      consumeQueuedInput(session.nativeSessionId!, context.nativeCommandId); complete(session.nativeSessionId!);
      await result.lifecycle.done; expect(prompts()).toHaveLength(before + 1);
      expect(result.lifecycle.submissionEvidence()).toMatchObject({ submission: "submitted", nativeAcceptance: "accepted" });
      expect(await result.lifecycle.successfulSettlement()).toMatchObject({ ready: false });
      expect(claim.outcomes.some(evidence => evidence.submission === "unknown")).toBe(true);
    } finally { app!.preparedInput.release(lease); unconfirmed.mockRestore(); lostAck.mockRestore(); fake.active = false; }
  }, TIMEOUT);

  for (const harness of ["opencode", "claude-code"] as const) for (const asyncPublisher of [false, true]) test(`publisher ${asyncPublisher ? "Promise" : "throw"} withholds ${harness} execution and retains installed owner/global locks`, async () => {
    const f = await isolatedQueueSeed(`publisher-${harness}-${asyncPublisher}`, false, harness), prepared = await preparedFor(f.session.sessionId, "offline publication refusal", f.selected.dataDir, f.session.cwd);
    const claim = harness === "opencode" ? handoffClaim(f.session) : undefined;
    const context = claim?.context ?? admissionContext({ nativeCommandId: undefined, origin: "queued-user" });
    const lease = f.running.preparedInput.reserve(context.intent, f.session.sessionId), before = mutations().length, cliBefore = invocations().length;
    const nativeExecute = spyOn(OpenCodeRunService.prototype, "executeNative"), claudeExecute = spyOn(ClaudeRunService.prototype, "execute");
    let published: DispatchLifecycle | undefined, count = 0;
    try {
      await expect(f.running.preparedInput.admit(prepared, lease, { context, publish: lifecycle => {
        published = lifecycle; count++; claim?.hooks.push("publish");
        if (asyncPublisher) return Promise.resolve();
        throw new Error("Offline publisher partial failure");
      } })).rejects.toThrow(asyncPublisher ? "synchronously" : "publisher partial failure");
      expect(published).toBeDefined(); expect(count).toBe(1); await published!.done;
      expect(published!.owner.settled).toBe(true); expect(published!.owner.nativeDispatched).toBe(false);
      expect(published!.submissionEvidence().submission).toBe("not-submitted");
      expect(nativeExecute).not.toHaveBeenCalled(); expect(claudeExecute).not.toHaveBeenCalled();
      expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(cliBefore);
      expect((await isolatedApi(f.running, "/api/sessions", { sessionId: f.session.sessionId, prompt: "must retain lock" }, f.token)).body.code).toBe("storage-unavailable");
      expect(await published!.successfulSettlement()).toMatchObject({ ready: false });
    } finally { f.running.preparedInput.release(lease); nativeExecute.mockRestore(); claudeExecute.mockRestore(); await closeStorageFailedFixture(f); }
  }, TIMEOUT);

  test("read-only OC settlement timeout does not poison bridge storage and fresh exact proof works", async () => {
    const session = await queueSession("opencode"), prepared = await preparedFor(session.sessionId), context = admissionContext(), lease = app!.preparedInput.reserve(context.intent, session.sessionId);
    let result;
    try { result = await app!.preparedInput.admit(prepared, lease, { context }); } finally { app!.preparedInput.release(lease); }
    await result.lifecycle.done;
    const claude = await api("/api/sessions", { harness: "claude-code", prompt: "hold for Claude followup read-only OC proof timeout" }); expect(claude.status).toBe(202);
    const snapshot = OpenCodeAdapter.prototype.snapshot;
    const timeout = spyOn(OpenCodeAdapter.prototype, "snapshot").mockImplementation(async () => { throw new OpenCodeUnavailableError("offline read-only timeout"); });
    try {
      expect(await result.lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "dispatch-proof-unavailable" });
      timeout.mockRestore();
      expect(await result.lifecycle.successfulSettlement()).toEqual({ ready: true });
      expect((await api("/api/sessions")).body.availability.canSend).toBe(true);
      expect(storedRun(claude.body.runId).status).toBe("running");
      expect(OpenCodeAdapter.prototype.snapshot).toBe(snapshot);
    } finally { timeout.mockRestore(); writeFileSync(join(root, `claude-release-${claude.body.runId}`), "release"); await waitIdle(claude.body.sessionId); }
  }, TIMEOUT);

  test("read-only OC exact proof denies native directory drift as source mismatch without poisoning storage", async () => {
    const session = await queueSession("opencode"), prepared = await preparedFor(session.sessionId), context = admissionContext(), lease = app!.preparedInput.reserve(context.intent, session.sessionId);
    let result;
    try { result = await app!.preparedInput.admit(prepared, lease, { context }); } finally { app!.preparedInput.release(lease); }
    await result.lifecycle.done;
    const fake = sessions.get(session.nativeSessionId!)!, location = fake.info.location, before = mutations().length;
    fake.info.location = { directory: join(root, "different-native-source") };
    try {
      expect(await result.lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "dispatch-source-mismatch" });
      const source = options.nativeSources!.oc;
      if (source.harness !== "oc" || source.kind !== "local-registration") throw new Error("Expected local OpenCode registration source");
      await expect(new OpenCodeAdapter(undefined, undefined, source.registrationFile).activity(session.nativeSessionId!, session.cwd)).rejects.toBeInstanceOf(OpenCodeSourceMismatchError);
      expect((await api("/api/sessions")).body.availability.canSend).toBe(true);
      expect(mutations()).toHaveLength(before);
    } finally { fake.info.location = location; }
    expect(await result.lifecycle.successfulSettlement()).toEqual({ ready: true });
  }, TIMEOUT);

  for (const status of [409, 503]) test(`generic OC observation error ${status} remains an invariant failure, not source mismatch or proof unavailability`, async () => {
    const f = await isolatedQueueSeed(`oc-proof-invariant-${status}`, false, "opencode"), prepared = await preparedFor(f.session.sessionId, "offline invariant proof", f.selected.dataDir, f.session.cwd);
    const context = admissionContext(), lease = f.running.preparedInput.reserve(context.intent, f.session.sessionId);
    let result;
    try { result = await f.running.preparedInput.admit(prepared, lease, { context }); } finally { f.running.preparedInput.release(lease); }
    await result.lifecycle.done;
    const observation = spyOn(OpenCodeAdapter.prototype, "snapshot").mockImplementation(async () => { throw new OpenCodeError("Offline unexpected observation contract", status); });
    try {
      expect(await result.lifecycle.successfulSettlement()).toMatchObject({ ready: false, code: "reconciliation-required" });
      expect((await isolatedApi(f.running, "/api/sessions", { prompt: "must not bypass proof invariant" }, f.token)).body.code).toBe("storage-unavailable");
    } finally { observation.mockRestore(); await closeStorageFailedFixture(f); }
  }, TIMEOUT);

  test("listeners reject user and native admission while startup worker classification is suspended", async () => {
    const selected = startupFixture("classification-gate"), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), bound: Bun.Server<any>[] = [];
    const serve = Bun.serve, capture = spyOn(Bun, "serve").mockImplementation(((input: any) => { const server = serve(input); bound.push(server); return server; }) as typeof Bun.serve);
    const active = spyOn(WorkerService.prototype, "active").mockImplementation(() => [{ id: "classification-fixture", sessionId: "unknown-worker", runId: "unknown-run", launch: { harness: "opencode" } }] as any);
    const refresh = spyOn(WorkerService.prototype, "refresh").mockImplementation(async value => { entered.resolve(); await gate.promise; return value; });
    const pending = start(selected); let isolated: Awaited<ReturnType<typeof start>> | undefined;
    try {
      await entered.promise;
      const origin = `http://127.0.0.1:${bound[0]!.port}`;
      const loggedIn = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
      const localCookie = loggedIn.headers.get("set-cookie")!.split(";")[0]!;
      const before = mutations().length;
      const response = await fetch(`${origin}/api/sessions`, { method: "POST", headers: { origin, cookie: localCookie, "content-type": "application/json" }, body: JSON.stringify({ harness: "opencode", prompt: "must not launch" }) });
      expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: "startup-classifying" });
      const nativeRecord = JSON.parse(readFileSync(join(selected.dataDir, "native-handoff.json"), "utf8"));
      const nativeResponse = await fetch(nativeRecord.url.replace("/handoffs", "/workers"), { method: "POST", headers: { authorization: `Bearer ${nativeRecord.token}`, "content-type": "application/json" }, body: JSON.stringify({ operation: "start" }) });
      expect(nativeResponse.status).toBe(503); expect(await nativeResponse.json()).toMatchObject({ code: "startup-classifying" });
      expect(mutations()).toHaveLength(before);
      gate.resolve(); isolated = await pending;
      const after = await fetch(`${origin}/api/sessions`, { headers: { cookie: localCookie } });
      expect((await after.json() as any).availability.canSend).toBe(true);
    } finally { gate.resolve(); await pending.then(value => { isolated = value; }, () => {}); await isolated?.close(); refresh.mockRestore(); active.mockRestore(); capture.mockRestore(); }
  }, TIMEOUT);

  test("recovered owner keeps an after-release barrier throughout asynchronous worker refresh, including capacity", async () => {
    const created = await api("/api/sessions", { harness: "opencode", prompt: "hold for recovered worker barrier", cwd: repoDir }); expect(created.status).toBe(202);
    const { sessionId, nativeSessionId, runId } = created.body;
    await until("accepted recovery fixture", async () => storedRun(runId).nativePhase === "accepted" ? true : undefined);
    await app!.close(); app = undefined; complete(nativeSessionId);
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), refreshed = { id: "barrier-worker", runId } as any;
    const getByRun = WorkerStore.prototype.getByRun;
    const worker = spyOn(WorkerStore.prototype, "getByRun").mockImplementation(function(this: WorkerStore, id) { return id === runId ? refreshed : getByRun.call(this, id); });
    const refresh = spyOn(WorkerService.prototype, "refresh").mockImplementation(async value => { expect(value).toBe(refreshed); entered.resolve(); await gate.promise; return value; });
    try {
      app = await start({ ...options, maxConcurrentRuns: 1 }); await login(); await entered.promise;
      const before = mutations().length;
      const same = await api("/api/sessions", { sessionId, prompt: "offline cannot race recovered refresh" });
      expect(same.status).toBe(409); expect(same.body.code).toBe("reconciliation-pending");
      const other = await api("/api/sessions", { harness: "opencode", prompt: "offline no capacity during recovered refresh" });
      expect(other.status).toBe(429); expect(other.body.code).toBe("capacity"); expect(mutations()).toHaveLength(before);
      gate.resolve(); expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
      const next = await api("/api/sessions", { sessionId, prompt: "offline fresh after recovery reconciliation" });
      expect(next.status).toBe(202); await waitIdle(sessionId);
    } finally { gate.resolve(); refresh.mockRestore(); worker.mockRestore(); await app?.close(); app = await start(options); await login(); }
  }, TIMEOUT);

  test("failed recovered-worker refresh retains its barrier and disposable installation/data ownership locks", async () => {
    const selected = startupFixture("failed-recovery-barrier"), paths = validateOwnershipPaths(selected.packageDir!, selected.dataDir);
    let isolated = await start({ ...selected, maxConcurrentRuns: 1 }), localCookie = "";
    const request = async (path: string, input?: unknown) => {
      const response = await fetch(`${isolated.origin}${path}`, { method: input === undefined ? "GET" : "POST", headers: { origin: isolated.origin, cookie: localCookie, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, body: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
    };
    localCookie = (await request("/api/login", { password: PASSWORD })).cookie!;
    const created = await request("/api/sessions", { harness: "opencode", prompt: "hold for failed recovered worker", cwd: repoDir }); expect(created.status).toBe(202);
    const { sessionId, nativeSessionId, runId } = created.body;
    const metadata = () => JSON.parse(readFileSync(join(selected.dataDir, "metadata.json"), "utf8"));
    await until("isolated accepted recovery fixture", async () => metadata().runs.find((r: any) => r.runId === runId)?.nativePhase === "accepted" ? true : undefined);
    await isolated.close(); complete(nativeSessionId);
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), recoveredWorker = { id: "failed-barrier-worker", runId } as any;
    const getByRun = WorkerStore.prototype.getByRun, refreshWorker = WorkerService.prototype.refresh;
    const worker = spyOn(WorkerStore.prototype, "getByRun").mockImplementation(function(this: WorkerStore, id) { return id === runId ? recoveredWorker : getByRun.call(this, id); });
    const refresh = spyOn(WorkerService.prototype, "refresh").mockImplementation(async function(this: WorkerService, value) {
      if (value !== recoveredWorker) return refreshWorker.call(this, value);
      entered.resolve(); await gate.promise; throw new Error("offline worker domain reconciliation failed");
    });
    try {
      isolated = await start({ ...selected, maxConcurrentRuns: 1 }); localCookie = (await request("/api/login", { password: PASSWORD })).cookie!; await entered.promise;
      expect((await request("/api/sessions")).body.sessions.find((s: any) => s.sessionId === sessionId).availability.code).toBe("reconciliation-pending");
      gate.resolve();
      await until("failed recovered reconciliation closed admission", async () => (await request("/api/sessions")).body.availability.code === "storage-unavailable" ? true : undefined);
      expect((await request("/api/sessions", { sessionId, prompt: "must not replay after refresh failure" })).status).toBe(409);
      await expect(isolated.close()).rejects.toThrow("ownership retained");
      expect(() => acquireInstallation(paths, { phase: "starting" })).toThrow();
      expect(JSON.parse(readFileSync(join(paths.installationLock, "owner.json"), "utf8")).phase).toBe("retained");
      expect(JSON.parse(readFileSync(join(paths.dataLock!, "owner.json"), "utf8")).phase).toBe("retained");
    } finally { gate.resolve(); refresh.mockRestore(); worker.mockRestore(); await isolated.close().catch(() => {}); }
  }, TIMEOUT);

  for (const field of ["model", "authorityId"] as const) test(`prepared user admission rejects pinned ${field} edits after async catalog preflight without dispatch`, async () => {
    let live: Session | undefined;
    const execute = OpenCodeRunService.prototype.executeNative;
    const capture = spyOn(OpenCodeRunService.prototype, "executeNative").mockImplementation(async function(this: OpenCodeRunService, ...args) {
      live = (this as unknown as { deps: OpenCodeRunDependencies }).deps.session(args[0].run.sessionId);
      return execute.apply(this, args);
    });
    let created;
    try { created = await api("/api/sessions", { harness: "opencode", prompt: "offline pin baseline" }); await waitIdle(created.body.sessionId); }
    finally { capture.mockRestore(); }
    expect(created.status).toBe(202); expect(live).toBeDefined();
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), prior = live![field];
    const associate = CatalogService.prototype.associate;
    const mock = spyOn(CatalogService.prototype, "associate").mockImplementation(async function(this: CatalogService, id, cwd, workspaceId, worktreeId) {
      if (id === live!.sessionId) { entered.resolve(); await gate.promise; }
      return associate.call(this, id, cwd, workspaceId, worktreeId);
    });
    const before = sideEffects(), pending = api("/api/sessions", { sessionId: live!.sessionId, prompt: "offline must remain unsent" });
    try {
      await entered.promise; live![field] = "changed-during-preflight"; gate.resolve();
      const response = await pending;
      expect(response.status).toBe(409); expect(response.body.error).toContain("configuration changed");
      expect(sideEffects()).toEqual(before);
    } finally { gate.resolve(); mock.mockRestore(); if (prior === undefined) delete live![field]; else live![field] = prior; }
    // The validation refusal did not fail closed or arrange an automatic retry.
    const explicit = await api("/api/sessions", { sessionId: live!.sessionId, prompt: "offline explicit retry" });
    expect(explicit.status).toBe(202); await waitIdle(live!.sessionId);
  }, TIMEOUT);

  test("capacity is deduplicated and the exact predecessor lease preserves only one legacy Claude followup", async () => {
    await app!.close(); app = await start({ ...options, maxConcurrentRuns: 1 }); await login();
    let first: any;
    try {
      const initial = await api("/api/sessions", { harness: "claude-code", prompt: "hold for Claude followup at capacity", model: "offline-claude", effort: "high" });
      expect(initial.status).toBe(202); first = initial.body;
      await until("Claude predecessor stopped turn with live process", async () => {
        const row = (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === first.sessionId);
        return row?.availability.queueAfterRunId === first.runId ? row : undefined;
      });
      expect((await api("/api/sessions", { harness: "opencode", prompt: "offline no spare slot" })).status).toBe(429);
      const queued = await api("/api/sessions", { sessionId: first.sessionId, prompt: "offline exact immutable followup" });
      expect(queued.status).toBe(202); expect(queued.body.queued).toBe(true);
      expect((await api("/api/sessions", { sessionId: first.sessionId, prompt: "offline forbidden second followup" })).status).toBe(409);
      expect((await api(`/api/sessions/${first.sessionId}/compact`, { requestId: crypto.randomUUID() })).status).toBe(409);
      expect((await api("/api/sessions", { harness: "opencode", prompt: "offline reservation still counts once" })).status).toBe(429);
      writeFileSync(join(root, `claude-release-${first.runId}`), "release");
      const settled = await waitIdle(first.sessionId);
      expect(settled.lastStatus).toBe("completed"); expect(settled.lastRunId).not.toBe(first.runId);
      const resumed = invocations().find(row => row.runId === settled.lastRunId);
      expect(resumed.prompt).toBe("offline exact immutable followup");
      expect(flag(resumed.args, "--resume")).toBe(first.nativeSessionId);
      expect(storedRun(settled.lastRunId)).toMatchObject({ model: "offline-claude", effort: "high", queuedFollowupId: queued.body.receipt.requestId });
      expect((await api("/api/sessions", { harness: "opencode", prompt: "offline released capacity" })).status).toBe(202);
    } finally {
      if (first) writeFileSync(join(root, `claude-release-${first.runId}`), "release");
      await app!.close(); app = await start(options); await login();
    }
  }, TIMEOUT);

  test("branch extension reserves both conversations atomically and enforces capacity before native fork", async () => {
    await app!.close(); app = await start({ ...options, maxConcurrentRuns: 1 }); await login();
    try {
      const created = await api("/api/sessions", { harness: "opencode", prompt: "offline branch capacity source" });
      expect(created.status).toBe(202); await waitIdle(created.body.sessionId);
      const before = sideEffects();
      const branch = await api(`/api/sessions/${created.body.sessionId}/branch`, { requestId: crypto.randomUUID(), runId: created.body.runId, prompt: "offline branch must not dispatch", replace: false });
      expect(branch.status).toBe(409); expect(branch.body.error).toContain("capacity reached");
      expect(sideEffects()).toEqual(before);
      expect(branch.body.operation.state).toBe("failed");
      const explicit = await api("/api/sessions", { sessionId: created.body.sessionId, prompt: "offline source reservation released" });
      expect(explicit.status).toBe(202); await waitIdle(created.body.sessionId);
    } finally { await app!.close(); app = await start(options); await login(); }
  }, TIMEOUT);

  test("shutdown closes coordinator admission before awaited preparation can install or submit", async () => {
    const session = await fixtureSession("opencode"), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const associate = CatalogService.prototype.associate;
    const mock = spyOn(CatalogService.prototype, "associate").mockImplementation(async function(this: CatalogService, id, cwd, workspaceId, worktreeId) {
      if (id === session.sessionId) { entered.resolve(); await gate.promise; }
      return associate.call(this, id, cwd, workspaceId, worktreeId);
    });
    const before = sideEffects(), pending = api("/api/sessions", { sessionId: session.sessionId, prompt: "offline shutdown must withhold" });
    try {
      await entered.promise; const close = app!.close(); gate.resolve();
      expect((await pending).status).toBe(409); await close;
      expect(sideEffects()).toEqual(before);
    } finally {
      gate.resolve(); mock.mockRestore(); await app!.close(); app = await start(options); await login();
    }
    expect((await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === session.sessionId).availability.canSend).toBe(true);
  }, TIMEOUT);

  test("backend prepared admission is shutdown-supervised even without an HTTP request task", async () => {
    const session = await fixtureSession("opencode"), prepared = await preparedFor(session.sessionId), context = admissionContext(), lease = app!.preparedInput.reserve(context.intent, session.sessionId);
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), associate = CatalogService.prototype.associate;
    const preflight = spyOn(CatalogService.prototype, "associate").mockImplementation(async function(this: CatalogService, ...args) {
      if (args[0] === session.sessionId) { entered.resolve(); await gate.promise; }
      return associate.apply(this, args);
    });
    const before = sideEffects(), consumer = app!.preparedInput, pending = consumer.admit(prepared, lease, { context });
    try {
      await entered.promise; const close = app!.close(); gate.resolve();
      await expect(pending).rejects.toThrow("admission unavailable"); consumer.release(lease); await close;
      expect(sideEffects()).toEqual(before);
    } finally { gate.resolve(); consumer.release(lease); preflight.mockRestore(); await app!.close(); app = await start(options); await login(); }
  }, TIMEOUT);

  test("shutdown preserves a pending legacy followup as non-submitted rather than launching after owner exit", async () => {
    let first: any;
    try {
      const initial = await api("/api/sessions", { harness: "claude-code", prompt: "hold for Claude followup at shutdown" });
      expect(initial.status).toBe(202); first = initial.body;
      await until("Claude stopped predecessor turn", async () => {
        const row = (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === first.sessionId);
        return row?.availability.queueAfterRunId === first.runId ? row : undefined;
      });
      const queued = await api("/api/sessions", { sessionId: first.sessionId, prompt: "offline must not resume after shutdown" });
      expect(queued.status).toBe(202); expect(queued.body.queued).toBe(true);
      const close = app!.close(); writeFileSync(join(root, `claude-release-${first.runId}`), "release"); await close;
      const metadata = disk("metadata.json");
      expect(metadata.runs.some((run: any) => run.queuedFollowupId === queued.body.receipt.requestId)).toBe(false);
      expect(invocations().some(row => row.prompt === "offline must not resume after shutdown")).toBe(false);
    } finally {
      if (first) writeFileSync(join(root, `claude-release-${first.runId}`), "release");
      await app!.close(); app = await start(options); await login();
    }
    const row = (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === first.sessionId);
    expect(row.queuedFollowups.at(-1).state).toBe("not-submitted"); expect(row.availability.canSend).toBe(true);
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

  for (const mixedClaude of [false, true]) test(`startup observes an exact existing OpenCode command while reconciliation blocks all new sends (mixedClaude=${mixedClaude})`, async () => {
    const created = await api("/api/sessions", { harness: "opencode", prompt: "hold for flagged startup", cwd: repoDir });
    expect(created.status).toBe(202);
    const { sessionId, nativeSessionId, runId } = created.body;
    await until("accepted exact command before flagged restart", async () => storedRun(runId).nativePhase === "accepted" ? true : undefined);
    await app!.close(); app = undefined;
    const metadata = disk("metadata.json"), nativeRun = metadata.runs.find((r: any) => r.runId === runId);
    metadata.reconciliationRequired = !mixedClaude;
    let claudeRun: any;
    if (mixedClaude) {
      claudeRun = metadata.runs.find((r: any) => r.status === "completed" && metadata.sessions.some((s: any) => s.sessionId === r.sessionId && s.harness === "claude-code" && s.lastRunId === r.runId));
      expect(claudeRun).toBeDefined();
      claudeRun.status = "running"; delete claudeRun.endedAt;
      const session = metadata.sessions.find((s: any) => s.sessionId === claudeRun.sessionId);
      session.lastStatus = "running"; session.lastRunId = claudeRun.runId;
    }
    writeFileSync(join(dataDir, "metadata.json"), JSON.stringify(metadata));
    const before = mutations().length, invocationCount = invocations().length, observations: [string, string, string | undefined][] = [];
    const snapshot = OpenCodeAdapter.prototype.snapshot;
    const observe = spyOn(OpenCodeAdapter.prototype, "snapshot").mockImplementation(async function(this: OpenCodeAdapter, id, commandId, cwd) {
      observations.push([id, commandId, cwd]); return snapshot.call(this, id, commandId, cwd);
    });
    try {
      app = await start(options); await login();
      await until("startup exact-command observer", async () => observations.some(([id, command]) => id === nativeSessionId && command === nativeRun.nativeCommandId) ? true : undefined);
      const config = await api("/api/config"); expect(config.status).toBe(200); expect(config.body.authenticated).toBe(true);
      const listing = await api("/api/sessions"); expect(listing.status).toBe(200);
      expect(listing.body.availability).toMatchObject({ canSend: false, code: "reconciliation-required" });
      expect(listing.body.sessions.find((s: any) => s.sessionId === sessionId).availability).toMatchObject({ canSend: false, code: "reconciliation-required" });
      for (const input of [{ sessionId, operation: "recover-run", requestId: runId, prompt: "offline arbitrary recovery must not dispatch" }, { harness: "opencode", prompt: "offline fresh creation must not dispatch" }]) {
        const rejection = await api("/api/sessions", input);
        expect(rejection.status).toBe(409); expect(rejection.body.code).toBe("reconciliation-required");
      }
      if (mixedClaude) expect(storedRun(claudeRun.runId).status).toBe("interrupted");
      complete(nativeSessionId);
      await until("exact observed input completion under blocked admission", async () => storedRun(runId).status === "completed" ? true : undefined);
      expect(disk("metadata.json").reconciliationRequired).toBe(true);
      expect(observations.filter(([id]) => id === nativeSessionId).every(([, command, cwd]) => command === nativeRun.nativeCommandId && cwd === repoDir)).toBe(true);
      expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(invocationCount);
    } finally {
      observe.mockRestore(); if (sessions.get(nativeSessionId)!.active) complete(nativeSessionId);
      await app?.close(); app = undefined;
      // Only this disposable fixture's synthetic CLI state is acknowledged.
      app = await start({ ...options, reconcileInterrupted: true }); await login();
    }
  }, TIMEOUT);

  for (const publicationFailure of [false, true]) test(`post-bind startup failure closes both listeners before releasing either lock and permits a clean same-port restart (publicationFailure=${publicationFailure})`, async () => {
    const selected = startupFixture(`post-bind-${publicationFailure}`), paths = validateOwnershipPaths(selected.packageDir!, selected.dataDir);
    const bound: Bun.Server<any>[] = [], ports: number[] = [], probeDrains: Promise<void>[] = [];
    const serve = Bun.serve, release = OwnershipHandle.prototype.release;
    let checkedBeforeRelease = false;
    const capture = spyOn(Bun, "serve").mockImplementation(((input: any) => { const server = serve(input); bound.push(server); ports.push(server.port!); return server; }) as typeof Bun.serve);
    const releaseSpy = spyOn(OwnershipHandle.prototype, "release").mockImplementation(function(this: OwnershipHandle) {
      if (this.owner.packageDir === selected.packageDir && !checkedBeforeRelease) {
        expect(bound).toHaveLength(2); expect(existsSync(paths.installationLock)).toBe(true); expect(existsSync(paths.dataLock!)).toBe(true);
        // Rebinding synchronously proves neither original socket can still serve
        // at the precise first lock-release boundary, not just after rejection.
        for (const port of ports) {
          const probe = serve({ hostname: "127.0.0.1", port, reusePort: false, fetch: () => new Response("offline closed-listener probe") });
          probeDrains.push(probe.stop(true));
        }
        checkedBeforeRelease = true;
      }
      return release.call(this);
    });
    const failureMessage = "offline post-bind startup failure", update = OwnershipHandle.prototype.update;
    const fault = publicationFailure
      ? spyOn(OwnershipHandle.prototype, "update").mockImplementation(function(this: OwnershipHandle, phase, listener) {
        if (this.owner.packageDir === selected.packageDir && this.owner.kind === "data" && phase === "serving") throw new Error(failureMessage);
        return update.call(this, phase, listener);
      })
      : spyOn(ChromePushService.prototype, "start").mockImplementation(() => { throw new Error(failureMessage); });
    let firstPort = 0;
    try {
      await expect(start(selected)).rejects.toThrow(failureMessage);
      expect(checkedBeforeRelease).toBe(true); expect(bound).toHaveLength(2); firstPort = ports[0]!;
      expect(existsSync(paths.installationLock)).toBe(false); expect(existsSync(paths.dataLock!)).toBe(false);
      await Promise.all(probeDrains);
    } finally { fault.mockRestore(); releaseSpy.mockRestore(); capture.mockRestore(); await Promise.all(bound.map(server => server.stop(true))); await Promise.all(probeDrains); }
    expect(firstPort).toBeGreaterThan(0);
    const restarted = await start({ ...selected, port: firstPort });
    try {
      expect(restarted.port).toBe(firstPort);
      expect((await fetch(`${restarted.origin}/api/config`, { headers: { origin: restarted.origin } })).status).toBe(200);
    } finally { await restarted.close(); }
  }, TIMEOUT);

  test("a rejecting post-bind listener cleanup still stops both listeners and retains ownership instead of serving unlocked", async () => {
    const selected = startupFixture("cleanup-rejection"), paths = validateOwnershipPaths(selected.packageDir!, selected.dataDir);
    const bound: Bun.Server<any>[] = [], ports: number[] = [], stops: number[] = [], serve = Bun.serve;
    const capture = spyOn(Bun, "serve").mockImplementation(((input: any) => {
      const server = serve(input), index = bound.length, stop = server.stop.bind(server); bound.push(server); ports.push(server.port!);
      if (index === 0) spyOn(server, "stop").mockImplementation(async force => { stops.push(index); await stop(force); throw new Error("offline cleanup acknowledgement rejected"); });
      else spyOn(server, "stop").mockImplementation(async force => { stops.push(index); await stop(force); });
      return server;
    }) as typeof Bun.serve);
    const fault = spyOn(ChromePushService.prototype, "start").mockImplementation(() => { throw new Error("offline startup failure with cleanup rejection"); });
    try {
      await expect(start(selected)).rejects.toThrow("offline startup failure with cleanup rejection");
      expect(stops).toEqual([0, 1]);
      for (const lock of [paths.installationLock, paths.dataLock!]) expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).phase).toBe("retained");
      for (const port of ports) {
        const probe = serve({ hostname: "127.0.0.1", port, reusePort: false, fetch: () => new Response("offline stopped cleanup probe") });
        await probe.stop(true);
      }
      await expect(start(selected)).rejects.toMatchObject({ code: "OWNER_BUSY" });
    } finally { fault.mockRestore(); capture.mockRestore(); for (const server of bound) { (server.stop as any).mockRestore?.(); await server.stop(true); } }
    // Retained records live only under the disposable fixture root and are
    // removed by afterAll. Never force-clear a production ownership sentinel.
  }, TIMEOUT);

  for (const publicationFailure of [false, true]) test(`a still-bound listener plus BOTH failed retention writes never releases either lock (publicationFailure=${publicationFailure})`, async () => {
    const selected = startupFixture(`retention-write-failure-${publicationFailure}`), paths = validateOwnershipPaths(selected.packageDir!, selected.dataDir);
    const bound: Bun.Server<any>[] = [], ports: number[] = [], stops: number[] = [], retainAttempts: string[] = [], releases: string[] = [];
    const handles = new Map<string, OwnershipHandle>(), sentinels = new Map<string, string>();
    const serve = Bun.serve, update = OwnershipHandle.prototype.update, release = OwnershipHandle.prototype.release;
    const capture = spyOn(Bun, "serve").mockImplementation(((input: any) => {
      const server = serve(input), index = bound.length, stop = server.stop.bind(server);
      bound.push(server); ports.push(server.port!);
      // Unlike the earlier rejection test, the HTTP listener never closes.
      spyOn(server, "stop").mockImplementation(async force => {
        stops.push(index);
        if (index === 0) throw new Error("offline listener stop refused BEFORE closure");
        await stop(force);
      });
      return server;
    }) as typeof Bun.serve);
    const updateFault = spyOn(OwnershipHandle.prototype, "update").mockImplementation(function(this: OwnershipHandle, phase, listener) {
      if (this.owner.packageDir === selected.packageDir) {
        handles.set(this.owner.kind, this);
        if (phase === "retained") {
          retainAttempts.push(this.owner.kind);
          const path = join(this.lock, "owner.json");
          if (!sentinels.has(path)) sentinels.set(path, readFileSync(path, "utf8"));
          throw new Error(`offline ${this.owner.kind} retention write refused BEFORE publication`);
        }
        if (publicationFailure && this.owner.kind === "data" && phase === "serving") throw new Error("offline serving publication refused");
      }
      return update.call(this, phase, listener);
    });
    const releaseSpy = spyOn(OwnershipHandle.prototype, "release").mockImplementation(function(this: OwnershipHandle) {
      if (this.owner.packageDir === selected.packageDir) releases.push(this.owner.kind);
      return release.call(this);
    });
    const startupFault = publicationFailure ? undefined : spyOn(ChromePushService.prototype, "start").mockImplementation(() => { throw new Error("offline inner post-bind startup refused"); });
    try {
      await expect(start(selected)).rejects.toThrow("offline installation retention write refused BEFORE publication");
      expect(bound).toHaveLength(2); expect(stops).toEqual([0, 1]);
      // Outer ownership-publication failure retries retention after abortStartup
      // throws; neither retry nor any final release may remove either sentinel.
      expect(retainAttempts).toEqual(publicationFailure ? ["data", "installation", "data", "installation"] : ["data", "installation"]);
      expect(releases).toEqual([]); expect(sentinels.size).toBe(2);
      for (const [path, before] of sentinels) expect(readFileSync(path, "utf8")).toBe(before);
      expect(existsSync(paths.installationLock)).toBe(true); expect(existsSync(paths.dataLock!)).toBe(true);
      expect(() => serve({ hostname: "127.0.0.1", port: ports[0]!, reusePort: false, fetch: () => new Response("must not bind") })).toThrow();
      const origin = `http://127.0.0.1:${ports[0]}`;
      expect((await fetch(`${origin}/api/config`, { headers: { origin } })).status).toBe(200);
      expect(() => acquireInstallation(paths, { phase: "starting", reconcileInterrupted: true })).toThrow("Live installation owner");
      expect(() => acquireData(handles.get("installation")!, { phase: "starting", reconcileInterrupted: true })).toThrow("Live data owner");
      await expect(start(selected)).rejects.toMatchObject({ code: "OWNER_BUSY" });
      expect(releases).toEqual([]);
      for (const [path, before] of sentinels) expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      startupFault?.mockRestore(); capture.mockRestore(); updateFault.mockRestore(); releaseSpy.mockRestore();
      // Only this disposable fixture: restore stop, close both actual sockets,
      // then release the captured handles whose failed retain writes never set
      // their internal flags. Never remove live production locks or sentinels.
      for (const server of bound) { (server.stop as any).mockRestore?.(); await server.stop(true); }
      handles.get("data")?.release(); handles.get("installation")?.release();
    }
    expect(existsSync(paths.installationLock)).toBe(false); expect(existsSync(paths.dataLock!)).toBe(false);
    const restarted = await start({ ...selected, port: ports[0]! });
    try { expect(restarted.port).toBe(ports[0]!); } finally { await restarted.close(); }
  }, TIMEOUT);

  test("Phase3 FIFO HTTP admission is dormant, concurrent three-max, unadvertised and cannot bypass ordinary prompt", async () => {
    const session = await queueSession(), path = queuePath(session.sessionId), beforeNative = mutations().length, beforeCli = invocations().length, beforeRuns = disk("metadata.json").runs.length;
    const inputs = [queueWire(session), queueWire(session), queueWire(session)], results = await Promise.all(inputs.map(input => api(path, input)));
    expect(results.map(r => r.status)).toEqual([202, 202, 202]); expect(new Set(results.map(r => r.body.itemId)).size).toBe(3);
    expect((await api(path, queueWire(session))).status).toBe(429);
    const read = await api(path); expect(isPendingInputSnapshot(read.body.snapshot)).toBe(true);
    expect(read.body.snapshot.items.map((i: any) => i.sequence)).toEqual([1, 2, 3]); expect(read.body.snapshot.revision).toBe(3);
    expect(read.body.presentation).toMatchObject({ waitingCount: 3, maxWaiting: 3, chainLocked: true, unresolved: null, automation: { supported: false }, enqueue: { allowed: false, code: "pending-input-full" } });
    const bypass = await api("/api/sessions", { sessionId: session.sessionId, prompt: "must not overtake", profileId: "template:engineering", requestId: crypto.randomUUID() });
    expect(bypass.status).toBe(409); expect(bypass.body.code).toBe("pending-input-chain-active");
    expect((await api(path, inputs[0], { anonymous: true })).status).toBe(401);
    expect(mutations()).toHaveLength(beforeNative); expect(invocations()).toHaveLength(beforeCli); expect(disk("metadata.json").runs).toHaveLength(beforeRuns);
    expect((await api(`/api/sessions/${session.sessionId}/runs`)).body.runs).toHaveLength(1);
    expect((await api("/api/config")).body).not.toHaveProperty("pendingInputCapability");
  }, TIMEOUT);

  test("Phase3 busy OpenCode accepts only App waiters without touching its distinct native inbox", async () => {
    const session = await queueSession("opencode"), path = queuePath(session.sessionId), held = await api("/api/sessions", { sessionId: session.sessionId, prompt: "hold for phase3 App-only waiters" }); expect(held.status).toBe(202);
    const before = mutations().length, beforeRuns = disk("metadata.json").runs.length;
    try {
      for (let n = 0; n < 3; n++) expect((await api(path, queueWire(session, `App waiter ${n}`))).status).toBe(202);
      expect((await api(path, queueWire(session))).status).toBe(429); expect(sessions.get(session.nativeSessionId!)!.inbox).toEqual([]);
      expect(mutations()).toHaveLength(before); expect(disk("metadata.json").runs).toHaveLength(beforeRuns);
      expect((await api("/api/sessions", { sessionId: session.sessionId, prompt: "cannot use native inbox to bypass App chain" })).status).toBe(409);
    } finally { complete(session.nativeSessionId!); await until("busy seed completes without draining", async () => storedRun(held.body.runId)?.status === "completed" || undefined); }
  }, TIMEOUT);

  test("Phase3 excludes an active exact-predecessor legacy reservation until its historical followup settles", async () => {
    await login();
    const held = await api("/api/sessions", { harness: "claude-code", prompt: "hold for Claude followup FIFO exclusion" }); expect(held.status).toBe(202);
    const session = disk("metadata.json").sessions.find((s: Session) => s.sessionId === held.body.sessionId), path = queuePath(session.sessionId), input = queueWire(session);
    try {
      await until("legacy predecessor ready", async () => (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === session.sessionId)?.availability.queueAfterRunId === held.body.runId || undefined);
      const legacy = await api("/api/sessions", { sessionId: session.sessionId, prompt: "offline prior legacy followup" }); expect(legacy.status).toBe(202); expect(legacy.body.queued).toBe(true);
      const refused = await api(path, input); expect(refused.status).toBe(409); expect(refused.body.code).toBe("pending-input-legacy-reservation");
      expect((await api(path)).body.snapshot.items).toEqual([]);
      writeFileSync(join(root, `claude-release-${held.body.runId}`), "release");
      await until("legacy run journaled", async () => disk("metadata.json").runs.find((r: any) => r.queuedFollowupId === legacy.body.receipt.requestId && r.status === "completed") || undefined);
      await waitIdle(session.sessionId); expect((await api(path, input)).status).toBe(202);
      const legacyRead = await api("/api/sessions"); expect(legacyRead.body.sessions.find((s: any) => s.sessionId === session.sessionId).queuedFollowups.find((r: any) => r.requestId === legacy.body.receipt.requestId).state).toBe("dispatched");
    } finally { writeFileSync(join(root, `claude-release-${held.body.runId}`), "release"); }
  }, TIMEOUT);

  test("Phase3 attached Claude read eligibility is honest and automation cannot reuse an external-stopped acknowledgement", async () => {
    await login(); const nativeSessionId = claudeHistoryFixture(), attached = await api("/api/sessions/attach", { harness: "claude-code", nativeSessionId, cwd: repoDir }); expect(attached.status).toBe(201);
    const session = disk("metadata.json").sessions.find((s: Session) => s.nativeSessionId === nativeSessionId), path = queuePath(session.sessionId), before = invocations().length;
    const read = await api(path); expect(read.body.presentation.enqueue).toMatchObject({ allowed: false, code: "pending-input-attached-cc" }); expect(read.body.presentation.automation.supported).toBe(false);
    expect((await api(path, queueWire(session))).status).toBe(409); expect((await api(path, { ...queueWire(session), nativeStopped: true })).status).toBe(400); expect(invocations()).toHaveLength(before);
  }, TIMEOUT);

  test("Phase3 original wire receipts dedup before full capacity/hidden/profile/catalog drift; conflicts and tombstones remain exact", async () => {
    const session = await queueSession(), path = queuePath(session.sessionId), input = queueWire(session), receipt = (await api(path, input)).body;
    await api(path, queueWire(session)); await api(path, queueWire(session)); await api(`/api/sessions/${session.sessionId}/hide`, {});
    const spy = spyOn(CatalogService.prototype, "assertBinding").mockImplementation(() => { throw new WorkspaceError(409, "binding-invalid", "Injected current catalog drift"); });
    try {
      expect((await api(path, input)).body).toEqual(receipt);
      const reordered = { ...input, source: Object.fromEntries(Object.entries(input.source).reverse()) };
      expect((await api(path, reordered)).body).toEqual(receipt);
      expect((await api(path, { ...input, configuration: { ...input.configuration, model: "different-model" } })).status).toBe(409);
      expect((await api(path, { ...input, text: "different original intent" })).status).toBe(409);
      const remove = { version: 1, conversationId: session.sessionId, requestId: crypto.randomUUID(), inputRequestId: input.requestId, itemId: receipt.itemId };
      const removed = await api(`${path}/${receipt.itemId}/remove`, remove); expect(removed.status).toBe(200);
      const revision = removed.body.revision; expect((await api(`${path}/${receipt.itemId}/remove`, remove)).body.revision).toBe(revision);
      expect((await api(path, input)).body).toEqual(receipt);
      expect((await api(`${path}/inputs/${input.requestId}`)).body).toMatchObject({ receipt, classification: "removed" });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  }, TIMEOUT);

  test("Phase3 exact wire validators reject malformed/current source and configuration assertions without native calls", async () => {
    const session = await queueSession("opencode"), path = queuePath(session.sessionId), input = queueWire(session), before = mutations().length;
    for (const value of [{ ...input, version: 2 }, { ...input, unknown: true }, { ...input, configuration: { ...input.configuration, effort: "bad\nvariant" } }, { ...input, source: { ...input.source, harnessId: "oc" } }]) expect((await api(path, value)).status).toBe(400);
    for (const value of [{ ...input, source: { ...input.source, nativeSessionId: null } }, { ...input, source: { ...input.source, nativeSessionId: "ses_wrong" } }, { ...input, configuration: { ...input.configuration, model: "fixture/other" } }]) expect((await api(path, value)).status).toBe(409);
    const accepted = await api(path, input); expect(accepted.status).toBe(202);
    expect((await api(path)).body.presentation.automation.supported).toBe(false);
    expect((await api(`/api/sessions/${crypto.randomUUID()}/pending-inputs`, { ...input, conversationId: crypto.randomUUID() })).status).toBe(400);
    expect((await api(`/api/sessions/${crypto.randomUUID()}/pending-inputs`)).status).toBe(404);
    expect(mutations()).toHaveLength(before);
  }, TIMEOUT);

  for (const position of [0, 1, 2]) test(`Phase3 paused HTTP removal position ${position} preserves independent siblings and releases chain only at last removal`, async () => {
    const session = await queueSession("claude-code", true), path = queuePath(session.sessionId), inputs = [queueWire(session, "head"), queueWire(session, "middle"), queueWire(session, "tail")];
    const receipts: Array<{ itemId: string }> = []; for (const input of inputs) receipts.push((await api(path, input)).body);
    app!.pendingInputs.store.pause(session.sessionId, { code: "source-changed", reason: "Operator safety pause" });
    const remove = async (n: number) => api(`${path}/${receipts[n].itemId}/remove`, { version: 1, conversationId: session.sessionId, requestId: crypto.randomUUID(), itemId: receipts[n].itemId, inputRequestId: inputs[n]!.requestId });
    expect((await remove(position)).status).toBe(200); const read = (await api(path)).body;
    expect(read.snapshot.items.map((i: any) => i.text)).toEqual(inputs.filter((_, n) => n !== position).map(i => i.text)); expect(read.snapshot.paused).toBe(true); expect(read.presentation.chainLocked).toBe(true);
    for (const n of [0, 1, 2].filter(n => n !== position)) expect((await remove(n)).status).toBe(200);
    expect((await api(path)).body.presentation.chainLocked).toBe(false);
    const upgraded = await api("/api/sessions", { sessionId: session.sessionId, prompt: "existing immediate profile upgrade", profileId: "template:engineering" }); expect(upgraded).toMatchObject({ status: 202 }); await waitIdle(session.sessionId);
    expect(disk("metadata.json").sessions.find((s: Session) => s.sessionId === session.sessionId).agent).toBe("engineering");
  }, TIMEOUT);

  test("Phase3 resume is revision-CAS/idempotent and global profile edits cannot rewrite the historical prepared launch", async () => {
    const session = await queueSession(), path = queuePath(session.sessionId), input = queueWire(session); await api(path, input);
    app!.pendingInputs.store.pause(session.sessionId, { code: "restart", reason: "Resume explicitly" });
    const revision = (await api(path)).body.snapshot.revision, resume = { version: 1, requestId: crypto.randomUUID(), conversationId: session.sessionId, action: "resume", expectedRevision: revision };
    expect((await api(`${path}/resume`, { ...resume, expectedRevision: revision - 1 })).status).toBe(409);
    const savedProfile = disk("agents.json").profiles.find((p: any) => p.id === "base:cc");
    try {
      expect((await api("/api/agents/base:cc", { model: "phase3-profile-edit", effort: "high" }, { method: "PUT" })).status).toBe(200);
      const resumed = await api(`${path}/resume`, resume); expect(resumed.status).toBe(200);
      app!.pendingInputs.store.pause(session.sessionId, { code: "hidden", reason: "A later pause" }); const paused = (await api(path)).body.snapshot;
      expect((await api(`${path}/resume`, resume)).body).toEqual(resumed.body); expect((await api(path)).body.snapshot).toEqual(paused);
      const prepared = app!.pendingInputs.store.lookup(session.sessionId, input.requestId)!.item.snapshot.prepared;
      expect(prepared.configuration.model).toBeUndefined(); expect(prepared.expectedPrior!.configuration).toEqual(prepared.configuration);
    } finally { await api("/api/agents/base:cc", { model: savedProfile.model, effort: savedProfile.effort }, { method: "PUT" }); }
  }, TIMEOUT);

  test("Phase3 catalog/context drift blocks new enqueue and resume while waiting removal remains independent", async () => {
    const session = await queueSession("claude-code", true), path = queuePath(session.sessionId), input = queueWire(session), receipt = (await api(path, input)).body;
    const association = (await api("/api/sessions")).body.sessions.find((s: any) => s.sessionId === session.sessionId), workspaceId = association.workspaceId;
    const created = await api(`/api/workstreams?workspaceId=${workspaceId}`, { id: "phase3-queue-context", title: "Offline queue context", type: "feature" }); expect(created.status).toBe(200);
    expect((await api(`/api/workstreams/associate?workspaceId=${workspaceId}`, { sessionId: session.sessionId, workstreamId: "phase3-queue-context" })).status).toBe(200);
    expect((await api(path, queueWire(session))).status).toBe(409);
    expect((await api(`${path}/resume`, { version: 1, requestId: crypto.randomUUID(), conversationId: session.sessionId, action: "resume", expectedRevision: (await api(path)).body.snapshot.revision })).status).toBe(409);
    expect((await api(path, input)).body).toEqual(receipt);
    const drift = spyOn(CatalogService.prototype, "assertBinding").mockImplementation(() => { throw new WorkspaceError(409, "binding-invalid", "Catalog binding drift"); });
    try {
      expect((await api(path, queueWire(session))).status).toBe(409);
      expect((await api(`${path}/${receipt.itemId}/remove`, { version: 1, requestId: crypto.randomUUID(), conversationId: session.sessionId, itemId: receipt.itemId, inputRequestId: input.requestId })).status).toBe(200);
    } finally { drift.mockRestore(); }
  }, TIMEOUT);

  test("Phase3 restart retains waiting paused, config drift refuses new work, and original receipt wins before preparation", async () => {
    const selected = startupFixture("fifo-restart"), dir = selected.dataDir; let running = await start(selected), token = await isolatedLogin(running);
    try {
      const created = await isolatedApi(running, "/api/sessions", { prompt: "offline queue restart seed" }, token);
      await until("isolated Claude seed settled", async () => { const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")); return meta.runs.find((r: any) => r.runId === created.body.runId)?.status === "completed" || undefined; });
      const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")), session = meta.sessions[0], input = queueWire(session), path = queuePath(session.sessionId), receipt = (await isolatedApi(running, path, input, token)).body;
      await running.close(); meta.sessions[0].model = "persisted-default-drift"; writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta));
      const before = invocations().length; running = await start(selected); token = await isolatedLogin(running);
      const state = await isolatedApi(running, path, undefined, token); expect(state.body.snapshot).toMatchObject({ paused: true, items: [{ state: "waiting", requestId: input.requestId }] }); expect(state.body.presentation.pauseCode).toBe("restart");
      expect((await isolatedApi(running, path, input, token)).body).toEqual(receipt);
      expect((await isolatedApi(running, path, queueWire({ ...session, model: "persisted-default-drift" }), token)).status).toBe(409);
      expect((await isolatedApi(running, `${path}/resume`, { version: 1, requestId: crypto.randomUUID(), conversationId: session.sessionId, action: "resume", expectedRevision: state.body.snapshot.revision }, token)).status).toBe(409);
      expect(invocations()).toHaveLength(before); expect(JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).runs).toHaveLength(1);
    } finally { await running.close(); }
  }, TIMEOUT);

  for (const action of ["enqueue", "resume"] as const) test(`Phase3 asynchronous repository corruption on ${action} fails storage closed and retains ownership`, async () => {
    const f = await isolatedQueueSeed(`fifo-router-corrupt-${action}`, true), path = queuePath(f.session.sessionId), marker = join(f.discovery.stateRoot, "complete.json");
    const original = readFileSync(marker, "utf8");
    if (action === "resume") expect((await isolatedApi(f.running, path, queueWire(f.session), f.token)).status).toBe(202);
    const beforeNative = mutations().length, beforeCli = invocations().length;
    // INCOMPLETE_INITIALIZATION is an actual corrupt inspection state, not one
    // of the two storage codes the old asynchronous classifier recognized.
    rmSync(marker);
    try {
      const input = action === "enqueue" ? queueWire(f.session) : { version: 1, requestId: crypto.randomUUID(), conversationId: f.session.sessionId, action: "resume", expectedRevision: f.running.pendingInputs.store.get(f.session.sessionId).revision };
      const failed = await isolatedApi(f.running, action === "resume" ? `${path}/resume` : path, input, f.token);
      expect(failed.status).toBe(503); expect(failed.body).toMatchObject({ code: "pending-input-storage", reconciliationRequired: true });
      writeFileSync(marker, original);
      expect((await isolatedApi(f.running, "/api/sessions", { prompt: "no unrelated corruption bypass" }, f.token)).body.code).toBe("storage-unavailable");
      expect(mutations()).toHaveLength(beforeNative); expect(invocations()).toHaveLength(beforeCli);
    } finally { writeFileSync(marker, original); await closeStorageFailedFixture(f); }
  }, TIMEOUT);

  for (const code of ["BUSY", "UNAVAILABLE"] as const) test(`Phase3 asynchronous repository ${code} is scoped 503 and permits a fresh queue retry`, async () => {
    const f = await isolatedQueueSeed(`fifo-router-${code}`, true), inspect = repository.inspectRepositoryStore;
    const unavailable = spyOn(repository, "inspectRepositoryStore").mockImplementation(discovery => discovery.stateRoot === f.discovery.stateRoot ? { state: "unavailable", code, message: "Offline local reader unavailable", path: discovery.databasePath } : inspect(discovery));
    try {
      const response = await isolatedApi(f.running, queuePath(f.session.sessionId), queueWire(f.session), f.token);
      expect(response.status).toBe(503); expect(response.body.code).toBe("pending-input-pin-unavailable"); expect(response.body.reconciliationRequired).not.toBe(true);
      expect((await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.availability.canSend).toBe(true);
      unavailable.mockRestore();
      expect((await isolatedApi(f.running, queuePath(f.session.sessionId), queueWire(f.session), f.token)).status).toBe(202);
    } finally { unavailable.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  for (const code of ["STORAGE_ERROR", "CORRUPT_STORE"]) test(`Phase3 coded asynchronous repository ${code} exception is storage-fatal even with status 409`, async () => {
    const f = await isolatedQueueSeed(`fifo-router-code-${code}`, true), forAdmission = RepositoryRouter.prototype.forAdmission;
    const failure = spyOn(RepositoryRouter.prototype, "forAdmission").mockImplementation(function(this: RepositoryRouter, admission, workspaceId) {
      if (admission.sessionId === f.session.sessionId) throw new WorkstreamAdapterError(409, code, "Offline coded authority failure");
      return forAdmission.call(this, admission, workspaceId);
    });
    try {
      const response = await isolatedApi(f.running, queuePath(f.session.sessionId), queueWire(f.session), f.token);
      expect(response.status).toBe(503); expect(response.body).toMatchObject({ code: "pending-input-storage", reconciliationRequired: true });
    } finally { failure.mockRestore(); await closeStorageFailedFixture(f); }
  }, TIMEOUT);

  for (const initialized of [false, true]) for (const change of ["corrupt", "BUSY", "UNAVAILABLE"] as const) test(`Phase3 final synchronous ${initialized ? "repository" : "App-only"} fence classifies ${change} after successful preflight`, async () => {
    const f = await isolatedQueueSeed(`fifo-final-${initialized}-${change}`, initialized), assertBinding = CatalogService.prototype.assertBinding, inspect = repository.inspectRepositoryStore;
    let fences = 0, armed = false;
    const inspection = spyOn(repository, "inspectRepositoryStore").mockImplementation(discovery => armed && change !== "corrupt" && discovery.stateRoot === f.discovery.stateRoot ? { state: "unavailable", code: change, message: "Offline final reader unavailable", path: discovery.databasePath } : inspect(discovery));
    const fence = spyOn(CatalogService.prototype, "assertBinding").mockImplementation(function(this: CatalogService, ...args) {
      assertBinding.apply(this, args);
      if (args[2] !== f.session.cwd || ++fences !== 2) return;
      // First validate already succeeded; this is the real service commit fence.
      armed = true;
      if (change === "corrupt") writeFileSync(join(f.discovery.stateRoot, "complete.json"), "{broken");
    });
    if (!initialized && change === "corrupt") mkdirSync(f.discovery.stateRoot, { recursive: true });
    const beforeNative = mutations().length, beforeCli = invocations().length;
    try {
      const response = await isolatedApi(f.running, queuePath(f.session.sessionId), queueWire(f.session), f.token);
      expect(fences).toBe(2); expect(response.status).toBe(503);
      expect(response.body.code).toBe(change === "corrupt" ? "pending-input-storage" : "pending-input-pin-unavailable");
      expect(response.body.reconciliationRequired).toBe(change === "corrupt" ? true : undefined);
      expect(f.running.pendingInputs.store.get(f.session.sessionId).items).toHaveLength(0);
      expect(mutations()).toHaveLength(beforeNative); expect(invocations()).toHaveLength(beforeCli);
      if (change !== "corrupt") expect((await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.availability.canSend).toBe(true);
    } finally {
      fence.mockRestore(); inspection.mockRestore();
      if (change === "corrupt") await closeStorageFailedFixture(f); else await f.running.close();
    }
  }, TIMEOUT);

  test("Phase3 final App-only fence refuses newly initialized valid repository as 409 without poisoning storage", async () => {
    const f = await isolatedQueueSeed("fifo-final-new-domain", false), assertBinding = CatalogService.prototype.assertBinding;
    let fences = 0;
    const fence = spyOn(CatalogService.prototype, "assertBinding").mockImplementation(function(this: CatalogService, ...args) {
      assertBinding.apply(this, args);
      if (args[2] === f.session.cwd && ++fences === 2) initializeRepository(f.discovery);
    });
    try {
      const response = await isolatedApi(f.running, queuePath(f.session.sessionId), queueWire(f.session), f.token);
      expect(fences).toBe(2); expect(response.status).toBe(409); expect(response.body.code).toBe("pending-input-domain-changed");
      expect((await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.availability.canSend).toBe(true);
      expect(f.running.pendingInputs.store.get(f.session.sessionId).items).toHaveLength(0);
    } finally { fence.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase3 startup recovery permits explicit resume/new waiting mutations after classification without any replay", async () => {
    const selected = startupFixture("fifo-valid-resume"), dir = selected.dataDir; let running = await start(selected), token = await isolatedLogin(running);
    try {
      const created = await isolatedApi(running, "/api/sessions", { prompt: "offline waiting recovery seed" }, token);
      await until("resume seed settled", async () => JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === created.body.runId)?.status === "completed" || undefined);
      const session = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).sessions[0], path = queuePath(session.sessionId), input = queueWire(session), receipt = (await isolatedApi(running, path, input, token)).body;
      await running.close(); const before = invocations().length; running = await start(selected); token = await isolatedLogin(running);
      const state = (await isolatedApi(running, path, undefined, token)).body; expect(state.snapshot.paused).toBe(true);
      expect((await isolatedApi(running, `${path}/resume`, { version: 1, requestId: crypto.randomUUID(), conversationId: session.sessionId, action: "resume", expectedRevision: state.snapshot.revision }, token)).status).toBe(200);
      expect((await isolatedApi(running, path, queueWire(session, "second recovered App waiter"), token)).status).toBe(202);
      const read = (await isolatedApi(running, path, undefined, token)).body; expect(read.snapshot.paused).toBe(false); expect(read.presentation.waitingCount).toBe(2);
      expect(read.snapshot.items[0].itemId).toBe(receipt.itemId); expect(read.snapshot.items[1].sequence).toBeGreaterThan(receipt.sequence);
      expect(invocations()).toHaveLength(before); expect(JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).runs).toHaveLength(1);
    } finally { await running.close(); }
  }, TIMEOUT);

  test("Phase3 recovered claim without run metadata is uncertain, not replayed, not removable or resumable", async () => {
    const selected = startupFixture("fifo-claim"), dir = selected.dataDir; let running = await start(selected), token = await isolatedLogin(running);
    try {
      const created = await isolatedApi(running, "/api/sessions", { prompt: "offline claim recovery seed" }, token);
      await until("claim seed settled", async () => JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === created.body.runId)?.status === "completed" || undefined);
      const session = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).sessions[0], input = queueWire(session), path = queuePath(session.sessionId), receipt = (await isolatedApi(running, path, input, token)).body;
      await running.close(); const storeId = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).storeId, queued = new PendingInputStore(dir, storeId, { validateLive: () => {} }); queued.recover();
      queued.resume({ version: 1, requestId: crypto.randomUUID(), conversationId: session.sessionId, action: "resume", expectedRevision: queued.get(session.sessionId).revision });
      const item = queued.lookup(session.sessionId, input.requestId)!.item, identity = queued.claim({ conversationId: session.sessionId, inputRequestId: input.requestId, itemId: receipt.itemId, expectedRevision: queued.get(session.sessionId).revision, attemptId: crypto.randomUUID(), runId: crypto.randomUUID(), nativeCommandId: null,
        authorization: { kind: "dispatch", authorizationId: crypto.randomUUID(), chainId: item.chainId, predecessorRunId: null, source: dispatchSource(item.snapshot) } }).claim!.identity;
      queued.link(identity); const before = invocations().length; running = await start(selected); token = await isolatedLogin(running);
      expect((await isolatedApi(running, `${path}/inputs/${input.requestId}`, undefined, token)).body).toMatchObject({ receipt, classification: "uncertain", runId: identity.runId });
      const remove = { version: 1, requestId: crypto.randomUUID(), conversationId: session.sessionId, inputRequestId: input.requestId, itemId: receipt.itemId }, removed = await isolatedApi(running, `${path}/${receipt.itemId}/remove`, remove, token);
      expect(removed.status).toBe(409); expect(removed.body).toMatchObject({ outcome: "claimed", runId: identity.runId }); expect((await isolatedApi(running, `${path}/${receipt.itemId}/remove`, remove, token)).body).toEqual(removed.body);
      expect((await isolatedApi(running, `${path}/resume`, { version: 1, requestId: crypto.randomUUID(), conversationId: session.sessionId, action: "resume", expectedRevision: running.pendingInputs.store.get(session.sessionId).revision }, token)).status).toBe(409);
      expect((await isolatedApi(running, "/api/sessions", { sessionId: session.sessionId, prompt: "no bypass" }, token)).status).toBe(409); expect(invocations()).toHaveLength(before);
    } finally { await running.close(); }
  }, TIMEOUT);

  test("Phase3 corrupt optional queue fails startup closed and retains disposable ownership locks", async () => {
    const selected = startupFixture("fifo-corrupt"), paths = validateOwnershipPaths(selected.packageDir!, selected.dataDir);
    writeFileSync(join(selected.dataDir, "pending-inputs.json"), "{broken");
    await expect(start(selected)).rejects.toThrow("Pending input store unavailable or corrupt");
    expect(() => acquireInstallation(paths, { phase: "starting" })).toThrow();
  }, TIMEOUT);

  test("Phase3 queue storage errors map 503 and invoke bridge failClosed, never a retryable generic 400", async () => {
    const selected = startupFixture("fifo-storage-failure"), running = await start(selected), token = await isolatedLogin(running);
    let spy: ReturnType<typeof spyOn> | undefined;
    try {
      const created = await isolatedApi(running, "/api/sessions", { prompt: "offline storage failure seed" }, token);
      await until("failure seed settled", async () => JSON.parse(readFileSync(join(selected.dataDir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === created.body.runId)?.status === "completed" || undefined);
      const session = JSON.parse(readFileSync(join(selected.dataDir, "metadata.json"), "utf8")).sessions[0];
      spy = spyOn(PendingInputStore.prototype, "enqueue").mockImplementation(() => { throw new PendingInputStorageError("Injected durability failure after native intent record boundary"); });
      const input = queueWire(session), failed = await isolatedApi(running, queuePath(session.sessionId), input, token); expect(failed.status).toBe(503); expect(failed.body).toMatchObject({ code: "pending-input-storage", conversationId: session.sessionId, requestId: input.requestId, reconciliationRequired: true });
      const bypass = await isolatedApi(running, "/api/sessions", { sessionId: session.sessionId, prompt: "must fail closed" }, token); expect(bypass.body.code).toBe("storage-unavailable");
    } finally { spy?.mockRestore(); await expect(running.close()).rejects.toThrow("ownership retained"); }
  }, TIMEOUT);

  test("fake Claude ordinary prompt/resume uses selected source, stdout and native hook-secret boundary", async () => {
    const nativeMutations = mutations().length;
    const created = await api("/api/sessions", { harness: "claude-code", prompt: "offline CC first turn", cwd: repoDir, model: "opus", effort: "high" });
    expect(created.status).toBe(202);
    const { sessionId, nativeSessionId, runId } = created.body;
    expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
    const first = invocations().find(row => row.runId === runId);
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
    // The successful result is a separate native record, not an alias of the
    // assistant UUID. The stub deliberately emits distinct text for each.
    expect(transcript.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "assistant"]);
    expect(transcript.messages[1].parts[0].text).toBe("offline Claude answer: offline CC first turn");
    expect(transcript.messages[2]).toMatchObject({ runId, role: "assistant", status: "completed", parts: [{ type: "text", text: "offline Claude OK" }] });
    expect(transcript.messages[2].id).toStartWith(`${runId}:result:legacy:seq:`);
    expect(new Set(transcript.messages.map((m: any) => m.id)).size).toBe(3);
    // Hooks route before browser auth/Host/Origin, but still require a live secret.
    expect((await api("/hooks/Stop", { runId, payload: {} }, { anonymous: true, headers: { host: "untrusted.invalid", origin: "https://untrusted.invalid" } })).status).toBe(403);
    expect((await api("/hooks/Stop", undefined, { anonymous: true })).status).toBe(403);
    expect((await api("/hooks/NotAHook", {}, { anonymous: true })).status).toBe(400);
    const resumed = await api("/api/sessions", { sessionId, prompt: "offline CC resumed turn" });
    expect(resumed.status).toBe(202); expect((await waitIdle(sessionId)).lastStatus).toBe("completed");
    const second = invocations().find(row => row.runId === resumed.body.runId);
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
