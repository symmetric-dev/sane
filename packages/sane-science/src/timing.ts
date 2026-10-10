import { AsyncLocalStorage } from "node:async_hooks";

export type ScienceTimingSpan = { stage: string; offsetMs: number; durationMs: number; outcome: string };
export type ScienceTimingTrace = { started: number; spans: ScienceTimingSpan[]; droppedSpans: number; counters?: Record<string, number>; sessionEvidence: "unobserved" | "existing-session" | "open-required"; outcome: string };
export const scienceTiming = new AsyncLocalStorage<ScienceTimingTrace>();
const ms = (value: number) => Math.round(value * 1000) / 1000;
export function scienceSpan(stage: string) {
  const trace = scienceTiming.getStore(), start = performance.now();
  return (outcome = "completed") => {
    if (!trace) return;
    if (trace.spans.length >= 1024) { trace.droppedSpans++; return; }
    trace.spans.push({ stage, offsetMs: ms(start - trace.started), durationMs: ms(performance.now() - start), outcome });
  };
}
/** Fixed internal labels only; independent of the span budget. */
export function scienceCount(stage: string) {
  const trace = scienceTiming.getStore();
  if (!trace) return;
  const counters = trace.counters ??= {};
  if (Object.hasOwn(counters, stage) || Object.keys(counters).length < 64) counters[stage] = (counters[stage] ?? 0) + 1;
}
export async function scienceTimed<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const end = scienceSpan(stage);
  try { const value = await work(); end(); return value; }
  catch (error) { end("error"); throw error; }
}
/** Preserve synchronous execution and exception propagation for blocking work. */
export function scienceTimedSync<T>(stage: string, work: () => T): T {
  const end = scienceSpan(stage);
  try { const value = work(); end(); return value; }
  catch (error) { end("error"); throw error; }
}
