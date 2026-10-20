import type { QueuedFollowup } from "../shared/conversation/queued-followup";
import type { QueuedSendConfiguration } from "../shared/conversation/queued-followup";
import type { Event, Run } from "./history";

/** Receipt identity, never prompt text, links queued input to a submitted run.
 * Inert queued/admitting records after restart are recoverable, not replayable. */
export function projectClaudeFollowups(sessionId: string, runs: readonly Run[], events: (id: string) => readonly Event[], pending: (requestId: string) => boolean): QueuedFollowup[] {
  const journals = new Map<string, FollowupEvidence>();
  return projectFollowups(sessionId, runs, id => {
    let evidence = journals.get(id);
    if (!evidence) { evidence = collectEvidence(events(id)); journals.set(id, evidence); }
    return evidence;
  }, pending);
}

type FollowupEvidence = { contexts: Event[]; submissions: Set<string> };

function collectEvidence(events: readonly Event[], start = 0, evidence: FollowupEvidence = { contexts: [], submissions: new Set() }): FollowupEvidence {
  for (let i = start; i < events.length; i++) {
    const event = events[i]!, data = event.data as Record<string, unknown> | null;
    if (event.kind === "context" && data?.source === "claude-followup" && typeof data.requestId === "string") evidence.contexts.push(event);
    if (event.kind === "submission" && typeof data?.queuedFollowupId === "string") evidence.submissions.add(data.queuedFollowupId);
  }
  return evidence;
}

function projectFollowups(sessionId: string, runs: readonly Run[], evidence: (id: string) => FollowupEvidence, pending: (requestId: string) => boolean): QueuedFollowup[] {
  const receipts = new Map<string, QueuedFollowup>();
  for (const run of runs) {
    if (run.sessionId !== sessionId) continue;
    for (const event of evidence(run.runId).contexts) {
      const data = event.data as Record<string, unknown> | null;
      if (event.kind !== "context" || !data || data.source !== "claude-followup" || typeof data.requestId !== "string") continue;
      if (data.state === "queued" && typeof data.prompt === "string" && data.afterRunId === run.runId && data.sessionId === sessionId) {
        receipts.set(data.requestId, { requestId: data.requestId, afterRunId: run.runId, sessionId, prompt: data.prompt, time: event.time, state: "queued", ...(data.configuration && typeof data.configuration === "object" ? { configuration: data.configuration as QueuedSendConfiguration } : {}) });
      } else {
        const receipt = receipts.get(data.requestId);
        if (!receipt) continue;
        if (data.state === "not-submitted" || data.state === "admission-unconfirmed") receipt.state = data.state;
      }
    }
  }
  for (const run of runs) {
    if (run.sessionId !== sessionId || !run.queuedFollowupId) continue;
    const receipt = receipts.get(run.queuedFollowupId);
    if (receipt && evidence(run.runId).submissions.has(receipt.requestId)) {
      // This links the receipt to the NEW run's recorded submission attempt;
      // it does not claim CLI consumption, delivery, or successful completion.
      receipt.state = "dispatched"; receipt.runId = run.runId;
    }
  }
  return [...receipts.values()].map(receipt => receipt.state === "queued" && !pending(receipt.requestId) ? { ...receipt, state: "not-submitted" } : receipt);
}

type CachedEvidence = { length: number; first?: Event; tail?: Event; evidence: FollowupEvidence };

/** Cache journal facts, never liveness or a receipt returned to a caller. Runs
 * and contexts are still folded in store order, including late materialization
 * of an earlier run. The bridge appends events or replaces arrays for replay;
 * callers editing arbitrary event payloads use the full-data helper above. */
export class ClaudeFollowupProjectionCache {
  private journals = new WeakMap<readonly Event[], CachedEvidence>();
  project(sessionId: string, runs: readonly Run[], events: (id: string) => readonly Event[], pending: (requestId: string) => boolean): QueuedFollowup[] {
    return projectFollowups(sessionId, runs, id => {
      const journal = events(id), old = this.journals.get(journal);
      if (old && journal.length >= old.length && journal[0] === old.first && journal[old.length - 1] === old.tail) {
        if (journal.length === old.length) return old.evidence;
        collectEvidence(journal, old.length, old.evidence);
        old.length = journal.length; old.first = journal[0]; old.tail = journal.at(-1);
        return old.evidence;
      }
      const evidence = collectEvidence(journal);
      this.journals.set(journal, { length: journal.length, first: journal[0], tail: journal.at(-1), evidence });
      return evidence;
    }, pending);
  }
}
