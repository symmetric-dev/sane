import type { OperationTiming } from "./operation-timing";

/** Fixed vocabulary: never use a prompt, path, error, identifier, or native
 * configuration as a stage name. This also documents the shared pipeline map. */
export const RUN_SUBMISSION_STAGES = [
  "status.journal", "context.prepare",
  "payload.encode", "payload.bind-and-journal", "metadata.submission", "admission.publish",
  "native.setup", "native.inspect", "native.history", "execution.resolve",
  "execution.configure", "transport.setup", "launch.journal", "metadata.launch",
  "native.preflight", "context.freshness.before-native", "native.gate",
  "native.send", "native.outcome", "native.withheld",
] as const;
export type RunSubmissionStage = typeof RUN_SUBMISSION_STAGES[number];
export type RunSubmissionMode = "initial" | "live-input" | "queued" | "queued-handoff" | "idle-only";
export type RunSubmissionHarness = "claude-code" | "opencode";

export type RunSubmissionTimingSnapshot = Readonly<{
  version: 1;
  harness: RunSubmissionHarness | "unknown";
  mode: RunSubmissionMode | "unknown";
  /** Monotonic age at snapshot(), not a frozen preparation/send duration. */
  elapsedMs: number;
  stages: readonly Readonly<{
    stage: RunSubmissionStage;
    calls: number;
    completed: number;
    errors: number;
    elapsedMs: number;
    count: number;
  }>[];
  dropped: number;
}>;

const stages = new Set<string>(RUN_SUBMISSION_STAGES);
const modes = new Set<string>(["initial", "live-input", "queued", "queued-handoff", "idle-only"]);
const limit = 4096;
const rounded = (value: number) => Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 1000) / 1000;
const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

/** Caller-owned, bounded, metadata-only OperationTiming. No files, timers, async
 * context, global registration, automatic publishing, or content/error capture.
 * Unknown stages are dropped rather than serialized. Counts are observations,
 * not evidence of native execution or a claim of performance improvement. */
export function createRunSubmissionTiming(input: Readonly<{
  harness: RunSubmissionHarness;
  mode: RunSubmissionMode;
}>): OperationTiming & { snapshot: () => RunSubmissionTimingSnapshot } {
  const harness = input.harness === "claude-code" || input.harness === "opencode" ? input.harness : "unknown";
  const mode = modes.has(input.mode) ? input.mode : "unknown";
  const started = performance.now();
  const values = new Map<RunSubmissionStage, { calls: number; completed: number; errors: number; elapsedMs: number; count: number }>();
  let observations = 0, dropped = 0;
  const reserve = (stage: string) => {
    if (!stages.has(stage) || observations >= limit) { dropped = increment(dropped); return; }
    observations++;
    const key = stage as RunSubmissionStage;
    let value = values.get(key);
    if (!value) { value = { calls: 0, completed: 0, errors: 0, elapsedMs: 0, count: 0 }; values.set(key, value); }
    return value;
  };
  const span: OperationTiming["span"] = stage => {
    const value = reserve(stage);
    if (!value) return () => {};
    value.calls++;
    const start = performance.now();
    let finished = false;
    return outcome => {
      if (finished) return;
      finished = true;
      value.completed++;
      if (outcome === "error") value.errors++;
      value.elapsedMs += Math.max(0, performance.now() - start);
    };
  };
  return Object.freeze({
    span,
    async: async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
      const end = span(stage);
      try { const result = await work(); end(); return result; }
      catch (error) { end("error"); throw error; }
    },
    count: (stage: string) => { const value = reserve(stage); if (value) value.count++; },
    snapshot: (): RunSubmissionTimingSnapshot => Object.freeze({
      version: 1, harness, mode, elapsedMs: rounded(performance.now() - started), dropped,
      stages: Object.freeze(RUN_SUBMISSION_STAGES.flatMap(stage => {
        const value = values.get(stage);
        return value ? [Object.freeze({ stage, ...value, elapsedMs: rounded(value.elapsedMs) })] : [];
      })),
    }),
  });
}
