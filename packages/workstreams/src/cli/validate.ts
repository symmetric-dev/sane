/**
 * CLI: Workstream Validate
 *
 * Validate PLAN.md and TASKS.md structure and content.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { getRepoRoot, getWorkDir } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { getStreamPlanMdPath, consolidateStream } from "../lib/consolidate.ts"
import { parseTasksMd } from "../lib/tasks-md.ts"
import { findSharedFilesInTasksMd, formatSharedFileWarnings } from "../lib/analysis.ts"

interface ValidateCliArgs {
    repoRoot?: string
    streamId?: string
    subcommand?: "plan" | "tasks"
    json: boolean
}

interface ValidationResult {
    valid: boolean
    errors: string[]
    warnings: string[]
}

function printHelp(): void {
    console.log(`
work validate - Validate workstream plan and tasks structure

Usage:
  work validate plan [--stream <stream-id>]
  work validate tasks [--stream <stream-id>]

Subcommands:
  plan     Validate PLAN.md structure and content
  tasks    Validate TASKS.md structure and content

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Validates PLAN.md or TASKS.md schema structure (stages, batches, threads).
  Both commands check for files shared across parallel threads in the same batch.
  Draft plans with an empty Stages section are valid, but 'work validate plan'
  emits a warning until stages are scaffolded.
  Note: Use 'work check plan' to check for open questions and missing input files.

Examples:
  # Validate current workstream plan
  work validate plan

  # Validate a draft plan before stages exist yet
  work create --name draft-feature
  work current --set "000-draft-feature"
  work validate plan

  # Validate tasks structure
  work validate tasks

  # Validate specific workstream
  work validate plan --stream "001-my-stream"

  # Output as JSON
  work validate plan --json
`)
}

function parseCliArgs(argv: string[]): ValidateCliArgs | null {
    const args = argv.slice(2)
    const parsed: ValidateCliArgs = { json: false }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const next = args[i + 1]

        // Handle subcommand
        if ((arg === "plan" || arg === "tasks") && !parsed.subcommand) {
            parsed.subcommand = arg as "plan" | "tasks"
            continue
        }

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
                parsed.streamId = next
                i++
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

function formatValidationResult(result: ValidationResult, fileType: "PLAN.md" | "TASKS.md"): string {
    const lines: string[] = []

    if (result.valid) {
        lines.push(`✓ ${fileType} validation passed`)
    } else {
        lines.push(`✗ ${fileType} validation failed`)
    }

    if (result.errors.length > 0) {
        lines.push("")
        lines.push("Errors:")
        for (const error of result.errors) {
            lines.push(`  - ${error}`)
        }
    }

    if (result.warnings.length > 0) {
        lines.push("")
        lines.push("Warnings:")
        for (const warning of result.warnings) {
            lines.push(`  - ${warning}`)
        }
    }

    return lines.join("\n")
}

export function main(argv: string[] = process.argv): void {
    const cliArgs = parseCliArgs(argv)
    if (!cliArgs) {
        console.error("\nRun with --help for usage information.")
        process.exit(1)
    }

    // Validate subcommand
    if (!cliArgs.subcommand) {
        console.error("Error: subcommand required (e.g., 'plan' or 'tasks')")
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

    // Load index and find workstream (uses current if not specified)
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

    if (cliArgs.subcommand === "plan") {
        const planMdPath = getStreamPlanMdPath(repoRoot, stream.id)
        if (!existsSync(planMdPath)) {
            console.error(`Error: PLAN.md not found at ${planMdPath}`)
            process.exit(1)
        }

        // Run schema validation
        const consolidateResult = consolidateStream(repoRoot, stream.id, true)

        const result: ValidationResult = {
            valid: consolidateResult.success,
            errors: consolidateResult.errors.map(e => `[${e.section || "?"}] ${e.message}`),
            warnings: consolidateResult.warnings,
        }

        if (cliArgs.json) {
            console.log(JSON.stringify(result, null, 2))
        } else {
            console.log(formatValidationResult(result, "PLAN.md"))
        }

        // Exit with error if validation failed
        if (!result.valid) {
            process.exit(1)
        }
    }

    if (cliArgs.subcommand === "tasks") {
        const workDir = getWorkDir(repoRoot)
        const tasksMdPath = join(workDir, stream.id, "TASKS.md")
        if (!existsSync(tasksMdPath)) {
            console.error(`Error: TASKS.md not found at ${tasksMdPath}`)
            process.exit(1)
        }

        const content = readFileSync(tasksMdPath, "utf-8")

        // Parse TASKS.md to check for structural errors
        const parseResult = parseTasksMd(content, stream.id)

        // Check for shared files in parallel threads
        const sharedFileWarnings = findSharedFilesInTasksMd(content)
        const formattedWarnings = formatSharedFileWarnings(sharedFileWarnings)

        const result: ValidationResult = {
            valid: parseResult.errors.length === 0,
            errors: parseResult.errors,
            warnings: formattedWarnings,
        }

        if (cliArgs.json) {
            console.log(JSON.stringify(result, null, 2))
        } else {
            console.log(formatValidationResult(result, "TASKS.md"))
        }

        // Exit with error if validation failed
        if (!result.valid) {
            process.exit(1)
        }
    }
}

// Run if called directly
if (import.meta.main) {
    main()
}
