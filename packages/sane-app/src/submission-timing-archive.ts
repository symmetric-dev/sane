import { RUN_SUBMISSION_STAGES, type RunSubmissionTimingSnapshot } from "./run-submission-timing";

export type RunPreparationTimings = Readonly<{
  initial?: RunSubmissionTimingSnapshot;
  liveInput?: RunSubmissionTimingSnapshot;
}>;

const stages = new Set(RUN_SUBMISSION_STAGES);

/** Copy only the fixed diagnostic vocabulary, never future service fields or
 * owner references. An absent snapshot stays absent; nothing is reconstructed. */
export function copyPreparationTimings(value: RunPreparationTimings | undefined): RunPreparationTimings | undefined {
  if (!value?.initial && !value?.liveInput) return undefined;
  const copy = (snapshot: RunSubmissionTimingSnapshot): RunSubmissionTimingSnapshot => Object.freeze({
    version: 1, harness: snapshot.harness, mode: snapshot.mode, elapsedMs: snapshot.elapsedMs, dropped: snapshot.dropped,
    stages: Object.freeze(snapshot.stages.filter(value => stages.has(value.stage)).slice(0, RUN_SUBMISSION_STAGES.length).map(value => Object.freeze({
      stage: value.stage, calls: value.calls, completed: value.completed, errors: value.errors, elapsedMs: value.elapsedMs, count: value.count,
    }))),
  });
  return Object.freeze({ ...(value.initial ? { initial: copy(value.initial) } : {}),
    ...(value.liveInput ? { liveInput: copy(value.liveInput) } : {}) });
}

/** Process-local diagnostics only. Archival neither certifies ownership release
 * nor participates in admission, recovery, native execution or durable evidence. */
export function createSubmissionTimingArchive() {
  const snapshots = new Map<string, RunPreparationTimings>();
  return {
    retain(runId: string, value: RunPreparationTimings | undefined): void {
      const snapshot = copyPreparationTimings(value);
      if (!snapshot) return;
      snapshots.delete(runId);
      snapshots.set(runId, snapshot);
      if (snapshots.size > 128) snapshots.delete(snapshots.keys().next().value!);
    },
    read: (runId: string): RunPreparationTimings | undefined => snapshots.get(runId),
  };
}
