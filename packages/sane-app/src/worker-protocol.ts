import { createHash } from "node:crypto";
import type { WorkerCaller } from "./worker-contract";
import {
  explicitWorker, workerResults, workerTerminal,
  type WorkerCompletion, type WorkerProtocolOperation, type WorkerProtocolPin, type WorkerRecord, type WorkerState,
} from "./worker-contract";

export const WORKER_PROTOCOL_OPERATIONS = ["complete", "notify", "message-parent", "message-child"] as const satisfies readonly WorkerProtocolOperation[];
export type CompletionBlocker = "descendants" | "consultation" | "uncertain-execution" | "undelivered-findings";

const TERMINAL_STATES = ["completed", "failed", "interrupted"] as const;

export function isExplicitWorker(worker: { protocol?: Pick<WorkerProtocolPin, "id"> }): boolean {
  return explicitWorker(worker);
}

export function protocolAllows(worker: WorkerRecord, operation: WorkerProtocolOperation): boolean {
  return isExplicitWorker(worker) && !!worker.protocol?.operations.includes(operation);
}

export function validProtocolPin(pin: WorkerProtocolPin): boolean {
  return !!pin && pin.id === "explicit-v1" && Array.isArray(pin.operations) && pin.operations.length <= WORKER_PROTOCOL_OPERATIONS.length
    && pin.operations.every(operation => (WORKER_PROTOCOL_OPERATIONS as readonly string[]).includes(operation))
    && new Set(pin.operations).size === pin.operations.length
    && boundedText(pin.executionRevision, 200) && boundedText(pin.contextRevision, 200)
    && Array.isArray(pin.runtimeCapabilities) && pin.runtimeCapabilities.length <= 64
    && pin.runtimeCapabilities.every(capability => boundedText(capability, 200));
}

export function sameProtocolPin(left: WorkerProtocolPin, right: WorkerProtocolPin): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Explicit idle is unfinished and owner-free. It is not a legacy terminal outcome. */
export function explicitIdle(worker: WorkerRecord): boolean {
  return isExplicitWorker(worker) && worker.state === "idle" && worker.assignment !== "closing" && worker.assignment !== "terminal" && !worker.outcome;
}

/**
 * Legacy: non-terminal or active execution, unchanged.
 * Explicit: in-flight states and live owner/delivery occupy a slot; idle does not.
 */
export function occupiesExecution(worker: Pick<WorkerRecord, "state" | "assignment"> & { protocol?: Pick<WorkerProtocolPin, "id"> }, activeExecution: boolean): boolean {
  if (!isExplicitWorker(worker)) return !workerTerminal(worker) || activeExecution;
  if (workerTerminal(worker) || worker.assignment === "terminal") return activeExecution;
  if (worker.state === "idle") return activeExecution;
  return true;
}

export function unfinishedExplicit(worker: Pick<WorkerRecord, "state" | "assignment"> & { protocol?: Pick<WorkerProtocolPin, "id"> }): boolean {
  return isExplicitWorker(worker) && worker.assignment !== "terminal" && !workerTerminal(worker);
}

export function continuationActive(worker: { continuation?: Pick<NonNullable<WorkerRecord["continuation"]>, "state"> }): boolean {
  return !!worker.continuation && !TERMINAL_STATES.includes(worker.continuation.state as typeof TERMINAL_STATES[number]);
}

export function pendingResultDelivery(worker: WorkerRecord): boolean {
  return workerResults(worker).some(result => ["pending", "claimed", "acceptance-unknown"].includes(result.notification.state));
}

/** Legacy missing outcome still blocks. Explicit open/idle does not block forever. */
export function workerBlocksParentGate(worker: WorkerRecord): boolean {
  if (!isExplicitWorker(worker)) return !worker.outcome || continuationActive(worker) || pendingResultDelivery(worker);
  if (worker.assignment === "closing" || (worker.state !== "idle" && !["completed", "failed", "interrupted"].includes(worker.state))) return true;
  if (continuationActive(worker) || pendingResultDelivery(worker)) return true;
  return false;
}

export function userOrParentWaitOpen(worker: WorkerRecord): boolean {
  return worker.wait?.reason === "parent" || worker.wait?.reason === "user";
}

const NATIVE_TURN_STATES = new Set(["reserved", "launching", "running", "cancelling"]);

/**
 * Explicit wait joins only the current native turn.
 * Settled means not reserved, launching, running, or cancelling, and no active execution.
 * Idle, awaiting user, awaiting parent, and awaiting children are settled.
 * Legacy workers stay unfinished until terminal.
 */
export function workerWaitUnsettled(worker: Pick<WorkerRecord, "protocol" | "state" | "continuation">, activeExecution = false): boolean {
  if (!isExplicitWorker(worker)) return !workerTerminal(worker);
  if (NATIVE_TURN_STATES.has(worker.state)) return true;
  if (worker.continuation && NATIVE_TURN_STATES.has(worker.continuation.state)) return true;
  return activeExecution;
}

export function completionBlockers(worker: WorkerRecord, descendants: readonly WorkerRecord[], uncertain: (worker: WorkerRecord) => boolean): CompletionBlocker[] {
  const blockers = new Set<CompletionBlocker>();
  if (worker.wait?.reason === "parent") blockers.add("consultation");
  if (uncertain(worker) || worker.state === "uncertain") blockers.add("uncertain-execution");
  for (const descendant of descendants) {
    if (!workerTerminal(descendant)) blockers.add("descendants");
    if (continuationActive(descendant)) blockers.add("descendants");
    if (uncertain(descendant) || descendant.state === "uncertain") blockers.add("uncertain-execution");
    if (workerResults(descendant).some(result => !["delivered", "wait-consumed"].includes(result.notification.state))) blockers.add("undelivered-findings");
    if (workerTerminal(descendant) && !workerResults(descendant).length && descendant.outcome) blockers.add("undelivered-findings");
  }
  return [...blockers];
}

export function completionBlockedMessage(blockers: readonly CompletionBlocker[]): string {
  const labels = blockers.map(blocker => blocker === "uncertain-execution" ? "uncertain execution" : blocker === "undelivered-findings" ? "undelivered findings" : blocker);
  return `Completion is blocked by ${labels.join(", ")}. Resolve those blockers, then retry the same completion request. This request did not complete the assignment.`;
}

export function workerInvocationKey(caller: WorkerCaller): string {
  return JSON.stringify([caller.runId, caller.toolCallId, caller.invocation?.messageId ?? null, caller.invocation?.opencode?.invocationId ?? null]);
}

export function workerPayloadFingerprint(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

export function attentionBoundary(workerSessionId: string, requestId: string): string {
  return `worker-attention:${workerSessionId}:${requestId}`;
}

export type ExplicitObservationInput = {
  run: { runId: string; status: string; endedAt?: string } | null;
  ownerPresent: boolean;
  ownerSettled: boolean;
  terminationUncertain: boolean;
  cancelRequested: boolean;
  /** Durable run-scoped Stop evidence, distinct from assignment cancellation. */
  runStopped?: boolean;
  /** App-owned failure text only. Never used to invent an explicit completion. */
  nativeSummary?: string;
  preparationOutcome?: { status: "failed" | "interrupted"; summary: string };
};

/** Explicit turn end without a receipt stays open. Receipt publication waits for settlement. */
export function explicitObservationChange(worker: WorkerRecord, input: ExplicitObservationInput): Partial<WorkerRecord> {
  const completion = worker.completion;
  const continuation = input.run && input.run.runId !== worker.runId ? observedContinuation(worker, input) : undefined;
  if (input.terminationUncertain) {
    return { state: "uncertain", error: "Execution ownership or termination remains unconfirmed; reconcile the original native run without resubmitting.", ...(continuation ? { continuation: { ...continuation, state: "uncertain", error: "Execution ownership or termination unconfirmed" } } : {}) };
  }
  if (input.ownerPresent && !input.ownerSettled) return continuation ? { continuation, state: settlingState(worker, input) } : {};
  if (!input.run) {
    if (input.ownerPresent) return {};
    if (completion) return publishAccepted(worker, completion, null, input);
    if (input.preparationOutcome) return appOwned(worker, input.preparationOutcome.status, input.preparationOutcome.summary, null, continuation);
    return {};
  }
  if (input.run.status === "running") return { state: settlingState(worker, input), ...(continuation ? { continuation } : {}) };
  if (completion) return publishAccepted(worker, completion, input.run, input, continuation);
  if (input.cancelRequested) return appOwned(worker, "interrupted", input.nativeSummary || "Cancelled before explicit completion", input.run, continuation);
  if (input.run.status === "failed" || input.run.status === "interrupted" && !input.runStopped) return appOwned(worker, input.run.status, input.nativeSummary || input.run.status, input.run, continuation);
  return {
    state: "idle",
    assignment: worker.assignment === "terminal" ? "terminal" : "open",
    error: undefined,
    ...(continuation ? { continuation } : {}),
  };
}

function settlingState(worker: WorkerRecord, input: ExplicitObservationInput): WorkerState {
  if (worker.completion) return input.cancelRequested || worker.continuationCancellation ? "cancelling" : "running";
  if (input.cancelRequested || worker.continuationCancellation) return "cancelling";
  return "running";
}

function observedContinuation(worker: WorkerRecord, input: ExplicitObservationInput): NonNullable<WorkerRecord["continuation"]> {
  const status = input.run!.status === "running" ? (worker.continuationCancellation || input.cancelRequested ? "cancelling" : "running") : input.run!.status;
  return { runId: input.run!.runId, state: status as WorkerState };
}

function publishAccepted(worker: WorkerRecord, completion: WorkerCompletion, run: { runId: string; status: string } | null, input: ExplicitObservationInput, continuation?: WorkerRecord["continuation"]): Partial<WorkerRecord> {
  const change: Partial<WorkerRecord> = {
    state: completion.outcome.status,
    assignment: "terminal",
    error: undefined,
    ...(continuation ? { continuation: { runId: continuation.runId, state: completion.outcome.status } } : {}),
  };
  if (!worker.outcome && !workerResults(worker).some(result => result.revision > ((worker.usageRecovery ?? worker.stopRecovery)?.throughRevision ?? 0))) {
    change.outcome = {
      status: completion.outcome.status,
      at: completion.at,
      summary: completion.outcome.summary,
      log: run ? { sessionId: worker.sessionId, runId: run.runId } : null,
    };
  }
  if (run && run.status !== "completed" && !worker.settlement) {
    change.settlement = { status: run.status, at: new Date().toISOString(), summary: "Native settlement disagreed after the completion receipt was accepted. The accepted outcome was not replaced." };
  }
  if (input.terminationUncertain) return { state: "uncertain" };
  return change;
}

function appOwned(worker: WorkerRecord, status: "failed" | "interrupted", summary: string, run: { runId: string; status: string; endedAt?: string } | null, continuation?: WorkerRecord["continuation"]): Partial<WorkerRecord> {
  if (worker.completion) return publishAccepted(worker, worker.completion, run, { run, ownerPresent: false, ownerSettled: true, terminationUncertain: false, cancelRequested: true, nativeSummary: summary }, continuation);
  return {
    state: status,
    assignment: "terminal",
    error: undefined,
    ...(continuation ? { continuation: { runId: continuation.runId, state: status } } : {}),
    outcome: { status, at: run?.endedAt ?? new Date().toISOString(), summary, log: run ? { sessionId: worker.sessionId, runId: run.runId } : null },
  };
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
}
