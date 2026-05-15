import { spawn } from "child_process"
import { existsSync, readFileSync } from "fs"
import { fileURLToPath } from "url"
import { getBatchThreadMetadata } from "./thread-execution.ts"
import {
  cleanupCompletionMarkers,
  cleanupResultFiles,
  cleanupSessionFiles,
} from "./marker-polling.ts"
import {
  createBatchStatusFile,
  initializeBatchStatusRunLocked,
  type BatchStatusFile,
  type BatchStatusThread,
  type BatchThreadRunStatus,
  getBatchStatusFilePath,
  isTerminalBatchStatus,
  readBatchStatus,
  summarizeBatchThreads,
  writeBatchStatusLocked,
} from "./batch-status.ts"
import { parseBatchId } from "./cli-utils.ts"
import { queryThreadByIdForWorkstream, queryThreadsForWorkstream } from "./hierarchy-query.ts"
import {
  getCompletionMarkerPath,
  getRunResultPath,
} from "./opencode.ts"
import {
  getLastSessionForThread,
  getThreadMetadata,
} from "./threads.ts"
import { applyFinalizationCompletions, type FinalizationCompletion } from "./multi-finalization.ts"
import { sessionExists } from "./tmux.ts"

interface BatchThreadSeed {
  threadId: string
  threadName: string
}

export interface SyncBatchStatusOptions {
  repoRoot: string
  streamId: string
  batchId: string
}

export interface WaitForBatchStatusOptions extends SyncBatchStatusOptions {
  pollIntervalMs?: number
  timeoutMs?: number
}

export interface DetachedBatchMonitorOptions extends WaitForBatchStatusOptions {}

function formatBatchStatusSummary(status: BatchStatusFile): string {
  return `${status.summary.completed}/${status.summary.total} completed, ${status.summary.failed} failed, ${status.summary.running} running, ${status.summary.pending} pending`
}

function createBatchStatusTimeoutError(status: BatchStatusFile, timeoutMs: number): Error {
  return new Error(
    `Timed out after ${timeoutMs}ms waiting for batch ${status.batchId} to reach a terminal state (last status: ${status.status}; ${formatBatchStatusSummary(status)})`,
  )
}

function getBatchThreadSeeds(
  repoRoot: string,
  streamId: string,
  batchId: string,
): BatchThreadSeed[] {
  return queryThreadsForWorkstream(repoRoot, streamId)
    .filter((thread) => thread.batchId === batchId)
    .map((thread) => ({
      threadId: thread.threadId,
      threadName: thread.threadName,
    }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId))
}

function finalizeCompletedThreadArtifacts(markerDetectedAt: string): Partial<BatchStatusThread> {
  return {
    markerDetectedAt,
    completedAt: markerDetectedAt,
  }
}

function shouldRefreshCompletedThreadArtifacts(args: {
  markerExists: boolean
  markerDetectedAt?: string
}): boolean {
  if (!args.markerExists) {
    return false
  }

  if (!args.markerDetectedAt) {
    return true
  }

  return false
}

interface StoredRunResult {
  status: "completed" | "failed"
  exitCode?: number
}

type RecoverySessionStatus = "completed" | "failed" | "interrupted"

interface GhostBatchThreadRecovery {
  threadId: string
  status: Exclude<BatchThreadRunStatus, "pending" | "running">
  completedAt: string
  markerDetectedAt?: string
  recoveryNote: string
}

const CANONICAL_RUN_START_TOLERANCE_MS = 60_000

function readStoredRunResult(streamId: string, threadId: string): StoredRunResult | null {
  const resultPath = getRunResultPath(streamId, threadId)
  if (!existsSync(resultPath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf-8")) as StoredRunResult
    if (parsed.status === "completed" || parsed.status === "failed") {
      return parsed
    }
  } catch {
    // Ignore malformed result files and fall back to other signals.
  }

  return null
}

function areThreadTasksCanonicallyCompleted(repoRoot: string, streamId: string, threadId: string): boolean {
  const thread = queryThreadByIdForWorkstream(repoRoot, streamId, threadId)
  return thread?.aggregateStatus === "completed"
}

function startedAtOrAfterRunStart(startedAt: string | undefined, runStartedAt: string | undefined): boolean {
  if (!startedAt || !runStartedAt) {
    return true
  }

  return (
    new Date(startedAt).getTime() >=
    new Date(runStartedAt).getTime() - CANONICAL_RUN_START_TOLERANCE_MS
  )
}

function shouldFinalizeThreadFromCanonicalState(args: {
  repoRoot: string
  streamId: string
  threadId: string
  markerExists: boolean
  storedResult?: StoredRunResult | null
  workSessionStillExists: boolean
  latestSessionStatus?: string
  latestSessionStartedAt?: string
  currentSessionId?: string
  runStartedAt?: string
}): boolean {
  if (args.markerExists || args.storedResult) {
    return false
  }

  if (args.workSessionStillExists) {
    return false
  }

  if (args.latestSessionStatus !== "running" && !args.currentSessionId) {
    return false
  }

  if (
    !startedAtOrAfterRunStart(args.latestSessionStartedAt, args.runStartedAt)
  ) {
    return false
  }

  return areThreadTasksCanonicallyCompleted(args.repoRoot, args.streamId, args.threadId)
}

function deriveThreadStatus(args: {
  markerExists: boolean
  storedResult?: StoredRunResult | null
  latestSessionStatus?: string
  currentSessionId?: string
}): BatchThreadRunStatus {
  if (args.storedResult?.status === "completed") return "completed"
  if (args.storedResult?.status === "failed") return "failed"

  if (args.markerExists || args.latestSessionStatus === "completed") {
    return "completed"
  }

  if (args.latestSessionStatus === "failed" || args.latestSessionStatus === "interrupted") {
    return "failed"
  }

  if (args.latestSessionStatus === "running" || args.currentSessionId) {
    return "running"
  }

  return "pending"
}

function getTrackedThreadSessionId(args: {
  previous?: BatchStatusThread
  latestSessionId?: string
  latestSessionStatus?: string
  currentSessionId?: string
}): string | undefined {
  return (
    args.currentSessionId ??
    (args.latestSessionStatus === "running" ? args.latestSessionId : undefined) ??
    args.previous?.currentSessionId
  )
}

function formatGhostRecoveryNote(args: {
  tmuxSessionName?: string
  source: "completion marker" | "stored result" | "canonical task state" | "missing tmux session"
  status: GhostBatchThreadRecovery["status"]
  exitCode?: number
}): string {
  const tmuxLabel = args.tmuxSessionName
    ? `tmux session \"${args.tmuxSessionName}\"`
    : "the recorded tmux session"
  const suffix =
    typeof args.exitCode === "number" ? ` (exit ${args.exitCode})` : ""
  return `${args.status}: recovered after ${tmuxLabel} disappeared using ${args.source}${suffix}.`
}

async function reconcileGhostBatchRun(args: {
  repoRoot: string
  streamId: string
  batchId: string
  existing: BatchStatusFile
  threadSeeds: BatchThreadSeed[]
}): Promise<BatchStatusFile> {
  const now = new Date().toISOString()
  const previousThreads = new Map(
    args.existing.threads.map((thread) => [thread.threadId, thread]),
  )
  const completions: FinalizationCompletion[] = []
  const recoveries = new Map<string, GhostBatchThreadRecovery>()

  for (const seed of args.threadSeeds) {
    const previous = previousThreads.get(seed.threadId)
    const threadMeta = getThreadMetadata(args.repoRoot, args.streamId, seed.threadId)
    const latestSession = getLastSessionForThread(args.repoRoot, args.streamId, seed.threadId)
    const markerExists = existsSync(getCompletionMarkerPath(args.streamId, seed.threadId))
    const storedResult = readStoredRunResult(args.streamId, seed.threadId)
    const sessionId = getTrackedThreadSessionId({
      previous,
      latestSessionId: latestSession?.sessionId,
      latestSessionStatus: latestSession?.status,
      currentSessionId: threadMeta?.currentSessionId,
    })
    const canonicalCompletion = shouldFinalizeThreadFromCanonicalState({
      repoRoot: args.repoRoot,
      streamId: args.streamId,
      threadId: seed.threadId,
      markerExists,
      storedResult,
      workSessionStillExists: false,
      latestSessionStatus: latestSession?.status,
      latestSessionStartedAt: latestSession?.startedAt ?? previous?.startedAt,
      currentSessionId: threadMeta?.currentSessionId ?? previous?.currentSessionId,
      runStartedAt: args.existing.startedAt,
    })

    let status: GhostBatchThreadRecovery["status"]
    let completionStatus: RecoverySessionStatus | undefined
    let recoveryNote: string
    let markerDetectedAt = previous?.markerDetectedAt
    let exitCode: number | undefined

    if (storedResult?.status === "completed") {
      status = "completed"
      completionStatus = "completed"
      exitCode = storedResult.exitCode
      recoveryNote = formatGhostRecoveryNote({
        tmuxSessionName: args.existing.tmuxSessionName,
        source: "stored result",
        status,
        exitCode,
      })
    } else if (storedResult?.status === "failed") {
      status = "failed"
      completionStatus = "failed"
      exitCode = storedResult.exitCode
      recoveryNote = formatGhostRecoveryNote({
        tmuxSessionName: args.existing.tmuxSessionName,
        source: "stored result",
        status,
        exitCode,
      })
    } else if (markerExists) {
      status = "completed"
      completionStatus = "completed"
      markerDetectedAt = markerDetectedAt ?? now
      recoveryNote = formatGhostRecoveryNote({
        tmuxSessionName: args.existing.tmuxSessionName,
        source: "completion marker",
        status,
      })
    } else if (canonicalCompletion) {
      status = "completed"
      completionStatus = "completed"
      recoveryNote = formatGhostRecoveryNote({
        tmuxSessionName: args.existing.tmuxSessionName,
        source: "canonical task state",
        status,
      })
    } else {
      status = "failed"
      completionStatus = sessionId ? "interrupted" : undefined
      recoveryNote = formatGhostRecoveryNote({
        tmuxSessionName: args.existing.tmuxSessionName,
        source: "missing tmux session",
        status,
      })
    }

    if (sessionId && completionStatus) {
      completions.push({
        threadId: seed.threadId,
        sessionId,
        status: completionStatus,
        exitCode,
      })
    }

    recoveries.set(seed.threadId, {
      threadId: seed.threadId,
      status,
      completedAt: now,
      markerDetectedAt,
      recoveryNote,
    })
  }

  if (completions.length > 0) {
    await applyFinalizationCompletions({
      repoRoot: args.repoRoot,
      streamId: args.streamId,
      completions,
      verbose: false,
    })
  }

  const nextThreads: BatchStatusThread[] = args.threadSeeds.map((seed) => {
    const previous = previousThreads.get(seed.threadId)
    const recovery = recoveries.get(seed.threadId)
    const threadMeta = getThreadMetadata(args.repoRoot, args.streamId, seed.threadId)
    const latestSession = getLastSessionForThread(args.repoRoot, args.streamId, seed.threadId)

    return {
      threadId: seed.threadId,
      threadName: seed.threadName,
      status: recovery?.status ?? "failed",
      startedAt: latestSession?.startedAt ?? previous?.startedAt ?? args.existing.startedAt,
      updatedAt: now,
      completedAt: recovery?.completedAt ?? latestSession?.completedAt ?? previous?.completedAt ?? now,
      ...(recovery?.markerDetectedAt
        ? { markerDetectedAt: recovery.markerDetectedAt }
        : previous?.markerDetectedAt
          ? { markerDetectedAt: previous.markerDetectedAt }
          : {}),
      opencodeSessionId: threadMeta?.opencodeSessionId ?? previous?.opencodeSessionId,
      ...(recovery?.recoveryNote
        ? { recoveryNote: recovery.recoveryNote }
        : previous?.recoveryNote
          ? { recoveryNote: previous.recoveryNote }
          : {}),
    }
  })

  const batchStatus: BatchStatusFile = {
    ...args.existing,
    updatedAt: now,
    completedAt: now,
    status: deriveBatchStatus(nextThreads),
    summary: summarizeBatchThreads(nextThreads),
    threads: nextThreads,
  }

  await writeBatchStatusLocked(args.repoRoot, args.streamId, batchStatus)
  cleanupCompletionMarkers(
    args.streamId,
    args.threadSeeds.map((thread) => thread.threadId),
  )
  cleanupResultFiles(
    args.streamId,
    args.threadSeeds.map((thread) => thread.threadId),
  )
  cleanupSessionFiles(
    args.streamId,
    args.threadSeeds.map((thread) => thread.threadId),
  )
  return batchStatus
}

async function reconcileTerminalFailedBatchFromCanonicalState(args: {
  repoRoot: string
  streamId: string
  existing: BatchStatusFile
  threadSeeds: BatchThreadSeed[]
}): Promise<BatchStatusFile> {
  if (args.existing.status !== "failed") {
    return args.existing
  }

  const allThreadsCanonicallyCompleted = args.threadSeeds.every((seed) =>
    areThreadTasksCanonicallyCompleted(args.repoRoot, args.streamId, seed.threadId),
  )
  if (!allThreadsCanonicallyCompleted) {
    return args.existing
  }

  const now = new Date().toISOString()
  const previousThreads = new Map(
    args.existing.threads.map((thread) => [thread.threadId, thread]),
  )
  const nextThreads: BatchStatusThread[] = args.threadSeeds.map((seed) => {
    const previous = previousThreads.get(seed.threadId)
    const latestSession = getLastSessionForThread(args.repoRoot, args.streamId, seed.threadId)
    const threadMeta = getThreadMetadata(args.repoRoot, args.streamId, seed.threadId)
    const recoveredFromFailure = previous?.status === "failed"

    return {
      threadId: seed.threadId,
      threadName: seed.threadName,
      status: "completed",
      startedAt: latestSession?.startedAt ?? previous?.startedAt ?? args.existing.startedAt,
      updatedAt: now,
      completedAt: latestSession?.completedAt ?? previous?.completedAt ?? now,
      ...(previous?.markerDetectedAt ? { markerDetectedAt: previous.markerDetectedAt } : {}),
      opencodeSessionId: threadMeta?.opencodeSessionId ?? previous?.opencodeSessionId,
      ...(recoveredFromFailure
        ? {
            recoveryNote:
              "completed: restored from canonical execution state after terminal runtime failure; all thread items are completed.",
          }
        : previous?.recoveryNote
          ? { recoveryNote: previous.recoveryNote }
          : {}),
    }
  })

  const batchStatus: BatchStatusFile = {
    ...args.existing,
    status: "completed",
    updatedAt: now,
    completedAt: args.existing.completedAt ?? now,
    summary: summarizeBatchThreads(nextThreads),
    threads: nextThreads,
  }

  await writeBatchStatusLocked(args.repoRoot, args.streamId, batchStatus)
  return batchStatus
}

export async function reconcileBatchStatusRunIfNeeded(
  options: SyncBatchStatusOptions,
): Promise<BatchStatusFile | null> {
  const existing = readBatchStatus(options.repoRoot, options.streamId, options.batchId)
  if (!existing || isTerminalBatchStatus(existing.status)) {
    return existing
  }

  if (existing.status !== "running" || !existing.tmuxSessionName) {
    return existing
  }

  if (sessionExists(existing.tmuxSessionName)) {
    return existing
  }

  const threadSeeds = getBatchThreadSeeds(
    options.repoRoot,
    options.streamId,
    options.batchId,
  )

  return reconcileGhostBatchRun({
    repoRoot: options.repoRoot,
    streamId: options.streamId,
    batchId: options.batchId,
    existing,
    threadSeeds,
  })
}

export async function prepareHeadlessBatchStatusRun(options: {
  repoRoot: string
  streamId: string
  batchId: string
  tmuxSessionName?: string
  stageName?: string
  batchName?: string
  threads: BatchThreadSeed[]
}): Promise<BatchStatusFile> {
  const existing = readBatchStatus(options.repoRoot, options.streamId, options.batchId)
  if (
    existing &&
    !isTerminalBatchStatus(existing.status) &&
    existing.status === "running" &&
    existing.tmuxSessionName
  ) {
    if (sessionExists(existing.tmuxSessionName)) {
      throw new Error(
        `Batch ${options.batchId} already has an active headless run in tmux session \"${existing.tmuxSessionName}\".`,
      )
    }

    await reconcileBatchStatusRunIfNeeded({
      repoRoot: options.repoRoot,
      streamId: options.streamId,
      batchId: options.batchId,
    })
  }

  return resetBatchStatusRun(options)
}

async function finalizeCanonicalThreadState(
  repoRoot: string,
  streamId: string,
  threadSeeds: BatchThreadSeed[],
  workTmuxSessionName?: string,
  runStartedAt?: string,
): Promise<void> {
  const completions: FinalizationCompletion[] = []
  const workSessionStillExists = workTmuxSessionName
    ? sessionExists(workTmuxSessionName)
    : false

  for (const seed of threadSeeds) {
    const markerExists = existsSync(getCompletionMarkerPath(streamId, seed.threadId))
    const storedResult = readStoredRunResult(streamId, seed.threadId)

    const threadMeta = getThreadMetadata(repoRoot, streamId, seed.threadId)
    const latestSession = getLastSessionForThread(repoRoot, streamId, seed.threadId)
    const sessionId =
      threadMeta?.currentSessionId ??
      (latestSession?.status === "running" ? latestSession.sessionId : undefined)

    const finalizeFromCanonicalState = shouldFinalizeThreadFromCanonicalState({
      repoRoot,
      streamId,
      threadId: seed.threadId,
      markerExists,
      storedResult,
      workSessionStillExists,
      latestSessionStatus: latestSession?.status,
      latestSessionStartedAt: latestSession?.startedAt,
      currentSessionId: threadMeta?.currentSessionId,
      runStartedAt,
    })

    if (!markerExists && !storedResult && !finalizeFromCanonicalState) {
      continue
    }

    if (!sessionId) {
      continue
    }

    completions.push({
      threadId: seed.threadId,
      sessionId,
      status: storedResult?.status ?? "completed",
      exitCode: storedResult?.exitCode,
    })
  }

  if (completions.length > 0) {
    await applyFinalizationCompletions({
      repoRoot,
      streamId,
      completions,
      verbose: false,
    })
  }
}

export async function resetBatchStatusRun(options: {
  repoRoot: string
  streamId: string
  batchId: string
  tmuxSessionName?: string
  stageName?: string
  batchName?: string
  threads: BatchThreadSeed[]
}): Promise<BatchStatusFile> {
  const threadIds = options.threads.map((thread) => thread.threadId)
  cleanupCompletionMarkers(options.streamId, threadIds)
  cleanupResultFiles(options.streamId, threadIds)
  cleanupSessionFiles(options.streamId, threadIds)

  return initializeBatchStatusRunLocked({
    repoRoot: options.repoRoot,
    streamId: options.streamId,
    batchId: options.batchId,
    tmuxSessionName: options.tmuxSessionName,
    stageName: options.stageName,
    batchName: options.batchName,
    threads: options.threads,
  })
}

export function startDetachedBatchMonitor(
  options: DetachedBatchMonitorOptions,
): void {
  const workCliPath = fileURLToPath(new URL("../../bin/work.ts", import.meta.url))
  const args = [
    workCliPath,
    "batch-status",
    "--repo-root",
    options.repoRoot,
    "--stream",
    options.streamId,
    "--batch",
    options.batchId,
    "--wait",
    "--format",
    "json",
  ]

  if (options.pollIntervalMs !== undefined) {
    args.push("--poll-interval-ms", String(options.pollIntervalMs))
  }
  if (options.timeoutMs !== undefined) {
    args.push("--timeout-ms", String(options.timeoutMs))
  }

  const child = spawn(process.execPath, args, {
    cwd: options.repoRoot,
    detached: true,
    stdio: "ignore",
  })
  child.unref()
}

function deriveBatchStatus(threads: BatchStatusThread[]): BatchStatusFile["status"] {
  if (threads.length === 0) return "pending"
  if (threads.some((thread) => thread.status === "running")) return "running"
  if (threads.every((thread) => thread.status === "completed")) return "completed"

  const allTerminal = threads.every(
    (thread) => thread.status === "completed" || thread.status === "failed",
  )
  if (allTerminal) return "failed"

  if (threads.some((thread) => thread.status !== "pending")) return "running"
  return "pending"
}

export async function syncBatchStatus(
  options: SyncBatchStatusOptions,
): Promise<BatchStatusFile> {
  const { repoRoot, streamId, batchId } = options
  const batchParsed = parseBatchId(batchId)
  if (!batchParsed) {
    throw new Error(
      `Invalid batch ID "${batchId}". Expected format: "SS.BB" (e.g., "01.01")`,
    )
  }

  const threadSeeds = getBatchThreadSeeds(repoRoot, streamId, batchId)
  if (threadSeeds.length === 0) {
    throw new Error(`No tasks found for batch ${batchId} in stream ${streamId}`)
  }

  const batchMeta = getBatchThreadMetadata(
    repoRoot,
    streamId,
    batchParsed.stage,
    batchParsed.batch,
  )

  const reconciledExisting = await reconcileBatchStatusRunIfNeeded({
    repoRoot,
    streamId,
    batchId,
  })
  const existing = reconciledExisting ?? readBatchStatus(repoRoot, streamId, batchId)
  if (existing && isTerminalBatchStatus(existing.status)) {
    return reconcileTerminalFailedBatchFromCanonicalState({
      repoRoot,
      streamId,
      existing,
      threadSeeds,
    })
  }
  const now = new Date().toISOString()
  await finalizeCanonicalThreadState(
    repoRoot,
    streamId,
    threadSeeds,
    existing?.tmuxSessionName,
    existing?.startedAt,
  )
  const existingThreads = new Map(
    (existing?.threads ?? []).map((thread) => [thread.threadId, thread]),
  )

  const batchStatus =
    existing ??
    createBatchStatusFile({
      streamId,
      batchId,
      stageName: batchMeta?.stageName,
      batchName: batchMeta?.batchName,
      threads: threadSeeds,
    })

  const nextThreads: BatchStatusThread[] = []

  for (const seed of threadSeeds) {
    const previous = existingThreads.get(seed.threadId)
    const threadMeta = getThreadMetadata(repoRoot, streamId, seed.threadId)
    const latestSession = getLastSessionForThread(repoRoot, streamId, seed.threadId)
    const markerExists = existsSync(getCompletionMarkerPath(streamId, seed.threadId))
    const storedResult = readStoredRunResult(streamId, seed.threadId)

    let thread: BatchStatusThread = {
      threadId: seed.threadId,
      threadName: seed.threadName,
      status: deriveThreadStatus({
        markerExists,
        storedResult,
        latestSessionStatus: latestSession?.status,
        currentSessionId: threadMeta?.currentSessionId,
      }),
      startedAt: latestSession?.startedAt ?? previous?.startedAt,
      updatedAt: now,
      completedAt: latestSession?.completedAt ?? previous?.completedAt,
      markerDetectedAt: previous?.markerDetectedAt,
      currentSessionId:
        threadMeta?.currentSessionId ??
        (latestSession?.status === "running" ? previous?.currentSessionId : undefined),
      opencodeSessionId: threadMeta?.opencodeSessionId ?? previous?.opencodeSessionId,
      recoveryNote: previous?.recoveryNote,
    }

    if (thread.status === "completed" && !thread.startedAt) {
      thread.startedAt = batchStatus.startedAt
    }

    if (
      shouldRefreshCompletedThreadArtifacts({
        markerExists,
        markerDetectedAt: thread.markerDetectedAt,
      })
    ) {
      const markerDetectedAt = thread.markerDetectedAt ?? now
      const artifactUpdates = finalizeCompletedThreadArtifacts(markerDetectedAt)
      thread = {
        ...thread,
        ...artifactUpdates,
      }
    }

    nextThreads.push(thread)
  }

  if (nextThreads.some((thread) => thread.status === "completed" || thread.status === "failed")) {
    await finalizeCanonicalThreadState(
      repoRoot,
      streamId,
      threadSeeds,
      existing?.tmuxSessionName,
      existing?.startedAt,
    )
  }

  batchStatus.threads = nextThreads
  batchStatus.summary = summarizeBatchThreads(nextThreads)
  batchStatus.status = deriveBatchStatus(nextThreads)
  batchStatus.updatedAt = now
  if (batchMeta?.stageName) batchStatus.stageName = batchMeta.stageName
  if (batchMeta?.batchName) batchStatus.batchName = batchMeta.batchName
  if (isTerminalBatchStatus(batchStatus.status)) {
    batchStatus.completedAt = batchStatus.completedAt ?? now
  } else {
    delete batchStatus.completedAt
  }

  await writeBatchStatusLocked(repoRoot, streamId, batchStatus)

  if (isTerminalBatchStatus(batchStatus.status)) {
    const threadIds = threadSeeds.map((thread) => thread.threadId)
    cleanupCompletionMarkers(streamId, threadIds)
    cleanupResultFiles(streamId, threadIds)
    cleanupSessionFiles(streamId, threadIds)
  }

  return batchStatus
}

export async function waitForBatchStatus(
  options: WaitForBatchStatusOptions,
): Promise<BatchStatusFile> {
  const timeoutMs = options.timeoutMs ?? 0
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const startedAt = Date.now()

  while (true) {
    const status = await syncBatchStatus(options)
    if (isTerminalBatchStatus(status.status)) {
      return status
    }

    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      throw createBatchStatusTimeoutError(status, timeoutMs)
    }

    await Bun.sleep(pollIntervalMs)
  }
}

export function batchStatusExists(
  repoRoot: string,
  streamId: string,
  batchId: string,
): boolean {
  return readBatchStatus(repoRoot, streamId, batchId) !== null
}
