import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as checkMain } from "../src/cli/check.ts"
import { main as previewMain } from "../src/cli/preview.ts"
import { main as validateMain } from "../src/cli/validate.ts"
import { consolidateStream, DRAFT_PLAN_NO_STAGES_WARNING } from "../src/lib/consolidate.ts"
import { loadIndex, saveIndex } from "../src/lib/index.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("draft plan semantics", () => {
  let repoRoot: string
  let planPath: string

  beforeEach(() => {
    repoRoot = join(tmpdir(), `workstreams-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    planPath = join(repoRoot, "work", "stream-draft", "PLAN.md")

    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(join(repoRoot, "work", "stream-draft"), { recursive: true })

    const index: WorkIndex = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      streams: [
        {
          id: "stream-draft",
          name: "draft-stream",
          order: 1,
          size: "short",
          session_estimated: {
            length: 2,
            unit: "session",
            session_minutes: [30, 45],
            session_iterations: [4, 8],
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          path: "work/stream-draft",
          generated_by: { workstreams: "1.0.0" },
        },
      ],
    }

    saveIndex(repoRoot, index)
    writeFileSync(
      planPath,
      `# Plan: draft-stream

## Summary

Initial draft summary.

## Stages

Stages will be added later.
`,
    )
  })

  afterEach(() => {
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true })
    }
    delete process.env.WORKSTREAM_ROLE
  })

  test("consolidateStream treats zero-stage plan as a draft warning", () => {
    const result = consolidateStream(repoRoot, "stream-draft", true)

    expect(result.success).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.streamDocument?.stages).toHaveLength(0)
    expect(result.warnings).toContain(DRAFT_PLAN_NO_STAGES_WARNING)
  })

  test("work validate plan succeeds and warns for draft plans", async () => {
    const { stdout, stderr } = await captureCliOutput(() => {
      validateMain(["node", "validate", "plan", "--stream", "stream-draft", "--repo-root", repoRoot])
    })

    expect(stderr).toHaveLength(0)
    expect(stdout.join("\n")).toContain("✓ PLAN.md validation passed")
    expect(stdout.join("\n")).toContain(DRAFT_PLAN_NO_STAGES_WARNING)
  })

  test("work check plan shows explicit draft messaging", async () => {
    const { stdout } = await captureCliOutput(() => {
      checkMain(["node", "check", "plan", "--stream", "stream-draft", "--repo-root", repoRoot])
    })

    const output = stdout.join("\n")
    expect(output).toContain("Draft plan: no stages defined yet.")
    expect(output).toContain("Warnings (1):")
  })

  test("work preview shows draft-friendly stage messaging", async () => {
    const { stdout } = await captureCliOutput(() => {
      previewMain(["node", "preview", "--stream", "stream-draft", "--repo-root", repoRoot])
    })

    const output = stdout.join("\n")
    expect(output).toContain("Workstream: draft-stream")
    expect(output).toContain("Draft plan: no stages defined yet")
    expect(output).toContain("Use 'work plan create' to scaffold stages.")
  })

  test("work approve plan blocks zero-stage draft plans", async () => {
    process.env.WORKSTREAM_ROLE = "USER"

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
          "plan",
          "--stream",
          "stream-draft",
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
    expect(stderr.join("\n")).toContain("Cannot approve a draft plan with no stages")
    expect(stderr.join("\n")).toContain("work plan create")
    expect(existsSync(join(repoRoot, "work", "stream-draft", "TASKS.md"))).toBe(false)

    const stream = loadIndex(repoRoot).streams[0]
    expect(stream?.approval?.status).toBeUndefined()
  })
})
