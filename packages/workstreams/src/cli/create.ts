/**
 * CLI: Create Workstream
 *
 * Creates a new workstream container with PLAN.md template and empty tasks.json.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { generateStream, createGenerateArgs } from "../lib/generate.ts"
import { validateStreamName } from "../lib/utils.ts"

interface CreateStreamCliArgs {
  name: string
  repoRoot?: string
  stages?: number
}

function printHelp(): void {
  console.log(`
work create - Create a draft workstream container

Usage:
  work create --name <name> [--stages <n>]

Required:
  --name, -n       Workstream name in kebab-case (e.g., "migrate-sql-to-orm")

Optional:
  --stages         Scaffold this many plan stages immediately (1-20)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Examples:
  # Create a draft workstream without stages yet
  work create --name migrate-sql-to-orm

  # Shortcut: create a workstream and scaffold 3 stages immediately
  work create --name migrate-sql-to-orm --stages 3

Workstream Structure:
  Creates a new workstream directory with:
  - PLAN.md     Structured markdown for workstream definition
  - tasks.json  Empty task tracker (populate with "work add-task")
  - files/      Directory for task outputs
  - docs/       Optional directory for additional documentation

Workflow:
  1. Create draft:      work create --name my-feature
  2. Set current:       work current --set "001-my-feature"
  3. Scaffold stages:   work plan create --stages 3
  4. Edit PLAN.md:      Fill in stage names, threads, and details
  5. Validate:          work validate plan
                         (empty drafts warn but still succeed)
  6. Approve:           work approve plan
                         (requires at least one stage)
  7. Track progress:    work list --stream "001-my-feature" --tasks

Shortcut:
  Skip step 2 with:     work create --name my-feature --stages 3
`)
}

function parseCliArgs(argv: string[]): CreateStreamCliArgs | null {
  const args = argv.slice(2)
  const parsed: Partial<CreateStreamCliArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--name":
      case "-n":
        if (!next) {
          console.error("Error: --name requires a value")
          return null
        }
        if (!validateStreamName(next)) {
          console.error(
            `Error: Workstream name must be kebab-case (e.g., "my-stream"). Got: "${next}"`
          )
          return null
        }
        parsed.name = next
        i++
        break

      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value")
          return null
        }
        parsed.repoRoot = next
        i++
        break

      case "--stages":
        if (!next) {
          console.error("Error: --stages requires a number")
          return null
        }
        const stages = parseInt(next, 10)
        if (isNaN(stages) || stages < 1 || stages > 20) {
          console.error("Error: --stages must be a number between 1 and 20")
          return null
        }
        parsed.stages = stages
        i++
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)

      // Deprecated options - show helpful message
      case "--size":
      case "-s":
        console.error("Error: --size is no longer supported. All workstreams now use a uniform structure.")
        console.error("Run with --help for usage information.")
        return null

      case "--supertasks":
      case "--subtasks":
        console.error(`Error: ${arg} is no longer supported. Use --stages to specify the number of stages.`)
        console.error("Run with --help for usage information.")
        return null
    }
  }

  // Validate required args
  if (!parsed.name) {
    console.error("Error: --name is required")
    return null
  }

  return parsed as CreateStreamCliArgs
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

  // Build args
  const generateArgs = createGenerateArgs(
    cliArgs.name,
    repoRoot,
    cliArgs.stages,
  )

  try {
    const result = generateStream(generateArgs)
    console.log(`Created workstream: ${result.streamId}`)
    console.log(`   Path: ${result.streamPath}`)
    console.log("")
    console.log("Next steps:")
    if (cliArgs.stages) {
      console.log("  1. Edit PLAN.md to define stages, threads, and tasks")
      console.log(`  2. Run: work validate plan`)
      console.log(`  3. View: work list --stream "${result.streamId}" --tasks`)
    } else {
      console.log(`  1. Scaffold plan stages: work plan create --stream "${result.streamId}" --stages 3`)
      console.log("  2. Edit PLAN.md to define stages, threads, and tasks")
      console.log(`  3. Run: work validate plan`)
    }
    console.log("")
    console.log("Created files:")
    console.log(
      cliArgs.stages
        ? "  - PLAN.md     (includes scaffolded stage templates)"
        : "  - PLAN.md     (draft plan with an empty Stages section)",
    )
    console.log("  - tasks.json  (empty task tracker)")
    console.log("  - docs/       (optional additional documentation)")
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
