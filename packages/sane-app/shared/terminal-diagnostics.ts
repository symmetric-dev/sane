type Metric = "inputQueueMs" | "bindingMs" | "ptyWriteMs" | "outputQueueMs" | "outputParseMs" | "ackMs" | "clientQueueMs" | "clientParseMs" | "queuedTasks" | "queuedBytes" | "inputBytes" | "outputBytes";
type Context = { terminalId: string | null; bindingMode?: "metadata" | "discovery" };
type Event = "started" | "attached" | "disconnected" | "stopped" | "binding-mode" | "operation-error";
type Details = { bindingMode?: "metadata" | "discovery"; attachmentId?: string; code?: number; reason?: string; errorCode?: string };

/** Bounded aggregates only: never pass input, output, paths or tokens.
 * Flush after five seconds of activity; no polling or per-keystroke log spam.
 * Parser completion is measured, not screen paint or end-to-end echo latency. */
export class TerminalDiagnostics {
  private metrics: Partial<Record<Metric, { count: number; total: number; max: number }>> = {};
  private timer?: ReturnType<typeof setTimeout>;
  private since = 0;
  private disposed = false;
  constructor(private side: "server" | "client", private context: () => Context, private sink?: (line: string) => void) {}
  sample(metric: Metric, value: number) {
    if (this.disposed || !Number.isFinite(value) || value < 0) return;
    const entry = this.metrics[metric] ??= { count: 0, total: 0, max: 0 };
    entry.count++; entry.total += value; entry.max = Math.max(entry.max, value);
    if (!this.timer) {
      this.since = performance.now();
      this.timer = setTimeout(() => this.flush(), 5000);
      this.timer.unref?.();
    }
  }
  event(event: Event, details: Details = {}) {
    if (!this.disposed) this.log({ event, ...details });
  }
  flush() {
    clearTimeout(this.timer); this.timer = undefined;
    if (!Object.keys(this.metrics).length) return;
    const round = (value: number) => Math.round(value * 10) / 10;
    const metrics = Object.fromEntries(Object.entries(this.metrics).map(([name, entry]) => [name, {
      count: entry.count, avg: round(entry.total / entry.count), max: round(entry.max), total: round(entry.total),
    }]));
    this.log({ event: "summary", windowMs: round(performance.now() - this.since), metrics });
    this.metrics = {}; this.since = performance.now();
  }
  dispose() { this.flush(); this.disposed = true; }
  private log(value: object) {
    // Diagnostics must never interfere with input, parser ACKs or cleanup.
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...this.context(), ...value });
      try { console.info(`[terminal:${this.side}]`, line); } catch {}
      this.sink?.(line);
    } catch {}
  }
}
