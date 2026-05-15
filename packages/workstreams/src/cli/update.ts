/**
 * CLI: Update Thread Status
 *
 * Updates a thread status in a workstream.
 */

import type { ExecutionStatus } from "../lib/types.ts"
import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { updateThreadExecution } from "../lib/update.ts"

interface UpdateCliArgs {
  repoRoot?: string
  streamId?: string
  threadId?: string
  status: ExecutionStatus
  note?: string
  breadcrumb?: string
  report?: string
  assigned_agent?: string
}

const VALID_STATUSES: ExecutionStatus[] = ["pending", "in_progress", "completed", "blocked", "cancelled"]

function printHelp(): void {
  console.log(`
work update - Update a thread status

Usage:
  work update --thread <id> --status <status> [options]

Required:
  --thread         Thread ID (e.g., "01.01.01" = Stage 01, Batch 01, Thread 01)
  --status         New status: pending, in_progress, completed, blocked, cancelled

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --note, -n       Add implementation note
  --breadcrumb, -b Add recovery breadcrumb (last action)
  --report         Completion report (brief summary of what was done)
  --agent          Assign agent to thread
  --help, -h       Show this help message

Examples:
  work update --thread "01.01.01" --status completed
  work update --thread "01.01.01" --status completed --report "Added hono dependencies."
  work update --thread "01.01.02" --status cancelled
  work update --stream "001-my-stream" --thread "01.01.01" --status completed
`)
}

function parseCliArgs(argv: string[]): UpdateCliArgs | null {
  const rawArgs = argv.slice(2)
  const args = rawArgs[0] === "update" ? rawArgs.slice(1) : rawArgs
  const parsed: Partial<UpdateCliArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) return console.error("Error: --repo-root requires a value"), null
        parsed.repoRoot = next
        i++
        break
      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) return console.error("Error: --stream requires a value"), null
        parsed.streamId = next
        i++
        break
      case "--thread":
        if (!next) return console.error("Error: --thread requires a value"), null
        parsed.threadId = next
        i++
        break
      case "--status":
        if (!next) return console.error("Error: --status requires a value"), null
        if (!VALID_STATUSES.includes(next as ExecutionStatus)) {
          console.error(`Error: Invalid status "${next}". Valid: ${VALID_STATUSES.join(", ")}`)
          return null
        }
        parsed.status = next as ExecutionStatus
        i++
        break
      case "--note":
      case "-n":
        if (!next) return console.error("Error: --note requires a value"), null
        parsed.note = next
        i++
        break
      case "--breadcrumb":
      case "-b":
        if (!next) return console.error("Error: --breadcrumb requires a value"), null
        parsed.breadcrumb = next
        i++
        break
      case "--report":
        if (!next) return console.error("Error: --report requires a value"), null
        parsed.report = next
        i++
        break
      case "--agent":
        if (!next) return console.error("Error: --agent requires a value"), null
        parsed.assigned_agent = next
        i++
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

  if (!parsed.threadId) return console.error("Error: --thread is required"), null
  if (!parsed.status) return console.error("Error: --status is required"), null
  return parsed as UpdateCliArgs
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
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

  try {
    const result = await updateThreadExecution({
      repoRoot,
      stream,
      threadId: cliArgs.threadId!,
      status: cliArgs.status,
      note: cliArgs.note,
      breadcrumb: cliArgs.breadcrumb,
      report: cliArgs.report,
      assigned_agent: cliArgs.assigned_agent,
    })
    console.log(`Updated thread ${result.threadId} to ${result.thread.status}`)
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}
