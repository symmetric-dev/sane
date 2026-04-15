import { existsSync, mkdirSync, readFileSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"
import { atomicWriteFile } from "./index.ts"
import { getWorkDir } from "./repo.ts"

export const BATCH_STATUS_VERSION = "1.0.0"

function createRunId(batchId: string): string {
  return `${batchId}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export type BatchThreadRunStatus = "pending" | "running" | "completed" | "failed"
export type BatchRunStatus = BatchThreadRunStatus

export interface BatchStatusThread {
  threadId: string
  threadName: string
  firstTaskId: string
  status: BatchThreadRunStatus
  startedAt?: string
  updatedAt: string
  completedAt?: string
  markerDetectedAt?: string
  currentSessionId?: string
  opencodeSessionId?: string
  workingAgentSessionId?: string
  synthesisUpdatedAt?: string
}

export interface BatchStatusSummary {
  total: number
  pending: number
  running: number
  completed: number
  failed: number
}

export interface BatchStatusFile {
  version: string
  streamId: string
  batchId: string
  runId: string
  tmuxSessionName?: string
  mode: "headless"
  status: BatchRunStatus
  stageName?: string
  batchName?: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  summary: BatchStatusSummary
  threads: BatchStatusThread[]
}

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
  return join(getWorkDir(repoRoot), streamId, "batch-status")
}

export function getBatchStatusFilePath(
  repoRoot: string,
  streamId: string,
  batchId: string,
): string {
  return join(getBatchStatusDir(repoRoot, streamId), `${batchId}.json`)
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
  const filePath = getBatchStatusFilePath(repoRoot, streamId, batchId)
  if (!existsSync(filePath)) {
    return null
  }

  return JSON.parse(readFileSync(filePath, "utf-8")) as BatchStatusFile
}

export function writeBatchStatus(
  repoRoot: string,
  streamId: string,
  batchStatus: BatchStatusFile,
): void {
  const dir = getBatchStatusDir(repoRoot, streamId)
  mkdirSync(dir, { recursive: true })

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

  atomicWriteFile(
    getBatchStatusFilePath(repoRoot, streamId, batchStatus.batchId),
    JSON.stringify(ordered, null, 2),
  )
}
