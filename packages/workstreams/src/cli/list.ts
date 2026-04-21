/**
 * CLI: Workstream List
 *
 * List all tasks in a workstream with their status.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { queryTasksForWorkstream } from "../lib/hierarchy-query.ts"
import { getEffectiveRuntimeSummary, groupTasks, readTasksFile } from "../lib/tasks.ts"
import type { Task, TaskStatus } from "../lib/types.ts"

interface ListCliArgs {
  repoRoot?: string
  streamId?: string
  tasks: boolean
  status?: TaskStatus
  json: boolean
  stage?: number
  batch?: string
  thread?: string
}

function printHelp(): void {
  console.log(`
work list - List tasks in a workstream

Usage:
  work list [--stream <stream-id>] [--tasks] [--status <status>]
            [--stage <n>] [--batch <id>] [--thread <id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --tasks          Show tasks (default if no other flags)
  --status         Filter by status (pending, in_progress, completed, blocked, cancelled)
  --stage          Filter by stage number (e.g. 1)
  --batch          Filter by batch ID (e.g. "01.02")
  --thread         Filter by thread ID (e.g. "01.02.03")
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # List all tasks (uses current workstream)
  work list --tasks

  # List only in-progress tasks
  work list --tasks --status in_progress

  # List tasks for a specific batch
  work list --tasks --batch "01.02"

  # List tasks for a specific workstream
  work list --stream "001-my-stream" --tasks
`)
}

function parseCliArgs(argv: string[]): ListCliArgs | null {
  const args = argv.slice(2)
  const parsed: ListCliArgs = { json: false, tasks: false }

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

      case "--tasks":
        parsed.tasks = true
        break

      case "--status":
        if (!next) {
          console.error("Error: --status requires a value")
          return null
        }
        const validStatuses = ["pending", "in_progress", "completed", "blocked", "cancelled"]
        if (!validStatuses.includes(next)) {
          console.error(`Error: Invalid status "${next}". Valid values: ${validStatuses.join(", ")}`)
          return null
        }
        parsed.status = next as TaskStatus
        i++
        break

      case "--stage":
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
    }
  }

  // Default to showing tasks if no specific flag
  if (!parsed.tasks) {
    parsed.tasks = true
  }

  return parsed
}

function statusToIcon(status: TaskStatus): string {
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

// ... imports remain the same, just updated groupTasks import above

// ... (skipping to formatTaskList replacement)

function formatTaskList(streamId: string, tasks: Task[]): string {
  const lines: string[] = []
  const counts = {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    in_progress: tasks.filter((t) => t.status === "in_progress").length,
    pending: tasks.filter((t) => t.status === "pending").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
  }

  lines.push(`Workstream: ${streamId}`)
  lines.push(
    `Tasks: ${counts.total} total | ${counts.completed} completed | ${counts.in_progress} in progress | ${counts.pending} pending`
  )
  lines.push("")

  // Group tasks by stage, batch, and thread
  const grouped = groupTasks(tasks, { byBatch: true })

  // Sort stages
  const stageEntries = Array.from(grouped.entries())
  stageEntries.sort((a, b) => {
    const aFirstTask = getFirstTaskFromStage(a[1])
    const bFirstTask = getFirstTaskFromStage(b[1])
    if (!aFirstTask || !bFirstTask) return 0
    return parseInt(aFirstTask.id.split(".")[0]!, 10) - parseInt(bFirstTask.id.split(".")[0]!, 10)
  })

  for (const [stageName, batchMap] of stageEntries) {
    const firstTask = getFirstTaskFromStage(batchMap)
    const stageNum = firstTask ? firstTask.id.split(".")[0] : "?"

    lines.push(`Stage ${stageNum}: ${stageName}`)

    // Sort batches
    const batchEntries = Array.from(batchMap.entries())
    batchEntries.sort((a, b) => {
      const aFirst = getFirstTaskFromBatch(a[1])
      const bFirst = getFirstTaskFromBatch(b[1])
      if (!aFirst || !bFirst) return 0
      return parseInt(aFirst.id.split(".")[1]!, 10) - parseInt(bFirst.id.split(".")[1]!, 10)
    })

    for (const [batchName, threadMap] of batchEntries) {
      // Get batch number from first task
      const firstBatchTask = getFirstTaskFromBatch(threadMap)
      const batchNum = firstBatchTask ? firstBatchTask.id.split(".")[1] : "?"

      lines.push(`  Batch ${batchNum}: ${batchName}`)

      // Sort threads
      const threadEntries = Array.from(threadMap.entries())
      threadEntries.sort((a, b) => {
        const aTask = a[1][0]
        const bTask = b[1][0]
        if (!aTask || !bTask) return 0
        return parseInt(aTask.id.split(".")[2]!, 10) - parseInt(bTask.id.split(".")[2]!, 10)
      })

      for (const [threadName, threadTasks] of threadEntries) {
        // Thread is index 2 in "stage.batch.thread.task"
        const threadNum = threadTasks[0]?.id.split(".")[2] ?? "?"
        lines.push(`    Thread ${threadNum}: ${threadName}`)

        for (const task of threadTasks) {
          const icon = statusToIcon(task.status)
          lines.push(`      ${icon} ${task.id} ${task.name}`)
        }
      }
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

function aggregateStatus(tasks: Task[]): TaskStatus {
  if (tasks.length === 0) return "pending"
  if (tasks.some((task) => task.status === "blocked")) return "blocked"
  if (tasks.some((task) => task.status === "in_progress")) return "in_progress"
  if (tasks.some((task) => task.status === "pending")) return "pending"
  return "completed"
}

export function formatRuntimeSummary(streamId: string, tasks: Task[], repoRoot: string): string[] {
  const tasksFile = readTasksFile(repoRoot, streamId)
  const runtimeSummary = getEffectiveRuntimeSummary(repoRoot, streamId, tasksFile)
  if (!runtimeSummary) {
    return []
  }

  const batchTaskStatus = new Map<string, TaskStatus>()
  for (const task of tasks) {
    const parts = task.id.split(".")
    if (parts.length < 2) continue
    const batchId = `${parts[0]}.${parts[1]}`
    if (!batchTaskStatus.has(batchId)) {
      batchTaskStatus.set(batchId, aggregateStatus(tasks.filter((candidate) => candidate.id.startsWith(`${batchId}.`))))
    }
  }

  const lines: string[] = []
  for (const batchId of Object.keys(runtimeSummary.batches).sort()) {
    const batch = runtimeSummary.batches[batchId]!
    const taskStatus = batchTaskStatus.get(batchId)
    const isRuntimeActive = ["running", "failed"].includes(batch.status)
    if (!taskStatus) continue
    if (batch.status !== taskStatus || isRuntimeActive) {
      lines.push(
        `Runtime: ${batchId} tasks ${taskStatus.replace("_", " ")} vs runtime ${batch.status}`,
      )
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

// Helper to get first task from nested maps structure for sorting
function getFirstTaskFromStage(batchMap: Map<string, Map<string, Task[]>>): Task | undefined {
  const firstBatch = batchMap.values().next().value
  return getFirstTaskFromBatch(firstBatch)
}

function getFirstTaskFromBatch(threadMap: Map<string, Task[]> | undefined): Task | undefined {
  if (!threadMap) return undefined
  const firstThread = threadMap.values().next().value
  return firstThread?.[0]
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

  // Load index and find workstream (uses current if not specified)
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

  // Get tasks
  let tasks = queryTasksForWorkstream(repoRoot, stream.id, cliArgs.status)

  // Apply filters
  if (cliArgs.stage !== undefined) {
    const stagePrefix = `${cliArgs.stage.toString().padStart(2, "0")}.`
    tasks = tasks.filter((t) => t.id.startsWith(stagePrefix))
  }

  if (cliArgs.batch) {
    // Ensure strict prefix matching (e.g. "01.02.")
    const batchPrefix = cliArgs.batch.endsWith(".") ? cliArgs.batch : `${cliArgs.batch}.`
    tasks = tasks.filter((t) => t.id.startsWith(batchPrefix))
  }

  if (cliArgs.thread) {
    const threadPrefix = cliArgs.thread.endsWith(".") ? cliArgs.thread : `${cliArgs.thread}.`
    tasks = tasks.filter((t) => t.id.startsWith(threadPrefix))
  }

  if (tasks.length === 0) {
    if (cliArgs.status) {
      console.log(`No tasks with status "${cliArgs.status}" found in workstream "${stream.id}"`)
    } else {
      console.log(`No tasks found in workstream "${stream.id}".`)
    }
    return
  }

  if (cliArgs.json) {
    console.log(JSON.stringify(tasks, null, 2))
  } else {
    const output = [formatTaskList(stream.id, tasks), ...formatRuntimeSummary(stream.id, tasks, repoRoot)]
      .filter(Boolean)
      .join("\n")
    console.log(output)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
