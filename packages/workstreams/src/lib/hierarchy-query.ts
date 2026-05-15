import { existsSync } from "fs"

import { loadStructuredWorkstreamStateSync } from "./storage-adapter.ts"
import { getSqliteStructuredStoragePath } from "./sqlite-storage.ts"
import {
  approvalMetadataToStructuredApprovalRecords,
  structuredApprovalRecordsToApprovalMetadata,
} from "./structured-storage.ts"
import type {
  StructuredApprovalRecord,
  StructuredBatchRecord,
  StructuredStageRecord,
  StructuredTaskRecord,
  StructuredThreadRecord,
} from "./structured-storage.ts"
import type { ApprovalMetadata, Task, TaskStatus } from "./types.ts"
import { Database } from "bun:sqlite"
import { loadCanonicalWorkspaceState, resolveWorkspaceStateStreamRecord } from "./workspace-read-model.ts"
import { loadIndex } from "./index.ts"
import {
  inferCanonicalBatchIdFromTaskId,
  inferCanonicalStageIdFromTaskId,
  inferCanonicalThreadIdFromTaskId,
} from "./stage-id.ts"

export interface HierarchyTaskQueryRecord extends StructuredTaskRecord {
  stageName: string
  batchName: string
  threadName: string
}

export interface WorkstreamHierarchyQueryResult {
  source: "sqlite" | "compatibility"
  streamId: string
  stages: StructuredStageRecord[]
  batches: StructuredBatchRecord[]
  threads: StructuredThreadRecord[]
  tasks: HierarchyTaskQueryRecord[]
}

export interface WorkstreamApprovalQueryResult {
  source: "sqlite" | "compatibility"
  streamId: string
  approvals: StructuredApprovalRecord[]
  approval?: ApprovalMetadata
}

export interface HierarchyThreadQueryRecord extends StructuredThreadRecord {
  threadId: string
  stageName: string
  batchName: string
  threadName: string
  aggregateStatus: TaskStatus
  taskCount: number
  assignedAgent?: string
  breadcrumb?: string
  report?: string
  representativeTaskId?: string
}

function getLatestThreadValue(
  tasks: HierarchyTaskQueryRecord[],
  pick: (task: HierarchyTaskQueryRecord) => string | undefined,
): string | undefined {
  const sorted = [...tasks].sort((left, right) => {
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt.localeCompare(left.updatedAt)
    }
    return compareIds(right.id, left.id)
  })

  return sorted.map(pick).find((value) => value !== undefined && value !== "")
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function toLegacyTask(record: HierarchyTaskQueryRecord): Task {
  return {
    id: record.id,
    name: record.name,
    stage_name: record.stageName,
    batch_name: record.batchName,
    thread_name: record.threadName,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    status: record.status,
    ...(record.breadcrumb ? { breadcrumb: record.breadcrumb } : {}),
    ...(record.report ? { report: record.report } : {}),
    ...(record.assignedAgent ? { assigned_agent: record.assignedAgent } : {}),
  }
}

function aggregateTaskStatuses(tasks: Pick<HierarchyTaskQueryRecord, "status">[]): TaskStatus {
  if (tasks.length === 0) return "pending"
  if (tasks.some((task) => task.status === "blocked")) return "blocked"
  if (tasks.some((task) => task.status === "in_progress")) return "in_progress"
  if (tasks.some((task) => task.status === "pending")) return "pending"
  return "completed"
}

function buildThreadQueryRecords(query: WorkstreamHierarchyQueryResult): HierarchyThreadQueryRecord[] {
  const stageById = new Map(query.stages.map((stage) => [stage.id, stage] as const))
  const batchById = new Map(query.batches.map((batch) => [batch.id, batch] as const))
  const tasksByThreadId = new Map<string, HierarchyTaskQueryRecord[]>()

  for (const task of query.tasks) {
    const existing = tasksByThreadId.get(task.threadId)
    if (existing) {
      existing.push(task)
    } else {
      tasksByThreadId.set(task.threadId, [task])
    }
  }

  const threadRecords = new Map<string, HierarchyThreadQueryRecord>()

  for (const thread of query.threads) {
    const threadTasks = tasksByThreadId.get(thread.id) ?? []
    const representativeTask = threadTasks[0]
    const assignedAgent = getLatestThreadValue(threadTasks, (task) => task.assignedAgent)
    const breadcrumb = getLatestThreadValue(threadTasks, (task) => task.breadcrumb)
    const report = getLatestThreadValue(threadTasks, (task) => task.report)
    threadRecords.set(thread.id, {
      ...thread,
      threadId: thread.id,
      stageName: stageById.get(thread.stageId)?.name ?? `Stage ${thread.stageId}`,
      batchName: batchById.get(thread.batchId)?.name ?? `Batch ${thread.batchId}`,
      threadName: thread.name,
      aggregateStatus: aggregateTaskStatuses(threadTasks),
      taskCount: threadTasks.length,
      ...(assignedAgent ? { assignedAgent } : {}),
      ...(breadcrumb ? { breadcrumb } : {}),
      ...(report ? { report } : {}),
      ...(representativeTask ? { representativeTaskId: representativeTask.id } : {}),
    })
  }

  for (const task of query.tasks) {
    if (threadRecords.has(task.threadId)) {
      continue
    }

    const [stageId = task.stageId, batchNumber = "00", threadNumber = "00"] = task.threadId.split(".")
    const batchId = `${stageId}.${batchNumber}`
    const threadTasks = tasksByThreadId.get(task.threadId) ?? [task]
    const assignedAgent = getLatestThreadValue(threadTasks, (threadTask) => threadTask.assignedAgent)
    const breadcrumb = getLatestThreadValue(threadTasks, (threadTask) => threadTask.breadcrumb)
    const report = getLatestThreadValue(threadTasks, (threadTask) => threadTask.report)
    threadRecords.set(task.threadId, {
      id: task.threadId,
      threadId: task.threadId,
      stageId,
      batchId,
      number: Number.parseInt(threadNumber, 10) || 0,
      name: task.threadName,
      stageName: task.stageName,
      batchName: task.batchName,
      threadName: task.threadName,
      aggregateStatus: aggregateTaskStatuses(threadTasks),
      taskCount: threadTasks.length,
      ...(assignedAgent ? { assignedAgent } : {}),
      ...(breadcrumb ? { breadcrumb } : {}),
      ...(report ? { report } : {}),
      representativeTaskId: threadTasks[0]?.id ?? task.id,
    })
  }

  return [...threadRecords.values()].sort((left, right) => compareIds(left.threadId, right.threadId))
}

function loadCompatibilityHierarchy(repoRoot: string, streamId: string): WorkstreamHierarchyQueryResult {
  const state = loadStructuredWorkstreamStateSync(repoRoot, streamId)

  if (!state) {
    return {
      source: "compatibility",
      streamId,
      stages: [],
      batches: [],
      threads: [],
      tasks: [],
    }
  }

  const stageById = new Map(state.hierarchy.stages.map((stage) => [stage.id, stage] as const))
  const batchById = new Map(state.hierarchy.batches.map((batch) => [batch.id, batch] as const))
  const threadById = new Map(state.hierarchy.threads.map((thread) => [thread.id, thread] as const))

  return {
    source: "compatibility",
    streamId,
    stages: [...state.hierarchy.stages].sort((left, right) => compareIds(left.id, right.id)),
    batches: [...state.hierarchy.batches].sort((left, right) => compareIds(left.id, right.id)),
    threads: [...state.hierarchy.threads].sort((left, right) => compareIds(left.id, right.id)),
    tasks: [...state.hierarchy.tasks]
      .sort((left, right) => compareIds(left.id, right.id))
      .map((task) => ({
        ...task,
        stageName: stageById.get(task.stageId)?.name ?? `Stage ${task.stageId}`,
        batchName: batchById.get(task.batchId)?.name ?? `Batch ${task.batchId}`,
        threadName: threadById.get(task.threadId)?.name ?? `Thread ${task.threadId}`,
      })),
  }
}

function loadSqliteHierarchy(repoRoot: string, streamId: string): WorkstreamHierarchyQueryResult {
  const database = new Database(getSqliteStructuredStoragePath(repoRoot), { readonly: true })

  try {
    const stages = database
      .query<StructuredStageRecord, [string]>(
        `SELECT stage_id as id, stage_number as number, name
         FROM stages
         WHERE stream_id = ?
         ORDER BY stage_number, stage_id`,
      )
      .all(streamId)

    const batches = database
      .query<StructuredBatchRecord, [string]>(
        `SELECT batch_id as id, stage_id as stageId, batch_number as number, name
         FROM batches
         WHERE stream_id = ?
         ORDER BY stage_id, batch_number, batch_id`,
      )
      .all(streamId)

    const threads = database
      .query<StructuredThreadRecord, [string]>(
        `SELECT thread_id as id, stage_id as stageId, batch_id as batchId, thread_number as number, name, prompt_path as promptPath
         FROM threads
         WHERE stream_id = ?
         ORDER BY batch_id, thread_number, thread_id`,
      )
      .all(streamId)

    const tasks = database
      .query<HierarchyTaskQueryRecord, [string]>(
        `SELECT
           tasks.task_id as id,
           tasks.stage_id as stageId,
           tasks.batch_id as batchId,
           tasks.thread_id as threadId,
           tasks.task_number as number,
           tasks.name as name,
           tasks.status as status,
           tasks.created_at as createdAt,
           tasks.updated_at as updatedAt,
           tasks.breadcrumb as breadcrumb,
           tasks.report as report,
           tasks.assigned_agent as assignedAgent,
           stages.name as stageName,
           batches.name as batchName,
           threads.name as threadName
         FROM tasks
         INNER JOIN stages
           ON stages.stream_id = tasks.stream_id AND stages.stage_id = tasks.stage_id
         INNER JOIN batches
           ON batches.stream_id = tasks.stream_id AND batches.batch_id = tasks.batch_id
         INNER JOIN threads
           ON threads.stream_id = tasks.stream_id AND threads.thread_id = tasks.thread_id
         WHERE tasks.stream_id = ?
         ORDER BY tasks.stage_id, tasks.batch_id, tasks.thread_id, tasks.task_number, tasks.task_id`,
      )
      .all(streamId)

    const mismatchedCompatibilityAnchors = database
      .query<{ threadId: string; firstTaskId: string }, [string]>(
        `SELECT thread_id as threadId, first_task_id as firstTaskId
         FROM batch_run_threads
         WHERE stream_id = ?`,
      )
      .all(streamId)
      .filter(
        (record) =>
          inferCanonicalThreadIdFromTaskId(record.firstTaskId) !== undefined &&
          inferCanonicalThreadIdFromTaskId(record.firstTaskId) !== record.threadId,
      )

    const mismatchedTaskIds = new Set(mismatchedCompatibilityAnchors.map((record) => record.firstTaskId))
    const filteredTasks = tasks.filter((task) => !mismatchedTaskIds.has(task.id))

    const danglingMismatchedThreadIds = new Set(
      mismatchedCompatibilityAnchors
        .map((record) => inferCanonicalThreadIdFromTaskId(record.firstTaskId))
        .filter(
          (threadId): threadId is string =>
            typeof threadId === "string" && !filteredTasks.some((task) => task.threadId === threadId),
        ),
    )

    const filteredThreads = threads.filter((thread) => !danglingMismatchedThreadIds.has(thread.id))

    const danglingMismatchedBatchIds = new Set(
      mismatchedCompatibilityAnchors
        .map((record) => inferCanonicalBatchIdFromTaskId(record.firstTaskId))
        .filter(
          (batchId): batchId is string =>
            typeof batchId === "string" && !filteredThreads.some((thread) => thread.batchId === batchId),
        ),
    )
    const filteredBatches = batches.filter((batch) => !danglingMismatchedBatchIds.has(batch.id))

    const danglingMismatchedStageIds = new Set(
      mismatchedCompatibilityAnchors
        .map((record) => inferCanonicalStageIdFromTaskId(record.firstTaskId))
        .filter(
          (stageId): stageId is string =>
            typeof stageId === "string" && !filteredBatches.some((batch) => batch.stageId === stageId),
        ),
    )
    const filteredStages = stages.filter((stage) => !danglingMismatchedStageIds.has(stage.id))

    return {
      source: "sqlite",
      streamId,
      stages: filteredStages,
      batches: filteredBatches,
      threads: filteredThreads,
      tasks: filteredTasks,
    }
  } finally {
    database.close()
  }
}

function resolveStreamIdForQuery(repoRoot: string, streamIdOrName: string): string | null {
  try {
    const workspaceState = loadCanonicalWorkspaceState(repoRoot)
    const record = resolveWorkspaceStateStreamRecord(workspaceState, streamIdOrName)
    if (record) {
      return record.id
    }
  } catch {
    // Fall through to legacy compatibility lookup.
  }

  try {
    const stream = loadIndex(repoRoot).streams.find(
      (candidate) => candidate.id === streamIdOrName || candidate.name === streamIdOrName,
    )
    return stream?.id ?? null
  } catch {
    return null
  }
}

function loadCompatibilityApprovals(
  repoRoot: string,
  streamIdOrName: string,
): WorkstreamApprovalQueryResult {
  let stream
  try {
    const index = loadIndex(repoRoot)
    stream = index.streams.find(
      (candidate) => candidate.id === streamIdOrName || candidate.name === streamIdOrName,
    )
  } catch {
    stream = undefined
  }
  const approvals = stream
    ? approvalMetadataToStructuredApprovalRecords(stream.id, stream.approval)
    : []

  return {
    source: "compatibility",
    streamId: stream?.id ?? streamIdOrName,
    approvals,
    approval: stream?.approval,
  }
}

function loadSqliteApprovals(repoRoot: string, streamId: string): WorkstreamApprovalQueryResult {
  const database = new Database(getSqliteStructuredStoragePath(repoRoot), { readonly: true })

  try {
    const approvals = database
      .query<StructuredApprovalRecord, [string]>(
        `SELECT
           stream_id as streamId,
           scope,
           stage_id as stageId,
           status,
           approved_at as approvedAt,
           approved_by as approvedBy,
           revoked_at as revokedAt,
           revoked_reason as revokedReason,
           plan_hash as planHash,
           task_count as taskCount,
           commit_sha as commitSha
         FROM approvals
         WHERE stream_id = ?
         ORDER BY
           CASE scope
             WHEN 'plan' THEN 0
             WHEN 'tasks' THEN 1
             WHEN 'stage' THEN 2
             ELSE 99
           END,
           stage_id`,
      )
      .all(streamId)

    return {
      source: "sqlite",
      streamId,
      approvals,
      approval: structuredApprovalRecordsToApprovalMetadata(approvals),
    }
  } finally {
    database.close()
  }
}

export function loadWorkstreamHierarchyQueryResult(
  repoRoot: string,
  streamId: string,
): WorkstreamHierarchyQueryResult {
  const sqlitePath = getSqliteStructuredStoragePath(repoRoot)
  if (existsSync(sqlitePath)) {
    const sqliteResult = loadSqliteHierarchy(repoRoot, streamId)
    if (
      sqliteResult.stages.length > 0 ||
      sqliteResult.batches.length > 0 ||
      sqliteResult.threads.length > 0 ||
      sqliteResult.tasks.length > 0
    ) {
      return sqliteResult
    }

    return loadCompatibilityHierarchy(repoRoot, streamId)
  }

  return loadCompatibilityHierarchy(repoRoot, streamId)
}

export function loadWorkstreamApprovalQueryResult(
  repoRoot: string,
  streamIdOrName: string,
): WorkstreamApprovalQueryResult {
  const streamId = resolveStreamIdForQuery(repoRoot, streamIdOrName)
  const sqlitePath = getSqliteStructuredStoragePath(repoRoot)

  if (streamId && existsSync(sqlitePath)) {
    const sqliteResult = loadSqliteApprovals(repoRoot, streamId)
    if (sqliteResult.approvals.length > 0) {
      return sqliteResult
    }
  }

  return loadCompatibilityApprovals(repoRoot, streamIdOrName)
}

export function queryTasksForWorkstream(
  repoRoot: string,
  streamId: string,
  status?: TaskStatus,
): Task[] {
  const tasks = loadWorkstreamHierarchyQueryResult(repoRoot, streamId).tasks.map(toLegacyTask)
  if (!status) {
    return tasks
  }

  return tasks.filter((task) => task.status === status)
}

export function queryTaskByIdForWorkstream(
  repoRoot: string,
  streamId: string,
  taskId: string,
): Task | null {
  return queryTasksForWorkstream(repoRoot, streamId).find((task) => task.id === taskId) ?? null
}

export function queryThreadsForWorkstream(
  repoRoot: string,
  streamId: string,
  status?: TaskStatus,
): HierarchyThreadQueryRecord[] {
  const threads = buildThreadQueryRecords(loadWorkstreamHierarchyQueryResult(repoRoot, streamId))
  if (!status) {
    return threads
  }

  return threads.filter((thread) => thread.aggregateStatus === status)
}

export function queryThreadByIdForWorkstream(
  repoRoot: string,
  streamId: string,
  threadId: string,
): HierarchyThreadQueryRecord | null {
  return queryThreadsForWorkstream(repoRoot, streamId).find((thread) => thread.threadId === threadId) ?? null
}
