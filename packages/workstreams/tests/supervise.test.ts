import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { captureCliOutput } from "./helpers/cli-runner.ts"
import {
  cleanupTestWorkstream,
  createTestWorkstream,
  type TestWorkspace,
} from "./helpers/index.ts"
import {
  collectSupervisorReviewInput,
  getReviewAffectedThreadIds,
  runDeterministicSupervisorReview,
} from "../src/lib/supervisor/index.ts"
import { saveThreads } from "../src/lib/threads.ts"
import { loadSupervisorState } from "../src/lib/supervisor-state.ts"
import { getRunResultPath, getSessionFilePath } from "../src/lib/opencode.ts"
import { main as superviseMain } from "../src/cli/supervise.ts"
import { main as workMain } from "../bin/work.ts"

function writeIndex(repoRoot: string, streamId: string, name: string): void {
  mkdirSync(join(repoRoot, "work"), { recursive: true })
  writeFileSync(
    join(repoRoot, "work", "index.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        current_stream: streamId,
        streams: [
          {
            id: streamId,
            name,
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

function writeValidPlan(workDir: string): void {
  writeFileSync(
    join(workDir, "PLAN.md"),
    `# Plan: Test Stream

## Summary

Short summary.

## References

- \`README.md\`

## Stages

### Stage 01: Stage 1

#### Stage Definition

Do the work.

#### Stage Constitution

Use the normal workflow.

#### Stage Questions

- [x] Any open questions? → No.

#### Stage Batches

##### Batch 01: Batch 1

###### Thread 01: Thread 1

**Summary:**
Single thread.

**Details:**
- Do one task.
`,
  )
}

function writeTasks(
  workDir: string,
  streamId: string,
  taskStatus: "pending" | "completed",
  report?: string,
): void {
  writeFileSync(
    join(workDir, "tasks.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Task 1",
            thread_name: "Thread 1",
            batch_name: "Batch 1",
            stage_name: "Stage 1",
            status: taskStatus,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...(report ? { report } : {}),
          },
        ],
      },
      null,
      2,
    ),
  )
}

describe("supervise", () => {
  let workspace: TestWorkspace | undefined
  const originalExecPath = process.execPath

  afterEach(() => {
    process.execPath = originalExecPath
    if (workspace) {
      rmSync(getRunResultPath(workspace.streamId, "01.01.01"), { force: true })
      rmSync(getSessionFilePath(workspace.streamId, "01.01.01"), { force: true })
      cleanupTestWorkstream(workspace)
      workspace = undefined
    }
  })

  test("deterministic review accepts completed threads based on canonical task/session state", () => {
    workspace = createTestWorkstream("001-supervise-review")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-review")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed", "Implemented the requested change.")

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [
        {
          threadId: "01.01.01",
          currentSessionId: "thread-current-1",
          opencodeSessionId: "outer-session-1",
          sessions: [
            {
              sessionId: "outer-session-1",
              agentName: "default",
              model: "openai/gpt-5.4",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              status: "completed",
              exitCode: 0,
            },
          ],
        },
      ],
    })

    const reviewInput = collectSupervisorReviewInput(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      streamId: workspace.streamId,
      batchId: "01.01",
      runId: "batch-run-1",
      mode: "headless",
      status: "completed",
      stageName: "Stage 1",
      batchName: "Batch 1",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      summary: {
        total: 1,
        pending: 0,
        running: 0,
        completed: 1,
        failed: 0,
      },
      threads: [
        {
          threadId: "01.01.01",
          threadName: "Thread 1",
          firstTaskId: "01.01.01.01",
          status: "completed",
          currentSessionId: "batch-current-1",
          opencodeSessionId: "batch-session-1",
          updatedAt: new Date().toISOString(),
        },
      ],
    })

    const reviewer = runDeterministicSupervisorReview(reviewInput)

    expect(reviewInput.threads[0]).toMatchObject({
      currentSessionId: "batch-current-1",
      opencodeSessionId: "batch-session-1",
      sessionCount: 1,
      completedSessionCount: 1,
      taskStatuses: [
        {
          taskId: "01.01.01.01",
          status: "completed",
          report: "Implemented the requested change.",
        },
      ],
    })
    expect(reviewer.alignment.status).toBe("aligned")
    expect(reviewer.missingOutputs).toHaveLength(0)
    expect(reviewer.issues).toHaveLength(0)
    expect(getReviewAffectedThreadIds(reviewInput)).toEqual([])
  })

  test("CLI supervises a completed batch and records a readable stop", async () => {
    workspace = createTestWorkstream("001-supervise-cli")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-cli")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed")
    writeFileSync(
      join(workspace.repoRoot, "work", "supervisor.json"),
      JSON.stringify(
        {
          stage_completion: {
            stop: false,
            contact_user: false,
          },
          escalation: {
            contact_user_on: {
              stage_completion: false,
            },
          },
        },
        null,
        2,
      ),
    )

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [
        {
          threadId: "01.01.01",
          sessions: [],
        },
      ],
    })

    writeFileSync(
      getRunResultPath(workspace.streamId, "01.01.01"),
      JSON.stringify({ status: "completed", exitCode: 0 }),
    )

    const fakeRuntime = join(workspace.repoRoot, "fake-bun")
    writeFileSync(fakeRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.execPath = fakeRuntime

    const { stdout } = await captureCliOutput(async () => {
      await superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        workspace!.repoRoot,
        "--stream",
        workspace!.streamId,
        "--batch",
        "01.01",
        "--poll-interval-ms",
        "1",
      ])
    })

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] start batch 01.01")
    expect(output).toContain("[supervise] review 01.01: aligned")
    expect(output).toContain("[supervise] stop: no remaining batches after 01.01.")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs).toHaveLength(1)
    expect(supervisorState?.reviewed_batches).toHaveLength(1)
    expect(supervisorState?.stage_stops).toHaveLength(1)
    expect(supervisorState?.runs[0]?.status).toBe("completed")
  })

  test("CLI supervises a canonically completed batch when tmux artifacts are missing", async () => {
    workspace = createTestWorkstream("001-supervise-canonical-fallback")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-canonical-fallback")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed")

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [
        {
          threadId: "01.01.01",
          currentSessionId: "session-canonical-fallback-1",
          sessions: [
            {
              sessionId: "session-canonical-fallback-1",
              agentName: "code-reviewer",
              model: "openai/gpt-5.3-codex",
              startedAt: new Date().toISOString(),
              status: "running",
            },
          ],
        },
      ],
    })

    writeFileSync(getSessionFilePath(workspace.streamId, "01.01.01"), "canonical-opencode-session\n")

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-canonical-fallback")
    writeFileSync(fakeRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.execPath = fakeRuntime

    const { stdout } = await captureCliOutput(async () => {
      await superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        workspace!.repoRoot,
        "--stream",
        workspace!.streamId,
        "--batch",
        "01.01",
        "--poll-interval-ms",
        "1",
        "--timeout-ms",
        "100",
      ])
    })

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] start batch 01.01")
    expect(output).toContain("[supervise] batch 01.01 finished: completed")
    expect(output).toContain("[supervise] review 01.01: aligned")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs[0]?.status).toBe("completed")
    expect(supervisorState?.reviewed_batches).toHaveLength(1)
    expect(supervisorState?.stage_stops).toHaveLength(1)
  })

  test("dry-run shows the headless launch command and avoids interactive flow", async () => {
    workspace = createTestWorkstream("001-supervise-dry-run")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-dry-run")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "pending")

    const { stdout } = await captureCliOutput(async () => {
      await superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        workspace!.repoRoot,
        "--stream",
        workspace!.streamId,
        "--batch",
        "01.01",
        "--dry-run",
      ])
    })

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] would launch batch 01.01 with work multi --headless --async")
    expect(output).not.toContain("opencode --session")
  })

  test("default stage completion behavior stops and contacts user at stage boundary", async () => {
    workspace = createTestWorkstream("001-supervise-stage-boundary")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-stage-boundary")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed")

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [
        {
          threadId: "01.01.01",
          sessions: [],
        },
      ],
    })

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-stage-stop")
    writeFileSync(
      fakeRuntime,
      `#!/bin/sh
cat <<'JSON' > "${getRunResultPath(workspace.streamId, "01.01.01")}" 
{"status":"completed","exitCode":0}
JSON
exit 0
`,
      { mode: 0o755 },
    )
    process.execPath = fakeRuntime

    const { stdout } = await captureCliOutput(async () => {
      await superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        workspace!.repoRoot,
        "--stream",
        workspace!.streamId,
        "--batch",
        "01.01",
        "--poll-interval-ms",
        "1",
      ])
    })

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] stop: user input required")
    expect(output).toContain("Stage completed at batch 01.01")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.reviewed_batches).toHaveLength(1)
    expect(supervisorState?.stage_stops).toHaveLength(1)
    expect(supervisorState?.escalations).toHaveLength(1)
    expect(supervisorState?.stage_stops[0]?.reason).toBe("completed")
    expect(supervisorState?.escalations[0]?.target).toBe("stage")
  })

  test("timeout while waiting fails the supervisor run and skips review for incomplete batches", async () => {
    workspace = createTestWorkstream("001-supervise-timeout")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-timeout")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "pending")

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-timeout")
    writeFileSync(fakeRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.execPath = fakeRuntime

    let thrown: Error | undefined
    const { stdout } = await captureCliOutput(async () => {
      try {
        await superviseMain([
          "bun",
          "work-supervise",
          "--repo-root",
          workspace!.repoRoot,
          "--stream",
          workspace!.streamId,
          "--batch",
          "01.01",
          "--poll-interval-ms",
          "1",
          "--timeout-ms",
          "5",
        ])
      } catch (error) {
        thrown = error as Error
      }
    })

    expect(thrown).toBeDefined()
    expect(thrown?.message).toContain("Timed out after 5ms waiting for batch 01.01")

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] start batch 01.01")
    expect(output).toContain("[supervise] waiting for batch-status 01.01")
    expect(output).not.toContain("[supervise] review 01.01")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs).toHaveLength(1)
    expect(supervisorState?.runs[0]?.status).toBe("failed")
    expect(supervisorState?.reviewed_batches).toHaveLength(0)
    expect(supervisorState?.stage_stops).toHaveLength(1)
    expect(supervisorState?.stage_stops[0]?.reason).toBe("failed")
    expect(supervisorState?.stage_stops[0]?.summary).toContain("Timed out after 5ms waiting for batch 01.01")
  })

  test("supervisor runs exactly one automatic fix cycle by default before escalation", async () => {
    workspace = createTestWorkstream("001-supervise-one-fix-cycle")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-one-fix-cycle")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed")

    // Keep task reports empty so deterministic review findings stay open across passes.
    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [
        {
          threadId: "01.01.01",
          sessions: [],
        },
      ],
    })

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-fix-cycle")
    writeFileSync(
      fakeRuntime,
      `#!/bin/sh
cat <<'JSON' > "${getRunResultPath(workspace.streamId, "01.01.01")}" 
{"status":"failed","exitCode":1}
JSON
exit 0
`,
      { mode: 0o755 },
    )
    process.execPath = fakeRuntime

    const { stdout } = await captureCliOutput(async () => {
      await superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        workspace!.repoRoot,
        "--stream",
        workspace!.streamId,
        "--batch",
        "01.01",
        "--poll-interval-ms",
        "1",
      ])
    })

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] fix: Batch 01.01 will run automatic fix cycle 1")
    expect(output).toContain("[supervise] stop: user input required")
    expect(output).toContain("Fix-cycle limit reached (1/1)")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.reviewed_batches).toHaveLength(2)
    expect(supervisorState?.fix_cycles).toHaveLength(1)
    expect(supervisorState?.fix_cycles[0]?.attemptCount).toBe(1)
    expect(supervisorState?.fix_cycles[0]?.lastOutcome).toBe("escalated")
    expect(supervisorState?.stage_stops[0]?.reason).toBe("review_limit_reached")
    expect(supervisorState?.escalations[0]?.target).toBe("operator")
  })

  test("main CLI help registers the supervise command", async () => {
    const originalExit = process.exit
    process.exit = ((code?: number) => {
      throw new Error(`Process exited with code ${code ?? 0}`)
    }) as typeof process.exit

    try {
      const { stdout, stderr } = await captureCliOutput(() => {
        try {
          workMain(["bun", "work", "--help", "--show-all-commands"])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 0") {
            throw error
          }
        }
      })

      expect(stderr).toHaveLength(0)
      expect(stdout.join("\n")).toMatch(/^\s+supervise\s+Run headless batch supervision from reports and canonical state$/m)
    } finally {
      process.exit = originalExit
    }
  })
})
