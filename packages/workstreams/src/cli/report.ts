/**
 * CLI: Workstream Report
 *
 * Generate progress reports for workstreams.
 * Supports both full workstream reports and stage-specific reports.
 */

import { writeFileSync, existsSync } from "fs"
import { join } from "path"
import { getRepoRoot, getWorkDir } from "../lib/repo.ts"
import { loadIndex, resolveStreamId, findStream, atomicWriteFile } from "../lib/index.ts"
import { generateReport, formatReportMarkdown } from "../lib/document.ts"
import {
  generateStageReport,
  formatStageReportMarkdown,
  saveStageReport,
} from "../lib/reports.ts"
import {
  generateReportTemplate,
  validateReport,
} from "../lib/report-template.ts"
import {
  evaluateStream,
  evaluateAllStreams,
  filterExecutionItems,
  filterExecutionItemsByStatus,
  analyzeBlockers,
  formatMetricsOutput,
  formatBlockerAnalysis,
  aggregateMetrics,
} from "../lib/metrics.ts"
import { listThreadExecutionItems } from "../lib/thread-execution.ts"
import type { ExecutionStatus } from "../lib/types.ts"

interface ReportCliArgs {
  subcommand?: "init" | "validate" | "metrics"
  repoRoot?: string
  streamId?: string
  stage?: string
  all: boolean
  output?: string
  json: boolean
  save: boolean
  // Metrics specific args
  filter?: string
  regex: boolean
  filterStatus?: string
  blockers: boolean
  compact: boolean
}

function printHelp(): void {
  console.log(`
work report - Generate and validate workstream reports

Usage:
  work report [subcommand] [options]

Subcommands:
  init             Generate REPORT.md template for an existing workstream
  validate         Validate REPORT.md has required sections filled
  metrics          Evaluate workstream progress and metrics
  (none)           Generate progress report (default behavior)

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Specific workstream ID or name (uses current if set)
  --stage          Generate stage-specific report (number or name)
  --all            Generate report for all workstreams
  --output, -o     Output file path (prints to stdout if omitted)
  --save           Save stage report to reports/ directory
  --json, -j       Output as JSON
  --help, -h       Show this help message

Metrics Options (for 'work report metrics'):
  --filter <pattern>   Filter execution items by name pattern
  --regex              Treat filter as regex pattern
  --filter-status <s>  Filter by status (comma-separated: pending,blocked)
  --blockers           Show blocked item analysis
  --compact            Single-line summary per workstream

Examples:
  # Generate REPORT.md template for current workstream
  work report init

  # Validate REPORT.md for current workstream
  work report validate

  # Current workstream report
  work report

  # Stage-specific report
  work report --stage 1

  # Metrics and Status
  work report metrics
  work report metrics --blockers
  work report metrics --filter "test"

  # All workstreams
  work report --all
`)
}

function parseCliArgs(argv: string[]): ReportCliArgs | null {
  const args = argv.slice(2)
  const parsed: ReportCliArgs = {
    all: false,
    json: false,
    save: false,
    regex: false,
    blockers: false,
    compact: false,
  }

  // Check for subcommand as first argument
  if (args.length > 0 && !args[0]?.startsWith("-")) {
    const subcommand = args[0]
    if (subcommand === "init" || subcommand === "validate" || subcommand === "metrics") {
      parsed.subcommand = subcommand
      // Remove subcommand from args for remaining parsing
      args.shift()
    }
  }

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
        parsed.stage = next
        i++
        break

      case "--all":
        parsed.all = true
        break

      case "--output":
      case "-o":
        if (!next) {
          console.error("Error: --output requires a value")
          return null
        }
        parsed.output = next
        i++
        break

      case "--save":
        parsed.save = true
        break

      case "--json":
      case "-j":
        parsed.json = true
        break
      
      case "--filter":
        if (!next) {
          console.error("Error: --filter requires a value")
          return null
        }
        parsed.filter = next
        i++
        break

      case "--regex":
        parsed.regex = true
        break

      case "--filter-status":
        if (!next) {
          console.error("Error: --filter-status requires a value")
          return null
        }
        parsed.filterStatus = next
        i++
        break

      case "--blockers":
        parsed.blockers = true
        break

      case "--compact":
        parsed.compact = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed
}

/**
 * Handle 'work report init' subcommand
 * Generates REPORT.md template for an existing workstream
 */
function handleInit(repoRoot: string, streamId: string): void {
  const index = loadIndex(repoRoot)
  const stream = findStream(index, streamId)
  if (!stream) {
    console.error(`Error: Workstream "${streamId}" not found`)
    process.exit(1)
  }

  const workDir = getWorkDir(repoRoot)
  const reportPath = join(workDir, stream.id, "REPORT.md")

  // Check if REPORT.md already exists
  if (existsSync(reportPath)) {
    console.error(`Error: REPORT.md already exists at ${reportPath}`)
    console.error("Use --force to overwrite (not implemented yet)")
    process.exit(1)
  }

  try {
    const template = generateReportTemplate(repoRoot, streamId)
    atomicWriteFile(reportPath, template)
    console.log(`Created REPORT.md template: ${reportPath}`)
    console.log("")
    console.log("Next steps:")
    console.log("  1. Fill in the Summary section with a high-level overview")
    console.log("  2. Document accomplishments for each stage")
    console.log("  3. Add file references with changes made")
    console.log("  4. Run: work report validate")
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

/**
 * Handle 'work report validate' subcommand
 * Validates REPORT.md has required sections filled
 */
function handleValidate(repoRoot: string, streamId: string): void {
  const index = loadIndex(repoRoot)
  const stream = findStream(index, streamId)
  if (!stream) {
    console.error(`Error: Workstream "${streamId}" not found`)
    process.exit(1)
  }

  const workDir = getWorkDir(repoRoot)
  const reportPath = join(workDir, stream.id, "REPORT.md")

  // Check if REPORT.md exists
  if (!existsSync(reportPath)) {
    console.error(`Error: REPORT.md not found at ${reportPath}`)
    console.error("Run 'work report init' to create a template")
    process.exit(1)
  }

  try {
    const validation = validateReport(repoRoot, streamId)

    if (validation.valid) {
      console.log("✓ REPORT.md validation passed")
      if (validation.warnings.length > 0) {
        console.log("\nWarnings:")
        for (const warning of validation.warnings) {
          console.log(`  ⚠ ${warning}`)
        }
      }
    } else {
      console.log("✗ REPORT.md validation failed")
      console.log("\nErrors:")
      for (const error of validation.errors) {
        console.log(`  ✗ ${error}`)
      }
      if (validation.warnings.length > 0) {
        console.log("\nWarnings:")
        for (const warning of validation.warnings) {
          console.log(`  ⚠ ${warning}`)
        }
      }
      process.exit(1)
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

function getStatusIcon(status: ExecutionStatus): string {
  switch (status) {
    case "completed":
      return "[x]"
    case "in_progress":
      return "[~]"
    case "blocked":
      return "[!]"
    case "cancelled":
      return "[-]"
    default:
      return "[ ]"
  }
}

/**
 * Handle 'work report metrics' subcommand
 */
function handleMetrics(repoRoot: string, cliArgs: ReportCliArgs): void {
  const index = loadIndex(repoRoot)

  // Handle --all flag
  if (cliArgs.all) {
    const allMetrics = evaluateAllStreams(repoRoot)

    if (cliArgs.json) {
      const aggregate = aggregateMetrics(allMetrics)
      console.log(JSON.stringify({ streams: allMetrics, aggregate }, null, 2))
      return
    }

    if (cliArgs.compact) {
      for (const metrics of allMetrics) {
        console.log(formatMetricsOutput(metrics, { compact: true }))
      }
      console.log("")
      const aggregate = aggregateMetrics(allMetrics)
      console.log(formatMetricsOutput(aggregate, { compact: true }))
      return
    }

    for (const metrics of allMetrics) {
      console.log(formatMetricsOutput(metrics))
      console.log("")
    }

    console.log("─".repeat(40))
    const aggregate = aggregateMetrics(allMetrics)
    console.log(formatMetricsOutput(aggregate))
    return
  }

  // Single workstream metrics
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId)

  if (!resolvedStreamId) {
    console.error(
      "Error: No workstream specified. Use --stream or set current with 'work current --set'"
    )
    process.exit(1)
  }

  const stream = findStream(index, resolvedStreamId)
  if (!stream) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`)
    process.exit(1)
  }

  // Handle --blockers flag
  if (cliArgs.blockers) {
    const analysis = analyzeBlockers(repoRoot, stream.id)

    if (cliArgs.json) {
      console.log(JSON.stringify(analysis, null, 2))
      return
    }

    console.log(formatBlockerAnalysis(analysis))
    return
  }

  // Handle filters
  if (cliArgs.filter || cliArgs.filterStatus) {
    let items = listThreadExecutionItems(repoRoot, stream.id)

    // Apply status filter first
    if (cliArgs.filterStatus) {
      const statuses = cliArgs.filterStatus.split(",") as ExecutionStatus[]
      items = filterExecutionItemsByStatus(items, statuses)
    }

    // Apply name filter
    if (cliArgs.filter) {
      const result = filterExecutionItems(items, cliArgs.filter, cliArgs.regex)
      items = result.matchingItems

      if (cliArgs.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      console.log(
        `Found ${result.matchCount} of ${result.totalItems} execution items matching "${cliArgs.filter}":`
      )
      console.log("")
      for (const item of items) {
        const statusIcon = getStatusIcon(item.status)
        console.log(`  ${statusIcon} [${item.id}] ${item.name}`)
      }
      return
    }

    // Status filter only
    if (cliArgs.json) {
      console.log(JSON.stringify({ items, count: items.length }, null, 2))
      return
    }

    console.log(`Found ${items.length} execution items with status: ${cliArgs.filterStatus}`)
    console.log("")
    for (const item of items) {
      const statusIcon = getStatusIcon(item.status)
      console.log(`  ${statusIcon} [${item.id}] ${item.name}`)
    }
    return
  }

  // Default: show metrics
  const metrics = evaluateStream(repoRoot, stream.id)

  if (cliArgs.json) {
    console.log(JSON.stringify(metrics, null, 2))
    return
  }

  console.log(formatMetricsOutput(metrics, { compact: cliArgs.compact }))
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

  if (index.streams.length === 0) {
    console.log("No workstreams found.")
    return
  }

  // Resolve stream ID first (needed for stage reports too)
  const resolvedStreamId = resolveStreamId(index, cliArgs.streamId)

  // Handle subcommands: init, validate, metrics
  if (cliArgs.subcommand === "init") {
    if (!resolvedStreamId) {
      console.error(
        "Error: No workstream specified. Use --stream or set current with 'work current --set'",
      )
      process.exit(1)
    }
    handleInit(repoRoot, resolvedStreamId)
    return
  }

  if (cliArgs.subcommand === "validate") {
    if (!resolvedStreamId) {
      console.error(
        "Error: No workstream specified. Use --stream or set current with 'work current --set'",
      )
      process.exit(1)
    }
    handleValidate(repoRoot, resolvedStreamId)
    return
  }

  if (cliArgs.subcommand === "metrics") {
    handleMetrics(repoRoot, cliArgs)
    return
  }

  // Handle --stage flag: generate stage-specific report
  if (cliArgs.stage) {
    if (!resolvedStreamId) {
      console.error(
        "Error: No workstream specified. Use --stream or set current with 'work current --set'",
      )
      process.exit(1)
    }

    const stream = findStream(index, resolvedStreamId)
    if (!stream) {
      console.error(`Error: Workstream "${resolvedStreamId}" not found`)
      process.exit(1)
    }

    try {
      // Parse stage reference (number or name)
      const stageRef = /^\d+$/.test(cliArgs.stage)
        ? parseInt(cliArgs.stage, 10)
        : cliArgs.stage

      const report = generateStageReport(repoRoot, stream.id, stageRef)

      if (cliArgs.json) {
        const output = JSON.stringify(report, null, 2)
        if (cliArgs.output) {
          writeFileSync(cliArgs.output, output)
          console.log(`Stage report written to ${cliArgs.output}`)
        } else {
          console.log(output)
        }
        return
      }

      // Save to reports directory if --save flag is set
      if (cliArgs.save) {
        const savedPath = saveStageReport(repoRoot, stream.id, report)
        console.log(`Stage report saved to ${savedPath}`)
        return
      }

      const output = formatStageReportMarkdown(report)

      if (cliArgs.output) {
        writeFileSync(cliArgs.output, output)
        console.log(`Stage report written to ${cliArgs.output}`)
      } else {
        console.log(output)
      }
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`)
      process.exit(1)
    }
    return
  }

  // Handle --all flag
  if (cliArgs.all) {
    const reports = index.streams.map((stream) => generateReport(repoRoot, stream.id))

    if (cliArgs.json) {
      const output = JSON.stringify(reports, null, 2)
      if (cliArgs.output) {
        writeFileSync(cliArgs.output, output)
        console.log(`Report written to ${cliArgs.output}`)
      } else {
        console.log(output)
      }
      return
    }

    const markdowns = reports.map((r) => formatReportMarkdown(r))
    const output = markdowns.join("\n\n---\n\n")

    if (cliArgs.output) {
      writeFileSync(cliArgs.output, output)
      console.log(`Report written to ${cliArgs.output}`)
    } else {
      console.log(output)
    }
    return
  }

  // Single workstream report
  if (!resolvedStreamId) {
    console.error(
      "Error: No workstream specified. Use --stream or set current with 'work current --set'",
    )
    process.exit(1)
  }

  const stream = findStream(index, resolvedStreamId)
  if (!stream) {
    console.error(`Error: Workstream "${resolvedStreamId}" not found`)
    process.exit(1)
  }

  const report = generateReport(repoRoot, stream.id)

  if (cliArgs.json) {
    const output = JSON.stringify(report, null, 2)
    if (cliArgs.output) {
      writeFileSync(cliArgs.output, output)
      console.log(`Report written to ${cliArgs.output}`)
    } else {
      console.log(output)
    }
    return
  }

  const output = formatReportMarkdown(report)

  if (cliArgs.output) {
    writeFileSync(cliArgs.output, output)
    console.log(`Report written to ${cliArgs.output}`)
  } else {
    console.log(output)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
