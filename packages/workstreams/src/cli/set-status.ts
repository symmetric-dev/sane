/**
 * CLI: Set Workstream Status
 *
 * Manually set a workstream's status (e.g., on_hold).
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream, setStreamStatus } from "../lib/index.ts"
import { getStreamStatus, formatStreamStatusIcon } from "../lib/status.ts"
import type { StreamStatus } from "../lib/types.ts"

interface SetStatusCliArgs {
  repoRoot?: string
  streamId?: string
  status?: string
  clear?: boolean
}

const VALID_STATUSES: StreamStatus[] = ["pending", "in_progress", "completed", "on_hold"]

function printHelp(): void {
  console.log(`
work set-status - Set workstream status manually

Usage:
  work set-status <status> [--stream <id>]
  work set-status --clear [--stream <id>]

Arguments:
  <status>         Status to set: pending, in_progress, completed, on_hold

Options:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --clear, -c      Clear manual status (let it be computed from items)
  --repo-root      Repository root (auto-detected)
  --help, -h       Show this help message

Workstream Statuses:
  pending       No items started (default)
  in_progress   Has items in progress or completed
  completed     All items completed
  on_hold       Manually paused, won't work on for now

Notes:
  - Most statuses are computed automatically from item states
  - Use 'on_hold' to mark a workstream as paused without deleting it
  - Use --clear to reset to computed status

Examples:
  # Put current workstream on hold
  work set-status on_hold

  # Mark specific workstream as on hold
  work set-status on_hold --stream "001-my-feature"

  # Clear manual status (use computed)
  work set-status --clear
`)
}

function parseCliArgs(argv: string[]): SetStatusCliArgs | null {
  const args = argv.slice(2)
  const parsed: SetStatusCliArgs = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
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

      case "--clear":
      case "-c":
        parsed.clear = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)

      default:
        // Positional argument - status
        if (!arg.startsWith("-") && !parsed.status) {
          parsed.status = arg
        }
    }
  }

  // Validate
  if (!parsed.clear && !parsed.status) {
    console.error("Error: Status is required. Use one of: " + VALID_STATUSES.join(", "))
    return null
  }

  if (parsed.status && !VALID_STATUSES.includes(parsed.status as StreamStatus)) {
    console.error(`Error: Invalid status "${parsed.status}". Use one of: ${VALID_STATUSES.join(", ")}`)
    return null
  }

  return parsed
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

  const previousStatus = getStreamStatus(repoRoot, stream)

  try {
    if (cliArgs.clear) {
      setStreamStatus(repoRoot, stream.id, undefined)
      // Re-fetch to get computed status
      const updatedIndex = loadIndex(repoRoot)
      const updatedStream = getResolvedStream(updatedIndex, stream.id)
      const newStatus = getStreamStatus(repoRoot, updatedStream)
      console.log(`Cleared manual status for "${stream.id}"`)
      console.log(`  Status: ${formatStreamStatusIcon(previousStatus)} → ${formatStreamStatusIcon(newStatus)} (computed)`)
    } else {
      const newStatus = cliArgs.status as StreamStatus
      setStreamStatus(repoRoot, stream.id, newStatus)
      console.log(`Updated status for "${stream.id}"`)
      console.log(`  Status: ${formatStreamStatusIcon(previousStatus)} → ${formatStreamStatusIcon(newStatus)}`)
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
