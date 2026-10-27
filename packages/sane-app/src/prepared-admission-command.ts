import type { Harness } from "../shared/conversation/harness-capabilities";
import { newNativeCommandId } from "./dispatch-run";
import { WorkstreamAdapterError } from "./workstreams";

/** Prepared-admission command identity. Claude stays null. OpenCode keeps the
 * existing `msg_` id or allocates one with the same grammar. Grok is an
 * eligibility refusal, never a Claude null. */
export function preparedAdmissionNativeCommandId(harness: Harness, existing?: string | null): string | null {
  if (harness === "grok") throw new WorkstreamAdapterError(501, "unsupported-harness-operation", "Grok prepared admission is not available");
  if (harness === "opencode") return existing ?? newNativeCommandId();
  return null;
}
