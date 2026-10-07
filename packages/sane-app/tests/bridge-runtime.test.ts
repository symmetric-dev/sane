/** Real HTTP bridge wiring, entirely offline: isolated installation/store/repo,
 * registered loopback fake OpenCode HTTP service, and a test-owned Claude script.
 * Never builds assets, ensures a managed service, or invokes installed CLIs/models.
 * Run this file alone: startup selectors/password are saved and restored below.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, type Options } from "../src/bridge";
import { atomicAppRecord, initializeAppStore } from "../src/app-store";
import { acquireData, acquireInstallation, validateOwnershipPaths, OwnershipHandle } from "../src/installation-ownership";
import { OpenCodeAdapter, OpenCodeError, OpenCodeSourceMismatchError, OpenCodeUnavailableError, type NativeMessage } from "../src/opencode";
import { ChromePushService } from "../src/chrome-push";
import { capabilitiesFor, getHarnessDescriptor, type Harness } from "../shared/conversation/harness-capabilities";
import { RepositoryRouter, WorkstreamAdapterError } from "../src/workstreams";
import { CatalogService } from "../src/catalog";
import { OpenCodeRunService, type OpenCodeRunDependencies } from "../src/opencode-run-service";
import { ClaudeRunService, type ClaudeRunDependencies } from "../src/claude-run-service";
import { ConversationCoordinator, type ConversationAdmissionLease } from "../src/conversation-coordinator";
import { WorkerService } from "../src/workers";
import { WorkerStore } from "../src/worker-store";
import type { WorkerExecutor } from "../src/workers";
import type { WorkerRecord } from "../src/worker-contract";
import { prepareUserInput } from "../src/user-input-preparation";
import { PendingInputStore, type PendingInputStoreDependencies } from "../src/pending-input-store";
import { PendingInputService, type PendingInputServiceDependencies } from "../src/pending-input-service";
import type { PendingInputWakeClock, PendingInputWakeTimer } from "../src/pending-input-wake";
import { DispatchPreNativeRefusal } from "../src/dispatch-evidence";
import type { RunOwner } from "../src/run-owner";
import { PendingInputDomainError, PendingInputStorageError, type PendingInputStoredItem } from "../src/pending-input-contract";
import { dispatchSource } from "../src/pending-input-codec";
import { isPendingInputCapability, isPendingInputSnapshot } from "../shared/conversation/pending-input-contract";
import { legacyProfileId } from "../src/agent-profiles-contract";
import { WorkspaceError } from "../src/workspace";
import type { NativeQueuedHandoffAdmissionContext, PreparedAdmissionContext, PreparedAdmissionOptions, PreparedAdmissionResult } from "../src/prepared-input-admission";
import type { DispatchIdentity, DispatchSubmissionEvidence } from "../shared/conversation/dispatch-contract";
import type { DispatchLifecycle } from "../src/harness-dispatch";
import { HarnessDispatchRegistry } from "../src/harness-dispatch";
import type { Session } from "../src/history";
import { discoverRepository, initializeRepository, DomainError, RepositoryDomain } from "sane-core/server";
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
  const selected = { ...options, packageDir, dataDir: isolatedDataDir, port: 0, pendingInputWakeClock: fixtureWakeClock().clock };
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
async function isolatedQueueSeed(name: string, initialized: boolean, harness: Harness = "claude-code", wakeClock?: PendingInputWakeClock | null) {
  const selected = { ...startupFixture(name), ...(wakeClock ? { pendingInputWakeClock: wakeClock } : {}) }, cwd = join(root, `${name}-repository`); mkdirSync(cwd);
  // Only the default-clock activation case omits the internal fixture dependency.
  if (wakeClock === null) delete selected.pendingInputWakeClock;
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
async function driveConsumer(running: Awaited<ReturnType<typeof start>>) {
  running.pendingInputConsumer.poll(); await running.pendingInputConsumer.drain();
}
function fixtureWakeClock() {
  const jobs: Array<() => void> = [], timers = new Map<PendingInputWakeTimer, () => void>();
  let unrefs = 0;
  const clock: PendingInputWakeClock = {
    queueMicrotask: callback => { jobs.push(callback); },
    setInterval: (callback, delay) => {
      expect(delay).toBe(15000);
      const timer = { unref: () => { unrefs++; } }; timers.set(timer, callback); return timer;
    },
    clearInterval: timer => { timers.delete(timer); },
  };
  return { clock, jobs, timers, unrefs: () => unrefs,
    tick: () => { for (const callback of timers.values()) callback(); },
    flush: async (running: Awaited<ReturnType<typeof start>>) => {
      const batch = jobs.splice(0); expect(batch.length).toBeLessThanOrEqual(1);
      for (const callback of batch) callback();
      await running.pendingInputConsumer.drain();
    },
  };
}
function holdOutboxTimers() {
  const callbacks: Array<() => void> = [], original = globalThis.setInterval;
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    const handle = original(callback, ms, ...args);
    if (ms === 500) { clearInterval(handle); callbacks.push(callback); }
    return handle;
  }) as typeof setInterval);
  return { callbacks, restore: () => timer.mockRestore() };
}
function pendingReport(running: Awaited<ReturnType<typeof start>>, session: Session) {
  const id = crypto.randomUUID(), now = new Date().toISOString();
  running.workers.store.insert({ id, sessionId: crypto.randomUUID(), runId: null,
    parent: { sessionId: session.sessionId, runId: session.lastRunId!, toolCallId: "offline-arbitration-report", native: { harness: "oc", authorityId: session.authorityId!, nativeId: session.nativeSessionId! } },
    input: { requestId: crypto.randomUUID(), worker: "tester", prompt: "offline completed worker" }, checkout: session.cwd,
    launch: { profileId: "worker:tester", harness: "opencode", agent: "sane/worker/tester" }, child: null, state: "completed", createdAt: now, updatedAt: now,
    outcome: { status: "completed", at: now, summary: "offline pending result", log: null }, notification: { id: `worker-outcome:${id}`, state: "pending" } });
  return id;
}
async function enqueueFixtureHandoff(f: Awaited<ReturnType<typeof isolatedQueueSeed>>, input: unknown) {
  const native = JSON.parse(readFileSync(join(f.selected.dataDir, "native-handoff.json"), "utf8"));
  const res = await fetch(native.url, { method: "POST", headers: { authorization: `Bearer ${native.token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "enqueue", caller: { version: 1, repository: f.discovery.primaryCheckout, source: f.selected.nativeSources.oc, authorityId: f.session.authorityId, nativeId: f.session.nativeSessionId }, input }) });
  const body = await res.json() as any; expect(res.status).toBe(202); return body.handoff as { id: string; recipientSessionId: string };
}
async function settledInput(running: Awaited<ReturnType<typeof start>>, sessionId: string, requestId: string) {
  return until("real consumer independent settlement", async () => {
    await driveConsumer(running);
    const item = running.pendingInputs.store.lookup(sessionId, requestId)!.item;
    return item.state === "settled" ? item : undefined;
  });
}
async function unrelatedDirectInput(f: Awaited<ReturnType<typeof isolatedQueueSeed>>) {
  const created = await isolatedApi(f.running, "/api/sessions", { harness: "claude-code", prompt: "offline unrelated no-chain admission remains healthy" }, f.token);
  expect(created.status).toBe(202);
  await until("unrelated conversation released", async () => (await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.sessions.find((s: any) => s.sessionId === created.body.sessionId)?.availability?.canSend || undefined);
  const resumed = await isolatedApi(f.running, "/api/sessions", { sessionId: created.body.sessionId, prompt: "offline unrelated direct send remains healthy" }, f.token);
  expect(resumed.status).toBe(202);
  await until("unrelated direct send completed", async () => JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === resumed.body.runId)?.status === "completed" || undefined);
}
async function closeStorageFailedFixture(f: Awaited<ReturnType<typeof isolatedQueueSeed>>) {
  await expect(f.running.close()).rejects.toThrow("ownership retained");
  const paths = validateOwnershipPaths(f.selected.packageDir!, f.selected.dataDir);
  for (const lock of [paths.installationLock, paths.dataLock!]) expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).phase).toBe("retained");
  // No automatic reconciliation/restart. These test-owned sentinels survive
  // until afterAll explicitly disposes the entire closed, isolated fixture.
}
/** Hold actual asynchronous native preparation, then inject drift at the final
 * evidence callback AFTER the real native owner/configuration guards. The real
 * store, scheduler validation, bridge translation, services and transports run.
 * No mocked validation is used as proof that the native boundary was withheld. */
async function heldQueueBoundary(name: string, harness: Harness, mutate: (owner: RunOwner, session: Session) => void, wakeClock?: PendingInputWakeClock) {
  const f = await isolatedQueueSeed(name, false, harness, wakeClock), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const stages: string[] = []; let published: DispatchLifecycle | undefined, live: Session | undefined, boundaryError: unknown;
  let preparationRestore: (() => void) | undefined;
  const hold = (service: unknown, owner: RunOwner) => {
    if (owner.run.sessionId !== f.session.sessionId || preparationRestore) return;
    const deps = (service as { deps: Pick<ClaudeRunDependencies, "execution" | "session"> }).deps, execution = deps.execution;
    live = deps.session(owner.run.sessionId)!;
    let held = false;
    deps.execution = async id => {
      const cwd = await execution(id);
      if (!held && id === f.session.sessionId) {
        held = true; stages.push("held-preparation"); entered.resolve(); await gate.promise; stages.push("released-preparation");
      }
      return cwd;
    };
    preparationRestore = () => { deps.execution = execution; };
  };
  const ccExecute = ClaudeRunService.prototype.execute, ocExecute = OpenCodeRunService.prototype.executeNative;
  const service = harness === "claude-code"
    ? spyOn(ClaudeRunService.prototype, "execute").mockImplementation(function(this: ClaudeRunService, ...args) { hold(this, args[0]); return ccExecute.apply(this, args); })
    : spyOn(OpenCodeRunService.prototype, "executeNative").mockImplementation(function(this: OpenCodeRunService, ...args) { hold(this, args[0]); return ocExecute.apply(this, args); });
  const admit = f.running.preparedInput.admit;
  const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => {
    if (prepared.binding.conversationId !== f.session.sessionId) return admit(prepared, lease, options);
    const context = options!.context!, validate = context.validate!, beforeNative = context.evidence!.beforeNative!;
    let boundaryEntered = false;
    // Install these wrappers before admission captures the original guard. The
    // post-preparation validate is called inside the real owner.beforeSend; the
    // service then invokes evidence.beforeNative after that guard has returned.
    return admit(prepared, lease, { ...options, context: { ...context,
      validate: identity => { validate(identity); if (stages.includes("released-preparation")) stages.push("native-owner-check"); },
      evidence: { ...context.evidence, beforeNative: evidence => {
        if (boundaryEntered) return beforeNative(evidence);
        boundaryEntered = true;
        expect(stages.at(-1)).toBe("native-owner-check"); expect(stages).toContain("released-preparation");
        stages.push("boundary-drift"); mutate(published!.owner, live!);
        try { beforeNative(evidence); } catch (error) { boundaryError = error; throw error; }
      } },
    }, publish: lifecycle => {
      options!.publish!(lifecycle); published = lifecycle;
    } });
  });
  return { ...f, stages, entered, gate, published: () => published!, boundaryError: () => boundaryError, live: () => live!,
    restore: () => { gate.resolve(); preparationRestore?.(); service.mockRestore(); publisher.mockRestore(); } };
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
/** Actual ordinary FIFO dispatch, then offline lost durable ACK at restart.
 * Metadata deliberately still says accepted: it is NOT queue receipt proof. */
async function recoveredOCSeed(name: string) {
  const f = await isolatedQueueSeed(name, false, "opencode"), id = f.session.sessionId;
  const head = queueWire(f.session, "hold for Phase5e2 original pending"), waiter = queueWire(f.session, "Phase5e2 unchanged waiting text");
  const prompt = OpenCodeAdapter.prototype.promptQueuedHandoff;
  const busyRace = spyOn(OpenCodeAdapter.prototype, "promptQueuedHandoff").mockImplementation(function(this: OpenCodeAdapter, ...args) {
    if (args[0] === f.session.nativeSessionId) sessions.get(args[0])!.active = true;
    return prompt.apply(this, args);
  });
  try {
    await f.running.pendingInputs.enqueue(id, head); await f.running.pendingInputs.enqueue(id, waiter); await driveConsumer(f.running);
    await until("Phase5e2 real original native ACK", async () => f.running.pendingInputs.store.lookup(id, head.requestId)!.item.claim?.evidence?.nativeAcceptance === "accepted" || undefined);
  } finally { busyRace.mockRestore(); await f.running.close(); }
  const records = JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8"));
  const conversation = records.conversations.find((c: any) => c.conversationId === id);
  const original = conversation.items.find((i: any) => i.requestId === head.requestId);
  original.claim.evidence = { ...original.claim.identity, submission: "unknown", nativeAcceptance: "unknown" };
  original.claim.uncertain = true;
  conversation.pause = { code: "acceptance-unknown", reason: "Offline lost durable ACK; original identity requires reconciliation" }; conversation.revision++;
  atomicAppRecord(f.selected.dataDir, "pending-inputs.json", records);
  return { ...f, head, waiter, original: original as PendingInputStoredItem };
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
      `const resultFailure = prompt.startsWith("Phase5c1 result failure") || prompt.startsWith("Phase5c1 execution-result failure");`,
      `console.log(JSON.stringify({ type: "result", subtype: resultFailure ? "error_during_execution" : "success", is_error: resultFailure, session_id, result: resultFailure ? "offline native result command failed" : "offline Claude OK" }));`,
      `if (prompt.startsWith("fail for FIFO consumer")) process.exit(1);`,
      `if (prompt.startsWith("hold for Claude followup")) { await probe(process.env.CC_WEB_HOOK_SECRET, { hook_event_name: "Stop", session_id }, "Stop"); while (!existsSync(${JSON.stringify(join(root, "claude-release-"))} + process.env.CC_WEB_RUN_ID)) await Bun.sleep(20); }`,
      "",
    ].join("\n")); chmodSync(stub, 0o755);
    // Park only clock delivery: actual startup activation and all guards remain.
    options = { host: "127.0.0.1", port: 0, cwd: repoDir, dataDir, claudeBin: stub, packageDir, noBuild: true, allowRemote: false, reconcileInterrupted: false, pendingInputWakeClock: fixtureWakeClock().clock,
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

  test("terminal worker observation cache reopens for native phase and command evidence and retains legacy restoration", async () => {
    const timers = holdOutboxTimers();
    const f = await isolatedQueueSeed("worker-observation-key", false, "opencode");
    try {
      const prepared = await preparedFor(f.session.sessionId, "offline worker observation key", f.selected.dataDir, f.session.cwd);
      const context = admissionContext(), lease = f.running.preparedInput.reserve(context.intent, f.session.sessionId);
      let result;
      try { result = await f.running.preparedInput.admit(prepared, lease, { context }); }
      finally { f.running.preparedInput.release(lease); }
      await result.lifecycle.done;
      await until("worker observation fixture owner released", async () => (await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.sessions.find((s: any) => s.sessionId === f.session.sessionId)?.availability.canSend || undefined);
      const workers = f.running.workers, id = pendingReport(f.running, f.session);
      workers.store.suppress(f.session.sessionId, true);
      let worker = workers.store.update(id, { sessionId: f.session.sessionId, runId: result.runId });
      worker = await workers.refresh(worker);
      expect(workers.listForRefresh()).toEqual([]);
      // Change only metadata used by workerDeliveryEvidence: no event append or
      // WorkerStore write may mask an incomplete external observation key.
      const run = result.lifecycle.owner.run;
      const previousPhase = run.nativePhase, previousCommand = run.nativeCommandId;
      run.nativePhase = "preparing";
      expect(workers.listForRefresh().map(w => w.id)).toEqual([id]);
      worker = await workers.refresh(worker);
      expect(workers.listForRefresh()).toEqual([]);
      run.nativeCommandId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
      expect(workers.listForRefresh().map(w => w.id)).toEqual([id]);
      worker = await workers.refresh(worker);
      expect(workers.listForRefresh()).toEqual([]);
      run.nativePhase = previousPhase; run.nativeCommandId = previousCommand;
      // A legacy tail in ANY revision keeps restoration eligible, not only the
      // newest or original outcome. Remove this middle revision's log to keep
      // the synthetic legacy tail unresolved by the restoration pass.
      expect(worker.results!.length).toBeGreaterThanOrEqual(3);
      worker.results![1]!.outcome = { ...worker.results![1]!.outcome, summary: "x".repeat(4000), log: null };
      worker = workers.store.update(id, { results: worker.results });
      await workers.refresh(worker);
      expect(workers.listForRefresh().map(w => w.id)).toEqual([id]);
    } finally { timers.restore(); await f.running.close(); }
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

  for (const publicationFailure of [false, true]) test(publicationFailure ? "post-bind serving-record publication failure fences storage and closes both listeners while retaining both locks" : "post-bind startup failure closes both listeners before releasing either lock and permits a clean same-port restart (publicationFailure=false)", async () => {
    const selected = startupFixture(`post-bind-${publicationFailure}`), paths = validateOwnershipPaths(selected.packageDir!, selected.dataDir);
    const clock = fixtureWakeClock(); selected.pendingInputWakeClock = clock.clock;
    const bound: Bun.Server<any>[] = [], ports: number[] = [], stops: number[] = [], probeDrains: Promise<void>[] = [];
    const before = sideEffects(), fenced: boolean[] = []; let deps: PendingInputServiceDependencies | undefined;
    const recover = PendingInputService.prototype.recover;
    const recovery = spyOn(PendingInputService.prototype, "recover").mockImplementation(function(this: PendingInputService) {
      const current = (this as unknown as { deps: PendingInputServiceDependencies }).deps;
      if (current.dataDir === selected.dataDir) deps = current;
      return recover.call(this);
    });
    const serve = Bun.serve, release = OwnershipHandle.prototype.release;
    let checkedBeforeRelease = false;
    const capture = spyOn(Bun, "serve").mockImplementation(((input: any) => {
      const server = serve(input), index = bound.length, stop = server.stop.bind(server); bound.push(server); ports.push(server.port!);
      spyOn(server, "stop").mockImplementation(async force => { stops.push(index); await stop(force); });
      return server;
    }) as typeof Bun.serve);
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
        if (this.owner.packageDir === selected.packageDir && phase === "retained") {
          // Before abortStartup sets closing: the actual inner storage fence,
          // not just stopped listeners, must already deny mutation ownership.
          let unavailable = false;
          try { deps!.guard("remove", "offline-storage-fence"); }
          catch (error) { unavailable = error instanceof PendingInputDomainError && error.code === "pending-input-owner-unavailable"; }
          fenced.push(unavailable && deps!.automationStarted!() === false);
        }
        if (this.owner.packageDir === selected.packageDir && this.owner.kind === "data" && phase === "serving") {
          update.call(this, phase, listener); // A post-commit error is still uncertain publication.
          throw new Error(failureMessage);
        }
        return update.call(this, phase, listener);
      })
      : spyOn(ChromePushService.prototype, "start").mockImplementation(() => { throw new Error(failureMessage); });
    let firstPort = 0;
    try {
      await expect(start(selected)).rejects.toThrow(failureMessage);
      expect(checkedBeforeRelease).toBe(!publicationFailure); expect(bound).toHaveLength(2); firstPort = ports[0]!;
      expect(stops).toEqual([0, 1]);
      expect(existsSync(paths.installationLock)).toBe(publicationFailure); expect(existsSync(paths.dataLock!)).toBe(publicationFailure);
      if (publicationFailure) {
        expect(fenced).toEqual([true, true, true, true]);
        for (const lock of [paths.installationLock, paths.dataLock!]) expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).phase).toBe("retained");
        expect(clock.unrefs()).toBe(0); expect(clock.timers.size).toBe(0); expect(clock.jobs).toHaveLength(0);
        expect(sideEffects()).toEqual(before);
        for (const port of ports) {
          const probe = serve({ hostname: "127.0.0.1", port, reusePort: false, fetch: () => new Response("offline retained-owner stopped-listener probe") });
          probeDrains.push(probe.stop(true));
        }
        await expect(start(selected)).rejects.toMatchObject({ code: "OWNER_BUSY" });
        await Bun.sleep(30); expect(sideEffects()).toEqual(before);
      }
      await Promise.all(probeDrains);
    } finally {
      fault.mockRestore(); releaseSpy.mockRestore(); capture.mockRestore(); recovery.mockRestore();
      for (const server of bound) { (server.stop as any).mockRestore?.(); await server.stop(true); }
      await Promise.all(probeDrains);
    }
    expect(firstPort).toBeGreaterThan(0);
    // Only afterAll disposes these closed, isolated retained-owner fixtures.
    if (publicationFailure) return;
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
      await expect(start(selected)).rejects.toThrow(publicationFailure ? "offline serving publication refused" : "offline installation retention write refused BEFORE publication");
      expect(bound).toHaveLength(2); expect(stops).toEqual([0, 1]);
      // Publication fences/retains before abortStartup retries retention. Neither
      // failed write may mask that original error or permit a final release.
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

  for (const harness of ["claude-code", "opencode"] as const) test(`PhaseFinalWake ${harness} HTTP commits drain automatically with bounded busy backstop and healthy capability advertisement`, async () => {
    const clock = fixtureWakeClock(), f = await isolatedQueueSeed(`final-wake-${harness}`, false, harness, clock.clock);
    const id = f.session.sessionId, store = f.running.pendingInputs.store;
    const first = queueWire(f.session, `offline final wake ${harness} head`), second = queueWire(f.session, `offline final wake ${harness} successor`);
    const before = harness === "opencode" ? prompts().length : invocations().length;
    const read = spyOn(store, "readRecords");
    const activity = OpenCodeAdapter.prototype.activity;
    const nativeProof = spyOn(OpenCodeAdapter.prototype, "activity");
    const reserve = spyOn(ConversationCoordinator.prototype, "reserveAdmission");
    try {
      expect(store.hasPendingWork()).toBe(false);
      expect(f.running.pendingInputWake.isStarted()).toBe(true); expect(clock.unrefs()).toBe(1);
      expect(isPendingInputCapability((await isolatedApi(f.running, "/api/config", undefined, f.token)).body.pendingInputCapability)).toBe(true);
      expect((await isolatedApi(f.running, queuePath(id), undefined, f.token)).body.presentation.automation).toEqual({ supported: true, reason: null });
      const receipt = await isolatedApi(f.running, queuePath(id), first, f.token); expect(receipt.status).toBe(202);
      expect((await isolatedApi(f.running, queuePath(id), second, f.token)).status).toBe(202);
      expect(store.hasPendingWork()).toBe(true);
      const loaded = new PendingInputStore(f.selected.dataDir, store.storeId, { validateLive: () => { throw new Error("Read-only loaded fixture"); } });
      expect(loaded.hasPendingWork()).toBe(true); expect(loaded.inspect(id).recoveryRequired).toBe(true);
      if (harness === "opencode") {
        const fake = sessions.get(f.session.nativeSessionId!)!; fake.active = true;
        const reservations = reserve.mock.calls.length;
        await clock.flush(f.running);
        expect(store.lookup(id, first.requestId)!.item.claim).toBeNull(); expect(prompts()).toHaveLength(before);
        expect(reserve.mock.calls.length).toBe(reservations); expect(clock.jobs).toHaveLength(0);
        const proofs = nativeProof.mock.calls.length, reads = read.mock.calls.length;
        await Bun.sleep(30); expect(nativeProof.mock.calls.length).toBe(proofs); expect(read.mock.calls.length).toBe(reads);
        // A 15s virtual tick causes one finite reconsideration, not a self-spin.
        clock.tick(); await clock.flush(f.running);
        expect(nativeProof.mock.calls.length).toBeGreaterThan(proofs); expect(nativeProof.mock.calls.length - proofs).toBeLessThanOrEqual(2); expect(clock.jobs).toHaveLength(0);
        const reconsidered = nativeProof.mock.calls.length, nativeRequests = calls.length;
        await Bun.sleep(30); expect(nativeProof.mock.calls.length).toBe(reconsidered); expect(calls).toHaveLength(nativeRequests);
        expect(prompts()).toHaveLength(before); expect(reserve.mock.calls.length).toBe(reservations);
        // Transport-unknown proof likewise preserves waiting text without poison.
        fake.active = false;
        nativeProof.mockImplementation(async function(this: OpenCodeAdapter, ...args) {
          if (args[0] === f.session.nativeSessionId) throw new OpenCodeUnavailableError("Offline final wake unknown source activity");
          return activity.apply(this, args);
        });
        try { clock.tick(); await clock.flush(f.running); expect(store.lookup(id, first.requestId)!.item.claim).toBeNull(); expect(store.inspect(id).pause).toBeNull(); expect(clock.jobs).toHaveLength(0); }
        finally { nativeProof.mockImplementation(function(this: OpenCodeAdapter, ...args) { return activity.apply(this, args); }); }
        // Inject a scoped claim refusal AFTER the real coordinator acquires its
        // lease: its actual release notification must not make a retry loop.
        const claims = spyOn(store, "claim").mockImplementation(() => { throw new PendingInputDomainError("conversation-busy", "Offline final claim backpressure"); });
        try {
          const admissions = reserve.mock.calls.length;
          clock.tick(); await clock.flush(f.running); await Bun.sleep(30);
          expect(reserve.mock.calls.length).toBe(admissions + 1); expect(claims.mock.calls).toHaveLength(1);
          expect(clock.jobs).toHaveLength(0); expect(store.lookup(id, first.requestId)!.item.claim).toBeNull(); expect(prompts()).toHaveLength(before);
        } finally { claims.mockRestore(); }
        // Last removal clears derived work despite retained receipts/tombstones.
        for (const request of [first, second]) {
          const item = store.lookup(id, request.requestId)!.item;
          expect((await isolatedApi(f.running, `${queuePath(id)}/${item.itemId}/remove`, { version: 1, requestId: crypto.randomUUID(), conversationId: id, inputRequestId: request.requestId, itemId: item.itemId }, f.token)).body.outcome).toBe("removed");
        }
        expect(store.hasPendingWork()).toBe(false); await clock.flush(f.running);
        const emptyReads = read.mock.calls.length, emptyProofs = nativeProof.mock.calls.length;
        clock.tick(); await clock.flush(f.running);
        expect(read.mock.calls.length).toBe(emptyReads); expect(nativeProof.mock.calls.length).toBe(emptyProofs);
        // New chain after retained history is ordinary FIFO, not historical work.
        first.requestId = crypto.randomUUID(); second.requestId = crypto.randomUUID();
        expect((await isolatedApi(f.running, queuePath(id), first, f.token)).status).toBe(202);
        expect((await isolatedApi(f.running, queuePath(id), second, f.token)).status).toBe(202);
      }
      // Only the injected clock is advanced. Never consumer.poll()/driveConsumer.
      await clock.flush(f.running);
      await until("final wake independently settled both real FIFO heads", async () => {
        await clock.flush(f.running);
        return [first, second].every(request => store.lookup(id, request.requestId)!.item.state === "settled") || undefined;
      });
      expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before + 2);
      for (const request of [first, second]) expect(store.lookup(id, request.requestId)!.item.history).toMatchObject({ kind: "settled", status: "completed" });
      expect(store.hasPendingWork()).toBe(false); expect(store.inspect(id).chain).toBeNull();
      expect((await f.running.pendingInputs.enqueue(id, first)).outcome).toBe("enqueued");
      expect(clock.jobs).toHaveLength(0); // Historical receipt cannot mint a hint/grant.
      const reads = read.mock.calls.length, proofs = nativeProof.mock.calls.length;
      clock.tick(); await clock.flush(f.running);
      expect(read.mock.calls.length).toBe(reads); expect(nativeProof.mock.calls.length).toBe(proofs);
    } finally { read.mockRestore(); nativeProof.mockRestore(); reserve.mockRestore(); await f.running.close(); expect(clock.timers.size).toBe(0); }
  }, TIMEOUT);

  test("PhaseFinalWake close cancels queued hints before deferred native preparation and retains original outcome under locks", async () => {
    const clock = fixtureWakeClock(), f = await heldQueueBoundary("final-wake-close", "opencode", () => {}, clock.clock);
    const id = f.session.sessionId, store = f.running.pendingInputs.store, paths = validateOwnershipPaths(f.selected.packageDir!, f.selected.dataDir);
    const head = queueWire(f.session, "offline final wake deferred original"), next = queueWire(f.session, "offline final wake preserved successor");
    const before = prompts().length, originalOutcome = PendingInputStore.prototype.outcome;
    let observedUnderLocks = false;
    const outcome = spyOn(PendingInputStore.prototype, "outcome").mockImplementation(function(this: PendingInputStore, evidence) {
      if (this === store && evidence.requestId === head.requestId && evidence.submission === "not-submitted") {
        expect(existsSync(paths.installationLock)).toBe(true); expect(existsSync(paths.dataLock!)).toBe(true);
        observedUnderLocks = true;
      }
      return originalOutcome.call(this, evidence);
    });
    try {
      expect(f.running.pendingInputWake.isStarted()).toBe(true);
      expect((await isolatedApi(f.running, queuePath(id), head, f.token)).status).toBe(202);
      expect((await isolatedApi(f.running, queuePath(id), next, f.token)).status).toBe(202);
      await clock.flush(f.running); await f.entered.promise;
      clock.tick(); expect(clock.jobs).toHaveLength(1);
      const close = f.running.close();
      expect(f.running.pendingInputWake.isStarted()).toBe(false); expect(clock.timers.size).toBe(0);
      expect(f.running.close()).toBe(close);
      await clock.flush(f.running); f.gate.resolve(); await close;
      expect(observedUnderLocks).toBe(true); expect(prompts()).toHaveLength(before);
      expect(store.lookup(id, head.requestId)!.item.claim!.evidence).toMatchObject({ submission: "not-submitted", nativeAcceptance: "not-accepted" });
      expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null, request: { text: next.text } });
      expect(existsSync(paths.installationLock)).toBe(false); expect(existsSync(paths.dataLock!)).toBe(false);
      const bytes = readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8");
      clock.tick(); await clock.flush(f.running); await Bun.sleep(30);
      expect(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).toBe(bytes); expect(prompts()).toHaveLength(before);
    } finally { f.gate.resolve(); outcome.mockRestore(); f.restore(); await f.running.close(); }
  }, TIMEOUT);

  test("PhaseFinalWake default clock activates authenticated capability, real unref backstop and automatic HTTP FIFO without enable", async () => {
    const interval = globalThis.setInterval, clear = globalThis.clearInterval;
    let handle: (PendingInputWakeTimer & { hasRef(): boolean }) | undefined, callback: (() => void) | undefined, unref: ReturnType<typeof spyOn> | undefined;
    const intervals = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, delay: number, ...args: unknown[]) => {
      const timer = interval(fn, delay, ...args);
      if (delay === 15000) { expect(handle).toBeUndefined(); handle = timer; callback = fn; unref = spyOn(timer, "unref"); }
      return timer;
    }) as typeof setInterval);
    const clears = spyOn(globalThis, "clearInterval").mockImplementation(clear);
    let f: Awaited<ReturnType<typeof isolatedQueueSeed>> | undefined;
    try {
      f = await isolatedQueueSeed("final-wake-default-clock", false, "opencode", null);
      expect(f.selected).not.toHaveProperty("pendingInputWakeClock"); expect(f.running.pendingInputWake.isStarted()).toBe(true);
      expect(handle).toBeDefined(); expect(unref).toHaveBeenCalledTimes(1); expect(handle!.hasRef()).toBe(false);
      const anonymousRequests = calls.length, anonymous = await isolatedApi(f.running, "/api/config");
      expect(anonymous.status).toBe(200); expect(anonymous.body).toMatchObject({ authenticated: false, cwd: null });
      for (const key of ["pendingInputCapability", "storeId", "capabilities", "workspaces", "harnesses", "agents", "agentProfiles"]) expect(anonymous.body).not.toHaveProperty(key);
      expect(calls).toHaveLength(anonymousRequests);
      const config = await isolatedApi(f.running, "/api/config", undefined, f.token);
      expect(config.body.pendingInputCapability).toEqual({ protocol: "pending-input", version: 1, supported: true, maxWaiting: 3, removal: true, resume: true });
      expect(isPendingInputCapability(config.body.pendingInputCapability)).toBe(true);
      const id = f.session.sessionId, store = f.running.pendingInputs.store, fake = sessions.get(f.session.nativeSessionId!)!;
      const requests = ["head", "removed middle", "successor"].map(text => queueWire(f!.session, `offline default clock ${text}`)), before = prompts().length;
      fake.active = true;
      for (const request of requests) expect((await isolatedApi(f.running, queuePath(id), request, f.token)).status).toBe(202);
      expect((await isolatedApi(f.running, queuePath(id), queueWire(f.session), f.token)).status).toBe(429);
      const read = await isolatedApi(f.running, queuePath(id), undefined, f.token);
      expect(isPendingInputSnapshot(read.body.snapshot)).toBe(true); expect(read.body.presentation).toMatchObject({ waitingCount: 3, maxWaiting: 3, automation: { supported: true } });
      const middle = store.lookup(id, requests[1]!.requestId)!.item;
      expect((await isolatedApi(f.running, `${queuePath(id)}/${middle.itemId}/remove`, { version: 1, requestId: crypto.randomUUID(), conversationId: id, inputRequestId: requests[1]!.requestId, itemId: middle.itemId }, f.token)).body.outcome).toBe("removed");
      expect(prompts()).toHaveLength(before);
      fake.active = false; callback!(); // Actual timer callback; no 15-second sleep.
      await until("default clock automatic FIFO settlement", async () => [requests[0]!, requests[2]!].every(request => store.lookup(id, request.requestId)!.item.state === "settled") || undefined);
      expect(prompts().slice(before).map(c => c.body.text)).toEqual([requests[0]!.text, requests[2]!.text]);
      expect(store.lookup(id, requests[1]!.requestId)!.item.state).toBe("removed");
      const close = f.running.close();
      expect(f.running.pendingInputWake.isStarted()).toBe(false); expect(clears.mock.calls.some(args => args[0] === handle)).toBe(true);
      await close;
      const nativeRequests = calls.length, bytes = readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8");
      callback!(); await Bun.sleep(30);
      expect(calls).toHaveLength(nativeRequests); expect(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).toBe(bytes);
    } finally {
      try { await f?.running.close(); } finally { unref?.mockRestore(); intervals.mockRestore(); clears.mockRestore(); }
    }
  }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const) test(`Phase4c2 real ${harness} consumer with parked clock admits exact head on internal drive and independently settles`, async () => {
    const f = await isolatedQueueSeed(`consumer-${harness}`, false, harness), id = f.session.sessionId;
    const input = queueWire(f.session, `offline real ${harness} FIFO head`), before = harness === "opencode" ? prompts().length : invocations().length;
    let published: DispatchLifecycle | undefined;
    const admit = f.running.preparedInput.admit;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
    try {
      expect((await isolatedApi(f.running, queuePath(id), input, f.token)).status).toBe(202);
      await Bun.sleep(600);
      expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before);
      expect((await f.running.pendingInputs.get(id)).presentation.automation.supported).toBe(true);
      expect(() => f.running.preparedInput.reserve({ kind: "user-prompt", requestId: input.requestId }, id)).toThrow("durable input chain");
      const store = f.running.pendingInputs.store, item = store.lookup(id, input.requestId)!.item, revision = store.inspect(id).snapshot.revision;
      expect(() => store.claim({ conversationId: id, itemId: item.itemId, inputRequestId: input.requestId, expectedRevision: revision,
        runId: crypto.randomUUID(), attemptId: crypto.randomUUID(), nativeCommandId: harness === "opencode" ? `msg_${crypto.randomUUID()}` : null,
        authorization: { kind: "dispatch", authorizationId: crypto.randomUUID(), chainId: item.chainId, predecessorRunId: f.session.lastRunId, source: dispatchSource(item.snapshot) } })).toThrow("No synchronous scheduler authority");
      expect(store.inspect(id).snapshot.revision).toBe(revision);
      await driveConsumer(f.running);
      const settled = await settledInput(f.running, id, input.requestId);
      expect(settled.history).toMatchObject({ kind: "settled", status: "completed" });
      expect(published).toBeDefined(); expect(settled.claim!.identity.runId).toBe(published!.owner.run.runId);
      expect(published!.submissionEvidence()).toMatchObject({ requestId: input.requestId, submission: "submitted" });
      expect(await published!.successfulSettlement()).toEqual({ ready: true });
      expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before + 1);
      if (harness === "opencode") expect(prompts().at(-1)!.body).toEqual({ id: settled.claim!.identity.nativeCommandId, text: input.text, delivery: "queue" });
      expect(store.inspect(id).chain).toBeNull();
    } finally { publisher.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase4c2 native busy preflight has no lease; removing its head allows only the next exact head", async () => {
    const f = await isolatedQueueSeed("consumer-busy", false, "opencode"), id = f.session.sessionId, fake = sessions.get(f.session.nativeSessionId!)!;
    const first = queueWire(f.session, "offline removable busy head"), next = queueWire(f.session, "offline next FIFO head"), store = f.running.pendingInputs.store;
    const reserve = spyOn(ConversationCoordinator.prototype, "reserveAdmission");
    try {
      const receipt = await f.running.pendingInputs.enqueue(id, first); await f.running.pendingInputs.enqueue(id, next);
      fake.active = true; const before = prompts().length, reservations = reserve.mock.calls.length;
      await driveConsumer(f.running);
      expect(reserve.mock.calls.length).toBe(reservations); expect(store.lookup(id, first.requestId)!.item.claim).toBeNull(); expect(prompts()).toHaveLength(before);
      expect((await f.running.pendingInputs.remove(id, receipt.itemId, { version: 1, requestId: crypto.randomUUID(), conversationId: id, inputRequestId: first.requestId, itemId: receipt.itemId })).outcome).toBe("removed");
      fake.active = false; await settledInput(f.running, id, next.requestId);
      expect(prompts().slice(before).map(c => c.body.text)).toEqual([next.text]);
      expect(store.lookup(id, first.requestId)!.item.state).toBe("removed");
    } finally { fake.active = false; reserve.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase4c2 healthy CC released success advances once; failed and cancelling/done predecessors cannot", async () => {
    const f = await isolatedQueueSeed("consumer-cc-failure", false), id = f.session.sessionId, store = f.running.pendingInputs.store;
    let lifecycle: DispatchLifecycle | undefined;
    const admit = f.running.preparedInput.admit;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: handle => { lifecycle = handle; options!.publish!(handle); } }));
    try {
      const first = queueWire(f.session, "fail for FIFO consumer exact process"), next = queueWire(f.session, "offline must remain waiting after failure");
      await f.running.pendingInputs.enqueue(id, first); await f.running.pendingInputs.enqueue(id, next);
      await driveConsumer(f.running);
      await until("failed CC lifecycle published", async () => lifecycle || undefined); await lifecycle!.done;
      expect(lifecycle!.owner.run.status).toBe("failed"); expect((await lifecycle!.successfulSettlement()).ready).toBe(false);
      const before = invocations().length;
      lifecycle!.owner.cancelling = true; await driveConsumer(f.running);
      expect(store.lookup(id, next.requestId)!.item.state).toBe("waiting"); expect(invocations()).toHaveLength(before);
      lifecycle!.owner.cancelling = false; await driveConsumer(f.running);
      expect(["failed", "stopped"]).toContain(store.inspect(id).pause?.code ?? ""); expect(store.lookup(id, next.requestId)!.item.claim).toBeNull();
      expect(invocations()).toHaveLength(before);
    } finally { publisher.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase4c2 OC preclaim idle allows foreign postclaim activity, always POST queue, and one irreversible head", async () => {
    const f = await isolatedQueueSeed("consumer-foreign", false, "opencode"), id = f.session.sessionId, fake = sessions.get(f.session.nativeSessionId!)!, store = f.running.pendingInputs.store;
    const first = queueWire(f.session, "offline claimed native FIFO head"), second = queueWire(f.session, "offline successor FIFO head");
    const preflight = OpenCodeAdapter.prototype.preflightNativeSession;
    const foreign = spyOn(OpenCodeAdapter.prototype, "preflightNativeSession").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
      if (args[0] === f.session.nativeSessionId && store.lookup(id, first.requestId)?.item.claim) fake.active = true;
      return preflight.apply(this, args);
    });
    try {
      await f.running.pendingInputs.enqueue(id, first); await f.running.pendingInputs.enqueue(id, second);
      const before = prompts().length; await driveConsumer(f.running);
      const claim = await until("claimed FIFO input acknowledged in native queue", async () => {
        const item = store.lookup(id, first.requestId)!.item;
        return item.claim?.evidence?.nativeAcceptance === "accepted" ? item.claim : undefined;
      });
      expect(prompts()).toHaveLength(before + 1); expect(prompts().at(-1)!.body).toEqual({ id: claim.identity.nativeCommandId, text: first.text, delivery: "queue" });
      await driveConsumer(f.running); expect(store.lookup(id, second.requestId)!.item.claim).toBeNull();
      foreign.mockRestore(); consumeQueuedInput(f.session.nativeSessionId!, claim.identity.nativeCommandId!); complete(f.session.nativeSessionId!);
      await settledInput(f.running, id, second.requestId);
      expect(prompts().slice(before).map(c => c.body.text)).toEqual([first.text, second.text]);
    } finally { foreign.mockRestore(); fake.active = false; await f.running.close(); }
  }, TIMEOUT);

  for (const resumed of [false, true]) for (const field of ["model", "authorityId"] as const) test(`${resumed ? "Phase5b resumed" : "Phase4c2"} ${field} drift during asynchronous idle proof pauses durably before acquiring any lease`, async () => {
    let live: Session | undefined;
    const execute = OpenCodeRunService.prototype.executeNative;
    const capture = spyOn(OpenCodeRunService.prototype, "executeNative").mockImplementation(async function(this: OpenCodeRunService, ...args) {
      live = (this as unknown as { deps: OpenCodeRunDependencies }).deps.session(args[0].run.sessionId); return execute.apply(this, args);
    });
    let f: Awaited<ReturnType<typeof isolatedQueueSeed>>;
    try { f = await isolatedQueueSeed(`consumer-${field}-drift-${resumed}`, false, "opencode"); } finally { capture.mockRestore(); }
    const id = f!.session.sessionId, input = queueWire(f!.session), before = prompts().length, prior = live![field];
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), activity = OpenCodeAdapter.prototype.activity;
    const read = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(async function(this: OpenCodeAdapter, ...args) { if (args[0] === f.session.nativeSessionId) { entered.resolve(); await gate.promise; } return activity.apply(this, args); });
    const reserve = spyOn(ConversationCoordinator.prototype, "reserveAdmission");
    try {
      await f!.running.pendingInputs.enqueue(id, input);
      if (resumed) await f!.running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: f!.running.pendingInputs.store.get(id).revision });
      const reservations = reserve.mock.calls.length;
      f!.running.pendingInputConsumer.poll(); await entered.promise; live![field] = "changed-during-consumer-proof"; gate.resolve(); await f!.running.pendingInputConsumer.drain();
      expect(reserve.mock.calls.length).toBe(reservations); expect(prompts()).toHaveLength(before);
      expect(f!.running.pendingInputs.store.inspect(id).pause?.code).toBe(field === "model" ? "configuration-changed" : "source-changed");
      expect(f!.running.pendingInputs.store.lookup(id, input.requestId)!.item.claim).toBeNull();
    } finally { gate.resolve(); read.mockRestore(); reserve.mockRestore(); if (prior === undefined) delete live![field]; else live![field] = prior; await f!.running.close(); }
  }, TIMEOUT);

  for (const resumed of [false, true]) test(`${resumed ? "Phase5b resumed" : "Phase4c2"} transport unavailable waits without storage poison, while fresh domain drift pauses`, async () => {
    const f = await isolatedQueueSeed(`consumer-unavailable-${resumed}`, true, "opencode"), id = f.session.sessionId, input = queueWire(f.session), store = f.running.pendingInputs.store;
    const activity = OpenCodeAdapter.prototype.activity;
    const unavailable = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(async function(this: OpenCodeAdapter, ...args) { if (args[0] === f.session.nativeSessionId) throw new OpenCodeUnavailableError("Offline consumer proof unavailable"); return activity.apply(this, args); });
    try {
      await f.running.pendingInputs.enqueue(id, input);
      if (resumed) await f.running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision });
      await driveConsumer(f.running);
      expect(store.lookup(id, input.requestId)!.item.claim).toBeNull(); expect(store.inspect(id).pause).toBeNull();
      unavailable.mockRestore();
      const listed = (await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.sessions.find((s: any) => s.sessionId === id);
      expect((await isolatedApi(f.running, `/api/workstreams?workspaceId=${listed.workspaceId}`, { id: "consumer-context-drift", title: "Offline context drift", type: "feature" }, f.token)).status).toBe(200);
      expect((await isolatedApi(f.running, `/api/workstreams/associate?workspaceId=${listed.workspaceId}`, { sessionId: id, workstreamId: "consumer-context-drift" }, f.token)).status).toBe(200);
      await driveConsumer(f.running);
      expect(store.inspect(id).pause?.code).toBe("context-changed"); expect(store.lookup(id, input.requestId)!.item.claim).toBeNull();
      expect((await isolatedApi(f.running, "/api/sessions", { harness: "claude-code", prompt: "offline storage remains available" }, f.token)).status).toBe(202);
    } finally { unavailable.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase4c2 typed activity source mismatch after successful predecessor readiness pauses only its unclaimed chain", async () => {
    let predecessor: DispatchLifecycle | undefined;
    const startDispatch = HarnessDispatchRegistry.prototype.start;
    const capture = spyOn(HarnessDispatchRegistry.prototype, "start").mockImplementation(function(this: HarnessDispatchRegistry, ...args) { const lifecycle = startDispatch.apply(this, args); predecessor = lifecycle; return lifecycle; });
    let f: Awaited<ReturnType<typeof isolatedQueueSeed>>;
    try { f = await isolatedQueueSeed("consumer-typed-activity-mismatch", false, "opencode"); } finally { capture.mockRestore(); }
    const id = f!.session.sessionId, input = queueWire(f!.session), next = queueWire(f!.session, "offline waiter behind mismatched activity"), store = f!.running.pendingInputs.store;
    const success = predecessor!.successfulSettlement, activity = OpenCodeAdapter.prototype.activity;
    let ready = false, mismatches = 0;
    const proof = spyOn(predecessor!, "successfulSettlement").mockImplementation(async () => { const result = await success(); ready = result.ready; return result; });
    const read = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
      if (args[0] === f.session.nativeSessionId && ready) { mismatches++; throw new OpenCodeSourceMismatchError("Offline exact consumer activity source mismatch"); }
      return activity.apply(this, args);
    });
    const reserve = spyOn(ConversationCoordinator.prototype, "reserveAdmission");
    try {
      await predecessor!.done; await f!.running.pendingInputs.enqueue(id, input); await f!.running.pendingInputs.enqueue(id, next);
      const before = mutations().length, cli = invocations().length, reservations = reserve.mock.calls.length;
      await driveConsumer(f!.running);
      expect(ready).toBe(true); expect(mismatches).toBe(1); expect(reserve.mock.calls.length).toBe(reservations);
      expect(store.inspect(id).pause).toEqual({ code: "source-changed", reason: "Offline exact consumer activity source mismatch" });
      for (const request of [input, next]) expect(store.lookup(id, request.requestId)!.item).toMatchObject({ state: "waiting", claim: null, history: null });
      await driveConsumer(f!.running); expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(cli);
      expect(JSON.parse(readFileSync(join(f!.selected.dataDir, "pending-inputs.json"), "utf8")).conversations.find((c: any) => c.conversationId === id).pause).toEqual(store.inspect(id).pause);
      read.mockRestore(); proof.mockRestore(); reserve.mockRestore(); await unrelatedDirectInput(f!);
    } finally { read.mockRestore(); proof.mockRestore(); reserve.mockRestore(); await f!.running.close(); }
  }, TIMEOUT);

  test("Phase4c2 typed exact terminal proof source mismatch retains accepted claim and waiters without global poison or replay", async () => {
    const f = await isolatedQueueSeed("consumer-typed-terminal-mismatch", false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const input = queueWire(f.session), next = queueWire(f.session, "offline waiter behind mismatched terminal proof");
    const admit = f.running.preparedInput.admit, snapshot = OpenCodeAdapter.prototype.snapshot;
    let published: DispatchLifecycle | undefined, proof: ReturnType<typeof spyOn> | undefined, ready = false, mismatches = 0;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => {
      published = lifecycle; options!.publish!(lifecycle);
      const success = lifecycle.successfulSettlement;
      proof = spyOn(lifecycle, "successfulSettlement").mockImplementation(async () => { const result = await success(); ready = result.ready; return result; });
    } }));
    const read = spyOn(OpenCodeAdapter.prototype, "snapshot").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
      if (ready && args[0] === f.session.nativeSessionId && args[1] === published?.owner.run.nativeCommandId) { mismatches++; throw new OpenCodeSourceMismatchError("Offline exact consumer terminal source mismatch"); }
      return snapshot.apply(this, args);
    });
    try {
      await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(id, next);
      const before = mutations().length, cli = invocations().length; await driveConsumer(f.running);
      await until("published exact terminal mismatch", async () => published || undefined); await published!.done; await driveConsumer(f.running);
      expect(ready).toBe(true); expect(mismatches).toBeGreaterThan(0);
      expect(store.inspect(id).pause).toEqual({ code: "source-changed", reason: "Offline exact consumer terminal source mismatch" });
      const item = store.lookup(id, input.requestId)!.item;
      expect(item.state).toBe("run-linked"); expect(item.history).toBeNull(); expect(item.claim!.identity.runId).toBe(published!.owner.run.runId);
      expect(item.claim).toMatchObject({ possibleNative: true, uncertain: false, evidence: { submission: "submitted", nativeAcceptance: "accepted" } });
      expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null, history: null });
      await driveConsumer(f.running); await driveConsumer(f.running);
      expect(mutations().slice(before)).toEqual([expect.objectContaining({ path: `/api/session/${f.session.nativeSessionId}/prompt`, body: { id: item.claim!.identity.nativeCommandId, text: input.text, delivery: "queue" } })]);
      expect(invocations()).toHaveLength(cli);
      expect(JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).conversations.find((c: any) => c.conversationId === id).pause).toEqual(store.inspect(id).pause);
      read.mockRestore(); proof?.mockRestore(); publisher.mockRestore(); await unrelatedDirectInput(f);
    } finally { read.mockRestore(); proof?.mockRestore(); publisher.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  for (const [harness, field, value] of [["claude-code", "model", "changed-model"], ["opencode", "model", "fixture/changed"], ["opencode", "effort", "changed-variant"], ["opencode", "agent", "engineering"]] as const)
    test(`Phase4c2 published ${harness} owner ${field} drift with unchanged Session withholds native effects and pauses only its chain`, async () => {
      const f = await isolatedQueueSeed(`consumer-owner-${harness}-${field}`, false, harness), id = f.session.sessionId, store = f.running.pendingInputs.store;
      const input = queueWire(f.session), next = queueWire(f.session, "offline waiter behind changed installed launch"), admit = f.running.preparedInput.admit;
      let published: DispatchLifecycle | undefined;
      const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => {
        published = lifecycle; options!.publish!(lifecycle);
        if (field === "agent") lifecycle.owner.run.agent = "engineering"; else lifecycle.owner.run[field] = value;
      } }));
      try {
        await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(id, next);
        const before = mutations().length, cli = invocations().length; await driveConsumer(f.running);
        await until("published configuration refusal", async () => published || undefined); await published!.done; await driveConsumer(f.running);
        expect(store.inspect(id).pause).toEqual({ code: "configuration-changed", reason: "Installed queue owner launch settings differ from the captured launch" });
        const item = store.lookup(id, input.requestId)!.item;
        expect(item.claim!.identity.runId).toBe(published!.owner.run.runId);
        expect(item.claim).toMatchObject({ possibleNative: false, uncertain: false, evidence: { submission: "not-submitted", nativeAcceptance: "not-accepted" } });
        expect(item.history?.kind).toBe("not-submitted"); expect(published!.owner.run[field]).toBe(value);
        expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null, history: null });
        expect(JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).sessions.find((s: Session) => s.sessionId === id)[field]).toBe(f.session[field]);
        await driveConsumer(f.running); expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(cli);
        expect(JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).conversations.find((c: any) => c.conversationId === id).pause).toEqual(store.inspect(id).pause);
        publisher.mockRestore(); await unrelatedDirectInput(f);
      } finally { publisher.mockRestore(); await f.running.close(); }
    }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const) for (const drift of ["session", "owner"] as const)
    test(`Phase4c2 real ${harness} ${drift} drift only at final native boundary durably pauses without global poison`, async () => {
      const f = await heldQueueBoundary(`consumer-final-boundary-${harness}-${drift}`, harness, (owner, session) => {
        if (drift === "session") session.model = "changed-at-final-native-boundary";
        else owner.run.model = "changed-at-final-native-boundary";
      });
      const id = f.session.sessionId, input = queueWire(f.session), next = queueWire(f.session, "offline successor must stay waiting"), store = f.running.pendingInputs.store;
      const beforeNative = store.beforeNative;
      const nativeIntent = spyOn(store, "beforeNative").mockImplementation(evidence => { f.stages.push("before-native-store"); return beforeNative.call(store, evidence); });
      const release = spyOn(ConversationCoordinator.prototype, "releaseOwner");
      try {
        await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(id, next);
        const before = mutations().length, cli = invocations().length;
        f.running.pendingInputConsumer.poll(); await f.entered.promise; await f.running.pendingInputConsumer.drain();
        expect(f.published().owner.run.model).toBe(f.session.model); expect(f.live().model).toBe(f.session.model);
        expect(store.inspect(id).pause).toBeNull(); expect(nativeIntent).not.toHaveBeenCalled();
        f.gate.resolve(); await f.published().done; await driveConsumer(f.running);
        expect(f.stages).toEqual(["held-preparation", "released-preparation", "native-owner-check", "boundary-drift", "before-native-store"]);
        expect(nativeIntent).toHaveBeenCalledTimes(1);
        expect(f.boundaryError()).toBeInstanceOf(DispatchPreNativeRefusal);
        expect((f.boundaryError() as Error).cause).toBeInstanceOf(WorkstreamAdapterError);
        expect((f.boundaryError() as Error).cause).toMatchObject({ code: "configuration-changed" });
        expect(store.inspect(id).pause?.code).toBe("configuration-changed");
        const item = store.lookup(id, input.requestId)!.item;
        expect(item.claim!.identity.runId).toBe(f.published().owner.run.runId);
        expect(item.claim).toMatchObject({ possibleNative: false, uncertain: false, evidence: { submission: "not-submitted", nativeAcceptance: "not-accepted" } });
        expect(item.history?.kind).toBe("not-submitted"); expect(item.claim!.evidence).toEqual(f.published().submissionEvidence());
        expect(f.published().owner.run.status).toBe("failed"); expect((await f.published().successfulSettlement()).ready).toBe(false);
        const released = release.mock.calls.findIndex(([owner]) => owner === f.published().owner);
        expect(released).toBeGreaterThanOrEqual(0); expect(release.mock.results[released]!.value).toBe(true);
        const readiness = (await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.sessions.find((s: any) => s.sessionId === id).availability;
        expect(readiness.reason).not.toContain("Storage");
        expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null, history: null });
        const persisted = JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).conversations.find((c: any) => c.conversationId === id);
        expect(persisted.pause).toEqual(store.inspect(id).pause);
        expect(persisted.items.find((i: any) => i.requestId === input.requestId).claim.evidence).toEqual(f.published().submissionEvidence());
        expect(() => f.published().owner.dispatchEvidence!.beforeNative()).toThrow("replay forbidden");
        await driveConsumer(f.running); await driveConsumer(f.running);
        expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(cli);
        nativeIntent.mockRestore(); release.mockRestore(); f.restore(); await unrelatedDirectInput(f);
      } finally { nativeIntent.mockRestore(); release.mockRestore(); f.restore(); await f.running.close(); }
    }, TIMEOUT);

  for (const target of ["intent", "pause"] as const) for (const postRename of [false, true])
    test(`Phase4c2 ${target} writer ${postRename ? "post-rename" : "pre-write"} nominal drift error remains storage-fatal at native boundary`, async () => {
      const f = await heldQueueBoundary(`consumer-boundary-writer-${target}-${postRename}`, "opencode", (owner, _session) => {
        if (target === "pause") owner.run.model = "changed-at-final-native-boundary";
      });
      const id = f.session.sessionId, input = queueWire(f.session), store = f.running.pendingInputs.store;
      const deps = (store as unknown as { deps: PendingInputStoreDependencies }).deps, write = deps.write;
      let failedWrites = 0;
      deps.write = (dir, file, candidate) => {
        const conversation = (candidate as any).conversations.find((c: any) => c.conversationId === id);
        const fail = target === "pause" ? conversation?.pause?.code === "configuration-changed" : conversation?.items.some((i: any) => i.claim?.possibleNative === true);
        if (fail) {
          failedWrites++;
          if (postRename) (write ?? atomicAppRecord)(dir, file, candidate);
          throw new PendingInputDomainError("configuration-changed", "Offline writer threw a misleading nominal domain error");
        }
        (write ?? atomicAppRecord)(dir, file, candidate);
      };
      try {
        await f.running.pendingInputs.enqueue(id, input); const before = prompts().length;
        f.running.pendingInputConsumer.poll(); await f.entered.promise; f.gate.resolve(); await f.published().done; await f.running.pendingInputConsumer.drain();
        expect(failedWrites).toBe(1); expect(f.boundaryError()).toBeInstanceOf(PendingInputStorageError);
        expect(f.boundaryError()).not.toBeInstanceOf(DispatchPreNativeRefusal);
        expect(prompts()).toHaveLength(before); expect((await f.published().successfulSettlement()).ready).toBe(false);
        expect((await isolatedApi(f.running, "/api/sessions", { harness: "claude-code", prompt: "offline storage must be closed" }, f.token)).body.code).toBe("storage-unavailable");
        const persisted = JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).conversations.find((c: any) => c.conversationId === id);
        if (target === "intent") expect(persisted.items.find((i: any) => i.requestId === input.requestId).claim.possibleNative).toBe(postRename);
        else expect(persisted.pause?.code === "configuration-changed").toBe(postRename);
        await driveConsumer(f.running); expect(prompts()).toHaveLength(before);
      } finally { deps.write = write; f.restore(); await closeStorageFailedFixture(f); }
    }, TIMEOUT);

  for (const error of [new WorkstreamAdapterError(409, "configuration-changed", "Offline arbitrary adapter code"),
    new PendingInputDomainError("scheduler-identity", "Offline identity invariant"), new Error("Offline unknown native boundary failure")])
    test(`Phase4c2 native boundary never certifies ${error.message}`, async () => {
      const f = await heldQueueBoundary(`consumer-boundary-uncertified-${crypto.randomUUID()}`, "opencode", () => {}), id = f.session.sessionId;
      const failure = spyOn(f.running.pendingInputs.store, "beforeNative").mockImplementation(() => { throw error; });
      try {
        await f.running.pendingInputs.enqueue(id, queueWire(f.session)); const before = prompts().length;
        f.running.pendingInputConsumer.poll(); await f.entered.promise; f.gate.resolve(); await f.published().done; await f.running.pendingInputConsumer.drain();
        expect(f.boundaryError()).not.toBeInstanceOf(DispatchPreNativeRefusal); expect(prompts()).toHaveLength(before);
        expect((await isolatedApi(f.running, "/api/sessions", { harness: "claude-code", prompt: "offline fatal boundary" }, f.token)).body.code).toBe("storage-unavailable");
      } finally { failure.mockRestore(); f.restore(); await closeStorageFailedFixture(f); }
    }, TIMEOUT);

  test("Phase4c2 installed-owner configuration projection preserves canonical absent versus undefined settings", async () => {
    const f = await isolatedQueueSeed("consumer-owner-canonical-omission", false), id = f.session.sessionId, input = queueWire(f.session), admit = f.running.preparedInput.admit;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => {
      options!.publish!(lifecycle);
      for (const field of ["model", "effort", "agent", "agentKind", "nativeAgentSelected"] as const) {
        if (prepared.configuration[field] === undefined) lifecycle.owner.run[field] = undefined;
      }
    } }));
    try {
      await f.running.pendingInputs.enqueue(id, input); const before = invocations().length;
      const item = await settledInput(f.running, id, input.requestId);
      expect(item.history).toMatchObject({ kind: "settled", status: "completed" }); expect(invocations()).toHaveLength(before + 1);
      expect(f.running.pendingInputs.store.inspect(id).pause).toBeNull();
    } finally { publisher.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase4c2 committed resume DTO cannot manufacture a live chain-revision capability", async () => {
    const f = await isolatedQueueSeed("consumer-resume-dormant", false, "opencode"), id = f.session.sessionId, input = queueWire(f.session), store = f.running.pendingInputs.store;
    try {
      await f.running.pendingInputs.enqueue(id, input); store.pause(id, { code: "stopped", reason: "Offline explicit resume needed" });
      // Simulate a historical receipt lacking process-local publication. Neither
      // the ledger nor the stored lastAuthorization may replace that capability.
      const deps = (f.running.pendingInputs as unknown as { deps: PendingInputServiceDependencies }).deps, callback = deps.resumeCommitted;
      deps.resumeCommitted = undefined;
      try { await f.running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.inspect(id).snapshot.revision }); }
      finally { deps.resumeCommitted = callback; }
      const before = prompts().length; await driveConsumer(f.running);
      expect(store.lookup(id, input.requestId)!.item.claim).toBeNull(); expect(prompts()).toHaveLength(before);
    } finally { await f.running.close(); }
  }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const) for (const action of ["cancel", "hide"] as const)
    test(`Phase5b fresh ${harness} ${action}/unhide resume is dormant until drive, consumes one grant and advances by live success`, async () => {
      const f = await isolatedQueueSeed(`resume-${harness}-${action}`, false, harness), id = f.session.sessionId, store = f.running.pendingInputs.store;
      try {
        const first = queueWire(f.session, "offline fresh consent head"), next = queueWire(f.session, "offline ordinary successor after consent");
        await f.running.pendingInputs.enqueue(id, first); await f.running.pendingInputs.enqueue(id, next);
        const chain = store.inspect(id).chain;
        expect((await isolatedApi(f.running, `/api/sessions/${id}/${action}`, {}, f.token)).status).toBe(200);
        if (action === "hide") expect((await isolatedApi(f.running, `/api/sessions/${id}/unhide`, {}, f.token)).status).toBe(200);
        const before = harness === "opencode" ? prompts().length : invocations().length;
        const request = { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision };
        const receipt = await f.running.pendingInputs.resume(id, request);
        expect(store.inspect(id).chain).toEqual(chain); expect(store.get(id).paused).toBe(false);
        await Bun.sleep(100); expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before);
        await settledInput(f.running, id, next.requestId);
        const head = store.lookup(id, first.requestId)!.item, successor = store.lookup(id, next.requestId)!.item;
        expect(head.claim!.authorization.predecessorRunId).toBe(f.session.lastRunId);
        expect(successor.claim!.authorization.predecessorRunId).toBe(head.claim!.identity.runId);
        expect(head.claim!.expectedRevision).toBe(receipt.revision); expect(successor.history).toMatchObject({ kind: "settled", status: "completed" });
        expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before + 2);
      } finally { await f.running.close(); }
    }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const)
    test(`Phase5b ${harness} failed settled predecessor needs new consent, retains sticky Stop history and does not reuse consent after another failure`, async () => {
      const f = await isolatedQueueSeed(`resume-failed-${harness}`, false, harness), id = f.session.sessionId, store = f.running.pendingInputs.store;
      const admit = f.running.preparedInput.admit; let published: DispatchLifecycle | undefined;
      const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
      try {
        const first = queueWire(f.session, harness === "claude-code" ? "fail for FIFO consumer resume predecessor" : "hold for failed resume predecessor");
        const second = queueWire(f.session, harness === "claude-code" ? "fail for FIFO consumer resumed head" : "hold for failed resumed head"), last = queueWire(f.session, "offline waiting after second failure"), healthy = queueWire(f.session, "offline ordinary healthy successor");
        await f.running.pendingInputs.enqueue(id, first); await f.running.pendingInputs.enqueue(id, second); await f.running.pendingInputs.enqueue(id, last);
        await driveConsumer(f.running); await until("failed predecessor submitted", async () => published?.submissionEvidence().submission === "submitted" || undefined);
        if (harness === "opencode") complete(f.session.nativeSessionId!, "failed");
        const failed = published!; await failed.done; await settledInput(f.running, id, first.requestId);
        failed.owner.stopRequested = true; failed.owner.stopping = Promise.resolve(true);
        const before = harness === "opencode" ? prompts().length : invocations().length;
        await driveConsumer(f.running); expect(store.lookup(id, second.requestId)!.item.claim).toBeNull();
        const request = { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision };
        const receipt = await f.running.pendingInputs.resume(id, request); await driveConsumer(f.running);
        await until("resumed failed head submitted", async () => published !== failed && published?.submissionEvidence().submission === "submitted" || undefined);
        expect(store.lookup(id, second.requestId)!.item.claim!.authorization.predecessorRunId).toBe(failed.owner.run.runId);
        expect(failed.owner.stopRequested).toBe(true); expect(failed.owner.stopping).toBeDefined();
        if (harness === "opencode") complete(f.session.nativeSessionId!, "failed");
        await published!.done; await settledInput(f.running, id, second.requestId);
        expect(await f.running.pendingInputs.resume(id, request)).toEqual(receipt); await driveConsumer(f.running);
        expect(store.lookup(id, last.requestId)!.item.claim).toBeNull(); expect(store.get(id).paused).toBe(true);
        await f.running.pendingInputs.enqueue(id, healthy);
        await f.running.pendingInputs.resume(id, { ...request, requestId: crypto.randomUUID(), expectedRevision: store.get(id).revision });
        await settledInput(f.running, id, healthy.requestId);
        expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before + 3);
        expect(store.lookup(id, healthy.requestId)!.item.claim!.authorization.predecessorRunId).toBe(store.lookup(id, last.requestId)!.item.claim!.identity.runId);
      } finally { publisher.mockRestore(); await f.running.close(); }
    }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const)
    test(`Phase5b ${harness} duplicate/stale consent after another Stop cannot reauthorize any waiter`, async () => {
      const f = await isolatedQueueSeed(`resume-dedup-${harness}`, false, harness), id = f.session.sessionId, store = f.running.pendingInputs.store;
      try {
        const input = queueWire(f.session); await f.running.pendingInputs.enqueue(id, input);
        const request = { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision };
        const receipt = await f.running.pendingInputs.resume(id, request);
        expect((await isolatedApi(f.running, `/api/sessions/${id}/cancel`, {}, f.token)).status).toBe(200);
        const revision = store.get(id).revision, before = harness === "opencode" ? prompts().length : invocations().length;
        expect(await f.running.pendingInputs.resume(id, request)).toEqual(receipt);
        await expect(f.running.pendingInputs.resume(id, { ...request, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: "pending-input-stale" });
        await driveConsumer(f.running); expect(store.get(id).revision).toBe(revision); expect(store.lookup(id, input.requestId)!.item.claim).toBeNull();
        expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before);
        await f.running.pendingInputs.resume(id, { ...request, requestId: crypto.randomUUID(), expectedRevision: revision });
        await settledInput(f.running, id, input.requestId);
      } finally { await f.running.close(); }
    }, TIMEOUT);

  test("Phase5b same-chain removal/refill during live resume idle proof selects the new head at its fresh revision without a lease", async () => {
    const f = await isolatedQueueSeed("resume-refill", false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), activity = OpenCodeAdapter.prototype.activity;
    let held = false;
    const read = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(async function(this: OpenCodeAdapter, ...args) { if (args[0] === f.session.nativeSessionId && !held) { held = true; entered.resolve(); await gate.promise; } return activity.apply(this, args); });
    const reserve = spyOn(ConversationCoordinator.prototype, "reserveAdmission");
    try {
      const first = queueWire(f.session), next = queueWire(f.session, "offline replacement waiting head"), refill = queueWire(f.session, "offline same chain refill");
      const receipt = await f.running.pendingInputs.enqueue(id, first); await f.running.pendingInputs.enqueue(id, next);
      const chain = store.inspect(id).chain;
      await f.running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision });
      const reservations = reserve.mock.calls.length; f.running.pendingInputConsumer.poll(); await entered.promise;
      expect(reserve.mock.calls.length).toBe(reservations);
      await f.running.pendingInputs.remove(id, receipt.itemId, { version: 1, requestId: crypto.randomUUID(), conversationId: id, itemId: receipt.itemId, inputRequestId: first.requestId });
      await f.running.pendingInputs.enqueue(id, refill); const revision = store.get(id).revision;
      gate.resolve(); await f.running.pendingInputConsumer.drain(); expect(store.lookup(id, next.requestId)!.item.claim).toBeNull();
      await settledInput(f.running, id, refill.requestId);
      expect(store.lookup(id, next.requestId)!.item.claim!.expectedRevision).toBe(revision);
      expect(store.lookup(id, next.requestId)!.item.chainId).toBe(chain!.chainId); expect(store.lookup(id, first.requestId)!.item.state).toBe("removed");
    } finally { gate.resolve(); read.mockRestore(); reserve.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  for (const nativeProof of ["idle", "busy", "unavailable"] as const) for (const barrier of ["unsettled", "cancelling", "reconciliation", "foreign-owner"] as const)
    test(`Phase5b original predecessor ${barrier} during awaited resume ${nativeProof} proof revokes consent without a lease; duplicate cannot renew it`, async () => {
      let predecessor: DispatchLifecycle | undefined;
      const startDispatch = HarnessDispatchRegistry.prototype.start;
      const capture = spyOn(HarnessDispatchRegistry.prototype, "start").mockImplementation(function(this: HarnessDispatchRegistry, ...args) { predecessor = startDispatch.apply(this, args); return predecessor; });
      let f: Awaited<ReturnType<typeof isolatedQueueSeed>>;
      try { f = await isolatedQueueSeed(`resume-barrier-${nativeProof}-${barrier}`, false, "opencode"); } finally { capture.mockRestore(); }
      await predecessor!.done;
      const id = f!.session.sessionId, store = f!.running.pendingInputs.store, entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
      const activity = OpenCodeAdapter.prototype.activity, fake = sessions.get(f!.session.nativeSessionId!)!; let held = false, block = false;
      const read = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
        if (args[0] === f!.session.nativeSessionId && !held) {
          held = true; entered.resolve(); await gate.promise;
          if (nativeProof === "unavailable") throw new OpenCodeUnavailableError("Offline held resume proof unavailable");
        }
        return activity.apply(this, args);
      });
      const reconcile = ConversationCoordinator.prototype.hasReconciliation, getOwner = ConversationCoordinator.prototype.getOwner;
      const reconciliation = spyOn(ConversationCoordinator.prototype, "hasReconciliation").mockImplementation(function(this: ConversationCoordinator<RunOwner>, cid) { return block && barrier === "reconciliation" && cid === id || reconcile.call(this, cid); });
      const foreign = { ...predecessor!.owner, run: { ...predecessor!.owner.run, runId: crypto.randomUUID() } };
      const owner = spyOn(ConversationCoordinator.prototype, "getOwner").mockImplementation(function(this: ConversationCoordinator<RunOwner>, cid) { return block && barrier === "foreign-owner" && cid === id ? foreign : getOwner.call(this, cid); });
      const reserve = spyOn(ConversationCoordinator.prototype, "reserveAdmission");
      try {
        const input = queueWire(f!.session); await f!.running.pendingInputs.enqueue(id, input);
        const original = store.lookup(id, input.requestId)!.item;
        const request = { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision };
        const receipt = await f!.running.pendingInputs.resume(id, request), reservations = reserve.mock.calls.length, before = prompts().length;
        f!.running.pendingInputConsumer.poll(); await entered.promise; block = true;
        fake.active = nativeProof === "busy";
        if (barrier === "unsettled") predecessor!.owner.settled = false;
        if (barrier === "cancelling") predecessor!.owner.cancelling = true;
        gate.resolve(); await f!.running.pendingInputConsumer.drain();
        expect(reserve.mock.calls.length).toBe(reservations); expect(store.lookup(id, input.requestId)!.item.claim).toBeNull();
        block = false; fake.active = false; predecessor!.owner.settled = true; predecessor!.owner.cancelling = false;
        await driveConsumer(f!.running);
        expect(store.lookup(id, input.requestId)!.item.claim).toBeNull(); expect(prompts()).toHaveLength(before);
        expect(await f!.running.pendingInputs.resume(id, request)).toEqual(receipt); await driveConsumer(f!.running);
        expect(store.lookup(id, input.requestId)!.item.claim).toBeNull(); expect(prompts()).toHaveLength(before);
        expect(store.lookup(id, input.requestId)!.item).toMatchObject({ itemId: original.itemId, request: original.request, snapshot: original.snapshot });
        await f!.running.pendingInputs.resume(id, { ...request, requestId: crypto.randomUUID(), expectedRevision: store.get(id).revision });
        await settledInput(f!.running, id, input.requestId);
        expect(prompts()).toHaveLength(before + 1);
      } finally { block = false; fake.active = false; predecessor!.owner.settled = true; predecessor!.owner.cancelling = false; gate.resolve(); read.mockRestore(); reconciliation.mockRestore(); owner.mockRestore(); reserve.mockRestore(); await f!.running.close(); }
    }, TIMEOUT);

  for (const nativeProof of ["busy", "unavailable"] as const) test(`Phase5b native ${nativeProof} resume proof preserves valid consent without a lease until a fresh healthy idle observation`, async () => {
    const f = await isolatedQueueSeed(`resume-valid-${nativeProof}`, false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store, fake = sessions.get(f.session.nativeSessionId!)!;
    const activity = OpenCodeAdapter.prototype.activity; let unavailable = false;
    const read = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
      if (args[0] === f.session.nativeSessionId && unavailable) throw new OpenCodeUnavailableError("Offline valid resume proof unavailable");
      return activity.apply(this, args);
    });
    const reserve = spyOn(ConversationCoordinator.prototype, "reserveAdmission");
    try {
      const input = queueWire(f.session); await f.running.pendingInputs.enqueue(id, input);
      const receipt = await f.running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision });
      const original = store.lookup(id, input.requestId)!.item;
      const reservations = reserve.mock.calls.length, before = prompts().length; fake.active = nativeProof === "busy"; unavailable = nativeProof === "unavailable";
      await driveConsumer(f.running); expect(reserve.mock.calls.length).toBe(reservations); expect(store.lookup(id, input.requestId)!.item.claim).toBeNull(); expect(prompts()).toHaveLength(before);
      expect(store.inspect(id).pause).toBeNull(); expect(store.get(id).revision).toBe(receipt.revision);
      fake.active = false; unavailable = false; await settledInput(f.running, id, input.requestId);
      expect(store.lookup(id, input.requestId)!.item).toMatchObject({ itemId: original.itemId, request: original.request, snapshot: original.snapshot, claim: { expectedRevision: receipt.revision } });
      expect(prompts()).toHaveLength(before + 1);
    } finally { fake.active = false; unavailable = false; read.mockRestore(); reserve.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("live OC acknowledged pending removal archives interrupted without native history and preserves paused FIFO for explicit Resume", async () => {
    const f = await isolatedQueueSeed("live-oc-pending-stop", false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const fake = sessions.get(f.session.nativeSessionId!)!, head = queueWire(f.session, "offline original live pending Stop head");
    const next = queueWire(f.session, "offline exact first paused FIFO waiter"), last = queueWire(f.session, "offline exact second paused FIFO waiter");
    const admit = f.running.preparedInput.admit, preflight = OpenCodeAdapter.prototype.preflightNativeSession, install = ConversationCoordinator.prototype.installOwner;
    let published: DispatchLifecycle | undefined, coordinator: ConversationCoordinator | undefined;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
    const arbitration = spyOn(ConversationCoordinator.prototype, "installOwner").mockImplementation(function(this: ConversationCoordinator, lease, owner) {
      if (owner.run.sessionId === id) coordinator = this;
      return install.call(this, lease, owner);
    });
    const foreign = spyOn(OpenCodeAdapter.prototype, "preflightNativeSession").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
      if (args[0] === f.session.nativeSessionId && store.lookup(id, head.requestId)?.item.claim) fake.active = true;
      return preflight.apply(this, args);
    });
    try {
      await f.running.pendingInputs.enqueue(id, head); await f.running.pendingInputs.enqueue(id, next); await f.running.pendingInputs.enqueue(id, last);
      const nextOriginal = structuredClone(store.lookup(id, next.requestId)!.item), lastOriginal = structuredClone(store.lookup(id, last.requestId)!.item);
      const before = prompts().length; await driveConsumer(f.running);
      const original = await until("live original typed queued ACK", async () => {
        const item = store.lookup(id, head.requestId)!.item;
        return item.claim?.evidence?.nativeAcceptance === "accepted" && published?.owner.run.nativePhase === "accepted" ? structuredClone(item) : undefined;
      });
      const identity = original.claim!.identity, lifecycle = published!, nativeBefore = calls.length;
      expect(fake.inbox.find(input => input.id === identity.nativeCommandId)).toMatchObject({ sessionID: f.session.nativeSessionId, type: "user", delivery: "queue" });
      expect(coordinator!.hasOwner(id)).toBe(true); expect(coordinator!.hasAdmission(id)).toBe(true);
      const stop = await isolatedApi(f.running, `/api/sessions/${id}/cancel`, {}, f.token);
      expect(stop).toMatchObject({ status: 200, body: { interrupted: true } });
      await lifecycle.done;
      const settled = await settledInput(f.running, id, head.requestId);
      expect(settled).toMatchObject({ state: "settled", claim: { identity, uncertain: false, evidence: original.claim!.evidence }, history: { kind: "settled", status: "interrupted", authorization: { kind: "settlement", predecessorRunId: identity.runId, source: identity.source } } });
      expect(settled.claim!.authorization).toEqual(original.claim!.authorization);
      expect(lifecycle.owner).toMatchObject({ settled: true, cancelling: false, stopRequested: true, run: { status: "interrupted" } });
      expect((await lifecycle.successfulSettlement()).ready).toBe(false);
      expect(calls.slice(nativeBefore).filter(call => call.method !== "GET")).toEqual([expect.objectContaining({ method: "DELETE", path: `/api/session/${f.session.nativeSessionId}/inbox/${identity.nativeCommandId}` })]);
      expect(calls.slice(nativeBefore)).toContainEqual(expect.objectContaining({ method: "GET", path: `/api/session/${f.session.nativeSessionId}/message/${identity.nativeCommandId}` }));
      expect(fake.messages.some(message => message.id === identity.nativeCommandId)).toBe(false);
      expect(fake.inbox.some(input => input.id === identity.nativeCommandId)).toBe(false);
      const snapshot = await new OpenCodeAdapter(undefined, undefined, join(root, "oc", "service.json")).snapshot(f.session.nativeSessionId!, identity.nativeCommandId!, f.session.cwd);
      expect(snapshot.pending).toBe(false); expect(snapshot.outcome).toBeUndefined();
      expect(fake.active).toBe(true); // Foreign native busyness is not this deleted head's execution.
      expect(coordinator!.hasOwner(id)).toBe(false); expect(coordinator!.hasAdmission(id)).toBe(false); expect(coordinator!.hasReconciliation(id)).toBe(false);
      expect(store.inspect(id).pause?.code).toBe("stopped");
      expect(store.lookup(id, next.requestId)!.item).toEqual(nextOriginal); expect(store.lookup(id, last.requestId)!.item).toEqual(lastOriginal);
      await driveConsumer(f.running); expect(prompts()).toHaveLength(before + 1);
      foreign.mockRestore(); fake.active = false;
      await driveConsumer(f.running); expect(prompts()).toHaveLength(before + 1); // Idle is not Resume consent.
      await f.running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision });
      const resumed = await settledInput(f.running, id, next.requestId);
      expect(resumed.claim!.identity.nativeCommandId).not.toBe(identity.nativeCommandId);
      expect(prompts().slice(before).map(call => call.body.text).slice(0, 2)).toEqual([head.text, next.text]);
      expect(prompts().filter(call => call.body.id === identity.nativeCommandId)).toHaveLength(1);
      expect(prompts().filter(call => call.body.id === resumed.claim!.identity.nativeCommandId)).toHaveLength(1);
      expect(resumed.claim!.authorization.predecessorRunId).toBe(identity.runId);
      // Resume permits the completed predecessor to dispatch the final waiter;
      // drain that legitimate turn before shutdown closes settlement observation.
      const final = await settledInput(f.running, id, last.requestId);
      expect(prompts().slice(before).map(call => call.body.text)).toEqual([head.text, next.text, last.text]);
      expect(prompts().filter(call => call.body.id === final.claim!.identity.nativeCommandId)).toHaveLength(1);
      expect(final.claim!.authorization.predecessorRunId).toBe(resumed.claim!.identity.runId);
    } finally { foreign.mockRestore(); arbitration.mockRestore(); publisher.mockRestore(); fake.active = false; await f.running.close(); }
  }, TIMEOUT);

  test("Phase5c1 CC consumed Stop archives exact interrupted identity only after acknowledged termination and retains stopped waiters", async () => {
    const f = await isolatedQueueSeed("resume-cc-interrupt-gap", false), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const admit = f.running.preparedInput.admit; let published: DispatchLifecycle | undefined;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
    try {
      const head = queueWire(f.session, "hold for Claude followup consumed FIFO Stop"), next = queueWire(f.session);
      await f.running.pendingInputs.enqueue(id, head); await f.running.pendingInputs.enqueue(id, next); await driveConsumer(f.running);
      await until("known CC child is installed", async () => published?.owner.child || undefined);
      const identity = store.lookup(id, head.requestId)!.item.claim!.identity;
      expect((await isolatedApi(f.running, `/api/sessions/${id}/cancel`, {}, f.token)).status).toBe(200);
      await published!.done; await driveConsumer(f.running); await driveConsumer(f.running);
      expect(published!.owner).toMatchObject({ settled: true, streamsDrained: true, run: { status: "interrupted" } });
      // The settlement consumed its original lease; paused waiters do not renew it.
      expect((await published!.releasedSettlement()).ready).toBe(false);
      expect((await published!.successfulSettlement()).ready).toBe(false);
      expect(store.lookup(id, head.requestId)!.item).toMatchObject({ state: "settled", history: { kind: "settled", status: "interrupted" }, claim: { identity, possibleNative: true } });
      expect(store.inspect(id).pause?.code).toBe("stopped");
      expect(store.lookup(id, next.requestId)!.item.request.text).toBe(next.text);
      expect(store.lookup(id, next.requestId)!.item.claim).toBeNull();
    } finally { publisher.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  for (const failure of ["result", "execution-result", "nonzero"] as const) test(`Phase5c1 CC ${failure} failure archives exact service-classified failed turn, never interrupted or next`, async () => {
    const f = await isolatedQueueSeed(`terminal-failed-${failure}`, false), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const head = queueWire(f.session, failure === "nonzero" ? "fail for FIFO consumer Phase5c1 nonzero" : `Phase5c1 ${failure} failure exit zero`);
    const next = queueWire(f.session, "Phase5c1 preserve this waiting text");
    let published: DispatchLifecycle | undefined, service: ClaudeRunService | undefined;
    const execute = ClaudeRunService.prototype.execute, admit = f.running.preparedInput.admit;
    const capture = spyOn(ClaudeRunService.prototype, "execute").mockImplementation(function(this: ClaudeRunService, ...args) { if (args[0].run.sessionId === id) service = this; return execute.apply(this, args); });
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
    try {
      const before = invocations().length;
      await f.running.pendingInputs.enqueue(id, head); await f.running.pendingInputs.enqueue(id, next);
      const settled = await settledInput(f.running, id, head.requestId);
      expect(settled.history).toMatchObject({ kind: "settled", status: "failed" });
      const local = service!.readLocalSettlement(published!.owner);
      expect(local).toMatchObject({ ready: true, kind: "terminated", evidence: { exitObserved: true, exitCode: failure === "nonzero" ? 1 : 0,
        streamsDrained: true, lifecycleFinished: true, terminal: { status: "failed", cause: failure === "nonzero" ? "nonzero-exit" : "result-failure" } } });
      expect(settled.claim!.identity).toEqual({ source: published!.submissionEvidence().source, runId: published!.owner.run.runId, nativeCommandId: null, requestId: head.requestId });
      expect((await published!.releasedSettlement()).ready).toBe(false);
      expect((await published!.successfulSettlement()).ready).toBe(false);
      expect(store.inspect(id).pause?.code).toBe("failed");
      await driveConsumer(f.running); expect(invocations()).toHaveLength(before + 1);
      expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null, request: { text: next.text } });
    } finally { capture.mockRestore(); publisher.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  for (const barrier of ["termination-false", "termination-pending", "streams-rejected", "group-alive", "reconciliation", "status-altered", "child-replaced", "source-mismatch", "foreign-admission"] as const)
    test(`Phase5c1 CC ${barrier} cannot archive or advance despite done; original retained queue lease does not self-block`, async () => {
      const f = await isolatedQueueSeed(`terminal-barrier-${barrier}`, false), id = f.session.sessionId, store = f.running.pendingInputs.store;
      const head = queueWire(f.session, "Phase5c1 result failure barrier"), next = queueWire(f.session, "Phase5c1 barrier waiter unchanged");
      let published: DispatchLifecycle | undefined, service: ClaudeRunService | undefined, coordinator: ConversationCoordinator | undefined, originalLease: ConversationAdmissionLease | undefined;
      const execute = ClaudeRunService.prototype.execute, admit = f.running.preparedInput.admit, install = ConversationCoordinator.prototype.installOwner;
      const capture = spyOn(ClaudeRunService.prototype, "execute").mockImplementation(function(this: ClaudeRunService, ...args) { if (args[0].run.sessionId === id) service = this; return execute.apply(this, args); });
      const arbitration = spyOn(ConversationCoordinator.prototype, "installOwner").mockImplementation(function(this: ConversationCoordinator, lease, owner) { if (owner.run.sessionId === id) { coordinator = this; originalLease = lease; } return install.call(this, lease, owner); });
      const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
      let restore = () => {};
      try {
        await f.running.pendingInputs.enqueue(id, head); await f.running.pendingInputs.enqueue(id, next); await driveConsumer(f.running);
        await until("Phase5c1 terminal handle", async () => published || undefined); await published!.done;
        const owner = published!.owner, identity = store.lookup(id, head.requestId)!.item.claim!.identity;
        expect(coordinator!.hasAdmission(id)).toBe(true); expect(coordinator!.hasOwner(id)).toBe(false);
        expect(await published!.releasedSettlement()).toEqual({ ready: true }); // its exact original lease is expected
        const internals = service as unknown as { supervision: WeakMap<RunOwner, { termination: string; streamsDrained: boolean; pid: number }>;
          runtime: { kill: (pid: number, signal: NodeJS.Signals | 0) => void }; deps: ClaudeRunDependencies };
        const state = internals.supervision.get(owner)!;
        if (barrier === "termination-false" || barrier === "termination-pending") {
          const original = state.termination; state.termination = barrier === "termination-false" ? "unconfirmed" : "pending"; restore = () => { state.termination = original; };
        } else if (barrier === "streams-rejected") {
          state.streamsDrained = false; restore = () => { state.streamsDrained = true; };
        } else if (barrier === "group-alive") {
          const kill = internals.runtime.kill; internals.runtime.kill = (pid, signal) => { if (pid === -state.pid && signal === 0) return; return kill(pid, signal); }; restore = () => { internals.runtime.kill = kill; };
        } else if (barrier === "reconciliation") {
          const pending = spyOn(coordinator!, "hasReconciliation").mockImplementation(cid => cid === id); restore = () => pending.mockRestore();
        } else if (barrier === "status-altered") {
          owner.run.status = "completed"; restore = () => { owner.run.status = "failed"; };
        } else if (barrier === "child-replaced") {
          const child = owner.child; owner.child = { ...child!, exitCode: 0 } as typeof child; restore = () => { owner.child = child; };
        } else if (barrier === "source-mismatch") {
          const session = internals.deps.session(id)!, source = session.nativeSessionId; session.nativeSessionId = crypto.randomUUID(); restore = () => { session.nativeSessionId = source; };
        } else {
          // A different reservation cannot impersonate the original opaque lease.
          expect(coordinator!.releaseAdmission(originalLease!)).toBe(true);
          const foreign = coordinator!.reserveAdmission({ conversationIds: [id], intent: { kind: "compact", requestId: crypto.randomUUID() } });
          expect(foreign.ready).toBe(true);
          if (!foreign.ready) throw new Error(foreign.reason);
          restore = () => { coordinator!.releaseAdmission(foreign.lease); };
          expect((await published!.releasedSettlement()).ready).toBe(false);
        }
        const before = invocations().length;
        if (!["reconciliation", "foreign-admission"].includes(barrier)) expect(service!.readLocalSettlement(owner).ready).toBe(false);
        await driveConsumer(f.running); await driveConsumer(f.running);
        expect(store.lookup(id, head.requestId)!.item).toMatchObject({ state: "run-linked", history: null, claim: { identity } });
        expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null, request: { text: next.text } });
        expect(invocations()).toHaveLength(before); expect(store.inspect(id).chain).not.toBeNull();
      } finally { restore(); capture.mockRestore(); arbitration.mockRestore(); publisher.mockRestore(); await f.running.close(); }
    }, TIMEOUT);

  test("Phase5e2 recovered typed original receipt observes and Stops exact pending input with exact or missing Run metadata, without replay or settlement", async () => {
    for (const metadata of ["exact", "missing"] as const) {
      const f = await recoveredOCSeed(`phase5e2-pending-${metadata}`), id = f.session.sessionId, identity = f.original.claim!.identity;
      if (metadata === "missing") {
        const record = JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8"));
        record.runs = record.runs.filter((run: any) => run.runId !== identity.runId);
        record.sessions[0].lastRunId = record.runs.at(-1).runId; record.sessions[0].lastStatus = record.runs.at(-1).status;
        atomicAppRecord(f.selected.dataDir, "metadata.json", record);
      }
      const fake = sessions.get(identity.source.nativeSessionId!)!, foreign = { id: "msg_phase5e2_foreign_waiter", sessionID: identity.source.nativeSessionId, type: "user", delivery: "queue", time: { created: 123 }, payload: { text: "foreign unchanged" } };
      fake.inbox.push(foreign);
      const before = mutations().length, nativeCallsBefore = calls.length, read = spyOn(OpenCodeAdapter.prototype, "snapshot");
      const running = await start({ ...f.selected, cwd: f.session.cwd, maxConcurrentRuns: 1 });
      try {
        const token = await isolatedLogin(running), store = running.pendingInputs.store;
        expect(read.mock.calls.some(args => args[0] === identity.source.nativeSessionId && args[1] === identity.nativeCommandId && args[2] === identity.source.cwd && args[3] === "native-queued-handoff")).toBe(true);
        expect(mutations()).toHaveLength(before);
        expect(store.lookup(id, f.head.requestId)!.item).toMatchObject({ ...f.original, claim: { ...f.original.claim!, uncertain: true, evidence: { ...identity, submission: "submitted", nativeAcceptance: "accepted" } } });
        const stop = await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, token);
        expect(stop).toMatchObject({ status: 200, body: { interrupted: true, reconciliationRequired: true } });
        expect(calls.slice(nativeCallsBefore).filter(call => call.method !== "GET")).toEqual([expect.objectContaining({ method: "DELETE", path: `/api/session/${identity.source.nativeSessionId}/inbox/${identity.nativeCommandId}` })]);
        expect(fake.inbox).toEqual([foreign]); expect(fake.active).toBe(true);
        await driveConsumer(running);
        expect(store.lookup(id, f.head.requestId)!.item).toMatchObject({ state: "run-linked", history: null, claim: { identity, uncertain: true } });
        expect(store.lookup(id, f.waiter.requestId)!.item).toMatchObject({ state: "waiting", claim: null, request: { text: f.waiter.text } });
        expect(store.inspect(id).pause).not.toBeNull();
        expect((await isolatedApi(running, "/api/sessions", undefined, token)).body.availability.code).toBe("capacity");
        await expect(running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision })).rejects.toMatchObject({ code: "pending-input-claimed" });
        expect(mutations()).toHaveLength(before); // Existing mutations() counts POST, not the exact DELETE above.
        const after = JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8"));
        expect(after.runs.some((run: any) => run.runId === identity.runId)).toBe(metadata === "exact");
      } finally { read.mockRestore(); await running.close(); }
    }
  }, TIMEOUT);

  test("Phase5e2 original protocol contradiction is journaled without Run metadata and survives restart to block typed and consumed Stop", async () => {
    const f = await recoveredOCSeed("phase5e2-original-protocol-journal"), id = f.session.sessionId, identity = f.original.claim!.identity;
    const metadataPath = join(f.selected.dataDir, "metadata.json"), metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    metadata.runs = metadata.runs.filter((run: any) => run.runId !== identity.runId);
    metadata.sessions[0].lastRunId = metadata.runs.at(-1).runId; metadata.sessions[0].lastStatus = metadata.runs.at(-1).status;
    atomicAppRecord(f.selected.dataDir, "metadata.json", metadata);
    const journalPath = join(f.selected.dataDir, `${identity.runId}.jsonl`);
    const journal = () => readFileSync(journalPath, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    const fake = sessions.get(identity.source.nativeSessionId!)!, input = fake.inbox.find(input => input.id === identity.nativeCommandId);
    const time = input.time;
    input.time = { created: "invalid-protocol-time" }; // Exact ID/session/user/queue alone is not a typed receipt.
    const before = calls.length;
    let running = await start({ ...f.selected, cwd: f.session.cwd, maxConcurrentRuns: 1 });
    try {
      const marker = journal().find(event => event.data?.nativeQueuedHandoffProtocolMismatch === true);
      expect(marker).toMatchObject({ runId: identity.runId, sessionId: id, kind: "status", data: { recoveryOriginal: {
        storeId: running.pendingInputs.store.storeId, itemId: f.original.itemId, chainId: f.original.chainId, attemptId: f.original.claim!.attemptId, identity } } });
      expect(running.pendingInputs.store.lookup(id, f.head.requestId)!.item.claim!.evidence).toEqual(f.original.claim!.evidence);
      expect(calls.slice(before).filter(call => call.method !== "GET")).toEqual([]);
      await running.close(); // Actual App restart: reload original journal, not a volatile unsafe flag.
      input.time = time;
      running = await start({ ...f.selected, cwd: f.session.cwd, maxConcurrentRuns: 1 });
      const token = await isolatedLogin(running), store = running.pendingInputs.store;
      expect(store.lookup(id, f.head.requestId)!.item.claim!.evidence).toEqual(f.original.claim!.evidence);
      expect((await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, token)).body).toMatchObject({ interrupted: false, reconciliationRequired: true });
      expect(fake.inbox.some(input => input.id === identity.nativeCommandId)).toBe(true); // Chosen strict policy also refuses DELETE.
      consumeQueuedInput(identity.source.nativeSessionId!, identity.nativeCommandId!);
      expect(fake.active).toBe(true);
      expect(fake.messages.some(message => message.id === identity.nativeCommandId && message.type === "user")).toBe(true);
      expect((await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, token)).body).toMatchObject({ interrupted: false, reconciliationRequired: true });
      expect(fake.active).toBe(true);
      expect(store.lookup(id, f.head.requestId)!.item).toMatchObject({ state: "run-linked", history: null, claim: { identity, uncertain: true, evidence: f.original.claim!.evidence } });
      expect(store.lookup(id, f.waiter.requestId)!.item).toMatchObject({ state: "waiting", claim: null, request: { text: f.waiter.text } });
      expect(store.inspect(id).pause).not.toBeNull();
      expect((await isolatedApi(running, "/api/sessions", undefined, token)).body.availability.code).toBe("capacity");
      await expect(running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision })).rejects.toMatchObject({ code: "pending-input-claimed" });
      expect(journal().filter(event => event.data?.nativeQueuedHandoffProtocolMismatch === true)).toEqual([marker]);
      expect(JSON.parse(readFileSync(metadataPath, "utf8")).runs.some((run: any) => run.runId === identity.runId)).toBe(false);
      expect(calls.slice(before).filter(call => call.method !== "GET")).toEqual([]);
    } finally { await running.close(); }
  }, TIMEOUT);

  test("Phase5e2 eager original journal pin rejects marker-free replacement during startup queue preflight and retains original locks", async () => {
    const f = await recoveredOCSeed("phase5e2-eager-journal-pin"), id = f.session.sessionId, identity = f.original.claim!.identity;
    const fake = sessions.get(identity.source.nativeSessionId!)!, input = fake.inbox.find(input => input.id === identity.nativeCommandId), time = input.time;
    input.time = { created: "invalid-protocol-time" };
    const marked = await start({ ...f.selected, cwd: f.session.cwd });
    await marked.close(); // Obtain a real durable exact-original protocol marker, not a fabricated history.
    input.time = time;
    const journalPath = join(f.selected.dataDir, `${identity.runId}.jsonl`), retainedPath = `${journalPath}.retained-original`;
    const originalJournal = readFileSync(journalPath, "utf8"), originalPin = lstatSync(journalPath);
    const records = originalJournal.trimEnd().split("\n").map(line => JSON.parse(line));
    const marker = records.find(event => event.data?.nativeQueuedHandoffProtocolMismatch === true);
    expect(marker).toMatchObject({ runId: identity.runId, sessionId: id, data: { recoveryOriginal: {
      itemId: f.original.itemId, chainId: f.original.chainId, attemptId: f.original.claim!.attemptId, identity } } });
    const inbox = structuredClone(fake.inbox), before = calls.length, entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const execution = RepositoryRouter.prototype.execution;
    const held = spyOn(RepositoryRouter.prototype, "execution").mockImplementation(async function(this: RepositoryRouter, admission) {
      if (admission.sessionId === id) { entered.resolve(); await gate.promise; }
      return execution.call(this, admission);
    });
    let starting: Promise<Awaited<ReturnType<typeof start>>> | undefined;
    try {
      starting = start({ ...f.selected, cwd: f.session.cwd, maxConcurrentRuns: 1 });
      const outcome = starting.then(running => ({ running, error: undefined }), error => ({ running: undefined, error }));
      await entered.promise;
      renameSync(journalPath, retainedPath);
      writeFileSync(journalPath, records.filter(event => event !== marker).map(event => JSON.stringify(event)).join("\n") + "\n");
      expect(lstatSync(journalPath).ino).not.toBe(originalPin.ino);
      expect(readFileSync(retainedPath, "utf8")).toBe(originalJournal);
      gate.resolve();
      const result = await outcome;
      if (result.running) await result.running.close();
      expect(result.error).toBeInstanceOf(PendingInputStorageError);
      expect(result.error.message).toBe("Original run journal was replaced");
      const disk = JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8"));
      const conversation = disk.conversations.find((c: any) => c.conversationId === id);
      expect(conversation.items.find((item: any) => item.requestId === f.head.requestId)).toMatchObject({ state: "run-linked", history: null,
        claim: { identity, uncertain: true, evidence: f.original.claim!.evidence } });
      expect(conversation.items.find((item: any) => item.requestId === f.waiter.requestId)).toMatchObject({ state: "waiting", claim: null, request: { text: f.waiter.text } });
      expect(conversation.pause).not.toBeNull(); expect(conversation.chain).not.toBeNull();
      expect(fake.inbox).toEqual(inbox); expect(fake.active).toBe(true);
      expect(calls.slice(before).filter(call => call.method !== "GET")).toEqual([]);
      const paths = validateOwnershipPaths(f.selected.packageDir!, f.selected.dataDir);
      for (const lock of [paths.installationLock, paths.dataLock!]) expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).phase).toBe("retained");
    } finally {
      gate.resolve(); held.mockRestore();
      await starting?.catch(() => {});
      // Deliberately restore the test-owned original inode only AFTER retained-owner assertions.
      // afterAll disposes this closed isolated fixture, as in closeStorageFailedFixture.
      if (existsSync(retainedPath)) renameSync(retainedPath, journalPath);
    }
  }, TIMEOUT);

  test("Phase5e2 consumed lost ACK and source drift during strict read never borrow acceptance, interrupt or redirect; unrelated send stays healthy", async () => {
    const f = await recoveredOCSeed("phase5e2-consumed-drift"), id = f.session.sessionId, identity = f.original.claim!.identity;
    consumeQueuedInput(identity.source.nativeSessionId!, identity.nativeCommandId!);
    const before = mutations().length, running = await start({ ...f.selected, cwd: f.session.cwd }), token = await isolatedLogin(running);
    let service: OpenCodeRunService | undefined;
    const observe = OpenCodeRunService.prototype.observeRecoveredInput;
    const capture = spyOn(OpenCodeRunService.prototype, "observeRecoveredInput").mockImplementation(function(this: OpenCodeRunService, ...args) { service = this; return observe.apply(this, args); });
    try {
      const store = running.pendingInputs.store;
      expect((await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, token)).body).toMatchObject({ interrupted: false, reconciliationRequired: true });
      expect(store.lookup(id, f.head.requestId)!.item.claim!.evidence).toEqual(f.original.claim!.evidence);
      expect(mutations()).toHaveLength(before);
      // A typed receipt discovered after App source A -> B is not borrowable.
      const fake = sessions.get(identity.source.nativeSessionId!)!;
      fake.inbox.push({ id: identity.nativeCommandId, sessionID: identity.source.nativeSessionId, type: "user", delivery: "queue", time: { created: 123 }, payload: { text: f.head.text } });
      const originalRead = OpenCodeAdapter.prototype.snapshot;
      const drift = spyOn(OpenCodeAdapter.prototype, "snapshot").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
        const snapshot = await originalRead.apply(this, args);
        if (args[0] === identity.source.nativeSessionId && args[3] === "native-queued-handoff") {
          const deps = (service as unknown as { deps: OpenCodeRunDependencies }).deps;
          deps.session(id).nativeSessionId = "ses_phase5e2_source_B";
        }
        return snapshot;
      });
      try { expect((await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, token)).body).toMatchObject({ interrupted: false, reconciliationRequired: true }); }
      finally { drift.mockRestore(); }
      expect(store.inspect(id).pause?.code).toBe("source-changed");
      expect(store.lookup(id, f.head.requestId)!.item.claim).toMatchObject({ identity, uncertain: true, evidence: f.original.claim!.evidence });
      expect(fake.inbox.some(input => input.id === identity.nativeCommandId)).toBe(true);
      expect(mutations()).toHaveLength(before);
      expect(calls.some(call => call.path.includes("ses_phase5e2_source_B"))).toBe(false);
      await unrelatedDirectInput({ ...f, running, token });
      expect(store.lookup(id, f.waiter.requestId)!.item).toMatchObject({ state: "waiting", claim: null, request: { text: f.waiter.text } });
    } finally { capture.mockRestore(); await running.close(); }
  }, TIMEOUT);

  test("Phase5e2 original observation outcome post-rename writer fault fails closed before native Stop and retains both locks", async () => {
    const f = await recoveredOCSeed("phase5e2-outcome-writer"), identity = f.original.claim!.identity, id = f.session.sessionId;
    const input = sessions.get(identity.source.nativeSessionId!)!.inbox.find(input => input.id === identity.nativeCommandId), time = input.time;
    delete input.time; // Untyped legacy-like pending input is not receipt proof.
    const running = await start({ ...f.selected, cwd: f.session.cwd }), token = await isolatedLogin(running), store = running.pendingInputs.store;
    const deps = (store as unknown as { deps: PendingInputStoreDependencies }).deps, before = mutations().length;
    input.time = time;
    deps.write = (dir, file, candidate) => { atomicAppRecord(dir, file, candidate); throw new PendingInputDomainError("source-changed", "Phase5e2 post-rename fault is storage-fatal"); };
    try {
      expect((await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, token)).status).toBe(503);
      expect(store.lookup(id, f.head.requestId)!.item.claim!.evidence).toEqual(f.original.claim!.evidence);
      const disk = JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8"));
      expect(disk.conversations.find((c: any) => c.conversationId === id).items.find((i: any) => i.requestId === f.head.requestId).claim).toMatchObject({ identity, uncertain: true, evidence: { nativeAcceptance: "accepted" } });
      expect(mutations()).toHaveLength(before);
      expect((await isolatedApi(running, "/api/sessions", { harness: "claude-code", prompt: "must fail globally closed" }, token))).toMatchObject({ status: 409, body: { code: "storage-unavailable" } });
    } finally { await closeStorageFailedFixture({ ...f, running }); }
  }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const) test(`Phase5e waiting-only ${harness} restart needs fresh Resume, binds historical predecessor identity, and then uses normal live success`, async () => {
    const f = await isolatedQueueSeed(`resume-restart-${harness}`, false, harness), id = f.session.sessionId;
    let running = f.running;
    try {
      const first = queueWire(f.session, "Phase5e historical settled head"), input = queueWire(f.session, "Phase5e fresh resumed head"), next = queueWire(f.session, "Phase5e normal live successor");
      await running.pendingInputs.enqueue(id, first); await running.pendingInputs.enqueue(id, input); await running.pendingInputs.enqueue(id, next);
      await driveConsumer(running);
      await until("original head genuinely completed", async () => JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === running.pendingInputs.store.lookup(id, first.requestId)!.item.claim?.identity.runId)?.status === "completed" || undefined);
      expect((await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, f.token)).status).toBe(200);
      const original = await settledInput(running, id, first.requestId), predecessorRunId = original.claim!.identity.runId;
      expect(running.pendingInputs.store.inspect(id).lastPredecessorRunId).toBe(predecessorRunId);
      const request = { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: running.pendingInputs.store.get(id).revision };
      const receipt = await running.pendingInputs.resume(id, request);
      await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, f.token);
      const before = harness === "opencode" ? prompts().length : invocations().length;
      await running.close(); running = await start({ ...f.selected, cwd: f.session.cwd });
      expect(running.pendingInputs.store.inspect(id).pause?.code).toBe("stopped");
      expect((await isolatedApi(running, "/api/sessions", undefined, await isolatedLogin(running))).body.availability.canSend).toBe(true);
      expect(await running.pendingInputs.resume(id, request)).toEqual(receipt);
      await driveConsumer(running); expect(running.pendingInputs.store.get(id).paused).toBe(true);
      expect(running.pendingInputs.store.lookup(id, input.requestId)!.item.claim).toBeNull();
      expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before);
      await running.pendingInputs.resume(id, { ...request, requestId: crypto.randomUUID(), expectedRevision: running.pendingInputs.store.get(id).revision });
      if (harness === "opencode") {
        const fake = sessions.get(f.session.nativeSessionId!)!;
        fake.inbox.push({ id: "msg_phase5e_foreign_pending", type: "user", delivery: "queue", sessionID: f.session.nativeSessionId, payload: { text: "foreign pending" } });
        await driveConsumer(running); expect(running.pendingInputs.store.lookup(id, input.requestId)!.item.claim).toBeNull();
        fake.inbox.pop(); fake.active = true;
        await driveConsumer(running); expect(running.pendingInputs.store.lookup(id, input.requestId)!.item.claim).toBeNull();
        fake.active = false;
      }
      const resumed = await settledInput(running, id, input.requestId);
      expect(resumed.claim!.authorization).toMatchObject({ chainId: original.chainId, predecessorRunId, source: original.claim!.identity.source });
      const successor = await settledInput(running, id, next.requestId);
      expect(successor.claim!.authorization.predecessorRunId).toBe(resumed.claim!.identity.runId);
      expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before + 2);
      expect(running.pendingInputs.store.lookup(id, first.requestId)!.item).toEqual(original);
      expect(await running.pendingInputs.resume(id, request)).toEqual(receipt);
      await driveConsumer(running); expect(harness === "opencode" ? prompts().length : invocations().length).toBe(before + 2);
    } finally { await running.close(); }
  }, TIMEOUT);

  test("Phase5e recovered accepted original blocks idle/admission and occupies one slot despite done, completed or missing metadata; legacy recovery never adopts it", async () => {
    const f = await isolatedQueueSeed("recovered-accepted-original", false, "opencode"), id = f.session.sessionId;
    let running = f.running, original: DispatchLifecycle | undefined, arbitration: ConversationCoordinator | undefined;
    const admit = running.preparedInput.admit;
    const publication = spyOn(running.preparedInput, "admit").mockImplementation((prepared, lease, input) => admit(prepared, lease, { ...input, publish: lifecycle => { original = lifecycle; input!.publish!(lifecycle); } }));
    const monitor = spyOn(OpenCodeRunService.prototype, "monitorNative"), adoption = spyOn(ConversationCoordinator.prototype, "adoptObservedOwner");
    const inspect = ConversationCoordinator.prototype.inspectReadiness;
    const readiness = spyOn(ConversationCoordinator.prototype, "inspectReadiness").mockImplementation(function(this: ConversationCoordinator, input) {
      if (input.conversationId === id) arbitration = this;
      return inspect.call(this, input);
    });
    try {
      const input = queueWire(f.session, "hold for Phase5e accepted original"), waiter = queueWire(f.session, "Phase5e removable waiter");
      const receipt = await running.pendingInputs.enqueue(id, input); await running.pendingInputs.enqueue(id, waiter); await driveConsumer(running);
      await until("original strict queued ACK durably accepted", async () => running.pendingInputs.store.lookup(id, input.requestId)!.item.claim?.evidence?.nativeAcceptance === "accepted" || undefined);
      const pinned = running.pendingInputs.store.lookup(id, input.requestId)!.item;
      expect(pinned).toMatchObject({ state: "run-linked", claim: { possibleNative: true, uncertain: false } });
      await running.close(); await original!.done; complete(f.session.nativeSessionId!);
      monitor.mockClear(); adoption.mockClear(); // Fresh original monitoring is legitimate; startup legacy adoption is not.
      const before = mutations().length;
      const assertBarrier = async () => {
        const token = await isolatedLogin(running), current = running.pendingInputs.store.lookup(id, input.requestId)!;
        expect(current).toMatchObject({ receipt, classification: "uncertain", item: { ...pinned, claim: { ...pinned.claim!, uncertain: true } } });
        expect((await isolatedApi(running, `${queuePath(id)}/inputs/${input.requestId}`, undefined, token)).body).toMatchObject({ receipt, classification: "uncertain", runId: pinned.claim!.identity.runId, nativeCommandId: pinned.claim!.identity.nativeCommandId });
        const list = (await isolatedApi(running, "/api/sessions", undefined, token)).body;
        expect(list.sessions.find((s: any) => s.sessionId === id).availability).toMatchObject({ canSend: false, code: "pending-input-reconciliation-required" });
        expect(list.availability).toMatchObject({ canSend: false, code: "capacity" });
        expect(arbitration!.inspectReadiness({ conversationId: id, intent: { kind: "inspect-idle" }, phase: "admission" })).toMatchObject({ ready: false, code: "pending-input-reconciliation-required" });
        expect([...arbitration!.occupiedConversationIds()]).toEqual([id]); // Metadata + claim are ONE slot, not two.
        expect(arbitration!.hasOwner(id)).toBe(false);
        expect((await isolatedApi(running, "/api/sessions", { sessionId: id, prompt: "Phase5e forbidden direct send" }, token))).toMatchObject({ status: 409, body: { code: "pending-input-chain-active" } });
        expect(() => running.preparedInput.reserve({ kind: "history-refresh" }, id)).toThrow("Original queued execution is uncertain");
        await expect(running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: running.pendingInputs.store.get(id).revision })).rejects.toMatchObject({ code: "pending-input-claimed" });
        expect((await isolatedApi(running, `/api/sessions/${id}/native-history`, undefined, token)).status).toBe(200);
        await driveConsumer(running);
        expect(monitor.mock.calls.filter(([owner]) => owner.run.sessionId === id)).toHaveLength(0);
        expect(adoption.mock.calls.filter(([owner]) => owner.run.sessionId === id)).toHaveLength(0);
        expect(mutations()).toHaveLength(before);
      };
      running = await start({ ...f.selected, cwd: f.session.cwd, maxConcurrentRuns: 1 }); await assertBarrier();
      // Refilling is waiting-only and bounded, never capacity/submission consent.
      const refill = queueWire(f.session, "Phase5e refill uncertain original"); await running.pendingInputs.enqueue(id, refill);
      const remove = running.pendingInputs.store.lookup(id, waiter.requestId)!.item;
      await running.pendingInputs.remove(id, remove.itemId, { version: 1, requestId: crypto.randomUUID(), conversationId: id, inputRequestId: waiter.requestId, itemId: remove.itemId });
      const stop = await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, await isolatedLogin(running));
      expect(stop.body).toMatchObject({ interrupted: false, reconciliationRequired: true, code: "pending-input-reconciliation-required" });
      await running.close();
      const path = join(f.selected.dataDir, "metadata.json"), metadata = JSON.parse(readFileSync(path, "utf8"));
      const run = metadata.runs.find((r: any) => r.runId === pinned.claim!.identity.runId);
      run.status = "completed"; run.endedAt = new Date().toISOString(); metadata.sessions[0].lastStatus = "completed";
      run.nativePhase = "preparing"; run.nativeCommandId = "msg_phase5e_inconsistent_metadata"; // Neither is proof against the original accepted claim.
      atomicAppRecord(f.selected.dataDir, "metadata.json", metadata);
      running = await start({ ...f.selected, cwd: f.session.cwd, maxConcurrentRuns: 1 }); await assertBarrier(); await running.close();
      metadata.runs = metadata.runs.filter((r: any) => r.runId !== pinned.claim!.identity.runId);
      metadata.sessions[0].lastRunId = metadata.runs.at(-1).runId;
      atomicAppRecord(f.selected.dataDir, "metadata.json", metadata);
      running = await start({ ...f.selected, cwd: f.session.cwd, maxConcurrentRuns: 1, reconcileInterrupted: true }); await assertBarrier();
      expect(running.pendingInputs.store.lookup(id, refill.requestId)!.item.request.text).toBe(refill.text);
    } finally { publication.mockRestore(); monitor.mockRestore(); adoption.mockRestore(); readiness.mockRestore(); await running.close(); }
  }, TIMEOUT);

  test("Phase5e recovered original source/settings drift stays scoped and preserves native pending input without rebind or foreign cancellation", async () => {
    const f = await isolatedQueueSeed("recovered-original-drift", false, "opencode"), id = f.session.sessionId, input = queueWire(f.session);
    let running = f.running;
    try {
      const receipt = await running.pendingInputs.enqueue(id, input); await running.close();
      const storeId = JSON.parse(readFileSync(join(f.selected.dataDir, "manifest.json"), "utf8")).storeId;
      const store = new PendingInputStore(f.selected.dataDir, storeId, { validateLive: () => {} }); store.recover();
      store.resume({ version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision });
      const item = store.lookup(id, input.requestId)!.item;
      const claim = store.claim({ conversationId: id, itemId: receipt.itemId, inputRequestId: input.requestId, expectedRevision: store.get(id).revision,
        attemptId: crypto.randomUUID(), runId: crypto.randomUUID(), nativeCommandId: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
        authorization: { kind: "dispatch", authorizationId: crypto.randomUUID(), chainId: item.chainId, predecessorRunId: null, source: dispatchSource(item.snapshot) } }).claim!;
      store.link(claim.identity); store.beforeNative({ ...claim.identity, submission: "attempted", nativeAcceptance: "unknown" });
      store.outcome({ ...claim.identity, submission: "submitted", nativeAcceptance: "accepted" });
      const fake = sessions.get(f.session.nativeSessionId!)!;
      fake.inbox.push({ id: claim.identity.nativeCommandId, type: "user", sessionID: f.session.nativeSessionId, delivery: "queue", payload: { text: input.text } });
      const path = join(f.selected.dataDir, "metadata.json"), metadata = JSON.parse(readFileSync(path, "utf8"));
      metadata.sessions[0].nativeSessionId = "ses_phase5e_replacement"; metadata.sessions[0].model = "fixture/changed";
      atomicAppRecord(f.selected.dataDir, "metadata.json", metadata);
      // Current App records are internally valid; only the ORIGINAL queue pins
      // disagree. Store corruption is not a scoped source-drift test.
      const admissions = JSON.parse(readFileSync(join(f.selected.dataDir, "admissions.json"), "utf8"));
      admissions.admissions.find((a: any) => a.sessionId === id).nativeId = metadata.sessions[0].nativeSessionId;
      atomicAppRecord(f.selected.dataDir, "admissions.json", admissions);
      sessions.set(metadata.sessions[0].nativeSessionId, { info: { ...fake.info, id: metadata.sessions[0].nativeSessionId }, messages: [], inbox: [], active: false });
      const before = mutations().length;
      running = await start({ ...f.selected, cwd: f.session.cwd });
      expect(running.pendingInputs.store.inspect(id).pause?.code).toBe("source-changed");
      expect(running.pendingInputs.store.lookup(id, input.requestId)!.item).toMatchObject({ request: input, snapshot: item.snapshot, chainId: item.chainId, claim: { ...claim, possibleNative: true, uncertain: true, evidence: { ...claim.identity, submission: "submitted", nativeAcceptance: "accepted" } } });
      const view = await running.pendingInputs.get(id); expect(view.presentation.source).toEqual(input.source); expect(view.presentation.enqueue.allowed).toBe(false);
      await driveConsumer(running);
      const stop = await isolatedApi(running, `/api/sessions/${id}/cancel`, {}, await isolatedLogin(running)); expect(stop.body.interrupted).toBe(false);
      expect(fake.inbox).toHaveLength(1); expect(fake.inbox[0].id).toBe(claim.identity.nativeCommandId);
      expect(mutations()).toHaveLength(before);
      expect((await isolatedApi(running, "/api/sessions", undefined, await isolatedLogin(running))).body.availability.canSend).toBe(true);
      await unrelatedDirectInput({ ...f, running, token: await isolatedLogin(running) });
    } finally { await running.close(); }
  }, TIMEOUT);

  test("Phase5c2 fresh App-idle CC without historical chain identity launches one FIFO head and validates its exact preparing owner", async () => {
    const f = await isolatedQueueSeed("cc-fresh-app-idle", false), id = f.session.sessionId;
    await f.running.close();
    const running = await start({ ...f.selected, cwd: f.session.cwd }), store = running.pendingInputs.store;
    const readIdle = ClaudeRunService.prototype.readLocalIdle, beforeNative = store.beforeNative;
    let ownReads = 0, nativeChecks = 0;
    const idle = spyOn(ClaudeRunService.prototype, "readLocalIdle").mockImplementation(function(this: ClaudeRunService, cid, owner) {
      if (cid === id && owner) {
        ownReads++; expect(store.lookup(id, store.get(id).items[0]!.requestId)!.item.claim!.possibleNative).toBe(false);
      }
      return readIdle.call(this, cid, owner);
    });
    const intent = spyOn(store, "beforeNative").mockImplementation(evidence => {
      nativeChecks++; expect(store.lookup(id, evidence.requestId!)!.item.claim!.possibleNative).toBe(false);
      return beforeNative.call(store, evidence);
    });
    try {
      const first = queueWire(f.session, "hold for Claude followup Phase5c2 new idle head"), next = queueWire(f.session, "Phase5c2 ordinary successful successor");
      await running.pendingInputs.enqueue(id, first); await running.pendingInputs.enqueue(id, next);
      expect(store.inspect(id).lastPredecessorRunId).toBeNull();
      const before = invocations().length; await driveConsumer(running);
      await until("fresh CC FIFO head actually launched", async () => invocations().length === before + 1 || undefined);
      expect(store.lookup(id, first.requestId)!.item.claim!.authorization.predecessorRunId).toBeNull();
      expect(store.lookup(id, next.requestId)!.item.claim).toBeNull(); expect(nativeChecks).toBe(1); expect(ownReads).toBeGreaterThan(0);
      writeFileSync(join(root, `claude-release-${store.lookup(id, first.requestId)!.item.claim!.identity.runId}`), "release");
      await settledInput(running, id, next.requestId);
      expect(store.lookup(id, next.requestId)!.item.claim!.authorization.predecessorRunId).toBe(store.lookup(id, first.requestId)!.item.claim!.identity.runId);
      expect(invocations().slice(before).map(row => row.prompt)).toEqual([first.text, next.text]); expect(nativeChecks).toBe(2);
    } finally { idle.mockRestore(); intent.mockRestore(); await running.close(); }
  }, TIMEOUT);

  test("Phase5c2 fresh App-idle CC still blocks another unknown supervised attempt when its exact new preparation is excluded", async () => {
    const f = await isolatedQueueSeed("cc-other-supervised-attempt", false), id = f.session.sessionId;
    await f.running.close(); const running = await start({ ...f.selected, cwd: f.session.cwd }), store = running.pendingInputs.store;
    const readIdle = ClaudeRunService.prototype.readLocalIdle;
    let service: ClaudeRunService | undefined, removeAttempt = () => {}, deniedOwn = false;
    const idle = spyOn(ClaudeRunService.prototype, "readLocalIdle").mockImplementation(function(this: ClaudeRunService, cid, owner) {
      if (cid === id && owner && !service) {
        service = this;
        // Model an older spawn attempt whose child handle was never obtained.
        // It has no coordinator owner; excluding NEW preparation cannot retire it.
        const local = this as unknown as { supervision: WeakMap<RunOwner, any>; supervised: Map<string, Set<any>> };
        const current = local.supervision.get(owner), oldRun = { ...owner.run, runId: crypto.randomUUID(), status: "failed" };
        const oldOwner = { ...owner, run: oldRun }, unknown = { ...current, owner: oldOwner, run: oldRun,
          identity: { ...current.identity, runId: oldRun.runId }, preparing: false, nativeAttempted: true, finished: true, streamsDrained: true };
        local.supervised.get(id)!.add(unknown); removeAttempt = () => { local.supervised.get(id)?.delete(unknown); };
      }
      const result = readIdle.call(this, cid, owner);
      if (cid === id && owner) deniedOwn ||= !result.ready;
      return result;
    });
    try {
      const head = queueWire(f.session, "Phase5c2 blocked exact new preparation"), next = queueWire(f.session, "Phase5c2 preserve unknown-attempt waiter");
      await running.pendingInputs.enqueue(id, head); await running.pendingInputs.enqueue(id, next);
      const before = invocations().length; await settledInput(running, id, head.requestId);
      expect(deniedOwn).toBe(true); expect(service!.readLocalIdle(id).ready).toBe(false);
      expect(store.lookup(id, head.requestId)!.item).toMatchObject({ history: { kind: "not-submitted" }, claim: { possibleNative: false } });
      await driveConsumer(running); expect(store.lookup(id, next.requestId)!.item.claim).toBeNull(); expect(invocations()).toHaveLength(before);
      expect((await isolatedApi(running, "/api/sessions", undefined, await isolatedLogin(running))).body.availability.canSend).toBe(true);
    } finally { removeAttempt(); idle.mockRestore(); await running.close(); }
  }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const)
    test(`${harness === "claude-code" ? "Phase5c2" : "Phase5b"} definitely withheld ${harness} head preserves its original handle; fresh resume proves ${harness === "opencode" ? "native idle" : "finished no-child release and spends original consent"}`, async () => {
      const f = await heldQueueBoundary(`resume-withheld-${harness}`, harness, () => {}), id = f.session.sessionId, store = f.running.pendingInputs.store;
      try {
        const head = queueWire(f.session), next = queueWire(f.session, harness === "claude-code" ? "fail for FIFO consumer Phase5c2 after withholding" : "offline waiter behind certified withholding");
        const last = queueWire(f.session, "Phase5c2 original grant cannot authorize another failed predecessor");
        await f.running.pendingInputs.enqueue(id, head); await f.running.pendingInputs.enqueue(id, next);
        if (harness === "claude-code") await f.running.pendingInputs.enqueue(id, last);
        f.running.pendingInputConsumer.poll(); await f.entered.promise; await f.running.pendingInputConsumer.drain();
        const original = f.published(), identity = store.lookup(id, head.requestId)!.item.claim!.identity;
        expect((await isolatedApi(f.running, `/api/sessions/${id}/cancel`, {}, f.token)).status).toBe(200);
        f.gate.resolve(); await original.done; await driveConsumer(f.running);
        expect(store.lookup(id, head.requestId)!.item).toMatchObject({ state: "settled", history: { kind: "not-submitted" }, claim: { identity, possibleNative: false } });
        f.restore(); const before = harness === "opencode" ? prompts().length : invocations().length;
        await f.running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision });
        if (harness === "opencode") {
          await settledInput(f.running, id, next.requestId);
          expect(store.lookup(id, next.requestId)!.item.claim!.authorization.predecessorRunId).toBe(original.owner.run.runId);
          expect(prompts()).toHaveLength(before + 1);
        } else {
          expect(original.owner.child).toBeUndefined(); expect(original.owner.run.status).not.toBe("completed");
          const resumed = await settledInput(f.running, id, next.requestId);
          expect(resumed.claim!.authorization.predecessorRunId).toBe(original.owner.run.runId);
          expect(resumed.history).toMatchObject({ kind: "settled", status: "failed" });
          await driveConsumer(f.running); expect(store.lookup(id, last.requestId)!.item.claim).toBeNull();
          expect(store.inspect(id).pause?.code).toBe("failed");
          expect(invocations().slice(before).map(row => row.prompt)).toEqual([next.text]);
        }
      } finally { f.restore(); await f.running.close(); }
    }, TIMEOUT);

  test("Phase4c2 lost prepared result and unconfirmed/lost ACK retain exact published handle and uncertain claim, never replay", async () => {
    const f = await isolatedQueueSeed("consumer-lost-ack", false, "opencode"), id = f.session.sessionId, input = queueWire(f.session), store = f.running.pendingInputs.store, fake = sessions.get(f.session.nativeSessionId!)!;
    let published: DispatchLifecycle | undefined;
    const admit = f.running.preparedInput.admit, execute = OpenCodeRunService.prototype.executeNative, prompt = OpenCodeAdapter.prototype.promptQueuedHandoff;
    const lostResult = spyOn(f.running.preparedInput, "admit").mockImplementation(async (prepared, lease, options) => { await admit(prepared, lease, { ...options, publish: handle => { published = handle; options!.publish!(handle); fake.active = true; } }); throw new WorkstreamAdapterError(503, "run-unavailable", "Offline prepared result lost"); });
    const unconfirmed = spyOn(OpenCodeRunService.prototype, "executeNative").mockImplementation(function(this: OpenCodeRunService, owner, text, resume, ready) { ready(false); return execute.call(this, owner, text, resume, ready); });
    const lostAck = spyOn(OpenCodeAdapter.prototype, "promptQueuedHandoff").mockImplementation(async function(this: OpenCodeAdapter, ...args) { await prompt.apply(this, args); throw new OpenCodeUnavailableError("Offline consumer lost ACK"); });
    try {
      await f.running.pendingInputs.enqueue(id, input); const before = prompts().length; await driveConsumer(f.running);
      await until("uncertain real queue claim retains original handle", async () => store.lookup(id, input.requestId)!.item.claim?.uncertain || undefined);
      expect(published).toBeDefined(); expect(await published!.admission).toEqual({ state: "unconfirmed" });
      const claim = store.lookup(id, input.requestId)!.item.claim!;
      expect(claim.identity.runId).toBe(published!.owner.run.runId); expect(store.inspect(id).pause?.code).toBe("acceptance-unknown");
      await until("exact original queue evidence reconciled", async () => published!.submissionEvidence().nativeAcceptance === "accepted" || undefined);
      consumeQueuedInput(f.session.nativeSessionId!, claim.identity.nativeCommandId!); complete(f.session.nativeSessionId!); await published!.done;
      await driveConsumer(f.running); await driveConsumer(f.running);
      expect(prompts()).toHaveLength(before + 1); expect(store.lookup(id, input.requestId)!.item.state).toBe("run-linked");
      expect((await published!.successfulSettlement()).ready).toBe(false);
    } finally { lostResult.mockRestore(); unconfirmed.mockRestore(); lostAck.mockRestore(); fake.active = false; await f.running.close(); }
  }, TIMEOUT);

  test("Phase4c2 publisher failure preserves the published consumer handle/claim and withholds native execution", async () => {
    const f = await isolatedQueueSeed("consumer-publisher", false, "opencode"), id = f.session.sessionId, input = queueWire(f.session);
    const admit = f.running.preparedInput.admit; let published: DispatchLifecycle | undefined;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: handle => { published = handle; options!.publish!(handle); throw new Error("Offline consumer publisher failure"); } }));
    try {
      await f.running.pendingInputs.enqueue(id, input); const before = prompts().length; await driveConsumer(f.running);
      await until("consumer publisher exact installed handle retained", async () => published || undefined); await published!.done;
      const item = f.running.pendingInputs.store.lookup(id, input.requestId)!.item;
      expect(item.state).toBe("run-linked"); expect(item.claim!.identity.runId).toBe(published!.owner.run.runId);
      expect(prompts()).toHaveLength(before); expect((await published!.successfulSettlement()).ready).toBe(false);
    } finally { publisher.mockRestore(); await closeStorageFailedFixture(f); }
  }, TIMEOUT);

  test("Phase4c2 shutdown aborts lease-free read-only preflight without waiting for its transport or replaying", async () => {
    const f = await isolatedQueueSeed("consumer-shutdown-preflight", false, "opencode"), id = f.session.sessionId, input = queueWire(f.session);
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), activity = OpenCodeAdapter.prototype.activity;
    const read = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(async function(this: OpenCodeAdapter, ...args) { if (args[0] === f.session.nativeSessionId) { entered.resolve(); await gate.promise; } return activity.apply(this, args); });
    const reserve = spyOn(ConversationCoordinator.prototype, "reserveAdmission");
    try {
      await f.running.pendingInputs.enqueue(id, input); const before = prompts().length, reservations = reserve.mock.calls.length;
      f.running.pendingInputConsumer.poll(); await entered.promise;
      await f.running.close(); // Gate remains unresolved: only bounded consumer work is drained.
      expect(reserve.mock.calls.length).toBe(reservations); expect(prompts()).toHaveLength(before);
      expect(f.running.pendingInputs.store.lookup(id, input.requestId)!.item.claim).toBeNull();
    } finally { gate.resolve(); read.mockRestore(); reserve.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase4c2 coded admission storage failures remain fatal, never normalized into busy/domain retry", async () => {
    const f = await isolatedQueueSeed("consumer-storage-refusal", false, "opencode"), id = f.session.sessionId, input = queueWire(f.session);
    const failure = spyOn(f.running.preparedInput, "admit").mockImplementation(async () => { throw new WorkstreamAdapterError(409, "STORAGE_ERROR", "Offline admission authority storage failure"); });
    try {
      await f.running.pendingInputs.enqueue(id, input); const before = prompts().length; await driveConsumer(f.running);
      await until("consumer storage fault closes submission", async () => (await isolatedApi(f.running, "/api/sessions", { harness: "claude-code", prompt: "must fail closed" }, f.token)).body.code === "storage-unavailable" || undefined);
      expect(prompts()).toHaveLength(before); expect(f.running.pendingInputs.store.lookup(id, input.requestId)!.item.state).toBe("claimed");
    } finally { failure.mockRestore(); await closeStorageFailedFixture(f); }
  }, TIMEOUT);

  test("Phase4c2 shutdown retains only original-identity outcome writes through bounded drain", async () => {
    const f = await isolatedQueueSeed("consumer-shutdown-observation", false, "opencode"), id = f.session.sessionId, input = queueWire(f.session), store = f.running.pendingInputs.store;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), prompt = OpenCodeAdapter.prototype.promptQueuedHandoff;
    const ack = spyOn(OpenCodeAdapter.prototype, "promptQueuedHandoff").mockImplementation(async function(this: OpenCodeAdapter, ...args) { const result = await prompt.apply(this, args); entered.resolve(); await gate.promise; return result; });
    let published: DispatchLifecycle | undefined;
    const admit = f.running.preparedInput.admit;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
    let close: Promise<void> | undefined;
    try {
      await f.running.pendingInputs.enqueue(id, input); await driveConsumer(f.running); await entered.promise;
      expect(store.lookup(id, input.requestId)!.item.claim!.evidence!.submission).toBe("attempted");
      close = f.running.close();
      await expect(f.running.pendingInputs.enqueue(id, queueWire(f.session))).rejects.toBeInstanceOf(PendingInputDomainError);
      expect(() => store.pause(id, { code: "stopped", reason: "arbitrary closing write must fail" })).toThrow("storage ownership");
      gate.resolve(); await close;
      expect(store.lookup(id, input.requestId)!.item.claim!.evidence).toEqual(published!.submissionEvidence());
      expect(store.lookup(id, input.requestId)!.item.claim!.evidence).toMatchObject({ submission: "unknown", nativeAcceptance: "unknown", requestId: input.requestId });
      expect(store.lookup(id, input.requestId)!.item.state).toBe("run-linked");
    } finally { gate.resolve(); ack.mockRestore(); publisher.mockRestore(); await (close ?? f.running.close()); }
  }, TIMEOUT);

  test("Phase5a idle Stop durably pauses existing waiters without a new chain or native attempt", async () => {
    const f = await isolatedQueueSeed("controls-idle-stop", false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    try {
      const inputs = [queueWire(f.session), queueWire(f.session, "offline later Stop waiter")];
      for (const input of inputs) await f.running.pendingInputs.enqueue(id, input);
      const chain = store.inspect(id).chain, before = mutations().length, cli = invocations().length;
      const stopped = await isolatedApi(f.running, `/api/sessions/${id}/cancel`, {}, f.token);
      expect(stopped.status).toBe(200); expect(stopped.body.interrupted).toBe(false);
      expect(store.inspect(id).pause?.code).toBe("stopped"); expect(store.inspect(id).chain).toEqual(chain);
      for (const input of inputs) expect(store.lookup(id, input.requestId)!.item).toMatchObject({ state: "waiting", claim: null, history: null });
      await driveConsumer(f.running); expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(cli);
      expect(JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).conversations[0].pause).toEqual(store.inspect(id).pause);
      const empty = await isolatedApi(f.running, "/api/sessions", { prompt: "offline no-chain Stop compatibility" }, f.token);
      await until("no-chain seed ended", async () => JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === empty.body.runId)?.status === "completed" || undefined);
      const legacy = await isolatedApi(f.running, `/api/sessions/${empty.body.sessionId}/cancel`, {}, f.token);
      expect(legacy.status).toBe(200); expect(legacy.body).toMatchObject({ interrupted: false, reason: "No active App-owned run; external execution must be stopped in its native harness" });
      expect(store.inspect(empty.body.sessionId).chain).toBeNull();
    } finally { await f.running.close(); }
  }, TIMEOUT);

  for (const action of ["cancel", "hide"] as const) test(`Phase5a ${action} fences held lease-free preflight and permits paused waiting removal`, async () => {
    const f = await isolatedQueueSeed(`controls-preflight-${action}`, false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(), activity = OpenCodeAdapter.prototype.activity;
    const read = spyOn(OpenCodeAdapter.prototype, "activity").mockImplementation(async function(this: OpenCodeAdapter, ...args) {
      if (args[0] === f.session.nativeSessionId) { entered.resolve(); await gate.promise; } return activity.apply(this, args);
    });
    try {
      const input = queueWire(f.session), next = queueWire(f.session), receipt = await f.running.pendingInputs.enqueue(id, input);
      await f.running.pendingInputs.enqueue(id, next); const before = prompts().length;
      f.running.pendingInputConsumer.poll(); await entered.promise;
      expect((await isolatedApi(f.running, `/api/sessions/${id}/${action}`, {}, f.token)).status).toBe(200);
      expect(store.inspect(id).pause?.code).toBe(action === "hide" ? "hidden" : "stopped");
      expect(store.lookup(id, input.requestId)!.item.claim).toBeNull();
      expect((await isolatedApi(f.running, `${queuePath(id)}/${receipt.itemId}/remove`, { version: 1, requestId: crypto.randomUUID(), conversationId: id, itemId: receipt.itemId, inputRequestId: input.requestId }, f.token)).status).toBe(200);
      gate.resolve(); await f.running.pendingInputConsumer.drain(); await driveConsumer(f.running);
      expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null }); expect(prompts()).toHaveLength(before);
      read.mockRestore(); await unrelatedDirectInput(f);
    } finally { gate.resolve(); read.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  for (const harness of ["claude-code", "opencode"] as const) for (const action of ["cancel", "hide"] as const)
    test(`Phase5a ${action} after published ${harness} owner prevents late native execution and preserves later text`, async () => {
      const f = await heldQueueBoundary(`controls-published-${harness}-${action}`, harness, () => {}), id = f.session.sessionId, store = f.running.pendingInputs.store;
      try {
        const input = queueWire(f.session), next = queueWire(f.session, "offline waiting after owner control");
        await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(id, next);
        const before = mutations().length, cli = invocations().length;
        f.running.pendingInputConsumer.poll(); await f.entered.promise; await f.running.pendingInputConsumer.drain();
        const owner = f.published().owner, identity = store.lookup(id, input.requestId)!.item.claim!.identity;
        expect((await isolatedApi(f.running, `/api/sessions/${id}/${action}`, {}, f.token)).status).toBe(200);
        expect(owner.stopRequested === true).toBe(action === "cancel"); expect(store.inspect(id).pause?.code).toBe(action === "cancel" ? "stopped" : "hidden");
        f.gate.resolve(); await f.published().done; await driveConsumer(f.running);
        const item = store.lookup(id, input.requestId)!.item;
        expect(item.claim!.identity).toEqual(identity); expect(item.claim).toMatchObject({ possibleNative: false, uncertain: false, evidence: { submission: "not-submitted", nativeAcceptance: "not-accepted" } });
        expect(item.history?.kind).toBe("not-submitted"); expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null, history: null });
        await driveConsumer(f.running); expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(cli);
        const receipt = store.lookup(id, next.requestId)!.receipt;
        expect((await isolatedApi(f.running, `${queuePath(id)}/${receipt.itemId}/remove`, { version: 1, requestId: crypto.randomUUID(), conversationId: id, itemId: receipt.itemId, inputRequestId: next.requestId }, f.token)).status).toBe(200);
        f.restore(); await unrelatedDirectInput(f);
      } finally { f.restore(); await f.running.close(); }
    }, TIMEOUT);

  test("Phase5a accepted queued Stop interrupts only the pinned head and never advances its successor", async () => {
    const f = await isolatedQueueSeed("controls-accepted-stop", false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const admit = f.running.preparedInput.admit; let published: DispatchLifecycle | undefined;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
    try {
      const input = queueWire(f.session, "hold for accepted queued Stop"), next = queueWire(f.session);
      await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(id, next); const before = prompts().length;
      await driveConsumer(f.running); await until("accepted queued Stop head", async () => published?.submissionEvidence().nativeAcceptance === "accepted" || undefined);
      const identity = store.lookup(id, input.requestId)!.item.claim!.identity;
      expect((await isolatedApi(f.running, `/api/sessions/${id}/cancel`, {}, f.token)).status).toBe(200);
      // Stop acknowledgement/done alone do not retire the original claim.
      expect(store.lookup(id, input.requestId)!.item.state).toBe("run-linked");
      await published!.done; await driveConsumer(f.running); await driveConsumer(f.running);
      // This fake service supplies exact interrupted outcome AND native idle;
      // independent real settlement may retire the head, never its pause.
      expect(store.inspect(id).pause?.code).toBe("stopped"); expect(store.lookup(id, input.requestId)!.item).toMatchObject({ state: "settled", history: { kind: "settled", status: "interrupted" }, claim: { identity, possibleNative: true, evidence: { submission: "submitted", nativeAcceptance: "accepted" } } });
      expect(store.lookup(id, next.requestId)!.item).toMatchObject({ state: "waiting", claim: null }); expect(prompts()).toHaveLength(before + 1);
      expect(calls.filter(c => c.method === "POST" && c.path.includes("/interrupt?")).at(-1)?.path).toBe(`/api/session/${f.session.nativeSessionId}/interrupt?resume=false`);
    } finally { publisher.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase5a unconfirmed accepted Stop retains the original claim and owner, never dispatches a successor", async () => {
    const f = await isolatedQueueSeed("controls-unconfirmed-stop", false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const admit = f.running.preparedInput.admit, cancel = OpenCodeAdapter.prototype.cancel; let published: DispatchLifecycle | undefined;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
    const refusal = spyOn(OpenCodeAdapter.prototype, "cancel").mockImplementation(function(this: OpenCodeAdapter, ...args) {
      if (args[0] === f.session.nativeSessionId) throw new OpenCodeUnavailableError("Offline cancellation acknowledgement unavailable"); return cancel.apply(this, args);
    });
    try {
      const input = queueWire(f.session, "hold for unconfirmed queued Stop"), next = queueWire(f.session);
      await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(id, next); const before = prompts().length;
      await driveConsumer(f.running); await until("accepted unconfirmed Stop head", async () => published?.submissionEvidence().nativeAcceptance === "accepted" || undefined);
      const identity = store.lookup(id, input.requestId)!.item.claim!.identity;
      expect((await isolatedApi(f.running, `/api/sessions/${id}/cancel`, {}, f.token)).status).toBe(503);
      await driveConsumer(f.running); await driveConsumer(f.running);
      expect(published!.owner).toMatchObject({ stopRequested: true, settled: false, run: { status: "running" } });
      expect(store.lookup(id, input.requestId)!.item).toMatchObject({ state: "run-linked", history: null, claim: { identity, possibleNative: true } });
      expect(store.inspect(id).pause?.code).toBe("stopped"); expect(store.lookup(id, next.requestId)!.item.claim).toBeNull(); expect(prompts()).toHaveLength(before + 1);
      await expect(f.running.pendingInputs.resume(id, { version: 1, action: "resume", requestId: crypto.randomUUID(), conversationId: id, expectedRevision: store.get(id).revision })).rejects.toMatchObject({ code: "pending-input-claimed" });
      expect(store.lookup(id, input.requestId)!.item.claim!.identity).toEqual(identity);
      const row = (await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.sessions.find((s: any) => s.sessionId === id);
      expect(row.availability.canSend).toBe(false); expect(row.availability.reason).not.toContain("Storage");
      refusal.mockRestore(); complete(f.session.nativeSessionId!, "interrupted"); await published!.done;
    } finally { refusal.mockRestore(); publisher.mockRestore(); sessions.get(f.session.nativeSessionId!)!.active = false; await f.running.close(); }
  }, TIMEOUT);

  for (const code of ["stopped", "failed", "restart", "source-changed", "acceptance-unknown"] as const)
    test(`Phase5a hide/unhide never replaces or clears existing ${code} pause`, async () => {
      const f = await isolatedQueueSeed(`controls-unhide-${code}`, false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
      try {
        const input = queueWire(f.session); await f.running.pendingInputs.enqueue(id, input); store.pause(id, { code, reason: `Original ${code} evidence` });
        const original = store.inspect(id), before = prompts().length;
        for (const action of ["hide", "hide", "unhide", "unhide"]) expect((await isolatedApi(f.running, `/api/sessions/${id}/${action}`, {}, f.token)).status).toBe(200);
        expect(store.inspect(id)).toEqual(original); await driveConsumer(f.running); expect(prompts()).toHaveLength(before);
        expect(JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).sessions[0].hidden).toBe(false);
      } finally { await f.running.close(); }
    }, TIMEOUT);

  test("Phase5a hiding already accepted execution pauses future input without interrupting that execution", async () => {
    const f = await isolatedQueueSeed("controls-hide-active", false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const admit = f.running.preparedInput.admit; let published: DispatchLifecycle | undefined;
    const publisher = spyOn(f.running.preparedInput, "admit").mockImplementation((prepared, lease, options) => admit(prepared, lease, { ...options, publish: lifecycle => { published = lifecycle; options!.publish!(lifecycle); } }));
    try {
      const input = queueWire(f.session, "hold for hiding accepted queued input"), next = queueWire(f.session);
      await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(id, next); await driveConsumer(f.running);
      await until("accepted hidden execution", async () => published?.submissionEvidence().nativeAcceptance === "accepted" || undefined);
      const before = mutations().length;
      expect((await isolatedApi(f.running, `/api/sessions/${id}/hide`, {}, f.token)).status).toBe(200);
      expect(published!.owner.stopRequested).not.toBe(true); expect(sessions.get(f.session.nativeSessionId!)!.active).toBe(true);
      expect(mutations()).toHaveLength(before); complete(f.session.nativeSessionId!); await published!.done;
      expect((await isolatedApi(f.running, `/api/sessions/${id}/unhide`, {}, f.token)).status).toBe(200);
      await driveConsumer(f.running); expect(store.inspect(id).pause?.code).toBe("hidden"); expect(store.lookup(id, next.requestId)!.item.claim).toBeNull();
    } finally { publisher.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  for (const action of ["cancel", "hide"] as const) for (const postRename of [false, true])
    test(`Phase5a ${action} pause ${postRename ? "post-rename" : "pre-write"} failure is globally storage-fatal before late native effects`, async () => {
      const f = await heldQueueBoundary(`controls-pause-fault-${action}-${postRename}`, "opencode", () => {}), id = f.session.sessionId, store = f.running.pendingInputs.store;
      const deps = (store as unknown as { deps: PendingInputStoreDependencies }).deps, write = deps.write;
      try {
        const input = queueWire(f.session); await f.running.pendingInputs.enqueue(id, input); const before = prompts().length;
        f.running.pendingInputConsumer.poll(); await f.entered.promise; await f.running.pendingInputConsumer.drain();
        deps.write = (dir, file, candidate) => {
          if ((candidate as any).conversations.find((c: any) => c.conversationId === id)?.pause) {
            if (postRename) (write ?? atomicAppRecord)(dir, file, candidate);
            throw new PendingInputDomainError("configuration-changed", "Offline misleading pause writer error");
          }
          (write ?? atomicAppRecord)(dir, file, candidate);
        };
        const failed = await isolatedApi(f.running, `/api/sessions/${id}/${action}`, {}, f.token);
        expect(failed.status).toBe(503); expect(failed.body.code).toBe("storage-unavailable");
        if (action === "cancel") expect(f.published().owner.stopRequested).toBe(true);
        const persisted = JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).conversations[0];
        expect(!!persisted.pause).toBe(postRename);
        deps.write = write; f.gate.resolve(); await f.published().done; await driveConsumer(f.running);
        expect(prompts()).toHaveLength(before);
        expect((await isolatedApi(f.running, "/api/sessions", { prompt: "offline failclosed after pause error" }, f.token)).body.code).toBe("storage-unavailable");
      } finally { deps.write = write; f.restore(); await closeStorageFailedFixture(f); }
    }, TIMEOUT);

  test("Phase5d2 domain chain guards resolved assignment owners, membership and default pins without freezing labels or peers", async () => {
    const f = await isolatedQueueSeed("domain-chain-targets", true), id = f.session.sessionId;
    const request = (path: string, input?: unknown) => isolatedApi(f.running, path, input, f.token);
    const listed = await request("/api/sessions"), admission = listed.body.sessions.find((s: any) => s.sessionId === id).admission;
    const qs = `?workspaceId=${admission.binding.workspaceId}`;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let held = false;
    const original = RepositoryRouter.prototype.forAdmission;
    let router: RepositoryRouter | undefined;
    const hold = spyOn(RepositoryRouter.prototype, "forAdmission").mockImplementation(async function(this: RepositoryRouter, ...args) {
      const adapter = await original.apply(this, args);
      if (held && args[0].sessionId === id) { held = false; router = this; entered.resolve(); await gate.promise; }
      return adapter;
    });
    try {
      for (const workstreamId of ["domain-source", "domain-destination"]) expect((await request(`/api/workstreams${qs}`, { id: workstreamId, title: workstreamId, type: "feature", defaultCheckout: f.session.cwd })).status).toBe(200);
      expect((await request(`/api/workstreams/associate${qs}`, { sessionId: id, workstreamId: "domain-source" })).status).toBe(200);
      const assigned = await request(`/api/workstreams/phase/assign${qs}`, { sessionId: id, phase: "engineering" }); expect(assigned.status).toBe(200);
      const peer = await request("/api/sessions", { cwd: f.session.cwd, prompt: "offline domain peer" }); expect(peer.status).toBe(202);
      await until("domain peer settled", async () => (await request("/api/sessions")).body.sessions.find((s: any) => s.sessionId === peer.body.sessionId)?.availability.canSend || undefined);
      const peerSession = JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).sessions.find((s: Session) => s.sessionId === peer.body.sessionId) as Session;
      const peerRef = { harness: "cc", authorityId: peerSession.authorityId, nativeId: peerSession.nativeSessionId };
      expect((await request(`/api/workstreams/associate${qs}`, { sessionId: peerSession.sessionId, workstreamId: "domain-source" })).status).toBe(200);
      const input = queueWire(f.session, "preserved domain waiting text"); expect((await request(queuePath(id), input)).status).toBe(202);
      const chain = f.running.pendingInputs.store.inspect(id), domainBefore = (await request(`/api/workstreams/overview${qs}`)).body, before = mutations().length;
      expect(chain.chain!.pins.context!.conversation.id).not.toBe(id);
      held = true;
      const delayed = request(`/api/workstreams/phase/assign${qs}`, { sessionId: id, phase: "design" }); await entered.promise; gate.resolve();
      expect(await delayed).toMatchObject({ status: 409, body: { code: "pending-input-chain-active" } });
      const ref = { harness: "cc", authorityId: f.session.authorityId, nativeId: f.session.nativeSessionId };
      for (const [operation, data] of [
        ["phase/end", { sessionId: id, assignmentId: assigned.body.id }],
        ["phase/end", { sessionId: peerSession.sessionId, assignmentId: assigned.body.id }],
        ["manage", { operation: "phase/end", ref: peerRef, assignmentId: assigned.body.id }],
        ["manage", { operation: "phase/assign", ref, phase: "design" }],
        ["manage", { operation: "associate", ref, workstreamId: "domain-destination" }],
        ["associate", { sessionId: id, workstreamId: "domain-destination" }],
        ["associate", { sessionId: id, workstreamId: null }],
        ["default-checkout", { id: "domain-source", checkout: null }],
      ] as const) expect(await request(`/api/workstreams/${operation}${qs}`, data)).toMatchObject({ status: 409, body: { code: "pending-input-chain-active" } });
      const adapter = await router!.forWorkspace(admission.binding.workspaceId);
      expect(() => adapter.endPhase(peerSession, assigned.body.id)).toThrow(WorkstreamAdapterError);
      expect(() => adapter.associate(f.session, "domain-destination")).toThrow(WorkstreamAdapterError);
      expect((await request(`/api/workstreams/overview${qs}`)).body).toEqual(domainBefore);
      expect(f.running.pendingInputs.store.inspect(id)).toEqual(chain); expect(mutations()).toHaveLength(before);
      // A peer/new child changes only its own captured assignment projection.
      expect((await request(`/api/workstreams/phase/assign${qs}`, { sessionId: peerSession.sessionId, phase: "design" })).status).toBe(200);
      const child = { ...f.session, sessionId: crypto.randomUUID(), nativeSessionId: crypto.randomUUID() };
      expect(adapter.register(child, { harness: "cc", authorityId: f.session.authorityId!, nativeId: f.session.nativeSessionId! }).workstreamId).toBe("domain-source");
      expect(adapter.assignPhase(child, "design").ref.nativeId).toBe(child.nativeSessionId);
      expect((await request(`/api/workstreams/default-checkout${qs}`, { id: "domain-destination", checkout: null })).status).toBe(200);
      const label = await fetch(`${f.running.origin}/api/workspaces/${admission.binding.workspaceId}/worktrees/${admission.binding.worktreeId}/alias`, { method: "PUT", headers: { origin: f.running.origin, cookie: f.token, "content-type": "application/json" }, body: JSON.stringify({ alias: "harmless queued label" }) }); expect(label.status).toBe(200);
      expect(f.running.pendingInputs.store.inspect(id)).toEqual(chain);
    } finally { gate.resolve(); hold.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase5d2 App-only chains fence scoped initialization and lifecycle reservations fence enqueue through awaited writes", async () => {
    const f = await isolatedQueueSeed("domain-app-only", false), id = f.session.sessionId;
    const request = (path: string, input?: unknown) => isolatedApi(f.running, path, input, f.token);
    const admission = (await request("/api/sessions")).body.sessions.find((s: any) => s.sessionId === id).admission;
    const qs = `?workspaceId=${admission.binding.workspaceId}`, input = queueWire(f.session, "App-only preserved text");
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let held = false;
    const provide = RepositoryDomain.prototype.providePhase;
    const hold = spyOn(RepositoryDomain.prototype, "providePhase").mockImplementation(async function(this: RepositoryDomain, ...args) {
      if (held && this.context.commonDir === f.discovery.commonDir) { held = false; entered.resolve(); await gate.promise; }
      return provide.apply(this, args);
    });
    try {
      expect((await request(queuePath(id), input)).status).toBe(202);
      const chain = f.running.pendingInputs.store.inspect(id), before = mutations().length;
      expect(chain.chain!.pins.context).toBeNull();
      expect(await request(`/api/workstreams/init${qs}`, {})).toMatchObject({ status: 409, body: { code: "pending-input-chain-active" } });
      expect((await request(`/api/workstreams/inspect${qs}`)).body.state).toBe("uninitialized");
      // Prefix-similar canonical paths are unrelated repositories, not scope matches.
      const other = `${f.session.cwd}-unrelated`; mkdirSync(other); expect(Bun.spawnSync(["git", "init", "-q", other]).exitCode).toBe(0);
      const registered = await request("/api/workspaces", { cwd: other });
      expect((await request(`/api/workstreams/init?workspaceId=${registered.body.workspaceId}`, {})).body.state).toBe("ready");
      // An external domain edit is allowed; consumer pin drift remains its job.
      initializeRepository(f.discovery);
      expect((await request(`/api/workstreams${qs}`, { id: "app-only-lifecycle", title: "Offline lifecycle", type: "feature" })).status).toBe(200);
      const status = (await request(`/api/workstreams/status${qs}&id=app-only-lifecycle`)).body;
      const action = { id: "app-only-lifecycle", phase: "design", repositoryId: status.workstream.repositoryId, expectedRevision: status.workstream.revision };
      for (const operation of ["provide", "approve"]) expect(await request(`/api/workstreams/${operation}${qs}`, { ...action, ...(operation === "approve" ? { approvalRef: "offline human approval" } : {}) })).toMatchObject({ status: 409, body: { code: "pending-input-chain-active" } });
      expect(f.running.pendingInputs.store.inspect(id)).toEqual(chain); expect(mutations()).toHaveLength(before);
      expect((await request(`${queuePath(id)}/${chain.snapshot.items[0]!.itemId}/remove`, { version: 1, requestId: crypto.randomUUID(), inputRequestId: input.requestId, conversationId: id, itemId: chain.snapshot.items[0]!.itemId })).status).toBe(200);
      held = true; const changing = request(`/api/workstreams/provide${qs}`, action); await entered.promise;
      expect(await request(queuePath(id), queueWire(f.session, "must not enter reserved repo"))).toMatchObject({ status: 409, body: { code: "workstream-action-pending" } });
      gate.resolve(); expect((await changing).status).toBe(200);
      expect(f.running.pendingInputs.store.inspect(id).chain).toBeNull();
    } finally { gate.resolve(); hold.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase5d2 chains created during router awaits are refused at the final domain mutation boundary", async () => {
    const f = await isolatedQueueSeed("domain-final-await", true), id = f.session.sessionId;
    const request = (path: string, input?: unknown) => isolatedApi(f.running, path, input, f.token);
    const admission = (await request("/api/sessions")).body.sessions.find((s: any) => s.sessionId === id).admission;
    const qs = `?workspaceId=${admission.binding.workspaceId}`;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    let held = false;
    const original = RepositoryRouter.prototype.forWorkspace;
    const hold = spyOn(RepositoryRouter.prototype, "forWorkspace").mockImplementation(async function(this: RepositoryRouter, ...args) {
      const adapter = await original.apply(this, args);
      if (held && args[0] === admission.binding.workspaceId) { held = false; entered.resolve(); await gate.promise; }
      return adapter;
    });
    try {
      expect((await request(`/api/workstreams${qs}`, { id: "await-domain", title: "Offline await", type: "feature", defaultCheckout: f.session.cwd })).status).toBe(200);
      expect((await request(`/api/workstreams/associate${qs}`, { sessionId: id, workstreamId: "await-domain" })).status).toBe(200);
      const before = (await request(`/api/workstreams/overview${qs}`)).body, nativeBefore = mutations().length;
      held = true; const changing = request(`/api/workstreams/default-checkout${qs}`, { id: "await-domain", checkout: null }); await entered.promise;
      expect((await request(queuePath(id), queueWire(f.session, "arrived while domain router held"))).status).toBe(202);
      const chain = f.running.pendingInputs.store.inspect(id); gate.resolve();
      expect(await changing).toMatchObject({ status: 409, body: { code: "pending-input-chain-active" } });
      expect((await request(`/api/workstreams/overview${qs}`)).body).toEqual(before); expect(f.running.pendingInputs.store.inspect(id)).toEqual(chain); expect(mutations()).toHaveLength(nativeBefore);
    } finally { gate.resolve(); hold.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase5d1 recipient chain arbitrates copied intents, branch/compact and both waiting outboxes", async () => {
    const timers = holdOutboxTimers();
    const f = await isolatedQueueSeed("recipient-chain-arbitration", true, "opencode"); timers.restore();
    const id = f.session.sessionId, observed: Array<{ kind: string; code?: string }> = [];
    let coordinator: ConversationCoordinator | undefined;
    const inspect = ConversationCoordinator.prototype.inspectReadiness;
    const readiness = spyOn(ConversationCoordinator.prototype, "inspectReadiness").mockImplementation(function(this: ConversationCoordinator, input) {
      const result = inspect.call(this, input);
      if (input.conversationId === id) { coordinator = this; observed.push({ kind: input.intent.kind, ...(!result.ready ? { code: result.code } : {}) }); }
      return result;
    });
    try {
      const listed = await isolatedApi(f.running, "/api/sessions", undefined, f.token);
      const workspaceId = listed.body.sessions.find((s: any) => s.sessionId === id).admission.binding.workspaceId;
      const qs = `?workspaceId=${workspaceId}`, workstreamId = "recipient-arbitration";
      expect((await isolatedApi(f.running, `/api/workstreams${qs}`, { id: workstreamId, title: "Offline arbitration", type: "feature", defaultCheckout: f.session.cwd }, f.token)).status).toBe(200);
      expect((await isolatedApi(f.running, `/api/workstreams/associate${qs}`, { sessionId: id, workstreamId }, f.token)).status).toBe(200);
      expect((await isolatedApi(f.running, `/api/workstreams/phase/assign${qs}`, { sessionId: id, phase: "engineering" }, f.token)).status).toBe(200);
      const head = queueWire(f.session); expect((await isolatedApi(f.running, queuePath(id), head, f.token)).status).toBe(202);
      for (const kind of ["user-prompt", "worker-report", "handoff", "prepare-recipient", "branch", "compact", "branch-recovery", "enroll", "retry-admission", "attach"] as const) {
        expect(coordinator!.reserveAdmission({ conversationIds: [id], intent: { kind, requestId: head.requestId } })).toMatchObject({ ready: false, code: "pending-input-chain-active" });
      }
      expect(coordinator!.inspectReadiness({ conversationId: id, intent: { kind: "inspect-idle" }, phase: "admission" })).toEqual({ ready: true });
      const before = mutations().length, beforeRuns = JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs.length;
      for (const [path, input] of [
        [`/api/sessions/${id}/branch`, { requestId: crypto.randomUUID(), runId: f.session.lastRunId, replace: false, prompt: "must not fork" }],
        [`/api/sessions/${id}/compact`, { requestId: crypto.randomUUID() }],
      ] as const) {
        const response = await isolatedApi(f.running, path, input, f.token);
        expect(response.status).toBe(409); expect(response.body.code).toBe("pending-input-chain-active");
      }
      const handoff = await enqueueFixtureHandoff(f, { requestId: crypto.randomUUID(), to: "engineering", message: "offline chain must retain this handoff", target: { harness: "oc", authorityId: f.session.authorityId, nativeId: f.session.nativeSessionId } });
      const workerId = pendingReport(f.running, f.session);
      expect(timers.callbacks).toHaveLength(2); for (const tick of timers.callbacks) tick();
      await until("both real outbox polls refused recipient chain", async () => observed.some(o => o.kind === "handoff" && o.code === "pending-input-chain-active")
        && f.running.workers.store.get(workerId)?.latestResult?.notification.error?.includes("durable input chain") ? true : undefined);
      expect(f.running.workerOutbox.list()).toEqual([]);
      expect(f.running.workers.store.get(workerId)!.latestResult!.notification.state).toBe("pending");
      expect((await isolatedApi(f.running, `/api/handoffs${qs}`, undefined, f.token)).body.handoffs.find((h: any) => h.id === handoff.id)).toMatchObject({ status: "queued", runId: null, attemptId: null });
      expect(mutations()).toHaveLength(before);
      expect(JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs).toHaveLength(beforeRuns);
      expect(f.running.pendingInputs.store.lookup(id, head.requestId)!.item).toMatchObject({ state: "waiting", claim: null });
    } finally { timers.restore(); readiness.mockRestore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase5d1 actual eligible queued handoff writer faults fence storage before diagnostics and never replay", async () => {
    for (const mode of ["pre-commit", "post-commit", "diagnostic"] as const) {
      const timers = holdOutboxTimers();
      const f = await isolatedQueueSeed(`handoff-writer-fault-${mode}`, true, "opencode"); timers.restore();
      const advance = RepositoryDomain.prototype.advanceHandoff, record = RepositoryDomain.prototype.recordHandoffProblem, assertIdle = OpenCodeAdapter.prototype.assertIdle;
      let handoffId = "", attempts = 0, diagnostics = 0, diagnosticFence: string | undefined, proofUnavailable = false, diagnosticFault = false;
      let attempted: { attemptId?: string; nativeCommandId?: string; runId?: string } | undefined;
      const writer = spyOn(RepositoryDomain.prototype, "advanceHandoff").mockImplementation(function(this: RepositoryDomain, ...args) {
        if (args[0] !== handoffId) return advance.apply(this, args);
        attempts++; attempted = args[2];
        if (mode === "diagnostic") throw new DomainError("CONFLICT", "Offline ordinary handoff authority refusal");
        if (mode === "post-commit") advance.apply(this, args);
        throw new DomainError("STORAGE_ERROR", `Offline ${mode} handoff writer failure`);
      });
      const diagnostic = spyOn(RepositoryDomain.prototype, "recordHandoffProblem").mockImplementation(function(this: RepositoryDomain, ...args) {
        if (args[0] !== handoffId) return record.apply(this, args);
        diagnostics++;
        try { const lease = f.running.preparedInput.reserve({ kind: "user-prompt" }, f.session.sessionId); f.running.preparedInput.release(lease); }
        catch (error) { diagnosticFence = error instanceof WorkstreamAdapterError ? error.code : "unexpected"; }
        if (diagnosticFault) throw new DomainError("STORAGE_ERROR", "Offline diagnostic writer private detail");
        return record.apply(this, args);
      });
      const proof = spyOn(OpenCodeAdapter.prototype, "assertIdle").mockImplementation(function(this: OpenCodeAdapter, nativeId, cwd) {
        if (proofUnavailable && nativeId === f.session.nativeSessionId) throw new OpenCodeUnavailableError("Offline read-only handoff native proof unavailable");
        return assertIdle.call(this, nativeId, cwd);
      });
      try {
        const listed = await isolatedApi(f.running, "/api/sessions", undefined, f.token);
        const workspaceId = listed.body.sessions.find((s: any) => s.sessionId === f.session.sessionId).admission.binding.workspaceId, qs = `?workspaceId=${workspaceId}`;
        expect((await isolatedApi(f.running, `/api/workstreams${qs}`, { id: "writer-fault", title: "Offline writer boundary", type: "feature", defaultCheckout: f.session.cwd }, f.token)).status).toBe(200);
        expect((await isolatedApi(f.running, `/api/workstreams/associate${qs}`, { sessionId: f.session.sessionId, workstreamId: "writer-fault" }, f.token)).status).toBe(200);
        expect((await isolatedApi(f.running, `/api/workstreams/phase/assign${qs}`, { sessionId: f.session.sessionId, phase: "engineering" }, f.token)).status).toBe(200);
        const created = await isolatedApi(f.running, "/api/sessions", { harness: "opencode", prompt: "offline unrelated handoff writer fault seed" }, f.token);
        expect(created.status).toBe(202);
        await until("unrelated handoff fault conversation idle", async () => (await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.sessions.find((s: any) => s.sessionId === created.body.sessionId)?.availability.canSend || undefined);
        const unrelated = JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).sessions.find((s: Session) => s.sessionId !== f.session.sessionId) as Session;
        const handoff = await enqueueFixtureHandoff(f, { requestId: crypto.randomUUID(), to: "engineering", message: "offline actual writer fault delivery", target: { harness: "oc", authorityId: f.session.authorityId, nativeId: f.session.nativeSessionId } });
        handoffId = handoff.id;
        const read = () => isolatedApi(f.running, `/api/handoffs${qs}`, undefined, f.token);
        const before = mutations().length, cliBefore = invocations().length, runsBefore = JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs.length;
        expect(timers.callbacks).toHaveLength(2);
        if (mode === "diagnostic") {
          timers.callbacks[0]!();
          await until("ordinary handoff refusal diagnostic", async () => (await read()).body.problems[handoffId]?.includes("ordinary handoff authority refusal") || undefined);
          expect((await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.availability.canSend).toBe(true);
          expect((await read()).body.handoffs.find((h: any) => h.id === handoffId)).toMatchObject({ status: "queued", attemptId: null, runId: null });
          proofUnavailable = true;
        }
        diagnosticFault = mode !== "pre-commit";
        timers.callbacks[0]!();
        await until("handoff writer fault closes global storage", async () => (await isolatedApi(f.running, "/api/sessions", undefined, f.token)).body.availability.code === "storage-unavailable" || undefined);
        await until("failed handoff diagnostic remains projected", async () => (await read()).body.problems[handoffId]?.includes(mode === "diagnostic" ? "native proof unavailable; durable problem record failed" : `${mode} handoff writer failure`) || undefined);
        expect(attempts).toBe(1); expect(diagnostics).toBe(mode === "diagnostic" ? 2 : 1);
        if (mode !== "diagnostic") expect(diagnosticFence).toBe("storage-unavailable");
        const original = (await read()).body.handoffs.find((h: any) => h.id === handoffId);
        expect(original).toMatchObject(mode === "post-commit" ? { id: handoffId, status: "acceptance_unknown", attemptId: attempted!.attemptId, nativeCommandId: attempted!.nativeCommandId, runId: attempted!.runId }
          : { id: handoffId, status: "queued", attemptId: null, nativeCommandId: null, runId: null });
        expect((await read()).body.problems[handoffId]).not.toContain("private detail");
        const denied = await isolatedApi(f.running, "/api/sessions", { sessionId: unrelated.sessionId, prompt: "offline unrelated direct send must be fenced" }, f.token);
        expect(denied.body.code).toBe("storage-unavailable"); expect(denied.status).toBe(409);
        expect((await isolatedApi(f.running, queuePath(unrelated.sessionId), queueWire(unrelated), f.token)).status).toBe(503);
        timers.callbacks[0]!(); await Bun.sleep(50);
        expect(attempts).toBe(1); expect((await read()).body.handoffs).toHaveLength(1);
        expect((await read()).body.handoffs[0]).toEqual(original);
        expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(cliBefore);
        expect(JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs).toHaveLength(runsBefore);
      } finally { writer.mockRestore(); diagnostic.mockRestore(); proof.mockRestore(); timers.restore(); await closeStorageFailedFixture(f); }
    }
  }, TIMEOUT * 3);

  test("Phase5d1 report preflight rechecks a newly enqueued chain before durable claim", async () => {
    const timers = holdOutboxTimers();
    const f = await isolatedQueueSeed("report-chain-preflight", true, "opencode"); timers.restore();
    const id = f.session.sessionId, entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const assertIdle = OpenCodeAdapter.prototype.assertIdle;
    const idle = spyOn(OpenCodeAdapter.prototype, "assertIdle").mockImplementation(async function(this: OpenCodeAdapter, nativeId, cwd) {
      await assertIdle.call(this, nativeId, cwd);
      if (nativeId === f.session.nativeSessionId) { entered.resolve(); await gate.promise; }
    });
    try {
      const workerId = pendingReport(f.running, f.session), before = prompts().length;
      expect(timers.callbacks).toHaveLength(2); timers.callbacks[1]!(); await entered.promise;
      const head = queueWire(f.session); expect((await isolatedApi(f.running, queuePath(id), head, f.token)).status).toBe(202);
      gate.resolve();
      await until("fresh post-native-preflight report refusal", async () => f.running.workers.store.get(workerId)?.latestResult?.notification.error?.includes("durable input chain") ? true : undefined);
      expect(f.running.workerOutbox.list()).toEqual([]); expect(prompts()).toHaveLength(before);
      expect(f.running.workers.store.get(workerId)!.latestResult!.notification.state).toBe("pending");
      expect(f.running.pendingInputs.store.lookup(id, head.requestId)!.item).toMatchObject({ state: "waiting", claim: null });
    } finally { gate.resolve(); idle.mockRestore(); timers.restore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase5d1 new handoff recipient holds preparation lease through awaited binding", async () => {
    const timers = holdOutboxTimers();
    const f = await isolatedQueueSeed("handoff-binding-chain-fence", true, "opencode"); timers.restore();
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const execution = RepositoryRouter.prototype.execution;
    let recipientId: string | undefined;
    const hold = spyOn(RepositoryRouter.prototype, "execution").mockImplementation(async function(this: RepositoryRouter, admission) {
      const result = await execution.call(this, admission);
      if (admission.sessionId === recipientId) { entered.resolve(); await gate.promise; }
      return result;
    });
    const assertIdle = OpenCodeAdapter.prototype.assertIdle;
    const withhold = spyOn(OpenCodeAdapter.prototype, "assertIdle").mockImplementation(async function(this: OpenCodeAdapter, nativeId, cwd) {
      if (recipientId && JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).sessions.some((s: Session) => s.sessionId === recipientId && s.nativeSessionId === nativeId)) throw new OpenCodeUnavailableError("Offline binding fixture withholds delivery after preparation");
      return assertIdle.call(this, nativeId, cwd);
    });
    try {
      const listed = await isolatedApi(f.running, "/api/sessions", undefined, f.token);
      const workspaceId = listed.body.sessions.find((s: any) => s.sessionId === f.session.sessionId).admission.binding.workspaceId;
      const qs = `?workspaceId=${workspaceId}`, workstreamId = "binding-arbitration";
      expect((await isolatedApi(f.running, `/api/workstreams${qs}`, { id: workstreamId, title: "Offline binding", type: "feature", defaultCheckout: f.session.cwd }, f.token)).status).toBe(200);
      expect((await isolatedApi(f.running, `/api/workstreams/associate${qs}`, { sessionId: f.session.sessionId, workstreamId }, f.token)).status).toBe(200);
      const handoff = await enqueueFixtureHandoff(f, { requestId: crypto.randomUUID(), to: "engineering", message: "offline new recipient binding", createNew: true });
      recipientId = handoff.recipientSessionId; timers.callbacks[0]!(); await entered.promise;
      const session = JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).sessions.find((s: Session) => s.sessionId === recipientId) as Session;
      const input = queueWire(session);
      const refused = await isolatedApi(f.running, queuePath(recipientId), input, f.token);
      expect(refused.status).toBe(409); expect(refused.body.code).toBe("pending-input-legacy-reservation");
      expect(f.running.pendingInputs.store.inspect(recipientId).chain).toBeNull();
      expect((await isolatedApi(f.running, `/api/handoffs?workspaceId=${workspaceId}`, undefined, f.token)).body.handoffs.find((h: any) => h.id === handoff.id).recipient.ref).toBeNull();
      gate.resolve();
      const bound = await until("handoff preparation bound", async () => {
        const response = await isolatedApi(f.running, `/api/handoffs?workspaceId=${workspaceId}`, undefined, f.token);
        const current = response.body.handoffs.find((h: any) => h.id === handoff.id);
        return current.recipient.ref ? current : undefined;
      });
      expect(bound.recipient.ref?.nativeId).toBe(session.nativeSessionId); expect(bound.status).toBe("queued");
      await until("binding lease released before enqueue", async () => (await isolatedApi(f.running, queuePath(recipientId!), input, f.token)).status === 202 ? true : undefined);
      expect(f.running.pendingInputs.store.lookup(recipientId, input.requestId)!.item).toMatchObject({ state: "waiting", claim: null });
    } finally { gate.resolve(); hold.mockRestore(); withhold.mockRestore(); timers.restore(); await f.running.close(); }
  }, TIMEOUT);

  test("Phase5a raw worker suppression failure on direct Stop retains owner flags and fails closed, not HTTP 400", async () => {
    const f = await heldQueueBoundary("controls-worker-suppression-fault", "opencode", () => {}), id = f.session.sessionId;
    const suppress = WorkerStore.prototype.suppress; let fault: ReturnType<typeof spyOn> | undefined;
    try {
      const input = queueWire(f.session); await f.running.pendingInputs.enqueue(id, input); const before = prompts().length;
      f.running.pendingInputConsumer.poll(); await f.entered.promise; await f.running.pendingInputConsumer.drain();
      fault = spyOn(WorkerStore.prototype, "suppress").mockImplementation(function(this: WorkerStore, sessionId, suppressed) { if (sessionId === id && suppressed) throw new Error("Offline raw suppression atomic write failure"); return suppress.call(this, sessionId, suppressed); });
      const failed = await isolatedApi(f.running, `/api/sessions/${id}/cancel`, {}, f.token);
      expect(failed.status).toBe(503); expect(failed.body.code).toBe("storage-unavailable");
      expect(f.published().owner).toMatchObject({ stopRequested: true, cancelling: true }); expect(f.running.pendingInputs.store.inspect(id).pause?.code).toBe("stopped");
      fault.mockRestore(); f.gate.resolve(); await f.published().done; await driveConsumer(f.running); expect(prompts()).toHaveLength(before);
      expect((await isolatedApi(f.running, "/api/sessions", { prompt: "offline raw suppression closes global admission" }, f.token)).body.code).toBe("storage-unavailable");
    } finally { fault?.mockRestore(); f.restore(); await closeStorageFailedFixture(f); }
  }, TIMEOUT);

  for (const mode of ["pause-pre", "pause-post", "suppress-pre", "suppress-post", "wrapped-reject", "wrapped-never", "void-async", "fence-async"] as const)
    test(`Phase5a actual worker cancel HTTP route ${mode} is storage-fatal before refresh and late native effects`, async () => {
      const f = await heldQueueBoundary(`controls-worker-route-${mode}`, "opencode", () => {}), id = f.session.sessionId, store = f.running.pendingInputs.store;
      const workers = f.running.workers, executor = (workers as unknown as { executor: WorkerExecutor }).executor;
      const deps = (store as unknown as { deps: PendingInputStoreDependencies }).deps, write = deps.write;
      const observe = executor.observe, suppressionHook = executor.suppressCancellation, beforeCancel = executor.beforeCancel;
      const gate = Promise.withResolvers<void>(), cancel = OpenCodeAdapter.prototype.cancel;
      let reads = 0, nativeCancels = 0, suppression: ReturnType<typeof spyOn> | undefined;
      const nativeCancel = spyOn(OpenCodeAdapter.prototype, "cancel").mockImplementation(function(this: OpenCodeAdapter, ...args) { nativeCancels++; return cancel.apply(this, args); });
      try {
        const created = await isolatedApi(f.running, "/api/sessions", { harness: "opencode", prompt: "offline actual worker parent", cwd: f.session.cwd }, f.token);
        expect(created.status).toBe(202);
        await until("actual worker parent settled", async () => JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === created.body.runId)?.status === "completed" || undefined);
        const root = created.body.sessionId, wid = crypto.randomUUID(), now = new Date().toISOString();
        workers.store.insert({ id: wid, sessionId: id, runId: f.session.lastRunId!, parent: { sessionId: root, runId: created.body.runId, toolCallId: "offline-route-worker", native: { harness: "oc", authorityId: f.session.authorityId!, nativeId: created.body.nativeSessionId ?? "offline-parent" } },
          input: { requestId: crypto.randomUUID(), worker: "tester", prompt: "offline historical route worker" }, checkout: f.session.cwd,
          launch: { profileId: "worker:tester", harness: "opencode", agent: "sane/worker/tester" }, child: { harness: "oc", authorityId: f.session.authorityId!, nativeId: f.session.nativeSessionId! }, state: "completed", createdAt: now, updatedAt: now,
          outcome: { status: "completed", at: now, summary: "offline route worker result", log: { sessionId: id, runId: f.session.lastRunId! } }, notification: { id: `worker-outcome:${wid}`, state: "wait-consumed" } });
        const path = `/api/sessions/${root}/workers/cancel`;
        const invalid = await isolatedApi(f.running, path, { ids: [crypto.randomUUID()] }, f.token);
        expect(invalid.status).toBe(409); expect(invalid.body.code).toBe("worker-cancel");
        const input = queueWire(f.session), waiter = queueWire(f.session, "offline route waiter preserved after uncertain write");
        await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(id, waiter);
        f.running.pendingInputConsumer.poll(); await f.entered.promise; await f.running.pendingInputConsumer.drain();
        const identity = store.lookup(id, input.requestId)!.item.claim!.identity, before = mutations().length, cli = invocations().length;
        executor.observe = async w => { reads++; return observe(w); };
        if (mode.startsWith("pause-")) deps.write = (dir, file, candidate) => {
          if ((candidate as any).conversations.find((c: any) => c.conversationId === id)?.pause) {
            if (mode === "pause-post") (write ?? atomicAppRecord)(dir, file, candidate);
            throw new PendingInputDomainError("worker-scope", "Misleading pause writer failure");
          }
          (write ?? atomicAppRecord)(dir, file, candidate);
        };
        else if (mode === "void-async") executor.suppressCancellation = () => gate.promise;
        else if (mode === "fence-async") executor.beforeCancel = (() => gate.promise) as unknown as NonNullable<WorkerExecutor["beforeCancel"]>;
        else {
          const suppress = workers.store.suppress;
          suppression = spyOn(workers.store, "suppress").mockImplementation((sessionId, value) => {
            if (sessionId !== id || !value) return suppress.call(workers.store, sessionId, value);
            if (mode.startsWith("wrapped-")) return gate.promise;
            if (mode === "suppress-post") suppress.call(workers.store, sessionId, value);
            throw new PendingInputDomainError("worker-scope", "Raw cancellation suppression writer failure");
          });
        }
        const failed = await isolatedApi(f.running, path, mode.endsWith("post") || mode === "void-async" ? { all: true } : { ids: [wid] }, f.token);
        expect(failed.status).toBe(503); expect(failed.body.code).toBe("storage-unavailable");
        expect(reads).toBe(0); expect(nativeCancels).toBe(0); expect(workers.store.get(wid)!.continuationCancellation).toBeUndefined();
        if (mode !== "fence-async") expect(f.published().owner).toMatchObject({ stopRequested: true, cancelling: true });
        expect(store.lookup(id, waiter.requestId)!.item).toMatchObject({ state: "waiting", claim: null, history: null });
        expect(store.lookup(id, input.requestId)!.item.claim).toMatchObject({ identity, possibleNative: false });
        const persisted = JSON.parse(readFileSync(join(f.selected.dataDir, "pending-inputs.json"), "utf8")).conversations.find((c: any) => c.conversationId === id);
        expect(!!persisted.pause).toBe(mode !== "pause-pre" && mode !== "fence-async");
        expect(persisted.items.find((i: any) => i.requestId === waiter.requestId)).toMatchObject({ state: "waiting", claim: null, history: null });
        if (mode === "suppress-post") expect(JSON.parse(readFileSync(join(f.selected.dataDir, "workers.json"), "utf8")).suppressedParents).toContain(id);
        const fenced = await isolatedApi(f.running, "/api/sessions", { prompt: "offline HTTP worker fault closes global admission" }, f.token);
        expect(fenced.status).toBe(409); expect(fenced.body.code).toBe("storage-unavailable");
        if (["wrapped-reject", "void-async", "fence-async"].includes(mode)) { gate.reject(new PendingInputDomainError("worker-scope", "Late asynchronous refusal remains unsafe")); await Promise.resolve(); await Promise.resolve(); }
        deps.write = write; suppression?.mockRestore(); executor.suppressCancellation = suppressionHook; executor.beforeCancel = beforeCancel;
        f.gate.resolve(); await f.published().done; await driveConsumer(f.running);
        expect(reads).toBe(0); expect(nativeCancels).toBe(0); expect(mutations()).toHaveLength(before); expect(invocations()).toHaveLength(cli);
        expect(store.lookup(id, waiter.requestId)!.item).toMatchObject({ state: "waiting", claim: null, history: null });
      } finally {
        deps.write = write; suppression?.mockRestore(); executor.observe = observe; executor.suppressCancellation = suppressionHook; executor.beforeCancel = beforeCancel;
        nativeCancel.mockRestore(); f.restore(); await closeStorageFailedFixture(f);
      }
    }, TIMEOUT);

  for (const fault of [false, true]) test(`Phase5a selected worker cancellation ${fault ? "suppression fault closes storage" : "fences before held refresh without cascading"}`, async () => {
    const f = await isolatedQueueSeed(`controls-worker-before-refresh-${fault}`, false, "opencode"), id = f.session.sessionId, store = f.running.pendingInputs.store;
    const workers = f.running.workers, executor = (workers as unknown as { executor: WorkerExecutor }).executor, observe = executor.observe;
    const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>(); let pending: Promise<WorkerRecord[]> | undefined, suppression: ReturnType<typeof spyOn> | undefined;
    try {
      const created = await isolatedApi(f.running, "/api/sessions", { harness: "opencode", prompt: "offline nested worker queue seed", cwd: f.session.cwd }, f.token);
      await until("nested queue seed completed", async () => JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).runs.find((r: any) => r.runId === created.body.runId)?.status === "completed" || undefined);
      const childSession = JSON.parse(readFileSync(join(f.selected.dataDir, "metadata.json"), "utf8")).sessions.find((s: Session) => s.sessionId === created.body.sessionId) as Session;
      const root = crypto.randomUUID(), now = new Date().toISOString();
      // Historical worker records only; ordinary real bridge runs/queue claims
      // and native preparation still belong to the existing offline services.
      const row = (session: Session, parent: string): WorkerRecord => {
        const wid = crypto.randomUUID();
        return { id: wid, sessionId: session.sessionId, runId: session.lastRunId!, parent: { sessionId: parent, runId: crypto.randomUUID(), toolCallId: "offline-seeded-worker", native: { harness: "oc", nativeId: "offline-parent", authorityId: session.authorityId! } },
          input: { requestId: crypto.randomUUID(), worker: "tester", prompt: "offline historical worker" }, checkout: session.cwd,
          launch: { profileId: "worker:tester", harness: "opencode", agent: "sane/worker/tester" }, child: { harness: "oc", authorityId: session.authorityId!, nativeId: session.nativeSessionId! }, state: "completed", createdAt: now, updatedAt: now,
          outcome: { status: "completed", at: now, summary: "offline initial worker result", log: { sessionId: session.sessionId, runId: session.lastRunId! } }, notification: { id: `worker-outcome:${wid}`, state: "wait-consumed" } };
      };
      const selected = row(f.session, root), child = row(childSession, id); workers.store.insert(selected); workers.store.insert(child);
      const input = queueWire(f.session), childInput = queueWire(childSession);
      await f.running.pendingInputs.enqueue(id, input); await f.running.pendingInputs.enqueue(childSession.sessionId, childInput);
      executor.observe = async w => { if (w.id === selected.id) { entered.resolve(); await gate.promise; } return observe(w); };
      const before = prompts().length;
      if (fault) {
        const suppress = workers.store.suppress;
        suppression = spyOn(workers.store, "suppress").mockImplementation((sessionId, value) => { if (sessionId === id) throw new Error("Offline selected worker suppression writer failure"); return suppress.call(workers.store, sessionId, value); });
        await expect(workers.cancelForSession(root, [selected.id])).rejects.toBeInstanceOf(PendingInputStorageError);
        expect((await isolatedApi(f.running, "/api/sessions", { prompt: "offline worker write fault global fence" }, f.token)).body.code).toBe("storage-unavailable");
      } else {
        pending = workers.cancelForSession(root, [selected.id]); await entered.promise;
        expect(workers.store.suppressed(id)).toBe(true); expect(workers.store.suppressed(childSession.sessionId)).toBe(false);
      }
      expect(store.inspect(id).pause?.code).toBe("stopped"); expect(store.inspect(childSession.sessionId).pause).toBeNull();
      expect(store.lookup(id, input.requestId)!.item.claim).toBeNull();
      // Drive only the targeted chain while refresh is held. The child remains
      // independently eligible; it was not included in this cancellation policy.
      if (!fault) { store.pause(childSession.sessionId, { code: "failed", reason: "Offline independent child fixture fence" }); await driveConsumer(f.running); }
      expect(prompts()).toHaveLength(before); gate.resolve(); await pending;
      expect(workers.store.get(child.id)!.cancelRequestedAt).toBeUndefined();
    } finally { gate.resolve(); await pending; executor.observe = observe; suppression?.mockRestore(); if (fault) await closeStorageFailedFixture(f); else await f.running.close(); }
  }, TIMEOUT);

  test("Phase3 FIFO HTTP admission with parked clock is concurrent three-max, advertised and cannot bypass ordinary prompt", async () => {
    const session = await queueSession(), path = queuePath(session.sessionId), beforeNative = mutations().length, beforeCli = invocations().length, beforeRuns = disk("metadata.json").runs.length;
    const inputs = [queueWire(session), queueWire(session), queueWire(session)], results = await Promise.all(inputs.map(input => api(path, input)));
    expect(results.map(r => r.status)).toEqual([202, 202, 202]); expect(new Set(results.map(r => r.body.itemId)).size).toBe(3);
    expect((await api(path, queueWire(session))).status).toBe(429);
    const read = await api(path); expect(isPendingInputSnapshot(read.body.snapshot)).toBe(true);
    expect(read.body.snapshot.items.map((i: any) => i.sequence)).toEqual([1, 2, 3]); expect(read.body.snapshot.revision).toBe(3);
    expect(read.body.presentation).toMatchObject({ waitingCount: 3, maxWaiting: 3, chainLocked: true, unresolved: null, automation: { supported: true }, enqueue: { allowed: false, code: "pending-input-full" } });
    const bypass = await api("/api/sessions", { sessionId: session.sessionId, prompt: "must not overtake", profileId: "template:engineering", requestId: crypto.randomUUID() });
    expect(bypass.status).toBe(409); expect(bypass.body.code).toBe("pending-input-chain-active");
    expect((await api(path, inputs[0], { anonymous: true })).status).toBe(401);
    expect(mutations()).toHaveLength(beforeNative); expect(invocations()).toHaveLength(beforeCli); expect(disk("metadata.json").runs).toHaveLength(beforeRuns);
    expect((await api(`/api/sessions/${session.sessionId}/runs`)).body.runs).toHaveLength(1);
    expect(isPendingInputCapability((await api("/api/config")).body.pendingInputCapability)).toBe(true);
  }, TIMEOUT);

  test("Phase3 busy OpenCode accepts only App waiters without touching its distinct native inbox", async () => {
    const session = await queueSession("opencode"), path = queuePath(session.sessionId), held = await api("/api/sessions", { sessionId: session.sessionId, prompt: "hold for phase3 App-only waiters" }); expect(held.status).toBe(202);
    await until("busy queue fixture native submission acknowledged before counting mutations", async () => storedRun(held.body.runId)?.nativePhase === "accepted" || undefined);
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
    const read = await api(path); expect(read.body.presentation.enqueue).toMatchObject({ allowed: false, code: "pending-input-attached-cc" }); expect(read.body.presentation.automation.supported).toBe(true);
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
    expect((await api(path)).body.presentation.automation.supported).toBe(true);
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
