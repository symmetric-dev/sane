/**
 * CLI: Session Management
 *
 * Manage agent sessions for workstream threads.
 * 
 * Subcommands:
 *   complete    - Mark sessions as completed
 *   
 * This is useful for recovery when tmux exits unexpectedly or agent crashes,
 * allowing manual cleanup of stale 'running' or 'interrupted' sessions.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, resolveStreamId } from "../lib/index.ts"
import { parseThreadId } from "../lib/execution-ids.ts"
import { loadThreads, saveThreads } from "../lib/threads.ts"
import type { SessionStatus, SessionRecord, ThreadMetadata } from "../lib/types.ts"

interface SessionCliArgs {
  repoRoot?: string
  subcommand?: "complete"
  // complete options
  thread?: string // Thread ID pattern (e.g., "01.01.01")
  batch?: string // Batch ID pattern (e.g., "01.01")
  all?: boolean // Complete all running/interrupted sessions
  json: boolean
}

function printHelp(): void {
  console.log(`
work session - Manage agent sessions

Usage:
  work session <subcommand> [options]

Subcommands:
  complete    Mark sessions as completed

Complete Options:
  --thread, -t <id>   Complete sessions for specific thread (e.g., "01.01.01")
  --batch, -b <id>    Complete all sessions in batch (e.g., "01.01")
  --all               Complete all running/interrupted sessions

Global Options:
  --repo-root, -r     Repository root (auto-detected if omitted)
  --json              Output as JSON
  --help, -h          Show this help message

Description:
  Sessions track agent execution on threads. When tmux exits unexpectedly
  or an agent crashes, sessions may be left in 'running' or 'interrupted'
  state. Use this command to manually mark them as 'completed'.

Examples:
  # Complete sessions for a specific thread
  work session complete --thread "01.01.01"

  # Complete all sessions in a batch
  work session complete --batch "01.01"

  # Complete all running/interrupted sessions in the workstream
  work session complete --all
`)
}

function parseCliArgs(argv: string[]): SessionCliArgs | null {
  const args = argv.slice(2)
  const parsed: SessionCliArgs = { json: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "complete":
        parsed.subcommand = "complete"
        break

      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value")
          return null
        }
        parsed.repoRoot = next
        i++
        break

      case "--thread":
      case "-t":
        if (!next) {
          console.error("Error: --thread requires a value")
          return null
        }
        parsed.thread = next
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

      case "--all":
        parsed.all = true
        break

      case "--json":
      case "-j":
        parsed.json = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed
}

/**
 * Find all sessions with 'running' or 'interrupted' status
 */
function findIncompleteThreadSessions(
  threads: ThreadMetadata[],
  filter?: { threadPrefix?: string; batchPrefix?: string }
): Array<{ thread: ThreadMetadata; session: SessionRecord }> {
  const results: Array<{ thread: ThreadMetadata; session: SessionRecord }> = []

  for (const thread of threads) {
    if (!thread.sessions) continue

    if (filter?.threadPrefix && thread.threadId !== filter.threadPrefix) {
      continue
    }
    if (filter?.batchPrefix && !thread.threadId.startsWith(filter.batchPrefix + ".")) {
      continue
    }

    for (const session of thread.sessions) {
      if (session.status === "running" || session.status === "interrupted") {
        results.push({ thread, session })
      }
    }
  }

  return results
}

/**
 * Complete sessions by marking them as 'completed'
 */
function completeSessions(
  repoRoot: string,
  streamId: string,
  filter?: { threadPrefix?: string; batchPrefix?: string }
): {
  completed: Array<{ threadId: string; sessionId: string; previousStatus: SessionStatus }>
  errors: string[]
} {
  const threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) {
    return { completed: [], errors: ["Thread runtime state not found"] }
  }

  const incompleteSessions = findIncompleteThreadSessions(threadsFile.threads, filter)
  const completed: Array<{ threadId: string; sessionId: string; previousStatus: SessionStatus }> = []
  const errors: string[] = []
  const now = new Date().toISOString()

  for (const { thread, session } of incompleteSessions) {
    const previousStatus = session.status

    session.status = "completed"
    session.completedAt = now

    if (thread.currentSessionId === session.sessionId) {
      thread.currentSessionId = undefined
    }
    thread.updatedAt = now

    completed.push({
      threadId: thread.threadId,
      sessionId: session.sessionId,
      previousStatus,
    })
  }

  if (completed.length > 0) {
    saveThreads(repoRoot, streamId, threadsFile)
  }

  return { completed, errors }
}

/**
 * Handle the 'complete' subcommand
 */
function handleComplete(
  repoRoot: string,
  streamId: string,
  cliArgs: SessionCliArgs
): void {
  // Validate that at least one filter is provided
  if (!cliArgs.thread && !cliArgs.batch && !cliArgs.all) {
    console.error("Error: Must specify --thread, --batch, or --all")
    console.error("\nRun 'work session complete --help' for usage information.")
    process.exit(1)
  }

  // Build filter based on options
  let filter: { threadPrefix?: string; batchPrefix?: string } | undefined

  if (cliArgs.thread) {
    // Validate thread ID format
    try {
      parseThreadId(cliArgs.thread)
      filter = { threadPrefix: cliArgs.thread }
    } catch (e) {
      console.error(`Error: Invalid thread ID format "${cliArgs.thread}"`)
      console.error("Expected format: SS.BB.TT (e.g., 01.01.01)")
      process.exit(1)
    }
  } else if (cliArgs.batch) {
    // Validate batch ID format (SS.BB)
    const parts = cliArgs.batch.split(".")
    if (parts.length !== 2 || parts.some(p => isNaN(parseInt(p, 10)))) {
      console.error(`Error: Invalid batch ID format "${cliArgs.batch}"`)
      console.error("Expected format: SS.BB (e.g., 01.01)")
      process.exit(1)
    }
    filter = { batchPrefix: cliArgs.batch }
  }
  // If --all, filter remains undefined (no filtering)

  const result = completeSessions(repoRoot, streamId, filter)

  if (cliArgs.json) {
    console.log(JSON.stringify({
      streamId,
      completed: result.completed,
      errors: result.errors,
      count: result.completed.length,
    }, null, 2))
  } else {
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        console.error(`Error: ${error}`)
      }
    }

    if (result.completed.length === 0) {
      const scope = cliArgs.thread
        ? `thread "${cliArgs.thread}"`
        : cliArgs.batch
          ? `batch "${cliArgs.batch}"`
          : "workstream"
      console.log(`No running or interrupted sessions found in ${scope}.`)
    } else {
      console.log(`Completed ${result.completed.length} session(s):`)
      console.log("")
      for (const item of result.completed) {
        console.log(`  Thread ${item.threadId}`)
        console.log(`    Session: ${item.sessionId}`)
        console.log(`    Previous status: ${item.previousStatus}`)
        console.log("")
      }
    }
  }
}

export function main(argv: string[] = process.argv): void {
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

  // Load index and resolve stream ID
  let index
  try {
    index = loadIndex(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  const resolvedStreamId = resolveStreamId(index, undefined)
  if (!resolvedStreamId) {
    console.error("Error: No current workstream set.")
    console.error("Run 'work current --set <stream-id>' to set one.")
    process.exit(1)
  }

  // Handle subcommand
  if (!cliArgs.subcommand) {
    console.error("Error: No subcommand specified")
    printHelp()
    process.exit(1)
  }

  switch (cliArgs.subcommand) {
    case "complete":
      handleComplete(repoRoot, resolvedStreamId, cliArgs)
      break
    default:
      console.error(`Error: Unknown subcommand "${cliArgs.subcommand}"`)
      printHelp()
      process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
