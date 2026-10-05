import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { notificationStore as store } from "./notifications";
import { NotificationDatabase } from "./notification-db";
import { controlledIDB, installIDB, tick } from "./notification-db.test";
import { LEGACY_PREFIX, legacyIdentity, legacyKey } from "./notifications-legacy";
import { updateOccurrenceId, type ConversationUpdate, type ConversationUpdatePage, type ConversationUpdateSource } from "../shared/conversation/conversation-updates";
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
function oldRecord(runId: string, readAt = 0) {
  const identity = legacyIdentity(conversation()), key = legacyKey({ identity, runId });
  return { identity, conversationId: "A", runId, phase: "settled", observedActive: true, bornAt: 1, touchedAt: 2, readAt,
    item: { id: key, conversationId: "A", runId, title: "Old", status: "completed", time: "2026-10-05T00:00:00Z" } };
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
