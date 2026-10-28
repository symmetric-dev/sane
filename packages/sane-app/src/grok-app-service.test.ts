import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { GrokTurnInput } from "../shared/conversation/grok-contract";
import { AdmissionService } from "./admission";
import { initializeAppStore, publishGrokSourcePin } from "./app-store";
import { CatalogService } from "./catalog";
import { GrokAppService } from "./grok-app-service";
import type { GrokSpawn, GrokSpawnOptions } from "./grok-adapter";
import { beginGrokCaptureTurn, createGrokCaptureJournal, grokCaptureFilename } from "./grok-capture";
import { validateStoredMetadata, type Session } from "./history";
import { RepositoryRouter } from "./workstreams";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const roots: string[] = [];
const routers: RepositoryRouter[] = [];
afterEach(async () => {
  for (const router of routers.splice(0)) await router.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: (NodeJS.Signals | number | undefined)[] = [];
  constructor(readonly pid: number, private autoClose = true) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (this.autoClose) this.finish(null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }
  finish(code: number | null = 0, signal: string | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(TEMP, "grok-app-service-")));
  roots.push(root);
  const dataDir = join(root, "app"), cwd = join(root, "workspace"), homeRoot = join(root, "grok-home");
  for (const dir of [dataDir, cwd, homeRoot, join(root, "cc"), join(root, "oc")]) mkdirSync(dir);
  const executable = join(root, "inert-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const initial = initializeAppStore(dataDir, {
    cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: join(root, "cc") },
    oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(root, "oc/service.json") },
  });
  const sources = publishGrokSourcePin(dataDir, homeRoot);
  const sessions: Session[] = [];
  const catalog = new CatalogService(dataDir, () => sessions);
  await catalog.load();
  const registered = await catalog.register(cwd);
  const router = new RepositoryRouter(catalog, sources);
  routers.push(router);
  const admissions = new AdmissionService(dataDir, initial.admissions, sources, catalog, router);
  const calls: { argv: readonly string[]; options: GrokSpawnOptions; child: Child }[] = [];
  const events: string[] = [];
  const spawn: GrokSpawn = (argv, options) => {
    events.push("spawn");
    const child = new Child(8000 + calls.length);
    calls.push({ argv, options, child });
    return child;
  };
  const options = {
    dataDir, admissions, catalog, executable, homeRoot, spawn,
    assertOpen: () => {},
    admit: async <T,>(_id: string, work: () => Promise<T>) => { events.push("admit"); return work(); },
    persistSession: async (session: Session) => {
      validateStoredMetadata({ version: 2, sessions: [...sessions, session], runs: [], reconciliationRequired: false });
      events.push("persist"); sessions.push(structuredClone(session));
    },
    readSession: (id: string) => sessions.find(session => session.sessionId === id),
    changed: (_id: string) => {},
  };
  const service = new GrokAppService(options);
  const input: GrokTurnInput = { sessionId: crypto.randomUUID(), turnIndex: 0, prompt: "First exact prompt\n café", model: "fixture-model", effort: "fixture-effort", cwd, workspaceId: registered.workspaceId, worktreeId: registered.worktreeId };
  return { root, options, dataDir, cwd, homeRoot, executable, catalog, admissions, sessions, calls, events, service, input };
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 500; i++) { if (await check()) return; await Bun.sleep(2); }
  throw new Error("Offline fixture condition did not settle");
}
async function idle(service: GrokAppService, id: string) { await until(async () => !(await service.view(id)).active); return service.view(id); }
function textEvent(text: string) { return JSON.stringify({ type: "assistant", message: { id: "msg_0", role: "assistant", content: [{ type: "text", text }] } }) + "\n"; }

test("new/continuation, incremental text, persisted idle metadata, duplicate status, restart, and no CC fallback", async () => {
  const f = await fixture();
  expect(f.service.capability().configured).toBe(true);
  expect(f.calls).toHaveLength(0);
  const first = await f.service.submit(f.input);
  expect(first.active).toBe(true);
  await until(() => f.calls.length === 1);
  expect(f.events).toEqual(["admit", "persist", "spawn"]);
  const call = f.calls[0]!;
  expect(call.argv[0]).toBe(f.executable);
  expect(call.argv).toContain("--session-id");
  expect(call.argv).toContain("--deny");
  expect(call.options.env.SANE_UNQUALIFIED_NATIVE).toBe("1");
  expect(call.options.env.GROK_SESSION_ID).toBe(first.nativeSessionId!);
  expect(call.options.env.PATH).toBeUndefined();
  expect(call.options.env.HOME).toBeUndefined();
  const stored = f.sessions[0]!;
  expect(stored).toMatchObject({ harness: "grok", lastRunId: null, lastStatus: "unknown", profileId: "base:gk" });
  expect(f.admissions.getGrokCreate(f.input.sessionId)?.state).toBe("identity_known");
  const event = textEvent("Hello café");
  const bytes = Buffer.from(event);
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  call.child.stdout.write(bytes.subarray(0, split));
  call.child.stdout.write(bytes.subarray(split));
  const live = await f.service.view(f.input.sessionId);
  expect(live.messages.at(-1)?.parts).toEqual([{ type: "text", text: "Hello café" }]);
  expect((await f.service.submit(f.input)).runs[0]?.id).toBe(first.runs[0]?.id);
  await expect(f.service.submit({ ...f.input, prompt: "different" })).rejects.toMatchObject({ code: "grok-turn-conflict" });
  expect(f.calls).toHaveLength(1);
  call.child.finish();
  const done = await idle(f.service, f.input.sessionId);
  expect(done.phase).toBe("idle");
  expect(done.nextTurnIndex).toBe(1);
  expect(f.service.presentationRuns()).toMatchObject([{ runId: done.runs[0]!.id, status: "completed", sessionId: f.input.sessionId }]);
  expect(done.nativeAcceptance).toBe("unknown");
  expect(done.acceptedMessageId).toBeNull();
  expect(done.messages.some(message => message.nativeIds?.includes("msg_0"))).toBe(false);
  expect(f.service.overlay(stored)).toMatchObject({ lastRunId: done.runs[0]!.id, lastStatus: "completed" });
  expect(stored.lastRunId).toBeNull();
  expect(stored.lastStatus).toBe("unknown");
  const restarted = new GrokAppService(f.options);
  expect((await restarted.view(f.input.sessionId)).messages).toEqual(done.messages);
  expect((await restarted.view(f.input.sessionId)).runs[0]!.id).toBe(done.runs[0]!.id);
  await restarted.submit(f.input);
  expect(f.calls).toHaveLength(1);
  const secondInput = { ...f.input, turnIndex: 1, prompt: "Continue", cwd: undefined };
  await f.service.submit(secondInput);
  await until(() => f.calls.length === 2);
  expect(f.calls[1]!.argv).toContain("--resume");
  expect(f.calls[1]!.argv).not.toContain("--session-id");
  expect(f.calls[1]!.options.env.GROK_SESSION_ID).toBe(first.nativeSessionId!);
  f.calls[1]!.child.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "Second response", uuid: crypto.randomUUID() }) + "\n");
  f.calls[1]!.child.finish();
  const second = await idle(f.service, f.input.sessionId);
  expect(second.messages.at(-1)?.parts).toEqual([{ type: "text", text: "Second response" }]);
  expect(second.runs).toHaveLength(2);
  expect(f.sessions).toHaveLength(1);
  expect(f.events.filter(event => event === "admit")).toHaveLength(1);
  const capture = JSON.parse(readFileSync(join(f.dataDir, "grok-captures", grokCaptureFilename(f.input.sessionId)), "utf8"));
  expect(capture.turns[0].runId).toBe(first.runs[0]!.id);
  expect(capture.turns[0].createdAt).toBe(first.runs[0]!.createdAt);
  expect(capture.execution.disposition).toBe("idle");
  expect(await f.service.close()).toEqual({ drained: true });
});

test("pending capture recovery is blocked, displays stored settings, and never replays", async () => {
  const f = await fixture();
  const nativeId = crypto.randomUUID();
  const admission = await f.admissions.beginGrokCreate({ sessionId: f.input.sessionId, nativeId, cwd: f.cwd, workspaceId: f.input.workspaceId!, worktreeId: f.input.worktreeId! });
  f.sessions.push({ sessionId: f.input.sessionId, harness: "grok", nativeSessionId: nativeId, authorityId: admission.source.authorityId, cwd: f.cwd, lastRunId: null, lastStatus: "unknown", model: f.input.model, effort: f.input.effort });
  const directory = join(f.dataDir, "grok-captures");
  mkdirSync(directory);
  beginGrokCaptureTurn(directory, createGrokCaptureJournal(), { appSessionId: f.input.sessionId, nativeSessionId: nativeId, authorityId: admission.source.authorityId, turnIndex: 0 });
  const bytes = readFileSync(join(directory, grokCaptureFilename(f.input.sessionId)), "utf8");
  const recovered = await f.service.view(f.input.sessionId);
  expect(recovered).toMatchObject({ blocked: true, active: false, phase: "blocked", model: f.input.model, effort: f.input.effort, nativeSessionId: nativeId });
  await expect(f.service.submit(f.input)).rejects.toMatchObject({ code: "grok-blocked" });
  expect(f.calls).toHaveLength(0);
  expect(readFileSync(join(directory, grokCaptureFilename(f.input.sessionId)), "utf8")).toBe(bytes);
});

test("fresh continuation revision drift is refused before spawn", async () => {
  const f = await fixture();
  await f.service.submit(f.input);
  await until(() => f.calls.length === 1);
  f.calls[0]!.child.stdout.write(textEvent("first"));
  f.calls[0]!.child.finish();
  await idle(f.service, f.input.sessionId);
  const original = f.catalog.binding.bind(f.catalog);
  f.catalog.binding = async (...args: Parameters<CatalogService["binding"]>) => ({ ...await original(...args), bindingRevision: crypto.randomUUID() });
  await expect(f.service.submit({ ...f.input, turnIndex: 1, prompt: "next" })).rejects.toMatchObject({ code: "binding-invalid" });
  expect(f.calls).toHaveLength(1);
  const restarted = new GrokAppService(f.options);
  expect((await restarted.view(f.input.sessionId)).blocked).toBe(true);
  expect((await restarted.submit({ ...f.input, turnIndex: 1, prompt: "next" })).blocked).toBe(true);
  await expect(restarted.submit({ ...f.input, turnIndex: 1, prompt: "changed" })).rejects.toMatchObject({ code: "grok-turn-conflict" });
});

test("catalog fence is checked after idle metadata persistence and before spawn", async () => {
  const f = await fixture();
  const service = new GrokAppService({ ...f.options, persistSession: async session => {
    await f.options.persistSession(session);
    f.catalog.assertBinding = () => { throw new Error("binding changed during metadata persistence"); };
  } });
  await service.submit(f.input);
  const view = await idle(service, f.input.sessionId);
  expect(view.blocked).toBe(true);
  expect(view.reason).toContain("binding changed");
  expect(f.calls).toHaveLength(0);
  expect(f.sessions).toHaveLength(1);
  const restarted = new GrokAppService(f.options);
  expect((await restarted.view(f.input.sessionId)).blocked).toBe(true);
  await expect(restarted.submit(f.input)).rejects.toMatchObject({ code: "grok-blocked" });
});

test("Stop during continuation preflight prevents a later spawn, and pending settings conflicts are refused", async () => {
  const f = await fixture();
  await f.service.submit(f.input);
  await until(() => f.calls.length === 1);
  f.calls[0]!.child.finish();
  await idle(f.service, f.input.sessionId);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const original = f.catalog.binding.bind(f.catalog);
  f.catalog.binding = async (...args: Parameters<CatalogService["binding"]>) => {
    entered.resolve();
    await gate.promise;
    return original(...args);
  };
  const nextInput = { ...f.input, turnIndex: 1, prompt: "next" };
  const next = f.service.submit(nextInput);
  await entered.promise;
  const stopped = await f.service.stop(f.input.sessionId);
  expect(stopped).toMatchObject({ interrupted: false, nativeCancellation: "not-attempted", wrapperClosed: true });
  gate.resolve();
  await expect(next).rejects.toMatchObject({ code: "grok-stopped" });
  expect(f.calls).toHaveLength(1);

  const g = await fixture();
  const preparing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const associate = g.catalog.associate.bind(g.catalog);
  g.catalog.associate = async (...args: Parameters<CatalogService["associate"]>) => { preparing.resolve(); await release.promise; return associate(...args); };
  const pending = g.service.submit(g.input);
  await preparing.promise;
  await expect(g.service.submit({ ...g.input, workspaceId: crypto.randomUUID() })).rejects.toMatchObject({ code: "grok-turn-conflict" });
  const closing = g.service.close();
  release.resolve();
  await expect(pending).rejects.toMatchObject({ code: "grok-closing" });
  expect(await closing).toEqual({ drained: true });
  expect(g.calls).toHaveLength(0);
});

test("Stop and shutdown use the original owned handles despite a changed configured pin", async () => {
  const f = await fixture();
  await f.service.submit(f.input);
  await until(() => f.calls.length === 1);
  f.admissions.getGrokSourcePin = () => null;
  const stop = await f.service.stop(f.input.sessionId);
  expect(stop).toMatchObject({ interrupted: false, nativeCancellation: "unproven", wrapperClosed: true });
  expect(f.calls[0]!.child.signals).toEqual(["SIGTERM"]);
  const view = await idle(f.service, f.input.sessionId);
  expect(view.blocked).toBe(true);
  const recovered = new GrokAppService(f.options);
  expect((await recovered.view(f.input.sessionId)).blocked).toBe(true);
  await expect(recovered.submit({ ...f.input, turnIndex: 1, prompt: "no replay" })).rejects.toMatchObject({ code: "grok-blocked" });
  expect(await f.service.close()).toEqual({ drained: true });

  const g = await fixture();
  await g.service.submit(g.input);
  await until(() => g.calls.length === 1);
  expect(await g.service.close()).toEqual({ drained: true });
  expect(g.calls[0]!.child.signals).toEqual(["SIGTERM"]);
  expect((await g.service.view(g.input.sessionId)).blocked).toBe(true);
});

test("bounded incomplete drain reports false; late actual close releases ownership but keeps durable blocked", async () => {
  const f = await fixture();
  const child = new Child(9900, false);
  const service = new GrokAppService({ ...f.options, spawn: () => child });
  await service.submit(f.input);
  await until(() => f.sessions.length === 1);
  await Bun.sleep(5);
  expect(await service.close()).toEqual({ drained: false });
  expect(service.activeCount()).toBe(1);
  expect((await service.view(f.input.sessionId)).blocked).toBe(true);
  child.finish(null, "SIGKILL");
  await until(() => service.activeCount() === 0);
  expect((await service.view(f.input.sessionId)).blocked).toBe(true);
  expect(await service.close()).toEqual({ drained: true });
}, 10_000);

test("nonzero and error results are durably blocked, without silent retry", async () => {
  for (const kind of ["exit", "result"] as const) {
    const f = await fixture();
    await f.service.submit(f.input);
    await until(() => f.calls.length === 1);
    if (kind === "result") f.calls[0]!.child.stdout.write(JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "quota unavailable" }) + "\n");
    f.calls[0]!.child.finish(kind === "exit" ? 2 : 0);
    const view = await idle(f.service, f.input.sessionId);
    expect(view.blocked).toBe(true);
    expect(view.reason).toContain("Start a new conversation");
    expect(view.runs[0]!.status).toBe("failed");
    expect((await f.service.submit(f.input)).blocked).toBe(true);
    const restarted = new GrokAppService(f.options);
    expect((await restarted.view(f.input.sessionId)).blocked).toBe(true);
    expect((await restarted.view(f.input.sessionId)).runs[0]!.status).toBe("failed");
    await expect(restarted.submit({ ...f.input, turnIndex: 1, prompt: "next" })).rejects.toMatchObject({ code: "grok-blocked" });
    expect(f.calls).toHaveLength(1);
  }
});

test("unknown protocol is a bounded system diagnostic, not fabricated assistant success", async () => {
  const f = await fixture();
  await f.service.submit(f.input);
  await until(() => f.calls.length === 1);
  f.calls[0]!.child.stdout.write("unexpected protocol " + "x".repeat(5_000) + "\n");
  f.calls[0]!.child.finish();
  const view = await idle(f.service, f.input.sessionId);
  expect(view.messages.map(message => message.role)).toEqual(["user", "system"]);
  expect(JSON.stringify(view.messages)).toContain("diagnostic");
  expect(JSON.stringify(view.messages).length).toBeLessThan(4_000);
  expect(view.nativeAcceptance).toBe("unknown");
});

test("missing explicit config, mismatching pin, invalid input and other harness admissions never spawn", async () => {
  const f = await fixture();
  for (const overrides of [{ executable: undefined }, { homeRoot: undefined }, { homeRoot: join(f.root, "other") }]) {
    const service = new GrokAppService({ ...f.options, ...overrides });
    expect(service.capability().configured).toBe(false);
    await expect(service.submit(f.input)).rejects.toMatchObject({ code: "grok-unconfigured" });
  }
  await expect(f.service.submit({ ...f.input, automatic: true } as GrokTurnInput)).rejects.toMatchObject({ code: "invalid-grok-turn" });
  await expect(f.service.submit({ ...f.input, effort: "" })).rejects.toMatchObject({ code: "invalid-grok-turn" });
  await expect(f.service.submit({ ...f.input, effort: " ".repeat(3) })).rejects.toMatchObject({ code: "invalid-grok-turn" });
  await expect(f.service.submit({ ...f.input, effort: "x".repeat(201) })).rejects.toMatchObject({ code: "invalid-grok-turn" });
  const other = { ...f.input, sessionId: crypto.randomUUID() };
  f.sessions.push({ sessionId: other.sessionId, harness: "claude-code", cwd: f.cwd, lastRunId: null, lastStatus: "unknown" });
  await expect(f.service.submit(other)).rejects.toMatchObject({ code: "grok-session-conflict" });
  expect(f.calls).toHaveLength(0);
});

test("repository workspace is refused, never initialized or admitted as app-only", async () => {
  const f = await fixture();
  const original = f.catalog.registered.bind(f.catalog);
  f.catalog.registered = async id => ({ ...await original(id), kind: "repository" });
  await expect(f.service.submit(f.input)).rejects.toMatchObject({ code: "grok-repository-refused" });
  expect(f.admissions.get(f.input.sessionId)).toBeUndefined();
  expect(f.sessions).toHaveLength(0);
  expect(f.calls).toHaveLength(0);
});
