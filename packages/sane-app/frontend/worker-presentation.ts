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

/** Match the durable caller identity written by workerInvocationKey, including
 * native imports and wrapper tools. Never infer a send from message text/output. */
export function sentWorkerExchanges(sessionId: string, source: Message, tool: ToolPart, exchanges: readonly WorkerExchange[]): WorkerExchange[] {
  return exchanges.filter(exchange => {
    if (exchange.sender.sessionId !== sessionId) return false;
    let caller: unknown;
    try { caller = JSON.parse(exchange.invocationKey); } catch { return false; }
    if (!Array.isArray(caller) || caller.length !== 4 || typeof caller[0] !== "string" || typeof caller[1] !== "string") return false;
    const [runId, toolCallId, messageId] = caller;
    if (toolCallId !== (tool.toolCallId ?? tool.id) || source.runId !== "native-import" && runId !== source.runId) return false;
    return messageId === null || typeof messageId === "string" && (messageId === source.id || source.nativeIds?.includes(messageId) === true);
  });
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
  return exchange.direction === "parent-to-child" ? "Worker" : "Parent";
}

/** Keep Worker on the left so arrow direction alone distinguishes the sender. */
export function exchangeRouteLabel(exchange: Pick<WorkerExchange, "direction">): string {
  return exchange.direction === "parent-to-child" ? "Worker ← Parent" : "Worker → Parent";
}

const exchangeDeliveryLabels = { queued: "Queued", claimed: "Sending", "acceptance-unknown": "Acceptance unconfirmed", accepted: "Accepted", "wrapper-completed": "Delivered", "not-submitted": "Not sent" };
const closedExchangeRecipient = "Recipient assignment is no longer open; the exchange remains queued";

/** A terminal recipient's parked queue entry is historical non-delivery, not an
 * upcoming send. Closing alone is temporary; never relabel it as finished. */
export function exchangeDeliveryPresentation(exchange: WorkerExchange, recipient?: Pick<WorkerRecord, "assignment">): {
  label: string; tone: "neutral" | "warning" | "danger"; notice: string | undefined; parked: boolean;
} {
  const parked = recipient?.assignment === "terminal" && exchange.delivery.state === "queued" && exchange.delivery.error === closedExchangeRecipient;
  return {
    label: parked ? "Not delivered" : exchangeDeliveryLabels[exchange.delivery.state],
    tone: parked || exchange.delivery.state === "acceptance-unknown" ? "warning" : exchange.delivery.state === "not-submitted" ? "danger" : "neutral",
    notice: parked ? "Not delivered — worker finished before delivery" : exchange.delivery.error,
    parked,
  };
}
