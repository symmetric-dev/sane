/**
 * CLI: Workstream Read
 *
 * Read thread details.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import {
  queryThreadByIdForWorkstream,
  type HierarchyThreadQueryRecord,
} from "../lib/hierarchy-query.ts"

interface ReadCliArgs {
  repoRoot?: string
  streamId?: string
  threadId?: string
  json: boolean
}

function toPublicThreadView(thread: HierarchyThreadQueryRecord) {
  return {
    threadId: thread.threadId,
    stageId: thread.stageId,
    stageName: thread.stageName,
    batchId: thread.batchId,
    batchName: thread.batchName,
    threadName: thread.threadName,
    aggregateStatus: thread.aggregateStatus,
    itemCount: thread.itemCount,
    ...(thread.assignedAgent ? { assignedAgent: thread.assignedAgent } : {}),
    ...(thread.breadcrumb ? { breadcrumb: thread.breadcrumb } : {}),
    ...(thread.report ? { report: thread.report } : {}),
  }
}

function printHelp(): void {
  console.log(`
work read - Read thread details

Usage:
  work read --thread <thread-id> [--stream <stream-id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --thread         Thread ID in format "stage.batch.thread" (e.g., "01.01.02")
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # Read thread 01.01.02 (uses current workstream)
  work read --thread "01.01.02"

  # Read a specific thread from a specific workstream
  work read --stream "001-my-stream" --thread "01.01.02"
`)
}

function parseCliArgs(argv: string[]): ReadCliArgs | null {
  const rawArgs = argv.slice(2)
  const args = rawArgs[0] === "read" ? rawArgs.slice(1) : rawArgs
  const parsed: ReadCliArgs = { json: false }

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
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value")
          return null
        }
        parsed.streamId = next
        i++
        break

      case "--thread":
        if (!next) {
          console.error("Error: --thread requires a value")
          return null
        }
        parsed.threadId = next
        i++
        break

      case "--json":
      case "-j":
        parsed.json = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)

      default:
        console.error(`Error: Unknown argument: ${arg}`)
        return null
    }
  }

  return parsed
}

function formatThread(thread: HierarchyThreadQueryRecord): string {
  const lines: string[] = []

  lines.push(`Thread ${thread.threadId}: ${thread.threadName}`)
  lines.push(`Stage: ${thread.stageName}`)
  lines.push(`Batch: ${thread.batchName}`)
  lines.push(`Status: ${thread.aggregateStatus}`)
  lines.push(`Item count: ${thread.itemCount}`)
  if (thread.assignedAgent) {
    lines.push(`Assigned agent: ${thread.assignedAgent}`)
  }
  if (thread.breadcrumb) {
    lines.push(`Breadcrumb: ${thread.breadcrumb}`)
  }
  if (thread.report) {
    lines.push(`Report: ${thread.report}`)
  }
  return lines.join("\n")
}

export function main(argv: string[] = process.argv): void {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  if (!cliArgs.threadId) {
    console.error("Error: --thread is required")
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

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

  const thread = queryThreadByIdForWorkstream(repoRoot, stream.id, cliArgs.threadId)
  if (!thread) {
    console.error(`Error: Thread "${cliArgs.threadId}" not found in workstream "${stream.id}"`)
    process.exit(1)
  }

  if (cliArgs.json) {
    console.log(JSON.stringify(toPublicThreadView(thread), null, 2))
  } else {
    console.log(formatThread(thread))
  }
}

if (import.meta.main) {
  main()
}
