#!/usr/bin/env bun
/**
 * work - Unified CLI for workstream management
 *
 * Subcommands:
 *   create      - Create a draft workstream container
 *   status      - Show workstream progress
 *   update      - Update a task's status
 *   complete    - Mark a workstream as complete
 *   index       - Update workstream metadata fields
 *   read        - Read task details
 *   list        - List tasks in a workstream
 *   add-task    - Add a task to a workstream
 *   delete      - Delete workstreams, stages, threads, or tasks
 *   review      - Review plan or tasks
 *   validate    - Validate PLAN.md structure
 *   check       - Find unchecked items in plan
 *   preview     - Show PLAN.md structure
 *   init        - Initialize work/ directory with default config files
 */

import { main as createMain } from "../src/cli/create.ts"
import { main as statusMain } from "../src/cli/status.ts"
import { main as updateTaskMain } from "../src/cli/update-task.ts"
import { main as completeMain } from "../src/cli/complete.ts"
import { main as updateIndexMain } from "../src/cli/update-index.ts"
import { main as readMain } from "../src/cli/read.ts"
import { main as listMain } from "../src/cli/list.ts"
import { main as addTaskMain } from "../src/cli/add-task.ts"
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
import { main as contextMain } from "../src/cli/context.ts"
import { main as addStageMain } from "../src/cli/add-stage.ts"
import { main as tasksMain } from "../src/cli/tasks.ts"
import { main as agentsMain } from "../src/cli/agents.ts"
import { main as assignMain } from "../src/cli/assign.ts"
import { main as promptMain } from "../src/cli/prompt.ts"
import { main as editMain } from "../src/cli/edit.ts"
import { main as initMain } from "../src/cli/init.ts"
import { main as executeMain } from "../src/cli/execute.ts"
import { main as multiMain } from "../src/cli/multi.ts"
import { main as multiNavigatorMain } from "../src/cli/multi-navigator.ts"
import { main as multiGridMain } from "../src/cli/multi-grid.ts"
import { main as treeMain } from "../src/cli/tree.ts"
import { main as githubMain } from "../src/cli/github.ts"
import { main as startMain } from "../src/cli/start.ts"
import { main as sessionMain } from "../src/cli/session.ts"
import { main as revisionMain } from "../src/cli/revision.ts"
import { main as notificationsMain } from "../src/cli/notifications.ts"
import { main as synthesisMain } from "../src/cli/synthesis.ts"
import { main as planMain } from "../src/cli/plan.ts"

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
  context: contextMain,
  "add-stage": addStageMain,
  revision: revisionMain,
  approve: approveMain,
  start: startMain,
  plan: planMain,
  status: statusMain,
  "set-status": setStatusMain,
  update: updateTaskMain,
  complete: completeMain,
  index: updateIndexMain,
  read: readMain,
  list: listMain,
  "add-task": addTaskMain,
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
  tasks: tasksMain,
  agents: agentsMain,
  assign: assignMain,
  prompt: promptMain,
  execute: executeMain,
  multi: multiMain,
  "multi-navigator": multiNavigatorMain,
  "multi-grid": multiGridMain,
  tree: treeMain,
  github: githubMain,
  session: sessionMain,
  notifications: notificationsMain,
  synthesis: synthesisMain,
} as const

type Subcommand = keyof typeof SUBCOMMANDS

/** Command descriptions for help output */
const COMMAND_DESCRIPTIONS: Record<string, string> = {
  init: "Initialize work/ directory with default config files",
  create: "Create a draft workstream container",
  current: "Get or set the current workstream",
  continue: "Continue execution (alias for 'work multi --continue')",
  context: "Show workstream context and resume information",
  "add-stage": "Append a fix stage to a workstream",
  approve: "Approve workstream plan/tasks/prompts (subcommands: plan, tasks, prompts)",
  start: "Start execution (requires all approvals, creates GitHub branch/issues)",
  plan: "Manage planning sessions or scaffold a plan (subcommand: create)",
  agents: "Manage agent definitions (list, add, remove)",
  assign: "Assign agents to threads for batch execution",
  prompt: "Generate thread execution prompt for agents",
  execute: "Execute a thread prompt via opencode",
  multi: "Execute all threads in a batch in parallel via tmux",
  status: "Show workstream progress",
  "set-status": "Set workstream status (pending, in_progress, completed, on_hold)",
  update: "Update a task's status",
  complete: "Mark a workstream as complete",
  index: "Update workstream metadata fields",
  read: "Read task details",
  list: "List tasks in a workstream",
  "add-task": "Add a task to a workstream (interactive if no flags)",
  "add-batch": "Add a batch to a stage",
  "add-thread": "Add a thread to a batch",
  edit: "Open PLAN.md in editor",
  delete: "Delete workstreams, stages, threads, or tasks",
  files: "List and index files in files/ directory",
  tasks: "Manage TASKS.md intermediate file (generate/serialize)",
  review: "Review plan, tasks, or commits (plan, tasks, commits)",
  validate: "Validate plan structure and content",
  check: "Find unchecked items in plan",
  preview: "Show PLAN.md structure",
  report: "Generate progress report (includes metrics)",
  changelog: "Generate changelog from completed tasks",
  export: "Export workstream data (md, csv, json)",
  tree: "Show workstream structure tree",
  github: "Manage GitHub integration (enable, create-branch, etc.)",
  session: "Manage agent sessions (complete stale sessions)",
  revision: "Manage workstream revisions",
  "multi-navigator": "Multi-session navigator mode",
  "multi-grid": "Multi-session grid layout",
  notifications: "Show notification configuration",
  synthesis: "Show synthesis configuration",
}

function printHelp(showAllCommands: boolean = false): void {
  const allCommands = Object.keys(SUBCOMMANDS)
  const availableCommands = showAllCommands
    ? allCommands
    : filterCommandsForRole(allCommands)

  // Build command list with role indicators
  const commandLines = availableCommands.map((cmd) => {
    const description = COMMAND_DESCRIPTIONS[cmd] || ""
    const roleIndicator = isUserOnlyCommand(cmd) ? " [USER]" : ""
    // Format: "  cmd          description [USER]" with proper padding
    const paddedCmd = cmd.padEnd(16)
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
    work list --tasks
    work update --task "01.01.01.01" --status completed

Examples:
  work create --name my-feature
  work current --set "001-my-feature"
  work plan create --stages 2
  work validate plan
  work status
  work list --tasks
  work update --task "01.01.01.01" --status completed
  work add-task --stage 01 --batch 01 --thread 01 --name "Task description"
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
