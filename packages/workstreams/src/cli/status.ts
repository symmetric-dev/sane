/**
 * CLI: Workstream Status
 *
 * Shows the current status of one or all workstreams.
 */

import { getRepoRoot } from "../lib/repo.ts"
import {
  formatSessionHistory,
  formatStatusSnapshot,
  getWorkstreamStatusSnapshot,
  statusSnapshotToStreamProgress,
} from "../lib/status.ts"
import {
  createStreamMetadataFromWorkspaceStateRecord,
  loadCanonicalWorkspaceState,
} from "../lib/workspace-read-model.ts"

interface StatusCliArgs {
  repoRoot?: string
  streamId?: string
  json: boolean
  sessions: boolean
}

function printHelp(): void {
  console.log(`
work status - Show workstream progress

Usage:
  work status [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Specific workstream ID or name (shows all if omitted)
  --sessions       Show detailed session history for each thread
  --json, -j       Output as JSON
  --help, -h       Show this help message

Examples:
  # Show all workstreams
  work status

  # Show specific workstream
  work status --stream "001-my-stream"

  # Show detailed session history
  work status --sessions

  # Get JSON output
  work status --json
`)
}

function parseCliArgs(argv: string[]): StatusCliArgs | null {
  const args = argv.slice(2)
  const parsed: StatusCliArgs = { json: false, sessions: false }

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

      case "--sessions":
        parsed.sessions = true
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

  let workspaceState
  try {
    workspaceState = loadCanonicalWorkspaceState(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  if (workspaceState.workstreams.length === 0) {
    console.log("No workstreams found.")
    return
  }

  // Resolve stream ID: explicit > current > all
  const resolvedStreamIdOrName = cliArgs.streamId === "current"
    ? workspaceState.currentStreamId
    : cliArgs.streamId ?? workspaceState.currentStreamId

  const streamRecordsToShow = resolvedStreamIdOrName
    ? workspaceState.workstreams.filter(
      (record) => record.id === resolvedStreamIdOrName || record.name === resolvedStreamIdOrName,
    )
    : workspaceState.workstreams

  if (streamRecordsToShow.length === 0) {
    console.error(`Error: Workstream "${resolvedStreamIdOrName}" not found`)
    process.exit(1)
  }

  const snapshotList = streamRecordsToShow.map((streamRecord) => {
    const stream = createStreamMetadataFromWorkspaceStateRecord(streamRecord)
    const snapshot = getWorkstreamStatusSnapshot(repoRoot, stream, workspaceState.currentStreamId)
    return {
      stream,
      snapshot,
      progress: statusSnapshotToStreamProgress(snapshot),
    }
  })

  if (cliArgs.json) {
    const jsonOutput = snapshotList.map(({ snapshot, progress }) => ({
      ...progress,
      ...snapshot,
      status: snapshot.aggregate_status,
    }))
    console.log(JSON.stringify(jsonOutput, null, 2))
  } else {
    for (const { stream, snapshot, progress } of snapshotList) {
      console.log(formatStatusSnapshot(snapshot, stream, repoRoot))
      
      // Show detailed session history if --sessions flag is set
      if (cliArgs.sessions) {
        console.log(formatSessionHistory(repoRoot, stream.id, progress))
      } else {
        console.log()
      }
    }
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
