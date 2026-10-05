import { expect, spyOn, test } from "bun:test";
import type { SessionEventDurable, SessionLogOutput, V2Event } from "@opencode/client";
import { OpenCodeReplyTransportLimitError, type OpenCodeReplyTransport } from "./opencode";
import { OC_REPLY_QUALIFICATION_CHECKS, OpenCodeReplyObserver, validateOpenCodeReplyCheckpoint, type OpenCodeReplyCheckpoint, type OpenCodeReplyCommit, type OpenCodeReplyQualification, type OpenCodeReplyRegistration } from "./opencode-reply-observer";
import { initialOpenCodeReplyState, OC_REPLY_UNQUALIFIED_REASON, openCodeIncarnation, reduceOpenCodeReply, type OpenCodeReplyBinding } from "../shared/conversation/oc-reply-reducer";
import { updateSourceKey, type ConversationUpdateCandidate } from "../shared/conversation/conversation-updates";

const createdAt = Date.parse("2026-10-01T00:00:00Z"), nativeVersion = "2.0.21";
const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
const error = { type: "fixture", message: "Mock failure" };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
type Native<K extends SessionEventDurable["type"]> = Extract<SessionEventDurable, { type: K }>;
function binding(index = 0, initialBaselineThrough = 0): OpenCodeReplyRegistration {
  const creation = { eventId: `evt_created_${index}`, createdAt };
  return { conversationId: `app_${index}`, creation, initialBaselineThrough, registrationRevision: `registration_${index}_1`,
    source: { harness: "opencode", authorityId: "mock_authority", nativeSessionId: `ses_${index}`, incarnation: openCodeIncarnation(creation) } };
}
function durable<K extends SessionEventDurable["type"]>(b: OpenCodeReplyBinding, seq: number, type: K, data: Omit<Native<K>["data"], "sessionID">): Native<K> {
  return { id: seq === 0 ? b.creation.eventId : `evt_${seq}`, created: createdAt + seq, type,
    durable: { aggregateID: b.source.nativeSessionId, seq, version: type === "session.deleted" ? 2 : 1 }, data: { sessionID: b.source.nativeSessionId, ...data } } as unknown as Native<K>;
}
const creation = (b: OpenCodeReplyBinding) => durable(b, 0, "session.created", { projectID: "project_mock", location: { directory: "/fixture" }, slug: "mock", version: nativeVersion });
function reply(b: OpenCodeReplyBinding, after = 0, messageID = `msg_${after}`): SessionEventDurable[] {
  return [durable(b, after + 1, "session.execution.started", {}),
    durable(b, after + 2, "session.step.started", { assistantMessageID: messageID, started: createdAt, agent: "build", model: { providerID: "mock", id: "mock" } }),
    durable(b, after + 3, "session.text.started", { assistantMessageID: messageID, ordinal: 0 }),
    durable(b, after + 4, "session.text.ended", { assistantMessageID: messageID, ordinal: 0, text: "Actual native fixture reply" }),
    durable(b, after + 5, "session.step.ended", { assistantMessageID: messageID, finish: "stop", cost: 0, tokens }),
    durable(b, after + 6, "session.execution.succeeded", {})];
}
const synced = (b: OpenCodeReplyBinding, seq?: number): SessionLogOutput => ({ type: "log.synced", aggregateID: b.source.nativeSessionId, ...(seq === undefined ? {} : { seq }) });
function checkpoint(b: OpenCodeReplyRegistration, events: SessionEventDurable[] = [creation(b)]): OpenCodeReplyCheckpoint {
  let state = initialOpenCodeReplyState(b);
  for (const event of events) state = reduceOpenCodeReply(state, event, b, event.durable.seq <= b.initialBaselineThrough).state;
  return { version: 2, sourceKey: updateSourceKey(b.source), nativeVersion, progressThrough: state.seq, certifiedThrough: state.seq, initialBaselineThrough: b.initialBaselineThrough, state };
}

/** Fake 2.0.21 runtime + installed 2.0.18 SDK shapes only: NEVER qualification of a real runtime. */
function mockQualification(): OpenCodeReplyQualification {
  return { authorityId: "mock_authority", clientVersion: "2.0.18", nativeVersion, verifiedAt: "2026-10-01T00:00:00Z", evidenceRef: "fake-runtime-only:not-real-qualification",
    checks: Object.fromEntries(OC_REPLY_QUALIFICATION_CHECKS.map(k => [k, { passed: true, evidenceRef: `fake-runtime-only:${k}` }])) as OpenCodeReplyQualification["checks"] };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function aborted(signal: AbortSignal): Promise<void> { return new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); }); }
async function tick() { await new Promise<void>(r => setImmediate(r)); }
/** Bounded fixture-only scheduling; no native services, models, or browser. */
async function until(predicate: () => boolean) { for (let i = 0; i < 10000; i++) { if (predicate()) return; await tick(); } throw new Error("Mock observer did not reach expected state"); }
class Hints {
  private queue: (V2Event | Error)[] = [];
  private wake?: () => void;
  push(value: V2Event | Error) { this.queue.push(value); this.wake?.(); }
  async *stream(signal: AbortSignal): AsyncGenerator<V2Event> {
    while (!signal.aborted) {
      if (!this.queue.length) await new Promise<void>(resolve => {
        const done = () => { signal.removeEventListener("abort", done); this.wake = undefined; resolve(); };
        this.wake = done; signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
      });
      if (signal.aborted) return;
      const next = this.queue.shift(); if (next instanceof Error) throw next; if (next) yield next;
    }
  }
}
function fixture(count = 1) {
  const catalog = Array.from({ length: count }, (_, i) => binding(i));
  const saved = new Map<string, OpenCodeReplyCheckpoint>(), ledger = new Map<string, Set<string>>(), rows = new Map<string, ConversationUpdateCandidate>();
  const logs = new Map(catalog.map(b => [b.source.nativeSessionId, [creation(b)] as SessionEventDurable[]]));
  const hints = new Hints(), commits: OpenCodeReplyCommit[] = [];
  const calls = { transport: 0, info: 0, events: 0, session: 0, logs: [] as { sessionID: string; after?: number; hasAfter: boolean; signal: AbortSignal }[], loads: [] as string[], membership: [] as { sourceKey: string; id: string }[], commitSignals: [] as AbortSignal[] };
  let version = nativeVersion;
  let logOverride: ((b: OpenCodeReplyRegistration, after: number | undefined, signal: AbortSignal) => AsyncIterable<SessionLogOutput>) | undefined;
  let loadOverride: ((b: OpenCodeReplyRegistration, signal: AbortSignal) => Promise<OpenCodeReplyCheckpoint | undefined>) | undefined;
  let commitOverride: ((batch: OpenCodeReplyCommit, signal: AbortSignal) => Promise<void>) | undefined;
  const transport: OpenCodeReplyTransport = {
    async info() { calls.info++; return { version, pid: 1, urls: [], paths: { tmp: "/fixture" } }; },
    events(options) { calls.events++; return hints.stream(options!.signal!); },
    async session({ sessionID }) {
      calls.session++; const b = catalog.find(b => b.source.nativeSessionId === sessionID)!;
      return { id: sessionID, slug: "mock", version: nativeVersion, projectID: "project_mock", cost: 0, tokens, time: { created: b.creation.createdAt, updated: createdAt }, location: { directory: "/fixture" } };
    },
    async *log(input, options) {
      expect(input.follow).toBe(false);
      const { sessionID, after } = input, signal = options!.signal!;
      calls.logs.push({ sessionID, after, hasAfter: Object.hasOwn(input, "after"), signal });
      const b = catalog.find(b => b.source.nativeSessionId === sessionID)!;
      if (logOverride) { yield* logOverride(b, after, signal); return; }
      const events = logs.get(sessionID)!;
      for (const event of events) if (after === undefined || event.durable.seq > after) yield event;
      yield synced(b, events.at(-1)?.durable.seq);
    },
  };
  const observer = new OpenCodeReplyObserver({ authorityId: "mock_authority", sessions: () => catalog,
    async transport() { calls.transport++; return transport; },
    async load(b, signal) { calls.loads.push(b.source.nativeSessionId); return loadOverride ? loadOverride(b, signal) : saved.get(updateSourceKey(b.source)); },
    hasSeenMessage(b, id) { const sourceKey = updateSourceKey(b.source); calls.membership.push({ sourceKey, id }); return ledger.get(sourceKey)?.has(id) === true; },
    async commit(batch, signal) {
      calls.commitSignals.push(signal);
      if (commitOverride) await commitOverride(batch, signal);
      signal.throwIfAborted();
      const current = catalog.find(b => updateSourceKey(b.source) === updateSourceKey(batch.binding.source));
      if (!current || current.conversationId !== batch.binding.conversationId || current.registrationRevision !== batch.binding.registrationRevision) throw new Error("Stale registration");
      const old = saved.get(batch.checkpoint.sourceKey);
      if ((old?.progressThrough ?? null) !== batch.expectedProgressThrough) throw new Error("Checkpoint CAS conflict");
      // Atomic mock transaction: no fixture repair of reducer state or signals.
      const ids = new Set(ledger.get(batch.checkpoint.sourceKey));
      for (const id of batch.messageIds) ids.add(id);
      const newRows = batch.candidates.map(row => structuredClone(row));
      const cp = structuredClone(batch.checkpoint), committed = structuredClone(batch);
      ledger.set(cp.sourceKey, ids); saved.set(cp.sourceKey, cp);
      for (const row of newRows) rows.set(row.id, row);
      commits.push(committed);
    },
  });
  const b = () => catalog[0]!;
  return { observer, catalog, saved, ledger, rows, logs, hints, commits, calls, transport,
    qualify: () => observer.qualify(mockQualification()), setVersion: (v: string) => { version = v; },
    setLog: (v: typeof logOverride) => { logOverride = v; }, setLoad: (v: typeof loadOverride) => { loadOverride = v; }, setCommit: (v: typeof commitOverride) => { commitOverride = v; },
    cp: () => saved.get(updateSourceKey(b().source)), ready: () => observer.coverage()[0]?.state === "ready",
  };
}
function assertCoverage(f: ReturnType<typeof fixture>) {
  for (const coverage of f.observer.coverage()) {
    const cp = f.saved.get(coverage.sourceKey);
    if (coverage.through !== undefined) {
      const certifiedThrough = cp?.certifiedThrough;
      if (typeof certifiedThrough !== "number") throw new Error("Coverage through requires a certified checkpoint");
      expect(coverage.through).toBe(certifiedThrough);
    }
    if (coverage.baselineThrough !== undefined) { expect(coverage.through).toBeDefined(); expect(coverage.baselineThrough).toBeLessThanOrEqual(coverage.through!); }
  }
}

test("unqualified constructor/start opens no transport and fake descriptors never imply real qualification", async () => {
  const f = fixture(); f.observer.start(); f.observer.start(); f.observer.refresh(); await tick();
  expect(f.observer.qualificationStatus()).toEqual({ state: "unqualified", reason: OC_REPLY_UNQUALIFIED_REASON });
  expect(f.calls.transport).toBe(0); expect(f.calls.info).toBe(0); expect(f.calls.logs).toEqual([]); expect(f.commits).toEqual([]);
  expect(f.observer.coverage()[0]).toMatchObject({ state: "unqualified", reason: OC_REPLY_UNQUALIFIED_REASON });
  expect(Object.values(mockQualification().checks).every(c => c.evidenceRef.startsWith("fake-runtime-only:"))).toBe(true);
  await f.observer.close();
});

test("qualification gate requires every explicit fake-runtime check, identity/version and date", async () => {
  const f = fixture(), descriptor = mockQualification();
  const bad: unknown[] = [undefined, { ...descriptor, authorityId: "other" }, { ...descriptor, clientVersion: "2.0.19" }, { ...descriptor, nativeVersion: "" }, { ...descriptor, verifiedAt: "invalid" }, { ...descriptor, evidenceRef: "" }, { ...descriptor, checks: {} }];
  for (const k of OC_REPLY_QUALIFICATION_CHECKS) {
    bad.push({ ...descriptor, checks: { ...descriptor.checks, [k]: { passed: false, evidenceRef: "fake" } } });
    bad.push({ ...descriptor, checks: { ...descriptor.checks, [k]: { passed: true, evidenceRef: "" } } });
  }
  for (const value of bad) expect(() => f.observer.qualify(value as OpenCodeReplyQualification)).toThrow("evidenced runtime checks");
  expect(f.calls.info).toBe(0); f.qualify(); f.observer.start();
  expect(() => f.qualify()).toThrow("Close the observer"); await f.observer.close();
});

test("native creation zero: cold request omits after; restart at checkpoint zero explicitly includes after zero", async () => {
  const f = fixture(), b = f.catalog[0]!; f.qualify(); f.observer.start();
  try {
    await until(f.ready);
    expect(f.calls.logs[0]).toMatchObject({ hasAfter: false, after: undefined });
    expect(f.cp()).toMatchObject({ version: 2, nativeVersion, progressThrough: 0, certifiedThrough: 0, initialBaselineThrough: 0, state: { version: 2, seq: 0, created: true } });
    expect(f.commits[0]!.expectedProgressThrough).toBeNull(); assertCoverage(f);
    await f.observer.close(); f.logs.get(b.source.nativeSessionId)!.push(...reply(b)); f.observer.start();
    await until(() => f.cp()?.certifiedThrough === 6 && f.ready());
    expect(f.calls.logs[1]).toMatchObject({ hasAfter: true, after: 0 });
    expect([...f.rows.values()][0]).toMatchObject({ sourceSequence: 6, nativeBoundaryId: "evt_6", messageId: "msg_0" });
    expect([...f.rows.values()][0]!.historical).toBeUndefined(); assertCoverage(f);
  } finally { await f.observer.close(); }
});

test("pinned admission fence marks only <= fence historical, including live replies in first catch-up", async () => {
  const f = fixture(); f.catalog[0] = binding(0, 6); const b = f.catalog[0]!;
  f.logs.set(b.source.nativeSessionId, [creation(b), ...reply(b), ...reply(b, 6)]); f.qualify(); f.observer.start();
  try {
    await until(f.ready); expect(f.cp()).toMatchObject({ progressThrough: 12, certifiedThrough: 12, initialBaselineThrough: 6 });
    expect([...f.rows.values()]).toHaveLength(2);
    expect([...f.rows.values()][0]).toMatchObject({ sourceSequence: 6, historical: true });
    expect([...f.rows.values()][1]).toMatchObject({ sourceSequence: 12 }); expect([...f.rows.values()][1]!.historical).toBeUndefined();
    f.logs.get(b.source.nativeSessionId)!.push(...reply(b, 12)); f.observer.refresh(); await until(() => f.cp()?.certifiedThrough === 18);
    expect(f.cp()!.initialBaselineThrough).toBe(6); expect([...f.rows.values()][2]!.historical).toBeUndefined(); assertCoverage(f);
  } finally { await f.observer.close(); }
});

for (const watermark of [0, 42, undefined]) test(`empty cold watermark ${watermark} cannot fabricate creation, state, baseline or ready`, async () => {
  const f = fixture(); f.setLog(async function* (b) { yield synced(b, watermark); }); f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "degraded");
    expect(f.saved.size).toBe(0); expect(f.commits).toEqual([]); expect(f.rows.size).toBe(0);
    expect(f.observer.coverage()[0]!.through).toBeUndefined(); expect(f.observer.coverage()[0]!.baselineThrough).toBeUndefined();
    expect(f.calls.logs[0]!.hasAfter).toBe(false);
  } finally { await f.observer.close(); }
});

for (const mode of ["one-origin", "mixed-origin", "wrong-creation"] as const) test(`${mode} native creation is rejected without committing`, async () => {
  const f = fixture(); f.setLog(async function* (b) {
    const event = creation(b);
    if (mode === "one-origin") yield { ...event, durable: { ...event.durable, seq: 1 } };
    else if (mode === "wrong-creation") yield { ...event, id: "evt_other" };
    else { yield event; yield { ...event, durable: { ...event.durable, seq: 1 } }; }
    yield synced(b, 1);
  }); f.qualify(); f.observer.start();
  try { await until(() => f.observer.coverage()[0]?.state === "degraded"); expect(f.saved.size).toBe(0); expect(f.commits).toEqual([]); }
  finally { await f.observer.close(); }
});

test("validated quota prefix publishes a candidate before log.synced without ready or fabricated certification", async () => {
  const f = fixture(); f.catalog[0] = binding(0, 200); const b = f.catalog[0]!, release = deferred();
  const events = [creation(b), ...reply(b)];
  for (let seq = 7; seq <= 140; seq++) events.push(durable(b, seq, "session.renamed", { title: "Prefix" }));
  f.setLog(async function* (b, after, signal) {
    for (const e of events) if (after === undefined || e.durable.seq > after) yield e;
    await Promise.race([release.promise, aborted(signal)]); signal.throwIfAborted(); yield synced(b, 140);
  }); f.qualify(); f.observer.start();
  try {
    await until(() => f.rows.size === 1);
    expect([...f.rows.values()][0]).toMatchObject({ historical: true, sourceSequence: 6 });
    expect(f.cp()).toMatchObject({ certifiedThrough: null, initialBaselineThrough: 200 });
    expect(f.cp()!.progressThrough).toBeGreaterThanOrEqual(127); expect(f.cp()!.state.seq).toBe(f.cp()!.progressThrough);
    expect(f.ready()).toBe(false); expect(f.observer.coverage()[0]!.through).toBeUndefined(); expect(f.observer.coverage()[0]!.baselineThrough).toBeUndefined();
    expect(f.commits.every(c => c.coverage.state !== "ready")).toBe(true);
    release.resolve(); await until(f.ready); expect(f.cp()!.certifiedThrough).toBe(140); assertCoverage(f);
    expect(f.observer.coverage()[0]!.baselineThrough).toBeUndefined();
  } finally { release.resolve(); await f.observer.close(); }
});

test("ordinary 128-event slices replay >10k total, survive restart, and certify only exact final watermark", async () => {
  const f = fixture(), b = f.catalog[0]!;
  const events: SessionEventDurable[] = [creation(b)];
  for (let seq = 1; seq <= 10500; seq++) events.push(durable(b, seq, "session.renamed", { title: "Long history" }));
  events.push(...reply(b, 10500)); f.logs.set(b.source.nativeSessionId, events);
  let blockedSignal: AbortSignal | undefined;
  f.setCommit(async (batch, signal) => { if (batch.checkpoint.progressThrough >= 5000) { blockedSignal = signal; await aborted(signal); signal.throwIfAborted(); } });
  f.qualify(); f.observer.start();
  try {
    await until(() => blockedSignal !== undefined); const retained = structuredClone(f.cp()!);
    expect(retained.progressThrough).toBeGreaterThan(0); expect(retained.certifiedThrough).toBeNull();
    await f.observer.close(); expect(blockedSignal!.aborted).toBe(true); expect(f.cp()).toEqual(retained);
    f.setCommit(undefined); f.observer.start(); await until(() => f.cp()?.certifiedThrough === 10506 && f.ready());
    expect(f.rows.size).toBe(1); expect([...f.rows.values()][0]!.sourceSequence).toBe(10506);
    let previous: number | null = null;
    for (const c of f.commits) {
      expect(c.expectedProgressThrough).toBe(previous); expect(c.checkpoint.progressThrough - (previous ?? -1)).toBeLessThanOrEqual(128);
      expect(c.checkpoint.state.seq).toBe(c.checkpoint.progressThrough); expect(bytes(c.checkpoint)).toBeLessThanOrEqual(256 * 1024);
      previous = c.checkpoint.progressThrough;
    }
    expect(f.calls.logs.some(c => c.after === retained.progressThrough)).toBe(true); assertCoverage(f);
  } finally { await f.observer.close(); }
});

test("512 KiB normal byte quota rotates slices without degrading the whole long source", async () => {
  const f = fixture(), b = f.catalog[0]!, events: SessionEventDurable[] = [creation(b)];
  for (let seq = 1; seq <= 1500; seq++) events.push(durable(b, seq, "session.synthetic", { text: "x".repeat(6000) }));
  events.push(...reply(b, 1500)); f.logs.set(b.source.nativeSessionId, events); f.qualify(); f.observer.start();
  try {
    await until(f.ready); expect(f.cp()!.certifiedThrough).toBe(1506); expect(f.rows.size).toBe(1); expect(f.commits.length).toBeGreaterThan(15);
    let after = -1;
    for (const c of f.commits) {
      const slice = events.filter(e => e.durable.seq > after && e.durable.seq <= c.checkpoint.progressThrough);
      expect(slice.length).toBeLessThanOrEqual(128); expect(slice.reduce((sum, e) => sum + bytes(e), 0)).toBeLessThanOrEqual(512 * 1024);
      expect(bytes(c.checkpoint)).toBeLessThanOrEqual(256 * 1024); after = c.checkpoint.progressThrough;
    }
    assertCoverage(f);
  } finally { await f.observer.close(); }
});

for (const mode of ["gap", "wrong-schema", "missing-watermark", "wrong-watermark", "ended"] as const) test(`${mode} invalid current chunk cannot advance; earlier committed prefix remains`, async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old);
  f.setLog(async function* (b, after) {
    for (let seq = Math.max(1, (after ?? -1) + 1); seq <= 128; seq++) yield durable(b, seq, "session.renamed", { title: "Validated earlier slice" });
    for (const e of reply(b, 128)) if (after === undefined || e.durable.seq > after) yield e;
    if (mode === "gap") yield durable(b, 136, "session.renamed", { title: "Gap" });
    else if (mode === "wrong-schema") {
      // Intentionally malformed raw transport payload, not a valid native SDK event.
      yield { ...durable(b, 135, "session.renamed", { title: "Bad version" }), durable: { aggregateID: b.source.nativeSessionId, seq: 135, version: 99 } } as unknown as SessionLogOutput;
    }
    else if (mode !== "ended") yield synced(b, mode === "missing-watermark" ? undefined : 135);
  }); f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "degraded");
    expect(f.cp()).toMatchObject({ progressThrough: 128, certifiedThrough: 0, state: { seq: 128 } });
    expect(f.commits.length).toBeGreaterThan(0); expect(f.rows.size).toBe(0); expect(f.ledger.get(old.sourceKey)?.size ?? 0).toBe(0);
    expect(f.observer.coverage()[0]).toMatchObject({ state: "degraded", through: 0, baselineThrough: 0 }); assertCoverage(f);
  } finally { await f.observer.close(); }
});

for (const mode of ["oversized-item", "oversized-raw-item", "wrapped-raw-bytes"] as const) test(`${mode} source degrades without hot-loop or fabricated progress`, async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old);
  f.setLog(async function* (b, after) {
    if (mode === "wrapped-raw-bytes") throw new Error("SDK wrapper", { cause: new OpenCodeReplyTransportLimitError() });
    if (after === undefined || after < 1) yield durable(b, 1, "session.synthetic", { text: "x".repeat(mode === "oversized-raw-item" ? 17 * 1024 * 1024 : 600 * 1024) }); yield synced(b, 1);
  }); f.qualify(); f.observer.start();
  try {
    await until(() => ["degraded", "ready"].includes(f.observer.coverage()[0]?.state ?? "")); const reads = f.calls.logs.length;
    for (let i = 0; i < 50; i++) await tick();
    expect(f.observer.coverage()[0]!.state).toBe("degraded"); expect(f.calls.logs.length).toBe(reads); expect(f.cp()).toEqual(old); expect(f.commits).toEqual([]); assertCoverage(f);
  } finally { await f.observer.close(); }
});

test("raw transport rotation saves validated prefix with lifetime signal, then resumes and certifies", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old);
  let failedRead: AbortSignal | undefined;
  f.setLog(async function* (b, after, signal) {
    if (after === 0) { yield* reply(b); failedRead = signal; throw new Error("wrapped", { cause: new OpenCodeReplyTransportLimitError() }); }
    yield synced(b, 6);
  }); f.qualify(); f.observer.start();
  try {
    await until(() => f.cp()?.progressThrough === 6); expect(f.rows.size).toBe(1);
    expect(f.calls.commitSignals[0]).not.toBe(failedRead); expect(f.calls.commitSignals[0]!.aborted).toBe(false);
    await until(f.ready); expect(f.cp()!.certifiedThrough).toBe(6); expect(f.calls.logs.some(c => c.after === 6)).toBe(true); assertCoverage(f);
  } finally { await f.observer.close(); }
});

test("read deadline rotation commits prefix under non-aborted lifetime signal, never the aborted read signal", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old);
  const deadline = new AbortController(), originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  let firstReadDeadline = true;
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    if (ms === 15000 && firstReadDeadline) { firstReadDeadline = false; return deadline.signal; }
    return originalTimeout(ms);
  });
  let readSignal: AbortSignal | undefined, commitSignal: AbortSignal | undefined;
  f.setLog(async function* (b, after, signal) {
    if (after === 0) { yield* reply(b); readSignal = signal; await aborted(signal); signal.throwIfAborted(); }
    else yield synced(b, 6);
  });
  f.setCommit(async (_batch, signal) => { commitSignal = signal; expect(signal.aborted).toBe(false); expect(signal).not.toBe(readSignal); });
  f.qualify(); f.observer.start();
  try {
    await until(() => readSignal !== undefined); deadline.abort();
    await until(() => commitSignal !== undefined);
    expect(readSignal!.aborted).toBe(true); expect(commitSignal!.aborted).toBe(false); expect(f.cp()!.progressThrough).toBe(6); expect(f.rows.size).toBe(1);
    timeout.mockRestore(); f.observer.refresh(); await until(f.ready); expect(f.cp()!.certifiedThrough).toBe(6); assertCoverage(f);
  } finally { timeout.mockRestore(); await f.observer.close(); }
});

test("productive bounded FIFO gives all 300 sessions real replies with <= two active logs", async () => {
  const f = fixture(300); let active = 0, maximum = 0;
  for (const b of f.catalog) f.logs.set(b.source.nativeSessionId, [creation(b), ...reply(b)]);
  f.setLog(async function* (b, after) {
    active++; maximum = Math.max(maximum, active);
    try { await tick(); for (const event of f.logs.get(b.source.nativeSessionId)!) if (after === undefined || event.durable.seq > after) yield event; yield synced(b, 6); }
    finally { active--; }
  }); f.qualify(); f.observer.start();
  try {
    f.observer.refresh(); f.hints.push({ id: "evt_connected", type: "server.connected", data: {} });
    await until(() => f.saved.size === 300 && f.observer.coverage().every(c => c.state === "ready"));
    expect(f.rows.size).toBe(300); expect(new Set(f.calls.loads).size).toBe(300); expect(maximum).toBe(2);
    expect(f.saved.get(updateSourceKey(f.catalog[299]!.source))!.certifiedThrough).toBe(6); assertCoverage(f);
  } finally { await f.observer.close(); }
});

test("cross-slice/restart reconstruction matches whole-log model for text replacement, retry, synthetic and compaction", async () => {
  const f = fixture(), b = f.catalog[0]!, events: SessionEventDurable[] = [creation(b)];
  let seq = 0;
  function emit<K extends SessionEventDurable["type"]>(type: K, data: Omit<Native<K>["data"], "sessionID">) { const event = durable(b, ++seq, type, data); events.push(event); }
  const pad = (through: number) => { while (seq < through) emit("session.renamed", { title: "Slice padding" }); };
  const step = (id: string) => emit("session.step.started", { assistantMessageID: id, started: createdAt, agent: "build", model: { providerID: "mock", id: "mock" } });
  const end = (id: string) => emit("session.step.ended", { assistantMessageID: id, finish: "stop", cost: 0, tokens });
  pad(124); emit("session.execution.started", {}); step("msg_retry"); emit("session.text.started", { assistantMessageID: "msg_retry", ordinal: 0 });
  emit("session.text.ended", { assistantMessageID: "msg_retry", ordinal: 0, text: "Original text" });
  emit("session.message.content.updated", { messageID: "msg_retry", content: [{ type: "reasoning", text: "Replacement" }] });
  emit("session.step.failed", { assistantMessageID: "msg_retry", error });
  pad(254); emit("session.retry.scheduled", { assistantMessageID: "msg_retry", attempt: 1, at: createdAt, error }); step("msg_retry");
  emit("session.text.started", { assistantMessageID: "msg_retry", ordinal: 0 }); emit("session.text.ended", { assistantMessageID: "msg_retry", ordinal: 0, text: "Retry result" }); end("msg_retry"); emit("session.execution.succeeded", {});
  pad(382); emit("session.synthetic", { text: "Background result", metadata: { arbitrary: true } }); emit("session.execution.started", {}); step("msg_synthetic");
  emit("session.message.content.updated", { messageID: "msg_synthetic", content: [{ type: "text", text: "Continuation reply" }] }); end("msg_synthetic"); emit("session.execution.succeeded", {});
  pad(509); emit("session.execution.started", {}); emit("session.compaction.started", { reason: "manual", recent: "msg_synthetic" }); step("msg_compact");
  emit("session.message.content.updated", { messageID: "msg_compact", content: [{ type: "text", text: "Summary not reply" }] }); end("msg_compact"); emit("session.execution.succeeded", {});
  let model = initialOpenCodeReplyState(b); const expected: ConversationUpdateCandidate[] = [];
  for (const event of events) { const result = reduceOpenCodeReply(model, event, b); model = result.state; if (result.candidate) expected.push(result.candidate); }
  expect(expected.map(c => c.messageId)).toEqual(["msg_retry", "msg_synthetic"]);
  f.logs.set(b.source.nativeSessionId, events); let blocking: AbortSignal | undefined;
  f.setCommit(async (batch, signal) => { if (batch.checkpoint.progressThrough > 127) { blocking = signal; await aborted(signal); signal.throwIfAborted(); } });
  f.qualify(); f.observer.start();
  try {
    await until(() => blocking !== undefined); expect(f.cp()!.state.window?.step?.texts).toEqual([{ complete: false, nonempty: false }]);
    await f.observer.close(); f.setCommit(undefined); f.observer.start(); await until(f.ready);
    expect([...f.rows.values()]).toEqual(expected);
    // Durable ledger replaces the transient seenMessages cache, not model reconstruction.
    expect({ ...f.cp()!.state, seenMessages: [], identityLedger: "external" }).toEqual({ ...model, seenMessages: [], identityLedger: "external" });
    expect(f.ledger.get(updateSourceKey(b.source))).toEqual(new Set(model.seenMessages)); assertCoverage(f);
  } finally { await f.observer.close(); }
});

test("exact source ledger >4096 persists across restart and suppresses old-ID failed/retry reopen", async () => {
  const f = fixture(), b = f.catalog[0]!, events: SessionEventDurable[] = [creation(b)]; let after = 0;
  for (let i = 0; i < 4100; i++) { const next = reply(b, after, `msg_long_${i}`); events.push(...next); after += 6; }
  f.logs.set(b.source.nativeSessionId, events); f.qualify(); f.observer.start();
  try {
    await until(f.ready); const key = updateSourceKey(b.source);
    expect(f.rows.size).toBe(4100); expect(f.ledger.get(key)!.size).toBe(4100); expect(bytes(f.cp())).toBeLessThanOrEqual(256 * 1024);
    await f.observer.close();
    const reused = reply(b, after, "msg_long_0");
    reused.splice(2, 0, durable(b, after + 3, "session.step.failed", { assistantMessageID: "msg_long_0", error }),
      durable(b, after + 4, "session.retry.scheduled", { assistantMessageID: "msg_long_0", attempt: 1, at: createdAt, error }),
      durable(b, after + 5, "session.step.started", { assistantMessageID: "msg_long_0", started: createdAt, agent: "build", model: { providerID: "mock", id: "mock" } }));
    // Resequencing changes only the envelope; each event's type/data correlation stays intact.
    const tail = reused.map((e, i) => ({ ...e, id: `evt_${after + i + 1}`, created: createdAt + after + i + 1, durable: { ...e.durable, seq: after + i + 1 } }) as unknown as SessionEventDurable);
    f.logs.get(b.source.nativeSessionId)!.push(...tail); f.observer.start();
    await until(() => f.cp()?.certifiedThrough === after + tail.length && f.ready());
    expect(f.rows.size).toBe(4100); expect(f.ledger.get(key)!.size).toBe(4100);
    expect(f.calls.membership.some(c => c.sourceKey === key && c.id === "msg_long_0")).toBe(true);
    expect(f.commits.at(-1)!.candidates).toEqual([]); assertCoverage(f);
  } finally { await f.observer.close(); }
});

test("ledger membership is exact and source-scoped, not a global duplicate filter", async () => {
  const f = fixture(2);
  for (const b of f.catalog) f.logs.set(b.source.nativeSessionId, [creation(b), ...reply(b, 0, "msg_shared")]);
  f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage().every(c => c.state === "ready")); expect(f.rows.size).toBe(2);
    for (const b of f.catalog) expect(f.ledger.get(updateSourceKey(b.source))).toEqual(new Set(["msg_shared"]));
  } finally { await f.observer.close(); }
});

test("checkpoint-v2 validates distinct progress/certification/fence and reducer state", () => {
  const b = binding(0, 1000), cp = checkpoint(b);
  expect(validateOpenCodeReplyCheckpoint(cp, b, nativeVersion)).toBe(true);
  expect(validateOpenCodeReplyCheckpoint({ ...cp, certifiedThrough: null }, b)).toBe(true);
  for (const invalid of [
    { ...cp, version: 1 }, { ...cp, through: 0, baselineThrough: 0 }, { ...cp, nativeVersion: "" }, { ...cp, sourceKey: "foreign" },
    { ...cp, progressThrough: -1 }, { ...cp, progressThrough: 1 }, { ...cp, certifiedThrough: 1 }, { ...cp, certifiedThrough: -1 }, { ...cp, initialBaselineThrough: 999 },
    { ...cp, state: { ...cp.state, version: 1 } }, { ...cp, state: { ...cp.state, seq: -1 } }, { ...cp, state: { ...cp.state, created: false } },
    { ...cp, state: { ...cp.state, creation: { ...b.creation, eventId: "other" } } }, { ...cp, state: { ...cp.state, seenMessages: ["duplicate", "duplicate"] } },
    { ...cp, state: { ...cp.state, window: { id: "window", eligible: true, compacting: false, step: { messageId: "unknown" } } } },
  ]) expect(validateOpenCodeReplyCheckpoint(invalid, b)).toBe(false);
  expect(validateOpenCodeReplyCheckpoint(cp, b, "other-version")).toBe(false);
});

for (const id of ["m".repeat(1025), "é".repeat(600)]) test(`checkpoint message identity rejects ${new TextEncoder().encode(id).byteLength} bytes`, () => {
  const b = binding(), cp = checkpoint(b);
  expect(validateOpenCodeReplyCheckpoint({ ...cp, state: { ...cp.state, seenMessages: [id] } }, b)).toBe(false);
});

test("256 KiB checkpoint budget rejects real state size, not a dummy invalid envelope", () => {
  const b = binding(), cp = checkpoint(b);
  const padded = (count: number) => ({ ...cp, state: { ...cp.state, seenMessages: Array.from({ length: count }, (_, i) => `m${i}_` + "x".repeat(1000)) } });
  const within = padded(200), over = padded(280);
  expect(bytes(within)).toBeLessThan(256 * 1024); expect(within.state.seenMessages.every(id => new TextEncoder().encode(id).byteLength <= 1024)).toBe(true);
  expect(validateOpenCodeReplyCheckpoint(within, b)).toBe(true);
  expect(bytes(over)).toBeGreaterThan(256 * 1024); expect(over.state.seenMessages.every(id => id.length <= 1024)).toBe(true);
  expect(validateOpenCodeReplyCheckpoint(over, b)).toBe(false);
});

test("old or corrupt checkpoint rejects before session replay rather than migrating one-origin state", async () => {
  for (const old of [true, false]) {
    const f = fixture(), b = f.catalog[0]!, cp = checkpoint(b);
    f.saved.set(cp.sourceKey, (old ? { version: 1, sourceKey: cp.sourceKey, through: 1, baselineThrough: 1, state: { ...cp.state, version: 1, seq: 1 } } : { ...cp, state: undefined }) as unknown as OpenCodeReplyCheckpoint);
    f.qualify(); f.observer.start();
    try { await until(() => f.observer.coverage()[0]?.state === "degraded"); expect(f.calls.logs).toEqual([]); expect(f.commits).toEqual([]); }
    finally { await f.observer.close(); }
  }
});

test("native version mismatch rejects evidenced runtime and preserves certified checkpoint", async () => {
  const f = fixture(), cp = checkpoint(f.catalog[0]!); f.saved.set(cp.sourceKey, cp); f.setVersion("other-version"); f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "unqualified"); expect(f.observer.coverage()[0]).toMatchObject({ through: 0, reason: "Native version differs from evidenced reply qualification" });
    expect(f.cp()).toEqual(cp); expect(f.calls.logs).toEqual([]); expect(f.commits).toEqual([]);
  } finally { await f.observer.close(); }
});

for (const mode of ["child", "creation-changed-after-replay", "native-id-changed"] as const) test(`ownership ${mode} prevents attention`, async () => {
  const f = fixture(), b = f.catalog[0]!, cp = checkpoint(b); f.saved.set(cp.sourceKey, cp); f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
  const original = f.transport.session; let reads = 0;
  f.transport.session = async (input, options) => {
    const session = await original(input, options); reads++;
    if (mode === "child") return { ...session, parentID: "ses_native_parent" };
    if (mode === "native-id-changed") return { ...session, id: "ses_other" };
    return reads === 2 ? { ...session, time: { ...session.time, created: createdAt + 1 } } : session;
  }; f.qualify(); f.observer.start();
  try { await until(() => f.observer.coverage()[0]?.state === "degraded"); expect(f.rows.size).toBe(0); expect(f.cp()).toEqual(cp); }
  finally { await f.observer.close(); }
});

test("global hints never inject candidates; disconnect replays durable log without a terminal hint", async () => {
  const f = fixture(), b = f.catalog[0]!, cp = checkpoint(b); f.saved.set(cp.sourceKey, cp); f.qualify(); f.observer.start();
  try {
    await until(f.ready); const reads = f.calls.logs.length;
    f.hints.push(durable(binding(99), 6, "session.execution.succeeded", {})); await tick(); expect(f.calls.logs.length).toBe(reads); expect(f.rows.size).toBe(0);
    f.logs.get(b.source.nativeSessionId)!.push(...reply(b)); f.hints.push(new Error("Fake disconnect"));
    await until(() => f.cp()?.certifiedThrough === 6); expect(f.rows.size).toBe(1); assertCoverage(f);
  } finally { await f.observer.close(); }
});

test("atomic rollback leaves ledger, candidates and cursor untouched; retry preserves occurrence identity", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old); f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
  const attempts: OpenCodeReplyCommit[] = [];
  f.setCommit(async batch => { attempts.push(structuredClone(batch)); if (attempts.length === 1) throw new Error("Fake rollback"); });
  f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "degraded"); expect(f.cp()).toEqual(old); expect(f.rows.size).toBe(0); expect(f.ledger.size).toBe(0);
    await f.observer.close(); f.observer.start(); await until(f.ready); expect(attempts[1]!.candidates).toEqual(attempts[0]!.candidates); expect(attempts[1]!.messageIds).toEqual(attempts[0]!.messageIds);
    expect(f.calls.logs.map(c => c.after)).toEqual([0, 0]); expect(f.rows.size).toBe(1); expect(f.cp()!.certifiedThrough).toBe(6);
  } finally { await f.observer.close(); }
});

test("atomic checkpoint CAS rejects competing progress without overwriting winning store state", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b), winner = checkpoint(b, [creation(b), durable(b, 1, "session.renamed", { title: "Competing progress" })]); f.saved.set(old.sourceKey, old); f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
  f.setCommit(async batch => { expect(batch.expectedProgressThrough).toBe(0); f.saved.set(winner.sourceKey, winner); }); f.qualify(); f.observer.start();
  try { await until(() => f.observer.coverage()[0]?.state === "degraded"); expect(f.cp()).toEqual(winner); expect(f.commits).toEqual([]); expect(f.ledger.size).toBe(0); expect(f.rows.size).toBe(0); }
  finally { await f.observer.close(); }
});

for (const stage of ["load", "session", "log", "commit"] as const) for (const mode of ["remove", "rebind", "ABA"] as const) test(`${mode} registration actively aborts blocked ${stage} without manual release`, async () => {
  const f = fixture(), b = f.catalog[0]!, cp = checkpoint(b); f.saved.set(cp.sourceKey, cp); f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
  let blockedSignal: AbortSignal | undefined, exited = false;
  const block = async (signal: AbortSignal) => { if (blockedSignal) return; blockedSignal = signal; try { await aborted(signal); signal.throwIfAborted(); } finally { exited = true; } };
  if (stage === "load") f.setLoad(async (_b, signal) => { await block(signal); return cp; });
  if (stage === "session") { const original = f.transport.session; f.transport.session = async (input, options) => { await block(options!.signal!); return original(input, options); }; }
  if (stage === "log") f.setLog(async function* (b, after, signal) { await block(signal); for (const event of reply(b)) if (after === undefined || event.durable.seq > after) yield event; yield synced(b, 6); });
  if (stage === "commit") f.setCommit(async (_batch, signal) => { await block(signal); });
  f.qualify(); f.observer.start();
  try {
    await until(() => blockedSignal !== undefined);
    if (mode === "remove") f.catalog.splice(0, 1);
    else if (mode === "ABA") { f.catalog.splice(0, 1); f.observer.refresh(); f.catalog.push({ ...b, registrationRevision: "registration_0_2" }); }
    else f.catalog[0] = { ...b, conversationId: "app_rebound", registrationRevision: "registration_0_2" };
    f.observer.refresh();
    // Independent signal assertions: the atomic mock's stale-registration rejection cannot make these pass.
    await until(() => blockedSignal!.aborted); expect(blockedSignal!.aborted).toBe(true); await until(() => exited);
    expect(f.commits.some(c => c.binding.registrationRevision === b.registrationRevision)).toBe(false);
    if (mode === "remove") { expect(f.observer.coverage()).toEqual([]); expect(f.saved.get(cp.sourceKey)).toEqual(cp); }
    else { await until(f.ready); expect(f.commits.some(c => c.binding.registrationRevision === "registration_0_2")).toBe(true); }
  } finally { await f.observer.close(); }
});

for (const stage of ["load", "session", "log", "commit"] as const) test(`close aborts blocked ${stage}, preserves checkpoint, and cannot reschedule`, async () => {
  const f = fixture(), b = f.catalog[0]!, cp = checkpoint(b); f.saved.set(cp.sourceKey, cp); f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
  let signal: AbortSignal | undefined;
  const block = async (s: AbortSignal) => { signal = s; await aborted(s); s.throwIfAborted(); };
  if (stage === "load") f.setLoad(async (_b, s) => { await block(s); return cp; });
  if (stage === "session") { const original = f.transport.session; f.transport.session = async (input, options) => { await block(options!.signal!); return original(input, options); }; }
  if (stage === "log") f.setLog(async function* (_b, _after, s) { await block(s); });
  if (stage === "commit") f.setCommit(async (_batch, s) => { await block(s); });
  f.qualify(); f.observer.start();
  try { await until(() => signal !== undefined); await f.observer.close(); expect(signal!.aborted).toBe(true); const count = f.calls.logs.length; f.observer.refresh(); await tick(); expect(f.calls.logs.length).toBe(count); expect(f.commits).toEqual([]); expect(f.cp()).toEqual(cp); }
  finally { await f.observer.close(); }
});

test("load/commit/diagnostic failures remain source-scoped without unhandled rejections", async () => {
  const unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error); }; process.on("unhandledRejection", onUnhandled);
  const f = fixture(3);
  f.setLoad(async b => { if (b.source.nativeSessionId === "ses_0") throw new Error("Fake load failure"); return undefined; });
  f.setCommit(async batch => { if (batch.binding.source.nativeSessionId === "ses_1") throw new Error("Fake rollback"); });
  const other = new OpenCodeReplyObserver({ authorityId: "mock_authority", sessions: () => [binding()], transport: async () => { throw new Error("must not connect"); }, load: async () => undefined, hasSeenMessage: () => false, commit: async () => {}, coverage: async () => { throw new Error("Fake diagnostic failure"); } });
  f.qualify(); f.observer.start(); other.start();
  try { await until(() => f.observer.coverage().filter(c => c.state === "degraded").length === 2 && f.saved.size === 1); await tick(); expect(unhandled).toEqual([]); expect(f.saved.has(updateSourceKey(f.catalog[2]!.source))).toBe(true); }
  finally { await f.observer.close(); await other.close(); process.off("unhandledRejection", onUnhandled); }
});
