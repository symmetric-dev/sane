/**
 * CLI: Workstream Preview
 *
 * Show the structure of PLAN.md (stages, threads, questions).
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { getStreamPreview } from "../lib/stream-parser.ts"
import { loadWorkstreamPlan, formatMissingWorkstreamPlanMessage } from "../lib/consolidate.ts"
import { listThreadExecutionItems } from "../lib/thread-execution.ts"
import { parseExecutionItemId } from "../lib/execution-ids.ts"
import type { ExecutionItem } from "../lib/types.ts"

interface PreviewCliArgs {
  repoRoot?: string
  streamId?: string
  verbose: boolean
  json: boolean
}

function printHelp(): void {
  console.log(`
work preview - Show workstream plan structure

Usage:
  work preview [--stream <stream-id>]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --verbose, -v    Show more details
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Preview shows the structure of the canonical workstream plan, loaded from
  stage-local stages/*/PLAN.md files by default (legacy root PLAN.md still supported):
  - Workstream name and summary
  - Stages with their threads
  - Question counts (open vs resolved)

Examples:
  # Preview workstream structure (uses current)
  work preview

  # Verbose output
  work preview --verbose

  # Preview specific workstream
  work preview --stream "001-my-stream"
`)
}

function parseCliArgs(argv: string[]): PreviewCliArgs | null {
  const args = argv.slice(2)
  const parsed: PreviewCliArgs = { verbose: false, json: false }

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

      case "--verbose":
      case "-v":
        parsed.verbose = true
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

interface StreamPreview {
  streamName: string | null
  summary: string
  stageCount: number
  stages: {
    number: number
    name: string
    batchCount: number
    threadCount: number
    batches: {
      number: number
      prefix: string
      name: string
      threadCount: number
      threads: { number: number; name: string }[]
    }[]
  }[]
  questionCounts: { open: number; resolved: number }
}

/**
 * Progress data for a single execution unit (stage/batch/thread)
 */
interface ExecutionProgress {
  total: number
  completed: number
  inProgress: number
  blocked: number
}

/**
 * Compute execution progress for a given stage/batch/thread
 */
function computeExecutionProgress(
  items: ExecutionItem[],
  stageNum?: number,
  batchNum?: number,
  threadNum?: number,
): ExecutionProgress {
  const filtered = items.filter((t) => {
    const parsed = parseExecutionItemId(t.id)
    if (stageNum !== undefined && parsed.stage !== stageNum) return false
    if (batchNum !== undefined && parsed.batch !== batchNum) return false
    if (threadNum !== undefined && parsed.thread !== threadNum) return false
    return true
  })

  return {
    total: filtered.length,
    completed: filtered.filter((t) => t.status === "completed").length,
    inProgress: filtered.filter((t) => t.status === "in_progress").length,
    blocked: filtered.filter((t) => t.status === "blocked").length,
  }
}

/**
 * Generate a progress bar string
 */
function progressBar(completed: number, total: number, width: number = 10): string {
  if (total === 0) return "░".repeat(width)
  const filled = Math.round((completed / total) * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

/**
 * Format progress as percentage
 */
function progressPercent(completed: number, total: number): string {
  if (total === 0) return "0%"
  return `${Math.round((completed / total) * 100)}%`
}

function formatPreview(preview: StreamPreview, verbose: boolean, items: ExecutionItem[]): string {
  const lines: string[] = []

  if (!preview.streamName) {
    return "Could not parse workstream plan - invalid format"
  }

  lines.push(`Workstream: ${preview.streamName}`)

  if (preview.summary) {
    lines.push(`Summary: ${preview.summary}`)
  }

  // Overall progress
  const overallProgress = computeExecutionProgress(items)
  if (overallProgress.total > 0) {
    lines.push("")
    lines.push(
      `Overall Progress: [${progressBar(overallProgress.completed, overallProgress.total)}] ` +
      `${progressPercent(overallProgress.completed, overallProgress.total)} ` +
      `(${overallProgress.completed}/${overallProgress.total} items)`,
    )
  }

  lines.push("")
  lines.push("Stages:")

  if (preview.stageCount === 0) {
    lines.push("  Draft plan: no stages defined yet")
    lines.push("  Use 'work plan create' to scaffold stages.")
    lines.push("")
    lines.push("Questions: none")
    return lines.join("\n")
  }

  for (let stageIdx = 0; stageIdx < preview.stages.length; stageIdx++) {
    const stage = preview.stages[stageIdx]!
    const stageProgress = computeExecutionProgress(items, stage.number)

    // Stage header with progress
    const batchInfo = stage.batchCount > 1 ? `, ${stage.batchCount} batches` : ""
    let stageLine = `  ${stage.number}. ${stage.name} (${stage.threadCount} thread${stage.threadCount !== 1 ? "s" : ""}${batchInfo})`

    if (stageProgress.total > 0) {
      const pct = progressPercent(stageProgress.completed, stageProgress.total)
      const bar = progressBar(stageProgress.completed, stageProgress.total, 8)
      stageLine += ` [${bar}] ${pct}`

      // Completion indicator
      if (stageProgress.completed === stageProgress.total) {
        stageLine += " ✓"
      } else if (stageProgress.blocked > 0) {
        stageLine += " ⚠"
      }
    }

    // Blocked indicator for stages after the first
    if (stageIdx > 0) {
      const prevStage = preview.stages[stageIdx - 1]!
      const prevProgress = computeExecutionProgress(items, prevStage.number)
      if (prevProgress.total > 0 && prevProgress.completed < prevProgress.total) {
        stageLine += " (blocked by Stage " + prevStage.number + ")"
      }
    }

    lines.push(stageLine)

    for (const batch of stage.batches) {
      const batchProgress = computeExecutionProgress(items, stage.number, batch.number)

      // Only show batch header if there's more than one batch or in verbose mode
      if (stage.batchCount > 1 || verbose) {
        let batchLine = `     Batch ${batch.prefix}: ${batch.name}`
        if (batchProgress.total > 0) {
          batchLine += ` [${batchProgress.completed}/${batchProgress.total}]`
          if (batchProgress.completed === batchProgress.total) {
            batchLine += " ✓"
          }
        }
        lines.push(batchLine)
      }

      if (verbose || batch.threads.length <= 5) {
        for (const thread of batch.threads) {
          const indent = stage.batchCount > 1 || verbose ? "        " : "     "
          const threadProgress = computeExecutionProgress(items, stage.number, batch.number, thread.number)
          let threadLine = `${indent}- Thread ${thread.number}: ${thread.name}`
          if (threadProgress.total > 0) {
            threadLine += ` [${threadProgress.completed}/${threadProgress.total}]`
            if (threadProgress.completed === threadProgress.total) {
              threadLine += " ✓"
            }
          }
          lines.push(threadLine)
        }
      } else {
        // Show first 3 threads and indicate more
        for (const thread of batch.threads.slice(0, 3)) {
          const indent = stage.batchCount > 1 || verbose ? "        " : "     "
          const threadProgress = computeExecutionProgress(items, stage.number, batch.number, thread.number)
          let threadLine = `${indent}- Thread ${thread.number}: ${thread.name}`
          if (threadProgress.total > 0) {
            threadLine += ` [${threadProgress.completed}/${threadProgress.total}]`
            if (threadProgress.completed === threadProgress.total) {
              threadLine += " ✓"
            }
          }
          lines.push(threadLine)
        }
        const indent = stage.batchCount > 1 || verbose ? "        " : "     "
        lines.push(`${indent}... and ${batch.threads.length - 3} more threads`)
      }
    }

    // Show dependency arrow between stages
    if (stageIdx < preview.stages.length - 1) {
      lines.push("  ↓")
    }
  }

  lines.push("")
  const { open, resolved } = preview.questionCounts
  const total = open + resolved
  if (total > 0) {
    lines.push(`Questions: ${open} open, ${resolved} resolved`)
  } else {
    lines.push("Questions: none")
  }

  return lines.join("\n")
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

  const loadedPlan = loadWorkstreamPlan(repoRoot, stream.id)
  if (!loadedPlan) {
    console.error(`Error: ${formatMissingWorkstreamPlanMessage(repoRoot, stream.id)}`)
    process.exit(1)
  }

  // Read and parse the canonical workstream plan
  const content = loadedPlan.content
  const preview = getStreamPreview(content)

  // Load execution item data for progress
  const items = listThreadExecutionItems(repoRoot, stream.id)

  if (cliArgs.json) {
    // Include execution item progress in JSON output
    const progressData = {
      ...preview,
      itemProgress: {
        total: items.length,
        completed: items.filter((t) => t.status === "completed").length,
        inProgress: items.filter((t) => t.status === "in_progress").length,
        blocked: items.filter((t) => t.status === "blocked").length,
        pending: items.filter((t) => t.status === "pending").length,
      },
    }
    console.log(JSON.stringify(progressData, null, 2))
  } else {
    console.log(formatPreview(preview, cliArgs.verbose, items))
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
