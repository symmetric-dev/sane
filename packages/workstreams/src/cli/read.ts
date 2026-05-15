/**
 * CLI: Workstream Read
 *
 * Read thread-first details with compatibility task fallback.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import {
  queryTaskByIdForWorkstream,
  queryThreadByIdForWorkstream,
  type HierarchyThreadQueryRecord,
} from "../lib/hierarchy-query.ts"
import type { Task } from "../lib/types.ts"

interface ReadCliArgs {
  repoRoot?: string
  streamId?: string
  threadId?: string
  taskId?: string
  json: boolean
}

function printHelp(): void {
  console.log(`
work read - Read thread or compatibility task details

Usage:
  work read --thread <thread-id> [--stream <stream-id>]
  work read --task <task-id> [--stream <stream-id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --thread         Thread ID in format "stage.batch.thread" (e.g., "01.01.02") (primary)
  --task, -t       Compatibility task ID in format "stage.batch.thread.task" (e.g., "01.01.02.01")
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # Read thread 01.01.02 (uses current workstream)
  work read --thread "01.01.02"

  # Read compatibility task from specific workstream
  work read --stream "001-my-stream" --task "01.01.02.01"
`)
}

function parseCliArgs(argv: string[]): ReadCliArgs | null {
  const args = argv.slice(2)
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

      case "--task":
      case "-t":
        if (!next) {
          console.error("Error: --task requires a value")
          return null
        }
        parsed.taskId = next
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
    }
  }

  return parsed
}

function formatTask(task: Task): string {
  const lines: string[] = []

  lines.push(`Task ${task.id}: ${task.name}`)
  lines.push(`Stage: ${task.stage_name}`)
  lines.push(`Thread: ${task.thread_name}`)
  lines.push(`Status: ${task.status}`)
  lines.push(`Updated: ${task.updated_at.split("T")[0]}`)

  return lines.join("\n")
}

function formatThread(thread: HierarchyThreadQueryRecord): string {
  const lines: string[] = []

  lines.push(`Thread ${thread.threadId}: ${thread.threadName}`)
  lines.push(`Stage: ${thread.stageName}`)
  lines.push(`Batch: ${thread.batchName}`)
  lines.push(`Status: ${thread.aggregateStatus}`)
  lines.push(`Task count: ${thread.taskCount}`)
  if (thread.assignedAgent) {
    lines.push(`Assigned agent: ${thread.assignedAgent}`)
  }
  if (thread.breadcrumb) {
    lines.push(`Breadcrumb: ${thread.breadcrumb}`)
  }
  if (thread.report) {
    lines.push(`Report: ${thread.report}`)
  }
  if (thread.representativeTaskId) {
    lines.push(`Compatibility task: ${thread.representativeTaskId}`)
  }

  return lines.join("\n")
}

export function main(argv: string[] = process.argv): void {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  if (!cliArgs.threadId && !cliArgs.taskId) {
    console.error("Error: --thread or --task is required")
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  if (cliArgs.threadId && cliArgs.taskId) {
    console.error("Error: --thread and --task are mutually exclusive")
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

  if (cliArgs.threadId) {
    const thread = queryThreadByIdForWorkstream(repoRoot, stream.id, cliArgs.threadId)
    if (!thread) {
      console.error(`Error: Thread "${cliArgs.threadId}" not found in workstream "${stream.id}"`)
      process.exit(1)
    }

    if (cliArgs.json) {
      console.log(JSON.stringify(thread, null, 2))
    } else {
      console.log(formatThread(thread))
    }
    return
  }

  const task = queryTaskByIdForWorkstream(repoRoot, stream.id, cliArgs.taskId!)
  if (!task) {
    console.error(`Error: Task "${cliArgs.taskId}" not found in workstream "${stream.id}"`)
    process.exit(1)
  }

  if (cliArgs.json) {
    console.log(JSON.stringify(task, null, 2))
  } else {
    console.log(formatTask(task))
  }
}

if (import.meta.main) {
  main()
}
