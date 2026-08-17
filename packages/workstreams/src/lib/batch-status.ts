import { randomUUID } from "crypto"
import type {
  PersistedBatchStatusFile,
  PersistedBatchStatusSummary,
  PersistedBatchStatusThread,
  PersistedBatchExecutionMetadata,
  PersistedExecutionAttemptMetadata,
} from "./types.ts"
import { upsertStructuredBatchRun } from "./structured-storage.ts"
import {
  getStructuredStorageAdapter,
  getFilesystemWorkstreamStatePath,
  modifySqliteCanonicalRuntimeWorkstreamStateSync,
  readStructuredBatchRunSync,
  writeStructuredBatchRunSync,
} from "./storage-adapter.ts"

export const BATCH_STATUS_VERSION = "1.0.0"

function createRunId(batchId: string): string {
  return `${batchId}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export type BatchThreadRunStatus = "pending" | "running" | "completed" | "failed"
export type BatchRunStatus = BatchThreadRunStatus

export type BatchStatusThread = PersistedBatchStatusThread
export type BatchStatusSummary = PersistedBatchStatusSummary
export type BatchStatusFile = PersistedBatchStatusFile

export interface BatchStatusThreadSeed extends Partial<PersistedExecutionAttemptMetadata> {
  threadId: string
  threadName: string
}

export interface InitializeBatchStatusRunArgs extends Partial<PersistedBatchExecutionMetadata> {
  repoRoot: string
  streamId: string
  batchId: string
  tmuxSessionName?: string
  stageName?: string
  batchName?: string
  threads: BatchStatusThreadSeed[]
}

export function getBatchStatusDir(repoRoot: string, streamId: string): string {
  return getFilesystemWorkstreamStatePath(repoRoot, streamId)
}

export function getBatchStatusFilePath(
  repoRoot: string,
  streamId: string,
  _batchId: string,
): string {
  return getFilesystemWorkstreamStatePath(repoRoot, streamId)
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
} & Partial<PersistedBatchExecutionMetadata>): BatchStatusFile {
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
    ...(args.executionBackend !== undefined
      ? { executionBackend: args.executionBackend }
      : {}),
    ...(args.provider !== undefined ? { provider: args.provider } : {}),
    ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
    ...(args.logicalAgent !== undefined ? { logicalAgent: args.logicalAgent } : {}),
    ...(args.resolvedModel !== undefined ? { resolvedModel: args.resolvedModel } : {}),
    ...(args.resolvedVariant !== undefined
      ? { resolvedVariant: args.resolvedVariant }
      : {}),
    ...(args.runtimeSelectionSource !== undefined
      ? { runtimeSelectionSource: args.runtimeSelectionSource }
      : {}),
    ...(args.executorOwnerToken !== undefined
      ? { executorOwnerToken: args.executorOwnerToken }
      : {}),
    ...(args.executorPid !== undefined ? { executorPid: args.executorPid } : {}),
    ...(args.executorStartedAt !== undefined
      ? { executorStartedAt: args.executorStartedAt }
      : {}),
    ...(args.executorHeartbeatAt !== undefined
      ? { executorHeartbeatAt: args.executorHeartbeatAt }
      : {}),
    ...(args.executorFinishedAt !== undefined
      ? { executorFinishedAt: args.executorFinishedAt }
      : {}),
    ...(args.lastEventAt !== undefined ? { lastEventAt: args.lastEventAt } : {}),
    ...(args.lastActivityAt !== undefined
      ? { lastActivityAt: args.lastActivityAt }
      : {}),
    ...(args.cancellationRequestedAt !== undefined
      ? { cancellationRequestedAt: args.cancellationRequestedAt }
      : {}),
    ...(args.cancellationAcknowledgedAt !== undefined
      ? { cancellationAcknowledgedAt: args.cancellationAcknowledgedAt }
      : {}),
    ...(args.terminalOutcome !== undefined
      ? { terminalOutcome: args.terminalOutcome }
      : {}),
    ...(args.errorSummary !== undefined ? { errorSummary: args.errorSummary } : {}),
    ...(args.resultSummary !== undefined ? { resultSummary: args.resultSummary } : {}),
    ...(args.runtimeDirectory !== undefined
      ? { runtimeDirectory: args.runtimeDirectory }
      : {}),
    ...(args.activityJournalPath !== undefined
      ? { activityJournalPath: args.activityJournalPath }
      : {}),
    ...(args.snapshotPath !== undefined ? { snapshotPath: args.snapshotPath } : {}),
    ...(args.executorLogPath !== undefined
      ? { executorLogPath: args.executorLogPath }
      : {}),
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
    ...(batchStatus.executionBackend !== undefined
      ? { executionBackend: batchStatus.executionBackend }
      : {}),
    ...(batchStatus.provider !== undefined ? { provider: batchStatus.provider } : {}),
    ...(batchStatus.runtime !== undefined ? { runtime: batchStatus.runtime } : {}),
    ...(batchStatus.logicalAgent !== undefined
      ? { logicalAgent: batchStatus.logicalAgent }
      : {}),
    ...(batchStatus.resolvedModel !== undefined
      ? { resolvedModel: batchStatus.resolvedModel }
      : {}),
    ...(batchStatus.resolvedVariant !== undefined
      ? { resolvedVariant: batchStatus.resolvedVariant }
      : {}),
    ...(batchStatus.runtimeSelectionSource !== undefined
      ? { runtimeSelectionSource: batchStatus.runtimeSelectionSource }
      : {}),
    ...(batchStatus.executorOwnerToken !== undefined
      ? { executorOwnerToken: batchStatus.executorOwnerToken }
      : {}),
    ...(batchStatus.executorPid !== undefined ? { executorPid: batchStatus.executorPid } : {}),
    ...(batchStatus.executorStartedAt !== undefined
      ? { executorStartedAt: batchStatus.executorStartedAt }
      : {}),
    ...(batchStatus.executorHeartbeatAt !== undefined
      ? { executorHeartbeatAt: batchStatus.executorHeartbeatAt }
      : {}),
    ...(batchStatus.executorFinishedAt !== undefined
      ? { executorFinishedAt: batchStatus.executorFinishedAt }
      : {}),
    ...(batchStatus.lastEventAt !== undefined
      ? { lastEventAt: batchStatus.lastEventAt }
      : {}),
    ...(batchStatus.lastActivityAt !== undefined
      ? { lastActivityAt: batchStatus.lastActivityAt }
      : {}),
    ...(batchStatus.cancellationRequestedAt !== undefined
      ? { cancellationRequestedAt: batchStatus.cancellationRequestedAt }
      : {}),
    ...(batchStatus.cancellationAcknowledgedAt !== undefined
      ? { cancellationAcknowledgedAt: batchStatus.cancellationAcknowledgedAt }
      : {}),
    ...(batchStatus.terminalOutcome !== undefined
      ? { terminalOutcome: batchStatus.terminalOutcome }
      : {}),
    ...(batchStatus.errorSummary !== undefined
      ? { errorSummary: batchStatus.errorSummary }
      : {}),
    ...(batchStatus.resultSummary !== undefined
      ? { resultSummary: batchStatus.resultSummary }
      : {}),
    ...(batchStatus.runtimeDirectory !== undefined
      ? { runtimeDirectory: batchStatus.runtimeDirectory }
      : {}),
    ...(batchStatus.activityJournalPath !== undefined
      ? { activityJournalPath: batchStatus.activityJournalPath }
      : {}),
    ...(batchStatus.snapshotPath !== undefined
      ? { snapshotPath: batchStatus.snapshotPath }
      : {}),
    ...(batchStatus.executorLogPath !== undefined
      ? { executorLogPath: batchStatus.executorLogPath }
      : {}),
    startedAt: batchStatus.startedAt,
    updatedAt: batchStatus.updatedAt,
    ...(batchStatus.completedAt ? { completedAt: batchStatus.completedAt } : {}),
    summary: batchStatus.summary,
    threads: batchStatus.threads.map((thread) => ({ ...thread })),
  }
}

export function initializeBatchStatusRun(
  args: InitializeBatchStatusRunArgs,
): BatchStatusFile {
  const batchStatus = createBatchStatusFile(args)

  writeBatchStatus(args.repoRoot, args.streamId, batchStatus)
  return batchStatus
}

export async function initializeBatchStatusRunLocked(
  args: InitializeBatchStatusRunArgs,
): Promise<BatchStatusFile> {
  const batchStatus = createBatchStatusFile(args)

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
