export type PollerOptions = {
  intervalMs: number;
  shouldRun?: () => boolean;
  onError?: (error: unknown) => void;
};

/** Single-flight interval poller. Replaces handoff/worker/input bespoke setInterval guards. */
export function createPoller(fn: () => Promise<void>, options: PollerOptions) {
  const { intervalMs, shouldRun, onError } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;

  const tick = () => {
    if (inFlight) return;
    if (shouldRun && !shouldRun()) return;
    inFlight = fn().catch((error) => onError?.(error)).finally(() => {
      inFlight = undefined;
    });
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    /** Test hook: run once respecting single-flight. */
    async pollOnce(): Promise<void> {
      if (inFlight) return;
      inFlight = fn().finally(() => {
        inFlight = undefined;
      });
      await inFlight;
    },
    get running() {
      return timer !== undefined;
    },
  };
}
