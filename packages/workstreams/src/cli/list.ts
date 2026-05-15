/**
 * CLI: Workstream List
 *
 * List thread views for a workstream.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import {
  queryThreadsForWorkstream,
  queryRuntimeSummaryForWorkstream,
  type HierarchyThreadQueryRecord,
} from "../lib/hierarchy-query.ts"
import type { ExecutionStatus } from "../lib/types.ts"

interface ListCliArgs {
  repoRoot?: string
  streamId?: string
  status?: ExecutionStatus
  json: boolean
  stage?: number
  batch?: string
  thread?: string
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
work list - List threads in a workstream

Usage:
  work list [--stream <stream-id>] [--status <status>]
            [--stage <n>] [--batch <id>] [--thread <id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --status         Filter by status (pending, in_progress, completed, blocked, cancelled)
  --stage          Filter by stage number (e.g. 1)
  --batch          Filter by batch ID (e.g. "01.02")
  --thread         Filter by thread ID (e.g. "01.02.03")
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # List all threads (uses current workstream)
  work list

  # List only in-progress threads
  work list --status in_progress

  # List threads for a specific workstream
  work list --stream "001-my-stream"
`)
}

function parseCliArgs(argv: string[]): ListCliArgs | null {
  const rawArgs = argv.slice(2)
  const args = rawArgs[0] === "list" ? rawArgs.slice(1) : rawArgs
  const parsed: ListCliArgs = { json: false }

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

      case "--status": {
        if (!next) {
          console.error("Error: --status requires a value")
          return null
        }
        const validStatuses = ["pending", "in_progress", "completed", "blocked", "cancelled"]
        if (!validStatuses.includes(next)) {
          console.error(`Error: Invalid status "${next}". Valid values: ${validStatuses.join(", ")}`)
          return null
        }
        parsed.status = next as ExecutionStatus
        i++
        break
      }

      case "--stage": {
        if (!next) {
          console.error("Error: --stage requires a value")
          return null
        }
        const stageNum = parseInt(next, 10)
        if (isNaN(stageNum)) {
          console.error("Error: --stage must be a number")
          return null
        }
        parsed.stage = stageNum
        i++
        break
      }

      case "--batch":
        if (!next) {
          console.error("Error: --batch requires a value")
          return null
        }
        parsed.batch = next
        i++
        break

      case "--thread":
        if (!next) {
          console.error("Error: --thread requires a value")
          return null
        }
        parsed.thread = next
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

function statusToIcon(status: ExecutionStatus): string {
  switch (status) {
    case "completed":
      return "[x]"
    case "in_progress":
      return "[~]"
    case "blocked":
      return "[!]"
    case "cancelled":
      return "[-]"
    default:
      return "[ ]"
  }
}

function formatThreadList(streamId: string, threads: HierarchyThreadQueryRecord[]): string {
  const lines: string[] = []
  const counts = {
    total: threads.length,
    completed: threads.filter((thread) => thread.aggregateStatus === "completed").length,
    in_progress: threads.filter((thread) => thread.aggregateStatus === "in_progress").length,
    pending: threads.filter((thread) => thread.aggregateStatus === "pending").length,
    blocked: threads.filter((thread) => thread.aggregateStatus === "blocked").length,
  }

  lines.push(`Workstream: ${streamId}`)
  lines.push(
    `Threads: ${counts.total} total | ${counts.completed} completed | ${counts.in_progress} in progress | ${counts.pending} pending${counts.blocked ? ` | ${counts.blocked} blocked` : ""}`,
  )
  lines.push("")

  const stageMap = new Map<string, { name: string; batches: Map<string, { name: string; threads: HierarchyThreadQueryRecord[] }> }>()

  for (const thread of threads) {
    let stageEntry = stageMap.get(thread.stageId)
    if (!stageEntry) {
      stageEntry = { name: thread.stageName, batches: new Map() }
      stageMap.set(thread.stageId, stageEntry)
    }

    let batchEntry = stageEntry.batches.get(thread.batchId)
    if (!batchEntry) {
      batchEntry = { name: thread.batchName, threads: [] }
      stageEntry.batches.set(thread.batchId, batchEntry)
    }

    batchEntry.threads.push(thread)
  }

  const sortedStages = [...stageMap.entries()].sort(([left], [right]) =>
    left.localeCompare(right, undefined, { numeric: true }),
  )

  for (const [stageId, stageEntry] of sortedStages) {
    lines.push(`Stage ${stageId}: ${stageEntry.name}`)
    const sortedBatches = [...stageEntry.batches.entries()].sort(([left], [right]) =>
      left.localeCompare(right, undefined, { numeric: true }),
    )

    for (const [batchId, batchEntry] of sortedBatches) {
      lines.push(`  Batch ${batchId.split(".")[1] ?? "?"}: ${batchEntry.name}`)
      const sortedThreads = [...batchEntry.threads].sort((left, right) =>
        left.threadId.localeCompare(right.threadId, undefined, { numeric: true }),
      )

      for (const thread of sortedThreads) {
        const agentDisplay = thread.assignedAgent ? ` @${thread.assignedAgent}` : ""
        const itemSuffix = ` (${thread.itemCount} item${thread.itemCount === 1 ? "" : "s"})`
        lines.push(`    ${statusToIcon(thread.aggregateStatus)} ${thread.threadId} ${thread.threadName}${itemSuffix}${agentDisplay}`)
      }
    }

    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

export function formatRuntimeSummary(streamId: string, threads: HierarchyThreadQueryRecord[], repoRoot: string): string[] {
  const runtimeSummary = queryRuntimeSummaryForWorkstream(repoRoot, streamId)
  if (!runtimeSummary) {
    return []
  }

  const batchExecutionStatus = new Map<string, ExecutionStatus>()
  for (const thread of threads) {
    if (!batchExecutionStatus.has(thread.batchId)) {
      const batchThreads = threads.filter((candidate) => candidate.batchId === thread.batchId)
      if (batchThreads.some((candidate) => candidate.aggregateStatus === "blocked")) batchExecutionStatus.set(thread.batchId, "blocked")
      else if (batchThreads.some((candidate) => candidate.aggregateStatus === "in_progress")) batchExecutionStatus.set(thread.batchId, "in_progress")
      else if (batchThreads.some((candidate) => candidate.aggregateStatus === "pending")) batchExecutionStatus.set(thread.batchId, "pending")
      else batchExecutionStatus.set(thread.batchId, "completed")
    }
  }

  const lines: string[] = []
  for (const batchId of Object.keys(runtimeSummary.batches).sort()) {
    const batch = runtimeSummary.batches[batchId]!
    const executionStatus = batchExecutionStatus.get(batchId)
    const isRuntimeActive = ["running", "failed"].includes(batch.status)
    if (!executionStatus) continue
    if (batch.status !== executionStatus || isRuntimeActive) {
      lines.push(`Runtime: ${batchId} threads ${executionStatus.replace("_", " ")} vs runtime ${batch.status}`)
    }
  }

  const activeRun = runtimeSummary.supervision?.active_run
  if (activeRun) {
    lines.push(`Runtime: supervision ${activeRun.status} on ${activeRun.current_batch_id ?? `stage ${activeRun.stage_id}`}`)
  } else if (runtimeSummary.supervision?.current_branch) {
    const branch = runtimeSummary.supervision.current_branch
    lines.push(
      `Runtime: supervision branch ${branch.status} on ${branch.current_batch_id ?? branch.batch_id ?? `stage ${branch.stage_id}`}`,
    )
  }

  return lines
}

function matchesFilters(identifier: string, cliArgs: ListCliArgs): boolean {
  if (cliArgs.stage !== undefined) {
    const stagePrefix = `${cliArgs.stage.toString().padStart(2, "0")}.`
    if (!identifier.startsWith(stagePrefix)) return false
  }

  if (cliArgs.batch) {
    const batchPrefix = cliArgs.batch.endsWith(".") ? cliArgs.batch : `${cliArgs.batch}.`
    if (!identifier.startsWith(batchPrefix)) return false
  }

  if (cliArgs.thread) {
    if (identifier !== cliArgs.thread) {
      return false
    }
  }

  return true
}

export function main(argv: string[] = process.argv): void {
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

  const threads = queryThreadsForWorkstream(repoRoot, stream.id, cliArgs.status).filter((thread) =>
    matchesFilters(thread.threadId, cliArgs),
  )

  if (threads.length === 0) {
    if (cliArgs.status) {
      console.log(`No threads with status "${cliArgs.status}" found in workstream "${stream.id}"`)
    } else {
      console.log(`No threads found in workstream "${stream.id}".`)
    }
    return
  }

  if (cliArgs.json) {
    console.log(JSON.stringify(threads.map(toPublicThreadView), null, 2))
  } else {
    const output = [formatThreadList(stream.id, threads), ...formatRuntimeSummary(stream.id, threads, repoRoot)]
      .filter(Boolean)
      .join("\n")
    console.log(output)
  }
}

if (import.meta.main) {
  main()
}
