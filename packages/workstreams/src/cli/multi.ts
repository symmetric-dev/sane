/**
 * CLI: Multi
 *
 * Executes all threads in a batch in parallel using tmux sessions.
 * Each thread runs in its own tmux window with an opencode instance
 * connected to a shared opencode serve backend.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { loadAgentsConfig } from "../lib/agents-yaml.ts"
import {
  readTasksFile,
  parseTaskId,
  generateSessionId,
  startMultipleSessionsLocked,
  getBatchMetadata,
} from "../lib/tasks.ts"
import type { Task, ThreadInfo, ThreadSessionMap } from "../lib/types.ts"
import { MAX_THREADS_PER_BATCH } from "../lib/types.ts"
import type { MultiCliArgs } from "../lib/multi-types.ts"
import { buildRootAgentLineage } from "../lib/root-agent-branch.ts"
import {
  sessionExists,
  attachSession,
  getWorkSessionName,
  buildCreateSessionCommand,
  buildAddWindowCommand,
  buildAttachCommand,
  waitForAllPanesExit,
} from "../lib/tmux.ts"
import { getStageApprovalStatus } from "../lib/approval.ts"
import {
  isServerRunning,
  startServer,
  waitForServer,
  buildServeCommand,
} from "../lib/opencode.ts"
import { NotificationTracker } from "../lib/notifications.ts"
import { parseBatchId } from "../lib/cli-utils.ts"
import {
  collectThreadInfoFromTasks,
  buildThreadRunCommand,
  setupTmuxSession,
  setupGridController,
  setupKillSessionKeybind,
  validateThreadPrompts,
} from "../lib/multi-orchestrator.ts"
import { startMarkerPolling } from "../lib/marker-polling.ts"
import { finalizeMultiRun } from "../lib/multi-finalization.ts"
import { resetBatchStatusRun, startDetachedBatchMonitor } from "../lib/batch-monitor.ts"

const DEFAULT_PORT = 4096

function printHelp(): void {
  console.log(`
work multi - Execute all threads in a batch in parallel

Usage:
  work multi --batch "01.01" [options]
  work multi --continue [options]

Required:
  --batch, -b      Batch ID to execute (format: "SS.BB", e.g., "01.02")
                   OR uses next incomplete batch if --continue is set

Optional:
  --continue, -c   Continue with the next incomplete batch
  --stream, -s     Workstream ID or name (uses current if not specified)
  --port, -p       OpenCode server port (default: 4096)
  --dry-run        Show commands without executing
  --no-server      Skip starting opencode serve (assume already running)
  --headless       Request non-interactive batch execution
  --async          Return after starting the batch (requires --headless)
  --silent         Disable notification sounds (audio only)
  --root-session-id        Root Agent session ID for lineage metadata
  --parent-session-id      Parent native session ID when launched from a branch
  --parent-branch-session-id  Parent repo-local branch session ID
  --branch-role            Branch role for spawned thread sessions (supervision|fix)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Executes all threads in a batch simultaneously in parallel using tmux.
  Each thread runs in its own tmux window with a full opencode TUI.

  A shared opencode serve backend is started (unless --no-server) to
  eliminate MCP cold boot times and share model cache across threads.

  Headless mode is intended for non-interactive callers. Async mode is a
  headless-only variant that returns control immediately after startup.

Examples:
  work multi --batch "01.01"
  work multi --continue
  work multi --batch "01.01" --headless
  work multi --batch "01.01" --headless --async
  work multi --batch "01.01" --dry-run
  work multi --continue --dry-run
`)
}

export function parseCliArgs(argv: string[]): MultiCliArgs | null {
  const args = argv.slice(2)
  const parsed: Partial<MultiCliArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value")
          return null
        }
        parsed.repoRoot = next
        i++
        break

      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value")
          return null
        }
        parsed.streamId = next
        i++
        break

      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value")
          return null
        }
        parsed.batch = next
        i++
        break

      case "--continue":
      case "-c":
        parsed.continue = true
        break

      case "--port":
      case "-p":
        if (!next) {
          console.error("Error: --port requires a value")
          return null
        }
        parsed.port = parseInt(next, 10)
        if (isNaN(parsed.port)) {
          console.error("Error: --port must be a number")
          return null
        }
        i++
        break

      case "--dry-run":
        parsed.dryRun = true
        break

      case "--no-server":
        parsed.noServer = true
        break

      case "--headless":
        parsed.headless = true
        break

      case "--async":
        parsed.async = true
        break

      case "--silent":
        parsed.silent = true
        break

      case "--root-session-id":
        if (!next) {
          console.error("Error: --root-session-id requires a value")
          return null
        }
        parsed.rootSessionId = next
        i++
        break

      case "--parent-session-id":
        if (!next) {
          console.error("Error: --parent-session-id requires a value")
          return null
        }
        parsed.parentSessionId = next
        i++
        break

      case "--parent-branch-session-id":
        if (!next) {
          console.error("Error: --parent-branch-session-id requires a value")
          return null
        }
        parsed.parentBranchSessionId = next
        i++
        break

      case "--branch-role":
        if (!next || (next !== "supervision" && next !== "fix")) {
          console.error("Error: --branch-role must be supervision or fix")
          return null
        }
        parsed.branchRole = next
        i++
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed as MultiCliArgs
}

export function validateCliArgs(cliArgs: MultiCliArgs): string | null {
  if (cliArgs.async && !cliArgs.headless) {
    return "--async requires --headless"
  }

  return null
}

export function buildRootAgentThreadSessionLineage(
  cliArgs: MultiCliArgs,
  sessionId: string,
) {
  if (!cliArgs.rootSessionId) {
    return undefined
  }

  return buildRootAgentLineage({
    context: {
      rootSessionId: cliArgs.rootSessionId,
      branchSessionId: sessionId,
      ...(cliArgs.parentBranchSessionId
        ? { parentBranchSessionId: cliArgs.parentBranchSessionId }
        : {}),
      ...(cliArgs.parentSessionId ? { parentSessionId: cliArgs.parentSessionId } : {}),
    },
    branchRole: cliArgs.branchRole ?? "supervision",
    source:
      cliArgs.parentBranchSessionId &&
      cliArgs.parentSessionId &&
      cliArgs.parentSessionId !== cliArgs.rootSessionId
        ? "native_fork"
        : "repo_local_fallback",
  })
}

/**
 * Find the next incomplete batch based on tasks
 */
export function findNextIncompleteBatch(tasks: Task[]): string | null {
  // Group tasks by batch ID "SS.BB"
  const batches = new Map<string, Task[]>()

  for (const task of tasks) {
    try {
      const parsed = parseTaskId(task.id)
      if (!parsed) continue

      const batchId = `${parsed.stage.toString().padStart(2, "0")}.${parsed.batch.toString().padStart(2, "0")}`

      if (!batches.has(batchId)) {
        batches.set(batchId, [])
      }
      batches.get(batchId)!.push(task)
    } catch {
      // Ignore invalid task IDs
    }
  }

  // Sort batch IDs to check in order
  const sortedBatchIds = Array.from(batches.keys()).sort()

  // Find first batch that is not fully complete
  for (const batchId of sortedBatchIds) {
    const batchTasks = batches.get(batchId)!

    // Check if all tasks in this batch are completed or cancelled
    const allDone = batchTasks.every(
      (t) => t.status === "completed" || t.status === "cancelled",
    )

    if (!allDone) {
      return batchId
    }
  }

  return null
}

/**
 * Print dry run output showing what would be executed
 */
function printDryRunOutput(
  stream: { id: string },
  batchId: string,
  stageName: string,
  batchName: string,
  threads: ThreadInfo[],
  sessionName: string,
  port: number,
  noServer: boolean,
  repoRoot: string,
  headless: boolean,
  asyncMode: boolean,
): void {
  console.log("=== DRY RUN ===\n")
  console.log(`Stream: ${stream.id}`)
  console.log(`Batch: ${batchId} (${stageName} -> ${batchName})`)
  console.log(`Threads: ${threads.length}`)
  console.log(`Session: ${sessionName}`)
  console.log(`Port: ${port}`)
  console.log(
    `Execution: ${headless ? (asyncMode ? "headless async" : "headless") : "interactive"}`,
  )
  console.log("")

  if (!noServer) {
    console.log("# Start opencode serve")
    console.log(buildServeCommand(port))
    console.log("")
  }

  console.log("# Create tmux session (Window 0: Dashboard)")
  const firstThread = threads[0]!
  const firstCmd = buildThreadRunCommand(firstThread, port, stream.id, { headless })
  console.log(buildCreateSessionCommand(sessionName, "Dashboard", firstCmd))
  console.log("")

  console.log("# Add thread windows (Background)")
  if (threads.length > 1) {
    for (let i = 1; i < threads.length; i++) {
      const thread = threads[i]!
      const cmd = buildThreadRunCommand(thread, port, stream.id, { headless })
      console.log(buildAddWindowCommand(sessionName, thread.threadId, cmd))
    }
    console.log("")
  }

  if (!headless) {
    console.log("# Setup Dashboard Layout")
    const navigatorCmd = `bun work multi-navigator --session "${sessionName}" --batch "${batchId}" --repo-root "${repoRoot}" --stream "${stream.id}"`
    console.log(
      `tmux split-window -t "${sessionName}:0" -h -b -l 25% "${navigatorCmd}"`,
    )
    console.log("")

    console.log("# Attach to session")
    console.log(buildAttachCommand(sessionName))
    console.log("")
  }

  console.log("=== Thread Details ===")
  for (const thread of threads) {
    console.log(`\n${thread.threadId}: ${thread.threadName}`)
    console.log(`  Agent: ${thread.agentName}`)
    console.log(`  Working Models: ${thread.models.map((m) => m.model).join(" → ")}`)
    console.log(`  Prompt: ${thread.promptPath}`)
  }
}

/**
 * Handle session close event - update statuses and cleanup
 */
async function handleSessionClose(
  code: number | null,
  sessionName: string,
  threadSessionMap: ThreadSessionMap[],
  threadIds: string[],
  notificationTracker: NotificationTracker | null,
  repoRoot: string,
  streamId: string,
  pollingState: { active: boolean },
  pollingPromise: Promise<void>,
): Promise<void> {
  // Stop marker polling when session closes
  pollingState.active = false
  try {
    await pollingPromise
  } catch {
    // Ignore polling errors on close
  }
  console.log(`\nSession detached. Checking thread statuses...`)

  const result = await finalizeMultiRun({
    sessionName,
    threadSessionMap,
    threadIds,
    notificationTracker,
    repoRoot,
    streamId,
  })

  process.exit(code ?? result.exitCode)
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  const cliArgsError = validateCliArgs(cliArgs)
  if (cliArgsError) {
    console.error(`Error: ${cliArgsError}`)
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  if (!cliArgs.batch && !cliArgs.continue) {
    console.error("Error: Either --batch or --continue is required")
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  // Auto-detect repo root if not provided
  let repoRoot: string
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  let index
  try {
    index = loadIndex(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  let stream
  try {
    stream = getResolvedStream(index, cliArgs.streamId)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  // Resolve batch ID
  let batchId = cliArgs.batch

  if (cliArgs.continue) {
    const tasksFile = readTasksFile(repoRoot, stream.id)
    if (!tasksFile) {
      console.error(`Error: No tasks found for stream ${stream.id}`)
      process.exit(1)
    }

    const nextBatch = findNextIncompleteBatch(tasksFile.tasks)
    if (!nextBatch) {
      console.log("All batches are complete! Nothing to continue.")
      process.exit(0)
    }

    batchId = nextBatch
    console.log(`Continuing with next incomplete batch: ${batchId}`)
  }

  if (!batchId) {
    console.error(
      "Error: No batch specified and could not determine next batch",
    )
    process.exit(1)
  }

  // Parse batch ID
  const batchParsed = parseBatchId(batchId)
  if (!batchParsed) {
    console.error(
      `Error: Invalid batch ID "${batchId}". Expected format: "SS.BB" (e.g., "01.02")`,
    )
    process.exit(1)
  }

  // Check Previous Stage Approval
  if (batchParsed.stage > 1) {
    const prevStageNum = batchParsed.stage - 1
    const approvalStatus = getStageApprovalStatus(stream, prevStageNum)

    if (approvalStatus !== "approved") {
      console.error(
        `Error: Previous stage (Stage ${prevStageNum}) is not approved.`,
      )
      console.error(
        `\nYou must approve the outputs of Stage ${prevStageNum} before proceeding to Stage ${batchParsed.stage}.`,
      )
      console.error(`Run: work approve stage ${prevStageNum}`)
      process.exit(1)
    }
  }

  // Load agents config
  const agentsConfig = loadAgentsConfig(repoRoot)
  if (!agentsConfig) {
    console.error("Error: No agents.yaml found. Run 'work init' to create one.")
    process.exit(1)
  }

  // Discover threads from tasks.json
  const threads = collectThreadInfoFromTasks(
    repoRoot,
    stream.id,
    batchParsed.stage,
    batchParsed.batch,
    agentsConfig,
  )

  if (threads.length === 0) {
    console.error(
      `Error: No tasks found for batch ${batchId} in stream ${stream.id}`,
    )
    console.error(`\nHint: Make sure tasks.json has tasks for this batch.`)
    process.exit(1)
  }

  if (threads.length > MAX_THREADS_PER_BATCH) {
    console.error(
      `Error: Batch has ${threads.length} threads, but max is ${MAX_THREADS_PER_BATCH}`,
    )
    console.error(
      `\nHint: Split this batch into smaller batches or increase MAX_THREADS_PER_BATCH.`,
    )
    process.exit(1)
  }

  // Get batch metadata for display
  const batchMeta = getBatchMetadata(
    repoRoot,
    stream.id,
    batchParsed.stage,
    batchParsed.batch,
  )
  const stageName = batchMeta?.stageName || `Stage ${batchParsed.stage}`
  const batchName = batchMeta?.batchName || `Batch ${batchParsed.batch}`

  // Validate prompt files exist
  const missingPrompts = validateThreadPrompts(threads)
  if (missingPrompts.length > 0) {
    console.error("Error: Missing prompt files:")
    for (const msg of missingPrompts) {
      console.error(msg)
    }
    console.error(
      `\nHint: Run 'work prompt --stage ${batchParsed.stage} --batch ${batchParsed.batch}' to generate them.`,
    )
    process.exit(1)
  }

  const port = cliArgs.port ?? DEFAULT_PORT
  const sessionName = getWorkSessionName(stream.id)

  // === DRY RUN MODE ===
  if (cliArgs.dryRun) {
    printDryRunOutput(
      stream,
      batchId,
      stageName,
      batchName,
      threads,
      sessionName,
      port,
      cliArgs.noServer ?? false,
      repoRoot,
      cliArgs.headless ?? false,
      cliArgs.async ?? false,
    )
    return
  }

  // === REAL EXECUTION ===

  // Check if session already exists
  if (sessionExists(sessionName)) {
    console.error(`Error: tmux session "${sessionName}" already exists.`)
    console.error(`\nOptions:`)
    console.error(`  1. Attach to it: tmux attach -t "${sessionName}"`)
    console.error(`  2. Kill it: tmux kill-session -t "${sessionName}"`)
    process.exit(1)
  }

  // Generate session IDs for each thread
  console.log("Generating session IDs for thread tracking...")
  for (const thread of threads) {
    thread.sessionId = generateSessionId()
  }

  // Start sessions in tasks.json
  const sessionsToStart = threads
    .filter((t) => t.firstTaskId && t.sessionId)
    .map((t) => ({
      taskId: t.firstTaskId!,
      agentName: t.agentName,
      model: t.models[0]?.model || "unknown",
      sessionId: t.sessionId!,
      ...(buildRootAgentThreadSessionLineage(cliArgs, t.sessionId!)
        ? { lineage: buildRootAgentThreadSessionLineage(cliArgs, t.sessionId!) }
        : {}),
    }))

  if (sessionsToStart.length > 0) {
    console.log(`Starting ${sessionsToStart.length} sessions in tasks.json...`)
    await startMultipleSessionsLocked(repoRoot, stream.id, sessionsToStart)
  }

  // Start opencode serve if needed
  if (!cliArgs.noServer) {
    const serverRunning = await isServerRunning(port)
    if (!serverRunning) {
      console.log(`Starting opencode serve on port ${port}...`)
      startServer(port, repoRoot)

      console.log("Waiting for server to be ready...")
      const ready = await waitForServer(port, 30000)
      if (!ready) {
        console.error(`Error: opencode serve did not start within 30 seconds`)
        process.exit(1)
      }
      console.log("Server ready.\n")
    } else {
      console.log(`opencode serve already running on port ${port}\n`)
    }
  }

  if (cliArgs.headless) {
    const batchStatus = resetBatchStatusRun({
      repoRoot,
      streamId: stream.id,
      batchId,
      stageName,
      batchName,
      threads: threads.map((thread) => ({
        threadId: thread.threadId,
        threadName: thread.threadName,
        firstTaskId: thread.firstTaskId!,
      })),
    })

    console.log(`Initialized batch status run ${batchStatus.runId} for ${batchId}.`)
  }

  // Create tmux session with threads
  console.log(`Creating tmux session "${sessionName}"...`)
  const { threadSessionMap } = setupTmuxSession(
    sessionName,
    threads,
    port,
    repoRoot,
    stream.id,
    batchId,
    { headless: cliArgs.headless },
  )

  console.log(`  Tracking ${threadSessionMap.length} thread sessions`)

  // Setup grid controller for pagination (if >4 threads)
  await setupGridController(
    sessionName,
    threads,
    port,
    batchId,
    repoRoot,
    stream.id,
    { headless: cliArgs.headless },
  )

  // Setup keybinding to kill session
  if (!cliArgs.headless) {
    setupKillSessionKeybind()
  }

  const threadIds = threads.map((t) => t.threadId)

  if (cliArgs.headless) {
    console.log(`
Layout: headless tmux session (${threads.length} thread${threads.length === 1 ? "" : "s"})
Monitoring for completion without attaching.
`)

    if (cliArgs.async) {
      startDetachedBatchMonitor({
        repoRoot,
        streamId: stream.id,
        batchId,
        pollIntervalMs: 1000,
      })
      console.log(`Headless async mode: session "${sessionName}" is running detached.`)
      return
    }

    // Create notification tracker with workstream-specific config.
    // Async mode returns immediately after starting the detached monitor, so it
    // must not start local marker polling that would keep the launcher alive.
    const notificationTracker = cliArgs.silent ? null : new NotificationTracker({ repoRoot })

    // Start marker file polling for local notifications in blocking modes only.
    const { promise: pollingPromise, state: pollingState } = startMarkerPolling({
      threadIds,
      notificationTracker,
      streamId: stream.id,
    })

    await waitForAllPanesExit(sessionName)
    await handleSessionClose(
      null,
      sessionName,
      threadSessionMap,
      threadIds,
      notificationTracker,
      repoRoot,
      stream.id,
      pollingState,
      pollingPromise,
    )
    return
  }

  console.log(`
Layout: ${threads.length <= 4 ? "2x2 Grid (all visible)" : `2x2 Grid with pagination (${threads.length} threads, use n/p to page)`}
Press Ctrl+b X to kill the session when done.
`)

  // Create notification tracker with workstream-specific config.
  const notificationTracker = cliArgs.silent ? null : new NotificationTracker({ repoRoot })

  // Start marker file polling for local notifications in attached mode.
  const { promise: pollingPromise, state: pollingState } = startMarkerPolling({
    threadIds,
    notificationTracker,
    streamId: stream.id,
  })

  console.log(`Attaching to session "${sessionName}"...`)

  // Attach to session
  const child = attachSession(sessionName)

  child.on("close", async (code) => {
    await handleSessionClose(
      code,
      sessionName,
      threadSessionMap,
      threadIds,
      notificationTracker,
      repoRoot,
      stream.id,
      pollingState,
      pollingPromise,
    )
  })

  child.on("error", (err) => {
    console.error(`Error attaching to tmux session: ${err.message}`)
    notificationTracker?.playError("__session_error__")
    process.exit(1)
  })
}

// Run if called directly
if (import.meta.main) {
  await main()
}
