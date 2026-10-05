/** Offline fake 2.0.21 transport only. Test descriptors do NOT qualify a runtime. */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEventDurable, SessionLogOutput } from "@opencode/client";
import { atomicAppRecord, type Admission } from "./app-store";
import type { Event, Run, Session } from "./history";
import type { OpenCodeReplyTransport } from "./opencode";
import { OpenCodeReplyBindings, type OpenCodeReplyBindingRecord } from "./opencode-reply-bindings";
import { OC_REPLY_ACTIVATION_BLOCKED, OpenCodeReplyIntegration, type OpenCodeReplyIntegrationOptions } from "./opencode-reply-integration";
import { OC_REPLY_QUALIFICATION_CHECKS, OpenCodeReplyObserver, type OpenCodeReplyCheckpoint, type OpenCodeReplyCommit, type OpenCodeReplyQualification, type OpenCodeReplyRegistration } from "./opencode-reply-observer";
import { ConversationUpdateStore, type UpdateJson } from "./conversation-update-store";
import { ConversationUpdates, nativeUpdateCheckpointKey, type NativeConversationUpdateBatch } from "./conversation-updates";
import { initialOpenCodeReplyState, openCodeIncarnation, reduceOpenCodeReply } from "../shared/conversation/oc-reply-reducer";
import { updateOccurrenceId, updateSourceKey, type ConversationUpdateCandidate } from "../shared/conversation/conversation-updates";

const TEMP = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const createdAt = Date.parse("2026-10-01T00:00:00Z"), now = new Date(createdAt).toISOString(), nativeVersion = "2.0.21";
const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
const fixtures: { dir: string; close: () => Promise<void> }[] = [];
function qualification(authorityId = "fake-authority"): OpenCodeReplyQualification {
  return { authorityId, clientVersion: "2.0.18", nativeVersion, verifiedAt: now, evidenceRef: "fake-only:not-runtime-qualification",
    checks: Object.fromEntries(OC_REPLY_QUALIFICATION_CHECKS.map(k => [k, { passed: true, evidenceRef: `fake-only:${k}` }])) as OpenCodeReplyQualification["checks"] };
}
function parent(index = 0): Session {
  return { sessionId: `app_${index}`, harness: "opencode", authorityId: "fake-authority", nativeSessionId: `ses_${index}`, cwd: "/fixture", lastStatus: "unknown", lastRunId: null };
}
function admission(session: Session): Admission {
  return { version: 1, sessionId: session.sessionId, requestId: `admission_${session.sessionId}`, operation: "enroll", state: "ready", parent: null, nativeId: session.nativeSessionId!, createdAt: now, error: null,
    source: { authorityId: session.authorityId!, descriptor: { version: 1, harness: "oc", kind: "local-registration", registrationFile: "/fixture/never-opened.json" } },
    binding: { workspaceId: "workspace", worktreeId: "worktree", bindingRevision: "binding_1", executionCheckout: session.cwd, checkoutPin: null, domain: { mode: "app-only" } } };
}
function savedBinding(session = parent(), fence = 6): OpenCodeReplyBindingRecord {
  const creation = { eventId: `evt_created_${session.nativeSessionId}`, createdAt };
  return { version: 1, conversationId: session.sessionId, source: { harness: "opencode", authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId!, incarnation: openCodeIncarnation(creation) },
    creation, initialBaselineThrough: fence, registrationRevision: `registration_${session.sessionId}`, nativeVersion };
}
function durable(b: OpenCodeReplyRegistration, seq: number, type: SessionEventDurable["type"], data: Record<string, unknown> = {}): SessionEventDurable {
  return { id: seq === 0 ? b.creation.eventId : `evt_${b.source.nativeSessionId}_${seq}`, created: createdAt + seq, type,
    durable: { aggregateID: b.source.nativeSessionId, seq, version: 1 }, data: { sessionID: b.source.nativeSessionId, ...data } } as unknown as SessionEventDurable;
}
const creation = (b: OpenCodeReplyRegistration) => durable(b, 0, "session.created", { projectID: "project", location: { directory: "/fixture" }, slug: "fake", version: nativeVersion }) as Extract<SessionEventDurable, { type: "session.created" }>;
function reply(b: OpenCodeReplyRegistration, after = 0, messageId = "msg_reply"): SessionEventDurable[] {
  return [durable(b, after + 1, "session.execution.started"),
    durable(b, after + 2, "session.step.started", { assistantMessageID: messageId, started: createdAt, agent: "build", model: { providerID: "fake", id: "fake" } }),
    durable(b, after + 3, "session.text.started", { assistantMessageID: messageId, ordinal: 0 }),
    durable(b, after + 4, "session.text.ended", { assistantMessageID: messageId, ordinal: 0, text: "Fake reply" }),
    durable(b, after + 5, "session.step.ended", { assistantMessageID: messageId, finish: "stop", cost: 0, tokens }),
    durable(b, after + 6, "session.execution.succeeded")];
}
const synced = (b: OpenCodeReplyRegistration, seq = 6): SessionLogOutput => ({ type: "log.synced", aggregateID: b.source.nativeSessionId, seq });
function checkpoint(b: OpenCodeReplyRegistration, events: SessionEventDurable[] = [creation(b)], certifiedThrough: number | null = events.at(-1)!.durable.seq): OpenCodeReplyCheckpoint {
  let state = initialOpenCodeReplyState(b);
  for (const event of events) state = reduceOpenCodeReply(state, event, b).state;
  return { version: 2, sourceKey: updateSourceKey(b.source), nativeVersion, progressThrough: state.seq, certifiedThrough, initialBaselineThrough: b.initialBaselineThrough, state };
}
function aborted(signal: AbortSignal) { return new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); }); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function pending<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { await new Promise<void>(r => setImmediate(r)); }
async function until(ready: () => boolean) { for (let i = 0; i < 5000; i++) { if (ready()) return; await tick(); } throw new Error("Fake integration checkpoint not reached"); }
function fixture(patch: Partial<OpenCodeReplyIntegrationOptions> = {}, rows?: unknown[]) {
  const dir = mkdtempSync(join(TEMP, "oc-reply-integration-test-")), path = join(dir, "opencode-reply-bindings.json");
  if (rows) writeFileSync(path, JSON.stringify({ version: 1, bindings: rows }));
  const sessions = [parent()], admissions = new Map(sessions.map(s => [s.sessionId, admission(s)])), runs: Run[] = [], journals = new Map<string, Event[]>();
  const calls = { transport: 0, events: 0, session: 0, logs: [] as { input: { sessionID: string; after?: number; follow?: boolean }; signal: AbortSignal }[], batches: [] as NativeConversationUpdateBatch[], lifecycle: [] as string[] };
  const logs = new Map<string, SessionEventDurable[]>(sessions.map(s => { const b = savedBinding(s); return [s.nativeSessionId!, [creation(b), ...reply(b)]]; }));
  let fence = 6, closing = false;
  let logOverride: ((input: { sessionID: string; after?: number; follow?: boolean }, signal: AbortSignal) => AsyncIterable<SessionLogOutput>) | undefined;
  const transport: OpenCodeReplyTransport = {
    async info() { return { version: nativeVersion, pid: 1, urls: [], paths: { tmp: "/fixture" } }; },
    async session({ sessionID }) { calls.session++; return { id: sessionID, slug: "fake", version: nativeVersion, projectID: "project", cost: 0, tokens, time: { created: createdAt, updated: createdAt }, location: { directory: "/fixture" } }; },
    async *events(options) { calls.events++; try { await aborted(options!.signal!); } finally { calls.lifecycle.push("events-exited"); } },
    async *log(input, options) {
      const signal = options!.signal!; calls.logs.push({ input: { ...input }, signal });
      expect(input.follow).toBe(false);
      if (logOverride) { yield* logOverride(input, signal); return; }
      const b = savedBinding(sessions.find(s => s.nativeSessionId === input.sessionID) ?? parent());
      if (input.after === Number.MAX_SAFE_INTEGER) { yield synced(b, fence); return; }
      for (const e of logs.get(input.sessionID) ?? []) if (input.after === undefined || e.durable.seq > input.after) yield e;
      yield synced(b, logs.get(input.sessionID)?.at(-1)?.durable.seq ?? 0);
    },
  };
  const bindings = new OpenCodeReplyBindings(dir, (root, name, next) => { atomicAppRecord(root, name, next); calls.lifecycle.push("binding-saved"); });
  const store = new ConversationUpdateStore(dir, "fake-store", { now: () => now }); expect(store.load()).toBe(true);
  let integration: OpenCodeReplyIntegration;
  const updates = new ConversationUpdates(store, { coverage: () => integration.coverage(), bootstrap: () => ({ activeRunIds: runs.filter(r => r.status === "running").map(r => r.runId), sourceBaselines: integration.sourceBaselines() }) });
  const original = updates.upsertNativeBatch.bind(updates);
  updates.upsertNativeBatch = async (batch, guard) => { calls.batches.push(structuredClone(batch)); calls.lifecycle.push("native-commit"); return original(batch, guard); };
  const options: OpenCodeReplyIntegrationOptions = { dataDir: dir, authorities: [{ authorityId: "fake-authority", qualification: qualification(), adapter: { async replyTransport() { calls.transport++; return transport; } } }],
    sessions: () => sessions, runs: () => runs, events: id => journals.get(id) ?? [], admission: id => admissions.get(id), isWorker: () => false,
    isClosing: () => closing, isCurrent: (id, source) => sessions.some(s => s.sessionId === id && s.authorityId === source.authorityId && s.nativeSessionId === source.nativeSessionId), store, updates, bindings, ...patch };
  integration = new OpenCodeReplyIntegration(options);
  const f = { dir, path, sessions, admissions, runs, journals, calls, logs, transport, bindings, store, updates, options, integration,
    setFence: (n: number) => { fence = n; }, setLog: (v: typeof logOverride) => { logOverride = v; }, setClosing: () => { closing = true; },
    ready: () => integration.coverage().some(c => c.state === "ready"), cp: () => store.getCheckpoint(nativeUpdateCheckpointKey(integration.updateSource("app_0") ?? savedBinding().source)),
    async close() { await integration.close(); calls.lifecycle.push("integration-closed"); await updates.close(); calls.lifecycle.push("store-closed"); } };
  fixtures.push(f); return f;
}
afterEach(async () => { for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.dir, { recursive: true, force: true }); } });

for (const size of [1, 128, 1024]) test(`disabled metadata/journal hooks do no duplicate parse or catalog scans (${size} parents)`, async () => {
  const f = fixture({ allowQualifiedActivation: false }), marker = `disabled-metadata-fixture-${size}`;
  while (f.sessions.length < size) f.sessions.push(parent(f.sessions.length));
  const counts = { sessions: 0, runs: 0, admission: 0, worker: 0, current: 0, parse: 0 };
  f.options.sessions = () => { counts.sessions++; return f.sessions; };
  f.options.runs = () => { counts.runs++; return f.runs; };
  f.options.admission = id => { counts.admission++; return f.admissions.get(id); };
  f.options.isWorker = () => { counts.worker++; return false; };
  f.options.isCurrent = () => { counts.current++; return true; };
  const snapshot = JSON.stringify({ version: 1, sessions: f.sessions.map(s => ({ ...s, title: marker })), runs: [], reconciliationRequired: false });
  const parse = JSON.parse;
  const parsing = spyOn(JSON, "parse").mockImplementation((raw, reviver) => { if (raw.includes(marker)) counts.parse++; return parse(raw, reviver); });
  try {
    f.integration.start(); expect(f.integration.hasQualifiedAuthorities()).toBe(false);
    const r = run(), s = f.sessions[0]!;
    for (let seq = 1; seq <= 32; seq++) {
      f.integration.metadataPublished(snapshot); f.integration.requestRefresh(); f.integration.refresh();
      expect(await f.updates.ingestCommitted(s, r, message(r, "assistant", `msg_primary_${seq}`, seq))).toBe(true);
    }
    expect(await f.updates.ingestCommitted(s, r, { ...message(r, "assistant", "msg_terminal", 33), kind: "status", data: { status: "failed" } })).toBe(true);
    await tick();
    expect(counts).toEqual({ sessions: 0, runs: 0, admission: 0, worker: 0, current: 0, parse: 0 });
    expect(f.store.getCheckpoints()).toHaveLength(1); expect(f.store.getCheckpoints()[0]!.through).toBe(33);
    expect(f.store.page().updates).toHaveLength(1); expect(f.store.page().updates[0]).toMatchObject({ kind: "failed", runId: r.runId, legacyRunId: r.runId });
    expect(f.calls.transport).toBe(0);
  } finally { parsing.mockRestore(); }
});

for (const gate of [undefined, false]) test(`trusted fake descriptor with gate=${gate} never opens native or exports old ready coverage/checkpoints/baselines`, async () => {
  const b = savedBinding(), f = fixture({ allowQualifiedActivation: gate }, [b]);
  const cp = checkpoint(b, [creation(b), ...reply(b)]);
  expect(await f.updates.upsertNativeBatch({ source: b.source, through: 6, state: cp as unknown as UpdateJson, baselineThrough: 6, candidates: [], coverage: { sourceKey: cp.sourceKey, state: "ready", through: 6, baselineThrough: 6 } })).toBe(true);
  f.calls.batches.length = 0; f.integration.start(); f.integration.refresh(); await tick();
  expect(f.calls.transport).toBe(0); expect(f.calls.events).toBe(0); expect(f.calls.logs).toEqual([]); expect(f.calls.batches).toEqual([]);
  expect(f.integration.updateSource("app_0")).toBeUndefined(); expect(f.integration.sourceBaselines()).toEqual([]);
  expect(f.integration.coverage().map(c => c.state)).toEqual(["unqualified", "unqualified"]);
  expect(f.integration.coverage().every(c => c.reason === OC_REPLY_ACTIVATION_BLOCKED && c.through === undefined && c.baselineThrough === undefined)).toBe(true);
  expect((await f.updates.page({}, true)).bootstrap!.sourceBaselines).toEqual([]);
  expect(f.cp()!.state).toEqual(cp); // Existing evidence is retained, not qualified or rewritten.
});

test("explicit fake-only activation pins verified head before observer exposure; historical fence is not publication-time or replay certification", async () => {
  const f = fixture({ allowQualifiedActivation: true }); f.setFence(6);
  const b = savedBinding(); f.logs.get("ses_0")!.push(...reply(b, 6, "msg_live"));
  f.integration.start(); await until(f.ready);
  expect(f.bindings.get("app_0")).toMatchObject({ creation: b.creation, initialBaselineThrough: 6, nativeVersion });
  expect(f.calls.logs[0]!.input).toEqual({ sessionID: "ses_0", after: Number.MAX_SAFE_INTEGER, follow: false });
  expect(f.calls.logs[1]!.input).toEqual({ sessionID: "ses_0", follow: false }); expect(Object.hasOwn(f.calls.logs[1]!.input, "after")).toBe(false);
  expect(f.calls.logs[1]!.signal.aborted).toBe(true); // Creation probe is aborted after identity evidence.
  expect(f.calls.lifecycle.indexOf("binding-saved")).toBeLessThan(f.calls.lifecycle.indexOf("native-commit"));
  expect(f.store.page().updates).toHaveLength(2); expect(f.store.page().updates[0]!.historical).toBe(true); expect(f.store.page().updates[1]!.historical).toBeUndefined();
  expect(f.cp()!.state).toMatchObject({ version: 2, progressThrough: 12, certifiedThrough: 12, initialBaselineThrough: 6, state: { identityLedger: "external", seq: 12 } });
  expect(f.store.hasNativeMessage(updateSourceKey(b.source), "msg_reply")).toBe(true); expect(f.store.hasNativeMessage(updateSourceKey(b.source), "msg_live")).toBe(true);
  expect((await f.updates.page({}, true)).bootstrap!.sourceBaselines).toEqual([{ sourceKey: updateSourceKey(b.source), through: 6 }]);
  await f.integration.close(); const oldHead = f.store.getHead(), oldBinding = f.bindings.get("app_0")!, reads = f.calls.logs.length;
  const restarted = new OpenCodeReplyIntegration(f.options);
  try {
    restarted.start(); await until(() => restarted.coverage()[0]?.state === "ready");
    expect(f.store.getHead()).toEqual(oldHead); expect(f.bindings.get("app_0")).toEqual(oldBinding);
    expect(f.calls.logs.slice(reads).map(c => c.input.after)).toEqual([12]);
    expect(f.store.hasNativeMessage(updateSourceKey(b.source), "msg_live")).toBe(true);
  } finally { await restarted.close(); }
});

test("restart uses persisted first fence without new admission probes and observer refresh enrolls new App parents", async () => {
  const b = savedBinding(), f = fixture({ allowQualifiedActivation: true }, [b]); f.setFence(99);
  f.integration.start(); await until(f.ready);
  expect(f.calls.logs.every(c => c.input.after !== Number.MAX_SAFE_INTEGER)).toBe(true); expect(f.bindings.get("app_0")!.initialBaselineThrough).toBe(6);
  const next = parent(1), nb = savedBinding(next); f.sessions.push(next); f.admissions.set(next.sessionId, admission(next)); f.logs.set("ses_1", [creation(nb), ...reply(nb)]); f.setFence(6);
  f.integration.refresh(); await until(() => f.integration.coverage().length === 2 && f.integration.coverage().every(c => c.state === "ready"));
  expect(f.bindings.get("app_1")).toBeDefined(); expect(f.store.page().updates.map(c => c.conversationId)).toEqual(["app_0", "app_1"]);
});

for (const mode of ["no-creation", "one-origin", "child", "directory", "creation-time", "multiple-fences", "absent-fence"] as const) test(`${mode} creation/fence verification rejects without invented binding, baseline or replay checkpoint`, async () => {
  const f = fixture({ allowQualifiedActivation: true }), b = savedBinding();
  if (mode === "child" || mode === "directory" || mode === "creation-time") {
    const original = f.transport.session;
    f.transport.session = async (input, options) => { const s = await original(input, options); return mode === "child" ? { ...s, parentID: "ses_parent" } : mode === "directory" ? { ...s, location: { directory: "/wrong" } } : { ...s, time: { ...s.time, created: createdAt + 1 } }; };
  }
  f.setLog(async function* (input) {
    if (input.after === Number.MAX_SAFE_INTEGER) { if (mode !== "absent-fence") yield synced(b); if (mode === "multiple-fences") yield synced(b); return; }
    if (mode !== "no-creation") { const event = creation(b); yield mode === "one-origin" ? { ...event, durable: { ...event.durable, seq: 1 } } : event; }
    yield synced(b);
  });
  f.integration.start(); await until(() => f.integration.coverage()[0]?.state === "unavailable");
  expect(f.bindings.get("app_0")).toBeUndefined(); expect(f.store.getCheckpoints()).toEqual([]); expect(f.store.page().updates).toEqual([]); expect(f.integration.sourceBaselines()).toEqual([]);
});

test("corrupt binding record does not block a healthy parent; malformed binding container stays untouched", async () => {
  const bad = savedBinding(parent(1)), f = fixture({ allowQualifiedActivation: true }, [{ ...bad, initialBaselineThrough: -1 }]);
  f.sessions.push(parent(1)); f.admissions.set("app_1", admission(parent(1))); f.integration.start(); await until(f.ready);
  expect(f.integration.coverage().find(c => c.sourceKey.includes("ses_1"))!.state).toBe("unavailable"); expect(f.store.page().updates).toHaveLength(1);
  const broken = fixture({ allowQualifiedActivation: true }); writeFileSync(broken.path, "{optional-corruption"); broken.integration.start(); await tick();
  expect(broken.calls.logs).toEqual([]); expect(broken.integration.coverage()[0]!.state).toBe("unavailable"); expect(readFileSync(broken.path, "utf8")).toBe("{optional-corruption");
});

test("duplicate registered authority excludes only that authority; unrelated authority still enrolls", async () => {
  const f = fixture({ allowQualifiedActivation: true }), healthy = { ...parent(2), authorityId: "other-authority" };
  f.sessions.push(healthy); f.admissions.set(healthy.sessionId, admission(healthy));
  const b = savedBinding(healthy); f.logs.set(healthy.nativeSessionId!, [creation(b), ...reply(b)]);
  f.options.authorities = [...f.options.authorities, f.options.authorities[0]!, { authorityId: healthy.authorityId, qualification: qualification(healthy.authorityId), adapter: { async replyTransport() { f.calls.transport++; return f.transport; } } }];
  // Constructor snapshots the authority catalog; use a fresh coordinator with the changed catalog.
  const integration = new OpenCodeReplyIntegration(f.options);
  try {
    integration.start(); await until(() => integration.coverage().some(c => c.state === "ready"));
    expect(integration.coverage()[0]).toMatchObject({ state: "unqualified", reason: "Ambiguous registered OpenCode reply authority" });
    expect(f.calls.logs.every(c => c.input.sessionID === healthy.nativeSessionId)).toBe(true); expect(f.bindings.get("app_0")).toBeUndefined(); expect(f.bindings.get(healthy.sessionId)).toBeDefined();
  }
  finally { await integration.close(); }
});

test("all duplicate App native aliases are excluded individually while an unrelated parent enrolls", async () => {
  const f = fixture({ allowQualifiedActivation: true });
  const alias = { ...parent(), sessionId: "app_alias" }, good = parent(1);
  f.sessions.push(alias, good); for (const s of [alias, good]) f.admissions.set(s.sessionId, admission(s));
  const b = savedBinding(good); f.logs.set("ses_1", [creation(b), ...reply(b)]); f.integration.start();
  await until(() => f.integration.coverage().some(c => c.state === "ready"));
  expect(f.bindings.get("app_0")).toBeUndefined(); expect(f.bindings.get("app_alias")).toBeUndefined(); expect(f.bindings.get("app_1")).toBeDefined();
  expect(f.calls.logs.every(c => c.input.sessionID === "ses_1")).toBe(true);
});

test("checkpoint progress ahead of certification exposes only certified coverage and bootstrap baseline", async () => {
  const b = savedBinding(parent(), 0), f = fixture({ allowQualifiedActivation: true }, [b]);
  const cp = checkpoint(b, [creation(b), ...reply(b)], 0);
  await f.updates.upsertNativeBatch({ source: b.source, candidates: [], through: 6, state: cp as unknown as UpdateJson, baselineThrough: 0, coverage: { sourceKey: cp.sourceKey, state: "ready", through: 0, baselineThrough: 0 } });
  f.setLog(async function* (_input, signal) { await aborted(signal); signal.throwIfAborted(); }); f.integration.start(); await tick();
  expect(f.integration.coverage()[0]).toMatchObject({ state: "initializing", through: 0, baselineThrough: 0 });
  expect(f.integration.sourceBaselines()).toEqual([{ sourceKey: cp.sourceKey, through: 0 }]);
  expect(f.cp()!.through).toBe(6);
});

for (const cert of [null, 0]) test(`uncertified first fence (cert=${cert}) never exports a bootstrap baseline`, async () => {
  const b = savedBinding(), f = fixture({ allowQualifiedActivation: true }, [b]), cp = checkpoint(b, [creation(b), ...reply(b)], cert);
  await f.updates.upsertNativeBatch({ source: b.source, candidates: [], through: 6, state: cp as unknown as UpdateJson, coverage: { sourceKey: cp.sourceKey, state: "initializing", ...(cert === null ? {} : { through: cert }) } });
  f.setLog(async function* (_input, signal) { await aborted(signal); signal.throwIfAborted(); }); f.integration.start(); await tick();
  expect(f.integration.coverage()[0]!.state).not.toBe("ready"); expect(f.integration.sourceBaselines()).toEqual([]); expect((await f.updates.page({}, true)).bootstrap!.sourceBaselines).toEqual([]);
  expect(f.integration.coverage()[0]!.through).toBe(cert === null ? undefined : cert);
});

test("null checkpoint certification cannot inherit an old coverage watermark from optional persisted metadata", async () => {
  const b = savedBinding(), f = fixture({ allowQualifiedActivation: true }, [b]), cp = checkpoint(b, [creation(b), ...reply(b)], null);
  // Generic storage accepts this envelope; the coordinator owns native cp-v2
  // certification and must not trust the old independent coverage claim.
  expect(await f.updates.upsertNativeBatch({ source: b.source, candidates: [], through: 6, state: cp as unknown as UpdateJson, coverage: { sourceKey: cp.sourceKey, state: "ready", through: 6 } })).toBe(true);
  f.setLog(async function* (_input, signal) { await aborted(signal); signal.throwIfAborted(); }); f.integration.start(); await tick();
  expect(f.integration.coverage()[0]!.state).not.toBe("ready"); expect(f.integration.coverage()[0]!.through).toBeUndefined(); expect(f.integration.sourceBaselines()).toEqual([]);
});

test("lagging certification overrides a ready observer status and cannot baseline the current uncertified fence", async () => {
  const b = savedBinding(), f = fixture({ allowQualifiedActivation: true }, [b]), cp = checkpoint(b, [creation(b), ...reply(b)], 0);
  expect(await f.updates.upsertNativeBatch({ source: b.source, candidates: [], through: 6, state: cp as unknown as UpdateJson, coverage: { sourceKey: cp.sourceKey, state: "ready", through: 6 } })).toBe(true);
  f.setLog(async function* (_input, signal) { await aborted(signal); signal.throwIfAborted(); }); f.integration.start(); await tick();
  const observer = spyOn(OpenCodeReplyObserver.prototype, "coverage").mockReturnValue([{ sourceKey: cp.sourceKey, state: "ready", through: 6 }]);
  try {
    const coverage = f.integration.coverage()[0]!;
    expect(coverage).toMatchObject({ state: "initializing", through: 0 }); expect(coverage.baselineThrough).toBeUndefined();
    expect(f.integration.sourceBaselines()).toEqual([]); expect((await f.updates.page({}, true)).bootstrap!.sourceBaselines).toEqual([]);
    expect(f.cp()!.through).toBe(6); expect((f.cp()!.state as unknown as OpenCodeReplyCheckpoint).certifiedThrough).toBe(0);
  } finally { observer.mockRestore(); }
});

test("positive high-after head probe is no readiness or baseline while verified creation is still pending", async () => {
  const f = fixture({ allowQualifiedActivation: true }), b = savedBinding(), entered = deferred();
  let creationSignal: AbortSignal | undefined;
  f.setLog(async function* (input, signal) {
    if (input.after === Number.MAX_SAFE_INTEGER) { yield synced(b, 9000); return; }
    creationSignal = signal; entered.resolve(); await aborted(signal); signal.throwIfAborted();
  });
  f.integration.start(); await entered.promise;
  expect(f.integration.coverage()[0]!.state).not.toBe("ready"); expect(f.integration.coverage()[0]!.through).toBeUndefined(); expect(f.integration.coverage()[0]!.baselineThrough).toBeUndefined();
  expect(f.integration.sourceBaselines()).toEqual([]); expect(f.store.getCheckpoints()).toEqual([]); expect(f.bindings.get("app_0")).toBeUndefined();
  await f.integration.close(); expect(creationSignal!.aborted).toBe(true); expect(f.store.getCheckpoints()).toEqual([]);
});

test("incompatible checkpoint envelope is isolated, not reset or advertised as ready", async () => {
  const b = savedBinding(), f = fixture({ allowQualifiedActivation: true }, [b]), cp = checkpoint(b, [creation(b), ...reply(b)]);
  expect(await f.updates.upsertNativeBatch({ source: b.source, candidates: [], through: 6, state: { ...cp, initialBaselineThrough: 7 } as unknown as UpdateJson, coverage: { sourceKey: cp.sourceKey, state: "ready", through: 6 } })).toBe(true);
  const before = readFileSync(join(f.dir, "conversation-updates.json"), "utf8"); f.integration.start();
  await until(() => f.integration.coverage()[0]?.state === "unqualified");
  expect(f.calls.logs).toEqual([]); expect(f.integration.updateSource("app_0")).toBeUndefined(); expect(f.integration.sourceBaselines()).toEqual([]); expect(readFileSync(join(f.dir, "conversation-updates.json"), "utf8")).toBe(before);
});

function run(index = 0, patch: Partial<Run> = {}): Run {
  return { runId: `run_${index}`, sessionId: "app_0", cwd: "/fixture", status: "completed", createdAt: now, endedAt: now, nativeCommandId: `msg_command_${index}`, nativePhase: "accepted", nativeAcceptedAt: createdAt, ...patch };
}
function message(r: Run, role: "user" | "assistant", id: string, seq = 1, patch: Partial<Event> = {}): Event {
  return { seq, kind: "message", runId: r.runId, sessionId: r.sessionId, time: now, data: { role, messageId: id, createdAt: now }, ...patch };
}
function journal(f: ReturnType<typeof fixture>, r: Run, assistant = "msg_reply") {
  f.runs.push(r); f.journals.set(r.runId, [message(r, "user", r.nativeCommandId!), message(r, "assistant", assistant, 2)]);
}

for (const mode of ["exact", "unaccepted", "compact", "child", "wrong-message", "unpersisted", "wrong-session", "ambiguous", "old-command"] as const) test(`native/App correlation ${mode} requires unique accepted command plus exact assistant in committed parent journal`, async () => {
  const f = fixture({ allowQualifiedActivation: true });
  const r = run(0, mode === "unaccepted" ? { nativePhase: "sending" } : mode === "compact" ? { operation: "compact" } : mode === "child" ? { agentKind: "worker" } : mode === "old-command" ? { nativeAcceptedAt: createdAt - 1 } : {});
  journal(f, r, mode === "wrong-message" ? "msg_not_reply" : "msg_reply");
  if (mode === "unpersisted") f.journals.delete(r.runId);
  if (mode === "wrong-session") f.journals.set(r.runId, f.journals.get(r.runId)!.map(e => ({ ...e, sessionId: "child" })));
  if (mode === "ambiguous") journal(f, run(1));
  f.integration.start(); await until(f.ready);
  const row = f.store.page().updates[0]!; expect(row.runId).toBe(mode === "exact" ? r.runId : undefined); expect(row.legacyRunId).toBeUndefined();
});

test("late committed exact assistant correlation changes metadata revision, never occurrence identity/order or legacy alias", async () => {
  const f = fixture({ allowQualifiedActivation: true }), r = run(); f.runs.push(r); f.journals.set(r.runId, [message(r, "user", r.nativeCommandId!)]);
  f.integration.start(); await until(f.ready); const first = f.store.page().updates[0]!; expect(first.runId).toBeUndefined();
  const assistant = message(r, "assistant", "msg_reply", 2); f.journals.get(r.runId)!.push(assistant);
  f.integration.correlateCommitted(f.sessions[0]!, r, assistant);
  await until(() => f.store.getUpdate(first.id)?.revision === 2);
  const revised = f.store.getUpdate(first.id)!;
  expect(revised).toMatchObject({ id: first.id, occurrenceSequence: first.occurrenceSequence, revision: 2, runId: r.runId, messageId: "msg_reply" }); expect(revised.legacyRunId).toBeUndefined();
  f.integration.correlateCommitted(f.sessions[0]!, r, assistant); await tick(); await f.updates.flush(); expect(f.store.getUpdate(first.id)!.revision).toBe(2);
});

test("late exact message correlation never assigns a run to another native source", async () => {
  const f = fixture({ allowQualifiedActivation: true }), r = run(); f.runs.push(r); f.journals.set(r.runId, [message(r, "user", r.nativeCommandId!)]);
  f.integration.start(); await until(f.ready);
  const first = f.store.page().updates[0]!, foreignSource = { ...first.source, nativeSessionId: "ses_foreign" };
  const foreignId = updateOccurrenceId(foreignSource, "foreign-boundary");
  expect(await f.updates.upsertNativeBatch({ source: foreignSource, through: 6, candidates: [{ id: foreignId, source: foreignSource, conversationId: "app_0", kind: "reply", messageId: "msg_reply", sourceSequence: 6, occurredAt: now }] })).toBe(true);
  const assistant = message(r, "assistant", "msg_reply", 2); f.journals.get(r.runId)!.push(assistant); f.integration.correlateCommitted(f.sessions[0]!, r, assistant);
  await until(() => f.store.getUpdate(first.id)?.runId === r.runId); expect(f.store.getUpdate(foreignId)!.runId).toBeUndefined(); expect(f.store.getUpdate(foreignId)!.legacyRunId).toBeUndefined();
});

async function padFeed(f: ReturnType<typeof fixture>, count: number) {
  const source = { harness: "claude-code" as const, authorityId: "fake-background-feed", nativeSessionId: "foreign" };
  const rows: ConversationUpdateCandidate[] = Array.from({ length: count }, (_, index) => ({ id: updateOccurrenceId(source, `background_${index}`), source, conversationId: "background", kind: "reply", messageId: `background_${index}`, occurredAt: null }));
  expect(await f.store.commitCandidates(rows)).toBe(true);
}

test("empty-selector late correlation yields after at most two pages so backend primary journal work can progress", async () => {
  const f = fixture({ allowQualifiedActivation: true }), r = run(), assistant = message(r, "assistant", "msg_absent_from_feed", 2);
  journal(f, r, "msg_absent_from_feed"); f.integration.start(); await until(f.ready); await padFeed(f, 1200);
  const head = f.store.getHead()!, actualPage = f.store.page.bind(f.store), backend = deferred();
  let pages = 0, pagesAtSentinel = 0, pagesAtJournalCommit = 0, correlations = 0, journalAccepted = false;
  f.updates.correlate = async () => { correlations++; return true; };
  f.store.page = (request, bootstrap, coverage) => {
    pages++;
    if (pages === 1) setTimeout(() => {
      pagesAtSentinel = pages;
      void (async () => {
        const first = await f.updates.ingestCommitted(f.sessions[0]!, r, message(r, "user", r.nativeCommandId!, 1));
        const second = await f.updates.ingestCommitted(f.sessions[0]!, r, assistant);
        journalAccepted = first && second; pagesAtJournalCommit = pages;
      })().finally(() => backend.resolve());
    }, 0);
    return actualPage(request, bootstrap, coverage);
  };
  f.integration.correlateCommitted(f.sessions[0]!, r, assistant); await backend.promise;
  expect(pagesAtSentinel).toBeGreaterThan(0); expect(pagesAtSentinel).toBeLessThanOrEqual(2);
  expect(journalAccepted).toBe(true);
  expect(pagesAtJournalCommit).toBeLessThan(Math.ceil(head.through / 100));
  expect(f.store.getCheckpoints().find(cp => JSON.parse(cp.key)[0] === "app-run")!.through).toBe(2);
  await until(() => pages >= Math.ceil(head.through / 100)); expect(correlations).toBe(0);
  await f.integration.close(); const stopped = pages; await tick(); expect(pages).toBe(stopped);
});

test("256 queued correlation jobs cannot scan in one turn; close cancels queued turns before store closure", async () => {
  const f = fixture({ allowQualifiedActivation: true }), r = run(); f.runs.push(r); f.integration.start(); await until(f.ready); await padFeed(f, 300);
  const actualPage = f.store.page.bind(f.store), actualClose = f.store.close.bind(f.store), sentinel = deferred();
  let pages = 0, firstTurnPages = 0, storeClosed = false, readsAfterClose = 0;
  f.store.page = (request, bootstrap, coverage) => {
    if (storeClosed) readsAfterClose++; pages++;
    if (pages === 1) setTimeout(() => { firstTurnPages = pages; sentinel.resolve(); }, 0);
    return actualPage(request, bootstrap, coverage);
  };
  f.store.close = async () => { storeClosed = true; return actualClose(); };
  for (let index = 0; index < 256; index++) f.integration.correlateCommitted(f.sessions[0]!, r, message(r, "assistant", `msg_queued_${index}`, 2));
  expect(pages).toBe(0); await sentinel.promise;
  expect(firstTurnPages).toBeGreaterThan(0); expect(firstTurnPages).toBeLessThanOrEqual(2); expect(firstTurnPages).toBeLessThan(256);
  await f.close(); const stopped = pages;
  await new Promise<void>(resolve => setTimeout(resolve, 0)); await tick();
  expect(storeClosed).toBe(true); expect(pages).toBe(stopped); expect(readsAfterClose).toBe(0);
  expect(f.calls.lifecycle.indexOf("integration-closed")).toBeLessThan(f.calls.lifecycle.indexOf("store-closed"));
});

test("late correlation has at most two active publications and close aborts and joins them before store closes", async () => {
  const f = fixture({ allowQualifiedActivation: true });
  for (let index = 0; index < 16; index++) journal(f, run(index), `msg_late_${index}`);
  f.integration.start(); await until(f.ready); const source = f.integration.updateSource("app_0")!;
  const rows: ConversationUpdateCandidate[] = f.runs.map((r, index) => ({ id: updateOccurrenceId(source, `late-boundary-${index}`), source, conversationId: r.sessionId, kind: "reply", messageId: `msg_late_${index}`, occurredAt: null }));
  expect(await f.store.commitCandidates(rows)).toBe(true);
  let active = 0, maximum = 0, completed = 0; const signals: AbortSignal[] = [];
  f.updates.correlate = async (_selectors, guard) => {
    const signal = guard!.signal!; signals.push(signal); active++; maximum = Math.max(maximum, active);
    try { await aborted(signal); return false; } finally { active--; completed++; f.calls.lifecycle.push("correlation-exited"); }
  };
  const actualClose = f.store.close.bind(f.store);
  f.store.close = async () => { expect(active).toBe(0); expect(completed).toBe(signals.length); return actualClose(); };
  for (const [index, r] of f.runs.entries()) f.integration.correlateCommitted(f.sessions[0]!, r, message(r, "assistant", `msg_late_${index}`, 2));
  await until(() => active > 0); await tick(); expect(maximum).toBeLessThanOrEqual(2);
  const close = f.integration.close(); expect(signals.every(s => s.aborted)).toBe(true); await close; expect(active).toBe(0);
  await f.close(); expect(f.calls.lifecycle.indexOf("correlation-exited")).toBeLessThan(f.calls.lifecycle.indexOf("store-closed"));
});

test("stale binding revision is rejected at coordinator commit even with a fresh non-aborted caller signal", async () => {
  const f = fixture({ allowQualifiedActivation: true }); f.integration.start(); await until(f.ready);
  const current = f.bindings.get("app_0")!, cp = f.cp()!.state as unknown as OpenCodeReplyCheckpoint;
  const stale = { ...current, registrationRevision: "old-revision" };
  const batch: OpenCodeReplyCommit = { binding: stale, checkpoint: cp, candidates: [], messageIds: ["msg_uncommitted"], coverage: { sourceKey: cp.sourceKey, state: "ready", through: cp.certifiedThrough! }, expectedProgressThrough: cp.progressThrough };
  // Direct module boundary seam: exercise the actual private publication guard,
  // not a fixture replacement of implementation behavior.
  const direct = f.integration as unknown as { commit(batch: OpenCodeReplyCommit, signal: AbortSignal): Promise<void> };
  const before = readFileSync(join(f.dir, "conversation-updates.json"), "utf8");
  await expect(direct.commit(batch, new AbortController().signal)).rejects.toThrow("Stale native reply registration");
  expect(readFileSync(join(f.dir, "conversation-updates.json"), "utf8")).toBe(before); expect(f.store.hasNativeMessage(cp.sourceKey, "msg_uncommitted")).toBe(false);
});

test("negative checkpoint CAS rejects native commit without rows, ledger or readiness", async () => {
  const f = fixture({ allowQualifiedActivation: true }), original = f.updates.upsertNativeBatch.bind(f.updates);
  f.updates.upsertNativeBatch = (batch, guard) => original(batch, { ...guard, expectedCheckpoint: { key: nativeUpdateCheckpointKey(batch.source), through: 999 } });
  f.integration.start(); await until(() => f.integration.coverage()[0]?.state === "degraded");
  expect(f.store.page().updates).toEqual([]); expect(f.store.getCheckpoints()).toEqual([]); expect(f.store.hasNativeMessage(updateSourceKey(savedBinding().source), "msg_reply")).toBe(false); expect(f.integration.sourceBaselines()).toEqual([]);
});

test("remove/rebind ABA while native publication is queued rejects stale revision then renews immutable first fence", async () => {
  const b = savedBinding(), f = fixture({ allowQualifiedActivation: true }, [b]), entered = deferred(), release = deferred();
  const original = f.updates.upsertNativeBatch.bind(f.updates); let first = true, staleAccepted: boolean | undefined;
  f.updates.upsertNativeBatch = async (batch, guard) => { if (first) { first = false; entered.resolve(); await release.promise; staleAccepted = await original(batch, guard); return staleAccepted; } return original(batch, guard); };
  f.integration.start(); await entered.promise;
  f.sessions.length = 0; f.integration.refresh(); f.sessions.push(parent()); f.integration.refresh();
  const renewed = f.bindings.get("app_0")!; expect(renewed.registrationRevision).not.toBe(b.registrationRevision); expect({ ...renewed, registrationRevision: b.registrationRevision }).toEqual(b);
  release.resolve(); await until(f.ready);
  expect(staleAccepted).toBe(false); expect(f.store.page().updates).toHaveLength(1); expect(f.calls.logs.every(c => c.input.after !== Number.MAX_SAFE_INTEGER)).toBe(true);
});

test("removed in-flight admission probe cannot publish an ABA binding or checkpoint", async () => {
  const f = fixture({ allowQualifiedActivation: true }), entered = deferred(), release = deferred(); const original = f.transport.session; let once = true, oldSignal: AbortSignal | undefined;
  f.transport.session = async (input, options) => { if (once) { once = false; oldSignal = options!.signal!; entered.resolve(); await release.promise; } return original(input, options); };
  f.integration.start(); await entered.promise;
  try {
    f.sessions.length = 0; f.integration.refresh(); expect(oldSignal!.aborted).toBe(true);
    expect(f.bindings.get("app_0")).toBeUndefined(); expect(f.store.getCheckpoints()).toEqual([]);
    f.sessions.push(parent()); f.integration.refresh(); await until(f.ready);
    const binding = f.bindings.get("app_0")!, before = readFileSync(join(f.dir, "conversation-updates.json"), "utf8");
    release.resolve(); await tick(); await tick();
    expect(f.bindings.get("app_0")).toEqual(binding); expect(readFileSync(join(f.dir, "conversation-updates.json"), "utf8")).toBe(before);
    expect(f.calls.logs.some(c => c.signal === oldSignal)).toBe(false); // Retired generation performs no subsequent head probe.
  } finally { release.resolve(); }
});

for (const stage of ["transport", "info", "session", "head", "creation", "verify"] as const) for (const mode of ["remove", "rebind"] as const) test(`${mode} aborts admission during ${stage}; rejected old promise cannot overwrite current epoch`, async () => {
  const f = fixture({ allowQualifiedActivation: true }), entered = deferred(), old = pending<void>(), originalSession = f.transport.session, originalInfo = f.transport.info;
  let oldSignal: AbortSignal | undefined, blocked = false, transportCalls = 0, sessionCalls = 0;
  const block = async (signal?: AbortSignal) => { blocked = true; oldSignal = signal; entered.resolve(); await old.promise; };
  // The adapter factory itself has no signal parameter. Observe its private
  // generation controller only for that one boundary; all HTTP/log boundaries
  // expose their actual request signal to this fake transport.
  const adapter = f.options.authorities[0]!.adapter, originalTransport = adapter.replyTransport;
  adapter.replyTransport = async () => { if (stage === "transport" && ++transportCalls === 2) await block(); return originalTransport(); };
  f.transport.info = async options => { if (stage === "info" && !blocked) await block(options!.signal!); return originalInfo(options); };
  f.transport.session = async (input, options) => {
    if (input.sessionID === "ses_0") {
      sessionCalls++;
      if (!blocked && (stage === "session" && sessionCalls === 1 || stage === "verify" && sessionCalls === 2)) await block(options!.signal!);
    }
    return originalSession(input, options);
  };
  f.setLog(async function* (input, signal) {
    const s = f.sessions.find(s => s.nativeSessionId === input.sessionID) ?? parent(), b = savedBinding(s);
    if (input.sessionID === "ses_0" && !blocked && (stage === "head" && input.after === Number.MAX_SAFE_INTEGER || stage === "creation" && input.after === undefined)) await block(signal);
    if (input.after === Number.MAX_SAFE_INTEGER) { yield synced(b); return; }
    for (const event of f.logs.get(input.sessionID) ?? []) if (input.after === undefined || event.durable.seq > input.after) yield event;
    yield synced(b);
  });
  f.integration.start(); await entered.promise;
  if (stage === "transport") oldSignal = (f.integration as unknown as { active: Map<string, { controller: AbortController }> }).active.get("app_0")!.controller.signal;
  try {
    if (mode === "remove") f.sessions.length = 0;
    else {
      const rebound = { ...parent(), nativeSessionId: "ses_rebound" };
      f.sessions[0] = rebound; f.admissions.set(rebound.sessionId, { ...admission(rebound), requestId: "new-epoch-request", binding: { ...admission(rebound).binding, bindingRevision: "new-epoch-binding" } });
    }
    f.integration.refresh(); expect(oldSignal!.aborted).toBe(true); expect(f.bindings.get("app_0")).toBeUndefined();
    const fresh = mode === "remove" ? parent(1) : f.sessions[0]!;
    if (mode === "remove") { f.sessions.push(fresh); f.admissions.set(fresh.sessionId, admission(fresh)); }
    const freshBinding = savedBinding(fresh); f.logs.set(fresh.nativeSessionId!, [creation(freshBinding), ...reply(freshBinding)]);
    f.integration.refresh(); await until(() => f.integration.coverage().some(c => c.sourceKey.includes(fresh.nativeSessionId!) && c.state === "ready"));
    // Current admission completes while the old adapter still has not settled.
    const beforeBinding = f.bindings.get(fresh.sessionId), beforeDisk = readFileSync(join(f.dir, "conversation-updates.json"), "utf8"), beforeCoverage = f.integration.coverage(), oldProbes = f.calls.logs.filter(c => c.input.sessionID === "ses_0").length;
    expect(beforeBinding).toBeDefined(); old.reject(new Error("late old-generation rejection")); await tick(); await tick();
    expect(f.bindings.get(fresh.sessionId)).toEqual(beforeBinding); expect(f.integration.coverage()).toEqual(beforeCoverage);
    expect(readFileSync(join(f.dir, "conversation-updates.json"), "utf8")).toBe(beforeDisk); expect(f.calls.logs.filter(c => c.input.sessionID === "ses_0")).toHaveLength(oldProbes);
  } finally { old.resolve(); }
});

test("aborting one of two occupied admission slots starts the queued parent before separately released old adapter promises", async () => {
  const f = fixture({ allowQualifiedActivation: true }), original = f.transport.session;
  const releases = [pending<void>(), pending<void>()], signals = new Map<string, AbortSignal>(), entered = new Set<string>();
  for (let index = 1; index <= 2; index++) { const s = parent(index), b = savedBinding(s); f.sessions.push(s); f.admissions.set(s.sessionId, admission(s)); f.logs.set(s.nativeSessionId!, [creation(b), ...reply(b)]); }
  let queuedEntered = false;
  f.transport.session = async (input, options) => {
    const index = input.sessionID === "ses_0" ? 0 : input.sessionID === "ses_1" ? 1 : -1;
    if (index >= 0 && !entered.has(input.sessionID)) { entered.add(input.sessionID); signals.set(input.sessionID, options!.signal!); await releases[index]!.promise; }
    if (input.sessionID === "ses_2") queuedEntered = true;
    return original(input, options);
  };
  f.integration.start(); await until(() => entered.size === 2);
  try {
    expect(queuedEntered).toBe(false); f.sessions.splice(0, 1); f.integration.refresh();
    expect(signals.get("ses_0")!.aborted).toBe(true); expect(signals.get("ses_1")!.aborted).toBe(false);
    await until(() => f.bindings.get("app_2") !== undefined);
    expect(queuedEntered).toBe(true); expect(f.bindings.get("app_0")).toBeUndefined(); expect(f.bindings.get("app_1")).toBeUndefined();
  } finally { for (const release of releases) release.resolve(); }
});

test("unchanged periodic refresh preserves the admission sweep past a failing 300-parent prefix to a healthy tail", async () => {
  const f = fixture({ allowQualifiedActivation: true }), original = f.transport.session;
  f.sessions.length = 0; f.admissions.clear(); f.logs.clear();
  for (let index = 0; index < 320; index++) {
    const s = parent(index); f.sessions.push(s); f.admissions.set(s.sessionId, admission(s));
    if (index >= 300) { const b = savedBinding(s); f.logs.set(s.nativeSessionId!, [creation(b), ...reply(b)]); }
  }
  const blocked = new Map<string, { gate: ReturnType<typeof pending<void>>; signal: AbortSignal }>(), attempts = new Map<string, number>();
  let maximum = 0;
  f.transport.session = async (input, options) => {
    const index = Number(input.sessionID.slice(4));
    if (index < 300) {
      attempts.set(input.sessionID, (attempts.get(input.sessionID) ?? 0) + 1);
      const entry = { gate: pending<void>(), signal: options!.signal! }; blocked.set(input.sessionID, entry); maximum = Math.max(maximum, blocked.size);
      try { await entry.gate.promise; throw new Error("fake failed-prefix parent"); }
      finally { if (blocked.get(input.sessionID) === entry) blocked.delete(input.sessionID); }
    }
    return original(input, options);
  };
  f.integration.start();
  try {
    // No wall-clock deadline, real 15-second timeout or timer interception.
    // Each turn explicitly refreshes an UNCHANGED catalog while the two oldest
    // fake admission requests are still blocked, then releases only that pair.
    for (let turn = 0; turn < 500 && !f.bindings.get("app_319"); turn++) {
      f.integration.refresh();
      for (const entry of [...blocked.values()]) entry.gate.resolve();
      await tick();
    }
    expect(f.bindings.get("app_319")).toBeDefined(); expect(f.bindings.get("app_300")).toBeDefined();
    expect(attempts.size).toBe(300); expect(maximum).toBeLessThanOrEqual(2);
    expect(f.calls.logs.filter(call => call.input.after === Number.MAX_SAFE_INTEGER).every(call => Number(call.input.sessionID.slice(4)) >= 300)).toBe(true);
  } finally { for (const entry of blocked.values()) entry.gate.resolve(); }
});

test("changing only an eligibility signature restarts the sweep and aborts the old admission without changing native identity", async () => {
  const f = fixture({ allowQualifiedActivation: true }), original = f.transport.session;
  for (let index = 1; index < 4; index++) { const s = parent(index), b = savedBinding(s); f.sessions.push(s); f.admissions.set(s.sessionId, admission(s)); f.logs.set(s.nativeSessionId!, [creation(b), ...reply(b)]); }
  const held = new Map<string, { gate: ReturnType<typeof pending<void>>; signal: AbortSignal }>();
  let newGenerationEntered = false;
  f.transport.session = async (input, options) => {
    if (!held.has(input.sessionID)) {
      const entry = { gate: pending<void>(), signal: options!.signal! }; held.set(input.sessionID, entry); await entry.gate.promise;
      throw new Error("rejected old optional admission");
    }
    if (input.sessionID === "ses_0") newGenerationEntered = true;
    return original(input, options);
  };
  f.integration.start(); await until(() => held.has("ses_0") && held.has("ses_1"));
  const old = held.get("ses_0")!, unchanged = held.get("ses_1")!, prior = f.admissions.get("app_0")!;
  try {
    f.admissions.set("app_0", { ...prior, binding: { ...prior.binding, bindingRevision: "changed-signature-same-native" } }); f.integration.refresh();
    expect(old.signal.aborted).toBe(true); expect(unchanged.signal.aborted).toBe(false); expect(f.sessions[0]!.nativeSessionId).toBe(prior.nativeId!);
    for (let turn = 0; turn < 30 && !f.bindings.get("app_0"); turn++) {
      for (const [id, entry] of held) if (id !== "ses_0") entry.gate.resolve();
      await tick();
    }
    expect(newGenerationEntered).toBe(true); expect(f.bindings.get("app_0")).toBeDefined();
    await until(f.ready); const binding = f.bindings.get("app_0"), coverage = f.integration.coverage();
    old.gate.reject(new Error("late rejected old signature")); await tick(); await tick();
    expect(f.bindings.get("app_0")).toEqual(binding); expect(f.integration.coverage()).toEqual(coverage);
  } finally { for (const entry of held.values()) entry.gate.resolve(); }
});

test("an exhausted failed admission sweep stays idle until the next explicit periodic refresh, then retries once", async () => {
  const f = fixture({ allowQualifiedActivation: true });
  for (let index = 1; index < 4; index++) { const s = parent(index); f.sessions.push(s); f.admissions.set(s.sessionId, admission(s)); }
  const attempts = new Map<string, number>();
  f.transport.session = async input => { attempts.set(input.sessionID, (attempts.get(input.sessionID) ?? 0) + 1); throw new Error("fake failed admission"); };
  // Logical monotonic time advances only when the test represents the next
  // periodic cadence. No wall-clock sleep or global timer interception is used.
  let monotonic = performance.now();
  const clock = spyOn(performance, "now").mockImplementation(() => monotonic);
  try {
    f.integration.start(); await until(() => attempts.size === 4);
    for (let turn = 0; turn < 20; turn++) await tick();
    expect([...attempts.values()]).toEqual([1, 1, 1, 1]);
    f.integration.refresh();
    for (let turn = 0; turn < 20; turn++) await tick();
    expect([...attempts.values()]).toEqual([1, 1, 1, 1]);
    monotonic += 30001; f.integration.refresh(); await until(() => [...attempts.values()].every(count => count === 2));
    for (let turn = 0; turn < 20; turn++) await tick();
    expect([...attempts.values()]).toEqual([2, 2, 2, 2]); expect(f.bindings.get("app_0")).toBeUndefined(); expect(f.store.getCheckpoints()).toEqual([]);
  } finally { clock.mockRestore(); }
});

test("close aborts and joins admission probes and observer tasks before the fixture store closes", async () => {
  const f = fixture({ allowQualifiedActivation: true }); let probeSignal: AbortSignal | undefined;
  f.setLog(async function* (_input, signal) { probeSignal = signal; try { await aborted(signal); signal.throwIfAborted(); } finally { f.calls.lifecycle.push("probe-exited"); } });
  f.integration.start(); await until(() => probeSignal !== undefined && f.calls.events > 0);
  const close = f.integration.close(); expect(f.integration.close()).toBe(close); expect(probeSignal!.aborted).toBe(true);
  await f.close(); expect(f.calls.lifecycle.indexOf("probe-exited")).toBeLessThan(f.calls.lifecycle.indexOf("store-closed")); expect(f.calls.lifecycle.indexOf("events-exited")).toBeLessThan(f.calls.lifecycle.indexOf("store-closed")); expect(f.store.getCheckpoints()).toEqual([]);
});
