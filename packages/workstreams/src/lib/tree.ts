import { parseBatchId } from "./cli-utils.ts"
import { parseTaskId } from "./tasks.ts"
import type {
  RuntimeBatchStatus,
  RuntimeBranchSupervisionStatus,
  RuntimeSupervisorStatus,
  Task,
  TaskStatus,
  WorkstreamRuntimeBatchSummary,
  WorkstreamRuntimeSummary,
} from "./types.ts"

export interface WorkstreamTreeTaskCounts {
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
  taskStatus: TaskStatus
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
  status: TaskStatus
  taskCount: number
}

interface WorkstreamTreeAggregateNode extends WorkstreamTreeNodeBase {
  taskCounts: WorkstreamTreeTaskCounts
}

export interface WorkstreamTreeTaskNode extends WorkstreamTreeNodeBase {
  kind: "task"
  streamId: string
  stageId: string
  stageNumber: number
  batchId: string
  batchNumber: number
  threadId: string
  threadNumber: number
  taskNumber: number
  assignedAgent?: string
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
  tasks: WorkstreamTreeTaskNode[]
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
  tasks: Task[]
  runtimeSummary?: WorkstreamRuntimeSummary
  batchId?: string
}

interface MutableWorkstreamTreeTaskNode extends WorkstreamTreeTaskNode {}

interface MutableWorkstreamTreeThreadNode extends WorkstreamTreeThreadNode {
  tasks: MutableWorkstreamTreeTaskNode[]
}

interface MutableWorkstreamTreeBatchNode extends WorkstreamTreeBatchNode {
  threads: MutableWorkstreamTreeThreadNode[]
}

interface MutableWorkstreamTreeStageNode extends WorkstreamTreeStageNode {
  batches: MutableWorkstreamTreeBatchNode[]
}

function createEmptyTaskCounts(): WorkstreamTreeTaskCounts {
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

function incrementTaskCounts(taskCounts: WorkstreamTreeTaskCounts, status: TaskStatus): void {
  taskCounts.total += 1
  taskCounts[status] += 1

  if (status === "completed" || status === "cancelled") {
    taskCounts.done += 1
  }
}

export function aggregateTreeStatus(taskCounts: WorkstreamTreeTaskCounts): TaskStatus {
  if (taskCounts.total === 0) return "pending"
  if (taskCounts.blocked > 0) return "blocked"
  if (taskCounts.in_progress > 0) return "in_progress"
  if (taskCounts.pending > 0) return "pending"
  return "completed"
}

function padNumber(value: number): string {
  return value.toString().padStart(2, "0")
}

function formatTaskStatus(status: TaskStatus): string {
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

export function getBatchRuntimeOverlay(
  batchStatus: WorkstreamRuntimeBatchSummary,
  taskStatus: TaskStatus,
): WorkstreamTreeBatchRuntimeOverlay | undefined {
  const detail = getBatchRuntimeDetail(batchStatus)
  const isRuntimeActive = ["running", "failed"].includes(batchStatus.status)

  if (batchStatus.status !== taskStatus) {
    return {
      kind: "desync",
      text: `desync: tasks ${formatTaskStatus(taskStatus)}, runtime ${batchStatus.status} (${detail})`,
      taskStatus,
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
      taskStatus,
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

function createTaskNode(streamId: string, task: Task): WorkstreamTreeTaskNode {
  const parsedTaskId = parseTaskId(task.id)
  const stageId = padNumber(parsedTaskId.stage)
  const batchId = `${stageId}.${padNumber(parsedTaskId.batch)}`
  const threadId = `${batchId}.${padNumber(parsedTaskId.thread)}`
  const taskLabel = padNumber(parsedTaskId.task)

  return {
    kind: "task",
    id: task.id,
    parentId: threadId,
    streamId,
    stageId,
    stageNumber: parsedTaskId.stage,
    batchId,
    batchNumber: parsedTaskId.batch,
    threadId,
    threadNumber: parsedTaskId.thread,
    taskNumber: parsedTaskId.task,
    label: `Task ${taskLabel}`,
    displayLabel: `Task ${taskLabel}: ${task.name}`,
    name: task.name,
    status: task.status,
    taskCount: 1,
    ...(task.assigned_agent ? { assignedAgent: task.assigned_agent } : {}),
  }
}

export function filterTasksForBatch(tasks: Task[], batchId: string): Task[] | null {
  const parsedBatchId = parseBatchId(batchId)
  if (!parsedBatchId) {
    return null
  }

  const normalizedBatchId = `${padNumber(parsedBatchId.stage)}.${padNumber(parsedBatchId.batch)}`
  return tasks.filter((task) => task.id.startsWith(`${normalizedBatchId}.`))
}

function filterRuntimeSummaryForBatch(
  runtimeSummary: WorkstreamRuntimeSummary | undefined,
  batchId: string,
): WorkstreamRuntimeSummary | undefined {
  if (!runtimeSummary) {
    return undefined
  }

  const matchingBatch = runtimeSummary.batches[batchId]
  const activeRun = runtimeSummary.supervision?.active_run
  const currentBranch = runtimeSummary.supervision?.current_branch
  const filteredActiveRun = activeRun?.current_batch_id === batchId ? activeRun : undefined
  const filteredCurrentBranch =
    currentBranch && (currentBranch.current_batch_id === batchId || currentBranch.batch_id === batchId)
      ? currentBranch
      : undefined

  if (!matchingBatch && !filteredActiveRun && !filteredCurrentBranch) {
    return undefined
  }

  return {
    updated_at: runtimeSummary.updated_at,
    batches: matchingBatch ? { [batchId]: matchingBatch } : {},
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
  tasks,
  runtimeSummary,
  batchId,
}: BuildWorkstreamTreeSnapshotOptions): WorkstreamTreeSnapshot {
  const scopedRuntimeSummary = batchId ? filterRuntimeSummaryForBatch(runtimeSummary, batchId) : runtimeSummary
  const sortedTasks = [...tasks].sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
  const runtimeNotice = getWorkstreamTreeRuntimeNotice(scopedRuntimeSummary)

  const snapshot: MutableWorkstreamTreeSnapshot = {
    kind: "workstream",
    id: streamId,
    streamId,
    label: streamId,
    displayLabel: `Workstream: ${streamId}`,
    name: streamId,
    status: "pending",
    taskCount: 0,
    taskCounts: createEmptyTaskCounts(),
    ...(runtimeNotice ? { runtimeNotice } : {}),
    stages: [],
  }

  const stageMap = new Map<string, MutableWorkstreamTreeStageNode>()

  for (const task of sortedTasks) {
    const parsedTaskId = parseTaskId(task.id)
    const stageId = padNumber(parsedTaskId.stage)
    const batchId = `${stageId}.${padNumber(parsedTaskId.batch)}`
    const threadId = `${batchId}.${padNumber(parsedTaskId.thread)}`

    let stageNode = stageMap.get(stageId)
    if (!stageNode) {
      stageNode = {
        kind: "stage",
        id: stageId,
        parentId: streamId,
        streamId,
        stageId,
        stageNumber: parsedTaskId.stage,
        label: `Stage ${stageId}`,
        displayLabel: `Stage ${stageId}: ${task.stage_name}`,
        name: task.stage_name,
        status: "pending",
        taskCount: 0,
        taskCounts: createEmptyTaskCounts(),
        batches: [],
      }
      stageMap.set(stageId, stageNode)
      snapshot.stages.push(stageNode)
    }

    let batchNode = stageNode.batches.find((candidate) => candidate.id === batchId)
    if (!batchNode) {
      batchNode = {
        kind: "batch",
        id: batchId,
        parentId: stageId,
        streamId,
        stageId,
        stageNumber: parsedTaskId.stage,
        batchId,
        batchNumber: parsedTaskId.batch,
        label: `Batch ${padNumber(parsedTaskId.batch)}`,
        displayLabel: `Batch ${padNumber(parsedTaskId.batch)}: ${task.batch_name}`,
        name: task.batch_name,
        status: "pending",
        taskCount: 0,
        taskCounts: createEmptyTaskCounts(),
        threads: [],
      }
      stageNode.batches.push(batchNode)
    }

    let threadNode = batchNode.threads.find((candidate) => candidate.id === threadId)
    if (!threadNode) {
      threadNode = {
        kind: "thread",
        id: threadId,
        parentId: batchId,
        streamId,
        stageId,
        stageNumber: parsedTaskId.stage,
        batchId,
        batchNumber: parsedTaskId.batch,
        threadId,
        threadNumber: parsedTaskId.thread,
        label: `Thread ${padNumber(parsedTaskId.thread)}`,
        displayLabel: `Thread ${padNumber(parsedTaskId.thread)}: ${task.thread_name}`,
        name: task.thread_name,
        status: "pending",
        taskCount: 0,
        taskCounts: createEmptyTaskCounts(),
        ...(task.assigned_agent ? { assignedAgent: task.assigned_agent } : {}),
        tasks: [],
      }
      batchNode.threads.push(threadNode)
    }

    const taskNode = createTaskNode(streamId, task)
    threadNode.tasks.push(taskNode)

    incrementTaskCounts(threadNode.taskCounts, task.status)
    threadNode.taskCount = threadNode.taskCounts.total
    threadNode.status = aggregateTreeStatus(threadNode.taskCounts)
    if (!threadNode.assignedAgent && task.assigned_agent) {
      threadNode.assignedAgent = task.assigned_agent
    }

    incrementTaskCounts(batchNode.taskCounts, task.status)
    batchNode.taskCount = batchNode.taskCounts.total
    batchNode.status = aggregateTreeStatus(batchNode.taskCounts)

    incrementTaskCounts(stageNode.taskCounts, task.status)
    stageNode.taskCount = stageNode.taskCounts.total
    stageNode.status = aggregateTreeStatus(stageNode.taskCounts)

    incrementTaskCounts(snapshot.taskCounts, task.status)
    snapshot.taskCount = snapshot.taskCounts.total
    snapshot.status = aggregateTreeStatus(snapshot.taskCounts)
  }

  snapshot.runtimeNotice = runtimeNotice

  for (const stageNode of snapshot.stages) {
    stageNode.batches.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))

    for (const batchNode of stageNode.batches) {
      batchNode.threads.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))

      if (scopedRuntimeSummary?.batches[batchNode.batchId]) {
        batchNode.runtimeOverlay = getBatchRuntimeOverlay(
          scopedRuntimeSummary.batches[batchNode.batchId]!,
          batchNode.status,
        )
      }
    }
  }

  snapshot.stages.sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))

  return snapshot
}

interface MutableWorkstreamTreeSnapshot extends WorkstreamTreeSnapshot {
  stages: MutableWorkstreamTreeStageNode[]
}

export function statusToTreeIcon(status: TaskStatus): string {
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
  const lines = [`${statusToTreeIcon(snapshot.status)} ${snapshot.displayLabel} (${snapshot.taskCount})`]

  if (snapshot.runtimeNotice) {
    lines.push(`    Runtime: ${snapshot.runtimeNotice.text}`)
  }

  snapshot.stages.forEach((stageNode, stageIndex) => {
    const isLastStage = stageIndex === snapshot.stages.length - 1
    const stagePrefix = isLastStage ? "└── " : "├── "
    const stageChildPrefix = isLastStage ? "    " : "│   "

    lines.push(
      `${stagePrefix}${statusToTreeIcon(stageNode.status)} ${stageNode.displayLabel} (${stageNode.taskCount})`,
    )

    stageNode.batches.forEach((batchNode, batchIndex) => {
      const isLastBatch = batchIndex === stageNode.batches.length - 1
      const batchPrefix = isLastBatch ? "└── " : "├── "
      const batchChildPrefix = isLastBatch ? "    " : "│   "
      const runtimeSuffix = batchNode.runtimeOverlay ? ` [${batchNode.runtimeOverlay.text}]` : ""

      lines.push(
        `${stageChildPrefix}${batchPrefix}${statusToTreeIcon(batchNode.status)} ${batchNode.displayLabel} (${batchNode.taskCount})${runtimeSuffix}`,
      )

      batchNode.threads.forEach((threadNode, threadIndex) => {
        const isLastThread = threadIndex === batchNode.threads.length - 1
        const threadPrefix = isLastThread ? "└── " : "├── "
        const agentDisplay = threadNode.assignedAgent ? ` @${threadNode.assignedAgent}` : ""

        lines.push(
          `${stageChildPrefix}${batchChildPrefix}${threadPrefix}${statusToTreeIcon(threadNode.status)} ${threadNode.displayLabel} (${threadNode.taskCount})${agentDisplay}`,
        )
      })
    })
  })

  return lines
}
