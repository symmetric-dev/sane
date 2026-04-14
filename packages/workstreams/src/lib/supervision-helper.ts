import { spawn } from "child_process"
import { randomUUID } from "crypto"
import { fileURLToPath } from "url"
import { syncBatchStatus, waitForBatchStatus } from "./batch-monitor.ts"
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
  port?: number
  noServer?: boolean
  silent?: boolean
  rootSessionId?: string
  parentSessionId?: string
  parentBranchSessionId?: string
  branchRole?: "supervision" | "fix"
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

export function findNextIncompleteBatch(
  tasks: Array<{ id: string; status: string }>,
  scope?: BatchSelectionScope,
): string | null {
  const batchMap = new Map<string, Array<{ id: string; status: string }>>()

  for (const task of tasks) {
    const parts = task.id.split(".")
    if (parts.length < 2) continue

    const batchId = `${parts[0]}.${parts[1]}`
    const batchTasks = batchMap.get(batchId) ?? []
    batchTasks.push(task)
    batchMap.set(batchId, batchTasks)
  }

  for (const batchId of Array.from(batchMap.keys()).sort()) {
    if (!matchesBatchSelectionScope(batchId, scope)) {
      continue
    }

    const batchTasks = batchMap.get(batchId) ?? []
    const allDone = batchTasks.every(
      (task) => task.status === "completed" || task.status === "cancelled",
    )
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

export async function launchHeadlessBatchExecution(
  args: LaunchHeadlessBatchArgs,
): Promise<void> {
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
    const child = spawn(process.execPath, commandArgs, {
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
