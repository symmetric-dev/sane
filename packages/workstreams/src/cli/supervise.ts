import { getRepoRoot } from "../lib/repo.ts"
import { getResolvedStream, loadIndex } from "../lib/index.ts"
import { syncBatchStatus, waitForBatchStatus } from "../lib/batch-monitor.ts"
import { readTasksFile } from "../lib/tasks.ts"
import {
  clearSupervisorRunFailureStopLocked,
  pauseSupervisorRunLocked,
  reconcileSupervisorRunsLocked,
  upsertBranchSessionLocked,
  upsertSupervisorRunLocked,
} from "../lib/supervisor-state.ts"
import {
  buildRootAgentBranchSession,
  createRootAgentBranchSessionId,
  getRootAgentBranchSource,
  type RootAgentBranchContext,
  waitForRootAgentBranchNativeSessionId,
} from "../lib/root-agent-branch.ts"
import {
  buildSupervisionExecutionPlan,
  findNextIncompleteBatch,
  getLatestResumableBatchId,
  getRunById,
  getSupervisorStateSnapshot,
  launchHeadlessBatchExecution,
  summarizeBatchStatus,
  type SupervisionExecutionAction,
} from "../lib/supervision-helper.ts"

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
  rootSessionId?: string
  branchSessionId?: string
  parentSessionId?: string
  parentBranchSessionId?: string
  checkpointMessageId?: string
  checkpointMessageIndex?: number
  checkpointCreatedAt?: string
  nativeBranchSessionId?: string
}

interface ResolvedSupervisorContext {
  repoRoot: string
  stream: { id: string; name: string }
  tasksFile: NonNullable<ReturnType<typeof readTasksFile>>
}

function printHelp(): void {
  console.log(`
work supervise - Run a thin headless batch execution helper

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
  --root-session-id      Root Agent session ID for lineage metadata
  --branch-session-id    Repo-local branch session ID for this supervision branch
  --parent-session-id    Parent native session ID when this branch was forked
  --parent-branch-session-id  Parent repo-local branch session ID for nested flows
  --checkpoint-message-id     Root-session checkpoint message ID for this branch launch
  --checkpoint-message-index  Deterministic checkpoint message index fallback
  --checkpoint-created-at     ISO timestamp when checkpoint metadata was created
  --native-branch-session-id  Native opencode session ID for this branch (optional)
  --dry-run              Show the planned helper actions without executing them
  --help, -h             Show this help message

Description:
  Resolves the next batch to execute or recover, launches headless batch
  execution when needed, waits for or recovers persisted batch-status,
  reconciles stale runs, and then hands terminal batch results back to the
  caller so Root Agent review/fix/escalation policy stays outside the CLI.

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
      case "--root-session-id":
        if (!next) return null
        parsed.rootSessionId = next
        i++
        break
      case "--branch-session-id":
        if (!next) return null
        parsed.branchSessionId = next
        i++
        break
      case "--parent-session-id":
        if (!next) return null
        parsed.parentSessionId = next
        i++
        break
      case "--parent-branch-session-id":
        if (!next) return null
        parsed.parentBranchSessionId = next
        i++
        break
      case "--checkpoint-message-id":
        if (!next) return null
        parsed.checkpointMessageId = next
        i++
        break
      case "--checkpoint-message-index":
        if (!next) return null
        parsed.checkpointMessageIndex = Number(next)
        if (Number.isNaN(parsed.checkpointMessageIndex)) return null
        i++
        break
      case "--checkpoint-created-at":
        if (!next) return null
        parsed.checkpointCreatedAt = next
        i++
        break
      case "--native-branch-session-id":
        if (!next) return null
        parsed.nativeBranchSessionId = next
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

function isBatchWaitTimeoutError(error: unknown): error is Error {
  return error instanceof Error && /Timed out after \d+ms waiting for batch /.test(error.message)
}

export async function resolveRootAgentBranchContext(
  cliArgs: SuperviseCliArgs,
  repoRoot: string,
  streamId: string,
): Promise<RootAgentBranchContext | null> {
  if (!cliArgs.rootSessionId) {
    return null
  }

  const branchSessionId = cliArgs.branchSessionId ?? createRootAgentBranchSessionId("supervision")
  const nativeSessionId =
    cliArgs.nativeBranchSessionId ??
    (cliArgs.branchSessionId
      ? await waitForRootAgentBranchNativeSessionId({
          repoRoot,
          streamId,
          branchSessionId,
          timeoutMs: 5000,
          pollIntervalMs: 100,
        })
      : undefined)

  return {
    rootSessionId: cliArgs.rootSessionId,
    branchSessionId,
    ...(cliArgs.checkpointMessageId ? { checkpointMessageId: cliArgs.checkpointMessageId } : {}),
    ...(typeof cliArgs.checkpointMessageIndex === "number"
      ? { checkpointMessageIndex: cliArgs.checkpointMessageIndex }
      : {}),
    ...(cliArgs.checkpointCreatedAt
      ? { checkpointCreatedAt: cliArgs.checkpointCreatedAt }
      : {}),
    ...(cliArgs.parentSessionId ? { parentSessionId: cliArgs.parentSessionId } : {}),
    ...(cliArgs.parentBranchSessionId
      ? { parentBranchSessionId: cliArgs.parentBranchSessionId }
      : {}),
    ...(nativeSessionId ? { nativeSessionId } : {}),
    source: getRootAgentBranchSource(nativeSessionId),
  }
}

async function recordSupervisionBranchSession(args: {
  repoRoot: string
  streamId: string
  branchContext: RootAgentBranchContext | null
  status: "running" | "completed" | "stopped" | "failed"
  runId: string
  batchId: string
  startedAt: string
  updatedAt?: string
  completedAt?: string
  notes?: string
}): Promise<void> {
  if (!args.branchContext) {
    return
  }

  const timestamp = args.updatedAt ?? new Date().toISOString()
  await upsertBranchSessionLocked(
    args.repoRoot,
    args.streamId,
    buildRootAgentBranchSession({
      context: args.branchContext,
      branchRole: "supervision",
      status: args.status,
      startedAt: args.startedAt,
      updatedAt: timestamp,
      completedAt: args.completedAt,
      runId: args.runId,
      batchId: args.batchId,
      notes: args.notes,
    }),
  )
}

function getDryRunActionMessage(action: Exclude<SupervisionExecutionAction, "stop">, batchId: string): string {
  switch (action) {
    case "launch":
      return `[supervise] would launch batch ${batchId} with work multi --headless --async`
    case "wait":
      return `[supervise] would wait for in-progress batch ${batchId}`
    case "recover":
      return `[supervise] would recover terminal batch ${batchId} from persisted state`
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

  return {
    repoRoot,
    stream,
    tasksFile,
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

  const { repoRoot, stream, tasksFile } = context
  const branchContext = await resolveRootAgentBranchContext(cliArgs, repoRoot, stream.id)
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

  const startPlan = await buildSupervisionExecutionPlan({
    repoRoot,
    streamId: stream.id,
    requestedBatchId,
  })

  if (startPlan.action === "stop") {
    console.log(startPlan.message ?? `[supervise] stop: batch ${startPlan.batchId} is already terminal.`)
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
    if (branchContext) {
      console.log(
        `[supervise] would record supervision branch ${branchContext.branchSessionId} under root session ${branchContext.rootSessionId}`,
      )
    }
    console.log(getDryRunActionMessage(startPlan.action, startPlan.batchId))
    console.log(
      `[supervise] would record a supervise-pass handoff for ${startPlan.batchId} and yield batch state back to the Root Agent or caller for review decisions.`,
    )
    return
  }

  const persistedRun = getRunById(getSupervisorStateSnapshot(repoRoot, stream.id), startPlan.runId)
  const persistedRunMetadata = {
    reviewPasses: persistedRun?.reviewPasses ?? 0,
    issueSummaryIds: persistedRun?.issueSummaryIds ?? [],
    escalationIds: persistedRun?.escalationIds ?? [],
  }

  if (!startPlan.reusingExistingRun) {
    await upsertSupervisorRunLocked(repoRoot, stream.id, {
      runId: startPlan.runId,
      stageId: startPlan.stageId,
      status: "running",
      startedAt: startPlan.runStartedAt,
      updatedAt: startPlan.runStartedAt,
      currentBatchId: startPlan.batchId,
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
      rootSessionId: branchContext?.rootSessionId,
      branchSessionId: branchContext?.branchSessionId,
    })

    console.log(`[supervise] starting run ${startPlan.runId} for ${stream.id}`)
  } else {
    await clearSupervisorRunFailureStopLocked(
      repoRoot,
      stream.id,
      startPlan.runId,
      startPlan.batchId,
    )
    await upsertSupervisorRunLocked(repoRoot, stream.id, {
      runId: startPlan.runId,
      stageId: startPlan.stageId,
      status: "running",
      startedAt: startPlan.runStartedAt,
      updatedAt: new Date().toISOString(),
      currentBatchId: startPlan.batchId,
      reviewPasses: persistedRunMetadata.reviewPasses,
      issueSummaryIds: persistedRunMetadata.issueSummaryIds,
      escalationIds: persistedRunMetadata.escalationIds,
      rootSessionId: branchContext?.rootSessionId ?? persistedRun?.rootSessionId,
      branchSessionId: branchContext?.branchSessionId ?? persistedRun?.branchSessionId,
      completedAt: undefined,
      stageStopId: undefined,
      stopReason: undefined,
    })
    console.log(startPlan.message ?? `[supervise] resume: continuing run ${startPlan.runId}.`)
  }

  await recordSupervisionBranchSession({
    repoRoot,
    streamId: stream.id,
    branchContext,
    status: "running",
    runId: startPlan.runId,
    batchId: startPlan.batchId,
    startedAt: startPlan.runStartedAt,
    updatedAt: new Date().toISOString(),
    notes: startPlan.message
      ? `${startPlan.message} Branch session remains active until the parent/root records the final supervision outcome.`
      : "Supervision helper started; branch session remains active until parent/root finalization.",
  })

  try {
    if (startPlan.action === "launch") {
      console.log(`[supervise] start batch ${startPlan.batchId}`)
      await launchHeadlessBatchExecution({
        repoRoot,
        streamId: stream.id,
        batchId: startPlan.batchId,
        port: cliArgs.port,
        noServer: cliArgs.noServer,
        silent: cliArgs.silent,
        rootSessionId: branchContext?.rootSessionId,
        parentSessionId: branchContext?.nativeSessionId ?? branchContext?.parentSessionId,
        parentBranchSessionId: branchContext?.branchSessionId,
        branchRole: "supervision",
      })
    }

    const batchStatus: Awaited<ReturnType<typeof waitForBatchStatus>> =
      startPlan.action === "recover"
        ? await (async () => {
            console.log(`[supervise] recovering terminal batch-status ${startPlan.batchId}`)
            return startPlan.resolvedBatchStatus ?? syncBatchStatus({
              repoRoot,
              streamId: stream.id,
              batchId: startPlan.batchId,
            })
          })()
        : await (async () => {
            console.log(`[supervise] waiting for batch-status ${startPlan.batchId}`)
            return waitForBatchStatus({
              repoRoot,
              streamId: stream.id,
              batchId: startPlan.batchId,
              timeoutMs: cliArgs.timeoutMs,
              pollIntervalMs: cliArgs.pollIntervalMs,
            })
          })()

    console.log(`[supervise] batch ${startPlan.batchId} finished: ${batchStatus.status}`)
    console.log(`  ${summarizeBatchStatus(batchStatus)}`)

    await pauseSupervisorRunLocked(repoRoot, stream.id, {
      runId: startPlan.runId,
      currentBatchId: startPlan.batchId,
      updatedAt: batchStatus.completedAt ?? batchStatus.updatedAt,
    })

    await recordSupervisionBranchSession({
      repoRoot,
      streamId: stream.id,
      branchContext,
      status: "running",
      runId: startPlan.runId,
      batchId: startPlan.batchId,
      startedAt: startPlan.runStartedAt,
      updatedAt: batchStatus.completedAt ?? batchStatus.updatedAt,
      completedAt: undefined,
      notes: `Recorded supervise-pass handoff for ${startPlan.batchId} (${batchStatus.status}); waiting for parent/root review, fix, or escalation finalization.`,
    })

    console.log(
      `[supervise] handoff: batch ${startPlan.batchId} reached ${batchStatus.status}. Root Agent should review outputs and decide next steps; branch finalization happens parent-side.`,
    )
  } catch (error) {
    if (isBatchWaitTimeoutError(error)) {
      await upsertSupervisorRunLocked(repoRoot, stream.id, {
        runId: startPlan.runId,
        stageId: startPlan.stageId,
        status: "running",
        startedAt: startPlan.runStartedAt,
        updatedAt: new Date().toISOString(),
        currentBatchId: startPlan.batchId,
        reviewPasses: persistedRunMetadata.reviewPasses,
        issueSummaryIds: persistedRunMetadata.issueSummaryIds,
        escalationIds: persistedRunMetadata.escalationIds,
        rootSessionId: branchContext?.rootSessionId ?? persistedRun?.rootSessionId,
        branchSessionId: branchContext?.branchSessionId ?? persistedRun?.branchSessionId,
        completedAt: undefined,
        stageStopId: undefined,
        stopReason: undefined,
      })
      await recordSupervisionBranchSession({
        repoRoot,
        streamId: stream.id,
        branchContext,
        status: "stopped",
        runId: startPlan.runId,
        batchId: startPlan.batchId,
        startedAt: startPlan.runStartedAt,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        notes: `Supervision helper stopped before handoff while waiting for ${startPlan.batchId}; Root Agent should resume or inspect persisted state.`,
      })
      console.log(
        `[supervise] timeout: ${error.message} The batch may still be running; rerun work supervise to resume deterministically.`,
      )
      throw error
    }

    await upsertSupervisorRunLocked(repoRoot, stream.id, {
      runId: startPlan.runId,
      stageId: startPlan.stageId,
      status: "failed",
      startedAt: startPlan.runStartedAt,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
        currentBatchId: startPlan.batchId,
        reviewPasses: persistedRunMetadata.reviewPasses,
        issueSummaryIds: persistedRunMetadata.issueSummaryIds,
        escalationIds: persistedRunMetadata.escalationIds,
        rootSessionId: branchContext?.rootSessionId ?? persistedRun?.rootSessionId,
        branchSessionId: branchContext?.branchSessionId ?? persistedRun?.branchSessionId,
        stageStopId: undefined,
        stopReason: undefined,
      })
    await recordSupervisionBranchSession({
      repoRoot,
      streamId: stream.id,
      branchContext,
      status: "failed",
      runId: startPlan.runId,
      batchId: startPlan.batchId,
      startedAt: startPlan.runStartedAt,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      notes: `Supervision helper failed before parent/root finalization: ${(error as Error).message}`,
    })
    throw error
  }
}

if (import.meta.main) {
  await main()
}
