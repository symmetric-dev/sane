import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { main as assignMain } from "../src/cli/assign.ts"
import { createEmptyTasksFile, getTasks, writeTasksFile } from "../src/lib/tasks.ts"

describe("assignments", () => {
  let tempDir: string
  let repoRoot: string
  const streamId = "001-test-stream"

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agenv-assignments-test-"))
    repoRoot = join(tempDir, "repo")
    mkdirSync(join(repoRoot, "work", streamId), { recursive: true })
    writeFileSync(
      join(repoRoot, "work", "index.json"),
      JSON.stringify({
        streams: [{ id: streamId, name: "test-stream", status: "active", relativePath: streamId }],
      }),
    )

    const tasksFile = createEmptyTasksFile(streamId)
    tasksFile.tasks = [
      {
        id: "01.01.01.01",
        name: "Task 1",
        thread_name: "T1",
        batch_name: "B01",
        stage_name: "S1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "pending",
      },
      {
        id: "01.01.01.02",
        name: "Task 2",
        thread_name: "T1",
        batch_name: "B01",
        stage_name: "S1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "pending",
      },
      {
        id: "01.01.02.01",
        name: "Task 3",
        thread_name: "T2",
        batch_name: "B01",
        stage_name: "S1",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "pending",
      },
    ]
    writeTasksFile(repoRoot, streamId, tasksFile)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function captureConsole() {
    const stdout: string[] = []
    const stderr: string[] = []
    const originalLog = console.log
    const originalError = console.error
    const originalExit = process.exit

    console.log = (...args) => stdout.push(args.join(" "))
    console.error = (...args) => stderr.push(args.join(" "))
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`)
    }) as typeof process.exit

    return {
      stdout,
      stderr,
      restore: () => {
        console.log = originalLog
        console.error = originalError
        process.exit = originalExit
      },
    }
  }

  test("assign --thread canonically assigns the whole thread", async () => {
    const output = captureConsole()

    try {
      await assignMain([
        "bun",
        "work",
        "assign",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--thread",
        "01.01.01",
        "--agent",
        "CodebaseAgent",
      ])
    } finally {
      output.restore()
    }

    const tasks = getTasks(repoRoot, streamId)
    expect(tasks.find((task) => task.id === "01.01.01.01")?.assigned_agent).toBe("CodebaseAgent")
    expect(tasks.find((task) => task.id === "01.01.01.02")?.assigned_agent).toBe("CodebaseAgent")
    expect(tasks.find((task) => task.id === "01.01.02.01")?.assigned_agent).toBeUndefined()
    expect(output.stdout.join("\n")).toContain('Assigned "CodebaseAgent" to thread 01.01.01')
  })

  test("assign --task is a compatibility alias for assigning the owning thread", async () => {
    const output = captureConsole()

    try {
      await assignMain([
        "bun",
        "work",
        "assign",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--task",
        "01.01.01.02",
        "--agent",
        "CodebaseAgent",
      ])
    } finally {
      output.restore()
    }

    const tasks = getTasks(repoRoot, streamId)
    expect(tasks.find((task) => task.id === "01.01.01.01")?.assigned_agent).toBe("CodebaseAgent")
    expect(tasks.find((task) => task.id === "01.01.01.02")?.assigned_agent).toBe("CodebaseAgent")
    expect(tasks.find((task) => task.id === "01.01.02.01")?.assigned_agent).toBeUndefined()
    expect(output.stdout.join("\n")).toContain(
      'Assigned "CodebaseAgent" to thread 01.01.01 via compatibility task 01.01.01.02',
    )
  })

  test("assign --task --clear clears the owning thread assignment", async () => {
    const seed = getTasks(repoRoot, streamId).map((task) => ({
      ...task,
      ...(task.id.startsWith("01.01.01.") ? { assigned_agent: "CodebaseAgent" } : {}),
    }))
    writeTasksFile(repoRoot, streamId, {
      ...createEmptyTasksFile(streamId),
      tasks: seed,
    })

    const output = captureConsole()

    try {
      await assignMain([
        "bun",
        "work",
        "assign",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--task",
        "01.01.01.01",
        "--clear",
      ])
    } finally {
      output.restore()
    }

    const tasks = getTasks(repoRoot, streamId)
    expect(tasks.find((task) => task.id === "01.01.01.01")?.assigned_agent).toBeUndefined()
    expect(tasks.find((task) => task.id === "01.01.01.02")?.assigned_agent).toBeUndefined()
    expect(output.stdout.join("\n")).toContain(
      "Cleared agent assignment from thread 01.01.01 via compatibility task 01.01.01.01",
    )
  })
})
