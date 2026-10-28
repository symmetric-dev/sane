import { describe, expect, test } from "bun:test";
import { contextUsageFor } from "../shared/conversation/context-usage";
import type { Run } from "../shared/conversation/types";
import { isNativeCommandId, newDispatchRun } from "./dispatch-run";
import { preparedAdmissionNativeCommandId } from "./prepared-admission-command";
import { WorkstreamAdapterError } from "./workstreams";

function claudeShapedRun(): Run {
  return {
    id: "run-1",
    conversationId: "sess-1",
    nativeSessionId: "sess-1",
    cwd: "/tmp",
    status: "completed",
    createdAt: "2026-10-27T00:00:00.000Z",
    observedEfforts: [],
    messages: [],
    events: [
      {
        seq: 1, time: "2026-10-27T00:00:01.000Z", runId: "run-1", sessionId: "sess-1", kind: "stdout",
        data: {
          type: "assistant", session_id: "sess-1", uuid: "11111111-1111-4111-8111-111111111111",
          message: { model: "claude-sonnet-4", usage: { input_tokens: 12, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } },
        },
      },
      {
        seq: 2, time: "2026-10-27T00:00:02.000Z", runId: "run-1", sessionId: "sess-1", kind: "stdout",
        data: { type: "result", session_id: "sess-1", modelUsage: { "claude-sonnet-4": { contextWindow: 200000 } } },
      },
    ],
    cursor: 2,
    seen: new Set([1, 2]),
    buffer: "",
    resultCount: 0,
    resultKeys: new Set(),
    toolResults: new Map(),
  };
}

describe("grok does not fall through to Claude", () => {
  test("context usage for grok is not a Claude usage snapshot", () => {
    const runs = [claudeShapedRun()];
    const claude = contextUsageFor("claude-code", runs, []);
    const grok = contextUsageFor("grok", runs, [], null, [{ id: "c", sessionId: "sess-1", harness: "grok", lifecycle: "running", contextReset: true, trigger: "manual", observedAt: "2026-10-27T00:00:03.000Z" }]);
    expect(claude).toMatchObject({ tokens: 16, model: "claude-sonnet-4", capacity: 200000 });
    expect(grok).toBeNull();
    expect(grok).not.toEqual(claude);
  });

  test("prepared admission command id refuses grok and keeps Claude and OpenCode grammar", () => {
    expect(preparedAdmissionNativeCommandId("claude-code")).toBeNull();
    expect(preparedAdmissionNativeCommandId("claude-code", "msg_not_claude")).toBeNull();
    expect(preparedAdmissionNativeCommandId("opencode", "msg_kept")).toBe("msg_kept");
    const generated = preparedAdmissionNativeCommandId("opencode");
    expect(isNativeCommandId(generated)).toBe(true);
    expect(generated?.startsWith("msg_")).toBe(true);
    expect(() => preparedAdmissionNativeCommandId("grok")).toThrow(WorkstreamAdapterError);
    expect(() => preparedAdmissionNativeCommandId("grok", "msg_nope")).toThrow(WorkstreamAdapterError);
    try {
      preparedAdmissionNativeCommandId("grok");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkstreamAdapterError);
      expect((error as WorkstreamAdapterError).code).toBe("unsupported-harness-operation");
      expect((error as WorkstreamAdapterError).status).toBe(501);
      expect((error as WorkstreamAdapterError).message).not.toMatch(/Claude/);
    }
  });

  test("dispatch run factory does not give Grok a Claude command id", () => {
    const claude = newDispatchRun({ sessionId: "s", harness: "claude-code", cwd: "/tmp" });
    expect(claude.commandId).toBe(`${claude.run.runId}:user`);
    expect(claude.run.nativeCommandId).toBeUndefined();
    const opencode = newDispatchRun({ sessionId: "s", harness: "opencode", cwd: "/tmp" });
    expect(isNativeCommandId(opencode.commandId)).toBe(true);
    expect(opencode.run.nativeCommandId).toBe(opencode.commandId);
    expect(() => newDispatchRun({ sessionId: "s", harness: "grok", cwd: "/tmp" })).toThrow(WorkstreamAdapterError);
    try {
      newDispatchRun({ sessionId: "s", harness: "grok", cwd: "/tmp" });
    } catch (error) {
      expect((error as WorkstreamAdapterError).code).toBe("unsupported-harness-operation");
      expect((error as WorkstreamAdapterError).status).toBe(501);
      expect(String(error)).not.toMatch(/:user/);
    }
  });
});
