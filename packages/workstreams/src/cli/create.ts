/**
 * CLI: Create Workstream
 *
 * Creates a new workstream container with a minimal draft-first layout.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { generateStream, createGenerateArgs } from "../lib/generate.ts"
import { validateStreamName } from "../lib/utils.ts"

interface CreateStreamCliArgs {
  name: string
  repoRoot?: string
}

function printHelp(): void {
  console.log(`
work create - Create a draft workstream container

Usage:
  work create --name <name>

Required:
  --name, -n       Workstream name in kebab-case (e.g., "migrate-sql-to-orm")

Optional:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --help, -h       Show this help message

Examples:
  # Create a draft workstream without stages yet
  work create --name migrate-sql-to-orm

Workstream Structure:
  Creates a new workstream directory with:
  - README.md   Shared workstream description, goals, and requirements
  - resources/  Supporting files gathered before stage planning
  - docs/       Optional draft notes and supporting documentation
  - stages/     Stage directories added by 'work plan create'

Workflow:
  1. Create draft:      work create --name my-feature
  2. Set current:       work current --set "001-my-feature"
  3. Gather context:    Add files under resources/ or docs/
  4. Draft root context: Update README.md with the overall goal and requirements
  5. Scaffold stages:   work plan create --stages 3
  6. Fill stage docs:   Edit stages/01/{REQUIREMENTS.md,PLAN.md,WORK.md}
  7. Repeat for more stages as needed
  8. Approve:           work approve plan
                          (requires at least one stage)
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
        console.error(`Error: ${arg} is no longer supported. Use 'work plan create --stages <n>' after creating the workstream.`)
        console.error("Run with --help for usage information.")
        return null

      case "--stages":
        console.error("Error: --stages is no longer supported on 'work create'.")
        console.error("Create the workstream first, then run 'work plan create --stages <n>'.")
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
  )

  try {
    const result = generateStream(generateArgs)
    console.log(`Created workstream: ${result.streamId}`)
    console.log(`   Path: ${result.streamPath}`)
    console.log("")
    console.log("Next steps:")
    console.log("  1. Review and update README.md with the overall goal and shared requirements")
    console.log("  2. Add supporting files under resources/ or docs/")
    console.log(`  3. Run: work plan create --stream "${result.streamId}" --stages 3`)
    console.log("  4. Fill each stage directory under stages/ with REQUIREMENTS.md, PLAN.md, WORK.md, and specs/")
    console.log("")
    console.log("Initial filesystem state:")
    console.log("  - README.md   (shared workstream description and requirements)")
    console.log("  - resources/  (supporting files and gathered inputs)")
    console.log("  - docs/       (optional draft notes and documentation)")
    console.log("  - stages/     (empty until 'work plan create' scaffolds stage directories)")
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
