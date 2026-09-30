/**
 * Real-agent native handoff integration.
 * File 1: four-direction baseline + targeting/idempotency + scheduling/cancellation.
 *
 * Contract sources: packages/sane-app/src/bridge.ts,
 * packages/sane-core/src/schema.ts (handoffs) + server.ts.
 *
 * Rules enforced here:
 * - Serial only: top-level describe.serial; a 45s sleep runs between tests
 *   (INTER_TEST_DELAY_MS, env NATIVE_INTER_TEST_DELAY_MS). Never parallel.
 * - Models: OC opencode-go/muse-spark-1.3-contributor (high variant), verified against
 *   the installed model catalog at runtime. CC NATIVE_CC_MODEL when set, else the
 *   installed CLI default model (no --model flag); explicit failure when unavailable.
 * - Narrow marker prompts (HANDOFF-*-OK): fixed reporting task, explicit
 *   "execute only these commands, do not deviate, do not approve anything,
 *   end turn after reporting". Max 5 agent turns per handoff, 600s per-handoff timeout.
 * - Disposable repos/workstreams/App stores/ports/sessions; unique requestIds.
 *   Asserts durable domain state + correlated native history, never model claims alone.
 * - Spend cap: at most 7 real agent turns for this file (7 + recovery file 5 = 12
 *   combined worst case per full run). chargeTurns() fails explicitly past budget.
 * - Unsupported directions: test.skip with reason (CC gate below). No silent passes.
 * - Evidence log per handoff, secrets redacted; flushed to NATIVE_EVIDENCE_DIR in afterAll.
 *
 * Implementation only: real OC/CC agents launch when this suite runs, not at
 * authoring time. Verify with typecheck only (`bunx tsc --noEmit`); do NOT run.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resolveAppConfig } from "../src/app-config";
import { runtimeOptions, start } from "../src/bridge";
import { validateOwnershipPaths, acquireInstallation, acquireData, type OwnershipHandle } from "../src/installation-ownership";
import { initializeAppStore } from "../src/app-store";

const INTER_TEST_DELAY_MS = (() => {
  const v = Number(process.env.NATIVE_INTER_TEST_DELAY_MS ?? 45000);
  return Number.isFinite(v) && v >= 0 ? v : 45000;
})();
const HANDOFF_TIMEOUT_MS = 600000;
const BOOT_TIMEOUT_MS = 300000;
const QUICK_TIMEOUT_MS = 120000;
const TURN_BUDGET = 7;
const OC_MODEL = "opencode-go/muse-spark-1.3-contributor";
const OC_VARIANT = "high";
let resolvedOcModel = OC_MODEL;
const CC_ENV_MODEL = (process.env.NATIVE_CC_MODEL ?? "").trim();
const MAX_TURNS_PER_HANDOFF = 5;

const PKG_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const bridgeSource = readFileSync(join(PKG_DIR, "src", "bridge.ts"), "utf8");
if (!bridgeSource.includes("consumeHandoffs") || !bridgeSource.includes("maxConcurrentRuns")) {
  throw new Error("native-test: bridge handoff/scheduling implementation markers moved; update this suite");
}
const ambient = (() => {
  try {
    return resolveAppConfig([], { packageDir: PKG_DIR, invocationCwd: process.cwd() });
  } catch (error) {
    throw new Error(`native-test: ambient App config unreadable, set NATIVE_CLAUDE_PROFILE/NATIVE_OPENCODE_REGISTRATION: ${error instanceof Error ? error.message : String(error)}`);
  }
})();
const CC_STATIC_AVAILABLE = ambient.sources.claude.state === "available";
const ccTest: typeof test = CC_STATIC_AVAILABLE
  ? test
  : test.skip;

type Evidence = Record<string, unknown>;
const evidence: Evidence[] = [];
function record(entry: Evidence): void {
  const clean: Evidence = {};
  for (const [k, v] of Object.entries(entry)) {
    if (/token|secret|password|cookie|auth/i.test(k)) { clean[k] = "<redacted>"; continue; }
    clean[k] = typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  }
  evidence.push({ at: new Date().toISOString(), ...clean });
}
let chargedTurns = 0;
function chargeTurns(n: number, label: string): void {
  chargedTurns += n;
  record({ kind: "turn-budget", label, charged: n, total: chargedTurns, budget: TURN_BUDGET });
  if (chargedTurns > TURN_BUDGET) throw new Error(`spend cap exceeded: ${chargedTurns}/${TURN_BUDGET} real agent turns (${label})`);
}

type TestApp = {
  origin: string; dataDir: string; repoDir: string; workspaceId: string; workstreamId: string;
  ccProfile: string; ocRegistration: string; claudeBin: string; root: string;
  close: () => Promise<void>;
};

async function api(origin: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${origin}${path}`, { ...init, redirect: "error" });
  const text = await res.text();
  let body: any = null;
  try { body = text ? (JSON.parse(text) as any) : null; } catch { body = { raw: text.slice(0, 2000) }; }
  return { status: res.status, body };
}
const appHeaders = (origin: string): Record<string, string> => ({ "content-type": "application/json", origin });

async function bootApp(tag: string, maxConcurrentRuns: number, workstreamId: string): Promise<TestApp> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `itest--`)));
  const repoDir = join(root, "repo");
  const dataDir = join(root, "appdata");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const git = Bun.spawn(["git", "init", repoDir], { stdout: "ignore", stderr: "ignore" });
  if ((await git.exited) !== 0 || git.exitCode !== 0) throw new Error("native-test: cannot init disposable repo (git init failed)");
  const ccProfile = process.env.NATIVE_CLAUDE_PROFILE ?? ambient.config.native.claude.profileRoot;
  const ocRegistration = process.env.NATIVE_OPENCODE_REGISTRATION ?? ambient.config.native.opencode.registrationFile;
  const claudeBin = process.env.NATIVE_CLAUDE_BIN ?? ambient.config.native.claude.executable;
  const configPath = join(root, "app.config.json");
  writeFileSync(configPath, `${JSON.stringify({ format: "sane-app-config", version: 1, dataDir, defaultExecutionCwd: repoDir,
    server: { host: "127.0.0.1", port: 0, publicOrigin: null, allowRemote: false }, maxConcurrentRuns,
    native: { claude: { executable: claudeBin, profileRoot: ccProfile }, opencode: { mode: "managed", registrationFile: ocRegistration } } }, null, 2)}\n`);
  const resolved = resolveAppConfig(["--config", configPath], { packageDir: PKG_DIR, invocationCwd: repoDir });
  const options = { ...runtimeOptions(resolved), maxConcurrentRuns };
  const paths = validateOwnershipPaths(PKG_DIR, options.dataDir);
  const installation = acquireInstallation(paths, { phase: "setup" });
  let dataHandle: OwnershipHandle | undefined;
  try {
    dataHandle = acquireData(installation, { phase: "setup", createDataParent: true });
    initializeAppStore(paths.dataDir!, options.nativeSources);
  } finally { try { dataHandle?.release(); } finally { installation.release(); } }
  const handle = await start(options);
  const origin = handle.origin;
  const headers = appHeaders(origin);
  const reg = await api(origin, "/api/workspaces", { method: "POST", headers, body: JSON.stringify({ cwd: repoDir }) });
  const workspaceId = reg.body?.workspaceId ?? reg.body?.workspace?.workspaceId ?? reg.body?.id;
  if (reg.status !== 201 || typeof workspaceId !== "string" || !workspaceId) {
    await handle.close();
    throw new Error(`native-test: disposable workspace registration failed: ${reg.status} ${JSON.stringify(reg.body)?.slice(0, 800)}`);
  }
  const qs = new URLSearchParams({ workspaceId }).toString();
  await api(origin, `/api/workstreams/inspect?${qs}`, { headers: { origin } });
  const init = await api(origin, `/api/workstreams/init?${qs}`, { method: "POST", headers, body: "{}" });
  if (init.status !== 200 && init.status !== 201) {
    await handle.close();
    throw new Error(`native-test: workstream init failed: ${init.status} ${JSON.stringify(init.body)?.slice(0, 800)}`);
  }
  const created = await api(origin, `/api/workstreams?${qs}`, { method: "POST", headers,
    body: JSON.stringify({ id: workstreamId, title: `integration  disposable`, type: "feature", defaultCheckout: repoDir }) });
  if (created.status !== 200 && created.status !== 201) {
    await handle.close();
    throw new Error(`native-test: workstream create failed: ${created.status} ${JSON.stringify(created.body)?.slice(0, 800)}`);
  }
  record({ kind: "app-boot", tag, originHost: "127.0.0.1", workstreamId, maxConcurrentRuns });
  return { origin, dataDir, repoDir, workspaceId, workstreamId, ccProfile, ocRegistration, claudeBin, root,
    close: () => handle.close() };
}

async function admissionOf(app: TestApp, sessionId: string): Promise<any> {
  const res = await api(app.origin, "/api/sessions", { headers: { origin: app.origin } });
  const found = (res.body?.sessions as any[])?.find((s) => s?.sessionId === sessionId);
  if (!found?.admission) throw new Error(`native-test: no durable admission for ${sessionId}: ${JSON.stringify(res.body)?.slice(0, 500)}`);
  return found.admission;
}
function senderRef(admission: any): { authorityId: string; nativeId: string; harness: "oc" | "cc" } {
  const harness = admission?.source?.descriptor?.harness;
  if ((harness !== "oc" && harness !== "cc") || typeof admission?.source?.authorityId !== "string" || typeof admission?.nativeId !== "string") {
    throw new Error(`native-test: admission lacks qualified native identity: ${JSON.stringify(admission)?.slice(0, 500)}`);
  }
  return { authorityId: admission.source.authorityId, nativeId: admission.nativeId, harness };
}
async function managePhase(app: TestApp, operation: "associate" | "phase/assign" | "phase/end", body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const qs = new URLSearchParams({ workspaceId: app.workspaceId }).toString();
  return api(app.origin, `/api/workstreams/${operation}?${qs}`, { method: "POST", headers: appHeaders(app.origin), body: JSON.stringify(body) });
}
async function associate(app: TestApp, sessionId: string): Promise<void> {
  const res = await managePhase(app, "associate", { sessionId, workstreamId: app.workstreamId });
  if (res.status !== 200) throw new Error(`native-test: associate failed: ${res.status} ${JSON.stringify(res.body)?.slice(0, 500)}`);
}
async function assignPhase(app: TestApp, sessionId: string, phase: string): Promise<void> {
  const res = await managePhase(app, "phase/assign", { sessionId, phase });
  if (res.status !== 200) throw new Error(`native-test: phase/assign failed: ${res.status} ${JSON.stringify(res.body)?.slice(0, 500)}`);
}

function markerPrompt(marker: string, opts: { slowSeconds?: number; pinPermission?: boolean } = {}): string {
  const steps = [`print exactly ${marker} on its own line`];
  if (opts.slowSeconds) steps.unshift(`run the shell command \`sleep ${opts.slowSeconds}\` to completion`);
  if (opts.pinPermission) steps.unshift("request permission to run the sleep command and wait for the decision");
  return [`integration marker task ${marker}.`, `Do exactly the following steps in order: ${steps.join("; ")}.`,
    "Execute only these commands, do not deviate, do not approve anything, do not send any handoff.",
    `End your turn immediately after reporting the marker (at most ${MAX_TURNS_PER_HANDOFF} agent turns).`].join("\n");
}

async function startSession(app: TestApp, opts: { prompt: string; harness: "opencode" | "claude-code"; model?: string; effort?: string; sessionId?: string; label: string }): Promise<{ sessionId: string; runId: string }> {
  chargeTurns(1, opts.label);
  const res = await api(app.origin, "/api/sessions", { method: "POST", headers: appHeaders(app.origin),
    body: JSON.stringify({ prompt: opts.prompt, harness: opts.harness, cwd: app.repoDir,
      ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }) });
  if (res.status !== 202 || typeof res.body?.sessionId !== "string" || typeof res.body?.runId !== "string") {
    throw new Error(`native-test: session start refused (${opts.label}): ${res.status} ${JSON.stringify(res.body)?.slice(0, 800)}`);
  }
  record({ kind: "session-start", label: opts.label, harness: opts.harness, model: opts.model ?? null, sessionId: res.body.sessionId, runId: res.body.runId });
  return { sessionId: res.body.sessionId as string, runId: res.body.runId as string };
}
async function runsOf(app: TestApp, sessionId: string): Promise<any[]> {
  const res = await api(app.origin, `/api/sessions/${encodeURIComponent(sessionId)}/runs`, { headers: { origin: app.origin } });
  if (!Array.isArray(res.body?.runs)) throw new Error(`native-test: runs unavailable for ${sessionId}: ${res.status}`);
  return res.body.runs;
}
async function awaitRun(app: TestApp, sessionId: string, runId: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = (await runsOf(app, sessionId)).find((r) => r?.runId === runId) ?? null;
    if (last && last.status !== "running") return last;
    await Bun.sleep(5000);
  }
  throw new Error(`native-test: run ${runId} did not settle: ${JSON.stringify(last)?.slice(0, 500)}`);
}
async function runEvents(app: TestApp, runId: string): Promise<any[]> {
  const res = await api(app.origin, `/api/runs/${encodeURIComponent(runId)}/events?after=0`, { headers: { origin: app.origin } });
  if (!Array.isArray(res.body?.events)) throw new Error(`native-test: events unavailable for ${runId}: ${res.status}`);
  return res.body.events;
}
async function enqueueHandoff(app: TestApp, sender: { authorityId: string; nativeId: string; harness: "oc" | "cc" }, input: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const record = JSON.parse(readFileSync(join(app.dataDir, "native-handoff.json"), "utf8")) as { url?: unknown; token?: unknown };
  if (typeof record.url !== "string" || typeof record.token !== "string" || !record.url || !record.token) {
    throw new Error("native-test: native handoff record missing url/token; bridge did not publish its native endpoint");
  }
  const caller = { version: 1, repository: app.repoDir,
    source: sender.harness === "oc"
      ? { version: 1, harness: "oc", kind: "local-registration", registrationFile: app.ocRegistration }
      : { version: 1, harness: "cc", kind: "local-profile", profileRoot: app.ccProfile },
    authorityId: sender.authorityId, nativeId: sender.nativeId };
  return api("", record.url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${record.token}` },
    body: JSON.stringify({ operation: "enqueue", caller, input }) });
}
async function listHandoffs(app: TestApp): Promise<any[]> {
  const qs = new URLSearchParams({ workspaceId: app.workspaceId }).toString();
  const res = await api(app.origin, `/api/handoffs?${qs}`, { headers: { origin: app.origin } });
  if (!Array.isArray(res.body?.handoffs)) throw new Error(`native-test: handoff list unavailable: ${res.status}`);
  return res.body.handoffs;
}
function handoffById(list: any[], id: string): any {
  const h = list.find((x) => x?.id === id);
  if (!h) throw new Error(`native-test: handoff ${id} absent from durable domain list`);
  return h;
}
async function awaitHandoff(app: TestApp, id: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = handoffById(await listHandoffs(app), id);
    if (last.status === "completed" || last.status === "failed") return last;
    await Bun.sleep(5000);
  }
  throw new Error(`native-test: handoff ${id} did not settle: ${JSON.stringify(last)?.slice(0, 500)}`);
}
async function chargeOnDelivery(app: TestApp, handoffId: string, recipientSessionId: string, label: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = handoffById(await listHandoffs(app), handoffId);
    const runId = h?.runId ?? h?.run_id;
    if (typeof runId === "string" && runId) {
      if ((h.status === "acceptance_unknown" || h.status === "accepted" || h.status === "running") || h.status === "completed") {
        chargeTurns(1, label);
        record({ kind: "delivery-start", label, handoffId, runId, recipientSessionId, status: h.status });
        return runId;
      }
    }
    if (h.status === "failed") throw new Error(`native-test: handoff ${handoffId} failed before delivery: ${JSON.stringify(h)?.slice(0, 500)}`);
    await Bun.sleep(2000);
  }
  throw new Error(`native-test: handoff ${handoffId} never reached native delivery`);
}
function assertNoImplicitApproval(domain: any[], recipientNativeId: string, handoffId: string): void {
  const replies = domain.filter((h) => h?.sender?.nativeId === recipientNativeId);
  if (replies.length > 0) {
    throw new Error(`native-test: recipient reply handoff implies unrequested follow-up work (${handoffId}): ${JSON.stringify(replies[0])?.slice(0, 300)}`);
  }
}

let app: TestApp | undefined;
function mustApp(): TestApp {
  if (!app) throw new Error("native-test: disposable App is not booted (t00 must run first)");
  return mustAppRef();
}
function mustAppRef(): TestApp {
  if (!app) throw new Error("native-test: disposable App is not booted (t00 must run first)");
  return app;
}
let sOc = "";
let rOcOc = "";
let rOcOcRun1 = "";
let hQueueId = "";
let reqQueue = "";
let queueInput: Record<string, unknown> = {};
let cSess = "";
let hOverlapId = "";
let sCc = "";
const CC_REASON = "no available CC native source in ambient config (SANE_TEST CC profile unavailable)";

describe.serial("native handoff: baseline, targeting/idempotency, scheduling/cancellation", () => {
  let seen = 0;
  beforeEach(async () => {
    if (seen++ > 0 && INTER_TEST_DELAY_MS > 0) await Bun.sleep(INTER_TEST_DELAY_MS);
  }, INTER_TEST_DELAY_MS + 30000);
  afterAll(async () => {
    const root = app?.root;
    try {
      const dir = process.env.NATIVE_EVIDENCE_DIR ?? (root ? join(root, "evidence") : null);
      if (dir) {
        const { mkdirSync: mkdir } = await import("node:fs");
        mkdir(dir, { recursive: true });
        writeFileSync(join(dir, "native-handoff.json"), `${JSON.stringify({ turns: chargedTurns, budget: TURN_BUDGET, evidence }, null, 2)}\n`);
      }
    } finally {
      try { await app?.close(); } catch { /* close failure is evidence, not cleanup */ }
      app = undefined;
      if (process.env.NATIVE_KEEP_FIXTURES !== "1" && root) {
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }, QUICK_TIMEOUT_MS);

  test("t00 boot disposable App, workstream, and verify installed OC model catalog", async () => {
    const wsId = `itest-handoff-${randomUUID().slice(0, 8)}`;
    app = await bootApp("handoff", 2, wsId);
    const a = mustAppRef();
    const models = await api(a.origin, `/api/harnesses/opencode/models?cwd=${encodeURIComponent(a.repoDir)}`, { headers: { origin: a.origin } });
    const ids = Array.isArray(models.body?.models) ? (models.body.models as any[]).map((m) => m?.id).filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) {
      // The disposable-cwd catalog endpoint is informational and returns [] here;
      // t01 session-start acceptance with the default model is the real gate.
      resolvedOcModel = OC_MODEL;
      record({ kind: "model-catalog", ocModel: OC_MODEL, ocResolvedModel: resolvedOcModel, ocCatalogHit: false, ocCatalogEmpty: true, ccModel: CC_ENV_MODEL || null, ccStaticAvailable: CC_STATIC_AVAILABLE });
    } else {
      const resolved = ids.includes(OC_MODEL) ? OC_MODEL : (ids.find((id) => id.endsWith("muse-spark-1.3-contributor")) ?? ids.find((id) => id.includes("muse-spark-1.3-contributor")));
      if (!resolved) {
        throw new Error(`native-test: no muse-spark-1.3-contributor suffix match in OC catalog: ${JSON.stringify(ids.slice(0, 50))}`);
      }
      resolvedOcModel = resolved;
      record({ kind: "model-catalog", ocModel: OC_MODEL, ocResolvedModel: resolvedOcModel, ocCatalogHit: true, ocCatalogEmpty: false, ccModel: CC_ENV_MODEL || null, ccStaticAvailable: CC_STATIC_AVAILABLE });
    }
    expect(typeof resolvedOcModel).toBe("string");
  }, BOOT_TIMEOUT_MS);

  test("t01 OC sender session executes a real marker turn", async () => {
    const a = mustApp();
    const started = await startSession(a, { prompt: markerPrompt("SENDER-OC-OK"), harness: "opencode", model: resolvedOcModel, effort: OC_VARIANT, label: "t01-oc-sender" });
    sOc = started.sessionId;
    const run = await awaitRun(a, sOc, started.runId, HANDOFF_TIMEOUT_MS);
    expect(run.status).toBe("completed");
    expect(JSON.stringify(await runEvents(a, started.runId))).toContain("SENDER-OC-OK");
    await associate(a, sOc);
    await assignPhase(a, sOc, "execution");
    record({ kind: "sender-ready", sessionId: sOc });
  }, HANDOFF_TIMEOUT_MS);

  test("t02 OC→OC slow baseline dispatches to a new recipient", async () => {
    const a = mustApp();
    const sender = senderRef(await admissionOf(a, sOc));
    const requestId = `itest-oc-oc-${randomUUID()}`;
    const res = await enqueueHandoff(a, sender, { requestId, to: "engineering", message: markerPrompt("HANDOFF-OC-OC-OK", { slowSeconds: 420, pinPermission: true }), createNew: true, harness: "oc", checkout: a.repoDir });
    expect(res.status).toBe(202);
    const h = res.body?.handoff;
    expect(typeof h?.id).toBe("string");
    rOcOc = h?.recipientSessionId;
    expect(typeof rOcOc).toBe("string");
    rOcOcRun1 = await chargeOnDelivery(a, h.id, rOcOc, "t02-oc-oc-delivery", 180000);
    // The recipient runs `sleep 240`, so it stays running past any bounded
    // awaitRun (which only returns on a non-running status). Poll until the run
    // is accepted (running with a nativeCommandId) and leave it running: t03
    // needs this recipient busy.
    const acceptDeadline = Date.now() + 120000;
    let run: any = null;
    while (Date.now() < acceptDeadline) {
      run = (await runsOf(a, rOcOc)).find((r) => r?.runId === rOcOcRun1) ?? null;
      if (run?.status === "running" && typeof run?.nativeCommandId === "string" && run.nativeCommandId) break;
      await Bun.sleep(5000);
    }
    expect(run?.status).toBe("running");
    expect(typeof run?.nativeCommandId).toBe("string");
    const events = await runEvents(a, rOcOcRun1);
    expect(JSON.stringify(events)).toContain("do not approve anything");
    record({ kind: "handoff", direction: "OC→OC", requestId, handoffId: h.id, recipient: rOcOc, runId: rOcOcRun1 });
  }, HANDOFF_TIMEOUT_MS);

  test("t03 busy recipient queues, same-conversation input is refused, unique target auto-resolves", async () => {
    const a = mustApp();
    const sender = senderRef(await admissionOf(a, sOc));
    reqQueue = `itest-oc-oc-reply-${randomUUID()}`;
    queueInput = { requestId: reqQueue, to: "engineering", message: markerPrompt("HANDOFF-OC-OC-REPLY-OK") };
    const res = await enqueueHandoff(a, sender, queueInput);
    expect(res.status).toBe(202);
    hQueueId = res.body?.handoff?.id;
    expect(typeof hQueueId).toBe("string");
    expect(res.body?.handoff?.recipientSessionId).toBe(rOcOc);
    const queued = handoffById(await listHandoffs(a), hQueueId);
    expect(queued.status).toBe("queued");
    const clash = await api(a.origin, "/api/sessions", { method: "POST", headers: appHeaders(a.origin),
      body: JSON.stringify({ sessionId: rOcOc, prompt: "probe", harness: "opencode" }) });
    expect(clash.status).toBe(409);
    // Same-conversation exclusion surfaces as 409 with either refusal code:
    // "conversation-busy" (active run/admission) or "handoff-pending" (active
    // or uncertain handoff reservation). Both preserve the exclusion contract.
    expect(["conversation-busy", "handoff-pending"]).toContain(clash.body?.code);
    record({ kind: "busy-queue", handoffId: hQueueId, recipient: rOcOc, exclusionCode: clash.body?.code ?? null });
  }, QUICK_TIMEOUT_MS);

  test("t04 overlap delivery starts while sender-side recipient is busy; capacity refuses; cancel one while sibling runs", async () => {
    const a = mustApp();
    const sender = senderRef(await admissionOf(a, sOc));
    const useCc = CC_STATIC_AVAILABLE;
    const marker = useCc ? "HANDOFF-OC-CC-OK" : "HANDOFF-OC-OC2-OK";
    const requestId = `itest-overlap-${randomUUID()}`;
    const res = await enqueueHandoff(a, sender, { requestId, to: "planning", message: markerPrompt(marker, { slowSeconds: 120, pinPermission: true }),
      createNew: true, harness: useCc ? "cc" : "oc", ...(useCc ? {} : { checkout: a.repoDir }) });
    expect(res.status).toBe(202);
    hOverlapId = res.body?.handoff?.id;
    cSess = res.body?.handoff?.recipientSessionId;
    expect(typeof cSess).toBe("string");
    const cRun = await chargeOnDelivery(a, hOverlapId, cSess, "t04-overlap-delivery", 180000);
    const cRunning = await runsOf(a, cSess);
    expect(cRunning.find((r) => r?.runId === cRun)?.status).toBe("running");
    const rRuns = await runsOf(a, rOcOc);
    expect(rRuns.find((r) => r?.runId === rOcOcRun1)?.status).toBe("running");
    record({ kind: "overlap", overlapRecipient: cSess, overlapRun: cRun, busyRecipient: rOcOc, busyRun: rOcOcRun1 });
    const deadline = Date.now() + 60000;
    let saturated = false;
    while (Date.now() < deadline) {
      const sessions = await api(a.origin, "/api/sessions", { headers: { origin: a.origin } });
      if (sessions.body?.availability?.canSend === false) { saturated = true; break; }
      await Bun.sleep(2000);
    }
    expect(saturated).toBe(true);
    const probe = await api(a.origin, "/api/sessions", { method: "POST", headers: appHeaders(a.origin),
      body: JSON.stringify({ prompt: "capacity probe", harness: "opencode", cwd: a.repoDir }) });
    expect(probe.status).toBe(429);
    expect(JSON.stringify(probe.body)).toContain("capacity");
    const cancel = await api(a.origin, `/api/sessions/${encodeURIComponent(rOcOc)}/cancel`, { method: "POST", headers: appHeaders(a.origin), body: "{}" });
    expect(cancel.body?.interrupted).toBe(true);
    const interrupted = await awaitRun(a, rOcOc, rOcOcRun1, 120000);
    expect(interrupted.status).toBe("interrupted");
    const cStill = (await runsOf(a, cSess)).find((r) => r?.runId === cRun);
    expect(cStill?.status).toBe("running");
    record({ kind: "cancel-sibling", cancelledRun: rOcOcRun1, siblingRun: cRun });
  }, HANDOFF_TIMEOUT_MS);

  test("t05 queued delivery runs after the recipient frees, with no overlapping turns", async () => {
    const a = mustApp();
    const runId = await chargeOnDelivery(a, hQueueId, rOcOc, "t05-queued-delivery", 300000);
    const run = await awaitRun(a, rOcOc, runId, HANDOFF_TIMEOUT_MS);
    expect(run.status).toBe("completed");
    expect(JSON.stringify(await runEvents(a, runId))).toContain("HANDOFF-OC-OC-REPLY-OK");
    const settled = await awaitHandoff(a, hQueueId, 60000);
    expect(settled.status).toBe("completed");
    const runs = await runsOf(a, rOcOc);
    const first = runs.find((r) => r?.runId === rOcOcRun1);
    const second = runs.find((r) => r?.runId === runId);
    expect(typeof first?.endedAt).toBe("string");
    expect(typeof second?.createdAt).toBe("string");
    expect((second.createdAt as string) >= (first.endedAt as string)).toBe(true);
    assertNoImplicitApproval(await listHandoffs(a), senderRef(await admissionOf(a, rOcOc)).nativeId, hQueueId);
    record({ kind: "handoff", direction: "OC→OC-existing", handoffId: hQueueId, runId });
  }, HANDOFF_TIMEOUT_MS);

  test("t06 overlap recipient completes with its marker", async () => {
    const a = mustApp();
    const h = handoffById(await listHandoffs(a), hOverlapId);
    const runId = h?.runId ?? h?.run_id;
    expect(typeof runId).toBe("string");
    const run = await awaitRun(a, cSess, runId, HANDOFF_TIMEOUT_MS);
    expect(run.status).toBe("completed");
    const marker = CC_STATIC_AVAILABLE ? "HANDOFF-OC-CC-OK" : "HANDOFF-OC-OC2-OK";
    expect(JSON.stringify(await runEvents(a, runId))).toContain(marker);
    const settled = await awaitHandoff(a, hOverlapId, 60000);
    expect(settled.status).toBe("completed");
    record({ kind: "handoff", direction: CC_STATIC_AVAILABLE ? "OC→CC" : "OC→OC", handoffId: hOverlapId, runId });
  }, HANDOFF_TIMEOUT_MS);

  test("t07 ambiguous target is refused and launches nothing", async () => {
    const a = mustApp();
    await assignPhase(a, cSess, "engineering");
    const runsBefore = (await runsOf(a, rOcOc)).length + (await runsOf(a, cSess)).length;
    const sender = senderRef(await admissionOf(a, sOc));
    const res = await enqueueHandoff(a, sender, { requestId: `itest-ambiguous-${randomUUID()}`, to: "engineering", message: markerPrompt("HANDOFF-AMBIG-PROBE") });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("AMBIGUOUS");
    const runsAfter = (await runsOf(a, rOcOc)).length + (await runsOf(a, cSess)).length;
    expect(runsAfter).toBe(runsBefore);
    try {
      const status = await api(a.origin, `/api/workstreams/status?${new URLSearchParams({ workspaceId: a.workspaceId, id: a.workstreamId }).toString()}`, { headers: { origin: a.origin } });
      const assignmentId = JSON.stringify(status.body).includes(rOcOc) ? undefined : undefined;
      if (assignmentId) await managePhase(a, "phase/end", { sessionId: rOcOc, assignmentId });
    } catch { /* best-effort cleanup only */ }
    record({ kind: "ambiguity-refusal", runsBefore, runsAfter });
  }, QUICK_TIMEOUT_MS);

  ccTest(`t08 CC sender session ${CC_STATIC_AVAILABLE ? "executes a real marker turn" : "(skipped: " + CC_REASON + ")"}`, async () => {
    const a = mustApp();
    const resolved = resolveCcModel(a);
    const started = await startSession(a, { prompt: markerPrompt("HANDOFF-CC-SENDER-OK"), harness: "claude-code", model: resolved.id, label: "t08-cc-sender" });
    sCc = started.sessionId;
    const run = await awaitRun(a, sCc, started.runId, HANDOFF_TIMEOUT_MS);
    expect(run.status).toBe("completed");
    expect(JSON.stringify(await runEvents(a, started.runId))).toContain("HANDOFF-CC-SENDER-OK");
    await associate(a, sCc);
    await assignPhase(a, sCc, "execution");
    record({ kind: "sender-ready", sessionId: sCc, ccModel: resolved.id ?? null, ccModelSource: resolved.source });
  }, HANDOFF_TIMEOUT_MS);

  ccTest(`t09 CC→OC baseline delivery ${CC_STATIC_AVAILABLE ? "completes with its marker" : "(skipped: " + CC_REASON + ")"}`, async () => {
    const a = mustApp();
    const sender = senderRef(await admissionOf(a, sCc));
    const requestId = `itest-cc-oc-${randomUUID()}`;
    const res = await enqueueHandoff(a, sender, { requestId, to: "planning", message: markerPrompt("HANDOFF-CC-OC-OK"), createNew: true, harness: "oc", checkout: a.repoDir });
    if (res.status !== 202) throw new Error(`native-test: CC→OC enqueue refused: ${res.status} ${JSON.stringify(res.body)?.slice(0, 800)}`);
    expect(res.status).toBe(202);
    const h = res.body?.handoff;
    const runId = await chargeOnDelivery(a, h.id, h?.recipientSessionId, "t09-cc-oc-delivery", 180000);
    const run = await awaitRun(a, h.recipientSessionId, runId, HANDOFF_TIMEOUT_MS);
    expect(run.status).toBe("completed");
    expect(JSON.stringify(await runEvents(a, runId))).toContain("HANDOFF-CC-OC-OK");
    expect((await awaitHandoff(a, h.id, 60000)).status).toBe("completed");
    record({ kind: "handoff", direction: "CC→OC", requestId, handoffId: h.id, runId });
  }, HANDOFF_TIMEOUT_MS);

  ccTest(`t10 CC→CC baseline delivery ${CC_STATIC_AVAILABLE ? "completes with its marker" : "(skipped: " + CC_REASON + ")"}`, async () => {
    const a = mustApp();
    const sender = senderRef(await admissionOf(a, sCc));
    const requestId = `itest-cc-cc-${randomUUID()}`;
    const res = await enqueueHandoff(a, sender, { requestId, to: "research", message: markerPrompt("HANDOFF-CC-CC-OK"), createNew: true, harness: "cc" });
    if (res.status !== 202) throw new Error(`native-test: CC→CC enqueue refused: ${res.status} ${JSON.stringify(res.body)?.slice(0, 800)}`);
    expect(res.status).toBe(202);
    const h = res.body?.handoff;
    const runId = await chargeOnDelivery(a, h.id, h?.recipientSessionId, "t10-cc-cc-delivery", 180000);
    const run = await awaitRun(a, h.recipientSessionId, runId, HANDOFF_TIMEOUT_MS);
    expect(run.status).toBe("completed");
    expect(JSON.stringify(await runEvents(a, runId))).toContain("HANDOFF-CC-CC-OK");
    expect((await awaitHandoff(a, h.id, 60000)).status).toBe("completed");
    record({ kind: "handoff", direction: "CC→CC", requestId, handoffId: h.id, runId });
  }, HANDOFF_TIMEOUT_MS);

  test("t11 duplicate request reuses delivery without a new turn; changed payload is refused", async () => {
    const a = mustApp();
    const sender = senderRef(await admissionOf(a, sOc));
    const runsBefore = (await runsOf(a, rOcOc)).length;
    const eventsBefore = (await runEvents(a, (await runsOf(a, rOcOc)).find((r) => r?.status === "completed" && r?.runId !== rOcOcRun1)?.runId ?? "")).length;
    const dup = await enqueueHandoff(a, sender, queueInput);
    expect(dup.status).toBe(202);
    expect(dup.body?.handoff?.id).toBe(hQueueId);
    expect((await runsOf(a, rOcOc)).length).toBe(runsBefore);
    const changed = await enqueueHandoff(a, sender, { ...queueInput, message: `${queueInput.message}\naltered payload` });
    expect(changed.status).toBe(409);
    expect(JSON.stringify(changed.body)).toContain("CONFLICT");
    record({ kind: "idempotency", handoffId: hQueueId, runsBefore, eventsBefore });
  }, QUICK_TIMEOUT_MS);
});

function resolveCcModel(a: TestApp): { id?: string; source: string } {
  if (!CC_STATIC_AVAILABLE) throw new Error(`native-test: CC direction unsupported (${CC_REASON})`);
  if (CC_ENV_MODEL) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(CC_ENV_MODEL) || CC_ENV_MODEL.length > 200) {
      throw new Error(`native-test: CC model ID unavailable: ${JSON.stringify(CC_ENV_MODEL)}`);
    }
    record({ kind: "cc-model", id: CC_ENV_MODEL, source: "env:NATIVE_CC_MODEL", repo: a.repoDir });
    return { id: CC_ENV_MODEL, source: "env:NATIVE_CC_MODEL" };
  }
  // No explicit model: omit --model and let the installed CLI use its default.
  // The previous default (anthropic/claude-sonnet-5) is rejected by this
  // environment's Claude Code ("may not exist or you may not have access").
  record({ kind: "cc-model", id: null, source: "default:omitted (installed CLI default; anthropic/claude-sonnet-5 rejected)", repo: a.repoDir });
  return { id: undefined, source: "default-omitted" };
}
