/**
 * CLI: GitHub Integration
 *
 * Manages GitHub integration for workstreams: enable, disable, status,
 * create-branch, create-issues, sync.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, resolveStreamId, getStream } from "../lib/index.ts"
import { listThreadExecutionItems } from "../lib/thread-execution.ts"
import {
  loadGitHubConfig,
  enableGitHub,
  disableGitHub,
  isGitHubEnabled,
} from "../lib/github/config.ts"
import { getGitHubAuth, validateAuth, ensureGitHubAuth } from "../lib/github/auth.ts"
import { createWorkstreamBranch, formatBranchName } from "../lib/github/branches.ts"
import {
  createStageIssue,
  findExistingStageIssue,
  reopenStageIssue,
  type CreateStageIssueInput,
  type StageBatch,
  type StageThread,
  type StageItem,
} from "../lib/github/issues.ts"
import { ensureWorkstreamLabels } from "../lib/github/labels.ts"
import { syncStageIssues, type SyncStageIssuesResult } from "../lib/github/sync.ts"
import {
  loadWorkstreamGitHub,
  initWorkstreamGitHub,
  saveWorkstreamGitHub,
  getStageIssue,
  setStageIssue,
  type StageIssue,
} from "../lib/github/workstream-github.ts"
import type { ExecutionItem } from "../lib/types.ts"

type Subcommand = "enable" | "disable" | "status" | "create-branch" | "create-issues" | "sync"

const SUBCOMMANDS: Subcommand[] = ["enable", "disable", "status", "create-branch", "create-issues", "sync"]

function printHelp(): void {
  console.log(`
work github - GitHub integration management

Usage:
  work github <subcommand> [options]

Subcommands:
  enable        Enable GitHub integration (auto-detects repo)
  disable       Disable GitHub integration
  status        Show config and auth status
  create-branch Create workstream branch on GitHub
  create-issues Create issues for stages
  sync          Sync issue states with local item status

Run 'work github <subcommand> --help' for more information on a subcommand.
`)
}

function printEnableHelp(): void {
  console.log(`
work github enable - Enable GitHub integration

Usage:
  work github enable [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Enables GitHub integration by auto-detecting the repository from the
  git remote 'origin'. Saves configuration to work/github.json.

Examples:
  # Enable GitHub integration
  work github enable
`)
}

function printDisableHelp(): void {
  console.log(`
work github disable - Disable GitHub integration

Usage:
  work github disable [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Disables GitHub integration. Configuration is preserved but integration
  is marked as disabled.

Examples:
  # Disable GitHub integration
  work github disable
`)
}

function printStatusHelp(): void {
  console.log(`
work github status - Show GitHub integration status

Usage:
  work github status [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Description:
  Shows the current GitHub integration configuration, authentication
  status, and repository information.

Examples:
  # Show GitHub integration status
  work github status
`)
}

function printCreateIssuesHelp(): void {
  console.log(`
work github create-issues - Create GitHub issues for stages

Usage:
  work github create-issues [options]

Options:
  --stream, -s   Workstream ID or name (uses current if omitted)
  --stage, -st   Create issue for a specific stage (e.g., 1)
  --json, -j     Output as JSON
  --help, -h     Show this help message

Description:
  Creates GitHub issues for workstream stages. Each stage gets one issue
  that tracks all batches, threads, and items within that stage.

  Issue title format: [{stream-id}] Stage {N}: {Stage Name}

  When no stage filter is specified, creates issues for all stages that
  don't already have an issue.

Examples:
  # Create issue for stage 1
  work github create-issues --stage 1

  # Create issues for all stages without issues
  work github create-issues

  # Create issues for specific workstream
  work github create-issues --stream "002-github-integration" --stage 1
`)
}

function printCreateBranchHelp(): void {
  console.log(`
work github create-branch - Create workstream branch on GitHub

Usage:
  work github create-branch [options]

Options:
  --stream, -s   Workstream ID or name (uses current if omitted)
  --from, -f     Base branch to create from (default: main)
  --help, -h     Show this help message

Examples:
  # Create branch for current workstream
  work github create-branch

  # Create branch for specific workstream
  work github create-branch --stream "002-github-integration"

  # Create branch from specific base
  work github create-branch --from develop
`)
}

function printSyncHelp(): void {
  console.log(`
work github sync - Sync stage issue states with local item status

Usage:
  work github sync [options]

Options:
  --stream, -s   Workstream ID or name (uses current if omitted)
  --json, -j     Output as JSON
  --help, -h     Show this help message

Description:
  Synchronizes GitHub stage issue states with local item status. For stages
  where all items are completed/cancelled, this command closes the stage
  issue and updates the state in github.json.

  Reports: "Closed N stage issues, M unchanged"

Examples:
  # Sync all issue states for current workstream
  work github sync

  # Sync for specific workstream
  work github sync --stream "002-github-integration"

  # Output as JSON
  work github sync --json
`)
}

// ============================================
// STAGE INFO TYPES AND HELPERS
// ============================================

interface StageInfo {
  stageNumber: number
  stageId: string
  stageName: string
  batches: Map<string, BatchInfo>
}

interface BatchInfo {
  batchId: string
  batchName: string
  threads: Map<string, ThreadInfo>
}

interface ThreadInfo {
  threadId: string
  threadName: string
  items: ExecutionItem[]
}

/**
 * Group tasks by stage, batch, and thread
 * Returns a Map of stages with nested batches and threads
 */
function groupTasksByStage(tasks: ExecutionItem[]): Map<number, StageInfo> {
  const stages = new Map<number, StageInfo>()

  for (const task of tasks) {
    const [stageId = "00", batchId = "00", threadId = "00"] = task.id.split(".")
    const stage = Number.parseInt(stageId, 10) || 0

    // Get or create stage
    if (!stages.has(stage)) {
      stages.set(stage, {
        stageNumber: stage,
        stageId,
        stageName: task.stageName,
        batches: new Map(),
      })
    }
    const stageInfo = stages.get(stage)!

    // Get or create batch
    const batchKey = `${stageId}.${batchId}`
    if (!stageInfo.batches.has(batchKey)) {
      stageInfo.batches.set(batchKey, {
        batchId: batchKey,
        batchName: task.batchName,
        threads: new Map(),
      })
    }
    const batchInfo = stageInfo.batches.get(batchKey)!

    // Get or create thread
    const threadKey = `${stageId}.${batchId}.${threadId}`
    if (!batchInfo.threads.has(threadKey)) {
      batchInfo.threads.set(threadKey, {
        threadId: threadKey,
          threadName: task.threadName,
        items: [],
      })
    }
    batchInfo.threads.get(threadKey)!.items.push(task)
  }

  return stages
}

/**
 * Convert StageInfo to CreateStageIssueInput format
 */
function stageInfoToInput(
  stageInfo: StageInfo,
  streamId: string,
  streamName: string
): CreateStageIssueInput {
  const batches: StageBatch[] = []

  // Sort batches by ID
  const sortedBatches = Array.from(stageInfo.batches.entries())
    .sort(([a], [b]) => a.localeCompare(b))

  for (const [, batchInfo] of sortedBatches) {
    const threads: StageThread[] = []

    // Sort threads by ID
    const sortedThreads = Array.from(batchInfo.threads.entries())
      .sort(([a], [b]) => a.localeCompare(b))

    for (const [, threadInfo] of sortedThreads) {
      // Sort tasks by ID
      const sortedItems = threadInfo.items.sort((a, b) =>
        a.id.localeCompare(b.id, undefined, { numeric: true })
      )

      const items: StageItem[] = sortedItems.map((t) => ({
        itemId: t.id,
        itemName: t.name,
        status: t.status,
      }))

      threads.push({
        threadId: threadInfo.threadId,
        threadName: threadInfo.threadName,
        items,
      })
    }

    batches.push({
      batchId: batchInfo.batchId,
      batchName: batchInfo.batchName,
      threads,
    })
  }

  return {
    streamId,
    streamName,
    stageNumber: stageInfo.stageNumber,
    stageName: stageInfo.stageName,
    batches,
  }
}

/**
 * Check if all execution items in a stage are completed or cancelled
 */
function isStageComplete(stageInfo: StageInfo): boolean {
  for (const batch of stageInfo.batches.values()) {
    for (const thread of batch.threads.values()) {
      for (const item of thread.items) {
        if (item.status !== "completed" && item.status !== "cancelled") {
          return false
        }
      }
    }
  }
  return true
}

interface CreateStageIssuesResult {
  created: { stageNumber: number; stageName: string; issueUrl: string; issueNumber: number }[]
  skipped: { stageNumber: number; stageName: string; reason: string }[]
  reopened: { stageNumber: number; stageName: string; issueUrl: string; issueNumber: number }[]
  failed: { stageNumber: number; stageName: string; error: string }[]
}

/**
 * Create issues for the given stages.
 * Stores issue metadata in github.json using setStageIssue().
 */
async function createIssuesForStages(
  repoRoot: string,
  streamId: string,
  streamName: string,
  stages: Map<number, StageInfo>,
  stageFilter?: number
): Promise<CreateStageIssuesResult> {
  const result: CreateStageIssuesResult = {
    created: [],
    skipped: [],
    reopened: [],
    failed: [],
  }

  // Ensure labels exist first
  await ensureWorkstreamLabels(repoRoot, streamId)

  // Load or initialize github.json
  let githubData = await loadWorkstreamGitHub(repoRoot, streamId)
  if (!githubData) {
    githubData = await initWorkstreamGitHub(repoRoot, streamId)
  }

  // Filter stages if requested
  let stagesToProcess: Map<number, StageInfo>
  if (stageFilter !== undefined) {
    const stageInfo = stages.get(stageFilter)
    stagesToProcess = stageInfo ? new Map([[stageFilter, stageInfo]]) : new Map()
  } else {
    stagesToProcess = stages
  }

  // Sort stages by number
  const sortedStages = Array.from(stagesToProcess.entries())
    .sort(([a], [b]) => a - b)

  for (const [stageNumber, stageInfo] of sortedStages) {
    const stageId = stageNumber.toString().padStart(2, "0")

    try {
      // Check if issue already exists in github.json
      const existingLocal = getStageIssue(githubData, stageId)

      // Check if stage is complete
      const isComplete = isStageComplete(stageInfo)

      // Check GitHub for existing issue
      const existingRemote = await findExistingStageIssue(
        repoRoot,
        streamId,
        stageNumber,
        stageInfo.stageName
      )

      if (existingLocal) {
        // Already tracked locally
        if (existingLocal.state === "closed" && !isComplete) {
          // Reopen the issue if stage is no longer complete
          try {
            await reopenStageIssue(repoRoot, existingLocal.issue_number)
            existingLocal.state = "open"
            delete existingLocal.closed_at
            await saveWorkstreamGitHub(repoRoot, streamId, githubData)

            result.reopened.push({
              stageNumber,
              stageName: stageInfo.stageName,
              issueUrl: existingLocal.issue_url,
              issueNumber: existingLocal.issue_number,
            })
          } catch (error) {
            result.failed.push({
              stageNumber,
              stageName: stageInfo.stageName,
              error: `Failed to reopen issue: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        } else {
          result.skipped.push({
            stageNumber,
            stageName: stageInfo.stageName,
            reason: `Issue #${existingLocal.issue_number} already exists (${existingLocal.state})`,
          })
        }
        continue
      }

      if (existingRemote) {
        // Found on GitHub but not tracked locally - add to github.json
        const stageIssue: StageIssue = {
          issue_number: existingRemote.issueNumber,
          issue_url: existingRemote.issueUrl,
          state: existingRemote.state,
          created_at: new Date().toISOString(),
        }
        if (existingRemote.state === "closed") {
          stageIssue.closed_at = new Date().toISOString()
        }
        setStageIssue(githubData, stageId, stageIssue)
        await saveWorkstreamGitHub(repoRoot, streamId, githubData)

        if (existingRemote.state === "closed" && !isComplete) {
          // Reopen the issue
          try {
            await reopenStageIssue(repoRoot, existingRemote.issueNumber)
            stageIssue.state = "open"
            delete stageIssue.closed_at
            await saveWorkstreamGitHub(repoRoot, streamId, githubData)

            result.reopened.push({
              stageNumber,
              stageName: stageInfo.stageName,
              issueUrl: existingRemote.issueUrl,
              issueNumber: existingRemote.issueNumber,
            })
          } catch (error) {
            result.failed.push({
              stageNumber,
              stageName: stageInfo.stageName,
              error: `Failed to reopen issue: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        } else {
          result.skipped.push({
            stageNumber,
            stageName: stageInfo.stageName,
            reason: `Existing issue #${existingRemote.issueNumber} found on GitHub (${existingRemote.state})`,
          })
        }
        continue
      }

      // No existing issue - check if stage is already complete
      if (isComplete) {
        result.skipped.push({
          stageNumber,
          stageName: stageInfo.stageName,
          reason: "Stage already complete, no issue needed",
        })
        continue
      }

      // Create new issue
      const input = stageInfoToInput(stageInfo, streamId, streamName)
      const stageIssue = await createStageIssue(repoRoot, input)

      if (stageIssue) {
        // Store in github.json
        setStageIssue(githubData, stageId, stageIssue)
        await saveWorkstreamGitHub(repoRoot, streamId, githubData)

        result.created.push({
          stageNumber,
          stageName: stageInfo.stageName,
          issueUrl: stageIssue.issue_url,
          issueNumber: stageIssue.issue_number,
        })
      } else {
        result.skipped.push({
          stageNumber,
          stageName: stageInfo.stageName,
          reason: "GitHub integration not enabled or configured",
        })
      }
    } catch (error) {
      result.failed.push({
        stageNumber,
        stageName: stageInfo.stageName,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return result
}

// ============================================
// CREATE-BRANCH ARGS
// ============================================

interface CreateBranchArgs {
  repoRoot?: string
  streamId?: string
  fromRef?: string
}

function parseCreateBranchArgs(argv: string[]): CreateBranchArgs | null {
  const args = argv.slice(3) // Skip: bun, work-github, create-branch
  const parsed: CreateBranchArgs = {}

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

      case "--from":
      case "-f":
        if (!next) {
          console.error("Error: --from requires a value")
          return null
        }
        parsed.fromRef = next
        i++
        break

      case "--help":
      case "-h":
        printCreateBranchHelp()
        process.exit(0)
    }
  }

  return parsed
}

async function createBranchCommand(argv: string[]): Promise<void> {
  const cliArgs = parseCreateBranchArgs(argv)
  if (!cliArgs) {
    console.error("\nRun 'work github create-branch --help' for usage information.")
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

  // Check if GitHub is enabled
  const enabled = await isGitHubEnabled(repoRoot)
  if (!enabled) {
    console.error("Error: GitHub integration is not enabled.")
    console.error("Run 'work github enable' first.")
    process.exit(1)
  }

  // Load index and resolve stream
  let index
  try {
    index = loadIndex(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId)
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified and no current workstream set.")
    console.error("Use --stream to specify a workstream, or run 'work current --set <stream>'")
    process.exit(1)
  }

  // Find the stream
  const stream = index.streams.find(
    (s) => s.id === resolvedStreamId || s.name === resolvedStreamId
  )
  if (!stream) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`)
    process.exit(1)
  }

  // Check if branch already exists in metadata
  if (stream.github?.branch) {
    console.log(`Branch already exists: ${stream.github.branch}`)
    console.log("To checkout, run:")
    console.log(`  git checkout ${stream.github.branch}`)
    return
  }

  // Create the branch
  console.log(`Creating branch for workstream: ${stream.id}`)
  if (cliArgs.fromRef) {
    console.log(`Base branch: ${cliArgs.fromRef}`)
  }

  try {
    const result = await createWorkstreamBranch(repoRoot, stream.id, cliArgs.fromRef)
    
    console.log("")
    console.log("Branch created and checked out successfully!")
    console.log("")
    console.log(`  Branch: ${result.branchName}`)
    console.log(`  SHA:    ${result.sha.substring(0, 7)}`)
    console.log(`  URL:    ${result.url}`)
    console.log("")
    console.log("You are now on the workstream branch.")
  } catch (e) {
    const error = e as Error
    console.error(`Error creating branch: ${error.message}`)
    process.exit(1)
  }
}

// ============================================
// CREATE-ISSUES COMMAND
// ============================================

interface CreateIssuesArgs {
  repoRoot?: string
  streamId?: string
  stage?: number
  json: boolean
}

function parseCreateIssuesArgs(argv: string[]): CreateIssuesArgs | null {
  const args = argv.slice(3) // Skip: bun, work-github, create-issues
  const parsed: CreateIssuesArgs = { json: false }

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

      case "--stage":
      case "-st":
        if (!next) {
          console.error("Error: --stage requires a value")
          return null
        }
        parsed.stage = parseInt(next, 10)
        if (isNaN(parsed.stage)) {
          console.error("Error: --stage must be a number")
          return null
        }
        i++
        break

      case "--json":
      case "-j":
        parsed.json = true
        break

      case "--help":
      case "-h":
        printCreateIssuesHelp()
        process.exit(0)
    }
  }

  return parsed
}

async function createIssuesCommand(argv: string[]): Promise<void> {
  const cliArgs = parseCreateIssuesArgs(argv)
  if (!cliArgs) {
    console.error("\nRun 'work github create-issues --help' for usage information.")
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

  // Check if GitHub is enabled
  const enabled = await isGitHubEnabled(repoRoot)
  if (!enabled) {
    console.error("Error: GitHub integration is not enabled")
    console.error("Run 'work github enable' to enable it")
    process.exit(1)
  }

  // Ensure auth is available
  try {
    await ensureGitHubAuth()
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    process.exit(1)
  }

  // Load index and get stream
  let index
  try {
    index = loadIndex(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId)
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified and no current workstream set.")
    console.error("Use --stream to specify a workstream, or run 'work current --set <stream>'")
    process.exit(1)
  }

  const stream = getStream(index, resolvedStreamId)

  // Load tasks
  const executionItems = listThreadExecutionItems(repoRoot, stream.id)
  if (executionItems.length === 0) {
    console.error("Error: No tasks found for workstream")
    process.exit(1)
  }

  // Group tasks by stage
  const stages = groupTasksByStage(executionItems)

  // Validate stage filter if provided
  if (cliArgs.stage !== undefined && !stages.has(cliArgs.stage)) {
    console.error(`Error: No tasks found for stage ${cliArgs.stage}`)
    process.exit(1)
  }

  // Create issues for stages (filtered if --stage provided)
  const result = await createIssuesForStages(
    repoRoot,
    stream.id,
    stream.name,
    stages,
    cliArgs.stage
  )

  // Output results
  if (cliArgs.json) {
    console.log(JSON.stringify({
      streamId: stream.id,
      streamName: stream.name,
      ...result,
    }, null, 2))
  } else {
    if (result.created.length > 0) {
      console.log(`Created ${result.created.length} stage issue(s):`)
      for (const item of result.created) {
        console.log(`  Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName}`)
        console.log(`    ${item.issueUrl}`)
      }
    }

    if (result.reopened.length > 0) {
      console.log(`\nReopened ${result.reopened.length} stage issue(s):`)
      for (const item of result.reopened) {
        console.log(`  Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName}`)
        console.log(`    ${item.issueUrl}`)
      }
    }

    if (result.skipped.length > 0) {
      console.log(`\nSkipped ${result.skipped.length} stage(s):`)
      for (const item of result.skipped) {
        console.log(`  Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName} - ${item.reason}`)
      }
    }

    if (result.failed.length > 0) {
      console.log(`\nFailed ${result.failed.length} stage(s):`)
      for (const item of result.failed) {
        console.log(`  Stage ${item.stageNumber.toString().padStart(2, "0")}: ${item.stageName} - ${item.error}`)
      }
    }

    if (result.created.length === 0 && result.reopened.length === 0 && result.skipped.length === 0 && result.failed.length === 0) {
      console.log("No stages to process")
    }
  }
}

// ============================================
// SUBCOMMAND: enable
// ============================================

interface EnableDisableStatusArgs {
  repoRoot?: string
}

function parseSimpleArgs(argv: string[], commandIndex: number): EnableDisableStatusArgs | null {
  const args = argv.slice(commandIndex + 1)
  const parsed: EnableDisableStatusArgs = {}

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

      case "--help":
      case "-h":
        return null // Signal to show help
    }
  }

  return parsed
}

async function enableCommand(argv: string[]): Promise<void> {
  const args = argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    printEnableHelp()
    process.exit(0)
  }

  const cliArgs = parseSimpleArgs(argv, 2)
  
  // Auto-detect repo root if not provided
  let repoRoot: string
  try {
    repoRoot = cliArgs?.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  console.log("Enabling GitHub integration...")

  try {
    await enableGitHub(repoRoot)
    const config = await loadGitHubConfig(repoRoot)
    console.log(`GitHub integration enabled for ${config.owner}/${config.repo}`)
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// ============================================
// SUBCOMMAND: disable
// ============================================

async function disableCommand(argv: string[]): Promise<void> {
  const args = argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    printDisableHelp()
    process.exit(0)
  }

  const cliArgs = parseSimpleArgs(argv, 2)
  
  // Auto-detect repo root if not provided
  let repoRoot: string
  try {
    repoRoot = cliArgs?.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  console.log("Disabling GitHub integration...")

  try {
    await disableGitHub(repoRoot)
    console.log("GitHub integration disabled")
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// ============================================
// SUBCOMMAND: status
// ============================================

async function statusCommand(argv: string[]): Promise<void> {
  const args = argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    printStatusHelp()
    process.exit(0)
  }

  const cliArgs = parseSimpleArgs(argv, 2)
  
  // Auto-detect repo root if not provided
  let repoRoot: string
  try {
    repoRoot = cliArgs?.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  const config = await loadGitHubConfig(repoRoot)

  console.log("GitHub Integration Status")
  console.log("=".repeat(40))
  console.log()

  // Enabled status
  console.log(`Enabled:       ${config.enabled ? "Yes" : "No"}`)

  // Repository
  if (config.owner && config.repo) {
    console.log(`Repository:    ${config.owner}/${config.repo}`)
  } else {
    console.log("Repository:    Not configured")
  }

  // Branch prefix
  console.log(`Branch Prefix: ${config.branch_prefix}`)
  console.log()

  // Authentication status
  console.log("Authentication:")
  const token = getGitHubAuth()
  if (token) {
    const isValid = await validateAuth(token)
    const source = process.env.GITHUB_TOKEN
      ? "GITHUB_TOKEN"
      : process.env.GH_TOKEN
        ? "GH_TOKEN"
        : "gh CLI"
    console.log(`  Source:      ${source}`)
    console.log(`  Valid:       ${isValid ? "Yes" : "No"}`)
  } else {
    console.log("  Status:      Not authenticated")
    console.log("  Hint:        Set GITHUB_TOKEN, GH_TOKEN, or run 'gh auth login'")
  }

  console.log()

  // Label configuration
  console.log("Label Configuration:")
  console.log(`  Workstream:  ${config.label_config.workstream.prefix} (color: #${config.label_config.workstream.color})`)
  console.log(`  Stage:       ${config.label_config.stage.prefix} (color: #${config.label_config.stage.color})`)
  console.log(`  Batch:       ${config.label_config.batch.prefix} (color: #${config.label_config.batch.color})`)
  console.log(`  Thread:      ${config.label_config.thread.prefix} (color: #${config.label_config.thread.color})`)
}

// ============================================
// SUBCOMMAND: sync
// ============================================

interface SyncArgs {
  repoRoot?: string
  streamId?: string
  json: boolean
}

function parseSyncArgs(argv: string[]): SyncArgs | null {
  const args = argv.slice(3) // Skip: bun, work-github, sync
  const parsed: SyncArgs = { json: false }

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

      case "--json":
      case "-j":
        parsed.json = true
        break

      case "--help":
      case "-h":
        printSyncHelp()
        process.exit(0)
    }
  }

  return parsed
}

async function syncCommand(argv: string[]): Promise<void> {
  const cliArgs = parseSyncArgs(argv)
  if (!cliArgs) {
    console.error("\nRun 'work github sync --help' for usage information.")
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

  // Check if GitHub is enabled
  const enabled = await isGitHubEnabled(repoRoot)
  if (!enabled) {
    console.error("Error: GitHub integration is not enabled")
    console.error("Run 'work github enable' to enable it")
    process.exit(1)
  }

  // Ensure auth is available
  try {
    await ensureGitHubAuth()
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    process.exit(1)
  }

  // Load index and get stream
  let index
  try {
    index = loadIndex(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId)
  if (!resolvedStreamId) {
    console.error("Error: No workstream specified and no current workstream set.")
    console.error("Use --stream to specify a workstream, or run 'work current --set <stream>'")
    process.exit(1)
  }

  const stream = getStream(index, resolvedStreamId)

  // Sync issue states (stage-level)
  if (!cliArgs.json) {
    console.log(`Syncing stage issue states for workstream: ${stream.id}`)
    console.log("")
  }

  let result: SyncStageIssuesResult
  try {
    result = await syncStageIssues(repoRoot, stream.id)
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    process.exit(1)
  }

  // Output results
  if (cliArgs.json) {
    console.log(JSON.stringify({
      streamId: stream.id,
      streamName: stream.name,
      ...result,
    }, null, 2))
  } else {
    // Report closed issues
    if (result.closed.length > 0) {
      console.log(`Closed ${result.closed.length} stage issue(s):`)
      for (const item of result.closed) {
        console.log(`  Stage ${item.stageNumber}: ${item.stageName}`)
        console.log(`    #${item.issueNumber}: ${item.issueUrl}`)
      }
      console.log("")
    }

    // Report unchanged issues
    if (result.unchanged.length > 0) {
      console.log(`Unchanged ${result.unchanged.length} stage issue(s):`)
      for (const item of result.unchanged) {
        console.log(`  Stage ${item.stageNumber}: ${item.stageName} - ${item.reason}`)
      }
      console.log("")
    }

    // Report errors
    if (result.errors.length > 0) {
      console.log(`Errors ${result.errors.length}:`)
      for (const item of result.errors) {
        console.log(`  Stage ${item.stageNumber}: ${item.stageName} - ${item.error}`)
      }
      console.log("")
    }

    // Summary
    const closedCount = result.closed.length
    const unchangedCount = result.unchanged.length
    const errorCount = result.errors.length

    if (closedCount === 0 && unchangedCount === 0 && errorCount === 0) {
      console.log("No stage issues to sync (no stages have associated GitHub issues)")
    } else {
      console.log(`Summary: Closed ${closedCount} stage issues, ${unchangedCount} unchanged`)
      if (errorCount > 0) {
        console.log(`  ${errorCount} error(s) occurred`)
      }
    }
  }
}

// ============================================
// MAIN
// ============================================

export function main(argv: string[] = process.argv): void {
  const args = argv.slice(2)

  if (args.length === 0) {
    printHelp()
    process.exit(0)
  }

  const firstArg = args[0]

  if (firstArg === "--help" || firstArg === "-h") {
    printHelp()
    process.exit(0)
  }

  if (!SUBCOMMANDS.includes(firstArg as Subcommand)) {
    console.error(`Error: Unknown subcommand "${firstArg}"`)
    console.error("\nAvailable subcommands: " + SUBCOMMANDS.join(", "))
    console.error("\nRun 'work github --help' for usage information.")
    process.exit(1)
  }

  const subcommand = firstArg as Subcommand

  switch (subcommand) {
    case "enable":
      enableCommand(argv)
      break

    case "disable":
      disableCommand(argv)
      break

    case "status":
      statusCommand(argv)
      break

    case "create-branch":
      createBranchCommand(argv)
      break

    case "create-issues":
      createIssuesCommand(argv)
      break

    case "sync":
      syncCommand(argv)
      break
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}

// ============================================
// EXPORTED FUNCTIONS FOR USE BY OTHER MODULES
// ============================================

/**
 * Result type for createStageIssuesForWorkstream
 */
export interface CreateStageIssuesForWorkstreamResult {
  created: { stageNumber: number; stageName: string; issueUrl: string; issueNumber: number }[]
  skipped: { stageNumber: number; stageName: string; reason: string }[]
  reopened: { stageNumber: number; stageName: string; issueUrl: string; issueNumber: number }[]
  failed: { stageNumber: number; stageName: string; error: string }[]
}

/**
 * Create stage-level GitHub issues for a workstream.
 * This is a convenience wrapper for use by other modules (e.g., start.ts).
 * 
 * @param repoRoot Repository root path
 * @param streamId Workstream ID
 * @param streamName Workstream name
 * @returns Result with created, skipped, reopened, and failed arrays
 */
export async function createStageIssuesForWorkstream(
  repoRoot: string,
  streamId: string,
  streamName: string
): Promise<CreateStageIssuesForWorkstreamResult> {
  // Load tasks
  const executionItems = listThreadExecutionItems(repoRoot, streamId)
  if (executionItems.length === 0) {
    return { created: [], skipped: [], reopened: [], failed: [] }
  }

  // Group tasks by stage
  const stages = groupTasksByStage(executionItems)

  // Create issues for all stages
  return createIssuesForStages(repoRoot, streamId, streamName, stages)
}
