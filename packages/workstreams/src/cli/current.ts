/**
 * CLI: Current
 *
 * Get or set the current workstream.
 */

import { getRepoRoot } from "../lib/repo.ts"
import {
  setCurrentStream,
  clearCurrentStream,
} from "../lib/index.ts"
import {
  createStreamMetadataFromWorkspaceStateRecord,
  loadCanonicalWorkspaceState,
  resolveWorkspaceStateStreamRecord,
} from "../lib/workspace-read-model.ts"

interface CurrentCliArgs {
  repoRoot?: string
  set?: string
  clear?: boolean
}

function printHelp(): void {
  console.log(`
work current - Get or set the current workstream

Usage:
  work current [options]

Options:
  --set, -s <id>      Set the current workstream by ID or name
  --clear, -c         Clear the current workstream
  --repo-root <path>  Repository root (auto-detected)
  --help, -h          Show this help message

When no options are provided, shows the current workstream.

Once a current workstream is set, all commands default to it:
  work status              # Uses current workstream
  work list --tasks        # Uses current workstream
  work update --task 1.1.1 --status completed

You can still override with --stream:
  work status --stream "other-stream"

Examples:
  work current                           # Show current workstream
  work current --set "001-my-feature"    # Set current workstream
  work current --clear                   # Clear current workstream
`)
}

function parseCliArgs(argv: string[]): CurrentCliArgs | null {
  const args = argv.slice(2)
  const parsed: Partial<CurrentCliArgs> = {}

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

      case "--set":
      case "-s":
        if (!next) {
          console.error("Error: --set requires a workstream ID or name")
          return null
        }
        parsed.set = next
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
    }
  }

  return parsed as CurrentCliArgs
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
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  try {
    // Clear current workstream
    if (cliArgs.clear) {
      clearCurrentStream(repoRoot)
      console.log("Cleared current workstream")
      return
    }

    // Set current workstream
    if (cliArgs.set) {
      const stream = setCurrentStream(repoRoot, cliArgs.set)
      console.log(`Current workstream set to: ${stream.id}`)
      return
    }

    // Show current workstream
    const workspaceState = loadCanonicalWorkspaceState(repoRoot)
    const currentId = workspaceState.currentStreamId

    if (!currentId) {
      console.log("No current workstream set")
      console.log("\nUse 'work current --set <id>' to set one.")
      return
    }

    const streamRecord = resolveWorkspaceStateStreamRecord(workspaceState, currentId)
    if (!streamRecord) {
      throw new Error(`Workstream "${currentId}" not found`)
    }

    const stream = createStreamMetadataFromWorkspaceStateRecord(streamRecord)
    console.log(`Current workstream: ${stream.id}`)
    console.log(`   Name: ${stream.name}`)
    console.log(`   Path: ${stream.path}`)
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
