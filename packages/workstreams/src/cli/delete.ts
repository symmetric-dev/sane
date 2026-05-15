/**
 * CLI: Delete
 *
 * Delete workstreams, stages, batches, or threads.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream, deleteStream } from "../lib/index.ts"
import {
  deleteThreadExecutionItemsByStage,
  deleteThreadExecutionItemsByBatch,
  deleteThreadExecutionItemsByThread,
} from "../lib/thread-execution.ts"

interface DeleteCliArgs {
  repoRoot?: string
  streamId?: string
  // Delete targets (mutually exclusive)
  stage?: number // e.g., 01
  batch?: string // e.g., "01.00" (stage.batch)
  thread?: string // e.g., "01.01.02" (stage.batch.thread)
  stream?: boolean // delete entire stream
  force?: boolean
}

function printHelp(): void {
  console.log(`
work delete - Delete workstreams, stages, batches, or threads

Usage:
  work delete [--stream <id>] [target] [options]

Targets (mutually exclusive):
  --stage <num>       Delete all execution entries in a stage (e.g., 01)
  --batch <id>        Delete all execution entries in a batch (e.g., "01.00")
  --thread <id>       Delete all execution entries in a thread (e.g., "01.01.02")
  (no target)         Delete the entire workstream

Options:
  --stream, -s <id>   Workstream ID or name (uses current if not specified)
  --force, -f         Skip confirmation prompts
  --repo-root <path>  Repository root (auto-detected)
  --help, -h          Show this help message

Examples:
  # Delete all execution entries in stage 02
  work delete --stage 02

  # Delete all execution entries in batch 01.00
  work delete --batch "01.00"

  # Delete all execution entries in thread 01.01.02
  work delete --thread "01.01.02"

  # Delete specific workstream (with confirmation)
  work delete --stream "001-my-stream"

  # Delete workstream without confirmation
  work delete --stream "001-my-stream" --force
`)
}

function parseCliArgs(argv: string[]): DeleteCliArgs | null {
  const args = argv.slice(2)
  const parsed: Partial<DeleteCliArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--repo-root":
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

      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value")
          return null
        }
        const stageNum = parseInt(next, 10)
        if (isNaN(stageNum) || stageNum < 1) {
          console.error("Error: --stage must be a positive number")
          return null
        }
        parsed.stage = stageNum
        i++
        break

      case "--batch":
      case "-b":
        if (!next) {
          console.error("Error: --batch requires a value")
          return null
        }
        // Validate format: "stage.batch"
        const batchParts = next.split(".")
        if (
          batchParts.length !== 2 ||
          batchParts.some((p) => isNaN(parseInt(p, 10)))
        ) {
          console.error(
            'Error: --batch must be in format "stage.batch" (e.g., "1.00")',
          )
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
        // Validate format: "stage.batch.thread"
        const threadParts = next.split(".")
        if (
          threadParts.length !== 3 ||
          threadParts.some((p) => isNaN(parseInt(p, 10)))
        ) {
          console.error(
            'Error: --thread must be in format "stage.batch.thread" (e.g., "01.01.02")',
          )
          return null
        }
        parsed.thread = next
        i++
        break

      case "--force":
      case "-f":
        parsed.force = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  // Check for mutually exclusive targets
    const targets = [
    parsed.stage,
    parsed.batch,
    parsed.thread,
  ].filter((t) => t !== undefined)
  if (targets.length > 1) {
    console.error(
      "Error: --stage, --batch, and --thread are mutually exclusive",
    )
    return null
  }

  // If no target specified, we're deleting the entire stream
  if (targets.length === 0) {
    parsed.stream = true
  }

  return parsed as DeleteCliArgs
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
    // Delete all execution entries in a stage
    if (cliArgs.stage !== undefined) {
      const deleted = deleteThreadExecutionItemsByStage(repoRoot, stream.id, cliArgs.stage)
      if (deleted.length > 0) {
        console.log(
          `Deleted ${deleted.length} checkpoint(s) from stage ${cliArgs.stage}`,
        )
        for (const task of deleted) {
          console.log(`  - ${task.id}: ${task.name}`)
        }
      } else {
        console.log(`No execution entries found in stage ${cliArgs.stage}`)
      }
      return
    }

    // Delete all execution entries in a batch
    if (cliArgs.batch) {
      const [stage, batch] = cliArgs.batch.split(".").map(Number)
      const deleted = deleteThreadExecutionItemsByBatch(repoRoot, stream.id, stage!, batch!)
      if (deleted.length > 0) {
        console.log(
          `Deleted ${deleted.length} checkpoint(s) from batch ${cliArgs.batch}`,
        )
        for (const task of deleted) {
          console.log(`  - ${task.id}: ${task.name}`)
        }
      } else {
        console.log(`No execution entries found in batch ${cliArgs.batch}`)
      }
      return
    }

    // Delete all execution entries in a thread
    if (cliArgs.thread) {
      const [stage, batch, thread] = cliArgs.thread.split(".").map(Number)
      const deleted = deleteThreadExecutionItemsByThread(
        repoRoot,
        stream.id,
        stage!,
        batch!,
        thread!,
      )
      if (deleted.length > 0) {
        console.log(
          `Deleted ${deleted.length} checkpoint(s) from thread ${cliArgs.thread}`,
        )
        for (const task of deleted) {
          console.log(`  - ${task.id}: ${task.name}`)
        }
      } else {
        console.log(`No execution entries found in thread ${cliArgs.thread}`)
      }
      return
    }

    // Delete entire stream
    if (cliArgs.stream) {
      if (!cliArgs.force) {
        console.log(
          `This will delete workstream "${stream.id}" and all its files.`,
        )
        console.log("Run with --force to confirm.")
        process.exit(1)
      }

      const result = await deleteStream(repoRoot, stream.id, {
        deleteFiles: true,
      })
      console.log(`Deleted workstream: ${result.streamId}`)
      console.log(`   Path: ${result.streamPath}`)
      return
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
