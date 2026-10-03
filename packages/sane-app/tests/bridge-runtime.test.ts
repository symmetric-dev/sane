/** Real HTTP bridge wiring, entirely offline: isolated installation/store/repo,
 * registered loopback fake OpenCode HTTP service, and a test-owned Claude script.
 * Never builds assets, ensures a managed service, or invokes installed CLIs/models.
 * Run this file alone: startup selectors/password are saved and restored below.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { start, type Options } from "../src/bridge";
import { initializeAppStore } from "../src/app-store";
import { acquireData, acquireInstallation, validateOwnershipPaths, type OwnershipHandle } from "../src/installation-ownership";
import type { NativeMessage } from "../src/opencode";

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
type FakeSession = { info: any; messages: NativeMessage[]; active: boolean };
const calls: Call[] = [];
const sessions = new Map<string, FakeSession>();
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
  if (path === "/api/model") return Response.json({ data: [{ id: "offline", providerID: "fixture", name: "Offline fixture", enabled: true, variants: [{ id: "bounded" }] }] });
  if (path === "/api/agent") return Response.json({ data: [{ id: "sane/assistant/engineering", model: { providerID: "fixture", id: "offline", variant: "bounded" } }] });
  if (path === "/api/session/active") return Response.json({ data: Object.fromEntries([...sessions].filter(([, s]) => s.active).map(([id]) => [id, { type: "running" }])) });
  if (path === "/api/session" && req.method === "POST") {
    const id = `ses_fixture_${sessions.size + 1}`, time = 1700000000000 + sessions.size * 1000;
    const info = { id, ...input, time: { created: time, updated: time } };
    sessions.set(id, { info, messages: [], active: false });
    return Response.json({ data: info });
  }
  const match = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(path);
  const session = match && sessions.get(match[1]!);
  if (!session) return Response.json({ error: `Unexpected fixture route: ${path}` }, { status: 404 });
  switch (match![2]) {
    case undefined: return Response.json({ data: session.info });
    case "model": session.info.model = input.model; return Response.json({ data: session.info });
    case "inbox": case "permission": case "form": return Response.json({ data: [] });
    case "message": return Response.json({ data: [...session.messages].reverse(), cursor: { next: null } });
    case "prompt": {
      const time = session.info.time.updated + 10;
      session.messages.push({ id: input.id, type: "user", text: input.text, time: { created: time } });
      session.active = true; session.info.time.updated = time;
      if (!input.text.startsWith("hold for ")) complete(match![1]!);
      return Response.json({ data: { id: input.id, time: { created: time } } });
    }
    case "interrupt": complete(match![1]!, "interrupted"); return Response.json({ interrupted: true });
    default: return Response.json({ error: `Unexpected fixture route: ${path}` }, { status: 404 });
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
});
