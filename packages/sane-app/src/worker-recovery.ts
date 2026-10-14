import type { Event, TerminationUncertainty } from "./history";
import type { WorkerRecord } from "./worker-contract";

/** Initial, continuation, and exchange-delivery runs. Result history is not current occupancy. */
export function workerExecutionRunIds(worker: WorkerRecord): string[] {
  const ids = new Set<string>();
  if (worker.runId) ids.add(worker.runId);
  if (worker.continuation?.runId) ids.add(worker.continuation.runId);
  for (const exchange of worker.exchanges ?? []) if (exchange.delivery.runId) ids.add(exchange.delivery.runId);
  return [...ids];
}

export function workerOwnsExecutionRun(worker: WorkerRecord, runId: string): boolean {
  return workerExecutionRunIds(worker).includes(runId);
}

function historicalTerminationUncertainty(reason: unknown): boolean {
  return reason === "server restarted; verify old CLI process has stopped"
    || reason === "Process termination unconfirmed; operator reconciliation required";
}

/** A later explicit operator acknowledgement supersedes only the evidence it covers. */
export function workerTerminationUncertainty(records: Event[]): Event | undefined {
  let uncertain: Event | undefined;
  for (const event of records) {
    if (event.kind !== "status") continue;
    const data = event.data as { reason?: unknown; termination?: TerminationUncertainty; reconciliation?: { kind?: unknown; throughSeq?: unknown } } | null;
    const termination = data?.termination;
    const typed = termination?.kind === "unconfirmed" && (termination.cause === "server-restart" || termination.cause === "process-group");
    if (typed || termination === undefined && historicalTerminationUncertainty(data?.reason)) uncertain = event;
    const proof = data?.reconciliation;
    if (uncertain && proof?.kind === "termination-confirmed" && typeof proof.throughSeq === "number" && proof.throughSeq >= uncertain.seq && proof.throughSeq < event.seq) uncertain = undefined;
  }
  return uncertain;
}
