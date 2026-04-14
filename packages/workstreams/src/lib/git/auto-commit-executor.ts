import { execFileSync } from "node:child_process"

import type { AutoCommitMessage } from "./auto-commit-message.ts"

export interface GitAutoCommitResult {
  success: boolean
  staged: boolean
  created: boolean
  skipped: boolean
  outcome: "committed" | "skipped" | "failed"
  commitSha?: string
  error?: string
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
  message: AutoCommitMessage
): GitAutoCommitResult {
  const result: GitAutoCommitResult = {
    success: false,
    staged: false,
    created: false,
    skipped: false,
    outcome: "failed",
  }

  try {
    runGit(repoRoot, ["add", "-A"])
    result.staged = true

    if (!hasStagedChangesToCommit(repoRoot)) {
      return {
        ...result,
        success: true,
        skipped: true,
        outcome: "skipped",
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
