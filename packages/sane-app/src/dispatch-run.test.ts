import { describe, expect, test } from "bun:test";
import { isNativeCommandId, newDispatchRun, newNativeCommandId, NATIVE_COMMAND_PREFIX } from "./dispatch-run";

describe("newNativeCommandId", () => {
  test("has msg_ prefix and matches validator", () => {
    const id = newNativeCommandId();
    expect(id.startsWith(NATIVE_COMMAND_PREFIX)).toBe(true);
    expect(isNativeCommandId(id)).toBe(true);
  });
  test("validator rejects bad values", () => {
    expect(isNativeCommandId("nope")).toBe(false);
    expect(isNativeCommandId("msg_")).toBe(false);
    expect(isNativeCommandId("msg_a b")).toBe(false);
    expect(isNativeCommandId(undefined)).toBe(false);
  });
});

describe("newDispatchRun", () => {
  const base = { sessionId: "s1", harness: "opencode" as const, cwd: "/tmp", model: "m", effort: "e" };
  test("opencode run gets msg_ command and preparing phase", () => {
    const { run, commandId } = newDispatchRun(base);
    expect(isNativeCommandId(commandId)).toBe(true);
    expect(run.nativeCommandId).toBe(commandId);
    expect(run.nativePhase).toBe("preparing");
    expect(run.status).toBe("running");
  });
  test("claude-code run uses runId:user command and no native phase", () => {
    const { run, commandId } = newDispatchRun({ ...base, harness: "claude-code" as const });
    expect(commandId).toBe(`${run.runId}:user`);
    expect(run.nativeCommandId).toBeUndefined();
    expect(run.nativePhase).toBeUndefined();
  });
  test("extra overrides run fields", () => {
    const { run } = newDispatchRun(base, { operation: "compact" });
    expect(run.operation).toBe("compact");
  });
});
