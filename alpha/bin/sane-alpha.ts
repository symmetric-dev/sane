#!/usr/bin/env bun

import { runCli as runCreateRepositoryWorkstream } from "../scripts/create-sane-repository-workstream.ts"
import { runCli as runInitializeRepository } from "../scripts/init-sane-repository.ts"
import { runCli as runInstallAgentContextPackages } from "../scripts/install-sane-agent-context-packages.ts"
import { runCli as runPrintSanePath } from "../scripts/print-sane-path.ts"
import { runCli as runSelectWorkstream } from "../scripts/select-sane-workstream.ts"

export type AlphaCommand =
  | "init-sane"
  | "create-workstream"
  | "select-workstream"
  | "install-context-packages"
  | "sane-path"

export type AlphaCommandHandler = (args: string[]) => Promise<number>

export const COMMANDS: Record<AlphaCommand, AlphaCommandHandler> = {
  "init-sane": runInitializeRepository,
  "create-workstream": runCreateRepositoryWorkstream,
  "select-workstream": runSelectWorkstream,
  "install-context-packages": runInstallAgentContextPackages,
  "sane-path": runPrintSanePath,
}

export const USAGE = `Usage: sane-alpha <command> [arguments...]

Commands:
  init-sane
  create-workstream
  select-workstream
  install-context-packages
  sane-path                      Print the paired SANE workstream repository path

Run 'sane-alpha <command> --help' for a command's argument validation.`

function printUsage(): void {
  console.log(USAGE)
}

/** Dispatch an Alpha utility without altering its argument vector or exit code. */
export async function runSaneAlpha(
  args: string[],
  commands: Record<AlphaCommand, AlphaCommandHandler> = COMMANDS,
): Promise<number> {
  const [command, ...commandArgs] = args
  if (!command || command === "--help" || command === "-h" || command === "help") {
    printUsage()
    return 0
  }
  if (!(command in commands)) {
    console.error(`Error: Unknown SANE Alpha command "${command}".`)
    console.error(USAGE)
    return 1
  }
  return commands[command as AlphaCommand](commandArgs)
}

if (import.meta.main) {
  process.exitCode = await runSaneAlpha(Bun.argv.slice(2))
}
