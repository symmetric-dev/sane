/**
 * CLI: Update Task
 *
 * Updates a thread status in a workstream.
 * Compatibility task targeting is an explicit alias for the owning thread.
 */

import type { TaskStatus } from "../lib/types.ts"
import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { updateTask, updateThreadTasks } from "../lib/update.ts"

interface UpdateTaskCliArgs {
  repoRoot?: string
  streamId?: string
  taskId?: string
  threadId?: string
  status: TaskStatus
  note?: string
  breadcrumb?: string
  report?: string
  assigned_agent?: string
}

const VALID_STATUSES: TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "cancelled",
]

function printHelp(): void {
  console.log(`
work update - Update a thread or compatibility task status

Usage:
  work update --thread <id> --status <status> [options]
  work update --task <id> --status <status> [options]

Required (one of):
  --thread         Thread ID (e.g., "01.01.01" = Stage 01, Batch 01, Thread 01) - canonical
  --task, -t       Compatibility task ID alias (e.g., "01.01.01.01" = Stage 01, Batch 01, Thread 01, Task 01)
  --status         New status: pending, in_progress, completed, blocked, cancelled

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --note, -n       Add implementation note
  --breadcrumb, -b Add recovery breadcrumb (last action)
  --report         Completion report (brief summary of what was done)
  --agent          Assign agent to task
  --help, -h       Show this help message

ID Formats:
  Task:   "01.01.02.03" = Stage 01, Batch 01, Thread 02, Task 03
  Thread: "01.01.02"    = Stage 01, Batch 01, Thread 02

Examples:
  # Mark all tasks in a thread completed
  work update --thread "01.01.01" --status completed

  # Compatibility alias: resolve task -> owning thread -> update
  work update --task "01.01.01.01" --status completed

  # Mark task completed with report
  work update --task "01.01.01.01" --status completed --report "Added hono dependencies."

  # Mark all tasks in thread cancelled
  work update --thread "01.01.02" --status cancelled

  # Update in a specific workstream
  work update --stream "001-my-stream" --thread "01.01.01" --status completed
`)
}

function parseCliArgs(argv: string[]): UpdateTaskCliArgs | null {
  const args = argv.slice(2)
  const parsed: Partial<UpdateTaskCliArgs> = {}

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

      case "--task":
      case "-t":
        if (!next) {
          console.error("Error: --task requires a value")
          return null
        }
        parsed.taskId = next
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

      case "--status":
        if (!next) {
          console.error("Error: --status requires a value")
          return null
        }
        if (!VALID_STATUSES.includes(next as TaskStatus)) {
          console.error(
            `Error: Invalid status "${next}". Valid: ${VALID_STATUSES.join(", ")}`,
          )
          return null
        }
        parsed.status = next as TaskStatus
        i++
        break

      case "--note":
      case "-n":
        if (!next) {
          console.error("Error: --note requires a value")
          return null
        }
        parsed.note = next
        i++
        break

      case "--breadcrumb":
      case "-b":
        if (!next) {
          console.error("Error: --breadcrumb requires a value")
          return null
        }
        parsed.breadcrumb = next
        i++
        break

      case "--report":
        if (!next) {
          console.error("Error: --report requires a value")
          return null
        }
        parsed.report = next
        i++
        break

      case "--agent":
        if (!next) {
          console.error("Error: --agent requires a value")
          return null
        }
        parsed.assigned_agent = next
        i++
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  // Validate required args
  if (!parsed.taskId && !parsed.threadId) {
    console.error("Error: --thread or --task is required")
    return null
  }
  if (parsed.taskId && parsed.threadId) {
    console.error("Error: --task and --thread are mutually exclusive")
    return null
  }
  if (!parsed.status) {
    console.error("Error: --status is required")
    return null
  }

  return parsed as UpdateTaskCliArgs
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

  try {
    if (cliArgs.threadId) {
      // Update all tasks in thread
      const result = await updateThreadTasks({
        repoRoot,
        stream,
        threadId: cliArgs.threadId,
        status: cliArgs.status,
        note: cliArgs.note,
        breadcrumb: cliArgs.breadcrumb,
        report: cliArgs.report,
        assigned_agent: cliArgs.assigned_agent,
      })
      console.log(`Updated thread ${result.threadId} (${result.count} compatibility task(s)) to ${result.status}`)
    } else {
      const result = await updateTask({
        repoRoot,
        stream,
        taskId: cliArgs.taskId!,
        status: cliArgs.status,
        note: cliArgs.note,
        breadcrumb: cliArgs.breadcrumb,
        report: cliArgs.report,
        assigned_agent: cliArgs.assigned_agent,
      })
      console.log(
        `Updated thread ${result.threadId} via compatibility task ${result.taskId} ` +
        `(${result.count} compatibility task(s)) to ${result.status}`,
      )
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  await main()
}
