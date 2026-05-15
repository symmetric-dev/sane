import { createRuntimeSummaryFromWorkstreamState } from "./runtime-state.ts"
import { loadStructuredWorkstreamStateSync } from "./storage-adapter.ts"
import { structuredApprovalRecordsToApprovalMetadata } from "./structured-storage.ts"
import type {
  StructuredApprovalRecord,
  StructuredBatchRecord,
  StructuredStageRecord,
  StructuredThreadRecord,
} from "./structured-storage.ts"
import type { ApprovalMetadata, ExecutionItem, ExecutionStatus, WorkstreamRuntimeSummary } from "./types.ts"
import { loadCanonicalWorkspaceState, resolveWorkspaceStateStreamRecord } from "./workspace-read-model.ts"

export interface ExecutionItemQueryRecord extends ExecutionItem {
  stageName: string
  batchName: string
  threadName: string
}

export interface WorkstreamHierarchyQueryResult {
  streamId: string
  stages: StructuredStageRecord[]
  batches: StructuredBatchRecord[]
  threads: StructuredThreadRecord[]
  items: ExecutionItemQueryRecord[]
}

export interface WorkstreamApprovalQueryResult {
  streamId: string
  approvals: StructuredApprovalRecord[]
  approval?: ApprovalMetadata
}

export interface HierarchyThreadQueryRecord extends StructuredThreadRecord {
  threadId: string
  stageName: string
  batchName: string
  threadName: string
  aggregateStatus: ExecutionStatus
  itemCount: number
  assignedAgent?: string
  breadcrumb?: string
  report?: string
}

function getLatestThreadValue(
  items: ExecutionItemQueryRecord[],
  pick: (item: ExecutionItemQueryRecord) => string | undefined,
): string | undefined {
  const sorted = [...items].sort((left, right) => {
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

function aggregateExecutionStatuses(items: Pick<ExecutionItemQueryRecord, "status">[]): ExecutionStatus {
  if (items.length === 0) return "pending"
  if (items.some((item) => item.status === "blocked")) return "blocked"
  if (items.some((item) => item.status === "in_progress")) return "in_progress"
  if (items.some((item) => item.status === "pending")) return "pending"
  return "completed"
}

function buildThreadQueryRecords(query: WorkstreamHierarchyQueryResult): HierarchyThreadQueryRecord[] {
  const stageById = new Map(query.stages.map((stage) => [stage.id, stage] as const))
  const batchById = new Map(query.batches.map((batch) => [batch.id, batch] as const))
  const itemsByThreadId = new Map<string, ExecutionItemQueryRecord[]>()

  for (const item of query.items) {
    const existing = itemsByThreadId.get(item.threadId)
    if (existing) {
      existing.push(item)
    } else {
      itemsByThreadId.set(item.threadId, [item])
    }
  }

  const threadRecords = new Map<string, HierarchyThreadQueryRecord>()

  for (const thread of query.threads) {
    const threadItems = itemsByThreadId.get(thread.id) ?? []
    const assignedAgent = getLatestThreadValue(threadItems, (item) => item.assignedAgent)
    const breadcrumb = getLatestThreadValue(threadItems, (item) => item.breadcrumb)
    const report = getLatestThreadValue(threadItems, (item) => item.report)
    threadRecords.set(thread.id, {
      ...thread,
      threadId: thread.id,
      stageName: stageById.get(thread.stageId)?.name ?? `Stage ${thread.stageId}`,
      batchName: batchById.get(thread.batchId)?.name ?? `Batch ${thread.batchId}`,
      threadName: thread.name,
      aggregateStatus: aggregateExecutionStatuses(threadItems),
      itemCount: threadItems.length,
      ...(assignedAgent ? { assignedAgent } : {}),
      ...(breadcrumb ? { breadcrumb } : {}),
      ...(report ? { report } : {}),
    })
  }

  for (const item of query.items) {
    if (threadRecords.has(item.threadId)) {
      continue
    }

    const [stageId = item.stageId, batchNumber = "00", threadNumber = "00"] = item.threadId.split(".")
    const batchId = `${stageId}.${batchNumber}`
    const threadItems = itemsByThreadId.get(item.threadId) ?? [item]
    const assignedAgent = getLatestThreadValue(threadItems, (threadItem) => threadItem.assignedAgent)
    const breadcrumb = getLatestThreadValue(threadItems, (threadItem) => threadItem.breadcrumb)
    const report = getLatestThreadValue(threadItems, (threadItem) => threadItem.report)
    threadRecords.set(item.threadId, {
      id: item.threadId,
      threadId: item.threadId,
      stageId,
      batchId,
      number: Number.parseInt(threadNumber, 10) || 0,
      name: item.threadName,
      stageName: item.stageName,
      batchName: item.batchName,
      threadName: item.threadName,
      aggregateStatus: aggregateExecutionStatuses(threadItems),
      itemCount: threadItems.length,
      ...(assignedAgent ? { assignedAgent } : {}),
      ...(breadcrumb ? { breadcrumb } : {}),
      ...(report ? { report } : {}),
    })
  }

  return [...threadRecords.values()].sort((left, right) => compareIds(left.threadId, right.threadId))
}

function loadHierarchyQueryResult(repoRoot: string, streamId: string): WorkstreamHierarchyQueryResult {
  const state = loadStructuredWorkstreamStateSync(repoRoot, streamId)

  if (!state) {
    return {
      streamId,
      stages: [],
      batches: [],
      threads: [],
      items: [],
    }
  }

  const stageById = new Map(state.hierarchy.stages.map((stage) => [stage.id, stage] as const))
  const batchById = new Map(state.hierarchy.batches.map((batch) => [batch.id, batch] as const))
  const runtimeByThreadId = new Map(state.threadRuntime.map((runtime) => [runtime.threadId, runtime] as const))

  const mappedItems = state.hierarchy.threads.map((thread) => {
    const runtime = runtimeByThreadId.get(thread.id)
    const createdAt = runtime?.createdAt ?? new Date().toISOString()
    return {
      id: thread.id,
      threadId: thread.id,
      stageId: thread.stageId,
      batchId: thread.batchId,
      number: thread.number,
      name: runtime?.itemName ?? thread.name,
      status: runtime?.status ?? "pending",
      createdAt,
      updatedAt: runtime?.updatedAt ?? createdAt,
      ...(runtime?.breadcrumb ? { breadcrumb: runtime.breadcrumb } : {}),
      ...(runtime?.report ? { report: runtime.report } : {}),
      ...(runtime?.assignedAgent ? { assignedAgent: runtime.assignedAgent } : {}),
      stageName: stageById.get(thread.stageId)?.name ?? `Stage ${thread.stageId}`,
      batchName: batchById.get(thread.batchId)?.name ?? `Batch ${thread.batchId}`,
      threadName: thread.name,
    }
  })

  return {
    streamId,
    stages: [...state.hierarchy.stages].sort((left, right) => compareIds(left.id, right.id)),
    batches: [...state.hierarchy.batches].sort((left, right) => compareIds(left.id, right.id)),
    threads: [...state.hierarchy.threads].sort((left, right) => compareIds(left.id, right.id)),
    items: mappedItems.sort((left, right) => compareIds(left.id, right.id)),
  }
}

function resolveStreamIdForQuery(repoRoot: string, streamIdOrName: string): string | null {
  try {
    const workspaceState = loadCanonicalWorkspaceState(repoRoot)
    const record = resolveWorkspaceStateStreamRecord(workspaceState, streamIdOrName)
    return record?.id ?? null
  } catch {
    return null
  }
}

function loadApprovalQueryResult(repoRoot: string, streamIdOrName: string): WorkstreamApprovalQueryResult {
  const streamId = resolveStreamIdForQuery(repoRoot, streamIdOrName) ?? streamIdOrName
  const workstreamState = loadStructuredWorkstreamStateSync(repoRoot, streamId)
  const approvals = workstreamState?.approvals ?? []

  return {
    streamId,
    approvals,
    approval: workstreamState ? structuredApprovalRecordsToApprovalMetadata(approvals) : undefined,
  }
}

export function loadWorkstreamHierarchyQueryResult(
  repoRoot: string,
  streamId: string,
): WorkstreamHierarchyQueryResult {
  return loadHierarchyQueryResult(repoRoot, streamId)
}

export function loadWorkstreamApprovalQueryResult(
  repoRoot: string,
  streamIdOrName: string,
): WorkstreamApprovalQueryResult {
  return loadApprovalQueryResult(repoRoot, streamIdOrName)
}

export function queryExecutionItemsForWorkstream(
  repoRoot: string,
  streamId: string,
  status?: ExecutionStatus,
): ExecutionItemQueryRecord[] {
  const items = loadWorkstreamHierarchyQueryResult(repoRoot, streamId).items
  if (!status) {
    return items
  }

  return items.filter((item) => item.status === status)
}

export function queryRuntimeSummaryForWorkstream(
  repoRoot: string,
  streamId: string,
): WorkstreamRuntimeSummary | undefined {
  const workstreamState = loadStructuredWorkstreamStateSync(repoRoot, streamId)
  return workstreamState ? createRuntimeSummaryFromWorkstreamState(workstreamState) : undefined
}

export function queryExecutionItemByIdForWorkstream(
  repoRoot: string,
  streamId: string,
  itemId: string,
): ExecutionItemQueryRecord | null {
  return queryExecutionItemsForWorkstream(repoRoot, streamId).find((item) => item.id === itemId) ?? null
}

export function queryThreadsForWorkstream(
  repoRoot: string,
  streamId: string,
  status?: ExecutionStatus,
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
