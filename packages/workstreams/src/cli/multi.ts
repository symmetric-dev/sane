/**
 * CLI: Multi
 *
 * Executes all threads in a batch in parallel using tmux sessions.
 * Each thread runs in its own tmux window with an opencode instance
 * connected to a shared opencode serve backend.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { loadAgentsConfig, getDefaultSynthesisAgent, getSynthesisAgent, getSynthesisAgentModels } from "../lib/agents-yaml.ts"
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
import { isSynthesisEnabled, getSynthesisAgentOverride } from "../lib/synthesis/config.ts"
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
  synthesisConfigEnabled: boolean,
  synthesisAgentName: string | null,
  headless: boolean,
  asyncMode: boolean,
): void {
  // Check if synthesis mode is enabled based on config and agent availability
  const synthesisEnabled = synthesisConfigEnabled && threads.some(t => t.synthesisModels && t.synthesisModels.length > 0)
  
  console.log("=== DRY RUN ===\n")
  console.log(`Stream: ${stream.id}`)
  console.log(`Batch: ${batchId} (${stageName} -> ${batchName})`)
  console.log(`Threads: ${threads.length}`)
  console.log(`Session: ${sessionName}`)
  console.log(`Port: ${port}`)
  console.log(
    `Execution: ${headless ? (asyncMode ? "headless async" : "headless") : "interactive"}`,
  )
  console.log(`Synthesis config: work/synthesis.json`)
  if (synthesisConfigEnabled) {
    if (synthesisAgentName) {
      console.log(`Synthesis: enabled (${synthesisAgentName})`)
      if (synthesisEnabled) {
        console.log(`Mode: Post-Session Synthesis (working agent runs first with TUI, synthesis runs after)`)
      }
    } else {
      console.log(`Synthesis: enabled but no agent configured`)
    }
  } else {
    console.log(`Synthesis: disabled`)
  }
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
    const synthIndicator = thread.synthesisModels ? " [synthesis]" : ""
    console.log(`\n${thread.threadId}: ${thread.threadName}${synthIndicator}`)
    console.log(`  Agent: ${thread.agentName}`)
    console.log(`  Working Models: ${thread.models.map((m) => m.model).join(" → ")}`)
    if (thread.synthesisModels) {
      console.log(`  Synthesis Models: ${thread.synthesisModels.map((m) => m.model).join(" → ")}`)
    }
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

  // Check if synthesis is enabled via synthesis.json config before loading synthesis agent
  const synthesisConfigEnabled = isSynthesisEnabled(repoRoot)
  
  // Load synthesis agent config only if synthesis is enabled in config
  // If synthesis is disabled in config, set synthesisAgent to null regardless of agents.yaml
  let synthesisAgent = null
  if (synthesisConfigEnabled) {
    // Check for agent override in synthesis.json, otherwise use default from agents.yaml
    const agentOverride = getSynthesisAgentOverride(repoRoot)
    if (agentOverride) {
      synthesisAgent = getSynthesisAgent(agentsConfig, agentOverride)
      if (!synthesisAgent) {
        console.log(`Synthesis agent override "${agentOverride}" not found in agents.yaml, using default`)
        synthesisAgent = getDefaultSynthesisAgent(agentsConfig)
      }
    } else {
      synthesisAgent = getDefaultSynthesisAgent(agentsConfig)
    }
    
    if (synthesisAgent) {
      const synthModels = getSynthesisAgentModels(agentsConfig, synthesisAgent.name)
      console.log(`Synthesis enabled: ${synthesisAgent.name} (${synthModels.length} model(s))`)
    } else {
      console.log(`Synthesis enabled but no synthesis agent configured in agents.yaml`)
    }
  } else {
    console.log(`Synthesis: disabled (work/synthesis.json)`)
  }

  // Discover threads from tasks.json
  const threads = collectThreadInfoFromTasks(
    repoRoot,
    stream.id,
    batchParsed.stage,
    batchParsed.batch,
    agentsConfig,
    synthesisAgent,
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
      synthesisConfigEnabled,
      synthesisAgent?.name ?? null,
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

  // Create notification tracker with workstream-specific config
  const notificationTracker = cliArgs.silent ? null : new NotificationTracker({ repoRoot })

  // Start marker file polling for notifications
  // Pass streamId to enable synthesis output in notifications
  const threadIds = threads.map((t) => t.threadId)
  const { promise: pollingPromise, state: pollingState } = startMarkerPolling({
    threadIds,
    notificationTracker,
    streamId: stream.id,
  })

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
