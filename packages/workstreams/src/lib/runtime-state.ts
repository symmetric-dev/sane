import {
  normalizePersistedBatchStatus,
  normalizePersistedBranchSession,
  normalizePersistedCurrentBranchSupervisionContext,
  normalizePersistedSupervisorEscalation,
  normalizePersistedSupervisorFixCycle,
  normalizePersistedSupervisorIssueSummary,
  normalizePersistedSupervisorReviewedBatch,
  normalizePersistedSupervisorRunState,
  normalizePersistedSupervisorStageStop,
  normalizePersistedThreadMetadata,
} from "./stage-id.ts"
import type {
  PersistedBatchStatusFile,
  SupervisorStateFile,
  WorkstreamRuntimeBatchSummary,
  WorkstreamRuntimeBranchSupervisionSummary,
  WorkstreamRuntimeSummary,
  WorkstreamRuntimeSupervisorRunSummary,
  WorkstreamRuntimeSupervisionSummary,
  WorkstreamUnifiedRuntimeState,
} from "./types.ts"
import type { StructuredStorageWorkstreamState } from "./structured-storage.ts"

const RUNTIME_STATE_VERSION = "1.0.0"

export function createEmptyRuntimeState(streamId: string): WorkstreamUnifiedRuntimeState {
  return {
    version: RUNTIME_STATE_VERSION,
    last_updated: new Date().toISOString(),
    threads: [],
    batches: {},
    supervision: {
      version: "1.0.0",
      stream_id: streamId,
      last_updated: new Date().toISOString(),
      runs: [],
      checkpoint_pointers: [],
      branch_sessions: [],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    },
  }
}

export function normalizeSupervisorState(
  streamId: string,
  supervisorState?: Partial<SupervisorStateFile> | null,
): SupervisorStateFile {
  return {
    version: supervisorState?.version ?? "1.0.0",
    stream_id: supervisorState?.stream_id ?? streamId,
    last_updated: supervisorState?.last_updated ?? new Date().toISOString(),
    ...(supervisorState?.active_run_id ? { active_run_id: supervisorState.active_run_id } : {}),
    ...(supervisorState?.current_branch_supervision
      ? { current_branch_supervision: { ...supervisorState.current_branch_supervision } }
      : {}),
    runs: (supervisorState?.runs ?? []).map((run) => ({ ...run })),
    checkpoint_pointers: (supervisorState?.checkpoint_pointers ?? []).map((pointer) => ({ ...pointer })),
    branch_sessions: (supervisorState?.branch_sessions ?? []).map((branchSession) => ({
      ...branchSession,
      ...(branchSession.scope ? { scope: { ...branchSession.scope } } : {}),
      ...(branchSession.supervisionProgress
        ? { supervisionProgress: { ...branchSession.supervisionProgress } }
        : {}),
    })),
    reviewed_batches: (supervisorState?.reviewed_batches ?? []).map((reviewedBatch) => ({
      ...reviewedBatch,
      threadIds: [...(reviewedBatch.threadIds ?? [])],
    })),
    issue_summaries: (supervisorState?.issue_summaries ?? []).map((issueSummary) => ({ ...issueSummary })),
    fix_cycles: (supervisorState?.fix_cycles ?? []).map((fixCycle) => ({ ...fixCycle })),
    escalations: (supervisorState?.escalations ?? []).map((escalation) => ({ ...escalation })),
    stage_stops: (supervisorState?.stage_stops ?? []).map((stageStop) => ({ ...stageStop })),
  }
}

export function normalizeLoadedSupervisorState(
  streamId: string,
  supervisorState?: Partial<SupervisorStateFile> | null,
): SupervisorStateFile {
  const normalized = normalizeSupervisorState(streamId, supervisorState)
  return {
    ...normalized,
    ...(normalized.current_branch_supervision
      ? {
          current_branch_supervision: normalizePersistedCurrentBranchSupervisionContext(
            normalized.current_branch_supervision,
          ),
        }
      : {}),
    runs: normalized.runs.map(normalizePersistedSupervisorRunState),
    branch_sessions: normalized.branch_sessions.map(normalizePersistedBranchSession),
    reviewed_batches: normalized.reviewed_batches.map(normalizePersistedSupervisorReviewedBatch),
    issue_summaries: normalized.issue_summaries.map(normalizePersistedSupervisorIssueSummary),
    fix_cycles: normalized.fix_cycles.map(normalizePersistedSupervisorFixCycle),
    escalations: normalized.escalations.map(normalizePersistedSupervisorEscalation),
    stage_stops: normalized.stage_stops.map(normalizePersistedSupervisorStageStop),
  }
}

export function normalizeRuntimeState(
  streamId: string,
  runtimeState?: Partial<WorkstreamUnifiedRuntimeState> | null,
): WorkstreamUnifiedRuntimeState {
  const empty = createEmptyRuntimeState(streamId)
  return {
    version: runtimeState?.version ?? empty.version,
    last_updated: runtimeState?.last_updated ?? empty.last_updated,
    threads: Array.isArray(runtimeState?.threads)
      ? runtimeState.threads.map((thread) => ({
          ...thread,
          sessions: (thread.sessions ?? []).map((session) => ({
            ...session,
            ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
          })),
          ...(thread.synthesis ? { synthesis: { ...thread.synthesis } } : {}),
        }))
      : [],
    batches: Object.fromEntries(
      Object.entries(runtimeState?.batches ?? {}).map(([batchId, batchStatus]) => [
        batchId,
        {
          ...batchStatus,
          summary: { ...batchStatus.summary },
          threads: (batchStatus.threads ?? []).map((thread) => ({ ...thread })),
        },
      ]),
    ),
    supervision: normalizeSupervisorState(streamId, runtimeState?.supervision),
  }
}

export function normalizeLoadedRuntimeState(
  streamId: string,
  runtimeState?: Partial<WorkstreamUnifiedRuntimeState> | null,
): WorkstreamUnifiedRuntimeState {
  const normalized = normalizeRuntimeState(streamId, runtimeState)
  return {
    ...normalized,
    threads: normalized.threads.map(normalizePersistedThreadMetadata),
    batches: Object.fromEntries(
      Object.entries(normalized.batches).map(([batchId, batchStatus]) => {
        const normalizedBatchStatus = normalizePersistedBatchStatus(batchStatus, batchId)
        return [normalizedBatchStatus.batchId, normalizedBatchStatus]
      }),
    ),
    supervision: normalizeLoadedSupervisorState(streamId, normalized.supervision),
  }
}

function toRuntimeBatchSummary(batchStatus: PersistedBatchStatusFile): WorkstreamRuntimeBatchSummary {
  return {
    batch_id: batchStatus.batchId,
    run_id: batchStatus.runId,
    status: batchStatus.status,
    started_at: batchStatus.startedAt,
    updated_at: batchStatus.updatedAt,
    ...(batchStatus.completedAt ? { completed_at: batchStatus.completedAt } : {}),
    ...(batchStatus.stageName ? { stage_name: batchStatus.stageName } : {}),
    ...(batchStatus.batchName ? { batch_name: batchStatus.batchName } : {}),
    thread_summary: batchStatus.summary,
  }
}

function toRuntimeSupervisorRunSummary(run: SupervisorStateFile["runs"][number]): WorkstreamRuntimeSupervisorRunSummary {
  return {
    run_id: run.runId,
    stage_id: run.stageId,
    status: run.status,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    ...(run.completedAt ? { completed_at: run.completedAt } : {}),
    ...(run.currentBatchId ? { current_batch_id: run.currentBatchId } : {}),
    ...(run.lastReviewedBatchId ? { last_reviewed_batch_id: run.lastReviewedBatchId } : {}),
    review_passes: run.reviewPasses,
    ...(run.stopReason ? { stop_reason: run.stopReason } : {}),
    ...(run.branchSessionId ? { branch_session_id: run.branchSessionId } : {}),
    ...(run.rootSessionId ? { root_session_id: run.rootSessionId } : {}),
  }
}

function toRuntimeBranchSupervisionSummary(
  branch: NonNullable<SupervisorStateFile["current_branch_supervision"]>,
  matchingBranchSession?: SupervisorStateFile["branch_sessions"][number],
): WorkstreamRuntimeBranchSupervisionSummary {
  const status =
    matchingBranchSession?.status === "pending" ||
    matchingBranchSession?.status === "running" ||
    matchingBranchSession?.status === "stopped"
      ? matchingBranchSession.status
      : "running"

  return {
    branch_session_id: branch.branchSessionId,
    root_session_id: branch.rootSessionId,
    status,
    updated_at: branch.updatedAt,
    ...(branch.scope ? { scope_level: branch.scope.level, stage_id: branch.scope.stageId } : {}),
    ...(branch.scope?.level === "batch" ? { batch_id: branch.scope.batchId } : {}),
    ...(branch.supervisionProgress?.executionMode
      ? { execution_mode: branch.supervisionProgress.executionMode }
      : {}),
    ...(branch.supervisionProgress?.currentBatchId
      ? { current_batch_id: branch.supervisionProgress.currentBatchId }
      : {}),
    ...(branch.supervisionProgress?.lastReviewedBatchId
      ? { last_reviewed_batch_id: branch.supervisionProgress.lastReviewedBatchId }
      : {}),
  }
}

function summarizeSupervisionRuntime(
  supervisorState: SupervisorStateFile,
): WorkstreamRuntimeSupervisionSummary | undefined {
  const activeRun = supervisorState.active_run_id
    ? supervisorState.runs.find((run) => run.runId === supervisorState.active_run_id)
    : undefined
  const latestRun = [...supervisorState.runs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  const currentBranch = supervisorState.current_branch_supervision
  const matchingBranchSession = currentBranch?.branchSessionId
    ? supervisorState.branch_sessions.find(
        (branchSession) => branchSession.branchSessionId === currentBranch.branchSessionId,
      )
    : undefined

  if (!activeRun && !latestRun && !currentBranch) {
    return undefined
  }

  const updatedAt = [
    supervisorState.last_updated,
    activeRun?.updatedAt,
    latestRun?.updatedAt,
    currentBranch?.updatedAt,
  ].filter((value): value is string => Boolean(value)).sort((left, right) => right.localeCompare(left))[0] ?? new Date().toISOString()

  return {
    updated_at: updatedAt,
    ...(supervisorState.active_run_id ? { active_run_id: supervisorState.active_run_id } : {}),
    ...(activeRun ? { active_run: toRuntimeSupervisorRunSummary(activeRun) } : {}),
    ...(latestRun ? { latest_run: toRuntimeSupervisorRunSummary(latestRun) } : {}),
    ...(currentBranch
      ? { current_branch: toRuntimeBranchSupervisionSummary(currentBranch, matchingBranchSession) }
      : {}),
  }
}

export function createRuntimeSummaryFromWorkstreamState(
  workstreamState: Pick<StructuredStorageWorkstreamState, "batchRuns" | "supervision">,
): WorkstreamRuntimeSummary | undefined {
  const batches = Object.fromEntries(
    workstreamState.batchRuns.map((batchStatus) => [batchStatus.batchId, toRuntimeBatchSummary(batchStatus)]),
  )
  const supervision = summarizeSupervisionRuntime(workstreamState.supervision)
  if (Object.keys(batches).length === 0 && !supervision) {
    return undefined
  }

  return {
    updated_at: new Date().toISOString(),
    batches,
    ...(supervision ? { supervision } : {}),
  }
}

export function resolveRuntimeSummary(
  workstreamState?: Pick<StructuredStorageWorkstreamState, "batchRuns" | "supervision"> | null,
): WorkstreamRuntimeSummary | undefined {
  return workstreamState ? createRuntimeSummaryFromWorkstreamState(workstreamState) : undefined
}
