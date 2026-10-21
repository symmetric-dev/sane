import type { WorkerDelivery, WorkerExchange, WorkerProtocolStatus, WorkerRecord } from "../src/worker-contract";
import { workerProtocolStatus } from "../src/worker-contract";
import type { Message, ToolPart } from "./types";

/** Rendering only: never infer a background report from user-supplied text.
 * Exchange ids are consultations, not completed WorkerResults. */
export function workerReportDelivery(message: Message, deliveries: WorkerDelivery[], exchanges: readonly Pick<WorkerExchange, "id" | "delivery">[] = []): WorkerDelivery | undefined {
  if (message.role !== "user") return;
  const blocked = new Set(exchanges.flatMap(exchange => [exchange.id, exchange.delivery.commandId, exchange.delivery.runId].filter((id): id is string => !!id)));
  if (blocked.has(message.id) || !!message.runId && blocked.has(message.runId)) return;
  return deliveries.find(delivery => !blocked.has(delivery.id) && !blocked.has(delivery.commandId) && !blocked.has(delivery.run.runId)
    && (delivery.run.runId === message.runId || delivery.commandId === message.id));
}

export function workerExchanges(workers: readonly Pick<WorkerRecord, "exchanges">[]): WorkerExchange[] {
  return workers.flatMap(worker => worker.exchanges ?? []);
}

/** Match durable delivery evidence, never the prompt's title or JSON payload. */
export function receivedWorkerExchange(message: Message, sessionId: string, exchanges: readonly WorkerExchange[]): WorkerExchange | undefined {
  if (message.role !== "user") return;
  return exchanges.find(exchange => exchange.recipient.sessionId === sessionId
    && (exchange.delivery.commandId === message.id || !!exchange.delivery.runId && exchange.delivery.runId === message.runId));
}

export function dispatchedWorkers(sessionId: string, message: Message, tool: ToolPart, workers: WorkerRecord[]): WorkerRecord[] {
  if (!tool.toolCallId) return [];
  return workers.filter(w => w.parent.sessionId === sessionId && w.parent.toolCallId === tool.toolCallId && (message.runId === "native-import" || w.parent.runId === message.runId));
}

/** Protocol waits are not permission prompts and not "Waiting for input". */
export function workerStatusLabel(status: WorkerProtocolStatus, outcome?: string): string {
  switch (status) {
    case "running": return "Running";
    case "idle": return "Idle, unfinished";
    case "awaiting-user": return "Awaiting you";
    case "awaiting-parent": return "Awaiting parent";
    case "awaiting-children": return "Awaiting children";
    case "closing": return "Closing";
    case "uncertain": return "Unconfirmed";
    case "terminal": return outcome === "failed" ? "Failed" : outcome === "interrupted" ? "Interrupted" : outcome === "completed" ? "Completed" : "Terminal";
  }
}

export function workerStatusText(worker: WorkerRecord): string | undefined {
  const status = workerProtocolStatus(worker);
  if (!status) return;
  const outcome = worker.outcome?.status ?? (status === "terminal" && (worker.state === "completed" || worker.state === "failed" || worker.state === "interrupted") ? worker.state : undefined);
  return workerStatusLabel(status, outcome);
}

export function exchangeSenderLabel(exchange: WorkerExchange): string {
  return exchange.direction === "parent-to-child" ? "Parent" : "Worker";
}

export function exchangeRecipientLabel(exchange: WorkerExchange): string {
  return exchange.direction === "parent-to-child" ? "worker" : "parent";
}
