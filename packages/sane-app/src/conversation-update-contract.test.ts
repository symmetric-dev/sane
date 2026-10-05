import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_UPDATE_MAX_BYTES,
  CONVERSATION_UPDATE_MAX_PAGE,
  isConversationUpdate,
  isConversationUpdateBootstrap,
  isConversationUpdateCandidate,
  isConversationUpdateCoverage,
  isConversationUpdateCursor,
  isConversationUpdateError,
  isConversationUpdateFeedRequest,
  isConversationUpdatePage,
  isConversationUpdateSource,
  updateOccurrenceId,
  updateSourceKey,
  type ConversationUpdate,
  type ConversationUpdateCandidate,
  type ConversationUpdatePage,
  type ConversationUpdateSource,
} from "../shared/conversation/conversation-updates";

const source: ConversationUpdateSource = {
  harness: "opencode", authorityId: "authority", nativeSessionId: "session",
};
const now = "2026-10-05T12:34:56.123Z";
const sourceKey = updateSourceKey(source);

function candidate(overrides: Partial<ConversationUpdateCandidate> = {}): ConversationUpdateCandidate {
  return {
    id: updateOccurrenceId(source, "boundary"), conversationId: "conversation",
    source, kind: "reply", occurredAt: null, nativeBoundaryId: "boundary", ...overrides,
  };
}
function update(overrides: Partial<ConversationUpdate> = {}): ConversationUpdate {
  return { ...candidate(), sequence: 1, occurrenceSequence: 1, revision: 1, observedAt: now, ...overrides };
}
function page(overrides: Partial<ConversationUpdatePage> = {}): ConversationUpdatePage {
  return {
    storeId: "store", epoch: "epoch", retainedAfter: 0, through: 1,
    nextCursor: { epoch: "epoch", after: 1 }, hasMore: false,
    updates: [update()], coverage: [{ sourceKey, state: "ready" }], ...overrides,
  };
}

describe("source-qualified stable occurrence identity", () => {
  test("distinguishes harness, authority, native session, and incarnation", () => {
    const sources: ConversationUpdateSource[] = [
      source,
      { ...source, harness: "claude-code" },
      { ...source, authorityId: "other-authority" },
      { ...source, nativeSessionId: "other-session" },
      { ...source, incarnation: "first" },
      { ...source, incarnation: "second" },
    ];
    expect(new Set(sources.map(updateSourceKey)).size).toBe(sources.length);
    expect(new Set(sources.map(value => updateOccurrenceId(value, "boundary"))).size).toBe(sources.length);
    expect(updateSourceKey(source)).toBe(JSON.stringify(["opencode", "authority", "session", null]));
    expect(updateSourceKey({ ...source, incarnation: undefined })).toBe(sourceKey);
    expect(updateOccurrenceId(source, "boundary")).toBe(updateOccurrenceId({ ...source }, "boundary"));
    expect(updateOccurrenceId(source, "other-boundary")).not.toBe(updateOccurrenceId(source, "boundary"));
  });

  test("tuple encoding avoids delimiter and escaping collisions", () => {
    const left = { ...source, authorityId: "a:b", nativeSessionId: "c" };
    const right = { ...source, authorityId: "a", nativeSessionId: "b:c" };
    expect(updateSourceKey(left)).not.toBe(updateSourceKey(right));
    const boundary = 'boundary:["quoted"]\\suffix';
    expect(JSON.parse(updateOccurrenceId(left, boundary))).toEqual([updateSourceKey(left), boundary]);
  });

  test("identity constructors reject invalid source and boundary fields", () => {
    for (const value of ["", " ", "line\nbreak", "界".repeat(342)]) {
      expect(() => updateOccurrenceId(source, value)).toThrow(TypeError);
      expect(() => updateSourceKey({ ...source, authorityId: value })).toThrow(TypeError);
    }
    expect(() => updateSourceKey({ ...source, harness: "unknown" } as unknown as ConversationUpdateSource)).toThrow(TypeError);
  });
});

describe("candidate and persisted update contracts", () => {
  test("candidates have no store-assigned sequence, occurrence order, or revision", () => {
    expect(isConversationUpdateCandidate(candidate())).toBe(true);
    expect(isConversationUpdateCandidate(candidate({ observedAt: now, sourceSequence: 0, historical: false }))).toBe(true);
    expect(isConversationUpdate(candidate())).toBe(false);
    expect(isConversationUpdateCandidate(update())).toBe(false);
    for (const field of ["sequence", "occurrenceSequence", "revision"]) {
      expect(isConversationUpdateCandidate({ ...candidate(), [field]: 1 })).toBe(false);
    }
    expect(isConversationUpdate(update())).toBe(true);
    expect(isConversationUpdate({ ...update(), observedAt: undefined })).toBe(false);
  });

  test("requires positive safe transport/occurrence/revision integers and nonnegative source order", () => {
    const invalid = [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null];
    for (const field of ["sequence", "occurrenceSequence", "revision"]) {
      for (const value of [...invalid, 0]) expect(isConversationUpdate({ ...update(), [field]: value })).toBe(false);
    }
    for (const value of invalid) expect(isConversationUpdateCandidate({ ...candidate(), sourceSequence: value })).toBe(false);
    expect(isConversationUpdate(update({ sequence: Number.MAX_SAFE_INTEGER, occurrenceSequence: Number.MAX_SAFE_INTEGER, revision: Number.MAX_SAFE_INTEGER }))).toBe(true);
    expect(isConversationUpdateCandidate(candidate({ sourceSequence: Number.MAX_SAFE_INTEGER }))).toBe(true);
    expect(isConversationUpdate(update({ occurrenceSequence: 2, sequence: 1 }))).toBe(false);
    expect(isConversationUpdate(update({ occurrenceSequence: 1, sequence: 9, revision: 3 }))).toBe(true);
  });

  test("allows missing native occurrence time, but validates real RFC3339 timestamps", () => {
    for (const value of [null, now, "2024-02-29T23:59:59+05:30", "2026-10-05T12:34:56.123456789Z"]) {
      expect(isConversationUpdateCandidate(candidate({ occurredAt: value }))).toBe(true);
    }
    for (const value of [undefined, "2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-00-01T12:00:00Z", "2026-10-05T24:00:00Z", "2026-10-05T12:34:60Z", "2026-10-05T12:00:00+24:00", "2026-10-05T12:00:00+00:60", "2026-10-05T12:00:00", "yesterday"]) {
      expect(isConversationUpdateCandidate({ ...candidate(), occurredAt: value })).toBe(false);
    }
  });

  test("requires canonical occurrence IDs bound to the qualified source", () => {
    const mismatchedIds = [
      "arbitrary-id",
      JSON.stringify([sourceKey, "boundary", "extra"]),
      JSON.stringify([sourceKey, ""]),
      JSON.stringify([sourceKey, null]),
      `[ ${JSON.stringify(sourceKey)}, "boundary" ]`,
    ];
    for (const id of mismatchedIds) {
      expect(isConversationUpdateCandidate(candidate({ id }))).toBe(false);
      expect(isConversationUpdate(update({ id }))).toBe(false);
    }
    for (const differentSource of [
      { ...source, authorityId: "different" },
      { ...source, harness: "claude-code" as const },
      { ...source, nativeSessionId: "different" },
      { ...source, incarnation: "new-incarnation" },
    ]) {
      expect(isConversationUpdateCandidate(candidate({ source: differentSource }))).toBe(false);
      expect(isConversationUpdate(update({ source: differentSource }))).toBe(false);
      expect(isConversationUpdate(update({ source: differentSource, id: updateOccurrenceId(differentSource, "boundary") }))).toBe(true);
    }
  });

  test("the canonical producer boundary need not equal the native boundary UUID", () => {
    expect(isConversationUpdateCandidate(candidate({ nativeBoundaryId: "different-boundary" }))).toBe(true);
    expect(isConversationUpdate(update({ nativeBoundaryId: "different-boundary" }))).toBe(true);
  });
});

describe("strict metadata-only wire shapes and UTF-8 budgets", () => {
  test("rejects unknown fields at every payload level", () => {
    const cases: [((value: unknown) => boolean), object][] = [
      [isConversationUpdateSource, source], [isConversationUpdateCandidate, candidate()],
      [isConversationUpdate, update()], [isConversationUpdateCursor, { epoch: "epoch", after: 0 }],
      [isConversationUpdateFeedRequest, { limit: 1 }],
      [isConversationUpdateCoverage, { sourceKey, state: "ready" }],
      [isConversationUpdateBootstrap, { activeRunIds: [], sourceBaselines: [] }],
      [isConversationUpdatePage, page()], [isConversationUpdateError, { error: "unavailable" }],
    ];
    for (const [validate, value] of cases) {
      expect(validate(value)).toBe(true);
      expect(validate({ ...value, transcript: "private body" })).toBe(false);
      for (const malformed of [null, [], "payload", 1, new Date()]) expect(validate(malformed)).toBe(false);
      expect(validate(Object.assign(Object.create({ inherited: true }), value))).toBe(false);
      expect(validate(Object.assign(Object.create(null), value))).toBe(true);
    }
    expect(isConversationUpdatePage(page({ updates: [{ ...update(), toolOutput: "private" } as ConversationUpdate] }))).toBe(false);
    expect(isConversationUpdateBootstrap({ activeRunIds: [], sourceBaselines: [{ sourceKey, through: 0, body: "private" }] })).toBe(false);
  });

  test("bounds strings by bytes, not only JavaScript string length", () => {
    expect(isConversationUpdateSource({ ...source, authorityId: "界".repeat(341) })).toBe(true);
    expect(isConversationUpdateSource({ ...source, authorityId: "界".repeat(342) })).toBe(false);
    for (const value of ["", "  ", "\u0000", "\u007f", "line\nbreak"]) {
      expect(isConversationUpdateSource({ ...source, nativeSessionId: value })).toBe(false);
    }
    expect(isConversationUpdateSource({ ...source, harness: "cc" })).toBe(false);
    expect(isConversationUpdateSource({ ...source, incarnation: null })).toBe(false);
    expect(isConversationUpdateCandidate({ ...candidate(), historical: "true" })).toBe(false);
    expect(isConversationUpdateCandidate({ ...candidate(), kind: "completed" })).toBe(false);
    expect(isConversationUpdateCandidate({ ...candidate(), runId: null })).toBe(false);
    expect(isConversationUpdateError({ error: "界".repeat(682) })).toBe(true);
    expect(isConversationUpdateError({ error: "界".repeat(683) })).toBe(false);
  });

  test("enforces the whole-page UTF-8 budget, including coverage", () => {
    const coverage = Array.from({ length: 150 }, (_, index) => ({
      sourceKey: updateSourceKey({ ...source, nativeSessionId: `session-${index}` }),
      state: "degraded" as const, reason: "界".repeat(600),
    }));
    expect(coverage.every(isConversationUpdateCoverage)).toBe(true);
    const oversized = page({ coverage });
    expect(JSON.stringify(oversized).length).toBeLessThan(CONVERSATION_UPDATE_MAX_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(CONVERSATION_UPDATE_MAX_BYTES);
    expect(isConversationUpdatePage(oversized)).toBe(false);
    expect(isConversationUpdatePage(page({ coverage: coverage.slice(0, 100) }))).toBe(true);
  });

  test("bounds bootstrap metadata itself and together with the page", () => {
    const activeRunIds = Array.from({ length: 300 }, (_, index) => `${index}-${"界".repeat(300)}`);
    const oversized = { activeRunIds, sourceBaselines: [] };
    expect(JSON.stringify(oversized).length).toBeLessThan(CONVERSATION_UPDATE_MAX_BYTES);
    expect(isConversationUpdateBootstrap(oversized)).toBe(false);
    const bootstrap = { activeRunIds: activeRunIds.slice(0, 200), sourceBaselines: [] };
    expect(isConversationUpdateBootstrap(bootstrap)).toBe(true);
    const coverage = Array.from({ length: 60 }, (_, index) => ({
      sourceKey: updateSourceKey({ ...source, nativeSessionId: `session-${index}` }),
      state: "degraded" as const, reason: "界".repeat(600),
    }));
    expect(isConversationUpdatePage(page({ coverage }))).toBe(true);
    expect(isConversationUpdatePage(page({ bootstrap, coverage }))).toBe(false);
  });
});

describe("request-scoped fixed-bound traversal", () => {
  test("request and cursor counters are safe integers and bounded", () => {
    expect(isConversationUpdateFeedRequest({})).toBe(true);
    expect(isConversationUpdateFeedRequest({ cursor: { epoch: "epoch", after: 0 }, through: 0, limit: 100 })).toBe(true);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      expect(isConversationUpdateCursor({ epoch: "epoch", after: value })).toBe(false);
      expect(isConversationUpdateFeedRequest({ through: value })).toBe(false);
    }
    for (const limit of [0, 101, 1.5, Number.MAX_SAFE_INTEGER, null]) expect(isConversationUpdateFeedRequest({ limit })).toBe(false);
    expect(isConversationUpdateFeedRequest({ cursor: { epoch: "epoch", after: 3 }, through: 2 })).toBe(false);
    expect(isConversationUpdateFeedRequest({ cursor: null })).toBe(false);
    expect(isConversationUpdateCursor({ epoch: " ", after: 0 })).toBe(false);
  });

  test("binds response store, epoch, through, cursor, and requested page limit", () => {
    const value = page({ through: 10, retainedAfter: 2, nextCursor: { epoch: "epoch", after: 7 }, hasMore: true, updates: [update({ sequence: 5 })] });
    const expected = { storeId: "store", epoch: "epoch", cursor: { epoch: "epoch", after: 4 }, through: 10, limit: 1 };
    expect(isConversationUpdatePage(value, expected)).toBe(true);
    for (const mismatch of [
      { storeId: "different" }, { storeId: "" }, { epoch: "different" }, { epoch: "" },
      { through: 11 }, { through: NaN }, { limit: 0 }, { limit: 101 },
      { cursor: { epoch: "different", after: 4 } }, { cursor: { epoch: "epoch", after: 1 } },
      { cursor: { epoch: "epoch", after: 11 } }, { cursor: { epoch: "epoch", after: 8 } },
      { cursor: { epoch: "epoch", after: 5 } },
    ]) expect(isConversationUpdatePage(value, { ...expected, ...mismatch })).toBe(false);
    expect(isConversationUpdatePage(page({ through: 2, nextCursor: { epoch: "epoch", after: 2 }, updates: [update(), update({ id: updateOccurrenceId(source, "other"), sequence: 2, occurrenceSequence: 2 })] }), { limit: 1 })).toBe(false);
  });

  test("a caller omitting cursor expectations cannot detect an already-consumed replay", () => {
    expect(isConversationUpdatePage(page())).toBe(true);
    expect(isConversationUpdatePage(page(), { cursor: { epoch: "epoch", after: 1 } })).toBe(false);
  });

  test("rejects no-progress pages while allowing scan progress over compacted changes", () => {
    const scanning = page({ through: 10, nextCursor: { epoch: "epoch", after: 7 }, hasMore: true, updates: [] });
    expect(isConversationUpdatePage(scanning, { cursor: { epoch: "epoch", after: 5 }, through: 10 })).toBe(true);
    expect(isConversationUpdatePage(scanning, { cursor: { epoch: "epoch", after: 7 } })).toBe(false);
    expect(isConversationUpdatePage(page({ through: 10, nextCursor: { epoch: "epoch", after: 0 }, hasMore: true, updates: [] }))).toBe(false);
    expect(isConversationUpdatePage(page({ through: 10, nextCursor: { epoch: "epoch", after: 10 }, updates: [] }), { cursor: { epoch: "epoch", after: 10 } })).toBe(true);
    expect(isConversationUpdatePage(page({ through: 0, nextCursor: { epoch: "epoch", after: 0 }, updates: [] }))).toBe(true);
  });

  test("rejects inconsistent scan bounds, epochs, hasMore, and update order", () => {
    for (const overrides of [
      { retainedAfter: 2 }, { through: -1 }, { retainedAfter: 0.5 },
      { nextCursor: { epoch: "other", after: 1 } }, { nextCursor: { epoch: "epoch", after: 2 } },
      { hasMore: true }, { hasMore: "false" },
      { updates: [update({ sequence: 2 })] },
    ]) expect(isConversationUpdatePage({ ...page(), ...overrides })).toBe(false);
    expect(isConversationUpdatePage(page({ retainedAfter: 1 }))).toBe(false);
    expect(isConversationUpdatePage(page({ through: 3, nextCursor: { epoch: "epoch", after: 3 }, updates: [update({ sequence: 2 }), update({ sequence: 1, revision: 2 })] }))).toBe(false);
    expect(isConversationUpdatePage(page({ updates: [update(), update({ revision: 2 })] }))).toBe(false);
    const updates = Array.from({ length: CONVERSATION_UPDATE_MAX_PAGE + 1 }, (_, index) => update({ id: updateOccurrenceId(source, `id-${index}`), sequence: index + 1, occurrenceSequence: index + 1 }));
    expect(isConversationUpdatePage(page({ through: 101, nextCursor: { epoch: "epoch", after: 101 }, updates }))).toBe(false);
    expect(isConversationUpdatePage(page({ through: 100, nextCursor: { epoch: "epoch", after: 100 }, updates: updates.slice(0, 100) }))).toBe(true);
  });
});

describe("revisions preserve occurrence attention and legacy alias uniqueness", () => {
  const first = update({ legacyRunId: "legacy-run", sourceSequence: 500 });
  const correction = update({ sequence: 3, revision: 2, kind: "failed", occurredAt: now, observedAt: "2026-10-05T12:35:00Z", historical: true, runId: "run", messageId: "message", sourceSequence: 501, legacyRunId: "legacy-run" });
  const revisedPage = (updates: ConversationUpdate[]) => page({ through: 3, nextCursor: { epoch: "epoch", after: 3 }, updates });

  test("accepts ordered repeated IDs as revisions, not new occurrences or necessarily new replies", () => {
    expect(isConversationUpdatePage(revisedPage([first, correction]))).toBe(true);
    expect(correction.id).toBe(first.id);
    expect(correction.occurrenceSequence).toBe(first.occurrenceSequence);
    expect(correction.kind).not.toBe(first.kind);
    expect(isConversationUpdatePage(revisedPage([first, { ...correction, revision: 10 }]))).toBe(true);
  });

  test("rejects immutable occurrence, conversation, or source changes within repeated IDs", () => {
    for (const change of [
      { occurrenceSequence: 2 }, { conversationId: "different" },
      { source: { ...source, authorityId: "different" } },
      { source: { ...source, harness: "claude-code" as const } },
      { source: { ...source, incarnation: "new-incarnation" } },
      { revision: 1 },
    ]) expect(isConversationUpdatePage(revisedPage([first, { ...correction, ...change }]))).toBe(false);
    expect(isConversationUpdatePage(revisedPage([{ ...first, revision: 3 }, correction]))).toBe(false);
  });

  test("permits the same alias on revisions but not on distinct occurrences", () => {
    expect(isConversationUpdatePage(revisedPage([first, correction]))).toBe(true);
    const second = update({ id: updateOccurrenceId(source, "second"), nativeBoundaryId: "second", sequence: 2, occurrenceSequence: 2, legacyRunId: "legacy-run" });
    expect(isConversationUpdatePage(revisedPage([first, second]))).toBe(false);
    expect(isConversationUpdatePage(revisedPage([first, { ...second, legacyRunId: "different-run" }]))).toBe(true);
    expect(isConversationUpdatePage(revisedPage([{ ...first, legacyRunId: undefined, runId: "shared" }, { ...second, legacyRunId: undefined, runId: "shared" }]))).toBe(true);
  });

  test("rejects conflicting native boundaries, while allowing metadata enrichment", () => {
    expect(isConversationUpdatePage(revisedPage([first, { ...correction, nativeBoundaryId: "different" }]))).toBe(false);
    expect(isConversationUpdatePage(revisedPage([{ ...first, nativeBoundaryId: undefined }, correction]))).toBe(true);
    expect(isConversationUpdatePage(revisedPage([first, { ...correction, nativeBoundaryId: undefined }]))).toBe(true);
    expect(isConversationUpdatePage(revisedPage([
      { ...first, nativeBoundaryId: "native-uuid" },
      { ...correction, nativeBoundaryId: "native-uuid" },
    ]))).toBe(true);
  });

  test("retains an established native boundary across an intervening omitted field", () => {
    const middle = { ...first, sequence: 2, revision: 2, nativeBoundaryId: undefined };
    const conflicting = { ...correction, revision: 3, nativeBoundaryId: "different" };
    expect(isConversationUpdatePage(revisedPage([first, middle, conflicting]))).toBe(false);
  });
});

describe("coverage and bootstrap retain source order, not global transport order", () => {
  test("source baselines may exceed the page transport through", () => {
    const coverage = { sourceKey, state: "ready" as const, baselineThrough: 1000, through: 2000 };
    const bootstrap = { activeRunIds: ["run"], sourceBaselines: [{ sourceKey, through: 1000 }] };
    expect(isConversationUpdateCoverage(coverage)).toBe(true);
    expect(isConversationUpdateBootstrap(bootstrap)).toBe(true);
    expect(isConversationUpdatePage(page({ updates: [update({ sourceSequence: 2000 })], coverage: [coverage], bootstrap }))).toBe(true);
    expect(isConversationUpdateCoverage({ ...coverage, baselineThrough: 2001 })).toBe(false);
    expect(isConversationUpdatePage(page({ coverage: [{ sourceKey, state: "ready", baselineThrough: Number.MAX_SAFE_INTEGER }], bootstrap: { activeRunIds: [], sourceBaselines: [{ sourceKey, through: Number.MAX_SAFE_INTEGER }] } }))).toBe(true);
  });

  test("validates coverage states, canonical source keys, uniqueness, and safe source counters", () => {
    for (const state of ["ready", "initializing", "unavailable", "unqualified", "degraded"]) expect(isConversationUpdateCoverage({ sourceKey, state })).toBe(true);
    expect(isConversationUpdateCoverage({ sourceKey, state: "complete" })).toBe(false);
    for (const key of ["plain-key", JSON.stringify(["opencode", "authority", "session"]), '[ "opencode", "authority", "session", null ]', JSON.stringify(["cc", "authority", "session", null])]) {
      expect(isConversationUpdateCoverage({ sourceKey: key, state: "ready" })).toBe(false);
      expect(isConversationUpdateBootstrap({ activeRunIds: [], sourceBaselines: [{ sourceKey: key, through: 0 }] })).toBe(false);
    }
    for (const through of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isConversationUpdateCoverage({ sourceKey, state: "ready", through })).toBe(false);
      expect(isConversationUpdateCoverage({ sourceKey, state: "ready", baselineThrough: through })).toBe(false);
      expect(isConversationUpdateBootstrap({ activeRunIds: [], sourceBaselines: [{ sourceKey, through }] })).toBe(false);
    }
    expect(isConversationUpdatePage(page({ coverage: [{ sourceKey, state: "ready" }, { sourceKey, state: "degraded" }] }))).toBe(false);
    expect(isConversationUpdateBootstrap({ activeRunIds: ["run", "run"], sourceBaselines: [] })).toBe(false);
    expect(isConversationUpdateBootstrap({ activeRunIds: [], sourceBaselines: [{ sourceKey, through: 0 }, { sourceKey, through: 1 }] })).toBe(false);
  });
});
