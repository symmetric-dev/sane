/**
 * CLI: Workstream Tree
 *
 * Show a tree view of the workstream stages, batches, and threads.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { getEffectiveRuntimeSummary, groupTasks, readTasksFile } from "../lib/tasks.ts"
import type { Task, TaskStatus, WorkstreamRuntimeBatchSummary } from "../lib/types.ts"

interface TreeCliArgs {
    repoRoot?: string
    streamId?: string
    batchId?: string
}

function printHelp(): void {
    console.log(`
work tree - Show workstream structure tree

Usage:
  work tree [--stream <stream-id>] [--batch <batch-id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --batch, -b      Filter to a specific batch (e.g., "01.01")
  --help, -h       Show this help message

Examples:
  work tree
  work tree --stream "001-migration"
  work tree --batch "01.01"
`)
}

function parseCliArgs(argv: string[]): TreeCliArgs | null {
    const args = argv.slice(2)
    const parsed: TreeCliArgs = {}

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

            case "--batch":
            case "-b":
                if (!next) {
                    console.error("Error: --batch requires a value")
                    return null
                }
                parsed.batchId = next
                i++
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
 * Aggregate status from a list of tasks
 * Precedence: Blocked > In Progress > Pending > Completed
 * (Completed only if ALL are completed/cancelled)
 */
function aggregateStatus(tasks: Task[]): TaskStatus {
    if (tasks.length === 0) return "pending"

    if (tasks.some((t) => t.status === "blocked")) return "blocked"
    if (tasks.some((t) => t.status === "in_progress")) return "in_progress"

    // If any task is pending, the container is pending
    if (tasks.some((t) => t.status === "pending")) return "pending"

    // If we're here, all tasks are either completed or cancelled
    return "completed"
}

function statusToIcon(status: TaskStatus): string {
    switch (status) {
        case "completed":
            return "[x]"
        case "in_progress":
            return "[~]"
        case "blocked":
            return "[!]"
        case "pending":
            return "[ ]"
        case "cancelled":
            return "[-]"
        default:
            return "[ ]"
    }
}

function toBatchId(task?: Task): string | undefined {
    const parts = task?.id.split(".")
    if (!parts || parts.length < 2) return undefined
    return `${parts[0]}.${parts[1]}`
}

function formatBatchRuntime(batchStatus: WorkstreamRuntimeBatchSummary, taskStatus: TaskStatus): string {
    const failedCount = batchStatus.thread_summary.failed
    const runningCount = batchStatus.thread_summary.running
    const isRuntimeActive = ["running", "failed"].includes(batchStatus.status)
    const details = failedCount > 0
        ? `${failedCount} failed`
        : runningCount > 0
            ? `${runningCount} running`
            : `${batchStatus.thread_summary.completed} completed`

    if (batchStatus.status !== taskStatus) {
        return ` [desync: tasks ${taskStatus.replace("_", " ")}, runtime ${batchStatus.status} (${details})]`
    }

    if (isRuntimeActive) {
        return ` [runtime: ${batchStatus.status} (${details})]`
    }

    return ""
}

function formatWorkstreamRuntimeNotice(notice: string | undefined): void {
    if (notice) {
        console.log(`    Runtime: ${notice}`)
    }
}

function getWorkstreamRuntimeNotice(
    runtimeSummary: ReturnType<typeof getEffectiveRuntimeSummary>,
): string | undefined {
    if (!runtimeSummary) {
        return undefined
    }

    const failedBatch = Object.values(runtimeSummary.batches)
        .filter((batch) => batch.status === "failed")
        .sort((a, b) => a.batch_id.localeCompare(b.batch_id))[0]
    if (failedBatch) {
        return `batch ${failedBatch.batch_id} failed (${failedBatch.thread_summary.failed} failed thread${failedBatch.thread_summary.failed === 1 ? "" : "s"})`
    }

    const runningBatch = Object.values(runtimeSummary.batches).find((batch) => batch.status === "running")
    if (runningBatch) {
        return `batch ${runningBatch.batch_id} running (${runningBatch.thread_summary.running} active thread${runningBatch.thread_summary.running === 1 ? "" : "s"})`
    }

    const activeRun = runtimeSummary.supervision?.active_run
    if (activeRun) {
        return `supervision ${activeRun.status} on ${activeRun.current_batch_id ?? `stage ${activeRun.stage_id}`}`
    }

    const currentBranch = runtimeSummary.supervision?.current_branch
    if (currentBranch) {
        return `supervision branch ${currentBranch.status} on ${currentBranch.current_batch_id ?? currentBranch.batch_id ?? `stage ${currentBranch.stage_id}`}`
    }

    return undefined
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

    // Get tasks and group them
    const tasksFile = readTasksFile(repoRoot, stream.id)
    let tasks = tasksFile?.tasks ?? []
    if (tasks.length === 0) {
        console.log(`Workstream: ${stream.id} (Empty)`)
        return
    }
    const runtimeSummary = getEffectiveRuntimeSummary(repoRoot, stream.id, tasksFile)

    // Filter by batch if --batch is specified
    if (cliArgs.batchId) {
        const [stageNum, batchNum] = cliArgs.batchId.split('.')
        if (!stageNum || !batchNum) {
            console.error(`Error: Invalid batch ID format "${cliArgs.batchId}". Expected format: "01.01"`)
            process.exit(1)
        }
        const stagePrefix = stageNum.padStart(2, '0')
        const batchPrefix = `${stagePrefix}.${batchNum.padStart(2, '0')}`
        tasks = tasks.filter(t => t.id.startsWith(batchPrefix + '.'))
        if (tasks.length === 0) {
            console.log(`Batch ${cliArgs.batchId}: No tasks found`)
            return
        }
    }

    const grouped = groupTasks(tasks, { byBatch: true })

    // Calculate overall status
    const streamStatus = aggregateStatus(tasks)
    console.log(`${statusToIcon(streamStatus)} Workstream: ${stream.id} (${tasks.length})`)
    formatWorkstreamRuntimeNotice(getWorkstreamRuntimeNotice(runtimeSummary))

    // Iterate Stages
    // Sort stages by numeric prefix (Map iteration order is insertion order, but better to be safe)
    const sortedStages = Array.from(grouped.entries()).sort((a, b) => {
        // Trying to extract stage number from the first task of the stage
        // Just a heuristic sort based on stage name if we can't get ID easily, 
        // but typically stage names don't have numbers at start.
        // However, the grouping function returns Map<StageName, ...>
        // We rely on the order returned by groupTasks 
        // which might be effectively sorted if tasks were sorted.

        // Let's try to find numeric tasks to sort robustly
        // Actually groupTasks preserves insertion order 
        // but tasks.ts doesn't guarantee stage sort order in the Map keys.
        // We'll trust the insertion order for now or sort by name if needed.
        // Better: finding the first task of each stage to compare IDs.
        const taskA = a[1].values().next().value?.values().next().value?.[0]; // Stage -> Batch -> Thread -> Task[]
        const taskB = b[1].values().next().value?.values().next().value?.[0];
        if (taskA && taskB) {
            return taskA.id.localeCompare(taskB.id);
        }
        return a[0].localeCompare(b[0]);
    });


    for (const [stageIndex, [stageName, batchMap]] of sortedStages.entries()) {
        const isLastStage = stageIndex === sortedStages.length - 1
        const stagePrefix = isLastStage ? "└── " : "├── "
        const stageChildPrefix = isLastStage ? "    " : "│   "

        // Aggregate stage tasks
        const stageTasks: Task[] = []
        for (const batch of batchMap.values()) {
            for (const thread of batch.values()) {
                stageTasks.push(...thread)
            }
        }
        const stageStatus = aggregateStatus(stageTasks)

        // Extract stage number from first task ID
        const firstTask = stageTasks[0]
        const stageNum = firstTask ? firstTask.id.split('.')[0] : "?"

        console.log(`${stagePrefix}${statusToIcon(stageStatus)} Stage ${stageNum}: ${stageName} (${stageTasks.length})`)

        const sortedBatches = Array.from(batchMap.entries()).sort((a, b) => {
            const taskA = a[1].values().next().value?.[0];
            const taskB = b[1].values().next().value?.[0];
            if (taskA && taskB) {
                return taskA.id.localeCompare(taskB.id);
            }
            return a[0].localeCompare(b[0]);
        });

        for (const [batchIndex, [batchName, threadMap]] of sortedBatches.entries()) {
            const isLastBatch = batchIndex === sortedBatches.length - 1
            const batchPrefix = isLastBatch ? "└── " : "├── "
            const batchChildPrefix = isLastBatch ? "    " : "│   "

            // Aggregate batch tasks
            const batchTasks: Task[] = []
            for (const thread of threadMap.values()) {
                batchTasks.push(...thread)
            }
            const batchStatus = aggregateStatus(batchTasks)

            // Extract batch number
            const firstBatchTask = batchTasks[0]
            const batchNum = firstBatchTask ? firstBatchTask.id.split('.')[1] : "?"
            const batchId = toBatchId(firstBatchTask)
            const runtimeSuffix = batchId && runtimeSummary?.batches[batchId]
                ? formatBatchRuntime(runtimeSummary.batches[batchId]!, batchStatus)
                : ""

            console.log(`${stageChildPrefix}${batchPrefix}${statusToIcon(batchStatus)} Batch ${batchNum}: ${batchName} (${batchTasks.length})${runtimeSuffix}`)

            const sortedThreads = Array.from(threadMap.entries()).sort((a, b) => {
                const taskA = a[1][0];
                const taskB = b[1][0];
                if (taskA && taskB) return taskA.id.localeCompare(taskB.id);
                return a[0].localeCompare(b[0]);
            });

            for (const [threadIndex, [threadName, tasks]] of sortedThreads.entries()) {
                const isLastThread = threadIndex === sortedThreads.length - 1
                const threadPrefix = isLastThread ? "└── " : "├── "

                const threadStatus = aggregateStatus(tasks)
                const threadNum = tasks[0] ? tasks[0].id.split('.')[2] : "?"

                // Get agent assignment (all tasks in a thread should have the same agent)
                const assignedAgent = tasks.find(t => t.assigned_agent)?.assigned_agent
                const agentDisplay = assignedAgent ? ` @${assignedAgent}` : ""

                console.log(`${stageChildPrefix}${batchChildPrefix}${threadPrefix}${statusToIcon(threadStatus)} Thread ${threadNum}: ${threadName} (${tasks.length})${agentDisplay}`)
            }
        }
    }
}

if (import.meta.main) {
    main()
}
