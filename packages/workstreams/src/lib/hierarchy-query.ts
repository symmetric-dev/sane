import { existsSync } from "fs"

import { loadStructuredWorkstreamStateSync } from "./storage-adapter.ts"
import { getSqliteStructuredStoragePath } from "./sqlite-storage.ts"
import type {
  StructuredBatchRecord,
  StructuredStageRecord,
  StructuredTaskRecord,
  StructuredThreadRecord,
} from "./structured-storage.ts"
import type { Task, TaskStatus } from "./types.ts"
import { Database } from "bun:sqlite"

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

    return {
      source: "sqlite",
      streamId,
      stages,
      batches,
      threads,
      tasks,
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
