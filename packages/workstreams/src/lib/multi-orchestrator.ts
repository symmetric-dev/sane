/**
 * Multi-Orchestrator
 *
 * Orchestration logic for executing multiple threads in parallel using tmux.
 * Handles thread discovery, session setup, pane spawning, and session tracking.
 */

import { join } from "path"
import { existsSync } from "fs"
import { getWorkDir } from "./repo.ts"
import { loadAgentsConfig, getAgentModels, getSynthesisAgentModels } from "./agents-yaml.ts"
import type { SynthesisAgentDefinitionYaml, AgentsConfigYaml } from "./types.ts"
import { discoverThreadsInBatch } from "./tasks.ts"
import { getThreadMetadata } from "./threads.ts"
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
import { buildRetryRunCommand, buildPostSynthesisCommand } from "./opencode.ts"
import type { NormalizedModelSpec } from "./types.ts"
import type { ThreadInfo, ThreadSessionMap } from "./multi-types.ts"

/**
 * Build the prompt file path for a thread using metadata strings
 * Used when discovering threads from tasks.json instead of PLAN.md
 */
export function getPromptFilePathFromMetadata(
  repoRoot: string,
  streamId: string,
  stageNum: number,
  stageName: string,
  batchNum: number,
  batchName: string,
  threadName: string,
): string {
  const workDir = getWorkDir(repoRoot)

  const safeStageName = stageName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()
  const safeBatchName = batchName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()
  const safeThreadName = threadName
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase()

  const stagePrefix = stageNum.toString().padStart(2, "0")
  const batchPrefix = batchNum.toString().padStart(2, "0")

  return join(
    workDir,
    streamId,
    "prompts",
    `${stagePrefix}-${safeStageName}`,
    `${batchPrefix}-${safeBatchName}`,
    `${safeThreadName}.md`,
  )
}

/**
 * Build the pane title for a thread
 */
export function buildPaneTitle(threadInfo: ThreadInfo): string {
  return threadInfo.threadName
}

/**
 * Options for collectThreadInfoFromTasks
 */
export interface CollectThreadInfoOptions {
  repoRoot: string
  streamId: string
  stageNum: number
  batchNum: number
  agentsConfig: AgentsConfigYaml
  /** Optional synthesis agent - if provided, synthesis mode is enabled for all threads */
  synthesisAgent?: SynthesisAgentDefinitionYaml | null
}

/**
 * Collect thread information from tasks.json (not PLAN.md)
 * Discovers threads dynamically from tasks, including dynamically added ones
 * 
 * @param options - Collection options including optional synthesis agent
 */
export function collectThreadInfoFromTasks(
  repoRoot: string,
  streamId: string,
  stageNum: number,
  batchNum: number,
  agentsConfig: ReturnType<typeof loadAgentsConfig>,
  synthesisAgent?: SynthesisAgentDefinitionYaml | null,
): ThreadInfo[] {
  const discoveredThreads = discoverThreadsInBatch(
    repoRoot,
    streamId,
    stageNum,
    batchNum,
  )
  if (!discoveredThreads || discoveredThreads.length === 0) {
    return []
  }

  const threads: ThreadInfo[] = []

  // Get synthesis models if synthesis agent is provided
  const synthesisModels = synthesisAgent 
    ? getSynthesisAgentModels(agentsConfig!, synthesisAgent.name)
    : undefined

  for (const discovered of discoveredThreads) {
    // Get prompt path from threads.json (authoritative source)
    // Fall back to reconstructing from metadata if not stored
    const threadMeta = getThreadMetadata(repoRoot, streamId, discovered.threadId)
    let promptPath: string
    
    if (threadMeta?.promptPath) {
      // Use stored path from threads.json (relative path, need to make absolute)
      const workDir = getWorkDir(repoRoot)
      promptPath = join(workDir, threadMeta.promptPath)
    } else {
      // Fallback: reconstruct from task metadata (legacy behavior)
      promptPath = getPromptFilePathFromMetadata(
        repoRoot,
        streamId,
        discovered.stageNum,
        discovered.stageName,
        discovered.batchNum,
        discovered.batchName,
        discovered.threadName,
      )
    }

    // Get agent (from task or default)
    const agentName = discovered.assignedAgent || "default"

    // Get models from agent (for retry logic)
    const models = getAgentModels(agentsConfig!, agentName)
    if (models.length === 0) {
      console.error(
        `Error: Agent "${agentName}" not found in agents.yaml (referenced in thread ${discovered.threadId})`,
      )
      process.exit(1)
    }

    const threadInfo: ThreadInfo = {
      threadId: discovered.threadId,
      threadName: discovered.threadName,
      stageName: discovered.stageName,
      batchName: discovered.batchName,
      promptPath,
      models,
      agentName,
      firstTaskId: discovered.firstTaskId,
    }

    // Add synthesis agent fields if synthesis is enabled (for post-session synthesis)
    if (synthesisAgent && synthesisModels && synthesisModels.length > 0) {
      threadInfo.synthesisAgentName = synthesisAgent.name
      threadInfo.synthesisModels = synthesisModels
    }

    threads.push(threadInfo)
  }

  return threads
}

/**
 * Result of tmux session setup
 */
export interface SessionSetupResult {
  sessionName: string
  threadSessionMap: ThreadSessionMap[]
}

/**
 * Build the run command for a thread, using post-session synthesis if enabled
 * 
 * This uses the modern post-session synthesis flow (replacing the legacy wrapper approach):
 * 1. Working agent runs first with full TUI visibility (user can interact)
 * 2. After completion, synthesis agent runs headless to summarize
 * 3. Session resume opens working agent session (not synthesis)
 * 
 * @param thread - Thread info with optional synthesis fields
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
  const paneTitle = buildPaneTitle(thread)

  // Check if post-session synthesis is enabled for this thread
  if (thread.synthesisModels && thread.synthesisModels.length > 0) {
    return buildPostSynthesisCommand({
      port,
      workingModels: thread.models,
      synthesisModels: thread.synthesisModels,
      promptPath: thread.promptPath,
      threadTitle: paneTitle,
      streamId,
      threadId: thread.threadId,
      headless: options.headless,
    })
  }

  // Fallback to regular retry command (no synthesis)
  return buildRetryRunCommand(
    port,
    thread.models,
    thread.promptPath,
    paneTitle,
    thread.threadId,
    { headless: options.headless, streamId },
  )
}

/**
 * Set up a tmux session with grid layout for parallel thread execution
 *
 * Creates a 2x2 grid layout with:
 * - Window 0: Grid with up to 4 visible threads
 * - Windows 1+: Hidden windows for threads 5+ (for pagination)
 * 
 * If threads have synthesisModels, post-session synthesis mode is enabled:
 * - Working agent runs first with full TUI
 * - Synthesis runs headless after completion
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

  // Log thread with synthesis mode indicator
  const synthIndicator = firstThread.synthesisModels ? " [synthesis]" : ""
  console.log(`  Grid: Thread 1 - ${firstThread.threadName}${synthIndicator}`)

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
    const synthInd = thread.synthesisModels ? " [synthesis]" : ""
    console.log(`  Grid: Thread ${i + 1} - ${thread.threadName}${synthInd}`)
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
    if (thread.sessionId && thread.firstTaskId && gridPaneIds[i]) {
      threadSessionMap.push({
        threadId: thread.threadId,
        sessionId: thread.sessionId,
        taskId: thread.firstTaskId,
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
      if (thread.sessionId && thread.firstTaskId && windowPaneIds[0]) {
        threadSessionMap.push({
          threadId: thread.threadId,
          sessionId: thread.sessionId,
          taskId: thread.firstTaskId,
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
      return `THREAD_CMD_${i + 1}="${cmd}"`
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
 * Validate that all thread prompts exist
 * Returns array of error messages for missing prompts
 */
export function validateThreadPrompts(threads: ThreadInfo[]): string[] {
  const missingPrompts: string[] = []
  for (const thread of threads) {
    if (!existsSync(thread.promptPath)) {
      missingPrompts.push(`  ${thread.threadId}: ${thread.promptPath}`)
    }
  }
  return missingPrompts
}
