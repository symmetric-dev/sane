import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import { CONVERSATION_UPDATE_MAX_ROWS, ConversationUpdateServiceError, ConversationUpdateStore, isConversationUpdateCheckpoint } from "./conversation-update-store";
import {
  ConversationUpdates, appRunUpdateCheckpointKey, nativeUpdateCheckpointKey,
  type ConversationUpdateProjector, type NativeConversationUpdateBatch,
} from "./conversation-updates";
import { createClaudeUpdateState, projectClaudeCommittedEvent } from "./claude-conversation-updates";
import { validateOpenCodeReplyCheckpoint } from "./opencode-reply-observer";
import { initialOpenCodeReplyState, openCodeIncarnation, type OpenCodeReplyBinding } from "../shared/conversation/oc-reply-reducer";
import {
  updateOccurrenceId, updateSourceKey, type ConversationUpdateCandidate, type ConversationUpdateSource,
} from "../shared/conversation/conversation-updates";
import type { Event, Run, Session } from "./history";

const tempRoot = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const dirs: string[] = [];
const now = "2026-10-05T12:00:00.000Z";
const ccSource: ConversationUpdateSource = { harness: "claude-code", authorityId: "authority-cc", nativeSessionId: "native-cc" };
const ocSource: ConversationUpdateSource = { harness: "opencode", authorityId: "authority-oc", nativeSessionId: "ses_native" };
const ccProjector = { createState: createClaudeUpdateState, project: projectClaudeCommittedEvent };
function records(source = ccSource, runId = "run") {
  const session: Session = { sessionId: "conversation", cwd: "/fixture", ...source, lastStatus: "running", lastRunId: runId };
  const run: Run = { runId, sessionId: session.sessionId, cwd: session.cwd, status: "running", createdAt: now };
  const event = (seq: number, kind: Event["kind"] = "stdout", data: unknown = {}, patch: Partial<Event> = {}): Event => ({ seq, kind, data, time: now, runId, sessionId: session.sessionId, ...patch });
  return { session, run, event };
}
const success = (index: number, patch: Record<string, unknown> = {}) => ({ type: "result", session_id: ccSource.nativeSessionId, result_index: index, subtype: "success", is_error: false, result: "useful reply", ...patch });
const candidate = (name: string, patch: Partial<ConversationUpdateCandidate> = {}, source = ocSource): ConversationUpdateCandidate => ({
  id: updateOccurrenceId(source, name), source, conversationId: "conversation", kind: "reply", occurredAt: null, ...patch,
});
const nativeBatch = (through: number, candidates: ConversationUpdateCandidate[] = [], patch: Partial<NativeConversationUpdateBatch> = {}): NativeConversationUpdateBatch => ({ source: ocSource, through, candidates, ...patch });
function fixture(options: ConstructorParameters<typeof ConversationUpdateStore>[2] = {}) {
  const dir = mkdtempSync(join(tempRoot, "conversation-updates-test-")); dirs.push(dir);
  const store = new ConversationUpdateStore(dir, "store", { now: () => now, ...options });
  expect(store.load()).toBe(true);
  return { dir, store, path: join(dir, "conversation-updates.json") };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("conversation updates separate committed-record ingest queue", () => {
  test("primary callbacks return before projection and a throwing projector cannot escape or block another source", async () => {
    const f = fixture(), r = records(); let projections = 0;
    const projector: ConversationUpdateProjector = { project: () => { projections++; throw new Error("optional projector failure"); } };
    const service = new ConversationUpdates(f.store, { projector });
    expect(() => service.primaryJournalCommitted(r.session, r.run, r.event(1))).not.toThrow();
    expect(projections).toBe(0);
    await service.flush(); expect(projections).toBe(1);
    expect(service.getHealth().state).toBe("ready");
    expect(service.getCoverage()).toContainEqual(expect.objectContaining({ sourceKey: updateSourceKey(ccSource), state: "degraded" }));
    expect(await service.ingestCommitted(r.session, r.run, r.event(2))).toBe(false);
    expect(projections).toBe(1);
    const other = records(ocSource, "other-run");
    expect(await service.ingestCommitted(other.session, other.run, other.event(1, "status", { status: "failed" }))).toBe(true);
    expect((await service.page()).updates).toHaveLength(1);
    expect(f.store.getCheckpoint(appRunUpdateCheckpointKey(ccSource, r.run.runId))).toBeUndefined();
  });

  test("noncloneable inputs and missing authority do not throw into primary callbacks", async () => {
    const f = fixture(), r = records(), service = new ConversationUpdates(f.store);
    expect(() => service.primaryJournalCommitted(r.session, r.run, r.event(1, "stdout", () => {}))).not.toThrow();
    expect(await service.ingestCommitted(r.session, r.run, r.event(1, "stdout", () => {}))).toBe(false);
    delete r.session.authorityId;
    expect(await service.ingestCommitted(r.session, r.run, r.event(1))).toBe(false);
    expect(f.store.getHead()?.through).toBe(0); expect(f.store.getCheckpoints()).toEqual([]);
  });

  test("save failures remain isolated and an explicit reload plus replay repairs the feed", async () => {
    let fail = false;
    const f = fixture({ save: (root, name, value) => { if (fail) throw new Error("disk failure"); atomicAppRecord(root, name, value); } });
    const service = new ConversationUpdates(f.store, { projector: ccProjector }), r = records(), event = r.event(1, "stdout", success(0));
    const disk = readFileSync(f.path, "utf8"); fail = true;
    expect(() => service.primaryJournalCommitted(r.session, r.run, event)).not.toThrow();
    await service.flush(); expect(service.getHealth().state).toBe("unavailable");
    expect(readFileSync(f.path, "utf8")).toBe(disk);
    expect(f.store.getCheckpoint(appRunUpdateCheckpointKey(ccSource, r.run.runId))).toBeUndefined();
    await expect(service.page()).rejects.toMatchObject({ code: "CONVERSATION_UPDATES_UNAVAILABLE" });
    fail = false; expect(f.store.load()).toBe(true);
    expect(await service.replayRun(r.session, r.run, [event])).toBe(true);
    expect((await service.page()).updates).toHaveLength(1);
  });

  test("projection failure recovery replays from the last committed reducer state, not failed speculative state", async () => {
    const f = fixture(), r = records(); let fail = true;
    const projector: ConversationUpdateProjector<{ count: number }> = {
      createState: () => ({ count: 0 }),
      project: (_session, _run, event, state) => {
        state.count++;
        if (fail && event.seq === 2) throw new Error("bad projection");
        return { state, candidates: [] };
      },
    };
    const service = new ConversationUpdates(f.store, { projector });
    expect(await service.ingestCommitted(r.session, r.run, r.event(1))).toBe(true);
    expect(await service.ingestCommitted(r.session, r.run, r.event(2))).toBe(false);
    expect(await service.ingestCommitted(r.session, r.run, r.event(3))).toBe(false);
    const key = appRunUpdateCheckpointKey(ccSource, r.run.runId);
    expect(f.store.getCheckpoint(key)).toMatchObject({ through: 1, state: { projector: { count: 1 } } });
    fail = false;
    expect(await service.replayRun(r.session, r.run, [r.event(1), r.event(2), r.event(3)])).toBe(true);
    expect(f.store.getCheckpoint(key)).toMatchObject({ through: 3, state: { projector: { count: 3 } } });
    expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ccSource))?.state).toBe("ready");
    expect(await service.ingestCommitted(r.session, r.run, r.event(4))).toBe(true);
    expect(f.store.getCheckpoint(key)).toMatchObject({ through: 4, state: { projector: { count: 4 } } });
  });

  test("a primary event gap is not guessed and requires ordered replay before later ingestion", async () => {
    const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
    expect(await service.ingestCommitted(r.session, r.run, r.event(3, "stdout", success(2)))).toBe(false);
    expect(f.store.getCheckpoints()).toEqual([]); expect(f.store.getHead()?.through).toBe(0);
    const events = [r.event(1), r.event(2), r.event(3, "stdout", success(2))];
    expect(await service.replayRun(r.session, r.run, events)).toBe(true);
    expect(f.store.getCheckpoint(appRunUpdateCheckpointKey(ccSource, r.run.runId))?.through).toBe(3);
    expect(await service.ingestCommitted(r.session, r.run, r.event(4))).toBe(true);
  });

  test("startup replay rejects a missing launch, an internal gap and out-of-order events before projecting replies", async () => {
    for (const shape of ["missing-launch", "internal-gap", "out-of-order"]) {
      const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
      const events = [r.event(1, "launch", { framework: null }), r.event(2, "stderr", "diagnostic"), r.event(3, "stdout", success(0))];
      const incomplete = shape === "missing-launch" ? events.slice(1)
        : shape === "internal-gap" ? [events[0]!, events[2]!]
        : [events[0]!, events[2]!, events[1]!];
      const disk = readFileSync(f.path, "utf8");
      expect(await service.replayRun(r.session, r.run, incomplete)).toBe(false);
      expect(readFileSync(f.path, "utf8")).toBe(disk);
      expect(f.store.getCheckpoints()).toEqual([]); expect(service.getHead()?.through).toBe(0);
      expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ccSource))?.state).toBe("degraded");
      expect(await service.replayRun(r.session, r.run, events)).toBe(true);
      expect(f.store.getCheckpoint(appRunUpdateCheckpointKey(ccSource, r.run.runId))?.through).toBe(3);
      expect((await service.page()).updates).toHaveLength(1);
      expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ccSource))?.state).toBe("ready");
    }
  });

  test("a replay journal shorter than the saved checkpoint cannot clear degradation or change persisted state", async () => {
    const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
    const events = [r.event(1, "launch", { framework: null }), r.event(2, "stdout", success(0)), r.event(3, "stderr", "diagnostic")];
    expect(await service.replayRun(r.session, r.run, events)).toBe(true);
    const key = appRunUpdateCheckpointKey(ccSource, r.run.runId), checkpoint = f.store.getCheckpoint(key), head = service.getHead();
    await service.close();
    const store = new ConversationUpdateStore(f.dir, "store"); expect(store.load()).toBe(true);
    const restarted = new ConversationUpdates(store, { projector: ccProjector });
    const disk = readFileSync(f.path, "utf8");
    expect(await restarted.replayRun(r.session, r.run, events.slice(0, 2))).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk);
    expect(store.getCheckpoint(key)).toEqual(checkpoint); expect(restarted.getHead()).toEqual(head);
    expect(restarted.getCoverage().find(item => item.sourceKey === updateSourceKey(ccSource))?.state).toBe("degraded");
    expect(await restarted.ingestCommitted(r.session, r.run, r.event(4, "stdout", success(1)))).toBe(false);
    expect(await restarted.replayRun(r.session, r.run, events)).toBe(true);
    expect(restarted.getHead()).toEqual(head);
    expect(await restarted.ingestCommitted(r.session, r.run, r.event(4, "stdout", success(1)))).toBe(true);
    expect(store.getCheckpoint(key)?.through).toBe(4);
  });

  test("bad runA does not stop healthy runB, and replaying runB cannot clear runA's degraded source coverage", async () => {
    const f = fixture(), a = records(ccSource, "runA"), b = records(ccSource, "runB"); let failA = true;
    const projector = { createState: createClaudeUpdateState, project: (...args: Parameters<typeof projectClaudeCommittedEvent>) => {
      if (failA && args[1].runId === "runA" && args[2].seq === 2) throw new Error("runA projection failed");
      return projectClaudeCommittedEvent(...args);
    } };
    const service = new ConversationUpdates(f.store, { projector });
    const aEvents = [a.event(1, "stdout", success(0)), a.event(2, "stdout", success(1)), a.event(3, "stdout", success(2))];
    const bEvents = [b.event(1, "stdout", success(0)), b.event(2, "stdout", success(1))];
    expect(await service.ingestCommitted(a.session, a.run, aEvents[0]!)).toBe(true);
    expect(await service.ingestCommitted(a.session, a.run, aEvents[1]!)).toBe(false);
    expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ccSource))?.state).toBe("degraded");
    expect(await service.ingestCommitted(b.session, b.run, bEvents[0]!)).toBe(true);
    expect(await service.replayRun(b.session, b.run, bEvents)).toBe(true);
    expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ccSource))?.state).toBe("degraded");
    expect(await service.ingestCommitted(b.session, b.run, b.event(3, "stdout", success(2)))).toBe(true);
    expect(await service.ingestCommitted(a.session, a.run, aEvents[2]!)).toBe(false);
    expect(f.store.getCheckpoint(appRunUpdateCheckpointKey(ccSource, "runA"))?.through).toBe(1);
    expect(f.store.getCheckpoint(appRunUpdateCheckpointKey(ccSource, "runB"))?.through).toBe(3);
    expect((await service.page()).updates.filter(row => row.runId === "runB")).toHaveLength(3);
    failA = false;
    expect(await service.replayRun(a.session, a.run, aEvents)).toBe(true);
    expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ccSource))?.state).toBe("ready");
    expect(await service.ingestCommitted(b.session, b.run, b.event(4, "stdout", success(3)))).toBe(true);
    expect(f.store.getCheckpoint(appRunUpdateCheckpointKey(ccSource, "runB"))?.through).toBe(4);
  });

  test("captured primary inputs cannot be mutated before the asynchronous queue consumes them", async () => {
    const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
    const event = r.event(1, "stdout", success(0)), pending = service.ingestCommitted(r.session, r.run, event);
    (event.data as { result: string }).result = ""; r.session.nativeSessionId = "mutated"; r.run.runId = "mutated";
    expect(await pending).toBe(true);
    expect((await service.page()).updates[0]).toMatchObject({ runId: "run", source: ccSource, kind: "reply" });
  });

  test("event/run/session mismatches never publish candidates or advance checkpoints", async () => {
    for (const mismatch of ["event-run", "event-session", "run-session"]) {
      const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
      const event = r.event(1, "stdout", success(0));
      if (mismatch === "event-run") event.runId = "foreign";
      if (mismatch === "event-session") event.sessionId = "foreign";
      if (mismatch === "run-session") r.run.sessionId = "foreign";
      expect(await service.ingestCommitted(r.session, r.run, event)).toBe(false);
      expect(f.store.getHead()?.through).toBe(0); expect(f.store.getCheckpoints()).toEqual([]);
    }
  });
});

describe("committed CC projections and durable per-run replay", () => {
  test("multiple indexed replies are separate occurrences; completion aliases only the final useful reply", async () => {
    const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
    const events = [r.event(1, "stdout", success(0)), r.event(2, "stdout", success(8)), r.event(3, "status", { status: "completed" })];
    for (const event of events) expect(await service.ingestCommitted(r.session, r.run, event)).toBe(true);
    const page = await service.page(); expect(page.updates).toHaveLength(3);
    expect(page.updates.map(row => [row.sequence, row.occurrenceSequence, row.revision, row.legacyRunId])).toEqual([[1, 1, 1, undefined], [2, 2, 1, undefined], [3, 2, 2, "run"]]);
    expect(page.updates.map(row => row.nativeBoundaryId)).toEqual(["cc-result:run:index:0", "cc-result:run:index:8", "cc-result:run:index:8"]);
    expect(page.updates.map(row => row.messageId)).toEqual(["run:result:index:0", "run:result:index:8", "run:result:index:8"]);
    const key = appRunUpdateCheckpointKey(ccSource, r.run.runId);
    expect(f.store.getCheckpoint(key)?.through).toBe(3);
    await service.close();
    const store = new ConversationUpdateStore(f.dir, "store"); expect(store.load()).toBe(true);
    const restarted = new ConversationUpdates(store, { projector: ccProjector });
    expect(await restarted.replayRun(r.session, { ...r.run, status: "completed" }, events)).toBe(true);
    expect(restarted.getHead()).toEqual({ storeId: "store", epoch: page.epoch, retainedAfter: 0, through: 3 });
    expect((await restarted.page()).updates).toEqual(page.updates);
  });

  test("per-run checkpoints survive retained-row pruning and prevent resurrecting replies or terminal aliases", async () => {
    const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
    const events = [r.event(1, "stdout", success(0)), r.event(2, "status", { status: "completed" })];
    expect(await service.replayRun(r.session, { ...r.run, status: "completed" }, events)).toBe(true);
    const checkpointKey = appRunUpdateCheckpointKey(ccSource, r.run.runId), oldCheckpoint = f.store.getCheckpoint(checkpointKey)!;
    expect(await f.store.commitCandidates(Array.from({ length: CONVERSATION_UPDATE_MAX_ROWS }, (_, i) => candidate(`new-${i}`, { sourceSequence: i + 10 }, ccSource)), {
      key: nativeUpdateCheckpointKey(ccSource), sourceKey: updateSourceKey(ccSource), through: CONVERSATION_UPDATE_MAX_ROWS + 9,
    })).toBe(true);
    expect(f.store.getUpdate(updateOccurrenceId(ccSource, "cc-result:run:index:0"))).toBeUndefined();
    const oldHead = f.store.getHead()!; expect(oldHead.retainedAfter).toBe(2);
    await service.close();
    const store = new ConversationUpdateStore(f.dir, "store"); expect(store.load()).toBe(true);
    const restarted = new ConversationUpdates(store, { projector: ccProjector });
    expect(store.getCheckpoint(checkpointKey)).toEqual(oldCheckpoint);
    expect(await restarted.replayRun(r.session, { ...r.run, status: "completed" }, events)).toBe(true);
    expect(store.getHead()).toEqual(oldHead);
    expect(await restarted.ingestCommitted(r.session, r.run, events[1]!)).toBe(true);
    expect(store.getHead()).toEqual(oldHead);
    const newRun = records(ccSource, "another-run");
    expect(await restarted.ingestCommitted(newRun.session, newRun.run, newRun.event(1, "stdout", success(3)))).toBe(true);
    expect(store.getCheckpoint(appRunUpdateCheckpointKey(ccSource, "another-run"))?.through).toBe(1);
    expect(store.getHead()?.through).toBe(oldHead.through + 1);
  });

  test("qualified CC terminal evidence prevents duplicate App failures; OC replies stay unqualified", async () => {
    const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
    expect(await service.ingestCommitted(r.session, r.run, r.event(1, "stdout", success(0)))).toBe(true);
    expect(await service.ingestCommitted(r.session, r.run, r.event(2, "status", { status: "failed" }))).toBe(true);
    expect((await service.page()).updates.map(row => row.kind)).toEqual(["reply", "failed"]);
    const oc = records(ocSource, "oc-run");
    expect(await service.ingestCommitted(oc.session, oc.run, oc.event(1, "stdout", success(0)))).toBe(true);
    expect(await service.ingestCommitted(oc.session, oc.run, oc.event(2, "status", { status: "interrupted" }))).toBe(true);
    const page = await service.page();
    expect(page.updates.at(-1)).toMatchObject({ kind: "interrupted", occurredAt: null, runId: "oc-run", legacyRunId: "oc-run" });
    expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ocSource))).toMatchObject({ state: "unqualified" });
  });

  test("replay-only terminal metadata uses a durable marker without inventing a source sequence", async () => {
    const f = fixture(), r = records(ocSource), service = new ConversationUpdates(f.store);
    expect(await service.replayRun(r.session, { ...r.run, status: "failed" }, [])).toBe(true);
    const row = (await service.page()).updates[0]!;
    expect(row).toMatchObject({ kind: "failed", occurredAt: null, legacyRunId: "run" }); expect(row.sourceSequence).toBeUndefined();
    expect(f.store.getCheckpoint(appRunUpdateCheckpointKey(ocSource, "run"))).toMatchObject({ through: 0, state: { terminalIndexed: true } });
    expect(await service.replayRun(r.session, { ...r.run, status: "failed" }, [])).toBe(true);
    expect(service.getHead()?.through).toBe(1);
  });

  // This generic service does not own worker/compact admission exclusions. The
  // parent bridge/adapter must omit these inputs; integration coverage lives there.
  test("the generic service does not silently claim worker or compact filtering", async () => {
    const f = fixture(), service = new ConversationUpdates(f.store);
    const worker = records(ocSource, "worker-run"), compact = records(ocSource, "compact-run");
    worker.session.agentKind = "worker"; worker.run.agentKind = "worker";
    compact.run.operation = "compact";
    expect(await service.ingestCommitted(worker.session, worker.run, worker.event(1, "status", { status: "failed" }))).toBe(true);
    expect(await service.ingestCommitted(compact.session, compact.run, compact.event(1, "status", { status: "failed" }))).toBe(true);
    expect((await service.page()).updates.map(row => row.runId)).toEqual(["worker-run", "compact-run"]);
  });
});

describe("native batches, exact correlation and source checkpoint boundaries", () => {
  test("baseline historical/live classification is explicit and independent of observation time or transport sequence", async () => {
    const f = fixture(), service = new ConversationUpdates(f.store, { bootstrap: () => ({ activeRunIds: ["currently-running"], sourceBaselines: [{ sourceKey: updateSourceKey(ocSource), through: 500 }] }) });
    expect(await service.upsertNativeBatch(nativeBatch(500, [candidate("history", { sourceSequence: 499, historical: true, occurredAt: "2099-01-01T00:00:00Z" })], { baselineThrough: 500, state: { pending: "execution" } }))).toBe(true);
    expect(await service.upsertNativeBatch(nativeBatch(700, [candidate("live", { sourceSequence: 700, occurredAt: "2000-01-01T00:00:00Z" })]))).toBe(true);
    const page = await service.page({}, true);
    expect(page.through).toBe(2); expect(page.bootstrap).toEqual({ activeRunIds: ["currently-running"], sourceBaselines: [{ sourceKey: updateSourceKey(ocSource), through: 500 }] });
    expect(page.updates.map(row => [row.sequence, row.sourceSequence, row.historical, row.occurredAt, row.observedAt])).toEqual([
      [1, 499, true, "2099-01-01T00:00:00Z", now], [2, 700, undefined, "2000-01-01T00:00:00Z", now],
    ]);
    expect(f.store.getCheckpoint(nativeUpdateCheckpointKey(ocSource))).toMatchObject({ through: 700, baselineThrough: 500, state: { pending: "execution" } });
    expect(page.coverage).toContainEqual({ sourceKey: updateSourceKey(ocSource), state: "ready", through: 700, baselineThrough: 500 });
  });

  test("sparse native candidates use only the supplied watermark; old out-of-order batches never regress it", async () => {
    const f = fixture(), service = new ConversationUpdates(f.store);
    expect(await service.upsertNativeBatch(nativeBatch(500, [candidate("sparse", { sourceSequence: 100 })], { baselineThrough: 400 }))).toBe(true);
    expect(f.store.getCheckpoint(nativeUpdateCheckpointKey(ocSource))?.through).toBe(500);
    expect(await service.upsertNativeBatch(nativeBatch(200, [candidate("stale", { sourceSequence: 200 })]))).toBe(true);
    expect(service.getHead()?.through).toBe(1);
    expect(f.store.getCheckpoint(nativeUpdateCheckpointKey(ocSource))?.through).toBe(500);
    expect(await service.upsertNativeBatch(nativeBatch(700, [candidate("already-covered", { sourceSequence: 450 }), candidate("next", { sourceSequence: 650 })]))).toBe(true);
    expect((await service.page()).updates.map(row => row.sourceSequence)).toEqual([100, 650]);
    expect(f.store.getCheckpoint(nativeUpdateCheckpointKey(ocSource))?.through).toBe(700);
  });

  test("missing/invalid watermarks or source positions are rejected, never inferred from candidates", async () => {
    for (const batch of [nativeBatch(undefined as unknown as number, [candidate("reply", { sourceSequence: 10 })]), nativeBatch(Number.NaN), nativeBatch(10, [candidate("reply")]), nativeBatch(10, [candidate("reply", { sourceSequence: 11 })])]) {
      const f = fixture(), service = new ConversationUpdates(f.store);
      expect(await service.upsertNativeBatch(batch)).toBe(false);
      expect(f.store.getCheckpoints()).toEqual([]); expect(service.getHead()?.through).toBe(0);
      expect(service.getHealth().state).toBe("ready");
    }
  });

  test("native candidate authority and native-session mismatches are rejected before atomic storage", async () => {
    for (const foreign of [{ ...ocSource, authorityId: "foreign" }, { ...ocSource, nativeSessionId: "ses_foreign" }]) {
      const f = fixture(), service = new ConversationUpdates(f.store);
      expect(await service.upsertNativeBatch(nativeBatch(10, [candidate("foreign", { sourceSequence: 10 }, foreign)]))).toBe(false);
      expect(f.store.getCheckpoints()).toEqual([]); expect(service.getHead()?.through).toBe(0);
    }
  });

  test("a corrected native batch can recover a projection-validation failure without restarting the service", async () => {
    const f = fixture(), service = new ConversationUpdates(f.store);
    expect(await service.upsertNativeBatch(nativeBatch(10, [candidate("reply")]))).toBe(false);
    expect(f.store.getHealth().state).toBe("ready");
    expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ocSource))?.state).toBe("degraded");
    expect(await service.upsertNativeBatch(nativeBatch(10, [candidate("reply", { sourceSequence: 10 })]))).toBe(true);
    expect(service.getCoverage().find(item => item.sourceKey === updateSourceKey(ocSource))?.state).toBe("ready");
    expect(f.store.getCheckpoint(nativeUpdateCheckpointKey(ocSource))?.through).toBe(10);
  });

  test("native candidate and pending checkpoint state cannot diverge on persistence failure", async () => {
    let fail = false;
    const f = fixture({ save: (root, name, value) => { if (fail) throw new Error("disk failure"); atomicAppRecord(root, name, value); } });
    const service = new ConversationUpdates(f.store);
    expect(await service.upsertNativeBatch(nativeBatch(10, [], { baselineThrough: 10, state: { pending: "execution" } }))).toBe(true);
    const disk = readFileSync(f.path, "utf8"); fail = true;
    expect(await service.upsertNativeBatch(nativeBatch(20, [candidate("reply", { sourceSequence: 20 })], { state: { pending: null } }))).toBe(false);
    expect(f.store.getCheckpoint(nativeUpdateCheckpointKey(ocSource))).toMatchObject({ through: 10, state: { pending: "execution" } });
    expect(f.store.getUpdate(candidate("reply").id)).toBeUndefined(); expect(readFileSync(f.path, "utf8")).toBe(disk);
    fail = false; expect(f.store.load()).toBe(true);
    expect(await service.upsertNativeBatch(nativeBatch(20, [candidate("reply", { sourceSequence: 20 })], { state: { pending: null } }))).toBe(true);
    expect(f.store.getCheckpoint(nativeUpdateCheckpointKey(ocSource))).toMatchObject({ through: 20, baselineThrough: 10, state: { pending: null } });
  });

  test("exact correlation revises metadata without creating attention and validates authority, session and conversation", async () => {
    const f = fixture(), service = new ConversationUpdates(f.store), original = candidate("reply", { sourceSequence: 10 });
    expect(await service.upsertNativeBatch(nativeBatch(10, [original]))).toBe(true);
    expect(await service.correlate([{ id: original.id, source: ocSource, conversationId: "conversation", runId: "run" }])).toBe(true);
    expect(f.store.getUpdate(original.id)).toMatchObject({ occurrenceSequence: 1, sequence: 2, revision: 2, runId: "run" });
    expect(f.store.getUpdate(original.id)?.legacyRunId).toBeUndefined();
    expect(await service.correlate([{ id: original.id, source: ocSource, conversationId: "conversation", legacyRunId: "run" }])).toBe(true);
    const head = service.getHead();
    expect(await service.correlate([{ id: candidate("missing").id, source: ocSource, conversationId: "conversation", runId: "invented" }])).toBe(true);
    expect(service.getHead()).toEqual(head);
    for (const selector of [
      { id: original.id, source: { ...ocSource, authorityId: "foreign" }, conversationId: "conversation" },
      { id: original.id, source: { ...ocSource, nativeSessionId: "foreign" }, conversationId: "conversation" },
      { id: original.id, source: ocSource, conversationId: "foreign" },
      { id: original.id, source: ocSource, conversationId: "conversation", runId: "different" },
      { id: original.id, source: ocSource, conversationId: "conversation", legacyRunId: "different" },
    ]) expect(await service.correlate([selector])).toBe(false);
    expect(service.getHead()).toEqual(head);
    expect(await service.correlate(Array.from({ length: 65 }, () => ({ id: original.id, source: ocSource, conversationId: "conversation" })))).toBe(false);
  });

  test("correlation cannot assign a colliding one-to-one alias", async () => {
    const f = fixture(), service = new ConversationUpdates(f.store);
    const first = candidate("first", { sourceSequence: 1, legacyRunId: "run" }), second = candidate("second", { sourceSequence: 2 });
    expect(await service.upsertNativeBatch(nativeBatch(2, [first, second]))).toBe(true);
    const disk = readFileSync(f.path, "utf8");
    expect(await service.correlate([{ id: second.id, source: ocSource, conversationId: "conversation", legacyRunId: "run" }])).toBe(false);
    expect(f.store.getUpdate(second.id)?.legacyRunId).toBeUndefined(); expect(readFileSync(f.path, "utf8")).toBe(disk);
  });

  test("oversized OC checkpoints are rejected upstream and malformed native submission cannot disable the App feed", async () => {
    const creation = { eventId: "created", createdAt: 1 };
    const source = { ...ocSource, incarnation: openCodeIncarnation(creation) };
    const binding: OpenCodeReplyBinding = { conversationId: "conversation", source, creation };
    const state = initialOpenCodeReplyState(binding); state.created = true; state.parent = true; state.seq = 5000;
    state.seenMessages = Array.from({ length: 1000 }, (_, i) => `msg_${i}_${"x".repeat(300)}`);
    const checkpoint = { version: 1 as const, sourceKey: updateSourceKey(source), through: 5000, baselineThrough: 5000, state };
    const stateBytes = Buffer.byteLength(JSON.stringify(state)), observerBytes = Buffer.byteLength(JSON.stringify(checkpoint));
    expect(stateBytes).toBeGreaterThan(256 * 1024); expect(observerBytes).toBeGreaterThan(256 * 1024);
    expect(validateOpenCodeReplyCheckpoint(checkpoint, binding)).toBe(false);
    expect(isConversationUpdateCheckpoint({ key: nativeUpdateCheckpointKey(source), sourceKey: checkpoint.sourceKey, through: 5000, baselineThrough: 5000, state })).toBe(false);
    const f = fixture(), service = new ConversationUpdates(f.store, { projector: ccProjector }), r = records();
    expect(await service.ingestCommitted(r.session, r.run, r.event(1, "stdout", success(0)))).toBe(true);
    const disk = readFileSync(f.path, "utf8"), head = service.getHead();
    expect(await service.upsertNativeBatch({ source, candidates: [], through: 5000, baselineThrough: 5000, state })).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk);
    expect(f.store.getCheckpoint(nativeUpdateCheckpointKey(source))).toBeUndefined();
    expect(f.store.getHealth().state).toBe("ready"); expect(service.getHead()).toEqual(head);
    expect((await service.page()).updates).toHaveLength(1);
    expect(await service.ingestCommitted(r.session, r.run, r.event(2, "stdout", success(1)))).toBe(true);
    expect((await service.page()).updates.filter(row => row.source.harness === "claude-code")).toHaveLength(2);
    console.info(`OC checkpoint budget evidence: state=${stateBytes}B observerCheckpoint=${observerBytes}B; both ceilings=262144B`);
  });
});

describe("authoritative bootstrap, adapter diagnostics and lifecycle", () => {
  test("bootstrap requires authoritative active runs, not an inference from empty retained rows", async () => {
    const f = fixture(), service = new ConversationUpdates(f.store);
    await expect(service.page({}, true)).rejects.toMatchObject({ code: "CONVERSATION_UPDATES_UNAVAILABLE" });
    expect((await service.page()).updates).toEqual([]);
    const authoritative = new ConversationUpdates(f.store, { bootstrap: () => ({ activeRunIds: ["running"], sourceBaselines: [] }) });
    expect((await authoritative.page({}, true)).bootstrap).toEqual({ activeRunIds: ["running"], sourceBaselines: [] });
  });

  test("failing bootstrap or coverage callbacks expose only structured unavailable errors", async () => {
    const f = fixture();
    for (const options of [{ bootstrap: () => { throw new Error("private path"); } }, { coverage: () => { throw new Error("private credentials"); } }]) {
      const service = new ConversationUpdates(f.store, options);
      try { await service.page({}, true); throw new Error("Expected unavailable"); }
      catch (error) {
        expect(error).toBeInstanceOf(ConversationUpdateServiceError);
        expect((error as ConversationUpdateServiceError).code).toBe("CONVERSATION_UPDATES_UNAVAILABLE");
        expect((error as Error).message).not.toContain("private");
      }
    }
    const coverage = new ConversationUpdates(f.store, { coverage: () => { throw new Error("private credentials"); } });
    await expect(coverage.page()).rejects.toMatchObject({ code: "CONVERSATION_UPDATES_UNAVAILABLE" });
  });

  test("closing drains already accepted work and refuses later optional ingestion", async () => {
    const f = fixture(), r = records(), service = new ConversationUpdates(f.store, { projector: ccProjector });
    const accepted = service.ingestCommitted(r.session, r.run, r.event(1, "stdout", success(0)));
    await service.close(); expect(await accepted).toBe(true);
    expect(f.store.getHead()?.through).toBe(1);
    expect(await service.ingestCommitted(r.session, r.run, r.event(2, "stdout", success(1)))).toBe(false);
    expect(await service.upsertNativeBatch(nativeBatch(1))).toBe(false);
    expect(await service.replayRun(r.session, r.run, [])).toBe(false);
  });
});
