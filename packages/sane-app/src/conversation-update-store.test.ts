import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { atomicAppRecord } from "./app-store";
import {
  CONVERSATION_UPDATE_MAX_ROWS, CONVERSATION_UPDATE_STORE_BYTES, ConversationUpdateServiceError, ConversationUpdateStore,
  isConversationUpdateCheckpoint, isConversationUpdateCommitCurrent, isConversationUpdateExpectedCheckpoint, type ConversationUpdateCheckpoint,
  type ConversationUpdateCommitGuard, type ConversationUpdateCommitExtras,
} from "./conversation-update-store";
import {
  CONVERSATION_UPDATE_MAX_BYTES, isConversationUpdatePage, updateOccurrenceId, updateSourceKey,
  type ConversationUpdateCandidate, type ConversationUpdateSource,
} from "../shared/conversation/conversation-updates";
import { conversationUpdateRoute } from "./conversation-update-routes";

const tempRoot = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode";
const dirs: string[] = [];
const source: ConversationUpdateSource = { harness: "opencode", authorityId: "authority", nativeSessionId: "ses_native", incarnation: "creation" };
const sourceKey = updateSourceKey(source);
const now = "2026-10-05T12:00:00.000Z";
const candidate = (name: string, patch: Partial<ConversationUpdateCandidate> = {}): ConversationUpdateCandidate => ({
  id: updateOccurrenceId(source, name), source, conversationId: "conversation", kind: "reply", occurredAt: null, ...patch,
});
const checkpoint = (through: number, patch: Partial<ConversationUpdateCheckpoint> = {}): ConversationUpdateCheckpoint => ({
  key: JSON.stringify(["native", sourceKey]), sourceKey, through, ...patch,
});
function fixture(options: ConstructorParameters<typeof ConversationUpdateStore>[2] = {}) {
  const dir = mkdtempSync(join(tempRoot, "conversation-update-store-test-")); dirs.push(dir);
  const store = new ConversationUpdateStore(dir, "store", { now: () => now, ...options });
  return { dir, store, path: join(dir, "conversation-updates.json") };
}
function errorCode(fn: () => unknown): string | undefined {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ConversationUpdateServiceError);
    return (error as ConversationUpdateServiceError).code;
  }
  throw new Error("Expected a conversation update service error");
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("conversation update store persistence and isolation", () => {
  test("initial save failure does not publish an epoch and can recover after storage repair", () => {
    let fail = true;
    const f = fixture({ save: (root, name, value) => { if (fail) throw new Error("save failed"); atomicAppRecord(root, name, value); } });
    expect(f.store.load()).toBe(false);
    expect(f.store.getHead()).toBeUndefined();
    expect(f.store.getHealth().state).toBe("unavailable");
    fail = false;
    expect(f.store.load()).toBe(true);
    expect(f.store.getHead()?.through).toBe(0);
  });

  test("failed save advances neither occurrence nor checkpoint and prevents queued overwrites", async () => {
    let fail = false, writes = 0;
    const f = fixture({ save: (root, name, value) => { writes++; if (fail) throw new Error("disk failure"); atomicAppRecord(root, name, value); } });
    expect(f.store.load()).toBe(true);
    const oldHead = f.store.getHead()!, disk = readFileSync(f.path, "utf8");
    fail = true;
    const first = f.store.commitCandidates([candidate("first", { sourceSequence: 1 })], checkpoint(1, { state: { pending: "first" } }));
    const second = f.store.commitCandidates([candidate("second", { sourceSequence: 2 })], checkpoint(2));
    expect(await first).toBe(false); expect(await second).toBe(false);
    expect(writes).toBe(2);
    expect(f.store.getHead()).toBeUndefined();
    expect(f.store.getUpdate(candidate("first").id)).toBeUndefined();
    expect(f.store.getCheckpoints()).toEqual([]);
    expect(readFileSync(f.path, "utf8")).toBe(disk);
    fail = false;
    expect(f.store.load()).toBe(true);
    expect(f.store.getHead()).toEqual(oldHead);
    expect(await f.store.commitCandidates([candidate("first", { sourceSequence: 1 })], checkpoint(1))).toBe(true);
    expect(f.store.getHead()?.through).toBe(1);
  });

  test("ambiguous disk commit never publishes an in-memory head before reconciliation", async () => {
    let ambiguous = false, writes = 0;
    const f = fixture({ save: (root, name, value) => {
      writes++; atomicAppRecord(root, name, value);
      if (ambiguous) throw new Error("rename committed, directory fsync failed");
    } });
    expect(f.store.load()).toBe(true);
    const epoch = f.store.getHead()!.epoch;
    ambiguous = true;
    expect(await f.store.commitCandidates([candidate("first", { sourceSequence: 10 })], checkpoint(10, { state: { pending: [] } }))).toBe(false);
    expect(f.store.getHead()).toBeUndefined();
    expect(f.store.getUpdate(candidate("first").id)).toBeUndefined();
    expect(f.store.getCheckpoint(checkpoint(10).key)).toBeUndefined();
    const disk = readFileSync(f.path, "utf8");
    expect(JSON.parse(disk)).toMatchObject({ epoch, head: 1, checkpoints: [checkpoint(10, { state: { pending: [] } })] });
    expect(await f.store.commitCandidates([candidate("second", { sourceSequence: 11 })], checkpoint(11))).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk); expect(writes).toBe(2);
    ambiguous = false;
    expect(f.store.load()).toBe(true);
    expect(f.store.getHead()?.through).toBe(1);
    expect(f.store.getUpdate(candidate("first").id)?.occurrenceSequence).toBe(1);
    expect(await f.store.commitCandidates([candidate("first", { sourceSequence: 10 })], checkpoint(10, { state: { pending: [] } }))).toBe(true);
    expect(f.store.getHead()?.through).toBe(1); expect(writes).toBe(2);
  });

  test("rows, reducer state, source progress and coverage are one atomic persisted value", async () => {
    const saves: unknown[] = [];
    const f = fixture({ save: (root, name, value) => { saves.push(structuredClone(value)); atomicAppRecord(root, name, value); } });
    expect(f.store.load()).toBe(true);
    const cp = checkpoint(20, { baselineThrough: 10, state: { pending: { id: "pending" } }, coverage: { sourceKey, state: "ready", through: 20, baselineThrough: 10 } });
    expect(await f.store.commitCandidates([candidate("reply", { sourceSequence: 20 })], cp)).toBe(true);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ head: 1, rows: [{ id: candidate("reply").id }], checkpoints: [cp] });
    const restarted = new ConversationUpdateStore(f.dir, "store");
    expect(restarted.load()).toBe(true);
    expect(restarted.getHead()).toEqual(f.store.getHead());
    expect(restarted.getCheckpoint(cp.key)).toEqual(cp);
  });

  test("malformed JSON, foreign identity and invalid row schema never overwrite existing records", () => {
    for (const contents of ["{broken", JSON.stringify({ version: 1, storeId: "other", epoch: "epoch", head: 0, retainedAfter: 0, rows: [], checkpoints: [] }),
      JSON.stringify({ version: 1, storeId: "store", epoch: "epoch", head: 1, retainedAfter: 0, rows: [{ ...candidate("bad"), sequence: 1, revision: 1, occurrenceSequence: 2, observedAt: now }], checkpoints: [] })]) {
      let writes = 0;
      const f = fixture({ save: () => { writes++; } }); writeFileSync(f.path, contents);
      expect(f.store.load()).toBe(false); expect(f.store.load()).toBe(false);
      expect(writes).toBe(0); expect(f.store.getHead()).toBeUndefined();
      expect(readFileSync(f.path, "utf8")).toBe(contents);
    }
  });

  test("a symlink record is unavailable and neither link nor target is overwritten", () => {
    const f = fixture(), target = join(f.dir, "target.json"); writeFileSync(target, "do not touch"); symlinkSync(target, f.path);
    expect(f.store.load()).toBe(false); expect(readFileSync(target, "utf8")).toBe("do not touch");
  });

  test("captures transaction inputs and returns detached checkpoints and rows", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const row = candidate("reply", { source: { ...source }, sourceSequence: 1 }), cp = checkpoint(1, { state: { pending: "original" } });
    const pending = f.store.commitCandidates([row], cp);
    row.conversationId = "mutated"; (cp.state as { pending: string }).pending = "mutated";
    expect(await pending).toBe(true);
    const loaded = f.store.getCheckpoint(cp.key)!; loaded.through = 900;
    expect(f.store.getCheckpoint(cp.key)?.through).toBe(1);
    const loadedRow = f.store.getUpdate(row.id)!; loadedRow.conversationId = "mutated";
    expect(f.store.getUpdate(row.id)?.conversationId).toBe("conversation");
    expect(f.store.getCheckpoint(cp.key)?.state).toEqual({ pending: "original" });
  });
});

describe("conversation update store live commit guards", () => {
  test("runtime malformed guards fail closed before reading transaction inputs or saving", async () => {
    let writes = 0, bodyCalls = 0;
    const f = fixture({ now: () => { bodyCalls++; return now; }, save: (root, name, value) => { writes++; atomicAppRecord(root, name, value); } });
    expect(f.store.load()).toBe(true);
    expect(await f.store.commitCandidates([candidate("old", { sourceSequence: 1 })], checkpoint(1), undefined,
      { nativeMessages: { sourceKey, ids: ["msg_old"] } })).toBe(true);
    const snapshot = () => ({ disk: readFileSync(f.path, "utf8"), head: f.store.getHead(), checkpoints: f.store.getCheckpoints(),
      coverage: f.store.getCoverage(), health: f.store.getHealth(), page: f.store.page(), writes });
    const before = snapshot(); bodyCalls = 0;
    const row = candidate("reject", { sourceSequence: 2 });
    Object.defineProperty(row, "messageId", { enumerable: true, get: () => { bodyCalls++; return "msg_reject"; } });
    const listener = () => {};
    const invalid: unknown[] = [null, [], 7, { isCurrent: false }, { isCurrent: null }, { isCurrent: "current" },
      { isCurrent: () => false }, { isCurrent: () => { throw new Error("fixture registration failure"); } },
      { signal: {} }, { signal: null }, { signal: [] },
      { signal: { aborted: "false", addEventListener: listener, removeEventListener: listener } },
      { signal: { aborted: 0, addEventListener: listener, removeEventListener: listener } },
      { signal: { aborted: false } }, { signal: { aborted: false, addEventListener: listener } },
      { signal: { aborted: false, removeEventListener: listener } },
      { signal: { aborted: false, addEventListener: "listener", removeEventListener: listener } },
      { signal: { aborted: false, addEventListener: listener, removeEventListener: null } }];
    for (const value of invalid) {
      const guard = value as unknown as ConversationUpdateCommitGuard;
      expect(isConversationUpdateCommitCurrent(guard)).toBe(false);
      expect(await f.store.commitCandidates([row], checkpoint(2), guard, { nativeMessages: { sourceKey, ids: ["msg_reject"] } })).toBe(false);
      expect(bodyCalls).toBe(0); expect(snapshot()).toEqual(before);
      expect(f.store.hasNativeMessage(sourceKey, "msg_old")).toBe(true); expect(f.store.hasNativeMessage(sourceKey, "msg_reject")).toBe(false);
    }
    let callbackCalls = 0;
    expect(isConversationUpdateCommitCurrent({ signal: {} as unknown as AbortSignal, isCurrent: () => { callbackCalls++; return true; } })).toBe(false);
    expect(callbackCalls).toBe(0);
  });

  test("undefined guard and cross-realm structural signal remain supported", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const signal = runInNewContext("({ aborted: false, addEventListener() {}, removeEventListener() {} })") as unknown as AbortSignal;
    expect(signal instanceof AbortSignal).toBe(false);
    const guard: ConversationUpdateCommitGuard = { signal, isCurrent() { return this === guard; } };
    expect(isConversationUpdateCommitCurrent(undefined)).toBe(true); expect(isConversationUpdateCommitCurrent(guard)).toBe(true);
    expect(await f.store.commitCandidates([candidate("default", { sourceSequence: 1 })], checkpoint(1), undefined,
      { nativeMessages: { sourceKey, ids: ["msg_default"] } })).toBe(true);
    expect(await f.store.commitCandidates([candidate("structural", { sourceSequence: 2 })], checkpoint(2), guard,
      { nativeMessages: { sourceKey, ids: ["msg_structural"] } })).toBe(true);
    expect(f.store.hasNativeMessage(sourceKey, "msg_default")).toBe(true); expect(f.store.hasNativeMessage(sourceKey, "msg_structural")).toBe(true);
    expect(f.store.getHead()?.through).toBe(2); expect(f.store.getHealth()).toEqual({ state: "ready" });
  });

  test("queued guards that become malformed are rejected at the real store boundary", async () => {
    for (const mutation of ["callback", "aborted-type", "missing-listener"] as const) {
      const f = fixture(); expect(f.store.load()).toBe(true);
      const before = readFileSync(f.path, "utf8"), head = f.store.getHead();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const queued = f.store as unknown as { queue: Promise<unknown> }; queued.queue = queued.queue.then(() => gate);
      const signal: Record<string, unknown> = { aborted: false, addEventListener() {}, removeEventListener() {} };
      const value: Record<string, unknown> = { signal, isCurrent: () => true };
      const pending = f.store.commitCandidates([candidate("reject", { sourceSequence: 1 })], checkpoint(1), value as unknown as ConversationUpdateCommitGuard,
        { nativeMessages: { sourceKey, ids: ["msg_reject"] } });
      if (mutation === "callback") value.isCurrent = false;
      else if (mutation === "aborted-type") signal.aborted = "false";
      else delete signal.removeEventListener;
      release(); expect(await pending).toBe(false);
      expect(readFileSync(f.path, "utf8")).toBe(before); expect(f.store.getHead()).toEqual(head);
      expect(f.store.getCheckpoints()).toEqual([]); expect(f.store.getCoverage()).toEqual([]);
      expect(f.store.hasNativeMessage(sourceKey, "msg_reject")).toBe(false); expect(f.store.getHealth()).toEqual({ state: "ready" });
    }
  });

  test("guard helper fails closed, short-circuits aborted signals and detects abort inside callback", () => {
    expect(isConversationUpdateCommitCurrent()).toBe(true);
    expect(isConversationUpdateCommitCurrent({ isCurrent: () => true })).toBe(true);
    expect(isConversationUpdateCommitCurrent({ isCurrent: () => false })).toBe(false);
    expect(isConversationUpdateCommitCurrent({ isCurrent: () => { throw new Error("stale registration"); } })).toBe(false);
    const aborted = new AbortController(); aborted.abort(); let calls = 0;
    expect(isConversationUpdateCommitCurrent({ signal: aborted.signal, isCurrent: () => { calls++; return true; } })).toBe(false);
    expect(calls).toBe(0);
    const during = new AbortController();
    expect(isConversationUpdateCommitCurrent({ signal: during.signal, isCurrent: () => { during.abort(); return true; } })).toBe(false);
  });

  for (const phase of ["admission", "queued", "prepared"] as const) {
    for (const mode of ["aborted", "rebound", "throwing"] as const) {
      test(`${mode} guard at ${phase} rejects without changing persisted state or health`, async () => {
        let stale = false, writes = 0;
        const controller = new AbortController();
        const invalidate = () => { stale = true; if (mode === "aborted") controller.abort(); };
        const f = fixture({
          now: () => { if (phase === "prepared") invalidate(); return now; },
          save: (root, name, value) => { writes++; atomicAppRecord(root, name, value); },
        });
        expect(f.store.load()).toBe(true);
        const before = { disk: readFileSync(f.path, "utf8"), head: f.store.getHead(), checkpoints: f.store.getCheckpoints(),
          coverage: f.store.getCoverage(), health: f.store.getHealth(), page: f.store.page(), writes };
        // A deferred predecessor on this test-owned queue isolates the real store
        // transaction boundary without pretending synchronous persistence is async.
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        if (phase === "queued") {
          const queued = f.store as unknown as { queue: Promise<unknown> };
          queued.queue = queued.queue.then(() => gate);
        }
        if (phase === "admission") invalidate();
        const row = candidate("guarded", { sourceSequence: 1 });
        const cp = checkpoint(1, { baselineThrough: 0, state: { pending: "guarded" },
          coverage: { sourceKey, state: "ready", through: 1, baselineThrough: 0 } });
        const pending = f.store.commitCandidates([row], cp, { signal: controller.signal, isCurrent: () => {
          if (stale && mode === "throwing") throw new Error("registration lookup failed");
          return !stale;
        } });
        if (phase === "queued") invalidate();
        release();
        expect(await pending).toBe(false);
        expect(f.store.getUpdate(row.id)).toBeUndefined();
        expect({ disk: readFileSync(f.path, "utf8"), head: f.store.getHead(), checkpoints: f.store.getCheckpoints(),
          coverage: f.store.getCoverage(), health: f.store.getHealth(), page: f.store.page(), writes }).toEqual(before);
      });
    }
  }

  test("successful synchronous save followed by abort and rebinding truthfully returns true", async () => {
    const controller = new AbortController(); let current = true, cancelAfterSave = false;
    const f = fixture({ save: (root, name, value) => {
      atomicAppRecord(root, name, value);
      if (cancelAfterSave) { controller.abort(); current = false; }
    } });
    expect(f.store.load()).toBe(true); cancelAfterSave = true;
    const row = candidate("saved", { sourceSequence: 1 }), cp = checkpoint(1, { state: { pending: null } });
    expect(await f.store.commitCandidates([row], cp, { signal: controller.signal, isCurrent: () => current })).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(f.store.getUpdate(row.id)).toMatchObject({ occurrenceSequence: 1, revision: 1 });
    expect(f.store.getCheckpoint(cp.key)).toEqual(cp);
    expect(JSON.parse(readFileSync(f.path, "utf8"))).toMatchObject({ head: 1, rows: [{ id: row.id }], checkpoints: [cp] });
    expect(f.store.getHealth()).toEqual({ state: "ready" });
  });
});

describe("conversation update store exact ledger and checkpoint CAS", () => {
  test("native ledger extras require a matching native checkpoint even for empty ids", async () => {
    let writes = 0;
    const f = fixture({ save: (root, name, value) => { writes++; atomicAppRecord(root, name, value); } });
    expect(f.store.load()).toBe(true);
    expect(await f.store.commitCandidates([candidate("old", { sourceSequence: 1 })], checkpoint(1), undefined,
      { nativeMessages: { sourceKey, ids: ["msg_old"] } })).toBe(true);
    const foreign = { ...source, authorityId: "foreign" }, foreignKey = updateSourceKey(foreign);
    const a = candidate("reject-A", { sourceSequence: 2 });
    const b = candidate("reject-B", { id: updateOccurrenceId(foreign, "reject-B"), source: foreign, sourceSequence: 2 });
    const cases: { rows: ConversationUpdateCandidate[]; cp?: ConversationUpdateCheckpoint; extras: ConversationUpdateCommitExtras }[] = [
      { rows: [], extras: { nativeMessages: { sourceKey, ids: ["msg_reject"] } } },
      { rows: [a], extras: { nativeMessages: { sourceKey: foreignKey, ids: ["msg_reject"] } } },
      { rows: [], extras: { nativeMessages: { sourceKey, ids: [] } } },
      { rows: [a], cp: checkpoint(2), extras: { nativeMessages: { sourceKey: foreignKey, ids: [] } } },
      { rows: [a], cp: checkpoint(2, { key: JSON.stringify(["app-run", sourceKey, "run"]) }), extras: { nativeMessages: { sourceKey, ids: ["msg_reject"] } } },
      { rows: [a, b], cp: checkpoint(2), extras: { nativeMessages: { sourceKey, ids: ["msg_reject"] } } },
      { rows: [a], cp: checkpoint(2), extras: { nativeMessages: { sourceKey: foreignKey, ids: ["msg_reject"] } } },
    ];
    const snapshot = () => ({ disk: readFileSync(f.path, "utf8"), head: f.store.getHead(), checkpoints: f.store.getCheckpoints(),
      coverage: f.store.getCoverage(), health: f.store.getHealth(), page: f.store.page(), writes });
    const before = snapshot();
    for (const { rows, cp, extras } of cases) {
      expect(await f.store.commitCandidates(rows, cp, undefined, extras)).toBe(false);
      expect(snapshot()).toEqual(before);
      expect(f.store.getUpdate(a.id)).toBeUndefined(); expect(f.store.getUpdate(b.id)).toBeUndefined();
      expect(f.store.hasNativeMessage(sourceKey, "msg_old")).toBe(true);
      expect(f.store.hasNativeMessage(sourceKey, "msg_reject")).toBe(false); expect(f.store.hasNativeMessage(foreignKey, "msg_reject")).toBe(false);
    }
    expect(await f.store.commitCandidates([a], checkpoint(2), undefined, { nativeMessages: { sourceKey, ids: ["msg_valid"] } })).toBe(true);
    expect(writes).toBe(before.writes + 1);
    expect(JSON.parse(readFileSync(f.path, "utf8"))).toMatchObject({ head: 2, rows: [{ id: candidate("old").id }, { id: a.id }],
      checkpoints: [checkpoint(2)], nativeMessages: [{ sourceKey, ids: ["msg_old", "msg_valid"] }] });
    expect(await f.store.commitCandidates([], checkpoint(3), undefined, { nativeMessages: { sourceKey, ids: [] } })).toBe(true);
    expect(f.store.hasNativeMessage(sourceKey, "msg_old")).toBe(true); expect(f.store.hasNativeMessage(sourceKey, "msg_valid")).toBe(true);
  });

  test("CAS validates canonical key shape and binds the exact checkpoint, not only matching progress", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const foreignKey = updateSourceKey({ ...source, authorityId: "foreign" });
    const wrong = [JSON.stringify(["native", foreignKey]), JSON.stringify(["app-run", sourceKey, "run"]), JSON.stringify(["native", sourceKey, "other"] )];
    for (const key of wrong) {
      expect(isConversationUpdateExpectedCheckpoint({ key, through: null })).toBe(true);
      expect(await f.store.commitCandidates([candidate("reject", { sourceSequence: 1 })], checkpoint(1), { expectedCheckpoint: { key, through: null } },
        { nativeMessages: { sourceKey, ids: ["msg_reject"] } })).toBe(false);
    }
    const invalid: unknown[] = [null, [], { key: "not-json", through: null }, { key: "bad\nkey", through: null },
      { key: JSON.stringify(["native", sourceKey], null, 2), through: null }, { key: JSON.stringify(["native", "foreign"]), through: null },
      { key: checkpoint(1).key, through: null, extra: true }, { key: checkpoint(1).key }, { key: checkpoint(1).key, through: "0" }];
    for (const expectedCheckpoint of invalid) {
      expect(isConversationUpdateExpectedCheckpoint(expectedCheckpoint)).toBe(false);
      expect(isConversationUpdateCommitCurrent({ expectedCheckpoint } as unknown as ConversationUpdateCommitGuard)).toBe(false);
    }
    expect(await f.store.commitCandidates([candidate("reject", { sourceSequence: 1 })], undefined,
      { expectedCheckpoint: { key: wrong[0]!, through: null } })).toBe(false);
    expect(f.store.getHead()?.through).toBe(0); expect(f.store.getCheckpoints()).toEqual([]); expect(f.store.getCoverage()).toEqual([]);
    expect(f.store.hasNativeMessage(sourceKey, "msg_reject")).toBe(false); expect(f.store.getHealth()).toEqual({ state: "ready" });
  });

  test("serial CAS distinguishes absent/null from zero and same-value replay is idempotent", async () => {
    let writes = 0;
    const f = fixture({ save: (root, name, value) => { writes++; atomicAppRecord(root, name, value); } });
    expect(f.store.load()).toBe(true);
    const cp = checkpoint(0, { state: { pending: "original" } });
    const expectedCheckpoint = { key: cp.key, through: null };
    const first = f.store.commitCandidates([], cp, { expectedCheckpoint }, { nativeMessages: { sourceKey, ids: ["msg_original"] } });
    const stale = f.store.commitCandidates([], { ...cp, state: { pending: "stale" } }, { expectedCheckpoint }, { nativeMessages: { sourceKey, ids: ["msg_stale"] } });
    expect(await first).toBe(true); expect(await stale).toBe(false);
    expect(f.store.getCheckpoint(cp.key)).toEqual(cp);
    expect(f.store.hasNativeMessage(sourceKey, "msg_original")).toBe(true);
    expect(f.store.hasNativeMessage(sourceKey, "msg_stale")).toBe(false);
    const disk = readFileSync(f.path, "utf8"), head = f.store.getHead(), health = f.store.getHealth(), coverage = f.store.getCoverage(), beforeWrites = writes;
    expect(await f.store.commitCandidates([], cp, { expectedCheckpoint: { key: cp.key, through: 0 } }, { nativeMessages: { sourceKey, ids: ["msg_original"] } })).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe(disk); expect(writes).toBe(beforeWrites);
    expect(f.store.getHead()).toEqual(head); expect(f.store.getHealth()).toEqual(health); expect(f.store.getCoverage()).toEqual(coverage);
    expect(await f.store.commitCandidates([], checkpoint(1), { expectedCheckpoint })).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk);
  });

  test("queued winner advances rows, checkpoint and ledger; stale CAS cannot overwrite any part", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    expect(await f.store.commitCandidates([], checkpoint(1), undefined, { nativeMessages: { sourceKey, ids: ["msg_old"] } })).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = f.store as unknown as { queue: Promise<unknown> }; queued.queue = queued.queue.then(() => gate);
    const guard = { expectedCheckpoint: { key: checkpoint(1).key, through: 1 } };
    const winner = candidate("winner", { sourceSequence: 2 }), stale = candidate("stale", { sourceSequence: 2 });
    const first = f.store.commitCandidates([winner], checkpoint(2, { state: { pending: "winner" } }), guard, { nativeMessages: { sourceKey, ids: ["msg_winner"] } });
    const second = f.store.commitCandidates([stale], checkpoint(2, { state: { pending: "stale" } }), guard, { nativeMessages: { sourceKey, ids: ["msg_stale"] } });
    expect(f.store.hasNativeMessage(sourceKey, "msg_winner")).toBe(false);
    release(); expect(await first).toBe(true);
    const disk = readFileSync(f.path, "utf8"), head = f.store.getHead(), coverage = f.store.getCoverage();
    expect(await second).toBe(false);
    expect(f.store.getCheckpoint(checkpoint(2).key)?.state).toEqual({ pending: "winner" });
    expect(f.store.getUpdate(winner.id)).toBeDefined(); expect(f.store.getUpdate(stale.id)).toBeUndefined();
    expect(f.store.hasNativeMessage(sourceKey, "msg_winner")).toBe(true); expect(f.store.hasNativeMessage(sourceKey, "msg_stale")).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk); expect(f.store.getHead()).toEqual(head);
    expect(f.store.getCoverage()).toEqual(coverage); expect(f.store.getHealth()).toEqual({ state: "ready" });
  });

  test("invalid or unmatched CAS and wrong-source transactions publish neither ledger nor rows", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    expect(await f.store.commitCandidates([], checkpoint(1))).toBe(true);
    const foreignKey = updateSourceKey({ ...source, authorityId: "foreign" });
    const disk = readFileSync(f.path, "utf8"), cp = f.store.getCheckpoints(), coverage = f.store.getCoverage(), head = f.store.getHead();
    const invalid: ConversationUpdateCommitGuard[] = [
      { expectedCheckpoint: { key: checkpoint(1).key, through: null } },
      { expectedCheckpoint: { key: JSON.stringify(["native", foreignKey]), through: 1 } },
      { expectedCheckpoint: { key: "", through: null } },
      { expectedCheckpoint: { key: "bad\nkey", through: null } },
      { expectedCheckpoint: { key: checkpoint(1).key, through: -1 } },
      { expectedCheckpoint: { key: checkpoint(1).key, through: Number.NaN } },
      { expectedCheckpoint: { key: checkpoint(1).key, through: 1.5 } },
    ];
    const row = candidate("reject", { sourceSequence: 2 });
    const extras = { nativeMessages: { sourceKey, ids: ["msg_reject"] } };
    for (const guard of invalid) expect(await f.store.commitCandidates([row], checkpoint(2), guard, extras)).toBe(false);
    expect(await f.store.commitCandidates([row], checkpoint(2), undefined, { nativeMessages: { sourceKey: foreignKey, ids: ["msg_reject"] } })).toBe(false);
    expect(await f.store.commitCandidates([row], checkpoint(2, { sourceKey: foreignKey }), undefined, extras)).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk); expect(f.store.getCheckpoints()).toEqual(cp);
    expect(f.store.getCoverage()).toEqual(coverage); expect(f.store.getHead()).toEqual(head); expect(f.store.getHealth()).toEqual({ state: "ready" });
    expect(f.store.hasNativeMessage(sourceKey, "msg_reject")).toBe(false); expect(f.store.hasNativeMessage(foreignKey, "msg_reject")).toBe(false);
  });

  test("ledger, candidate and checkpoint publish once atomically, capture ids, and reload source-scoped identities", async () => {
    const saves: unknown[] = [];
    const f = fixture({ save: (root, name, value) => { saves.push(structuredClone(value)); atomicAppRecord(root, name, value); } });
    expect(f.store.load()).toBe(true);
    const row = candidate("reply", { sourceSequence: 1, messageId: "msg_exact" }), cp = checkpoint(1, { state: { pending: null } });
    const ids = ["msg_exact", "msg_intermediate"];
    const pending = f.store.commitCandidates([row], cp, { expectedCheckpoint: { key: cp.key, through: null } }, { nativeMessages: { sourceKey, ids } });
    ids.push("msg_mutated");
    expect(f.store.hasNativeMessage(sourceKey, "msg_exact")).toBe(false); expect(await pending).toBe(true);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ head: 1, rows: [{ id: row.id }], checkpoints: [cp], nativeMessages: [{ sourceKey, ids: ["msg_exact", "msg_intermediate"] }] });
    expect(f.store.hasNativeMessage(sourceKey, "msg_mutated")).toBe(false);
    const restarted = new ConversationUpdateStore(f.dir, "store"); expect(restarted.load()).toBe(true);
    expect(restarted.getUpdate(row.id)).toEqual(f.store.getUpdate(row.id)); expect(restarted.getCheckpoint(cp.key)).toEqual(cp);
    expect(restarted.hasNativeMessage(sourceKey, "msg_exact")).toBe(true); expect(restarted.hasNativeMessage(sourceKey, "msg_intermediate")).toBe(true);
    const foreignKey = updateSourceKey({ ...source, incarnation: "recreated" });
    expect(restarted.hasNativeMessage(foreignKey, "msg_exact")).toBe(false);
    expect(await restarted.commitCandidates([], checkpoint(0, { key: JSON.stringify(["native", foreignKey]), sourceKey: foreignKey }), undefined,
      { nativeMessages: { sourceKey: foreignKey, ids: ["msg_exact"] } })).toBe(true);
    expect(restarted.hasNativeMessage(foreignKey, "msg_exact")).toBe(true);
    expect(restarted.hasNativeMessage(sourceKey, "msg_exact")).toBe(true);
  });

  for (const mode of ["aborted", "rebound", "save-failed"] as const) {
    test(`${mode} leaves the previously committed exact ledger unchanged`, async () => {
      let fail = false;
      const f = fixture({ save: (root, name, value) => { if (fail) throw new Error("fixture disk failure"); atomicAppRecord(root, name, value); } });
      expect(f.store.load()).toBe(true);
      expect(await f.store.commitCandidates([], checkpoint(1), undefined, { nativeMessages: { sourceKey, ids: ["msg_old"] } })).toBe(true);
      const disk = readFileSync(f.path, "utf8"), oldCheckpoint = f.store.getCheckpoint(checkpoint(1).key);
      const controller = new AbortController(); let current = true, release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const queued = f.store as unknown as { queue: Promise<unknown> }; queued.queue = queued.queue.then(() => gate);
      const row = candidate("pending", { sourceSequence: 2 });
      const pending = f.store.commitCandidates([row], checkpoint(2), { signal: controller.signal, isCurrent: () => current }, { nativeMessages: { sourceKey, ids: ["msg_new"] } });
      expect(f.store.hasNativeMessage(sourceKey, "msg_new")).toBe(false);
      if (mode === "aborted") controller.abort(); else if (mode === "rebound") current = false; else fail = true;
      release(); expect(await pending).toBe(false);
      expect(f.store.hasNativeMessage(sourceKey, "msg_old")).toBe(true); expect(f.store.hasNativeMessage(sourceKey, "msg_new")).toBe(false);
      expect(f.store.getCheckpoint(checkpoint(1).key)).toEqual(oldCheckpoint); expect(f.store.getUpdate(row.id)).toBeUndefined();
      expect(readFileSync(f.path, "utf8")).toBe(disk);
      expect(f.store.getHealth().state).toBe(mode === "save-failed" ? "unavailable" : "ready");
    });
  }

  test("pruning old feed rows never prunes the exact ledger, including intermediate-only identities", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const old = candidate("retired", { sourceSequence: 1 });
    expect(await f.store.commitCandidates([old], checkpoint(1), undefined, { nativeMessages: { sourceKey, ids: ["msg_retired", "msg_no_reply"] } })).toBe(true);
    expect(await f.store.commitCandidates(Array.from({ length: CONVERSATION_UPDATE_MAX_ROWS }, (_, i) => candidate(`new-${i}`, { sourceSequence: i + 2 })), checkpoint(CONVERSATION_UPDATE_MAX_ROWS + 1))).toBe(true);
    expect(f.store.getUpdate(old.id)).toBeUndefined(); expect(f.store.getHead()?.retainedAfter).toBe(1);
    const restarted = new ConversationUpdateStore(f.dir, "store"); expect(restarted.load()).toBe(true);
    expect(restarted.hasNativeMessage(sourceKey, "msg_retired")).toBe(true); expect(restarted.hasNativeMessage(sourceKey, "msg_no_reply")).toBe(true);
    expect(restarted.getUpdate(old.id)).toBeUndefined();
  });

  test("duplicate or malformed persisted ledgers fail load without resetting the file or epoch", async () => {
    const entry = { sourceKey, ids: ["msg_exact"] };
    for (const nativeMessages of [null, {}, [entry, entry], [{ sourceKey, ids: ["duplicate", "duplicate"] }],
      [{ sourceKey: "foreign", ids: ["msg_exact"] }], [{ sourceKey, ids: [""] }], [{ sourceKey, ids: ["bad\nmessage"] }],
      [{ sourceKey, ids: [1] }], [{ ...entry, extra: true }], [{ sourceKey, ids: "not-array" }]]) {
      const f = fixture(); expect(f.store.load()).toBe(true);
      const record = JSON.parse(readFileSync(f.path, "utf8")); record.nativeMessages = nativeMessages;
      const disk = JSON.stringify(record); writeFileSync(f.path, disk); let writes = 0;
      const restarted = new ConversationUpdateStore(f.dir, "store", { save: () => { writes++; } });
      expect(restarted.load()).toBe(false); expect(restarted.load()).toBe(false);
      expect(restarted.getHead()).toBeUndefined(); expect(restarted.getHealth().state).toBe("unavailable");
      expect(restarted.hasNativeMessage(sourceKey, "msg_exact")).toBe(false);
      expect(writes).toBe(0); expect(readFileSync(f.path, "utf8")).toBe(disk);
    }
  });

  test("invalid submitted ledgers reject the complete transaction without poisoning storage", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true); const disk = readFileSync(f.path, "utf8");
    for (const extras of [{ nativeMessages: { sourceKey, ids: ["duplicate", "duplicate"] } },
      { nativeMessages: { sourceKey, ids: ["bad\nmessage"] } }, { nativeMessages: { sourceKey, ids: ["x".repeat(16 * 1024 + 1)] } },
      { nativeMessages: { sourceKey, ids: [1] } }, { nativeMessages: { sourceKey: "foreign", ids: ["msg"] } }, { unknown: true }]) {
      expect(await f.store.commitCandidates([candidate("reject", { sourceSequence: 1 })], checkpoint(1), undefined, extras as ConversationUpdateCommitExtras)).toBe(false);
      expect(f.store.hasNativeMessage(sourceKey, "duplicate")).toBe(false);
      expect(f.store.getCheckpoints()).toEqual([]); expect(f.store.getHead()?.through).toBe(0);
      expect(f.store.getHealth()).toEqual({ state: "ready" }); expect(readFileSync(f.path, "utf8")).toBe(disk);
    }
  });

  test("whole-record ledger capacity rejects a batch atomically and leaves healthy App rows writable", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    expect(await f.store.commitCandidates([candidate("app-old")])).toBe(true);
    const disk = readFileSync(f.path, "utf8"), beforeHead = f.store.getHead();
    const ids = Array.from({ length: 1024 }, (_, i) => `message-${i}-`.padEnd(16 * 1024, "x"));
    expect(Buffer.byteLength(JSON.stringify({ nativeMessages: [{ sourceKey, ids }] }))).toBeGreaterThan(CONVERSATION_UPDATE_STORE_BYTES);
    expect(await f.store.commitCandidates([candidate("native-reject", { sourceSequence: 1 })], checkpoint(1), undefined, { nativeMessages: { sourceKey, ids } })).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk); expect(f.store.getHead()).toEqual(beforeHead);
    expect(f.store.getCheckpoints()).toEqual([]); expect(f.store.hasNativeMessage(sourceKey, ids[0]!)).toBe(false);
    expect(f.store.getHealth()).toEqual({ state: "ready" }); expect(f.store.getUpdate(candidate("app-old").id)).toBeDefined();
    expect(await f.store.commitCandidates([candidate("app-next")])).toBe(true);
    expect(f.store.getHead()?.through).toBe(2);
  });
});

describe("conversation update store occurrence invariants", () => {
  test("metadata revisions retain occurrence order and duplicate observations are idempotent", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const first = candidate("first", { nativeBoundaryId: "first", sourceSequence: 1 });
    expect(await f.store.commitCandidates([first, candidate("second", { sourceSequence: 2 })], checkpoint(2))).toBe(true);
    expect(await f.store.commitCandidates([{ ...first, runId: "run", messageId: "message", legacyRunId: "run" }], checkpoint(3))).toBe(true);
    const row = f.store.getUpdate(first.id)!;
    expect(row).toMatchObject({ sequence: 3, occurrenceSequence: 1, revision: 2, runId: "run", legacyRunId: "run", observedAt: now });
    expect(await f.store.commitCandidates([{ ...first, runId: "run", messageId: "message", legacyRunId: "run", observedAt: "2026-10-05T13:00:00Z" }], checkpoint(3))).toBe(true);
    expect(f.store.getHead()?.through).toBe(3);
    expect(f.store.getUpdate(first.id)).toEqual(row);
  });

  test("rejects duplicate legacy aliases atomically across occurrences", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const disk = readFileSync(f.path, "utf8");
    expect(await f.store.commitCandidates([candidate("one", { legacyRunId: "run", sourceSequence: 1 }), candidate("two", { legacyRunId: "run", sourceSequence: 2 })], checkpoint(2))).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk); expect(f.store.getCheckpoints()).toEqual([]);
    expect(f.store.getHealth().state).toBe("ready");
    expect(await f.store.commitCandidates([candidate("valid", { sourceSequence: 3 })], checkpoint(3))).toBe(true);
    expect(f.store.page().updates.map(row => row.id)).toEqual([candidate("valid").id]);
  });

  test("rejects source and conversation mismatches without partial publication", async () => {
    for (const patch of [{ conversationId: "other" }, { source: { ...source, authorityId: "foreign" } }, { source: { ...source, nativeSessionId: "foreign" } }]) {
      const f = fixture(); expect(f.store.load()).toBe(true);
      const original = candidate("same", { sourceSequence: 1 });
      expect(await f.store.commitCandidates([original], checkpoint(1))).toBe(true);
      const disk = readFileSync(f.path, "utf8");
      expect(await f.store.commitCandidates([{ ...original, ...patch }], checkpoint(2))).toBe(false);
      expect(readFileSync(f.path, "utf8")).toBe(disk);
      expect(f.store.getUpdate(original.id)?.revision).toBe(1);
    }
  });

  test("native boundary evidence cannot change across an omitted-boundary revision", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const original = candidate("stable", { nativeBoundaryId: "boundary-A", sourceSequence: 1 });
    expect(await f.store.commitCandidates([original], checkpoint(1))).toBe(true);
    const { nativeBoundaryId: _boundary, ...omitted } = original;
    expect(await f.store.commitCandidates([omitted], checkpoint(2))).toBe(true);
    expect(f.store.getUpdate(original.id)?.nativeBoundaryId).toBe("boundary-A");
    expect(f.store.getUpdate(original.id)?.revision).toBe(1);
    const restarted = new ConversationUpdateStore(f.dir, "store"); expect(restarted.load()).toBe(true);
    expect(restarted.getUpdate(original.id)?.nativeBoundaryId).toBe("boundary-A");
    const disk = readFileSync(f.path, "utf8");
    expect(await f.store.commitCandidates([{ ...omitted, nativeBoundaryId: "boundary-B" }], checkpoint(3))).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk);
  });

  test("loading conflicting native boundary history fails closed without overwriting", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const original = candidate("stable", { nativeBoundaryId: "boundary-A", sourceSequence: 1 });
    expect(await f.store.commitCandidates([original], checkpoint(1))).toBe(true);
    const record = JSON.parse(readFileSync(f.path, "utf8"));
    const { nativeBoundaryId: _boundary, ...omitted } = record.rows[0];
    record.rows.push({ ...omitted, sequence: 2, revision: 2 }, { ...omitted, nativeBoundaryId: "boundary-B", sequence: 3, revision: 3 }); record.head = 3;
    const disk = JSON.stringify(record); writeFileSync(f.path, disk);
    const restarted = new ConversationUpdateStore(f.dir, "store");
    expect(restarted.load()).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(disk);
  });

  test("baseline and source checkpoint regressions are rejected", async () => {
    for (const next of [checkpoint(9, { baselineThrough: 5 }), checkpoint(11, { baselineThrough: 6 }), checkpoint(11)]) {
      const f = fixture(); expect(f.store.load()).toBe(true);
      expect(await f.store.commitCandidates([], checkpoint(10, { baselineThrough: 5 }))).toBe(true);
      const disk = readFileSync(f.path, "utf8");
      expect(await f.store.commitCandidates([], next)).toBe(false);
      expect(readFileSync(f.path, "utf8")).toBe(disk);
    }
  });

  test("checkpoint JSON uses a hard UTF-8 state budget, independent of response budget", async () => {
    const accepted = checkpoint(1, { state: "x".repeat(256 * 1024 - 2) });
    expect(isConversationUpdateCheckpoint(accepted)).toBe(true);
    expect(isConversationUpdateCheckpoint(checkpoint(1, { state: "x".repeat(256 * 1024 - 1) }))).toBe(false);
    expect(isConversationUpdateCheckpoint(checkpoint(1, { state: "é".repeat(128 * 1024) }))).toBe(false);
    const f = fixture(); expect(f.store.load()).toBe(true);
    expect(await f.store.commitCandidates([], accepted)).toBe(true);
    expect(f.store.getHead()?.through).toBe(0);
    expect(f.store.page().updates).toEqual([]);
  });
});

describe("conversation update store bounded snapshots and retention", () => {
  test("fixed-through traversals preserve revision snapshots when the moving head advances", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    expect(await f.store.commitCandidates(Array.from({ length: 205 }, (_, i) => candidate(`reply-${i}`, { sourceSequence: i + 1 })), checkpoint(205))).toBe(true);
    const first = f.store.page({ limit: 2 }), epoch = first.epoch;
    expect(first.updates).toHaveLength(2); expect(first.hasMore).toBe(true); expect(first.through).toBe(205);
    expect(await f.store.commitCandidates([candidate("reply-0", { sourceSequence: 1, messageId: "late-metadata" }), candidate("new", { sourceSequence: 206 })], checkpoint(206))).toBe(true);
    const rows = [...first.updates]; let page = first;
    while (page.hasMore) {
      page = f.store.page({ cursor: page.nextCursor, through: first.through });
      expect(page.updates.length).toBeLessThanOrEqual(100);
      expect(isConversationUpdatePage(page, { epoch, through: 205 })).toBe(true);
      rows.push(...page.updates);
    }
    expect(rows).toHaveLength(205); expect(rows[0]?.messageId).toBeUndefined();
    expect(page.nextCursor.after).toBe(205);
    const changes = f.store.page({ cursor: page.nextCursor });
    expect(changes.updates.map(row => [row.sequence, row.occurrenceSequence, row.revision])).toEqual([[206, 1, 2], [207, 207, 1]]);
  });

  test("the entire page stays within the UTF-8 byte budget and every page makes progress", async () => {
    const bigSource: ConversationUpdateSource = { harness: "opencode", authorityId: "界".repeat(340), nativeSessionId: "界".repeat(340), incarnation: "界".repeat(340) };
    const f = fixture(); expect(f.store.load()).toBe(true);
    const rows = Array.from({ length: 80 }, (_, i) => candidate(`large-${i}`, {
      id: updateOccurrenceId(bigSource, `large-${i}-${"界".repeat(330)}`), source: bigSource,
      conversationId: "界".repeat(340), runId: "界".repeat(340), messageId: "界".repeat(340), nativeBoundaryId: "界".repeat(340),
    }));
    expect(await f.store.commitCandidates(rows)).toBe(true);
    let page = f.store.page(), count = 0;
    expect(page.updates.length).toBeGreaterThan(0); expect(page.updates.length).toBeLessThan(80);
    const through = page.through;
    for (;;) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(CONVERSATION_UPDATE_MAX_BYTES);
      expect(isConversationUpdatePage(page)).toBe(true); count += page.updates.length;
      if (!page.hasMore) break;
      const after = page.nextCursor.after;
      page = f.store.page({ cursor: page.nextCursor, through });
      expect(page.nextCursor.after).toBeGreaterThan(after);
    }
    expect(count).toBe(80);
  });

  test("pruning retains durable replay checkpoints, persists the epoch and maps expired cursors to HTTP 410", async () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    const first = candidate("retired", { sourceSequence: 1 });
    expect(await f.store.commitCandidates([first], checkpoint(1, { baselineThrough: 0, state: { dedup: "persisted" } }))).toBe(true);
    const oldHead = f.store.getHead()!;
    expect(await f.store.commitCandidates(Array.from({ length: CONVERSATION_UPDATE_MAX_ROWS }, (_, i) => candidate(`retained-${i}`, { sourceSequence: i + 2 })), checkpoint(CONVERSATION_UPDATE_MAX_ROWS + 1, { baselineThrough: 0, state: { dedup: "persisted" } }))).toBe(true);
    expect(f.store.getHead()?.retainedAfter).toBe(1); expect(f.store.getUpdate(first.id)).toBeUndefined();
    expect(errorCode(() => f.store.page({ cursor: { epoch: oldHead.epoch, after: 0 } }))).toBe("CONVERSATION_UPDATE_CURSOR_EXPIRED");
    expect(errorCode(() => f.store.page({ cursor: { epoch: "other", after: 1 } }))).toBe("CONVERSATION_UPDATE_CURSOR_EXPIRED");
    const response = await conversationUpdateRoute(new Request(`http://fixture/api/conversation-updates?epoch=${oldHead.epoch}&after=0`), {
      bootstrap: async limit => f.store.page({ limit }, true), page: async input => f.store.page(input),
    });
    expect(response?.status).toBe(410); expect((await response!.json()).code).toBe("conversation-update-gap");
    const restarted = new ConversationUpdateStore(f.dir, "store"); expect(restarted.load()).toBe(true);
    const persisted = restarted.getHead()!;
    expect(persisted.epoch).toBe(oldHead.epoch); expect(persisted.retainedAfter).toBe(1);
    expect(restarted.getCheckpoint(checkpoint(1).key)?.state).toEqual({ dedup: "persisted" });
    expect(await restarted.commitCandidates([first], checkpoint(CONVERSATION_UPDATE_MAX_ROWS + 1, { baselineThrough: 0, state: { dedup: "persisted" } }))).toBe(true);
    expect(restarted.getHead()).toEqual(persisted); expect(restarted.getUpdate(first.id)).toBeUndefined();
  });

  test("rejects invalid cursors and metadata that cannot fit, instead of emitting an invalid page", () => {
    const f = fixture(); expect(f.store.load()).toBe(true);
    expect(errorCode(() => f.store.page({ limit: 101 }))).toBe("INVALID_CONVERSATION_UPDATE_REQUEST");
    expect(errorCode(() => f.store.page({ through: 1 }))).toBe("INVALID_CONVERSATION_UPDATE_REQUEST");
    const bootstrap = { activeRunIds: Array.from({ length: 270 }, (_, i) => `${i}-${"x".repeat(1000)}`), sourceBaselines: [] };
    expect(errorCode(() => f.store.page({}, bootstrap))).toBe("CONVERSATION_UPDATES_UNAVAILABLE");
  });
});
