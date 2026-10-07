import type { Event, Run } from "./history";
import type { WorkerSelection } from "./worker-store";

/** Call only after operational and legacy-output cache guards pass. Store revision
 * separately covers worker/results and delivery snapshots. Event logs are loaded
 * before observation and subsequently append-only, including replacement messages.
 */
export function workerObservationEvidence(
  worker: Readonly<Pick<WorkerSelection, "sessionId">>,
  runs: readonly Readonly<Run>[],
  events: ReadonlyMap<string, readonly Readonly<Pick<Event, "seq">>[]>,
  deliveryRunIds: ReadonlySet<string>,
): string {
  // Observation resolves delivery runs globally before filtering by session.
  // Preserve history order and acceptance-only native command/phase changes.
  return JSON.stringify(runs.filter(run => run.sessionId === worker.sessionId || deliveryRunIds.has(run.runId)).map(run => {
    const evidence = events.get(run.runId);
    return [
      run.runId, run.sessionId, run.operation, run.status, run.endedAt, run.nativeCommandId, run.nativePhase,
      evidence?.length, evidence?.at(-1)?.seq,
    ];
  }));
}
