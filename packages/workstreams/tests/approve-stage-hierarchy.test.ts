import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as approveMain } from "../src/cli/approve/index.ts"
import { loadIndex, saveIndex } from "../src/lib/index.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("work approve stage hierarchy validation", () => {
  let repoRoot: string
  let tasksPath: string

  beforeEach(() => {
    repoRoot = join(tmpdir(), `workstreams-approve-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    tasksPath = join(repoRoot, "work", "stream-approve", "tasks.json")

    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(join(repoRoot, "work", "stream-approve"), { recursive: true })

    const index: WorkIndex = {
      version: "1.0.0",
      last_updated: "2026-04-22T00:00:00.000Z",
      streams: [
        {
          id: "stream-approve",
          name: "approve-stream",
          order: 1,
          size: "short",
          session_estimated: {
            length: 2,
            unit: "session",
            session_minutes: [30, 45],
            session_iterations: [4, 8],
          },
          created_at: "2026-04-22T00:00:00.000Z",
          updated_at: "2026-04-22T00:00:00.000Z",
          path: "work/stream-approve",
          generated_by: { workstreams: "1.0.0" },
        },
      ],
    }

    saveIndex(repoRoot, index)
    writeFileSync(join(repoRoot, "work", "stream-approve", "PLAN.md"), "# Plan: approve-stream")
    writeFileSync(
      tasksPath,
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: "stream-approve",
          last_updated: "2026-04-22T00:00:00.000Z",
          tasks: [
            {
              id: "01.01.01.01",
              name: "Only stage task",
              stage_name: "Stage 01",
              batch_name: "Batch 01",
              thread_name: "Thread 01",
              status: "completed",
              created_at: "2026-04-22T00:00:00.000Z",
              updated_at: "2026-04-22T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    )

    process.env.WORKSTREAM_ROLE = "USER"
  })

  afterEach(() => {
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true })
    }

    delete process.env.WORKSTREAM_ROLE
  })

  test("fails without mutating approval state when the stage does not exist", async () => {
    const beforeIndex = loadIndex(repoRoot)
    const beforeTasks = readFileSync(tasksPath, "utf-8")

    const originalExit = process.exit
    let exitCode: number | undefined
    process.exit = ((code?: number) => {
      exitCode = code ?? 0
      throw new Error(`Process exited with code ${code}`)
    }) as typeof process.exit

    const { stdout, stderr } = await captureCliOutput(async () => {
      try {
        await approveMain([
          "node",
          "approve",
          "stage",
          "99",
          "--stream",
          "stream-approve",
          "--repo-root",
          repoRoot,
        ])
      } catch {
        // expected from mocked process.exit
      } finally {
        process.exit = originalExit
      }
    })

    expect(exitCode).toBe(1)
    expect(stdout).toHaveLength(0)
    expect(stderr.join("\n")).toContain("Stage 99 does not exist in the workstream hierarchy")
    expect(loadIndex(repoRoot)).toEqual(beforeIndex)
    expect(readFileSync(tasksPath, "utf-8")).toBe(beforeTasks)
  })
})
