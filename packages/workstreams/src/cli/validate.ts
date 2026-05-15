/**
 * CLI: Workstream Validate
 *
 * Validate planning documents and requirements content.
 */

import { readFileSync } from "fs"
import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { loadWorkstreamPlan, consolidateStream } from "../lib/consolidate.ts"
import { printRemovedTaskWorkflowError } from "../lib/removed-workflows.ts"
import {
    loadWorkstreamRequirements,
    validateRequirementsDocument,
} from "../lib/requirements.ts"
import { relative } from "path"

interface ValidateCliArgs {
    repoRoot?: string
    streamId?: string
    subcommand?: "plan" | "tasks" | "requirements"
    json: boolean
}

interface ValidationResult {
    valid: boolean
    errors: string[]
    warnings: string[]
}

function printHelp(): void {
    console.log(`
 work validate - Validate workstream planning docs and requirements

Usage:
  work validate plan [--stream <stream-id>]
  work validate requirements [--stream <stream-id>]

Subcommands:
  plan     Validate planning structure and content
  requirements  Validate requirements structure and content

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Validates planning and requirements markdown during the current transition.
  In the supported stage-local model, shared goals live in root README.md and
  stage details live under stages/<nn>/. Some validation flows still target the
  compatibility plan/requirements documents where present.
  Plan validation checks for files shared across parallel threads in the same batch.
  REQUIREMENTS.md validation checks required sections plus dependency/resource paths.
  When no root REQUIREMENTS.md exists, it validates filled stage-local files under
  stages/<nn>/REQUIREMENTS.md and ignores untouched scaffolds.
  Note: Use 'work check plan' to check for open questions and missing input files.

Examples:
  # Validate current workstream plan compatibility document
  work validate plan

  # Validate requirements and a newly scaffolded plan
  work create --name draft-feature
  work current --set "000-draft-feature"
  work plan create --stages 2
  work validate plan

  # Validate root or stage-local requirements structure
  work validate requirements

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
        if ((arg === "plan" || arg === "tasks" || arg === "requirements") && !parsed.subcommand) {
            parsed.subcommand = arg as "plan" | "tasks" | "requirements"
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

function formatValidationResult(result: ValidationResult, fileType: "PLAN.md" | "TASKS.md" | "REQUIREMENTS.md"): string {
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
        console.error("Error: subcommand required (e.g., 'plan' or 'requirements')")
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
        const loadedPlan = loadWorkstreamPlan(repoRoot, stream.id)
        if (!loadedPlan) {
            console.error(`Error: no root or stage-local PLAN.md found for workstream "${stream.id}"`)
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
        printRemovedTaskWorkflowError(
            "Use 'work validate plan' to validate the thread/stage execution structure before 'work approve plan'.",
        )
    }

    if (cliArgs.subcommand === "requirements") {
        const loadedRequirementsResult = loadWorkstreamRequirements(repoRoot, stream.id)
        if (loadedRequirementsResult.status === "no-stages") {
            console.error(
                `Error: no stages have been created yet for workstream "${stream.id}". Run 'work plan create --stream "${stream.id}" --stages <count>' first.`,
            )
            process.exit(1)
        }

        if (loadedRequirementsResult.status === "missing") {
            console.error(`Error: no root or stage-local REQUIREMENTS.md found for workstream "${stream.id}"`)
            process.exit(1)
        }

        const loadedRequirements = loadedRequirementsResult.documents

        const result: ValidationResult = {
            valid: true,
            errors: [],
            warnings: [...loadedRequirements.warnings],
        }

        for (const requirementsPath of loadedRequirements.documentPaths) {
            const content = readFileSync(requirementsPath, "utf-8")
            const validation = validateRequirementsDocument({
                content,
                repoRoot,
                streamId: stream.id,
            })

            const pathPrefix = loadedRequirements.source === "stages"
                ? `${relative(repoRoot, requirementsPath)}: `
                : ""

            result.valid = result.valid && validation.valid
            result.errors.push(
                ...validation.errors.map((error) => {
                    const location = error.line !== undefined
                        ? `[${error.section} line ${error.line}]`
                        : `[${error.section}]`
                    return `${pathPrefix}${location} ${error.message}`
                }),
            )
            result.warnings.push(
                ...validation.warnings.map((warning) => `${pathPrefix}${warning}`),
            )
        }

        if (cliArgs.json) {
            console.log(JSON.stringify(result, null, 2))
        } else {
            console.log(formatValidationResult(result, "REQUIREMENTS.md"))
        }

        if (!result.valid) {
            process.exit(1)
        }
    }
}

// Run if called directly
if (import.meta.main) {
    main()
}
