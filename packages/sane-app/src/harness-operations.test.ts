import { describe, expect, test } from "bun:test";
import { HARNESS_DESCRIPTORS, type HarnessOperation } from "../shared/conversation/harness-capabilities";
import { HarnessOperationError, dispatchHarness, dispatchOwnedOperation, requireOperation, requireOwnedOperation, validateHarness } from "./harness-operations";

const operations = Object.keys(HARNESS_DESCRIPTORS.opencode.operations) as HarnessOperation[];
const unknowns: unknown[] = [undefined, null, "", "gemini", "cc", "oc", "OpenCode", 0, false, {}, ["opencode"]];
const callbacks = (calls: string[]) => ({
  "claude-code": () => { calls.push("cc"); return { messages: ["cc"] }; },
  opencode: () => { calls.push("oc"); return { messages: ["oc"], rawMessages: [{ id: "native" }], activity: "idle" as const }; },
});
const session = (harness: unknown) => ({ sessionId: "conversation", harness });
const owner = (native?: boolean, sessionId = "conversation") => ({ native, run: { sessionId } });

describe("strict backend harness dispatch", () => {
  test("unknown and null never select a native callback or implicit default", () => {
    const calls: string[] = [];
    for (const value of unknowns) {
      expect(() => validateHarness(value)).toThrow("Unknown harness");
      expect(() => dispatchHarness(value, callbacks(calls))).toThrow("Unknown harness");
      for (const operation of operations) expect(() => requireOperation(value, operation)).toThrow("Unknown harness");
    }
    expect(calls).toEqual([]);
  });

  test("only an explicit caller default accepts undefined, not null or unknown", () => {
    for (const defaultHarness of ["claude-code", "opencode"] as const) {
      expect(validateHarness(undefined, { defaultHarness })).toBe(defaultHarness);
      expect(validateHarness("opencode", { defaultHarness })).toBe("opencode");
      for (const value of unknowns.filter(value => value !== undefined)) expect(() => validateHarness(value, { defaultHarness })).toThrow("Unknown harness");
    }
    // Defaults do not leak into operation checks or a later dispatch call.
    validateHarness(undefined, { defaultHarness: "claude-code" });
    expect(() => requireOperation(undefined, "prompt")).toThrow("Unknown harness");
  });

  test("dispatch selects exactly the named callback and retains rich native results", () => {
    const calls: string[] = [];
    const cc = dispatchHarness("claude-code", callbacks(calls));
    const oc = dispatchHarness("opencode", callbacks(calls));
    expect(cc).toEqual({ messages: ["cc"] });
    expect(oc).toEqual({ messages: ["oc"], rawMessages: [{ id: "native" }], activity: "idle" });
    expect(calls).toEqual(["cc", "oc"]);
    // Compile-time inference includes both native return shapes, without any.
    const inferred: { messages: string[] } | { messages: string[]; rawMessages: { id: string }[]; activity: "idle" } = oc;
    expect(inferred.messages).toEqual(["oc"]);
  });

  test("async callbacks preserve promises and do not execute the other harness", async () => {
    const calls: string[] = [];
    const result: Promise<number> | Promise<string> = dispatchHarness("opencode", {
      "claude-code": async () => { calls.push("cc"); return 1; },
      opencode: async () => { calls.push("oc"); return "native"; },
    });
    expect(await result).toBe("native"); expect(calls).toEqual(["oc"]);
  });

  for (const harness of ["claude-code", "opencode"] as const) {
    for (const operation of operations) {
      test(`${harness} ${operation} follows static operation support, not runtime availability`, () => {
        const expected = HARNESS_DESCRIPTORS[harness].operations[operation];
        if (expected.supported) expect(requireOperation(harness, operation)).toBe(HARNESS_DESCRIPTORS[harness]);
        else {
          try { requireOperation(harness, operation); throw new Error("unsupported operation admitted"); }
          catch (error) { expect(error).toBeInstanceOf(HarnessOperationError); expect(error).toMatchObject({ status: 501, code: "unsupported-harness-operation", message: expected.reason }); }
        }
      });
    }
  }

  test("owned prompt/compact dispatch uses session harness and validates private transport state", () => {
    for (const operation of ["prompt", "compact", "cancelOwnedRun"] as const) {
      for (const harness of ["claude-code", "opencode"] as const) {
        const calls: string[] = [];
        dispatchOwnedOperation(session(harness), owner(harness === "opencode"), operation, callbacks(calls));
        expect(calls).toEqual([harness === "opencode" ? "oc" : "cc"]);
      }
    }
  });

  test("unknown owner session, mismatched harness or conversation cannot call any native API", () => {
    const calls: string[] = [];
    for (const operation of ["prompt", "compact", "cancelOwnedRun"] as const) {
      for (const value of unknowns) expect(() => dispatchOwnedOperation(session(value), owner(false), operation, callbacks(calls))).toThrow("Unknown harness");
      for (const harness of ["claude-code", "opencode"] as const) {
        for (const invalid of [owner(harness !== "opencode"), owner(undefined), owner(harness === "opencode", "different")]) {
          expect(() => dispatchOwnedOperation(session(harness), invalid, operation, callbacks(calls))).toThrow("Run owner harness or conversation differs");
          expect(() => requireOwnedOperation(session(harness), invalid, operation)).toThrow("Run owner harness or conversation differs");
        }
      }
    }
    expect(calls).toEqual([]);
  });

  test("unsupported owned operation is rejected before even matching native callbacks", () => {
    const calls: string[] = [];
    for (const operation of ["listInteractions", "permissionReply", "questionReply", "listModels", "recoverRun"] as const) {
      expect(() => dispatchOwnedOperation(session("claude-code"), owner(false), operation, callbacks(calls))).toThrow(HarnessOperationError);
    }
    expect(calls).toEqual([]);
    expect(requireOperation("opencode", "recoverRun").operations.recoverRun.supported).toBe(true);
  });
});
