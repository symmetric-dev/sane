import type { ConversationActivity } from "../shared/conversation/activity";
import type { ConversationUpdateSource } from "../shared/conversation/conversation-updates";
import { legacyProfileId } from "./agent-profiles-contract";
import type { Admission } from "./app-store";
import type { Association } from "./catalog-contract";
import { projectClaudeFollowups } from "./claude-followup-projection";
import type { ClaudeRunService } from "./claude-run-service";
import { conversationRecency } from "./conversation-recency";
import type { Event, Run, Session } from "./history";
import type { SessionListProjection } from "./session-list-projection";

export type SessionListAvailability = { canSend: boolean; reason?: string; code?: string; queueAfterRunId?: string };

/** Bridge-owned policy/lifecycle reads, captured after native observation. The
 * response model has no access to admission, dispatch, or mutation authority. */
export interface SessionListRow {
  session: Session;
  availability: SessionListAvailability;
  association: Association;
  admission?: Admission;
  updateSource?: ConversationUpdateSource;
  activity?: ConversationActivity;
}

export interface SessionListResponseInput {
  rows: readonly SessionListRow[];
  runs: readonly Run[];
  events: ReadonlyMap<string, readonly Event[]>;
  indexes: SessionListProjection;
  native: { active: Readonly<Record<string, { type: string }>>; error: string };
  admissions: Admission[];
  availability: SessionListAvailability;
}

/** Native observation only overlays presentation. Existing policy blockers win,
 * and App run metadata remains independent of native activity. */
function nativeState(session: Session, available: SessionListAvailability, native: SessionListResponseInput["native"]) {
  if (session.harness !== "opencode") return { availability: available };
  const active = !!native.active[session.nativeSessionId!];
  const nativeActivity = native.error ? "unknown" as const : active ? "active" as const : "idle" as const;
  return {
    nativeActivity,
    ...(native.error ? { nativeActivityReason: native.error } : {}),
    ...(active ? { lastStatus: "running" as const } : {}),
    availability: !available.canSend ? available : native.error ? { canSend: false, reason: native.error }
      : active && session.agentKind === "worker" ? { canSend: false, reason: "OpenCode worker is still active" }
      : active ? { ...available, nativeQueue: true } : available,
  };
}

export function sessionDisplayTitle(session: Session, runs: readonly Run[], events: SessionListResponseInput["events"]) {
  if (session.title) return session.title;
  const ordered = runs.filter(run => run.sessionId === session.sessionId && run.operation !== "compact").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of ordered) for (const event of events.get(run.runId) ?? []) {
    if (event.kind !== "submission") continue;
    const text = (event.data as { text?: unknown })?.text;
    if (typeof text !== "string") continue;
    const title = text.split("\n")[0]!.trim().slice(0, 200);
    if (title) return title;
  }
  return undefined;
}

/** Synchronous read model: consume one post-observation snapshot without any
 * awaits. The sole service dependency is the existing followup liveness reader. */
export function sessionListResponse(input: SessionListResponseInput, followups: Pick<ClaudeRunService, "followupPending">) {
  const { runs, events, indexes } = input;
  const updatedAt = conversationRecency(runs, events);
  const runsById = new Map(runs.map(run => [run.runId, run]));
  // A failed prompt submission also consumes the recovery draft; compact does not.
  const prompted = new Set(runs.filter(run => run.operation !== "compact").map(run => run.sessionId));
  const branchDrafts = new Map(indexes.branches.filter(op => op.state === "completed" && op.firstMessage && !op.firstRunId && !prompted.has(op.destinationId)).map(op => [op.destinationId, op.firstMessage]));
  const sessions = input.rows.map(({ session, availability, association, admission, updateSource, activity }) => {
    const run = session.lastRunId ? runsById.get(session.lastRunId) : undefined;
    return {
      ...session,
      ...(run?.sessionId === session.sessionId ? { lastRunStatus: run.status, lastRunOperation: run.operation ?? "prompt", lastRunEndedAt: run.endedAt } : {}),
      ...(updateSource ? { updateSource } : {}),
      ...(activity ? { activity } : {}),
      updatedAt: updatedAt.get(session.sessionId) ?? null,
      branchDraft: branchDrafts.get(session.sessionId),
      branchOrigin: indexes.origins.get(session.sessionId),
      replacedBy: indexes.replaced.get(session.sessionId)?.destinationId,
      ...(indexes.replaced.has(session.sessionId) ? { hidden: true } : {}),
      ...(indexes.workerSessions.has(session.sessionId) ? { worker: indexes.workerSessions.get(session.sessionId) } : {}),
      directWorkerCount: indexes.workerCounts.get(session.sessionId) ?? 0,
      profileId: session.profileId ?? legacyProfileId(session.harness ?? "claude-code", session.agent),
      title: sessionDisplayTitle(session, runs, events),
      admission,
      ...association,
      ...nativeState(session, availability, input.native),
      ...(session.harness === "claude-code" ? { queuedFollowups: projectClaudeFollowups(session.sessionId, runs, id => events.get(id) ?? [], id => followups.followupPending(id)) } : {}),
    };
  });
  return { sessions, admissions: input.admissions, availability: input.availability };
}
