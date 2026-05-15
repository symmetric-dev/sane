/**
 * Thread-first mutation operations over canonical workstream state.
 */
import type { ExecutionItem, ExecutionStatus, StreamMetadata } from "./types.ts"
import {
  loadStructuredWorkstreamStateSync,
  replaceStructuredWorkstreamStateSync,
} from "./storage-adapter.ts"
import { upsertStructuredThreadRuntime } from "./structured-storage.ts"
import { queryExecutionItemsForWorkstream } from "./hierarchy-query.ts"
import { parseThreadId } from "./execution-ids.ts"

export interface MutateThreadExecutionArgs {
  repoRoot: string
  stream: StreamMetadata
  threadId: string
  status?: ExecutionStatus
  note?: string
  breadcrumb?: string
  report?: string
  assigned_agent?: string
}

export interface MutateThreadExecutionResult {
  updated: boolean
  storage: "structured_workstream_state"
  threadId: string
  thread: ExecutionItem
}

export async function mutateThreadExecution(args: MutateThreadExecutionArgs): Promise<MutateThreadExecutionResult> {
  let parsed: { stage: number; batch: number; thread: number }
  try {
    parsed = parseThreadId(args.threadId)
  } catch {
    throw new Error(
      `Invalid thread ID: ${args.threadId}. Expected format "stage.batch.thread" (e.g., "01.01.02")`,
    )
  }

  const existingItem = queryExecutionItemsForWorkstream(args.repoRoot, args.stream.id).find(
    (item) => item.threadId === args.threadId,
  )

  if (!existingItem) {
    throw new Error(
      `Thread "${args.threadId}" not found in workstream "${args.stream.id}".`,
    )
  }

  const updatedAt = new Date().toISOString()
  const workstreamState = loadStructuredWorkstreamStateSync(args.repoRoot, args.stream.id)
  if (!workstreamState) {
    throw new Error(`Workstream state for "${args.stream.id}" not found`)
  }

  const existingRuntime = workstreamState.threadRuntime.find((thread) => thread.threadId === args.threadId)
  upsertStructuredThreadRuntime(workstreamState, {
    threadId: args.threadId,
    sessions: existingRuntime?.sessions ?? [],
    status: args.status ?? existingRuntime?.status ?? "pending",
    createdAt: existingRuntime?.createdAt ?? updatedAt,
    updatedAt,
    itemName: existingRuntime?.itemName ?? existingItem.name,
    ...(args.breadcrumb !== undefined
      ? { breadcrumb: args.breadcrumb }
      : existingRuntime?.breadcrumb
        ? { breadcrumb: existingRuntime.breadcrumb }
        : {}),
    ...(args.report !== undefined
      ? { report: args.report }
      : existingRuntime?.report
        ? { report: existingRuntime.report }
        : {}),
    ...(args.assigned_agent !== undefined
      ? { assignedAgent: args.assigned_agent }
      : existingRuntime?.assignedAgent
        ? { assignedAgent: existingRuntime.assignedAgent }
        : {}),
    ...(existingRuntime?.currentSessionId ? { currentSessionId: existingRuntime.currentSessionId } : {}),
    ...(existingRuntime?.opencodeSessionId ? { opencodeSessionId: existingRuntime.opencodeSessionId } : {}),
    ...(existingRuntime?.workingAgentSessionId ? { workingAgentSessionId: existingRuntime.workingAgentSessionId } : {}),
    ...(existingRuntime?.synthesisOutput ? { synthesisOutput: existingRuntime.synthesisOutput } : {}),
    ...(existingRuntime?.synthesis ? { synthesis: existingRuntime.synthesis } : {}),
  })

  replaceStructuredWorkstreamStateSync({
    repoRoot: args.repoRoot,
    workstreamState,
  })

  const thread = {
    ...existingItem,
    name: existingRuntime?.itemName ?? existingItem.name,
    updatedAt,
    status: args.status ?? existingRuntime?.status ?? existingItem.status,
    ...(args.breadcrumb !== undefined
      ? { breadcrumb: args.breadcrumb }
      : existingRuntime?.breadcrumb
        ? { breadcrumb: existingRuntime.breadcrumb }
        : existingItem.breadcrumb
          ? { breadcrumb: existingItem.breadcrumb }
          : {}),
    ...(args.report !== undefined
      ? { report: args.report }
      : existingRuntime?.report
        ? { report: existingRuntime.report }
        : existingItem.report
          ? { report: existingItem.report }
          : {}),
    ...(args.assigned_agent !== undefined
      ? { assignedAgent: args.assigned_agent }
      : existingRuntime?.assignedAgent
        ? { assignedAgent: existingRuntime.assignedAgent }
        : existingItem.assignedAgent
          ? { assignedAgent: existingItem.assignedAgent }
          : {}),
  }

  return {
    updated: true,
    storage: "structured_workstream_state",
    threadId: args.threadId,
    thread,
  }
}

export interface UpdateThreadExecutionArgs {
  repoRoot: string
  stream: StreamMetadata
  threadId: string
  status: ExecutionStatus
  note?: string
  breadcrumb?: string
  report?: string
  assigned_agent?: string
}

export interface UpdateThreadExecutionResult {
  updated: boolean
  storage: "structured_workstream_state"
  threadId: string
  thread: ExecutionItem
}

/**
 * Update thread execution state.
 */
export async function updateThreadExecution(
  args: UpdateThreadExecutionArgs,
): Promise<UpdateThreadExecutionResult> {
  return mutateThreadExecution(args)
}
