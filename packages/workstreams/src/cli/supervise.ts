import { spawn } from "child_process"
import { randomUUID } from "crypto"
import { existsSync, readFileSync } from "fs"
import { fileURLToPath } from "url"
import { getRepoRoot } from "../lib/repo.ts"
import { getResolvedStream, loadIndex } from "../lib/index.ts"
import { getStreamPlanMdPath } from "../lib/consolidate.ts"
import { syncBatchStatus, waitForBatchStatus } from "../lib/batch-monitor.ts"
import { readTasksFile } from "../lib/tasks.ts"
import { parseStreamDocument } from "../lib/stream-parser.ts"
import {
  decideSupervisorBatchFollowUp,
  decideSupervisorStageBoundary,
  getReviewAffectedThreadIds,
  getSupervisorBatchCycleState,
  loadSupervisorConfig,
  collectSupervisorReviewInput,
  runDeterministicSupervisorReview,
} from "../lib/supervisor/index.ts"
import {
  clearSupervisorRunFailureStopLocked,
  createEmptySupervisorState,
  loadSupervisorState,
  reconcileSupervisorRunsLocked,
  recordStageStopLocked,
  upsertEscalationOutcomeLocked,
  upsertFixCycleLocked,
  upsertIssueSummaryLocked,
  upsertReviewedBatchLocked,
  upsertSupervisorRunLocked,
} from "../lib/supervisor-state.ts"
import type {
  ReviewerResult,
} from "../lib/reviewer/types.ts"
import type {
  StreamDocument,
  SupervisorFixCycle,
  SupervisorReviewedBatch,
  SupervisorRunState,
  SupervisorStateFile,
} from "../lib/types.ts"

interface SuperviseCliArgs {
  repoRoot?: string
  streamId?: string
  batch?: string
  port?: number
  noServer?: boolean
  dryRun?: boolean
  silent?: boolean
  timeoutMs?: number
  pollIntervalMs?: number
}

interface ResolvedSupervisorContext {
  repoRoot: string
  stream: { id: string; name: string }
  tasksFile: NonNullable<ReturnType<typeof readTasksFile>>
  streamDocument: StreamDocument
}

type InitialSupervisorAction = "launch" | "wait" | "review" | "stop"

interface SupervisorStartPlan {
  runId: string
  runStartedAt: string
  stageId: string
  initialBatchId: string
  action: InitialSupervisorAction
  message?: string
  reusingExistingRun: boolean
}

function printHelp(): void {
  console.log(`
work supervise - Run a supervised headless batch loop

Usage:
  work supervise [options]
  work supervise --batch "01.01" [options]

Options:
  --repo-root, -r        Repository root (auto-detected if omitted)
  --stream, -s           Workstream ID or name (uses current if not specified)
  --batch, -b            Start from a specific batch instead of the next incomplete batch
  --port, -p             OpenCode server port for the headless batch run
  --no-server            Skip starting opencode serve during the batch launch
  --silent               Disable notification sounds during batch execution
  --timeout-ms           Stop waiting for batch completion after this many milliseconds
  --poll-interval-ms     Poll interval while waiting for batch status (default: 1000)
  --dry-run              Show the planned supervisor actions without executing them
  --help, -h             Show this help message

Description:
  Resolves the next batch to supervise, launches headless batch execution,
  waits for persisted batch status, gathers review inputs from task reports
  plus canonical workstream state, records a normalized review result in
  supervisor-state.json, and then either continues, starts one fix-cycle
  re-run, or stops with a clear handoff.

Examples:
  work supervise
  work supervise --batch "03.01"
  work supervise --batch "03.01" --timeout-ms 300000
`)
}

function parseCliArgs(argv: string[]): SuperviseCliArgs | null {
  const args = argv.slice(2)
  const parsed: SuperviseCliArgs = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) return null
        parsed.repoRoot = next
        i++
        break
      case "--stream":
      case "-s":
        if (!next) return null
        parsed.streamId = next
        i++
        break
      case "--batch":
      case "-b":
        if (!next) return null
        parsed.batch = next
        i++
        break
      case "--port":
      case "-p":
        if (!next) return null
        parsed.port = Number(next)
        if (Number.isNaN(parsed.port)) return null
        i++
        break
      case "--timeout-ms":
        if (!next) return null
        parsed.timeoutMs = Number(next)
        if (Number.isNaN(parsed.timeoutMs)) return null
        i++
        break
      case "--poll-interval-ms":
        if (!next) return null
        parsed.pollIntervalMs = Number(next)
        if (Number.isNaN(parsed.pollIntervalMs)) return null
        i++
        break
      case "--no-server":
        parsed.noServer = true
        break
      case "--dry-run":
        parsed.dryRun = true
        break
      case "--silent":
        parsed.silent = true
        break
      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed
}

function findNextIncompleteBatch(tasks: Array<{ id: string; status: string }>): string | null {
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

function findNextBatchId(tasks: Array<{ id: string }>, currentBatchId: string): string | null {
  const batchIds = Array.from(
    new Set(
      tasks
        .map((task) => task.id.split("."))
        .filter((parts) => parts.length >= 2)
        .map((parts) => `${parts[0]}.${parts[1]}`),
    ),
  ).sort()

  const index = batchIds.indexOf(currentBatchId)
  if (index === -1) {
    return null
  }

  return batchIds[index + 1] ?? null
}

function createSupervisorRunId(stageId: string): string {
  return `sup-${stageId}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

function summarizeBatchStatus(status: Awaited<ReturnType<typeof waitForBatchStatus>>): string {
  return `${status.summary.completed}/${status.summary.total} completed, ${status.summary.failed} failed, ${status.summary.running} running, ${status.summary.pending} pending`
}

function printReviewSummary(batchId: string, reviewer: ReviewerResult): void {
  console.log(
    `[supervise] review ${batchId}: ${reviewer.alignment.status} (${reviewer.issues.length} issues, ${reviewer.missingOutputs.length} missing outputs)`,
  )

  if (reviewer.issues.length > 0) {
    for (const issue of reviewer.issues) {
      console.log(
        `  - [${issue.severity}] ${issue.summary} (${issue.ownership}, ${issue.difficulty}, ${issue.effort})`,
      )
    }
  }
}

function loadStreamDocument(repoRoot: string, streamId: string): StreamDocument {
  const planPath = getStreamPlanMdPath(repoRoot, streamId)
  if (!existsSync(planPath)) {
    throw new Error(`PLAN.md not found for stream ${streamId}`)
  }

  const errors: { message: string }[] = []
  const document = parseStreamDocument(readFileSync(planPath, "utf-8"), errors)
  if (!document) {
    throw new Error(
      `Could not parse PLAN.md for stream ${streamId}${errors.length > 0 ? `: ${errors.map((error) => error.message).join("; ")}` : ""}`,
    )
  }

  return document
}

async function runWorkMultiHeadless(args: {
  repoRoot: string
  streamId: string
  batchId: string
  port?: number
  noServer?: boolean
  silent?: boolean
}): Promise<void> {
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

function getSupervisorStateSnapshot(repoRoot: string, streamId: string): SupervisorStateFile {
  return loadSupervisorState(repoRoot, streamId) ?? createEmptySupervisorState(streamId)
}

function getPersistedRunMetadata(
  repoRoot: string,
  streamId: string,
  runId: string,
): Pick<SupervisorRunState, "reviewPasses" | "issueSummaryIds" | "escalationIds"> {
  const existingRun = getSupervisorStateSnapshot(repoRoot, streamId).runs.find(
    (run) => run.runId === runId,
  )

  return {
    reviewPasses: existingRun?.reviewPasses ?? 0,
    issueSummaryIds: existingRun?.issueSummaryIds ?? [],
    escalationIds: existingRun?.escalationIds ?? [],
  }
}

function getRunById(
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

function getLatestResumableBatchId(supervisorState: SupervisorStateFile): string | undefined {
  const activeRun = getRunById(supervisorState, supervisorState.active_run_id)
  if (activeRun?.status === "running" && activeRun.currentBatchId) {
    return activeRun.currentBatchId
  }

  return [...supervisorState.runs]
    .filter((run) => (run.status === "running" || run.status === "paused") && run.currentBatchId)
    .sort((left, right) =>
      new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )[0]?.currentBatchId
}

function getLatestReviewedBatch(
  supervisorState: SupervisorStateFile,
  runId: string,
  batchId: string,
): SupervisorReviewedBatch | undefined {
  return [...supervisorState.reviewed_batches]
    .filter((review) => review.runId === runId && review.batchId === batchId)
    .sort((left, right) => right.reviewPass - left.reviewPass)[0]
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

function isInterruptedFailureStop(stageStop: ReturnType<typeof getRunStageStop>): boolean {
  return stageStop?.reason === "failed"
}

function formatRecoveredStopMessage(args: {
  batchId: string
  run: SupervisorRunState
  review?: SupervisorReviewedBatch
  summary?: string
}): string {
  if (args.summary) {
    return `[supervise] stop: batch ${args.batchId} already has a persisted supervisor outcome from run ${args.run.runId}. ${args.summary}`
  }

  if (args.review?.notes) {
    return `[supervise] stop: batch ${args.batchId} already has a persisted supervisor outcome from run ${args.run.runId}. ${args.review.notes}`
  }

  return `[supervise] stop: batch ${args.batchId} already has a persisted supervisor outcome from run ${args.run.runId} (${args.run.status}).`
}

function isBatchWaitTimeoutError(error: unknown): error is Error {
  return error instanceof Error && /Timed out after \d+ms waiting for batch /.test(error.message)
}

async function recoverTerminalReviewOutcome(args: {
  repoRoot: string
  streamId: string
  tasksFile: NonNullable<ReturnType<typeof readTasksFile>>
  streamDocument: StreamDocument
  config: ReturnType<typeof loadSupervisorConfig>
  supervisorState: SupervisorStateFile
  run: SupervisorRunState
  review: SupervisorReviewedBatch
}): Promise<SupervisorStartPlan> {
  const { repoRoot, streamId, tasksFile, streamDocument, config, supervisorState, run, review } = args
  const cycleState = getSupervisorBatchCycleState({
    config,
    supervisorState,
    runId: run.runId,
    batchId: review.batchId,
  })

  if (review.outcome === "approved") {
    const stageBoundary = decideSupervisorStageBoundary({
      config,
      streamDocument,
      batchId: review.batchId,
      issues: [],
      fixCyclesUsed: cycleState.fixCyclesUsed,
    })

    if (stageBoundary.action !== "continue") {
      let escalationId: string | undefined
      if (stageBoundary.shouldContactUser) {
        escalationId = `${review.reviewId}-stage-escalation`
        await upsertEscalationOutcomeLocked(repoRoot, streamId, {
          escalationId,
          runId: run.runId,
          stageId: run.stageId,
          batchId: review.batchId,
          target: "stage",
          reason: stageBoundary.summary,
          status: "pending",
          escalatedAt: review.reviewedAt,
        })
      }

      await recordStageStopLocked(repoRoot, streamId, {
        stopId: `${review.reviewId}-stage-stop`,
        runId: run.runId,
        stageId: run.stageId,
        batchId: review.batchId,
        reason: stageBoundary.stopReason ?? "completed",
        summary: stageBoundary.summary,
        stoppedAt: review.reviewedAt,
        escalationId,
      })

      return {
        runId: run.runId,
        runStartedAt: run.startedAt,
        stageId: run.stageId,
        initialBatchId: review.batchId,
        action: "stop",
        message: formatRecoveredStopMessage({
          batchId: review.batchId,
          run,
          review,
          summary: stageBoundary.summary,
        }),
        reusingExistingRun: true,
      }
    }

    const nextBatchId = findNextBatchId(tasksFile.tasks, review.batchId)
    if (!nextBatchId) {
      await recordStageStopLocked(repoRoot, streamId, {
        stopId: `${review.reviewId}-final-stop`,
        runId: run.runId,
        stageId: run.stageId,
        batchId: review.batchId,
        reason: "completed",
        summary: `Supervisor completed the last known batch ${review.batchId}.`,
        stoppedAt: review.reviewedAt,
      })

      return {
        runId: run.runId,
        runStartedAt: run.startedAt,
        stageId: run.stageId,
        initialBatchId: review.batchId,
        action: "stop",
        message: formatRecoveredStopMessage({
          batchId: review.batchId,
          run,
          review,
          summary: `Supervisor completed the last known batch ${review.batchId}.`,
        }),
        reusingExistingRun: true,
      }
    }

    await upsertSupervisorRunLocked(repoRoot, streamId, {
      runId: run.runId,
      stageId: run.stageId,
      status: "running",
      startedAt: run.startedAt,
      updatedAt: new Date().toISOString(),
      currentBatchId: nextBatchId,
      reviewPasses: review.reviewPass,
      issueSummaryIds: run.issueSummaryIds,
      escalationIds: run.escalationIds,
    })

    const nextBatchStatus = await syncBatchStatus({
      repoRoot,
      streamId,
      batchId: nextBatchId,
    })

    return {
      runId: run.runId,
      runStartedAt: run.startedAt,
      stageId: run.stageId,
      initialBatchId: nextBatchId,
      action: nextBatchStatus.status === "running"
        ? "wait"
        : nextBatchStatus.status === "completed" || nextBatchStatus.status === "failed"
          ? "review"
          : "launch",
      message: `[supervise] resume: continuing persisted supervisor run ${run.runId} at batch ${nextBatchId}.`,
      reusingExistingRun: true,
    }
  }

  if (review.outcome === "changes_requested") {
    return {
      runId: run.runId,
      runStartedAt: run.startedAt,
      stageId: run.stageId,
      initialBatchId: review.batchId,
      action: cycleState.hasPendingReReview ? "launch" : "review",
      message: cycleState.hasPendingReReview
        ? `[supervise] resume: rerunning batch ${review.batchId} for pending fix-cycle review in run ${run.runId}.`
        : `[supervise] resume: batch ${review.batchId} already has persisted review output for run ${run.runId}.`,
      reusingExistingRun: true,
    }
  }

  const escalationId = `${review.reviewId}-escalation`
  await upsertEscalationOutcomeLocked(repoRoot, streamId, {
    escalationId,
    runId: run.runId,
    stageId: run.stageId,
    batchId: review.batchId,
    target: "operator",
    reason: review.notes ?? `Supervisor stopped after reviewing batch ${review.batchId}.`,
    status: "pending",
    escalatedAt: review.reviewedAt,
  })
  await recordStageStopLocked(repoRoot, streamId, {
    stopId: `${review.reviewId}-stop`,
    runId: run.runId,
    stageId: run.stageId,
    batchId: review.batchId,
    reason: review.stopReason ?? "operator_handoff",
    summary: review.notes ?? `Supervisor stopped after reviewing batch ${review.batchId}.`,
    stoppedAt: review.reviewedAt,
    escalationId,
  })

  return {
    runId: run.runId,
    runStartedAt: run.startedAt,
    stageId: run.stageId,
    initialBatchId: review.batchId,
    action: "stop",
    message: formatRecoveredStopMessage({
      batchId: review.batchId,
      run,
      review,
    }),
    reusingExistingRun: true,
  }
}

async function buildSupervisorStartPlan(args: {
  repoRoot: string
  streamId: string
  tasksFile: NonNullable<ReturnType<typeof readTasksFile>>
  streamDocument: StreamDocument
  config: ReturnType<typeof loadSupervisorConfig>
  requestedBatchId: string
}): Promise<SupervisorStartPlan> {
  const { repoRoot, streamId, tasksFile, streamDocument, config, requestedBatchId } = args
  const supervisorState = getSupervisorStateSnapshot(repoRoot, streamId)
  const recoveredRun = getRecoveredRunForBatch(supervisorState, requestedBatchId)

  if (!recoveredRun || (recoveredRun.currentBatchId && recoveredRun.currentBatchId !== requestedBatchId)) {
    const [stageId] = requestedBatchId.split(".")
    if (!stageId) {
      throw new Error(`Error: Invalid batch ID \"${requestedBatchId}\"`)
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
      initialBatchId: requestedBatchId,
      action: batchStatus.status === "running"
        ? "wait"
        : batchStatus.status === "completed" || batchStatus.status === "failed"
          ? "review"
          : "launch",
      message:
        batchStatus.status === "running"
          ? `[supervise] resume: waiting for in-progress batch ${requestedBatchId}.`
          : batchStatus.status === "completed" || batchStatus.status === "failed"
            ? `[supervise] resume: batch ${requestedBatchId} already reached ${batchStatus.status}; reviewing persisted results.`
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
  const latestReview = getLatestReviewedBatch(supervisorState, recoveredRun.runId, currentBatchId)
  const stageStop = getRunStageStop(supervisorState, recoveredRun.runId, currentBatchId)
  const interruptedFailureStop = isInterruptedFailureStop(stageStop)

  if (
    recoveredRun.status !== "running" &&
    recoveredRun.status !== "paused" &&
    !(interruptedFailureStop && (batchStatus.status === "completed" || batchStatus.status === "failed"))
  ) {
    return {
      runId: recoveredRun.runId,
      runStartedAt: recoveredRun.startedAt,
      stageId: recoveredRun.stageId,
      initialBatchId: requestedBatchId,
      action: "stop",
      message: formatRecoveredStopMessage({
        batchId: requestedBatchId,
        run: recoveredRun,
        summary: stageStop?.summary,
      }),
      reusingExistingRun: true,
    }
  }

  if (stageStop && !interruptedFailureStop) {
    return {
      runId: recoveredRun.runId,
      runStartedAt: recoveredRun.startedAt,
      stageId: recoveredRun.stageId,
      initialBatchId: currentBatchId,
      action: "stop",
      message: formatRecoveredStopMessage({
        batchId: currentBatchId,
        run: recoveredRun,
        review: latestReview,
        summary: stageStop.summary,
      }),
      reusingExistingRun: true,
    }
  }

  if (latestReview) {
    return recoverTerminalReviewOutcome({
      repoRoot,
      streamId,
      tasksFile,
      streamDocument,
      config,
      supervisorState,
      run: recoveredRun,
      review: latestReview,
    })
  }

  return {
    runId: recoveredRun.runId,
    runStartedAt: recoveredRun.startedAt,
    stageId: recoveredRun.stageId,
    initialBatchId: currentBatchId,
    action: batchStatus.status === "running"
      ? "wait"
      : batchStatus.status === "completed" || batchStatus.status === "failed"
        ? "review"
        : "launch",
    message:
      batchStatus.status === "running"
        ? `[supervise] resume: waiting for in-progress batch ${currentBatchId} from run ${recoveredRun.runId}.`
        : batchStatus.status === "completed" || batchStatus.status === "failed"
          ? `[supervise] resume: batch ${currentBatchId} already reached ${batchStatus.status}; reviewing persisted results from run ${recoveredRun.runId}.`
          : `[supervise] resume: relaunching persisted supervisor run ${recoveredRun.runId} at batch ${currentBatchId}.`,
    reusingExistingRun: true,
  }
}

async function markPendingFixCycles(args: {
  repoRoot: string
  streamId: string
  runId: string
  stageId: string
  batchId: string
  reviewId: string
  issueSummaryIds: string[]
  threadIds: string[]
  attempt: number
}): Promise<void> {
  const now = new Date().toISOString()

  for (const threadId of args.threadIds) {
    const cycleId = `${args.runId}-${args.batchId}-${threadId}-fix-${String(args.attempt).padStart(2, "0")}`
    await upsertFixCycleLocked(args.repoRoot, args.streamId, {
      cycleId,
      runId: args.runId,
      stageId: args.stageId,
      batchId: args.batchId,
      threadId,
      attemptCount: args.attempt,
      batchAttempt: args.attempt,
      triggeredByReviewId: args.reviewId,
      lastAttemptAt: now,
      lastOutcome: "pending_review",
      issueSummaryIds: args.issueSummaryIds,
    })
  }
}

async function resolvePendingFixCycles(args: {
  repoRoot: string
  streamId: string
  runId: string
  supervisorState: SupervisorStateFile
  batchId: string
  reviewId: string
  issueSummaryIds: string[]
  outcome: SupervisorFixCycle["lastOutcome"]
}): Promise<void> {
  const pendingCycles = args.supervisorState.fix_cycles.filter(
    (fixCycle) =>
      fixCycle.batchId === args.batchId &&
      fixCycle.runId === args.runId &&
      fixCycle.lastOutcome === "pending_review",
  )

  for (const fixCycle of pendingCycles) {
    await upsertFixCycleLocked(args.repoRoot, args.streamId, {
      ...fixCycle,
      reReviewId: args.reviewId,
      lastAttemptAt: new Date().toISOString(),
      lastOutcome: args.outcome,
      issueSummaryIds: Array.from(new Set([...fixCycle.issueSummaryIds, ...args.issueSummaryIds])),
    })
  }
}

async function resolveContext(cliArgs: SuperviseCliArgs): Promise<ResolvedSupervisorContext> {
  const repoRoot = cliArgs.repoRoot ?? getRepoRoot()
  const index = loadIndex(repoRoot)
  const stream = getResolvedStream(index, cliArgs.streamId)
  const tasksFile = readTasksFile(repoRoot, stream.id)
  if (!tasksFile) {
    throw new Error(`No tasks found for stream ${stream.id}`)
  }

  loadSupervisorConfig(repoRoot)

  return {
    repoRoot,
    stream,
    tasksFile,
    streamDocument: loadStreamDocument(repoRoot, stream.id),
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("Error: invalid supervise arguments")
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  let context: ResolvedSupervisorContext
  try {
    context = await resolveContext(cliArgs)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }

  const { repoRoot, stream, tasksFile, streamDocument } = context
  const config = loadSupervisorConfig(repoRoot)
  const reconciledRunIds = await reconcileSupervisorRunsLocked(repoRoot, stream.id)
  const reconciledSupervisorState = getSupervisorStateSnapshot(repoRoot, stream.id)
  const requestedBatchId =
    cliArgs.batch ??
    getLatestResumableBatchId(reconciledSupervisorState) ??
    findNextIncompleteBatch(tasksFile.tasks)

  if (!requestedBatchId) {
    console.log(`[supervise] No incomplete batches remain for ${stream.id}.`)
    return
  }

  const startPlan = await buildSupervisorStartPlan({
    repoRoot,
    streamId: stream.id,
    tasksFile,
    streamDocument,
    config,
    requestedBatchId,
  })

  if (startPlan.action === "stop") {
    console.log(startPlan.message ?? `[supervise] stop: batch ${startPlan.initialBatchId} is already terminal.`)
    return
  }

  if (reconciledRunIds.length > 0) {
    console.log(
      `[supervise] reconciled interrupted supervisor run${reconciledRunIds.length === 1 ? "" : "s"}: ${reconciledRunIds.join(", ")}`,
    )
  }

  if (cliArgs.dryRun) {
    console.log(`[supervise] dry run for stream ${stream.id}`)
    console.log(
      `[supervise] would ${startPlan.reusingExistingRun ? "resume" : "start"} supervisor run ${startPlan.runId}`,
    )
    if (startPlan.action === "launch") {
      console.log(
        `[supervise] would launch batch ${startPlan.initialBatchId} with work multi --headless --async`,
      )
    } else {
      console.log(
        `[supervise] would ${startPlan.action} existing batch ${startPlan.initialBatchId} from persisted state`,
      )
    }
    console.log("[supervise] would wait for batch-status, review outputs, and continue, fix, or stop.")
    return
  }

  const runId = startPlan.runId
  const runStartedAt = startPlan.runStartedAt
  const stageId = startPlan.stageId
  const persistedRunMetadata = getPersistedRunMetadata(repoRoot, stream.id, runId)

  if (!startPlan.reusingExistingRun) {
    await upsertSupervisorRunLocked(repoRoot, stream.id, {
      runId,
      stageId,
      status: "running",
      startedAt: runStartedAt,
      updatedAt: runStartedAt,
      currentBatchId: startPlan.initialBatchId,
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
    })

    console.log(`[supervise] starting run ${runId} for ${stream.id}`)
  } else {
    await clearSupervisorRunFailureStopLocked(
      repoRoot,
      stream.id,
      runId,
      startPlan.initialBatchId,
    )
    await upsertSupervisorRunLocked(repoRoot, stream.id, {
      runId,
      stageId,
      status: "running",
      startedAt: runStartedAt,
      updatedAt: new Date().toISOString(),
      currentBatchId: startPlan.initialBatchId,
      reviewPasses: persistedRunMetadata.reviewPasses,
      issueSummaryIds: persistedRunMetadata.issueSummaryIds,
      escalationIds: persistedRunMetadata.escalationIds,
    })
    console.log(startPlan.message ?? `[supervise] resume: continuing run ${runId}.`)
  }

  let currentBatchId: string | null = startPlan.initialBatchId
  let nextAction: Exclude<InitialSupervisorAction, "stop"> = startPlan.action
  let reuseExistingReview = startPlan.reusingExistingRun && startPlan.action === "review"

  try {
    while (currentBatchId) {
      let batchStatus: Awaited<ReturnType<typeof waitForBatchStatus>>

      if (nextAction === "launch") {
        console.log(`[supervise] start batch ${currentBatchId}`)
        await runWorkMultiHeadless({
          repoRoot,
          streamId: stream.id,
          batchId: currentBatchId,
          port: cliArgs.port,
          noServer: cliArgs.noServer,
          silent: cliArgs.silent,
        })
      }

      if (nextAction === "launch" || nextAction === "wait") {
        console.log(`[supervise] waiting for batch-status ${currentBatchId}`)
        batchStatus = await waitForBatchStatus({
          repoRoot,
          streamId: stream.id,
          batchId: currentBatchId,
          timeoutMs: cliArgs.timeoutMs,
          pollIntervalMs: cliArgs.pollIntervalMs,
        })
      } else {
        console.log(`[supervise] recovering terminal batch-status ${currentBatchId}`)
        batchStatus = await syncBatchStatus({
          repoRoot,
          streamId: stream.id,
          batchId: currentBatchId,
        })
      }

      console.log(`[supervise] batch ${currentBatchId} finished: ${batchStatus.status}`)
      console.log(`  ${summarizeBatchStatus(batchStatus)}`)

      const reviewInput = collectSupervisorReviewInput(repoRoot, stream.id, batchStatus)
      const reviewer = runDeterministicSupervisorReview(reviewInput)
      printReviewSummary(currentBatchId, reviewer)

      const supervisorState = getSupervisorStateSnapshot(repoRoot, stream.id)
      const persistedRun = getRunById(supervisorState, runId)
      const cycleState = getSupervisorBatchCycleState({
        config,
        supervisorState,
        runId,
        batchId: currentBatchId,
      })
      const existingReview = reuseExistingReview
        ? getLatestReviewedBatch(supervisorState, runId, currentBatchId)
        : undefined
      const reviewId = existingReview?.reviewId ?? `${runId}-${currentBatchId}-review-${String(cycleState.currentReviewPass).padStart(2, "0")}`
      const now = new Date().toISOString()
      const issueSummaryIds = existingReview?.issueSummaryIds ?? []

      if (!existingReview) {
        for (const [index, issue] of reviewer.issues.entries()) {
          const summaryId = `${reviewId}-issue-${String(index + 1).padStart(2, "0")}`
          issueSummaryIds.push(summaryId)
          await upsertIssueSummaryLocked(repoRoot, stream.id, {
            summaryId,
            runId,
            stageId,
            batchId: currentBatchId,
            status: "open",
            summary: issue.summary,
            severity: issue.severity,
            firstObservedAt: now,
            lastObservedAt: now,
          })
        }
      } else {
        console.log(
          `[supervise] resume review ${currentBatchId}: using persisted review ${existingReview.reviewId} (${existingReview.outcome})`,
        )
      }

      const followUp = existingReview
        ? undefined
        : decideSupervisorBatchFollowUp({
          config,
          supervisorState,
          runId,
          batchId: currentBatchId,
          issues: reviewer.issues,
        })

      if (followUp) {
        await upsertReviewedBatchLocked(repoRoot, stream.id, {
          reviewId,
          runId,
          stageId,
          batchId: currentBatchId,
          reviewPass: cycleState.currentReviewPass,
          reviewedAt: now,
          outcome: followUp.reviewOutcome,
          threadIds: batchStatus.threads.map((thread) => thread.threadId),
          issueSummaryIds,
          stopReason: followUp.stopReason,
          notes: followUp.summary,
        })
      }

      const resolvedReview = existingReview ?? {
        reviewId,
        runId,
        stageId,
        batchId: currentBatchId,
        reviewPass: cycleState.currentReviewPass,
        reviewedAt: now,
        outcome: followUp!.reviewOutcome,
        threadIds: batchStatus.threads.map((thread) => thread.threadId),
        issueSummaryIds,
        stopReason: followUp?.stopReason,
        notes: followUp?.summary,
      }

      if (cycleState.hasPendingReReview) {
        const lastOutcome = resolvedReview.outcome === "approved"
          ? "accepted"
          : resolvedReview.outcome === "escalated"
            ? "escalated"
            : "pending_review"

        if (lastOutcome !== "pending_review") {
          await resolvePendingFixCycles({
            repoRoot,
            streamId: stream.id,
            runId,
            supervisorState,
            batchId: currentBatchId,
            reviewId: resolvedReview.reviewId,
            issueSummaryIds,
            outcome: lastOutcome,
          })
        }
      }

      if (resolvedReview.outcome === "changes_requested") {
        const affectedThreadIds = getReviewAffectedThreadIds(reviewInput)
        const hasTriggeredFixCycles = supervisorState.fix_cycles.some(
          (fixCycle) =>
            fixCycle.runId === runId &&
            fixCycle.batchId === currentBatchId &&
            fixCycle.triggeredByReviewId === resolvedReview.reviewId,
        )

        if (!hasTriggeredFixCycles) {
          await markPendingFixCycles({
            repoRoot,
            streamId: stream.id,
            runId,
            stageId,
            batchId: currentBatchId,
            reviewId: resolvedReview.reviewId,
            issueSummaryIds,
            threadIds: affectedThreadIds.length > 0 ? affectedThreadIds : resolvedReview.threadIds,
            attempt: cycleState.fixCyclesUsed + 1,
          })
        }

        console.log(
          `[supervise] fix: ${resolvedReview.notes ?? `Batch ${currentBatchId} will run automatic fix cycle ${cycleState.fixCyclesUsed + 1}.`}`,
        )
        await upsertSupervisorRunLocked(repoRoot, stream.id, {
          runId,
          stageId,
          status: "running",
          startedAt: runStartedAt,
          updatedAt: new Date().toISOString(),
          currentBatchId,
          reviewPasses: followUp?.nextReviewPass ?? Math.max(cycleState.currentReviewPass, resolvedReview.reviewPass + 1),
          issueSummaryIds,
          escalationIds: persistedRun?.escalationIds ?? [],
        })
        nextAction = "launch"
        reuseExistingReview = false
        continue
      }

      if (resolvedReview.outcome === "escalated") {
        const escalationId = `${resolvedReview.reviewId}-escalation`
        await upsertEscalationOutcomeLocked(repoRoot, stream.id, {
          escalationId,
          runId,
          stageId,
          batchId: currentBatchId,
          target: "operator",
          reason: resolvedReview.notes ?? `Supervisor stopped after reviewing batch ${currentBatchId}.`,
          status: "pending",
          escalatedAt: resolvedReview.reviewedAt,
          notes: resolvedReview.notes,
        })
        await recordStageStopLocked(repoRoot, stream.id, {
          stopId: `${resolvedReview.reviewId}-stop`,
          runId,
          stageId,
          batchId: currentBatchId,
          reason: resolvedReview.stopReason ?? "operator_handoff",
          summary: resolvedReview.notes ?? `Supervisor stopped after reviewing batch ${currentBatchId}.`,
          stoppedAt: resolvedReview.reviewedAt,
          escalationId,
        })
        console.log(
          `[supervise] stop: user input required. ${resolvedReview.notes ?? `Supervisor stopped after reviewing batch ${currentBatchId}.`}`,
        )
        break
      }

      const stageBoundary = decideSupervisorStageBoundary({
        config,
        streamDocument,
        batchId: currentBatchId,
        issues: resolvedReview.outcome === "approved" ? [] : reviewer.issues,
        fixCyclesUsed: followUp?.cycleState.fixCyclesUsed ?? cycleState.fixCyclesUsed,
      })

      if (stageBoundary.action !== "continue") {
        let escalationId: string | undefined

        if (stageBoundary.shouldContactUser) {
          escalationId = `${resolvedReview.reviewId}-stage-escalation`
          await upsertEscalationOutcomeLocked(repoRoot, stream.id, {
            escalationId,
            runId,
            stageId,
            batchId: currentBatchId,
            target: "stage",
            reason: stageBoundary.summary,
            status: "pending",
            escalatedAt: resolvedReview.reviewedAt,
            notes: stageBoundary.escalation?.chatSummary,
          })
        }

        await recordStageStopLocked(repoRoot, stream.id, {
          stopId: `${resolvedReview.reviewId}-stage-stop`,
          runId,
          stageId,
          batchId: currentBatchId,
          reason: stageBoundary.stopReason ?? "completed",
          summary: stageBoundary.summary,
          stoppedAt: resolvedReview.reviewedAt,
          escalationId,
        })
        console.log(
          `[supervise] stop: ${stageBoundary.shouldContactUser ? "user input required" : "stage boundary reached"}. ${stageBoundary.summary}`,
        )
        break
      }

      const nextBatchId = findNextBatchId(tasksFile.tasks, currentBatchId)
      if (!nextBatchId) {
        await recordStageStopLocked(repoRoot, stream.id, {
          stopId: `${resolvedReview.reviewId}-final-stop`,
          runId,
          stageId,
          batchId: currentBatchId,
          reason: "completed",
          summary: `Supervisor completed the last known batch ${currentBatchId}.`,
          stoppedAt: resolvedReview.reviewedAt,
        })
        console.log(`[supervise] stop: no remaining batches after ${currentBatchId}.`)
        break
      }

      console.log(`[supervise] continue: ${currentBatchId} approved; moving to ${nextBatchId}.`)
      currentBatchId = nextBatchId
      nextAction = "launch"
      reuseExistingReview = false
      await upsertSupervisorRunLocked(repoRoot, stream.id, {
        runId,
        stageId,
        status: "running",
        startedAt: runStartedAt,
        updatedAt: new Date().toISOString(),
        currentBatchId,
        reviewPasses: resolvedReview.reviewPass,
        issueSummaryIds,
        escalationIds: persistedRun?.escalationIds ?? [],
      })
    }
  } catch (error) {
    if (isBatchWaitTimeoutError(error)) {
      await upsertSupervisorRunLocked(repoRoot, stream.id, {
        runId,
        stageId,
        status: "running",
        startedAt: runStartedAt,
        updatedAt: new Date().toISOString(),
        currentBatchId: currentBatchId ?? undefined,
        reviewPasses: persistedRunMetadata.reviewPasses,
        issueSummaryIds: persistedRunMetadata.issueSummaryIds,
        escalationIds: persistedRunMetadata.escalationIds,
      })
      console.log(
        `[supervise] timeout: ${error.message} The batch may still be running; rerun work supervise to resume deterministically.`,
      )
      throw error
    }

    await recordStageStopLocked(repoRoot, stream.id, {
      stopId: `${runId}-error-stop`,
      runId,
      stageId,
      batchId: currentBatchId ?? undefined,
      reason: "failed",
      summary: `Supervisor run failed: ${(error as Error).message}`,
      stoppedAt: new Date().toISOString(),
    })
    throw error
  }
}

if (import.meta.main) {
  await main()
}
