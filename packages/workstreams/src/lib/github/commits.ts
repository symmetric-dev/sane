/**
 * Git commit helpers for stage approval auto-commits
 *
 * Provides functions for creating commits when stages are approved,
 * following the pattern established in complete.ts.
 */

import { execSync } from "node:child_process"
import type { StreamMetadata } from "../types.ts"
import { resolveStageApprovalNames } from "../approval.ts"
import { buildStageApprovalCommitMessage } from "../git/auto-commit-message.ts"

/**
 * Result of a commit operation
 */
export interface StageCommitResult {
  success: boolean
  commitSha?: string
  error?: string
  skipped?: boolean // True if no changes to commit
}

/**
 * Format a commit message for stage approval
 *
 * Format: "Stage {stageNum} approved: {stageName}"
 * With trailers:
 *   Stream-Id: {streamId}
 *   Stream-Name: {streamName}
 *   Stage: {stageNum}
 *   Stage-Name: {stageName}
 *
 * @param streamId The workstream ID
 * @param streamName The workstream name
 * @param stageNum The stage number being approved
 * @param stageName The name of the stage
 * @returns Formatted commit message with trailers
 */
export function formatStageCommitMessage(
  streamId: string,
  streamName: string,
  stageNum: number,
  stageName: string
): { title: string; body: string } {
  return buildStageApprovalCommitMessage({
    streamId,
    streamName,
    stageNumber: stageNum,
    stageName,
  })
}

/**
 * Check if there are uncommitted changes in the repository
 *
 * @param repoRoot Repository root path
 * @returns True if there are staged or unstaged changes
 */
export function hasUncommittedChanges(repoRoot: string): boolean {
  try {
    const statusOutput = execSync("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()

    return statusOutput.length > 0
  } catch {
    // If git status fails, assume no changes (safer default)
    return false
  }
}

/**
 * Create a commit for stage approval
 *
 * Performs:
 * 1. git add -A (stage all changes)
 * 2. git commit with formatted message
 * 3. Returns the commit SHA
 *
 * Errors are handled gracefully - commit failure should not block approval.
 *
 * @param repoRoot Repository root path
 * @param stream The workstream metadata
 * @param stageNum The stage number being approved
 * @param stageName The name of the stage
 * @returns Result containing success status, commit SHA, or error
 */
export function createStageApprovalCommit(
  repoRoot: string,
  stream: StreamMetadata,
  stageNum: number
): StageCommitResult {
  try {
    // Stage all changes
    execSync("git add -A", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })

    // Check if there are changes to commit
    if (!hasUncommittedChanges(repoRoot)) {
      return {
        success: true,
        skipped: true,
      }
    }

    // Format the commit message
    const { streamName, stageName } = resolveStageApprovalNames(
      repoRoot,
      stream,
      stageNum
    )
    const { title, body } = formatStageCommitMessage(
      stream.id,
      streamName,
      stageNum,
      stageName
    )

    // Create the commit
    // Escape double quotes in body for shell
    const escapedBody = body.replace(/"/g, '\\"')
    execSync(`git commit -m "${title}" -m "${escapedBody}"`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })

    // Get the commit SHA
    const commitSha = execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim()

    return {
      success: true,
      commitSha,
    }
  } catch (error) {
    // Handle errors gracefully - commit failure should not block approval
    const errorMessage = (error as Error).message || String(error)
    return {
      success: false,
      error: errorMessage,
    }
  }
}
