import type { Event, Run } from "./history";

export function conversationRecency(runs: readonly Run[], events: ReadonlyMap<string, readonly Event[]>): Map<string, string> {
  const latest = new Map<string, number>();
  const record = (sessionId: string, time: string | undefined) => {
    if (typeof time !== "string") return;
    const timestamp = Date.parse(time);
    if (!Number.isFinite(timestamp)) return;
    const previous = latest.get(sessionId);
    if (previous === undefined || timestamp > previous) latest.set(sessionId, timestamp);
  };
  for (const run of runs) {
    record(run.sessionId, run.createdAt);
    record(run.sessionId, run.endedAt);
    for (const event of events.get(run.runId) ?? []) record(run.sessionId, event.time);
  }
  return new Map([...latest].map(([sessionId, timestamp]) => [sessionId, new Date(timestamp).toISOString()]));
}
