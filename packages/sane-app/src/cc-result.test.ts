import { expect, test } from "bun:test";
import {
  CLAUDE_RESULT_TEXT_LIMIT, claudeResultBoundaryId, claudeResultMessageId,
  consumeClaudeResultRecord, createClaudeResultSequenceState, parseClaudeResult,
} from "../shared/conversation/cc-result";

const nativeId = "native-A";
const success = (patch: Record<string, unknown> = {}) => ({
  type: "result", session_id: nativeId, subtype: "success", is_error: false, result: "reply", ...patch,
});

test("indexed SDK results permit index gaps, receipt order, and missing UUIDs", () => {
  const state = createClaudeResultSequenceState();
  for (const index of [2, 9, 4]) {
    const observation = consumeClaudeResultRecord(state, success({ result_index: index }), nativeId);
    expect(observation.eligible).toBe(true);
    expect(observation.result).toMatchObject({ indexed: true, index, invalidIndex: false, exactSession: true });
    expect(claudeResultBoundaryId("R", observation.result!, 10)).toBe(`cc-result:R:index:${index}`);
    expect(claudeResultMessageId("R", observation.result!, 10)).toBe(`R:result:index:${index}`);
  }
  expect(state.indices).toEqual([2, 9, 4]);
  expect(state.error).toBe(false);
});

for (const [label, index] of [
  ["negative", -1], ["fraction", 1.5], ["string", "0"], ["null", null],
  ["unsafe", Number.MAX_SAFE_INTEGER + 1], ["NaN", NaN], ["infinite", Infinity],
] as const) test(`invalid ${label} index rejects this and later useful results`, () => {
  const state = createClaudeResultSequenceState();
  const parsed = parseClaudeResult(success({ result_index: index }), nativeId)!;
  expect(parsed.invalidIndex).toBe(true);
  expect(parsed.indexed).toBe(false);
  expect(consumeClaudeResultRecord(state, parsed.record, nativeId).eligible).toBe(false);
  expect(consumeClaudeResultRecord(state, success({ result_index: 8 }), nativeId).eligible).toBe(false);
  expect(state.integrityRejected).toBe(true);
  expect(state.failureCauses).toContain("invalid-index");
});

for (const [label, first, second] of [
  ["reused index with different UUID and text", success({ result_index: 0, uuid: "one" }), success({ result_index: 0, uuid: "two", result: "different" })],
  ["duplicate legacy", success({ uuid: "one" }), success({ uuid: "one" })],
  ["legacy then indexed", success(), success({ result_index: 1 })],
  ["indexed then legacy", success({ result_index: 1 }), success()],
] as const) test(`${label} is a sticky integrity rejection`, () => {
  const state = createClaudeResultSequenceState();
  expect(consumeClaudeResultRecord(state, first, nativeId).eligible).toBe(true);
  expect(consumeClaudeResultRecord(state, second, nativeId).eligible).toBe(false);
  expect(consumeClaudeResultRecord(state, success({ result_index: 12 }), nativeId).eligible).toBe(false);
  expect(state.failureCauses).toContain("duplicate");
  expect(state.integrityRejected).toBe(true);
});

for (const patch of [
  { parent_tool_use_id: "tool" }, { parent_agent_id: "agent" }, { agent_id: "agent" },
  { subagent_type: "worker" }, { isSidechain: true }, { hook_event_name: "SubagentStop" },
]) test(`child/lifecycle result ${JSON.stringify(patch)} does not contaminate the root sequence`, () => {
  const state = createClaudeResultSequenceState();
  const initial = structuredClone(state);
  const child = success({ ...patch, session_id: "foreign", result_index: -1, is_error: true });
  expect(parseClaudeResult(child, nativeId)).toBeUndefined();
  expect(consumeClaudeResultRecord(state, child, nativeId)).toEqual({ eligible: false, frameworkRejected: false });
  expect(state).toEqual(initial);
  expect(consumeClaudeResultRecord(state, success({ result_index: 0, parent_tool_use_id: null, isSidechain: false }), nativeId).eligible).toBe(true);
});

for (const session_id of [undefined, "foreign", "native-a", null]) test(`result session must match exactly: ${session_id}`, () => {
  const state = createClaudeResultSequenceState();
  expect(consumeClaudeResultRecord(state, success({ session_id, result_index: 0 }), nativeId).eligible).toBe(false);
  expect(consumeClaudeResultRecord(state, success({ result_index: 1 }), nativeId).eligible).toBe(false);
  expect(state.failureCauses).toContain("identity");
  expect(state.integrityRejected).toBe(true);
});

test("wrong root init identity rejects subsequent valid results", () => {
  const state = createClaudeResultSequenceState();
  consumeClaudeResultRecord(state, { type: "system", subtype: "init", session_id: "foreign" }, nativeId);
  expect(consumeClaudeResultRecord(state, success({ result_index: 0 }), nativeId).eligible).toBe(false);
  expect(state.diagnostic).toBe("CLI session identity mismatch or missing session_id");
});

test("explicit native failure preserves bounded diagnostics but permits a later useful indexed reply", () => {
  const state = createClaudeResultSequenceState();
  const error = success({ result_index: 0, subtype: "error_max_turns", is_error: true, result: "x".repeat(3000), api_error_status: 429, permission_denials: ["Read"] });
  expect(consumeClaudeResultRecord(state, error, nativeId).eligible).toBe(false);
  expect(state.failure).toEqual({ resultSubtype: "error_max_turns", isError: true, result: "x".repeat(CLAUDE_RESULT_TEXT_LIMIT), apiErrorStatus: 429, permissionDenials: ["Read"] });
  expect(consumeClaudeResultRecord(state, success({ result_index: 3 }), nativeId).eligible).toBe(true);
  expect(state.error).toBe(true);
  expect(state.integrityRejected).toBe(false);
});

for (const patch of [{ is_error: undefined }, { subtype: undefined }, { is_error: "false" }, { subtype: "error", is_error: false }])
  test(`result requires explicit native success: ${JSON.stringify(patch)}`, () => {
    const state = createClaudeResultSequenceState();
    expect(consumeClaudeResultRecord(state, success(patch), nativeId).eligible).toBe(false);
    expect(state.failureCauses).toEqual(["native-failure"]);
  });

test("result targets use indexed or legacy identity and ignore arbitrary alias-like fields", () => {
  const legacy = parseClaudeResult(success({ uuid: "legacy" }), nativeId)!;
  expect(claudeResultBoundaryId("R", legacy, 7)).toBe("cc-result:R:legacy:legacy");
  expect(claudeResultMessageId("R", legacy, 7)).toBe("R:result:legacy:legacy");
  const noUuid = parseClaudeResult(success(), nativeId)!;
  expect(claudeResultBoundaryId("R", noUuid, 7)).toBe("cc-result:R:legacy:seq:7");
  expect(claudeResultMessageId("R", noUuid, 7)).toBe("R:result:legacy:seq:7");
  for (const aliases of [{ message_id: "answer" }, { assistant_message_id: "answer" }, { message: { id: "answer" } }]) {
    const result = parseClaudeResult(success({ result_index: 0, ...aliases }), nativeId)!;
    expect(claudeResultMessageId("R", result, 7)).toBe("R:result:index:0");
    expect(claudeResultBoundaryId("R", result, 7)).toBe("cc-result:R:index:0");
    const legacyResult = parseClaudeResult(success({ uuid: "legacy", ...aliases }), nativeId)!;
    expect(claudeResultMessageId("R", legacyResult, 7)).toBe("R:result:legacy:legacy");
    expect(claudeResultBoundaryId("R", legacyResult, 7)).toBe("cc-result:R:legacy:legacy");
  }
});

test("framework hook must deliver the exact required context before init; rejection is sticky", () => {
  const hook = (text: string, outcome = "success") => ({ type: "system", subtype: "hook_response", hook_event: "SessionStart", outcome,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }), exit_code: 1, stderr: "hook failed" });
  const required = "framework\n\nassignment";
  const state = createClaudeResultSequenceState();
  state.framework = { text: required, delivered: false, rejected: false, failures: [] };
  consumeClaudeResultRecord(state, hook(required, "error"), nativeId);
  consumeClaudeResultRecord(state, hook("wrong"), nativeId);
  expect(state.framework.delivered).toBe(false);
  expect(state.framework.failures).toEqual([{ outcome: "error", exitCode: 1, stderr: "hook failed" }]);
  expect(consumeClaudeResultRecord(state, { type: "system", subtype: "init", session_id: nativeId }, nativeId).frameworkRejected).toBe(true);
  consumeClaudeResultRecord(state, hook(required), nativeId);
  expect(consumeClaudeResultRecord(state, success({ result_index: 0 }), nativeId).eligible).toBe(false);
  expect(state.framework.rejected).toBe(true);
  const delivered = createClaudeResultSequenceState();
  delivered.framework = { text: required, delivered: false, rejected: false, failures: [] };
  consumeClaudeResultRecord(delivered, hook(required), nativeId);
  expect(consumeClaudeResultRecord(delivered, { type: "system", subtype: "init", session_id: nativeId }, nativeId).frameworkRejected).toBe(false);
  expect(consumeClaudeResultRecord(delivered, success({ result_index: 4 }), nativeId).eligible).toBe(true);
});

test("required framework without delivered hook cannot qualify a result even when native init is missing", () => {
  const state = createClaudeResultSequenceState();
  state.framework = { text: "framework", delivered: false, rejected: false, failures: [] };
  expect(consumeClaudeResultRecord(state, success({ result_index: 0 }), nativeId).eligible).toBe(false);
});
