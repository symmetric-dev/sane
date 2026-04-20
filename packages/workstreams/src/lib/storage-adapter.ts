import { getOrCreateIndex, modifyIndex, saveIndex } from "./index.ts"
import {
  approvalMetadataToStructuredApprovalRecords,
  createEmptyStructuredStorageWorkstreamState,
  createStreamMetadataFromStructuredStorageRecord,
  createStructuredStorageWorkstreamRecord,
  structuredApprovalRecordsToApprovalMetadata,
  type StructuredBatchRecord,
  type StructuredStageRecord,
  type StructuredStorageStateAdapter,
  type StructuredStorageWorkspaceState,
  type StructuredStorageWorkstreamState,
  updateStructuredTask,
  type StructuredTaskRecord,
  type StructuredThreadRecord,
  type StructuredThreadRuntimeRecord,
} from "./structured-storage.ts"
import {
  createEmptyTasksFile,
  modifyTasksFile,
  normalizeRuntimeState,
  normalizeSupervisorState,
  readTasksFile,
  writeTasksFile,
} from "./tasks.ts"
import type { Task, TasksFile, ThreadMetadata, WorkIndex } from "./types.ts"

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function parseHierarchicalId(id: string): [string, string, string, string] {
  const parts = id.split(".")
  if (parts.length !== 4) {
    throw new Error(`Invalid task id: ${id}`)
  }

  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

function cloneWorkstreamState(state: StructuredStorageWorkstreamState): StructuredStorageWorkstreamState {
  return {
    streamId: state.streamId,
    hierarchy: {
      stages: state.hierarchy.stages.map((stage) => ({ ...stage })),
      batches: state.hierarchy.batches.map((batch) => ({ ...batch })),
      threads: state.hierarchy.threads.map((thread) => ({ ...thread })),
      tasks: state.hierarchy.tasks.map((task) => ({ ...task })),
    },
    approvals: state.approvals.map((approval) => ({ ...approval })),
    threadRuntime: state.threadRuntime.map((record) => ({
      threadId: record.threadId,
      sessions: record.sessions.map((session) => ({
        ...session,
        ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
      })),
      ...(record.currentSessionId ? { currentSessionId: record.currentSessionId } : {}),
      ...(record.opencodeSessionId ? { opencodeSessionId: record.opencodeSessionId } : {}),
      ...(record.workingAgentSessionId ? { workingAgentSessionId: record.workingAgentSessionId } : {}),
      ...(record.synthesisOutput ? { synthesisOutput: record.synthesisOutput } : {}),
      ...(record.synthesis ? { synthesis: { ...record.synthesis } } : {}),
    })),
    batchRuns: state.batchRuns.map((batchRun) => ({
      ...batchRun,
      summary: { ...batchRun.summary },
      threads: batchRun.threads.map((thread) => ({ ...thread })),
    })),
    supervision: normalizeSupervisorState(state.streamId, state.supervision),
  }
}

function workspaceStateFromIndex(index: WorkIndex): StructuredStorageWorkspaceState {
  return {
    ...(index.current_stream ? { currentStreamId: index.current_stream } : {}),
    workstreams: index.streams.map(createStructuredStorageWorkstreamRecord),
  }
}

function indexFromWorkspaceState(
  state: StructuredStorageWorkspaceState,
  previousIndex: WorkIndex,
): WorkIndex {
  const approvalByStreamId = new Map(
    previousIndex.streams.map((stream) => [stream.id, stream.approval] as const),
  )

  return {
    version: previousIndex.version ?? "1.0.0",
    last_updated: previousIndex.last_updated,
    ...(state.currentStreamId ? { current_stream: state.currentStreamId } : {}),
    streams: state.workstreams.map((record) =>
      createStreamMetadataFromStructuredStorageRecord({
        record,
        approval: approvalByStreamId.get(record.id),
      }),
    ),
  }
}

function toStructuredThreadRuntimeRecord(record: ThreadMetadata): StructuredThreadRuntimeRecord {
  return {
    threadId: record.threadId,
    sessions: record.sessions.map((session) => ({
      ...session,
      ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
    })),
    ...(record.currentSessionId ? { currentSessionId: record.currentSessionId } : {}),
    ...(record.opencodeSessionId ? { opencodeSessionId: record.opencodeSessionId } : {}),
    ...(record.workingAgentSessionId ? { workingAgentSessionId: record.workingAgentSessionId } : {}),
    ...(record.synthesisOutput ? { synthesisOutput: record.synthesisOutput } : {}),
    ...(record.synthesis ? { synthesis: { ...record.synthesis } } : {}),
  }
}

function toThreadMetadata(
  record: StructuredThreadRuntimeRecord,
  thread?: StructuredThreadRecord,
): ThreadMetadata {
  return {
    threadId: record.threadId,
    sessions: record.sessions.map((session) => ({
      ...session,
      ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
    })),
    ...(thread?.promptPath ? { promptPath: thread.promptPath } : {}),
    ...(record.currentSessionId ? { currentSessionId: record.currentSessionId } : {}),
    ...(record.opencodeSessionId ? { opencodeSessionId: record.opencodeSessionId } : {}),
    ...(record.workingAgentSessionId ? { workingAgentSessionId: record.workingAgentSessionId } : {}),
    ...(record.synthesisOutput ? { synthesisOutput: record.synthesisOutput } : {}),
    ...(record.synthesis ? { synthesis: { ...record.synthesis } } : {}),
  }
}

function buildHierarchyFromTasks(tasks: Task[]): {
  stages: StructuredStageRecord[]
  batches: StructuredBatchRecord[]
  threads: StructuredThreadRecord[]
  tasks: StructuredTaskRecord[]
} {
  const stages = new Map<string, StructuredStageRecord>()
  const batches = new Map<string, StructuredBatchRecord>()
  const threads = new Map<string, StructuredThreadRecord>()
  const structuredTasks: StructuredTaskRecord[] = []

  for (const task of tasks) {
    const [stageId, batchNumber, threadNumber, taskNumber] = parseHierarchicalId(task.id)
    const batchId = `${stageId}.${batchNumber}`
    const threadId = `${batchId}.${threadNumber}`

    if (!stages.has(stageId)) {
      stages.set(stageId, {
        id: stageId,
        number: Number.parseInt(stageId, 10),
        name: task.stage_name,
      })
    }

    if (!batches.has(batchId)) {
      batches.set(batchId, {
        id: batchId,
        stageId,
        number: Number.parseInt(batchNumber, 10),
        name: task.batch_name,
      })
    }

    if (!threads.has(threadId)) {
      threads.set(threadId, {
        id: threadId,
        stageId,
        batchId,
        number: Number.parseInt(threadNumber, 10),
        name: task.thread_name,
      })
    }

    structuredTasks.push({
      id: task.id,
      stageId,
      batchId,
      threadId,
      number: Number.parseInt(taskNumber, 10),
      name: task.name,
      status: task.status,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      ...(task.breadcrumb ? { breadcrumb: task.breadcrumb } : {}),
      ...(task.report ? { report: task.report } : {}),
      ...(task.assigned_agent ? { assignedAgent: task.assigned_agent } : {}),
    })
  }

  return {
    stages: [...stages.values()].sort((left, right) => compareIds(left.id, right.id)),
    batches: [...batches.values()].sort((left, right) => compareIds(left.id, right.id)),
    threads: [...threads.values()].sort((left, right) => compareIds(left.id, right.id)),
    tasks: structuredTasks.sort((left, right) => compareIds(left.id, right.id)),
  }
}

function tasksFileFromWorkstreamState(
  state: StructuredStorageWorkstreamState,
  existing?: TasksFile | null,
): TasksFile {
  const threadById = new Map(state.hierarchy.threads.map((thread) => [thread.id, thread] as const))
  const batchById = new Map(state.hierarchy.batches.map((batch) => [batch.id, batch] as const))
  const stageById = new Map(state.hierarchy.stages.map((stage) => [stage.id, stage] as const))

  const tasks: Task[] = [...state.hierarchy.tasks]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((task) => {
      const thread = threadById.get(task.threadId)
      const batch = batchById.get(task.batchId)
      const stage = stageById.get(task.stageId)

      if (!thread || !batch || !stage) {
        throw new Error(`Structured hierarchy is incomplete for task ${task.id}`)
      }

      return {
        id: task.id,
        name: task.name,
        thread_name: thread.name,
        batch_name: batch.name,
        stage_name: stage.name,
        status: task.status,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        ...(task.breadcrumb ? { breadcrumb: task.breadcrumb } : {}),
        ...(task.report ? { report: task.report } : {}),
        ...(task.assignedAgent ? { assigned_agent: task.assignedAgent } : {}),
      }
    })

  return {
    ...(existing ?? createEmptyTasksFile(state.streamId)),
    stream_id: state.streamId,
    runtime_state: {
      ...normalizeRuntimeState(state.streamId, existing?.runtime_state),
      threads: state.threadRuntime
        .map((record) => toThreadMetadata(record, threadById.get(record.threadId)))
        .sort((left, right) => compareIds(left.threadId, right.threadId)),
      batches: Object.fromEntries(
        [...state.batchRuns]
          .sort((left, right) => compareIds(left.batchId, right.batchId))
          .map((batchRun) => [batchRun.batchId, batchRun]),
      ),
      supervision: normalizeSupervisorState(state.streamId, state.supervision),
    },
    tasks,
  }
}

function workstreamStateFromSnapshot(
  index: WorkIndex,
  streamId: string,
  tasksFile?: TasksFile | null,
): StructuredStorageWorkstreamState | null {
  const stream = index.streams.find((entry) => entry.id === streamId)

  if (!tasksFile && !stream) {
    return null
  }

  const state = createEmptyStructuredStorageWorkstreamState(streamId)
  const runtimeState = normalizeRuntimeState(streamId, tasksFile?.runtime_state)
  const hierarchy = buildHierarchyFromTasks(tasksFile?.tasks ?? [])

  state.hierarchy = hierarchy
  state.approvals = approvalMetadataToStructuredApprovalRecords(streamId, stream?.approval)
  state.threadRuntime = runtimeState.threads
    .map(toStructuredThreadRuntimeRecord)
    .sort((left, right) => compareIds(left.threadId, right.threadId))
  state.batchRuns = Object.values(runtimeState.batches).sort((left, right) => compareIds(left.batchId, right.batchId))
  state.supervision = normalizeSupervisorState(streamId, runtimeState.supervision)

  for (const thread of state.hierarchy.threads) {
    const runtime = runtimeState.threads.find((record) => record.threadId === thread.id)
    if (runtime?.promptPath) {
      thread.promptPath = runtime.promptPath
    }
  }

  return state
}

async function persistWorkstreamApprovals(
  repoRoot: string,
  streamId: string,
  workstreamState: StructuredStorageWorkstreamState,
): Promise<void> {
  const nextApproval = structuredApprovalRecordsToApprovalMetadata(workstreamState.approvals)
  const existing = getOrCreateIndex(repoRoot)

  if (!existing.streams.some((stream) => stream.id === streamId)) {
    return
  }

  await modifyIndex(repoRoot, (index) => {
    const stream = index.streams.find((entry) => entry.id === streamId)
    if (!stream) {
      return
    }

    if (nextApproval) {
      stream.approval = nextApproval
    } else {
      delete stream.approval
    }
  })
}

export function createFilesystemStructuredStorageAdapter(): StructuredStorageStateAdapter {
  return {
    kind: "filesystem",
    async loadWorkspaceState(repoRoot: string): Promise<StructuredStorageWorkspaceState> {
      return workspaceStateFromIndex(getOrCreateIndex(repoRoot))
    },

    async replaceWorkspaceState(
      repoRoot: string,
      workspaceState: StructuredStorageWorkspaceState,
    ): Promise<void> {
      const previousIndex = getOrCreateIndex(repoRoot)
      saveIndex(repoRoot, indexFromWorkspaceState(workspaceState, previousIndex))
    },

    async modifyWorkspaceState<T>(
      repoRoot: string,
      fn: (workspaceState: StructuredStorageWorkspaceState) => T | Promise<T>,
    ): Promise<T> {
      const workspaceState = workspaceStateFromIndex(getOrCreateIndex(repoRoot))
      const result = await fn(workspaceState)
      const previousIndex = getOrCreateIndex(repoRoot)
      saveIndex(repoRoot, indexFromWorkspaceState(workspaceState, previousIndex))
      return result
    },

    async loadWorkstreamState(
      repoRoot: string,
      streamId: string,
    ): Promise<StructuredStorageWorkstreamState | null> {
      return workstreamStateFromSnapshot(getOrCreateIndex(repoRoot), streamId, readTasksFile(repoRoot, streamId))
    },

    async replaceWorkstreamState(
      repoRoot: string,
      workstreamState: StructuredStorageWorkstreamState,
    ): Promise<void> {
      const nextState = cloneWorkstreamState(workstreamState)
      const existingTasksFile = readTasksFile(repoRoot, workstreamState.streamId)
      writeTasksFile(
        repoRoot,
        workstreamState.streamId,
        tasksFileFromWorkstreamState(nextState, existingTasksFile),
      )
      await persistWorkstreamApprovals(repoRoot, workstreamState.streamId, nextState)
    },

    async modifyWorkstreamState<T>(
      repoRoot: string,
      streamId: string,
      fn: (workstreamState: StructuredStorageWorkstreamState) => T | Promise<T>,
    ): Promise<T> {
      const result = await modifyTasksFile(repoRoot, streamId, async (tasksFile) => {
        const index = getOrCreateIndex(repoRoot)
        const currentState = workstreamStateFromSnapshot(index, streamId, tasksFile)
        const mutableState = cloneWorkstreamState(
          currentState ?? createEmptyStructuredStorageWorkstreamState(streamId),
        )
        const callbackResult = await fn(mutableState)
        const nextTasksFile = tasksFileFromWorkstreamState(mutableState, tasksFile)
        tasksFile.version = nextTasksFile.version
        tasksFile.stream_id = nextTasksFile.stream_id
        tasksFile.last_updated = nextTasksFile.last_updated
        tasksFile.runtime_state = nextTasksFile.runtime_state
        delete tasksFile.runtime_summary
        tasksFile.tasks = nextTasksFile.tasks
        await persistWorkstreamApprovals(repoRoot, streamId, mutableState)
        return callbackResult
      })

      return result
    },
  }
}

export function modifyStructuredWorkstreamStateSync<T>(
  args: {
    repoRoot: string
    streamId: string
    touchStreamUpdatedAt?: boolean
    writeTasksFileIfMissing?: boolean
  },
  fn: (workstreamState: StructuredStorageWorkstreamState) => T,
): T {
  const existingIndex = getOrCreateIndex(args.repoRoot)
  const existingTasksFile = readTasksFile(args.repoRoot, args.streamId)
  const currentState = workstreamStateFromSnapshot(existingIndex, args.streamId, existingTasksFile)
  const mutableState = cloneWorkstreamState(
    currentState ?? createEmptyStructuredStorageWorkstreamState(args.streamId),
  )
  const result = fn(mutableState)

  if (existingTasksFile || args.writeTasksFileIfMissing !== false) {
    writeTasksFile(
      args.repoRoot,
      args.streamId,
      tasksFileFromWorkstreamState(mutableState, existingTasksFile),
    )
  }

  const stream = existingIndex.streams.find((entry) => entry.id === args.streamId)
  if (!stream) {
    return result
  }

  const nextApproval = structuredApprovalRecordsToApprovalMetadata(mutableState.approvals)
  const approvalChanged = JSON.stringify(stream.approval ?? null) !== JSON.stringify(nextApproval ?? null)

  if (nextApproval) {
    stream.approval = nextApproval
  } else {
    delete stream.approval
  }

  if (args.touchStreamUpdatedAt) {
    stream.updated_at = new Date().toISOString()
  }

  if (approvalChanged || args.touchStreamUpdatedAt) {
    saveIndex(args.repoRoot, existingIndex)
  }

  return result
}

export function updateStructuredTaskSync(
  repoRoot: string,
  streamId: string,
  mutation: Parameters<typeof updateStructuredTask>[1],
): StructuredTaskRecord | null {
  return modifyStructuredWorkstreamStateSync({ repoRoot, streamId }, (workstreamState) =>
    updateStructuredTask(workstreamState, mutation),
  )
}

export const filesystemStructuredStorageAdapter = createFilesystemStructuredStorageAdapter()

export function getStructuredStorageAdapter(): StructuredStorageStateAdapter {
  return filesystemStructuredStorageAdapter
}
