import type { CompactionMetadata } from "./oc-contract";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Preserve the actual RPC reply. A generic success/empty acknowledgment is not
 * proof that native history was compacted; only explicit outcome fields support
 * that projection. A preview is never promoted to a full native summary. */
export function grokCompactResultMetadata(result: unknown): CompactionMetadata {
  const value = object(result) ? result : {};
  const outcome = typeof value.outcome === "string" ? value.outcome : typeof value.status === "string" ? value.status : undefined;
  const skipped = value.skipped === true || value.compacted === false || outcome !== undefined && ["skipped", "noop", "no-op", "not_needed"].includes(outcome);
  const failed = value.success === false || value.error !== undefined && value.error !== null || outcome === "failed" || outcome === "error";
  const completed = value.compacted === true || outcome === "completed" || outcome === "compacted";
  return {
    trigger: "manual", lifecycle: failed ? "failed" : skipped ? "skipped" : completed ? "completed" : "unconfirmed",
    ...(nonnegative(value.tokens_before) ? { preTokens: value.tokens_before } : {}),
    ...(nonnegative(value.tokens_after) ? { postTokens: value.tokens_after } : {}),
    ...(nonnegative(value.elapsed_ms) ? { durationMs: value.elapsed_ms } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(failed && value.error !== undefined ? { error: value.error } : {}),
    nativeMetadata: { method: "x.ai/compact_conversation", rpcResult: result },
  };
}
