import type { Harness as CoreHarness } from "sane-core/contracts";
import type { Harness } from "./oc-contract";

export type NativeHarness = CoreHarness;
export { isNativeHarness } from "sane-core/native-source-contract";

/** Single mapping between App and qualified native harness names. */
export function toNativeHarness(harness: Harness): NativeHarness {
  switch (harness) {
    case "claude-code": return "cc";
    case "opencode": return "oc";
    case "grok": return "gk";
    default: throw new TypeError("Unknown session harness");
  }
}

export function toSessionHarness(native: NativeHarness): Harness {
  switch (native) {
    case "cc": return "claude-code";
    case "oc": return "opencode";
    case "gk": return "grok";
    default: throw new TypeError("Unknown native harness");
  }
}
