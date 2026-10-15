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
});
