import { parseBatchId } from "./cli-utils.ts"
import type { HierarchyThreadQueryRecord } from "./hierarchy-query.ts"
import type {
  ExecutionItem,
  RuntimeBatchStatus,
  RuntimeBranchSupervisionStatus,
  RuntimeSupervisorStatus,
  ExecutionStatus,
  WorkstreamRuntimeBatchSummary,
  WorkstreamRuntimeSummary,
} from "./types.ts"

export interface WorkstreamTreeItemCounts {
  total: number
  pending: number
  in_progress: number
  completed: number
  blocked: number
  cancelled: number
  done: number
}

export interface WorkstreamTreeRuntimeNotice {
  kind: "failed_batch" | "running_batch" | "supervision_run" | "supervision_branch"
  text: string
  batchId?: string
  stageId?: string
  status?: RuntimeBatchStatus | RuntimeSupervisorStatus | RuntimeBranchSupervisionStatus
  currentBatchId?: string
  branchSessionId?: string
  rootSessionId?: string
}

export interface WorkstreamTreeBatchRuntimeOverlay {
  kind: "runtime" | "desync"
  text: string
  executionStatus: ExecutionStatus
  runtimeStatus: RuntimeBatchStatus
  detail: string
  runId: string
  updatedAt: string
  startedAt: string
  completedAt?: string
  threadSummary: WorkstreamRuntimeBatchSummary["thread_summary"]
}

interface WorkstreamTreeNodeBase {
  id: string
  parentId?: string
  label: string
  displayLabel: string
  name: string
  status: ExecutionStatus
  itemCount: number
}

interface WorkstreamTreeAggregateNode extends WorkstreamTreeNodeBase {
  itemCounts: WorkstreamTreeItemCounts
}

export interface WorkstreamTreeThreadNode extends WorkstreamTreeAggregateNode {
  kind: "thread"
  streamId: string
  stageId: string
  stageNumber: number
  batchId: string
  batchNumber: number
  threadId: string
  threadNumber: number
  assignedAgent?: string
}

export interface WorkstreamTreeBatchNode extends WorkstreamTreeAggregateNode {
  kind: "batch"
  streamId: string
  stageId: string
  stageNumber: number
  batchId: string
  batchNumber: number
  runtimeOverlay?: WorkstreamTreeBatchRuntimeOverlay
  threads: WorkstreamTreeThreadNode[]
}

export interface WorkstreamTreeStageNode extends WorkstreamTreeAggregateNode {
  kind: "stage"
  streamId: string
  stageId: string
  stageNumber: number
  batches: WorkstreamTreeBatchNode[]
}

export interface WorkstreamTreeSnapshot extends WorkstreamTreeAggregateNode {
  kind: "workstream"
  streamId: string
  runtimeNotice?: WorkstreamTreeRuntimeNotice
  stages: WorkstreamTreeStageNode[]
}

interface BuildWorkstreamTreeSnapshotOptions {
  streamId: string
  items: ExecutionItem[]
  runtimeSummary?: WorkstreamRuntimeSummary
  batchId?: string
}

interface MutableWorkstreamTreeThreadNode extends WorkstreamTreeThreadNode {
}

interface MutableWorkstreamTreeBatchNode extends WorkstreamTreeBatchNode {
  threads: MutableWorkstreamTreeThreadNode[]
}

interface MutableWorkstreamTreeStageNode extends WorkstreamTreeStageNode {
  batches: MutableWorkstreamTreeBatchNode[]
}

function createEmptyTaskCounts(): WorkstreamTreeItemCounts {
  return {
    total: 0,
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
    done: 0,
  }
}

function incrementTaskCounts(taskCounts: WorkstreamTreeItemCounts, status: ExecutionStatus): void {
  taskCounts.total += 1
  taskCounts[status] += 1

  if (status === "completed" || status === "cancelled") {
    taskCounts.done += 1
  }
}

export function aggregateTreeStatus(taskCounts: WorkstreamTreeItemCounts): ExecutionStatus {
  if (taskCounts.total === 0) return "pending"
  if (taskCounts.blocked > 0) return "blocked"
  if (taskCounts.in_progress > 0) return "in_progress"
  if (taskCounts.pending > 0) return "pending"
  return "completed"
}

function padNumber(value: number): string {
  return value.toString().padStart(2, "0")
}

function normalizeBatchId(batchId: string): string | null {
  const parsedBatchId = parseBatchId(batchId)
  if (!parsedBatchId) {
    return null
  }

  return `${padNumber(parsedBatchId.stage)}.${padNumber(parsedBatchId.batch)}`
}

function formatExecutionStatus(status: ExecutionStatus): string {
  return status.replace("_", " ")
}

function getBatchRuntimeDetail(batchStatus: WorkstreamRuntimeBatchSummary): string {
  if (batchStatus.thread_summary.failed > 0) {
    return `${batchStatus.thread_summary.failed} failed`
  }

  if (batchStatus.thread_summary.running > 0) {
    return `${batchStatus.thread_summary.running} running`
  }

  return `${batchStatus.thread_summary.completed} completed`
}

function isBatchRuntimeStatusAligned(executionStatus: ExecutionStatus, runtimeStatus: WorkstreamRuntimeBatchSummary["status"]): boolean {
  return (executionStatus === "in_progress" && runtimeStatus === "running") || executionStatus === runtimeStatus
}

export function getBatchRuntimeOverlay(
  batchStatus: WorkstreamRuntimeBatchSummary,
  executionStatus: ExecutionStatus,
): WorkstreamTreeBatchRuntimeOverlay | undefined {
  const detail = getBatchRuntimeDetail(batchStatus)
  const isRuntimeActive = ["running", "failed"].includes(batchStatus.status)
  const isAlignedWithExecution = isBatchRuntimeStatusAligned(executionStatus, batchStatus.status)

  if (!isAlignedWithExecution) {
    return {
      kind: "desync",
      text: `desync: items ${formatExecutionStatus(executionStatus)}, runtime ${batchStatus.status} (${detail})`,
      executionStatus,
      runtimeStatus: batchStatus.status,
      detail,
      runId: batchStatus.run_id,
      updatedAt: batchStatus.updated_at,
      startedAt: batchStatus.started_at,
      ...(batchStatus.completed_at ? { completedAt: batchStatus.completed_at } : {}),
      threadSummary: { ...batchStatus.thread_summary },
    }
  }

  if (isRuntimeActive) {
    return {
      kind: "runtime",
      text: `runtime: ${batchStatus.status} (${detail})`,
      executionStatus,
      runtimeStatus: batchStatus.status,
      detail,
      runId: batchStatus.run_id,
      updatedAt: batchStatus.updated_at,
      startedAt: batchStatus.started_at,
      ...(batchStatus.completed_at ? { completedAt: batchStatus.completed_at } : {}),
      threadSummary: { ...batchStatus.thread_summary },
    }
  }

  return undefined
}

export function getWorkstreamTreeRuntimeNotice(
  runtimeSummary?: WorkstreamRuntimeSummary,
): WorkstreamTreeRuntimeNotice | undefined {
  if (!runtimeSummary) {
    return undefined
  }

  const failedBatch = Object.values(runtimeSummary.batches)
    .filter((batch) => batch.status === "failed")
    .sort((left, right) => left.batch_id.localeCompare(right.batch_id, undefined, { numeric: true }))[0]

  if (failedBatch) {
    const failedThreads = failedBatch.thread_summary.failed
    return {
      kind: "failed_batch",
      text: `batch ${failedBatch.batch_id} failed (${failedThreads} failed thread${failedThreads === 1 ? "" : "s"})`,
      batchId: failedBatch.batch_id,
      status: failedBatch.status,
    }
  }

  const runningBatch = Object.values(runtimeSummary.batches).find((batch) => batch.status === "running")
  if (runningBatch) {
    const runningThreads = runningBatch.thread_summary.running
    return {
      kind: "running_batch",
      text: `batch ${runningBatch.batch_id} running (${runningThreads} active thread${runningThreads === 1 ? "" : "s"})`,
      batchId: runningBatch.batch_id,
      status: runningBatch.status,
    }
  }

  const activeRun = runtimeSummary.supervision?.active_run
  if (activeRun) {
    return {
      kind: "supervision_run",
      text: `supervision ${activeRun.status} on ${activeRun.current_batch_id ?? `stage ${activeRun.stage_id}`}`,
      stageId: activeRun.stage_id,
      status: activeRun.status,
      currentBatchId: activeRun.current_batch_id,
      branchSessionId: activeRun.branch_session_id,
      rootSessionId: activeRun.root_session_id,
    }
  }

  const currentBranch = runtimeSummary.supervision?.current_branch
  if (currentBranch) {
    return {
      kind: "supervision_branch",
      text: `supervision branch ${currentBranch.status} on ${currentBranch.current_batch_id ?? currentBranch.batch_id ?? `stage ${currentBranch.stage_id}`}`,
      stageId: currentBranch.stage_id,
      batchId: currentBranch.batch_id,
      status: currentBranch.status,
      currentBatchId: currentBranch.current_batch_id,
      branchSessionId: currentBranch.branch_session_id,
      rootSessionId: currentBranch.root_session_id,
    }
  }

  return undefined
}

export function filterExecutionItemsForBatch(items: ExecutionItem[], batchId: string): ExecutionItem[] | null {
  const normalizedBatchId = normalizeBatchId(batchId)
  if (!normalizedBatchId) {
    return null
  }

  return items.filter((item) => item.batchId === normalizedBatchId)
}

export function filterThreadsForBatch(
  threads: HierarchyThreadQueryRecord[],
  batchId: string,
): HierarchyThreadQueryRecord[] | null {
  const normalizedBatchId = normalizeBatchId(batchId)
  if (!normalizedBatchId) {
    return null
  }

  return threads.filter((thread) => thread.batchId === normalizedBatchId)
}

function filterRuntimeSummaryForBatch(
  runtimeSummary: WorkstreamRuntimeSummary | undefined,
  batchId: string,
): WorkstreamRuntimeSummary | undefined {
  if (!runtimeSummary) {
    return undefined
  }

  const normalizedBatchId = normalizeBatchId(batchId)
  if (!normalizedBatchId) {
    return undefined
  }

  const matchingBatch = runtimeSummary.batches[normalizedBatchId]
  const activeRun = runtimeSummary.supervision?.active_run
  const currentBranch = runtimeSummary.supervision?.current_branch
  const filteredActiveRun = activeRun?.current_batch_id === normalizedBatchId ? activeRun : undefined
  const filteredCurrentBranch =
    currentBranch &&
    (currentBranch.current_batch_id === normalizedBatchId || currentBranch.batch_id === normalizedBatchId)
      ? currentBranch
      : undefined

  if (!matchingBatch && !filteredActiveRun && !filteredCurrentBranch) {
    return undefined
  }

  return {
    updated_at: runtimeSummary.updated_at,
    batches: matchingBatch ? { [normalizedBatchId]: matchingBatch } : {},
    ...(filteredActiveRun || filteredCurrentBranch
      ? {
          supervision: {
            updated_at: runtimeSummary.supervision?.updated_at ?? runtimeSummary.updated_at,
            ...(filteredActiveRun ? { active_run_id: filteredActiveRun.run_id, active_run: filteredActiveRun } : {}),
            ...(filteredCurrentBranch ? { current_branch: filteredCurrentBranch } : {}),
          },
        }
      : {}),
  }
}

export function buildWorkstreamTreeSnapshot({
  streamId,
  items,
  runtimeSummary,
  batchId,
}: BuildWorkstreamTreeSnapshotOptions): WorkstreamTreeSnapshot {
  return buildWorkstreamTreeSnapshotFromThreads({
    streamId,
    threads: items.map((item) => ({
      id: item.threadId,
      threadId: item.threadId,
      stageId: item.stageId,
      batchId: item.batchId,
      number: item.number,
      name: item.threadName,
      stageName: item.stageName,
      batchName: item.batchName,
      threadName: item.threadName,
      aggregateStatus: item.status,
      itemCount: 1,
      ...(item.assignedAgent ? { assignedAgent: item.assignedAgent } : {}),
      ...(item.breadcrumb ? { breadcrumb: item.breadcrumb } : {}),
      ...(item.report ? { report: item.report } : {}),
    })),
    runtimeSummary,
    ...(batchId ? { batchId } : {}),
  })
}

export function buildWorkstreamTreeSnapshotFromThreads(args: {
  streamId: string
  threads: HierarchyThreadQueryRecord[]
  runtimeSummary?: WorkstreamRuntimeSummary
  batchId?: string
}): WorkstreamTreeSnapshot {
  const scopedRuntimeSummary = args.batchId ? filterRuntimeSummaryForBatch(args.runtimeSummary, args.batchId) : args.runtimeSummary
  const runtimeNotice = getWorkstreamTreeRuntimeNotice(scopedRuntimeSummary)
  const snapshot: MutableWorkstreamTreeSnapshot = {
    kind: "workstream",
    id: args.streamId,
    streamId: args.streamId,
    label: args.streamId,
    displayLabel: `Workstream: ${args.streamId}`,
    name: args.streamId,
    status: "pending",
    itemCount: 0,
    itemCounts: createEmptyTaskCounts(),
    ...(runtimeNotice ? { runtimeNotice } : {}),
    stages: [],
  }

  const stageMap = new Map<string, MutableWorkstreamTreeStageNode>()
  for (const thread of [...args.threads].sort((left, right) => left.threadId.localeCompare(right.threadId, undefined, { numeric: true }))) {
    let stageNode = stageMap.get(thread.stageId)
    if (!stageNode) {
      stageNode = {
        kind: "stage",
        id: thread.stageId,
        parentId: args.streamId,
        streamId: args.streamId,
        stageId: thread.stageId,
        stageNumber: Number.parseInt(thread.stageId, 10) || 0,
        label: `Stage ${thread.stageId}`,
        displayLabel: `Stage ${thread.stageId}: ${thread.stageName}`,
        name: thread.stageName,
        status: "pending",
        itemCount: 0,
        itemCounts: createEmptyTaskCounts(),
        batches: [],
      }
      snapshot.stages.push(stageNode)
      stageMap.set(thread.stageId, stageNode)
    }

    let batchNode = stageNode.batches.find((candidate) => candidate.id === thread.batchId)
    if (!batchNode) {
      const batchLabel = thread.batchId.split(".")[1] ?? "00"
      batchNode = {
        kind: "batch",
        id: thread.batchId,
        parentId: thread.stageId,
        streamId: args.streamId,
        stageId: thread.stageId,
        stageNumber: Number.parseInt(thread.stageId, 10) || 0,
        batchId: thread.batchId,
        batchNumber: Number.parseInt(batchLabel, 10) || 0,
        label: `Batch ${batchLabel}`,
        displayLabel: `Batch ${batchLabel}: ${thread.batchName}`,
        name: thread.batchName,
        status: "pending",
        itemCount: 0,
        itemCounts: createEmptyTaskCounts(),
        threads: [],
      }
      stageNode.batches.push(batchNode)
    }

    const itemCounts = createEmptyTaskCounts()
    itemCounts.total = thread.itemCount
    itemCounts[thread.aggregateStatus] = thread.itemCount
    if (thread.aggregateStatus === "completed" || thread.aggregateStatus === "cancelled") {
      itemCounts.done = thread.itemCount
    }

      batchNode.threads.push({
        kind: "thread",
      id: thread.threadId,
      parentId: thread.batchId,
      streamId: args.streamId,
      stageId: thread.stageId,
      stageNumber: Number.parseInt(thread.stageId, 10) || 0,
      batchId: thread.batchId,
      batchNumber: Number.parseInt(thread.batchId.split(".")[1] ?? "0", 10) || 0,
      threadId: thread.threadId,
      threadNumber: thread.number,
      label: `Thread ${padNumber(thread.number)}`,
      displayLabel: `Thread ${padNumber(thread.number)}: ${thread.threadName}`,
      name: thread.threadName,
        status: thread.aggregateStatus,
        itemCount: thread.itemCount,
        itemCounts,
        ...(thread.assignedAgent ? { assignedAgent: thread.assignedAgent } : {}),
      })
  }

  for (const stageNode of snapshot.stages) {
    stageNode.batches.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))

    for (const batchNode of stageNode.batches) {
      batchNode.threads.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
      batchNode.itemCounts = createEmptyTaskCounts()
      for (const threadNode of batchNode.threads) {
        batchNode.itemCounts.total += threadNode.itemCount
        batchNode.itemCounts.pending += threadNode.itemCounts.pending
        batchNode.itemCounts.in_progress += threadNode.itemCounts.in_progress
        batchNode.itemCounts.completed += threadNode.itemCounts.completed
        batchNode.itemCounts.blocked += threadNode.itemCounts.blocked
        batchNode.itemCounts.cancelled += threadNode.itemCounts.cancelled
        batchNode.itemCounts.done += threadNode.itemCounts.done
      }
      batchNode.itemCount = batchNode.itemCounts.total
      batchNode.status = aggregateTreeStatus(batchNode.itemCounts)

      if (scopedRuntimeSummary?.batches[batchNode.batchId]) {
        batchNode.runtimeOverlay = getBatchRuntimeOverlay(
          scopedRuntimeSummary.batches[batchNode.batchId]!,
          batchNode.status,
        )
      }
    }

    stageNode.itemCounts = createEmptyTaskCounts()
    for (const batchNode of stageNode.batches) {
      stageNode.itemCounts.total += batchNode.itemCount
      stageNode.itemCounts.pending += batchNode.itemCounts.pending
      stageNode.itemCounts.in_progress += batchNode.itemCounts.in_progress
      stageNode.itemCounts.completed += batchNode.itemCounts.completed
      stageNode.itemCounts.blocked += batchNode.itemCounts.blocked
      stageNode.itemCounts.cancelled += batchNode.itemCounts.cancelled
      stageNode.itemCounts.done += batchNode.itemCounts.done
    }
    stageNode.itemCount = stageNode.itemCounts.total
    stageNode.status = aggregateTreeStatus(stageNode.itemCounts)
  }

  snapshot.stages.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
  snapshot.itemCounts = createEmptyTaskCounts()
  for (const stageNode of snapshot.stages) {
    snapshot.itemCounts.total += stageNode.itemCount
    snapshot.itemCounts.pending += stageNode.itemCounts.pending
    snapshot.itemCounts.in_progress += stageNode.itemCounts.in_progress
    snapshot.itemCounts.completed += stageNode.itemCounts.completed
    snapshot.itemCounts.blocked += stageNode.itemCounts.blocked
    snapshot.itemCounts.cancelled += stageNode.itemCounts.cancelled
    snapshot.itemCounts.done += stageNode.itemCounts.done
  }
  snapshot.itemCount = snapshot.itemCounts.total
  snapshot.status = aggregateTreeStatus(snapshot.itemCounts)
  snapshot.runtimeNotice = runtimeNotice

  return snapshot
}

interface MutableWorkstreamTreeSnapshot extends WorkstreamTreeSnapshot {
  stages: MutableWorkstreamTreeStageNode[]
}

export function statusToTreeIcon(status: ExecutionStatus): string {
  switch (status) {
    case "completed":
      return "[x]"
    case "in_progress":
      return "[~]"
    case "blocked":
      return "[!]"
    case "pending":
      return "[ ]"
    case "cancelled":
      return "[-]"
    default:
      return "[ ]"
  }
}

export function renderWorkstreamTree(snapshot: WorkstreamTreeSnapshot): string[] {
  const lines = [`${statusToTreeIcon(snapshot.status)} ${snapshot.displayLabel} (${snapshot.itemCount})`]

  if (snapshot.runtimeNotice) {
    lines.push(`    Runtime: ${snapshot.runtimeNotice.text}`)
  }

  snapshot.stages.forEach((stageNode, stageIndex) => {
    const isLastStage = stageIndex === snapshot.stages.length - 1
    const stagePrefix = isLastStage ? "└── " : "├── "
    const stageChildPrefix = isLastStage ? "    " : "│   "

    lines.push(
      `${stagePrefix}${statusToTreeIcon(stageNode.status)} ${stageNode.displayLabel} (${stageNode.itemCount})`,
    )

    stageNode.batches.forEach((batchNode, batchIndex) => {
      const isLastBatch = batchIndex === stageNode.batches.length - 1
      const batchPrefix = isLastBatch ? "└── " : "├── "
      const batchChildPrefix = isLastBatch ? "    " : "│   "
      const runtimeSuffix = batchNode.runtimeOverlay ? ` [${batchNode.runtimeOverlay.text}]` : ""

      lines.push(
        `${stageChildPrefix}${batchPrefix}${statusToTreeIcon(batchNode.status)} ${batchNode.displayLabel} (${batchNode.itemCount})${runtimeSuffix}`,
      )

      batchNode.threads.forEach((threadNode, threadIndex) => {
        const isLastThread = threadIndex === batchNode.threads.length - 1
        const threadPrefix = isLastThread ? "└── " : "├── "
        const agentDisplay = threadNode.assignedAgent ? ` @${threadNode.assignedAgent}` : ""

        lines.push(
          `${stageChildPrefix}${batchChildPrefix}${threadPrefix}${statusToTreeIcon(threadNode.status)} ${threadNode.displayLabel} (${threadNode.itemCount})${agentDisplay}`,
        )
      })
    })
  })

  return lines
}
