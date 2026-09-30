import type { ConversationRef } from "sane-core/contracts";
import type { WorkerAgentId } from "sane-core/agent-catalog";
import type { ResolvedAgentLaunch } from "./agent-profiles-contract";
import type { Run } from "./history";

/** Supplied by the authenticated integration, never by tool arguments. */
export type WorkerCaller = { envelope: unknown; runId: string; toolCallId: string; invocation?: import("../../sane-cli/src/native-worker-contract").NativeWorkerInvocation };
export type WorkerStart = { requestId: string; worker: WorkerAgentId; prompt: string; context?: string };
export type WorkerState = "reserved" | "launching" | "running" | "waiting" | "uncertain" | "cancelling" | "completed" | "failed" | "interrupted";
export type WorkerRecord = {
  id: string; sessionId: string; runId: string | null;
  parent: { sessionId: string; runId: string; toolCallId: string; native: ConversationRef; invocation?: WorkerCaller["invocation"] };
  input: WorkerStart; checkout: string; launch: ResolvedAgentLaunch; child: ConversationRef | null;
  state: WorkerState; createdAt: string; updatedAt: string; cancelRequestedAt?: string; error?: string;
  /** A later ordinary continuation never rewrites the initial worker outcome. */
  continuationCancellation?: { requestedAt: string; error?: string };
  continuation?: { runId: string; state: WorkerState; error?: string };
  results?: WorkerResult[];
  latestResult?: WorkerResult;
  outcome?: { status: "completed" | "failed" | "interrupted"; at: string; summary: string; log: { sessionId: string; runId: string } | null };
  notification?: { id: string; state: "pending" | "wait-consumed" | "claimed" | "acceptance-unknown" | "delivered"; deliveryId?: string; error?: string; retryAfter?: string; consumedAt?: string; consumedBy?: { runId: string; toolCallId: string } };
};
export type WorkerResult = { revision: number; runId: string | null; outcome: NonNullable<WorkerRecord["outcome"]>; notification: NonNullable<WorkerRecord["notification"]> };
export const workerResults = (w: WorkerRecord): WorkerResult[] => w.results ?? (w.outcome && w.notification ? [{ revision: 1, runId: w.outcome.log?.runId ?? w.runId, outcome: w.outcome, notification: w.notification }] : []);
/** run is the immutable dispatch snapshot; current execution stays in ordinary run metadata/logs.
 * delivered means native acceptance evidence, not completed execution or model comprehension. */
export type WorkerDelivery = { id: string; parentSessionId: string; native: ConversationRef; run: Run; commandId: string; workerIds: string[]; resultRefs?: { workerId: string; revision: number; notificationId: string }[]; state: "claimed" | "acceptance-unknown" | "delivered" | "not-submitted"; createdAt: string; updatedAt: string; error?: string };
export type WorkerRecords = { version: 1; workers: WorkerRecord[]; suppressedParents: string[]; deliveries?: WorkerDelivery[] };
export const workerTerminal = (w: WorkerRecord) => ["completed", "failed", "interrupted"].includes(w.state);
