import { execFileSync } from "node:child_process"

import type { AutoCommitMessage } from "./auto-commit-message.ts"

export type GitAutoCommitSkipReason =
  | "no_tracked_approval_changes"
  | "unsafe_fallback_stream_name"
  | "unsafe_generic_stream_name"
  | "unsafe_fallback_stage_name"
  | "unsafe_generic_stage_name"

export interface GitAutoCommitResult {
  success: boolean
  staged: boolean
  created: boolean
  skipped: boolean
  outcome: "committed" | "skipped" | "failed"
  reason?: GitAutoCommitSkipReason
  commitSha?: string
  error?: string
  files?: string[]
}

interface ExecuteGitAutoCommitOptions {
  skipReason?: GitAutoCommitSkipReason
}

function runGit(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  })
}

export function getHeadCommitSha(repoRoot: string): string {
  return runGit(repoRoot, ["rev-parse", "HEAD"]).trim()
}

export function hasStagedChangesToCommit(repoRoot: string): boolean {
  try {
    const stagedFiles = runGit(repoRoot, ["diff", "--cached", "--name-only"]).trim()
    return stagedFiles.length > 0
  } catch {
    return false
  }
}

export function executeGitAutoCommit(
  repoRoot: string,
  message: AutoCommitMessage,
  options: ExecuteGitAutoCommitOptions = {}
): GitAutoCommitResult {
  const result: GitAutoCommitResult = {
    success: false,
    staged: false,
    created: false,
    skipped: false,
    outcome: "failed",
  }

  try {
    runGit(repoRoot, ["rev-parse", "--git-dir"])

    runGit(repoRoot, ["add", "-A"])
    result.staged = true

    if (!hasStagedChangesToCommit(repoRoot)) {
      return {
        ...result,
        success: true,
        skipped: true,
        outcome: "skipped",
        ...(options.skipReason ? { reason: options.skipReason } : {}),
      }
    }

    const commitArgs = ["commit", "-m", message.title]
    if (message.body.trim().length > 0) {
      commitArgs.push("-m", message.body)
    }

    runGit(repoRoot, commitArgs)

    return {
      ...result,
      success: true,
      created: true,
      outcome: "committed",
      commitSha: getHeadCommitSha(repoRoot),
    }
  } catch (error) {
    return {
      ...result,
      error: (error as Error).message || String(error),
    }
  }
}
