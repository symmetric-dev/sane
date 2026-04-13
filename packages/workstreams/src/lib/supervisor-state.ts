import { existsSync, mkdirSync, readFileSync } from "fs"
import { dirname, join } from "path"
import * as lockfile from "proper-lockfile"
import type {
  RootAgentCheckpointPointer,
  RootAgentBranchSession,
  SupervisorEscalationRecord,
  SupervisorFixCycle,
  SupervisorIssueSummary,
  SupervisorReviewedBatch,
  SupervisorRunState,
  SupervisorStageStop,
  SupervisorStateFile,
} from "./types.ts"
import { isTerminalBatchStatus, readBatchStatus } from "./batch-status.ts"
import { atomicWriteFile } from "./index.ts"
import { getWorkDir } from "./repo.ts"

export const SUPERVISOR_STATE_VERSION = "1.0.0"

/**
 * Get the path to supervisor-state.json for a workstream.
 */
export function getSupervisorStateFilePath(repoRoot: string, streamId: string): string {
  return join(getWorkDir(repoRoot), streamId, "supervisor-state.json")
}

/**
 * Create an empty supervisor-state.json structure.
 */
export function createEmptySupervisorState(streamId: string): SupervisorStateFile {
  return {
    version: SUPERVISOR_STATE_VERSION,
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
  }
}

/**
 * Read supervisor-state.json from a workstream directory.
 * Returns null if the file does not exist.
 *
 * This is an unlocked snapshot read. For mutations, prefer
 * modifySupervisorState() so the read/modify/write cycle stays atomic.
 */
export function loadSupervisorState(
  repoRoot: string,
  streamId: string,
): SupervisorStateFile | null {
  const filePath = getSupervisorStateFilePath(repoRoot, streamId)
  if (!existsSync(filePath)) {
    return null
  }

  const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<SupervisorStateFile>

  return {
    ...createEmptySupervisorState(streamId),
    ...parsed,
    runs: parsed.runs ?? [],
    checkpoint_pointers: parsed.checkpoint_pointers ?? [],
    branch_sessions: parsed.branch_sessions ?? [],
    reviewed_batches: parsed.reviewed_batches ?? [],
    issue_summaries: parsed.issue_summaries ?? [],
    fix_cycles: parsed.fix_cycles ?? [],
    escalations: parsed.escalations ?? [],
    stage_stops: parsed.stage_stops ?? [],
  }
}

/**
 * Write supervisor-state.json to a workstream directory.
 *
 * This is a low-level write helper. Callers that need to mutate existing
 * state should prefer modifySupervisorState() to avoid unsafe read-modify-write
 * behavior across separate operations.
 */
export function saveSupervisorState(
  repoRoot: string,
  streamId: string,
  supervisorState: SupervisorStateFile,
): void {
  const filePath = getSupervisorStateFilePath(repoRoot, streamId)
  mkdirSync(dirname(filePath), { recursive: true })

  const lastUpdated = new Date().toISOString()
  supervisorState.last_updated = lastUpdated

  const ordered: SupervisorStateFile = {
    version: supervisorState.version,
    stream_id: supervisorState.stream_id,
    last_updated: lastUpdated,
    ...(supervisorState.active_run_id
      ? { active_run_id: supervisorState.active_run_id }
      : {}),
    runs: supervisorState.runs,
    checkpoint_pointers: supervisorState.checkpoint_pointers,
    branch_sessions: supervisorState.branch_sessions,
    reviewed_batches: supervisorState.reviewed_batches,
    issue_summaries: supervisorState.issue_summaries,
    fix_cycles: supervisorState.fix_cycles,
    escalations: supervisorState.escalations,
    stage_stops: supervisorState.stage_stops,
  }

  atomicWriteFile(filePath, JSON.stringify(ordered, null, 2))
}

async function withSupervisorStateLock<T>(
  repoRoot: string,
  streamId: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  const filePath = getSupervisorStateFilePath(repoRoot, streamId)
  mkdirSync(dirname(filePath), { recursive: true })

  if (!existsSync(filePath)) {
    atomicWriteFile(filePath, JSON.stringify(createEmptySupervisorState(streamId), null, 2))
  }

  const release = await lockfile.lock(filePath, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
  })

  try {
    return await fn()
  } finally {
    await release()
  }
}

/**
 * Atomic read-modify-write operation on supervisor-state.json.
 */
export async function modifySupervisorState<T>(
  repoRoot: string,
  streamId: string,
  fn: (supervisorState: SupervisorStateFile) => T | Promise<T>,
): Promise<T> {
  return withSupervisorStateLock(repoRoot, streamId, async () => {
    const supervisorState =
      loadSupervisorState(repoRoot, streamId) ?? createEmptySupervisorState(streamId)

    const result = await fn(supervisorState)
    saveSupervisorState(repoRoot, streamId, supervisorState)
    return result
  })
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values))
}

function upsertItem<T>(items: T[], incoming: T, getKey: (value: T) => string): T {
  const key = getKey(incoming)
  const index = items.findIndex((value) => getKey(value) === key)

  if (index === -1) {
    items.push(incoming)
    return incoming
  }

  items[index] = incoming
  return items[index]!
}

function getRun(supervisorState: SupervisorStateFile, runId: string): SupervisorRunState | undefined {
  return supervisorState.runs.find((run) => run.runId === runId)
}

function getRunStatusForStageStop(stageStop: SupervisorStageStop): SupervisorRunState["status"] {
  if (stageStop.reason === "completed") {
    return "completed"
  }

  if (stageStop.reason === "failed") {
    return "failed"
  }

  return stageStop.escalationId ? "escalated" : "stopped"
}

function getRunStageStops(
  supervisorState: SupervisorStateFile,
  runId: string,
  batchId?: string,
): SupervisorStageStop[] {
  return supervisorState.stage_stops.filter(
    (stop) => stop.runId === runId && (batchId ? stop.batchId === batchId : true),
  )
}

/**
 * Upsert a supervisor run record and maintain the active run pointer.
 */
export async function upsertSupervisorRunLocked(
  repoRoot: string,
  streamId: string,
  run: SupervisorRunState,
): Promise<SupervisorRunState> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const existing = getRun(supervisorState, run.runId)
    const normalized: SupervisorRunState = {
      ...existing,
      ...run,
      reviewPasses: Math.max(existing?.reviewPasses ?? 0, run.reviewPasses),
      issueSummaryIds: uniqueStrings([
        ...(existing?.issueSummaryIds ?? []),
        ...run.issueSummaryIds,
      ]),
      escalationIds: uniqueStrings([
        ...(existing?.escalationIds ?? []),
        ...run.escalationIds,
      ]),
    }

    const stored = upsertItem(supervisorState.runs, normalized, (value) => value.runId)

    if (stored.status === "running") {
      supervisorState.active_run_id = stored.runId
    } else if (supervisorState.active_run_id === stored.runId) {
      delete supervisorState.active_run_id
    }

    return stored
  })
}

/**
 * Upsert a root-agent checkpoint pointer record.
 */
export async function upsertCheckpointPointerLocked(
  repoRoot: string,
  streamId: string,
  checkpointPointer: RootAgentCheckpointPointer,
): Promise<RootAgentCheckpointPointer> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const normalized: RootAgentCheckpointPointer = {
      ...checkpointPointer,
    }

    return upsertItem(
      supervisorState.checkpoint_pointers,
      normalized,
      (value) => value.rootSessionId,
    )
  })
}

/**
 * Upsert a root-agent branch session record.
 */
export async function upsertBranchSessionLocked(
  repoRoot: string,
  streamId: string,
  branchSession: RootAgentBranchSession,
): Promise<RootAgentBranchSession> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const existing = supervisorState.branch_sessions.find(
      (value) => value.branchSessionId === branchSession.branchSessionId,
    )

    const normalized: RootAgentBranchSession = {
      ...existing,
      ...branchSession,
      updatedAt: branchSession.updatedAt,
      completedAt: branchSession.completedAt ?? existing?.completedAt,
    }

    return upsertItem(
      supervisorState.branch_sessions,
      normalized,
      (value) => value.branchSessionId,
    )
  })
}

/**
 * Set or clear the currently active supervisor run.
 */
export async function setActiveSupervisorRunLocked(
  repoRoot: string,
  streamId: string,
  runId?: string,
): Promise<void> {
  await modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    if (!runId) {
      delete supervisorState.active_run_id
      return
    }

    const run = getRun(supervisorState, runId)
    if (!run) {
      throw new Error(`Supervisor run ${runId} not found in stream ${streamId}`)
    }

    supervisorState.active_run_id = runId
    run.status = "running"
  })
}

/**
 * Pause a supervisor run after batch execution reaches a deterministic handoff
 * point. This clears active ownership without implying review/fix/escalation
 * policy has been decided.
 */
export async function pauseSupervisorRunLocked(
  repoRoot: string,
  streamId: string,
  args: {
    runId: string
    updatedAt: string
    currentBatchId?: string
  },
): Promise<SupervisorRunState | undefined> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const run = getRun(supervisorState, args.runId)
    if (!run) {
      return undefined
    }

    run.status = "paused"
    run.updatedAt = args.updatedAt
    if (args.currentBatchId) {
      run.currentBatchId = args.currentBatchId
    }
    delete run.completedAt
    delete run.stageStopId
    delete run.stopReason

    if (supervisorState.active_run_id === run.runId) {
      delete supervisorState.active_run_id
    }

    return run
  })
}

/**
 * Reconcile interrupted supervisor runs whose persisted batch has already
 * reached a terminal state. These runs are no longer actively executing work,
 * so they become resumable and the stale active run pointer is cleared.
 */
export async function reconcileSupervisorRunsLocked(
  repoRoot: string,
  streamId: string,
): Promise<string[]> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const reconciledRunIds: string[] = []

    if (supervisorState.active_run_id) {
      const activeRun = getRun(supervisorState, supervisorState.active_run_id)
      if (!activeRun || activeRun.status !== "running") {
        delete supervisorState.active_run_id
      }
    }

    for (const run of supervisorState.runs) {
      if ((run.status !== "running" && run.status !== "failed") || !run.currentBatchId) {
        continue
      }

      const batchStatus = readBatchStatus(repoRoot, streamId, run.currentBatchId)
      if (!batchStatus || !isTerminalBatchStatus(batchStatus.status)) {
        continue
      }

      const staleFailedStops = getRunStageStops(
        supervisorState,
        run.runId,
        run.currentBatchId,
      ).filter((stop) => stop.reason === "failed")

      if (staleFailedStops.length > 0) {
        const staleStopIds = new Set(staleFailedStops.map((stop) => stop.stopId))
        supervisorState.stage_stops = supervisorState.stage_stops.filter(
          (stop) => !staleStopIds.has(stop.stopId),
        )

        if (run.stageStopId && staleStopIds.has(run.stageStopId)) {
          delete run.stageStopId
          delete run.stopReason
          delete run.completedAt
        }
      }

      run.status = "paused"
      run.updatedAt = batchStatus.completedAt ?? batchStatus.updatedAt
      if (supervisorState.active_run_id === run.runId) {
        delete supervisorState.active_run_id
      }

      reconciledRunIds.push(run.runId)
    }

    return reconciledRunIds
  })
}

/**
 * Remove stale failed stop artifacts from an interrupted run so it can resume
 * deterministic review/finalization from the persisted batch state.
 */
export async function clearSupervisorRunFailureStopLocked(
  repoRoot: string,
  streamId: string,
  runId: string,
  batchId?: string,
): Promise<string[]> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const run = getRun(supervisorState, runId)
    if (!run) {
      return []
    }

    const failedStops = getRunStageStops(supervisorState, runId, batchId).filter(
      (stop) => stop.reason === "failed",
    )
    if (failedStops.length === 0) {
      return []
    }

    const failedStopIds = new Set(failedStops.map((stop) => stop.stopId))
    supervisorState.stage_stops = supervisorState.stage_stops.filter(
      (stop) => !failedStopIds.has(stop.stopId),
    )

    if (run.stageStopId && failedStopIds.has(run.stageStopId)) {
      delete run.stageStopId
      delete run.stopReason
      delete run.completedAt
    }

    if (run.status === "failed") {
      run.status = "paused"
      run.updatedAt = new Date().toISOString()
    }

    return failedStops.map((stop) => stop.stopId)
  })
}

/**
 * Upsert a reviewed batch record and update the run's last reviewed batch metadata.
 */
export async function upsertReviewedBatchLocked(
  repoRoot: string,
  streamId: string,
  reviewedBatch: SupervisorReviewedBatch,
): Promise<SupervisorReviewedBatch> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const existing = supervisorState.reviewed_batches.find(
      (value) => value.reviewId === reviewedBatch.reviewId,
    )
    const normalized: SupervisorReviewedBatch = {
      ...existing,
      ...reviewedBatch,
      threadIds: uniqueStrings([
        ...(existing?.threadIds ?? []),
        ...reviewedBatch.threadIds,
      ]),
      issueSummaryIds: uniqueStrings([
        ...(existing?.issueSummaryIds ?? []),
        ...reviewedBatch.issueSummaryIds,
      ]),
    }

    const stored = upsertItem(
      supervisorState.reviewed_batches,
      normalized,
      (value) => value.reviewId,
    )

    const run = getRun(supervisorState, stored.runId)
    if (run) {
      run.lastReviewedBatchId = stored.batchId
      run.reviewPasses = Math.max(run.reviewPasses, stored.reviewPass)
      run.updatedAt = stored.reviewedAt
    }

    return stored
  })
}

/**
 * Upsert an issue summary and link it back to the owning supervisor run.
 */
export async function upsertIssueSummaryLocked(
  repoRoot: string,
  streamId: string,
  issueSummary: SupervisorIssueSummary,
): Promise<SupervisorIssueSummary> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const existing = supervisorState.issue_summaries.find(
      (value) => value.summaryId === issueSummary.summaryId,
    )
    const normalized: SupervisorIssueSummary = {
      ...existing,
      ...issueSummary,
      firstObservedAt: existing?.firstObservedAt ?? issueSummary.firstObservedAt,
    }

    const stored = upsertItem(
      supervisorState.issue_summaries,
      normalized,
      (value) => value.summaryId,
    )

    const run = getRun(supervisorState, stored.runId)
    if (run) {
      run.issueSummaryIds = uniqueStrings([...run.issueSummaryIds, stored.summaryId])
      run.updatedAt = stored.lastObservedAt
    }

    return stored
  })
}

/**
 * Upsert a fix-cycle record for a specific thread review loop.
 */
export async function upsertFixCycleLocked(
  repoRoot: string,
  streamId: string,
  fixCycle: SupervisorFixCycle,
): Promise<SupervisorFixCycle> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const existing = supervisorState.fix_cycles.find(
      (value) => value.cycleId === fixCycle.cycleId,
    )
    const normalized: SupervisorFixCycle = {
      ...existing,
      ...fixCycle,
      attemptCount: Math.max(existing?.attemptCount ?? 0, fixCycle.attemptCount),
      issueSummaryIds: uniqueStrings([
        ...(existing?.issueSummaryIds ?? []),
        ...fixCycle.issueSummaryIds,
      ]),
    }

    return upsertItem(supervisorState.fix_cycles, normalized, (value) => value.cycleId)
  })
}

/**
 * Upsert an escalation record and link it to the owning supervisor run.
 */
export async function upsertEscalationOutcomeLocked(
  repoRoot: string,
  streamId: string,
  escalation: SupervisorEscalationRecord,
): Promise<SupervisorEscalationRecord> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const existing = supervisorState.escalations.find(
      (value) => value.escalationId === escalation.escalationId,
    )
    const normalized: SupervisorEscalationRecord = {
      ...existing,
      ...escalation,
    }

    const stored = upsertItem(
      supervisorState.escalations,
      normalized,
      (value) => value.escalationId,
    )

    const run = getRun(supervisorState, stored.runId)
    if (run) {
      run.escalationIds = uniqueStrings([...run.escalationIds, stored.escalationId])
      run.updatedAt = stored.resolvedAt ?? stored.escalatedAt
    }

    return stored
  })
}

/**
 * Record why a stage stopped and close out the active run pointer when needed.
 */
export async function recordStageStopLocked(
  repoRoot: string,
  streamId: string,
  stageStop: SupervisorStageStop,
): Promise<SupervisorStageStop> {
  return modifySupervisorState(repoRoot, streamId, (supervisorState) => {
    const stored = upsertItem(
      supervisorState.stage_stops,
      stageStop,
      (value) => value.stopId,
    )

    const run = getRun(supervisorState, stored.runId)
    if (run) {
      run.stageStopId = stored.stopId
      run.stopReason = stored.reason
      run.status = getRunStatusForStageStop(stored)
      run.updatedAt = stored.stoppedAt
      run.completedAt = stored.stoppedAt
    }

    if (supervisorState.active_run_id === stored.runId) {
      delete supervisorState.active_run_id
    }

    return stored
  })
}
