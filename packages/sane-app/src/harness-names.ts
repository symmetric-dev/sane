import type { Harness as CoreHarness } from "sane-core/contracts";
import type { Harness } from "./oc-contract";

export type NativeHarness = CoreHarness;
export { isNativeHarness } from "sane-core/native-source-contract";

/** Single harness mapping. Bans raw `harness === "opencode" ? "oc" : "cc"` ternaries.
 * Grok is a known App harness and is not a repository harness. */
export function toNativeHarness(harness: Harness): NativeHarness {
  switch (harness) {
    case "claude-code": return "cc";
    case "opencode": return "oc";
    case "grok": throw new TypeError("Grok is not a repository harness");
    default: throw new TypeError("Unknown session harness");
  }
}

export function toSessionHarness(native: NativeHarness): "claude-code" | "opencode" {
  switch (native) {
    case "cc": return "claude-code";
    case "oc": return "opencode";
    default: throw new TypeError("Unknown native harness");
  }
}
