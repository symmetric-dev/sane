import { rebuildCompatibilityProjectionFromSqlite } from "../lib/compatibility-projection.ts"
import { getRepoRoot } from "../lib/repo.ts"

interface RebuildCompatCliArgs {
  repoRoot?: string
  streamId?: string
  outputRoot?: string
}

function printHelp(): void {
  console.log(`
work rebuild-compat - Rebuild compatibility JSON from sqlite

Usage:
  work rebuild-compat [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Specific workstream ID or name (rebuilds that tasks.json only)
  --output-root, -o
                   Output root for rollback-safe inspection (defaults to repo root)
  --help, -h       Show this help message

Examples:
  work rebuild-compat
  work rebuild-compat --stream current
  work rebuild-compat --output-root /tmp/sqlite-compat-snapshot
`)
}

function parseCliArgs(argv: string[]): RebuildCompatCliArgs | null {
  const args = argv.slice(2)
  const parsed: RebuildCompatCliArgs = {}

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    const next = args[index + 1]

    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value")
          return null
        }
        parsed.repoRoot = next
        index++
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
        index++
        break

      case "--output-root":
      case "-o":
        if (!next) {
          console.error("Error: --output-root requires a value")
          return null
        }
        parsed.outputRoot = next
        index++
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

  try {
    const result = rebuildCompatibilityProjectionFromSqlite({
      repoRoot,
      streamId: cliArgs.streamId,
      outputRoot: cliArgs.outputRoot,
    })

    console.log(`Rebuilt compatibility projections under ${result.outputRoot}`)
    if (result.indexPath) {
      console.log(`  - ${result.indexPath}`)
    }
    for (const tasksPath of result.tasksPaths) {
      console.log(`  - ${tasksPath}`)
    }
  } catch (error) {
    console.error((error as Error).message)
    process.exit(1)
  }
}

if (import.meta.main) {
  main()
}
