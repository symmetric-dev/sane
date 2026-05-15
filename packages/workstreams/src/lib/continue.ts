/**
 * Logic for the 'continue' command
 */

import {
  queryTaskByIdForWorkstream,
  queryThreadsForWorkstream,
} from "./hierarchy-query.ts"
import { getTasks } from "./tasks.ts"
import type { Task } from "./types.ts"

export interface ContinueContext {
  activeTask?: Task
  nextTask?: Task
  lastCompletedTask?: Task
  streamId: string
  streamName: string
  assignedAgent?: string // Agent assigned to active task (from task.assigned_agent)
}

export function getContinueContext(
  repoRoot: string,
  streamId: string,
  streamName: string,
): ContinueContext {
  let threadViews: ReturnType<typeof queryThreadsForWorkstream> = []
  try {
    threadViews = queryThreadsForWorkstream(repoRoot, streamId)
  } catch {
    threadViews = []
  }
  if (threadViews.length > 0) {
    const activeThread = threadViews.find((thread) => thread.aggregateStatus === "in_progress")
    const nextThread = threadViews.find((thread) => thread.aggregateStatus === "pending")
    const lastCompletedThread = [...threadViews]
      .reverse()
      .find((thread) => thread.aggregateStatus === "completed")

    const activeTask =
      (activeThread?.representativeTaskId
        ? queryTaskByIdForWorkstream(repoRoot, streamId, activeThread.representativeTaskId)
        : null) ?? undefined
    const nextTask =
      (nextThread?.representativeTaskId
        ? queryTaskByIdForWorkstream(repoRoot, streamId, nextThread.representativeTaskId)
        : null) ?? undefined
    const lastCompletedTask =
      (lastCompletedThread?.representativeTaskId
        ? queryTaskByIdForWorkstream(repoRoot, streamId, lastCompletedThread.representativeTaskId)
        : null) ?? undefined

    return {
      activeTask,
      nextTask,
      lastCompletedTask,
      streamId,
      streamName,
      assignedAgent: activeThread?.assignedAgent ?? nextThread?.assignedAgent,
    }
  }

  const tasks = getTasks(repoRoot, streamId)
  const activeTask = tasks.find((t) => t.status === "in_progress")
  const nextTask = tasks.find((t) => t.status === "pending")

  // Get assigned agent directly from task
  const targetTask = activeTask || nextTask
  const assignedAgent = targetTask?.assigned_agent || undefined

  return {
    activeTask,
    nextTask,
    lastCompletedTask: [...tasks]
      .reverse()
      .find((t) => t.status === "completed"),
    streamId,
    streamName,
    assignedAgent,
  }
}
