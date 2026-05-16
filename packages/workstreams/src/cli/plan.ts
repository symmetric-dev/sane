/**
 * CLI: Planning Session Management
 *
 * Opens the planning opencode session for the current workstream,
 * or scaffolds stage-local planning directories for an existing draft workstream.
 * 
 * Usage:
 *   work plan                                  - Resume planning session for current workstream
 *   work plan --stream "001-my-stream"         - Resume planning session for specific workstream
 *   work plan --set <sessionId>                - Set the planning session ID for current workstream
 *   work plan --stream <id> --set <sessionId>  - Set planning session for specific workstream
 *   work plan create --stages 3                - Scaffold stage directories for current workstream
 */

import { spawn } from "child_process"
import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, resolveStreamId, getPlanningSessionId, setStreamPlanningSession } from "../lib/index.ts"
import { scaffoldPlanStages } from "../lib/generate.ts"

interface PlanCliArgs {
  subcommand?: "create"
  repoRoot?: string
  stream?: string
  set?: string
  stages?: number
  help: boolean
}

function printHelp(): void {
  console.log(`
work plan - Resume planning sessions or scaffold stage directories

Usage:
  work plan [options]
  work plan create [options] --stages <n>

Description:
  Default behavior keeps planning-session management intact: resume a linked
  opencode session or set the linked session ID for a workstream.

  The 'create' subcommand scaffolds stage directories for a workstream under
  stages/ using the supported stage-local files.

  To link a session from within opencode, use the workstream_link_planning_session
  tool after creating a workstream.

Options:
  --stream, -s <id>    Workstream ID or name (uses current if not specified)
  --set <sessionId>    Link a session ID to the workstream (used by tools)
  --stages <n>         Number of stages to scaffold (required with 'create')
  --repo-root, -r      Repository root (auto-detected if omitted)
  --help, -h           Show this help message

Workflow:
  Draft-first flow:
    1. work create --name my-feature
    2. work current --set "001-my-feature"
    3. Update README.md with the overall workstream context
    4. work plan create --stages 3
    5. Edit stages/01/{REQUIREMENTS.md,PLAN.md} and specs/
    6. Rename each stage PLAN.md heading to a meaningful title (for example: # Stage 01 Discovery Plan)
    7. work approve plan    # requires at least one stage; generates thread WORK.md files

  Planning-session flow:
    1. Open opencode and discuss the problem
    2. Ask agent to create workstream with planning skill
    3. Use workstream_link_planning_session to link session
    4. Later, resume with: work plan

Examples:
  work plan                        # Resume planning session
  work plan --stream "001-feature" # Resume specific workstream
  work plan create --stages 3
  work plan create --stream "001-feature" --stages 3
`)
}

function parseCliArgs(argv: string[]): PlanCliArgs | null {
  const args = argv.slice(2)
  const parsed: PlanCliArgs = { help: false }

  let index = 0
  if (args[0] === "create") {
    parsed.subcommand = "create"
    index = 1
  }

  for (let i = index; i < args.length; i++) {
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
        if (!next) {
          console.error("Error: --stream requires a value")
          return null
        }
        parsed.stream = next
        i++
        break

      case "--set":
        if (!next) {
          console.error("Error: --set requires a value")
          return null
        }
        parsed.set = next
        i++
        break

      case "--stages":
        if (!next) {
          console.error("Error: --stages requires a number")
          return null
        }
        parsed.stages = parseInt(next, 10)
        if (isNaN(parsed.stages) || parsed.stages < 1 || parsed.stages > 20) {
          console.error("Error: --stages must be a number between 1 and 20")
          return null
        }
        i++
        break

      case "--help":
      case "-h":
        parsed.help = true
        break

      default:
        if (arg && arg.startsWith("-")) {
          console.error(`Error: Unknown option "${arg}"`)
          return null
        }
        if (!parsed.subcommand) {
          console.error(`Error: Unknown subcommand "${arg}"`)
          return null
        }
    }
  }

  if (parsed.subcommand === "create") {
    if (!parsed.stages) {
      console.error("Error: work plan create requires --stages")
      return null
    }
    if (parsed.set) {
      console.error("Error: --set cannot be used with 'work plan create'")
      return null
    }
  }

  return parsed
}

function handleCreatePlan(
  repoRoot: string,
  streamId: string,
  stages: number,
): void {
  try {
    const result = scaffoldPlanStages(repoRoot, streamId, stages)
    console.log(`Scaffolded ${result.stageCount} stage${result.stageCount === 1 ? "" : "s"} in workstream "${streamId}".`)
    console.log(`  Updated: ${result.stagesPath}`)
    console.log("")
    console.log("Next steps:")
    console.log("  1. Edit each stage directory under stages/")
    console.log("  2. Fill REQUIREMENTS.md, PLAN.md, and specs/ for each stage")
    console.log("  3. Rename each stage PLAN.md heading to a meaningful title so stage names carry through preview and approval flows")
    console.log("  4. After approval, use generated threads/<thread-id>/WORK.md files as the primary worker docs")
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

/**
 * Set the planning session ID for a workstream
 */
function handleSetSession(
  repoRoot: string,
  streamId: string,
  sessionId: string
): void {
  try {
    const stream = setStreamPlanningSession(repoRoot, streamId, sessionId)
    console.log(`Set planning session for workstream "${stream.id}":`)
    console.log(`  Session ID: ${sessionId}`)
    console.log(`\nYou can now resume this session with:`)
    console.log(`  work plan`)
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

/**
 * Resume the planning session for a workstream
 */
function handleResumeSession(
  repoRoot: string,
  streamId: string
): void {
  try {
    const sessionId = getPlanningSessionId(repoRoot, streamId)
    
    if (!sessionId) {
      console.error(`No planning session found for workstream "${streamId}".`)
      console.error("")
      console.error("Options:")
      console.error("  1. If you created a planning session manually, use:")
      console.error("     work plan --set <sessionId>")
      console.error("")
      console.error("  2. Create a new workstream with planning session:")
      console.error("     work create --name my-feature")
      process.exit(1)
    }

    console.log(`Resuming planning session for workstream "${streamId}"...`)
    console.log(`Session ID: ${sessionId}`)
    console.log("")

    // Spawn opencode with the session ID
    const child = spawn("opencode", ["--session", sessionId], {
      stdio: "inherit",
      cwd: repoRoot,
    })

    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`\nopencode exited with code ${code}`)
        process.exit(code)
      }
    })

    child.on("error", (err) => {
      console.error(`\nFailed to launch opencode: ${err.message}`)
      process.exit(1)
    })
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

export function main(argv: string[] = process.argv): void {
  const cliArgs = parseCliArgs(argv)
  
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  if (cliArgs.help) {
    printHelp()
    process.exit(0)
  }

  // Auto-detect repo root if not provided
  let repoRoot: string
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  // Load index and resolve stream ID
  let index
  try {
    index = loadIndex(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  const resolvedStreamId = resolveStreamId(index, cliArgs.stream)
  if (!resolvedStreamId) {
    if (cliArgs.stream) {
      console.error(`Error: Workstream "${cliArgs.stream}" not found.`)
    } else {
      console.error("Error: No current workstream set.")
      console.error("Run 'work current --set <stream-id>' to set one.")
    }
    process.exit(1)
  }

  if (cliArgs.subcommand === "create") {
    handleCreatePlan(repoRoot, resolvedStreamId, cliArgs.stages!)
  } else if (cliArgs.set) {
    handleSetSession(repoRoot, resolvedStreamId, cliArgs.set)
  } else {
    // Default: resume session
    handleResumeSession(repoRoot, resolvedStreamId)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
