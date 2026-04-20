import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

import type { AutoCommitMessage } from "./auto-commit-message.ts"

export type GitAutoCommitSkipReason =
  | "no_tracked_approval_changes"
  | "unsafe_unrelated_tracked_changes"
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
  stagePaths?: string[]
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

function parseGitPathList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function isTrackedPath(repoRoot: string, gitPath: string): boolean {
  try {
    runGit(repoRoot, ["ls-files", "--error-unmatch", "--", gitPath])
    return true
  } catch {
    return false
  }
}

function isIgnoredPath(repoRoot: string, gitPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", gitPath], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    })
    return true
  } catch {
    return false
  }
}

function getStageablePaths(repoRoot: string, stagePaths: string[]): string[] {
  const uniquePaths = [...new Set(stagePaths)]

  return uniquePaths.filter((gitPath) => {
    if (isTrackedPath(repoRoot, gitPath)) {
      return true
    }

    const absolutePath = join(repoRoot, gitPath)
    if (!existsSync(absolutePath)) {
      return false
    }

    return !isIgnoredPath(repoRoot, gitPath)
  })
}

export function listTrackedDirtyFiles(repoRoot: string): string[] {
  const trackedDirtyPaths = new Set<string>()

  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
  ]) {
    try {
      const output = runGit(repoRoot, args)
      for (const gitPath of parseGitPathList(output)) {
        trackedDirtyPaths.add(gitPath)
      }
    } catch {
      // Ignore git diff errors and return best-effort results.
    }
  }

  return [...trackedDirtyPaths].sort((a, b) => a.localeCompare(b))
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

    const stagePaths = options.stagePaths
      ? getStageablePaths(repoRoot, options.stagePaths)
      : undefined

    if (stagePaths === undefined) {
      runGit(repoRoot, ["add", "-A"])
      result.staged = true
    } else if (stagePaths.length > 0) {
      runGit(repoRoot, ["add", "-A", "--", ...stagePaths])
      result.staged = true
    }

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
