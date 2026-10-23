import type { ConversationRef } from "sane-core/contracts";
import type { WorkerAgentId } from "sane-core/agent-catalog";
import type { ResolvedAgentLaunch } from "./agent-profiles-contract";
import type { Run } from "./history";

export const DEFAULT_MAX_WORKERS_PER_CHECKOUT = 8;
/** Unfinished explicit assignments, including idle ones. Not an execution slot. */
export const DEFAULT_MAX_UNFINISHED_EXPLICIT_WORKERS = 24;

/** Supplied by the authenticated integration, never by tool arguments. */
export type WorkerCaller = { envelope: unknown; runId: string; toolCallId: string; invocation?: import("../../sane-cli/src/native-worker-contract").NativeWorkerInvocation };
export type WorkerStart = { requestId: string; worker: WorkerAgentId; prompt: string; context?: string; jobs?: string[] };
export type WorkerState = "reserved" | "launching" | "running" | "waiting" | "idle" | "uncertain" | "cancelling" | "completed" | "failed" | "interrupted";
export type WorkerProtocolOperation = "complete" | "notify" | "message-parent" | "message-child";
/** Absent protocol is legacy. Do not infer this from role, coordination, or tool allow. */
export type WorkerProtocolPin = {
  id: "explicit-v1";
  operations: WorkerProtocolOperation[];
  executionRevision: string;
  contextRevision: string;
  runtimeCapabilities: string[];
};
export type WorkerAssignment = "open" | "closing" | "terminal";
export type WorkerWaitReason = "none" | "parent" | "user" | "children";
export type WorkerWait = { reason: WorkerWaitReason; correlationId?: string; since: string };
export type WorkerCompletionOutcome = { status: "completed" | "failed" | "interrupted"; summary: string };
export type WorkerOperationReceiptBody = { id: string; state: "accepted"; revision: number };
/** Immutable after accept. Parent delivery is a later settlement publication, not this receipt. */
export type WorkerCompletion = {
  requestId: string;
  fingerprint: string;
  invocationKey: string;
  at: string;
  outcome: WorkerCompletionOutcome;
  receipt: WorkerOperationReceiptBody;
};
/** Non-overwriting annotation when native settlement disagrees after the receipt. */
export type WorkerSettlement = { status: string; at: string; summary: string };
export type WorkerExchangeDirection = "child-to-parent" | "parent-to-child";
export type WorkerExchangeKind = "consultation" | "guidance" | "notice";
export type WorkerExchangeDeliveryState = "queued" | "claimed" | "acceptance-unknown" | "accepted" | "not-submitted";
export type WorkerExchangeParty = { sessionId: string; native: ConversationRef };
/** Not a WorkerResult and not a WorkerDelivery. Unknown acceptance must not be resent. */
export type WorkerExchange = {
  id: string;
  requestId: string;
  fingerprint: string;
  invocationKey: string;
  direction: WorkerExchangeDirection;
  kind: WorkerExchangeKind;
  correlationId: string;
  sequence: number;
  sender: WorkerExchangeParty;
  recipient: WorkerExchangeParty;
  protocol: "explicit-v1";
  text: string;
  delivery: { state: WorkerExchangeDeliveryState; deliveryId?: string; runId?: string; commandId?: string; error?: string; retryAfter?: string };
  createdAt: string;
};
export type WorkerOperationReceipt = {
  requestId: string;
  fingerprint: string;
  invocationKey: string;
  operation: WorkerProtocolOperation;
  receipt: WorkerOperationReceiptBody;
  at: string;
};
/** Durable attention identity. The feed event carries no message text. */
export type WorkerAttention = {
  requestId: string;
  intent: "informational" | "request";
  fingerprint: string;
  invocationKey: string;
  occurrenceBoundary: string;
  at: string;
};
export type WorkerRecord = {
  id: string; sessionId: string; runId: string | null;
  parent: { sessionId: string; runId: string; toolCallId: string; native: ConversationRef; invocation?: WorkerCaller["invocation"] };
  input: WorkerStart; checkout: string; launch: ResolvedAgentLaunch; child: ConversationRef | null;
  state: WorkerState; createdAt: string; updatedAt: string; cancelRequestedAt?: string; error?: string;
  /** Opted in by the immutable launch policy; older pinned workers retain their lifecycle. */
  coordination?: "scouts" | "workers";
  /** A later ordinary continuation never rewrites the initial worker outcome. */
  continuationCancellation?: { requestedAt: string; error?: string };
  continuation?: { runId: string; state: WorkerState; error?: string };
  results?: WorkerResult[];
  latestResult?: WorkerResult;
  outcome?: { status: "completed" | "failed" | "interrupted"; at: string; summary: string; log: { sessionId: string; runId: string } | null };
  notification?: { id: string; state: "pending" | "wait-consumed" | "claimed" | "acceptance-unknown" | "delivered"; deliveryId?: string; error?: string; retryAfter?: string; consumedAt?: string; consumedBy?: { runId: string; toolCallId: string } };
  /** Absent means legacy turn-end completion. Restart must not backfill this. */
  protocol?: WorkerProtocolPin;
  /** Explicit assignment lifecycle. Legacy readers keep using workerTerminal. */
  assignment?: WorkerAssignment;
  /** Protocol wait. Do not overload WorkerState "waiting" for this. Children may be derived. */
  wait?: WorkerWait;
  completion?: WorkerCompletion;
  settlement?: WorkerSettlement;
  /** Operator-recovered quota failure. Historical results and native runs remain immutable. */
  usageRecovery?: { runId: string; throughRunId: string; throughRevision: number; at: string };
  exchanges?: WorkerExchange[];
  operationReceipts?: WorkerOperationReceipt[];
  attention?: WorkerAttention[];
};
export type WorkerResult = { revision: number; runId: string | null; outcome: NonNullable<WorkerRecord["outcome"]>; notification: NonNullable<WorkerRecord["notification"]> };
export const workerResults = (w: WorkerRecord): WorkerResult[] => w.results ?? (w.outcome && w.notification ? [{ revision: 1, runId: w.outcome.log?.runId ?? w.runId, outcome: w.outcome, notification: w.notification }] : []);
/** run is the immutable dispatch snapshot; current execution stays in ordinary run metadata/logs.
 * delivered means native acceptance evidence, not completed execution or model comprehension. */
export type WorkerDelivery = { id: string; parentSessionId: string; native: ConversationRef; run: Run; commandId: string; workerIds: string[]; resultRefs?: { workerId: string; revision: number; notificationId: string }[]; state: "claimed" | "acceptance-unknown" | "delivered" | "not-submitted"; createdAt: string; updatedAt: string; error?: string };
export type WorkerRecords = { version: 1; workers: WorkerRecord[]; suppressedParents: string[]; deliveries?: WorkerDelivery[] };
export const workerTerminal = (w: Pick<WorkerRecord, "state">) => ["completed", "failed", "interrupted"].includes(w.state);
export const explicitWorker = (w: { protocol?: Pick<WorkerProtocolPin, "id"> }) => w.protocol?.id === "explicit-v1";

/** Protocol presentation. Absent means keep the legacy run/state label. */
export type WorkerProtocolStatus = "running" | "idle" | "awaiting-user" | "awaiting-parent" | "awaiting-children" | "closing" | "terminal" | "uncertain";
const EXECUTING = new Set(["reserved", "launching", "running", "cancelling"]);
export type WorkerProtocolSource = Pick<WorkerRecord, "assignment" | "state"> & {
  protocol?: Pick<WorkerProtocolPin, "id">;
  wait?: Pick<WorkerWait, "reason">;
  continuation?: Pick<NonNullable<WorkerRecord["continuation"]>, "state">;
};
type ProtocolSource = WorkerProtocolSource;

/** Detached sidebar metadata; no prompts, output, protocol receipts, or native payloads. */
export type SessionListWorker = WorkerProtocolSource & Pick<WorkerRecord, "id" | "sessionId"> & {
  parent: Pick<WorkerRecord["parent"], "sessionId" | "runId" | "toolCallId">;
  hasOutcome: boolean;
};
export type SessionListDelivery = Pick<WorkerDelivery, "state" | "parentSessionId">;

/** Running is native occupancy. Protocol waits are not "waiting", and idle is unfinished. */
export function workerProtocolStatus(worker: ProtocolSource): WorkerProtocolStatus | undefined {
  const explicit = explicitWorker(worker);
  const executing = EXECUTING.has(worker.state) || !!worker.continuation && EXECUTING.has(worker.continuation.state);
  if (worker.assignment === "terminal") return "terminal";
  if (executing) return "running";
  if (workerTerminal(worker)) return "terminal";
  if (worker.state === "uncertain" || worker.continuation?.state === "uncertain") return "uncertain";
  if (worker.assignment === "closing") return "closing";
  if (!explicit && worker.assignment === undefined) return undefined;
  if (worker.wait?.reason === "user") return "awaiting-user";
  if (worker.wait?.reason === "parent") return "awaiting-parent";
  if (worker.wait?.reason === "children") return "awaiting-children";
  if (explicit && worker.state === "idle" && (!worker.wait || worker.wait.reason === "none")) return "idle";
  return explicit ? "idle" : undefined;
}

/** Idle unfinished and uncertain/unknown stay stoppable. Terminal workers are not. */
export function workerStoppable(worker: ProtocolSource, executionActive = false, executionState: WorkerState | "starting" | "unknown" = worker.state): boolean {
  if (worker.assignment === "terminal" || workerTerminal(worker)) return false;
  if (executionActive || executionState === "uncertain" || executionState === "unknown" || worker.state === "uncertain" || worker.continuation?.state === "uncertain") return true;
  if (worker.assignment === "closing") return false;
  return explicitWorker(worker) && worker.state === "idle";
}

/** Idle unfinished and protocol waits are not execution slots. */
export function workerCountsAsActiveExecution(worker: ProtocolSource, executionActive: boolean): boolean {
  const status = workerProtocolStatus(worker);
  if (status === "idle" || status === "awaiting-user" || status === "awaiting-parent" || status === "awaiting-children" || status === "terminal") return false;
  if (status === "running") return true;
  if (status === "closing") return executionActive || EXECUTING.has(worker.state);
  return executionActive;
}
