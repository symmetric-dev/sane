import { spawn } from "child_process"
import { randomUUID } from "crypto"
import { existsSync, readFileSync } from "fs"
import { fileURLToPath } from "url"
import { getRepoRoot } from "../lib/repo.ts"
import { getResolvedStream, loadIndex } from "../lib/index.ts"
import { getStreamPlanMdPath } from "../lib/consolidate.ts"
import { waitForBatchStatus } from "../lib/batch-monitor.ts"
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
  createEmptySupervisorState,
  loadSupervisorState,
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
import type { StreamDocument, SupervisorFixCycle, SupervisorStateFile } from "../lib/types.ts"

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
  const initialBatchId = cliArgs.batch ?? findNextIncompleteBatch(tasksFile.tasks)

  if (!initialBatchId) {
    console.log(`[supervise] No incomplete batches remain for ${stream.id}.`)
    return
  }

  const [stageId] = initialBatchId.split(".")
  if (!stageId) {
    console.error(`Error: Invalid batch ID \"${initialBatchId}\"`)
    process.exit(1)
  }

  const runId = createSupervisorRunId(stageId)
  const runStartedAt = new Date().toISOString()

  if (cliArgs.dryRun) {
    console.log(`[supervise] dry run for stream ${stream.id}`)
    console.log(`[supervise] would start supervisor run ${runId}`)
    console.log(`[supervise] would launch batch ${initialBatchId} with work multi --headless --async`)
    console.log("[supervise] would wait for batch-status, review outputs, and continue, fix, or stop.")
    return
  }

  await upsertSupervisorRunLocked(repoRoot, stream.id, {
    runId,
    stageId,
    status: "running",
    startedAt: runStartedAt,
    updatedAt: runStartedAt,
    currentBatchId: initialBatchId,
    reviewPasses: 0,
    issueSummaryIds: [],
    escalationIds: [],
  })

  console.log(`[supervise] starting run ${runId} for ${stream.id}`)

  let currentBatchId: string | null = initialBatchId

  try {
    while (currentBatchId) {
      console.log(`[supervise] start batch ${currentBatchId}`)
      await runWorkMultiHeadless({
        repoRoot,
        streamId: stream.id,
        batchId: currentBatchId,
        port: cliArgs.port,
        noServer: cliArgs.noServer,
        silent: cliArgs.silent,
      })

      console.log(`[supervise] waiting for batch-status ${currentBatchId}`)
      const batchStatus = await waitForBatchStatus({
        repoRoot,
        streamId: stream.id,
        batchId: currentBatchId,
        timeoutMs: cliArgs.timeoutMs,
        pollIntervalMs: cliArgs.pollIntervalMs,
      })

      console.log(`[supervise] batch ${currentBatchId} finished: ${batchStatus.status}`)
      console.log(`  ${summarizeBatchStatus(batchStatus)}`)

      const reviewInput = collectSupervisorReviewInput(repoRoot, stream.id, batchStatus)
      const reviewer = runDeterministicSupervisorReview(reviewInput)
      printReviewSummary(currentBatchId, reviewer)

      const supervisorState = getSupervisorStateSnapshot(repoRoot, stream.id)
      const cycleState = getSupervisorBatchCycleState({
        config,
        supervisorState,
        runId,
        batchId: currentBatchId,
      })
      const reviewId = `${runId}-${currentBatchId}-review-${String(cycleState.currentReviewPass).padStart(2, "0")}`
      const issueSummaryIds: string[] = []
      const now = new Date().toISOString()

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

      const followUp = decideSupervisorBatchFollowUp({
        config,
        supervisorState,
        runId,
        batchId: currentBatchId,
        issues: reviewer.issues,
      })

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

      if (cycleState.hasPendingReReview) {
        const lastOutcome = followUp.action === "approve_batch"
          ? "accepted"
          : followUp.action === "contact_user"
            ? "escalated"
            : "pending_review"

        if (lastOutcome !== "pending_review") {
          await resolvePendingFixCycles({
            repoRoot,
            streamId: stream.id,
            runId,
            supervisorState,
            batchId: currentBatchId,
            reviewId,
            issueSummaryIds,
            outcome: lastOutcome,
          })
        }
      }

      if (followUp.action === "run_fix_cycle") {
        const affectedThreadIds = getReviewAffectedThreadIds(reviewInput)
        await markPendingFixCycles({
          repoRoot,
          streamId: stream.id,
          runId,
          stageId,
          batchId: currentBatchId,
          reviewId,
          issueSummaryIds,
          threadIds: affectedThreadIds.length > 0 ? affectedThreadIds : batchStatus.threads.map((thread) => thread.threadId),
          attempt: followUp.nextFixCycleAttempt ?? cycleState.fixCyclesUsed + 1,
        })

        console.log(`[supervise] fix: ${followUp.summary}`)
        await upsertSupervisorRunLocked(repoRoot, stream.id, {
          runId,
          stageId,
          status: "running",
          startedAt: runStartedAt,
          updatedAt: new Date().toISOString(),
          currentBatchId,
          reviewPasses: followUp.nextReviewPass ?? cycleState.currentReviewPass,
          issueSummaryIds,
          escalationIds: [],
        })
        continue
      }

      if (followUp.action === "contact_user") {
        const escalationId = `${reviewId}-escalation`
        await upsertEscalationOutcomeLocked(repoRoot, stream.id, {
          escalationId,
          runId,
          stageId,
          batchId: currentBatchId,
          target: "operator",
          reason: followUp.summary,
          status: "pending",
          escalatedAt: now,
          notes: followUp.escalation.chatSummary,
        })
        await recordStageStopLocked(repoRoot, stream.id, {
          stopId: `${reviewId}-stop`,
          runId,
          stageId,
          batchId: currentBatchId,
          reason: followUp.stopReason ?? "operator_handoff",
          summary: followUp.summary,
          stoppedAt: now,
          escalationId,
        })
        console.log(`[supervise] stop: user input required. ${followUp.summary}`)
        break
      }

      const stageBoundary = decideSupervisorStageBoundary({
        config,
        streamDocument,
        batchId: currentBatchId,
        issues: reviewer.issues,
        fixCyclesUsed: followUp.cycleState.fixCyclesUsed,
      })

      if (stageBoundary.action !== "continue") {
        let escalationId: string | undefined

        if (stageBoundary.shouldContactUser) {
          escalationId = `${reviewId}-stage-escalation`
          await upsertEscalationOutcomeLocked(repoRoot, stream.id, {
            escalationId,
            runId,
            stageId,
            batchId: currentBatchId,
            target: "stage",
            reason: stageBoundary.summary,
            status: "pending",
            escalatedAt: now,
            notes: stageBoundary.escalation?.chatSummary,
          })
        }

        await recordStageStopLocked(repoRoot, stream.id, {
          stopId: `${reviewId}-stage-stop`,
          runId,
          stageId,
          batchId: currentBatchId,
          reason: stageBoundary.stopReason ?? "completed",
          summary: stageBoundary.summary,
          stoppedAt: now,
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
          stopId: `${reviewId}-final-stop`,
          runId,
          stageId,
          batchId: currentBatchId,
          reason: "completed",
          summary: `Supervisor completed the last known batch ${currentBatchId}.`,
          stoppedAt: now,
        })
        console.log(`[supervise] stop: no remaining batches after ${currentBatchId}.`)
        break
      }

      console.log(`[supervise] continue: ${currentBatchId} approved; moving to ${nextBatchId}.`)
      currentBatchId = nextBatchId
      await upsertSupervisorRunLocked(repoRoot, stream.id, {
        runId,
        stageId,
        status: "running",
        startedAt: runStartedAt,
        updatedAt: new Date().toISOString(),
        currentBatchId,
        reviewPasses: cycleState.currentReviewPass,
        issueSummaryIds,
        escalationIds: [],
      })
    }
  } catch (error) {
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
