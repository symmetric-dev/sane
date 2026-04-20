/**
 * Task update operations
 *
 * Updates task status in tasks.json
 */


import type { TaskStatus, StreamMetadata, Task } from "./types.ts"
import {
  loadStructuredWorkstreamStateSync,
  replaceStructuredWorkstreamStateSync,
  updateStructuredTaskSync,
} from "./storage-adapter.ts"
import { updateStructuredTask } from "./structured-storage.ts"
import {
  getTaskById,
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
  status: TaskStatus
  task: Task | null
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
  // Update the task
  updateStructuredTaskSync(args.repoRoot, args.stream.id, {
    taskId: args.taskId,
    status: args.status,
    breadcrumb: args.breadcrumb,
    report: args.report,
    assignedAgent: args.assigned_agent,
  })

  const updatedTask = getTaskById(args.repoRoot, args.stream.id, args.taskId)

  if (!updatedTask) {
    throw new Error(`Failed to update task "${args.taskId}"`)
  }

  return {
    updated: true,
    file: "tasks.json",
    taskId: args.taskId,
    status: args.status,
    task: updatedTask,
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
  // Parse the thread ID

  let parsed: { stage: number; batch: number; thread: number }
  try {
    parsed = parseThreadId(args.threadId)
  } catch (e) {
    throw new Error(
      `Invalid thread ID: ${args.threadId}. Expected format "stage.batch.thread" (e.g., "01.01.02")`,
    )
  }

  // Update all tasks in the thread
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
      status: args.status,
      breadcrumb: args.breadcrumb,
      report: args.report,
      assignedAgent: args.assigned_agent,
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
    status: args.status,
    tasks: updatedTasks,
    count: updatedTasks.length,
  }
}

// Re-export parseTaskId for backwards compatibility
export { parseTaskId } from "./tasks.ts"
