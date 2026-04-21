import { mkdirSync } from "fs"
import { join } from "path"

import { atomicWriteFile } from "./index.ts"
import { getWorkDir } from "./repo.ts"
import {
  createStreamMetadataFromStructuredStorageRecord,
  createStructuredStorageParitySnapshot,
  structuredApprovalRecordsToApprovalMetadata,
  type StructuredStorageWorkspaceState,
  type StructuredStorageWorkstreamState,
} from "./structured-storage.ts"
import type {
  SessionRecord,
  TasksFile,
  ThreadMetadata,
  WorkIndex,
  WorkstreamRuntimeSummary,
  WorkstreamRuntimeSupervisionSummary,
} from "./types.ts"
import {
  loadSqliteStructuredStorageWorkspaceState,
  loadSqliteStructuredStorageWorkstreamState,
} from "./sqlite-storage.ts"

const COMPATIBILITY_INDEX_VERSION = "1.0.0"
const COMPATIBILITY_TASKS_VERSION = "2.0.0"
const COMPATIBILITY_EMPTY_TIMESTAMP = "1970-01-01T00:00:00.000Z"

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function compareOptionalStrings(left?: string, right?: string): number {
  if (left === right) return 0
  if (!left) return -1
  if (!right) return 1
  return compareIds(left, right)
}

function appendTimestamp(values: string[], value?: string): void {
  if (typeof value === "string" && value.length > 0) {
    values.push(value)
  }
}

function getLatestTimestamp(values: string[]): string {
  return values.sort((left, right) => right.localeCompare(left))[0] ?? COMPATIBILITY_EMPTY_TIMESTAMP
}

function toThreadMetadata(record: StructuredStorageWorkstreamState["threadRuntime"][number], promptPath?: string): ThreadMetadata {
  return {
    threadId: record.threadId,
    sessions: record.sessions.map((session) => ({
      ...session,
      ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
    })),
    ...(promptPath ? { promptPath } : {}),
    ...(record.currentSessionId ? { currentSessionId: record.currentSessionId } : {}),
    ...(record.opencodeSessionId ? { opencodeSessionId: record.opencodeSessionId } : {}),
    ...(record.workingAgentSessionId ? { workingAgentSessionId: record.workingAgentSessionId } : {}),
    ...(record.synthesisOutput ? { synthesisOutput: record.synthesisOutput } : {}),
    ...(record.synthesis ? { synthesis: { ...record.synthesis } } : {}),
  }
}

function buildRuntimeSupervisionSummary(
  supervisorState: StructuredStorageWorkstreamState["supervision"],
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

  const updatedAt = getLatestTimestamp([
    supervisorState.last_updated,
    activeRun?.updatedAt,
    latestRun?.updatedAt,
    currentBranch?.updatedAt,
  ].filter((value): value is string => Boolean(value)))

  return {
    updated_at: updatedAt,
    ...(supervisorState.active_run_id ? { active_run_id: supervisorState.active_run_id } : {}),
    ...(activeRun
      ? {
          active_run: {
            run_id: activeRun.runId,
            stage_id: activeRun.stageId,
            status: activeRun.status,
            updated_at: activeRun.updatedAt,
            started_at: activeRun.startedAt,
            ...(activeRun.completedAt ? { completed_at: activeRun.completedAt } : {}),
            ...(activeRun.currentBatchId ? { current_batch_id: activeRun.currentBatchId } : {}),
            ...(activeRun.lastReviewedBatchId
              ? { last_reviewed_batch_id: activeRun.lastReviewedBatchId }
              : {}),
            review_passes: activeRun.reviewPasses,
            ...(activeRun.stopReason ? { stop_reason: activeRun.stopReason } : {}),
            ...(activeRun.branchSessionId ? { branch_session_id: activeRun.branchSessionId } : {}),
            ...(activeRun.rootSessionId ? { root_session_id: activeRun.rootSessionId } : {}),
          },
        }
      : {}),
    ...(latestRun
      ? {
          latest_run: {
            run_id: latestRun.runId,
            stage_id: latestRun.stageId,
            status: latestRun.status,
            updated_at: latestRun.updatedAt,
            started_at: latestRun.startedAt,
            ...(latestRun.completedAt ? { completed_at: latestRun.completedAt } : {}),
            ...(latestRun.currentBatchId ? { current_batch_id: latestRun.currentBatchId } : {}),
            ...(latestRun.lastReviewedBatchId
              ? { last_reviewed_batch_id: latestRun.lastReviewedBatchId }
              : {}),
            review_passes: latestRun.reviewPasses,
            ...(latestRun.stopReason ? { stop_reason: latestRun.stopReason } : {}),
            ...(latestRun.branchSessionId ? { branch_session_id: latestRun.branchSessionId } : {}),
            ...(latestRun.rootSessionId ? { root_session_id: latestRun.rootSessionId } : {}),
          },
        }
      : {}),
    ...(currentBranch
      ? {
          current_branch: {
            branch_session_id: currentBranch.branchSessionId,
            root_session_id: currentBranch.rootSessionId,
            status:
              matchingBranchSession?.status === "pending" ||
                matchingBranchSession?.status === "running" ||
                matchingBranchSession?.status === "stopped"
                ? matchingBranchSession.status
                : "running",
            updated_at: currentBranch.updatedAt,
            ...(currentBranch.scope
              ? { scope_level: currentBranch.scope.level, stage_id: currentBranch.scope.stageId }
              : {}),
            ...(currentBranch.scope?.level === "batch"
              ? { batch_id: currentBranch.scope.batchId }
              : {}),
            ...(currentBranch.supervisionProgress?.executionMode
              ? { execution_mode: currentBranch.supervisionProgress.executionMode }
              : {}),
            ...(currentBranch.supervisionProgress?.currentBatchId
              ? { current_batch_id: currentBranch.supervisionProgress.currentBatchId }
              : {}),
            ...(currentBranch.supervisionProgress?.lastReviewedBatchId
              ? { last_reviewed_batch_id: currentBranch.supervisionProgress.lastReviewedBatchId }
              : {}),
          },
        }
      : {}),
  }
}

function buildRuntimeSummary(
  workstreamState: StructuredStorageWorkstreamState,
): WorkstreamRuntimeSummary | undefined {
  const supervision = buildRuntimeSupervisionSummary(workstreamState.supervision)
  const batches = Object.fromEntries(
    [...workstreamState.batchRuns]
      .sort((left, right) => {
        const batchOrder = compareIds(left.batchId, right.batchId)
        if (batchOrder !== 0) return batchOrder
        return compareIds(left.runId, right.runId)
      })
      .map((batchStatus) => [
        batchStatus.batchId,
        {
          batch_id: batchStatus.batchId,
          run_id: batchStatus.runId,
          status: batchStatus.status,
          started_at: batchStatus.startedAt,
          updated_at: batchStatus.updatedAt,
          ...(batchStatus.completedAt ? { completed_at: batchStatus.completedAt } : {}),
          ...(batchStatus.stageName ? { stage_name: batchStatus.stageName } : {}),
          ...(batchStatus.batchName ? { batch_name: batchStatus.batchName } : {}),
          thread_summary: batchStatus.summary,
        },
      ]),
  )

  if (Object.keys(batches).length === 0 && !supervision) {
    return undefined
  }

  const updatedAt = getLatestTimestamp([
    ...workstreamState.batchRuns.map((batchRun) => batchRun.updatedAt),
    ...(supervision ? [supervision.updated_at] : []),
  ])

  return {
    updated_at: updatedAt,
    batches,
    ...(supervision ? { supervision } : {}),
  }
}

function collectWorkstreamProjectionTimestamps(workstreamState: StructuredStorageWorkstreamState): string[] {
  const timestamps: string[] = []

  for (const task of workstreamState.hierarchy.tasks) {
    appendTimestamp(timestamps, task.createdAt)
    appendTimestamp(timestamps, task.updatedAt)
  }

  for (const threadRuntime of workstreamState.threadRuntime) {
    for (const session of threadRuntime.sessions) {
      appendTimestamp(timestamps, session.startedAt)
      appendTimestamp(timestamps, session.completedAt)
      appendTimestamp(timestamps, session.lineage?.checkpointCreatedAt)
    }

    appendTimestamp(timestamps, threadRuntime.synthesis?.completedAt)
  }

  for (const batchRun of workstreamState.batchRuns) {
    appendTimestamp(timestamps, batchRun.startedAt)
    appendTimestamp(timestamps, batchRun.updatedAt)
    appendTimestamp(timestamps, batchRun.completedAt)

    for (const thread of batchRun.threads) {
      appendTimestamp(timestamps, thread.startedAt)
      appendTimestamp(timestamps, thread.updatedAt)
      appendTimestamp(timestamps, thread.completedAt)
      appendTimestamp(timestamps, thread.markerDetectedAt)
      appendTimestamp(timestamps, thread.synthesisUpdatedAt)
    }
  }

  appendTimestamp(timestamps, workstreamState.supervision.last_updated)

  for (const run of workstreamState.supervision.runs) {
    appendTimestamp(timestamps, run.startedAt)
    appendTimestamp(timestamps, run.updatedAt)
    appendTimestamp(timestamps, run.completedAt)
  }

  for (const pointer of workstreamState.supervision.checkpoint_pointers) {
    appendTimestamp(timestamps, pointer.checkpointCreatedAt)
  }

  for (const session of workstreamState.supervision.branch_sessions) {
    appendTimestamp(timestamps, session.startedAt)
    appendTimestamp(timestamps, session.updatedAt)
    appendTimestamp(timestamps, session.completedAt)
    appendTimestamp(timestamps, session.processEndedAt)
    appendTimestamp(timestamps, session.checkpointCreatedAt)
  }

  for (const review of workstreamState.supervision.reviewed_batches) {
    appendTimestamp(timestamps, review.reviewedAt)
  }

  for (const summary of workstreamState.supervision.issue_summaries) {
    appendTimestamp(timestamps, summary.firstObservedAt)
    appendTimestamp(timestamps, summary.lastObservedAt)
  }

  for (const cycle of workstreamState.supervision.fix_cycles) {
    appendTimestamp(timestamps, cycle.lastAttemptAt)
  }

  for (const escalation of workstreamState.supervision.escalations) {
    appendTimestamp(timestamps, escalation.escalatedAt)
    appendTimestamp(timestamps, escalation.resolvedAt)
  }

  for (const stop of workstreamState.supervision.stage_stops) {
    appendTimestamp(timestamps, stop.stoppedAt)
  }

  return timestamps
}

function collectIndexProjectionTimestamps(args: {
  workspaceState: StructuredStorageWorkspaceState
  workstreamStatesById: Map<string, StructuredStorageWorkstreamState>
}): string[] {
  const timestamps: string[] = []

  for (const stream of args.workspaceState.workstreams) {
    appendTimestamp(timestamps, stream.createdAt)
    appendTimestamp(timestamps, stream.updatedAt)
    appendTimestamp(timestamps, stream.planningSession?.createdAt)
    appendTimestamp(timestamps, stream.github?.completed_at)

    const workstreamState = args.workstreamStatesById.get(stream.id)
    if (!workstreamState) {
      continue
    }

    for (const approval of workstreamState.approvals) {
      appendTimestamp(timestamps, approval.approvedAt)
      appendTimestamp(timestamps, approval.revokedAt)
    }
  }

  return timestamps
}

export function createCompatibilityIndexProjection(args: {
  workspaceState: StructuredStorageWorkspaceState
  workstreamStatesById?: Map<string, StructuredStorageWorkstreamState>
}): WorkIndex {
  const workstreamStatesById = args.workstreamStatesById ?? new Map<string, StructuredStorageWorkstreamState>()
  const workspaceSnapshot = createStructuredStorageParitySnapshot({ workspace: args.workspaceState }).workspace
  const streams = [...workspaceSnapshot.workstreams].sort((left, right) => {
    const orderComparison = left.order - right.order
    if (orderComparison !== 0) return orderComparison
    return compareIds(left.id, right.id)
  })
  const lastUpdated = getLatestTimestamp(
    collectIndexProjectionTimestamps({
      workspaceState: workspaceSnapshot,
      workstreamStatesById,
    }),
  )

  return {
    version: COMPATIBILITY_INDEX_VERSION,
    last_updated: lastUpdated,
    ...(workspaceSnapshot.currentStreamId
      ? { current_stream: workspaceSnapshot.currentStreamId }
      : {}),
    streams: streams.map((record) =>
      createStreamMetadataFromStructuredStorageRecord({
        record,
        approval: structuredApprovalRecordsToApprovalMetadata(workstreamStatesById.get(record.id)?.approvals ?? []),
      })
    ),
  }
}

export function createCompatibilityTasksProjection(
  workstreamState: StructuredStorageWorkstreamState,
): TasksFile {
  const snapshot = createStructuredStorageParitySnapshot({
    workspace: { workstreams: [] },
    workstream: workstreamState,
  }).workstream

  if (!snapshot) {
    throw new Error(`Missing workstream state for ${workstreamState.streamId}`)
  }

  const threadById = new Map(snapshot.hierarchy.threads.map((thread) => [thread.id, thread] as const))
  const batchById = new Map(snapshot.hierarchy.batches.map((batch) => [batch.id, batch] as const))
  const stageById = new Map(snapshot.hierarchy.stages.map((stage) => [stage.id, stage] as const))
  const lastUpdated = getLatestTimestamp(collectWorkstreamProjectionTimestamps(snapshot))
  const runtimeSummary = buildRuntimeSummary(snapshot)

  return {
    version: COMPATIBILITY_TASKS_VERSION,
    stream_id: snapshot.streamId,
    last_updated: lastUpdated,
    runtime_state: {
      version: "1.0.0",
      last_updated: lastUpdated,
      threads: snapshot.threadRuntime
        .map((record) => toThreadMetadata(record, threadById.get(record.threadId)?.promptPath))
        .sort((left, right) => compareIds(left.threadId, right.threadId))
        .map((record) => ({
          ...record,
          sessions: [...record.sessions].sort((left: SessionRecord, right: SessionRecord) => {
            const startedAtOrder = compareOptionalStrings(left.startedAt, right.startedAt)
            if (startedAtOrder !== 0) return startedAtOrder
            return compareIds(left.sessionId, right.sessionId)
          }),
        })),
      batches: Object.fromEntries(
        snapshot.batchRuns
          .map((batchRun) => [batchRun.batchId, batchRun] as const)
          .sort(([leftBatchId], [rightBatchId]) => compareIds(leftBatchId, rightBatchId)),
      ),
      supervision: snapshot.supervision,
    },
    ...(runtimeSummary ? { runtime_summary: runtimeSummary } : {}),
    tasks: snapshot.hierarchy.tasks
      .map((task) => {
        const thread = threadById.get(task.threadId)
        const batch = batchById.get(task.batchId)
        const stage = stageById.get(task.stageId)

        if (!thread || !batch || !stage) {
          throw new Error(`Structured hierarchy is incomplete for task ${task.id}`)
        }

        return {
          id: task.id,
          name: task.name,
          thread_name: thread.name,
          batch_name: batch.name,
          stage_name: stage.name,
          status: task.status,
          created_at: task.createdAt,
          updated_at: task.updatedAt,
          ...(task.breadcrumb ? { breadcrumb: task.breadcrumb } : {}),
          ...(task.report ? { report: task.report } : {}),
          ...(task.assignedAgent ? { assigned_agent: task.assignedAgent } : {}),
        }
      })
      .sort((left, right) => compareIds(left.id, right.id)),
  }
}

export interface RebuildCompatibilityProjectionResult {
  outputRoot: string
  indexPath?: string
  tasksPaths: string[]
}

export function rebuildCompatibilityProjectionFromSqlite(args: {
  repoRoot: string
  streamId?: string
  outputRoot?: string
}): RebuildCompatibilityProjectionResult {
  const workspaceState = loadSqliteStructuredStorageWorkspaceState(args.repoRoot)
  if (!workspaceState) {
    throw new Error("No canonical sqlite workspace state found. Initialize or hydrate sqlite first.")
  }

  const workspaceSnapshot = createStructuredStorageParitySnapshot({ workspace: workspaceState }).workspace
  const outputRoot = args.outputRoot ?? args.repoRoot
  const outputWorkDir = getWorkDir(outputRoot)
  const resolvedStream = args.streamId
    ? workspaceSnapshot.workstreams.find((stream) =>
        args.streamId === "current"
          ? stream.id === workspaceSnapshot.currentStreamId
          : stream.id === args.streamId || stream.name === args.streamId,
      )
    : undefined
  const selectedStreamIds = resolvedStream
    ? [resolvedStream.id]
    : args.streamId
    ? []
    : workspaceSnapshot.workstreams.map((stream) => stream.id)

  if (args.streamId && selectedStreamIds.length === 0) {
    throw new Error(`Workstream not found in canonical sqlite workspace state: ${args.streamId}`)
  }

  const workstreamStatesById = new Map<string, StructuredStorageWorkstreamState>()
  for (const stream of workspaceSnapshot.workstreams) {
    const workstreamState = loadSqliteStructuredStorageWorkstreamState(args.repoRoot, stream.id, {
      normalizeIds: false,
    })
    if (workstreamState) {
      workstreamStatesById.set(stream.id, workstreamState)
    }
  }

  mkdirSync(outputWorkDir, { recursive: true })

  const shouldWriteIndex = !args.streamId
  const indexPath = shouldWriteIndex ? join(outputWorkDir, "index.json") : undefined
  if (indexPath) {
    atomicWriteFile(
      indexPath,
      JSON.stringify(
        createCompatibilityIndexProjection({
          workspaceState: workspaceSnapshot,
          workstreamStatesById,
        }),
        null,
        2,
      ),
    )
  }

  const tasksPaths: string[] = []
  for (const streamId of selectedStreamIds) {
    const workstreamState = workstreamStatesById.get(streamId)
    if (!workstreamState) {
      throw new Error(`No canonical sqlite workstream state found for ${streamId}`)
    }

    const streamDir = join(outputWorkDir, streamId)
    mkdirSync(streamDir, { recursive: true })
    const tasksPath = join(streamDir, "tasks.json")
    atomicWriteFile(tasksPath, JSON.stringify(createCompatibilityTasksProjection(workstreamState), null, 2))
    tasksPaths.push(tasksPath)
  }

  return {
    outputRoot,
    indexPath,
    tasksPaths,
  }
}
