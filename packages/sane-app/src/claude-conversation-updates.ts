import type { Event, Run, Session } from "./history";
import {
  claudeResultBoundaryId, claudeResultMessageId, consumeClaudeResultRecord,
  createClaudeResultSequenceState, rejectUndeliveredClaudeFramework, type ClaudeResultSequenceState,
} from "../shared/conversation/cc-result";
import {
  isConversationUpdateCandidate, isConversationUpdateSource, updateOccurrenceId, updateSourceKey,
  type ConversationUpdateCandidate, type ConversationUpdateSource,
} from "../shared/conversation/conversation-updates";

type ClaudeCommittedRunState = {
  sessionId: string;
  sourceKey: string;
  through: number;
  sequence: ClaudeResultSequenceState;
  terminal: boolean;
  lastReply?: ConversationUpdateCandidate;
};
/** Durable JSON only. The immutable source binding belongs to each run, not
 * whichever live session/owner happens to be current during replay. */
export type ClaudeConversationUpdateState = { runs: Record<string, ClaudeCommittedRunState> };
export function createClaudeUpdateState(): ClaudeConversationUpdateState { return { runs: {} }; }

/** Only committed App history is admissible. Stop, tools, child records and
 * imported/synthetic messages never independently create attention updates. */
export function projectClaudeCommittedEvent(session: Session, run: Run, event: Event, previous: ClaudeConversationUpdateState): {
  candidates: ConversationUpdateCandidate[]; state: ClaudeConversationUpdateState;
} {
  const candidates: ConversationUpdateCandidate[] = [];
  if (session.harness !== "claude-code" || run.operation === "compact") return { candidates, state: previous };
  const source: ConversationUpdateSource = { harness: "claude-code", authorityId: session.authorityId!, nativeSessionId: session.nativeSessionId! };
  if (!isConversationUpdateSource(source)) return { candidates, state: previous };
  const key = updateSourceKey(source);
  const existing = Object.hasOwn(previous.runs, run.runId) ? previous.runs[run.runId] : undefined;
  const current: ClaudeCommittedRunState = existing ? structuredClone(existing) : {
    sessionId: session.sessionId, sourceKey: key, through: 0,
    sequence: createClaudeResultSequenceState(), terminal: false,
  };
  const state: ClaudeConversationUpdateState = { runs: { ...previous.runs, [run.runId]: current } };
  if (run.sessionId !== session.sessionId || event.sessionId !== session.sessionId || event.runId !== run.runId
    || current.sessionId !== session.sessionId || current.sourceKey !== key
    || !Number.isSafeInteger(event.seq) || event.seq < 1) {
    current.sequence.error = current.sequence.integrityRejected = true;
    if (!current.sequence.failureCauses.includes("identity")) current.sequence.failureCauses.push("identity");
    return { candidates, state };
  }
  // Duplicate committed events are replay, not duplicate native result slots.
  if (event.seq <= current.through) return { candidates, state: previous };
  current.through = event.seq;
  if (current.terminal) return { candidates, state };
  let data = event.data;
  if (event.kind === "stdout" && typeof data === "string") {
    try { data = JSON.parse(data); } catch { return { candidates, state }; }
  }
  const record = data !== null && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  if (event.kind === "launch" && record?.framework) {
    // Launch evidence, not presence of SANE membership on a resumed session,
    // proves that this run required SessionStart framework delivery.
    const context = session.saneContext;
    if (context) current.sequence.framework = {
      text: context.assignment === undefined ? context.framework : `${context.framework}\n\n${context.assignment}`,
      delivered: false, rejected: false, failures: [],
    };
    else {
      current.sequence.error = current.sequence.integrityRejected = true;
      if (!current.sequence.failureCauses.includes("framework")) current.sequence.failureCauses.push("framework");
    }
  }
  if (event.kind === "stdout") {
    const observation = consumeClaudeResultRecord(current.sequence, data, source.nativeSessionId);
    const result = observation.result;
    if (observation.eligible && result?.text?.trim()) {
      const boundaryId = claudeResultBoundaryId(run.runId, result, event.seq);
      const candidate: ConversationUpdateCandidate = {
        id: updateOccurrenceId(source, boundaryId), conversationId: session.sessionId, source,
        kind: "reply", occurredAt: null, observedAt: event.time, runId: run.runId, nativeBoundaryId: boundaryId,
        messageId: claudeResultMessageId(run.runId, result, event.seq), sourceSequence: event.seq,
      };
      if (isConversationUpdateCandidate(candidate)) { candidates.push(candidate); current.lastReply = candidate; }
    }
  }
  if (event.kind === "status" && record && ["completed", "failed", "interrupted"].includes(record.status as string)) {
    current.terminal = true;
    rejectUndeliveredClaudeFramework(current.sequence);
    if (record.status === "completed") {
      // A completed process is NOT another reply. Only the last qualifying
      // pre-exit result is the exact legacy run notification's alias.
      if (current.lastReply && !current.sequence.error
        && (!current.sequence.framework || current.sequence.framework.delivered && !current.sequence.framework.rejected)) {
        const candidate = { ...current.lastReply, legacyRunId: run.runId };
        candidates.push(candidate); current.lastReply = candidate;
      }
    } else {
      // Native failure alone need not explain launch/exit/framework failures.
      // Keep a distinct authoritative run-terminal occurrence instead of
      // guessing equivalence to any result record.
      const boundaryId = `cc-run:${run.runId}:terminal`;
      const candidate: ConversationUpdateCandidate = {
        id: updateOccurrenceId(source, boundaryId), conversationId: session.sessionId, source,
        kind: record.status as "failed" | "interrupted", occurredAt: null, observedAt: event.time,
        runId: run.runId, nativeBoundaryId: boundaryId, sourceSequence: event.seq, legacyRunId: run.runId,
      };
      if (isConversationUpdateCandidate(candidate)) candidates.push(candidate);
    }
  }
  return { candidates, state };
}
