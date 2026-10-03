import { expect, test } from "bun:test";
import type { TranscriptMessage, TranscriptPage, TranscriptRefresh, TranscriptRunMetadata } from "../src/transcript-contract";
import { createRun } from "./cc-reducer";
import { canonicalCount, equalValue, mergePage, pageMessages, pagedUsage, refreshPages, sameRunMetadata, TranscriptCoverageError, turnBoundaryKnown } from "./transcript-pages";

const message = (index: number, patch: Partial<TranscriptMessage> = {}): TranscriptMessage => ({ id: `m${index}`, version: `v${index}`, runId: "R", role: "assistant", parts: [{ type: "text", text: `message ${index}` }], time: "", status: "completed", ...patch });
const page = (start: number, end: number, total = 10, patch: Partial<TranscriptPage> = {}): TranscriptPage => ({
  sessionId: "A", revision: "r1", epoch: "e1", usage: null,
  messages: Array.from({ length: end - start + 1 }, (_, index) => message(start + index)),
  coverage: { firstId: `m${start}`, lastId: `m${end}`, firstIndex: start, lastIndex: end, totalMessages: total, olderCursor: start ? `older-${start}` : null, newerCursor: end < total - 1 ? `newer-${end}` : null },
  continuation: { older: false, newer: false }, ...patch,
});
const refresh = (patch: Partial<TranscriptRefresh> = {}): TranscriptRefresh => ({ sessionId: "A", epoch: "e1", revision: "r2", usage: null, processed: 0, removedIds: [], upserts: [], ...patch });

test("target and latest islands remain separate, canonically ordered, until adjacent coverage fills the gap", () => {
  const tail = mergePage(null, page(8, 9));
  const targeted = mergePage(tail, page(1, 2, 10, { target: { messageId: "m1" } }), undefined, false, true);
  expect(targeted.islands.map(island => island.messages.map(message => message.id))).toEqual([["m1", "m2"], ["m8", "m9"]]);
  expect(targeted.islands[0]!.scope).toBe("target");
  expect(canonicalCount(targeted)).toBe(10);
  const filled = mergePage(targeted, page(3, 7), { island: "m1", direction: "newer" });
  expect(filled.islands).toHaveLength(1);
  expect(filled.islands[0]!.key).toBe("m1");
  expect(pageMessages(filled).map(message => message.id)).toEqual(Array.from({ length: 9 }, (_, index) => `m${index + 1}`));
  expect(filled.islands[0]!.coverage).toMatchObject({ firstIndex: 1, lastIndex: 9, olderCursor: "older-1", newerCursor: null });
});

test("overlap merges by canonical ordinal, not timestamps, and retains same-version objects", () => {
  const first = page(2, 4), old = mergePage(null, first), incoming = page(4, 6);
  incoming.messages.forEach(message => { message.time = "older-clock"; });
  const merged = mergePage(old, incoming);
  expect(merged.islands).toHaveLength(1);
  expect(pageMessages(merged).map(message => message.id)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
  expect(pageMessages(merged)[2]).toBe(first.messages[2]);
  expect(merged.islands[0]!.coverage).toMatchObject({ firstIndex: 2, lastIndex: 6 });
});

test("invalid canonical ranges and anchor identities fail before merging", () => {
  const valid = page(1, 2);
  for (const coverage of [
    { ...valid.coverage, totalMessages: -1 }, { ...valid.coverage, firstIndex: 1.5 }, { ...valid.coverage, lastIndex: 3 },
    { ...valid.coverage, totalMessages: 2 }, { ...valid.coverage, firstId: "wrong" }, { ...valid.coverage, lastId: null },
  ]) expect(() => mergePage(null, { ...valid, coverage })).toThrow(TranscriptCoverageError);
  expect(() => mergePage(null, { ...valid, messages: [] })).toThrow(TranscriptCoverageError);
});

test("both contained and extending overlaps reject different message identities at the same ordinal", () => {
  const previous = mergePage(null, page(2, 5));
  for (const incoming of [page(3, 4), page(5, 7)]) {
    incoming.messages[0] = { ...incoming.messages[0]!, id: "different" };
    incoming.coverage.firstId = "different";
    expect(() => mergePage(previous, incoming)).toThrow("Transcript range identity mismatch.");
  }
  expect(pageMessages(previous).map(message => message.id)).toEqual(["m2", "m3", "m4", "m5"]);
});

test("receipt protection fences delayed versions and contained same-version pages reuse the entire message array", () => {
  const original = page(2, 5), previous = mergePage(null, original), same = mergePage(previous, page(3, 4));
  expect(same.islands[0]!.messages).toBe(previous.islands[0]!.messages);
  const delayed = page(3, 4, 10, { revision: "old", usage: { tokens: 1, model: "model", time: "old" } });
  delayed.messages[0] = message(3, { version: "delayed", parts: [{ type: "text", text: "old payload" }] });
  delayed.messages[1] = message(4, { version: "updated" });
  const merged = mergePage(previous, delayed, undefined, false, true, new Set(["m3"]));
  expect(merged.summary).toBe(previous.summary);
  expect(pageMessages(merged)[1]).toBe(original.messages[1]);
  expect(pageMessages(merged)[2]).toBe(delayed.messages[1]);
  expect(merged.islands[0]!.messages).not.toBe(previous.islands[0]!.messages);
  expect(pageMessages(previous)[2]).toBe(original.messages[2]);
});

test("independent equal-edge reads retain established cursors and summary, while actual extension supplies its new edge", () => {
  const previous = mergePage(null, page(3, 5));
  const delayed = page(3, 5, 10, { revision: "delayed" });
  delayed.coverage.olderCursor = "stale-older"; delayed.coverage.newerCursor = "stale-newer";
  delayed.continuation.newer = true;
  const contained = mergePage(previous, delayed, undefined, false, true);
  expect(contained.summary).toBe(previous.summary);
  expect(contained.islands[0]!.coverage).toMatchObject({ olderCursor: "older-3", newerCursor: "newer-5" });
  expect(contained.islands[0]!.observedEndBoundary).toBe(true);
  const extended = mergePage(contained, page(5, 7, 10, { revision: "later" }), undefined, false, true);
  expect(extended.islands[0]!.coverage.newerCursor).toBe("newer-7");
  expect(extended.islands[0]!.endRevision).toBe("later");
  expect(extended.summary).toBe(previous.summary);
});

test("unchanged latest polling reuses the complete state and changed epoch/session drops old coverage and metadata", () => {
  const latest = page(5, 9), previous = mergePage(null, latest);
  previous.metadataRevision = "meta1";
  previous.compactions = [{ id: "compact1", sessionId: "A", harness: "opencode", trigger: "manual", lifecycle: "completed", contextReset: true, placement: { kind: "before-message", messageId: "m5" } }];
  previous.target = { messageId: "m5" };
  expect(previous.compactions).toHaveLength(1);
  expect(mergePage(previous, page(7, 9), undefined, true)).toBe(previous);
  for (const patch of [{ epoch: "e2" }, { sessionId: "B" }]) {
    const reset = mergePage(previous, page(0, 1, 2, patch));
    expect(pageMessages(reset).map(message => message.id)).toEqual(["m0", "m1"]);
    expect(reset.metadataRevision).toBeUndefined();
    expect(reset.compactions).toEqual([]);
    expect(reset.target).toBeUndefined();
  }
  const empty: TranscriptPage = { ...latest, epoch: "empty", messages: [], coverage: { firstId: null, lastId: null, firstIndex: null, lastIndex: null, totalMessages: 0, olderCursor: null, newerCursor: null } };
  expect(pageMessages(mergePage(previous, empty))).toEqual([]);
  expect(previous.compactions).toHaveLength(1);
});

test("refresh updates loaded islands only, preserves protected/same-version objects, and never mutates previous state", () => {
  const left = mergePage(null, page(1, 2)), previous = mergePage(left, page(8, 9));
  const updated = message(8, { version: "new", parts: [{ type: "text", text: "updated tool/text payload" }] });
  const next = refreshPages(previous, refresh({ upserts: [message(1), message(2, { version: "old" }), updated, message(4, { version: "unloaded" })] }), new Set(["m2"]), true);
  expect(next.summary).toBe(previous.summary);
  expect(next.islands[0]).toBe(previous.islands[0]);
  expect(next.islands[1]).not.toBe(previous.islands[1]);
  expect(pageMessages(next)[2]).toBe(updated);
  expect(pageMessages(next)[3]).toBe(pageMessages(previous)[3]);
  expect(pageMessages(next).map(message => message.id)).toEqual(["m1", "m2", "m8", "m9"]);
  expect(pageMessages(previous)[2]!.version).toBe("v8");
  const unchanged = refreshPages(previous, refresh());
  expect(unchanged.islands).toBe(previous.islands);
  expect(unchanged.summary.revision).toBe("r2");
});

test("refresh removal is a coverage error even for an unloaded ID; refresh itself currently trusts caller epoch validation", () => {
  const previous = mergePage(null, page(1, 2));
  expect(() => refreshPages(previous, refresh({ removedIds: ["unloaded"] }))).toThrow(TranscriptCoverageError);
  // Epoch admission belongs to the caller today, unlike mergePage's reset logic.
  const foreign = refreshPages(previous, refresh({ epoch: "foreign-epoch" }));
  expect(foreign.summary.epoch).toBe("foreign-epoch");
  expect(foreign.islands).toBe(previous.islands);
});

test("tail boundary observations expire after growth but non-tail boundaries and observed new turns remain valid", () => {
  const previous = mergePage(null, page(8, 9));
  expect(turnBoundaryKnown(previous, previous.islands[0]!, pageMessages(previous)[0]!)).toBe(true);
  const grown = mergePage(previous, page(11, 12, 13, { revision: "r2" }));
  expect(turnBoundaryKnown(grown, grown.islands[0]!, pageMessages(grown)[0]!)).toBe(false);
  const nonTail = mergePage(null, page(2, 3));
  const later = mergePage(nonTail, page(8, 9, 12, { revision: "r2" }));
  expect(turnBoundaryKnown(later, later.islands[0]!, pageMessages(later)[0]!)).toBe(true);
  const withUser = page(1, 2, 4, { continuation: { older: false, newer: true } });
  withUser.messages[1]!.role = "user";
  const turn = mergePage(null, withUser);
  expect(turnBoundaryKnown(turn, turn.islands[0]!, pageMessages(turn)[0]!)).toBe(true);
});

test("sameRunMetadata compares nested compact values structurally and distinguishes absent from explicit undefined", () => {
  const metadata: TranscriptRunMetadata = { id: "R", conversationId: "A", cwd: "/fixture", status: "completed", createdAt: "recorded", operation: "compact", compact: { requestId: "request", nativeRequestId: "msg_request", nativeAdmittedId: "msg_admitted" } };
  const previous = createRun(metadata);
  const equal: TranscriptRunMetadata = { ...metadata, compact: { nativeAdmittedId: "msg_admitted", nativeRequestId: "msg_request", requestId: "request" } };
  expect(equal.compact).not.toBe(previous.compact);
  expect(sameRunMetadata(previous, equal)).toBe(true);
  expect(sameRunMetadata(previous, { ...equal, compact: { ...equal.compact!, nativeAdmittedId: "msg_changed" } })).toBe(false);
  expect(sameRunMetadata(previous, { ...equal, nativeReason: undefined })).toBe(false);
  const warningUnset: TranscriptRunMetadata = { ...metadata, nativeReason: undefined };
  expect(sameRunMetadata(createRun(warningUnset), equal)).toBe(false);
  expect(sameRunMetadata(createRun(warningUnset), { ...equal, nativeReason: undefined })).toBe(true);
  const absentNested = { ...metadata, compact: { requestId: "request" } };
  const undefinedNested = { ...metadata, compact: { requestId: "request", nativeRequestId: undefined } };
  expect(sameRunMetadata(createRun(absentNested), undefinedNested)).toBe(false);
  expect(sameRunMetadata(createRun(undefinedNested), absentNested)).toBe(false);
  expect(sameRunMetadata(createRun(undefinedNested), { ...undefinedNested, compact: { ...undefinedNested.compact } })).toBe(true);
});

test("equalValue compares nested compact objects and arrays without ignoring own undefined-valued properties", () => {
  const left = { compact: { requestId: "request", nested: { records: [{ id: "first", state: "completed" }, { id: "second", state: "running" }] } } };
  const equal = { compact: { nested: { records: [{ state: "completed", id: "first" }, { state: "running", id: "second" }] }, requestId: "request" } };
  expect(equalValue(left, equal)).toBe(true);
  expect(equalValue(left, { compact: { ...equal.compact, nested: { records: [{ id: "first", state: "failed" }, equal.compact.nested.records[1]!] } } })).toBe(false);
  expect(equalValue({ compact: { requestId: "request" } }, { compact: { requestId: "request", nativeRequestId: undefined } })).toBe(false);
  expect(equalValue({ compact: { requestId: "request", nativeRequestId: undefined } }, { compact: { requestId: "request" } })).toBe(false);
  expect(equalValue({ compact: { nativeRequestId: undefined } }, { compact: { nativeRequestId: undefined } })).toBe(true);
  expect(equalValue(undefined, undefined)).toBe(true);
  expect(equalValue(left.compact.nested.records, { 0: left.compact.nested.records[0], 1: left.compact.nested.records[1] })).toBe(false);
});

test("paged usage resolves OC capacity only from exact catalog evidence and CC only from authoritative usage", () => {
  const pages = mergePage(null, page(0, 0, 1, { usage: { tokens: 30, model: "provider/model", time: "reported", capacity: 999, stale: true } }));
  expect(pagedUsage(pages, "opencode", [])).toBeNull();
  expect(pagedUsage(pages, "opencode", [{ id: "other", name: "Other", efforts: [], contextWindow: 100 }])).toBeNull();
  for (const contextWindow of [0, -1, NaN, Infinity]) expect(pagedUsage(pages, "opencode", [{ id: "provider/model", name: "Model", efforts: [], contextWindow }])).toBeNull();
  expect(pagedUsage(pages, "opencode", [{ id: "provider/model", name: "Model", efforts: [], contextWindow: 100 }])).toEqual({ tokens: 30, model: "provider/model", time: "reported", capacity: 100, percentage: 30, stale: true });
  expect(pagedUsage(pages, "claude-code", [])!.capacity).toBe(999);
  pages.summary.usage = { tokens: 30, model: "provider/model", time: "reported" };
  expect(pagedUsage(pages, "claude-code", [{ id: "provider/model", name: "Model", efforts: [], contextWindow: 100 }])).toBeNull();
  expect(pagedUsage(null, "opencode", [])).toBeNull();
});
