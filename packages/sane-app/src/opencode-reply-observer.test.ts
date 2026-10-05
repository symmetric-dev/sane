import { expect, test } from "bun:test";
import type { SessionEventDurable, SessionLogOutput, V2Event } from "@opencode/client";
import { OpenCodeReplyTransportLimitError, type OpenCodeReplyTransport } from "./opencode";
import { OC_REPLY_QUALIFICATION_CHECKS, OpenCodeReplyObserver, validateOpenCodeReplyCheckpoint, type OpenCodeReplyCheckpoint, type OpenCodeReplyCommit, type OpenCodeReplyQualification } from "./opencode-reply-observer";
import { initialOpenCodeReplyState, OC_REPLY_UNQUALIFIED_REASON, openCodeIncarnation, reduceOpenCodeReply, type OpenCodeReplyBinding } from "../shared/conversation/oc-reply-reducer";
import { updateSourceKey } from "../shared/conversation/conversation-updates";

const createdAt = Date.parse("2026-10-01T00:00:00Z");
const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } };
type Native<K extends SessionEventDurable["type"]> = Extract<SessionEventDurable, { type: K }>;
function binding(index = 0): OpenCodeReplyBinding {
  const creation = { eventId: `evt_created_${index}`, createdAt };
  return { conversationId: `app_${index}`, creation, source: { harness: "opencode", authorityId: "mock_authority", nativeSessionId: `ses_${index}`, incarnation: openCodeIncarnation(creation) } };
}
function durable<K extends SessionEventDurable["type"]>(b: OpenCodeReplyBinding, seq: number, type: K, data: Omit<Native<K>["data"], "sessionID">): Native<K> {
  return { id: seq === 1 ? b.creation.eventId : `evt_${seq}`, created: seq === 1 ? b.creation.createdAt : createdAt + seq, type,
    durable: { aggregateID: b.source.nativeSessionId, seq, version: 1 }, data: { sessionID: b.source.nativeSessionId, ...data } } as unknown as Native<K>;
}
function creation(b: OpenCodeReplyBinding): SessionEventDurable {
  return durable(b, 1, "session.created", { projectID: "project_mock", location: { directory: "/fixture" }, slug: "mock", version: "2.0.18" });
}
function reply(b: OpenCodeReplyBinding, after = 1): SessionEventDurable[] {
  const messageID = `msg_${after}`;
  return [
    durable(b, after + 1, "session.execution.started", {}),
    durable(b, after + 2, "session.step.started", { assistantMessageID: messageID, started: createdAt, agent: "build", model: { providerID: "mock", id: "mock" } }),
    durable(b, after + 3, "session.text.started", { assistantMessageID: messageID, ordinal: 0 }),
    durable(b, after + 4, "session.text.ended", { assistantMessageID: messageID, ordinal: 0, text: "Actual native fixture reply" }),
    durable(b, after + 5, "session.step.ended", { assistantMessageID: messageID, finish: "stop", cost: 0, tokens }),
    durable(b, after + 6, "session.execution.succeeded", {}),
  ];
}
const synced = (b: OpenCodeReplyBinding, seq?: number): SessionLogOutput => ({ type: "log.synced", aggregateID: b.source.nativeSessionId, ...(seq === undefined ? {} : { seq }) });
function checkpoint(b: OpenCodeReplyBinding, events: SessionEventDurable[] = [creation(b)]): OpenCodeReplyCheckpoint {
  let state = initialOpenCodeReplyState(b);
  for (const event of events) state = reduceOpenCodeReply(state, event, b, true).state;
  return { version: 1, sourceKey: updateSourceKey(b.source), through: state.seq, baselineThrough: state.seq, state };
}

/** Deliberately mock-only evidence. Never stored or applied to a real adapter. */
function mockQualification(): OpenCodeReplyQualification {
  return { authorityId: "mock_authority", clientVersion: "2.0.18", nativeVersion: "mock-native", verifiedAt: "2026-10-01T00:00:00Z", evidenceRef: "mock-only:not-runtime-evidence",
    checks: Object.fromEntries(OC_REPLY_QUALIFICATION_CHECKS.map(k => [k, { passed: true, evidenceRef: `mock-only:${k}` }])) as OpenCodeReplyQualification["checks"] };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
}
/** Flush only in-memory fixture work; never wait for an external service. */
async function until(predicate: () => boolean) {
  for (let i = 0; i < 5000; i++) { if (predicate()) return; await new Promise<void>(r => setImmediate(r)); }
  throw new Error("Mock observer did not reach expected state");
}
class Hints {
  private queue: (V2Event | Error)[] = [];
  private wake?: () => void;
  push(value: V2Event | Error) { this.queue.push(value); this.wake?.(); }
  async *stream(signal: AbortSignal): AsyncGenerator<V2Event> {
    while (!signal.aborted) {
      if (!this.queue.length) {
        await new Promise<void>(resolve => {
          const done = () => { signal.removeEventListener("abort", done); this.wake = undefined; resolve(); };
          this.wake = done; signal.addEventListener("abort", done, { once: true }); if (signal.aborted) done();
        });
      }
      if (signal.aborted) return;
      const next = this.queue.shift(); if (next instanceof Error) throw next; if (next) yield next;
    }
  }
}

function fixture(count = 1) {
  const catalog = Array.from({ length: count }, (_, i) => binding(i));
  const saved = new Map<string, OpenCodeReplyCheckpoint>();
  const logs = new Map(catalog.map(b => [b.source.nativeSessionId, [creation(b)] as SessionEventDurable[]]));
  const hints = new Hints(), commits: OpenCodeReplyCommit[] = [];
  const calls = { transport: 0, info: 0, events: 0, session: 0, logs: [] as { sessionID: string; after: number }[], loads: [] as string[] };
  let version = "mock-native";
  let logOverride: ((b: OpenCodeReplyBinding, after: number, signal: AbortSignal) => AsyncIterable<SessionLogOutput>) | undefined;
  let loadOverride: ((b: OpenCodeReplyBinding, signal: AbortSignal) => Promise<OpenCodeReplyCheckpoint | undefined>) | undefined;
  let commitOverride: ((batch: OpenCodeReplyCommit, signal: AbortSignal) => Promise<void>) | undefined;
  const transport: OpenCodeReplyTransport = {
    async info() { calls.info++; return { version, pid: 1, urls: [], paths: { tmp: "/fixture" } }; },
    events(options) { calls.events++; return hints.stream(options!.signal!); },
    async session({ sessionID }) {
      calls.session++; const b = catalog.find(b => b.source.nativeSessionId === sessionID)!;
      return { id: sessionID, slug: "mock", version: "mock-native", projectID: "project_mock", cost: 0, tokens, time: { created: b.creation.createdAt, updated: createdAt }, location: { directory: "/fixture" } };
    },
    async *log({ sessionID, after = 0, follow }, options) {
      expect(follow).toBe(false); calls.logs.push({ sessionID, after });
      const b = catalog.find(b => b.source.nativeSessionId === sessionID)!;
      if (logOverride) { yield* logOverride(b, after, options!.signal!); return; }
      const events = logs.get(sessionID)!;
      for (const event of events) if (event.durable.seq > after) yield event;
      yield synced(b, events.at(-1)!.durable.seq);
    },
  };
  const observer = new OpenCodeReplyObserver({ authorityId: "mock_authority", sessions: () => catalog,
    async transport() { calls.transport++; return transport; },
    async load(b, signal) { calls.loads.push(b.source.nativeSessionId); return loadOverride ? loadOverride(b, signal) : saved.get(updateSourceKey(b.source)); },
    async commit(batch, signal) {
      if (commitOverride) await commitOverride(batch, signal);
      signal.throwIfAborted();
      // The injected atomic-store contract must also guard current registration.
      if (!catalog.some(b => updateSourceKey(b.source) === updateSourceKey(batch.binding.source) && b.conversationId === batch.binding.conversationId)) throw new Error("Stale registration");
      commits.push(structuredClone(batch)); saved.set(batch.checkpoint.sourceKey, structuredClone(batch.checkpoint));
    },
  });
  return { observer, catalog, saved, logs, hints, commits, calls, transport,
    qualify: () => observer.qualify(mockQualification()),
    setVersion: (v: string) => { version = v; },
    setLog: (v: typeof logOverride) => { logOverride = v; },
    setLoad: (v: typeof loadOverride) => { loadOverride = v; },
    setCommit: (v: typeof commitOverride) => { commitOverride = v; },
  };
}

test("constructor/start stay unqualified and open no native transport by default", async () => {
  const f = fixture(); expect(f.calls.transport).toBe(0);
  expect(f.observer.qualificationStatus()).toEqual({ state: "unqualified", reason: OC_REPLY_UNQUALIFIED_REASON });
  f.observer.start(); f.observer.start(); f.observer.refresh();
  await new Promise<void>(r => setImmediate(r));
  expect(f.calls).toEqual({ transport: 0, info: 0, events: 0, session: 0, logs: [], loads: [] });
  expect(f.observer.coverage()).toEqual([{ sourceKey: updateSourceKey(f.catalog[0]!.source), state: "unqualified", reason: OC_REPLY_UNQUALIFIED_REASON }]);
  expect(f.commits).toEqual([]); await f.observer.close();
});

test("qualification gate requires every evidenced check, identity/version and date; not server.info inference", async () => {
  const f = fixture();
  const bad: unknown[] = [undefined, { ...mockQualification(), authorityId: "other" }, { ...mockQualification(), clientVersion: "2.0.19" },
    { ...mockQualification(), verifiedAt: "invalid" }, { ...mockQualification(), evidenceRef: "" }, { ...mockQualification(), checks: {} }];
  for (const check of OC_REPLY_QUALIFICATION_CHECKS) {
    bad.push({ ...mockQualification(), checks: { ...mockQualification().checks, [check]: { passed: false, evidenceRef: "mock" } } });
    bad.push({ ...mockQualification(), checks: { ...mockQualification().checks, [check]: { passed: true, evidenceRef: "" } } });
  }
  for (const value of bad) expect(() => f.observer.qualify(value as OpenCodeReplyQualification)).toThrow("evidenced runtime checks");
  expect(f.calls.info).toBe(0); f.qualify(); expect(f.observer.qualificationStatus()).toEqual({ state: "qualified" });
  f.observer.start(); expect(() => f.qualify()).toThrow("Close the observer"); await f.observer.close();
});

test("cold complete replay seeds historical baseline; later parent reply retains sourceSequence and is not historical", async () => {
  const f = fixture(), b = f.catalog[0]!;
  f.logs.set(b.source.nativeSessionId, [creation(b), ...reply(b)]); f.qualify(); f.observer.start();
  try {
    await until(() => f.commits.length === 1);
    expect(f.commits[0]!.checkpoint).toMatchObject({ through: 7, baselineThrough: 7 });
    expect(f.commits[0]!.candidates[0]).toMatchObject({ kind: "reply", historical: true, sourceSequence: 7, nativeBoundaryId: "evt_7" });
    expect(f.commits[0]!.coverage).toMatchObject({ state: "ready", through: 7, baselineThrough: 7 });
    f.logs.get(b.source.nativeSessionId)!.push(...reply(b, 7)); f.observer.refresh();
    await until(() => f.commits.length === 2);
    expect(f.commits[1]!.checkpoint).toMatchObject({ through: 13, baselineThrough: 7 });
    expect(f.commits[1]!.candidates[0]).toMatchObject({ kind: "reply", sourceSequence: 13 });
    expect(f.commits[1]!.candidates[0]!.historical).toBeUndefined();
    expect(f.commits[1]!.candidates[0]!.id).not.toBe(f.commits[0]!.candidates[0]!.id);
    expect(f.calls.logs.map(call => call.after)).toEqual([0, 7]);
  } finally { await f.observer.close(); }
});

test("global terminal hints never commit attention before explicit durable log.synced", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old);
  const release = deferred(), entered = deferred();
  let replayEnabled = false;
  f.setLog(async function* (b, after, signal) {
    if (!replayEnabled) { yield synced(b, after); return; }
    yield* reply(b, after); entered.resolve();
    await Promise.race([release.promise, aborted(signal)]); signal.throwIfAborted(); yield synced(b, after + 6);
  });
  f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "ready");
    const reads = f.calls.logs.length;
    f.hints.push({ type: "session.execution.succeeded", id: "hint_unregistered", created: createdAt, durable: { aggregateID: "ses_unregistered", seq: 7, version: 1 }, data: { sessionID: "ses_unregistered" } });
    await new Promise<void>(r => setImmediate(r)); expect(f.calls.logs.length).toBe(reads);
    replayEnabled = true;
    f.hints.push(durable(b, 7, "session.execution.succeeded", {})); await entered.promise;
    expect(f.commits).toEqual([]); expect(f.saved.get(old.sourceKey)).toEqual(old);
    release.resolve(); await until(() => f.commits.length === 1);
    expect(f.commits[0]!.candidates[0]).toMatchObject({ kind: "reply", sourceSequence: 7 });
    expect(f.commits[0]!.checkpoint.through).toBe(7);
  } finally { release.resolve(); await f.observer.close(); }
});

test("global disconnect schedules authoritative log catch-up without requiring a live terminal hint", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old); f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "ready");
    f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
    f.hints.push(new Error("Mock disconnected stream"));
    await until(() => f.commits.length === 1);
    expect(f.commits[0]!.checkpoint.through).toBe(7);
    expect(f.commits[0]!.candidates[0]!.sourceSequence).toBe(7);
  } finally { await f.observer.close(); }
});

test("restarted observer reuses complete durable checkpoint and does not re-alert the old terminal", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b, [creation(b), ...reply(b)]);
  f.saved.set(old.sourceKey, old); f.logs.set(b.source.nativeSessionId, [creation(b), ...reply(b)]); f.qualify(); f.observer.start();
  await until(() => f.observer.coverage()[0]?.state === "ready"); await f.observer.close();
  f.logs.get(b.source.nativeSessionId)!.push(...reply(b, 7)); f.observer.start();
  try {
    await until(() => f.commits.length === 1);
    expect(f.calls.logs.map(call => call.after)).toEqual([7, 7]);
    expect(f.commits[0]!.candidates).toHaveLength(1);
    expect(f.commits[0]!.candidates[0]).toMatchObject({ sourceSequence: 13, nativeBoundaryId: "evt_13", source: b.source });
    expect(f.commits[0]!.checkpoint.baselineThrough).toBe(7);
  } finally { await f.observer.close(); }
});

for (const mode of ["missing-watermark", "wrong-watermark", "ended", "gap", "duplicate"] as const) {
  test(`${mode} cannot advance old checkpoint or commit reconstructed candidates`, async () => {
    const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old);
    f.setLog(async function* (b) {
      const events = reply(b);
      if (mode === "gap") { yield events[1]!; return; }
      if (mode === "duplicate") { yield creation(b); return; }
      yield* events;
      if (mode !== "ended") yield synced(b, mode === "missing-watermark" ? undefined : 8);
    });
    f.qualify(); f.observer.start();
    try {
      await until(() => f.observer.coverage()[0]?.state === "degraded");
      expect(f.commits).toEqual([]); expect(f.saved.get(old.sourceKey)).toEqual(old);
      expect(f.observer.coverage()[0]).toMatchObject({ state: "degraded", through: 1, baselineThrough: 1, reason: "Native reply catch-up incomplete; cursor not advanced" });
    } finally { await f.observer.close(); }
  });
}

for (const mode of ["events", "bytes", "wrapped-raw-bytes"] as const) {
  test(`oversized ${mode} catch-up explicitly degrades: partial bootstrap is unimplemented`, async () => {
    const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old);
    f.setLog(async function* (b) {
      if (mode === "wrapped-raw-bytes") throw new Error("SDK wrapper", { cause: new OpenCodeReplyTransportLimitError() });
      if (mode === "bytes") yield durable(b, 2, "session.synthetic", { text: "x".repeat(16 * 1024 * 1024) });
      else for (let seq = 2; seq <= 10002; seq++) yield durable(b, seq, "session.renamed", { title: "Mock large durable history" });
      yield synced(b, mode === "bytes" ? 2 : 10002);
    });
    f.qualify(); f.observer.start();
    try {
      await until(() => f.observer.coverage()[0]?.state === "degraded");
      expect(f.observer.coverage()[0]!.reason).toContain("partial replay checkpoints are not implemented");
      expect(f.observer.coverage()[0]).toMatchObject({ through: 1, baselineThrough: 1 });
      expect(f.saved.get(old.sourceKey)).toEqual(old); expect(f.commits).toEqual([]);
    } finally { await f.observer.close(); }
  });
}

test("large cold bootstrap remains degraded, with no fabricated baseline or ready coverage", async () => {
  const f = fixture(); f.setLog(async function* (b) {
    yield creation(b); for (let seq = 2; seq <= 10001; seq++) yield durable(b, seq, "session.renamed", { title: "Large initial native log" });
    yield synced(b, 10001);
  }); f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "degraded");
    expect(f.observer.coverage()[0]!.reason).toContain("partial replay checkpoints are not implemented");
    expect(f.observer.coverage()[0]!.through).toBeUndefined(); expect(f.observer.coverage()[0]!.baselineThrough).toBeUndefined();
    expect(f.saved.size).toBe(0); expect(f.commits).toEqual([]);
  } finally { await f.observer.close(); }
});

test("native version mismatch revokes coverage, not qualification inferred from info", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old); f.setVersion("other-version"); f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "unqualified");
    expect(f.observer.coverage()[0]).toMatchObject({ reason: "Native version differs from evidenced reply qualification", through: 1 });
    expect(f.calls.logs).toEqual([]); expect(f.commits).toEqual([]); expect(f.saved.get(old.sourceKey)).toEqual(old);
  } finally { await f.observer.close(); }
});

for (const mode of ["child", "creation-changed-after-replay", "native-id-changed"] as const) {
  test(`native ownership check excludes ${mode} before committing candidates`, async () => {
    const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old); f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
    const original = f.transport.session; let reads = 0;
    f.transport.session = async (input, options) => {
      const session = await original(input, options); reads++;
      if (mode === "child") return { ...session, parentID: "ses_native_parent" };
      if (mode === "native-id-changed") return { ...session, id: "ses_other" };
      return reads === 2 ? { ...session, time: { ...session.time, created: createdAt + 1 } } : session;
    };
    f.qualify(); f.observer.start();
    try {
      await until(() => f.observer.coverage()[0]?.state === "degraded");
      expect(reads).toBe(mode === "creation-changed-after-replay" ? 2 : 1);
      expect(f.commits).toEqual([]); expect(f.saved.get(old.sourceKey)).toEqual(old);
    } finally { await f.observer.close(); }
  });
}

test("checkpoint validation rejects incomplete state, source incarnation mismatch and invalid terminal generations", async () => {
  const f = fixture(), b = f.catalog[0]!, cp = checkpoint(b);
  expect(validateOpenCodeReplyCheckpoint(cp, b)).toBe(true);
  for (const invalid of [
    { ...cp, through: 2 }, { ...cp, baselineThrough: 2 }, { ...cp, sourceKey: "foreign" },
    { ...cp, state: { ...cp.state, created: false } }, { ...cp, state: { ...cp.state, creation: { ...b.creation, eventId: "other" } } },
    { ...cp, state: { ...cp.state, seenMessages: ["msg_duplicate", "msg_duplicate"] } },
    { ...cp, state: { ...cp.state, window: { id: "evt_window", eligible: true, compacting: false, step: { messageId: "unknown" } } } },
  ]) expect(validateOpenCodeReplyCheckpoint(invalid, b)).toBe(false);
  f.saved.set(cp.sourceKey, { ...cp, state: undefined } as unknown as OpenCodeReplyCheckpoint); f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "degraded");
    expect(f.observer.coverage()[0]!.reason).toContain("Incomplete native reply checkpoint");
    expect(f.calls.transport).toBe(1); // only the global hint stream, no catch-up transport
    expect(f.calls.logs).toEqual([]); expect(f.commits).toEqual([]);
  } finally { await f.observer.close(); }
});

test("bounded FIFO serves more than 256 registered sessions fairly with at most two active replays", async () => {
  const f = fixture(300); let active = 0, maximum = 0;
  f.setLog(async function* (b, after) {
    active++; maximum = Math.max(maximum, active);
    try { await new Promise<void>(r => setImmediate(r)); if (after === 0) yield creation(b); yield synced(b, 1); }
    finally { active--; }
  }); f.qualify(); f.observer.start();
  try {
    f.hints.push({ id: "evt_mock_connected", type: "server.connected", data: {} });
    f.observer.refresh();
    await until(() => f.saved.size === 300 && f.observer.coverage().every(c => c.state === "ready"));
    expect(new Set(f.calls.loads).size).toBe(300); expect(maximum).toBe(2);
    expect(f.saved.has(updateSourceKey(f.catalog[299]!.source))).toBe(true);
    expect(f.observer.coverage().filter(c => c.state === "ready")).toHaveLength(300);
  } finally { await f.observer.close(); }
});

test("load/commit and optional coverage failures are handled without unhandled promise rejection", async () => {
  const unhandled: unknown[] = []; const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on("unhandledRejection", onUnhandled);
  const f = fixture(3);
  f.setLoad(async b => { if (b.source.nativeSessionId === "ses_0") throw new Error("Mock load failed"); return undefined; });
  f.setCommit(async batch => { if (batch.binding.source.nativeSessionId === "ses_1") throw new Error("Mock atomic commit rolled back"); });
  const other = new OpenCodeReplyObserver({ authorityId: "mock_authority", sessions: () => [binding()], transport: async () => { throw new Error("must not connect"); }, load: async () => undefined, commit: async () => {}, coverage: async () => { throw new Error("Mock diagnostic failed"); } });
  f.qualify(); f.observer.start(); other.start();
  try {
    await until(() => f.observer.coverage().filter(c => c.state === "degraded").length === 2 && f.saved.size === 1);
    await new Promise<void>(r => setImmediate(r)); expect(unhandled).toEqual([]);
    expect(f.saved.has(updateSourceKey(binding(0).source))).toBe(false);
    expect(f.saved.has(updateSourceKey(binding(1).source))).toBe(false);
  } finally { await f.observer.close(); await other.close(); process.off("unhandledRejection", onUnhandled); }
});

test("rejected atomic commit replays same stable occurrence from old cursor", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b); f.saved.set(old.sourceKey, old); f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
  const attempts: OpenCodeReplyCommit[] = [];
  f.setCommit(async batch => { attempts.push(structuredClone(batch)); if (attempts.length === 1) throw new Error("Mock rollback"); });
  f.qualify(); f.observer.start();
  try {
    await until(() => f.observer.coverage()[0]?.state === "degraded"); expect(f.saved.get(old.sourceKey)).toEqual(old);
    f.observer.refresh(); await until(() => f.commits.length === 1);
    expect(attempts[1]!.candidates).toEqual(attempts[0]!.candidates);
    expect(f.calls.logs.map(c => c.after)).toEqual([1, 1]); expect(f.commits[0]!.checkpoint.through).toBe(7);
  } finally { await f.observer.close(); }
});

test("close aborts pending log and global stream, preserves checkpoint and emits no stale commit", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b), entered = deferred(); f.saved.set(old.sourceKey, old);
  let logSignal: AbortSignal | undefined;
  f.setLog(async function* (b, after, signal) { logSignal = signal; yield* reply(b, after); entered.resolve(); await aborted(signal); signal.throwIfAborted(); });
  f.qualify(); f.observer.start(); await entered.promise; await f.observer.close();
  expect(logSignal?.aborted).toBe(true); expect(f.commits).toEqual([]); expect(f.saved.get(old.sourceKey)).toEqual(old);
});

test("close aborts atomic store commit and preserves old replay cursor", async () => {
  const f = fixture(), b = f.catalog[0]!, old = checkpoint(b), entered = deferred();
  f.saved.set(old.sourceKey, old); f.logs.get(b.source.nativeSessionId)!.push(...reply(b));
  let commitSignal: AbortSignal | undefined;
  f.setCommit(async (_batch, signal) => { commitSignal = signal; entered.resolve(); await aborted(signal); signal.throwIfAborted(); });
  f.qualify(); f.observer.start(); await entered.promise; await f.observer.close();
  expect(commitSignal?.aborted).toBe(true); expect(f.commits).toEqual([]); expect(f.saved.get(old.sourceKey)).toEqual(old);
});

test("registration removed/rebound during replay ignores stale binding", async () => {
  for (const mode of ["removed", "rebound"] as const) {
    const f = fixture(), b = f.catalog[0]!, old = checkpoint(b), entered = deferred(), release = deferred(), finished = deferred(); f.saved.set(old.sourceKey, old);
    f.setLog(async function* (b, after, signal) {
      try { yield* reply(b, after); entered.resolve(); await Promise.race([release.promise, aborted(signal)]); signal.throwIfAborted(); yield synced(b, after + 6); }
      finally { finished.resolve(); }
    }); f.qualify(); f.observer.start();
    try {
      await entered.promise;
      if (mode === "removed") f.catalog.splice(0, 1); else f.catalog[0] = { ...b, conversationId: "app_rebound" };
      f.observer.refresh(); release.resolve();
      await finished.promise; await new Promise<void>(r => setImmediate(r));
      await until(() => mode === "removed" ? f.observer.coverage().length === 0 : f.commits.length === 1);
      expect(f.commits.some(batch => batch.binding.conversationId === b.conversationId)).toBe(false);
      if (mode === "removed") expect(f.saved.get(old.sourceKey)).toEqual(old);
      else expect(f.commits[0]!.binding.conversationId).toBe("app_rebound");
    } finally { release.resolve(); await f.observer.close(); }
  }
});
