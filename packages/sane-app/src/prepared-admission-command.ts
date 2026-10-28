import type { Harness } from "../shared/conversation/harness-capabilities";
import { newNativeCommandId } from "./dispatch-run";

/** Only OpenCode exposes a preallocated native command identity. */
export function preparedAdmissionNativeCommandId(harness: Harness, existing?: string | null): string | null {
  if (harness === "opencode") return existing ?? newNativeCommandId();
  return null;
}
