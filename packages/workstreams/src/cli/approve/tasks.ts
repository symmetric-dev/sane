/**
 * Approve CLI - Tasks Approval Handler
 *
 * Handles tasks approval/revocation and TASKS.md serialization to tasks.json.
 */

import { existsSync, readFileSync, unlinkSync } from "fs"
import { join } from "path"

import {
  approveTasks,
  revokeTasksApproval,
  getTasksApprovalStatus,
  checkTasksApprovalReady,
} from "../../lib/approval.ts"
import { parseTasksMd, generateTasksMdFromTasks } from "../../lib/tasks-md.ts"
import { getWorkDir } from "../../lib/repo.ts"
import {
  listTrackedDirtyFiles,
  type GitAutoCommitResult,
} from "../../lib/git/index.ts"
import { getResolvedStream, atomicWriteFile } from "../../lib/index.ts"
import { addTasks, getTasks } from "../../lib/tasks.ts"
import { generateAllPrompts } from "../../lib/prompts.ts"
import {
  loadGitHubConfig,
  createTasksApprovalCommit,
} from "../../lib/github/index.ts"

import type { ApproveCliArgs } from "./utils.ts"

function formatApprovalAutoCommitSkip(result: GitAutoCommitResult): string {
  if (result.reason === "unsafe_unrelated_tracked_changes") {
    const files = result.files?.length
      ? ` (${result.files.join(", ")})`
      : ""
    return `unsafe_unrelated_tracked_changes${files}`
  }

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
 * Result of serializing TASKS.md to tasks.json
 */
interface SerializeTasksResult {
  success: boolean
  taskCount: number
  tasksJsonPath?: string
  error?: string
}

/**
 * Serialize TASKS.md content to tasks.json
 *
 * Parses TASKS.md, extracts tasks, and writes to tasks.json.
 * This is the critical artifact that must succeed for approval.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @returns Result of the serialization
 */
export function serializeTasksMdToJson(
  repoRoot: string,
  streamId: string
): SerializeTasksResult {
  try {
    const workDir = getWorkDir(repoRoot)
    const tasksMdPath = join(workDir, streamId, "TASKS.md")
    const tasksJsonPath = join(workDir, streamId, "tasks.json")

    if (!existsSync(tasksMdPath)) {
      return {
        success: false,
        taskCount: 0,
        error: `TASKS.md not found at ${tasksMdPath}`,
      }
    }

    const content = readFileSync(tasksMdPath, "utf-8")
    const { tasks, errors } = parseTasksMd(content, streamId)

    if (errors.length > 0) {
      return {
        success: false,
        taskCount: 0,
        error: `TASKS.md parsing errors: ${errors.join(", ")}`,
      }
    }

    if (tasks.length === 0) {
      return {
        success: false,
        taskCount: 0,
        error: "TASKS.md contains no valid tasks",
      }
    }

    // Write tasks to tasks.json
    addTasks(repoRoot, streamId, tasks)

    return {
      success: true,
      taskCount: tasks.length,
      tasksJsonPath,
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
 * Delete TASKS.md after successful serialization
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @returns true if deleted, false otherwise
 */
export function deleteTasksMd(repoRoot: string, streamId: string): boolean {
  try {
    const workDir = getWorkDir(repoRoot)
    const tasksMdPath = join(workDir, streamId, "TASKS.md")

    if (existsSync(tasksMdPath)) {
      unlinkSync(tasksMdPath)
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Handle tasks approval/revocation workflow
 *
 * Validates TASKS.md, serializes to tasks.json, generates prompts,
 * and marks tasks as approved.
 */
export async function handleTasksApproval(
  repoRoot: string,
  stream: ReturnType<typeof getResolvedStream>,
  cliArgs: ApproveCliArgs
): Promise<void> {
  const currentStatus = getTasksApprovalStatus(stream)

  // Handle revoke
  if (cliArgs.revoke) {
    if (currentStatus !== "approved") {
      console.error("Error: Tasks are not approved, nothing to revoke")
      process.exit(1)
    }

    try {
      const updatedStream = revokeTasksApproval(
        repoRoot,
        stream.id,
        cliArgs.reason
      )

      // Regenerate TASKS.md from tasks.json so user can edit and re-approve
      const workDir = getWorkDir(repoRoot)
      const tasksMdPath = join(workDir, stream.id, "TASKS.md")
      const existingTasks = getTasks(repoRoot, stream.id)
      let tasksMdRegenerated = false

      if (existingTasks.length > 0 && !existsSync(tasksMdPath)) {
        const tasksMdContent = generateTasksMdFromTasks(
          updatedStream.name,
          existingTasks
        )
        atomicWriteFile(tasksMdPath, tasksMdContent)
        tasksMdRegenerated = true
      }

      if (cliArgs.json) {
        console.log(
          JSON.stringify(
            {
              action: "revoked",
              target: "tasks",
              streamId: updatedStream.id,
              streamName: updatedStream.name,
              reason: cliArgs.reason,
              approval: updatedStream.approval?.tasks,
              artifacts: {
                tasksMdRegenerated,
                taskCount: existingTasks.length,
              },
            },
            null,
            2
          )
        )
      } else {
        console.log(
          `Revoked tasks approval for workstream "${updatedStream.name}" (${updatedStream.id})`
        )
        if (cliArgs.reason) {
          console.log(`  Reason: ${cliArgs.reason}`)
        }
        if (tasksMdRegenerated) {
          console.log(`  Regenerated TASKS.md with ${existingTasks.length} tasks`)
          console.log(`  Edit TASKS.md and run 'work approve tasks' to re-approve`)
        }
      }
    } catch (e) {
      console.error((e as Error).message)
      process.exit(1)
    }
    return
  }

  if (currentStatus === "approved") {
    // Cleanup leftover TASKS.md if it exists
    const tasksMdDeleted = deleteTasksMd(repoRoot, stream.id)

    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            action: "already_approved",
            target: "tasks",
            streamId: stream.id,
            streamName: stream.name,
            approval: stream.approval?.tasks,
            artifacts: {
              tasksMdDeleted,
            },
          },
          null,
          2
        )
      )
    } else {
      console.log(
        `Tasks for workstream "${stream.name}" are already approved`
      )
      if (tasksMdDeleted) {
        console.log(`  Cleaned up leftover TASKS.md`)
      }
    }
    return
  }

  // Check readiness (validates TASKS.md exists and has valid tasks)
  const readyCheck = checkTasksApprovalReady(repoRoot, stream.id)
  if (!readyCheck.ready) {
    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            action: "blocked",
            target: "tasks",
            reason: readyCheck.reason,
            streamId: stream.id,
            streamName: stream.name,
          },
          null,
          2
        )
      )
    } else {
      console.error(`Error: ${readyCheck.reason}`)
    }
    process.exit(1)
  }

  const trackedDirtyBeforeApproval = listTrackedDirtyFiles(repoRoot)

  // Step 1: Serialize TASKS.md to tasks.json
  // This is the critical step - if it fails, we don't approve
  const serializeResult = serializeTasksMdToJson(repoRoot, stream.id)
  if (!serializeResult.success) {
    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            action: "blocked",
            target: "tasks",
            reason: "serialization_failed",
            error: serializeResult.error,
            streamId: stream.id,
            streamName: stream.name,
          },
          null,
          2
        )
      )
    } else {
      console.error(`Error: Failed to serialize TASKS.md to tasks.json`)
      console.error(`  ${serializeResult.error}`)
    }
    process.exit(1)
  }

  // Step 2: Generate all prompts
  // This is non-critical - if it fails, we still approve but warn
  const promptsResult = generateAllPrompts(repoRoot, stream.id)
  const promptsWarning = !promptsResult.success

  try {
    // Step 3: Approve tasks (must happen before deleting TASKS.md since approveTasks validates it)
    const updatedStream = approveTasks(repoRoot, stream.id)

    // Step 4: Delete TASKS.md AFTER approval succeeds
    const tasksMdDeleted = deleteTasksMd(repoRoot, stream.id)

    // Step 5: Auto-commit on tasks approval if configured.
    // This is non-critical - if it fails, approval still succeeds.
    let commitResult: GitAutoCommitResult | undefined
    const githubConfig = await loadGitHubConfig(repoRoot)
    if (githubConfig.auto_commit_on_approval) {
      commitResult = createTasksApprovalCommit(
        repoRoot,
        updatedStream,
        serializeResult.taskCount,
        {
          trackedDirtyBeforeApproval,
        }
      )
    }

    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            action: "approved",
            target: "tasks",
            streamId: updatedStream.id,
            streamName: updatedStream.name,
            taskCount: serializeResult.taskCount,
            approval: updatedStream.approval?.tasks,
            artifacts: {
              tasksJson: {
                generated: true,
                path: serializeResult.tasksJsonPath,
                taskCount: serializeResult.taskCount,
              },
              tasksMdDeleted,
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
      console.log(`Tasks approved. tasks.json and prompts generated.`)
      console.log(`  Task count: ${serializeResult.taskCount}`)
      console.log(`  tasks.json: ${serializeResult.tasksJsonPath}`)
      console.log(
        `  Prompts: ${promptsResult.generatedFiles.length}/${promptsResult.totalThreads} generated`
      )
      if (tasksMdDeleted) {
        console.log(`  TASKS.md deleted`)
      }
      if (promptsWarning) {
        console.log(`  Warning: Some prompts failed to generate:`)
        for (const err of promptsResult.errors.slice(0, 3)) {
          console.log(`    - ${err}`)
        }
        if (promptsResult.errors.length > 3) {
          console.log(
            `    ... and ${promptsResult.errors.length - 3} more errors`
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
