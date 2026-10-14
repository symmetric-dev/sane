import type { ConversationRef } from "sane-core/contracts";
import type { Event, Run } from "./history";
import { workerResults, type WorkerDelivery, type WorkerExchange, type WorkerRecord } from "./worker-contract";
import { isClaudeRootRecord } from "../shared/conversation/cc-scope";

export function workerReportPrompt(delivery: WorkerDelivery, workers: WorkerRecord[]) {
  const refs = delivery.resultRefs ?? delivery.workerIds.map(workerId => ({ workerId, revision: 1, notificationId: `worker-outcome:${workerId}` }));
  return ["Worker Outcome", `Delivery: ${delivery.id}`, JSON.stringify(refs.map(ref => {
    const w = workers.find(w => w.id === ref.workerId)!;
    const result = workerResults(w).find(r => r.revision === ref.revision && r.notification.id === ref.notificationId)!;
    return { ...ref, role: w.input.worker, sessionId: w.sessionId, outcome: result.outcome };
  }))].join("\n\n");
}

/** Consultation/guidance prompt. This is not a WorkerResult and must not be claimed as one. */
export function workerExchangePrompt(exchange: WorkerExchange) {
  return ["Worker Exchange", `Exchange: ${exchange.id}`, JSON.stringify({
    id: exchange.id, direction: exchange.direction, kind: exchange.kind, correlationId: exchange.correlationId,
    sequence: exchange.sequence, protocol: exchange.protocol, text: exchange.text,
    sender: exchange.sender, recipient: exchange.recipient,
  })].join("\n\n");
}

export function exchangeDeliveryEvidence(delivery: { id: string; commandId?: string; native: ConversationRef; sessionId: string; runId?: string }, run: Run | undefined, events: Event[]): "accepted" | "not-submitted" | "unknown" {
  if (!run || !delivery.runId || run.runId !== delivery.runId || run.sessionId !== delivery.sessionId) return "unknown";
  if (delivery.native.harness === "oc" && delivery.commandId && run.nativeCommandId === delivery.commandId && run.nativePhase === "accepted") return "accepted";
  if (delivery.native.harness === "cc" && events.some(event => {
    const data = event.data as { session_id?: string; type?: string };
    return event.kind === "stdout" && isClaudeRootRecord(event.data) && data.session_id === delivery.native.nativeId && (data.type === "assistant" || data.type === "result");
  })) return "accepted";
  if (events.some(event => event.kind === "status" && (event.data as { workerDeliveryNotSubmitted?: string } | null)?.workerDeliveryNotSubmitted === delivery.id)) return "not-submitted";
  if (delivery.native.harness === "oc" && run.nativePhase === "preparing" && run.status !== "running") return "not-submitted";
  return "unknown";
}

/** Accepted continuation is the delivery milestone, not comprehension or successful completion. */
export function workerDeliveryEvidence(d: WorkerDelivery, run: Run | undefined, events: Event[]): "accepted" | "not-submitted" | "unknown" {
  if (!run || run.runId !== d.run.runId || run.sessionId !== d.parentSessionId) return "unknown";
  if (d.native.harness === "oc" && run.nativeCommandId === d.commandId && run.nativePhase === "accepted") return "accepted";
  if (d.native.harness === "cc" && events.some(e => {
    const data = e.data as any;
    return e.kind === "stdout" && isClaudeRootRecord(data) && data?.session_id === d.native.nativeId && ["assistant", "result"].includes(data?.type);
  })) return "accepted";
  if (events.some(e => e.kind === "status" && (e.data as any)?.workerDeliveryNotSubmitted === d.id)) return "not-submitted";
  if (d.native.harness === "oc" && run.nativePhase === "preparing" && run.status !== "running") return "not-submitted";
  return "unknown";
}
