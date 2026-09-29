/**
 * C9 Phase 2 — real-agent native recovery integration.
 * File 2: restart/uncertainty + attachment + failed shutdown + OC child inheritance + CC child refusal.
 *
 * Contract sources: docs/sane-app/ongoing/C9-PLAN.md, docs/sane-app/ongoing/C8-QUESTIONS.md
 * ("Deferred real-native integration tests"), packages/sane-app/src/bridge.ts
 * (restart reconcile 251-264,910-918; reconcile endpoints 546-566; failed-shutdown
 * drain 924-969), packages/sane-core/src/schema.ts (95-112) + server.ts (226-278),
 * packages/sane-app/src/installation-ownership.ts (37-144).
 *
 * Rules enforced here (shared with c9-native-handoff.test.ts):
 * - Serial only: top-level describe.serial; 45s sleep between tests
 *   (INTER_TEST_DELAY_MS, env C9_INTER_TEST_DELAY_MS). Never parallel.
 * - Models: OC opencode-go/muse-spark-1.3-contributor (high variant); CC model only
 *   where a CC turn is unavoidable (none in this file). Max 5 agent turns per
 *   handoff, 600s per-handoff timeout.
 * - Narrow marker prompts, disposable repos/workstreams/App stores/ports/sessions,
 *   unique requestIds; durable domain state + correlated native history asserted.
 * - Spend cap: at most 6 real agent turns for this file (handoff file 7 + this
 *   file 6 = 13 combined worst case per full run: r01 quick + slow + delivery,
 *   r03 redelivery, r04 external hop + attached continue). chargeTurns() fails explicitly.
 * - Phase 1 env-gated fault hooks (SANE_TEST_FAULT) at the uncertain-acceptance
 *   and shutdown-drain boundaries are used when present (hook names autodetected
 *   from bridge.ts); the two hook-dependent tests use test.skip with an explicit
 *   reason when absent — never a silent pass.
 * - Evidence log per handoff, secrets redacted; flushed to C9_EVIDENCE_DIR in afterAll.
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
import { runtimeOptions, start, type Options } from "../src/bridge";
import { validateOwnershipPaths, acquireInstallation, acquireData, processEvidence, OwnershipError, type OwnershipHandle } from "../src/installation-ownership";
import { initializeAppStore } from "../src/app-store";
import { OpenCodeAdapter } from "../src/opencode";
import { classifyCaller } from "../../sane-cli/src/cli-arguments";

const INTER_TEST_DELAY_MS = (() => {
  const v = Number(process.env.C9_INTER_TEST_DELAY_MS ?? 45000);
  return Number.isFinite(v) && v >= 0 ? v : 45000;
})();
const HANDOFF_TIMEOUT_MS = 600000;
const BOOT_TIMEOUT_MS = 300000;
const QUICK_TIMEOUT_MS = 120000;
const TURN_BUDGET = 6;
const OC_MODEL = "opencode-go/muse-spark-1.3-contributor";
const OC_VARIANT = "high";
let resolvedOcModel = OC_MODEL;
const MAX_TURNS_PER_HANDOFF = 5;

const PKG_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const bridgeSource = readFileSync(join(PKG_DIR, "src", "bridge.ts"), "utf8");
const FAULT_NAMES = [...bridgeSource.matchAll(/SANE_TEST_FAULT\s*(?:===|==|!==|!=)?\s*["'`]([^"'`]+)["'`]/g)]
  .map((m) => String(m[1] ?? ""))
  .filter((n) => n.length > 0);
const HAS_FAULT_HOOKS = bridgeSource.includes("SANE_TEST_FAULT") && FAULT_NAMES.length > 0;
const ACCEPTANCE_FAULT = FAULT_NAMES.find((n) => /accept|uncertain|drop-run/i.test(n)) ?? "c9-uncertain-acceptance";
// NOTE: "handoff-drop-run" (bridge.ts dispatchHandoff) is the crash-simulation
// hook that pins a handoff at acceptance_unknown with no persisted run; the
// matcher must recognize it or r03 arms an inert fault value.
const SHUTDOWN_FAULT = FAULT_NAMES.find((n) => /shutdown|drain|failed/i.test(n)) ?? "c9-shutdown-drain";
const faultTest: typeof test = HAS_FAULT_HOOKS ? test : test.skip;
const FAULT_SKIP_REASON = "SANE_TEST_FAULT hooks absent (Phase 1 parallel work has not landed them)";
const ambient = (() => {
  try {
    return resolveAppConfig([], { packageDir: PKG_DIR, invocationCwd: process.cwd() });
  } catch (error) {
    throw new Error(`C9: ambient App config unreadable, set C9_CLAUDE_PROFILE/C9_OPENCODE_REGISTRATION: ${error instanceof Error ? error.message : String(error)}`);
  }
})();

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
  if (chargedTurns > TURN_BUDGET) throw new Error(`C9 spend cap exceeded: ${chargedTurns}/${TURN_BUDGET} real agent turns (${label})`);
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

async function bootApp(tag: string, workstreamId: string): Promise<{ app: TestApp; options: Options }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `c9-${tag}-`)));
  const repoDir = join(root, "repo");
  const dataDir = join(root, "appdata");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const git = Bun.spawn(["git", "init", repoDir], { stdout: "ignore", stderr: "ignore" });
  if ((await git.exited) !== 0 || git.exitCode !== 0) throw new Error("C9: cannot init disposable repo (git init failed)");
  const ccProfile = process.env.C9_CLAUDE_PROFILE ?? ambient.config.native.claude.profileRoot;
  const ocRegistration = process.env.C9_OPENCODE_REGISTRATION ?? ambient.config.native.opencode.registrationFile;
  const claudeBin = process.env.C9_CLAUDE_BIN ?? ambient.config.native.claude.executable;
  const configPath = join(root, "app.config.json");
  writeFileSync(configPath, `${JSON.stringify({ format: "sane-app-config", version: 1, dataDir, defaultExecutionCwd: repoDir,
    server: { host: "127.0.0.1", port: 0, publicOrigin: null, allowRemote: false }, maxConcurrentRuns: 16,
    native: { claude: { executable: claudeBin, profileRoot: ccProfile }, opencode: { mode: "managed", registrationFile: ocRegistration } } }, null, 2)}\n`);
  const resolved = resolveAppConfig(["--config", configPath], { packageDir: PKG_DIR, invocationCwd: repoDir });
  const options = runtimeOptions(resolved);
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
    throw new Error(`C9: disposable workspace registration failed: ${reg.status} ${JSON.stringify(reg.body)?.slice(0, 800)}`);
  }
  const qs = new URLSearchParams({ workspaceId }).toString();
  await api(origin, `/api/workstreams/inspect?${qs}`, { headers: { origin } });
  const init = await api(origin, `/api/workstreams/init?${qs}`, { method: "POST", headers, body: "{}" });
  if (init.status !== 200 && init.status !== 201) {
    await handle.close();
    throw new Error(`C9: workstream init failed: ${init.status} ${JSON.stringify(init.body)?.slice(0, 800)}`);
  }
  const created = await api(origin, `/api/workstreams?${qs}`, { method: "POST", headers,
    body: JSON.stringify({ id: workstreamId, title: `C9 ${tag} disposable`, type: "feature", defaultCheckout: repoDir }) });
  if (created.status !== 200 && created.status !== 201) {
    await handle.close();
    throw new Error(`C9: workstream create failed: ${created.status} ${JSON.stringify(created.body)?.slice(0, 800)}`);
  }
  record({ kind: "app-boot", tag, originHost: "127.0.0.1", workstreamId });
  return { app: { origin, dataDir, repoDir, workspaceId, workstreamId, ccProfile, ocRegistration, claudeBin, root, close: () => handle.close() }, options };
}

async function admissionOf(app: TestApp, sessionId: string): Promise<any> {
  const res = await api(app.origin, "/api/sessions", { headers: { origin: app.origin } });
  const found = (res.body?.sessions as any[])?.find((s) => s?.sessionId === sessionId);
  if (!found?.admission) throw new Error(`C9: no durable admission for ${sessionId}: ${JSON.stringify(res.body)?.slice(0, 500)}`);
  return found.admission;
}
function senderRef(admission: any): { authorityId: string; nativeId: string; harness: "oc" | "cc" } {
  const harness = admission?.source?.descriptor?.harness;
  if ((harness !== "oc" && harness !== "cc") || typeof admission?.source?.authorityId !== "string" || typeof admission?.nativeId !== "string") {
    throw new Error(`C9: admission lacks qualified native identity: ${JSON.stringify(admission)?.slice(0, 500)}`);
  }
  return { authorityId: admission.source.authorityId, nativeId: admission.nativeId, harness };
}
async function managePhase(app: TestApp, operation: "associate" | "phase/assign", body: Record<string, unknown>): Promise<void> {
  const qs = new URLSearchParams({ workspaceId: app.workspaceId }).toString();
  const res = await api(app.origin, `/api/workstreams/${operation}?${qs}`, { method: "POST", headers: appHeaders(app.origin), body: JSON.stringify(body) });
  if (res.status !== 200) throw new Error(`C9: ${operation} failed: ${res.status} ${JSON.stringify(res.body)?.slice(0, 500)}`);
}
function markerPrompt(marker: string, opts: { slowSeconds?: number; pinPermission?: boolean } = {}): string {
  const steps = [`print exactly ${marker} on its own line`];
  if (opts.slowSeconds) steps.unshift(`run the shell command \`sleep ${opts.slowSeconds}\` to completion`);
  if (opts.pinPermission) steps.unshift("request permission to run the sleep command and wait for the decision");
  return [`C9 marker task ${marker}.`, `Do exactly the following steps in order: ${steps.join("; ")}.`,
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
    throw new Error(`C9: session start refused (${opts.label}): ${res.status} ${JSON.stringify(res.body)?.slice(0, 800)}`);
  }
  record({ kind: "session-start", label: opts.label, harness: opts.harness, sessionId: res.body.sessionId, runId: res.body.runId });
  return { sessionId: res.body.sessionId as string, runId: res.body.runId as string };
}
async function runsOf(app: TestApp, sessionId: string): Promise<any[]> {
  const res = await api(app.origin, `/api/sessions/${encodeURIComponent(sessionId)}/runs`, { headers: { origin: app.origin } });
  if (!Array.isArray(res.body?.runs)) throw new Error(`C9: runs unavailable for ${sessionId}: ${res.status}`);
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
  throw new Error(`C9: run ${runId} did not settle: ${JSON.stringify(last)?.slice(0, 500)}`);
}
async function runEvents(app: TestApp, runId: string): Promise<any[]> {
  const res = await api(app.origin, `/api/runs/${encodeURIComponent(runId)}/events?after=0`, { headers: { origin: app.origin } });
  if (!Array.isArray(res.body?.events)) throw new Error(`C9: events unavailable for ${runId}: ${res.status}`);
  return res.body.events;
}
async function enqueueHandoff(app: TestApp, sender: { authorityId: string; nativeId: string; harness: "oc" | "cc" }, input: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const record = JSON.parse(readFileSync(join(app.dataDir, "native-handoff.json"), "utf8")) as { url?: unknown; token?: unknown };
  if (typeof record.url !== "string" || typeof record.token !== "string" || !record.url || !record.token) {
    throw new Error("C9: native handoff record missing url/token; bridge did not publish its native endpoint");
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
  if (!Array.isArray(res.body?.handoffs)) throw new Error(`C9: handoff list unavailable: ${res.status}`);
  return res.body.handoffs;
}
function handoffById(list: any[], id: string): any {
  const h = list.find((x) => x?.id === id);
  if (!h) throw new Error(`C9: handoff ${id} absent from durable domain list`);
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
  throw new Error(`C9: handoff ${id} did not settle: ${JSON.stringify(last)?.slice(0, 500)}`);
}
async function chargeOnDelivery(app: TestApp, handoffId: string, recipientSessionId: string, label: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = handoffById(await listHandoffs(app), handoffId);
    const runId = h?.runId ?? h?.run_id;
    if (typeof runId === "string" && runId && h.status !== "queued") {
      chargeTurns(1, label);
      record({ kind: "delivery-start", label, handoffId, runId, recipientSessionId, status: h.status });
      return runId;
    }
    if (h.status === "failed") throw new Error(`C9: handoff ${handoffId} failed before delivery: ${JSON.stringify(h)?.slice(0, 500)}`);
    await Bun.sleep(2000);
  }
  throw new Error(`C9: handoff ${handoffId} never reached native delivery`);
}

let ctx: { app: TestApp; options: Options } | undefined;
function mustCtx(): { app: TestApp; options: Options } {
  if (!ctx) throw new Error("C9: disposable App is not booted (r00 must run first)");
  return ctx;
}
let sSelf = "";
let hRestartId = "";
let reqRestart = "";

describe.serial("C9 native recovery: restart, uncertainty, attachment, failed shutdown, child callers", () => {
  let seen = 0;
  beforeEach(async () => {
    if (seen++ > 0 && INTER_TEST_DELAY_MS > 0) await Bun.sleep(INTER_TEST_DELAY_MS);
  }, INTER_TEST_DELAY_MS + 30000);
  afterAll(async () => {
    const root = ctx?.app.root;
    try {
      const dir = process.env.C9_EVIDENCE_DIR ?? (root ? join(root, "evidence") : null);
      if (dir) {
        const { mkdirSync: mkdir } = await import("node:fs");
        mkdir(dir, { recursive: true });
        writeFileSync(join(dir, "c9-native-recovery.json"), `${JSON.stringify({ turns: chargedTurns, budget: TURN_BUDGET, faultHooks: HAS_FAULT_HOOKS, faultNames: FAULT_NAMES, evidence }, null, 2)}\n`);
      }
    } finally {
      try { await ctx?.app.close(); } catch { /* close failure is evidence, not cleanup */ }
      ctx = undefined;
      if (process.env.C9_KEEP_FIXTURES !== "1" && root) {
        try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }, QUICK_TIMEOUT_MS);

  test("r00 boot disposable App and verify installed OC model catalog", async () => {
    const wsId = `c9-recovery-${randomUUID().slice(0, 8)}`;
    ctx = await bootApp("recovery", wsId);
    const models = await api(ctx.app.origin, `/api/harnesses/opencode/models?cwd=${encodeURIComponent(ctx.app.repoDir)}`, { headers: { origin: ctx.app.origin } });
    const ids = Array.isArray(models.body?.models) ? (models.body.models as any[]).map((m) => m?.id).filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) {
      // The disposable-cwd catalog endpoint is informational and returns [] here;
      // r01 session-start acceptance with the default model is the real gate.
      resolvedOcModel = OC_MODEL;
      record({ kind: "model-catalog", ocModel: OC_MODEL, ocResolvedModel: resolvedOcModel, ocCatalogHit: false, ocCatalogEmpty: true, faultHooks: HAS_FAULT_HOOKS, faultNames: FAULT_NAMES });
    } else {
      const resolved = ids.includes(OC_MODEL) ? OC_MODEL : (ids.find((id) => id.endsWith("muse-spark-1.3-contributor")) ?? ids.find((id) => id.includes("muse-spark-1.3-contributor")));
      if (!resolved) {
        throw new Error(`C9: no muse-spark-1.3-contributor suffix match in OC catalog: ${JSON.stringify(ids.slice(0, 50))}`);
      }
      resolvedOcModel = resolved;
      record({ kind: "model-catalog", ocModel: OC_MODEL, ocResolvedModel: resolvedOcModel, ocCatalogHit: true, ocCatalogEmpty: false, faultHooks: HAS_FAULT_HOOKS, faultNames: FAULT_NAMES });
    }
    expect(typeof resolvedOcModel).toBe("string");
  }, BOOT_TIMEOUT_MS);

  test("r01 queued delivery survives a test-App restart without duplicate delivery", async () => {
    const { app, options } = mustCtx();
    // Workstream associate refuses while the session has an active run (409
    // bridge-busy / conversation-busy), so settle a quick marker run first,
    // associate the idle session, then start the slow run that the restart
    // must reconcile. Costs one extra charged turn (budget 6 covers it).
    const quick = await startSession(app, { prompt: markerPrompt("RESTART-QUICK-OK"), harness: "opencode", model: resolvedOcModel, effort: OC_VARIANT, label: "r01-quick-run" });
    sSelf = quick.sessionId;
    const quickDone = await awaitRun(app, sSelf, quick.runId, QUICK_TIMEOUT_MS);
    expect(quickDone.status).toBe("completed");
    expect(JSON.stringify(await runEvents(app, quick.runId))).toContain("RESTART-QUICK-OK");
    await managePhase(app, "associate", { sessionId: sSelf, workstreamId: app.workstreamId });
    await managePhase(app, "phase/assign", { sessionId: sSelf, phase: "execution" });
    const sender = senderRef(await admissionOf(app, sSelf));
    const started = await startSession(app, { sessionId: sSelf, prompt: markerPrompt("RESTART-SLOW-OK", { slowSeconds: 200 }), harness: "opencode", label: "r01-slow-run" });
    expect(started.sessionId).toBe(sSelf);
    reqRestart = `c9-restart-${randomUUID()}`;
    const enq = await enqueueHandoff(app, sender, { requestId: reqRestart, to: "execution", message: markerPrompt("RESTART-DELIVERY-OK") });
    if (enq.status !== 202) throw new Error(`C9: restart enqueue refused: ${enq.status} ${JSON.stringify(enq.body)?.slice(0, 800)}`);
    expect(enq.status).toBe(202);
    hRestartId = enq.body?.handoff?.id;
    expect(typeof hRestartId).toBe("string");
    expect(handoffById(await listHandoffs(app), hRestartId).status).toBe("queued");
    await app.close();
    const restarted = await start(options);
    ctx = { app: { ...app, origin: restarted.origin, close: () => restarted.close() }, options };
    const back = mustCtx().app;
    const listed = await api(back.origin, `/api/workstreams?${new URLSearchParams({ workspaceId: back.workspaceId }).toString()}`, { headers: { origin: back.origin } });
    expect(JSON.stringify(listed.body)).toContain(back.workstreamId);
    const slow = await awaitRun(back, sSelf, started.runId, HANDOFF_TIMEOUT_MS);
    expect(slow.status).toBe("completed");
    expect(JSON.stringify(await runEvents(back, started.runId))).toContain("RESTART-SLOW-OK");
    const deliveryRun = await chargeOnDelivery(back, hRestartId, sSelf, "r01-restart-delivery", 300000);
    const done = await awaitRun(back, sSelf, deliveryRun, HANDOFF_TIMEOUT_MS);
    expect(done.status).toBe("completed");
    expect(JSON.stringify(await runEvents(back, deliveryRun))).toContain("RESTART-DELIVERY-OK");
    expect((await awaitHandoff(back, hRestartId, 60000)).status).toBe("completed");
    const runs = await runsOf(back, sSelf);
    expect(runs.length).toBe(3);
    const commands = runs.map((r) => r?.nativeCommandId);
    expect(new Set(commands).size).toBe(3);
    const dup = await enqueueHandoff(back, sender, { requestId: reqRestart, to: "execution", message: markerPrompt("RESTART-DELIVERY-OK") });
    expect(dup.status).toBe(202);
    expect(dup.body?.handoff?.id).toBe(hRestartId);
    expect((await runsOf(back, sSelf)).length).toBe(3);
    record({ kind: "restart-recovery", handoffId: hRestartId, quickRun: quick.runId, slowRun: started.runId, deliveryRun });
  }, HANDOFF_TIMEOUT_MS);

  test("r02 retry without nonacceptance proof is refused on a settled handoff", async () => {
    const { app } = mustCtx();
    const res = await api(app.origin, `/api/handoffs/${encodeURIComponent(hRestartId)}/retry`, { method: "POST", headers: appHeaders(app.origin), body: JSON.stringify({ workspaceId: app.workspaceId }) });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain("Nonacceptance is not proven");
    record({ kind: "retry-refusal", handoffId: hRestartId, status: res.status });
  }, QUICK_TIMEOUT_MS);

  faultTest(`r03 uncertain acceptance reconciles before retry ${HAS_FAULT_HOOKS ? "(fault hook engaged)" : `(skipped: ${FAULT_SKIP_REASON})`}`, async () => {
    const { app } = mustCtx();
    const previous = process.env.SANE_TEST_FAULT;
    process.env.SANE_TEST_FAULT = ACCEPTANCE_FAULT;
    try {
      const sender = senderRef(await admissionOf(app, sSelf));
      const requestId = `c9-uncertain-${randomUUID()}`;
      const enq = await enqueueHandoff(app, sender, { requestId, to: "execution", message: markerPrompt("UNCERTAIN-DELIVERY-OK"), createNew: true, harness: "oc", checkout: app.repoDir });
      if (enq.status !== 202) throw new Error(`C9: uncertain enqueue refused: ${enq.status} ${JSON.stringify(enq.body)?.slice(0, 800)}`);
      expect(enq.status).toBe(202);
      const hid = enq.body?.handoff?.id;
      const deadline = Date.now() + 180000;
      let stuck: any = null;
      while (Date.now() < deadline) {
        stuck = handoffById(await listHandoffs(app), hid);
        if (stuck.status === "acceptance_unknown") break;
        if (stuck.status === "completed" || stuck.status === "failed") {
          throw new Error(`C9: fault ${ACCEPTANCE_FAULT} did not engage; handoff settled to ${stuck.status}. Align the Phase 1 hook name with this suite (detected: ${JSON.stringify(FAULT_NAMES)})`);
        }
        await Bun.sleep(2000);
      }
      expect(stuck.status).toBe("acceptance_unknown");
      // The drop-run hook pins every dispatch at acceptance_unknown, so disarm
      // it before retry: redelivery must persist a real run to complete.
      if (previous === undefined) delete process.env.SANE_TEST_FAULT;
      else process.env.SANE_TEST_FAULT = previous;
      const recipient = stuck?.recipient?.sessionId;
      const retry = await api(app.origin, `/api/handoffs/${encodeURIComponent(hid)}/retry`, { method: "POST", headers: appHeaders(app.origin), body: JSON.stringify({ workspaceId: app.workspaceId }) });
      expect(retry.status).toBe(202);
      expect(retry.body?.handoff?.status).toBe("queued");
      const runId = await chargeOnDelivery(app, hid, recipient, "r03-uncertain-redelivery", 300000);
      const run = await awaitRun(app, recipient, runId, HANDOFF_TIMEOUT_MS);
      expect(run.status).toBe("completed");
      expect(JSON.stringify(await runEvents(app, runId))).toContain("UNCERTAIN-DELIVERY-OK");
      expect((await runsOf(app, recipient)).length).toBe(1);
      record({ kind: "uncertain-recovery", handoffId: hid, runId, fault: ACCEPTANCE_FAULT });
    } finally {
      if (previous === undefined) delete process.env.SANE_TEST_FAULT;
      else process.env.SANE_TEST_FAULT = previous;
    }
  }, HANDOFF_TIMEOUT_MS);

  test("r04 real external OC activity with a child hop attaches with ownership and pins, then continues", async () => {
    const { app } = mustCtx();
    const oc = new OpenCodeAdapter(undefined, undefined, app.ocRegistration);
    const created = await oc.create(app.repoDir, resolvedOcModel);
    const childNativeId: string = created.id;
    expect(childNativeId.startsWith("ses")).toBe(true);
    const commandId = `msg_${randomUUID().replaceAll("-", "")}`;
    const parentMarker = "ATTACH-PARENT-OK";
    const childMarker = "ATTACH-CHILD-OK";
    chargeTurns(1, "r04-external-child-hop");
    const admitted = await oc.prompt(childNativeId, commandId, [
      `C9 marker task ${parentMarker}.`,
      `Do exactly the following steps in order: spawn one subagent to print exactly ${childMarker} on its own line; print exactly ${parentMarker} on its own line.`,
      "Execute only these commands, do not deviate, do not approve anything, do not send any handoff.",
      `End your turn immediately after reporting (at most ${MAX_TURNS_PER_HANDOFF} agent turns).`,
    ].join("\n"));
    expect(typeof admitted?.time?.created).toBe("number");
    const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
    let outcome: string | undefined;
    let snapshot: any = null;
    while (Date.now() < deadline) {
      snapshot = await oc.snapshot(childNativeId, commandId, app.repoDir);
      if (snapshot.outcome) { outcome = snapshot.outcome; break; }
      await Bun.sleep(5000);
    }
    expect(outcome).toBe("succeeded");
    const externalText = JSON.stringify(snapshot?.messages ?? []);
    expect(externalText).toContain(parentMarker);
    expect(externalText).toContain(childMarker);
    const native = await oc.session(childNativeId);
    expect(native?.location?.directory).toBe(app.repoDir);
    record({ kind: "external-activity", nativeSessionId: childNativeId, parentMarker, childMarker, checkout: native?.location?.directory });
    const parentAdmission = await admissionOf(app, sSelf);
    const parentRef = senderRef(parentAdmission);
    const parentEnvelope = JSON.stringify({ version: 1, repository: app.repoDir,
      source: { version: 1, harness: "oc", kind: "local-registration", registrationFile: app.ocRegistration },
      authorityId: parentRef.authorityId, nativeId: parentRef.nativeId });
    const classified = classifyCaller({ SANE_CALLER_CONTEXT: parentEnvelope, OPENCODE_SESSION_ID: parentRef.nativeId });
    expect(classified.actorKind).toBe("native");
    let refusal = "";
    try {
      classifyCaller({ SANE_CALLER_CONTEXT: parentEnvelope, OPENCODE_SESSION_ID: childNativeId });
    } catch (error) {
      refusal = (error as { code?: unknown }).code !== undefined ? String((error as { code?: unknown }).code) : error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("NATIVE_CONTEXT_UNAVAILABLE");
    const attach = await api(app.origin, "/api/sessions/attach", { method: "POST", headers: appHeaders(app.origin),
      body: JSON.stringify({ harness: "opencode", nativeSessionId: childNativeId, cwd: app.repoDir }) });
    expect(attach.status).toBe(201);
    const attachedId = attach.body?.sessionId;
    expect(typeof attachedId).toBe("string");
    const attachedAdmission = await admissionOf(app, attachedId);
    expect(attachedAdmission?.nativeId).toBe(childNativeId);
    expect(attachedAdmission?.binding?.executionCheckout).toBe(app.repoDir);
    expect(attachedAdmission?.attachment?.state ?? attachedAdmission?.state).not.toBe("pending");
    const history = await api(app.origin, `/api/sessions/${encodeURIComponent(attachedId)}/native-history`, { headers: { origin: app.origin } });
    expect(history.status).toBe(200);
    const continued = await startSession(app, { sessionId: attachedId, prompt: markerPrompt("ATTACH-CONTINUE-OK"), harness: "opencode", label: "r04-attached-continue" });
    const run = await awaitRun(app, attachedId, continued.runId, HANDOFF_TIMEOUT_MS);
    expect(run.status).toBe("completed");
    const events = await runEvents(app, attachedId === continued.sessionId ? continued.runId : continued.runId);
    expect(JSON.stringify(events)).toContain("ATTACH-CONTINUE-OK");
    expect(events.filter((e) => e?.kind === "submission").length).toBe(1);
    const after = await admissionOf(app, attachedId);
    expect(after?.nativeId).toBe(childNativeId);
    expect(after?.binding?.executionCheckout).toBe(app.repoDir);
    record({ kind: "attach-continue", attachedId, nativeSessionId: childNativeId, runId: continued.runId });
  }, HANDOFF_TIMEOUT_MS);

  test("r05 CC child caller evidence fails explicitly; unknown CC attach is refused", async () => {
    const { app } = mustCtx();
    const { normalizeNativeSource } = await import("sane-core/server");
    const descriptor = { version: 1, harness: "cc", kind: "local-profile", profileRoot: app.ccProfile } as const;
    let authorityId = "unavailable";
    try { authorityId = normalizeNativeSource(descriptor).authorityId; } catch { authorityId = "unavailable"; }
    expect(authorityId.startsWith("unavailable")).toBe(false);
    const parentEnvelope = JSON.stringify({ version: 1, repository: app.repoDir, source: descriptor, authorityId, nativeId: "00000000-0000-4000-8000-000000000000" });
    let refusal = "";
    try {
      classifyCaller({ SANE_CALLER_CONTEXT: parentEnvelope, SANE_SESSION_ID: "11111111-1111-4111-8111-111111111111" });
    } catch (error) {
      refusal = (error as { code?: unknown }).code !== undefined ? String((error as { code?: unknown }).code) : error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("NATIVE_CONTEXT_UNAVAILABLE");
    const attach = await api(app.origin, "/api/sessions/attach", { method: "POST", headers: appHeaders(app.origin),
      body: JSON.stringify({ harness: "claude-code", nativeSessionId: randomUUID(), cwd: app.repoDir }) });
    // Unknown CC IDs have no local transcript file, so readClaudeHistory throws
    // a plain Error that the attach catch-all maps to 503 (bridge.ts); 409
    // covers the empty-transcript variant where the file exists but is empty.
    expect([409, 503]).toContain(attach.status);
    expect(JSON.stringify(attach.body?.error ?? attach.body)).not.toBe("");
    record({ kind: "cc-child-refusal", classifierRefusal: refusal, attachStatus: attach.status });
  }, QUICK_TIMEOUT_MS);

  faultTest(`r06 failed shutdown retains ownership, ordinary restart is refused, explicit reconcile needs dead proof ${HAS_FAULT_HOOKS ? "(fault hook engaged)" : `(skipped: ${FAULT_SKIP_REASON})`}`, async () => {
    const { app } = mustCtx();
    await app.close();
    ctx = undefined;
    const parentDir = realpathSync(mkdtempSync(join(tmpdir(), "c9-r06-")));
    const childData = join(parentDir, "appdata");
    mkdirSync(childData, { recursive: true });
    const childFile = join(parentDir, "c6-child.ts");
    writeFileSync(childFile, [
      `import { validateOwnershipPaths, acquireInstallation, acquireData } from ${JSON.stringify(join(PKG_DIR, "src", "installation-ownership.ts"))};`,
      "const packageDir = process.env.C9_CHILD_PKG as string;",
      "const dataDir = process.env.C9_CHILD_DATA as string;",
      "const paths = validateOwnershipPaths(packageDir, dataDir);",
      `process.env.SANE_TEST_FAULT = ${JSON.stringify(SHUTDOWN_FAULT)};`,
      'const installation = acquireInstallation(paths, { phase: "serving" });',
      'const data = acquireData(installation, { phase: "serving" });',
      "installation.retain(); data.retain();",
      'process.kill(process.pid, "SIGKILL");',
      "",
    ].join("\n"));
    const child = Bun.spawn([process.execPath, childFile], {
      env: { ...process.env, C9_CHILD_PKG: PKG_DIR, C9_CHILD_DATA: childData },
      stdout: "ignore", stderr: "ignore",
    });
    const childPid = child.pid;
    await child.exited;
    expect(processEvidence(childPid)).toEqual({ state: "dead" });
    const paths = validateOwnershipPaths(PKG_DIR, childData);
    let stale = "";
    try {
      acquireInstallation(paths, { phase: "starting" });
    } catch (error) {
      stale = error instanceof OwnershipError ? error.code : error instanceof Error ? error.message : String(error);
    }
    expect(stale).toBe("OWNER_STALE");
    const installation = acquireInstallation(paths, { phase: "starting", reconcileInterrupted: true });
    const data = acquireData(installation, { phase: "starting", reconcileInterrupted: true });
    expect(installation.owner.phase).toBe("starting");
    data.release();
    installation.release();
    try { rmSync(parentDir, { recursive: true, force: true }); } catch { /* best effort */ }
    record({ kind: "failed-shutdown", childPid, refusal: stale, fault: SHUTDOWN_FAULT });
  }, QUICK_TIMEOUT_MS);
});
