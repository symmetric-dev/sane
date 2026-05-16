import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs"
import { join } from "path"
import { atomicWriteFile, getOrCreateIndex, modifyIndex, saveIndex } from "./index.ts"
export {
  createFilesystemAuthoritativeSqliteStructuredStorageAdapter,
  type FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions,
} from "./sqlite-storage-adapter.ts"
import { createFilesystemAuthoritativeSqliteStructuredStorageAdapter } from "./sqlite-storage-adapter.ts"
import {
  approvalMetadataToStructuredApprovalRecords,
  createEmptyStructuredStorageWorkstreamState,
  createStreamMetadataFromStructuredStorageRecord,
  createStructuredStorageWorkstreamRecord,
  replaceStructuredApprovals,
  structuredApprovalRecordsToApprovalMetadata,
  type StructuredStorageStateAdapter,
  type StructuredStorageWorkstreamRecord,
  type StructuredStorageWorkspaceState,
  type StructuredStorageWorkstreamState,
  type StructuredThreadRecord,
  type StructuredThreadRuntimeRecord,
  upsertStructuredBatchRun,
  upsertStructuredThreadRuntime,
} from "./structured-storage.ts"
import { VERSION as WORKSTREAMS_VERSION } from "../version.ts"
import {
  getSqliteStructuredStoragePath,
  modifySqliteStructuredStorageWorkstreamState,
  loadSqliteStructuredStorageWorkspaceState,
  loadSqliteStructuredStorageWorkstreamState,
  recordSqliteStructuredStorageMirrorState,
  syncStructuredStorageWorkspaceStateToSqlite,
  syncStructuredStorageWorkstreamStateToSqlite,
} from "./sqlite-storage.ts"
import {
  normalizeLoadedSupervisorState,
  normalizeSupervisorState,
} from "./runtime-state.ts"
import { getWorkDir } from "./repo.ts"
import type {
  ApprovalMetadata,
  ExecutionItem,
  PersistedBatchStatusFile,
  SupervisorStateFile,
  ThreadMetadata,
  ThreadsJson,
  WorkIndex,
} from "./types.ts"

const FILESYSTEM_WORKSTREAM_STATE_VERSION = "1.0.0"

export function getFilesystemWorkstreamStatePath(repoRoot: string, streamId: string): string {
  return join(getWorkDir(repoRoot), streamId, "workstream-state.json")
}

function loadFilesystemCanonicalWorkstreamStateSnapshot(
  repoRoot: string,
  streamId: string,
): StructuredStorageWorkstreamState | null {
  const filePath = getFilesystemWorkstreamStatePath(repoRoot, streamId)
  if (!existsSync(filePath)) {
    return null
  }

  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<
    StructuredStorageWorkstreamState & { version?: string }
  >
  const empty = createEmptyStructuredStorageWorkstreamState(streamId)

  return {
    streamId: parsed.streamId ?? streamId,
    hierarchy: {
      stages: parsed.hierarchy?.stages ?? empty.hierarchy.stages,
      batches: parsed.hierarchy?.batches ?? empty.hierarchy.batches,
      threads: parsed.hierarchy?.threads ?? empty.hierarchy.threads,
    },
    approvals: parsed.approvals ?? empty.approvals,
    threadRuntime: parsed.threadRuntime ?? empty.threadRuntime,
    batchRuns: parsed.batchRuns ?? empty.batchRuns,
    supervision: normalizeSupervisorState(streamId, parsed.supervision ?? empty.supervision),
  }
}

function saveFilesystemCanonicalWorkstreamStateSnapshot(
  repoRoot: string,
  workstreamState: StructuredStorageWorkstreamState,
): void {
  atomicWriteFile(
    getFilesystemWorkstreamStatePath(repoRoot, workstreamState.streamId),
    JSON.stringify(
      {
        version: FILESYSTEM_WORKSTREAM_STATE_VERSION,
        ...cloneWorkstreamState(workstreamState),
      },
      null,
      2,
    ),
  )
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

export interface FilesystemSqliteHydrationResult {
  workspaceState: StructuredStorageWorkspaceState
  workstreamStates: StructuredStorageWorkstreamState[]
  hydratedStreamIds: string[]
}

function cloneWorkstreamState(state: StructuredStorageWorkstreamState): StructuredStorageWorkstreamState {
  return {
    streamId: state.streamId,
    hierarchy: {
      stages: state.hierarchy.stages.map((stage) => ({ ...stage })),
      batches: state.hierarchy.batches.map((batch) => ({ ...batch })),
      threads: state.hierarchy.threads.map((thread) => ({ ...thread })),
    },
    approvals: state.approvals.map((approval) => ({ ...approval })),
    threadRuntime: state.threadRuntime.map((record) => ({
      threadId: record.threadId,
      sessions: record.sessions.map((session) => ({
        ...session,
        ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
      })),
      ...(record.status ? { status: record.status } : {}),
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
      ...(record.itemName ? { itemName: record.itemName } : {}),
      ...(record.breadcrumb ? { breadcrumb: record.breadcrumb } : {}),
      ...(record.report ? { report: record.report } : {}),
      ...(record.assignedAgent ? { assignedAgent: record.assignedAgent } : {}),
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

function parseLegacyWorkstreamOrder(streamId: string): number | null {
  const match = /^(\d+)/.exec(streamId)
  if (!match) {
    return null
  }

  const prefix = match[1]
  if (typeof prefix !== "string") {
    return null
  }

  const parsed = Number.parseInt(prefix, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function hasFilesystemWorkstreamMarkers(repoRoot: string, streamId: string): boolean {
  const streamDir = join(getWorkDir(repoRoot), streamId)

  return [
    "workstream-state.json",
    "README.md",
    "REPORT.md",
    "resources",
    "stages",
    "docs",
  ].some((entry) => existsSync(join(streamDir, entry)))
}

function createDiscoveredFilesystemWorkstreamRecord(args: {
  repoRoot: string
  streamId: string
  fallbackOrder: number
}): StructuredStorageWorkstreamRecord {
  const streamDir = join(getWorkDir(args.repoRoot), args.streamId)
  const stats = statSync(streamDir)
  const discoveredAt = stats.birthtime.toISOString()
  const updatedAt = stats.mtime.toISOString()

  return {
    id: args.streamId,
    name: args.streamId.replace(/^\d+-/, "") || args.streamId,
    order: parseLegacyWorkstreamOrder(args.streamId) ?? args.fallbackOrder,
    size: "medium",
    createdAt: discoveredAt,
    updatedAt,
    storageRoot: `work/${args.streamId}`,
    generatedBy: {
      workstreams: `${WORKSTREAMS_VERSION}-filesystem-import`,
    },
    sessionEstimated: {
      length: 4,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8],
    },
  }
}

function collectHydrationWorkspaceState(args: {
  repoRoot: string
  index: WorkIndex
}): StructuredStorageWorkspaceState {
  const workspaceState = workspaceStateFromIndex(args.index)
  const workDir = getWorkDir(args.repoRoot)
  if (!existsSync(workDir)) {
    return workspaceState
  }

  const discoveredStreamIds = new Set(workspaceState.workstreams.map((stream) => stream.id))
  let nextFallbackOrder = workspaceState.workstreams.reduce(
    (maxOrder, stream) => Math.max(maxOrder, stream.order),
    -1,
  ) + 1

  for (const entry of readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    const streamId = entry.name
    if (discoveredStreamIds.has(streamId) || !hasFilesystemWorkstreamMarkers(args.repoRoot, streamId)) {
      continue
    }

    workspaceState.workstreams.push(
      createDiscoveredFilesystemWorkstreamRecord({
        repoRoot: args.repoRoot,
        streamId,
        fallbackOrder: nextFallbackOrder++,
      }),
    )
    discoveredStreamIds.add(streamId)
  }

  workspaceState.workstreams.sort((left, right) => {
    const orderComparison = left.order - right.order
    if (orderComparison !== 0) {
      return orderComparison
    }

    return compareIds(left.id, right.id)
  })

  return workspaceState
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
      ...(threadRuntime.status ? { status: threadRuntime.status } : {}),
      ...(threadRuntime.createdAt ? { createdAt: threadRuntime.createdAt } : {}),
      ...(threadRuntime.updatedAt ? { updatedAt: threadRuntime.updatedAt } : {}),
      ...(threadRuntime.itemName ? { itemName: threadRuntime.itemName } : {}),
      ...(threadRuntime.breadcrumb ? { breadcrumb: threadRuntime.breadcrumb } : {}),
      ...(threadRuntime.report ? { report: threadRuntime.report } : {}),
      ...(threadRuntime.assignedAgent ? { assigned_agent: threadRuntime.assignedAgent } : {}),
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

function getLegacyThreadsFilePath(repoRoot: string, streamId: string): string {
  return join(getWorkDir(repoRoot), streamId, "threads.json")
}

export function hydrateFilesystemStateToSqliteSync(args: {
  repoRoot: string
  streamId?: string
}): FilesystemSqliteHydrationResult {
  const index = getOrCreateIndex(args.repoRoot)
  const workspaceState = collectHydrationWorkspaceState({
    repoRoot: args.repoRoot,
    index,
  })
  const hydrationIndex = indexFromWorkspaceState(workspaceState, index)

  syncStructuredStorageWorkspaceStateToSqlite(args.repoRoot, workspaceState)

  const requestedStreamIds = args.streamId
    ? [args.streamId]
    : workspaceState.workstreams.map((workstream) => workstream.id)
  const workstreamStates: StructuredStorageWorkstreamState[] = []
  const hydratedStreamIds: string[] = []

  for (const streamId of requestedStreamIds) {
    const filesystemState = workstreamStateFromFilesystem(hydrationIndex, args.repoRoot, streamId)

    if (!filesystemState) {
      continue
    }

    syncStructuredStorageWorkstreamStateToSqlite(args.repoRoot, cloneWorkstreamState(filesystemState))
    const hydratedState = loadSqliteStructuredStorageWorkstreamState(args.repoRoot, streamId) ?? filesystemState

    workstreamStates.push(hydratedState)
    hydratedStreamIds.push(streamId)
  }

  return {
    workspaceState,
    workstreamStates,
    hydratedStreamIds,
  }
}

function workstreamStateFromFilesystem(
  index: WorkIndex,
  repoRoot: string,
  streamId: string,
): StructuredStorageWorkstreamState | null {
  const stream = index.streams.find((entry) => entry.id === streamId)
  const canonicalState = loadFilesystemCanonicalWorkstreamStateSnapshot(repoRoot, streamId)

  if (!canonicalState && !stream) {
    return null
  }

  const state = canonicalState ?? createEmptyStructuredStorageWorkstreamState(streamId)
  if (!canonicalState) {
    state.approvals = approvalMetadataToStructuredApprovalRecords(streamId, stream?.approval)
  }
  return state
}

function loadFilesystemStructuredWorkstreamStateSync(
  repoRoot: string,
  streamId: string,
  options?: { normalizeIds?: boolean },
): StructuredStorageWorkstreamState | null {
  const canonicalState = loadFilesystemCanonicalWorkstreamStateSnapshot(repoRoot, streamId)
  if (canonicalState) {
    return canonicalState
  }

  void repoRoot
  void streamId
  void options
  return null
}

function loadRuntimeCanonicalMutationSeedSync(
  repoRoot: string,
  streamId: string,
): StructuredStorageWorkstreamState | null {
  let sqliteState: StructuredStorageWorkstreamState | null = null
  try {
    sqliteState = loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId, { normalizeIds: false })
  } catch {
    sqliteState = null
  }

  if (sqliteState) {
    return sqliteState
  }

  const canonicalFilesystemState = loadFilesystemCanonicalWorkstreamStateSnapshot(repoRoot, streamId)
  if (canonicalFilesystemState) {
    return canonicalFilesystemState
  }

  return loadFilesystemStructuredWorkstreamStateSync(repoRoot, streamId, {
    normalizeIds: false,
  })
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
      return loadFilesystemStructuredWorkstreamStateSync(repoRoot, streamId)
    },

    async replaceWorkstreamState(
      repoRoot: string,
      workstreamState: StructuredStorageWorkstreamState,
    ): Promise<void> {
      const nextState = cloneWorkstreamState(workstreamState)
      saveFilesystemCanonicalWorkstreamStateSnapshot(repoRoot, nextState)
      await persistWorkstreamApprovals(repoRoot, workstreamState.streamId, nextState)
    },

    async modifyWorkstreamState<T>(
      repoRoot: string,
      streamId: string,
      fn: (workstreamState: StructuredStorageWorkstreamState) => T | Promise<T>,
    ): Promise<T> {
      const mutableState = cloneWorkstreamState(
        loadFilesystemStructuredWorkstreamStateSync(repoRoot, streamId) ??
          createEmptyStructuredStorageWorkstreamState(streamId),
      )
      const result = await fn(mutableState)
      saveFilesystemCanonicalWorkstreamStateSnapshot(repoRoot, mutableState)
      await persistWorkstreamApprovals(repoRoot, streamId, mutableState)
      return result
    },
  }
}

export function modifyStructuredWorkstreamStateSync<T>(
  args: {
    repoRoot: string
    streamId: string
    touchStreamUpdatedAt?: boolean
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
  })

  return result
}

export function loadStructuredWorkstreamStateSync(
  repoRoot: string,
  streamId: string,
): StructuredStorageWorkstreamState | null {
  if (existsSync(getSqliteStructuredStoragePath(repoRoot))) {
    return loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId)
  }

  return loadFilesystemStructuredWorkstreamStateSync(repoRoot, streamId)
}

export function loadStructuredWorkspaceStateSync(
  repoRoot: string,
): StructuredStorageWorkspaceState {
  if (existsSync(getSqliteStructuredStoragePath(repoRoot))) {
    return loadSqliteStructuredStorageWorkspaceState(repoRoot) ?? workspaceStateFromIndex(getOrCreateIndex(repoRoot))
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
}): void {
  const existingIndex = getOrCreateIndex(args.repoRoot)
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

  saveFilesystemCanonicalWorkstreamStateSnapshot(args.repoRoot, nextState)

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

export function modifySqliteCanonicalRuntimeWorkstreamStateSync<T>(args: {
  repoRoot: string
  streamId: string
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

  saveFilesystemCanonicalWorkstreamStateSnapshot(args.repoRoot, workstreamState)

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
      ...(thread.status ? { status: thread.status } : {}),
      ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
      ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
      ...(thread.itemName ? { itemName: thread.itemName } : {}),
      ...(thread.breadcrumb ? { breadcrumb: thread.breadcrumb } : {}),
      ...(thread.report ? { report: thread.report } : {}),
      ...(thread.assigned_agent ? { assignedAgent: thread.assigned_agent } : {}),
      ...(thread.currentSessionId ? { currentSessionId: thread.currentSessionId } : {}),
      ...(thread.opencodeSessionId ? { opencodeSessionId: thread.opencodeSessionId } : {}),
      ...(thread.workingAgentSessionId ? { workingAgentSessionId: thread.workingAgentSessionId } : {}),
      ...(thread.synthesisOutput ? { synthesisOutput: thread.synthesisOutput } : {}),
      ...(thread.synthesis ? { synthesis: thread.synthesis } : {}),
    })
  }

  const referencedThreadIds = new Set<string>([
    ...workstreamState.hierarchy.threads.map((thread) => thread.id),
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
  return workstreamState ? normalizeLoadedSupervisorState(streamId, workstreamState.supervision) : null
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
  })
  return nextApproval
}

export const filesystemStructuredStorageAdapter = createFilesystemStructuredStorageAdapter()

export const filesystemAuthoritativeSqliteStructuredStorageAdapter =
  createFilesystemAuthoritativeSqliteStructuredStorageAdapter(filesystemStructuredStorageAdapter)

export function getStructuredStorageAdapter(): StructuredStorageStateAdapter {
  return filesystemAuthoritativeSqliteStructuredStorageAdapter
}
