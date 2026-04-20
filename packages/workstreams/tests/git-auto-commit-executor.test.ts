import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  executeGitAutoCommit,
  getHeadCommitSha,
} from "../src/lib/git/auto-commit-executor.ts"
import {
  createPlanApprovalCommit,
  createStageApprovalCommit,
  createTasksApprovalCommit,
} from "../src/lib/github/commits.ts"
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
      mkdirSync(join(repoRoot, "work", "stream-001"), { recursive: true })
      writeFileSync(join(repoRoot, "work", "stream-001", "PLAN.md"), [
        "# Plan: Approval Automation",
        "",
        "## Summary",
        "Trusted naming should still surface git failures.",
        "",
        "## Stages",
        "",
        "### Stage 1: Shared Auto-Commit Infrastructure",
      ].join("\n"))

      const result = createStageApprovalCommit(repoRoot, stream, 1)

      expect(result.success).toBe(false)
      expect(result.outcome).toBe("failed")
      expect(result.error).toBeTruthy()
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("creates plan approval commits using resolved plan names", () => {
    const repoRoot = createGitRepo()
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
      },
    }

    try {
      mkdirSync(join(repoRoot, "work", "stream-001"), { recursive: true })
      writeFileSync(join(repoRoot, "work", "stream-001", "PLAN.md"), [
        "# Plan: Resolved Plan Name",
        "",
        "## Summary",
        "Testing resolved names.",
      ].join("\n"))

      const result = createPlanApprovalCommit(repoRoot, stream)

      expect(result).toMatchObject({
        success: true,
        created: true,
        skipped: false,
        outcome: "committed",
      })

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

      expect(subject).toBe("Plan approved: Resolved Plan Name")
      expect(body).toContain("Approved plan for workstream stream-001.")
      expect(body).toContain("Stream-Name: Resolved Plan Name")
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("skips plan approval commits when no changes exist", () => {
    const repoRoot = createGitRepo()
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
      },
    }

    try {
      const beforeSha = getHeadCommitSha(repoRoot)
      const result = createPlanApprovalCommit(repoRoot, stream)

      expect(result).toMatchObject({
        success: true,
        created: false,
        skipped: true,
        outcome: "skipped",
      })
      expect(getHeadCommitSha(repoRoot)).toBe(beforeSha)
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("creates tasks approval commits with task count trailers", () => {
    const repoRoot = createGitRepo()
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
      },
    }

    try {
      mkdirSync(join(repoRoot, "work", "stream-001"), { recursive: true })
      writeFileSync(join(repoRoot, "work", "stream-001", "PLAN.md"), [
        "# Plan: Resolved Stream Name",
        "",
        "## Summary",
        "Testing resolved names.",
        "",
        "## Stages",
        "",
        "### Stage 1: Stage One",
        "",
        "Test stage.",
      ].join("\n"))
      writeFileSync(join(repoRoot, "work", "stream-001", "tasks.json"), '{"tasks":[]}\n')

      const result = createTasksApprovalCommit(repoRoot, stream, 3)

      expect(result).toMatchObject({
        success: true,
        created: true,
        skipped: false,
        outcome: "committed",
      })

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

      expect(subject).toBe("Tasks approved: Resolved Stream Name")
      expect(body).toContain("Approved 3 tasks for workstream stream-001.")
      expect(body).toContain("Stream-Name: Resolved Stream Name")
      expect(body).toContain("Task-Count: 3")
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("skips plan approval commits when stream naming falls back from PLAN.md", () => {
    const repoRoot = createGitRepo()
    const stream: StreamMetadata = {
      id: "stream-001",
      name: "Synthetic Stream Name",
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
      },
    }

    try {
      mkdirSync(join(repoRoot, "work", "stream-001"), { recursive: true })
      writeFileSync(join(repoRoot, "work", "index.json"), '{"approval":true}\n')
      writeFileSync(join(repoRoot, "work", "stream-001", "PLAN.md"), [
        "# Invalid Plan Header",
        "",
        "## Summary",
        "Fallback stream naming should not auto-commit.",
      ].join("\n"))

      const beforeSha = getHeadCommitSha(repoRoot)
      const result = createPlanApprovalCommit(repoRoot, stream)

      expect(result).toMatchObject({
        success: true,
        created: false,
        skipped: true,
        outcome: "skipped",
        reason: "unsafe_fallback_stream_name",
      })
      expect(getHeadCommitSha(repoRoot)).toBe(beforeSha)
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("skips tasks approval commits when stream naming falls back from PLAN.md", () => {
    const repoRoot = createGitRepo()
    const stream: StreamMetadata = {
      id: "stream-001",
      name: "Synthetic Stream Name",
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
      },
    }

    try {
      mkdirSync(join(repoRoot, "work", "stream-001"), { recursive: true })
      writeFileSync(join(repoRoot, "work", "index.json"), '{"approval":true}\n')
      writeFileSync(join(repoRoot, "work", "stream-001", "tasks.json"), '{"tasks":[]}\n')
      writeFileSync(join(repoRoot, "work", "stream-001", "PLAN.md"), [
        "# Invalid Plan Header",
        "",
        "## Summary",
        "Fallback stream naming should not auto-commit.",
      ].join("\n"))

      const beforeSha = getHeadCommitSha(repoRoot)
      const result = createTasksApprovalCommit(repoRoot, stream, 1)

      expect(result).toMatchObject({
        success: true,
        created: false,
        skipped: true,
        outcome: "skipped",
        reason: "unsafe_fallback_stream_name",
      })
      expect(getHeadCommitSha(repoRoot)).toBe(beforeSha)
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("skips stage approval auto-commit when unrelated tracked files are already dirty", () => {
    const repoRoot = createGitRepo()
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
      const beforeSha = getHeadCommitSha(repoRoot)
      mkdirSync(join(repoRoot, "work", "stream-001"), { recursive: true })
      writeFileSync(join(repoRoot, "work", "index.json"), '{"approval":true}\n')
      writeFileSync(join(repoRoot, "work", "stream-001", "PLAN.md"), [
        "# Plan: Approval Automation",
        "",
        "## Summary",
        "Trusted naming should still enforce dirty-file safety.",
        "",
        "## Stages",
        "",
        "### Stage 1: Shared Auto-Commit Infrastructure",
      ].join("\n"))
      writeFileSync(join(repoRoot, "README.md"), "# Dirty tracked change\n")

      const result = createStageApprovalCommit(repoRoot, stream, 1, {
        trackedDirtyBeforeApproval: ["README.md"],
      })

      expect(result).toMatchObject({
        success: true,
        created: false,
        skipped: true,
        outcome: "skipped",
        reason: "unsafe_unrelated_tracked_changes",
        files: ["README.md"],
      })
      expect(getHeadCommitSha(repoRoot)).toBe(beforeSha)
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("skips stage approval commits when stage naming falls back to default resolution", () => {
    const repoRoot = createGitRepo()
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
      mkdirSync(join(repoRoot, "work", "stream-001"), { recursive: true })
      writeFileSync(join(repoRoot, "work", "index.json"), '{"approval":true}\n')
      writeFileSync(join(repoRoot, "work", "stream-001", "PLAN.md"), [
        "# Plan: Approval Automation",
        "",
        "## Summary",
        "Missing stage name should block auto-commit naming.",
        "",
        "## Stages",
        "",
        "### Stage 1:",
      ].join("\n"))

      const beforeSha = getHeadCommitSha(repoRoot)
      const result = createStageApprovalCommit(repoRoot, stream, 1)

      expect(result).toMatchObject({
        success: true,
        created: false,
        skipped: true,
        outcome: "skipped",
        reason: "unsafe_fallback_stage_name",
      })
      expect(getHeadCommitSha(repoRoot)).toBe(beforeSha)
    } finally {
      cleanupRepo(repoRoot)
    }
  })

  test("skips plan approval auto-commit when approval only changes ignored metadata", () => {
    const repoRoot = createGitRepo()
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
      },
    }

    try {
      writeFileSync(join(repoRoot, ".gitignore"), "work/\n")
      execSync("git add .gitignore && git commit -m \"ignore work\"", {
        cwd: repoRoot,
        stdio: "pipe",
      })
      const beforeSha = getHeadCommitSha(repoRoot)

      mkdirSync(join(repoRoot, "work", "stream-001"), { recursive: true })
      writeFileSync(join(repoRoot, "work", "index.json"), '{"approval":true}\n')
      writeFileSync(join(repoRoot, "work", "stream-001", "PLAN.md"), "# Plan: Ignored\n")
      writeFileSync(join(repoRoot, "work", "stream-001", "TASKS.md"), "# Tasks\n")

      const result = createPlanApprovalCommit(repoRoot, stream)

      expect(result).toMatchObject({
        success: true,
        created: false,
        skipped: true,
        outcome: "skipped",
        reason: "no_tracked_approval_changes",
      })
      expect(getHeadCommitSha(repoRoot)).toBe(beforeSha)
    } finally {
      cleanupRepo(repoRoot)
    }
  })
})
