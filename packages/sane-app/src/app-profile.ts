import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Explicit, local diagnostic capture. Never records requests or environment values. */
export async function startAppProfile(): Promise<{ stop(): Promise<void> }> {
  const disabled = { stop: async () => {} };
  if (process.env.SANE_APP_PROFILE !== "1") return disabled;
  try {
    // bun-types/jsc.d.ts documents async callbacks: sampling stops when they settle.
    const { profile } = await import("bun:jsc");
    if (typeof profile !== "function") throw new Error("Sampling profiler unavailable");
    const directory = await mkdtemp(join(tmpdir(), "sane-app-profile-"));
    const file = await open(join(directory, "profile.jsonl"), "wx", 0o600);
    console.log(`App CPU capture: ${directory}/profile.jsonl (60 seconds; 5ms sampling)`);
    let stopped = false;
    let release: (() => void) | undefined;
    const capture = (async () => {
      try {
        await file.writeFile(JSON.stringify({ version: 1, kind: "header", pid: process.pid, bun: Bun.version,
          timestamp: new Date().toISOString(), sampleIntervalUs: 5000, windowTargetMs: 1000,
          maxWindows: 60, maxWindowBytes: 256 * 1024,
          clock: "Window UTC/performance bounds bracket native samples; native timestamps are seconds on a separate monotonic clock. Do not treat them as Unix time." }) + "\n");
        const deadline = performance.now() + 60_000;
        for (let window = 0; window < 60 && !stopped && performance.now() < deadline; window++) {
          const timestamp = new Date().toISOString();
          const started = performance.now();
          const cpuStarted = process.cpuUsage();
          const drift: { timestamp: string; atMs: number; driftMs: number }[] = [];
          let due = started + 25;
          let droppedDriftSamples = 0;
          const interval = setInterval(() => {
            const now = performance.now();
            if (drift.length < 64) drift.push({ timestamp: new Date().toISOString(), atMs: now, driftMs: Math.max(0, now - due) });
            else droppedDriftSamples++;
            due = now + 25;
          }, 25);
          interval.unref();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          let result;
          try {
            result = await profile(async () => {
              await new Promise<void>(resolve => {
                release = resolve;
                timeout = setTimeout(resolve, Math.min(1000, Math.max(1, deadline - performance.now())));
              });
            }, 5000);
          } finally {
            clearInterval(interval);
            clearTimeout(timeout);
            release = undefined;
          }
          const ended = performance.now();
          const record = { version: 1, kind: "window", window, timestamp, endedTimestamp: new Date().toISOString(),
            startedMs: started, endedMs: ended, durationMs: ended - started,
            cpuUs: process.cpuUsage(cpuStarted), drift, droppedDriftSamples,
            terminalOverdueMs: Math.max(0, ended - due),
            functions: result.functions.slice(0, 32 * 1024), bytecodes: result.bytecodes.slice(0, 32 * 1024),
            stackTraces: result.stackTraces, rawSamplesOmitted: false };
          let line = JSON.stringify(record) + "\n";
          if (Buffer.byteLength(line) > 256 * 1024) {
            // Keep bounded summaries/timer evidence when deep stacks exceed the disk budget.
            line = JSON.stringify({ ...record, stackTraces: undefined, rawSamplesOmitted: true }) + "\n";
          }
          // Even unusually escape-heavy runtime strings must respect the per-window budget.
          if (Buffer.byteLength(line) > 256 * 1024) {
            line = JSON.stringify({ ...record, functions: undefined, bytecodes: undefined,
              stackTraces: undefined, rawSamplesOmitted: true }) + "\n";
          }
          await file.writeFile(line);
        }
        console.log(`App CPU capture complete: ${directory}/profile.jsonl`);
      } catch {
        console.error("App CPU capture failed; any completed windows remain in the capture file.");
      } finally {
        await file.close().catch(() => {});
      }
    })();
    return { async stop() { stopped = true; release?.(); await capture; } };
  } catch {
    console.error("App CPU capture unavailable; continuing without profiling.");
    return disabled;
  }
}
