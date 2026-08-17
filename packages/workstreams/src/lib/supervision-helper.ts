import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import { fileURLToPath } from "url"
import { closeSync, openSync } from "node:fs"
import { join } from "node:path"
import { syncBatchStatus, waitForBatchStatus } from "./batch-monitor.ts"
import {
  prepareSdkBatchRun,
  type BatchExecutorOptions,
} from "./agent-runtime/batch-executor.ts"
import { readBatchStatus, type BatchStatusFile } from "./batch-status.ts"
import type { HierarchyThreadQueryRecord } from "./hierarchy-query.ts"
import {
  createEmptySupervisorState,
  loadSupervisorState,
} from "./supervisor-state.ts"
import type {
  SupervisorRunState,
  SupervisorStateFile,
} from "./types.ts"

export type SupervisionExecutionAction = "launch" | "wait" | "recover" | "stop"

export interface SupervisionExecutionStartPlan {
  runId: string
  runStartedAt: string
  stageId: string
  batchId: string
  action: SupervisionExecutionAction
  resolvedBatchStatus?: Awaited<ReturnType<typeof syncBatchStatus>>
  message?: string
  reusingExistingRun: boolean
}

export interface LaunchHeadlessBatchArgs {
  repoRoot: string
  streamId: string
  batchId: string
  /** The default is deliberately legacy for the existing work command. */
  executionBackend?: "legacy" | "sdk"
  runtime?: string
  port?: number
  noServer?: boolean
  silent?: boolean
  rootSessionId?: string
  parentSessionId?: string
  parentBranchSessionId?: string
  branchRole?: "supervision" | "fix"
  /** Internal metadata used only by the detached SDK handoff. */
  runId?: string
  ownerToken?: string
}

export interface SupervisionHelperDependencies {
  spawn?: typeof spawn
  openExecutorLog?: (path: string) => number
  closeExecutorLog?: (fd: number) => void
  prepareSdkBatchRun?: (options: BatchExecutorOptions) => ReturnType<typeof prepareSdkBatchRun>
  readBatchStatus?: typeof readBatchStatus
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface BuildSupervisionExecutionPlanArgs {
  repoRoot: string
  streamId: string
  requestedBatchId: string
}

interface BatchSelectionScope {
  stageId?: string
  batchId?: string
}

function matchesBatchSelectionScope(batchId: string, scope?: BatchSelectionScope): boolean {
  if (!scope) {
    return true
  }

  if (scope.batchId) {
    return batchId === scope.batchId
  }

  if (scope.stageId) {
    return batchId.startsWith(`${scope.stageId}.`)
  }

  return true
}

export function findNextIncompleteBatchFromHierarchy(
  threads: Pick<HierarchyThreadQueryRecord, "batchId" | "aggregateStatus">[],
  scope?: BatchSelectionScope,
): string | null {
  const batchMap = new Map<string, Pick<HierarchyThreadQueryRecord, "batchId" | "aggregateStatus">[]>()

  for (const thread of threads) {
    const batchThreads = batchMap.get(thread.batchId) ?? []
    batchThreads.push(thread)
    batchMap.set(thread.batchId, batchThreads)
  }

  for (const batchId of Array.from(batchMap.keys()).sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  )) {
    if (!matchesBatchSelectionScope(batchId, scope)) {
      continue
    }

    const batchThreads = batchMap.get(batchId) ?? []
    const allDone = batchThreads.every((thread) => thread.aggregateStatus === "completed")
    if (!allDone) {
      return batchId
    }
  }

  return null
}

export function createSupervisorRunId(stageId: string): string {
  return `sup-${stageId}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export function summarizeBatchStatus(
  status: Awaited<ReturnType<typeof waitForBatchStatus>>,
): string {
  return `${status.summary.completed}/${status.summary.total} completed, ${status.summary.failed} failed, ${status.summary.running} running, ${status.summary.pending} pending`
}

function getSdkWorkerPath(): string {
  return fileURLToPath(new URL("../../bin/work-sdk.ts", import.meta.url))
}

async function waitForSdkWorkerInitialization(args: {
  repoRoot: string
  streamId: string
  batchId: string
  runId: string
  executorLogPath?: string
  readBatchStatus: typeof readBatchStatus
  sleep: (ms: number) => Promise<void>
  now: () => number
  timeoutMs?: number
}): Promise<BatchStatusFile> {
  const timeoutMs = args.timeoutMs ?? 15_000
  const startedAt = args.now()
  let attempts = 0

  while (args.now() - startedAt < timeoutMs && attempts < Math.ceil(timeoutMs / 25)) {
    attempts += 1
    const status = args.readBatchStatus(args.repoRoot, args.streamId, args.batchId)
    if (status?.runId === args.runId && status.executionBackend === "sdk") {
      // A terminal state is also valid: the worker initialized and completed
      // before the manager observed the first poll.
      if (status.status !== "pending" || status.executorPid !== undefined) return status
    }
    await args.sleep(25)
  }

  const logHint = args.executorLogPath ? `; inspect ${args.executorLogPath}` : ""
  throw new Error(
    `SDK batch worker did not initialize canonical run ${args.runId} within ${timeoutMs}ms${logHint}`,
  )
}

async function launchSdkBatchExecution(
  args: LaunchHeadlessBatchArgs,
  dependencies: SupervisionHelperDependencies,
): Promise<void> {
  const prepare = dependencies.prepareSdkBatchRun ?? prepareSdkBatchRun
  const prepared = prepare({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    batchId: args.batchId,
    runtimeOverride: args.runtime,
    serverPort: args.port,
    noServer: args.noServer,
    runId: args.runId,
    ownerToken: args.ownerToken,
  })
  const runId = prepared.batch.runId
  const ownerToken = prepared.ownerToken
  const workerPath = getSdkWorkerPath()
  const commandArgs = [
    workerPath,
    "batch-executor",
    "--repo-root",
    args.repoRoot,
    "--stream",
    args.streamId,
    "--batch-id",
    args.batchId,
    "--execution-backend",
    "sdk",
    "--run-id",
    runId,
    "--owner-token",
    ownerToken,
  ]

  if (args.runtime !== undefined) commandArgs.push("--runtime", args.runtime)
  if (args.port !== undefined) commandArgs.push("--port", String(args.port))
  if (args.noServer) commandArgs.push("--no-server")
  if (args.silent) commandArgs.push("--silent")

  const executorLogPath = prepared.batch.executorLogPath
  if (!executorLogPath) throw new Error(`SDK batch ${args.batchId} has no executor log path`)
  const absoluteExecutorLogPath = join(args.repoRoot, executorLogPath)
  const openLog = dependencies.openExecutorLog ?? ((path: string) => openSync(path, "a"))
  const closeLog = dependencies.closeExecutorLog ?? closeSync
  const spawnProcess = dependencies.spawn ?? spawn
  const logFd = openLog(absoluteExecutorLogPath)

  let child: ChildProcess
  try {
    // Numeric stdio descriptors are deliberate: the manager owns no pipes and
    // cannot accidentally retain the worker's provider output stream.
    child = spawnProcess(process.execPath, commandArgs, {
      cwd: args.repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    })
  } finally {
    closeLog(logFd)
  }
  child.unref()

  await waitForSdkWorkerInitialization({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    batchId: args.batchId,
    runId,
    executorLogPath: absoluteExecutorLogPath,
    readBatchStatus: dependencies.readBatchStatus ?? readBatchStatus,
    sleep: dependencies.sleep ?? ((ms) => Bun.sleep(ms)),
    now: dependencies.now ?? Date.now,
  })
}

export async function launchHeadlessBatchExecution(
  args: LaunchHeadlessBatchArgs,
  dependencies: SupervisionHelperDependencies = {},
): Promise<void> {
  if (args.executionBackend === "sdk") {
    await launchSdkBatchExecution(args, dependencies)
    return
  }

  // Keep this legacy command construction and attached pipe handling intact.
  const workCliPath = fileURLToPath(new URL("../../bin/work.ts", import.meta.url))
  const commandArgs = [
    workCliPath,
    "multi",
    "--repo-root",
    args.repoRoot,
    "--stream",
    args.streamId,
    "--batch",
    args.batchId,
    "--headless",
    "--async",
  ]

  if (args.port !== undefined) {
    commandArgs.push("--port", String(args.port))
  }
  if (args.noServer) {
    commandArgs.push("--no-server")
  }
  if (args.silent) {
    commandArgs.push("--silent")
  }
  if (args.rootSessionId) {
    commandArgs.push("--root-session-id", args.rootSessionId)
  }
  if (args.parentSessionId) {
    commandArgs.push("--parent-session-id", args.parentSessionId)
  }
  if (args.parentBranchSessionId) {
    commandArgs.push("--parent-branch-session-id", args.parentBranchSessionId)
  }
  if (args.branchRole) {
    commandArgs.push("--branch-role", args.branchRole)
  }

  await new Promise<void>((resolve, reject) => {
    const child = (dependencies.spawn ?? spawn)(process.execPath, commandArgs, {
      cwd: args.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(
        new Error(
          stderr.trim() || stdout.trim() || `work multi exited with status ${code ?? 1}`,
        ),
      )
    })
    child.on("error", reject)
  })
}

export function getSupervisorStateSnapshot(
  repoRoot: string,
  streamId: string,
): SupervisorStateFile {
  return loadSupervisorState(repoRoot, streamId) ?? createEmptySupervisorState(streamId)
}

export function getRunById(
  supervisorState: SupervisorStateFile,
  runId: string | undefined,
): SupervisorRunState | undefined {
  if (!runId) return undefined
  return supervisorState.runs.find((run) => run.runId === runId)
}

function getLatestRunForBatch(
  supervisorState: SupervisorStateFile,
  batchId: string,
): SupervisorRunState | undefined {
  const relatedRunIds = new Set<string>()

  for (const run of supervisorState.runs) {
    if (run.currentBatchId === batchId || run.lastReviewedBatchId === batchId) {
      relatedRunIds.add(run.runId)
    }
  }

  for (const review of supervisorState.reviewed_batches) {
    if (review.batchId === batchId) {
      relatedRunIds.add(review.runId)
    }
  }

  for (const stop of supervisorState.stage_stops) {
    if (stop.batchId === batchId) {
      relatedRunIds.add(stop.runId)
    }
  }

  return [...supervisorState.runs]
    .filter((run) => relatedRunIds.has(run.runId))
    .sort((left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )[0]
}

function getRecoveredRunForBatch(
  supervisorState: SupervisorStateFile,
  requestedBatchId: string,
): SupervisorRunState | undefined {
  const activeRun = getRunById(supervisorState, supervisorState.active_run_id)
  if (activeRun?.currentBatchId === requestedBatchId) {
    return activeRun
  }

  return getLatestRunForBatch(supervisorState, requestedBatchId) ?? activeRun
}

function getRunStageStop(
  supervisorState: SupervisorStateFile,
  runId: string,
  batchId?: string,
) {
  return [...supervisorState.stage_stops]
    .filter((stop) => stop.runId === runId && (batchId ? stop.batchId === batchId : true))
    .sort((left, right) =>
      new Date(right.stoppedAt).getTime() - new Date(left.stoppedAt).getTime(),
    )[0]
}

function formatRecoveredStopMessage(args: {
  batchId: string
  run: SupervisorRunState
  summary?: string
}): string {
  if (args.summary) {
    return `[supervise] stop: batch ${args.batchId} already has a persisted supervisor outcome from run ${args.run.runId}. ${args.summary}`
  }

  return `[supervise] stop: batch ${args.batchId} already has a persisted supervisor outcome from run ${args.run.runId} (${args.run.status}).`
}

function getExecutionActionForBatchStatus(
  status: Awaited<ReturnType<typeof syncBatchStatus>>["status"],
): Exclude<SupervisionExecutionAction, "stop"> {
  if (status === "running") {
    return "wait"
  }

  if (status === "completed" || status === "failed") {
    return "recover"
  }

  return "launch"
}

export function getLatestResumableBatchId(
  supervisorState: SupervisorStateFile,
  scope?: BatchSelectionScope,
): string | undefined {
  const activeRun = getRunById(supervisorState, supervisorState.active_run_id)
  if (
    activeRun &&
    (activeRun.status === "running" || activeRun.status === "paused") &&
    activeRun.currentBatchId &&
    matchesBatchSelectionScope(activeRun.currentBatchId, scope)
  ) {
    return activeRun.currentBatchId
  }

  return [...supervisorState.runs]
    .filter(
      (run) =>
        (run.status === "running" || run.status === "paused") &&
        run.currentBatchId &&
        matchesBatchSelectionScope(run.currentBatchId, scope),
    )
    .sort((left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )[0]?.currentBatchId
}

export async function buildSupervisionExecutionPlan(
  args: BuildSupervisionExecutionPlanArgs,
): Promise<SupervisionExecutionStartPlan> {
  const { repoRoot, streamId, requestedBatchId } = args
  const supervisorState = getSupervisorStateSnapshot(repoRoot, streamId)
  const recoveredRun = getRecoveredRunForBatch(supervisorState, requestedBatchId)

  if (!recoveredRun || (recoveredRun.currentBatchId && recoveredRun.currentBatchId !== requestedBatchId)) {
    const [stageId] = requestedBatchId.split(".")
    if (!stageId) {
      throw new Error(`Error: Invalid batch ID "${requestedBatchId}"`)
    }

    const batchStatus = await syncBatchStatus({
      repoRoot,
      streamId,
      batchId: requestedBatchId,
    })

    return {
      runId: createSupervisorRunId(stageId),
      runStartedAt: new Date().toISOString(),
      stageId,
      batchId: requestedBatchId,
      action: getExecutionActionForBatchStatus(batchStatus.status),
      resolvedBatchStatus:
        batchStatus.status === "completed" || batchStatus.status === "failed"
          ? batchStatus
          : undefined,
      message:
        batchStatus.status === "running"
          ? `[supervise] resume: waiting for in-progress batch ${requestedBatchId}.`
          : batchStatus.status === "completed" || batchStatus.status === "failed"
            ? `[supervise] resume: batch ${requestedBatchId} already reached ${batchStatus.status}; recovering persisted results.`
            : undefined,
      reusingExistingRun: false,
    }
  }

  const currentBatchId = recoveredRun.currentBatchId ?? requestedBatchId
  const batchStatus = await syncBatchStatus({
    repoRoot,
    streamId,
    batchId: currentBatchId,
  })
  const stageStop = getRunStageStop(supervisorState, recoveredRun.runId, currentBatchId)
  const hasPersistedTerminalOutcome =
    recoveredRun.status === "completed" ||
    recoveredRun.status === "stopped" ||
    recoveredRun.status === "escalated" ||
    Boolean(stageStop && recoveredRun.status !== "failed")

  if (hasPersistedTerminalOutcome) {
    return {
      runId: recoveredRun.runId,
      runStartedAt: recoveredRun.startedAt,
      stageId: recoveredRun.stageId,
      batchId: currentBatchId,
      action: "stop",
      message: formatRecoveredStopMessage({
        batchId: currentBatchId,
        run: recoveredRun,
        summary: stageStop?.summary,
      }),
      reusingExistingRun: true,
    }
  }

  return {
    runId: recoveredRun.runId,
    runStartedAt: recoveredRun.startedAt,
    stageId: recoveredRun.stageId,
    batchId: currentBatchId,
    action: getExecutionActionForBatchStatus(batchStatus.status),
    resolvedBatchStatus:
      batchStatus.status === "completed" || batchStatus.status === "failed"
        ? batchStatus
        : undefined,
    message:
      batchStatus.status === "running"
        ? `[supervise] resume: waiting for in-progress batch ${currentBatchId} from run ${recoveredRun.runId}.`
        : batchStatus.status === "completed" || batchStatus.status === "failed"
          ? `[supervise] resume: batch ${currentBatchId} already reached ${batchStatus.status}; recovering persisted results from run ${recoveredRun.runId}.`
          : `[supervise] resume: relaunching persisted supervisor run ${recoveredRun.runId} at batch ${currentBatchId}.`,
    reusingExistingRun: true,
  }
}
