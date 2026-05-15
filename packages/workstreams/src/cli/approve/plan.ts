/**
 * Approve CLI - Plan Approval Handler
 *
 * Handles plan and stage-level approval/revocation workflows.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"

import {
  approveStream,
  approveTasks,
  revokeApproval,
  queryApprovalStatus,
  formatApprovalStatus,
  checkOpenQuestions,
  approveStage,
  revokeStageApproval,
  queryStageApprovalStatus,
  storeStageCommitSha,
} from "../../lib/approval.ts"
import { loadWorkstreamHierarchyQueryResult } from "../../lib/hierarchy-query.ts"
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
import { parseStreamDocument } from "../../lib/stream-parser.ts"
import { getWorkDir } from "../../lib/repo.ts"
import { type GitAutoCommitResult } from "../../lib/git/index.ts"
import { getResolvedStream } from "../../lib/index.ts"
import { getTasks, parseTaskId } from "../../lib/tasks.ts"
import { generateAllPrompts } from "../../lib/prompts.ts"
import { syncCompatibilityTasksFromPlan } from "../../lib/task-compatibility.ts"

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

interface ExecutionStateInitializationResult {
  success: boolean
  taskCount: number
  error?: string
}

function initializeExecutionStateFromPlan(
  repoRoot: string,
  streamId: string,
): ExecutionStateInitializationResult {
  try {
    const workDir = getWorkDir(repoRoot)
    const streamDir = join(workDir, streamId)
    const planMdPath = join(streamDir, "PLAN.md")

    if (!existsSync(planMdPath)) {
      return {
        success: false,
        taskCount: 0,
        error: `PLAN.md not found at ${planMdPath}`,
      }
    }

    const planContent = readFileSync(planMdPath, "utf-8")
    const errors: any[] = []
    const doc = parseStreamDocument(planContent, errors)

    if (!doc) {
      return {
        success: false,
        taskCount: 0,
        error: `Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`,
      }
    }

    const tasks = syncCompatibilityTasksFromPlan(repoRoot, streamId, doc)

    return {
      success: true,
      taskCount: tasks.length,
    }
  } catch (e) {
    return {
      success: false,
      taskCount: 0,
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

    const stageExists = loadWorkstreamHierarchyQueryResult(repoRoot, stream.id).stages.some(
      (stage) => stage.id === stageNum.toString().padStart(2, "0") || stage.number === stageNum,
    )

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
    if (!stageExists) {
      console.error(`Error: Stage ${stageNum} does not exist in the workstream hierarchy`)
      process.exit(1)
    }

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
    let updatedStream = approveStream(repoRoot, stream.id, "user")

    const executionStateResult = initializeExecutionStateFromPlan(
      repoRoot,
      updatedStream.id,
    )

    if (!executionStateResult.success) {
      throw new Error(
        `Failed to initialize execution state from PLAN.md: ${executionStateResult.error}`,
      )
    }

    updatedStream = approveTasks(repoRoot, updatedStream.id)

    const promptsResult = generateAllPrompts(repoRoot, updatedStream.id)
    const promptsWarning = !promptsResult.success

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
            executionState: {
              initialized: executionStateResult.success,
              taskCount: executionStateResult.taskCount,
              promptsGenerated: promptsResult.generatedFiles.length,
              promptThreadCount: promptsResult.totalThreads,
              promptErrors: promptsResult.errors,
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
      console.log(
        `  Initialized execution state directly from PLAN.md (${executionStateResult.taskCount} compatibility task${executionStateResult.taskCount === 1 ? "" : "s"})`,
      )
      console.log(
        `  Prompts: ${promptsResult.generatedFiles.length}/${promptsResult.totalThreads} generated`,
      )
      if (promptsWarning) {
        console.log(`  Warning: Some prompts failed to generate:`)
        for (const err of promptsResult.errors.slice(0, 3)) {
          console.log(`    - ${err}`)
        }
        if (promptsResult.errors.length > 3) {
          console.log(
            `    ... and ${promptsResult.errors.length - 3} more errors`,
          )
        }
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
