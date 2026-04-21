import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as currentMain } from "../src/cli/current.ts"
import { main as initMain } from "../src/cli/init.ts"
import { main as rebuildCompatMain } from "../src/cli/rebuild-compat.ts"
import { main as resetBatchStateMain } from "../src/cli/reset-batch-state.ts"
import { main as revisionMain } from "../src/cli/revision.ts"
import { main as updateTaskMain } from "../src/cli/update-task.ts"
import { loadIndex } from "../src/lib/index.ts"
import { getStructuredStorageSqlitePath } from "../src/lib/sqlite-storage.ts"
import { inspectCriticalWorkflowDualWriteParitySync } from "../src/lib/storage-adapter.ts"
import { createBatchStatusFile, writeBatchStatus } from "../src/lib/batch-status.ts"
import { createEmptySupervisorState, saveSupervisorState } from "../src/lib/supervisor-state.ts"
import { readTasksFile, writeTasksFile } from "../src/lib/tasks.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

async function runCliSafely(fn: () => Promise<void> | void): Promise<{
  stdout: string[]
  stderr: string[]
  exitCode: number | null
}> {
  const originalExit = process.exit
  let exitCode: number | null = null

  process.exit = ((code?: number) => {
    exitCode = code ?? 0
    throw new Error(`process.exit:${exitCode}`)
  }) as typeof process.exit

  try {
    const output = await captureCliOutput(async () => {
      try {
        await fn()
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("process.exit:")) {
          return
        }
        throw error
      }
    })

    return { ...output, exitCode }
  } finally {
    process.exit = originalExit
  }
}

function writeValidPlan(streamDir: string): void {
  writeFileSync(
    join(streamDir, "PLAN.md"),
    `# Plan: sqlite-regression

## Summary

Validate sqlite-authoritative command lifecycle behavior.

## References

- \`README.md\`

## Stages

### Stage 01: Core Lifecycle

#### Stage Definition

Exercise lifecycle transitions end-to-end.

#### Stage Constitution

Follow command and parity workflows.

#### Stage Questions

- [x] Any open questions? → No.

#### Stage Batches

##### Batch 01: Regression coverage

###### Thread 01: Command and lifecycle regression

**Summary:**
Cover the sqlite-authoritative lifecycle.

**Details:**
- Verify init/bootstrap and approvals.
- Verify updates, revision, supervision recovery, and parity helpers.
`,
  )
}

function writeTasksMd(streamDir: string, streamId: string): void {
  writeFileSync(
    join(streamDir, "TASKS.md"),
    `# Tasks: ${streamId}

## Stage 01: Core Lifecycle

### Batch 01: Regression coverage

#### Thread 01: Command and lifecycle regression @agent:default
- [ ] Task 01.01.01.01: Validate sqlite-authoritative lifecycle transitions
`,
  )
}

function writeLegacyIndex(repoRoot: string, streamId: string): void {
  writeFileSync(
    join(repoRoot, "work", "index.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        last_updated: "2026-04-20T00:00:00.000Z",
        streams: [
          {
            id: streamId,
            name: "sqlite-regression",
            order: 1,
            size: "short",
            session_estimated: {
              length: 1,
              unit: "session",
              session_minutes: [30, 45],
              session_iterations: [4, 8],
            },
            created_at: "2026-04-20T00:00:00.000Z",
            updated_at: "2026-04-20T00:00:00.000Z",
            path: `work/${streamId}`,
            generated_by: { workstreams: "test" },
          },
        ],
      },
      null,
      2,
    ),
  )
}

describe("sqlite-authoritative workflow lifecycle regression", () => {
  const originalRole = process.env.WORKSTREAM_ROLE
  let repoRoot = ""
  let streamId = ""

  afterEach(() => {
    if (originalRole === undefined) {
      delete process.env.WORKSTREAM_ROLE
    } else {
      process.env.WORKSTREAM_ROLE = originalRole
    }

    if (repoRoot && existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test("covers init/bootstrap, current, approvals, updates, revision, supervision recovery, and parity rebuild after legacy migration", async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "work-sqlite-lifecycle-"))
    streamId = `001-sqlite-lifecycle-${Date.now()}`
    const streamDir = join(repoRoot, "work", streamId)
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(streamDir, { recursive: true })

    writeLegacyIndex(repoRoot, streamId)
    writeValidPlan(streamDir)
    writeTasksMd(streamDir, streamId)

    await initMain(["bun", "work", "init", "--repo-root", repoRoot, "--sqlite"])
    expect(existsSync(getStructuredStorageSqlitePath(repoRoot))).toBeTrue()

    const currentOutput = await runCliSafely(() =>
      currentMain(["bun", "work", "current", "--repo-root", repoRoot, "--set", streamId]),
    )
    expect(currentOutput.exitCode).toBeNull()
    expect(currentOutput.stderr).toHaveLength(0)
    expect(currentOutput.stdout.join("\n")).toContain(`Current workstream set to: ${streamId}`)

    process.env.WORKSTREAM_ROLE = "USER"
    const planApproveOutput = await runCliSafely(() =>
      approveMain(["bun", "work", "approve", "plan", "--repo-root", repoRoot, "--stream", streamId]),
    )
    expect(planApproveOutput.exitCode).toBeNull()

    // Plan approval regenerates TASKS.md placeholders; fill a concrete task before task approval.
    writeTasksMd(streamDir, streamId)

    const tasksApproveOutput = await runCliSafely(() =>
      approveMain(["bun", "work", "approve", "tasks", "--repo-root", repoRoot, "--stream", streamId]),
    )
    if (tasksApproveOutput.exitCode !== null) {
      throw new Error(
        `tasks approval failed: ${[...tasksApproveOutput.stderr, ...tasksApproveOutput.stdout].join("\\n")}`,
      )
    }

    const updatedOutput = await runCliSafely(() =>
      updateTaskMain([
        "bun",
        "work",
        "update",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--task",
        "01.01.01.01",
        "--status",
        "completed",
        "--report",
        "Lifecycle regression completed.",
      ]),
    )
    expect(updatedOutput.exitCode).toBeNull()
    expect(updatedOutput.stderr).toHaveLength(0)
    expect(updatedOutput.stdout.join("\n")).toContain("Updated task 01.01.01.01")

    const stageApproveOutput = await runCliSafely(() =>
      approveMain([
        "bun",
        "work",
        "approve",
        "stage",
        "1",
        "--force",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
      ]),
    )
    expect(stageApproveOutput.exitCode).toBeNull()
    const revisionOutput = await runCliSafely(() =>
      revisionMain([
        "bun",
        "work",
        "revision",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--name",
        "sqlite-follow-up",
      ]),
    )
    expect(revisionOutput.exitCode).toBeNull()
    expect(revisionOutput.stderr).toHaveLength(0)
    expect(revisionOutput.stdout.join("\n")).toContain("Appended Stage")

    const tasksFile = readTasksFile(repoRoot, streamId)
    expect(tasksFile?.tasks.find((task) => task.id === "01.01.01.01")?.status).toBe("completed")

    const now = "2026-04-20T10:00:00.000Z"
    if (!tasksFile) {
      throw new Error("expected tasks file")
    }
    tasksFile.tasks = [
      {
        ...tasksFile.tasks[0]!,
        id: "01.01.01.01",
        name: "Validate sqlite-authoritative lifecycle transitions",
        stage_name: "Core Lifecycle",
        batch_name: "Regression coverage",
        thread_name: "Command and lifecycle regression",
        status: "completed",
        report: "stale report",
        breadcrumb: "stale breadcrumb",
        created_at: now,
        updated_at: now,
      },
    ]
    tasksFile.runtime_state = {
      version: "1.0.0",
      last_updated: now,
      threads: [
        {
          threadId: "01.01.01",
          currentSessionId: "stale-session",
          sessions: [
            {
              sessionId: "stale-session",
              agentName: "default",
              model: "openai/gpt-5.4",
              startedAt: now,
              completedAt: now,
              status: "failed",
              exitCode: 1,
            },
          ],
        },
      ],
      batches: {
        "01.01": {
          version: "1.0.0",
          streamId,
          batchId: "01.01",
          runId: "run-01.01",
          mode: "headless",
          status: "failed",
          stageName: "Core Lifecycle",
          batchName: "Regression coverage",
          startedAt: now,
          updatedAt: now,
          completedAt: now,
          summary: { total: 1, pending: 0, running: 0, completed: 0, failed: 1 },
          threads: [
            {
              threadId: "01.01.01",
              threadName: "Command and lifecycle regression",
              firstTaskId: "01.01.01.01",
              status: "failed",
              updatedAt: now,
              completedAt: now,
            },
          ],
        },
      },
      supervision: {
        ...createEmptySupervisorState(streamId),
        last_updated: now,
        active_run_id: "sup-run-1",
        runs: [
          {
            runId: "sup-run-1",
            stageId: "01",
            status: "stopped",
            startedAt: now,
            updatedAt: now,
            currentBatchId: "01.01",
            reviewPasses: 1,
            issueSummaryIds: [],
            escalationIds: [],
          },
        ],
        checkpoint_pointers: [],
        branch_sessions: [],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      },
    }
    writeTasksFile(repoRoot, streamId, tasksFile)

    writeBatchStatus(
      repoRoot,
      streamId,
      createBatchStatusFile({
        streamId,
        batchId: "01.01",
        stageName: "Core Lifecycle",
        batchName: "Regression coverage",
        threads: [
          {
            threadId: "01.01.01",
            threadName: "Command and lifecycle regression",
            firstTaskId: "01.01.01.01",
          },
        ],
      }),
    )
    saveSupervisorState(repoRoot, streamId, {
      ...createEmptySupervisorState(streamId),
      last_updated: now,
      active_run_id: "sup-run-1",
      runs: [
        {
          runId: "sup-run-1",
          stageId: "01",
          status: "stopped",
          startedAt: now,
          updatedAt: now,
          currentBatchId: "01.01",
          reviewPasses: 1,
          issueSummaryIds: [],
          escalationIds: [],
        },
      ],
      checkpoint_pointers: [],
      branch_sessions: [],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    })

    const resetOutput = await runCliSafely(() =>
      resetBatchStateMain([
        "bun",
        "work",
        "reset-batch-state",
        "--repo-root",
        repoRoot,
        "--stream",
        streamId,
        "--batch",
        "01.01",
      ]),
    )
    expect(resetOutput.exitCode).toBeNull()

    const resetTask = readTasksFile(repoRoot, streamId)?.tasks[0]
    expect(resetTask).toMatchObject({
      id: "01.01.01.01",
      status: "pending",
    })
    expect(resetTask?.report).toBeUndefined()
    expect(resetTask?.breadcrumb).toBeUndefined()
    expect(readTasksFile(repoRoot, streamId)?.runtime_state?.batches["01.01"]).toBeUndefined()

    const outputRoot = mkdtempSync(join(tmpdir(), "work-rebuild-compat-"))
    try {
      rebuildCompatMain([
        "bun",
        "work",
        "rebuild-compat",
        "--repo-root",
        repoRoot,
        "--output-root",
        outputRoot,
      ])

      expect(existsSync(join(outputRoot, "work", "index.json"))).toBeTrue()
      expect(existsSync(join(outputRoot, "work", streamId, "tasks.json"))).toBeTrue()
      const rebuiltIndex = JSON.parse(readFileSync(join(outputRoot, "work", "index.json"), "utf-8"))
      expect(rebuiltIndex.current_stream).toBe(streamId)
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
    }

    const parity = inspectCriticalWorkflowDualWriteParitySync(repoRoot, streamId)
    expect(parity?.parity.all).toBeTrue()

    const index = loadIndex(repoRoot)
    const stream = index.streams.find((entry) => entry.id === streamId)
    expect(stream?.approval?.status).toBe("approved")
    expect(stream?.approval?.tasks?.status).toBe("revoked")
  })
})
