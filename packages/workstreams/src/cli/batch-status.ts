import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { syncBatchStatus, waitForBatchStatus } from "../lib/batch-monitor.ts"
import type { BatchStatusFile } from "../lib/batch-status.ts"

interface BatchStatusCliArgs {
  repoRoot?: string
  streamId?: string
  batch?: string
  format: "text" | "json"
  wait: boolean
  timeoutMs?: number
  pollIntervalMs?: number
}

function printHelp(): void {
  console.log(`
work batch-status - Show persisted batch execution status

Usage:
  work batch-status --batch "01.01" [options]

Options:
  --repo-root, -r        Repository root (auto-detected if omitted)
  --stream, -s           Workstream ID or name (uses current if not specified)
  --batch, -b            Batch ID to inspect (required, format: "SS.BB")
  --format               Output format: text | json (default: text)
  --wait                 Poll until the batch reaches a terminal state
  --timeout-ms           Stop waiting after this many milliseconds
  --poll-interval-ms     Poll interval while waiting (default: 1000)
  --help, -h             Show this help message

Examples:
  work batch-status --batch "01.01"
  work batch-status --batch "01.01" --format json
  work batch-status --batch "01.01" --format json --wait --timeout-ms 300000
`)
}

function parseCliArgs(argv: string[]): BatchStatusCliArgs | null {
  const args = argv.slice(2)
  const parsed: BatchStatusCliArgs = {
    format: "text",
    wait: false,
  }

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
      case "--format":
        if (!next || (next !== "text" && next !== "json")) return null
        parsed.format = next
        i++
        break
      case "--wait":
        parsed.wait = true
        break
      case "--timeout-ms":
        if (!next) return null
        parsed.timeoutMs = Number(next)
        if (Number.isNaN(parsed.timeoutMs)) return null
        i++
        break
      case "--poll-interval-ms":
        if (!next) return null
        parsed.pollIntervalMs = Number(next)
        if (Number.isNaN(parsed.pollIntervalMs)) return null
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

function formatTextOutput(status: Awaited<ReturnType<typeof syncBatchStatus>>): string {
  const lines = [
    `Batch ${status.batchId}: ${status.status}`,
    `Run ID: ${status.runId}`,
    `Summary: ${status.summary.completed}/${status.summary.total} completed, ${status.summary.running} running, ${status.summary.failed} failed, ${status.summary.pending} pending`,
  ]

  for (const thread of status.threads) {
    lines.push(`- ${thread.threadId} ${thread.threadName}: ${thread.status}`)
  }

  return lines.join("\n")
}

function toPublicBatchStatus(status: BatchStatusFile) {
  return {
    version: status.version,
    streamId: status.streamId,
    batchId: status.batchId,
    runId: status.runId,
    ...(status.tmuxSessionName ? { tmuxSessionName: status.tmuxSessionName } : {}),
    mode: status.mode,
    status: status.status,
    ...(status.stageName ? { stageName: status.stageName } : {}),
    ...(status.batchName ? { batchName: status.batchName } : {}),
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    ...(status.completedAt ? { completedAt: status.completedAt } : {}),
    summary: status.summary,
    threads: status.threads.map((thread) => ({
      threadId: thread.threadId,
      threadName: thread.threadName,
      status: thread.status,
      ...(thread.startedAt ? { startedAt: thread.startedAt } : {}),
      updatedAt: thread.updatedAt,
      ...(thread.completedAt ? { completedAt: thread.completedAt } : {}),
      ...(thread.markerDetectedAt ? { markerDetectedAt: thread.markerDetectedAt } : {}),
      ...(thread.currentSessionId ? { currentSessionId: thread.currentSessionId } : {}),
      ...(thread.opencodeSessionId ? { opencodeSessionId: thread.opencodeSessionId } : {}),
      ...(thread.workingAgentSessionId ? { workingAgentSessionId: thread.workingAgentSessionId } : {}),
      ...(thread.synthesisUpdatedAt ? { synthesisUpdatedAt: thread.synthesisUpdatedAt } : {}),
      ...(thread.recoveryNote ? { recoveryNote: thread.recoveryNote } : {}),
    })),
  }
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
    const status = cliArgs.wait
      ? await waitForBatchStatus({
          repoRoot,
          streamId,
          batchId: cliArgs.batch,
          timeoutMs: cliArgs.timeoutMs,
          pollIntervalMs: cliArgs.pollIntervalMs,
        })
      : await syncBatchStatus({
          repoRoot,
          streamId,
          batchId: cliArgs.batch,
        })

    if (cliArgs.format === "json") {
      console.log(JSON.stringify(toPublicBatchStatus(status), null, 2))
    } else {
      console.log(formatTextOutput(status))
    }
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
