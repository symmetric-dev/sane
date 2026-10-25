type Snapshot<T> = { value: T; error?: never } | { value?: never; error: string };

/** Optional display evidence only. Never use a snapshot for admission or sends.
 * The caller owns refresh scheduling; reads are synchronous and never start I/O.
 * A timed-out operation keeps its flight until settlement, preventing repeated
 * refreshes from accumulating uncancellable discovery/network operations. */
export function createPresentationSnapshot<T>(options: {
  load: () => Promise<T>;
  shouldRun: () => boolean;
  refreshMs: number;
  maxAgeMs: number;
  timeoutMs: number;
  label: string;
}) {
  let cached: { value: T; observedAt: number } | undefined;
  let error = `${options.label} has not yet been observed; state is unknown`;
  let nextRefreshAt = 0, failures = 0, closed = false;
  let flight: { expired: boolean; timer?: ReturnType<typeof setTimeout> } | undefined;
  const enabled = () => !closed && options.shouldRun();
  const failed = (reason: string) => {
    cached = undefined;
    error = reason;
    failures = Math.min(failures + 1, 6);
    nextRefreshAt = Date.now() + Math.min(30_000, options.refreshMs * 2 ** failures);
  };
  return {
    read(): Snapshot<T> {
      if (!enabled()) return { error: `${options.label} unavailable; state is unknown` };
      if (cached && Date.now() - cached.observedAt < options.maxAgeMs) return { value: cached.value };
      return { error: cached ? `${options.label} observation is stale; state is unknown` : error };
    },
    refresh(): void {
      if (!enabled() || flight || Date.now() < nextRefreshAt) return;
      const startedAt = Date.now(), current = { expired: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      flight = current;
      const finish = () => {
        if (current.timer !== undefined) clearTimeout(current.timer);
        if (flight === current) flight = undefined;
      };
      current.timer = setTimeout(() => {
        current.expired = true;
        if (enabled()) failed(`${options.label} refresh timed out; state is unknown`);
      }, options.timeoutMs);
      // Defer even synchronous loader work out of the refresh caller. Both
      // settlement paths consume failures, including a rejection after timeout.
      void Promise.resolve().then(() => enabled() ? options.load() : undefined).then(value => {
        if (!current.expired && enabled() && value !== undefined) {
          cached = { value, observedAt: startedAt };
          failures = 0;
          nextRefreshAt = Date.now() + options.refreshMs;
        }
        finish();
      }, () => {
        if (!current.expired && enabled()) failed(`${options.label} refresh failed; state is unknown`);
        finish();
      }).catch(() => { finish(); }); // Optional presentation must never reject in the background.
    },
    close(): void {
      closed = true;
      cached = undefined;
      if (flight?.timer !== undefined) clearTimeout(flight.timer);
    },
  };
}
