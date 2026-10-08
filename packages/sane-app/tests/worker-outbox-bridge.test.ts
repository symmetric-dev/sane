/** Offline bridge/store integration. Run alone: owns temporary environment selectors.
 * Native HTTP responses are controlled; dispatch, persistence and recovery are real.
 */
import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { start, type Options } from "../src/bridge";
import { initializeAppStore, atomicAppRecord } from "../src/app-store";
import { acquireData, acquireInstallation, validateOwnershipPaths } from "../src/installation-ownership";
import type { Session, Run } from "../src/history";
import type { WorkerDelivery } from "../src/worker-contract";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function assets(packageDir: string) {
  const files = { "bun.lock": "", "public/index.html": "<!doctype html><html><body>offline outbox</body></html>" };
  mkdirSync(join(packageDir, "public"), { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(packageDir, name), value);
  const recipe = { version: 2, target: "browser", format: "esm", naming: "app.[ext]", minify: true, define: { "process.env.NODE_ENV": '"production"' } };
  const inputs = Object.fromEntries(Object.entries({ ...Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])), $recipe: hash(JSON.stringify(recipe)), $bun: hash(Bun.version) }).sort(([a], [b]) => a.localeCompare(b)));
  const generation = crypto.randomUUID(), dir = join(packageDir, "public/assets", generation);
  mkdirSync(dir, { recursive: true });
  const outputs = { "app.js": "// offline\n", "push-worker.js": "// offline\n" };
  for (const [name, value] of Object.entries(outputs)) writeFileSync(join(dir, name), value);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ format: "sane-app-assets", version: 1, generation, fingerprint: hash(JSON.stringify(inputs)), inputs, outputs: Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, hash(value)])) }));
  writeFileSync(join(packageDir, "public/assets/current.json"), JSON.stringify({ format: "sane-app-assets-current", version: 1, generation }));
}
async function until(label: string, check: () => unknown) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await Bun.sleep(20); }
  throw new Error(`Timed out: ${label}`);
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-outbox-bridge-")));
  const cwd = join(root, "repo"), dataDir = join(root, "data"), packageDir = join(root, "installation"), profileRoot = join(root, "claude"), registrationFile = join(root, "service.json");
  for (const dir of [cwd, profileRoot]) mkdirSync(dir);
  assets(packageDir);
  expect(Bun.spawnSync(["git", "init", "-q", cwd]).exitCode).toBe(0);
  const saved = new Map(["SANE_APP_PASSWORD", "CLAUDE_CONFIG_DIR", "OPENCODE_TOKEN"].map(k => [k, process.env[k]]));
  process.env.SANE_APP_PASSWORD = "offline-outbox"; process.env.CLAUDE_CONFIG_DIR = profileRoot; delete process.env.OPENCODE_TOKEN;
  const sessions = new Map<string, { info: any; messages: any[]; active: boolean }>();
  const submissions: any[] = [];
  const historyReads = new Map<string, number>();
  const native = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname, input = req.method === "POST" ? await req.json() as any : undefined;
    if (path === "/api/info") return Response.json({ version: "2.0.18", pid: process.pid });
    if (path === "/api/model") return Response.json({ data: [{ id: "offline", providerID: "fixture", name: "Offline", enabled: true }] });
    if (path === "/api/agent") return Response.json({ data: [{ id: "sane/assistant/engineering", model: { providerID: "fixture", id: "offline" } }] });
    if (path === "/api/session/active") return Response.json({ data: Object.fromEntries([...sessions].filter(([, s]) => s.active).map(([id]) => [id, { type: "running" }])) });
    if (path === "/api/session" && input) {
      const id = `ses_outbox_${sessions.size}`, info = { id, ...input, time: { created: Date.now(), updated: Date.now() } };
      sessions.set(id, { info, messages: [], active: false }); return Response.json({ data: info });
    }
    const m = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(path), s = m && sessions.get(m[1]!);
    if (!s) return Response.json({ error: path }, { status: 404 });
    switch (m![2]) {
      case undefined: return Response.json({ data: s.info });
      case "model": s.info.model = input.model; return Response.json({ data: s.info });
      case "inbox": case "permission": case "form": return Response.json({ data: [] });
      case "message":
        historyReads.set(m![1]!, (historyReads.get(m![1]!) ?? 0) + 1);
        return Response.json({ data: [...s.messages].reverse(), cursor: { next: null } });
      case "prompt": {
        submissions.push(input); const now = Date.now();
        s.messages.push({ id: input.id, type: "user", text: input.text, time: { created: now } });
        s.active = input.text.includes("Worker Outcome");
        if (!s.active) s.messages.push({ id: `answer_${input.id}`, type: "assistant", time: { created: now + 1, completed: now + 2 }, content: [{ type: "text", text: "seed completed" }] }, { id: `idle_${input.id}`, type: "idle", time: { created: now + 3 }, outcome: "succeeded" });
        return Response.json({ data: { id: input.id, time: { created: now } } });
      }
      default: {
        const message = s.messages.find(x => `message/${x.id}` === m![2]);
        return message ? Response.json({ data: message }) : Response.json({ error: "not committed" }, { status: 404 });
      }
    }
  } });
  writeFileSync(registrationFile, JSON.stringify({ id: "offline-outbox", version: "2.0.18", pid: process.pid, url: `http://127.0.0.1:${native.port}`, password: "offline" }));
  const options: Options = { host: "127.0.0.1", port: 0, cwd, dataDir, packageDir, noBuild: true, allowRemote: false, reconcileInterrupted: false, claudeBin: "/nonexistent-offline-claude",
    nativeSources: { cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot }, oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile } } };
  const installation = acquireInstallation(validateOwnershipPaths(packageDir, dataDir), { phase: "setup" });
  const data = acquireData(installation, { phase: "setup", createDataParent: true });
  try { initializeAppStore(dataDir, options.nativeSources); } finally { data.release(); installation.release(); }
  let app: Awaited<ReturnType<typeof start>> | undefined, cookie = "";
  let ticks: Array<() => void> = [];
  async function boot() {
    ticks = []; const original = globalThis.setInterval;
    const timer = spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number, ...args: unknown[]) => {
      const handle = original(fn, ms, ...args); if (ms === 500) { clearInterval(handle); ticks.push(fn); } return handle;
    }) as typeof setInterval);
    try { app = await start(options); } finally { timer.mockRestore(); }
    const response = await fetch(`${app.origin}/api/login`, { method: "POST", headers: { origin: app.origin, "content-type": "application/json" }, body: JSON.stringify({ password: "offline-outbox" }) });
    expect(response.status).toBe(200); cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  }
  async function api(path: string, input?: unknown) {
    const response = await fetch(`${app!.origin}${path}`, { method: input === undefined ? "GET" : "POST", headers: { origin: app!.origin, cookie, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json() as any; expect(response.ok, JSON.stringify(body)).toBe(true); return body;
  }
  const disk = (name: string) => JSON.parse(readFileSync(join(dataDir, name), "utf8"));
  const stop = async () => { await app?.close(); app = undefined; };
  const cleanup = async () => { try { await stop(); } finally { native.stop(true); for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } rmSync(root, { recursive: true, force: true }); } };
  try {
    await boot(); const workspace = await api("/api/workspaces", { cwd });
    await api(`/api/workstreams/init?workspaceId=${workspace.workspaceId}`, {});
    const created = await api("/api/sessions", { harness: "opencode", prompt: "seed", cwd });
    await until("seed run completed", () => disk("metadata.json").runs.find((r: Run) => r.runId === created.runId)?.status === "completed");
    const session = disk("metadata.json").sessions.find((s: Session) => s.sessionId === created.sessionId) as Session;
    const id = crypto.randomUUID(), now = new Date().toISOString();
    app!.workers.store.insert({ id, sessionId: crypto.randomUUID(), runId: null,
      parent: { sessionId: session.sessionId, runId: session.lastRunId!, toolCallId: "fixture-worker", native: { harness: "oc", authorityId: session.authorityId!, nativeId: session.nativeSessionId! } },
      input: { requestId: crypto.randomUUID(), worker: "tester", prompt: "offline completed worker" }, checkout: cwd,
      launch: { profileId: "worker:tester", harness: "opencode", agent: "sane/worker/tester" }, child: null, state: "completed", createdAt: now, updatedAt: now,
      outcome: { status: "completed", at: now, summary: "revision one", log: null }, notification: { id: `worker-outcome:${id}`, state: "pending" } });
    function claim() {
      const run: Run = { runId: crypto.randomUUID(), sessionId: session.sessionId, cwd, status: "running", createdAt: now, nativeCommandId: `msg_${crypto.randomUUID().replaceAll("-", "")}`, nativePhase: "sending" };
      return app!.workers.store.claimDelivery({ id: crypto.randomUUID(), parentSessionId: session.sessionId, native: { harness: "oc", authorityId: session.authorityId!, nativeId: session.nativeSessionId! }, run, commandId: run.nativeCommandId!, createdAt: now, updatedAt: now })!;
    }
    async function persistRun(d: WorkerDelivery, phase: Run["nativePhase"]) {
      await stop(); const meta = disk("metadata.json");
      meta.runs.push({ ...d.run, nativePhase: phase });
      Object.assign(meta.sessions.find((s: Session) => s.sessionId === session.sessionId), { lastRunId: d.run.runId, lastStatus: "running" });
      writeFileSync(join(dataDir, `${d.run.runId}.jsonl`), JSON.stringify({ seq: 1, time: now, runId: d.run.runId, sessionId: session.sessionId, kind: "status", data: { status: "running" } }) + "\n");
      atomicAppRecord(dataDir, "metadata.json", meta);
    }
    return { get app() { return app!; }, boot, stop, cleanup, api, disk, dataDir, session, id, claim, persistRun, submissions, sessions, historyReads,
      tick: () => ticks.forEach(fn => fn()),
      caller: { envelope: { version: 1, repository: cwd, source: options.nativeSources.oc, authorityId: session.authorityId, nativeId: session.nativeSessionId }, runId: session.lastRunId!, toolCallId: "fixture-ack" } };
  } catch (error) { await cleanup(); throw error; }
}

test("restart recognizes exact acceptance once while parent run is still running", async () => {
  const f = await fixture();
  try {
    f.tick();
    await until("real dispatch accepted", () => {
      const delivery = f.app.workerOutbox.list()[0];
      return delivery && f.disk("metadata.json").runs.find((r: Run) => r.runId === delivery.run.runId)?.nativePhase === "accepted";
    });
    const d = f.app.workerOutbox.list()[0]!;
    expect(f.submissions).toHaveLength(2);
    expect(f.submissions[1].id).toBe(d.commandId);
    expect(f.sessions.get(f.session.nativeSessionId!)!.active).toBe(true);
    await f.stop();
    // Crash image: native acceptance committed, outbox completion write lost.
    // Preserve the real dispatch identity/metadata/log, rolling back only its
    // independent delivery checkpoint to the durable pre-acceptance state.
    const records = f.disk("workers.json");
    records.deliveries[0].state = "acceptance-unknown";
    records.workers[0].results[0].notification.state = "acceptance-unknown";
    atomicAppRecord(f.dataDir, "workers.json", records);
    await f.boot();
    await f.app.workerOutbox.reconcile(d.id);
    expect(f.app.workerOutbox.list()).toMatchObject([{ id: d.id, state: "delivered", resultRefs: d.resultRefs }]);
    expect(f.disk("metadata.json").runs.find((r: Run) => r.runId === d.run.runId).status).toBe("running");
    await f.stop(); await f.boot(); await f.app.workerOutbox.reconcile(d.id);
    expect(f.app.workerOutbox.list()).toHaveLength(1);
    expect(f.app.workers.store.get(f.id)!.latestResult!.notification.state).toBe("delivered");
    expect(f.submissions).toHaveLength(2);
  } finally { await f.cleanup(); }
}, 30000);

test("pre-publication crash retries the same revision through real bridge dispatch", async () => {
  const f = await fixture();
  try {
    const d = f.claim(); await f.stop(); await f.boot(); await f.app.workerOutbox.reconcile(d.id);
    expect(f.app.workerOutbox.list()[0]!.state).toBe("not-submitted");
    const w = f.app.workers.store.get(f.id)!;
    expect(w.latestResult!.notification.state).toBe("pending");
    // Advance only the durable retry deadline; no production clock or dispatch is replaced.
    w.results![0]!.notification.retryAfter = new Date(0).toISOString(); f.app.workers.store.update(w.id, { results: w.results });
    f.tick(); await until("retry native acceptance", () => f.submissions.length === 2);
    await until("retry delivered", async () => { const next = f.app.workerOutbox.list().find(x => x.id !== d.id); if (!next) return false; await f.app.workerOutbox.reconcile(next.id); return f.app.workerOutbox.list().find(x => x.id === next.id)?.state === "delivered"; });
    const next = f.app.workerOutbox.list()[1]!;
    expect(next.resultRefs).toEqual(d.resultRefs); expect(next.commandId).not.toBe(d.commandId);
    expect(f.submissions[1].text).toContain("revision one");
    expect(f.disk("metadata.json").runs.find((r: Run) => r.runId === next.run.runId).status).toBe("running");
  } finally { await f.cleanup(); }
}, 30000);

test("recovered monitor acquires later exact native acceptance without resending ambiguous delivery", async () => {
  const f = await fixture();
  try {
    const d = f.claim(); await f.persistRun(d, "sending");
    const native = f.sessions.get(f.session.nativeSessionId!)!;
    native.active = true;
    const reads = () => f.historyReads.get(f.session.nativeSessionId!) ?? 0;
    const run = () => f.disk("metadata.json").runs.find((r: Run) => r.runId === d.run.runId) as Run;
    // Two history reads ensure at least one complete recovered-monitor cycle,
    // rather than passing a negative assertion before observation has run.
    async function observeWithoutAcceptance(before: number) {
      await until("recovered monitor reads controlled native history", () => reads() >= before + 2);
      await f.app.workerOutbox.reconcile(d.id);
      expect(run()).toMatchObject({ nativePhase: "sending", nativeCommandId: d.commandId, status: "running" });
      expect(f.app.workerOutbox.list()).toMatchObject([{ id: d.id, state: "acceptance-unknown" }]);
      expect(f.app.workers.store.get(f.id)!.latestResult!.notification.state).toBe("acceptance-unknown");
      expect(f.submissions).toHaveLength(1);
    }
    for (let i = 0; i < 2; i++) {
      const before = reads();
      await f.boot(); f.tick();
      await observeWithoutAcceptance(before);
      await f.stop(); expect(f.submissions).toHaveLength(1);
    }
    // A foreign accepted user input cannot stand in for the original command.
    const foreign = { id: "msg_foreign_input", type: "user", text: "unrelated input", time: { created: Date.now() } };
    native.messages.push(foreign);
    const beforeForeign = reads(); await f.boot();
    await observeWithoutAcceptance(beforeForeign);
    // Even an exact ID with the wrong message type is contradictory, not proof.
    const contradictory = { id: d.commandId, type: "assistant", time: { created: Date.now() }, content: [{ type: "text", text: "not the accepted user input" }] };
    native.messages.push(contradictory);
    await observeWithoutAcceptance(reads());
    native.messages.splice(native.messages.indexOf(contradictory), 1);
    native.messages.push({ id: d.commandId, type: "user", text: "Worker Outcome: revision one", time: { created: Date.now() } });
    // No metadata mutation or adapter/service spy: the live recovered monitor
    // must acquire the exact native input and persist acceptance itself.
    await until("recovered monitor persists native acceptance", () => run().nativePhase === "accepted");
    expect(run()).toMatchObject({ nativeCommandId: d.commandId, status: "running" });
    f.tick();
    await until("real outbox consumes recovered acceptance", () => f.app.workerOutbox.list()[0]?.state === "delivered");
    expect(f.app.workerOutbox.list()).toHaveLength(1);
    expect(f.app.workers.store.get(f.id)!.latestResult!.notification.state).toBe("delivered");
    expect(f.submissions).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 30000);

test("lost acknowledgement response: retry old exact ref after restart cannot consume newer revision", async () => {
  const f = await fixture();
  try {
    const old = f.app.workers.store.get(f.id)!.latestResult!, ref = { workerId: f.id, revision: old.revision, notificationId: old.notification.id };
    // Service commits, but caller discards the response (lost transport reply).
    await f.app.workers.acknowledgeWait(f.caller, [ref]);
    const w = f.app.workers.store.get(f.id)!;
    const newer = { revision: 2, runId: crypto.randomUUID(), outcome: { ...old.outcome, summary: "revision two" }, notification: { id: `worker-outcome:${f.id}:2`, state: "pending" as const } };
    f.app.workers.store.update(f.id, { results: [...w.results!, newer] });
    await f.stop(); await f.boot();
    expect(await f.app.workers.acknowledgeWait(f.caller, [ref])).toEqual([{ ...ref, state: "wait-consumed", acknowledged: true }]);
    expect(f.app.workers.store.get(f.id)!.results!.map(r => r.notification.state)).toEqual(["wait-consumed", "pending"]);
    f.tick(); await until("only newer revision dispatched", () => f.submissions.length === 2);
    expect(f.app.workerOutbox.list()[0]!.resultRefs).toEqual([{ workerId: f.id, revision: 2, notificationId: newer.notification.id }]);
    expect(f.submissions[1].text).toContain("revision two"); expect(f.submissions[1].text).not.toContain("revision one");
  } finally { await f.cleanup(); }
}, 30000);
