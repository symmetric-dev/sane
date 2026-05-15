/**
 * CLI: Workstream Export
 *
 * Export workstream data in various formats.
 */

import { writeFileSync } from "fs"
import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, resolveStreamId, findStream } from "../lib/index.ts"
import { exportStream } from "../lib/document.ts"
import type { ExportFormat } from "../lib/types.ts"

interface ExportCliArgs {
  repoRoot?: string
  streamId?: string
  format?: ExportFormat
  output?: string
}

function printHelp(): void {
  console.log(`
work export - Export workstream data

Usage:
  work export --format <format> [options]

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Specific workstream ID or name (uses current if set)
  --format, -f     Export format: md, csv, json (required)
  --output, -o     Output file path (prints to stdout if omitted)
  --help, -h       Show this help message

Formats:
  md    Markdown summary with execution checklist
  csv   CSV spreadsheet format
  json  Full JSON export with metadata

Examples:
  # Export as markdown
  work export --format md

  # Export as CSV
  work export --format csv --output tasks.csv

  # Export as JSON
  work export --format json

  # Specific workstream
  work export --stream "001-my-stream" --format md
`)
}

function parseCliArgs(argv: string[]): ExportCliArgs | null {
  const args = argv.slice(2)
  const parsed: ExportCliArgs = {}

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

      case "--format":
      case "-f":
        if (!next) {
          console.error("Error: --format requires a value")
          return null
        }
        if (!["md", "csv", "json"].includes(next)) {
          console.error(`Error: Invalid format "${next}". Use md, csv, or json`)
          return null
        }
        parsed.format = next as ExportFormat
        i++
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

  if (!cliArgs.format) {
    console.error("Error: --format is required")
    console.error("Run with --help for usage information.")
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

  // Resolve workstream
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

  const output = exportStream(repoRoot, stream.id, cliArgs.format)

  if (cliArgs.output) {
    writeFileSync(cliArgs.output, output)
    console.log(`Exported to ${cliArgs.output}`)
  } else {
    console.log(output)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
