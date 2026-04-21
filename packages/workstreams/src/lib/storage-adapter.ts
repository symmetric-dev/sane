import { existsSync } from "fs"
import { getOrCreateIndex, modifyIndex, saveIndex } from "./index.ts"
export {
  createFilesystemAuthoritativeSqliteStructuredStorageAdapter,
  type FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions,
} from "./sqlite-storage-adapter.ts"
import { createFilesystemAuthoritativeSqliteStructuredStorageAdapter } from "./sqlite-storage-adapter.ts"
import {
  approvalMetadataToStructuredApprovalRecords,
  createStructuredStorageParitySnapshot,
  createEmptyStructuredStorageWorkstreamState,
  createStreamMetadataFromStructuredStorageRecord,
  createStructuredStorageWorkstreamRecord,
  replaceStructuredApprovals,
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
  upsertStructuredBatchRun,
  upsertStructuredThreadRuntime,
} from "./structured-storage.ts"
import {
  loadSqliteCriticalWorkflowParityProjection,
  modifySqliteStructuredStorageWorkstreamState,
  loadSqliteStructuredStorageWorkspaceState,
  loadSqliteStructuredStorageWorkstreamState,
  recordSqliteStructuredStorageMirrorState,
  syncStructuredStorageWorkspaceStateToSqlite,
  syncStructuredStorageWorkstreamStateToSqlite,
  type CriticalWorkflowParityProjection,
  type CriticalWorkflowThreadParityRecord,
} from "./sqlite-storage.ts"
import {
  createEmptyTasksFile,
  getTasksFilePath,
  modifyTasksFile,
  normalizeRuntimeState,
  normalizeSupervisorState,
  readTasksFile,
  writeTasksFile,
} from "./tasks.ts"
import type {
  ApprovalMetadata,
  PersistedBatchStatusFile,
  SupervisorStateFile,
  Task,
  TasksFile,
  ThreadMetadata,
  ThreadsJson,
  WorkIndex,
} from "./types.ts"

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

export interface CriticalWorkflowFilesystemCompatibilityData {
  threadMetadataViewEnvelope?: {
    version: string
    lastUpdated: string
  }
}

export interface CriticalWorkflowDualWriteParityInspection {
  streamId: string
  filesystem: CriticalWorkflowParityProjection
  sqlite: CriticalWorkflowParityProjection | null
  parity: {
    tasks: boolean
    threads: boolean
    approvals: boolean
    batchRuns: boolean
    supervisionRuns: boolean
    all: boolean
  }
  intentionalMismatches: Array<{
    entity: string
    path: string
    reason: string
  }>
  filesystemCompatibilityOnlyData: CriticalWorkflowFilesystemCompatibilityData
}

function normalizeThreadSessionsForParity(sessions: ThreadMetadata["sessions"]): ThreadMetadata["sessions"] {
  return sessions
    .map((session) => ({
      ...session,
      ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
    }))
    .sort((left, right) => {
      const startedAtOrder = (left.startedAt ?? "").localeCompare(right.startedAt ?? "")
      if (startedAtOrder !== 0) return startedAtOrder
      return compareIds(left.sessionId, right.sessionId)
    })
}

function threadRecordsForParity(
  state: StructuredStorageWorkstreamState,
): CriticalWorkflowThreadParityRecord[] {
  const runtimeByThreadId = new Map(state.threadRuntime.map((record) => [record.threadId, record] as const))

  return [...state.hierarchy.threads]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((thread) => {
      const runtime = runtimeByThreadId.get(thread.id)
      return {
        threadId: thread.id,
        stageId: thread.stageId,
        batchId: thread.batchId,
        number: thread.number,
        name: thread.name,
        ...(thread.promptPath ? { promptPath: thread.promptPath } : {}),
        ...(runtime?.currentSessionId ? { currentSessionId: runtime.currentSessionId } : {}),
        ...(runtime?.opencodeSessionId ? { opencodeSessionId: runtime.opencodeSessionId } : {}),
        ...(runtime?.workingAgentSessionId
          ? { workingAgentSessionId: runtime.workingAgentSessionId }
          : {}),
        ...(runtime?.synthesisOutput ? { synthesisOutput: runtime.synthesisOutput } : {}),
        ...(runtime?.synthesis ? { synthesis: { ...runtime.synthesis } } : {}),
        sessions: runtime ? normalizeThreadSessionsForParity(runtime.sessions) : [],
      }
    })
}

function buildCriticalWorkflowParityProjection(
  state: StructuredStorageWorkstreamState,
): CriticalWorkflowParityProjection {
  const paritySnapshot = createStructuredStorageParitySnapshot({
    workspace: { workstreams: [] },
    workstream: state,
  }).workstream

  if (!paritySnapshot) {
    return {
      tasks: [],
      threads: [],
      approvals: [],
      batchRuns: [],
      supervisionRuns: [],
    }
  }

  return {
    tasks: paritySnapshot.hierarchy.tasks.map((task) => ({ ...task })),
    threads: threadRecordsForParity(paritySnapshot),
    approvals: paritySnapshot.approvals.map((approval) => ({ ...approval })),
    batchRuns: paritySnapshot.batchRuns.map((run) => ({
      ...run,
      summary: { ...run.summary },
      threads: run.threads.map((thread) => ({ ...thread })),
    })),
    supervisionRuns: paritySnapshot.supervision.runs.map((run) => ({
      ...run,
      issueSummaryIds: [...run.issueSummaryIds],
      escalationIds: [...run.escalationIds],
    })),
  }
}

function parityEqual<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
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

function threadsFileFromWorkstreamState(
  state: StructuredStorageWorkstreamState,
): ThreadsJson {
  const threadById = new Map(state.hierarchy.threads.map((thread) => [thread.id, thread] as const))

  return {
    version: "1.0.0",
    stream_id: state.streamId,
    last_updated: new Date().toISOString(),
    threads: state.threadRuntime.map((threadRuntime) => ({
      threadId: threadRuntime.threadId,
      sessions: threadRuntime.sessions,
      ...(threadById.get(threadRuntime.threadId)?.promptPath
        ? { promptPath: threadById.get(threadRuntime.threadId)?.promptPath }
        : {}),
      ...(threadRuntime.currentSessionId ? { currentSessionId: threadRuntime.currentSessionId } : {}),
      ...(threadRuntime.opencodeSessionId ? { opencodeSessionId: threadRuntime.opencodeSessionId } : {}),
      ...(threadRuntime.workingAgentSessionId
        ? { workingAgentSessionId: threadRuntime.workingAgentSessionId }
        : {}),
      ...(threadRuntime.synthesisOutput ? { synthesisOutput: threadRuntime.synthesisOutput } : {}),
      ...(threadRuntime.synthesis ? { synthesis: threadRuntime.synthesis } : {}),
    })),
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

function loadFilesystemStructuredWorkstreamStateSync(
  repoRoot: string,
  streamId: string,
): StructuredStorageWorkstreamState | null {
  return workstreamStateFromSnapshot(getOrCreateIndex(repoRoot), streamId, readTasksFile(repoRoot, streamId))
}

function loadRuntimeCanonicalMutationSeedSync(
  repoRoot: string,
  streamId: string,
): StructuredStorageWorkstreamState | null {
  const filesystemState = loadFilesystemStructuredWorkstreamStateSync(repoRoot, streamId)
  const sqliteState = loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId)

  if (filesystemState && sqliteState) {
    return {
      streamId,
      hierarchy: {
        stages: filesystemState.hierarchy.stages.map((stage) => ({ ...stage })),
        batches: filesystemState.hierarchy.batches.map((batch) => ({ ...batch })),
        threads: filesystemState.hierarchy.threads.map((thread) => ({ ...thread })),
        tasks: filesystemState.hierarchy.tasks.map((task) => ({ ...task })),
      },
      approvals: filesystemState.approvals.map((approval) => ({ ...approval })),
      threadRuntime: sqliteState.threadRuntime.map((record) => ({
        ...record,
        sessions: record.sessions.map((session) => ({
          ...session,
          ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
        })),
        ...(record.synthesis ? { synthesis: { ...record.synthesis } } : {}),
      })),
      batchRuns: sqliteState.batchRuns.map((batchRun) => ({
        ...batchRun,
        summary: { ...batchRun.summary },
        threads: batchRun.threads.map((thread) => ({ ...thread })),
      })),
      supervision: normalizeSupervisorState(streamId, sqliteState.supervision),
    }
  }

  return sqliteState ?? filesystemState
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

function syncWorkspaceStateMirror(args: { repoRoot: string; operation: string; streamId?: string }): void {
  try {
    syncStructuredStorageWorkspaceStateToSqlite(
      args.repoRoot,
      workspaceStateFromIndex(getOrCreateIndex(args.repoRoot)),
    )
    recordSqliteStructuredStorageMirrorState({
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "workspace",
      result: "success",
      ...(args.streamId ? { streamId: args.streamId } : {}),
    })
  } catch (error) {
    recordSqliteStructuredStorageMirrorState({
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "workspace",
      result: "error",
      ...(args.streamId ? { streamId: args.streamId } : {}),
      error,
    })
  }
}

function syncWorkstreamStateMirror(args: {
  repoRoot: string
  operation: string
  workstreamState: StructuredStorageWorkstreamState
}): void {
  try {
    syncStructuredStorageWorkstreamStateToSqlite(
      args.repoRoot,
      cloneWorkstreamState(args.workstreamState),
    )
    recordSqliteStructuredStorageMirrorState({
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "workstream",
      result: "success",
      streamId: args.workstreamState.streamId,
    })
  } catch (error) {
    recordSqliteStructuredStorageMirrorState({
      repoRoot: args.repoRoot,
      operation: args.operation,
      phase: "workstream",
      result: "error",
      streamId: args.workstreamState.streamId,
      error,
    })
  }
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
  const mutableState = cloneWorkstreamState(
    loadStructuredWorkstreamStateSync(args.repoRoot, args.streamId) ??
      createEmptyStructuredStorageWorkstreamState(args.streamId),
  )
  const result = fn(mutableState)
  replaceStructuredWorkstreamStateSync({
    repoRoot: args.repoRoot,
    workstreamState: mutableState,
    touchStreamUpdatedAt: args.touchStreamUpdatedAt,
    writeTasksFileIfMissing: args.writeTasksFileIfMissing,
  })

  return result
}

export function loadStructuredWorkstreamStateSync(
  repoRoot: string,
  streamId: string,
): StructuredStorageWorkstreamState | null {
  try {
    const sqliteState = loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId)
    if (sqliteState) {
      return sqliteState
    }
  } catch {
    // Fall back to compatibility projections while sqlite is busy.
  }

  return loadFilesystemStructuredWorkstreamStateSync(repoRoot, streamId)
}

export function loadStructuredWorkspaceStateSync(
  repoRoot: string,
): StructuredStorageWorkspaceState {
  try {
    const sqliteState = loadSqliteStructuredStorageWorkspaceState(repoRoot)
    if (sqliteState) {
      return sqliteState
    }
  } catch {
    // Fall back to compatibility projections while sqlite is busy.
  }

  return workspaceStateFromIndex(getOrCreateIndex(repoRoot))
}

export function replaceStructuredWorkspaceStateSync(args: {
  repoRoot: string
  workspaceState: StructuredStorageWorkspaceState
}): void {
  const previousIndex = getOrCreateIndex(args.repoRoot)
  const nextWorkspaceState = structuredClone(args.workspaceState)

  try {
    syncStructuredStorageWorkspaceStateToSqlite(args.repoRoot, nextWorkspaceState)
    recordSqliteStructuredStorageMirrorState({
      repoRoot: args.repoRoot,
      operation: "replaceStructuredWorkspaceStateSync",
      phase: "workspace",
      result: "success",
    })
  } catch (error) {
    recordSqliteStructuredStorageMirrorState({
      repoRoot: args.repoRoot,
      operation: "replaceStructuredWorkspaceStateSync",
      phase: "workspace",
      result: "error",
      error,
    })
    throw error
  }

  saveIndex(args.repoRoot, indexFromWorkspaceState(nextWorkspaceState, previousIndex))
}

export function replaceStructuredWorkstreamStateSync(args: {
  repoRoot: string
  workstreamState: StructuredStorageWorkstreamState
  touchStreamUpdatedAt?: boolean
  writeTasksFileIfMissing?: boolean
}): void {
  const existingIndex = getOrCreateIndex(args.repoRoot)
  const existingTasksFile = readTasksFile(args.repoRoot, args.workstreamState.streamId)
  const nextState = cloneWorkstreamState(args.workstreamState)

  try {
    syncStructuredStorageWorkstreamStateToSqlite(args.repoRoot, nextState)
    recordSqliteStructuredStorageMirrorState({
      repoRoot: args.repoRoot,
      operation: "replaceStructuredWorkstreamStateSync",
      phase: "workstream",
      result: "success",
      streamId: args.workstreamState.streamId,
    })
  } catch (error) {
    recordSqliteStructuredStorageMirrorState({
      repoRoot: args.repoRoot,
      operation: "replaceStructuredWorkstreamStateSync",
      phase: "workstream",
      result: "error",
      streamId: args.workstreamState.streamId,
      error,
    })
    throw error
  }

  if (existingTasksFile || args.writeTasksFileIfMissing !== false) {
    writeTasksFile(
      args.repoRoot,
      args.workstreamState.streamId,
      tasksFileFromWorkstreamState(nextState, existingTasksFile),
    )
  }

  const stream = existingIndex.streams.find((entry) => entry.id === args.workstreamState.streamId)
  if (!stream) {
    return
  }

  const nextApproval = structuredApprovalRecordsToApprovalMetadata(nextState.approvals)
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

  syncWorkspaceStateMirror({
    repoRoot: args.repoRoot,
    operation: "replaceStructuredWorkstreamStateSync",
    streamId: args.workstreamState.streamId,
  })
}

function projectStructuredWorkstreamStateToCompatibilityFilesSync(args: {
  repoRoot: string
  workstreamState: StructuredStorageWorkstreamState
  writeTasksFileIfMissing?: boolean
}): void {
  const tasksFilePath = getTasksFilePath(args.repoRoot, args.workstreamState.streamId)
  if (!existsSync(tasksFilePath) && args.writeTasksFileIfMissing === false) {
    return
  }

  writeTasksFile(
    args.repoRoot,
    args.workstreamState.streamId,
    tasksFileFromWorkstreamState(args.workstreamState),
  )
}

export function modifySqliteCanonicalRuntimeWorkstreamStateSync<T>(args: {
  repoRoot: string
  streamId: string
  writeTasksFileIfMissing?: boolean
  fn: (workstreamState: StructuredStorageWorkstreamState) => T
}): T {
  const fallbackState =
    loadRuntimeCanonicalMutationSeedSync(args.repoRoot, args.streamId) ??
    createEmptyStructuredStorageWorkstreamState(args.streamId)
  const { result, workstreamState } = modifySqliteStructuredStorageWorkstreamState({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    baseState: fallbackState,
    preferBaseState: true,
    fn: args.fn,
  })

  projectStructuredWorkstreamStateToCompatibilityFilesSync({
    repoRoot: args.repoRoot,
    workstreamState,
    writeTasksFileIfMissing: args.writeTasksFileIfMissing,
  })

  return result
}

export function loadThreadMetadataViewSync(repoRoot: string, streamId: string): ThreadsJson | null {
  const workstreamState = loadRuntimeCanonicalMutationSeedSync(repoRoot, streamId)
  return workstreamState ? threadsFileFromWorkstreamState(workstreamState) : null
}

function applyThreadMetadataViewToWorkstreamState(
  workstreamState: StructuredStorageWorkstreamState,
  threadsFile: ThreadsJson,
): void {
  for (const thread of workstreamState.hierarchy.threads) {
    const metadata = threadsFile.threads.find((entry) => entry.threadId === thread.id)
    if (metadata?.promptPath !== undefined) {
      thread.promptPath = metadata.promptPath
    }
  }

  workstreamState.threadRuntime = []
  for (const thread of threadsFile.threads) {
    upsertStructuredThreadRuntime(workstreamState, {
      threadId: thread.threadId,
      sessions: thread.sessions,
      ...(thread.currentSessionId ? { currentSessionId: thread.currentSessionId } : {}),
      ...(thread.opencodeSessionId ? { opencodeSessionId: thread.opencodeSessionId } : {}),
      ...(thread.workingAgentSessionId ? { workingAgentSessionId: thread.workingAgentSessionId } : {}),
      ...(thread.synthesisOutput ? { synthesisOutput: thread.synthesisOutput } : {}),
      ...(thread.synthesis ? { synthesis: thread.synthesis } : {}),
    })
  }

  const referencedThreadIds = new Set<string>([
    ...workstreamState.hierarchy.tasks.map((task) => task.threadId),
    ...workstreamState.threadRuntime.map((thread) => thread.threadId),
    ...workstreamState.batchRuns.flatMap((batchRun) => batchRun.threads.map((thread) => thread.threadId)),
    ...workstreamState.supervision.branch_sessions
      .map((session) => session.threadId)
      .filter((threadId): threadId is string => typeof threadId === "string"),
  ])
  workstreamState.hierarchy.threads = workstreamState.hierarchy.threads.filter((thread) =>
    referencedThreadIds.has(thread.id)
  )

  const referencedBatchIds = new Set<string>([
    ...workstreamState.hierarchy.tasks.map((task) => task.batchId),
    ...workstreamState.hierarchy.threads.map((thread) => thread.batchId),
    ...workstreamState.batchRuns.map((batchRun) => batchRun.batchId),
    ...workstreamState.supervision.runs.flatMap((run) => [run.currentBatchId, run.lastReviewedBatchId]),
    ...workstreamState.supervision.branch_sessions.flatMap((session) => [
      session.batchId,
      session.scope?.level === "batch" ? session.scope.batchId : undefined,
    ]),
  ].filter((batchId): batchId is string => typeof batchId === "string"))
  workstreamState.hierarchy.batches = workstreamState.hierarchy.batches.filter((batch) =>
    referencedBatchIds.has(batch.id)
  )

  const referencedStageIds = new Set<string>([
    ...workstreamState.hierarchy.tasks.map((task) => task.stageId),
    ...workstreamState.hierarchy.batches.map((batch) => batch.stageId),
    ...workstreamState.approvals
      .map((approval) => approval.stageId)
      .filter((stageId): stageId is string => typeof stageId === "string"),
    ...workstreamState.supervision.runs.map((run) => run.stageId),
    ...workstreamState.supervision.branch_sessions
      .map((session) => session.scope?.stageId)
      .filter((stageId): stageId is string => typeof stageId === "string"),
  ])
  workstreamState.hierarchy.stages = workstreamState.hierarchy.stages.filter((stage) =>
    referencedStageIds.has(stage.id)
  )
}

export function modifyThreadMetadataViewSync<T>(args: {
  repoRoot: string
  streamId: string
  fn: (threadsFile: ThreadsJson) => T
}): T {
  return modifySqliteCanonicalRuntimeWorkstreamStateSync({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    fn: (workstreamState) => {
      const threadsFile = threadsFileFromWorkstreamState(workstreamState)
      const result = args.fn(threadsFile)
      applyThreadMetadataViewToWorkstreamState(workstreamState, threadsFile)
      return result
    },
  })
}

export function replaceThreadMetadataViewSync(args: {
  repoRoot: string
  streamId: string
  threadsFile: ThreadsJson
}): void {
  const workstreamState =
    loadRuntimeCanonicalMutationSeedSync(args.repoRoot, args.streamId) ??
    createEmptyStructuredStorageWorkstreamState(args.streamId)
  applyThreadMetadataViewToWorkstreamState(workstreamState, args.threadsFile)

  replaceStructuredWorkstreamStateSync({
    repoRoot: args.repoRoot,
    workstreamState,
  })
}

export function readStructuredBatchRunSync(
  repoRoot: string,
  streamId: string,
  batchId: string,
): PersistedBatchStatusFile | null {
  return loadRuntimeCanonicalMutationSeedSync(repoRoot, streamId)?.batchRuns.find((batch) => batch.batchId === batchId) ?? null
}

export function writeStructuredBatchRunSync(
  repoRoot: string,
  streamId: string,
  batchStatus: PersistedBatchStatusFile,
): void {
  const workstreamState =
    loadRuntimeCanonicalMutationSeedSync(repoRoot, streamId) ??
    createEmptyStructuredStorageWorkstreamState(streamId)
  upsertStructuredBatchRun(workstreamState, batchStatus)
  replaceStructuredWorkstreamStateSync({ repoRoot, workstreamState })
}

export function loadStructuredSupervisorStateSync(
  repoRoot: string,
  streamId: string,
): SupervisorStateFile | null {
  const workstreamState = loadRuntimeCanonicalMutationSeedSync(repoRoot, streamId)
  return workstreamState ? normalizeSupervisorState(streamId, workstreamState.supervision) : null
}

export function replaceStructuredSupervisorStateSync(args: {
  repoRoot: string
  streamId: string
  supervisorState: SupervisorStateFile
}): void {
  const workstreamState =
    loadStructuredWorkstreamStateSync(args.repoRoot, args.streamId) ??
    createEmptyStructuredStorageWorkstreamState(args.streamId)
  workstreamState.supervision = normalizeSupervisorState(args.streamId, args.supervisorState)
  replaceStructuredWorkstreamStateSync({ repoRoot: args.repoRoot, workstreamState })
}

export function updateStructuredApprovalsSync(args: {
  repoRoot: string
  streamId: string
  touchStreamUpdatedAt?: boolean
  writeTasksFileIfMissing?: boolean
  update: (approval: ApprovalMetadata | undefined) => ApprovalMetadata | undefined
}): ApprovalMetadata | undefined {
  const workstreamState =
    loadStructuredWorkstreamStateSync(args.repoRoot, args.streamId) ??
    createEmptyStructuredStorageWorkstreamState(args.streamId)
  const nextApproval = args.update(structuredApprovalRecordsToApprovalMetadata(workstreamState.approvals))
  replaceStructuredApprovals(
    workstreamState,
    approvalMetadataToStructuredApprovalRecords(args.streamId, nextApproval),
  )
  replaceStructuredWorkstreamStateSync({
    repoRoot: args.repoRoot,
    workstreamState,
    touchStreamUpdatedAt: args.touchStreamUpdatedAt,
    writeTasksFileIfMissing: args.writeTasksFileIfMissing,
  })
  return nextApproval
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

/**
 * Developer-facing parity inspection for filesystem-vs-sqlite dual-write checks.
 */
export function inspectCriticalWorkflowDualWriteParitySync(
  repoRoot: string,
  streamId: string,
): CriticalWorkflowDualWriteParityInspection | null {
  const filesystemState = loadStructuredWorkstreamStateSync(repoRoot, streamId)
  if (!filesystemState) {
    return null
  }

  const filesystem = buildCriticalWorkflowParityProjection(filesystemState)
  const sqlite = loadSqliteCriticalWorkflowParityProjection(repoRoot, streamId)
  const parity = {
    tasks: sqlite ? parityEqual(filesystem.tasks, sqlite.tasks) : false,
    threads: sqlite ? parityEqual(filesystem.threads, sqlite.threads) : false,
    approvals: sqlite ? parityEqual(filesystem.approvals, sqlite.approvals) : false,
    batchRuns: sqlite ? parityEqual(filesystem.batchRuns, sqlite.batchRuns) : false,
    supervisionRuns: sqlite ? parityEqual(filesystem.supervisionRuns, sqlite.supervisionRuns) : false,
    all: false,
  }
  parity.all = parity.tasks && parity.threads && parity.approvals && parity.batchRuns && parity.supervisionRuns

  const threadMetadataView = loadThreadMetadataViewSync(repoRoot, streamId)
  const filesystemCompatibilityOnlyData: CriticalWorkflowFilesystemCompatibilityData = {
    ...(threadMetadataView
      ? {
          threadMetadataViewEnvelope: {
            version: threadMetadataView.version,
            lastUpdated: threadMetadataView.last_updated,
          },
        }
      : {}),
  }

  return {
    streamId,
    filesystem,
    sqlite,
    parity,
    intentionalMismatches: [
      {
        entity: "threads",
        path: "threads.json compatibility envelope (version, last_updated)",
        reason:
          "Legacy compatibility wrapper metadata remains filesystem-only; sqlite parity projections compare canonical thread rows and session records instead.",
      },
    ],
    filesystemCompatibilityOnlyData,
  }
}

export const filesystemStructuredStorageAdapter = createFilesystemStructuredStorageAdapter()

export const filesystemAuthoritativeSqliteStructuredStorageAdapter =
  createFilesystemAuthoritativeSqliteStructuredStorageAdapter(filesystemStructuredStorageAdapter)

export function getStructuredStorageAdapter(): StructuredStorageStateAdapter {
  return filesystemAuthoritativeSqliteStructuredStorageAdapter
}
