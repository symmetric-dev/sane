import { classifyTranscriptTool } from "./activity-model";
import { receivedHandoff } from "./handoff-presentation";
import { receivedWorkerExchange, workerExchanges, workerReportDelivery } from "./worker-presentation";
import type { WorkerDelivery, WorkerExchange, WorkerRecord } from "../src/worker-contract";
import type { Message } from "./types";

type TranscriptWorkersInput = Omit<Parameters<typeof classifyTranscriptTool>[0], "source" | "part"> & {
  messages: Message[]; deliveries?: WorkerDelivery[]; exchanges?: readonly WorkerExchange[];
};

/** Exactly the WorkerCards represented by loaded messages, independent of viewport.
 * Receipts/exchanges/handoffs replace the message body and aren't refresh targets. */
export function loadedTranscriptWorkers({ messages, deliveries = [], exchanges, ...input }: TranscriptWorkersInput): WorkerRecord[] {
  const loaded = new Map<string, WorkerRecord>();
  const receivedExchanges = exchanges ?? workerExchanges(input.workers);
  for (const source of messages) {
    if (input.nativeHarness === "opencode" && source.role === "system" && (source.nativeSubagentResult || source.nativeShellResult)) continue;
    if (!input.readOnly && (receivedWorkerExchange(source, input.sessionId, receivedExchanges)
      || workerReportDelivery(source, deliveries, receivedExchanges)
      || receivedHandoff(source, input.sessionId, input.handoffs))) continue;
    for (const part of source.parts) {
      if (part.type !== "tool") continue;
      const classification = classifyTranscriptTool({ ...input, source, part });
      const card = classification.kind === "code-share" || classification.kind === "shared-content" ? classification.underlying : classification;
      if (card?.kind === "worker") for (const worker of card.workers) loaded.set(worker.id, worker);
    }
  }
  return [...loaded.values()];
}
