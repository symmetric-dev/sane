import { randomUUID } from "node:crypto";
import { parseNativeWorkerRequest, projectNativeWorkerReply, type NativeWorkerOperation, type NativeWorkerRequest, type NativeWorkerResultRef, type NativeWorkerAcknowledgement } from "../../sane-cli/src/native-worker-contract";
import { type WorkerCaller, type WorkerRecord, type WorkerStart } from "./worker-contract";
import { AgentProfileResolutionError } from "./agent-profiles-contract";
import { AppStoreError } from "./app-store";
import { PendingInputStorageError } from "./pending-input-contract";
import { WorkstreamAdapterError } from "./workstreams";
import { WorkerCapacityError, WorkerCompletionBlockedError, WorkerUnfinishedCapacityError } from "./workers";
import { completionBlockedMessage, workerWaitUnsettled } from "./worker-protocol";

/** Request cancellation belongs only to qualification/wait, never worker execution. */
export type NativeWorkerRequestContext = {
  signal: AbortSignal;
  deadline: number;
  assertActive(): void;
};

export type ResolvedNativeWorkerCaller = { caller: WorkerCaller; sessionId: string };

/**
 * Implement at the bridge's ownership/evidence boundary, not from request IDs alone.
 * Resolve exactly one ready, repository-enrolled App session by normalized source,
 * authority, native ID and repository; exclude sessions with attachment metadata.
 * Capture its owner BEFORE awaiting enrollment or native evidence and recheck it
 * afterwards. Fresh invocations require a current, running, non-stopping owner
 * or a request-local capability for an evidenced live OC continuation.
 * CC: match the authenticated run's hook/tool record and actual worker tool name.
 * OC: match messageId AND actual tool-part ID/name in the captured run's
 * nativeCommandId-bounded snapshot. Code Mode additionally requires private
 * plugin provenance from its active execute hooks; the callback UUID is an
 * independent retry identity, never a substitute for visible native evidence.
 * OC background/retry continuations may outlive that command's owner. Require
 * an active native session, the exact unfinished tool part, supported native
 * continuation records and the actual preceding App command. Recheck this
 * evidence before reservation; retain the original run/tool ancestry. This is
 * not command-completion evidence and must not reopen a completed Run.
 * Never choose lastRunId/latest run or accept a run ID from the request.
 *
 * Bind retries to that evidenced run. For start recovery, consult the EXISTING
 * durable worker record keyed by input.requestId and verify native parent,
 * tool invocation and payload; return its original parent run, never rebind to a
 * new owner. Other delayed invocations need original run evidence or rejection.
 * Do not introduce a duplicate persistent binding store. Observe context.signal.
 */
export type NativeWorkerCallerResolver = (
  request: NativeWorkerRequest,
  context: NativeWorkerRequestContext,
) => Promise<ResolvedNativeWorkerCaller>;

/**
 * Adapters must use WorkerService for tree authorization and durable admission.
 * In addition to checking context before calling the service, start must check
 * context.assertActive() at its final synchronous pre-reservation ownership check
 * (after asynchronous parent qualification). Do not pass the request signal to
 * launch/executor cancellation: an admitted worker outlives this HTTP request.
 */
/**
 * Explicit protocol handlers. The CLI contract admits these operations; the
 * switch maps free-text tool input onto these WorkerService calls. Bridge wires
 * them. Do not change the service method signatures.
 */
export type ExplicitWorkerOperationInput = {
  complete: { requestId: string; outcome: { status: "completed" | "failed" | "interrupted"; summary: string } };
  notify: { requestId: string; text: string; intent: "informational" | "request" };
  messageParent: { requestId: string; text: string; awaitReply: boolean };
  messageChild: { requestId: string; workerId: string; text: string };
};
export type ExplicitWorkerOperations = {
  complete(caller: WorkerCaller, input: ExplicitWorkerOperationInput["complete"], context: NativeWorkerRequestContext): Promise<{ completion: { state: "accepted"; revision: number } }>;
  notify(caller: WorkerCaller, input: ExplicitWorkerOperationInput["notify"], context: NativeWorkerRequestContext): Promise<{ attention: { state: "accepted"; revision: number; occurrenceId: string } }>;
  messageParent(caller: WorkerCaller, input: ExplicitWorkerOperationInput["messageParent"], context: NativeWorkerRequestContext): Promise<{ exchange: { id: string; state: "accepted"; revision: number; correlationId: string } }>;
  messageChild(caller: WorkerCaller, input: ExplicitWorkerOperationInput["messageChild"], context: NativeWorkerRequestContext): Promise<{ exchange: { id: string; state: "accepted"; revision: number; correlationId: string } }>;
};

export type NativeWorkerOperations = {
  start(caller: WorkerCaller, input: WorkerStart, context: NativeWorkerRequestContext): Promise<WorkerRecord>;
  status(caller: WorkerCaller, ids: string[] | undefined, context: NativeWorkerRequestContext): Promise<WorkerRecord[]>;
  acknowledge(caller: WorkerCaller, refs: NativeWorkerResultRef[], context: NativeWorkerRequestContext): Promise<NativeWorkerAcknowledgement[]>;
  cancel(caller: WorkerCaller, ids: string[], includeDescendants: boolean, context: NativeWorkerRequestContext): Promise<WorkerRecord[]>;
  cancelAll(caller: WorkerCaller, scope: { parentSessionId: string }, context: NativeWorkerRequestContext): Promise<WorkerRecord[]>;
};

export type NativeWorkerHandlerDependencies = {
  resolveCaller: NativeWorkerCallerResolver;
  operations: NativeWorkerOperations;
  /** Dispatched after CLI schema admission. Bridge wires these to WorkerService. */
  explicit?: ExplicitWorkerOperations;
  /** Current native-turn occupancy. Explicit wait stops without it once the record is settled. */
  nativeTurnActive?: (worker: WorkerRecord) => boolean;
  /** Absolute deadline established at bridge ingress; always capped to 16s. */
  deadline?: (request: Request) => number;
};

/** Only explicitly public, constant/actionable messages may cross this boundary. */
export class NativeWorkerRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Allowlisted messages, never the underlying adapter/profile error text. */
const publicWorkerErrors: Readonly<Record<string, string>> = {
  "invalid-worker-input": "Invalid worker arguments. Supply a supported worker role, bounded prompt/context and valid operation arguments.",
  "worker-request-conflict": "Worker request identity is already bound to another invocation or payload. Inspect sane_worker_status; do not create a replacement invocation for work that may already be admitted.",
  "worker-parent": "Worker operation requires a repository-enrolled, App-owned parent conversation and an evidenced live invocation in its run or native continuation. Inspect sane_worker_status before replacing any uncertain start.",
  "worker-scope": "Requested workers must belong to this caller's descendant tree. Use sane_worker_status without IDs to discover visible workers; cancellation requires explicit worker IDs.",
  "worker-wait": "Worker wait requires IDs and a timeout from 0 to 10 seconds; acknowledgement requires exact worker ID, result revision and notification ID from status or wait.",
  "worker-notification-recipient": "Only a worker's immediate parent may acknowledge its result. Ancestors may inspect results without consuming that parent's notifications.",
  "protocol-unavailable": "This assignment does not include that explicit protocol operation. Inspect sane_worker_status and use only the operations pinned for this worker. Do not invent a completion or send the operation to a different worker.",
  "completion-blocked": "Completion is blocked by descendants, consultation, uncertain execution, or undelivered findings. Resolve the blocker, then retry the same completion request. This request did not complete the assignment.",
  "wait-conflict": "A user or parent wait is already open. Resolve that wait before opening another. This request did not replace it.",
  "worker-terminal": "This assignment is already terminal, or cancellation already committed. Retry only an identical existing request. Do not start a replacement assignment for the same work.",
  "worker-relationship": "Messaging requires the recorded immediate parent and an explicit direct child. Sibling, unrelated, or caller-supplied identities are rejected.",
  "unfinished-capacity": "Checkout unfinished explicit worker capacity is reached. Idle explicit assignments still count until they complete or are cancelled. This request did not admit a worker. Inspect sane_worker_status before retrying only a missing assignment. Do not relaunch through native subagents.",
};

type WorkerFailurePhase = "deadline" | "parse" | "qualification" | "identity" | "dispatch" | "reply";
type WorkerFailureCategory = "worker-store-validation" | "storage" | "adapter" | "type" | "range" | "syntax" | "unexpected";

/** Only fixed categories leave this classifier, never exception content. */
function workerFailureCategory(error: unknown): WorkerFailureCategory {
  try {
    // The store currently throws a plain Error at its validation boundary.
    // Exact-match its known sentinel without invoking message getters or logging
    // any message (including near matches); no substring/regex classification.
    if (error instanceof Error && Object.getOwnPropertyDescriptor(error, "message")?.value === "Corrupt workers.json; operator reconciliation required") return "worker-store-validation";
    if (error instanceof AppStoreError || error instanceof PendingInputStorageError) return "storage";
    if (error instanceof WorkstreamAdapterError) return error.code === "storage-unavailable" ? "storage" : "adapter";
    if (error instanceof TypeError) return "type";
    if (error instanceof RangeError) return "range";
    if (error instanceof SyntaxError) return "syntax";
  } catch { /* Even exception inspection must not interfere with the response. */ }
  return "unexpected";
}

const unavailableGuidance: Readonly<Record<NativeWorkerOperation | "unknown", string>> = {
  start: "Admission is unconfirmed; other starts in the same batch may have succeeded. Admitted workers continue independently. Recover only with the same trusted invocation and unchanged payload; a new start may duplicate work. Do not relaunch through native subagents while admission is unresolved.",
  complete: "Final outcome acceptance is unconfirmed; this response proves neither rejection nor assignment completion. If recovery is needed, retry only the same trusted completion invocation and unchanged outcome, not the assignment itself.",
  notify: "Notification acceptance is unconfirmed. If recovery is needed, retry only the same trusted invocation and unchanged payload; a new invocation may duplicate attention.",
  message_parent: "Parent message acceptance is unconfirmed. If recovery is needed, retry only the same trusted invocation and unchanged payload; a new invocation may duplicate the message or consultation.",
  message: "Child message acceptance is unconfirmed. If recovery is needed, retry only the same trusted invocation and unchanged payload; a new invocation may duplicate the message.",
  acknowledge: "Acknowledgement receipt is unconfirmed. Inspect notification arbitration state before explicitly acknowledging the same exact references again; this failure does not prove notifications were consumed.",
  cancel: "Cancellation is unconfirmed. Inspect the selected workers before retrying cancellation of those same IDs; do not assume execution has stopped.",
  cancel_all: "Cancellation is unconfirmed. Inspect the caller's worker tree before retrying; do not assume execution has stopped or broaden cancellation to unrelated workers.",
  status: "Worker status could not be confirmed. Workers continue independently; retry status after the App is available.",
  wait: "Worker wait results could not be confirmed. Workers continue independently; inspect status rather than repeating wait to hold the session open. End the turn to allow report-back.",
  unknown: "The worker operation result is unconfirmed. Check existing worker state before retrying any state-changing operation.",
};

let workerFailureSequence = 0;
function unexpectedWorkerResponse(error: unknown, operation: NativeWorkerOperation | "unknown", phase: WorkerFailurePhase): Response {
  let errorId: string;
  try { errorId = randomUUID(); }
  catch { errorId = `worker-${Date.now().toString(36)}-${(++workerFailureSequence).toString(36)}`; }
  try {
    // Fixed-size, server-owned metadata only. No caller IDs, request/result
    // objects or exception objects: even apparently harmless fields may be text.
    console.error("[SANE native worker failure]", JSON.stringify({ errorId, operation, phase, category: workerFailureCategory(error) }));
  } catch { /* Diagnostics must never mask the original unavailable response. */ }
  return Response.json({
    error: `App worker operation failed unexpectedly. ${unavailableGuidance[operation]} Inspect sane_worker_status and App diagnostics (reference ${errorId}). Do not rerun or relaunch an assignment solely because this request failed.`,
    code: "worker-unavailable",
  }, { status: 503 });
}

function context(signal: AbortSignal, deadline: number): NativeWorkerRequestContext {
  return {
    signal, deadline,
    assertActive() {
      if (signal.aborted || Date.now() >= deadline) throw new NativeWorkerRequestError(504, "worker-request-ended", "Worker request ended; admitted workers continue independently. Inspect worker status before a new start invocation.");
    },
  };
}

/** Race also observes late rejection; abandoned qualification cannot dispatch. */
async function bounded<T>(ctx: NativeWorkerRequestContext, action: () => Promise<T>): Promise<T> {
  ctx.assertActive();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new NativeWorkerRequestError(504, "worker-request-ended", "Worker request interrupted or timed out; admitted workers continue independently. Inspect status before a new start invocation."));
    ctx.signal.addEventListener("abort", abort, { once: true });
    if (ctx.signal.aborted) abort();
  });
  try { return await Promise.race([Promise.resolve().then(() => { ctx.assertActive(); return action(); }), stopped]); }
  finally { ctx.signal.removeEventListener("abort", abort); }
}

async function pause(ctx: NativeWorkerRequestContext, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await bounded(ctx, () => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/**
 * Call ONLY after bridge's existing bearer-token/no-Origin native POST guard.
 * The bridge body-size limit still applies. HTTP success never acknowledges wait
 * consumption; delivery acceptance requires a separate evidenced mechanism.
 */
export function createNativeWorkerHandler(deps: NativeWorkerHandlerDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return Response.json({ error: "Native worker endpoint requires POST", code: "worker-method" }, { status: 405 });
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let qualificationTimer: ReturnType<typeof setTimeout> | undefined;
    let operation: NativeWorkerOperation | "unknown" = "unknown";
    let phase: WorkerFailurePhase = "deadline";
    try {
      const requestedDeadline = deps.deadline?.(request) ?? started + 16000;
      if (!Number.isFinite(requestedDeadline)) throw new NativeWorkerRequestError(503, "worker-deadline", "App worker request deadline is unavailable.");
      const deadline = Math.min(started + 16000, requestedDeadline);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
      const ctx = context(AbortSignal.any([request.signal, controller.signal]), deadline);
      let input: NativeWorkerRequest;
      phase = "parse";
      try { input = parseNativeWorkerRequest(await bounded(ctx, () => request.json())); }
      catch (error) {
        if (error instanceof NativeWorkerRequestError) throw error;
        throw new NativeWorkerRequestError(400, "invalid-worker-input", "Invalid worker request. Supply a qualified caller, trusted invocation, supported operation and its bounded arguments; cancel requires explicit worker IDs.");
      }
      operation = input.operation;
      phase = "qualification";
      const qualification = new AbortController();
      const qualificationDeadline = Math.min(deadline, started + 8000);
      qualificationTimer = setTimeout(() => qualification.abort(), Math.max(0, qualificationDeadline - Date.now()));
      const qualificationContext = context(AbortSignal.any([ctx.signal, qualification.signal]), qualificationDeadline);
      const resolved = await bounded(qualificationContext, () => deps.resolveCaller(input, qualificationContext));
      clearTimeout(qualificationTimer);
      phase = "identity";
      ctx.assertActive();
      if (!resolved.sessionId || !resolved.caller.runId || resolved.caller.toolCallId !== input.invocation.toolCallId || resolved.caller.toolCallId.length > 300) throw new NativeWorkerRequestError(409, "worker-identity", "Worker invocation could not be bound to an App-owned run. Retry only after native tool evidence is available.");
      const caller: WorkerCaller = { ...resolved.caller, envelope: input.caller };
      const op = deps.operations;
      phase = "dispatch";
      const result = await bounded(ctx, async () => {
        switch (input.operation) {
          case "start": return { worker: await op.start(caller, input.input, ctx) };
          case "status": return { workers: await op.status(caller, input.input.ids, ctx) };
          case "acknowledge": return { receipts: await op.acknowledge(caller, input.input.refs, ctx) };
          case "cancel": return { workers: await op.cancel(caller, input.input.ids, input.input.includeDescendants ?? false, ctx) };
          case "cancel_all": return { workers: await op.cancelAll(caller, { parentSessionId: resolved.sessionId }, ctx) };
          case "complete":
          case "notify":
          case "message_parent":
          case "message": {
            const explicit = deps.explicit;
            if (!explicit) throw new NativeWorkerRequestError(503, "protocol-unavailable", publicWorkerErrors["protocol-unavailable"]!);
            if (input.operation === "complete") return explicit.complete(caller, { requestId: input.input.requestId, outcome: { status: "completed", summary: input.input.outcome } }, ctx);
            if (input.operation === "notify") return explicit.notify(caller, { requestId: input.input.requestId, text: input.input.text, intent: input.input.intent }, ctx);
            if (input.operation === "message_parent") return explicit.messageParent(caller, { requestId: input.input.requestId, text: input.input.text, awaitReply: input.input.awaitReply }, ctx);
            return explicit.messageChild(caller, { requestId: input.input.requestId, workerId: input.input.workerId, text: input.input.text }, ctx);
          }
          case "wait": {
            const { ids, timeoutSec } = input.input;
            const end = Math.min(deadline, Date.now() + timeoutSec * 1000);
            const pending = (rows: WorkerRecord[]) => rows.some(worker => workerWaitUnsettled(worker, deps.nativeTurnActive?.(worker) ?? false));
            let workers = await bounded(ctx, () => op.status(caller, ids, ctx));
            while (pending(workers) && Date.now() < end) {
              await pause(ctx, Math.min(200, end - Date.now()));
              workers = await bounded(ctx, () => op.status(caller, ids, ctx));
            }
            return { workers, timedOut: pending(workers) };
          }
        }
      });
      phase = "reply";
      ctx.assertActive();
      return Response.json(projectNativeWorkerReply(result));
    } catch (error) {
      if (error instanceof NativeWorkerRequestError) return Response.json({ error: error.message.slice(0, 4000), code: error.code }, { status: error.status });
      if (error instanceof WorkerCapacityError || error instanceof WorkerUnfinishedCapacityError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      if (error instanceof WorkerCompletionBlockedError) return Response.json({ error: completionBlockedMessage(error.blockers), code: error.code }, { status: error.status });
      if (error instanceof WorkstreamAdapterError && Object.hasOwn(publicWorkerErrors, error.code)) return Response.json({ error: publicWorkerErrors[error.code], code: error.code }, { status: error.status });
      if (error instanceof AgentProfileResolutionError) return Response.json({ error: "Worker profile configuration is invalid or missing. Configure the caller's workerProfiles or App workerDefaults with a compatible worker profile for this role. This request did not admit a worker; other starts in the same batch may have succeeded. Inspect sane_worker_status before retrying only missing assignments.", code: "worker-profile" }, { status: 409 });
      return unexpectedWorkerResponse(error, operation, phase);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (qualificationTimer !== undefined) clearTimeout(qualificationTimer);
    }
  };
}
