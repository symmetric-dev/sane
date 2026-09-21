#!/usr/bin/env bun

import { runCli as runCreateRepositoryWorkstream } from "../packages/sane-cli/src/create-sane-repository-workstream.ts"
import { runCli as runInitializeRepository } from "../packages/sane-cli/src/init-sane-repository.ts"
import { runCli as runInstallAgentContextPackages } from "../packages/sane-cli/src/install-sane-agent-context-packages.ts"
import { runCli as runSaneApprove } from "../packages/sane-cli/src/sane-approve-command.ts"
import { runCli as runSaneProvide } from "../packages/sane-cli/src/sane-provide-command.ts"
import { runCli as runSaneResearch } from "../packages/sane-cli/src/sane-research-command.ts"
import { runCli as runSaneHandoff } from "../packages/sane-cli/src/sane-handoff-command.ts"
import { runCli as runSaneLink } from "../packages/sane-cli/src/sane-link-command.ts"
import { runCli as runSaneSessions } from "../packages/sane-cli/src/sane-sessions-command.ts"
import { runCli as runSaneJob } from "../packages/sane-cli/src/sane-job-command.ts"
import { runCli as runSaneValidate } from "../packages/sane-cli/src/sane-validate-command.ts"
import { runCli as runSaneView } from "../packages/sane-cli/src/sane-view-command.ts"
import { runCli as runSaneStatus } from "../packages/sane-cli/src/sane-status-command.ts"
import { runCli as runSelectWorkstream } from "../packages/sane-cli/src/select-sane-workstream.ts"

export type AlphaCommand =
  | "init"
  | "create"
  | "select"
  | "install"
  | "view"
  | "status"
  | "validate"
  | "approve"
  | "provide"
  | "job"
  | "research"
  | "handoff"
  | "link"
  | "sessions"

export type AlphaCommandHandler = (args: string[]) => Promise<number>

async function runInstall(args: string[]): Promise<number> {
  const [target, ...rest] = args
  if (target === "context-packages") {
    return runInstallAgentContextPackages(rest)
  }
  console.error(`Error: Unknown install target ${JSON.stringify(target ?? "")}.`)
  console.error("Usage: sane install context-packages [--dry-run] [--overwrite] [--model-config <path>]")
  return 1
}

export const COMMANDS: Record<AlphaCommand, AlphaCommandHandler> = {
  init: runInitializeRepository,
  create: runCreateRepositoryWorkstream,
  select: runSelectWorkstream,
  install: runInstall,
  view: runSaneView,
  status: runSaneStatus,
  validate: runSaneValidate,
  approve: runSaneApprove,
  provide: runSaneProvide,
  job: runSaneJob,
  research: runSaneResearch,
  handoff: runSaneHandoff,
  link: runSaneLink,
  sessions: runSaneSessions,
}

export const USAGE = `Usage: sane <command> [arguments...]

Commands:
  init [--dry-run]
  create --name <name> --type <feature|foundation|issue|maintenance> [--dry-run]
  select --name <name> [--dry-run]
  install context-packages [--dry-run] [--overwrite] [--model-config <path>]
  view
  status
  validate <design|engineering|planning|execution>
  approve <design|engineering|planning|execution> --ref <approval_ref>
  provide <design|engineering|planning|execution>
  job <job-id> [running|completed]
  job --register [--json] (register additions under existing Planning approval)
  research
  handoff
  link
  sessions

Run 'sane <command> --help' for a command's argument validation.`
// QUARANTINED FOR PILOT (not wired): `worktree`, `merge`. SANE-managed
// worktrees are disabled; worktrees are OpenCode-native (user selects/creates
// them in the client). See docs/SANE_0_2_0.md Section 4.
// REMOVED: `pickup` (absorbed by `validate`), `artifact` (replaced by
// `provide`). `init-sane`/`create-workstream`/`select-workstream`/
// `install-context-packages` were renamed to `init`/`create`/`select`/
// `install context-packages` with no aliases.

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
    console.error(`Error: Unknown SANE command "${command}".`)
    if (command === "worktree" || command === "merge") {
      console.error(
        "SANE-managed worktrees are quarantined for the pilot: create/select the worktree in the OpenCode client instead.",
      )
    }
    console.error(USAGE)
    return 1
  }
  return commands[command as AlphaCommand](commandArgs)
}

if (import.meta.main) {
  process.exitCode = await runSaneAlpha(Bun.argv.slice(2))
}
