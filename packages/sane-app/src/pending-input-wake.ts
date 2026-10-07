export const PENDING_INPUT_WAKE_BACKSTOP_MS = 15_000;
const MIN_BACKSTOP_MS = 5_000;

export type PendingInputWakeKind = "enqueue" | "remove" | "resume" | "domain" | "capacity" | "lifecycle";

export type PendingInputWakeDependencies = Readonly<{
  /** Cheap synchronous startup-healthy AND !closing predicate. */
  canRun: () => boolean;
  /** Cheap synchronous pending/unresolved-work predicate; no ledger clone or native proof. */
  hasWork: () => boolean;
  /** Only request the existing coalesced scheduler; never await native execution. */
  poll: () => void;
  /** Invariant failure, not a read-only native-proof refusal (handled by the scheduler). */
  onError: (error: unknown) => void;
}>;

export type PendingInputWakeTimer = { unref?: () => void };
export type PendingInputWakeClock = Readonly<{
  setInterval: (callback: () => void, delayMs: number) => PendingInputWakeTimer;
  clearInterval: (timer: PendingInputWakeTimer) => void;
  queueMicrotask: (callback: () => void) => void;
  /** Internal deterministic-clock override only; never an HTTP/environment setting. */
  backstopMs?: number;
}>;

export type PendingInputWake = Readonly<{
  start: () => void;
  notify: (kind: PendingInputWakeKind) => void;
  close: () => void;
  isStarted: () => boolean;
}>;

const systemClock: PendingInputWakeClock = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: timer => clearInterval(timer as ReturnType<typeof setInterval>),
  queueMicrotask: callback => queueMicrotask(callback),
};

/** Dormant until trusted bridge startup calls start AFTER its final startupReady
 * gate. A wake means reconsideration, NEVER admission permission. Fairness belongs
 * to the coordinator/scheduler; foreign/native readiness requires fresh bridge
 * proof, not a hint. No bridge/native dependencies or execution-owner registry.
 * close synchronously cancels hints/timer; scheduler close/drain is separate. */
export function createPendingInputWake(deps: PendingInputWakeDependencies, clock: PendingInputWakeClock = systemClock): PendingInputWake {
  const delayMs = clock.backstopMs ?? PENDING_INPUT_WAKE_BACKSTOP_MS;
  if (!Number.isSafeInteger(delayMs) || delayMs < MIN_BACKSTOP_MS || delayMs > 2_147_483_647)
    throw new Error("Pending-input wake backstop must be a bounded interval of at least 5000ms");

  let started = false, closed = false, reported = false;
  let queued = false, polling = false, dirty = false;
  let timer: PendingInputWakeTimer | undefined;

  const close = (): void => {
    if (closed) return;
    closed = true;
    started = false;
    queued = false;
    dirty = false;
    const current = timer;
    timer = undefined;
    if (current) {
      try { clock.clearInterval(current); }
      catch (error) { fail(error); }
    }
  };
  const fail = (error: unknown): void => {
    if (reported) return;
    reported = true;
    close();
    try { requireSynchronous(deps.onError(error)); }
    catch { /* The closed latch survives even a broken error hook. */ }
  };
  const flush = (): void => {
    queued = false;
    if (closed || !started || polling || !dirty) return;
    polling = true;
    try {
      if (!requireBooleanPredicate(deps.canRun()) || closed || !requireBooleanPredicate(deps.hasWork()) || closed) return;
      dirty = false;
      // Callback lookup and thenable inspection are also inside this boundary.
      requireSynchronous(deps.poll());
    } catch (error) { fail(error); }
    finally { polling = false; }
    // A reentrant hint stays dirty. NEVER self-reschedule for busy/dirty work;
    // only another external hint or the conservative backstop can reconsider it.
  };
  const notify = (_kind: PendingInputWakeKind): void => {
    if (closed || !started) return;
    dirty = true;
    if (polling || queued) return;
    queued = true;
    try { clock.queueMicrotask(flush); }
    catch (error) { fail(error); }
  };
  const start = (): void => {
    if (closed || started) return;
    try {
      if (!requireBooleanPredicate(deps.canRun()) || closed) return;
      const hasWork = requireBooleanPredicate(deps.hasWork());
      if (closed) return;
      started = true;
      timer = clock.setInterval(() => notify("lifecycle"), delayMs);
      // A clock callback may synchronously close us before returning its handle.
      if (closed) { clock.clearInterval(timer); timer = undefined; return; }
      timer.unref?.();
      if (!closed && hasWork) notify("lifecycle");
    } catch (error) { fail(error); }
  };

  return Object.freeze({ start, notify, close, isStarted: () => started && !closed });
}

/** Reject accidental async hooks immediately, but consume their late rejection.
 * Accessing a hostile `then` getter is intentionally within callers' try/catch. */
function requireSynchronous(value: unknown): void {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    const then = (value as { then?: unknown }).then;
    if (typeof then === "function") {
      // Consume asynchronously using the captured method, without rereading its getter.
      void Promise.resolve().then(() => new Promise<unknown>((resolve, reject) => {
        Reflect.apply(then, value, [resolve, reject]);
      })).catch(() => {});
      throw new Error("Pending-input wake hooks must be synchronous");
    }
  }
}

function requireBooleanPredicate(value: unknown): boolean {
  requireSynchronous(value);
  if (typeof value !== "boolean") throw new Error("Pending-input wake predicates must return a boolean");
  return value;
}
