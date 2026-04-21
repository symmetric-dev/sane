import { createEmptySupervisorState } from "./supervisor-state.ts"
import {
  normalizeCanonicalBatchIdOrFallback,
  normalizeCanonicalStageIdOrFallback,
  normalizePersistedBatchStatus,
  normalizePersistedThreadMetadata,
} from "./stage-id.ts"
import type {
  ApprovalMetadata,
  ApprovalStatus,
  GeneratedBy,
  PersistedBatchStatusFile,
  PlanningSession,
  SessionEstimate,
  SessionRecord,
  StreamMetadata,
  StreamStatus,
  SupervisorStateFile,
  TaskStatus,
  ThreadSynthesis,
} from "./types.ts"

/**
 * Adapter-facing workstream catalog record.
 *
 * This is intentionally document-light: it keeps the workstream storage root
 * and compatibility metadata needed by current workflows, while leaving
 * markdown/artifact content out of the first structured adapter boundary.
 */
export interface StructuredStorageWorkstreamRecord {
  id: string
  name: string
  order: number
  size: StreamMetadata["size"]
  createdAt: string
  updatedAt: string
  storageRoot: string
  manualStatus?: StreamStatus
  currentBatch?: string
  generatedBy: GeneratedBy
  sessionEstimated: SessionEstimate
  files?: string[]
  planningSession?: PlanningSession
  github?: StreamMetadata["github"]
}

/**
 * Workspace-level structured storage state.
 */
export interface StructuredStorageWorkspaceState {
  currentStreamId?: string
  workstreams: StructuredStorageWorkstreamRecord[]
}

export interface StructuredStageRecord {
  id: string
  number: number
  name: string
}

export interface StructuredBatchRecord {
  id: string
  stageId: string
  number: number
  name: string
}

export interface StructuredThreadRecord {
  id: string
  stageId: string
  batchId: string
  number: number
  name: string
  promptPath?: string
}

export interface StructuredTaskRecord {
  id: string
  stageId: string
  batchId: string
  threadId: string
  number: number
  name: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  breadcrumb?: string
  report?: string
  assignedAgent?: string
}

/**
 * Canonical hierarchy slice for a workstream's structured state.
 */
export interface StructuredWorkstreamHierarchy {
  stages: StructuredStageRecord[]
  batches: StructuredBatchRecord[]
  threads: StructuredThreadRecord[]
  tasks: StructuredTaskRecord[]
}

/**
 * Runtime-only thread state kept separate from the static hierarchy rows.
 */
export interface StructuredThreadRuntimeRecord {
  threadId: string
  sessions: SessionRecord[]
  currentSessionId?: string
  opencodeSessionId?: string
  workingAgentSessionId?: string
  synthesisOutput?: string
  synthesis?: ThreadSynthesis
}

export type StructuredApprovalScope = "plan" | "tasks" | "stage"

/**
 * Scope-keyed approval record used by the adapter boundary.
 */
export interface StructuredApprovalRecord {
  streamId: string
  scope: StructuredApprovalScope
  stageId?: string
  status: ApprovalStatus
  approvedAt?: string
  approvedBy?: string
  revokedAt?: string
  revokedReason?: string
  planHash?: string
  taskCount?: number
  commitSha?: string
}

/**
 * Full structured state for one workstream.
 *
 * This groups the workflow-critical structured state that will be migrated
 * behind storage adapters. Document bodies and artifact catalogs remain out of
 * scope; only the workstream root lives in the workspace catalog record.
 */
export interface StructuredStorageWorkstreamState {
  streamId: string
  hierarchy: StructuredWorkstreamHierarchy
  approvals: StructuredApprovalRecord[]
  threadRuntime: StructuredThreadRuntimeRecord[]
  batchRuns: PersistedBatchStatusFile[]
  supervision: SupervisorStateFile
}

/**
 * Deterministically ordered snapshot shape for future adapter parity checks.
 */
export interface StructuredStorageParitySnapshot {
  workspace: StructuredStorageWorkspaceState
  workstream?: StructuredStorageWorkstreamState
}

/**
 * Minimal structured-storage adapter surface.
 *
 * The boundary stays intentionally small:
 * - workspace catalog + current-stream selection
 * - per-workstream structured state snapshot
 * - atomic modify hook for workflow-critical mutations
 *
 * Specific operations like task updates, thread metadata writes, approval
 * persistence, batch-run persistence, and supervision persistence can all be
 * expressed as targeted mutations over the workstream snapshot.
 */
export interface StructuredStorageStateAdapter {
  readonly kind: string

  loadWorkspaceState(repoRoot: string): Promise<StructuredStorageWorkspaceState>

  replaceWorkspaceState(
    repoRoot: string,
    workspaceState: StructuredStorageWorkspaceState,
  ): Promise<void>

  modifyWorkspaceState<T>(
    repoRoot: string,
    fn: (workspaceState: StructuredStorageWorkspaceState) => T | Promise<T>,
  ): Promise<T>

  loadWorkstreamState(
    repoRoot: string,
    streamId: string,
  ): Promise<StructuredStorageWorkstreamState | null>

  replaceWorkstreamState(
    repoRoot: string,
    workstreamState: StructuredStorageWorkstreamState,
  ): Promise<void>

  modifyWorkstreamState<T>(
    repoRoot: string,
    streamId: string,
    fn: (workstreamState: StructuredStorageWorkstreamState) => T | Promise<T>,
  ): Promise<T>
}

export interface StructuredTaskMutation {
  taskId: string
  status?: TaskStatus
  breadcrumb?: string
  report?: string
  assignedAgent?: string
  updatedAt?: string
}

const APPROVAL_SCOPE_ORDER: Record<StructuredApprovalScope, number> = {
  plan: 0,
  tasks: 1,
  stage: 2,
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function compareOptionalStrings(left?: string, right?: string): number {
  if (left === right) return 0
  if (!left) return -1
  if (!right) return 1
  return compareStrings(left, right)
}

function cloneSessionRecord(session: SessionRecord): SessionRecord {
  return {
    ...session,
    ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
  }
}

function cloneStructuredThreadRuntimeRecord(
  record: StructuredThreadRuntimeRecord,
): StructuredThreadRuntimeRecord {
  return {
    threadId: record.threadId,
    sessions: record.sessions.map(cloneSessionRecord),
    ...(record.currentSessionId ? { currentSessionId: record.currentSessionId } : {}),
    ...(record.opencodeSessionId ? { opencodeSessionId: record.opencodeSessionId } : {}),
    ...(record.workingAgentSessionId
      ? { workingAgentSessionId: record.workingAgentSessionId }
      : {}),
    ...(record.synthesisOutput ? { synthesisOutput: record.synthesisOutput } : {}),
    ...(record.synthesis ? { synthesis: { ...record.synthesis } } : {}),
  }
}

function cloneBatchRun(batchRun: PersistedBatchStatusFile): PersistedBatchStatusFile {
  return {
    ...batchRun,
    summary: { ...batchRun.summary },
    threads: batchRun.threads.map((thread) => ({ ...thread })),
  }
}

function cloneSupervisorState(supervision: SupervisorStateFile): SupervisorStateFile {
  return {
    version: supervision.version,
    stream_id: supervision.stream_id,
    last_updated: supervision.last_updated,
    ...(supervision.active_run_id ? { active_run_id: supervision.active_run_id } : {}),
    ...(supervision.current_branch_supervision
      ? { current_branch_supervision: { ...supervision.current_branch_supervision } }
      : {}),
    runs: supervision.runs.map((run) => ({
      ...run,
      issueSummaryIds: [...run.issueSummaryIds].sort(compareStrings),
      escalationIds: [...run.escalationIds].sort(compareStrings),
    })),
    checkpoint_pointers: supervision.checkpoint_pointers.map((pointer) => ({
      ...pointer,
      ...(pointer.breakpointSelection
        ? {
            breakpointSelection: {
              ...pointer.breakpointSelection,
              configuredTags: [...pointer.breakpointSelection.configuredTags].sort(compareStrings),
            },
          }
        : {}),
    })),
    branch_sessions: supervision.branch_sessions.map((session) => ({
      ...session,
      ...(session.scope ? { scope: { ...session.scope } } : {}),
      ...(session.breakpointSelection
        ? {
            breakpointSelection: {
              ...session.breakpointSelection,
              configuredTags: [...session.breakpointSelection.configuredTags].sort(compareStrings),
            },
          }
        : {}),
      ...(session.supervisionProgress
        ? { supervisionProgress: { ...session.supervisionProgress } }
        : {}),
    })),
    reviewed_batches: supervision.reviewed_batches.map((review) => ({
      ...review,
      threadIds: [...review.threadIds].sort(compareStrings),
      issueSummaryIds: [...review.issueSummaryIds].sort(compareStrings),
    })),
    issue_summaries: supervision.issue_summaries.map((issue) => ({ ...issue })),
    fix_cycles: supervision.fix_cycles.map((cycle) => ({
      ...cycle,
      issueSummaryIds: [...cycle.issueSummaryIds].sort(compareStrings),
    })),
    escalations: supervision.escalations.map((escalation) => ({ ...escalation })),
    stage_stops: supervision.stage_stops.map((stop) => ({ ...stop })),
  }
}

function cloneApprovalRecord(record: StructuredApprovalRecord): StructuredApprovalRecord {
  if (record.scope !== "stage") {
    return { ...record }
  }

  return {
    ...record,
    ...(record.stageId
      ? { stageId: normalizeCanonicalStageIdOrFallback(record.stageId) ?? record.stageId }
      : {}),
  }
}

function sortApprovalRecords(records: StructuredApprovalRecord[]): StructuredApprovalRecord[] {
  return records.sort((left, right) => {
    const scopeOrder = APPROVAL_SCOPE_ORDER[left.scope] - APPROVAL_SCOPE_ORDER[right.scope]
    if (scopeOrder !== 0) return scopeOrder
    return compareOptionalStrings(left.stageId, right.stageId)
  })
}

export function createEmptyStructuredStorageWorkspaceState(): StructuredStorageWorkspaceState {
  return {
    workstreams: [],
  }
}

export function createEmptyStructuredStorageWorkstreamState(
  streamId: string,
): StructuredStorageWorkstreamState {
  return {
    streamId,
    hierarchy: {
      stages: [],
      batches: [],
      threads: [],
      tasks: [],
    },
    approvals: [],
    threadRuntime: [],
    batchRuns: [],
    supervision: createEmptySupervisorState(streamId),
  }
}

export function createStructuredStorageWorkstreamRecord(
  stream: StreamMetadata,
): StructuredStorageWorkstreamRecord {
  return {
    id: stream.id,
    name: stream.name,
    order: stream.order,
    size: stream.size,
    createdAt: stream.created_at,
    updatedAt: stream.updated_at,
    storageRoot: stream.path,
    ...(stream.status ? { manualStatus: stream.status } : {}),
    ...(stream.current_batch
      ? { currentBatch: normalizeCanonicalBatchIdOrFallback(stream.current_batch) ?? stream.current_batch }
      : {}),
    generatedBy: stream.generated_by,
    sessionEstimated: stream.session_estimated,
    ...(stream.files ? { files: [...stream.files] } : {}),
    ...(stream.planningSession ? { planningSession: { ...stream.planningSession } } : {}),
    ...(stream.github ? { github: { ...stream.github } } : {}),
  }
}

export function createStreamMetadataFromStructuredStorageRecord(args: {
  record: StructuredStorageWorkstreamRecord
  approval?: ApprovalMetadata
}): StreamMetadata {
  const { record, approval } = args
  const normalizedCurrentBatch =
    normalizeCanonicalBatchIdOrFallback(record.currentBatch) ?? record.currentBatch

  return {
    id: record.id,
    name: record.name,
    order: record.order,
    ...(record.manualStatus ? { status: record.manualStatus } : {}),
    ...(approval ? { approval } : {}),
    size: record.size,
    session_estimated: record.sessionEstimated,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    path: record.storageRoot,
    generated_by: record.generatedBy,
    ...(record.files ? { files: [...record.files] } : {}),
    ...(normalizedCurrentBatch ? { current_batch: normalizedCurrentBatch } : {}),
    ...(record.planningSession ? { planningSession: { ...record.planningSession } } : {}),
    ...(record.github ? { github: { ...record.github } } : {}),
  }
}

export function approvalMetadataToStructuredApprovalRecords(
  streamId: string,
  approval?: ApprovalMetadata,
): StructuredApprovalRecord[] {
  if (!approval) {
    return []
  }

  const records: StructuredApprovalRecord[] = [
    {
      streamId,
      scope: "plan",
      status: approval.status,
      ...(approval.approved_at ? { approvedAt: approval.approved_at } : {}),
      ...(approval.approved_by ? { approvedBy: approval.approved_by } : {}),
      ...(approval.revoked_at ? { revokedAt: approval.revoked_at } : {}),
      ...(approval.revoked_reason ? { revokedReason: approval.revoked_reason } : {}),
      ...(approval.plan_hash ? { planHash: approval.plan_hash } : {}),
    },
  ]

  if (approval.tasks) {
    records.push({
      streamId,
      scope: "tasks",
      status: approval.tasks.status,
      ...(approval.tasks.approved_at ? { approvedAt: approval.tasks.approved_at } : {}),
      ...(typeof approval.tasks.task_count === "number"
        ? { taskCount: approval.tasks.task_count }
        : {}),
      ...(approval.tasks.revoked_at ? { revokedAt: approval.tasks.revoked_at } : {}),
      ...(approval.tasks.revoked_reason ? { revokedReason: approval.tasks.revoked_reason } : {}),
    })
  }

  for (const [stageNumber, stageApproval] of Object.entries(approval.stages ?? {})) {
    records.push({
      streamId,
      scope: "stage",
      stageId: stageNumber.padStart(2, "0"),
      status: stageApproval.status,
      ...(stageApproval.approved_at ? { approvedAt: stageApproval.approved_at } : {}),
      ...(stageApproval.approved_by ? { approvedBy: stageApproval.approved_by } : {}),
      ...(stageApproval.revoked_at ? { revokedAt: stageApproval.revoked_at } : {}),
      ...(stageApproval.revoked_reason ? { revokedReason: stageApproval.revoked_reason } : {}),
      ...(stageApproval.commit_sha ? { commitSha: stageApproval.commit_sha } : {}),
    })
  }

  return sortApprovalRecords(records)
}

export function structuredApprovalRecordsToApprovalMetadata(
  records: StructuredApprovalRecord[],
): ApprovalMetadata | undefined {
  if (records.length === 0) {
    return undefined
  }

  const planRecord = records.find((record) => record.scope === "plan")
  const tasksRecord = records.find((record) => record.scope === "tasks")
  const stageRecords = records.filter((record) => record.scope === "stage")

  const approval: ApprovalMetadata = {
    status: planRecord?.status ?? "draft",
    ...(planRecord?.approvedAt ? { approved_at: planRecord.approvedAt } : {}),
    ...(planRecord?.approvedBy ? { approved_by: planRecord.approvedBy } : {}),
    ...(planRecord?.revokedAt ? { revoked_at: planRecord.revokedAt } : {}),
    ...(planRecord?.revokedReason ? { revoked_reason: planRecord.revokedReason } : {}),
    ...(planRecord?.planHash ? { plan_hash: planRecord.planHash } : {}),
  }

  if (tasksRecord) {
    approval.tasks = {
      status: tasksRecord.status,
      ...(tasksRecord.approvedAt ? { approved_at: tasksRecord.approvedAt } : {}),
      ...(typeof tasksRecord.taskCount === "number" ? { task_count: tasksRecord.taskCount } : {}),
      ...(tasksRecord.revokedAt ? { revoked_at: tasksRecord.revokedAt } : {}),
      ...(tasksRecord.revokedReason ? { revoked_reason: tasksRecord.revokedReason } : {}),
    }
  }

  if (stageRecords.length > 0) {
    approval.stages = {}
    for (const record of stageRecords) {
      if (!record.stageId) {
        continue
      }

      const stageNumber = Number.parseInt(record.stageId, 10)
      if (!Number.isFinite(stageNumber)) {
        continue
      }

      approval.stages[stageNumber] = {
        status: record.status,
        ...(record.approvedAt ? { approved_at: record.approvedAt } : {}),
        ...(record.approvedBy ? { approved_by: record.approvedBy } : {}),
        ...(record.revokedAt ? { revoked_at: record.revokedAt } : {}),
        ...(record.revokedReason ? { revoked_reason: record.revokedReason } : {}),
        ...(record.commitSha ? { commit_sha: record.commitSha } : {}),
      }
    }
  }

  return approval
}

export function updateStructuredTask(
  state: StructuredStorageWorkstreamState,
  mutation: StructuredTaskMutation,
): StructuredTaskRecord | null {
  const task = state.hierarchy.tasks.find((candidate) => candidate.id === mutation.taskId)
  if (!task) {
    return null
  }

  if (mutation.status !== undefined) {
    task.status = mutation.status
  }
  if (mutation.breadcrumb !== undefined) {
    task.breadcrumb = mutation.breadcrumb
  }
  if (mutation.report !== undefined) {
    task.report = mutation.report
  }
  if (mutation.assignedAgent !== undefined) {
    task.assignedAgent = mutation.assignedAgent
  }
  task.updatedAt = mutation.updatedAt ?? new Date().toISOString()

  return task
}

export function upsertStructuredThreadRuntime(
  state: StructuredStorageWorkstreamState,
  record: StructuredThreadRuntimeRecord,
): StructuredThreadRuntimeRecord {
  const next = cloneStructuredThreadRuntimeRecord(normalizePersistedThreadMetadata(record))
  const existingIndex = state.threadRuntime.findIndex(
    (candidate) =>
      (normalizePersistedThreadMetadata(candidate).threadId ?? candidate.threadId) === next.threadId,
  )

  if (existingIndex === -1) {
    state.threadRuntime.push(next)
  } else {
    state.threadRuntime[existingIndex] = next
  }

  state.threadRuntime.sort((left, right) => compareStrings(left.threadId, right.threadId))
  return next
}

export function replaceStructuredApprovals(
  state: StructuredStorageWorkstreamState,
  approvals: StructuredApprovalRecord[],
): StructuredApprovalRecord[] {
  state.approvals = sortApprovalRecords(approvals.map(cloneApprovalRecord))
  return state.approvals
}

export function upsertStructuredBatchRun(
  state: StructuredStorageWorkstreamState,
  batchRun: PersistedBatchStatusFile,
): PersistedBatchStatusFile {
  const next = cloneBatchRun(normalizePersistedBatchStatus(batchRun))
  const existingIndex = state.batchRuns.findIndex(
    (candidate) =>
      (normalizePersistedBatchStatus(candidate).batchId ?? candidate.batchId) === next.batchId,
  )

  if (existingIndex === -1) {
    state.batchRuns.push(next)
  } else {
    state.batchRuns[existingIndex] = next
  }

  state.batchRuns.sort((left, right) => {
    const batchOrder = compareStrings(left.batchId, right.batchId)
    if (batchOrder !== 0) return batchOrder
    return compareStrings(left.runId, right.runId)
  })

  return next
}

export function replaceStructuredSupervisionState(
  state: StructuredStorageWorkstreamState,
  supervision: SupervisorStateFile,
): SupervisorStateFile {
  state.supervision = cloneSupervisorState(supervision)
  return state.supervision
}

export function createStructuredStorageParitySnapshot(args: {
  workspace: StructuredStorageWorkspaceState
  workstream?: StructuredStorageWorkstreamState | null
}): StructuredStorageParitySnapshot {
  const workspace: StructuredStorageWorkspaceState = {
    ...(args.workspace.currentStreamId ? { currentStreamId: args.workspace.currentStreamId } : {}),
    workstreams: args.workspace.workstreams
      .map((record) => ({
        ...record,
        generatedBy: { ...record.generatedBy },
        sessionEstimated: { ...record.sessionEstimated },
        ...(record.files ? { files: [...record.files].sort(compareStrings) } : {}),
        ...(record.planningSession ? { planningSession: { ...record.planningSession } } : {}),
        ...(record.github ? { github: { ...record.github } } : {}),
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
  }

  if (!args.workstream) {
    return { workspace }
  }

  const workstream: StructuredStorageWorkstreamState = {
    streamId: args.workstream.streamId,
    hierarchy: {
      stages: [...args.workstream.hierarchy.stages]
        .map((stage) => ({ ...stage }))
        .sort((left, right) => compareStrings(left.id, right.id)),
      batches: [...args.workstream.hierarchy.batches]
        .map((batch) => ({ ...batch }))
        .sort((left, right) => compareStrings(left.id, right.id)),
      threads: [...args.workstream.hierarchy.threads]
        .map((thread) => ({ ...thread }))
        .sort((left, right) => compareStrings(left.id, right.id)),
      tasks: [...args.workstream.hierarchy.tasks]
        .map((task) => ({ ...task }))
        .sort((left, right) => compareStrings(left.id, right.id)),
    },
    approvals: sortApprovalRecords(args.workstream.approvals.map(cloneApprovalRecord)),
    threadRuntime: args.workstream.threadRuntime
      .map(cloneStructuredThreadRuntimeRecord)
      .sort((left, right) => compareStrings(left.threadId, right.threadId))
      .map((record) => ({
        ...record,
        sessions: [...record.sessions].sort((left, right) => {
          const startedAtOrder = compareOptionalStrings(left.startedAt, right.startedAt)
          if (startedAtOrder !== 0) return startedAtOrder
          return compareStrings(left.sessionId, right.sessionId)
        }),
      })),
    batchRuns: args.workstream.batchRuns
      .map(cloneBatchRun)
      .sort((left, right) => {
        const batchOrder = compareStrings(left.batchId, right.batchId)
        if (batchOrder !== 0) return batchOrder
        return compareStrings(left.runId, right.runId)
      })
      .map((batchRun) => ({
        ...batchRun,
        threads: [...batchRun.threads].sort((left, right) => compareStrings(left.threadId, right.threadId)),
      })),
    supervision: cloneSupervisorState(args.workstream.supervision),
  }

  workstream.supervision.runs.sort((left, right) => compareStrings(left.runId, right.runId))
  workstream.supervision.checkpoint_pointers.sort((left, right) => {
    const rootOrder = compareStrings(left.rootSessionId, right.rootSessionId)
    if (rootOrder !== 0) return rootOrder
    return left.checkpointMessageIndex - right.checkpointMessageIndex
  })
  workstream.supervision.branch_sessions.sort((left, right) =>
    compareStrings(left.branchSessionId, right.branchSessionId),
  )
  workstream.supervision.reviewed_batches.sort((left, right) =>
    compareStrings(left.reviewId, right.reviewId),
  )
  workstream.supervision.issue_summaries.sort((left, right) =>
    compareStrings(left.summaryId, right.summaryId),
  )
  workstream.supervision.fix_cycles.sort((left, right) => compareStrings(left.cycleId, right.cycleId))
  workstream.supervision.escalations.sort((left, right) =>
    compareStrings(left.escalationId, right.escalationId),
  )
  workstream.supervision.stage_stops.sort((left, right) => compareStrings(left.stopId, right.stopId))

  return {
    workspace,
    workstream,
  }
}
