/**
 * Logic for the 'continue' command
 */

import {
  queryExecutionItemsForWorkstream,
  queryThreadsForWorkstream,
  type ExecutionItemQueryRecord,
  type HierarchyThreadQueryRecord,
} from "./hierarchy-query.ts"

export interface ContinueContext {
  activeThread?: HierarchyThreadQueryRecord
  nextThread?: HierarchyThreadQueryRecord
  lastCompletedThread?: HierarchyThreadQueryRecord
  activeItem?: ExecutionItemQueryRecord
  nextItem?: ExecutionItemQueryRecord
  lastCompletedItem?: ExecutionItemQueryRecord
  streamId: string
  streamName: string
  assignedAgent?: string
}

export function getContinueContext(
  repoRoot: string,
  streamId: string,
  streamName: string,
): ContinueContext {
  const threadViews = queryThreadsForWorkstream(repoRoot, streamId)
  const activeThread = threadViews.find((thread) => thread.aggregateStatus === "in_progress")
  const nextThread = threadViews.find((thread) => thread.aggregateStatus === "pending")
  const lastCompletedThread = [...threadViews]
    .reverse()
    .find((thread) => thread.aggregateStatus === "completed")

  const items = queryExecutionItemsForWorkstream(repoRoot, streamId)
  const firstItemForThread = (threadId?: string) =>
    threadId ? items.find((item) => item.threadId === threadId) : undefined

  const activeItem = firstItemForThread(activeThread?.threadId)
  const nextItem = firstItemForThread(nextThread?.threadId)
  const lastCompletedItem = firstItemForThread(lastCompletedThread?.threadId)

  return {
    activeThread,
    nextThread,
    lastCompletedThread,
    activeItem,
    nextItem,
    lastCompletedItem,
    streamId,
    streamName,
    assignedAgent: activeThread?.assignedAgent ?? nextThread?.assignedAgent,
  }
}
