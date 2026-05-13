/**
 * tasks.json read/write operations
 *
 * This module handles all operations on the tasks.json file which stores
 * task tracking information in JSON format.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import * as lockfile from "proper-lockfile"
import { loadSqliteStructuredStorageWorkstreamState } from "./sqlite-storage.ts"
import type {
  RootAgentLineage,
  Task,
  TasksFile,
  TaskStatus,
  SessionRecord,
  SessionStatus,
  WorkstreamRuntimeSummary,
  WorkstreamRuntimeBatchSummary,
  WorkstreamRuntimeSupervisorRunSummary,
  WorkstreamRuntimeSupervisionSummary,
  WorkstreamRuntimeBranchSupervisionSummary,
  WorkstreamUnifiedRuntimeState,
  SupervisorStateFile,
  ThreadsJson,
  ThreadMetadata,
  PersistedBatchStatusFile,
} from "./types.ts"
import { atomicWriteFile } from "./index.ts"
import { getWorkDir } from "./repo.ts"
import {
  startThreadSession,
  completeThreadSession,
  startThreadSessionLocked,
  completeThreadSessionLocked,
  startMultipleThreadSessionsLocked,
  completeMultipleThreadSessionsLocked,
  getThreadMetadata,
} from "./threads.ts"
import {
  normalizePersistedBatchStatus,
  normalizePersistedBranchSession,
  normalizePersistedCurrentBranchSupervisionContext,
  normalizePersistedSupervisorEscalation,
  normalizePersistedSupervisorFixCycle,
  normalizePersistedSupervisorIssueSummary,
  normalizePersistedSupervisorReviewedBatch,
  normalizePersistedSupervisorRunState,
  normalizePersistedSupervisorStageStop,
  normalizePersistedThreadMetadata,
} from "./stage-id.ts"

const TASKS_FILE_VERSION = "2.0.0"
const RUNTIME_STATE_VERSION = "1.0.0"

/**
 * Get the path to tasks.json for a workstream
 */
export function getTasksFilePath(repoRoot: string, streamId: string): string {
  const workDir = getWorkDir(repoRoot)
  return join(workDir, streamId, "tasks.json")
}

/**
 * Create an empty tasks.json structure
 */
export function createEmptyTasksFile(streamId: string): TasksFile {
  return {
    version: TASKS_FILE_VERSION,
    stream_id: streamId,
    last_updated: new Date().toISOString(),
    runtime_state: createEmptyRuntimeState(streamId),
    tasks: [],
  }
}

export function createEmptyRuntimeState(streamId: string): WorkstreamUnifiedRuntimeState {
  return {
    version: RUNTIME_STATE_VERSION,
    last_updated: new Date().toISOString(),
    threads: [],
    batches: {},
    supervision: {
      version: "1.0.0",
      stream_id: streamId,
      last_updated: new Date().toISOString(),
      runs: [],
      checkpoint_pointers: [],
      branch_sessions: [],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    },
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

function readJsonFileIfExists<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null
  }

  return JSON.parse(readFileSync(filePath, "utf-8")) as T
}

function mergeThreadMetadata(
  canonical: ThreadMetadata | undefined,
  legacy: ThreadMetadata,
): ThreadMetadata {
  const canonicalSessionIds = new Set(canonical?.sessions.map((session) => session.sessionId) ?? [])
  const mergedSessions = [...(canonical?.sessions ?? [])]

  for (const session of legacy.sessions ?? []) {
    if (!canonicalSessionIds.has(session.sessionId)) {
      mergedSessions.push(session)
      canonicalSessionIds.add(session.sessionId)
    }
  }

  return {
    ...legacy,
    ...canonical,
    threadId: canonical?.threadId ?? legacy.threadId,
    sessions: mergedSessions,
    ...(canonical?.currentSessionId ?? legacy.currentSessionId
      ? { currentSessionId: canonical?.currentSessionId ?? legacy.currentSessionId }
      : {}),
    ...(canonical?.promptPath ?? legacy.promptPath
      ? { promptPath: canonical?.promptPath ?? legacy.promptPath }
      : {}),
    ...(canonical?.opencodeSessionId ?? legacy.opencodeSessionId
      ? { opencodeSessionId: canonical?.opencodeSessionId ?? legacy.opencodeSessionId }
      : {}),
    ...(canonical?.synthesis ?? legacy.synthesis
      ? { synthesis: canonical?.synthesis ?? legacy.synthesis }
      : {}),
  }
}

function mergeRuntimeThreads(
  streamId: string,
  runtimeState: WorkstreamUnifiedRuntimeState,
  legacyThreads?: ThreadsJson | null,
): boolean {
  if (!legacyThreads?.threads?.length) {
    return false
  }

  const threadMap = new Map<string, ThreadMetadata>()
  for (const thread of runtimeState.threads) {
    threadMap.set(thread.threadId, {
      ...thread,
      sessions: [...thread.sessions],
    })
  }

  let changed = false
  for (const legacyThread of legacyThreads.threads) {
    const merged = mergeThreadMetadata(threadMap.get(legacyThread.threadId), legacyThread)
    const previous = threadMap.get(legacyThread.threadId)
    if (JSON.stringify(previous) !== JSON.stringify(merged)) {
      changed = true
    }
    threadMap.set(legacyThread.threadId, merged)
  }

  if (!changed) {
    return false
  }

  runtimeState.threads = Array.from(threadMap.values()).sort((a, b) =>
    a.threadId.localeCompare(b.threadId, undefined, { numeric: true }),
  )
  runtimeState.last_updated = new Date().toISOString()
  return true
}

function upsertByKey<T>(items: T[], incoming: T, getKey: (value: T) => string): boolean {
  const key = getKey(incoming)
  const index = items.findIndex((value) => getKey(value) === key)
  if (index !== -1) {
    return false
  }

  items.push(incoming)
  return true
}

function mergeSupervisorStateFromLegacy(
  streamId: string,
  runtimeState: WorkstreamUnifiedRuntimeState,
  legacySupervisorState?: Partial<SupervisorStateFile> | null,
): boolean {
  if (!legacySupervisorState) {
    return false
  }

  const canonical = normalizeSupervisorState(streamId, runtimeState.supervision)
  const legacy = normalizeLoadedSupervisorState(streamId, legacySupervisorState)
  let changed = false

  if (!canonical.active_run_id && legacy.active_run_id) {
    canonical.active_run_id = legacy.active_run_id
    changed = true
  }

  if (!canonical.current_branch_supervision && legacy.current_branch_supervision) {
    canonical.current_branch_supervision = legacy.current_branch_supervision
    changed = true
  }

  for (const run of legacy.runs) {
    changed = upsertByKey(canonical.runs, run, (value) => value.runId) || changed
  }
  for (const pointer of legacy.checkpoint_pointers) {
    changed =
      upsertByKey(
        canonical.checkpoint_pointers,
        pointer,
        (value) => `${value.rootSessionId}:${value.checkpointMessageIndex}`,
      ) || changed
  }
  for (const branchSession of legacy.branch_sessions) {
    changed =
      upsertByKey(canonical.branch_sessions, branchSession, (value) => value.branchSessionId) ||
      changed
  }
  for (const reviewedBatch of legacy.reviewed_batches) {
    changed =
      upsertByKey(canonical.reviewed_batches, reviewedBatch, (value) => value.reviewId) || changed
  }
  for (const issueSummary of legacy.issue_summaries) {
    changed =
      upsertByKey(canonical.issue_summaries, issueSummary, (value) => value.summaryId) || changed
  }
  for (const fixCycle of legacy.fix_cycles) {
    changed = upsertByKey(canonical.fix_cycles, fixCycle, (value) => value.cycleId) || changed
  }
  for (const escalation of legacy.escalations) {
    changed =
      upsertByKey(canonical.escalations, escalation, (value) => value.escalationId) || changed
  }
  for (const stageStop of legacy.stage_stops) {
    changed = upsertByKey(canonical.stage_stops, stageStop, (value) => value.stopId) || changed
  }

  if (!changed) {
    return false
  }

  canonical.last_updated = new Date().toISOString()
  runtimeState.supervision = canonical
  runtimeState.last_updated = canonical.last_updated
  return true
}

function mergeBatchStatusesFromLegacy(
  runtimeState: WorkstreamUnifiedRuntimeState,
  legacyBatchStatuses: PersistedBatchStatusFile[],
): boolean {
  if (legacyBatchStatuses.length === 0) {
    return false
  }

  let changed = false
  for (const batchStatus of legacyBatchStatuses) {
    if (!runtimeState.batches[batchStatus.batchId]) {
      runtimeState.batches[batchStatus.batchId] = batchStatus
      changed = true
    }
  }

  if (changed) {
    runtimeState.last_updated = new Date().toISOString()
  }

  return changed
}

function importTaskLocalSessionsIntoRuntimeState(tasksFile: TasksFile): boolean {
  if (!hasSessionsInTasksJson(tasksFile)) {
    return false
  }

  tasksFile.runtime_state = normalizeRuntimeState(tasksFile.stream_id, tasksFile.runtime_state)
  const threadMap = new Map<string, ThreadMetadata>()

  for (const thread of tasksFile.runtime_state.threads) {
    threadMap.set(thread.threadId, {
      ...thread,
      sessions: [...thread.sessions],
    })
  }

  for (const task of tasksFile.tasks) {
    const threadId = extractThreadIdFromTaskId(task.id)
    let thread = threadMap.get(threadId)
    if (!thread) {
      thread = { threadId, sessions: [] }
      threadMap.set(threadId, thread)
    }

    if (task.sessions) {
      const existingSessionIds = new Set(thread.sessions.map((session) => session.sessionId))
      for (const session of task.sessions) {
        if (!existingSessionIds.has(session.sessionId)) {
          thread.sessions.push(session)
          existingSessionIds.add(session.sessionId)
        }
      }
    }

    if (!thread.currentSessionId && task.currentSessionId) {
      thread.currentSessionId = task.currentSessionId
    }
  }

  tasksFile.runtime_state.threads = Array.from(threadMap.values()).sort((a, b) =>
    a.threadId.localeCompare(b.threadId, undefined, { numeric: true }),
  )
  tasksFile.runtime_state.last_updated = new Date().toISOString()
  tasksFile.tasks = clearSessionsFromTasks(tasksFile).tasks
  return true
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function getTasksRuntimeLockPath(repoRoot: string, streamId: string): string {
  return `${getTasksFilePath(repoRoot, streamId)}.runtime.lock`
}

function acquireTasksRuntimeLockSync(repoRoot: string, streamId: string): () => void {
  const lockPath = getTasksRuntimeLockPath(repoRoot, streamId)
  let lastError: unknown

  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      mkdirSync(lockPath)
      return () => {
        try {
          rmSync(lockPath, { recursive: true, force: true })
        } catch {
          // Best effort cleanup.
        }
      }
    } catch (error) {
      lastError = error
      sleepSync(25)
    }
  }

  throw new Error(
    `Timed out acquiring tasks.json runtime lock for stream ${streamId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

function withTasksRuntimeLockSync<T>(
  repoRoot: string,
  streamId: string,
  fn: () => T,
): T {
  mkdirSync(join(getWorkDir(repoRoot), streamId), { recursive: true })
  const release = acquireTasksRuntimeLockSync(repoRoot, streamId)

  try {
    return fn()
  } finally {
    release()
  }
}

async function acquireTasksRuntimeLock(repoRoot: string, streamId: string): Promise<() => void> {
  const lockPath = getTasksRuntimeLockPath(repoRoot, streamId)
  let lastError: unknown

  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      mkdirSync(lockPath)
      return () => {
        try {
          rmSync(lockPath, { recursive: true, force: true })
        } catch {
          // Best effort cleanup.
        }
      }
    } catch (error) {
      lastError = error
      await Bun.sleep(25)
    }
  }

  throw new Error(
    `Timed out acquiring tasks.json runtime lock for stream ${streamId}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}

async function withTasksRuntimeLock<T>(
  repoRoot: string,
  streamId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  mkdirSync(join(getWorkDir(repoRoot), streamId), { recursive: true })
  const release = await acquireTasksRuntimeLock(repoRoot, streamId)

  try {
    return await fn()
  } finally {
    release()
  }
}

function readTasksFileSnapshot(
  repoRoot: string,
  streamId: string,
): TasksFile | null {
  const filePath = getTasksFilePath(repoRoot, streamId)

  if (!existsSync(filePath)) {
    return null
  }

  const content = readFileSync(filePath, "utf-8")
  const tasksFile = JSON.parse(content) as TasksFile

  return {
    version: tasksFile.version ?? TASKS_FILE_VERSION,
    stream_id: tasksFile.stream_id ?? streamId,
    last_updated: tasksFile.last_updated ?? new Date().toISOString(),
    runtime_state: normalizeRuntimeState(streamId, tasksFile.runtime_state),
    ...(tasksFile.runtime_summary ? { runtime_summary: tasksFile.runtime_summary } : {}),
    tasks: Array.isArray(tasksFile.tasks) ? tasksFile.tasks : [],
  }
}

function listLegacyBatchStatusFiles(repoRoot: string, streamId: string): string[] {
  const batchStatusDir = getLegacyBatchStatusDirPath(repoRoot, streamId)
  if (!existsSync(batchStatusDir)) {
    return []
  }

  return readdirSync(batchStatusDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(batchStatusDir, entry))
}

function shouldImportLegacyBatchStatuses(repoRoot: string, streamId: string): boolean {
  return loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId, { normalizeIds: false }) === null
}

function shouldImportLegacyThreads(repoRoot: string, streamId: string): boolean {
  return loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId, { normalizeIds: false }) === null
}

function importLegacyRuntimeStateUnlocked(repoRoot: string, streamId: string, tasksFile: TasksFile): boolean {
  tasksFile.runtime_state = normalizeRuntimeState(streamId, tasksFile.runtime_state)

  let changed = importTaskLocalSessionsIntoRuntimeState(tasksFile)

  if (shouldImportLegacyThreads(repoRoot, streamId)) {
    const legacyThreads = readJsonFileIfExists<ThreadsJson>(getLegacyThreadsFilePath(repoRoot, streamId))
    changed = mergeRuntimeThreads(streamId, tasksFile.runtime_state, legacyThreads) || changed
  }

  const legacySupervisorState = readJsonFileIfExists<SupervisorStateFile>(
    getLegacySupervisorStateFilePath(repoRoot, streamId),
  )
  changed =
    mergeSupervisorStateFromLegacy(streamId, tasksFile.runtime_state, legacySupervisorState) || changed

  if (shouldImportLegacyBatchStatuses(repoRoot, streamId)) {
    const legacyBatchStatuses = listLegacyBatchStatusFiles(repoRoot, streamId)
      .map((filePath) => readJsonFileIfExists<PersistedBatchStatusFile>(filePath))
      .filter((batchStatus): batchStatus is PersistedBatchStatusFile => batchStatus !== null)
    changed = mergeBatchStatusesFromLegacy(tasksFile.runtime_state, legacyBatchStatuses) || changed
  }

  return changed
}

export function importLegacyRuntimeState(
  repoRoot: string,
  streamId: string,
): { migrated: boolean; tasksFile: TasksFile } {
  return withTasksRuntimeLockSync(repoRoot, streamId, () => {
    const tasksFile = readTasksFileSnapshot(repoRoot, streamId) ?? createEmptyTasksFile(streamId)
    const migrated = importLegacyRuntimeStateUnlocked(repoRoot, streamId, tasksFile)

    if (migrated) {
      delete tasksFile.runtime_summary
      writeTasksFile(repoRoot, streamId, tasksFile)
    }

    return { migrated, tasksFile }
  })
}

export function mutateRuntimeState<T>(
  repoRoot: string,
  streamId: string,
  fn: (runtimeState: WorkstreamUnifiedRuntimeState, tasksFile: TasksFile) => T,
): T {
  return withTasksRuntimeLockSync(repoRoot, streamId, () => {
    const tasksFile = readTasksFileSnapshot(repoRoot, streamId) ?? createEmptyTasksFile(streamId)
    importLegacyRuntimeStateUnlocked(repoRoot, streamId, tasksFile)
    tasksFile.runtime_state = normalizeRuntimeState(streamId, tasksFile.runtime_state)
    const result = fn(tasksFile.runtime_state, tasksFile)
    delete tasksFile.runtime_summary
    writeTasksFile(repoRoot, streamId, tasksFile)
    return result
  })
}

export async function modifyRuntimeState<T>(
  repoRoot: string,
  streamId: string,
  fn: (runtimeState: WorkstreamUnifiedRuntimeState, tasksFile: TasksFile) => T | Promise<T>,
): Promise<T> {
  return withTasksRuntimeLock(repoRoot, streamId, async () => {
    const tasksFile = readTasksFileSnapshot(repoRoot, streamId) ?? createEmptyTasksFile(streamId)
    importLegacyRuntimeStateUnlocked(repoRoot, streamId, tasksFile)
    tasksFile.runtime_state = normalizeRuntimeState(streamId, tasksFile.runtime_state)
    const result = await fn(tasksFile.runtime_state, tasksFile)
    delete tasksFile.runtime_summary
    writeTasksFile(repoRoot, streamId, tasksFile)
    return result
  })
}

export function runtimeStateToThreadsJson(
  streamId: string,
  runtimeState?: WorkstreamUnifiedRuntimeState,
): ThreadsJson {
  return {
    version: runtimeState?.version ?? RUNTIME_STATE_VERSION,
    stream_id: streamId,
    last_updated: runtimeState?.last_updated ?? new Date().toISOString(),
    threads: runtimeState?.threads ?? [],
  }
}

export function normalizeSupervisorState(
  streamId: string,
  supervisorState?: Partial<SupervisorStateFile> | null,
): SupervisorStateFile {
  return {
    version: supervisorState?.version ?? "1.0.0",
    stream_id: supervisorState?.stream_id ?? streamId,
    last_updated: supervisorState?.last_updated ?? new Date().toISOString(),
    ...(supervisorState?.active_run_id ? { active_run_id: supervisorState.active_run_id } : {}),
    ...(supervisorState?.current_branch_supervision
      ? {
          current_branch_supervision: { ...supervisorState.current_branch_supervision },
        }
      : {}),
    runs: (supervisorState?.runs ?? []).map((run) => ({ ...run })),
    checkpoint_pointers: (supervisorState?.checkpoint_pointers ?? []).map((pointer) => ({ ...pointer })),
    branch_sessions: (supervisorState?.branch_sessions ?? []).map((branchSession) => ({
      ...branchSession,
      ...(branchSession.scope ? { scope: { ...branchSession.scope } } : {}),
      ...(branchSession.supervisionProgress
        ? { supervisionProgress: { ...branchSession.supervisionProgress } }
        : {}),
    })),
    reviewed_batches: (supervisorState?.reviewed_batches ?? []).map((reviewedBatch) => ({
      ...reviewedBatch,
      threadIds: [...(reviewedBatch.threadIds ?? [])],
    })),
    issue_summaries: (supervisorState?.issue_summaries ?? []).map((issueSummary) => ({ ...issueSummary })),
    fix_cycles: (supervisorState?.fix_cycles ?? []).map((fixCycle) => ({ ...fixCycle })),
    escalations: (supervisorState?.escalations ?? []).map((escalation) => ({ ...escalation })),
    stage_stops: (supervisorState?.stage_stops ?? []).map((stageStop) => ({ ...stageStop })),
  }
}

export function normalizeLoadedSupervisorState(
  streamId: string,
  supervisorState?: Partial<SupervisorStateFile> | null,
): SupervisorStateFile {
  const normalized = normalizeSupervisorState(streamId, supervisorState)

  return {
    ...normalized,
    ...(normalized.current_branch_supervision
      ? {
          current_branch_supervision: normalizePersistedCurrentBranchSupervisionContext(
            normalized.current_branch_supervision,
          ),
        }
      : {}),
    runs: normalized.runs.map(normalizePersistedSupervisorRunState),
    branch_sessions: normalized.branch_sessions.map(normalizePersistedBranchSession),
    reviewed_batches: normalized.reviewed_batches.map(normalizePersistedSupervisorReviewedBatch),
    issue_summaries: normalized.issue_summaries.map(normalizePersistedSupervisorIssueSummary),
    fix_cycles: normalized.fix_cycles.map(normalizePersistedSupervisorFixCycle),
    escalations: normalized.escalations.map(normalizePersistedSupervisorEscalation),
    stage_stops: normalized.stage_stops.map(normalizePersistedSupervisorStageStop),
  }
}

export function normalizeRuntimeState(
  streamId: string,
  runtimeState?: Partial<WorkstreamUnifiedRuntimeState> | null,
): WorkstreamUnifiedRuntimeState {
  const empty = createEmptyRuntimeState(streamId)

  const normalizedThreads = Array.isArray(runtimeState?.threads)
    ? runtimeState.threads.map((thread) => ({
        ...thread,
        sessions: (thread.sessions ?? []).map((session) => ({
          ...session,
          ...(session.lineage ? { lineage: { ...session.lineage } } : {}),
        })),
        ...(thread.synthesis ? { synthesis: { ...thread.synthesis } } : {}),
      }))
    : []

  const normalizedBatches = Object.fromEntries(
    Object.entries(runtimeState?.batches ?? {}).map(([batchId, batchStatus]) => {
      return [
        batchId,
        {
          ...batchStatus,
          summary: { ...batchStatus.summary },
          threads: (batchStatus.threads ?? []).map((thread) => ({ ...thread })),
        },
      ]
    }),
  )

  return {
    version: runtimeState?.version ?? empty.version,
    last_updated: runtimeState?.last_updated ?? empty.last_updated,
    threads: normalizedThreads,
    batches: normalizedBatches,
    supervision: normalizeSupervisorState(streamId, runtimeState?.supervision),
  }
}

export function normalizeLoadedRuntimeState(
  streamId: string,
  runtimeState?: Partial<WorkstreamUnifiedRuntimeState> | null,
): WorkstreamUnifiedRuntimeState {
  const normalized = normalizeRuntimeState(streamId, runtimeState)

  return {
    ...normalized,
    threads: normalized.threads.map(normalizePersistedThreadMetadata),
    batches: Object.fromEntries(
      Object.entries(normalized.batches).map(([batchId, batchStatus]) => {
        const normalizedBatchStatus = normalizePersistedBatchStatus(batchStatus, batchId)
        return [normalizedBatchStatus.batchId, normalizedBatchStatus]
      }),
    ),
    supervision: normalizeLoadedSupervisorState(streamId, normalized.supervision),
  }
}

function toRuntimeBatchSummary(batchStatus: PersistedBatchStatusFile): WorkstreamRuntimeBatchSummary {
  return {
    batch_id: batchStatus.batchId,
    run_id: batchStatus.runId,
    status: batchStatus.status,
    started_at: batchStatus.startedAt,
    updated_at: batchStatus.updatedAt,
    ...(batchStatus.completedAt ? { completed_at: batchStatus.completedAt } : {}),
    ...(batchStatus.stageName ? { stage_name: batchStatus.stageName } : {}),
    ...(batchStatus.batchName ? { batch_name: batchStatus.batchName } : {}),
    thread_summary: batchStatus.summary,
  }
}

function toRuntimeSupervisorRunSummary(
  run: SupervisorStateFile["runs"][number],
): WorkstreamRuntimeSupervisorRunSummary {
  return {
    run_id: run.runId,
    stage_id: run.stageId,
    status: run.status,
    updated_at: run.updatedAt,
    started_at: run.startedAt,
    ...(run.completedAt ? { completed_at: run.completedAt } : {}),
    ...(run.currentBatchId ? { current_batch_id: run.currentBatchId } : {}),
    ...(run.lastReviewedBatchId ? { last_reviewed_batch_id: run.lastReviewedBatchId } : {}),
    review_passes: run.reviewPasses,
    ...(run.stopReason ? { stop_reason: run.stopReason } : {}),
    ...(run.branchSessionId ? { branch_session_id: run.branchSessionId } : {}),
    ...(run.rootSessionId ? { root_session_id: run.rootSessionId } : {}),
  }
}

function toRuntimeBranchSupervisionSummary(
  branch: NonNullable<SupervisorStateFile["current_branch_supervision"]>,
  matchingBranchSession?: SupervisorStateFile["branch_sessions"][number],
): WorkstreamRuntimeBranchSupervisionSummary {
  const status =
    matchingBranchSession?.status === "pending" ||
    matchingBranchSession?.status === "running" ||
    matchingBranchSession?.status === "stopped"
      ? matchingBranchSession.status
      : "running"

  return {
    branch_session_id: branch.branchSessionId,
    root_session_id: branch.rootSessionId,
    status,
    updated_at: branch.updatedAt,
    ...(branch.scope ? { scope_level: branch.scope.level, stage_id: branch.scope.stageId } : {}),
    ...(branch.scope?.level === "batch" ? { batch_id: branch.scope.batchId } : {}),
    ...(branch.supervisionProgress?.executionMode
      ? { execution_mode: branch.supervisionProgress.executionMode }
      : {}),
    ...(branch.supervisionProgress?.currentBatchId
      ? { current_batch_id: branch.supervisionProgress.currentBatchId }
      : {}),
    ...(branch.supervisionProgress?.lastReviewedBatchId
      ? { last_reviewed_batch_id: branch.supervisionProgress.lastReviewedBatchId }
      : {}),
  }
}

function summarizeSupervisionRuntime(
  supervisorState: SupervisorStateFile,
): WorkstreamRuntimeSupervisionSummary | undefined {
  if (!supervisorState) {
    return undefined
  }

  const activeRun = supervisorState.active_run_id
    ? supervisorState.runs.find((run) => run.runId === supervisorState.active_run_id)
    : undefined
  const latestRun = [...(supervisorState.runs ?? [])].sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  )[0]
  const currentBranch = supervisorState.current_branch_supervision
  const matchingBranchSession = currentBranch?.branchSessionId
    ? supervisorState.branch_sessions?.find(
        (branchSession) => branchSession.branchSessionId === currentBranch.branchSessionId,
      )
    : undefined

  if (!activeRun && !latestRun && !currentBranch) {
    return undefined
  }

  const updatedAt = [
    supervisorState.last_updated,
    activeRun?.updatedAt,
    latestRun?.updatedAt,
    currentBranch?.updatedAt,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.localeCompare(a))[0] ?? new Date().toISOString()

  return {
    updated_at: updatedAt,
    ...(supervisorState.active_run_id ? { active_run_id: supervisorState.active_run_id } : {}),
    ...(activeRun ? { active_run: toRuntimeSupervisorRunSummary(activeRun) } : {}),
    ...(latestRun ? { latest_run: toRuntimeSupervisorRunSummary(latestRun) } : {}),
    ...(currentBranch
      ? { current_branch: toRuntimeBranchSupervisionSummary(currentBranch, matchingBranchSession) }
      : {}),
  }
}

function projectRuntimeSummaryFromStructuredState(
  workstreamState: {
    batchRuns: PersistedBatchStatusFile[]
    supervision: SupervisorStateFile
  },
): WorkstreamRuntimeSummary | undefined {
  const batches = Object.fromEntries(
    workstreamState.batchRuns.map((batchStatus) => [batchStatus.batchId, toRuntimeBatchSummary(batchStatus)]),
  )
  const supervision = summarizeSupervisionRuntime(workstreamState.supervision)

  if (Object.keys(batches).length === 0 && !supervision) {
    return undefined
  }

  return {
    updated_at: new Date().toISOString(),
    batches,
    ...(supervision ? { supervision } : {}),
  }
}

export function projectRuntimeSummary(
  repoRoot: string,
  streamId: string,
  tasksFile?: TasksFile | null,
): WorkstreamRuntimeSummary | undefined {
  const sqliteState = loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId)
  if (sqliteState) {
    return projectRuntimeSummaryFromStructuredState(sqliteState)
  }

  const resolvedTasksFile = tasksFile ?? readTasksFile(repoRoot, streamId)
  const runtimeState = normalizeLoadedRuntimeState(streamId, resolvedTasksFile?.runtime_state)
  const batches = Object.fromEntries(
    Object.entries(runtimeState.batches).map(([batchId, batchStatus]) => [
      batchId,
      toRuntimeBatchSummary(batchStatus),
    ]),
  )
  const supervision = summarizeSupervisionRuntime(runtimeState.supervision)

  if (Object.keys(batches).length === 0 && !supervision) {
    return undefined
  }

  return {
    updated_at: new Date().toISOString(),
    batches,
    ...(supervision ? { supervision } : {}),
  }
}

export function getEffectiveRuntimeSummary(
  repoRoot: string,
  streamId: string,
  tasksFile?: TasksFile | null,
): WorkstreamRuntimeSummary | undefined {
  if (loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId)) {
    return projectRuntimeSummary(repoRoot, streamId, tasksFile)
  }

  if (tasksFile?.runtime_summary) {
    return tasksFile.runtime_summary
  }

  return projectRuntimeSummary(repoRoot, streamId, tasksFile)
}

export function persistProjectedRuntimeSummary(repoRoot: string, streamId: string): TasksFile | null {
  const latest = readTasksFile(repoRoot, streamId)
  if (!latest) {
    return null
  }

  const runtimeSummary = projectRuntimeSummary(repoRoot, streamId, latest)

  const nextTasksFile: TasksFile = {
    version: latest.version ?? TASKS_FILE_VERSION,
    stream_id: latest.stream_id ?? streamId,
    last_updated: latest.last_updated ?? new Date().toISOString(),
    runtime_state: normalizeRuntimeState(streamId, latest.runtime_state),
    ...(runtimeSummary ? { runtime_summary: runtimeSummary } : {}),
    tasks: Array.isArray(latest.tasks) ? latest.tasks : [],
  }

  writeTasksFile(repoRoot, streamId, nextTasksFile)
  return nextTasksFile
}

// ============================================
// SESSION VALIDATION & MIGRATION
// ============================================

const VALID_SESSION_STATUSES: SessionStatus[] = ["running", "completed", "failed", "interrupted"]

/**
 * Validation error for session-related fields
 */
export interface SessionValidationError {
  taskId: string
  field: string
  message: string
}

/**
 * Validate a SessionRecord structure
 * Returns an array of validation errors (empty if valid)
 */
export function validateSessionRecord(
  session: unknown,
  taskId: string,
): SessionValidationError[] {
  const errors: SessionValidationError[] = []

  if (!session || typeof session !== "object") {
    errors.push({
      taskId,
      field: "session",
      message: "Session must be an object",
    })
    return errors
  }

  const s = session as Record<string, unknown>

  // Required fields
  if (typeof s.sessionId !== "string" || !s.sessionId) {
    errors.push({
      taskId,
      field: "sessionId",
      message: "sessionId is required and must be a non-empty string",
    })
  }

  if (typeof s.agentName !== "string" || !s.agentName) {
    errors.push({
      taskId,
      field: "agentName",
      message: "agentName is required and must be a non-empty string",
    })
  }

  if (typeof s.model !== "string" || !s.model) {
    errors.push({
      taskId,
      field: "model",
      message: "model is required and must be a non-empty string",
    })
  }

  if (typeof s.startedAt !== "string" || !s.startedAt) {
    errors.push({
      taskId,
      field: "startedAt",
      message: "startedAt is required and must be an ISO date string",
    })
  } else if (isNaN(Date.parse(s.startedAt as string))) {
    errors.push({
      taskId,
      field: "startedAt",
      message: "startedAt must be a valid ISO date string",
    })
  }

  if (typeof s.status !== "string" || !VALID_SESSION_STATUSES.includes(s.status as SessionStatus)) {
    errors.push({
      taskId,
      field: "status",
      message: `status must be one of: ${VALID_SESSION_STATUSES.join(", ")}`,
    })
  }

  // Optional fields validation
  if (s.completedAt !== undefined) {
    if (typeof s.completedAt !== "string") {
      errors.push({
        taskId,
        field: "completedAt",
        message: "completedAt must be a string if provided",
      })
    } else if (isNaN(Date.parse(s.completedAt))) {
      errors.push({
        taskId,
        field: "completedAt",
        message: "completedAt must be a valid ISO date string",
      })
    }
  }

  if (s.exitCode !== undefined && typeof s.exitCode !== "number") {
    errors.push({
      taskId,
      field: "exitCode",
      message: "exitCode must be a number if provided",
    })
  }

  return errors
}

/**
 * Validate task session fields (sessions array and currentSessionId)
 * Returns an array of validation errors (empty if valid)
 */
export function validateTaskSessions(task: Task): SessionValidationError[] {
  const errors: SessionValidationError[] = []

  // sessions is optional, but if present must be an array
  if (task.sessions !== undefined) {
    if (!Array.isArray(task.sessions)) {
      errors.push({
        taskId: task.id,
        field: "sessions",
        message: "sessions must be an array",
      })
    } else {
      // Validate each session record
      for (let i = 0; i < task.sessions.length; i++) {
        const sessionErrors = validateSessionRecord(task.sessions[i], task.id)
        for (const err of sessionErrors) {
          errors.push({
            ...err,
            field: `sessions[${i}].${err.field}`,
          })
        }
      }

      // Validate currentSessionId references a valid session
      if (task.currentSessionId !== undefined) {
        if (typeof task.currentSessionId !== "string") {
          errors.push({
            taskId: task.id,
            field: "currentSessionId",
            message: "currentSessionId must be a string",
          })
        } else {
          const sessionExists = task.sessions.some(
            (s) => s.sessionId === task.currentSessionId
          )
          if (!sessionExists && task.sessions.length > 0) {
            errors.push({
              taskId: task.id,
              field: "currentSessionId",
              message: `currentSessionId '${task.currentSessionId}' does not match any session in sessions array`,
            })
          }
        }
      }
    }
  } else if (task.currentSessionId !== undefined) {
    // currentSessionId without sessions array
    errors.push({
      taskId: task.id,
      field: "currentSessionId",
      message: "currentSessionId is set but sessions array is missing",
    })
  }

  return errors
}

/**
 * Validate all tasks in a TasksFile for session integrity
 * Returns an array of validation errors (empty if all valid)
 */
export function validateTasksFileSessions(tasksFile: TasksFile): SessionValidationError[] {
  const errors: SessionValidationError[] = []

  for (const task of tasksFile.tasks) {
    const taskErrors = validateTaskSessions(task)
    errors.push(...taskErrors)
  }

  return errors
}



// ============================================
// SESSION DATA MIGRATION TO UNIFIED RUNTIME STATE
// ============================================

/**
 * Check if any task in tasks.json has session data that needs migration
 * Returns true if sessions exist in tasks.json
 */
export function hasSessionsInTasksJson(tasksFile: TasksFile): boolean {
  return tasksFile.tasks.some((task) => 
    (task.sessions && task.sessions.length > 0) || task.currentSessionId
  )
}

/**
 * Clear legacy task-local session data after migration into runtime_state.threads.
 * Returns the updated TasksFile
 */
export function clearSessionsFromTasks(tasksFile: TasksFile): TasksFile {
  return {
    ...tasksFile,
    tasks: tasksFile.tasks.map((task) => ({
      ...task,
      sessions: undefined,
      currentSessionId: undefined,
    })),
  }
}

/**
 * Migrate legacy task-local session data from tasks[] into runtime_state.threads.
 * Returns the migration result
 */
export function migrateSessionsToThreads(
  repoRoot: string,
  streamId: string,
  tasksFile: TasksFile,
): { migrated: boolean; error?: string } {
  try {
    const clonedTasksFile: TasksFile = {
      ...tasksFile,
      runtime_state: normalizeRuntimeState(streamId, tasksFile.runtime_state),
      tasks: tasksFile.tasks.map((task) => ({ ...task })),
    }
    const migrated = importTaskLocalSessionsIntoRuntimeState(clonedTasksFile)

    if (!migrated) {
      return { migrated: false }
    }

    writeTasksFile(repoRoot, streamId, clonedTasksFile)
    return { migrated: true }
  } catch (err) {
    return { 
      migrated: false, 
      error: err instanceof Error ? err.message : String(err) 
    }
  }
}

// ============================================
// SESSION MANAGEMENT FUNCTIONS
// ============================================

/**
 * Extract thread ID from task ID
 * Task ID format: "SS.BB.TT.NN" -> Thread ID: "SS.BB.TT"
 */
function extractThreadIdFromTaskId(taskId: string): string {
  const parts = taskId.split(".")
  if (parts.length !== 4) {
    throw new Error(`Invalid task ID format: ${taskId}. Expected "SS.BB.TT.NN"`)
  }
  return `${parts[0]}.${parts[1]}.${parts[2]}`
}

/**
 * Generate a unique session ID
 * Format: "ses_{timestamp}_{random}" for human-readability and uniqueness
 */
export function generateSessionId(): string {
  const timestamp = Date.now().toString(36) // Base36 for compactness
  const random = Math.random().toString(36).substring(2, 8)
  return `ses_${timestamp}_${random}`
}

/**
 * Start a new session for a task
 * Creates a SessionRecord with 'running' status and sets it as currentSessionId
 * Returns the created session record, or null if task not found
 * 
 * NOTE: Session data is persisted in tasks.json under runtime_state.threads.
 * Legacy threads.json imports are handled during migration/compatibility reads.
 * The task must exist in tasks.json for validation.
 */
export function startTaskSession(
  repoRoot: string,
  streamId: string,
  taskId: string,
  agentName: string,
  model: string,
): SessionRecord | null {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return null

  const taskIndex = tasksFile.tasks.findIndex((t) => t.id === taskId)
  if (taskIndex === -1) return null

  // Extract thread ID from task ID and delegate to threads.ts
  const threadId = extractThreadIdFromTaskId(taskId)
  const sessionId = generateSessionId()
  
  return startThreadSession(repoRoot, streamId, threadId, agentName, model, sessionId)
}

/**
 * Complete a session for a task
 * Updates the session status and exit code, clears currentSessionId
 * Returns the updated session record, or null if not found
 * 
 * NOTE: Session data is persisted in tasks.json under runtime_state.threads.
 */
export function completeTaskSession(
  repoRoot: string,
  streamId: string,
  taskId: string,
  sessionId: string,
  status: SessionStatus,
  exitCode?: number,
): SessionRecord | null {
  // Extract thread ID from task ID and delegate to threads.ts
  const threadId = extractThreadIdFromTaskId(taskId)
  
  return completeThreadSession(repoRoot, streamId, threadId, sessionId, status, exitCode)
}

/**
 * Get the current session for a task
 * Returns the session record if there's an active session, null otherwise
 * 
 * NOTE: Session data is persisted in tasks.json under runtime_state.threads.
 */
export function getCurrentTaskSession(
  repoRoot: string,
  streamId: string,
  taskId: string,
): SessionRecord | null {
  const threadId = extractThreadIdFromTaskId(taskId)
  const thread = getThreadMetadata(repoRoot, streamId, threadId)
  if (!thread || !thread.currentSessionId) return null

  return thread.sessions.find((s) => s.sessionId === thread.currentSessionId) || null
}

/**
 * Get all sessions for a task
 * Returns empty array if task not found or has no sessions
 * 
 * NOTE: Session data is persisted in tasks.json under runtime_state.threads.
 */
export function getTaskSessions(
  repoRoot: string,
  streamId: string,
  taskId: string,
): SessionRecord[] {
  const threadId = extractThreadIdFromTaskId(taskId)
  const thread = getThreadMetadata(repoRoot, streamId, threadId)
  if (!thread) return []
  return thread.sessions
}

// ============================================
// LOCKED SESSION OPERATIONS (for concurrent access)
// ============================================

/**
 * Start a session for a task with file locking (safe for concurrent access)
 * Use this when multiple threads may update runtime_state.threads simultaneously
 * 
 * NOTE: Session data is persisted in tasks.json under runtime_state.threads.
 * Legacy threads.json imports are handled during migration/compatibility reads.
 * The task must exist in tasks.json for validation.
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param taskId - Task ID (format: "01.02.03.04")
 * @param agentName - Name of the agent running the session
 * @param model - Model being used
 * @param sessionId - Pre-generated session ID (use generateSessionId())
 * @returns The created session record, or null if task not found
 */
export async function startTaskSessionLocked(
  repoRoot: string,
  streamId: string,
  taskId: string,
  agentName: string,
  model: string,
  sessionId: string,
  lineage?: RootAgentLineage,
): Promise<SessionRecord | null> {
  const filePath = getTasksFilePath(repoRoot, streamId)
  
  if (!existsSync(filePath)) return null

  // Verify task exists
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return null

  const taskIndex = tasksFile.tasks.findIndex((t) => t.id === taskId)
  if (taskIndex === -1) return null

  // Extract thread ID from task ID and delegate to threads.ts
  const threadId = extractThreadIdFromTaskId(taskId)
  
  return startThreadSessionLocked(repoRoot, streamId, threadId, agentName, model, sessionId, lineage)
}

/**
 * Complete a session for a task with file locking (safe for concurrent access)
 * Use this when multiple threads may update runtime_state.threads simultaneously
 * 
 * NOTE: Session data is persisted in tasks.json under runtime_state.threads.
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param taskId - Task ID (format: "01.02.03.04")
 * @param sessionId - Session ID to complete
 * @param status - Final session status
 * @param exitCode - Optional exit code
 * @returns The updated session record, or null if not found
 */
export async function completeTaskSessionLocked(
  repoRoot: string,
  streamId: string,
  taskId: string,
  sessionId: string,
  status: SessionStatus,
  exitCode?: number,
): Promise<SessionRecord | null> {
  // Extract thread ID from task ID and delegate to threads.ts
  const threadId = extractThreadIdFromTaskId(taskId)
  
  return completeThreadSessionLocked(repoRoot, streamId, threadId, sessionId, status, exitCode)
}

/**
 * Start sessions for multiple tasks atomically with file locking
 * Use this when spawning parallel threads to record all sessions in one write
 * 
 * NOTE: Session data is persisted in tasks.json under runtime_state.threads.
 * Tasks must exist in tasks.json for validation.
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param sessions - Array of session info to start (taskId + session details)
 * @returns Array of created session records (empty for tasks not found)
 */
export async function startMultipleSessionsLocked(
  repoRoot: string,
  streamId: string,
  sessions: Array<{
    taskId: string
    agentName: string
    model: string
    sessionId: string
    lineage?: RootAgentLineage
  }>,
): Promise<SessionRecord[]> {
  const filePath = getTasksFilePath(repoRoot, streamId)
  
  if (!existsSync(filePath)) return []

  // Verify tasks exist and convert to thread sessions
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return []

  const threadSessions: Array<{
    threadId: string
    agentName: string
    model: string
    sessionId: string
    lineage?: RootAgentLineage
  }> = []

  for (const sessionInfo of sessions) {
    const taskIndex = tasksFile.tasks.findIndex((t) => t.id === sessionInfo.taskId)
    if (taskIndex === -1) continue

    const threadId = extractThreadIdFromTaskId(sessionInfo.taskId)
    threadSessions.push({
      threadId,
      agentName: sessionInfo.agentName,
      model: sessionInfo.model,
      sessionId: sessionInfo.sessionId,
      lineage: sessionInfo.lineage,
    })
  }

  if (threadSessions.length === 0) return []

  // Delegate to threads.ts
  return startMultipleThreadSessionsLocked(repoRoot, streamId, threadSessions)
}

/**
 * Complete sessions for multiple tasks atomically with file locking
 * Use this on batch completion to update all session statuses in one write
 * 
 * NOTE: Session data is persisted in tasks.json under runtime_state.threads.
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param completions - Array of session completions (sessionId + status + optional exitCode)
 * @returns Array of updated session records
 */
export async function completeMultipleSessionsLocked(
  repoRoot: string,
  streamId: string,
  completions: Array<{
    taskId: string
    sessionId: string
    status: SessionStatus
    exitCode?: number
  }>,
): Promise<SessionRecord[]> {
  if (completions.length === 0) return []

  // Convert to thread completions
  const threadCompletions = completions.map((completion) => ({
    threadId: extractThreadIdFromTaskId(completion.taskId),
    sessionId: completion.sessionId,
    status: completion.status,
    exitCode: completion.exitCode,
  }))

  // Delegate to threads.ts
  return completeMultipleThreadSessionsLocked(repoRoot, streamId, threadCompletions)
}

/**
 * Read tasks.json from a workstream directory
 * Automatically migrates legacy task-local session data into runtime_state.threads
 * Returns null if file doesn't exist
 */
export function readTasksFile(
  repoRoot: string,
  streamId: string,
  options?: { normalizeIds?: boolean },
): TasksFile | null {
  importLegacyRuntimeState(repoRoot, streamId)
  const tasksFile = readTasksFileSnapshot(repoRoot, streamId)
  if (!tasksFile) {
    return null
  }

  if (options?.normalizeIds !== false) {
    tasksFile.runtime_state = normalizeLoadedRuntimeState(streamId, tasksFile.runtime_state)
  }

  if (!tasksFile.runtime_summary) {
    const runtimeSummary = projectRuntimeSummary(repoRoot, streamId, tasksFile)
    if (runtimeSummary) {
      tasksFile.runtime_summary = runtimeSummary
    }
  }

  return tasksFile
}

/**
 * Write tasks.json to a workstream directory
 */
export function writeTasksFile(
  repoRoot: string,
  streamId: string,
  tasksFile: TasksFile,
): void {
  const filePath = getTasksFilePath(repoRoot, streamId)
  const lastUpdated = new Date().toISOString()
  const runtimeState = normalizeLoadedRuntimeState(streamId, tasksFile.runtime_state)
  runtimeState.last_updated = lastUpdated
  runtimeState.supervision.last_updated =
    runtimeState.supervision.last_updated || lastUpdated
  const ordered: TasksFile = {
    version: tasksFile.version ?? TASKS_FILE_VERSION,
    stream_id: tasksFile.stream_id ?? streamId,
    last_updated: lastUpdated,
    runtime_state: runtimeState,
    ...(tasksFile.runtime_summary
      ? { runtime_summary: tasksFile.runtime_summary }
      : projectRuntimeSummary(repoRoot, streamId, {
          ...tasksFile,
          runtime_state: runtimeState,
        })
        ? {
            runtime_summary: projectRuntimeSummary(repoRoot, streamId, {
              ...tasksFile,
              runtime_state: runtimeState,
            }),
          }
        : {}),
    tasks: Array.isArray(tasksFile.tasks) ? tasksFile.tasks : [],
  }
  atomicWriteFile(filePath, JSON.stringify(ordered, null, 2))
}

async function withTasksFileLock<T>(
  repoRoot: string,
  streamId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return withTasksRuntimeLock(repoRoot, streamId, fn)
}

export async function modifyTasksFile<T>(
  repoRoot: string,
  streamId: string,
  fn: (tasksFile: TasksFile) => T | Promise<T>,
): Promise<T> {
  return withTasksFileLock(repoRoot, streamId, async () => {
    const tasksFile = readTasksFileSnapshot(repoRoot, streamId) ?? createEmptyTasksFile(streamId)
    importLegacyRuntimeStateUnlocked(repoRoot, streamId, tasksFile)
    const result = await fn(tasksFile)
    writeTasksFile(repoRoot, streamId, tasksFile)
    return result
  })
}

export function getThreadRuntimeMetadata(
  tasksFile: TasksFile | null | undefined,
  threadId: string,
): ThreadMetadata | null {
  if (!tasksFile?.runtime_state) return null
  return tasksFile.runtime_state.threads.find((thread) => thread.threadId === threadId) ?? null
}

/**
 * Get a specific task by ID
 * Returns null if task not found
 */
export function getTaskById(
  repoRoot: string,
  streamId: string,
  taskId: string,
): Task | null {
  return getTasks(repoRoot, streamId).find((task) => task.id === taskId) ?? null
}

/**
 * Get all tasks, optionally filtered by status
 */
export function getTasks(
  repoRoot: string,
  streamId: string,
  status?: TaskStatus,
): Task[] {
  const sqliteState = loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId)
  if (sqliteState) {
    const stageById = new Map(sqliteState.hierarchy.stages.map((stage) => [stage.id, stage] as const))
    const batchById = new Map(sqliteState.hierarchy.batches.map((batch) => [batch.id, batch] as const))
    const threadById = new Map(sqliteState.hierarchy.threads.map((thread) => [thread.id, thread] as const))
    const tasks = sqliteState.hierarchy.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      stage_name: stageById.get(task.stageId)?.name ?? `Stage ${task.stageId}`,
      batch_name: batchById.get(task.batchId)?.name ?? `Batch ${task.batchId}`,
      thread_name: threadById.get(task.threadId)?.name ?? `Thread ${task.threadId}`,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
      status: task.status,
      ...(task.breadcrumb ? { breadcrumb: task.breadcrumb } : {}),
      ...(task.report ? { report: task.report } : {}),
      ...(task.assignedAgent ? { assigned_agent: task.assignedAgent } : {}),
    }))

    return status ? tasks.filter((task) => task.status === status) : tasks
  }

  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return []

  if (status) {
    return tasksFile.tasks.filter((t) => t.status === status)
  }
  return tasksFile.tasks
}

export interface TaskUpdateOptions {
  status?: TaskStatus
  breadcrumb?: string
  report?: string
  assigned_agent?: string
}

/**
 * Update a task's status
 * Returns the updated task, or null if not found
 */
export function updateTaskStatus(
  repoRoot: string,
  streamId: string,
  taskId: string,
  optionsOrStatus: TaskUpdateOptions | TaskStatus,
  legacyBreadcrumb?: string,
): Task | null {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return null

  const taskIndex = tasksFile.tasks.findIndex((t) => t.id === taskId)
  if (taskIndex === -1) return null

  const task = tasksFile.tasks[taskIndex]!

  let opts: TaskUpdateOptions
  if (typeof optionsOrStatus === "string") {
    opts = { status: optionsOrStatus, breadcrumb: legacyBreadcrumb }
  } else {
    opts = optionsOrStatus
  }

  if (opts.status) task.status = opts.status
  if (opts.breadcrumb) task.breadcrumb = opts.breadcrumb
  if (opts.report) task.report = opts.report
  if (opts.assigned_agent) task.assigned_agent = opts.assigned_agent

  task.updated_at = new Date().toISOString()

  writeTasksFile(repoRoot, streamId, tasksFile)
  return task
}

/**
 * Add tasks to tasks.json
 * Preserves existing task status and session data if task with same ID exists
 */
export function addTasks(
  repoRoot: string,
  streamId: string,
  newTasks: Task[],
): TasksFile {
  let tasksFile = readTasksFile(repoRoot, streamId)

  if (!tasksFile) {
    tasksFile = createEmptyTasksFile(streamId)
  }

  // Create a map of existing tasks by ID
  const existingTasksMap = new Map(tasksFile.tasks.map((t) => [t.id, t]))

  // Add new tasks, updating if they already exist
  for (const newTask of newTasks) {
    const existing = existingTasksMap.get(newTask.id)
    if (existing) {
      // Update existing task but preserve status, timestamps, and session data
      existingTasksMap.set(newTask.id, {
        ...newTask,
        status: existing.status,
        created_at: existing.created_at,
        updated_at: existing.updated_at,
        // Preserve session tracking data
        sessions: existing.sessions,
        currentSessionId: existing.currentSessionId,
      })
    } else {
      // Add new task
      existingTasksMap.set(newTask.id, newTask)
    }
  }

  // Convert map back to array, sorted by ID
  tasksFile.tasks = Array.from(existingTasksMap.values()).sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true }),
  )
  writeTasksFile(repoRoot, streamId, tasksFile)

  return tasksFile
}

/**
 * Replace tasks in tasks.json with a new canonical set.
 * Preserves status/runtime-linked metadata for task IDs that still exist,
 * and removes tasks omitted from the replacement list.
 */
export function replaceTasks(
  repoRoot: string,
  streamId: string,
  newTasks: Task[],
): TasksFile {
  let tasksFile = readTasksFile(repoRoot, streamId)

  if (!tasksFile) {
    tasksFile = createEmptyTasksFile(streamId)
  }

  const existingTasksMap = new Map(tasksFile.tasks.map((task) => [task.id, task]))

  tasksFile.tasks = newTasks
    .map((newTask) => {
      const existing = existingTasksMap.get(newTask.id)
      if (!existing) {
        return newTask
      }

      return {
        ...newTask,
        status: existing.status,
        created_at: existing.created_at,
        updated_at: existing.updated_at,
        sessions: existing.sessions,
        currentSessionId: existing.currentSessionId,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  writeTasksFile(repoRoot, streamId, tasksFile)

  return tasksFile
}

/**
 * Get task counts by status
 */
export function getTaskCounts(
  repoRoot: string,
  streamId: string,
): {
  total: number
  pending: number
  in_progress: number
  completed: number
  blocked: number
  cancelled: number
} {
  const tasks = getTasks(repoRoot, streamId)

  return {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    completed: tasks.filter((t) => t.status === "completed").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    cancelled: tasks.filter((t) => t.status === "cancelled").length,
  }
}

// ============================================
// TASK GROUPING UTILITIES
// ============================================

/**
 * Sort tasks by their numeric ID parts (e.g., "01.02.03.04")
 * Used internally by grouping functions
 */
function sortTasksById(tasks: Task[]): void {
  tasks.sort((a, b) => {
    const aParts = a.id.split(".").map(Number)
    const bParts = b.id.split(".").map(Number)
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] ?? 0
      const bVal = bParts[i] ?? 0
      if (aVal !== bVal) return aVal - bVal
    }
    return 0
  })
}

/**
 * Options for groupTasks function
 */
export interface GroupTasksOptions {
  /** Include batch level in grouping (default: true) */
  byBatch?: boolean
}

/**
 * Result types for groupTasks - depends on options
 */
export type GroupedByStageThread = Map<string, Map<string, Task[]>>
export type GroupedByStageBatchThread = Map<string, Map<string, Map<string, Task[]>>>

/**
 * Group tasks by stage, optionally batch, and thread
 * 
 * @param tasks - Array of tasks to group
 * @param options - Grouping options
 * @returns Nested Map structure grouped by stage -> (batch ->) thread -> tasks
 * 
 * When byBatch is false (or omitted as false):
 *   Returns Map<stageName, Map<threadName, Task[]>>
 * 
 * When byBatch is true (default):
 *   Returns Map<stageName, Map<batchName, Map<threadName, Task[]>>>
 */
export function groupTasks(
  tasks: Task[],
  options?: { byBatch: false }
): GroupedByStageThread
export function groupTasks(
  tasks: Task[],
  options: { byBatch: true }
): GroupedByStageBatchThread
export function groupTasks(
  tasks: Task[],
  options?: GroupTasksOptions
): GroupedByStageThread | GroupedByStageBatchThread
export function groupTasks(
  tasks: Task[],
  options: GroupTasksOptions = {}
): GroupedByStageThread | GroupedByStageBatchThread {
  const { byBatch = true } = options

  if (byBatch) {
    // 3-level grouping: stage -> batch -> thread
    const grouped = new Map<string, Map<string, Map<string, Task[]>>>()

    for (const task of tasks) {
      // Stage level
      if (!grouped.has(task.stage_name)) {
        grouped.set(task.stage_name, new Map())
      }
      const stageMap = grouped.get(task.stage_name)!

      // Batch level
      const batchName = task.batch_name || "Batch 01"
      if (!stageMap.has(batchName)) {
        stageMap.set(batchName, new Map())
      }
      const batchMap = stageMap.get(batchName)!

      // Thread level
      if (!batchMap.has(task.thread_name)) {
        batchMap.set(task.thread_name, [])
      }
      batchMap.get(task.thread_name)!.push(task)
    }

    // Sort tasks within each thread by ID
    for (const stageMap of grouped.values()) {
      for (const batchMap of stageMap.values()) {
        for (const threadTasks of batchMap.values()) {
          sortTasksById(threadTasks)
        }
      }
    }

    return grouped
  } else {
    // 2-level grouping: stage -> thread
    const grouped = new Map<string, Map<string, Task[]>>()

    for (const task of tasks) {
      if (!grouped.has(task.stage_name)) {
        grouped.set(task.stage_name, new Map())
      }
      const stageMap = grouped.get(task.stage_name)!

      if (!stageMap.has(task.thread_name)) {
        stageMap.set(task.thread_name, [])
      }
      stageMap.get(task.thread_name)!.push(task)
    }

    // Sort tasks within each thread by ID
    for (const stageMap of grouped.values()) {
      for (const threadTasks of stageMap.values()) {
        sortTasksById(threadTasks)
      }
    }

    return grouped
  }
}

// ============================================
// THREAD DISCOVERY FROM TASKS.JSON
// ============================================

/**
 * Discovered thread metadata from tasks.json
 * Contains all info needed to spawn thread execution
 */
export interface DiscoveredThread {
  threadId: string // Format: "SS.BB.TT" (e.g., "01.01.02")
  threadNum: number // Thread number within batch
  threadName: string // Thread name from first task
  stageName: string // Stage name from first task
  batchName: string // Batch name from first task
  stageNum: number // Stage number
  batchNum: number // Batch number
  firstTaskId: string // ID of first task in thread (for session tracking)
  assignedAgent?: string // Agent assignment from first task
  taskCount: number // Number of tasks in this thread
}

/**
 * Discover threads in a batch from tasks.json
 * Groups tasks by thread ID pattern (SS.BB.TT.*) and extracts metadata from first task
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param stageNum - Stage number to filter (1-99)
 * @param batchNum - Batch number to filter (1-99)
 * @returns Array of discovered threads sorted by thread number, or null if tasks file not found
 */
export function discoverThreadsInBatch(
  repoRoot: string,
  streamId: string,
  stageNum: number,
  batchNum: number,
): DiscoveredThread[] | null {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return null

  // Build the batch prefix for filtering
  const stageStr = stageNum.toString().padStart(2, "0")
  const batchStr = batchNum.toString().padStart(2, "0")
  const batchPrefix = `${stageStr}.${batchStr}.`

  // Group tasks by thread ID (SS.BB.TT)
  const threadMap = new Map<string, Task[]>()

  for (const task of tasksFile.tasks) {
    if (!task.id.startsWith(batchPrefix)) continue

    try {
      const parsed = parseTaskId(task.id)
      const threadId = formatThreadId(parsed.stage, parsed.batch, parsed.thread)

      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, [])
      }
      threadMap.get(threadId)!.push(task)
    } catch {
      // Skip invalid task IDs
    }
  }

  // Convert to DiscoveredThread array
  const threads: DiscoveredThread[] = []

  for (const [threadId, tasks] of threadMap) {
    // Sort tasks by ID to get first task
    tasks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    const firstTask = tasks[0]!

    const parsed = parseTaskId(firstTask.id)

    threads.push({
      threadId,
      threadNum: parsed.thread,
      threadName: firstTask.thread_name,
      stageName: firstTask.stage_name,
      batchName: firstTask.batch_name,
      stageNum: parsed.stage,
      batchNum: parsed.batch,
      firstTaskId: firstTask.id,
      assignedAgent: firstTask.assigned_agent,
      taskCount: tasks.length,
    })
  }

  // Sort by thread number
  threads.sort((a, b) => a.threadNum - b.threadNum)

  return threads
}

/**
 * Get batch metadata from tasks.json
 * Returns stage and batch names derived from tasks in the batch
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID  
 * @param stageNum - Stage number
 * @param batchNum - Batch number
 * @returns Object with stageName and batchName, or null if no tasks found
 */
export function getBatchMetadata(
  repoRoot: string,
  streamId: string,
  stageNum: number,
  batchNum: number,
): { stageName: string; batchName: string } | null {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return null

  const stageStr = stageNum.toString().padStart(2, "0")
  const batchStr = batchNum.toString().padStart(2, "0")
  const batchPrefix = `${stageStr}.${batchStr}.`

  // Find first task in batch
  const firstTask = tasksFile.tasks.find((t) => t.id.startsWith(batchPrefix))
  if (!firstTask) return null

  return {
    stageName: firstTask.stage_name,
    batchName: firstTask.batch_name,
  }
}


/**
 * @deprecated GitHub metadata is now stored in github.json per-stage, not in tasks.json.
 * This function is a no-op kept for backward compatibility.
 */
export function setTaskGitHubMeta(
  _repoRoot: string,
  _streamId: string,
  _taskId: string,
  _meta: { number: number; url: string; state: "open" | "closed" },
): Task | null {
  // No-op: GitHub metadata is now stored in github.json per-stage
  return null
}

/**
 * Parse a task ID into components
 */
export function parseTaskId(taskId: string): {
  stage: number
  batch: number
  thread: number
  task: number
} {
  const parts = taskId.split(".")
  if (parts.length === 4) {
    const parsed = parts.map((p) => parseInt(p, 10))
    if (parsed.every((n) => !isNaN(n))) {
      return {
        stage: parsed[0]!,
        batch: parsed[1]!,
        thread: parsed[2]!,
        task: parsed[3]!,
      }
    }
  }

  throw new Error(
    `Invalid task ID format: ${taskId}. Expected "stage.batch.thread.task" (e.g., "01.01.02.03")`,
  )
}

/**
 * Format task ID from components
 * All components are zero-padded to 2 digits for consistent sorting
 */
export function formatTaskId(
  stage: number,
  batch: number,
  thread: number,
  task: number,
): string {
  const stageStr = stage.toString().padStart(2, "0")
  const batchStr = batch.toString().padStart(2, "0")
  const threadStr = thread.toString().padStart(2, "0")
  const taskStr = task.toString().padStart(2, "0")
  return `${stageStr}.${batchStr}.${threadStr}.${taskStr}`
}

/**
 * Parse a thread ID into components
 * Thread ID format: "stage.batch.thread" (e.g., "01.01.02")
 */
export function parseThreadId(threadId: string): {
  stage: number
  batch: number
  thread: number
} {
  const parts = threadId.split(".")
  if (parts.length === 3) {
    const parsed = parts.map((p) => parseInt(p, 10))
    if (parsed.every((n) => !isNaN(n))) {
      return {
        stage: parsed[0]!,
        batch: parsed[1]!,
        thread: parsed[2]!,
      }
    }
  }

  throw new Error(
    `Invalid thread ID format: ${threadId}. Expected "stage.batch.thread" (e.g., "01.01.02")`,
  )
}

/**
 * Format thread ID from components
 * All components are zero-padded to 2 digits for consistent sorting
 */
export function formatThreadId(
  stage: number,
  batch: number,
  thread: number,
): string {
  const stageStr = stage.toString().padStart(2, "0")
  const batchStr = batch.toString().padStart(2, "0")
  const threadStr = thread.toString().padStart(2, "0")
  return `${stageStr}.${batchStr}.${threadStr}`
}

/**
 * Get all tasks in a thread
 */
export function getTasksByThread(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
  batchNumber: number,
  threadNumber: number,
): Task[] {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return []

  const stageStr = stageNumber.toString().padStart(2, "0")
  const batchStr = batchNumber.toString().padStart(2, "0")
  const threadStr = threadNumber.toString().padStart(2, "0")
  const threadPrefix = `${stageStr}.${batchStr}.${threadStr}.`

  return tasksFile.tasks.filter((t) => t.id.startsWith(threadPrefix))
}

/**
 * Update all tasks in a thread
 * Returns the updated tasks
 */
export function updateTasksByThread(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
  batchNumber: number,
  threadNumber: number,
  options: TaskUpdateOptions,
): Task[] {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return []

  const stageStr = stageNumber.toString().padStart(2, "0")
  const batchStr = batchNumber.toString().padStart(2, "0")
  const threadStr = threadNumber.toString().padStart(2, "0")
  const threadPrefix = `${stageStr}.${batchStr}.${threadStr}.`

  const updatedTasks: Task[] = []
  const now = new Date().toISOString()

  for (const task of tasksFile.tasks) {
    if (task.id.startsWith(threadPrefix)) {
      if (options.status) task.status = options.status
      if (options.breadcrumb) task.breadcrumb = options.breadcrumb
      if (options.report) task.report = options.report
      if (options.assigned_agent) task.assigned_agent = options.assigned_agent
      task.updated_at = now
      updatedTasks.push(task)
    }
  }

  if (updatedTasks.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile)
  }

  return updatedTasks
}

/**
 * Delete a single task by ID
 * Returns the deleted task, or null if not found
 */
export function deleteTask(
  repoRoot: string,
  streamId: string,
  taskId: string,
): Task | null {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return null

  const taskIndex = tasksFile.tasks.findIndex((t) => t.id === taskId)
  if (taskIndex === -1) return null

  const [deletedTask] = tasksFile.tasks.splice(taskIndex, 1)
  writeTasksFile(repoRoot, streamId, tasksFile)
  return deletedTask!
}

/**
 * Delete all tasks in a stage
 * Returns the deleted tasks
 */
export function deleteTasksByStage(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
): Task[] {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return []

  const stagePrefix = `${stageNumber.toString().padStart(2, "0")}.`
  const deletedTasks: Task[] = []

  tasksFile.tasks = tasksFile.tasks.filter((t) => {
    if (t.id.startsWith(stagePrefix)) {
      deletedTasks.push(t)
      return false
    }
    return true
  })

  if (deletedTasks.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile)
  }

  return deletedTasks
}

/**
 * Delete all tasks in a thread
 * Returns the deleted tasks
 */
export function deleteTasksByThread(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
  batchNumber: number,
  threadNumber: number,
): Task[] {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return []

  const batchStr = batchNumber.toString().padStart(2, "0")
  const stageStr = stageNumber.toString().padStart(2, "0")
  const threadPrefix = `${stageStr}.${batchStr}.${threadNumber}.`
  const deletedTasks: Task[] = []

  tasksFile.tasks = tasksFile.tasks.filter((t) => {
    if (t.id.startsWith(threadPrefix)) {
      deletedTasks.push(t)
      return false
    }
    return true
  })

  if (deletedTasks.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile)
  }

  return deletedTasks
}

/**
 * Delete all tasks in a batch
 * Returns the deleted tasks
 */
export function deleteTasksByBatch(
  repoRoot: string,
  streamId: string,
  stageNumber: number,
  batchNumber: number,
): Task[] {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) return []

  const batchStr = batchNumber.toString().padStart(2, "0")
  const stageStr = stageNumber.toString().padStart(2, "0")
  const batchPrefix = `${stageStr}.${batchStr}.`
  const deletedTasks: Task[] = []

  tasksFile.tasks = tasksFile.tasks.filter((t) => {
    if (t.id.startsWith(batchPrefix)) {
      deletedTasks.push(t)
      return false
    }
    return true
  })

  if (deletedTasks.length > 0) {
    writeTasksFile(repoRoot, streamId, tasksFile)
  }

  return deletedTasks
}

/**
 * Group tasks by stage, batch, and thread (convenience wrapper)
 * Returns a nested structure: { stageName: { batchName: { threadName: Task[] } } }
 * 
 * @deprecated Use groupTasks(tasks, { byBatch: true }) or groupTasks(tasks) instead
 */
export function groupTasksByStageAndBatchAndThread(
  tasks: Task[],
): Map<string, Map<string, Map<string, Task[]>>> {
  return groupTasks(tasks, { byBatch: true })
}
