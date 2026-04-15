import { describe, expect, test } from "bun:test"
import { join } from "path"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { main } from "../src/cli/list.ts"
import { createEmptyTasksFile, writeTasksFile } from "../src/lib/tasks.ts"
import type { Task, TasksFile } from "../src/lib/types"
import { runCliCommand } from "./helpers/cli-runner"

const STREAM_ID = "001-test-stream"

function setupWorkspace(): {
  testDir: string
  repoRoot: string
  workDir: string
  cleanup: () => void
} {
  const testDir = mkdtempSync(join(tmpdir(), "agenv-list-test-"))
  const repoRoot = join(testDir, "repo")
  const workDir = join(repoRoot, "work")
  mkdirSync(join(workDir, STREAM_ID), { recursive: true })

  writeFileSync(
    join(workDir, "index.json"),
    JSON.stringify({
      streams: [
        {
          id: STREAM_ID,
          name: "Test Stream",
          status: "active",
          relativePath: STREAM_ID,
        },
      ],
    }),
  )

  const tasksFile = createEmptyTasksFile(STREAM_ID)
  tasksFile.tasks = [
    {
      id: "01.01.01.01",
      name: "Task 1",
      status: "pending",
      stage_name: "Stage 1",
      batch_name: "Batch 1",
      thread_name: "Thread 1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: "01.01.02.01",
      name: "Task 2",
      status: "in_progress",
      stage_name: "Stage 1",
      batch_name: "Batch 1",
      thread_name: "Thread 2",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: "01.02.01.01",
      name: "Task 3 (Batch 2)",
      status: "pending",
      stage_name: "Stage 1",
      batch_name: "Batch 2",
      thread_name: "Thread 1 of Batch 2",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: "02.01.01.01",
      name: "Task 4 (Stage 2)",
      status: "pending",
      stage_name: "Stage 2",
      batch_name: "Batch 1",
      thread_name: "Thread 1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]
  writeTasksFile(repoRoot, STREAM_ID, tasksFile)

  return {
    testDir,
    repoRoot,
    workDir,
    cleanup: () => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    },
  }
}

function captureConsole(): {
  logOutput: string[]
  errorOutput: string[]
  restore: () => void
} {
  const logOutput: string[] = []
  const errorOutput: string[] = []
  const originalLog = console.log
  const originalError = console.error

  console.log = (msg: string) => logOutput.push(msg)
  console.error = (msg: string) => errorOutput.push(msg)

  return {
    logOutput,
    errorOutput,
    restore: () => {
      console.log = originalLog
      console.error = originalError
    },
  }
}

describe("CLI: List Tasks with Filtering", () => {
  test("should list all tasks when no filters provided", () => {
    const workspace = setupWorkspace()
    const output = captureConsole()

    try {
      main(["node", "work", "list", "--repo-root", workspace.repoRoot, "--stream", STREAM_ID, "--json"])
      const parsed = JSON.parse(output.logOutput[0] || "[]")
      expect(parsed.length).toBe(4)
    } finally {
      output.restore()
      workspace.cleanup()
    }
  })

  test("should filter by stage", () => {
    const workspace = setupWorkspace()
    const output = captureConsole()

    try {
      main([
        "node", "work", "list",
        "--repo-root", workspace.repoRoot,
        "--stream", STREAM_ID,
        "--stage", "1",
        "--json",
      ])
      const parsed = JSON.parse(output.logOutput[0] || "[]")
      expect(parsed.length).toBe(3)
      expect(parsed.every((task: any) => task.id.startsWith("01."))).toBe(true)
    } finally {
      output.restore()
      workspace.cleanup()
    }
  })

  test("should filter by batch", () => {
    const workspace = setupWorkspace()
    const output = captureConsole()

    try {
      main([
        "node", "work", "list",
        "--repo-root", workspace.repoRoot,
        "--stream", STREAM_ID,
        "--batch", "01.01",
        "--json",
      ])
      const parsed = JSON.parse(output.logOutput[0] || "[]")
      expect(parsed.length).toBe(2)
      expect(parsed.every((task: any) => task.id.startsWith("01.01."))).toBe(true)
    } finally {
      output.restore()
      workspace.cleanup()
    }
  })

  test("should filter by thread", () => {
    const workspace = setupWorkspace()
    const output = captureConsole()

    try {
      main([
        "node", "work", "list",
        "--repo-root", workspace.repoRoot,
        "--stream", STREAM_ID,
        "--thread", "01.01.02",
        "--json",
      ])
      const parsed = JSON.parse(output.logOutput[0] || "[]")
      expect(parsed.length).toBe(1)
      expect(parsed[0].id).toBe("01.01.02.01")
    } finally {
      output.restore()
      workspace.cleanup()
    }
  })

  test("should return empty list if no tasks match filter", () => {
    const workspace = setupWorkspace()
    const output = captureConsole()

    try {
      main([
        "node", "work", "list",
        "--repo-root", workspace.repoRoot,
        "--stream", STREAM_ID,
        "--batch", "99.99",
        "--json",
      ])
      expect(output.logOutput[0] || "").toContain("No tasks found")
    } finally {
      output.restore()
      workspace.cleanup()
    }
  })

  test("should display correct hierarchy in text output", () => {
    const workspace = setupWorkspace()
    const output = captureConsole()

    try {
      main([
        "node", "work", "list",
        "--repo-root", workspace.repoRoot,
        "--stream", STREAM_ID,
      ])

      const rendered = output.logOutput.join("\n")
      expect(rendered).toContain("Stage 01: Stage 1")
      expect(rendered).toContain("  Batch 01: Batch 1")
      expect(rendered).toContain("    Thread 01: Thread 1")
      expect(rendered).toContain("    Thread 02: Thread 2")
      expect(rendered).toContain("  Batch 02: Batch 2")
      expect(rendered).toContain("    Thread 01: Thread 1 of Batch 2")
    } finally {
      output.restore()
      workspace.cleanup()
    }
  })

  test("shows supervision branch runtime context in text output", async () => {
    const workspace = setupWorkspace()

    try {
      const tasksFile = createEmptyTasksFile(STREAM_ID) as TasksFile
      tasksFile.tasks = [
        {
          id: "01.01.01.01",
          name: "Task 1",
          status: "pending",
          stage_name: "Stage 1",
          batch_name: "Batch 1",
          thread_name: "Thread 1",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]
      tasksFile.runtime_summary = {
        updated_at: new Date().toISOString(),
        batches: {},
        supervision: {
          updated_at: new Date().toISOString(),
          current_branch: {
            stage_id: "01",
            batch_id: "01.01",
            current_batch_id: "01.01",
            status: "running",
            branch_session_id: "branch-session-1",
            root_session_id: "root-session-1",
            updated_at: new Date().toISOString(),
          },
        },
      }

      writeTasksFile(workspace.repoRoot, STREAM_ID, tasksFile)

      const result = await runCliCommand(
        "bun",
        ["run", "src/cli/list.ts", "--repo-root", workspace.repoRoot, "--stream", STREAM_ID],
        join(import.meta.dir, ".."),
      )

      expect(result.stdout).toContain("Runtime: supervision branch running on 01.01")
    } finally {
      workspace.cleanup()
    }
  })

  test("falls back to projected runtime summary for older tasks.json", async () => {
    const workspace = setupWorkspace()

    try {
      mkdirSync(join(workspace.workDir, STREAM_ID, "batch-status"), { recursive: true })
      writeFileSync(
        join(workspace.workDir, STREAM_ID, "batch-status", "01.01.json"),
        JSON.stringify(
          {
            version: "1.0.0",
            streamId: STREAM_ID,
            batchId: "01.01",
            runId: "run-1",
            mode: "headless",
            status: "running",
            stageName: "Stage 1",
            batchName: "Batch 1",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            summary: {
              total: 2,
              pending: 1,
              running: 1,
              completed: 0,
              failed: 0,
            },
            threads: [],
          },
          null,
          2,
        ),
      )

      const tasks: Task[] = [
        {
          id: "01.01.01.01",
          name: "Task 1",
          status: "pending",
          stage_name: "Stage 1",
          batch_name: "Batch 1",
          thread_name: "Thread 1",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: "01.01.02.01",
          name: "Task 2",
          status: "in_progress",
          stage_name: "Stage 1",
          batch_name: "Batch 1",
          thread_name: "Thread 2",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]

      const tasksFile = createEmptyTasksFile(STREAM_ID)
      tasksFile.tasks = tasks
      writeTasksFile(workspace.repoRoot, STREAM_ID, tasksFile)

      const result = await runCliCommand(
        "bun",
        ["run", "src/cli/list.ts", "--repo-root", workspace.repoRoot, "--stream", STREAM_ID],
        join(import.meta.dir, ".."),
      )

      expect(result.stdout).toContain("Runtime: 01.01 tasks in progress vs runtime running")
    } finally {
      workspace.cleanup()
    }
  })
})
