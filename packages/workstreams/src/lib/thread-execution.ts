import type { StructuredStorageWorkstreamState } from "./structured-storage.ts"
import type { ExecutionItem, ExecutionStatus, StreamDocument } from "./types.ts"
import { queryExecutionItemsForWorkstream, queryThreadsForWorkstream } from "./hierarchy-query.ts"
import { modifyStructuredWorkstreamStateSync } from "./storage-adapter.ts"

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function padId(value: number): string {
  return value.toString().padStart(2, "0")
}

export function buildCanonicalThreadExecutionState(args: {
  doc: StreamDocument
  existingState: Pick<StructuredStorageWorkstreamState, "hierarchy" | "threadRuntime">
}): Pick<StructuredStorageWorkstreamState, "hierarchy" | "threadRuntime"> {
  const runtimeByThreadId = new Map(args.existingState.threadRuntime.map((runtime) => [runtime.threadId, runtime] as const))
  const createdAt = new Date().toISOString()

  const stages = args.doc.stages.map((stage) => ({
    id: padId(stage.id),
    number: stage.id,
    name: stage.name,
  }))

  const batches = args.doc.stages.flatMap((stage) =>
    stage.batches.map((batch) => ({
      id: `${padId(stage.id)}.${padId(batch.id)}`,
      stageId: padId(stage.id),
      number: batch.id,
      name: batch.name,
    })),
  )

  const threads = args.doc.stages.flatMap((stage) =>
    stage.batches.flatMap((batch) =>
      batch.threads.map((thread) => ({
        id: `${padId(stage.id)}.${padId(batch.id)}.${padId(thread.id)}`,
        stageId: padId(stage.id),
        batchId: `${padId(stage.id)}.${padId(batch.id)}`,
        number: thread.id,
        name: thread.name,
      })),
    ),
  )

  const threadRuntime = threads.map((thread) => {
    const existingRuntime = runtimeByThreadId.get(thread.id)
    return {
      threadId: thread.id,
      sessions: existingRuntime?.sessions ?? [],
      status: existingRuntime?.status ?? "pending",
      createdAt: existingRuntime?.createdAt ?? createdAt,
      updatedAt: existingRuntime?.updatedAt ?? existingRuntime?.createdAt ?? createdAt,
      itemName: existingRuntime?.itemName ?? thread.name,
      ...(existingRuntime?.breadcrumb ? { breadcrumb: existingRuntime.breadcrumb } : {}),
      ...(existingRuntime?.report ? { report: existingRuntime.report } : {}),
      ...(existingRuntime?.assignedAgent ? { assignedAgent: existingRuntime.assignedAgent } : {}),
      ...(existingRuntime?.currentSessionId ? { currentSessionId: existingRuntime.currentSessionId } : {}),
      ...(existingRuntime?.opencodeSessionId ? { opencodeSessionId: existingRuntime.opencodeSessionId } : {}),
      ...(existingRuntime?.workingAgentSessionId ? { workingAgentSessionId: existingRuntime.workingAgentSessionId } : {}),
      ...(existingRuntime?.synthesisOutput ? { synthesisOutput: existingRuntime.synthesisOutput } : {}),
      ...(existingRuntime?.synthesis ? { synthesis: existingRuntime.synthesis } : {}),
    }
  })

  return {
    hierarchy: { stages, batches, threads },
    threadRuntime,
  }
}

export function listThreadExecutionItems(
  repoRoot: string,
  streamId: string,
  status?: ExecutionStatus,
): ExecutionItem[] {
  const items = queryExecutionItemsForWorkstream(repoRoot, streamId)
  return status ? items.filter((item) => item.status === status) : items
}

export function getThreadExecutionItemById(
  repoRoot: string,
  streamId: string,
  itemId: string,
): ExecutionItem | null {
  return listThreadExecutionItems(repoRoot, streamId).find((item) => item.id === itemId) ?? null
}

export function listThreadExecutionItemsByThreadId(
  repoRoot: string,
  streamId: string,
  threadId: string,
): ExecutionItem[] {
  return listThreadExecutionItems(repoRoot, streamId).filter((item) => item.threadId === threadId)
}

export function listThreadExecutionItemsByThread(
  repoRoot: string,
  streamId: string,
  stage: number,
  batch: number,
  thread: number,
): ExecutionItem[] {
  const threadId = [stage, batch, thread].map((value) => value.toString().padStart(2, "0")).join(".")
  return listThreadExecutionItemsByThreadId(repoRoot, streamId, threadId)
}

export function getThreadExecutionItemCounts(
  repoRoot: string,
  streamId: string,
): Record<ExecutionStatus, number> & { total: number } {
  const items = listThreadExecutionItems(repoRoot, streamId)
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    in_progress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    cancelled: items.filter((item) => item.status === "cancelled").length,
  }
}

function deleteThreadExecutionItemsByPrefix(repoRoot: string, streamId: string, prefix: string): ExecutionItem[] {
  const deleted: ExecutionItem[] = []
  modifyStructuredWorkstreamStateSync({ repoRoot, streamId }, (workstreamState) => {
    for (const item of listThreadExecutionItems(repoRoot, streamId)) {
      if (item.id.startsWith(prefix)) {
        deleted.push(item)
      }
    }

    const threadIdsToDelete = new Set(deleted.map((item) => item.threadId))
    workstreamState.hierarchy.threads = workstreamState.hierarchy.threads.filter(
      (thread) => !threadIdsToDelete.has(thread.id),
    )
    workstreamState.threadRuntime = workstreamState.threadRuntime.filter(
      (runtime) => !threadIdsToDelete.has(runtime.threadId),
    )
  })

  return deleted.sort((left, right) => compareIds(left.id, right.id))
}

export function deleteThreadExecutionItemsByStage(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
): ExecutionItem[] {
  return deleteThreadExecutionItemsByPrefix(repoRoot, streamId, `${stageNumber.toString().padStart(2, "0")}.`)
}

export function deleteThreadExecutionItemsByBatch(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
  batchNumber: number,
): ExecutionItem[] {
  return deleteThreadExecutionItemsByPrefix(
    repoRoot,
    streamId,
    `${stageNumber.toString().padStart(2, "0")}.${batchNumber.toString().padStart(2, "0")}.`,
  )
}

export function deleteThreadExecutionItemsByThread(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
  batchNumber: number,
  threadNumber: number,
): ExecutionItem[] {
  return deleteThreadExecutionItemsByPrefix(
    repoRoot,
    streamId,
    [stageNumber, batchNumber, threadNumber].map((value) => value.toString().padStart(2, "0")).join(".") + ".",
  )
}

export function getBatchThreadMetadata(
  repoRoot: string,
  streamId: string,
  stageNum: number,
  batchNum: number,
): { stageName: string; batchName: string } | null {
  const batchId = `${stageNum.toString().padStart(2, "0")}.${batchNum.toString().padStart(2, "0")}`
  const firstThread = queryThreadsForWorkstream(repoRoot, streamId).find((thread) => thread.batchId === batchId)
  if (!firstThread) {
    return null
  }

  return {
    stageName: firstThread.stageName,
    batchName: firstThread.batchName,
  }
}

function sortItemsById(items: ExecutionItem[]): void {
  items.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
}

export interface GroupThreadExecutionItemsOptions {
  byBatch?: boolean
}

export type GroupedThreadExecutionByStageThread = Map<string, Map<string, ExecutionItem[]>>
export type GroupedThreadExecutionByStageBatchThread = Map<string, Map<string, Map<string, ExecutionItem[]>>>

export function groupThreadExecutionItems(
  items: ExecutionItem[],
  options?: { byBatch: false },
): GroupedThreadExecutionByStageThread
export function groupThreadExecutionItems(
  items: ExecutionItem[],
  options: { byBatch: true },
): GroupedThreadExecutionByStageBatchThread
export function groupThreadExecutionItems(
  items: ExecutionItem[],
  options: GroupThreadExecutionItemsOptions = {},
): GroupedThreadExecutionByStageThread | GroupedThreadExecutionByStageBatchThread {
  const { byBatch = true } = options

  if (byBatch) {
    const grouped = new Map<string, Map<string, Map<string, ExecutionItem[]>>>()
    for (const item of items) {
      if (!grouped.has(item.stageName)) {
        grouped.set(item.stageName, new Map())
      }
      const stageMap = grouped.get(item.stageName)!
      const batchName = item.batchName || "Batch 01"
      if (!stageMap.has(batchName)) {
        stageMap.set(batchName, new Map())
      }
      const batchMap = stageMap.get(batchName)!
      if (!batchMap.has(item.threadName)) {
        batchMap.set(item.threadName, [])
      }
      batchMap.get(item.threadName)!.push(item)
    }

    for (const stageMap of grouped.values()) {
      for (const batchMap of stageMap.values()) {
        for (const threadItems of batchMap.values()) {
          sortItemsById(threadItems)
        }
      }
    }

    return grouped
  }

  const grouped = new Map<string, Map<string, ExecutionItem[]>>()
  for (const item of items) {
    if (!grouped.has(item.stageName)) {
      grouped.set(item.stageName, new Map())
    }
    const stageMap = grouped.get(item.stageName)!
    if (!stageMap.has(item.threadName)) {
      stageMap.set(item.threadName, [])
    }
    stageMap.get(item.threadName)!.push(item)
  }

  for (const stageMap of grouped.values()) {
    for (const threadItems of stageMap.values()) {
      sortItemsById(threadItems)
    }
  }

  return grouped
}
