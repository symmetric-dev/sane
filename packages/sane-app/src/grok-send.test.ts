import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { AdmissionService } from "./admission";
import { grokSourceRecord } from "./app-sources";
import { atomicAppRecord, initializeAppStore, publishGrokSourcePin, type Admission, type StoredSourceRecords } from "./app-store";
import { CatalogService } from "./catalog";
import { grokCaptureFilename } from "./grok-capture";
import { createGrokSendSession, GrokSendRefusal, runGrokTurn, type GrokSendSession, type GrokTurnRequest } from "./grok-send";
import { GrokDispatchRefusal, type GrokSpawn } from "./grok-adapter";
import { RepositoryRouter, WorkstreamAdapterError } from "./workstreams";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const MODEL = "fixture-model";
const EFFORT = "fixture-effort";
const roots: string[] = [];
const routers: RepositoryRouter[] = [];

afterEach(async () => {
  for (const router of routers.splice(0)) await router.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed: NodeJS.Signals | number | null = null;
  private exited = false;
  private closed = false;
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number) {
    this.killed = signal ?? "SIGTERM";
    this.emitExit(null, this.killed);
    this.emitClose(null, this.killed);
    return true;
  }
  emitExit(code: number | null, signal: NodeJS.Signals | number | null) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
  emitClose(code: number | null, signal: NodeJS.Signals | number | null) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
  }
  /** Stdout must be written before close. The adapter waits for close, not exit. */
  finish(code = 0, signal: NodeJS.Signals | number | null = null, write?: (child: FakeChild) => void) {
    write?.(this);
    this.emitExit(code, signal);
    this.emitClose(code, signal);
  }
}

function tempRoot(name: string) {
  const root = realpathSync(mkdtempSync(join(TEMP, name)));
  roots.push(root);
  return root;
}

async function fixture() {
  const root = tempRoot("grok-send-");
  const data = join(root, "app");
  const cwd = join(root, "workspace");
  const profile = join(root, "claude");
  const registration = join(root, "opencode");
  const home = join(root, "grok-home");
  const capture = join(root, "capture");
  const executable = join(root, "inert-executable");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const dir of [data, cwd, profile, registration, home, capture]) mkdirSync(dir);
  const initial = initializeAppStore(data, {
    cc: { version: 1, harness: "cc", kind: "local-profile", profileRoot: profile },
    oc: { version: 1, harness: "oc", kind: "local-registration", registrationFile: join(registration, "service.json") },
  });
  const sources = publishGrokSourcePin(data, home);
  const catalog = new CatalogService(data, () => []);
  await catalog.load();
  const registered = await catalog.register(cwd);
  const router = new RepositoryRouter(catalog, sources);
  routers.push(router);
  const service = new AdmissionService(data, initial.admissions, sources, catalog, router);
  const authority = sources.gk;
  if (!authority?.authorityId) throw new Error("Fixture Grok authority was not resolved");
  return { root, data, cwd, capture, home, executable, sources, initial, catalog, router, service, authority, workspaceId: registered.workspaceId, worktreeId: registered.worktreeId };
}

function request(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<GrokTurnRequest> = {}): GrokTurnRequest {
  return {
    kind: "new",
    executable: f.executable,
    model: MODEL,
    effort: EFFORT,
    cwd: f.cwd,
    authority: f.authority,
    prompt: "exact bytes \n café",
    workspaceId: f.workspaceId,
    worktreeId: f.worktreeId,
    admissions: f.service,
    ...overrides,
  };
}

function sessionFor(f: Awaited<ReturnType<typeof fixture>>, appSessionId: string = crypto.randomUUID()): GrokSendSession {
  return createGrokSendSession({ appSessionId, captureDirectory: f.capture, promptDirectory: f.capture });
}

function listing(dir: string) {
  return readdirSync(dir, { recursive: true }).map(entry => String(entry)).sort();
}

function finishingSpawn(onSpawn?: (child: FakeChild, argv: readonly string[]) => void): GrokSpawn {
  return argv => {
    const child = new FakeChild(4200);
    queueMicrotask(() => {
      onSpawn?.(child, argv);
      if (child.killed === null) child.finish(0);
    });
    return child;
  };
}

test("new turn uses --session-id and the exact prompt, then continuation uses --resume with the same UUID and does not call begin again", async () => {
  const f = await fixture();
  const events: string[] = [];
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const original = f.service.beginGrokCreate.bind(f.service);
  f.service.beginGrokCreate = async input => {
    events.push("begin");
    return original(input);
  };
  const session = sessionFor(f);
  const spawn: GrokSpawn = (argv, options) => {
    events.push("spawn");
    calls.push({ argv, env: options.env });
    expect(session.journal.execution?.disposition).toBe("pending");
    expect(session.nativeSessionId).toBe(session.journal.execution?.nativeSessionId);
    const child = new FakeChild(4200 + calls.length);
    queueMicrotask(() => { if (child.killed === null) child.finish(0); });
    return child;
  };
  const prompt = "exact bytes \n café";
  const created = runGrokTurn(session, request(f, { spawn, prompt }));
  const first = await created.done;
  const continued = runGrokTurn(session, request(f, { kind: "continuation", spawn, prompt: `${prompt} continued` }));
  const second = await continued.done;
  expect(events).toEqual(["begin", "spawn", "spawn"]);
  expect(calls).toHaveLength(2);
  const [createdCall, continuedCall] = calls;
  expect(createdCall!.argv).toContain("--session-id");
  expect(createdCall!.argv).not.toContain("--resume");
  const nativeSessionId = createdCall!.argv[createdCall!.argv.indexOf("--session-id") + 1];
  expect(nativeSessionId).toBe(created.nativeSessionId);
  expect(nativeSessionId).toBe(first.nativeSessionId);
  expect(session.nativeSessionId).toBe(nativeSessionId);
  const promptPath = createdCall!.argv[createdCall!.argv.indexOf("--prompt-file") + 1]!;
  expect(readFileSync(promptPath)).toEqual(Buffer.from(prompt, "utf8"));
  expect(promptPath).toContain(first.owner.run.runId);
  expect(promptPath).not.toContain("run-1");
  expect(createdCall!.argv.some(arg => arg.includes(prompt))).toBe(false);
  expect(continuedCall!.argv).toContain("--resume");
  expect(continuedCall!.argv).not.toContain("--session-id");
  expect(continuedCall!.argv[continuedCall!.argv.indexOf("--resume") + 1]).toBe(nativeSessionId);
  expect(createdCall!.env.GROK_HOME).toBe(f.authority.descriptor.homeRoot);
  expect(createdCall!.env.PATH).toBeUndefined();
  expect(createdCall!.env.HOME).toBeUndefined();
  expect(createdCall!.env.SANE_UNQUALIFIED_NATIVE).toBe("1");
  expect(createdCall!.env.GROK_SESSION_ID).toBe(nativeSessionId);
  expect(Object.keys(createdCall!.env).filter(key => key.startsWith("SANE_") || key.startsWith("OPENCODE_"))).toEqual(["SANE_UNQUALIFIED_NATIVE"]);
  expect(first.owner.run.runId).not.toBe("run-1");
  expect(first.owner.run.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(first.owner.run.createdAt).not.toBe("2026-10-27T00:00:00.000Z");
  expect(Math.abs(Date.now() - Date.parse(first.owner.run.createdAt))).toBeLessThan(60_000);
  expect(second.owner.run.runId).not.toBe(first.owner.run.runId);
  expect(first.owner.contextIdentity?.runId).toBe(first.owner.run.runId);
  expect(first.owner.contextIdentity?.nativeCommandId).toBeNull();
  expect(first.owner.run.nativeCommandId).toBeUndefined();
  expect(first.admission?.state).toBe("identity_known");
  expect(first.admission?.operation).toBe("create");
  expect(first.admission?.parent).toBeNull();
  expect(JSON.stringify(first.owner)).not.toContain("msg_");
  expect(first.observation?.nativeAcceptance).not.toBe("accepted");
  expect(first.owner.settled).toBe(true);
  expect(first.owner.run.status).toBe("completed");
  await first.owner.done;
});

test("capture file has acceptance unknown and acceptedMessageId null even when stdout contains msg_0 and exit is 0", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  const line = JSON.stringify({ type: "assistant", message: { id: "msg_0", content: [{ type: "text", text: "not a tool_use event" }] } });
  const spawn: GrokSpawn = argv => {
    const child = new FakeChild(4301);
    const nativeSessionId = argv[argv.indexOf("--session-id") + 1];
    queueMicrotask(() => {
      if (child.killed !== null) return;
      child.finish(0, null, current => {
        current.stdout.write(`${line}\n${JSON.stringify({ type: "result", subtype: "success", session_id: nativeSessionId, result: "ok" })}\n`);
      });
    });
    return child;
  };
  const result = await runGrokTurn(session, request(f, { spawn, prompt: "hello" })).done;
  const captureName = grokCaptureFilename(session.appSessionId);
  expect(existsSync(join(f.capture, "grok-captures.json"))).toBe(false);
  const journal = JSON.parse(readFileSync(join(f.capture, captureName), "utf8"));
  expect(journal.version).toBe(1);
  expect(journal.turns).toHaveLength(1);
  expect(journal.turns[0].nativeAcceptance).toBe("unknown");
  expect(journal.turns[0].acceptedMessageId).toBeNull();
  expect(journal.turns[0].stdout).toContain("msg_0");
  expect(journal.turns[0].stdout).toContain("success");
  expect(journal.turns[0].exitCode).toBe(0);
  expect(journal.turns[0].submission).toBe("submitted");
  expect(JSON.stringify(journal.turns[0])).not.toContain("\"accepted\"");
  expect(result.turn?.acceptedMessageId).toBeNull();
  expect(result.turn?.nativeAcceptance).toBe("unknown");
  expect(result.observation?.nativeAcceptance).toBe("unknown");
  expect(result.observation?.acceptedMessageId).toBeNull();
  expect(result.observation?.submission).toBe("submitted");
});

test("missing executable and null authority do not spawn", async () => {
  const f = await fixture();
  let calls = 0;
  let begins = 0;
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("eligibility refusal must not spawn"); };
  const admissions = {
    get: f.service.get.bind(f.service),
    getGrokCreate: f.service.getGrokCreate.bind(f.service),
    getGrokSourcePin: f.service.getGrokSourcePin.bind(f.service),
    beginGrokCreate: async () => { begins += 1; throw new Error("eligibility refusal must not begin"); },
  };
  const session = sessionFor(f);
  expect(() => runGrokTurn(session, request(f, { spawn, admissions, executable: undefined }))).toThrow(/executable/i);
  expect(() => runGrokTurn(session, request(f, { spawn, admissions, executable: "grok" }))).toThrow(/executable/i);
  expect(() => runGrokTurn(session, request(f, { spawn, admissions, executable: "bin/grok" }))).toThrow(/executable/i);
  expect(() => runGrokTurn(session, request(f, { spawn, admissions, authority: null }))).toThrow(/unresolved/i);
  expect(() => runGrokTurn(session, request(f, { spawn, admissions, authority: { ...f.authority, authorityId: null } }))).toThrow(/unresolved/i);
  expect(() => runGrokTurn(session, request(f, { spawn, admissions, model: "" }))).toThrow(/model/i);
  expect(() => runGrokTurn(session, request(f, { spawn, admissions, effort: " " }))).toThrow(/effort/i);
  expect(() => runGrokTurn(session, request(f, {
    spawn,
    admissions,
    authority: { ...f.authority, descriptor: { ...f.authority.descriptor, homeRoot: "relative/home" } },
  }))).toThrow(/homeRoot/i);
  const continuation = sessionFor(f);
  continuation.nativeSessionId = "ses_not_a_uuid";
  expect(() => runGrokTurn(continuation, request(f, { kind: "continuation", spawn, admissions }))).toThrow(/previously submitted/i);
  expect(calls).toBe(0);
  expect(begins).toBe(0);
});

test("beginGrokCreate does not call register", async () => {
  const f = await fixture();
  const binding = await f.catalog.binding(f.workspaceId, f.worktreeId);
  const existing: Admission = {
    version: 1,
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    operation: "attach",
    state: "identity_known",
    source: f.initial.sources.cc.authorityId ? f.initial.sources.cc as Admission["source"] : f.sources.cc as Admission["source"],
    binding: {
      workspaceId: f.workspaceId,
      worktreeId: f.worktreeId,
      bindingRevision: binding.bindingRevision,
      executionCheckout: f.cwd,
      checkoutPin: null,
      domain: { mode: "app-only" },
    },
    parent: null,
    nativeId: crypto.randomUUID(),
    createdAt: "2026-10-27T00:00:00.000Z",
    error: null,
  };
  const v1 = { version: 1 as const, admissions: [existing] };
  const admissionsPath = join(f.data, "admissions.json");
  atomicAppRecord(f.data, "admissions.json", v1);
  const beforeOpen = readFileSync(admissionsPath, "utf8");
  const opened = new AdmissionService(f.data, JSON.parse(beforeOpen), f.sources, f.catalog, f.router);
  expect(readFileSync(admissionsPath, "utf8")).toBe(beforeOpen);
  expect(opened.list()).toHaveLength(1);

  let registers = 0;
  let begins = 0;
  let routerCalls = 0;
  opened.register = async () => { registers += 1; throw new Error("register must not be called"); };
  opened.begin = async () => { begins += 1; throw new Error("begin must not create a Claude admission"); };
  opened.createNative = async () => { throw new Error("createNative must not be called"); };
  opened.ready = () => { throw new Error("ready must not be called"); };
  opened.enroll = async () => { throw new Error("enroll must not be called"); };
  f.router.inspect = async () => { routerCalls += 1; throw new Error("router must not be called"); };
  f.router.forAdmission = async () => { routerCalls += 1; throw new Error("router must not be called"); };
  f.router.initialize = async () => { routerCalls += 1; throw new Error("router must not be called"); };

  const v1Service = new AdmissionService(f.data, JSON.parse(beforeOpen), f.initial.sources, f.catalog, f.router);
  const unconfigured = await v1Service.beginGrokCreate({
    sessionId: crypto.randomUUID(), nativeId: crypto.randomUUID(), cwd: f.cwd, workspaceId: f.workspaceId, worktreeId: f.worktreeId, parent: null,
  }).then(() => { throw new Error("missing gk pin must refuse"); }, error => error);
  expect(unconfigured).toBeInstanceOf(WorkstreamAdapterError);
  expect(unconfigured).toMatchObject({ code: "grok-unconfigured" });
  expect(readFileSync(admissionsPath, "utf8")).toBe(beforeOpen);

  const unresolvedSources: StoredSourceRecords = { version: 2, cc: f.sources.cc, oc: f.sources.oc, gk: grokSourceRecord(join(f.root, "missing-grok-home")) };
  const unresolvedService = new AdmissionService(f.data, JSON.parse(beforeOpen), unresolvedSources, f.catalog, f.router);
  const unresolved = await unresolvedService.beginGrokCreate({
    sessionId: crypto.randomUUID(), nativeId: crypto.randomUUID(), cwd: f.cwd, workspaceId: f.workspaceId, worktreeId: f.worktreeId,
  }).then(() => { throw new Error("null authority must refuse"); }, error => error);
  expect(unresolved).toMatchObject({ code: "grok-unresolved" });
  expect(String(unresolved.message).toLowerCase()).not.toContain("unconfigured");
  expect(readFileSync(admissionsPath, "utf8")).toBe(beforeOpen);

  const parent = await opened.beginGrokCreate({
    sessionId: crypto.randomUUID(), nativeId: crypto.randomUUID(), cwd: f.cwd, workspaceId: f.workspaceId, worktreeId: f.worktreeId,
    parent: { harness: "cc", authorityId: f.sources.cc.authorityId!, nativeId: crypto.randomUUID() },
  }).then(() => { throw new Error("parent must refuse"); }, error => error);
  expect(parent).toMatchObject({ code: "grok-parent-refused" });
  expect(readFileSync(admissionsPath, "utf8")).toBe(beforeOpen);

  const sessionId = crypto.randomUUID();
  const nativeId = crypto.randomUUID();
  const created = await opened.beginGrokCreate({
    sessionId, nativeId, cwd: f.cwd, workspaceId: f.workspaceId, worktreeId: f.worktreeId, authorityId: f.authority.authorityId, parent: null,
  });
  expect(registers).toBe(0);
  expect(begins).toBe(0);
  expect(routerCalls).toBe(0);
  expect(created.state).toBe("identity_known");
  expect(created.operation).toBe("create");
  expect(created.parent).toBeNull();
  expect(created.nativeId).toBe(nativeId);
  expect(created.source.descriptor.harness).toBe("gk");
  const published = JSON.parse(readFileSync(admissionsPath, "utf8"));
  expect(published.version).toBe(2);
  expect(published.admissions[0]).toEqual(existing);
  expect(published.admissions).toHaveLength(2);
  expect(existsSync(join(f.cwd, ".sane"))).toBe(false);
  const reopenedBytes = readFileSync(admissionsPath, "utf8");
  const reopened = new AdmissionService(f.data, JSON.parse(reopenedBytes), f.sources, f.catalog, f.router);
  expect(readFileSync(admissionsPath, "utf8")).toBe(reopenedBytes);
  for (const call of [() => reopened.register(sessionId), () => reopened.createNative(sessionId, async () => crypto.randomUUID()), () => reopened.enroll(sessionId)] as const) {
    const refused = await call().then(() => { throw new Error("Grok repository operation must refuse"); }, error => error);
    expect(refused).toMatchObject({ status: 501, code: "unsupported-harness-operation" });
  }
  expect(() => reopened.ready(sessionId)).toThrow(WorkstreamAdapterError);
  expect(reopened.get(sessionId)).toMatchObject({ operation: "create", state: "identity_known", nativeId });
  expect(readFileSync(admissionsPath, "utf8")).toBe(reopenedBytes);

  const duplicateSession = await opened.beginGrokCreate({
    sessionId, nativeId: crypto.randomUUID(), cwd: f.cwd, workspaceId: f.workspaceId, worktreeId: f.worktreeId, authorityId: f.authority.authorityId,
  }).then(() => { throw new Error("duplicate session must refuse"); }, error => error);
  const duplicateNative = await opened.beginGrokCreate({
    sessionId: crypto.randomUUID(), nativeId, cwd: f.cwd, workspaceId: f.workspaceId, worktreeId: f.worktreeId, authorityId: f.authority.authorityId,
  }).then(() => { throw new Error("duplicate native id must refuse"); }, error => error);
  expect(duplicateSession).toMatchObject({ code: "admission-exists" });
  expect(duplicateNative).toMatchObject({ code: "admission-exists" });
  expect(JSON.parse(readFileSync(admissionsPath, "utf8")).admissions).toHaveLength(2);
});

test("stop before spawn does not begin or spawn and finishes not submitted", async () => {
  const f = await fixture();
  let calls = 0;
  let begins = 0;
  const before = readFileSync(join(f.data, "admissions.json"), "utf8");
  const original = f.service.beginGrokCreate.bind(f.service);
  f.service.beginGrokCreate = async input => {
    begins += 1;
    return original(input);
  };
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("stop before spawn must not spawn"); };
  const session = sessionFor(f);
  const handle = runGrokTurn(session, request(f, { spawn, prompt: "stop me" }));
  const early = handle.stop();
  expect(early).toMatchObject({ code: "grok-cancelled-before-spawn", nativeCancellation: "not-attempted", killedPid: null, stopped: false });
  const result = await handle.done;
  expect(calls).toBe(0);
  expect(begins).toBe(0);
  expect(result.turn).toBeNull();
  expect(result.observation).toMatchObject({ code: "grok-cancelled-before-spawn", submission: "not-submitted" });
  expect(session.nativeSessionId).toBeUndefined();
  expect(session.blocked).toBe(false);
  expect(readFileSync(join(f.data, "admissions.json"), "utf8")).toBe(before);
  const later = await runGrokTurn(session, request(f, { spawn: finishingSpawn(), prompt: "after early stop" })).done;
  expect(later.observation?.submission).toBe("submitted");
  expect(session.nativeSessionId).toBe(later.nativeSessionId);
});

test("stop during admission preserves a safely retryable original UUID without rejection", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let routerCalls = 0;
  const original = f.service.beginGrokCreate.bind(f.service);
  f.service.beginGrokCreate = async input => {
    started.resolve();
    await release.promise;
    return original(input);
  };
  f.service.register = async () => { routerCalls += 1; throw new Error("register must not be called"); };
  f.router.inspect = async () => { routerCalls += 1; throw new Error("router must not be called"); };
  f.router.forAdmission = async () => { routerCalls += 1; throw new Error("router must not be called"); };
  f.router.initialize = async () => { routerCalls += 1; throw new Error("router must not be called"); };
  f.router.forWorkspace = async () => { routerCalls += 1; throw new Error("router must not be called"); };
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("stop during begin must not spawn"); };
  const session = sessionFor(f);
  const handle = runGrokTurn(session, request(f, { spawn, prompt: "stop during begin" }));
  await started.promise;
  const early = handle.stop();
  expect(early).toMatchObject({ stopped: false, killedPid: null, nativeCancellation: "not-attempted" });
  release.resolve();
  const result = await handle.done;
  expect(calls).toBe(0);
  expect(routerCalls).toBe(0);
  expect(result.turn).toBeNull();
  expect(result.admission?.state).toBe("identity_known");
  expect(result.admission?.error).toBeNull();
  expect(session.nativeSessionId).toBe(handle.nativeSessionId);
  expect(session.blocked).toBe(false);
  expect(f.service.get(session.appSessionId)).toMatchObject({ state: "identity_known", operation: "create", nativeId: handle.nativeSessionId });
  expect(() => runGrokTurn(session, request(f, { kind: "continuation", spawn }))).toThrow(/previously submitted/i);
  expect(calls).toBe(0);
  const reloaded = sessionFor(f, session.appSessionId);
  expect(reloaded.journal.execution?.disposition).toBe("idle");
  const retry = await runGrokTurn(reloaded, request(f, { spawn: finishingSpawn() })).done;
  expect(retry.nativeSessionId).toBe(handle.nativeSessionId);
  expect(retry.observation?.submission).toBe("submitted");
});

test("stop after spawn reports cancellation unproven, blocks continuation, and does not spawn a replacement", async () => {
  const f = await fixture();
  const spawned = Promise.withResolvers<FakeChild>();
  let calls = 0;
  const unrelated = new FakeChild(6262);
  const spawn: GrokSpawn = () => {
    calls += 1;
    const child = new FakeChild(5151);
    spawned.resolve(child);
    return child;
  };
  const session = sessionFor(f);
  const handle = runGrokTurn(session, request(f, { spawn, prompt: "stop me" }));
  const child = await spawned.promise;
  const stopped = handle.stop();
  expect(stopped).toMatchObject({
    stopped: false,
    code: "grok-cancellation-unproven",
    killedPid: 5151,
    nativeCancellation: "unproven",
  });
  expect(child.killed).toBe("SIGTERM");
  expect(unrelated.killed).toBeNull();
  expect(session.blocked).toBe(true);
  const result = await handle.done;
  expect(calls).toBe(1);
  expect(session.nativeSessionId).toBe(handle.nativeSessionId);
  expect(result.turn?.nativeCancellation).toBe("unproven");
  expect(result.observation?.nativeCancellation).toBe("unproven");
  expect(result.observation?.submission).toBe("submitted");
  expect(result.observation?.acceptedMessageId).toBeNull();
  expect(result.observation?.nativeAcceptance).not.toBe("accepted");
  expect(result.owner.contextIdentity?.nativeCommandId).toBeNull();
  expect(() => runGrokTurn(session, request(f, { kind: "continuation", spawn, prompt: "do not resume" }))).toThrow(/blocked/i);
  expect(calls).toBe(1);
});

test("an explicit later executable may continue, but a changed home cannot rebind the native UUID", async () => {
  const f = await fixture();
  const calls: { argv: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
  const spawn: GrokSpawn = (argv, options) => {
    calls.push({ argv, env: options.env });
    const child = new FakeChild(4500 + calls.length);
    queueMicrotask(() => { if (child.killed === null) child.finish(0); });
    return child;
  };
  const session = sessionFor(f);
  await runGrokTurn(session, request(f, { spawn })).done;
  const later = join(f.root, "inert-later");
  writeFileSync(later, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await runGrokTurn(session, request(f, { kind: "continuation", spawn, executable: later })).done;
  expect(calls[0]?.argv[0]).toBe(f.executable);
  expect(calls[1]?.argv[0]).toBe(later);
  expect(calls[0]?.env.GROK_HOME).toBe(f.authority.descriptor.homeRoot);
  expect(calls[1]?.env.GROK_HOME).toBe(f.authority.descriptor.homeRoot);
  const changed = grokSourceRecord(f.cwd);
  expect(() => runGrokTurn(session, request(f, { kind: "continuation", spawn, authority: changed }))).toThrow(/original captured/i);
  expect(calls).toHaveLength(2);
});

test("new create admission refuses an authority that does not match the configured pin", async () => {
  const f = await fixture();
  let begins = 0;
  let calls = 0;
  const admissions = {
    get: f.service.get.bind(f.service),
    getGrokCreate: f.service.getGrokCreate.bind(f.service),
    getGrokSourcePin: f.service.getGrokSourcePin.bind(f.service),
    beginGrokCreate: async (input: Parameters<AdmissionService["beginGrokCreate"]>[0]) => { begins += 1; return f.service.beginGrokCreate(input); },
  };
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("mismatched authority must not spawn"); };
  const handle = runGrokTurn(sessionFor(f), request(f, {
    spawn,
    admissions,
    authority: { descriptor: f.authority.descriptor, authorityId: `sane-native-v1:gk:${"cd".repeat(32)}` },
  }));
  const error = await handle.done.then(() => { throw new Error("mismatched authority must refuse"); }, caught => caught);
  expect(error).toBeInstanceOf(WorkstreamAdapterError);
  expect(String(error.message)).toMatch(/authority/i);
  expect(begins).toBe(1);
  expect(calls).toBe(0);
  expect(handle.session.nativeSessionId).toBeUndefined();
});

test("a changed configured home after admission refuses launch without poisoning a known-unsubmitted reservation", async () => {
  const f = await fixture();
  let calls = 0;
  const authority = { descriptor: { ...f.authority.descriptor }, authorityId: f.authority.authorityId };
  const original = f.service.beginGrokCreate.bind(f.service);
  f.service.beginGrokCreate = async input => {
    const admitted = await original(input);
    renameSync(f.home, `${f.home}-original`);
    symlinkSync(f.cwd, f.home);
    return admitted;
  };
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("changed home must not spawn"); };
  const session = sessionFor(f);
  const error = await runGrokTurn(session, request(f, { spawn, authority })).done.then(() => { throw new Error("changed home must refuse"); }, caught => caught);
  expect(error).toBeInstanceOf(GrokSendRefusal);
  expect(String(error.message)).toMatch(/pinned home.*(?:changed|normalized)/i);
  expect(calls).toBe(0);
  expect(session.nativeSessionId).toBeDefined();
  expect(session.blocked).toBe(false);
  expect(f.service.get(session.appSessionId)).toMatchObject({ state: "identity_known", operation: "create" });
  const originalId = session.nativeSessionId!;
  rmSync(f.home);
  renameSync(`${f.home}-original`, f.home);
  const retry = await runGrokTurn(session, request(f, { spawn: finishingSpawn() })).done;
  expect(retry.nativeSessionId).toBe(originalId);
});

test("a second session object sees prior turns and continues the same native id", async () => {
  const f = await fixture();
  const appSessionId = crypto.randomUUID();
  const calls: { argv: readonly string[] }[] = [];
  const spawn: GrokSpawn = argv => {
    calls.push({ argv });
    const child = new FakeChild(4600 + calls.length);
    queueMicrotask(() => { if (child.killed === null) child.finish(0); });
    return child;
  };
  const first = sessionFor(f, appSessionId);
  const created = await runGrokTurn(first, request(f, { spawn, prompt: "remember me" })).done;
  const again = createGrokSendSession({ appSessionId, captureDirectory: f.capture, promptDirectory: f.capture });
  expect(again.turnIndex).toBe(1);
  expect(again.journal.turns).toHaveLength(1);
  expect(again.journal.turns[0]?.prompt).toBe("remember me");
  expect(again.nativeSessionId).toBe(created.nativeSessionId);
  expect(again.blocked).toBe(false);
  await runGrokTurn(again, request(f, { kind: "continuation", spawn, prompt: "still here" })).done;
  expect(calls[1]?.argv).toContain("--resume");
  expect(calls[1]?.argv[calls[1]!.argv.indexOf("--resume") + 1]).toBe(created.nativeSessionId);
  expect(again.turnIndex).toBe(2);
  const reloaded = createGrokSendSession({ appSessionId, captureDirectory: f.capture, promptDirectory: f.capture });
  expect(reloaded.journal.turns).toHaveLength(2);
  expect(reloaded.turnIndex).toBe(2);
});

test("a reloaded session stays blocked after an unproven cancel", async () => {
  const f = await fixture();
  const appSessionId = crypto.randomUUID();
  const spawned = Promise.withResolvers<FakeChild>();
  const spawn: GrokSpawn = () => {
    const child = new FakeChild(4701);
    spawned.resolve(child);
    return child;
  };
  const session = sessionFor(f, appSessionId);
  const handle = runGrokTurn(session, request(f, { spawn, prompt: "kill me" }));
  await spawned.promise;
  handle.stop();
  await handle.done;
  const again = createGrokSendSession({ appSessionId, captureDirectory: f.capture, promptDirectory: f.capture });
  expect(again.journal.turns).toHaveLength(1);
  expect(again.journal.turns[0]?.nativeCancellation).toBe("unproven");
  expect(again.blocked).toBe(true);
  expect(again.turnIndex).toBe(1);
  expect(() => runGrokTurn(again, request(f, { kind: "continuation", spawn }))).toThrow(/blocked/i);
});

test("tool-boundary refusal blocks continuation and is not success", async () => {
  const f = await fixture();
  let calls = 0;
  const spawn: GrokSpawn = () => {
    calls += 1;
    const child = new FakeChild(4801);
    queueMicrotask(() => {
      child.stdout.write(`${JSON.stringify({ type: "tool_use", id: "toolu_1" })}\n`);
      if (child.killed === null) child.finish(0);
    });
    return child;
  };
  const session = sessionFor(f);
  const error = await runGrokTurn(session, request(f, { spawn, prompt: "use a tool" })).done.then(() => { throw new Error("tool boundary must throw"); }, caught => caught);
  expect(error).toBeInstanceOf(GrokDispatchRefusal);
  expect(error).toMatchObject({ code: "grok-tool-boundary" });
  expect(session.blocked).toBe(true);
  expect(session.nativeSessionId).toBeDefined();
  expect(() => runGrokTurn(session, request(f, { kind: "continuation", spawn }))).toThrow(/blocked/i);
  expect(calls).toBe(1);
  const journal = JSON.parse(readFileSync(join(f.capture, grokCaptureFilename(session.appSessionId)), "utf8"));
  expect(journal.turns[0].nativeAcceptance).toBe("unknown");
  expect(journal.turns[0].acceptedMessageId).toBeNull();
  expect(journal.turns[0].nativeCancellation).toBe("unproven");
});

test("timeout observation blocks continuation and does not auto-continue", async () => {
  const f = await fixture();
  let calls = 0;
  const spawn: GrokSpawn = () => {
    calls += 1;
    return new FakeChild(4901);
  };
  const session = sessionFor(f);
  const result = await runGrokTurn(session, request(f, { spawn, prompt: "wait", timeoutMs: 30 })).done;
  expect(result.observation?.code).toBe("grok-cancellation-unproven");
  expect(result.observation?.nativeCancellation).toBe("unproven");
  expect(result.observation?.nativeAcceptance).not.toBe("accepted");
  expect(result.observation?.acceptedMessageId).toBeNull();
  expect(session.blocked).toBe(true);
  expect(session.nativeSessionId).toBe(result.nativeSessionId);
  expect(() => runGrokTurn(session, request(f, { kind: "continuation", spawn }))).toThrow(/blocked/i);
  expect(calls).toBe(1);
});

test("capture failure after a submitted turn blocks and keeps the original error", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  const spawn: GrokSpawn = () => {
    chmodSync(f.capture, 0o500);
    const child = new FakeChild(5001);
    queueMicrotask(() => { if (child.killed === null) child.finish(0); });
    return child;
  };
  try {
    const error = await runGrokTurn(session, request(f, { spawn, prompt: "keep this error" })).done.then(() => { throw new Error("persist must throw"); }, caught => caught);
    expect(error).toMatchObject({ code: "EACCES" });
    expect(String(error.message)).not.toMatch(/duplicate turn/i);
    expect(session.blocked).toBe(true);
    expect(session.nativeSessionId).toBeDefined();
    expect(session.journal.turns).toHaveLength(1);
    expect(existsSync(join(f.capture, grokCaptureFilename(session.appSessionId)))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.capture, grokCaptureFilename(session.appSessionId)), "utf8")).execution.disposition).toBe("pending");
    expect(sessionFor(f, session.appSessionId).blocked).toBe(true);
    expect(() => runGrokTurn(session, request(f, { kind: "continuation", spawn }))).toThrow(/blocked/i);
  } finally {
    chmodSync(f.capture, 0o700);
  }
});

test("no metadata.json run and no receipt file is written", async () => {
  const f = await fixture();
  const before = listing(f.data);
  const sourcesBefore = readFileSync(join(f.data, "sources.json"), "utf8");
  const metadataBefore = readFileSync(join(f.data, "metadata.json"), "utf8");
  const spawn: GrokSpawn = () => {
    const child = new FakeChild(4401);
    queueMicrotask(() => { if (child.killed === null) child.finish(0); });
    return child;
  };
  const result = await runGrokTurn(sessionFor(f), request(f, { spawn, prompt: "no receipt" })).done;
  const after = listing(f.data);
  expect(after.filter(name => name !== "admissions.json")).toEqual(before.filter(name => name !== "admissions.json"));
  expect(readFileSync(join(f.data, "sources.json"), "utf8")).toBe(sourcesBefore);
  expect(readFileSync(join(f.data, "metadata.json"), "utf8")).toBe(metadataBefore);
  const metadata = JSON.parse(metadataBefore);
  expect(metadata.runs).toEqual([]);
  expect(metadata.sessions).toEqual([]);
  expect(existsSync(join(f.data, "app-admissions"))).toBe(false);
  expect(after.some(name => name.toLowerCase().includes("receipt"))).toBe(false);
  expect(result.admission?.state).toBe("identity_known");
  expect(result.admission?.state).not.toBe("ready");
});

test("local executable and prompt preparation finish before admission and failures do not poison the App session", async () => {
  const f = await fixture();
  let begins = 0;
  let calls = 0;
  const original = f.service.beginGrokCreate.bind(f.service);
  f.service.beginGrokCreate = async input => {
    begins += 1;
    const prompts = readdirSync(f.capture).filter(name => name.endsWith(".prompt.txt"));
    expect(prompts).toHaveLength(1);
    expect(readFileSync(join(f.capture, prompts[0]!), "utf8")).toBe("prepared prompt");
    return original(input);
  };
  const spawn: GrokSpawn = () => { calls += 1; throw new Error("bad preparation must not spawn"); };
  const session = sessionFor(f);
  await expect(runGrokTurn(session, request(f, { executable: join(f.root, "missing-executable"), spawn })).done).rejects.toThrow(/executable/i);
  expect(session.blocked).toBe(false);
  expect(session.owner).toBeUndefined();
  const badDirectory = createGrokSendSession({ appSessionId: session.appSessionId, captureDirectory: f.capture, promptDirectory: join(f.root, "missing-prompt-dir") });
  await expect(runGrokTurn(badDirectory, request(f, { spawn })).done).rejects.toBeInstanceOf(GrokSendRefusal);
  expect(badDirectory.blocked).toBe(false);
  expect(begins).toBe(0);
  expect(calls).toBe(0);
  expect(f.service.get(session.appSessionId)).toBeUndefined();
  const result = await runGrokTurn(session, request(f, { spawn: finishingSpawn(), prompt: "prepared prompt" })).done;
  expect(begins).toBe(1);
  expect(result.observation?.submission).toBe("submitted");
});

test("exclusive owner blocks concurrent turns and independently loaded same-id sessions before another process", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  const duplicate = sessionFor(f, session.appSessionId);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let begins = 0, calls = 0;
  const original = f.service.beginGrokCreate.bind(f.service);
  f.service.beginGrokCreate = async input => { begins += 1; started.resolve(); await release.promise; return original(input); };
  const spawn: GrokSpawn = argv => { calls += 1; return finishingSpawn()(argv, { cwd: f.cwd, env: {}, stdio: ["ignore", "pipe", "pipe"] }); };
  const handle = runGrokTurn(session, request(f, { spawn }));
  const owned = session.owner!;
  let processingFinished = false;
  void owned.done.then(() => { processingFinished = true; });
  expect(owned.run.status).toBe("running");
  expect(owned.settled).toBe(false);
  expect(() => runGrokTurn(session, request(f, { spawn }))).toThrow(/owns/i);
  expect(() => runGrokTurn(duplicate, request(f, { spawn }))).toThrow(/owns/i);
  await started.promise;
  expect(processingFinished).toBe(false);
  expect(calls).toBe(0);
  release.resolve();
  await handle.done;
  await owned.done;
  expect(processingFinished).toBe(true);
  expect(owned.settled).toBe(true);
  expect(owned.run.status).toBe("completed");
  expect(session.owner).toBeUndefined();
  expect(begins).toBe(1);
  expect(calls).toBe(1);
});

test("continuations refuse original descriptor, configured pin, admission identity, and execution-binding drift", async () => {
  for (const changed of ["request-home", "pin", "admission-home", "admission-native", "admission-authority", "cwd", "workspace", "worktree"] as const) {
    const f = await fixture();
    const session = sessionFor(f);
    let calls = 0;
    const spawn = finishingSpawn(() => { calls += 1; });
    await runGrokTurn(session, request(f, { spawn })).done;
    const getAdmission = f.service.getGrokCreate.bind(f.service);
    if (changed.startsWith("admission-")) f.service.getGrokCreate = id => {
      const value = getAdmission(id)!;
      if (changed === "admission-home") value.source.descriptor.homeRoot = f.cwd;
      if (changed === "admission-native") value.nativeId = crypto.randomUUID();
      if (changed === "admission-authority") value.source.authorityId = `sane-native-v1:gk:${"ef".repeat(32)}`;
      return value;
    };
    if (changed === "pin") f.service.getGrokSourcePin = () => grokSourceRecord(f.cwd);
    const continuation = request(f, {
      kind: "continuation", spawn,
      ...(changed === "request-home" ? { authority: { ...f.authority, descriptor: { ...f.authority.descriptor, homeRoot: f.cwd } } } : {}),
      ...(changed === "cwd" ? { cwd: f.root } : {}),
      ...(changed === "workspace" ? { workspaceId: "another-workspace" } : {}),
      ...(changed === "worktree" ? { worktreeId: "another-worktree" } : {}),
    });
    await expect(runGrokTurn(session, continuation).done).rejects.toBeInstanceOf(GrokSendRefusal);
    expect(calls).toBe(1);
    expect(session.journal.turns).toHaveLength(1);
    expect(session.nativeSessionId).toBe(session.journal.turns[0]!.nativeSessionId);
  }
});

test("an admission without durable execution evidence is never replayed as a new create", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  await f.service.beginGrokCreate({ sessionId: session.appSessionId, nativeId: crypto.randomUUID(), cwd: f.cwd, workspaceId: f.workspaceId, worktreeId: f.worktreeId, authorityId: f.authority.authorityId });
  let calls = 0;
  await expect(runGrokTurn(session, request(f, { spawn: finishingSpawn(() => { calls += 1; }) })).done).rejects.toThrow(/no durable execution evidence/i);
  expect(calls).toBe(0);
  expect(session.journal.execution).toBeUndefined();
});

test("pending identity reloads before close, and an uncertain spawn durably blocks without rejecting admission", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  const failure = Object.assign(new Error("injected spawn might already have executed"), { code: "EACCES" });
  const spawn: GrokSpawn = () => {
    const pending = sessionFor(f, session.appSessionId);
    expect(pending.journal.execution?.disposition).toBe("pending");
    expect(pending.nativeSessionId).toBe(session.nativeSessionId);
    expect(pending.blocked).toBe(true);
    throw failure;
  };
  const handle = runGrokTurn(session, request(f, { spawn }));
  await expect(handle.done).rejects.toMatchObject({ code: "grok-spawn-uncertain", cause: failure });
  const reloaded = sessionFor(f, session.appSessionId);
  expect(reloaded.journal.turns).toHaveLength(0);
  expect(reloaded.journal.execution?.disposition).toBe("blocked");
  expect(reloaded.nativeSessionId).toBe(handle.nativeSessionId);
  expect(reloaded.blocked).toBe(true);
  expect(f.service.getGrokCreate(session.appSessionId)?.state).toBe("identity_known");
  expect(JSON.parse(readFileSync(join(f.data, "admissions.json"), "utf8")).admissions[0].state).toBe("identity_known");
  expect(() => runGrokTurn(reloaded, request(f, { spawn }))).toThrow(/blocked/i);
});

test("capture failure keeps durable pending, unsaved raw buffers, and the original execution error", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  const original = new Error("child failed first");
  const spawn: GrokSpawn = () => {
    const child = new FakeChild(9601);
    queueMicrotask(() => {
      child.stdout.write("unsaved raw evidence\n");
      chmodSync(f.capture, 0o500);
      child.emit("error", original);
    });
    return child;
  };
  try {
    await expect(runGrokTurn(session, request(f, { spawn })).done).rejects.toBe(original);
    expect(session.blocked).toBe(true);
    expect(Buffer.concat(session.stdoutChunks).toString()).toContain("unsaved raw evidence");
    const reloaded = sessionFor(f, session.appSessionId);
    expect(reloaded.journal.execution?.disposition).toBe("pending");
    expect(reloaded.blocked).toBe(true);
  } finally { chmodSync(f.capture, 0o700); }
});

test("fully closed durable captures release consumed buffers without changing raw journal evidence", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  const result = await runGrokTurn(session, request(f, { spawn: finishingSpawn(child => { child.stdout.write("raw stdout\n"); child.stderr.write("raw stderr\n"); }) })).done;
  expect(session.stdoutChunks).toHaveLength(0);
  expect(session.stderrChunks).toHaveLength(0);
  expect(result.turn).toMatchObject({ stdout: "raw stdout\n", stderr: "raw stderr\n", nativeAcceptance: "unknown", acceptedMessageId: null });
  if (!result.turn) throw new Error("Expected a submitted capture turn");
  expect(sessionFor(f, session.appSessionId).journal.turns[0]).toEqual(result.turn);
});

test("a nonzero closed wrapper durably blocks without claiming native acceptance", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  const child = new FakeChild(9651);
  let calls = 0;
  const spawn: GrokSpawn = () => {
    calls++;
    queueMicrotask(() => child.finish(23, null, current => current.stderr.write("opaque native failure\n")));
    return child;
  };
  const result = await runGrokTurn(session, request(f, { spawn })).done;
  expect(result.observation).toMatchObject({ submission: "submitted", wrapperCompletion: "closed", exitCode: 23,
    nativeAcceptance: "unknown", acceptedMessageId: null, nativeCancellation: "not-attempted" });
  expect(result.owner.run.status).toBe("failed");
  expect(child.killed).toBeNull();
  const reloaded = sessionFor(f, session.appSessionId);
  expect(reloaded.journal.execution?.disposition).toBe("blocked");
  expect(reloaded.journal.turns[0]).toMatchObject({ exitCode: 23, stderr: "opaque native failure\n", nativeAcceptance: "unknown", acceptedMessageId: null });
  expect(() => runGrokTurn(reloaded, request(f, { kind: "continuation", spawn }))).toThrow(/blocked/i);
  expect(calls).toBe(1);
});

test("incomplete close settles failed processing but retains ownership, buffers, and explicit Stop reachability", async () => {
  const f = await fixture();
  const session = sessionFor(f);
  const child = new FakeChild(9701);
  const unrelated = new FakeChild(9702);
  const signals: Array<NodeJS.Signals | number> = [];
  child.kill = signal => { signals.push(signal ?? "SIGTERM"); return true; };
  const spawn: GrokSpawn = () => { queueMicrotask(() => child.stdout.write("incomplete prefix\n")); return child; };
  const handle = runGrokTurn(session, request(f, { spawn, timeoutMs: 0 }));
  const owned = session.owner!;
  await expect(handle.done).rejects.toMatchObject({ code: "grok-wrapper-close-incomplete" });
  await owned.done;
  expect(owned.settled).toBe(true);
  expect(owned.run.status).toBe("failed");
  expect(owned.streamsDrained).toBe(false);
  expect(session.owner).toBe(owned);
  expect(session.blocked).toBe(true);
  expect(Buffer.concat(session.stdoutChunks).toString()).toContain("incomplete prefix");
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(handle.stop()).toMatchObject({ code: "grok-cancellation-unproven", killedPid: 9701, stopped: false });
  expect(signals).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
  expect(unrelated.killed).toBeNull();
  const reloaded = sessionFor(f, session.appSessionId);
  expect(reloaded.blocked).toBe(true);
  expect(reloaded.journal.execution?.disposition).toBe("blocked");
  expect(() => runGrokTurn(reloaded, request(f, { kind: "continuation", spawn }))).toThrow(/owns|blocked/i);
  child.stdout.write("late after incomplete\n");
  child.emitClose(null, "SIGKILL");
  expect(Buffer.concat(session.stdoutChunks).toString()).toContain("late after incomplete");
  expect(handle.stop()).toMatchObject({ code: "grok-stop-refused", killedPid: null });
});
