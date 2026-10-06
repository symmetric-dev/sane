import { describe, expect, test } from "bun:test";
import {
  isPendingInputCapability, isPendingInputItem, isPendingInputRemovalRequest, isPendingInputRemovalResult,
  isPendingInputRequest, isPendingInputResumeRequest, isPendingInputSnapshot, isPendingInputSubmissionResult,
  isPendingInputTombstone,
  type PendingInputCapability, type PendingInputItem, type PendingInputSnapshot,
} from "./pending-input-contract";

const capability: PendingInputCapability = { protocol: "pending-input", version: 1, supported: true, maxWaiting: 3, removal: true, resume: true };
const item = (sequence: number, harnessId = "claude-code"): PendingInputItem => ({
  version: 1, conversationId: "conversation-1", requestId: `request-${sequence}`, itemId: `item-${sequence}`,
  sequence, text: "Same prompt every time", state: "waiting",
  source: { harnessId, conversationId: "conversation-1", authorityId: "authority-1", nativeSessionId: "native-1", cwd: "/repo" },
  configuration: { cwd: "/repo", profileId: "profile-1", model: "model-1", effort: "high", agent: "assistant" },
});
const snapshot = (items: readonly PendingInputItem[] = [item(1)]): PendingInputSnapshot => ({
  version: 1, conversationId: "conversation-1", revision: 0, paused: false, reason: null, items, tombstones: [],
});
const future = { validateHarnessId: (id: string) => id === "future-harness" };
const request = () => {
  const { itemId, sequence, state, ...input } = item(1);
  return input;
};
const removal = { version: 1, requestId: "remove-1", conversationId: "conversation-1", inputRequestId: "request-1", itemId: "item-1" };

describe("dormant pending input wire contract", () => {
  test("support requires a complete explicit protocol advertisement, not harness flags", () => {
    expect(isPendingInputCapability(capability)).toBe(true);
    for (const value of [undefined, null, {}, { prompt: true, cancelRun: true }, { ...capability, version: 2 },
      { ...capability, maxWaiting: 4 }, { ...capability, maxWaiting: "3" }, { ...capability, supported: false }]) {
      expect(isPendingInputCapability(value)).toBe(false);
    }
    for (const key of Object.keys(capability)) {
      const missing: Record<string, unknown> = { ...capability }; delete missing[key];
      expect(isPendingInputCapability(missing)).toBe(false);
    }
    for (const key of ["supported", "removal", "resume"]) {
      for (const value of [false, 1, "true", null]) expect(isPendingInputCapability({ ...capability, [key]: value })).toBe(false);
    }
  });

  test("mixed current and explicitly backend-validated future source pins", () => {
    const mixed = snapshot([item(1), item(2, "opencode"), item(3, "future-harness")]);
    expect(isPendingInputSnapshot(mixed)).toBe(false);
    expect(isPendingInputSnapshot(mixed, future)).toBe(true);
    expect(isPendingInputSnapshot(mixed, { validateHarnessId: () => false })).toBe(false);
    expect(isPendingInputSnapshot(mixed, { validateHarnessId: () => "true" as unknown as boolean })).toBe(false);
    for (const harness of ["cc", "oc", "", " opencode "]) {
      expect(isPendingInputItem(item(1, harness), { validateHarnessId: () => true })).toBe(false);
    }
    const input = request();
    expect(isPendingInputRequest(input)).toBe(true);
    expect(isPendingInputRequest({ ...input, source: { ...input.source, authorityId: null, nativeSessionId: null } })).toBe(true);
    for (const patch of [{ conversationId: "wrong" }, { cwd: "/other" }, { nativeSessionId: "" }, { authorityId: false }]) {
      expect(isPendingInputRequest({ ...input, source: { ...input.source, ...patch } })).toBe(false);
    }
    expect(isPendingInputRequest({ ...input, configuration: { ...input.configuration, model: false } })).toBe(false);
    expect(isPendingInputRequest({ ...input, text: "  " })).toBe(false);
    expect(isPendingInputRequest({ ...input, requestId: "" })).toBe(false);
    expect(isPendingInputRequest({ ...input, version: 2 })).toBe(false);
    expect(isPendingInputRequest(input, { requestId: "other" })).toBe(false);
    expect(isPendingInputRequest(input, { conversationId: "other" })).toBe(false);
  });

  test("identity and configuration tokens reject every embedded ASCII control", () => {
    const input = request(), active = item(1);
    const controls = [...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)), "\u007f"];
    for (const control of controls) {
      const bad = `before${control}after`;
      expect(isPendingInputRequest({ ...input, requestId: bad })).toBe(false);
      expect(isPendingInputRequest({ ...input, conversationId: bad, source: { ...input.source, conversationId: bad } })).toBe(false);
      expect(isPendingInputItem({ ...active, itemId: bad })).toBe(false);
      for (const key of ["authorityId", "nativeSessionId", "harnessId"]) {
        expect(isPendingInputRequest({ ...input, source: { ...input.source, [key]: bad } }, { validateHarnessId: () => true })).toBe(false);
      }
      for (const key of ["profileId", "model", "effort", "agent"]) {
        expect(isPendingInputRequest({ ...input, configuration: { ...input.configuration, [key]: bad } })).toBe(false);
      }
      expect(isPendingInputRequest({ ...input, source: { ...input.source, cwd: bad }, configuration: { ...input.configuration, cwd: bad } })).toBe(false);
      expect(isPendingInputItem({ ...active, state: "run-linked", runId: bad })).toBe(false);
      expect(isPendingInputRemovalRequest({ ...removal, inputRequestId: bad })).toBe(false);
    }
  });

  test("future native variants, internal spaces and ordinary multiline prompts remain valid", () => {
    const input = request(), conversationId = "conversation with spaces", cwd = "/repo checkout/native project";
    const valid = {
      ...input, requestId: "request with spaces", conversationId, text: "First line\nSecond line\r\n\tIndented prompt",
      source: { ...input.source, harnessId: "future-harness", conversationId, authorityId: "native authority", nativeSessionId: "native session", cwd },
      configuration: { cwd, profileId: "native profile", model: "Provider / Model Name v2", effort: "native balanced variant / v2", agent: "native agent name" },
    };
    expect(isPendingInputRequest(valid, future)).toBe(true);
    expect(isPendingInputItem({ ...valid, itemId: "item with spaces", sequence: 1, state: "waiting" }, future)).toBe(true);
  });

  test("repeated text remains distinct; only WAITING consumes the three slots", () => {
    const active: PendingInputItem[] = [item(1), item(2), item(3), { ...item(4), state: "claimed" },
      { ...item(5), state: "claimed", runId: "run-5" }, { ...item(6), state: "run-linked", runId: "run-6" }];
    expect(isPendingInputSnapshot(snapshot(active))).toBe(true);
    expect(isPendingInputSnapshot(snapshot([...active, item(7)]))).toBe(false);
    const tombstones = Array.from({ length: 8 }, (_, index) => ({
      conversationId: "conversation-1", requestId: `removed-request-${index}`, itemId: `removed-item-${index}`, sequence: index + 7, state: "removed" as const,
    }));
    expect(isPendingInputSnapshot({ ...snapshot(active), tombstones })).toBe(true);
    expect(isPendingInputTombstone(tombstones[0])).toBe(true);
    expect(isPendingInputSnapshot({ ...snapshot(), items: [tombstones[0]] })).toBe(false);
  });

  test("invalid associations, duplicate identities, noncanonical order and unsafe revisions fail", () => {
    for (const items of [[item(2), item(1)], [item(1), item(1)], [item(1), { ...item(2), requestId: "request-1" }],
      [item(1), { ...item(2), itemId: "item-1" }], [item(1), { ...item(2), conversationId: "other" }],
      [item(1), { ...item(2), sequence: 1 }]]) expect(isPendingInputSnapshot(snapshot(items))).toBe(false);
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1"]) {
      expect(isPendingInputSnapshot({ ...snapshot(), revision: value })).toBe(false);
      expect(isPendingInputItem({ ...item(1), sequence: value })).toBe(false);
    }
    expect(isPendingInputItem({ ...item(1), sequence: 0 })).toBe(false);
    expect(isPendingInputSnapshot({ ...snapshot(), revision: Number.MAX_SAFE_INTEGER })).toBe(true);
    const tombstone = { conversationId: "conversation-1", requestId: "request-1", itemId: "item-1", sequence: 1, state: "removed" };
    expect(isPendingInputSnapshot({ ...snapshot(), tombstones: [tombstone] })).toBe(false);
    expect(isPendingInputTombstone({ ...tombstone, conversationId: "other" }, { conversationId: "conversation-1" })).toBe(false);
    expect(isPendingInputSnapshot({ ...snapshot([]), tombstones: [tombstone, { ...tombstone, itemId: "other", requestId: "other", sequence: 0 }] })).toBe(false);
    const later = { ...tombstone, itemId: "item-2", requestId: "request-2", sequence: 2 };
    expect(isPendingInputSnapshot({ ...snapshot([]), tombstones: [later, tombstone] })).toBe(false);
    for (const patch of [{ itemId: "item-1" }, { requestId: "request-1" }, { sequence: 1 }, { conversationId: "other" }]) {
      expect(isPendingInputSnapshot({ ...snapshot(), tombstones: [{ ...later, ...patch }] })).toBe(false);
    }
    expect(isPendingInputSnapshot(snapshot(), { conversationId: "other" })).toBe(false);
  });

  test("states, pause booleans and run linkage are strict", () => {
    for (const state of ["queued", "running", "removed", "accepted", null]) expect(isPendingInputItem({ ...item(1), state })).toBe(false);
    expect(isPendingInputItem({ ...item(1), runId: "run-1" })).toBe(false);
    expect(isPendingInputItem({ ...item(1), state: "run-linked" })).toBe(false);
    expect(isPendingInputItem({ ...item(1), state: "claimed", runId: null })).toBe(false);
    expect(isPendingInputSnapshot(snapshot([{ ...item(1), state: "run-linked", runId: "run" }, { ...item(2), state: "claimed", runId: "run" }]))).toBe(false);
    expect(isPendingInputSnapshot({ ...snapshot(), paused: true, reason: "reconciliation required" })).toBe(true);
    for (const patch of [{ paused: 1 }, { paused: "false" }, { paused: undefined }, { paused: true, reason: null },
      { paused: true, reason: " " }, { paused: false, reason: "blocked" }]) expect(isPendingInputSnapshot({ ...snapshot(), ...patch })).toBe(false);
  });

  test("queue receipt, App run admission and uncertainty cannot imply native acceptance", () => {
    const base = { version: 1, conversationId: "conversation-1", requestId: "request-1" };
    const receipt = { ...base, outcome: "enqueued", itemId: "item-1", sequence: 1, revision: 0 };
    const admitted = { ...base, outcome: "run-admitted", runId: "run-1" };
    const uncertain = { ...base, outcome: "uncertain", reason: "response lost", itemId: "item-1" };
    for (const result of [receipt, admitted, uncertain]) {
      expect(isPendingInputSubmissionResult(result)).toBe(true);
      expect(isPendingInputSubmissionResult({ ...result, accepted: true })).toBe(false);
      expect(isPendingInputSubmissionResult({ ...result, nativeAcceptance: "accepted" })).toBe(false);
      expect(isPendingInputSubmissionResult(result, { requestId: "other" })).toBe(false);
    }
    expect(isPendingInputSubmissionResult({ ...receipt, runId: "run-1" })).toBe(false);
    expect(isPendingInputSubmissionResult({ ...admitted, runId: undefined })).toBe(false);
    expect(isPendingInputSubmissionResult({ ...uncertain, reason: "" })).toBe(false);
    expect(isPendingInputSubmissionResult({ ...receipt, outcome: "accepted" })).toBe(false);
    expect(isPendingInputSubmissionResult(receipt, { itemId: "other" })).toBe(false);
  });

  test("removal is identity-bound and claimed may report a run but is not removed", () => {
    expect(isPendingInputRemovalRequest(removal)).toBe(true);
    for (const outcome of ["removed", "already-removed", "claimed"]) {
      const result = { ...removal, revision: 2, outcome };
      expect(isPendingInputRemovalResult(result)).toBe(true);
      expect(isPendingInputRemovalResult({ ...result, runId: "run-1" })).toBe(outcome === "claimed");
      expect(isPendingInputRemovalResult(result, { inputRequestId: "other" })).toBe(false);
      expect(isPendingInputRemovalResult(result, { itemId: "other" })).toBe(false);
    }
    expect(isPendingInputRemovalResult({ ...removal, revision: 2, outcome: "cancelled" })).toBe(false);
    expect(isPendingInputRemovalResult({ ...removal, revision: -1, outcome: "removed" })).toBe(false);
    expect(isPendingInputRemovalRequest({ ...removal, inputRequestId: "" })).toBe(false);
  });

  test("resume is an explicit revision-bound unpause, never a retry", () => {
    const resume = { version: 1, conversationId: "conversation-1", requestId: "resume-1", action: "resume", expectedRevision: 4 };
    expect(isPendingInputResumeRequest(resume)).toBe(true);
    for (const patch of [{ action: "retry" }, { retry: true }, { recreate: true }, { expectedRevision: -1 },
      { expectedRevision: undefined }, { requestId: "" }]) expect(isPendingInputResumeRequest({ ...resume, ...patch })).toBe(false);
    expect(isPendingInputResumeRequest(resume, { conversationId: "other" })).toBe(false);
  });
});
