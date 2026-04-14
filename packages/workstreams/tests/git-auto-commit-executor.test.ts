import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  executeGitAutoCommit,
  getHeadCommitSha,
} from "../src/lib/git/auto-commit-executor.ts"
import { createStageApprovalCommit } from "../src/lib/github/commits.ts"
import type { StreamMetadata } from "../src/lib/types.ts"

function createGitRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "work-git-auto-commit-"))

  execSync("git init", { cwd: repoRoot, stdio: "pipe" })
  execSync('git config user.name "Test User"', { cwd: repoRoot, stdio: "pipe" })
  execSync('git config user.email "test@example.com"', {
    cwd: repoRoot,
    stdio: "pipe",
  })

  writeFileSync(join(repoRoot, "README.md"), "# Test repo\n")
  execSync("git add README.md", { cwd: repoRoot, stdio: "pipe" })
  execSync('git commit -m "Initial commit"', { cwd: repoRoot, stdio: "pipe" })

  return repoRoot
}

function cleanupRepo(repoRoot: string): void {
  rmSync(repoRoot, { recursive: true, force: true })
}

describe("git auto commit executor", () => {
  test("creates commits after staging pending changes", () => {
    const repoRoot = createGitRepo()

    try {
      writeFileSync(join(repoRoot, "notes.txt"), "hello\n")

      const result = executeGitAutoCommit(repoRoot, {
        title: "workstream start",
        body: "Started workstream 001-test.\n\nStream-Id: 001-test",
      })

      expect(result).toMatchObject({
        success: true,
        staged: true,
        created: true,
        skipped: false,
        outcome: "committed",
      })
      expect(result.commitSha).toBeTruthy()

      const subject = execSync("git log -1 --pretty=%s", {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      const body = execSync("git log -1 --pretty=%b", {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()

      expect(subject).toBe("workstream start")
      expect(body).toContain("Started workstream 001-test.")
      expect(body).toContain("Stream-Id: 001-test")
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("skips commit creation when the tree is already clean", () => {
    const repoRoot = createGitRepo()

    try {
      const beforeSha = getHeadCommitSha(repoRoot)
      const result = executeGitAutoCommit(repoRoot, {
        title: "noop",
        body: "No changes.",
      })

      expect(result).toEqual({
        success: true,
        staged: true,
        created: false,
        skipped: true,
        outcome: "skipped",
      })
      expect(getHeadCommitSha(repoRoot)).toBe(beforeSha)
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("returns stage approval commit errors without throwing", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "work-stage-approval-failure-"))
    const stream: StreamMetadata = {
      id: "stream-001",
      name: "Approval Automation",
      order: 1,
      size: "short",
      session_estimated: {
        length: 1,
        unit: "session",
        session_minutes: [30, 45],
        session_iterations: [4, 8],
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      path: "work/stream-001",
      generated_by: {
        workstreams: "test",
      },
      approval: {
        status: "approved",
        stages: {
          1: {
            status: "approved",
            approved_at: new Date().toISOString(),
            approved_by: "user",
          },
        },
      },
    }

    try {
      const result = createStageApprovalCommit(repoRoot, stream, 1)

      expect(result.success).toBe(false)
      expect(result.outcome).toBe("failed")
      expect(result.error).toBeTruthy()
    } finally {
      cleanupRepo(repoRoot)
    }
  })
})
