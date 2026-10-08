import { parseNativeWorkerRequest, projectNativeWorkerReply, type NativeWorkerRequest, type NativeWorkerResultRef, type NativeWorkerAcknowledgement } from "../../sane-cli/src/native-worker-contract";
import { workerTerminal, type WorkerCaller, type WorkerRecord, type WorkerStart } from "./worker-contract";
import { AgentProfileResolutionError } from "./agent-profiles-contract";
import { WorkstreamAdapterError } from "./workstreams";
import { WorkerCapacityError } from "./workers";

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
};

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
    try {
      const requestedDeadline = deps.deadline?.(request) ?? started + 16000;
      if (!Number.isFinite(requestedDeadline)) throw new NativeWorkerRequestError(503, "worker-deadline", "App worker request deadline is unavailable.");
      const deadline = Math.min(started + 16000, requestedDeadline);
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
      const ctx = context(AbortSignal.any([request.signal, controller.signal]), deadline);
      let input: NativeWorkerRequest;
      try { input = parseNativeWorkerRequest(await bounded(ctx, () => request.json())); }
      catch (error) {
        if (error instanceof NativeWorkerRequestError) throw error;
        throw new NativeWorkerRequestError(400, "invalid-worker-input", "Invalid worker request. Supply a qualified caller, trusted invocation, supported operation and its bounded arguments; cancel requires explicit worker IDs.");
      }
      const qualification = new AbortController();
      const qualificationDeadline = Math.min(deadline, started + 8000);
      qualificationTimer = setTimeout(() => qualification.abort(), Math.max(0, qualificationDeadline - Date.now()));
      const qualificationContext = context(AbortSignal.any([ctx.signal, qualification.signal]), qualificationDeadline);
      const resolved = await bounded(qualificationContext, () => deps.resolveCaller(input, qualificationContext));
      clearTimeout(qualificationTimer);
      ctx.assertActive();
      if (!resolved.sessionId || !resolved.caller.runId || resolved.caller.toolCallId !== input.invocation.toolCallId || resolved.caller.toolCallId.length > 300) throw new NativeWorkerRequestError(409, "worker-identity", "Worker invocation could not be bound to an App-owned run. Retry only after native tool evidence is available.");
      const caller: WorkerCaller = { ...resolved.caller, envelope: input.caller };
      const op = deps.operations;
      const result = await bounded(ctx, async () => {
        switch (input.operation) {
          case "start": return { worker: await op.start(caller, input.input, ctx) };
          case "status": return { workers: await op.status(caller, input.input.ids, ctx) };
          case "acknowledge": return { receipts: await op.acknowledge(caller, input.input.refs, ctx) };
          case "cancel": return { workers: await op.cancel(caller, input.input.ids, input.input.includeDescendants ?? false, ctx) };
          case "cancel_all": return { workers: await op.cancelAll(caller, { parentSessionId: resolved.sessionId }, ctx) };
          case "wait": {
            const { ids, timeoutSec } = input.input;
            const end = Math.min(deadline, Date.now() + timeoutSec * 1000);
            let workers = await bounded(ctx, () => op.status(caller, ids, ctx));
            while (workers.some(w => !workerTerminal(w)) && Date.now() < end) {
              await pause(ctx, Math.min(200, end - Date.now()));
              workers = await bounded(ctx, () => op.status(caller, ids, ctx));
            }
            return { workers, timedOut: workers.some(w => !workerTerminal(w)) };
          }
        }
      });
      ctx.assertActive();
      return Response.json(projectNativeWorkerReply(result));
    } catch (error) {
      if (error instanceof NativeWorkerRequestError) return Response.json({ error: error.message.slice(0, 4000), code: error.code }, { status: error.status });
      if (error instanceof WorkerCapacityError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      if (error instanceof WorkstreamAdapterError && Object.hasOwn(publicWorkerErrors, error.code)) return Response.json({ error: publicWorkerErrors[error.code], code: error.code }, { status: error.status });
      if (error instanceof AgentProfileResolutionError) return Response.json({ error: "Worker profile configuration is invalid or missing. Configure the caller's workerProfiles or App workerDefaults with a compatible worker profile for this role. This request did not admit a worker; other starts in the same batch may have succeeded. Inspect sane_worker_status before retrying only missing assignments.", code: "worker-profile" }, { status: 409 });
      // Never serialize arbitrary executor/storage errors, prompts or credentials.
      return Response.json({ error: "App worker operation failed unexpectedly. Admission may be unconfirmed and other starts in the same batch may have succeeded; admitted workers continue independently. Inspect sane_worker_status and App diagnostics before a new start. Do not relaunch assignments through native subagents while admission is unresolved.", code: "worker-unavailable" }, { status: 503 });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (qualificationTimer !== undefined) clearTimeout(qualificationTimer);
    }
  };
}
