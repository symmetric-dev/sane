import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { main } from "../src/cli/read.ts"
import { createEmptyTasksFile, writeTasksFile } from "../src/lib/tasks.ts"

const STREAM_ID = "001-read-stream"

function setupWorkspace() {
  const testDir = mkdtempSync(join(tmpdir(), "agenv-read-test-"))
  const repoRoot = join(testDir, "repo")
  const workDir = join(repoRoot, "work")
  mkdirSync(join(workDir, STREAM_ID), { recursive: true })

  writeFileSync(
    join(workDir, "index.json"),
    JSON.stringify({
      streams: [{ id: STREAM_ID, name: "Read Stream", status: "active", relativePath: STREAM_ID }],
    }),
  )

  const tasksFile = createEmptyTasksFile(STREAM_ID)
  tasksFile.tasks = [
    {
      id: "01.01.01.01",
      name: "Compatibility task",
      status: "in_progress",
      stage_name: "Stage 1",
      batch_name: "Batch 1",
      thread_name: "Thread 1",
      assigned_agent: "reader",
      breadcrumb: "resume from sqlite thread projection",
      report: "Compatibility view kept in sync with thread mutation.",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]
  writeTasksFile(repoRoot, STREAM_ID, tasksFile)

  return {
    repoRoot,
    cleanup: () => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true })
      }
    },
  }
}

function captureConsole() {
  const logOutput: string[] = []
  const errorOutput: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit

  console.log = (msg: string) => logOutput.push(msg)
  console.error = (msg: string) => errorOutput.push(msg)
  process.exit = ((code?: number) => {
    throw new Error(`Process exited with code ${code ?? 0}`)
  }) as typeof process.exit

  return {
    logOutput,
    errorOutput,
    restore: () => {
      console.log = originalLog
      console.error = originalError
      process.exit = originalExit
    },
  }
}

describe("CLI: Read", () => {
  test("reads thread details by primary --thread mode", () => {
    const workspace = setupWorkspace()
    const output = captureConsole()

    try {
      main(["node", "work", "read", "--repo-root", workspace.repoRoot, "--stream", STREAM_ID, "--thread", "01.01.01"])
      const rendered = output.logOutput.join("\n")
      expect(rendered).toContain("Thread 01.01.01: Thread 1")
      expect(rendered).toContain("Status: in_progress")
      expect(rendered).toContain("Task count: 1")
      expect(rendered).toContain("Assigned agent: reader")
      expect(rendered).toContain("Breadcrumb: resume from sqlite thread projection")
      expect(rendered).toContain("Report: Compatibility view kept in sync with thread mutation.")
      expect(rendered).toContain("Compatibility task: 01.01.01.01")
    } finally {
      output.restore()
      workspace.cleanup()
    }
  })

  test("keeps compatibility task reads with --task", () => {
    const workspace = setupWorkspace()
    const output = captureConsole()

    try {
      main(["node", "work", "read", "--repo-root", workspace.repoRoot, "--stream", STREAM_ID, "--task", "01.01.01.01"])
      const rendered = output.logOutput.join("\n")
      expect(rendered).toContain("Task 01.01.01.01: Compatibility task")
      expect(rendered).toContain("Thread: Thread 1")
    } finally {
      output.restore()
      workspace.cleanup()
    }
  })
})
