/**
 * CLI: Continue (Session-aware)
 *
 * Checks for incomplete/failed threads with session history before continuing.
 * Offers options to continue or abort before running the next batch.
 */

import { main as multiMain } from "./multi.ts"
import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { findNextIncompleteBatchFromThreads } from "./multi.ts"
import { loadThreads } from "../lib/threads.ts"
import { queryThreadsForWorkstream, type HierarchyThreadQueryRecord } from "../lib/hierarchy-query.ts"
import {
  createReadlineInterface,
  displayThreadStatusTable,
  type ThreadStatus,
} from "../lib/interactive.ts"
import type { ThreadMetadata } from "../lib/types.ts"

interface ContinueCliArgs {
  repoRoot?: string
  streamId?: string
  port?: number
  dryRun?: boolean
  noServer?: boolean
  headless?: boolean
  async?: boolean
}

function printHelp(): void {
  console.log(`
work continue - Continue execution with session awareness

Usage:
  work continue [options]

Description:
  Finds the next incomplete batch from canonical thread views first, then checks
  for any incomplete/failed threads with session history. Offers options to:
  - Continue with the batch anyway
  - Abort

  If no issues are found, proceeds directly to execute the next batch.

Options:
  --port, -p       OpenCode server port (default: 4096)
  --dry-run        Show commands without executing
  --no-server      Skip starting opencode serve
  --headless       Skip prompts; auto-abort if prior session history needs review
  --async          Forward async execution to work multi (requires --headless)
  --repo-root, -r  Repository root
  --stream, -s     Workstream ID or name (uses current if not specified)
  --help, -h       Show this help message

Examples:
  work continue
  work continue --dry-run
  work continue --headless
  work continue --headless --async
`)
}

export function parseCliArgs(argv: string[]): ContinueCliArgs | null {
  const args = argv.slice(2)
  const parsed: ContinueCliArgs = {}

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

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  if (parsed.async && !parsed.headless) {
    console.error("Error: --async requires --headless")
    return null
  }

  return parsed
}

export function findIncompleteThreadViewsInBatch(
  batchId: string,
  threadViews: HierarchyThreadQueryRecord[],
  threadMetadata: ThreadMetadata[] = [],
): string[] {
  const threadMetadataMap = new Map(threadMetadata.map((thread) => [thread.threadId, thread]))

  return threadViews
    .filter((thread) => thread.batchId === batchId)
    .filter((thread) => {
      const hasSessionHistory = (threadMetadataMap.get(thread.threadId)?.sessions.length ?? 0) > 0

      return thread.aggregateStatus !== "completed" && hasSessionHistory
    })
    .map((thread) => thread.threadId)
}

export function buildHeadlessThreadStatuses(
  threadIds: string[],
  threadMetadata: ThreadMetadata[] = [],
  threadViews: HierarchyThreadQueryRecord[] = [],
): ThreadStatus[] {
  const threadMetadataMap = new Map(threadMetadata.map((thread) => [thread.threadId, thread]))
  const threadViewMap = new Map(threadViews.map((thread) => [thread.threadId, thread]))

  return threadIds.map((threadId) => {
    const meta = threadMetadataMap.get(threadId)
    const threadView = threadViewMap.get(threadId)
    const lastSession = meta && meta.sessions.length > 0 ? meta.sessions[meta.sessions.length - 1] : undefined

    return {
      threadId,
      threadName: threadView?.threadName || "(unknown)",
      status: threadView?.aggregateStatus === "completed"
        ? "completed"
        : lastSession?.status === "failed"
          ? "failed"
          : "incomplete",
      sessionsCount: meta?.sessions.length ?? 0,
      lastAgent: lastSession?.agentName,
    }
  })
}

export function resolveHeadlessContinueAction(
  incompleteThreads: string[],
): "continue" | "abort" {
  return incompleteThreads.length > 0 ? "abort" : "continue"
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
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

  const threadViews = queryThreadsForWorkstream(repoRoot, stream.id)
  if (threadViews.length === 0) {
    console.error(`Error: No canonical execution hierarchy found for stream ${stream.id}`)
    console.error(`\nHint: Run 'work approve plan' to initialize the execution hierarchy for this batch.`)
    process.exit(1)
  }

  const nextBatch = findNextIncompleteBatchFromThreads(threadViews)
  if (!nextBatch) {
    console.log("All batches are complete! Nothing to continue.")
    process.exit(0)
  }

  // Check for incomplete/failed threads with session history in the next batch
  const threadMetadata = loadThreads(repoRoot, stream.id)?.threads ?? []
  const incompleteThreads = findIncompleteThreadViewsInBatch(
    nextBatch,
    threadViews,
    threadMetadata,
  )
  const headlessAction = resolveHeadlessContinueAction(incompleteThreads)
  
  if (incompleteThreads.length > 0) {
    // Display summary of issues
    console.log(`\nFound ${incompleteThreads.length} incomplete/failed thread(s) with session history in batch ${nextBatch}:\n`)
    
    const threadStatuses = buildHeadlessThreadStatuses(
      incompleteThreads,
      threadMetadata,
      threadViews.filter((thread) => thread.batchId === nextBatch),
    )
    displayThreadStatusTable(threadStatuses)

    if (cliArgs.headless) {
      const dryRunPrefix = cliArgs.dryRun ? "Dry run: " : ""
      console.log(
        `${dryRunPrefix}headless mode automatic choice: abort.`,
      )
      console.log(
        "Reason: unresolved thread session history requires an explicit operator decision before rerunning this batch.",
      )
      console.log(
        "Re-run without --headless to choose interactively, or resolve the threads first.",
      )
      process.exit(cliArgs.dryRun ? 0 : 1)
    }
    
    // Offer interactive prompt
    const rl = createReadlineInterface()
    
    try {
      console.log("Options:")
      console.log("  1. Continue with this batch anyway")
      console.log("  2. Abort")
      console.log("\nHint: To address issues first, run `work add-stage --stage <n> --name \"fix-<topic>\"`.")
      
      const answer = await new Promise<string>((resolve) => {
        rl.question("\nSelect option (1-2): ", resolve)
      })
      
      rl.close()
      
      const choice = answer.trim()
      
      if (choice === "1") {
        // Continue with multi
        console.log("\nContinuing with the next batch anyway...\n")
      } else if (choice === "2") {
        console.log("\nAborted.")
        process.exit(0)
      } else {
        console.error(`\nInvalid option: "${choice}"`)
        process.exit(1)
      }
    } catch (err) {
      rl.close()
      throw err
    }
  } else {
    if (cliArgs.headless && headlessAction === "continue") {
      console.log(
        `\nHeadless mode automatic choice: continue with next incomplete batch ${nextBatch}.`,
      )
    } else {
      console.log(`\nContinuing with next incomplete batch: ${nextBatch}`)
    }
  }

  // Proceed with multi --continue
  const originalArgs = argv.slice(2)
  const newArgs = [
    argv[0]!, // runtime
    argv[1]!, // script path
    "--continue",
    ...originalArgs
  ]

  // Call multiMain
  await multiMain(newArgs)
}

// Run if called directly
if (import.meta.main) {
  main()
}
