/**
 * CLI: Workstream Tree
 *
 * Show a tree view of the workstream stages, batches, and threads.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { queryTasksForWorkstream } from "../lib/hierarchy-query.ts"
import { getEffectiveRuntimeSummary, readTasksFile } from "../lib/tasks.ts"
import { buildWorkstreamTreeSnapshot, filterTasksForBatch, renderWorkstreamTree } from "../lib/tree.ts"

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

export function main(argv: string[] = process.argv): void {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  let repoRoot: string
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot()
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }

  let index
  try {
    index = loadIndex(repoRoot)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }

  let stream
  try {
    stream = getResolvedStream(index, cliArgs.streamId)
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }

  const tasksFile = readTasksFile(repoRoot, stream.id)
  const allTasks = queryTasksForWorkstream(repoRoot, stream.id)
  if (allTasks.length === 0) {
    console.log(`Workstream: ${stream.id} (Empty)`)
    return
  }

  const runtimeSummary = getEffectiveRuntimeSummary(repoRoot, stream.id, tasksFile)
  const filteredTasks = cliArgs.batchId
    ? filterTasksForBatch(allTasks, cliArgs.batchId)
    : allTasks

  if (cliArgs.batchId && filteredTasks === null) {
    console.error(`Error: Invalid batch ID format "${cliArgs.batchId}". Expected format: "01.01"`)
    process.exit(1)
  }

  const tasks = filteredTasks ?? allTasks
  if (tasks.length === 0) {
    console.log(`Batch ${cliArgs.batchId}: No tasks found`)
    return
  }

  const snapshot = buildWorkstreamTreeSnapshot({
    streamId: stream.id,
    tasks,
    runtimeSummary,
    ...(cliArgs.batchId ? { batchId: cliArgs.batchId } : {}),
  })

  for (const line of renderWorkstreamTree(snapshot)) {
    console.log(line)
  }
}

if (import.meta.main) {
  main()
}
