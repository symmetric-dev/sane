import { existsSync, readFileSync } from "node:fs"

import { getRepoRoot } from "../lib/repo.ts"
import { getResolvedStream, loadIndex } from "../lib/index.ts"
import { readBatchStatus, type BatchStatusFile } from "../lib/batch-status.ts"
import {
  formatActivityRecordText,
  resolveRecordedRuntimePath,
  type ActivityRecord,
  type ReadActivityFileSystem,
} from "../lib/agent-runtime/observability.ts"

export interface BatchEventsCliArgs {
  repoRoot?: string
  streamId?: string
  batch?: string
  follow: boolean
  timeoutMs?: number
  format: "text" | "json"
  pollIntervalMs?: number
}

export interface ObserveBatchEventsOptions {
  repoRoot: string
  streamId: string
  batchId: string
  follow?: boolean
  timeoutMs?: number
  format?: "text" | "json"
  pollIntervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  readStatus?: typeof readBatchStatus
  fileSystem?: ReadActivityFileSystem
  write?: (line: string) => void
}

export interface ObserveBatchEventsResult {
  records: ActivityRecord[]
  journalPath: string
  timedOut: boolean
  terminal: boolean
}

const TERMINAL_ACTIVITY_KINDS = new Set([
  "batch_completed",
  "batch_failed",
  "batch_cancelled",
])

const defaultFileSystem: ReadActivityFileSystem = {
  existsSync,
  readFileSync: (path) => readFileSync(path),
}

function printHelp(): void {
  console.log(`
work-sdk batch-events - Observe compact SDK batch activity

Usage:
  work-sdk batch-events --batch SS.BB [options]

Options:
  --repo-root, -r        Repository root (auto-detected if omitted)
  --stream, -s           Workstream ID or name (uses current if omitted)
  --batch, -b            Canonical batch ID (required)
  --follow, -f           Follow journal creation and appended activity
  --timeout-ms           Bound follow mode in milliseconds
  --format               Output format: text | json (default: text)
  --poll-interval-ms     Follow poll interval (default: 100)
  --help, -h             Show this help message

Examples:
  work-sdk batch-events --batch "01.01"
  work-sdk batch-events --batch "01.01" --follow --timeout-ms 30000
  work-sdk batch-events --batch "01.01" --format json
`)
}

export function parseBatchEventsArgs(argv: string[]): BatchEventsCliArgs | null {
  const args = argv.slice(2)
  const parsed: BatchEventsCliArgs = { follow: false, format: "text" }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = args[index + 1]
    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) return null
        parsed.repoRoot = next
        index += 1
        break
      case "--stream":
      case "-s":
        if (!next) return null
        parsed.streamId = next
        index += 1
        break
      case "--batch":
      case "-b":
        if (!next) return null
        parsed.batch = next
        index += 1
        break
      case "--follow":
      case "-f":
        parsed.follow = true
        break
      case "--timeout-ms": {
        if (!next) return null
        const value = Number(next)
        if (!Number.isFinite(value) || value < 0) return null
        parsed.timeoutMs = value
        index += 1
        break
      }
      case "--format":
        if (next !== "text" && next !== "json") return null
        parsed.format = next
        index += 1
        break
      case "--poll-interval-ms": {
        if (!next) return null
        const value = Number(next)
        if (!Number.isFinite(value) || value <= 0) return null
        parsed.pollIntervalMs = value
        index += 1
        break
      }
      case "--help":
      case "-h":
        return null
      default:
        return null
    }
  }

  return parsed
}

function isTerminalRecord(record: ActivityRecord): boolean {
  return TERMINAL_ACTIVITY_KINDS.has(record.kind)
}

function formatRecord(record: ActivityRecord, format: "text" | "json"): string {
  return format === "json" ? JSON.stringify(record) : formatActivityRecordText(record)
}

function getJournalPath(
  status: BatchStatusFile | null,
  repoRoot: string,
  batchId: string,
): string {
  if (!status) throw new Error(`Batch ${batchId} not found in canonical state`)
  if (!status.activityJournalPath) {
    throw new Error(`Batch ${batchId} has no recorded activity journal path`)
  }
  return resolveRecordedRuntimePath(repoRoot, status.activityJournalPath)
}

function parseLines(content: string): ActivityRecord[] {
  const records: ActivityRecord[] = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as ActivityRecord
      if (record && typeof record === "object" && typeof record.timestamp === "string" && typeof record.kind === "string") {
        records.push(record)
      }
    } catch {
      // Ignore an incomplete line while an executor is appending it.
    }
  }
  return records
}

/**
 * Observe activity without tmux and without invoking any canonical-state
 * reconciliation. The recorded journal path is the only runtime path used.
 */
export async function observeBatchEvents(options: ObserveBatchEventsOptions): Promise<ObserveBatchEventsResult> {
  const readStatus = options.readStatus ?? readBatchStatus
  const status = readStatus(options.repoRoot, options.streamId, options.batchId)
  const journalPath = getJournalPath(status, options.repoRoot, options.batchId)
  const fileSystem = options.fileSystem ?? defaultFileSystem
  const follow = options.follow ?? false
  const format = options.format ?? "text"
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const write = options.write ?? ((line) => console.log(line))
  const deadline = options.timeoutMs === undefined ? undefined : now() + options.timeoutMs
  const records: ActivityRecord[] = []
  let offset = 0
  let partial = ""
  let terminal = false

  while (true) {
    if (fileSystem.existsSync(journalPath)) {
      const content = fileSystem.readFileSync(journalPath)
      if (content.length < offset) {
        // A run path should not be reused, but reset safely if a diagnostic
        // tool replaces the file while following it.
        offset = 0
        partial = ""
      }
      if (content.length > offset) {
        const chunk = content.subarray(offset).toString("utf8")
        offset = content.length
        const lines = `${partial}${chunk}`.split("\n")
        partial = lines.pop() ?? ""
        for (const record of parseLines(lines.join("\n"))) {
          records.push(record)
          write(formatRecord(record, format))
          if (isTerminalRecord(record)) terminal = true
        }
      }
    }

    if (!follow || terminal) {
      return { records, journalPath, timedOut: false, terminal }
    }
    if (deadline !== undefined && now() >= deadline) {
      return { records, journalPath, timedOut: true, terminal: false }
    }
    const remaining = deadline === undefined ? pollIntervalMs : Math.max(1, deadline - now())
    await sleep(Math.min(pollIntervalMs, remaining))
  }
}

export async function main(argv: string[] = process.argv): Promise<number> {
  if (argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    printHelp()
    return 0
  }
  const cliArgs = parseBatchEventsArgs(argv)
  if (!cliArgs || !cliArgs.batch) {
    console.error("Error: --batch is required")
    console.error("\nRun with --help for usage information.")
    return 2
  }

  try {
    const repoRoot = cliArgs.repoRoot ?? getRepoRoot()
    const streamId = getResolvedStream(loadIndex(repoRoot), cliArgs.streamId).id
    const result = await observeBatchEvents({
      repoRoot,
      streamId,
      batchId: cliArgs.batch,
      follow: cliArgs.follow,
      timeoutMs: cliArgs.timeoutMs,
      format: cliArgs.format,
      pollIntervalMs: cliArgs.pollIntervalMs,
    })
    if (result.timedOut) {
      console.error(`[batch-events] timed out after ${cliArgs.timeoutMs}ms`)
      return 1
    }
    return 0
  } catch (error) {
    console.error(`[batch-events] ${(error as Error).message}`)
    return 1
  }
}
