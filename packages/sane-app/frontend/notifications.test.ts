import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { notificationStore as store } from "./notifications";
import { NotificationDatabase } from "./notification-db";
import { controlledIDB, installIDB, tick } from "./notification-db.test";
import { LEGACY_PREFIX, legacyIdentity, legacyKey } from "./notifications-legacy";
import { updateOccurrenceId, updateSourceKey, type ConversationUpdate, type ConversationUpdatePage, type ConversationUpdateSource } from "../shared/conversation/conversation-updates";
import { notificationContextKey, notificationSourceMatches } from "./notification-source";
import type { Conversation } from "./types";

const source: ConversationUpdateSource = { harness: "claude-code", authorityId: "authority", nativeSessionId: "native" };
const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({ id: "A", ...source, cwd: "/fixture", lastRunId: "run", status: "completed", title: "Parent", ...overrides });
const event = (boundary: string, sequence: number, overrides: Partial<ConversationUpdate> = {}): ConversationUpdate => ({
  id: updateOccurrenceId(source, boundary), source, conversationId: "A", runId: "run", kind: "reply", occurredAt: null,
  observedAt: "2026-10-05T00:00:00Z", sequence, occurrenceSequence: sequence, revision: 1, ...overrides,
});
const page = (updates: ConversationUpdate[] = [], overrides: Partial<ConversationUpdatePage> = {}): ConversationUpdatePage => {
  const through = updates.at(-1)?.sequence ?? 0;
  return { storeId: "store", epoch: "epoch", retainedAfter: 0, through, nextCursor: { epoch: "epoch", after: through }, hasMore: false, updates, coverage: [], ...overrides };
};
const bootstrap = (updates: ConversationUpdate[] = [], activeRunIds: string[] = []) => page(updates, { bootstrap: { activeRunIds, sourceBaselines: [] } });
const ocBase: ConversationUpdateSource = { ...source, harness: "opencode" };
const ocNative: ConversationUpdateSource = { ...ocBase, incarnation: "creation-1" };
const ocConversation = (overrides: Partial<Conversation> = {}): Conversation => conversation({ ...ocBase, updateSource: ocNative, workspaceId: "workspace", worktreeId: "worktree", ...overrides } as Partial<Conversation>);
const sourcedEvent = (s: ConversationUpdateSource, boundary: string, sequence: number, overrides: Partial<ConversationUpdate> = {}) => event(boundary, sequence, {
  source: s, id: updateOccurrenceId(s, boundary), observedAt: `2026-10-05T00:00:${String(sequence).padStart(2, "0")}Z`, ...overrides,
});
let serial = 0;
let owner: string, window: Window, restore: () => void, savedWindow: PropertyDescriptor | undefined, savedChannel: PropertyDescriptor | undefined;
let idb: ReturnType<typeof controlledIDB>;
const drain = async () => { await (store as any).queue; };
async function start(memoryOnly = false) {
  restore(); restore = installIDB(memoryOnly ? undefined : idb);
  owner = `notification-test-${++serial}`; store.activate(owner); await store.ready();
  store.setFeedEnabled(true); store.observe([conversation()]); await drain();
}
const apply = (wire: ConversationUpdatePage) => store.applyPage(wire, store.resume()?.cursor ?? null);
function oldRecord(runId: string, readAt = 0, c = conversation()) {
  const identity = legacyIdentity(c), key = legacyKey({ identity, runId });
  return { identity, conversationId: c.id, runId, phase: "settled", observedActive: true, bornAt: 1, touchedAt: 2, readAt,
    item: { id: key, conversationId: c.id, runId, title: "Old", status: "completed", time: "2026-10-05T00:00:00Z" } };
}
function writeLegacy(records: ReturnType<typeof oldRecord>[]) {
  window.localStorage.setItem(LEGACY_PREFIX + owner, JSON.stringify({ version: 1, scope: owner, floor: 0, records }));
  window.dispatchEvent(new window.StorageEvent("storage", { key: LEGACY_PREFIX + owner }));
}

describe("notification store with happy-dom", () => {
  beforeEach(() => {
    store.suspend(); savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window"); savedChannel = Object.getOwnPropertyDescriptor(globalThis, "BroadcastChannel");
    window = new Window({ url: "https://fixture.test" });
    Object.defineProperty(globalThis, "window", { configurable: true, value: window });
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
    idb = controlledIDB(); restore = installIDB(idb);
  });
  afterEach(async () => {
    idb.hold = false; idb.release(); store.suspend(); await drain(); restore();
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
    if (savedChannel) Object.defineProperty(globalThis, "BroadcastChannel", savedChannel); else Reflect.deleteProperty(globalThis, "BroadcastChannel");
    await window.happyDOM.close();
  });

  for (const memoryOnly of [false, true]) describe(memoryOnly ? "explicit memory fallback (no durability/cross-tab claim)" : "actual store + NotificationDatabase transactional paths via stub", () => {
    test("E1 acknowledgement cannot read later E2 in the same run; revisions never resurrect reads or promote seed", async () => {
      await start(memoryOnly); const seed = event("seed", 1, { runId: "old" });
      expect(await store.applyPage(bootstrap([seed]), null, true)).toBe(true); expect(store.snapshot().unreadCount).toBe(0);
      const e1 = event("E1", 2); expect(await apply(page([e1]))).toBe(true);
      const capture = store.captureOpen("A")!; expect(capture.ids).toEqual([e1.id]);
      const e2 = event("E2", 3); expect(await apply(page([e2]))).toBe(true);
      store.acknowledgeCaptured(capture); await drain();
      expect(store.captureOpen("A")!.ids).toEqual([e2.id]);
      const revisedSeed = { ...seed, sequence: 4, revision: 2, legacyRunId: "unobserved-old" };
      const revisedRead = { ...e1, sequence: 5, revision: 2, legacyRunId: "run" };
      const revisedUnread = { ...e2, sequence: 6, revision: 2, kind: "failed" as const };
      expect(await apply(page([revisedSeed, revisedRead, revisedUnread]))).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([e2.id]); expect(store.snapshot().items[0]?.kind).toBe("failed");
      expect(!!store.snapshot().storageError).toBe(memoryOnly);
    });

    test("initial history is silent; fast acceptance after seeding promotes only the exact accepted run", async () => {
      await start(memoryOnly);
      const old = event("old", 1, { runId: "old" }), fast = event("fast", 2, { runId: "fast" });
      expect(await store.applyPage(bootstrap([old, fast]), null, true)).toBe(true); expect(store.snapshot().unreadCount).toBe(0);
      store.acceptRun("A", "fast"); await drain(); expect(store.captureOpen("A")!.ids).toEqual([fast.id]);
      store.markRead("A"); await drain(); store.acceptRun("A", "fast"); await drain(); expect(store.snapshot().unreadCount).toBe(0);
    });

    test("bootstrap active receipt survives a fast terminal catalog but does not promote unrelated history", async () => {
      await start(memoryOnly);
      const old = event("old", 1, { runId: "old" }), active = event("active", 2);
      expect(await store.applyPage(bootstrap([old, active], ["run"]), null, true)).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([active.id]);
    });

    test("source rebind discards captures from the old catalog source", async () => {
      await start(memoryOnly); await store.applyPage(bootstrap(), null, true); const e1 = event("E1", 1); await apply(page([e1]));
      const capture = store.captureOpen("A");
      store.observe([conversation({ authorityId: "replacement" })]); await drain(); expect(store.snapshot().unreadCount).toBe(0);
      store.acknowledgeCaptured(capture); await drain();
      store.observe([conversation()]); await drain();
      // A source rebind must not let a capture from the old catalog clear the old occurrence.
      expect(store.captureOpen("A")!.ids).toEqual([e1.id]);
    });

    test("authentication rebind discards captures even when the same owner returns", async () => {
      await start(memoryOnly); await store.applyPage(bootstrap(), null, true); const e1 = event("E1", 1); await apply(page([e1]));
      const beforeAuth = store.captureOpen("A"); store.suspend(); store.activate("other-owner"); await store.ready();
      store.acknowledgeCaptured(beforeAuth); await drain(); store.suspend(); store.activate(owner); await store.ready(); store.setFeedEnabled(true); store.observe([conversation()]); await drain();
      expect(store.captureOpen("A")!.ids).toEqual([e1.id]);
    });

    test("only exact alias on last same-run occurrence migrates a legacy read", async () => {
      await start(memoryOnly); writeLegacy([oldRecord("run", 10)]); await drain();
      const first = event("first", 1), last = event("last", 2, { legacyRunId: "run" });
      await store.applyPage(bootstrap([first, last]), null, true); store.acceptRun("A", "run"); await drain();
      expect(store.captureOpen("A")!.ids).toEqual([first.id]);
      writeLegacy([oldRecord("run")]); await drain(); expect(store.captureOpen("A")!.ids).toEqual([first.id]);
    });

    test("App terminal and native reply group once, retain actual latest source/destination, and read only frozen IDs", async () => {
      await start(memoryOnly); const c = ocConversation(); store.observe([c]); await drain();
      expect(await store.applyPage(bootstrap(), null, true)).toBe(true);
      const base = sourcedEvent(ocBase, "base-failure", 1, { kind: "failed" });
      const e1 = sourcedEvent(ocNative, "E1", 2, { sourceSequence: 9000 });
      expect(await apply(page([base, e1]))).toBe(true);
      expect(store.snapshot().unreadCount).toBe(1);
      expect(store.snapshot().items[0]).toMatchObject({ id: e1.id, conversationId: "A", sourceKey: updateSourceKey(ocNative), groupId: notificationContextKey(c), contextKey: notificationContextKey(c), workspaceId: "workspace", worktreeId: "worktree", kind: "reply" });
      expect(notificationSourceMatches(c, store.snapshot().items[0]!.sourceKey!)).toBe(true);
      const capture = store.captureOpen("A")!;
      expect(capture.ids).toEqual([base.id, e1.id]);
      expect(capture.sources).toEqual([updateSourceKey(ocBase), updateSourceKey(ocNative)]);
      const e2 = sourcedEvent(ocNative, "E2", 3, { sourceSequence: 9001 });
      expect(await apply(page([e2]))).toBe(true);
      store.acknowledgeCaptured(capture); await drain();
      expect(store.captureOpen("A")!.ids).toEqual([e2.id]);
      expect(store.snapshot().items[0]?.sourceKey).toBe(updateSourceKey(ocNative));
      const laterBase = sourcedEvent(ocBase, "base-interrupted", 4, { kind: "interrupted" });
      expect(await apply(page([laterBase]))).toBe(true);
      expect(store.snapshot().unreadCount).toBe(1);
      expect(store.snapshot().items[0]).toMatchObject({ id: laterBase.id, sourceKey: updateSourceKey(ocBase), kind: "interrupted", groupId: notificationContextKey(c) });
      expect(store.captureOpen("A")!.ids).toEqual([e2.id, laterBase.id]);
      if (!memoryOnly) expect(idb.rows("reads", owner).map(row => row.key).sort()).toEqual([base.id, e1.id].sort());
    });

    test("base and native read markers remain independent and historical incarnationless IDs remain immutable", async () => {
      await start(memoryOnly); store.observe([ocConversation()]); await drain();
      const history = sourcedEvent(ocBase, "old-incarnationless-reply", 1, { runId: "old", historical: true });
      expect(await store.applyPage(bootstrap([history]), null, true)).toBe(true);
      const base = sourcedEvent(ocBase, "failure", 2, { kind: "failed" });
      expect(await apply(page([base]))).toBe(true); store.markRead("A"); await drain();
      const native = sourcedEvent(ocNative, "reply", 3);
      expect(await apply(page([native]))).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([native.id]);
      store.markRead("A"); await drain();
      expect(await apply(page([{ ...history, sequence: 4, revision: 2, observedAt: "2026-10-05T00:01:00Z" }]))).toBe(true);
      expect(store.snapshot().unreadCount).toBe(0);
      if (!memoryOnly) {
        expect(idb.rows("reads", owner).map(row => row.key).sort()).toEqual([base.id, native.id].sort());
        const saved = idb.rows("events", owner).find(row => row.key === history.id)!;
        expect(saved.value.update.source).toEqual(ocBase);
        expect(saved.value.update.id).toBe(history.id);
        expect(saved.value.eligible).toBe(false);
      }
    });

    for (const rebind of ["incarnation", "authority", "native session"] as const) test(`${rebind} rebind invalidates captures and never broadly rebinds accepted receipts`, async () => {
      await start(memoryOnly); const original = ocConversation(); store.observe([original]); await drain();
      store.acceptRun("A", "run"); await drain();
      expect(await store.applyPage(bootstrap(), null, true)).toBe(true);
      const old = sourcedEvent(ocNative, "old", 1); expect(await apply(page([old]))).toBe(true);
      const capture = store.captureOpen("A")!;
      const reboundSource = { ...ocNative, ...(rebind === "incarnation" ? { incarnation: "creation-2" } : rebind === "authority" ? { authorityId: "other" } : { nativeSessionId: "other" }) };
      const rebound = ocConversation({ ...reboundSource, updateSource: reboundSource });
      store.observe([rebound]); await drain();
      store.acknowledgeCaptured(capture); await drain();
      const candidate = sourcedEvent(reboundSource, "same-run-new-identity", 2, { historical: true });
      expect(await apply(page([candidate]))).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([]);
      store.observe([original]); await drain();
      // An away-and-back rebind also invalidates the old capture revision.
      store.acknowledgeCaptured(capture); await drain();
      expect(store.captureOpen("A")!.ids).toEqual([old.id]);
      if (!memoryOnly) {
        expect(idb.rows("reads", owner)).toEqual([]);
        expect(idb.rows("accepted", owner)[0].value).toMatchObject({ sourceKey: updateSourceKey(ocBase), nativeSourceKey: updateSourceKey(ocNative) });
      }
    });

    test("exact base receipt rescues only admitted same-run native history, binding at most one incarnation", async () => {
      await start(memoryOnly); store.observe([ocConversation({ updateSource: undefined })]); await drain();
      store.acceptRun("A", "run"); await drain();
      const c = ocConversation(); store.observe([c]); await drain();
      const exact = sourcedEvent(ocNative, "exact", 1);
      const unrelated = sourcedEvent(ocNative, "unrelated", 2, { runId: "unrelated" });
      const wrongAuthority = sourcedEvent({ ...ocNative, authorityId: "foreign" }, "foreign", 3);
      const wrongConversation = sourcedEvent(ocNative, "wrong-conversation", 4, { conversationId: "B" });
      expect(await store.applyPage(bootstrap([exact, unrelated, wrongAuthority, wrongConversation]), null, true)).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([exact.id]);
      const nextSource = { ...ocNative, incarnation: "creation-2" };
      store.observe([ocConversation({ updateSource: nextSource })]); await drain();
      const next = sourcedEvent(nextSource, "same-run-but-new-creation", 5, { historical: true });
      expect(await apply(page([next]))).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([]);
      if (!memoryOnly) expect(idb.rows("accepted", owner)[0].value).toMatchObject({ sourceKey: updateSourceKey(ocBase), nativeSourceKey: updateSourceKey(ocNative), runId: "run", conversationId: "A" });
    });

    test("alias-only metadata revisions preserve unread ordering, read markers, and silent history", async () => {
      await start(memoryOnly); const a = ocConversation(), b = conversation({ id: "B", title: "Second" });
      store.observe([a, b]); await drain();
      const seed = sourcedEvent(ocNative, "seed", 1, { runId: "old" });
      expect(await store.applyPage(bootstrap([seed]), null, true)).toBe(true);
      const first = sourcedEvent(ocNative, "first", 2), second = sourcedEvent(source, "second", 3, { conversationId: "B" });
      expect(await apply(page([first, second]))).toBe(true);
      expect(store.snapshot().items.map(item => item.conversationId)).toEqual(["B", "A"]);
      const attention = store.snapshot().items[1]!.observedAt;
      expect(await apply(page([{ ...first, sequence: 4, revision: 2, legacyRunId: "alias", observedAt: "2026-10-05T00:01:00Z" }]))).toBe(true);
      expect(store.snapshot().items.map(item => item.conversationId)).toEqual(["B", "A"]);
      expect(store.snapshot().items[1]?.observedAt).toBe(attention);
      store.markRead("A"); await drain();
      expect(await apply(page([{ ...first, sequence: 5, revision: 3, legacyRunId: "alias" }, { ...seed, sequence: 6, revision: 2, legacyRunId: "old-alias" }]))).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([]);
      expect(store.snapshot().items.map(item => item.conversationId)).toEqual(["B"]);
    });

    test("App acceptance with a native catalog stores the immutable App base, not catalog creation", async () => {
      await start(memoryOnly); store.observe([ocConversation()]); await drain();
      store.acceptRun("A", "R"); await drain();
      const receipts = memoryOnly ? [...(store as any).memory.accepted.values()] : idb.rows("accepted", owner).map(row => row.value);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ conversationId: "A", runId: "R", sourceKey: updateSourceKey(ocBase) });
      // Catalog creation alone is not proof that this App run owns native history.
      expect(receipts[0].nativeSourceKey).toBeUndefined();
    });

    test("App receipt R still rescues exact incarnationless terminal R after I1-to-I2 catalog change", async () => {
      await start(memoryOnly); store.observe([ocConversation({ lastRunId: "catalog-run" })]); await drain();
      store.acceptRun("A", "R"); await drain();
      const i2 = { ...ocNative, incarnation: "creation-2" };
      store.observe([ocConversation({ updateSource: i2, lastRunId: "unrelated" })]); await drain();
      const exact = sourcedEvent(ocBase, "App-terminal-R", 1, { runId: "R", kind: "failed", historical: true });
      const unrelated = sourcedEvent(ocBase, "App-terminal-unrelated", 2, { runId: "unrelated", historical: true });
      expect(await store.applyPage(bootstrap([exact, unrelated]), null, true)).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([exact.id]);
      expect(store.snapshot().items[0]).toMatchObject({ id: exact.id, sourceKey: updateSourceKey(ocBase), kind: "failed" });
      const records = memoryOnly ? [...(store as any).memory.events.values()] : idb.rows("events", owner).map(row => row.value);
      expect(records.find(row => row.update.id === unrelated.id)?.eligible).toBe(false);
    });

    test("run-bearing native candidate proves only exact run ownership, never arbitrary same-base native history", async () => {
      await start(memoryOnly); store.observe([ocConversation({ lastRunId: "R" })]); await drain();
      store.acceptRun("A", "R"); await drain();
      const unowned = sourcedEvent(ocNative, "unowned-history", 1, { runId: undefined });
      const differentRun = sourcedEvent(ocNative, "different-run-history", 2, { runId: "other" });
      const exact = sourcedEvent(ocNative, "exact-R", 3, { runId: "R" });
      expect(await store.applyPage(bootstrap([unowned, differentRun, exact]), null, true)).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([exact.id]);
      const receipts = memoryOnly ? [...(store as any).memory.accepted.values()] : idb.rows("accepted", owner).map(row => row.value);
      expect(receipts[0]).toMatchObject({ runId: "R", sourceKey: updateSourceKey(ocBase), nativeSourceKey: updateSourceKey(ocNative) });
      const anotherUnowned = sourcedEvent(ocNative, "later-unowned-history", 4, { runId: undefined, historical: true });
      expect(await apply(page([anotherUnowned]))).toBe(true);
      expect(store.captureOpen("A")!.ids).toEqual([exact.id]);
    });
  });

  for (const readAt of [0, 10]) test(`cross-incarnation retained alias ambiguity preserves ${readAt ? "read" : "unread"} unmapped legacy evidence before source filtering`, async () => {
    await start(); store.observe([]); await drain();
    const i2 = { ...ocNative, incarnation: "creation-2" };
    const first = sourcedEvent(ocNative, "I1-reply", 1, { legacyRunId: "legacy-run", runId: "legacy-run" });
    const second = sourcedEvent(i2, "I2-reply", 2, { legacyRunId: "legacy-run", runId: "legacy-run", historical: true });
    // Separate wire pages are valid individually but cannot prove uniqueness
    // across the retained occurrences of two native creations.
    expect(await store.applyPage(bootstrap([first]), null, true)).toBe(true);
    expect(await apply(page([second]))).toBe(true);
    const c = ocConversation({ updateSource: i2, lastRunId: "catalog-run" });
    const old = oldRecord("legacy-run", readAt, c); writeLegacy([old]); await drain();
    store.observe([c]); await drain();
    const sidecar = idb.rows("legacy", owner)[0].value;
    expect(sidecar.mappings).toEqual([]);
    expect(sidecar.tombstones).not.toContain(old.item.id);
    expect(sidecar.records.some((row: any) => row.runId === "legacy-run")).toBe(true);
    expect(idb.rows("reads", owner).map(row => row.key)).not.toContain(second.id);
    expect(store.captureOpen("A")!.ids).toEqual([]);
    expect(store.captureOpen("A")!.legacyIds).toEqual(readAt ? [] : [old.item.id]);
    if (!readAt) expect(store.snapshot().items[0]?.kind).toBe("legacy");
  });

  for (const coverage of ["missing", "stale I1", "App base ready"] as const) test(`current I2 reports missing/stale native coverage for ${coverage} while preserving legacy fallback`, async () => {
    await start(); const i2 = { ...ocNative, incarnation: "creation-2" };
    const c = ocConversation({ updateSource: i2 });
    store.observe([ocConversation({ updateSource: i2, status: "running", lastRunStatus: "running" })]);
    store.observe([c]); await drain();
    const capturedLegacy = store.captureOpen("A")!.legacyIds;
    expect(capturedLegacy).toHaveLength(1);
    const rows = coverage === "missing" ? [] : [{ sourceKey: updateSourceKey(coverage === "stale I1" ? ocNative : ocBase), state: "ready" as const }];
    expect(await store.applyPage(page([], { bootstrap: { activeRunIds: [], sourceBaselines: [] }, coverage: rows }), null, true)).toBe(true);
    expect(store.captureOpen("A")!.legacyIds).toEqual(capturedLegacy);
    expect(store.snapshot().items[0]?.kind).toBe("legacy");
    expect(store.snapshot().feedError).toMatch(/coverage/i);
    expect(store.snapshot().feedError).toMatch(/missing|stale|unavailable|initializ|waiting/i);
  });

  test("healthy current native coverage ignores stale and unrelated source notices", async () => {
    await start(); const i2 = { ...ocNative, incarnation: "creation-2" };
    store.observe([ocConversation({ updateSource: i2 })]); await drain();
    expect(await store.applyPage(page([], { bootstrap: { activeRunIds: [], sourceBaselines: [] }, coverage: [
      { sourceKey: updateSourceKey(i2), state: "ready" },
      { sourceKey: updateSourceKey(ocNative), state: "degraded", reason: "stale I1 warning must not leak" },
      { sourceKey: updateSourceKey({ ...i2, nativeSessionId: "unrelated" }), state: "unavailable", reason: "unrelated source warning must not leak" },
    ] }), null, true)).toBe(true);
    expect(store.snapshot().feedError).toBe("");
  });

  test("disabling the feed removes missing-native-coverage notices without reading fallback", async () => {
    await start(); const c = ocConversation();
    store.observe([ocConversation({ status: "running", lastRunStatus: "running" })]); store.observe([c]); await drain();
    expect(await store.applyPage(bootstrap(), null, true)).toBe(true);
    const fallback = store.captureOpen("A")!.legacyIds;
    expect(fallback).toHaveLength(1);
    store.setFeedEnabled(false);
    expect(store.snapshot().feedError).toBe("");
    expect(store.captureOpen("A")!.legacyIds).toEqual(fallback);
    expect(store.snapshot().unreadCount).toBe(1);
  });

  for (const state of ["ready", "initializing", "degraded", "unavailable"] as const) test(`OC legacy fallback survives ${state} coverage until an exact allowed-source alias`, async () => {
    await start(); const c = ocConversation();
    store.observe([ocConversation({ status: "running", lastRunStatus: "running" })]);
    store.observe([c]); await drain();
    const legacyId = store.captureOpen("A")!.legacyIds[0]!;
    expect(legacyId).toBeTruthy();
    const sameRun = sourcedEvent(ocNative, "run-id-only", 1);
    const foreign = sourcedEvent({ ...ocNative, authorityId: "foreign" }, "foreign-alias", 2, { legacyRunId: "run" });
    const wrongConversation = sourcedEvent(ocNative, "wrong-conversation-alias", 3, { conversationId: "B", legacyRunId: "run" });
    expect(await store.applyPage(page([sameRun, foreign], { bootstrap: { activeRunIds: [], sourceBaselines: [] }, coverage: [{ sourceKey: updateSourceKey(ocNative), state }] }), null, true)).toBe(true);
    // Alias uniqueness is validated per page; exercise wrong-conversation evidence
    // in a separate valid page, without bypassing wire admission.
    expect(await apply(page([{ ...wrongConversation, historical: true }]))).toBe(true);
    expect(store.captureOpen("A")!.legacyIds).toEqual([legacyId]);
    expect(store.captureOpen("A")!.ids).toEqual([]);
    expect(store.snapshot().items[0]?.kind).toBe("legacy");
    // Retained same-conversation aliases must be unique before source filtering.
    // Withdraw the foreign producer's bad alias before asserting exact migration.
    expect(await apply(page([{ ...foreign, sequence: 4, revision: 2, legacyRunId: undefined }]))).toBe(true);
    const exact = { ...sameRun, sequence: 5, revision: 2, legacyRunId: "run" };
    expect(await apply(page([exact]))).toBe(true);
    expect(store.captureOpen("A")!.legacyIds).toEqual([]);
    expect(store.captureOpen("A")!.ids).toEqual([sameRun.id]);
    const sidecar = idb.rows("legacy", owner)[0].value;
    expect(sidecar.tombstones).toContain(legacyId);
    expect(sidecar.mappings).toContainEqual([legacyId, sameRun.id]);
  });

  test("legacy runId alone never reads all replies; only the exact one-to-one alias transfers a legacy read", async () => {
    await start(); const c = ocConversation(); store.observe([c]); await drain();
    const old = oldRecord("run", 10, c); writeLegacy([old]); await drain();
    const first = sourcedEvent(ocNative, "first", 1), last = sourcedEvent(ocNative, "last", 2);
    expect(await store.applyPage(bootstrap([first, last]), null, true)).toBe(true);
    store.acceptRun("A", "run"); await drain();
    expect(store.captureOpen("A")!.ids).toEqual([first.id, last.id]);
    expect(idb.rows("reads", owner)).toEqual([]);
    expect(await apply(page([{ ...last, sequence: 3, revision: 2, legacyRunId: "run" }]))).toBe(true);
    expect(store.captureOpen("A")!.ids).toEqual([first.id]);
    expect(idb.rows("reads", owner).map(row => row.key)).toEqual([last.id]);
  });

  test("ambiguous duplicate canonical aliases never suppress or broadly migrate legacy evidence", async () => {
    await start(); const c = ocConversation(); store.observe([]); await drain();
    const first = sourcedEvent(ocNative, "first", 1, { legacyRunId: "run" });
    const last = sourcedEvent(ocNative, "last", 2, { legacyRunId: "run", historical: true });
    expect(await store.applyPage(bootstrap([first]), null, true)).toBe(true);
    expect(await apply(page([last]))).toBe(true);
    store.observe([c]); await drain();
    const old = oldRecord("run", 0, c); writeLegacy([old]); await drain();
    expect(store.captureOpen("A")!.legacyIds).toEqual([old.item.id]);
    expect(store.captureOpen("A")!.ids).toEqual([]);
    expect(idb.rows("legacy", owner)[0].value.mappings).toEqual([]);
  });

  test("late old-tab OC legacy resurrection is tombstoned continuously and after hydration", async () => {
    await start(); const c = ocConversation(); store.observe([c]); await drain();
    const old = oldRecord("run", 0, c); writeLegacy([old]); await drain();
    const capture = store.captureOpen("A")!;
    const canonical = sourcedEvent(ocNative, "canonical", 1, { legacyRunId: "run" });
    expect(await store.applyPage(bootstrap([canonical]), null, true)).toBe(true);
    store.acknowledgeCaptured(capture); await drain();
    for (let rewrite = 0; rewrite < 3; rewrite++) {
      writeLegacy([{ ...old, touchedAt: 100 + rewrite }]); store.observe([c]); await drain();
      expect(store.snapshot().unreadCount).toBe(0);
    }
    store.suspend(); (store as any).scopes.delete(owner); store.activate(owner); await store.ready(); store.setFeedEnabled(true); store.observe([c]); await drain();
    writeLegacy([{ ...old, touchedAt: 999 }]); await drain();
    expect(store.snapshot().unreadCount).toBe(0);
    expect(idb.rows("reads", owner).map(row => row.key)).toEqual([canonical.id]);
    expect(idb.rows("legacy", owner)[0].value.tombstones).toContain(old.item.id);
  });

  test("stored-read merge while capture is open does not expand its frozen keys", async () => {
    await start(); await store.applyPage(bootstrap(), null, true);
    const e1 = event("E1", 1), e2 = event("E2", 2); await apply(page([e1])); const capture = store.captureOpen("A")!;
    const other = new NotificationDatabase();
    try {
      await other.transaction(owner, rows => rows.reads.set(e1.id, 100), () => true);
      await apply(page([e2])); expect(capture.ids).toEqual([e1.id]); store.acknowledgeCaptured(capture); await drain();
      expect(store.captureOpen("A")!.ids).toEqual([e2.id]); expect(idb.rows("reads", owner).map(row => row.key)).toEqual([e1.id]);
    } finally { other.close(); }
  });

  test("ongoing legacy import preserves unread; exact aliases and sidecar tombstones survive old writer rewrites/reload", async () => {
    await start(); const old = oldRecord("run"); writeLegacy([old]); await drain(); expect(store.snapshot().items[0]?.kind).toBe("legacy");
    const capture = store.captureOpen("A")!, canonical = event("canonical", 1, { legacyRunId: "run" });
    await store.applyPage(bootstrap([canonical]), null, true); expect(store.captureOpen("A")!.ids).toEqual([canonical.id]);
    store.acknowledgeCaptured(capture); await drain(); expect(store.snapshot().unreadCount).toBe(0);
    writeLegacy([old]); await drain();
    const sidecar = idb.rows("legacy", owner)[0].value;
    expect(sidecar.tombstones).toContain(old.item.id); expect(sidecar.mappings).toContainEqual([old.item.id, canonical.id]);
    // Force disk hydration rather than reusing this singleton's owner memory.
    store.suspend(); (store as any).scopes.delete(owner); store.activate(owner); await store.ready(); store.setFeedEnabled(true); store.observe([conversation()]); await drain();
    expect(store.snapshot().unreadCount).toBe(0);
    writeLegacy([old, oldRecord("new-old-writer-run")]); await drain(); expect(store.snapshot().items[0]?.runId).toBe("new-old-writer-run");
    store.markRead("A"); await drain(); writeLegacy([old, oldRecord("new-old-writer-run")]); await drain(); expect(store.snapshot().unreadCount).toBe(0);
  });

  test("quota fallback cursor recovers to durable cursor for replay, without losing read evidence", async () => {
    await start(); await store.applyPage(bootstrap(), null, true); const e1 = event("E1", 1); await apply(page([e1]));
    store.markRead("A"); await drain(); idb.quota = true;
    const e2 = event("E2", 2); expect(await apply(page([e2]))).toBe(true);
    expect(store.resume()?.cursor?.after).toBe(2); expect(store.snapshot().storageError).toContain("memory only");
    expect(idb.rows("resume", owner)[0].value.cursor.after).toBe(1);
    idb.quota = false; window.dispatchEvent(new window.Event("focus")); await drain();
    expect(store.resume()?.cursor?.after).toBe(1); expect(store.snapshot().storageError).toBe("");
    expect(await apply(page([e2]))).toBe(true); expect(store.captureOpen("A")!.ids).toEqual([e2.id]);
    expect(idb.rows("resume", owner)[0].value.cursor.after).toBe(2);
  });

  test("unavailable storage recovery replays from empty durable cursor, not memory head", async () => {
    await start(true); const seeded = event("seeded", 1, { runId: "old" });
    await store.applyPage(bootstrap([seeded]), null, true); const live = event("live", 2); await apply(page([live]));
    store.markRead("A"); await drain(); expect(store.resume()?.cursor?.after).toBe(2);
    restore(); restore = installIDB(idb); window.dispatchEvent(new window.Event("focus")); await drain();
    expect(store.resume()).toEqual({ seeding: true }); expect(store.snapshot().storageError).toBe("");
    expect(await store.applyPage(bootstrap([seeded, live]), null, true)).toBe(true);
    expect(store.snapshot().unreadCount).toBe(0); expect(idb.rows("reads", owner).map(row => row.key)).toEqual([live.id]);
  });

  for (const mismatch of ["store", "epoch", "through", "changed occurrence identity"] as const) test(`invalid ${mismatch} page cannot advance durable or memory cursor`, async () => {
    await start(); const original = event("E1", 1);
    await store.applyPage(page([original], { through: 3, hasMore: true, bootstrap: { activeRunIds: [], sourceBaselines: [] } }), null, true);
    const revised = { ...original, sequence: 2, revision: 2 };
    const invalid = page([revised], { through: 3, hasMore: true });
    if (mismatch === "store") invalid.storeId = "other";
    if (mismatch === "epoch") { invalid.epoch = "other"; invalid.nextCursor.epoch = "other"; }
    if (mismatch === "through") invalid.through = 4;
    if (mismatch === "changed occurrence identity") invalid.updates[0] = { ...revised, conversationId: "different" };
    expect(await apply(invalid)).toBe(false); expect(store.resume()?.cursor?.after).toBe(1);
    expect(idb.rows("resume", owner)[0].value.cursor.after).toBe(1); expect(store.snapshot().feedError).toBeTruthy();
    expect(await apply(page([revised], { through: 3, hasMore: true }))).toBe(true); expect(store.resume()?.cursor?.after).toBe(2);
  });

  test("suspend discards pending asynchronous page completion and its old capture", async () => {
    await start(); await store.applyPage(bootstrap(), null, true); const e1 = event("E1", 1); await apply(page([e1])); const capture = store.captureOpen("A");
    idb.hold = true; const pending = apply(page([event("E2", 2)])); await tick(); expect(idb.pending).toHaveLength(1);
    store.suspend(); store.acknowledgeCaptured(capture); idb.hold = false; idb.release();
    expect(await pending).toBe(false); expect(store.snapshot().unreadCount).toBe(0); expect(store.resume()).toBeNull();
    expect(idb.rows("reads", owner)).toEqual([]);
  });

  for (const listing of ["missing", "matching", "different incarnation", "different authority", "different native session", "main lacks optional source"] as const) test(`main-catalog navigation with ${listing} notification listing never acknowledges an ambiguous source`, async () => {
    await start();
    const main = ocConversation({ ...(listing === "main lacks optional source" ? { updateSource: undefined } : {}) });
    const feedSource = { ...ocNative, ...(listing === "different incarnation" ? { incarnation: "creation-2" } : listing === "different authority" ? { authorityId: "feed-authority" } : listing === "different native session" ? { nativeSessionId: "feed-native" } : {}) };
    const feed = ocConversation({ ...feedSource, updateSource: feedSource });
    store.observe([feed]); await drain(); expect(await store.applyPage(bootstrap(), null, true)).toBe(true);
    const unread = sourcedEvent(feedSource, "unread", 1); expect(await apply(page([unread]))).toBe(true);
    const { ChatStore } = await import("./store");
    const { conversationClient } = await import("./cc-client");
    const { catalog } = await import("./catalog");
    const savedCatalog = catalog.state, chat = new ChatStore(conversationClient);
    (chat as any).poll = async () => {};
    chat.state = { ...chat.state, phase: "ready", selected: "B", conversations: [main],
      config: { authenticated: true, authRequired: false, storeId: "store", conversationUpdates: true } };
    (chat as any).notificationScope = "store";
    (chat as any).notificationSources = new Map(listing === "missing" ? [] : [["A", notificationContextKey(feed)]]);
    catalog.state = { ...savedCatalog, ready: false, navigation: { ...savedCatalog.navigation, conversationId: "B" } };
    try {
      expect(chat.openConversation("A")).toBe(true); await drain();
      expect(chat.state.selected).toBe("A");
      expect(catalog.snapshot().navigation).toMatchObject({ view: "chat", conversationId: "A", workspaceId: "workspace", worktreeId: "worktree" });
      expect(store.captureOpen("A")!.ids).toEqual(listing === "matching" ? [] : [unread.id]);
      expect(idb.rows("reads", owner).map(row => row.key)).toEqual(listing === "matching" ? [unread.id] : []);
    } finally {
      (chat as any).stop(); (chat as any).stopNotifications();
      catalog.invalidate(); catalog.state = savedCatalog;
    }
  });

  test("explicit open uses main catalog when optional notification listing is absent", async () => {
    const { ChatStore } = await import("./store");
    const { conversationClient } = await import("./cc-client");
    const { catalog } = await import("./catalog");
    const savedCatalog = catalog.state;
    const chat = new ChatStore(conversationClient);
    // Exercise real choose/navigation but suppress unrelated transcript I/O.
    (chat as any).poll = async () => {};
    chat.state = { ...chat.state, phase: "ready", selected: "B", conversations: [conversation()],
      config: { authenticated: true, authRequired: false, storeId: "store", conversationUpdates: true } };
    (chat as any).notificationScope = "store";
    (chat as any).notificationSources.clear();
    catalog.state = { ...savedCatalog, ready: false, navigation: { ...savedCatalog.navigation, conversationId: "B" } };
    try {
      expect(chat.openConversation("A")).toBe(true);
      expect(chat.state.selected).toBe("A");
      expect(catalog.snapshot().navigation).toMatchObject({ view: "chat", conversationId: "A" });
    } finally {
      (chat as any).stop(); (chat as any).stopNotifications();
      catalog.invalidate(); catalog.state = savedCatalog;
    }
  });
});
