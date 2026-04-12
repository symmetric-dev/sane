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

function writeTwoBatchPlan(workDir: string): void {
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
First thread.

**Details:**
- Do the first task.

##### Batch 02: Batch 2

###### Thread 01: Thread 1

**Summary:**
Second thread.

**Details:**
- Do the second task.
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

function writeTasksList(
  workDir: string,
  streamId: string,
  tasks: Array<{
    id: string
    status: "pending" | "completed"
    threadName: string
    batchName: string
    stageName: string
    report?: string
  }>,
): void {
  writeFileSync(
    join(workDir, "tasks.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        tasks: tasks.map((task) => ({
          id: task.id,
          name: `Task ${task.id}`,
          thread_name: task.threadName,
          batch_name: task.batchName,
          stage_name: task.stageName,
          status: task.status,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          ...(task.report ? { report: task.report } : {}),
        })),
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
    expect(output).toContain("[supervise] recovering terminal batch-status 01.01")
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
    expect(output).toContain("[supervise] recovering terminal batch-status 01.01")
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
    expect(output).toContain("[supervise] would launch batch 01.01")
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

  test("timeout while waiting keeps the supervisor run resumable and skips review for incomplete batches", async () => {
    workspace = createTestWorkstream("001-supervise-timeout")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-timeout")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "pending")

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [
        {
          threadId: "01.01.01",
          currentSessionId: "timeout-session-1",
          sessions: [
            {
              sessionId: "timeout-session-1",
              agentName: "default",
              model: "openai/gpt-5.4",
              startedAt: new Date().toISOString(),
              status: "running",
            },
          ],
        },
      ],
    })

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-timeout")
    writeFileSync(fakeRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.execPath = fakeRuntime

    let thrown: unknown
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
    const timeoutMessage = String((thrown as { message?: string } | undefined)?.message ?? thrown ?? "")
    expect(timeoutMessage).toContain(
      "Timed out after 5ms waiting for batch 01.01",
    )

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] waiting for batch-status 01.01")
    expect(output).toContain("[supervise] timeout:")
    expect(output).not.toContain("[supervise] review 01.01")

    let supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs).toHaveLength(1)
    expect(supervisorState?.runs[0]?.status).toBe("running")
    expect(supervisorState?.reviewed_batches).toHaveLength(0)
    expect(supervisorState?.stage_stops).toHaveLength(0)
    expect(supervisorState?.active_run_id).toBe(supervisorState?.runs[0]?.runId)

    writeTasks(
      workspace.workDir,
      workspace.streamId,
      "completed",
      "Completed after the original caller stopped waiting.",
    )
    writeFileSync(getSessionFilePath(workspace.streamId, "01.01.01"), "timeout-opencode-session\n")
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

    const { stdout: resumedStdout } = await captureCliOutput(async () => {
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

    const resumedOutput = resumedStdout.join("\n")
    expect(resumedOutput).toContain("[supervise] resume: batch 01.01 already reached completed; reviewing persisted results")
    expect(resumedOutput).toContain("[supervise] recovering terminal batch-status 01.01")
    expect(resumedOutput).toContain("[supervise] review 01.01: aligned")

    supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs).toHaveLength(1)
    expect(supervisorState?.runs[0]?.status).toBe("completed")
    expect(supervisorState?.reviewed_batches).toHaveLength(1)
    expect(supervisorState?.stage_stops).toHaveLength(1)
    expect(supervisorState?.active_run_id).toBeUndefined()
  })

  test("rerunning without --batch after timeout resumes the interrupted batch before the next incomplete batch", async () => {
    workspace = createTestWorkstream("001-supervise-default-timeout-resume")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-default-timeout-resume")
    writeTwoBatchPlan(workspace.workDir)
    writeTasksList(workspace.workDir, workspace.streamId, [
      {
        id: "01.01.01.01",
        status: "pending",
        threadName: "Thread 1",
        batchName: "Batch 1",
        stageName: "Stage 1",
      },
      {
        id: "01.02.01.01",
        status: "pending",
        threadName: "Thread 1",
        batchName: "Batch 2",
        stageName: "Stage 1",
      },
    ])

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [
        {
          threadId: "01.01.01",
          currentSessionId: "timeout-default-session-1",
          sessions: [
            {
              sessionId: "timeout-default-session-1",
              agentName: "default",
              model: "openai/gpt-5.4",
              startedAt: new Date().toISOString(),
              status: "running",
            },
          ],
        },
        {
          threadId: "01.02.01",
          sessions: [],
        },
      ],
    })

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-default-timeout")
    writeFileSync(fakeRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.execPath = fakeRuntime

    let thrown: Error | undefined
    await captureCliOutput(async () => {
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

    expect(String((thrown as { message?: string } | undefined)?.message ?? thrown ?? "")).toContain(
      "Timed out after 5ms waiting for batch 01.01",
    )

    writeTasksList(workspace.workDir, workspace.streamId, [
      {
        id: "01.01.01.01",
        status: "completed",
        threadName: "Thread 1",
        batchName: "Batch 1",
        stageName: "Stage 1",
        report: "Completed after the original caller stopped waiting.",
      },
      {
        id: "01.02.01.01",
        status: "pending",
        threadName: "Thread 1",
        batchName: "Batch 2",
        stageName: "Stage 1",
      },
    ])

    thrown = undefined
    const { stdout } = await captureCliOutput(async () => {
      try {
        await superviseMain([
          "bun",
          "work-supervise",
          "--repo-root",
          workspace!.repoRoot,
          "--stream",
          workspace!.streamId,
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
    const secondTimeoutMessage = String(
      (thrown as { message?: string } | undefined)?.message ?? thrown ?? "",
    )
    expect(secondTimeoutMessage).toContain(
      "Timed out after 5ms waiting for batch 01.02",
    )

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] resume: batch 01.01 already reached completed; reviewing persisted results")
    expect(output).toContain("[supervise] recovering terminal batch-status 01.01")
    expect(output).toContain("[supervise] review 01.01: aligned")
    expect(output).toContain("[supervise] continue: 01.01 approved; moving to 01.02.")
    expect(output).toContain("[supervise] waiting for batch-status 01.02")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    const activeRun = supervisorState?.runs.find((run) => run.runId === supervisorState.active_run_id)
    expect(activeRun?.currentBatchId).toBe("01.02")
    expect(activeRun?.status).toBe("running")
    expect(supervisorState?.reviewed_batches).toHaveLength(1)
    expect(supervisorState?.reviewed_batches[0]?.batchId).toBe("01.01")
  })

  test("rerunning against an already-terminal batch stops without relaunching work", async () => {
    workspace = createTestWorkstream("001-supervise-terminal-rerun")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-terminal-rerun")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed", "Already handled.")

    writeFileSync(
      join(workspace.repoRoot, "work", workspace.streamId, "supervisor-state.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: new Date().toISOString(),
          runs: [
            {
              runId: "sup-01-existing",
              stageId: "01",
              status: "completed",
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              currentBatchId: "01.01",
              lastReviewedBatchId: "01.01",
              reviewPasses: 1,
              issueSummaryIds: [],
              escalationIds: [],
              stageStopId: "sup-01-existing-review-01-final-stop",
              stopReason: "completed",
            },
          ],
          reviewed_batches: [
            {
              reviewId: "sup-01-existing-01.01-review-01",
              runId: "sup-01-existing",
              stageId: "01",
              batchId: "01.01",
              reviewPass: 1,
              reviewedAt: new Date().toISOString(),
              outcome: "approved",
              threadIds: ["01.01.01"],
              issueSummaryIds: [],
              notes: "Batch already approved.",
            },
          ],
          issue_summaries: [],
          fix_cycles: [],
          escalations: [],
          stage_stops: [
            {
              stopId: "sup-01-existing-review-01-final-stop",
              runId: "sup-01-existing",
              stageId: "01",
              batchId: "01.01",
              reason: "completed",
              summary: "Supervisor completed the last known batch 01.01.",
              stoppedAt: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    )

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
      ])
    })

    const output = stdout.join("\n")
    expect(output).toContain("already has a persisted supervisor outcome")
    expect(output).not.toContain("[supervise] start batch 01.01")
  })

  test("rerunning a failed interrupted batch resumes review for the requested batch instead of relaunching completed work", async () => {
    workspace = createTestWorkstream("001-supervise-interrupted-failure-recovery")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-interrupted-failure-recovery")
    writeValidPlan(workspace.workDir)
    writeTasks(
      workspace.workDir,
      workspace.streamId,
      "completed",
      "Completed before the supervisor caller was interrupted.",
    )
    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [
        {
          threadId: "01.01.01",
          currentSessionId: "interrupted-session-1",
          sessions: [
            {
              sessionId: "interrupted-session-1",
              agentName: "default",
              model: "openai/gpt-5.4",
              startedAt: new Date().toISOString(),
              status: "running",
            },
          ],
        },
      ],
    })
    writeFileSync(getSessionFilePath(workspace.streamId, "01.01.01"), "interrupted-opencode-session\n")

    const startedAt = new Date().toISOString()
    mkdirSync(join(workspace.repoRoot, "work", workspace.streamId, "batch-status"), {
      recursive: true,
    })
    writeFileSync(
      join(workspace.repoRoot, "work", workspace.streamId, "batch-status", "01.01.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          streamId: workspace.streamId,
          batchId: "01.01",
          runId: "01.01-run",
          mode: "headless",
          status: "completed",
          stageName: "Stage 1",
          batchName: "Batch 1",
          startedAt,
          updatedAt: startedAt,
          completedAt: startedAt,
          summary: { total: 1, pending: 0, running: 0, completed: 1, failed: 0 },
          threads: [
            {
              threadId: "01.01.01",
              threadName: "Thread 1",
              firstTaskId: "01.01.01.01",
              status: "completed",
              updatedAt: startedAt,
              completedAt: startedAt,
            },
          ],
        },
        null,
        2,
      ),
    )

    writeFileSync(
      join(workspace.repoRoot, "work", workspace.streamId, "supervisor-state.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: startedAt,
          active_run_id: "sup-00-stale",
          runs: [
            {
              runId: "sup-00-stale",
              stageId: "00",
              status: "running",
              startedAt,
              updatedAt: startedAt,
              currentBatchId: "00.01",
              reviewPasses: 0,
              issueSummaryIds: [],
              escalationIds: [],
            },
            {
              runId: "sup-01-failed",
              stageId: "01",
              status: "failed",
              startedAt,
              updatedAt: startedAt,
              completedAt: startedAt,
              currentBatchId: "01.01",
              reviewPasses: 0,
              issueSummaryIds: [],
              escalationIds: [],
              stageStopId: "sup-01-failed-error-stop",
              stopReason: "failed",
            },
          ],
          reviewed_batches: [],
          issue_summaries: [],
          fix_cycles: [],
          escalations: [],
          stage_stops: [
            {
              stopId: "sup-01-failed-error-stop",
              runId: "sup-01-failed",
              stageId: "01",
              batchId: "01.01",
              reason: "failed",
              summary: "Caller crashed after batch completion.",
              stoppedAt: startedAt,
            },
          ],
        },
        null,
        2,
      ),
    )

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
    expect(output).toContain("[supervise] reconciled interrupted supervisor run: sup-01-failed")
    expect(output).toContain("[supervise] resume: batch 01.01 already reached completed; reviewing persisted results from run sup-01-failed.")
    expect(output).toContain("[supervise] recovering terminal batch-status 01.01")
    expect(output).toContain("[supervise] review 01.01: aligned")
    expect(output).not.toContain("[supervise] start batch 01.01")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.active_run_id).toBeUndefined()
    expect(supervisorState?.runs.find((run) => run.runId === "sup-00-stale")?.status).toBe("running")
    expect(supervisorState?.runs.find((run) => run.runId === "sup-01-failed")?.status).toBe("completed")
    expect(
      supervisorState?.stage_stops.find((stop) => stop.stopId === "sup-01-failed-error-stop"),
    ).toBeUndefined()
    expect(supervisorState?.reviewed_batches).toHaveLength(1)
    expect(supervisorState?.stage_stops).toHaveLength(1)
  })

  test("rerunning a reconciled escalated review reuses escalation artifacts without duplication", async () => {
    workspace = createTestWorkstream("001-supervise-escalation-resume")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-escalation-resume")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed", "Already handled.")

    const reviewedAt = new Date().toISOString()
    writeFileSync(
      join(workspace.repoRoot, "work", workspace.streamId, "supervisor-state.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: reviewedAt,
          runs: [
            {
              runId: "sup-01-escalated",
              stageId: "01",
              status: "paused",
              startedAt: reviewedAt,
              updatedAt: reviewedAt,
              currentBatchId: "01.01",
              lastReviewedBatchId: "01.01",
              reviewPasses: 1,
              issueSummaryIds: ["sup-01-escalated-01.01-review-01-issue-01"],
              escalationIds: ["sup-01-escalated-01.01-review-01-escalation"],
            },
          ],
          reviewed_batches: [
            {
              reviewId: "sup-01-escalated-01.01-review-01",
              runId: "sup-01-escalated",
              stageId: "01",
              batchId: "01.01",
              reviewPass: 1,
              reviewedAt,
              outcome: "escalated",
              threadIds: ["01.01.01"],
              issueSummaryIds: ["sup-01-escalated-01.01-review-01-issue-01"],
              stopReason: "review_limit_reached",
              notes: "Batch 01.01 cannot start another automatic fix cycle. Fix cycles used: 1/1.",
            },
          ],
          issue_summaries: [
            {
              summaryId: "sup-01-escalated-01.01-review-01-issue-01",
              runId: "sup-01-escalated",
              stageId: "01",
              batchId: "01.01",
              status: "open",
              summary: "Thread still needs fixes.",
              severity: "medium",
              firstObservedAt: reviewedAt,
              lastObservedAt: reviewedAt,
            },
          ],
          fix_cycles: [],
          escalations: [
            {
              escalationId: "sup-01-escalated-01.01-review-01-escalation",
              runId: "sup-01-escalated",
              stageId: "01",
              batchId: "01.01",
              target: "operator",
              reason: "Batch 01.01 cannot start another automatic fix cycle. Fix cycles used: 1/1.",
              status: "pending",
              escalatedAt: reviewedAt,
            },
          ],
          stage_stops: [],
        },
        null,
        2,
      ),
    )

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
      ])
    })

    const output = stdout.join("\n")
    expect(output).toContain("already has a persisted supervisor outcome")
    expect(output).not.toContain("[supervise] start batch 01.01")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.reviewed_batches).toHaveLength(1)
    expect(supervisorState?.escalations).toHaveLength(1)
    expect(supervisorState?.stage_stops).toHaveLength(1)
    expect(supervisorState?.runs[0]?.status).toBe("escalated")
  })

  test("rerunning a pending fix-cycle resume does not create duplicate fix-cycle artifacts", async () => {
    workspace = createTestWorkstream("001-supervise-fix-cycle-resume")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-fix-cycle-resume")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed")

    const reviewedAt = new Date().toISOString()
    writeFileSync(
      join(workspace.repoRoot, "work", workspace.streamId, "supervisor-state.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: reviewedAt,
          runs: [
            {
              runId: "sup-01-fix-resume",
              stageId: "01",
              status: "paused",
              startedAt: reviewedAt,
              updatedAt: reviewedAt,
              currentBatchId: "01.01",
              lastReviewedBatchId: "01.01",
              reviewPasses: 2,
              issueSummaryIds: ["sup-01-fix-resume-01.01-review-01-issue-01"],
              escalationIds: [],
            },
          ],
          reviewed_batches: [
            {
              reviewId: "sup-01-fix-resume-01.01-review-01",
              runId: "sup-01-fix-resume",
              stageId: "01",
              batchId: "01.01",
              reviewPass: 1,
              reviewedAt,
              outcome: "changes_requested",
              threadIds: ["01.01.01"],
              issueSummaryIds: ["sup-01-fix-resume-01.01-review-01-issue-01"],
              notes: "Batch 01.01 will run automatic fix cycle 1 and then re-review on pass 2. Fix cycles used: 0/1.",
            },
          ],
          issue_summaries: [
            {
              summaryId: "sup-01-fix-resume-01.01-review-01-issue-01",
              runId: "sup-01-fix-resume",
              stageId: "01",
              batchId: "01.01",
              status: "open",
              summary: "Thread still needs fixes.",
              severity: "medium",
              firstObservedAt: reviewedAt,
              lastObservedAt: reviewedAt,
            },
          ],
          fix_cycles: [
            {
              cycleId: "sup-01-fix-resume-01.01-01.01.01-fix-01",
              runId: "sup-01-fix-resume",
              stageId: "01",
              batchId: "01.01",
              threadId: "01.01.01",
              attemptCount: 1,
              batchAttempt: 1,
              triggeredByReviewId: "sup-01-fix-resume-01.01-review-01",
              lastAttemptAt: reviewedAt,
              lastOutcome: "pending_review",
              issueSummaryIds: ["sup-01-fix-resume-01.01-review-01-issue-01"],
            },
          ],
          escalations: [],
          stage_stops: [],
        },
        null,
        2,
      ),
    )

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-fix-cycle-resume")
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
    expect(output).toContain("rerunning batch 01.01 for pending fix-cycle review")
    expect(output).toContain("[supervise] start batch 01.01")
    expect(output).toContain("[supervise] stop: user input required")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.reviewed_batches).toHaveLength(2)
    expect(supervisorState?.fix_cycles).toHaveLength(1)
    expect(supervisorState?.fix_cycles[0]?.cycleId).toBe("sup-01-fix-resume-01.01-01.01.01-fix-01")
    expect(supervisorState?.fix_cycles[0]?.lastOutcome).toBe("escalated")
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
