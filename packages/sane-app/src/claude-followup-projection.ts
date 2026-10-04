import type { QueuedFollowup } from "../shared/conversation/queued-followup";
import type { QueuedSendConfiguration } from "../shared/conversation/queued-followup";
import type { Event, Run } from "./history";

/** Receipt identity, never prompt text, links queued input to a submitted run.
 * Inert queued/admitting records after restart are recoverable, not replayable. */
export function projectClaudeFollowups(sessionId: string, runs: readonly Run[], events: (id: string) => readonly Event[], pending: (requestId: string) => boolean): QueuedFollowup[] {
  const receipts = new Map<string, QueuedFollowup>();
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue;
    for (const event of events(run.runId)) {
      const data = event.data as Record<string, unknown> | null;
      if (event.kind !== "context" || !data || data.source !== "claude-followup" || typeof data.requestId !== "string") continue;
      if (data.state === "queued" && typeof data.prompt === "string" && data.afterRunId === run.runId && data.sessionId === sessionId) {
        receipts.set(data.requestId, { requestId: data.requestId, afterRunId: run.runId, sessionId, prompt: data.prompt, time: event.time, state: "queued", ...(data.configuration && typeof data.configuration === "object" ? { configuration: data.configuration as QueuedSendConfiguration } : {}) });
      } else {
        const receipt = receipts.get(data.requestId);
        if (!receipt) continue;
        if (data.state === "not-submitted" || data.state === "admission-unconfirmed") receipt.state = data.state;
      }
    }
  }
  for (const run of runs) {
    if (run.sessionId !== sessionId || !run.queuedFollowupId) continue;
    const receipt = receipts.get(run.queuedFollowupId);
    if (receipt && events(run.runId).some(event => event.kind === "submission" && (event.data as any)?.queuedFollowupId === receipt.requestId)) {
      // This links the receipt to the NEW run's recorded submission attempt;
      // it does not claim CLI consumption, delivery, or successful completion.
      receipt.state = "dispatched"; receipt.runId = run.runId;
    }
  }
  return [...receipts.values()].map(receipt => receipt.state === "queued" && !pending(receipt.requestId) ? { ...receipt, state: "not-submitted" } : receipt);
}
