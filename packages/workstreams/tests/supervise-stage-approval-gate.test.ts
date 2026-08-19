import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as createMain } from "../src/cli/create.ts"
import { main as planMain } from "../src/cli/plan.ts"
import { main as superviseMain } from "../src/cli/supervise.ts"
import { main as updateMain } from "../src/cli/update.ts"
import { approveStage } from "../src/lib/approval.ts"

async function captureCliOutputAndExit(fn: () => Promise<void> | void): Promise<{
  stdout: string[]
  stderr: string[]
  exitCode: number | undefined
}> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit
  let exitCode: number | undefined

  console.log = (...args: any[]) => stdout.push(args.map((value) => String(value)).join(" "))
  console.error = (...args: any[]) => stderr.push(args.map((value) => String(value)).join(" "))
  process.exit = ((code?: string | number | null | undefined) => {
    exitCode = typeof code === "number" ? code : code ? Number(code) : 0
    throw new Error("__PROCESS_EXIT__")
  }) as typeof process.exit

  try {
    await fn()
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__PROCESS_EXIT__") {
      throw error
    }
  } finally {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
  }

  return { stdout, stderr, exitCode }
}

function writeTwoStagePlanFiles(repoRoot: string, streamId: string): void {
  writeFileSync(
    join(repoRoot, `work/${streamId}/README.md`),
    `# Supervise Approval Gate

## Summary

Validate previous-stage approval gating for supervise.
`,
  )

  writeFileSync(
    join(repoRoot, `work/${streamId}/stages/01/PLAN.md`),
    `# Stage 01 Plan

## Summary

Stage 01 summary.

## References

- \`packages/workstreams/src/cli/supervise.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Stage one batch

Stage 01 batch summary.

#### Thread 01: Stage one thread

**Summary:**
Stage one thread summary.

**Details:**
Stage one thread details.
`,
  )

  writeFileSync(
    join(repoRoot, `work/${streamId}/stages/02/PLAN.md`),
    `# Stage 02 Plan

## Summary

Stage 02 summary.

## References

- \`packages/workstreams/src/cli/supervise.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Stage two batch

Stage 02 batch summary.

#### Thread 01: Stage two thread

**Summary:**
Stage two thread summary.

**Details:**
Stage two thread details.
`,
  )

  mkdirSync(join(repoRoot, `work/${streamId}/stages/01/threads/01.01.01`), { recursive: true })
  mkdirSync(join(repoRoot, `work/${streamId}/stages/02/threads/02.01.01`), { recursive: true })
  writeFileSync(
    join(repoRoot, `work/${streamId}/stages/01/threads/01.01.01/WORK.md`),
    "# Thread 01.01.01\n",
  )
  writeFileSync(
    join(repoRoot, `work/${streamId}/stages/02/threads/02.01.01/WORK.md`),
    "# Thread 02.01.01\n",
  )
}

async function createApprovedTwoStageWorkstream(repoRoot: string): Promise<string> {
  const streamId = "000-supervise-approval-gate"

  createMain(["bun", "work-create", "--name", "supervise-approval-gate", "--repo-root", repoRoot])
  planMain([
    "bun",
    "work-plan",
    "create",
    "--stream",
    streamId,
    "--stages",
    "2",
    "--repo-root",
    repoRoot,
  ])
  writeTwoStagePlanFiles(repoRoot, streamId)

  await approveMain([
    "bun",
    "work-approve",
    "plan",
    "--stream",
    streamId,
    "--repo-root",
    repoRoot,
  ])

  return streamId
}

describe("supervise previous-stage approval gate", () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "agenv-supervise-approval-gate-"))
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    process.env.WORKSTREAM_ROLE = "USER"
  })

  afterEach(() => {
    delete process.env.WORKSTREAM_ROLE
    rmSync(repoRoot, { recursive: true, force: true })
  })

  test("rejects SDK stage-2 launch without stage-1 approval with the exact multi error", async () => {
    const streamId = await createApprovedTwoStageWorkstream(repoRoot)

    const { stderr, exitCode } = await captureCliOutputAndExit(() =>
      superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--batch",
        "02.01",
        "--execution-backend",
        "sdk",
        "--dry-run",
      ]),
    )

    expect(exitCode).toBe(1)
    expect(stderr.join("\n")).toContain("Error: Previous stage (Stage 1) is not approved.")
    expect(stderr.join("\n")).toContain("Run: work approve stage 1")
  })

  test("allows SDK stage-2 dry-run when stage-1 is approved", async () => {
    const streamId = await createApprovedTwoStageWorkstream(repoRoot)
    approveStage(repoRoot, streamId, 1, "test")

    const { stderr, stdout, exitCode } = await captureCliOutputAndExit(() =>
      superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--batch",
        "02.01",
        "--execution-backend",
        "sdk",
        "--dry-run",
      ]),
    )

    expect(exitCode).toBeUndefined()
    expect(stderr.join("\n")).not.toContain("Error: Previous stage (Stage 1) is not approved.")
    expect(stdout.join("\n")).toContain("would launch batch 02.01")
    expect(stdout.join("\n")).toContain("work-sdk batch-executor --execution-backend sdk")
  })

  test("allows SDK stage-1 launch without any stage approval", async () => {
    const streamId = await createApprovedTwoStageWorkstream(repoRoot)

    const { stderr, stdout, exitCode } = await captureCliOutputAndExit(() =>
      superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--batch",
        "01.01",
        "--execution-backend",
        "sdk",
        "--dry-run",
      ]),
    )

    expect(exitCode).toBeUndefined()
    expect(stderr.join("\n")).not.toContain("Error: Previous stage")
    expect(stdout.join("\n")).toContain("would launch batch 01.01")
  })

  test("rejects explicit legacy supervise without stage-1 approval", async () => {
    const streamId = await createApprovedTwoStageWorkstream(repoRoot)

    const { stderr, exitCode } = await captureCliOutputAndExit(() =>
      superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--batch",
        "02.01",
        "--execution-backend",
        "legacy",
        "--dry-run",
      ]),
    )

    expect(exitCode).toBe(1)
    expect(stderr.join("\n")).toContain("Error: Previous stage (Stage 1) is not approved.")
  })

  test("allows work update thread status without previous-stage approval", async () => {
    const streamId = await createApprovedTwoStageWorkstream(repoRoot)

    const { stderr, exitCode } = await captureCliOutputAndExit(() =>
      updateMain([
        "bun",
        "work-update",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--thread",
        "02.01.01",
        "--status",
        "in_progress",
      ]),
    )

    expect(exitCode).toBeUndefined()
    expect(stderr.join("\n")).not.toContain("Error: Previous stage")
  })
})
