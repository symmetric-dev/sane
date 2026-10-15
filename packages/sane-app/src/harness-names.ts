import type { Harness } from "./oc-contract";

export type NativeHarness = "cc" | "oc";

/** Single harness mapping. Bans raw `harness === "opencode" ? "oc" : "cc"` ternaries. */
export function toNativeHarness(harness: Harness): NativeHarness {
  return harness === "opencode" ? "oc" : "cc";
}

export function toSessionHarness(native: NativeHarness): Harness {
  return native === "oc" ? "opencode" : "claude-code";
}

export function isNativeHarness(value: unknown): value is NativeHarness {
  return value === "cc" || value === "oc";
}
