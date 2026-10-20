import type { Event, Run } from "./history";

function latestEventTime(events: readonly Event[], start = 0, latest?: number): number | undefined {
  for (let i = start; i < events.length; i++) {
    const time = events[i]!.time;
    const timestamp = typeof time === "string" ? Date.parse(time) : NaN;
    if (Number.isFinite(timestamp) && (latest === undefined || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function projectRecency(runs: readonly Run[], events: ReadonlyMap<string, readonly Event[]>, journalTime: (events: readonly Event[]) => number | undefined): Map<string, string> {
  const latest = new Map<string, number>();
  const record = (sessionId: string, timestamp: number | undefined) => {
    if (timestamp === undefined || !Number.isFinite(timestamp)) return;
    const previous = latest.get(sessionId);
    if (previous === undefined || timestamp > previous) latest.set(sessionId, timestamp);
  };
  for (const run of runs) {
    record(run.sessionId, typeof run.createdAt === "string" ? Date.parse(run.createdAt) : undefined);
    record(run.sessionId, typeof run.endedAt === "string" ? Date.parse(run.endedAt) : undefined);
    const journal = events.get(run.runId);
    if (journal) record(run.sessionId, journalTime(journal));
  }
  return new Map([...latest].map(([sessionId, timestamp]) => [sessionId, new Date(timestamp).toISOString()]));
}

/** Full-data helper for callers whose event arrays may be edited in place. */
export function conversationRecency(runs: readonly Run[], events: ReadonlyMap<string, readonly Event[]>): Map<string, string> {
  return projectRecency(runs, events, latestEventTime);
}

type JournalRecency = { length: number; first?: Event; firstTime?: string; tail?: Event; tailTime?: string; latest?: number };

/** Presentation-only cache for the bridge's append-only loaded journals. Replay
 * replaces the array; shrink/replaced boundaries also rebuild. Weak keys do not
 * retain unloaded journals. Run membership/timestamps are read fresh each time. */
export class ConversationRecencyCache {
  private journals = new WeakMap<readonly Event[], JournalRecency>();
  project(runs: readonly Run[], events: ReadonlyMap<string, readonly Event[]>): Map<string, string> {
    return projectRecency(runs, events, journal => {
      const old = this.journals.get(journal);
      const reusable = old && journal.length >= old.length && journal[0] === old.first && journal[0]?.time === old.firstTime
        && journal[old.length - 1] === old.tail && journal[old.length - 1]?.time === old.tailTime;
      const latest = latestEventTime(journal, reusable ? old.length : 0, reusable ? old.latest : undefined);
      this.journals.set(journal, { length: journal.length, first: journal[0], firstTime: journal[0]?.time,
        tail: journal.at(-1), tailTime: journal.at(-1)?.time, latest });
      return latest;
    });
  }
}
