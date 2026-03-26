/**
 * CLI: Add Stage
 *
 * Append a fix stage to a workstream
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { appendFixStage, appendFixBatch } from "../lib/fix.ts"

interface AddStageCliArgs {
  repoRoot?: string
  streamId?: string
  targetStage: number
  afterStage?: number
  name: string
  description?: string
  isBatch?: boolean
}

function printHelp(): void {
  console.log(`
work add stage - Add a fix stage or batch to a workstream

Usage:
  work add stage --stage <n> --name <name> [options]

Required:
  --stage          The stage number being fixed (e.g. 1 or 01)
  --name           Name of the fix (e.g., "auth-race-condition")

Optional:
  --batch          Create a fix batch within the stage instead of a new stage
  --after-stage    Insert the new stage after this stage number from PLAN.md
                   (e.g. 3 inserts after Stage 03). Defaults to append.
  --stream, -s     Workstream ID or name (uses current if not specified)
  --description    Description of the fix
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Examples:
  work add stage --stage 01 --name "api-error-handling"
  work add stage --stage 03 --after-stage 03 --name "post-review-fixes"
  work add stage --batch --stage 02 --name "validation-logic"
`)
}

function parseCliArgs(argv: string[]): AddStageCliArgs | null {
  const args = argv.slice(2)
  const parsed: Partial<AddStageCliArgs> = {}

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

      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value")
          return null
        }
        parsed.targetStage = parseInt(next, 10)
        i++
        break

      case "--after-stage":
        if (!next) {
          console.error("Error: --after-stage requires a value")
          return null
        }
        parsed.afterStage = parseInt(next, 10)
        i++
        break

      case "--name":
        if (!next) {
          console.error("Error: --name requires a value")
          return null
        }
        parsed.name = next
        i++
        break

      case "--description":
        if (!next) {
          console.error("Error: --description requires a value")
          return null
        }
        parsed.description = next
        i++
        break

      case "--batch":
        parsed.isBatch = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  if (!parsed.targetStage || isNaN(parsed.targetStage)) {
    console.error("Error: --stage is required and must be a number")
    return null
  }
  if (parsed.afterStage !== undefined && isNaN(parsed.afterStage)) {
    console.error("Error: --after-stage must be a number")
    return null
  }
  if (!parsed.name) {
    console.error("Error: --name is required")
    return null
  }

  return parsed as AddStageCliArgs
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

  try {
    let result

    if (cliArgs.isBatch) {
      result = appendFixBatch(repoRoot, stream.id, {
        targetStage: cliArgs.targetStage,
        name: cliArgs.name,
        description: cliArgs.description,
      })
    } else {
      result = appendFixStage(repoRoot, stream.id, {
        targetStage: cliArgs.targetStage,
        afterStage: cliArgs.afterStage,
        name: cliArgs.name,
        description: cliArgs.description,
      })
    }

    if (result.success) {
      console.log(result.message)
      console.log(`\nRun 'work validate plan' to validate the new stage.`)
    } else {
      console.error(`Error: ${result.message}`)
      process.exit(1)
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
