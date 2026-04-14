/**
 * CLI: Complete Workstream
 *
 * Validates and completes a workstream, preparing it for PR creation.
 * Checks all stages are approved, GitHub is enabled, and we're on the workstream branch.
 * Optionally commits changes, pushes to remote, and creates a PR.
 */

import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { getRepoRoot, getWorkDir } from "../lib/repo.ts"
import { loadIndex, getResolvedStream, saveIndex } from "../lib/index.ts"
import { completeStream } from "../lib/complete.ts"
import { consolidateStream } from "../lib/consolidate.ts"
import { getTasks } from "../lib/tasks.ts"
import { getStageApprovalStatus, isApproved } from "../lib/approval.ts"
import { isGitHubEnabled, loadGitHubConfig } from "../lib/github/config.ts"
import {
  workstreamBranchExists,
  formatBranchName,
  getWorkstreamBranchName,
} from "../lib/github/branches.ts"
import { createGitHubClient } from "../lib/github/client.ts"
import { getGitHubAuth } from "../lib/github/auth.ts"
import type { StreamMetadata } from "../lib/types.ts"
import { canExecuteCommand, getRoleDenialMessage } from "../lib/roles.ts"
import { validateReport } from "../lib/report-template.ts"
import { buildWorkstreamCompletionCommitMessage } from "../lib/git/auto-commit-message.ts"
import {
  executeGitAutoCommit,
  getHeadCommitSha,
} from "../lib/git/auto-commit-executor.ts"

interface CompleteStreamCliArgs {
  repoRoot?: string
  streamId?: string
  commit: boolean
  pr: boolean
  target?: string
  draft: boolean
  json: boolean
  force: boolean
}

function printHelp(): void {
  console.log(`
work complete - Mark a workstream as complete

Requires: USER role

Usage:
  work complete [--stream <id>] [--no-commit] [--no-pr] [--target <branch>] [--draft] [--force]

Options:
  --stream, -s      Workstream ID or name (uses current if not specified)
  --repo-root, -r   Repository root (auto-detected if omitted)
  --commit          Commit and push changes (default: true)
  --no-commit       Skip committing and pushing changes
  --pr              Create a pull request (default: true)
  --no-pr           Skip creating a pull request
  --target, -t      Target branch for PR (default from config or "main")
  --draft           Create PR as draft
  --force, -f       Bypass REPORT.md validation (not recommended)
  --json            Output result as JSON
  --help, -h        Show this help message

REPORT.md Requirement:
  A valid REPORT.md file is required before completing a workstream.
  The report must have:
    - Summary section with content
    - At least one stage accomplishment
  
  If missing or invalid, run 'work report init' to create the template.
  Use --force to bypass validation (completion will succeed with warning).

Git Operations (when --commit is enabled):
  1. Stages all changes with 'git add -A'
  2. Creates commit: "Completed workstream: {name}"
  3. Pushes to origin/{branch-name}
  4. Shows commit SHA

PR Creation (when --pr is enabled):
  1. Creates PR with title: [{stream-id}] {stream-name}
  2. Body includes summary, PLAN.md link, task counts
  3. Stores PR number in stream metadata

Examples:
  # Mark current workstream complete (with commit/push and PR)
  work complete

  # Mark complete without committing
  work complete --no-commit

  # Mark complete without PR
  work complete --no-pr

  # Create PR targeting develop branch
  work complete --target develop

  # Create a draft PR
  work complete --draft

  # Mark specific workstream complete
  work complete --stream "001-my-stream"

  # Bypass REPORT.md validation (not recommended)
  work complete --force
`)
}

function parseCliArgs(argv: string[]): CompleteStreamCliArgs | null {
  const args = argv.slice(2)
  const parsed: CompleteStreamCliArgs = {
    commit: true,
    pr: true,
    draft: false,
    json: false,
    force: false,
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

      case "--commit":
        parsed.commit = true
        break

      case "--no-commit":
        parsed.commit = false
        break

      case "--pr":
        parsed.pr = true
        break

      case "--no-pr":
        parsed.pr = false
        break

      case "--target":
      case "-t":
        if (!next) {
          console.error("Error: --target requires a value")
          return null
        }
        parsed.target = next
        i++
        break

      case "--draft":
        parsed.draft = true
        break

      case "--json":
        parsed.json = true
        break

      case "--force":
      case "-f":
        parsed.force = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed
}

interface GitOperationsResult {
  staged: boolean
  committed: boolean
  pushed: boolean
  commitSha?: string
  alreadyPushed: boolean
  error?: string
}

/**
 * Performs git operations for workstream completion:
 * 1. git add -A (stage all changes)
 * 2. git commit -m "Completed workstream: {name}"
 * 3. git push origin {branch-name}
 *
 * @param repoRoot Repository root path
 * @param streamId Workstream ID
 * @param streamName Workstream name
 * @param summary Optional summary for commit body
 * @returns Result of git operations
 */
function performGitOperations(
  repoRoot: string,
  streamId: string,
  streamName: string,
  summary?: string,
): GitOperationsResult {
  const result: GitOperationsResult = {
    staged: false,
    committed: false,
    pushed: false,
    alreadyPushed: false,
  }

  // Get the branch name
  const branchName = getWorkstreamBranchName(repoRoot, streamId)
  if (!branchName) {
    result.error =
      "No GitHub branch found for this workstream. Run 'work github create-branch' first."
    return result
  }

  try {
    const commitResult = executeGitAutoCommit(
      repoRoot,
      buildWorkstreamCompletionCommitMessage({
        streamId,
        streamName,
        summary,
      })
    )
    result.staged = commitResult.staged

    if (!commitResult.success) {
      result.error = commitResult.error
      return result
    }

    if (commitResult.skipped) {
      // No changes to commit - check if we need to push existing commits
      const unpushed = checkForUnpushedCommits(repoRoot, branchName)
      if (!unpushed) {
        result.alreadyPushed = true
        result.commitSha = getHeadCommitSha(repoRoot)
        return result
      }
      // There are unpushed commits, skip commit but continue to push
    } else {
      result.committed = true
    }

    // Get the commit SHA before pushing
    result.commitSha = commitResult.commitSha ?? getHeadCommitSha(repoRoot)

    // 3. Push to origin
    try {
      execSync(`git push origin ${branchName}`, {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      result.pushed = true
    } catch (pushError) {
      const errorMessage = (pushError as Error).message || String(pushError)
      // Check if the error indicates already up-to-date
      if (errorMessage.includes("Everything up-to-date")) {
        result.alreadyPushed = true
        result.pushed = true
      } else {
        result.error = `Push failed: ${errorMessage}`
      }
    }

    return result
  } catch (error) {
    const errorMessage = (error as Error).message || String(error)
    result.error = errorMessage
    return result
  }
}

/**
 * Check if there are unpushed commits on the current branch
 */
function checkForUnpushedCommits(
  repoRoot: string,
  branchName: string,
): boolean {
  try {
    const result = execSync(`git log origin/${branchName}..HEAD --oneline`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()
    return result.length > 0
  } catch {
    // If the remote branch doesn't exist, we have unpushed commits
    return true
  }
}

/**
 * Get the current git branch name
 */
function getCurrentBranch(repoRoot: string): string | null {
  try {
    const result = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return result.trim()
  } catch {
    return null
  }
}

/**
 * Check if all stages in a workstream are approved
 */
function checkAllStagesApproved(
  repoRoot: string,
  stream: StreamMetadata,
  streamId: string,
): { allApproved: boolean; unapprovedStages: number[] } {
  // First check if the stream itself is approved
  if (!isApproved(stream)) {
    return { allApproved: false, unapprovedStages: [] }
  }

  // Parse the PLAN.md to get the stages
  const consolidateResult = consolidateStream(repoRoot, streamId, true)
  if (!consolidateResult.success || !consolidateResult.streamDocument) {
    return { allApproved: false, unapprovedStages: [] }
  }

  const stageNumbers = consolidateResult.streamDocument.stages.map((s) => s.id)
  const unapprovedStages: number[] = []

  for (const stageNum of stageNumbers) {
    const stageStatus = getStageApprovalStatus(stream, stageNum)
    if (stageStatus !== "approved") {
      unapprovedStages.push(stageNum)
    }
  }

  return {
    allApproved: unapprovedStages.length === 0,
    unapprovedStages,
  }
}

/**
 * Get task completion summary
 */
function getTaskSummary(
  repoRoot: string,
  streamId: string,
): {
  total: number
  completed: number
  inProgress: number
  pending: number
  blocked: number
  cancelled: number
} {
  const tasks = getTasks(repoRoot, streamId)
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === "completed").length,
    inProgress: tasks.filter((t) => t.status === "in_progress").length,
    pending: tasks.filter((t) => t.status === "pending").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    cancelled: tasks.filter((t) => t.status === "cancelled").length,
  }
}

/**
 * Store completion metadata in the stream's index.json entry
 */
function storeCompletionMetadata(repoRoot: string, streamId: string): void {
  const index = loadIndex(repoRoot)
  const streamIndex = index.streams.findIndex(
    (s) => s.id === streamId || s.name === streamId,
  )

  if (streamIndex === -1) {
    throw new Error(`Workstream "${streamId}" not found`)
  }

  const stream = index.streams[streamIndex]!
  stream.github = {
    ...stream.github,
    completed_at: new Date().toISOString(),
  }
  stream.updated_at = new Date().toISOString()

  saveIndex(repoRoot, index)
}

interface PRCreationResult {
  success: boolean
  prNumber?: number
  prUrl?: string
  error?: string
}

/**
 * Format PR title as [{stream-id}] {stream-name}
 */
function formatPRTitle(streamId: string, streamName: string): string {
  return `[${streamId}] ${streamName}`
}

/**
 * Format PR body with summary, PLAN.md link, and task counts
 */
function formatPRBody(
  repoRoot: string,
  streamId: string,
  streamName: string,
  owner: string,
  repo: string,
): string {
  const taskSummary = getTaskSummary(repoRoot, streamId)
  const planPath = `work/${streamId}/PLAN.md`

  const lines: string[] = [
    `## Summary`,
    ``,
    `Completes workstream: **${streamName}**`,
    ``,
    `## Details`,
    ``,
    `- **Stream ID:** \`${streamId}\``,
    `- **Plan:** [PLAN.md](${planPath})`,
    ``,
    `## Task Completion`,
    ``,
    `| Status | Count |`,
    `|--------|-------|`,
    `| Completed | ${taskSummary.completed} |`,
    `| In Progress | ${taskSummary.inProgress} |`,
    `| Pending | ${taskSummary.pending} |`,
    `| Blocked | ${taskSummary.blocked} |`,
    `| Cancelled | ${taskSummary.cancelled} |`,
    `| **Total** | **${taskSummary.total}** |`,
    ``,
    `---`,
    `*Generated by \`work complete\`*`,
  ]

  return lines.join("\n")
}

/**
 * Creates a pull request for the completed workstream
 */
async function createWorkstreamPR(
  repoRoot: string,
  streamId: string,
  streamName: string,
  branchName: string,
  targetBranch: string,
  draft: boolean,
): Promise<PRCreationResult> {
  try {
    // Get GitHub config and auth
    const config = await loadGitHubConfig(repoRoot)
    const token = getGitHubAuth()

    if (!token) {
      return {
        success: false,
        error:
          "No GitHub authentication found. Set GITHUB_TOKEN/GH_TOKEN or run 'gh auth login'.",
      }
    }

    if (!config.owner || !config.repo) {
      return {
        success: false,
        error:
          "GitHub repository not configured. Run 'work github enable' first.",
      }
    }

    // Create the client
    const client = createGitHubClient(token, config.owner, config.repo)

    // Format PR title and body
    const title = formatPRTitle(streamId, streamName)
    const body = formatPRBody(
      repoRoot,
      streamId,
      streamName,
      config.owner,
      config.repo,
    )

    // Create the PR
    const pr = await client.createPullRequest(
      title,
      body,
      branchName,
      targetBranch,
      draft,
    )

    return {
      success: true,
      prNumber: pr.number,
      prUrl: pr.html_url,
    }
  } catch (error) {
    const errorMessage = (error as Error).message || String(error)
    return {
      success: false,
      error: errorMessage,
    }
  }
}

/**
 * Validate workstream is ready for completion
 */
async function validateCompletion(
  repoRoot: string,
  stream: StreamMetadata,
  cliArgs: CompleteStreamCliArgs,
): Promise<{
  errors: string[]
  warnings: string[]
  branchName?: string
  targetBranch: string
}> {
  const errors: string[] = []
  const warnings: string[] = []
  let branchName: string | undefined
  let targetBranch = cliArgs.target || "main"

  // 1. Check if GitHub is enabled
  const githubEnabled = await isGitHubEnabled(repoRoot)
  if (!githubEnabled) {
    errors.push(
      "GitHub integration is not enabled. Run 'work github enable' first.",
    )
  }

  // 2. Check if workstream branch exists (only if GitHub is enabled)
  let branchExists = false
  if (githubEnabled) {
    const config = await loadGitHubConfig(repoRoot)
    branchName =
      getWorkstreamBranchName(repoRoot, stream.id) ||
      formatBranchName(config, stream.id)
    branchExists = await workstreamBranchExists(repoRoot, stream.id)
    if (!branchExists) {
      errors.push(
        `Workstream branch '${branchName}' does not exist. Run 'work github create-branch' first.`,
      )
    }
    // Set target branch from config if not specified
    if (!cliArgs.target) {
      targetBranch = config.default_pr_target || "main"
    }
  }

  // 3. Check if we're on the workstream branch
  if (githubEnabled && branchExists && branchName) {
    const currentBranch = getCurrentBranch(repoRoot)
    if (currentBranch !== branchName) {
      errors.push(
        `Not on workstream branch. Current branch: '${currentBranch}', expected: '${branchName}'`,
      )
    }
  }

  // 4. Check all stages are approved
  const approvalCheck = checkAllStagesApproved(repoRoot, stream, stream.id)
  if (!isApproved(stream)) {
    errors.push("Workstream plan is not approved. Run 'work approve' first.")
  } else if (!approvalCheck.allApproved) {
    for (const stageNum of approvalCheck.unapprovedStages) {
      errors.push(
        `Stage ${stageNum} is not approved. Run 'work approve stage ${stageNum}' first.`,
      )
    }
  }

  // 5. Check for REPORT.md existence and validation (unless --force is used)
  if (!cliArgs.force) {
    const workDir = getWorkDir(repoRoot)
    const reportPath = join(workDir, stream.id, "REPORT.md")
    
    if (!existsSync(reportPath)) {
      errors.push(
        "REPORT.md is missing. Run 'work report init' to create it, or use --force to bypass.",
      )
    } else {
      // Validate the report content
      const reportValidation = validateReport(repoRoot, stream.id)
      
      if (!reportValidation.valid) {
        errors.push("REPORT.md validation failed:")
        for (const error of reportValidation.errors) {
          errors.push(`  - ${error}`)
        }
        errors.push("Fix the issues above or use --force to bypass.")
      }
      
      // Add warnings from report validation
      for (const warning of reportValidation.warnings) {
        warnings.push(`REPORT.md: ${warning}`)
      }
    }
  }

  // Get task summary for warnings
  const taskSummary = getTaskSummary(repoRoot, stream.id)
  if (taskSummary.inProgress > 0) {
    warnings.push(`${taskSummary.inProgress} task(s) still in progress`)
  }
  if (taskSummary.pending > 0) {
    warnings.push(`${taskSummary.pending} task(s) still pending`)
  }
  if (taskSummary.blocked > 0) {
    warnings.push(`${taskSummary.blocked} task(s) blocked`)
  }

  return { errors, warnings, branchName, targetBranch }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  // Role-based access check
  if (!canExecuteCommand("complete")) {
    console.error(getRoleDenialMessage("complete"))
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

  // Resolve stream ID (uses current if not specified)
  let resolvedStreamId: string
  try {
    const index = loadIndex(repoRoot)
    const stream = getResolvedStream(index, cliArgs.streamId)
    resolvedStreamId = stream.id
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  // Reload stream to get the full metadata
  const stream = getResolvedStream(loadIndex(repoRoot), resolvedStreamId)

  // Validate workstream is ready for completion
  const validation = await validateCompletion(repoRoot, stream, cliArgs)
  const taskSummary = getTaskSummary(repoRoot, stream.id)

  // Show warning if --force was used to bypass REPORT.md validation
  if (cliArgs.force) {
    const workDir = getWorkDir(repoRoot)
    const reportPath = join(workDir, stream.id, "REPORT.md")
    
    if (!existsSync(reportPath)) {
      validation.warnings.push(
        "WARNING: REPORT.md is missing (bypassed with --force)",
      )
    } else {
      const reportValidation = validateReport(repoRoot, stream.id)
      if (!reportValidation.valid) {
        validation.warnings.push(
          "WARNING: REPORT.md validation failed (bypassed with --force)",
        )
      }
    }
  }

  // Output errors and exit if any
  if (validation.errors.length > 0) {
    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            success: false,
            errors: validation.errors,
            warnings: validation.warnings,
            stream: stream.id,
            tasks: taskSummary,
          },
          null,
          2,
        ),
      )
    } else {
      console.error(
        "Cannot complete workstream. The following issues must be resolved:\n",
      )
      for (const error of validation.errors) {
        console.error(`  - ${error}`)
      }
      if (validation.warnings.length > 0) {
        console.log("\nWarnings:")
        for (const warning of validation.warnings) {
          console.log(`  - ${warning}`)
        }
      }
    }
    process.exit(1)
  }

  try {
    // Store completion metadata in index.json
    storeCompletionMetadata(repoRoot, stream.id)

    // Complete the stream (generates COMPLETION.md, sets status)
    const result = completeStream({
      repoRoot,
      streamId: stream.id,
    })

    console.log(`Marked workstream "${result.streamId}" as complete`)
    console.log(`   Completed at: ${result.completedAt}`)
    console.log(`   Metrics:      ${result.completionPath}`)

    // Handle git operations if --commit is enabled
    if (cliArgs.commit) {
      console.log("")
      console.log("Git Operations:")

      const gitResult = performGitOperations(
        repoRoot,
        resolvedStreamId,
        stream.name,
        `Workstream completed.`,
      )

      if (gitResult.error) {
        console.log(`   Error: ${gitResult.error}`)
        // Don't exit with error - the completion itself succeeded
      } else {
        if (gitResult.staged) {
          console.log("   Staged all changes")
        }
        if (gitResult.committed) {
          console.log(`   Committed: "Completed workstream: ${stream.name}"`)
        }
        if (gitResult.alreadyPushed && !gitResult.committed) {
          console.log("   No new changes to commit (already up-to-date)")
        }
        if (gitResult.pushed) {
          const branchName = getWorkstreamBranchName(repoRoot, resolvedStreamId)
          if (gitResult.alreadyPushed && gitResult.committed) {
            // We committed and pushed, but the remote was already up-to-date message came back
            // This shouldn't happen, but handle it gracefully
            console.log(`   Pushed to origin/${branchName}`)
          } else if (gitResult.alreadyPushed) {
            console.log(`   Already pushed to origin/${branchName}`)
          } else {
            console.log(`   Pushed to origin/${branchName}`)
          }
        }
        if (gitResult.commitSha) {
          console.log(`   Commit SHA: ${gitResult.commitSha}`)
        }
      }
    }

    // Handle PR creation if --pr is enabled
    if (cliArgs.pr) {
      console.log("")
      console.log("Pull Request:")

      // Get branch name and target branch
      const githubEnabled = await isGitHubEnabled(repoRoot)
      if (!githubEnabled) {
        console.log("   Skipped: GitHub integration is not enabled")
      } else {
        const config = await loadGitHubConfig(repoRoot)
        const branchName =
          getWorkstreamBranchName(repoRoot, resolvedStreamId) ||
          formatBranchName(config, resolvedStreamId)
        const targetBranch =
          cliArgs.target || config.default_pr_target || "main"

        const prResult = await createWorkstreamPR(
          repoRoot,
          resolvedStreamId,
          stream.name,
          branchName,
          targetBranch,
          cliArgs.draft,
        )

        if (prResult.error) {
          console.log(`   Error: ${prResult.error}`)
        } else {
          console.log(`   Created PR #${prResult.prNumber}`)
          if (cliArgs.draft) {
            console.log("   Status: Draft")
          }
          console.log(`   Target: ${targetBranch}`)
          console.log(`   URL: ${prResult.prUrl}`)
        }
      }
    }
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
