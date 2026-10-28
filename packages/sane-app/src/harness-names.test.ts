import { describe, expect, test } from "bun:test";
import { isNativeHarness, toNativeHarness, toSessionHarness } from "./harness-names";

describe("harness-names", () => {
  test("maps session to native and back", () => {
    expect(toNativeHarness("opencode")).toBe("oc");
    expect(toNativeHarness("claude-code")).toBe("cc");
    expect(toSessionHarness("oc")).toBe("opencode");
    expect(toSessionHarness("cc")).toBe("claude-code");
  });
  test("round-trips", () => {
    expect(toSessionHarness(toNativeHarness("opencode"))).toBe("opencode");
    expect(toSessionHarness(toNativeHarness("claude-code"))).toBe("claude-code");
  });
  test("validates native harness", () => {
    expect(isNativeHarness("oc")).toBe(true);
    expect(isNativeHarness("cc")).toBe(true);
    expect(isNativeHarness("opencode")).toBe(false);
  });
  test("known Grok session is refused as a repository harness and is not Claude", () => {
    let mapped: string | undefined;
    expect(() => { mapped = toNativeHarness("grok"); }).toThrow(TypeError);
    expect(() => toNativeHarness("grok")).toThrow("Grok is not a repository harness");
    expect(() => toNativeHarness("grok")).not.toThrow(/Claude/);
    expect(mapped).toBeUndefined();
    expect(mapped).not.toBe("cc");
    expect(mapped).not.toBe("oc");
  });
  test("session conversion never defaults missing or unknown values to Claude", () => {
    for (const value of [undefined, null, "", "gk", "cc", "oc", "constructor", "__proto__", 0, false, {}, []]) {
      // Exercise the runtime boundary despite its deliberately narrow public type.
      expect(() => toNativeHarness(value as Parameters<typeof toNativeHarness>[0])).toThrow(TypeError);
      expect(() => toNativeHarness(value as Parameters<typeof toNativeHarness>[0])).toThrow("Unknown session harness");
    }
  });
  test("native conversion never defaults missing or unknown values to Claude", () => {
    for (const value of [undefined, null, "", "gk", "grok", "claude-code", "opencode", "constructor", "__proto__", 0, false, {}, []]) {
      expect(() => toSessionHarness(value as Parameters<typeof toSessionHarness>[0])).toThrow(TypeError);
      expect(() => toSessionHarness(value as Parameters<typeof toSessionHarness>[0])).toThrow("Unknown native harness");
      expect(isNativeHarness(value)).toBe(false);
    }
  });
});
