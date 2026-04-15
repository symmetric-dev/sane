import { randomUUID } from "crypto"
import type {
  PersistedBatchStatusFile,
  PersistedBatchStatusSummary,
  PersistedBatchStatusThread,
} from "./types.ts"
import { getTasksFilePath, readTasksFile, normalizeRuntimeState, writeTasksFile } from "./tasks.ts"

export const BATCH_STATUS_VERSION = "1.0.0"

function createRunId(batchId: string): string {
  return `${batchId}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export type BatchThreadRunStatus = "pending" | "running" | "completed" | "failed"
export type BatchRunStatus = BatchThreadRunStatus

export type BatchStatusThread = PersistedBatchStatusThread
export type BatchStatusSummary = PersistedBatchStatusSummary
export type BatchStatusFile = PersistedBatchStatusFile

export interface BatchStatusThreadSeed {
  threadId: string
  threadName: string
  firstTaskId: string
}

export interface InitializeBatchStatusRunArgs {
  repoRoot: string
  streamId: string
  batchId: string
  tmuxSessionName?: string
  stageName?: string
  batchName?: string
  threads: BatchStatusThreadSeed[]
}

export function getBatchStatusDir(repoRoot: string, streamId: string): string {
  return getTasksFilePath(repoRoot, streamId)
}

export function getBatchStatusFilePath(
  repoRoot: string,
  streamId: string,
  _batchId: string,
): string {
  return getTasksFilePath(repoRoot, streamId)
}

export function summarizeBatchThreads(
  threads: BatchStatusThread[],
): BatchStatusSummary {
  const summary: BatchStatusSummary = {
    total: threads.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  }

  for (const thread of threads) {
    summary[thread.status] += 1
  }

  return summary
}

export function isTerminalBatchStatus(status: BatchRunStatus): boolean {
  return status === "completed" || status === "failed"
}

export function createBatchStatusFile(args: {
  streamId: string
  batchId: string
  tmuxSessionName?: string
  stageName?: string
  batchName?: string
  threads: BatchStatusThreadSeed[]
  startedAt?: string
  runId?: string
}): BatchStatusFile {
  const startedAt = args.startedAt ?? new Date().toISOString()
  const threads: BatchStatusThread[] = args.threads.map((thread) => ({
    ...thread,
    status: "pending",
    updatedAt: startedAt,
  }))

  return {
    version: BATCH_STATUS_VERSION,
    streamId: args.streamId,
    batchId: args.batchId,
    runId: args.runId ?? createRunId(args.batchId),
    ...(args.tmuxSessionName ? { tmuxSessionName: args.tmuxSessionName } : {}),
    mode: "headless",
    status: "pending",
    ...(args.stageName ? { stageName: args.stageName } : {}),
    ...(args.batchName ? { batchName: args.batchName } : {}),
    startedAt,
    updatedAt: startedAt,
    summary: summarizeBatchThreads(threads),
    threads,
  }
}

export function initializeBatchStatusRun(
  args: InitializeBatchStatusRunArgs,
): BatchStatusFile {
  const batchStatus = createBatchStatusFile({
      streamId: args.streamId,
      batchId: args.batchId,
      tmuxSessionName: args.tmuxSessionName,
      stageName: args.stageName,
      batchName: args.batchName,
      threads: args.threads,
  })

  writeBatchStatus(args.repoRoot, args.streamId, batchStatus)
  return batchStatus
}

export function readBatchStatus(
  repoRoot: string,
  streamId: string,
  batchId: string,
): BatchStatusFile | null {
  const tasksFile = readTasksFile(repoRoot, streamId)
  return tasksFile?.runtime_state?.batches[batchId] ?? null
}

export function writeBatchStatus(
  repoRoot: string,
  streamId: string,
  batchStatus: BatchStatusFile,
): void {
  const ordered: BatchStatusFile = {
    version: batchStatus.version,
    streamId: batchStatus.streamId,
    batchId: batchStatus.batchId,
    runId: batchStatus.runId,
    ...(batchStatus.tmuxSessionName ? { tmuxSessionName: batchStatus.tmuxSessionName } : {}),
    mode: batchStatus.mode,
    status: batchStatus.status,
    ...(batchStatus.stageName ? { stageName: batchStatus.stageName } : {}),
    ...(batchStatus.batchName ? { batchName: batchStatus.batchName } : {}),
    startedAt: batchStatus.startedAt,
    updatedAt: batchStatus.updatedAt,
    ...(batchStatus.completedAt ? { completedAt: batchStatus.completedAt } : {}),
    summary: batchStatus.summary,
    threads: batchStatus.threads,
  }

  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) {
    throw new Error(`Cannot write batch status before tasks.json exists for stream ${streamId}`)
  }
  tasksFile.runtime_state = normalizeRuntimeState(streamId, tasksFile.runtime_state)
  tasksFile.runtime_state.batches[batchStatus.batchId] = ordered
  delete tasksFile.runtime_summary
  writeTasksFile(repoRoot, streamId, tasksFile)
}
