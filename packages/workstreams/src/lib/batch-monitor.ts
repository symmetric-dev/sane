import { spawn } from "child_process"
import { existsSync, readFileSync } from "fs"
import { fileURLToPath } from "url"
import { getBatchMetadata, readTasksFile } from "./tasks.ts"
import {
  cleanupCompletionMarkers,
  cleanupResultFiles,
  cleanupSessionFiles,
  cleanupSynthesisFiles,
} from "./marker-polling.ts"
import {
  initializeBatchStatusRun,
  createBatchStatusFile,
  type BatchStatusFile,
  type BatchStatusThread,
  type BatchThreadRunStatus,
  getBatchStatusFilePath,
  isTerminalBatchStatus,
  readBatchStatus,
  summarizeBatchThreads,
  writeBatchStatus,
} from "./batch-status.ts"
import { parseBatchId } from "./cli-utils.ts"
import {
  getCompletionMarkerPath,
  getRunResultPath,
  getSessionFilePath,
  getSynthesisLogPath,
  getWorkingAgentSessionPath,
} from "./opencode.ts"
import {
  getLastSessionForThread,
  getThreadMetadata,
  setSynthesisOutput,
  updateThreadMetadataLocked,
} from "./threads.ts"
import { applyFinalizationCompletions, type FinalizationCompletion } from "./multi-finalization.ts"
import { parseSynthesisOutputFile } from "./synthesis/output.ts"

interface BatchThreadSeed {
  threadId: string
  threadName: string
  firstTaskId: string
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
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) {
    throw new Error(`No tasks found for stream ${streamId}`)
  }

  const prefix = `${batchId}.`
  const threads = new Map<string, BatchThreadSeed>()

  for (const task of tasksFile.tasks) {
    if (!task.id.startsWith(prefix)) continue

    const parts = task.id.split(".")
    if (parts.length !== 4) continue
    const threadId = `${parts[0]}.${parts[1]}.${parts[2]}`

    const existing = threads.get(threadId)
    if (!existing || task.id.localeCompare(existing.firstTaskId) < 0) {
      threads.set(threadId, {
        threadId,
        threadName: task.thread_name,
        firstTaskId: task.id,
      })
    }
  }

  return Array.from(threads.values()).sort((a, b) =>
    a.threadId.localeCompare(b.threadId),
  )
}

async function finalizeCompletedThreadArtifacts(
  repoRoot: string,
  streamId: string,
  threadId: string,
  markerDetectedAt: string,
): Promise<Partial<BatchStatusThread>> {
  const updates: Partial<BatchStatusThread> = {
    markerDetectedAt,
    completedAt: markerDetectedAt,
  }

  const sessionFilePath = getSessionFilePath(streamId, threadId)
  if (existsSync(sessionFilePath)) {
    const opencodeSessionId = readFileSync(sessionFilePath, "utf-8").trim()
    if (opencodeSessionId) {
      updates.opencodeSessionId = opencodeSessionId
      await updateThreadMetadataLocked(repoRoot, streamId, threadId, {
        opencodeSessionId,
      })
    }
  }

  const workingAgentSessionPath = getWorkingAgentSessionPath(streamId, threadId)
  if (existsSync(workingAgentSessionPath)) {
    const workingAgentSessionId = readFileSync(
      workingAgentSessionPath,
      "utf-8",
    ).trim()
    if (workingAgentSessionId) {
      updates.workingAgentSessionId = workingAgentSessionId
      await updateThreadMetadataLocked(repoRoot, streamId, threadId, {
        workingAgentSessionId,
      })
    }
  }

  const synthesisJsonPath = `/tmp/workstream-${streamId}-${threadId}-synthesis.json`
  if (existsSync(synthesisJsonPath)) {
    const parseResult = parseSynthesisOutputFile(
      synthesisJsonPath,
      getSynthesisLogPath(streamId, threadId),
    )

    if (parseResult.text) {
      await setSynthesisOutput(repoRoot, streamId, threadId, {
        sessionId: `synthesis-${threadId}-${Date.now()}`,
        output: parseResult.text.trim(),
        completedAt: markerDetectedAt,
      })
      updates.synthesisUpdatedAt = markerDetectedAt
    }
  }

  return updates
}

function shouldRefreshCompletedThreadArtifacts(args: {
  streamId: string
  threadId: string
  thread: BatchStatusThread
  markerExists: boolean
}): boolean {
  if (!args.markerExists) {
    return false
  }

  if (!args.thread.markerDetectedAt) {
    return true
  }

  const synthesisJsonPath = `/tmp/workstream-${args.streamId}-${args.threadId}-synthesis.json`

  return (
    (!args.thread.opencodeSessionId && existsSync(getSessionFilePath(args.streamId, args.threadId))) ||
    (!args.thread.workingAgentSessionId &&
      existsSync(getWorkingAgentSessionPath(args.streamId, args.threadId))) ||
    (!args.thread.synthesisUpdatedAt && existsSync(synthesisJsonPath))
  )
}

interface StoredRunResult {
  status: "completed" | "failed"
  exitCode?: number
}

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

async function finalizeCanonicalThreadState(
  repoRoot: string,
  streamId: string,
  threadSeeds: BatchThreadSeed[],
): Promise<void> {
  const completions: FinalizationCompletion[] = []

  for (const seed of threadSeeds) {
    const markerExists = existsSync(getCompletionMarkerPath(streamId, seed.threadId))
    const storedResult = readStoredRunResult(streamId, seed.threadId)
    if (!markerExists && !storedResult) {
      continue
    }

    const threadMeta = getThreadMetadata(repoRoot, streamId, seed.threadId)
    const latestSession = getLastSessionForThread(repoRoot, streamId, seed.threadId)
    const sessionId =
      threadMeta?.currentSessionId ??
      (latestSession?.status === "running" ? latestSession.sessionId : undefined)

    if (!sessionId) {
      continue
    }

    completions.push({
      taskId: seed.firstTaskId,
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

export function resetBatchStatusRun(options: {
  repoRoot: string
  streamId: string
  batchId: string
  stageName?: string
  batchName?: string
  threads: BatchThreadSeed[]
}): BatchStatusFile {
  const threadIds = options.threads.map((thread) => thread.threadId)
  cleanupCompletionMarkers(options.streamId, threadIds)
  cleanupResultFiles(options.streamId, threadIds)
  cleanupSessionFiles(options.streamId, threadIds)
  cleanupSynthesisFiles(options.streamId, threadIds)

  return initializeBatchStatusRun({
    repoRoot: options.repoRoot,
    streamId: options.streamId,
    batchId: options.batchId,
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

  const batchMeta = getBatchMetadata(
    repoRoot,
    streamId,
    batchParsed.stage,
    batchParsed.batch,
  )

  const now = new Date().toISOString()
  await finalizeCanonicalThreadState(repoRoot, streamId, threadSeeds)
  const existing = readBatchStatus(repoRoot, streamId, batchId)
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
      firstTaskId: seed.firstTaskId,
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
      currentSessionId: threadMeta?.currentSessionId ?? previous?.currentSessionId,
      opencodeSessionId: threadMeta?.opencodeSessionId ?? previous?.opencodeSessionId,
      workingAgentSessionId:
        threadMeta?.workingAgentSessionId ?? previous?.workingAgentSessionId,
      synthesisUpdatedAt:
        threadMeta?.synthesis?.completedAt ?? previous?.synthesisUpdatedAt,
    }

    if (thread.status === "completed" && !thread.startedAt) {
      thread.startedAt = batchStatus.startedAt
    }

    if (
      shouldRefreshCompletedThreadArtifacts({
        streamId,
        threadId: seed.threadId,
        thread,
        markerExists,
      })
    ) {
      const markerDetectedAt = thread.markerDetectedAt ?? now
      const artifactUpdates = await finalizeCompletedThreadArtifacts(
        repoRoot,
        streamId,
        seed.threadId,
        markerDetectedAt,
      )
      thread = {
        ...thread,
        ...artifactUpdates,
      }
    }

    nextThreads.push(thread)
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

  writeBatchStatus(repoRoot, streamId, batchStatus)

  if (isTerminalBatchStatus(batchStatus.status)) {
    const threadIds = threadSeeds.map((thread) => thread.threadId)
    cleanupCompletionMarkers(streamId, threadIds)
    cleanupResultFiles(streamId, threadIds)
    cleanupSessionFiles(streamId, threadIds)
    cleanupSynthesisFiles(streamId, threadIds)
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
  return existsSync(getBatchStatusFilePath(repoRoot, streamId, batchId))
}
