import type { SystemPromptSnapshot } from "../shared/conversation/system-prompt";
import { validateContextDelivery, type ContextDelivery } from "./context-package";
import type { Event, Run } from "./history";

/** Never recompose historical context from mutable session files. Only the
 * prepared delivery contains the exact saved bytes; receipts are not content. */
export function systemPromptSnapshot(storeId: string, run: Run, events: readonly Event[]): SystemPromptSnapshot {
  const base = { schema: 1 as const, scope: "sane" as const, storeId, sessionId: run.sessionId, runId: run.runId, status: run.status };
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.kind !== "context" || event.runId !== run.runId || event.sessionId !== run.sessionId) continue;
    const data = event.data;
    if (!data || typeof data !== "object" || !("type" in data) || data.type !== "canonical-context"
      || !("stage" in data) || data.stage !== "prepared" || !("delivery" in data)) continue;
    const delivery = data.delivery as ContextDelivery;
    validateContextDelivery(delivery);
    // validateContextDelivery checks integrity; do not attribute another run's
    // session/checkout to this one even if its hashes are internally valid.
    if (delivery.binding.sessionId !== run.sessionId || delivery.binding.cwd !== run.cwd) throw new Error("Recorded system prompt binding mismatch");
    return { ...base, state: "recorded", standing: delivery.standing, injected: delivery.dynamic,
      nativeRoleReference: delivery.segments.find(segment => segment.channel === "native-role-reference")?.text ?? null };
  }
  return { ...base, state: run.status === "running" ? "pending" : "unavailable" };
}
