/**
 * Git commit helpers for stage approval auto-commits
 */

import type { StreamMetadata } from "../types.ts"
import { resolveStageApprovalNames } from "../approval.ts"
import { buildStageApprovalCommitMessage } from "../git/auto-commit-message.ts"
import {
  executeGitAutoCommit,
  type GitAutoCommitResult,
} from "../git/auto-commit-executor.ts"

export type StageCommitResult = GitAutoCommitResult

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
  const { streamName, stageName } = resolveStageApprovalNames(
    repoRoot,
    stream,
    stageNum
  )
  const message = formatStageCommitMessage(
    stream.id,
    streamName,
    stageNum,
    stageName
  )

  return executeGitAutoCommit(repoRoot, message)
}
