/**
 * Thread-first mutation operations.
 *
 * tasks.json remains a compatibility projection backed by canonical thread
 * mutations over structured task rows.
 */


import type { TaskStatus, StreamMetadata, Task } from "./types.ts"
import {
  loadStructuredWorkstreamStateSync,
  replaceStructuredWorkstreamStateSync,
} from "./storage-adapter.ts"
import { updateStructuredTask } from "./structured-storage.ts"
import {
  getTaskById,
  formatThreadId,
  getTasksByThread,
  parseTaskId,
  parseThreadId,
} from "./tasks.ts"

export interface UpdateTaskArgs {
  repoRoot: string
  stream: StreamMetadata
  taskId: string
  status: TaskStatus
  note?: string // Note: notes are not currently stored in tasks.json
  breadcrumb?: string
  report?: string
  assigned_agent?: string
}

export interface UpdateTaskResult {
  updated: boolean
  file: string
  taskId: string
  threadId: string
  status: TaskStatus
  task: Task | null
  tasks: Task[]
  count: number
}

export interface MutateThreadTasksArgs {
  repoRoot: string
  stream: StreamMetadata
  threadId: string
  status?: TaskStatus
  note?: string
  breadcrumb?: string
  report?: string
  assigned_agent?: string
}

export interface MutateThreadTasksResult {
  updated: boolean
  file: string
  threadId: string
  tasks: Task[]
  count: number
}

export async function mutateThreadTasks(args: MutateThreadTasksArgs): Promise<MutateThreadTasksResult> {
  let parsed: { stage: number; batch: number; thread: number }
  try {
    parsed = parseThreadId(args.threadId)
  } catch {
    throw new Error(
      `Invalid thread ID: ${args.threadId}. Expected format "stage.batch.thread" (e.g., "01.01.02")`,
    )
  }

  const existingTasks = getTasksByThread(
    args.repoRoot,
    args.stream.id,
    parsed.stage,
    parsed.batch,
    parsed.thread,
  )

  if (existingTasks.length === 0) {
    throw new Error(
      `No tasks found in thread "${args.threadId}" in workstream "${args.stream.id}".`,
    )
  }

  const updatedAt = new Date().toISOString()
  const workstreamState = loadStructuredWorkstreamStateSync(args.repoRoot, args.stream.id)
  if (!workstreamState) {
    throw new Error(`Workstream state for "${args.stream.id}" not found`)
  }

  for (const task of workstreamState.hierarchy.tasks) {
    if (task.threadId !== args.threadId) {
      continue
    }

    updateStructuredTask(workstreamState, {
      taskId: task.id,
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.breadcrumb !== undefined ? { breadcrumb: args.breadcrumb } : {}),
      ...(args.report !== undefined ? { report: args.report } : {}),
      ...(args.assigned_agent !== undefined ? { assignedAgent: args.assigned_agent } : {}),
      updatedAt,
    })
  }

  replaceStructuredWorkstreamStateSync({
    repoRoot: args.repoRoot,
    workstreamState,
  })

  const updatedTasks = getTasksByThread(
    args.repoRoot,
    args.stream.id,
    parsed.stage,
    parsed.batch,
    parsed.thread,
  )

  return {
    updated: true,
    file: "tasks.json",
    threadId: args.threadId,
    tasks: updatedTasks,
    count: updatedTasks.length,
  }
}

/**
 * Update a task's status in a workstream
 */
export async function updateTask(args: UpdateTaskArgs): Promise<UpdateTaskResult> {
  // Validate task ID format
  try {
    parseTaskId(args.taskId)
  } catch (e) {
    throw new Error(
      `Invalid task ID: ${args.taskId}. Expected format "stage.batch.thread.task" (e.g., "01.01.02.03")`,
    )
  }

  // Check if task exists and track previous status
  const existingTask = getTaskById(args.repoRoot, args.stream.id, args.taskId)
  if (!existingTask) {
    throw new Error(
      `Task "${args.taskId}" not found in workstream "${args.stream.id}". ` +
      `Run "work add-task" to add tasks, or "work validate plan" to check the plan.`,
    )
  }
  const parsedTaskId = parseTaskId(args.taskId)
  const threadId = formatThreadId(parsedTaskId.stage, parsedTaskId.batch, parsedTaskId.thread)

  const mutation = await mutateThreadTasks({
    repoRoot: args.repoRoot,
    stream: args.stream,
    threadId,
    status: args.status,
    note: args.note,
    breadcrumb: args.breadcrumb,
    report: args.report,
    assigned_agent: args.assigned_agent,
  })

  const updatedTask = mutation.tasks.find((task) => task.id === args.taskId) ?? getTaskById(args.repoRoot, args.stream.id, args.taskId)

  if (!updatedTask) {
    throw new Error(`Failed to update task "${args.taskId}"`)
  }

  return {
    updated: true,
    file: "tasks.json",
    taskId: args.taskId,
    threadId,
    status: args.status,
    task: updatedTask,
    tasks: mutation.tasks,
    count: mutation.count,
  }
}

export interface UpdateThreadTasksArgs {
  repoRoot: string
  stream: StreamMetadata
  threadId: string
  status: TaskStatus
  note?: string
  breadcrumb?: string
  report?: string
  assigned_agent?: string
}

export interface UpdateThreadTasksResult {
  updated: boolean
  file: string
  threadId: string
  status: TaskStatus
  tasks: Task[]
  count: number
}

/**
 * Update all tasks in a thread
 */
export async function updateThreadTasks(args: UpdateThreadTasksArgs): Promise<UpdateThreadTasksResult> {
  const mutation = await mutateThreadTasks(args)
  return {
    ...mutation,
    status: args.status,
  }
}

// Re-export parseTaskId for backwards compatibility
export { parseTaskId } from "./tasks.ts"
