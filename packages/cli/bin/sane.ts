#!/usr/bin/env bun
/**
 * sane - Sane CLI
 *
 * Root command for all Sane tools.
 *
 * Subcommands:
 *   work       - Workstream management (create, status, update, complete, index)
 *   install    - Installation management (skills)
 */

import { main as workMain } from "../../workstreams/bin/work.ts"
import { main as installMain } from "../src/commands/install.ts"
import { VERSION } from "../src/version.ts"

interface SubcommandModule {
  main: (argv: string[]) => void | Promise<void>
}

const SUBCOMMANDS: Record<string, SubcommandModule> = {
  work: { main: workMain },
  install: { main: installMain },
}

function printHelp(): void {
  console.log(`
sane - Sane CLI

Usage:
  sane <command> [subcommand] [options]

Commands:
  work       Workstream management (create, status, update, complete, index)
  install    Installation management (skills)

Options:
  --help, -h      Show this help message
  --version, -v   Show version

Examples:
  sane work create --name my-feature
  sane work status
  sane install skills --claude
  sane install skills --all

Run 'sane <command> --help' for more information on a command.
`)
}

function printVersion(): void {
  console.log(`sane v${VERSION}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0) {
    printHelp()
    process.exit(0)
  }

  const command = args[0]!

  // Handle global flags
  if (command === "--help" || command === "-h") {
    printHelp()
    process.exit(0)
  }

  if (command === "--version" || command === "-v") {
    printVersion()
    process.exit(0)
  }

  // Check if it's a valid subcommand
  if (!(command in SUBCOMMANDS)) {
    console.error(`Error: Unknown command "${command}"`)
    console.error(
      "\nAvailable commands: " + Object.keys(SUBCOMMANDS).join(", "),
    )
    console.error("\nRun 'sane --help' for usage information.")
    process.exit(1)
  }

  // Call the subcommand
  // We pass [bun, sane-subcommand, ...rest] to match expected argv format
  // For work commands, inject the cli version for tracking
  let subcommandArgs = ["bun", `sane-${command}`, ...args.slice(1)]
  if (command === "work") {
    // Inject cli version for work create command
    subcommandArgs = [...subcommandArgs, "--cli-version", VERSION]
  }

  await SUBCOMMANDS[command]!.main(subcommandArgs)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
