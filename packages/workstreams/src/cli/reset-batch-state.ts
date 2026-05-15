import { getResolvedStream, loadIndex } from "../lib/index.ts"
import { getRepoRoot } from "../lib/repo.ts"
import { resetBatchState } from "../lib/reset-batch-state.ts"

interface ResetBatchStateCliArgs {
  repoRoot?: string
  streamId?: string
  batch?: string
}

function printHelp(): void {
  console.log(`
work reset-batch-state - Reset a batch for a clean rerun

Usage:
  work reset-batch-state --batch "03.01" [options]

Options:
  --repo-root, -r        Repository root (auto-detected if omitted)
  --stream, -s           Workstream ID or name (uses current if not specified)
  --batch, -b            Batch ID to reset (required, format: "SS.BB")
  --help, -h             Show this help message

Description:
  Resets thread execution state, canonical runtime_state entries, supervisor
  recovery pointers, and temporary batch artifacts for a single batch so it can
  be rerun fresh.
  Canonical sqlite/thread runtime state remains the source of truth.

Examples:
  work reset-batch-state --batch "03.01"
  work reset-batch-state --stream "001-my-stream" --batch "03.01"
`)
}

function parseCliArgs(argv: string[]): ResetBatchStateCliArgs | null {
  const args = argv.slice(2)
  const parsed: ResetBatchStateCliArgs = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) return null
        parsed.repoRoot = next
        i++
        break
      case "--stream":
      case "-s":
        if (!next) return null
        parsed.streamId = next
        i++
        break
      case "--batch":
      case "-b":
        if (!next) return null
        parsed.batch = next
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

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs || !cliArgs.batch) {
    console.error("Error: --batch is required")
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

  let streamId: string
  try {
    const index = loadIndex(repoRoot)
    streamId = getResolvedStream(index, cliArgs.streamId).id
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }

  try {
    const result = await resetBatchState(repoRoot, streamId, cliArgs.batch)

    console.log(`Reset batch ${result.batchId} for stream ${streamId}.`)
    console.log(
      `Items: ${result.itemCount} in batch, ${result.itemsReset} status reset to pending, ${result.itemReportsCleared} reports cleared, ${result.itemBreadcrumbsCleared} breadcrumbs cleared.`,
    )
    console.log(
      `Runtime: ${result.itemRuntimeBatchCleared ? "cleared" : "no existing"} batch runtime entry, ${result.threadRuntimeEntriesTouched} thread runtime entr${result.threadRuntimeEntriesTouched === 1 ? "y" : "ies"} cleaned.`,
    )
    console.log(
      `Supervision: ${result.supervision.runsTouched} runs updated, ${result.supervision.branchSessionsRemoved} branch sessions removed, ${result.supervision.reviewedBatchesRemoved} reviews removed, ${result.supervision.stageStopsRemoved} stage stops removed, active run ${result.supervision.activeRunCleared ? "cleared" : "unchanged"}, current branch ${result.supervision.currentBranchCleared ? "cleared" : "unchanged"}.`,
    )
    console.log(
      `Artifacts: ${result.artifacts.completionMarkersRemoved} markers, ${result.artifacts.sessionFilesRemoved} session files, ${result.artifacts.resultFilesRemoved} result files, ${result.artifacts.workingSessionFilesRemoved} working-session files, ${result.artifacts.synthesisOutputsRemoved} legacy synthesis outputs, ${result.artifacts.synthesisLogsRemoved} legacy synthesis logs removed.`,
    )
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
