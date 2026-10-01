import type { WorkerDelivery, WorkerRecord } from "../src/worker-contract";
import type { Message, ToolPart } from "./types";

/** Rendering only: never infer a background report from user-supplied text. */
export function workerReportDelivery(message: Message, deliveries: WorkerDelivery[]): WorkerDelivery | undefined {
  if (message.role !== "user") return;
  return deliveries.find(d => d.run.runId === message.runId || d.commandId === message.id);
}

export function dispatchedWorkers(sessionId: string, message: Message, tool: ToolPart, workers: WorkerRecord[]): WorkerRecord[] {
  if (!tool.toolCallId) return [];
  return workers.filter(w => w.parent.sessionId === sessionId && w.parent.toolCallId === tool.toolCallId && (message.runId === "native-import" || w.parent.runId === message.runId));
}
