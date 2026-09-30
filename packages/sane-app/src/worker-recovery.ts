import type { Event } from "./history";

/** A later explicit operator acknowledgement supersedes only the evidence it covers. */
export function workerTerminationUncertainty(records: Event[]): Event | undefined {
  let uncertain: Event | undefined;
  for (const event of records) {
    if (event.kind !== "status") continue;
    const data = event.data as { reason?: unknown; reconciliation?: { kind?: unknown; throughSeq?: unknown } } | null;
    if (/server restarted|termination unconfirmed|operator reconciliation required/.test(String(data?.reason))) uncertain = event;
    const proof = data?.reconciliation;
    if (uncertain && proof?.kind === "termination-confirmed" && typeof proof.throughSeq === "number" && proof.throughSeq >= uncertain.seq && proof.throughSeq < event.seq) uncertain = undefined;
  }
  return uncertain;
}
