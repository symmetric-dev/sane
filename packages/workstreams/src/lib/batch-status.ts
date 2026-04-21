import { randomUUID } from "crypto"
import type {
  PersistedBatchStatusFile,
  PersistedBatchStatusSummary,
  PersistedBatchStatusThread,
} from "./types.ts"
import { upsertStructuredBatchRun } from "./structured-storage.ts"
import {
  getStructuredStorageAdapter,
  modifySqliteCanonicalRuntimeWorkstreamStateSync,
  readStructuredBatchRunSync,
  writeStructuredBatchRunSync,
} from "./storage-adapter.ts"
import { getTasksFilePath } from "./tasks.ts"

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

function orderBatchStatus(batchStatus: BatchStatusFile): BatchStatusFile {
  return {
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

export async function initializeBatchStatusRunLocked(
  args: InitializeBatchStatusRunArgs,
): Promise<BatchStatusFile> {
  const batchStatus = createBatchStatusFile({
    streamId: args.streamId,
    batchId: args.batchId,
    tmuxSessionName: args.tmuxSessionName,
    stageName: args.stageName,
    batchName: args.batchName,
    threads: args.threads,
  })

  await writeBatchStatusLocked(args.repoRoot, args.streamId, batchStatus)
  return batchStatus
}

export function readBatchStatus(
  repoRoot: string,
  streamId: string,
  batchId: string,
): BatchStatusFile | null {
  return readStructuredBatchRunSync(repoRoot, streamId, batchId)
}

export function writeBatchStatus(
  repoRoot: string,
  streamId: string,
  batchStatus: BatchStatusFile,
): void {
  writeStructuredBatchRunSync(repoRoot, streamId, orderBatchStatus(batchStatus))
}

export async function writeBatchStatusLocked(
  repoRoot: string,
  streamId: string,
  batchStatus: BatchStatusFile,
): Promise<void> {
  const ordered = orderBatchStatus(batchStatus)

  modifySqliteCanonicalRuntimeWorkstreamStateSync({ repoRoot, streamId, fn: (workstreamState) => {
    upsertStructuredBatchRun(workstreamState, ordered)
  } })
}
