/**
 * Multi-Orchestrator
 *
 * Orchestration logic for executing multiple threads in parallel using tmux.
 * Handles thread discovery, session setup, pane spawning, and session tracking.
 */

import { existsSync } from "fs"
import { loadAgentsConfig, getAgentModels } from "./agents-yaml.ts"
import { queryThreadsForWorkstream } from "./hierarchy-query.ts"
import { getPromptContext, generateThreadPrompt } from "./prompts.ts"
import { getThreadWorkMdPath, getThreadWorkMdRelativePath } from "./thread-workdocs.ts"
import {
  createSession,
  addWindow,
  setGlobalOption,
  markSessionHeadless,
  createGridLayout,
  listPaneIds,
  THREAD_START_DELAY_MS,
  sleepWithCountdown,
} from "./tmux.ts"
import { buildRetryRunCommand } from "./opencode.ts"
import type { ThreadInfo, ThreadSessionMap } from "./multi-types.ts"

function shellQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`
}

/**
 * Build the runtime prompt content for a thread.
 *
 * The prompt is generated in memory from the same prompt context used by the
 * legacy prompt-file flow. It is not persisted under work/<stream>/prompts.
 */
export function generateRuntimeThreadPrompt(
  repoRoot: string,
  streamId: string,
  threadId: string,
): string {
  const context = getPromptContext(repoRoot, streamId, threadId)
  return generateThreadPrompt(context)
}

/**
 * Build the pane title for a thread
 */
export function buildPaneTitle(threadInfo: ThreadInfo): string {
  return `${threadInfo.threadId} ${threadInfo.threadName}`
}

/**
 * Collect thread information for a batch.
 * Uses canonical thread query views for batch discovery.
 */
export function collectThreadInfoForBatch(
  repoRoot: string,
  streamId: string,
  stageNum: number,
  batchNum: number,
  agentsConfig: ReturnType<typeof loadAgentsConfig>,
): ThreadInfo[] {
  let canonicalThreads: ReturnType<typeof queryThreadsForWorkstream> = []
  try {
    canonicalThreads = queryThreadsForWorkstream(repoRoot, streamId).filter(
      (thread) => thread.stageId === stageNum.toString().padStart(2, "0") && thread.batchId === `${stageNum.toString().padStart(2, "0")}.${batchNum.toString().padStart(2, "0")}`,
    )
  } catch {
    canonicalThreads = []
  }

  if (canonicalThreads.length > 0) {
    return canonicalThreads.map((thread) => {
      const agentName = thread.assignedAgent || "default"
      const models = getAgentModels(agentsConfig!, agentName)
      if (models.length === 0) {
        console.error(
          `Error: Agent "${agentName}" not found in agents.yaml (referenced in thread ${thread.threadId})`,
        )
        process.exit(1)
      }

      return {
        threadId: thread.threadId,
        threadName: thread.threadName,
        stageName: thread.stageName,
        batchName: thread.batchName,
        models,
        agentName,
      }
    })
  }
  return []
}

/**
 * Result of tmux session setup
 */
export interface SessionSetupResult {
  sessionName: string
  threadSessionMap: ThreadSessionMap[]
}

/**
 * Build the run command for a thread.
 * @param port - OpenCode server port
 * @param streamId - Stream/workstream ID
 * @returns Shell command string for tmux execution
 */
export function buildThreadRunCommand(
  thread: ThreadInfo,
  port: number,
  streamId: string,
  options: { headless?: boolean } = {},
): string {
  if (!thread.promptContent) {
    throw new Error(
      `Runtime prompt content has not been generated for thread ${thread.threadId}`,
    )
  }
  const paneTitle = buildPaneTitle(thread)
  return buildRetryRunCommand(
    port,
    thread.models,
    thread.promptContent,
    paneTitle,
    thread.threadId,
    { headless: options.headless, streamId },
  )
}

/**
 * Generate in-memory runtime prompt content for each thread.
 */
export function prepareRuntimeThreadPrompts(
  repoRoot: string,
  streamId: string,
  threads: ThreadInfo[],
): void {
  for (const thread of threads) {
    thread.promptContent = generateRuntimeThreadPrompt(repoRoot, streamId, thread.threadId)
  }
}

/**
 * Set up a tmux session with grid layout for parallel thread execution
 *
 * Creates a 2x2 grid layout with:
 * - Window 0: Grid with up to 4 visible threads
 * - Windows 1+: Hidden windows for threads 5+ (for pagination)
 */
export function setupTmuxSession(
  sessionName: string,
  threads: ThreadInfo[],
  port: number,
  repoRoot: string,
  streamId: string,
  batchId: string,
  options: { headless?: boolean } = {},
): SessionSetupResult {
  const threadSessionMap: ThreadSessionMap[] = []

  const firstThread = threads[0]!
  const firstCmd = buildThreadRunCommand(firstThread, port, streamId, options)

  console.log(`  Grid: Thread 1 - ${firstThread.threadName}`)

  // Create session with first thread in Window 0
  createSession(sessionName, "Grid", firstCmd)
  if (options.headless) {
    markSessionHeadless(sessionName)
  }
  sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger")

  // Keep windows open after exit for debugging
  setGlobalOption(sessionName, "remain-on-exit", options.headless ? "off" : "on")
  // Enable mouse support for scrolling
  setGlobalOption(sessionName, "mouse", "on")

  // Build commands for threads 2-4 (remaining visible grid panes)
  const gridCommands = [firstCmd]
  for (let i = 1; i < Math.min(4, threads.length); i++) {
    const thread = threads[i]!
    const cmd = buildThreadRunCommand(thread, port, streamId, options)
    gridCommands.push(cmd)
    console.log(`  Grid: Thread ${i + 1} - ${thread.threadName}`)
  }

  // Create the grid layout (splits panes for threads 2-4)
  if (gridCommands.length > 1) {
    console.log("  Setting up 2x2 grid layout...")
    createGridLayout(`${sessionName}:0`, gridCommands)
  }

  // Capture pane IDs for threads in grid (window 0)
  const gridPaneIds = listPaneIds(`${sessionName}:0`)
  for (let i = 0; i < Math.min(4, threads.length); i++) {
    const thread = threads[i]!
    if (thread.sessionId && gridPaneIds[i]) {
      threadSessionMap.push({
        threadId: thread.threadId,
        sessionId: thread.sessionId,
        paneId: gridPaneIds[i]!,
        windowIndex: 0,
      })
    }
  }

  // Create hidden windows for threads 5+ (used by pagination)
  if (threads.length > 4) {
    console.log("  Creating hidden windows for pagination...")
    for (let i = 4; i < threads.length; i++) {
      const thread = threads[i]!
      const cmd = buildThreadRunCommand(thread, port, streamId, options)
      const windowName = `T${i + 1}`
      console.log(`  Hidden: ${windowName} - ${thread.threadName}`)
      addWindow(sessionName, windowName, cmd)
      sleepWithCountdown(THREAD_START_DELAY_MS, "Stagger")

      // Capture pane ID for hidden window thread
      const windowPaneIds = listPaneIds(`${sessionName}:${windowName}`)
      if (thread.sessionId && windowPaneIds[0]) {
        threadSessionMap.push({
          threadId: thread.threadId,
          sessionId: thread.sessionId,
          paneId: windowPaneIds[0]!,
          windowIndex: i - 3, // Hidden windows start at index 1
        })
      }
    }
  }

  return { sessionName, threadSessionMap }
}

/**
 * Set up the grid controller pane for pagination (when >4 threads)
 */
export async function setupGridController(
  sessionName: string,
  threads: ThreadInfo[],
  port: number,
  batchId: string,
  repoRoot: string,
  streamId: string,
  options: { headless?: boolean } = {},
): Promise<void> {
  if (threads.length <= 4 || options.headless) return

  console.log("  Setting up grid controller for pagination...")
  const bunPath = process.execPath
  const { resolve } = await import("path")
  const jsBinPath = resolve(import.meta.dir, "../../bin/work.js")
  const tsBinPath = resolve(import.meta.dir, "../../bin/work.ts")
  const binPath = existsSync(jsBinPath) ? jsBinPath : tsBinPath

  // Build thread command environment variables for respawn
  const threadCmdEnv = threads
    .map((t, i) => {
      const cmd = buildThreadRunCommand(t, port, streamId, options)
      return `THREAD_CMD_${i + 1}=${shellQuote(cmd)}`
    })
    .join(" ")

  // Exit code 42 = intentional quit (don't restart)
  const loopCmd = `while true; do ${threadCmdEnv} "${bunPath}" "${binPath}" multi-grid --session "${sessionName}" --batch "${batchId}" --repo-root "${repoRoot}" --stream "${streamId}"; exitCode=$?; if [ $exitCode -eq 42 ]; then exit 0; fi; echo "Controller crashed. Restarting in 1s..."; sleep 1; done`

  // Create a small pane at the bottom for the grid controller
  const splitArgs = [
    "tmux",
    "split-window",
    "-t",
    `${sessionName}:0`,
    "-v",
    "-l",
    "3", // 3 lines at bottom
    loopCmd,
  ]
  Bun.spawnSync(splitArgs)
}

/**
 * Set up keybinding to kill session (Ctrl+b X)
 */
export function setupKillSessionKeybind(): void {
  Bun.spawnSync(["tmux", "bind-key", "X", "kill-session"])
}

/**
 * Validate that all canonical thread WORK.md files exist.
 * Returns array of error messages for missing WORK.md files.
 */
export function validateThreadWorkDocuments(
  repoRoot: string,
  streamId: string,
  threads: Pick<ThreadInfo, "threadId">[],
): string[] {
  const missingWorkDocs: string[] = []
  for (const thread of threads) {
    const workPath = getThreadWorkMdPath(repoRoot, streamId, thread.threadId)
    if (!existsSync(workPath)) {
      missingWorkDocs.push(
        `  ${thread.threadId}: work/${getThreadWorkMdRelativePath(repoRoot, streamId, thread.threadId)}`,
      )
    }
  }
  return missingWorkDocs
}
