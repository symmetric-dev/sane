/**
 * CLI: Workstream Check
 *
 * Find todo items, unchecked boxes, and errors in PLAN.md.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import {
    loadWorkstreamPlan,
    consolidateStream,
    formatMissingWorkstreamPlanMessage,
} from "../lib/consolidate.ts"
import { findOpenQuestions, extractInputFileReferences, findMissingInputFiles, type OpenQuestion } from "../lib/analysis.ts"

interface CheckCliArgs {
    repoRoot?: string
    streamId?: string
    subcommand?: "plan"
    json: boolean
}

interface CheckResult {
    schemaValid: boolean
    schemaErrors: string[]
    schemaWarnings: string[]
    draftPlan: boolean
    openQuestions: OpenQuestion[]
    missingInputFiles: string[]
}

function printHelp(): void {
    console.log(`
work check - comprehensive check of workstream files

Usage:
  work check plan [--stream <stream-id>]

Subcommands:
  plan     Check PLAN.md for schema errors, open questions, and missing inputs

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Comprehensive check for plan documents including:
  - Schema structure
  - Open questions [ ] (reports with line numbers)
  - Referenced input files (checks if they exist)

Examples:
  # Check current workstream plan
  work check plan

  # Check specific workstream
  work check plan --stream "001-my-stream"

  # Output as JSON
  work check plan --json
`)
}

function parseCliArgs(argv: string[]): CheckCliArgs | null {
    const args = argv.slice(2)
    const parsed: CheckCliArgs = { json: false }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        const next = args[i + 1]

        // Handle subcommand
        if (arg === "plan" && !parsed.subcommand) {
            parsed.subcommand = "plan"
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

function formatCheckResult(result: CheckResult): string {
    const lines: string[] = []

    const issuesCount = result.schemaErrors.length + result.openQuestions.length + result.missingInputFiles.length
    const warningsCount = result.schemaWarnings.length

    if (issuesCount === 0 && warningsCount === 0) {
        lines.push("✓ PLAN.md checks passed. No issues found.")
    } else if (issuesCount === 0 && warningsCount > 0) {
        lines.push(`✓ PLAN.md checks passed with ${warningsCount} warning${warningsCount !== 1 ? "s" : ""}`)
    } else {
        lines.push(`⚠ Found ${issuesCount} issue${issuesCount !== 1 ? "s" : ""} in PLAN.md`)
    }

    if (result.draftPlan) {
        lines.push("Draft plan: no stages defined yet.")
    }

    if (result.schemaErrors.length > 0) {
        lines.push("")
        lines.push("Schema Errors:")
        for (const error of result.schemaErrors) {
            lines.push(`  - ${error}`)
        }
    }

    if (result.schemaWarnings.length > 0) {
        lines.push("")
        lines.push(`Warnings (${result.schemaWarnings.length}):`)
        for (const warning of result.schemaWarnings) {
            lines.push(`  - ${warning}`)
        }
    }

    if (result.openQuestions.length > 0) {
        lines.push("")
        lines.push(`Open Questions (${result.openQuestions.length}):`)
        for (const q of result.openQuestions) {
            const stageInfo = q.stage ? ` (Stage ${q.stage})` : ""
            lines.push(`  Line ${q.line}${stageInfo}: [ ] ${q.question}`)
        }
    }

    if (result.missingInputFiles.length > 0) {
        lines.push("")
        lines.push(`Missing Input Files (${result.missingInputFiles.length}):`)
        for (const file of result.missingInputFiles) {
            lines.push(`  - ${file}`)
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
        console.error("Error: subcommand required (e.g., 'plan')")
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
            console.error(`Error: ${formatMissingWorkstreamPlanMessage(repoRoot, stream.id)}`)
            process.exit(1)
        }
        const content = loadedPlan.content

        // 1. Schema Validation
        const consolidateResult = consolidateStream(repoRoot, stream.id, true)
        const schemaErrors = consolidateResult.errors.map(e => `[${e.section || "?"}] ${e.message}`)

        // 2. Open Questions
        const openQuestions = findOpenQuestions(content)

        // 3. Missing Inputs
        const inputFiles = extractInputFileReferences(content)
        const missingInputFiles = findMissingInputFiles(repoRoot, loadedPlan.displayPath, inputFiles)

        const result: CheckResult = {
            schemaValid: consolidateResult.success,
            schemaErrors,
            schemaWarnings: consolidateResult.warnings,
            draftPlan: consolidateResult.streamDocument?.stages.length === 0,
            openQuestions,
            missingInputFiles
        }

        if (cliArgs.json) {
            console.log(JSON.stringify(result, null, 2))
        } else {
            console.log(formatCheckResult(result))
        }
    }
}

// Run if called directly
if (import.meta.main) {
    main()
}
