import { explicitWorker, workerResults, workerTerminal, type WorkerRecord } from "./worker-contract";

/** Nonterminal, app-owned diagnostic, not parent guidance or a completion. Its
 * durable escalation marker deduplicates it once per assignment attempt. */
export const WORKER_COMPLETION_RECOVERY_SPENT_DIAGNOSTIC = "Assignment still open; recovery reminder already used. A later ordinary turn settled without worker_complete or a legitimate wait/dependency. Inspect the worker and its original reminder; no further automatic reminder or inferred task outcome.";

/** These are live coordinator facts, not facts implied by WorkerState "idle".
 * Every field is required. Gather them again after asynchronous preparation and
 * claim synchronously, before yielding or attempting native dispatch. Include
 * relevant descendant traffic, and accepted deliveries whose native turns are
 * still in flight; recipient-only active-exchange indexes are insufficient. */
export type WorkerCompletionRecoveryBlockers = {
  suppressed: boolean;
  cancellationCommitted: boolean;
  uncertainExecution: boolean;
  unfinishedDescendants: boolean;
  incomingExchanges: boolean;
  outgoingExchanges: boolean;
  resultDeliveries: boolean;
  admission: boolean;
  execution: boolean;
};

export type WorkerCompletionRecoveryInput = {
  attemptKey: string;
  latestRunId: string | null;
  /** Native success and owner settlement must be positively established by the
   * integration. App wrapper completion or final prose alone proves neither. */
  run: { runId: string; sessionId: string; status: string; successful: boolean; settled: boolean; stopped: boolean } | null;
  blockers: WorkerCompletionRecoveryBlockers;
};

export type WorkerCompletionRecoveryReason =
  | "not-explicit-open" | "completion-recorded" | "cancelled" | "stale-attempt" | "stale-run"
  | "no-successful-settled-run" | "stopped" | "uncertain-execution" | "parent-wait" | "user-wait"
  | "suppressed" | "unfinished-descendants" | "incoming-exchanges" | "outgoing-exchanges"
  | "result-deliveries" | "admission" | "execution" | "not-idle" | "missing-completion"
  | "recovery-pending" | "reminder-exhausted" | "reminder-not-submitted" | "delivery-unknown" | "escalation-recorded" | "reminder-spent";

export type WorkerCompletionRecoveryClassification = {
  status: "ineligible" | "blocked" | "recovery-needed" | "escalation-needed" | "attention-needed";
  reasons: WorkerCompletionRecoveryReason[];
};

/** An audited lifecycle reopen starts a new attempt; historical native runs and
 * result revisions remain unchanged. No migration/backfill of old records. */
export function workerCompletionRecoveryAttemptKey(worker: WorkerRecord): string {
  const recovery = worker.usageRecovery ?? worker.stopRecovery;
  return JSON.stringify(recovery
    ? [worker.id, worker.usageRecovery ? "usage" : "stop", recovery.runId, recovery.throughRunId, recovery.throughRevision, recovery.at]
    : [worker.id, "initial", worker.runId]);
}

/** Pure policy only. It neither infers task success nor publishes a completion,
 * starts a turn, mutates waits, or creates attention as a side effect of reads. */
export function classifyWorkerCompletionRecovery(worker: WorkerRecord, input: WorkerCompletionRecoveryInput): WorkerCompletionRecoveryClassification {
  const result = (status: WorkerCompletionRecoveryClassification["status"], ...reasons: WorkerCompletionRecoveryReason[]): WorkerCompletionRecoveryClassification => ({ status, reasons });
  if (!explicitWorker(worker) || worker.assignment !== "open" || workerTerminal(worker) || !worker.protocol?.operations.includes("complete")) return result("ineligible", "not-explicit-open");
  const boundary = worker.usageRecovery ?? worker.stopRecovery;
  if (worker.completion || worker.outcome || workerResults(worker).some(item => item.revision > (boundary?.throughRevision ?? 0))) return result("ineligible", "completion-recorded");
  if (worker.cancelRequestedAt || worker.continuationCancellation || worker.state === "cancelling" || input.blockers.cancellationCommitted !== false) return result("ineligible", "cancelled");
  if (input.attemptKey !== workerCompletionRecoveryAttemptKey(worker)) return result("blocked", "stale-attempt");
  const run = input.run;
  if (!run || run.status !== "completed" || run.successful !== true || run.settled !== true) return result("blocked", "no-successful-settled-run");
  if (run.sessionId !== worker.sessionId || run.runId !== input.latestRunId || run.runId !== (worker.continuation?.runId ?? worker.runId)
    || boundary && (run.runId === boundary.runId || run.runId === boundary.throughRunId)) return result("blocked", "stale-run");
  if (run.stopped !== false) return result("ineligible", "stopped");
  const reasons: WorkerCompletionRecoveryReason[] = [];
  if (worker.state === "uncertain" || worker.continuation?.state === "uncertain" || input.blockers.uncertainExecution !== false) reasons.push("uncertain-execution");
  if (worker.wait?.reason === "parent") reasons.push("parent-wait");
  if (worker.wait?.reason === "user") reasons.push("user-wait");
  for (const [key, reason] of [
    ["suppressed", "suppressed"], ["unfinishedDescendants", "unfinished-descendants"],
    ["incomingExchanges", "incoming-exchanges"], ["outgoingExchanges", "outgoing-exchanges"],
    ["resultDeliveries", "result-deliveries"], ["admission", "admission"], ["execution", "execution"],
  ] as const) if (input.blockers[key] !== false) reasons.push(reason);
  if (worker.state !== "idle" || worker.continuation && !["completed", "failed", "interrupted"].includes(worker.continuation.state)) reasons.push("not-idle");
  if (reasons.length) return { status: "blocked", reasons };
  const recovery = worker.completionRecovery;
  if (!recovery) return result("recovery-needed", "missing-completion");
  // A mismatched persisted fence is not a new reminder budget. Only the audited
  // lifecycle recovery methods may clear the prior attempt's claim.
  if (recovery.attemptKey !== input.attemptKey) return result("blocked", "stale-attempt");
  // Attention dedupe is not settlement authority. Later exact reminder evidence
  // may truthfully close the assignment even after an uncertainty diagnostic.
  if (run.runId === recovery.delivery.runId) return result("escalation-needed", "reminder-exhausted");
  if (run.runId !== recovery.triggerRunId) return recovery.escalation
    ? result("blocked", "escalation-recorded")
    : result("attention-needed", "reminder-spent");
  if (recovery.escalation) return result("blocked", "escalation-recorded");
  if (recovery.delivery.state === "not-submitted") return result("escalation-needed", "reminder-not-submitted");
  if (recovery.delivery.state === "acceptance-unknown") return result("escalation-needed", "delivery-unknown");
  return result("blocked", "recovery-pending");
}
