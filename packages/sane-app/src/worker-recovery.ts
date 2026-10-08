import type { Event, TerminationUncertainty } from "./history";

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
