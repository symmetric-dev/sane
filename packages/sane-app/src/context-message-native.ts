import type { MessageSnapshot } from "./oc-contract";
import type { ContextMessageBinding } from "./context-message";
import { contextMessageFromSubmission, decodeContextMessageSubmission } from "./context-message-evidence";
import { ContextMessageActivationError } from "./context-message-activation";
import { isDeepStrictEqual } from "node:util";

/** A content/prefix check over independently source-verified native history.
 * The caller must use its harness's bounded exact-native-session reader, not a
 * cached UI transcript, model assertion, or journal copy. This never promotes CC
 * pipe delivery to native acceptance and does not prove model consumption. */
export function assertContextMessageNativeContinuity(binding: ContextMessageBinding, standard: unknown, native: readonly MessageSnapshot[]): void {
  const submission = decodeContextMessageSubmission(standard), message = contextMessageFromSubmission(submission);
  if (!isDeepStrictEqual(message.binding, binding)) throw new ContextMessageActivationError("context-activation-unproven", "Native history belongs to another activation binding");
  const nativeMessageId = binding.harnessId === "opencode" ? submission.messageId
    : submission.liveInput ? submission.messageId.slice(`${submission.composition.dispatch.runId}:user:`.length) : submission.composition.dispatch.runId;
  const matching = native.flatMap((item, index) => {
    if (item.role !== "user" || item.messageId !== nativeMessageId) return [];
    const parts = item.parts.filter(part => part.type === "text");
    const text = parts.map(part => part.type === "text" ? part.text : "").join("");
    return text === submission.text ? [index] : [];
  });
  if (matching.length !== 1) throw new ContextMessageActivationError("context-retention-unproven", "The exact original activation bytes are not uniquely present in protected native history");
  for (const item of native.slice(matching[0]!)) {
    if (item.contextReset || item.compaction || item.compactionSummary) throw new ContextMessageActivationError("context-retention-unproven", "Native reset/compaction after activation has no qualified retention proof");
  }
}
