import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicAppRecord } from "./app-store";
import {
  CONVERSATION_UPDATE_MAX_ROWS, ConversationUpdateServiceError, ConversationUpdateStore,
  isConversationUpdateCheckpoint, type ConversationUpdateCheckpoint,
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
