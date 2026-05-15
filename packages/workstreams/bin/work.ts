#!/usr/bin/env bun
/**
 * work - Unified CLI for workstream management
 *
 * Subcommands:
 *   create      - Create a draft workstream container
 *   status      - Show workstream progress
 *   update      - Update a thread status
 *   complete    - Mark a workstream as complete
 *   index       - Update workstream metadata fields
 *   read        - Read thread details
 *   list        - List threads in a workstream
 *   delete      - Delete workstreams, stages, batches, or threads
 *   review      - Review plan or commits
 *   validate    - Validate plan/requirements
 *   check       - Find unchecked items in plan
 *   preview     - Show PLAN.md structure
 *   init        - Initialize work/ directory with default config files
 */

import { main as createMain } from "../src/cli/create.ts"
import { main as statusMain } from "../src/cli/status.ts"
import { main as updateMain } from "../src/cli/update.ts"
import { main as completeMain } from "../src/cli/complete.ts"
import { main as updateIndexMain } from "../src/cli/update-index.ts"
import { main as readMain } from "../src/cli/read.ts"
import { main as listMain } from "../src/cli/list.ts"
import { main as addBatchMain } from "../src/cli/add-batch.ts"
import { main as addThreadMain } from "../src/cli/add-thread.ts"
import { main as reviewMain } from "../src/cli/review.ts"
import { main as validateMain } from "../src/cli/validate.ts"
import { main as checkMain } from "../src/cli/check.ts"
import { main as previewMain } from "../src/cli/preview.ts"
import { main as deleteMain } from "../src/cli/delete.ts"
import { main as filesMain } from "../src/cli/files.ts"
import { main as currentMain } from "../src/cli/current.ts"
import { main as setStatusMain } from "../src/cli/set-status.ts"
import { main as reportMain } from "../src/cli/report.ts"
import { main as changelogMain } from "../src/cli/changelog.ts"
import { main as exportMain } from "../src/cli/export.ts"
import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as continueMain } from "../src/cli/continue.ts"
import { main as addStageMain } from "../src/cli/add-stage.ts"
import { main as agentsMain } from "../src/cli/agents.ts"
import { main as assignMain } from "../src/cli/assign.ts"
import { main as promptMain } from "../src/cli/prompt.ts"
import { main as editMain } from "../src/cli/edit.ts"
import { main as initMain } from "../src/cli/init.ts"
import { main as executeMain } from "../src/cli/execute.ts"
import { main as multiMain } from "../src/cli/multi.ts"
import { main as batchStatusMain } from "../src/cli/batch-status.ts"
import { main as multiNavigatorMain } from "../src/cli/multi-navigator.ts"
import { main as multiGridMain } from "../src/cli/multi-grid.ts"
import { main as treeMain } from "../src/cli/tree.ts"
import { main as githubMain } from "../src/cli/github.ts"
import { main as startMain } from "../src/cli/start.ts"
import { main as sessionMain } from "../src/cli/session.ts"
import { main as revisionMain } from "../src/cli/revision.ts"
import { main as notificationsMain } from "../src/cli/notifications.ts"
import { main as planMain } from "../src/cli/plan.ts"
import { main as superviseMain } from "../src/cli/supervise.ts"
import { main as resetBatchStateMain } from "../src/cli/reset-batch-state.ts"

// Role and help utilities
import {
  canExecuteCommand,
  getRoleDenialMessage,
  getCurrentRole,
} from "../src/lib/roles.ts"
import {
  filterCommandsForRole,
  getRoleFooter,
  isUserOnlyCommand,
} from "../src/lib/help.ts"

const SUBCOMMANDS = {
  init: initMain,
  create: createMain,
  current: currentMain,
  continue: continueMain,
  "add-stage": addStageMain,
  revision: revisionMain,
  approve: approveMain,
  start: startMain,
  plan: planMain,
  supervise: superviseMain,
  "reset-batch-state": resetBatchStateMain,
  status: statusMain,
  "set-status": setStatusMain,
  update: updateMain,
  complete: completeMain,
  index: updateIndexMain,
  read: readMain,
  list: listMain,
  "add-batch": addBatchMain,
  "add-thread": addThreadMain,
  edit: editMain,
  review: reviewMain,
  validate: validateMain,
  check: checkMain,
  preview: previewMain,
  delete: deleteMain,
  files: filesMain,
  report: reportMain,
  changelog: changelogMain,
  export: exportMain,
  agents: agentsMain,
  assign: assignMain,
  prompt: promptMain,
  execute: executeMain,
  multi: multiMain,
  "batch-status": batchStatusMain,
  "multi-navigator": multiNavigatorMain,
  "multi-grid": multiGridMain,
  tree: treeMain,
  github: githubMain,
  session: sessionMain,
  notifications: notificationsMain,
} as const

type Subcommand = keyof typeof SUBCOMMANDS

/** Command descriptions for help output */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  init: "Initialize work/ directory with default config files",
  create: "Create a draft workstream container and initial files",
  current: "Get or set the current workstream",
  continue: "Continue execution (alias for 'work multi --continue')",
  "add-stage": "Append a fix stage to a workstream",
  approve: "Approve workstream plans and revisions [plan seeds execution hierarchy]",
  start: "Start execution (requires all approvals, creates GitHub branch/issues)",
  plan: "Manage planning sessions or scaffold a plan (subcommand: create)",
  supervise: "Run batch-bounded supervision execution/recovery helper",
  "reset-batch-state": "Reset one batch for a clean rerun",
  agents: "Manage agent definitions (list, add, remove)",
  assign: "Assign agents to threads for batch execution",
  prompt: "Generate thread execution prompt for agents",
  execute: "Execute a thread prompt via opencode",
  multi: "Execute all threads in a batch in parallel via tmux",
  "batch-status": "Show persisted batch execution status for supervisors",
  status: "Show workstream progress",
  "set-status": "Set workstream status (pending, in_progress, completed, on_hold)",
  update: "Update a thread status",
  complete: "Mark a workstream as complete",
  index: "Update workstream metadata fields",
  read: "Read thread details",
  list: "List threads in a workstream [default]",
  "add-batch": "Add a batch to a stage",
  "add-thread": "Add a thread to a batch",
  edit: "Open PLAN.md in editor",
  delete: "Delete workstreams, stages, batches, or threads",
  files: "List and index files in files/ directory",
  review: "Review plan or commits (plan, commits)",
  validate: "Validate plan or requirements",
  check: "Find unchecked items in plan",
  preview: "Show PLAN.md structure",
  report: "Generate progress report (includes metrics)",
  changelog: "Generate changelog from completed threads",
  export: "Export workstream data (md, csv, json)",
  tree: "Show workstream structure tree",
  github: "Manage GitHub integration (enable, create-branch, etc.)",
  session: "Manage agent sessions (complete stale sessions)",
  revision: "Manage workstream revisions",
  "multi-navigator": "Multi-session navigator mode",
  "multi-grid": "Multi-session grid layout",
  notifications: "Show notification configuration",
}

function printHelp(showAllCommands: boolean = false): void {
  const allCommands = Object.keys(SUBCOMMANDS)
  const availableCommands = showAllCommands
    ? allCommands
    : filterCommandsForRole(allCommands)
  const commandWidth = Math.max(...availableCommands.map((cmd) => cmd.length), 0) + 2

  // Build command list with role indicators
  const commandLines = availableCommands.map((cmd) => {
    const description = COMMAND_DESCRIPTIONS[cmd] || ""
    const roleIndicator = isUserOnlyCommand(cmd) ? " [USER]" : ""
    // Format: "  cmd          description [USER]" with proper padding
    const paddedCmd = cmd.padEnd(commandWidth)
    return `  ${paddedCmd}${description}${roleIndicator}`
  })

  console.log(`
work - Workstream management CLI

Usage:
  work <command> [options]

Commands:
${commandLines.join("\n")}

Options:
  --help, -h           Show this help message
  --version, -v        Show version
  --show-all-commands  Show all commands regardless of role restrictions

Current Workstream:
  Set a current workstream to use as default for all commands:
    work current --set "001-my-feature"

  Then run commands without --stream:
    work status
    work list
    work update --thread "01.01.01" --status completed

Examples:
  work create --name my-feature
  work current --set "001-my-feature"
  work plan create --stages 2
  work validate requirements
  work validate plan
  work status
  work list
  work update --thread "01.01.01" --status completed
  work files --save
  work report metrics --blockers
  work report --output report.md
  work export --format csv

Run 'work <command> --help' for more information on a command.

${getRoleFooter()}${showAllCommands ? " (showing all commands)" : ""}
`)
}

import { VERSION } from "../src/version.ts"

function printVersion(): void {
  console.log(`work v${VERSION}`)
}

export function main(argv?: string[]): void {
  const args = argv ? argv.slice(2) : process.argv.slice(2)

  // Check for --show-all-commands flag
  const showAllCommands = args.includes("--show-all-commands")
  const filteredArgs = args.filter((arg) => arg !== "--show-all-commands")

  if (filteredArgs.length === 0) {
    printHelp(showAllCommands)
    process.exit(0)
  }

  const firstArg = filteredArgs[0]!

  // Handle global flags
  if (firstArg === "--help" || firstArg === "-h") {
    printHelp(showAllCommands)
    process.exit(0)
  }

  if (firstArg === "--version" || firstArg === "-v") {
    printVersion()
    process.exit(0)
  }

  // Handle multi-word command aliases (e.g., "add stage" -> "add-stage")
  let subcommand: string = firstArg
  let remainingArgs = filteredArgs.slice(1)
  
  if (firstArg === "add" && filteredArgs[1] === "stage") {
    subcommand = "add-stage"
    remainingArgs = filteredArgs.slice(2)
  }

  // Check if it's a valid subcommand
  if (!(subcommand in SUBCOMMANDS)) {
    console.error(`Error: Unknown command "${firstArg}"`)
    console.error(
      "\nAvailable commands: " + Object.keys(SUBCOMMANDS).join(", "),
    )
    console.error("\nRun 'work --help' for usage information.")
    process.exit(1)
  }

  // Check role permissions before dispatching
  if (!canExecuteCommand(subcommand)) {
    console.error(getRoleDenialMessage(subcommand))
    process.exit(1)
  }

  // Call the subcommand with adjusted argv
  // We pass [node, work-subcommand, ...rest] to match expected argv format
  const subcommandTyped = subcommand as Subcommand
  const subcommandArgs = ["bun", `work-${subcommand}`, ...remainingArgs]

  SUBCOMMANDS[subcommandTyped](subcommandArgs)
}

// Run if called directly
if (import.meta.main) {
  main()
}
