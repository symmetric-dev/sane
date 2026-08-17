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
    ...(status.executionBackend !== undefined
      ? { executionBackend: status.executionBackend }
      : {}),
    ...(status.provider !== undefined ? { provider: status.provider } : {}),
    ...(status.runtime !== undefined ? { runtime: status.runtime } : {}),
    ...(status.logicalAgent !== undefined ? { logicalAgent: status.logicalAgent } : {}),
    ...(status.resolvedModel !== undefined ? { resolvedModel: status.resolvedModel } : {}),
    ...(status.resolvedVariant !== undefined
      ? { resolvedVariant: status.resolvedVariant }
      : {}),
    ...(status.runtimeSelectionSource !== undefined
      ? { runtimeSelectionSource: status.runtimeSelectionSource }
      : {}),
    ...(status.executorOwnerToken !== undefined
      ? { executorOwnerToken: status.executorOwnerToken }
      : {}),
    ...(status.executorPid !== undefined ? { executorPid: status.executorPid } : {}),
    ...(status.executorStartedAt !== undefined
      ? { executorStartedAt: status.executorStartedAt }
      : {}),
    ...(status.executorHeartbeatAt !== undefined
      ? { executorHeartbeatAt: status.executorHeartbeatAt }
      : {}),
    ...(status.executorFinishedAt !== undefined
      ? { executorFinishedAt: status.executorFinishedAt }
      : {}),
    ...(status.lastEventAt !== undefined ? { lastEventAt: status.lastEventAt } : {}),
    ...(status.lastActivityAt !== undefined
      ? { lastActivityAt: status.lastActivityAt }
      : {}),
    ...(status.cancellationRequestedAt !== undefined
      ? { cancellationRequestedAt: status.cancellationRequestedAt }
      : {}),
    ...(status.cancellationAcknowledgedAt !== undefined
      ? { cancellationAcknowledgedAt: status.cancellationAcknowledgedAt }
      : {}),
    ...(status.terminalOutcome !== undefined
      ? { terminalOutcome: status.terminalOutcome }
      : {}),
    ...(status.errorSummary !== undefined ? { errorSummary: status.errorSummary } : {}),
    ...(status.resultSummary !== undefined ? { resultSummary: status.resultSummary } : {}),
    ...(status.runtimeDirectory !== undefined
      ? { runtimeDirectory: status.runtimeDirectory }
      : {}),
    ...(status.activityJournalPath !== undefined
      ? { activityJournalPath: status.activityJournalPath }
      : {}),
    ...(status.snapshotPath !== undefined ? { snapshotPath: status.snapshotPath } : {}),
    ...(status.executorLogPath !== undefined
      ? { executorLogPath: status.executorLogPath }
      : {}),
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
      ...(thread.executionBackend !== undefined
        ? { executionBackend: thread.executionBackend }
        : {}),
      ...(thread.provider !== undefined ? { provider: thread.provider } : {}),
      ...(thread.runtime !== undefined ? { runtime: thread.runtime } : {}),
      ...(thread.logicalAgent !== undefined ? { logicalAgent: thread.logicalAgent } : {}),
      ...(thread.resolvedModel !== undefined ? { resolvedModel: thread.resolvedModel } : {}),
      ...(thread.resolvedVariant !== undefined
        ? { resolvedVariant: thread.resolvedVariant }
        : {}),
      ...(thread.runtimeSelectionSource !== undefined
        ? { runtimeSelectionSource: thread.runtimeSelectionSource }
        : {}),
      ...(thread.attemptId !== undefined ? { attemptId: thread.attemptId } : {}),
      ...(thread.nativeSessionId !== undefined
        ? { nativeSessionId: thread.nativeSessionId }
        : {}),
      ...(thread.nativeRunId !== undefined ? { nativeRunId: thread.nativeRunId } : {}),
      ...(thread.lastEventAt !== undefined ? { lastEventAt: thread.lastEventAt } : {}),
      ...(thread.lastActivityAt !== undefined
        ? { lastActivityAt: thread.lastActivityAt }
        : {}),
      ...(thread.cancellationRequestedAt !== undefined
        ? { cancellationRequestedAt: thread.cancellationRequestedAt }
        : {}),
      ...(thread.cancellationAcknowledgedAt !== undefined
        ? { cancellationAcknowledgedAt: thread.cancellationAcknowledgedAt }
        : {}),
      ...(thread.terminalOutcome !== undefined
        ? { terminalOutcome: thread.terminalOutcome }
        : {}),
      ...(thread.errorSummary !== undefined ? { errorSummary: thread.errorSummary } : {}),
      ...(thread.resultSummary !== undefined ? { resultSummary: thread.resultSummary } : {}),
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
