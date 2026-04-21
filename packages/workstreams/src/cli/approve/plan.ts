/**
 * Approve CLI - Plan Approval Handler
 *
 * Handles plan and stage-level approval/revocation workflows.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"

import {
  approveStream,
  revokeApproval,
  queryApprovalStatus,
  formatApprovalStatus,
  checkOpenQuestions,
  approveStage,
  revokeStageApproval,
  queryStageApprovalStatus,
  storeStageCommitSha,
} from "../../lib/approval.ts"
import {
  loadGitHubConfig,
  isGitHubEnabled,
  createPlanApprovalCommit,
  createStageApprovalCommit,
  loadWorkstreamGitHub,
  saveWorkstreamGitHub,
  updateStageIssueState,
} from "../../lib/github/index.ts"
import { closeStageIssue } from "../../lib/github/issues.ts"
import { generateTasksMdFromPlan } from "../../lib/tasks-md.ts"
import { parseStreamDocument } from "../../lib/stream-parser.ts"
import { getWorkDir } from "../../lib/repo.ts"
import { type GitAutoCommitResult } from "../../lib/git/index.ts"
import { atomicWriteFile, getResolvedStream } from "../../lib/index.ts"
import { getTasks, parseTaskId } from "../../lib/tasks.ts"

import type { ApproveCliArgs } from "./utils.ts"

function formatApprovalAutoCommitSkip(result: GitAutoCommitResult): string {
  if (result.reason === "no_tracked_approval_changes") {
    return "no_tracked_approval_changes"
  }

  if (
    result.reason === "unsafe_fallback_stream_name" ||
    result.reason === "unsafe_generic_stream_name" ||
    result.reason === "unsafe_fallback_stage_name" ||
    result.reason === "unsafe_generic_stage_name"
  ) {
    return result.reason
  }

  return result.error ?? "unknown"
}

/**
 * Result of TASKS.md generation attempt
 */
interface TasksMdGenerationResult {
  success: boolean
  path?: string
  overwritten?: boolean
  error?: string
}

/**
 * Generate TASKS.md file after plan approval
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param streamName - Workstream name for the file header
 * @returns Result of the generation attempt
 */
function generateTasksMdAfterApproval(
  repoRoot: string,
  streamId: string,
  streamName: string
): TasksMdGenerationResult {
  try {
    const workDir = getWorkDir(repoRoot)
    const streamDir = join(workDir, streamId)
    const tasksMdPath = join(streamDir, "TASKS.md")
    const planMdPath = join(streamDir, "PLAN.md")

    // Check if PLAN.md exists
    if (!existsSync(planMdPath)) {
      return {
        success: false,
        error: `PLAN.md not found at ${planMdPath}`,
      }
    }

    // Check if TASKS.md already exists
    const overwritten = existsSync(tasksMdPath)

    // Parse PLAN.md to get the stream document
    const planContent = readFileSync(planMdPath, "utf-8")
    const errors: any[] = []
    const doc = parseStreamDocument(planContent, errors)

    if (!doc) {
      return {
        success: false,
        error: `Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`,
      }
    }

    // Generate TASKS.md content from the plan structure
    const content = generateTasksMdFromPlan(streamName, doc)

    // Write the file
    atomicWriteFile(tasksMdPath, content)

    return {
      success: true,
      path: tasksMdPath,
      overwritten,
    }
  } catch (e) {
    return {
      success: false,
      error: (e as Error).message,
    }
  }
}

/**
 * Handle plan approval/revocation workflow
 *
 * This includes both top-level plan approval and stage-level approvals.
 */
export async function handlePlanApproval(
  repoRoot: string,
  stream: ReturnType<typeof getResolvedStream>,
  cliArgs: ApproveCliArgs
): Promise<void> {
  // Handle Stage-level operations
  if (cliArgs.stage !== undefined) {
    const stageNum = cliArgs.stage

    if (cliArgs.revoke) {
      try {
        // Check if stage is approved
        const stageStatus = queryStageApprovalStatus(repoRoot, stream.id, stageNum, stream)
        if (stageStatus !== "approved") {
          console.error(
            `Error: Stage ${stageNum} is not approved, nothing to revoke`
          )
          process.exit(1)
        }

        const updatedStream = revokeStageApproval(
          repoRoot,
          stream.id,
          stageNum,
          cliArgs.reason
        )

        if (cliArgs.json) {
          console.log(
            JSON.stringify(
              {
                action: "revoked",
                scope: "stage",
                stage: stageNum,
                streamId: updatedStream.id,
                reason: cliArgs.reason,
                approval: updatedStream.approval?.stages?.[stageNum],
              },
              null,
              2
            )
          )
        } else {
          console.log(
            `Revoked approval for Stage ${stageNum} of workstream "${updatedStream.name}"`
          )
          if (cliArgs.reason) {
            console.log(`  Reason: ${cliArgs.reason}`)
          }
        }
      } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
      }
      return
    }

    // Handle Stage Approve
    const stageStatus = queryStageApprovalStatus(repoRoot, stream.id, stageNum, stream)
    if (stageStatus === "approved") {
      if (cliArgs.json) {
        console.log(
          JSON.stringify(
            {
              action: "already_approved",
              scope: "stage",
              stage: stageNum,
              streamId: stream.id,
              approval: stream.approval?.stages?.[stageNum],
            },
            null,
            2
          )
        )
      } else {
        console.log(
          `Stage ${stageNum} of workstream "${stream.name}" is already approved`
        )
      }
      return
    }

    // Validate that all tasks in the stage are completed
    if (!cliArgs.force) {
      const allTasks = getTasks(repoRoot, stream.id)
      const stageTasks = allTasks.filter((t) => {
        try {
          const parsed = parseTaskId(t.id)
          return parsed.stage === stageNum
        } catch {
          return false
        }
      })

      const incompleteTasks = stageTasks.filter((t) => t.status !== "completed" && t.status !== "cancelled")

      // Group incomplete tasks by thread
      const incompleteThreads = new Map<
        string,
        { count: number; name: string }
      >()

      incompleteTasks.forEach((t) => {
        try {
          const parsed = parseTaskId(t.id)
          // Format thread ID: stage.batch.thread
          const threadId = `${parsed.stage.toString().padStart(2, "0")}.${parsed.batch.toString().padStart(2, "0")}.${parsed.thread.toString().padStart(2, "0")}`

          if (!incompleteThreads.has(threadId)) {
            incompleteThreads.set(threadId, {
              count: 0,
              name: t.thread_name || `Thread ${parsed.thread}`,
            })
          }

          const threadInfo = incompleteThreads.get(threadId)!
          threadInfo.count++
        } catch {
          // ignore parsing errors
        }
      })

      if (incompleteThreads.size > 0) {
        if (cliArgs.json) {
          console.log(
            JSON.stringify(
              {
                action: "blocked",
                scope: "stage",
                stage: stageNum,
                streamId: stream.id,
                reason: "incomplete_tasks",
                incompleteThreadCount: incompleteThreads.size,
                incompleteTaskCount: incompleteTasks.length,
                incompleteThreads: Array.from(incompleteThreads.entries()).map(
                  ([id, info]) => ({
                    id,
                    name: info.name,
                    incompleteTasks: info.count,
                  })
                ),
              },
              null,
              2
            )
          )
        } else {
          console.error(
            `Error: Cannot approve Stage ${stageNum} because ${incompleteThreads.size} thread(s) are not approved.`
          )
          console.log("\nIncomplete threads:")

          // Sort threads by ID
          const sortedThreads = Array.from(incompleteThreads.entries()).sort(
            (a, b) => a[0].localeCompare(b[0])
          )

          for (const [threadId, info] of sortedThreads) {
            console.log(
              `  - ${threadId} (${info.name}): ${info.count} task(s) remaining`
            )
          }

          console.log("\nUse --force to approve anyway.")
        }
        process.exit(1)
      }
    }

    try {
      let updatedStream = approveStage(repoRoot, stream.id, stageNum, "user")

      // Auto-commit on stage approval if configured.
      // This uses plain git and does not require GitHub integration to be enabled.
      let commitResult: GitAutoCommitResult | undefined
      const githubConfig = await loadGitHubConfig(repoRoot)
      if (githubConfig.auto_commit_on_approval) {
        commitResult = createStageApprovalCommit(repoRoot, updatedStream, stageNum)

        if (commitResult.success && commitResult.commitSha) {
          updatedStream = storeStageCommitSha(
            repoRoot,
            updatedStream.id,
            stageNum,
            commitResult.commitSha
          )
        }
      }

      // Automatically close GitHub issue for this stage if GitHub integration is enabled
      let issueCloseResult:
        | {
            closed: boolean
            issueNumber?: number
            issueUrl?: string
            error?: string
          }
        | undefined
      
      const githubEnabled = await isGitHubEnabled(repoRoot)
      if (githubEnabled) {
        const workstreamGitHub = await loadWorkstreamGitHub(repoRoot, updatedStream.id)
        
        if (workstreamGitHub) {
          const stageId = stageNum.toString().padStart(2, "0")
          const stageIssue = workstreamGitHub.stages[stageId]
          
          if (stageIssue && stageIssue.state === "open") {
            try {
              // Close the issue on GitHub
              await closeStageIssue(repoRoot, stageIssue.issue_number)
              
              // Update the local github.json with closed_at timestamp
              updateStageIssueState(
                workstreamGitHub,
                stageId,
                "closed",
                new Date().toISOString()
              )
              await saveWorkstreamGitHub(repoRoot, updatedStream.id, workstreamGitHub)
              
              issueCloseResult = {
                closed: true,
                issueNumber: stageIssue.issue_number,
                issueUrl: stageIssue.issue_url,
              }
            } catch (error) {
              issueCloseResult = {
                closed: false,
                error: (error as Error).message,
              }
            }
          } else if (stageIssue && stageIssue.state === "closed") {
            // Issue already closed - not an error, just skip silently
          }
          // No issue for this stage - that's fine, skip silently
        }
        // No github.json for this workstream - that's fine, skip silently
      }

      if (cliArgs.json) {
        console.log(
          JSON.stringify(
            {
              action: "approved",
              scope: "stage",
              stage: stageNum,
              streamId: updatedStream.id,
              approval: updatedStream.approval?.stages?.[stageNum],
              commit: commitResult
                ? {
                    created: commitResult.success && !commitResult.skipped,
                    sha: commitResult.commitSha,
                    outcome: commitResult.outcome,
                    skipped: commitResult.skipped,
                    reason: commitResult.reason,
                    files: commitResult.files,
                    error: commitResult.error,
                  }
                : undefined,
              issue: issueCloseResult
                ? {
                    closed: issueCloseResult.closed,
                    issueNumber: issueCloseResult.issueNumber,
                    issueUrl: issueCloseResult.issueUrl,
                    error: issueCloseResult.error,
                  }
                : undefined,
            },
            null,
            2
          )
        )
      } else {
        console.log(
          `Approved Stage ${stageNum} of workstream "${updatedStream.name}"`
        )
        if (commitResult?.success && commitResult.commitSha) {
          console.log(`  Committed: ${commitResult.commitSha.substring(0, 7)}`)
        } else if (commitResult?.skipped) {
          console.log(`  Commit skipped: ${formatApprovalAutoCommitSkip(commitResult)}`)
        } else if (commitResult?.error) {
          console.log(`  Commit skipped: ${commitResult.error}`)
        }
        
        if (issueCloseResult) {
          if (issueCloseResult.closed) {
            console.log(`  Issue closed: #${issueCloseResult.issueNumber} (${issueCloseResult.issueUrl})`)
          } else if (issueCloseResult.error) {
            console.log(`  Issue not closed: ${issueCloseResult.error}`)
          }
        }
      }
    } catch (e) {
      console.error((e as Error).message)
      process.exit(1)
    }
    return
  }

  // Handle revoke
  if (cliArgs.revoke) {
    const currentStatus = queryApprovalStatus(repoRoot, stream.id, stream)
    if (currentStatus === "draft") {
      console.error("Error: Plan is not approved, nothing to revoke")
      process.exit(1)
    }

    try {
      const updatedStream = revokeApproval(repoRoot, stream.id, cliArgs.reason)

      if (cliArgs.json) {
        console.log(
          JSON.stringify(
            {
              action: "revoked",
              target: "plan",
              streamId: updatedStream.id,
              streamName: updatedStream.name,
              reason: cliArgs.reason,
              approval: updatedStream.approval,
            },
            null,
            2
          )
        )
      } else {
        console.log(
          `Revoked plan approval for workstream "${updatedStream.name}" (${updatedStream.id})`
        )
        if (cliArgs.reason) {
          console.log(`  Reason: ${cliArgs.reason}`)
        }
      }
    } catch (e) {
      console.error((e as Error).message)
      process.exit(1)
    }

    return
  }

  // Handle approve
  const currentStatus = queryApprovalStatus(repoRoot, stream.id, stream)
  if (currentStatus === "approved") {
    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            action: "already_approved",
            target: "plan",
            streamId: stream.id,
            streamName: stream.name,
            approval: stream.approval,
          },
          null,
          2
        )
      )
    } else {
      console.log(`Plan for workstream "${stream.name}" is already approved`)
      console.log(`  Status: ${formatApprovalStatus(stream)}`)
    }
    return
  }

  // Check for open questions
  const questionsResult = checkOpenQuestions(repoRoot, stream.id)

  const planMdPath = join(getWorkDir(repoRoot), stream.id, "PLAN.md")
  if (existsSync(planMdPath)) {
    const planContent = readFileSync(planMdPath, "utf-8")
    const parseErrors: { message: string }[] = []
    const doc = parseStreamDocument(planContent, parseErrors)

    if (doc && doc.stages.length === 0) {
      if (cliArgs.json) {
        console.log(
          JSON.stringify(
            {
              action: "blocked",
              target: "plan",
              reason: "empty_plan",
              streamId: stream.id,
              streamName: stream.name,
              message:
                "Cannot approve a draft plan with no stages. Scaffold stages first with 'work plan create'.",
            },
            null,
            2
          )
        )
      } else {
        console.error("Error: Cannot approve a draft plan with no stages.")
        console.error("Scaffold stages first with 'work plan create', then approve again.")
      }
      process.exit(1)
    }
  }

  if (questionsResult.hasOpenQuestions && !cliArgs.force) {
    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            action: "blocked",
            target: "plan",
            reason: "open_questions",
            streamId: stream.id,
            streamName: stream.name,
            openQuestions: questionsResult.questions,
            openCount: questionsResult.openCount,
            resolvedCount: questionsResult.resolvedCount,
          },
          null,
          2
        )
      )
    } else {
      console.error("Error: Cannot approve plan with open questions")
      console.error("")
      console.error(`Found ${questionsResult.openCount} open question(s):`)
      for (const q of questionsResult.questions) {
        console.error(`  Stage ${q.stage} (${q.stageName}): ${q.question}`)
      }
      console.error("")
      console.error("Options:")
      console.error("  1. Resolve questions in PLAN.md (mark with [x])")
      console.error("  2. Use --force to approve anyway")
    }
    process.exit(1)
  }

  if (questionsResult.hasOpenQuestions && cliArgs.force) {
    console.log(
      `Warning: Approving with ${questionsResult.openCount} open question(s)`
    )
  }

  try {
    const updatedStream = approveStream(repoRoot, stream.id, "user")

    // Auto-generate TASKS.md after successful plan approval
    const tasksMdResult = generateTasksMdAfterApproval(
      repoRoot,
      updatedStream.id,
      updatedStream.name
    )

    // Auto-commit on plan approval if configured.
    // This uses plain git and does not require GitHub integration to be enabled.
    let commitResult: GitAutoCommitResult | undefined
    const githubConfig = await loadGitHubConfig(repoRoot)
    if (githubConfig.auto_commit_on_approval) {
      commitResult = createPlanApprovalCommit(repoRoot, updatedStream)
    }

    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            action: "approved",
            target: "plan",
            streamId: updatedStream.id,
            streamName: updatedStream.name,
            approval: updatedStream.approval,
            openQuestions: questionsResult.hasOpenQuestions
              ? questionsResult.openCount
              : 0,
            forcedApproval: questionsResult.hasOpenQuestions && cliArgs.force,
            tasksMd: {
              generated: tasksMdResult.success,
              path: tasksMdResult.path,
              overwritten: tasksMdResult.overwritten,
              error: tasksMdResult.error,
            },
            commit: commitResult
              ? {
                  created: commitResult.success && !commitResult.skipped,
                  sha: commitResult.commitSha,
                  outcome: commitResult.outcome,
                  skipped: commitResult.skipped,
                  reason: commitResult.reason,
                  files: commitResult.files,
                  error: commitResult.error,
                }
              : undefined,
          },
          null,
          2
        )
      )
    } else {
      console.log(
        `Approved plan for workstream "${updatedStream.name}" (${updatedStream.id})`
      )
      console.log(`  Status: ${formatApprovalStatus(updatedStream)}`)

      // Report TASKS.md generation result
      if (tasksMdResult.success) {
        if (tasksMdResult.overwritten) {
          console.log(`  Warning: Overwrote existing TASKS.md`)
        }
        console.log(`  TASKS.md generated at ${tasksMdResult.path}`)
      } else {
        console.log(
          `  Warning: Failed to generate TASKS.md: ${tasksMdResult.error}`
        )
      }

      if (commitResult?.success && commitResult.commitSha) {
        console.log(`  Committed: ${commitResult.commitSha.substring(0, 7)}`)
      } else if (commitResult?.skipped) {
        console.log(`  Commit skipped: ${formatApprovalAutoCommitSkip(commitResult)}`)
      } else if (commitResult?.error) {
        console.log(`  Commit skipped: ${commitResult.error}`)
      }
    }
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
}
