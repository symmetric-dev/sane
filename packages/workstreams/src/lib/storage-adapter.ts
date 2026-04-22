import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs"
import { join } from "path"
import { atomicWriteFile, getOrCreateIndex, modifyIndex, saveIndex } from "./index.ts"
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
  type StructuredStorageWorkstreamRecord,
  type StructuredStorageWorkspaceState,
  type StructuredStorageWorkstreamState,
  updateStructuredTask,
  type StructuredTaskRecord,
  type StructuredThreadRecord,
  type StructuredThreadRuntimeRecord,
  upsertStructuredBatchRun,
  upsertStructuredThreadRuntime,
} from "./structured-storage.ts"
import { VERSION as WORKSTREAMS_VERSION } from "../version.ts"
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
  importLegacyRuntimeState,
  modifyTasksFile,
  normalizeLoadedRuntimeState,
  normalizeLoadedSupervisorState,
  normalizeRuntimeState,
  normalizeSupervisorState,
  readTasksFile,
  writeTasksFile,
} from "./tasks.ts"
import { getWorkDir } from "./repo.ts"
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
  divergences: CriticalWorkflowParityDivergenceReport
}

export type CriticalWorkflowParityEntity =
  | "tasks"
  | "threads"
  | "approvals"
  | "batchRuns"
  | "supervisionRuns"

export type CriticalWorkflowParityDivergenceKind =
  | "missing-from-compatibility"
  | "missing-from-sqlite"
  | "stale-compatibility"
  | "runtime-divergence"

export interface CriticalWorkflowParityDivergence {
  entity: CriticalWorkflowParityEntity
  key: string
  kind: CriticalWorkflowParityDivergenceKind
  message: string
  compatibilityValue?: unknown
  sqliteValue?: unknown
}

export interface CriticalWorkflowParityDivergenceSummary {
  total: number
  missingFromCompatibility: number
  missingFromSqlite: number
  staleCompatibility: number
  runtimeDivergence: number
}

export interface CriticalWorkflowParityDivergenceReport {
  tasks: CriticalWorkflowParityDivergence[]
  threads: CriticalWorkflowParityDivergence[]
  approvals: CriticalWorkflowParityDivergence[]
  batchRuns: CriticalWorkflowParityDivergence[]
  supervisionRuns: CriticalWorkflowParityDivergence[]
  all: CriticalWorkflowParityDivergence[]
  summary: CriticalWorkflowParityDivergenceSummary
}

export interface LegacyFilesystemSqliteHydrationDiagnostic {
  severity: "warning" | "error"
  code: string
  streamId?: string
  message: string
}

export interface LegacyFilesystemSqliteHydrationResult {
  workspaceState: StructuredStorageWorkspaceState
  workstreamStates: StructuredStorageWorkstreamState[]
  hydratedStreamIds: string[]
  projectedStreamIds: string[]
  diagnostics: LegacyFilesystemSqliteHydrationDiagnostic[]
}

interface FilesystemHydrationTasksSnapshot {
  tasksFile: TasksFile | null
  hadTasksFile: boolean
  hadLegacyRuntimeArtifacts: boolean
  createdTasksFile: boolean
  migratedLegacyRuntime: boolean
}

function formatDiagnosticIdList(ids: string[]): string {
  if (ids.length <= 4) {
    return ids.join(", ")
  }

  return `${ids.slice(0, 4).join(", ")}, +${ids.length - 4} more`
}

function uniqueSortedIds(ids: Iterable<string>): string[] {
  return [...new Set([...ids].filter((id) => id.length > 0))].sort(compareIds)
}

function collectWorkspaceHydrationDiagnostics(
  workspaceState: StructuredStorageWorkspaceState,
): LegacyFilesystemSqliteHydrationDiagnostic[] {
  if (!workspaceState.currentStreamId) {
    return []
  }

  if (workspaceState.workstreams.some((stream) => stream.id === workspaceState.currentStreamId)) {
    return []
  }

  return [
    {
      severity: "warning",
      code: "workspace-current-stream-missing",
      message:
        `Legacy workspace current_stream ${workspaceState.currentStreamId} is not present in index.json streams; sqlite hydration kept the selection, but follow-up cleanup is recommended.`,
    },
  ]
}

function collectWorkstreamHydrationDiagnostics(args: {
  streamId: string
  indexedStreamIds: Set<string>
  workspaceState: StructuredStorageWorkspaceState
  workstreamState: StructuredStorageWorkstreamState
  tasksSnapshot: FilesystemHydrationTasksSnapshot
}): LegacyFilesystemSqliteHydrationDiagnostic[] {
  const diagnostics: LegacyFilesystemSqliteHydrationDiagnostic[] = []

  if (!args.indexedStreamIds.has(args.streamId)) {
    diagnostics.push({
      severity: "warning",
      code: "workstream-missing-from-index",
      streamId: args.streamId,
      message:
        `Legacy workstream ${args.streamId} is not registered in index.json; sqlite hydration inferred a catalog row from filesystem state.`,
    })
  }

  if (!args.tasksSnapshot.hadTasksFile && !args.tasksSnapshot.hadLegacyRuntimeArtifacts) {
    diagnostics.push({
      severity: "warning",
      code: "workstream-missing-tasks-file",
      streamId: args.streamId,
      message:
        `Legacy workstream ${args.streamId} has no tasks.json or runtime compatibility artifacts; sqlite hydration imported workspace metadata and approvals only.`,
    })
  }

  if (!args.tasksSnapshot.hadTasksFile && args.tasksSnapshot.createdTasksFile) {
    diagnostics.push({
      severity: "warning",
      code: "runtime-artifacts-without-tasks-file",
      streamId: args.streamId,
      message:
        `Legacy workstream ${args.streamId} had runtime compatibility artifacts without tasks.json; hydration created tasks.json first so runtime history could be imported into sqlite canonically.`,
    })
  }

  if (args.tasksSnapshot.migratedLegacyRuntime) {
    diagnostics.push({
      severity: "warning",
      code: "legacy-runtime-merged",
      streamId: args.streamId,
      message:
        `Legacy runtime compatibility files for ${args.streamId} were merged into canonical runtime state during sqlite hydration.`,
    })
  }

  const stageIds = new Set(args.workstreamState.hierarchy.stages.map((stage) => stage.id))
  const batchIds = new Set(args.workstreamState.hierarchy.batches.map((batch) => batch.id))
  const threadIds = new Set(args.workstreamState.hierarchy.threads.map((thread) => thread.id))
  const taskIds = new Set(args.workstreamState.hierarchy.tasks.map((task) => task.id))

  const missingStageIds = uniqueSortedIds([
    ...args.workstreamState.approvals
      .map((approval) => approval.stageId)
      .filter((stageId): stageId is string => typeof stageId === "string" && !stageIds.has(stageId)),
    ...args.workstreamState.supervision.runs
      .map((run) => run.stageId)
      .filter((stageId) => !stageIds.has(stageId)),
    ...args.workstreamState.supervision.branch_sessions
      .map((session) => session.scope?.stageId)
      .filter((stageId): stageId is string => typeof stageId === "string" && !stageIds.has(stageId)),
  ])

  if (missingStageIds.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-stage-hierarchy",
      streamId: args.streamId,
      message:
        `Legacy workstream ${args.streamId} references stages outside the declared task hierarchy (${formatDiagnosticIdList(missingStageIds)}); sqlite hydration inferred placeholder stage rows to preserve runtime history.`,
    })
  }

  const missingBatchIds = uniqueSortedIds([
    ...args.workstreamState.batchRuns
      .map((batchRun) => batchRun.batchId)
      .filter((batchId) => !batchIds.has(batchId)),
    ...args.workstreamState.supervision.runs
      .flatMap((run) => [run.currentBatchId, run.lastReviewedBatchId])
      .filter((batchId): batchId is string => typeof batchId === "string" && !batchIds.has(batchId)),
    ...args.workstreamState.supervision.branch_sessions
      .flatMap((session) => [session.batchId, session.scope?.level === "batch" ? session.scope.batchId : undefined])
      .filter((batchId): batchId is string => typeof batchId === "string" && !batchIds.has(batchId)),
  ])

  if (missingBatchIds.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-batch-hierarchy",
      streamId: args.streamId,
      message:
        `Legacy workstream ${args.streamId} references batches outside the declared task hierarchy (${formatDiagnosticIdList(missingBatchIds)}); sqlite hydration inferred placeholder batch rows to preserve runtime history.`,
    })
  }

  const missingThreadIds = uniqueSortedIds([
    ...args.workstreamState.threadRuntime
      .map((runtime) => runtime.threadId)
      .filter((threadId) => !threadIds.has(threadId)),
    ...args.workstreamState.batchRuns
      .flatMap((batchRun) => batchRun.threads.map((thread) => thread.threadId))
      .filter((threadId) => !threadIds.has(threadId)),
    ...args.workstreamState.supervision.branch_sessions
      .map((session) => session.threadId)
      .filter((threadId): threadId is string => typeof threadId === "string" && !threadIds.has(threadId)),
  ])

  if (missingThreadIds.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-thread-hierarchy",
      streamId: args.streamId,
      message:
        `Legacy workstream ${args.streamId} references threads outside the declared task hierarchy (${formatDiagnosticIdList(missingThreadIds)}); sqlite hydration inferred placeholder thread rows to preserve runtime history.`,
    })
  }

  const missingTaskIds = uniqueSortedIds(
    args.workstreamState.batchRuns
      .flatMap((batchRun) => batchRun.threads.map((thread) => thread.firstTaskId))
      .filter((taskId) => !taskIds.has(taskId)),
  )

  if (missingTaskIds.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "missing-task-hierarchy",
      streamId: args.streamId,
      message:
        `Legacy workstream ${args.streamId} references batch entry tasks outside tasks.json (${formatDiagnosticIdList(missingTaskIds)}); sqlite hydration inferred placeholder task rows to preserve batch runtime continuity.`,
    })
  }

  return diagnostics
}

export function emitLegacyFilesystemSqliteHydrationDiagnostics(
  diagnostics: LegacyFilesystemSqliteHydrationDiagnostic[],
): void {
  for (const diagnostic of diagnostics) {
    const prefix = diagnostic.streamId
      ? `[sqlite-hydration:${diagnostic.streamId}]`
      : "[sqlite-hydration]"
    const writer = diagnostic.severity === "error" ? console.error : console.warn
    writer(`${prefix} ${diagnostic.message}`)
  }
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

function collectEntityParityDivergences<T>(args: {
  entity: CriticalWorkflowParityEntity
  compatibilityRows: T[]
  sqliteRows: T[]
  keyOf: (row: T) => string
  runtimeEntity: boolean
}): CriticalWorkflowParityDivergence[] {
  const compatibilityByKey = new Map<string, T>()
  for (const row of args.compatibilityRows) {
    compatibilityByKey.set(args.keyOf(row), row)
  }

  const sqliteByKey = new Map<string, T>()
  for (const row of args.sqliteRows) {
    sqliteByKey.set(args.keyOf(row), row)
  }

  const divergences: CriticalWorkflowParityDivergence[] = []

  for (const key of [...sqliteByKey.keys()].sort(compareIds)) {
    if (!compatibilityByKey.has(key)) {
      divergences.push({
        entity: args.entity,
        key,
        kind: "missing-from-compatibility",
        message: `Compatibility projection is missing ${args.entity} row ${key} that exists in sqlite canonical state.`,
        sqliteValue: sqliteByKey.get(key),
      })
    }
  }

  for (const key of [...compatibilityByKey.keys()].sort(compareIds)) {
    if (!sqliteByKey.has(key)) {
      divergences.push({
        entity: args.entity,
        key,
        kind: "missing-from-sqlite",
        message: `Compatibility projection includes ${args.entity} row ${key} that is missing from sqlite canonical state.`,
        compatibilityValue: compatibilityByKey.get(key),
      })
    }
  }

  for (const key of [...sqliteByKey.keys()].sort(compareIds)) {
    const sqliteRow = sqliteByKey.get(key)
    const compatibilityRow = compatibilityByKey.get(key)
    if (!sqliteRow || !compatibilityRow) {
      continue
    }

    if (parityEqual(compatibilityRow, sqliteRow)) {
      continue
    }

    divergences.push({
      entity: args.entity,
      key,
      kind: args.runtimeEntity ? "runtime-divergence" : "stale-compatibility",
      message: args.runtimeEntity
        ? `Compatibility runtime state for ${args.entity} row ${key} diverges from sqlite canonical state.`
        : `Compatibility projection for ${args.entity} row ${key} is stale relative to sqlite canonical state.`,
      compatibilityValue: compatibilityRow,
      sqliteValue: sqliteRow,
    })
  }

  return divergences
}

function summarizeParityDivergences(
  divergences: CriticalWorkflowParityDivergence[],
): CriticalWorkflowParityDivergenceSummary {
  const summary: CriticalWorkflowParityDivergenceSummary = {
    total: divergences.length,
    missingFromCompatibility: 0,
    missingFromSqlite: 0,
    staleCompatibility: 0,
    runtimeDivergence: 0,
  }

  for (const divergence of divergences) {
    if (divergence.kind === "missing-from-compatibility") {
      summary.missingFromCompatibility += 1
      continue
    }
    if (divergence.kind === "missing-from-sqlite") {
      summary.missingFromSqlite += 1
      continue
    }
    if (divergence.kind === "stale-compatibility") {
      summary.staleCompatibility += 1
      continue
    }
    summary.runtimeDivergence += 1
  }

  return summary
}

function parityProjectionHasRows(projection: CriticalWorkflowParityProjection): boolean {
  return (
    projection.tasks.length > 0 ||
    projection.threads.length > 0 ||
    projection.approvals.length > 0 ||
    projection.batchRuns.length > 0 ||
    projection.supervisionRuns.length > 0
  )
}

function collectCriticalWorkflowParityDivergenceReport(args: {
  compatibility: CriticalWorkflowParityProjection
  sqlite: CriticalWorkflowParityProjection
}): CriticalWorkflowParityDivergenceReport {
  const tasks = collectEntityParityDivergences({
    entity: "tasks",
    compatibilityRows: args.compatibility.tasks,
    sqliteRows: args.sqlite.tasks,
    keyOf: (task) => task.id,
    runtimeEntity: false,
  })
  const threads = collectEntityParityDivergences({
    entity: "threads",
    compatibilityRows: args.compatibility.threads,
    sqliteRows: args.sqlite.threads,
    keyOf: (thread) => thread.threadId,
    runtimeEntity: true,
  })
  const approvals = collectEntityParityDivergences({
    entity: "approvals",
    compatibilityRows: args.compatibility.approvals,
    sqliteRows: args.sqlite.approvals,
    keyOf: (approval) => `${approval.scope}:${approval.stageId ?? ""}`,
    runtimeEntity: false,
  })
  const batchRuns = collectEntityParityDivergences({
    entity: "batchRuns",
    compatibilityRows: args.compatibility.batchRuns,
    sqliteRows: args.sqlite.batchRuns,
    keyOf: (batchRun) => `${batchRun.batchId}:${batchRun.runId}`,
    runtimeEntity: true,
  })
  const supervisionRuns = collectEntityParityDivergences({
    entity: "supervisionRuns",
    compatibilityRows: args.compatibility.supervisionRuns,
    sqliteRows: args.sqlite.supervisionRuns,
    keyOf: (run) => run.runId,
    runtimeEntity: true,
  })

  const all = [...tasks, ...threads, ...approvals, ...batchRuns, ...supervisionRuns]

  return {
    tasks,
    threads,
    approvals,
    batchRuns,
    supervisionRuns,
    all,
    summary: summarizeParityDivergences(all),
  }
}

function parityDivergencesToHydrationDiagnostics(args: {
  streamId: string
  phase: "pre-hydration" | "post-hydration"
  report: CriticalWorkflowParityDivergenceReport
}): LegacyFilesystemSqliteHydrationDiagnostic[] {
  if (args.report.all.length === 0) {
    return []
  }

  const diagnostics = args.report.all.map((divergence) => {
    const code =
      divergence.kind === "missing-from-compatibility"
        ? "parity-missing-compatibility-row"
        : divergence.kind === "missing-from-sqlite"
          ? "parity-missing-sqlite-row"
          : divergence.kind === "stale-compatibility"
            ? "parity-stale-compatibility"
            : "parity-runtime-divergence"

    return {
      severity: "warning" as const,
      code,
      streamId: args.streamId,
      message:
        args.phase === "pre-hydration"
          ? `[pre-hydration] ${divergence.message}`
          : `[post-hydration] ${divergence.message}`,
    }
  })

  diagnostics.push({
    severity: "warning",
    code: "parity-divergence-summary",
    streamId: args.streamId,
    message:
      `${args.phase === "pre-hydration" ? "Pre-hydration" : "Post-hydration"} parity divergence summary for ${args.streamId}: ` +
      `${args.report.summary.total} total (${args.report.summary.missingFromCompatibility} missing-from-compatibility, ` +
      `${args.report.summary.missingFromSqlite} missing-from-sqlite, ${args.report.summary.staleCompatibility} stale-compatibility, ` +
      `${args.report.summary.runtimeDivergence} runtime-divergence).`,
  })

  return diagnostics
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

function hasLegacyFilesystemWorkstreamMarkers(repoRoot: string, streamId: string): boolean {
  const streamDir = join(getWorkDir(repoRoot), streamId)

  return [
    "PLAN.md",
    "REQUIREMENTS.md",
    "REPORT.md",
    "tasks.json",
    "threads.json",
    "supervisor-state.json",
    "batch-status",
    "docs",
    "files",
  ].some((entry) => existsSync(join(streamDir, entry)))
}

function createDiscoveredLegacyFilesystemWorkstreamRecord(args: {
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
      workstreams: `${WORKSTREAMS_VERSION}-legacy-filesystem-import`,
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
    if (discoveredStreamIds.has(streamId) || !hasLegacyFilesystemWorkstreamMarkers(args.repoRoot, streamId)) {
      continue
    }

    workspaceState.workstreams.push(
      createDiscoveredLegacyFilesystemWorkstreamRecord({
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

function getLegacyThreadsFilePath(repoRoot: string, streamId: string): string {
  return join(getWorkDir(repoRoot), streamId, "threads.json")
}

function getLegacySupervisorStateFilePath(repoRoot: string, streamId: string): string {
  return join(getWorkDir(repoRoot), streamId, "supervisor-state.json")
}

function getLegacyBatchStatusDirPath(repoRoot: string, streamId: string): string {
  return join(getWorkDir(repoRoot), streamId, "batch-status")
}

function hasLegacyBatchStatusFiles(repoRoot: string, streamId: string): boolean {
  const batchStatusDir = getLegacyBatchStatusDirPath(repoRoot, streamId)
  if (!existsSync(batchStatusDir)) {
    return false
  }

  return readdirSync(batchStatusDir).some((entry) => entry.endsWith(".json"))
}

function loadFilesystemHydrationTasksSnapshotSync(
  repoRoot: string,
  streamId: string,
): FilesystemHydrationTasksSnapshot {
  const tasksFilePath = getTasksFilePath(repoRoot, streamId)
  const hadTasksFile = existsSync(tasksFilePath)
  const hadLegacyRuntimeArtifacts =
    existsSync(getLegacyThreadsFilePath(repoRoot, streamId)) ||
    existsSync(getLegacySupervisorStateFilePath(repoRoot, streamId)) ||
    hasLegacyBatchStatusFiles(repoRoot, streamId)

  if (!hadTasksFile && !hadLegacyRuntimeArtifacts) {
    return {
      tasksFile: null,
      hadTasksFile,
      hadLegacyRuntimeArtifacts,
      createdTasksFile: false,
      migratedLegacyRuntime: false,
    }
  }

  const { migrated, tasksFile } = importLegacyRuntimeState(repoRoot, streamId)

  return {
    tasksFile,
    hadTasksFile,
    hadLegacyRuntimeArtifacts,
    createdTasksFile: !hadTasksFile && existsSync(tasksFilePath),
    migratedLegacyRuntime: migrated,
  }
}

function writeCompatibilityJsonFile(filePath: string, value: unknown): void {
  atomicWriteFile(filePath, JSON.stringify(value, null, 2))
}

export function projectLegacyRuntimeCompatibilityArtifactsSync(args: {
  repoRoot: string
  streamId: string
  workstreamState?: StructuredStorageWorkstreamState | null
}): void {
  const workstreamState =
    args.workstreamState ??
    loadSqliteStructuredStorageWorkstreamState(args.repoRoot, args.streamId, { normalizeIds: false })
  if (!workstreamState) {
    return
  }

  writeCompatibilityJsonFile(
    getLegacyThreadsFilePath(args.repoRoot, args.streamId),
    threadsFileFromWorkstreamState(workstreamState),
  )
  writeCompatibilityJsonFile(
    getLegacySupervisorStateFilePath(args.repoRoot, args.streamId),
    normalizeSupervisorState(args.streamId, workstreamState.supervision),
  )

  const batchStatusDir = getLegacyBatchStatusDirPath(args.repoRoot, args.streamId)
  mkdirSync(batchStatusDir, { recursive: true })

  const expectedBatchFiles = new Set<string>()
  for (const batchRun of workstreamState.batchRuns) {
    const fileName = `${batchRun.batchId}.json`
    expectedBatchFiles.add(fileName)
    writeCompatibilityJsonFile(join(batchStatusDir, fileName), batchRun)
  }

  for (const entry of readdirSync(batchStatusDir)) {
    if (!entry.endsWith(".json") || expectedBatchFiles.has(entry)) {
      continue
    }

    rmSync(join(batchStatusDir, entry), { force: true })
  }
}

export function hydrateLegacyFilesystemStateToSqliteSync(args: {
  repoRoot: string
  streamId?: string
  projectLegacyRuntimeCompatibilityArtifacts?: boolean
}): LegacyFilesystemSqliteHydrationResult {
  const index = getOrCreateIndex(args.repoRoot)
  const workspaceState = collectHydrationWorkspaceState({
    repoRoot: args.repoRoot,
    index,
  })
  const hydrationIndex = indexFromWorkspaceState(workspaceState, index)
  const indexedStreamIds = new Set(index.streams.map((stream) => stream.id))
  const diagnostics = collectWorkspaceHydrationDiagnostics(workspaceState)

  syncStructuredStorageWorkspaceStateToSqlite(args.repoRoot, workspaceState)

  const requestedStreamIds = args.streamId
    ? [args.streamId]
    : workspaceState.workstreams.map((workstream) => workstream.id)
  const workstreamStates: StructuredStorageWorkstreamState[] = []
  const hydratedStreamIds: string[] = []
  const projectedStreamIds: string[] = []
  const shouldProjectLegacyRuntimeCompatibilityArtifacts =
    args.projectLegacyRuntimeCompatibilityArtifacts ?? true

  for (const streamId of requestedStreamIds) {
    const tasksSnapshot = loadFilesystemHydrationTasksSnapshotSync(args.repoRoot, streamId)
    const filesystemState = workstreamStateFromSnapshot(hydrationIndex, streamId, tasksSnapshot.tasksFile)

    if (!filesystemState) {
      diagnostics.push({
        severity: "warning",
        code: "workstream-missing-filesystem-state",
        streamId,
        message:
          `No legacy filesystem state was found for workstream ${streamId}; sqlite hydration skipped this stream.`,
      })
      continue
    }

    const existingSqliteParity = loadSqliteCriticalWorkflowParityProjection(args.repoRoot, streamId)
    if (existingSqliteParity && parityProjectionHasRows(existingSqliteParity)) {
      diagnostics.push(
        ...parityDivergencesToHydrationDiagnostics({
          streamId,
          phase: "pre-hydration",
          report: collectCriticalWorkflowParityDivergenceReport({
            compatibility: buildCriticalWorkflowParityProjection(filesystemState),
            sqlite: existingSqliteParity,
          }),
        }),
      )
    }

    diagnostics.push(
        ...collectWorkstreamHydrationDiagnostics({
          streamId,
          indexedStreamIds,
          workspaceState,
          workstreamState: filesystemState,
          tasksSnapshot,
      }),
    )

    syncStructuredStorageWorkstreamStateToSqlite(args.repoRoot, cloneWorkstreamState(filesystemState))
    const hydratedState = loadSqliteStructuredStorageWorkstreamState(args.repoRoot, streamId) ?? filesystemState
    if (shouldProjectLegacyRuntimeCompatibilityArtifacts) {
      projectLegacyRuntimeCompatibilityArtifactsSync({
        repoRoot: args.repoRoot,
        streamId,
        workstreamState: hydratedState,
      })
    }

    const projectedParity = inspectCriticalWorkflowDualWriteParitySync(args.repoRoot, streamId)
    if (projectedParity?.sqlite) {
      diagnostics.push(
        ...parityDivergencesToHydrationDiagnostics({
          streamId,
          phase: "post-hydration",
          report: projectedParity.divergences,
        }),
      )
    }

    workstreamStates.push(hydratedState)
    hydratedStreamIds.push(streamId)
    if (shouldProjectLegacyRuntimeCompatibilityArtifacts) {
      projectedStreamIds.push(streamId)
    }
  }

  return {
    workspaceState,
    workstreamStates,
    hydratedStreamIds,
    projectedStreamIds,
    diagnostics,
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
  const runtimeState = normalizeLoadedRuntimeState(streamId, tasksFile?.runtime_state)
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
  options?: { normalizeIds?: boolean },
): StructuredStorageWorkstreamState | null {
  return workstreamStateFromSnapshot(
    getOrCreateIndex(repoRoot),
    streamId,
    readTasksFile(repoRoot, streamId, options),
  )
}

function loadRuntimeCanonicalMutationSeedSync(
  repoRoot: string,
  streamId: string,
): StructuredStorageWorkstreamState | null {
  const filesystemState = loadFilesystemStructuredWorkstreamStateSync(repoRoot, streamId, {
    normalizeIds: false,
  })
  let sqliteState: StructuredStorageWorkstreamState | null = null
  try {
    sqliteState = loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId, { normalizeIds: false })
  } catch {
    sqliteState = null
  }

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
  const existingTasksFile = readTasksFile(args.repoRoot, args.workstreamState.streamId, {
    normalizeIds: false,
  })
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
  const filesystemState = loadFilesystemStructuredWorkstreamStateSync(repoRoot, streamId)
  if (!filesystemState) {
    return null
  }

  const filesystem = buildCriticalWorkflowParityProjection(filesystemState)
  const sqlite = loadSqliteCriticalWorkflowParityProjection(repoRoot, streamId)
  const divergences = sqlite
    ? collectCriticalWorkflowParityDivergenceReport({ compatibility: filesystem, sqlite })
    : {
        tasks: [],
        threads: [],
        approvals: [],
        batchRuns: [],
        supervisionRuns: [],
        all: [],
        summary: {
          total: 0,
          missingFromCompatibility: 0,
          missingFromSqlite: 0,
          staleCompatibility: 0,
          runtimeDivergence: 0,
        },
      }
  const parity = {
    tasks: sqlite ? divergences.tasks.length === 0 : false,
    threads: sqlite ? divergences.threads.length === 0 : false,
    approvals: sqlite ? divergences.approvals.length === 0 : false,
    batchRuns: sqlite ? divergences.batchRuns.length === 0 : false,
    supervisionRuns: sqlite ? divergences.supervisionRuns.length === 0 : false,
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
    divergences,
  }
}

export const filesystemStructuredStorageAdapter = createFilesystemStructuredStorageAdapter()

export const filesystemAuthoritativeSqliteStructuredStorageAdapter =
  createFilesystemAuthoritativeSqliteStructuredStorageAdapter(filesystemStructuredStorageAdapter)

export function getStructuredStorageAdapter(): StructuredStorageStateAdapter {
  return filesystemAuthoritativeSqliteStructuredStorageAdapter
}
