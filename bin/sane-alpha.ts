#!/usr/bin/env bun

import { runCli as runCreateRepositoryWorkstream } from "../packages/sane-cli/src/create-sane-repository-workstream.ts"
import { runCli as runInitializeRepository } from "../packages/sane-cli/src/init-sane-repository.ts"
import { runCli as runInstallAgentContextPackages } from "../packages/sane-cli/src/install-sane-agent-context-packages.ts"
import { runCli as runSaneApprove } from "../packages/sane-cli/src/sane-approve-command.ts"
import { runCli as runSaneArtifact } from "../packages/sane-cli/src/sane-artifact-command.ts"
import { runCli as runSaneBaseline } from "../packages/sane-cli/src/sane-baseline-command.ts"
import { runCli as runSaneHandoff } from "../packages/sane-cli/src/sane-handoff-command.ts"
import { runCli as runSaneMerge } from "../packages/sane-cli/src/sane-merge-command.ts"
import { runCli as runSanePickup } from "../packages/sane-cli/src/sane-pickup-command.ts"
import { runCli as runSaneState } from "../packages/sane-cli/src/sane-state-command.ts"
import { runCli as runSaneStatus } from "../packages/sane-cli/src/sane-status-command.ts"
import { runCli as runSaneWorktree } from "../packages/sane-cli/src/sane-worktree-command.ts"
import { runCli as runSelectWorkstream } from "../packages/sane-cli/src/select-sane-workstream.ts"

export type AlphaCommand =
  | "init-sane"
  | "create-workstream"
  | "select-workstream"
  | "install-context-packages"
  | "state"
  | "status"
  | "pickup"
  | "artifact"
  | "approve"
  | "baseline"
  | "handoff"
  | "worktree"
  | "merge"

export type AlphaCommandHandler = (args: string[]) => Promise<number>

export const COMMANDS: Record<AlphaCommand, AlphaCommandHandler> = {
  "init-sane": runInitializeRepository,
  "create-workstream": runCreateRepositoryWorkstream,
  "select-workstream": runSelectWorkstream,
  "install-context-packages": runInstallAgentContextPackages,
  state: runSaneState,
  status: runSaneStatus,
  pickup: runSanePickup,
  artifact: runSaneArtifact,
  approve: runSaneApprove,
  baseline: runSaneBaseline,
  handoff: runSaneHandoff,
  worktree: runSaneWorktree,
  merge: runSaneMerge,
}

export const USAGE = `Usage: sane-alpha <command> [arguments...]

Commands:
  init-sane
  create-workstream
  select-workstream
  install-context-packages [--dry-run] [--overwrite] [--model-config <path>]
  state
  status
  pickup
  artifact
  approve
  baseline
  handoff
  worktree
  merge

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
