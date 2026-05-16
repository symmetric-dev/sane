/**
 * CLI: Approve Workstream Gates
 *
 * Approve or revoke workstream approvals for plan or revisions.
 * Plan approval also initializes the execution hierarchy needed by downstream commands.
 */

import { getRepoRoot } from "../../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../../lib/index.ts"
import { queryApprovalStatus } from "../../lib/approval.ts"
import { canExecuteCommand, getRoleDenialMessage } from "../../lib/roles.ts"

import type { ApproveTarget, ApproveCliArgs } from "./utils.ts"
import { formatApprovalIcon } from "./utils.ts"
import { handlePlanApproval } from "./plan.ts"
import { handleRevisionApproval } from "./revision.ts"

function printHelp(): void {
  console.log(`
work approve - Human-in-the-loop approval gates for workstreams

Requires: USER role

Usage:
  work approve plan [--stream <id>] [--force]
  work approve revision [--stream <id>]
  work approve [--stream <id>]  # Show plan approval status

Targets:
  plan      Approve the staged planning structure (requires stages; blocks on open questions)
  revision  Approve revised staged planning structure with new stages (refreshes execution hierarchy)

Options:
  --repo-root, -r  Repository root (auto-detected if omitted)
  --stream, -s     Workstream ID or name (uses current if not specified)
  --stage, -st     Stage number to approve/revoke (only for plan approval)
  --revoke         Revoke existing approval
  --reason         Reason for revoking approval
  --force, -f      Approve even with validation warnings

  --json, -j       Output as JSON
  --help, -h       Show this help message

Description:
  Workstreams require plan approval before starting.
  Plan approval validates the staged planning structure from stage-local
  stages/*/PLAN.md (or a legacy root PLAN.md when present), requires at least
  one stage, and blocks on
  open questions unless --force is used.

  Run 'work start' after approval to create the GitHub branch and issues.

  Plan approval also initializes the execution hierarchy directly from the plan structure.

  Draft plans created with 'work create' must be scaffolded with
  'work plan create --stages <n>' before plan approval can succeed.

  Note: This command requires USER role to maintain human-in-the-loop control.
  Set WORKSTREAM_ROLE=USER environment variable to enable approval commands.

Examples:
  # Show approval status
  work approve

  # Approve plan
  work approve plan

  # Revoke plan approval
  work approve plan --revoke --reason "Need to revise stage 2"

  # Approve specific stage
  work approve stage 1
`)
}

function parseCliArgs(argv: string[]): ApproveCliArgs | null {
  const rawArgs = argv.slice(2)
  const args = rawArgs[0] === "approve" ? rawArgs.slice(1) : rawArgs
  const parsed: ApproveCliArgs = { revoke: false, force: false, json: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    // Check for target subcommand
    if (arg === "plan" || arg === "revision") {
      parsed.target = arg as ApproveTarget
      continue
    }

    if (arg === "stage") {
      parsed.target = "plan"
      if (!next) {
        console.error("Error: stage requires a stage number")
        return null
      }
      parsed.stage = parseInt(next, 10)
      if (isNaN(parsed.stage)) {
        console.error("Error: stage must be a number")
        return null
      }
      i++
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
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value")
          return null
        }
        parsed.streamId = next
        i++
        break

      case "--revoke":
        parsed.revoke = true
        break

      case "--reason":
        if (!next) {
          console.error("Error: --reason requires a value")
          return null
        }
        parsed.reason = next
        i++
        break

      case "--force":
      case "-f":
        parsed.force = true
        break

      case "--json":
      case "-j":
        parsed.json = true
        break

      case "--stage":
      case "-st":
        if (!next) {
          console.error("Error: --stage requires a value")
          return null
        }
        parsed.stage = parseInt(next, 10)
        if (isNaN(parsed.stage)) {
          console.error("Error: --stage must be a number")
          return null
        }
        i++
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)

      default:
        console.error(`Error: Unknown argument: ${arg}`)
        return null
    }
  }

  return parsed
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  // Role-based access check
  if (!canExecuteCommand("approve")) {
    console.error(getRoleDenialMessage("approve"))
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

  // No target specified = show status (unless revoking)
  if (!cliArgs.target) {
    if (cliArgs.revoke) {
      cliArgs.target = "plan"
      // proceed to switch
    } else {
      const planStatus = queryApprovalStatus(repoRoot, stream.id, stream)

      if (cliArgs.json) {
        console.log(
          JSON.stringify(
              {
                streamId: stream.id,
                streamName: stream.name,
                plan: planStatus,
                approved: planStatus === "approved",
              },
            null,
            2
          )
        )
      } else {
        console.log(`Approval Status for "${stream.name}" (${stream.id})\n`)
        console.log(
          `  ${formatApprovalIcon(planStatus)} Plan: ${planStatus}`
        )
        console.log("")
        if (planStatus === "approved") {
          console.log("Plan approved. Run 'work start' to begin.")
        } else {
          console.log("Plan approval pending. Run 'work approve plan' to approve.")
        }
      }
      return
    }
  }

  // Handle specific target
  switch (cliArgs.target) {
    case "plan":
      await handlePlanApproval(repoRoot, stream, cliArgs)
      break
    case "revision":
      handleRevisionApproval(repoRoot, stream, cliArgs)
      break
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
