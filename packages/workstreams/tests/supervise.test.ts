import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "fs"
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
import { loadSupervisorState, saveSupervisorState, upsertBranchSessionLocked } from "../src/lib/supervisor-state.ts"
import { getRunResultPath, getSessionFilePath } from "../src/lib/opencode.ts"
import {
  __test as superviseTest,
  main as superviseMain,
  resolveRootAgentBranchContext,
} from "../src/cli/supervise.ts"
import { buildRootAgentThreadSessionLineage } from "../src/cli/multi.ts"
import { startMultipleSessionsLocked } from "../src/lib/tasks.ts"
import { getThreadMetadata } from "../src/lib/threads.ts"
import { buildRootAgentBranchSession } from "../src/lib/root-agent-branch.ts"
import { main as workMain } from "../bin/work.ts"
import { createEmptyTasksFile, readTasksFile, writeTasksFile } from "../src/lib/tasks.ts"

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
  const repoRoot = workDir.split("/work/")[0]!
  const tasksFile = readTasksFile(repoRoot, streamId) ?? createEmptyTasksFile(streamId)
  tasksFile.tasks = [
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
  ]
  writeTasksFile(repoRoot, streamId, tasksFile)
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
  const repoRoot = workDir.split("/work/")[0]!
  const tasksFile = readTasksFile(repoRoot, streamId) ?? createEmptyTasksFile(streamId)
  tasksFile.tasks = tasks.map((task) => ({
    id: task.id,
    name: `Task ${task.id}`,
    thread_name: task.threadName,
    batch_name: task.batchName,
    stage_name: task.stageName,
    status: task.status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(task.report ? { report: task.report } : {}),
  }))
  writeTasksFile(repoRoot, streamId, tasksFile)
}

describe("supervise", () => {
  let workspace: TestWorkspace | undefined
  const originalExecPath = process.execPath
  const originalSessionId = process.env.SESSION_ID
  const originalOpencodeSessionId = process.env.OPENCODE_SESSION_ID

  afterEach(() => {
    process.execPath = originalExecPath
    if (originalSessionId === undefined) {
      delete process.env.SESSION_ID
    } else {
      process.env.SESSION_ID = originalSessionId
    }
    if (originalOpencodeSessionId === undefined) {
      delete process.env.OPENCODE_SESSION_ID
    } else {
      process.env.OPENCODE_SESSION_ID = originalOpencodeSessionId
    }
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

  test("review input assembly does not depend on firstTaskId for thread lookup", () => {
    workspace = createTestWorkstream("001-supervise-thread-native-review")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-thread-native-review")
    writeValidPlan(workspace.workDir)
    writeTasksList(workspace.workDir, workspace.streamId, [
      {
        id: "01.01.01.01",
        status: "completed",
        threadName: "Thread 1",
        batchName: "Batch 1",
        stageName: "Stage 1",
        report: "Done.",
      },
    ])

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [{ threadId: "01.01.01", sessions: [] }],
    })

    const reviewInput = collectSupervisorReviewInput(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      streamId: workspace.streamId,
      batchId: "01.01",
      runId: "batch-run-thread-native",
      mode: "headless",
      status: "completed",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
          firstTaskId: "not-a-real-task-anchor",
          status: "completed",
          updatedAt: new Date().toISOString(),
        },
      ],
    })

    expect(reviewInput.threads[0]?.taskStatuses).toEqual([
      expect.objectContaining({
        taskId: "01.01.01.01",
        status: "completed",
        report: "Done.",
      }),
    ])
  })

  test("CLI recovers a completed batch and pauses for root-agent handoff", async () => {
    workspace = createTestWorkstream("001-supervise-cli")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-cli")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed")

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [{ threadId: "01.01.01", sessions: [] }],
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
    expect(output).toContain("[supervise] batch 01.01 finished: completed")
    expect(output).toContain("[supervise] handoff: batch 01.01 reached completed")
    expect(output).not.toContain("[supervise] review 01.01")
    expect(output).not.toContain("[supervise] continue:")
    expect(output).not.toContain("[supervise] fix:")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs).toHaveLength(1)
    expect(supervisorState?.runs[0]?.status).toBe("paused")
    expect(supervisorState?.runs[0]?.currentBatchId).toBe("01.01")
    expect(supervisorState?.active_run_id).toBeUndefined()
    expect(supervisorState?.reviewed_batches).toHaveLength(0)
    expect(supervisorState?.stage_stops).toHaveLength(0)
    expect(supervisorState?.escalations).toHaveLength(0)
  })

  test("CLI recovers canonically completed batches when tmux artifacts are missing", async () => {
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
    expect(output).toContain("[supervise] handoff: batch 01.01 reached completed")
    expect(output).not.toContain("[supervise] review 01.01")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs[0]?.status).toBe("paused")
    expect(supervisorState?.reviewed_batches).toHaveLength(0)
    expect(supervisorState?.stage_stops).toHaveLength(0)
  })

  test("dry-run shows the headless launch command and root-agent handoff", async () => {
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
    expect(output).toContain("[supervise] would record a supervise-pass handoff for 01.01")
    expect(output).not.toContain("opencode --session")
  })

  test("CLI records root-agent branch lineage when launched from a supervision branch", async () => {
    workspace = createTestWorkstream("001-supervise-lineage")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-lineage")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed")

    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [{ threadId: "01.01.01", sessions: [] }],
    })

    writeFileSync(
      getRunResultPath(workspace.streamId, "01.01.01"),
      JSON.stringify({ status: "completed", exitCode: 0 }),
    )

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-lineage")
    writeFileSync(fakeRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.execPath = fakeRuntime

    await captureCliOutput(async () => {
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
        "--root-session-id",
        "root-session-1",
        "--branch-session-id",
        "branch-supervision-1",
        "--parent-session-id",
        "root-session-1",
        "--checkpoint-message-id",
        "msg-root-checkpoint",
        "--checkpoint-created-at",
        "2026-04-12T00:00:00.000Z",
        "--native-branch-session-id",
        "ses_supervision_1",
      ])
    })

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs[0]).toMatchObject({
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      status: "paused",
    })
    expect(supervisorState?.branch_sessions[0]).toMatchObject({
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      branchRole: "supervision",
      checkpointMessageId: "msg-root-checkpoint",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      parentSessionId: "root-session-1",
      nativeSessionId: "ses_supervision_1",
      source: "native_fork",
      status: "running",
      batchId: "01.01",
      notes: expect.stringContaining("Recorded supervise-pass handoff"),
    })
  })

  test("resolveRootAgentBranchContext auto-resolves context from current branch native session", async () => {
    workspace = createTestWorkstream("001-supervise-auto-context")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-auto-context")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "pending")

    const startedAt = new Date().toISOString()
    await upsertBranchSessionLocked(
      workspace.repoRoot,
      workspace.streamId,
      buildRootAgentBranchSession({
        context: {
          rootSessionId: "root-session-auto",
          branchSessionId: "branch-supervision-auto",
          checkpointMessageId: "msg-root-auto",
          checkpointCreatedAt: "2026-04-13T00:00:00.000Z",
          parentSessionId: "root-session-auto",
          nativeSessionId: "ses_supervision_auto",
        },
        branchRole: "supervision",
        status: "running",
        startedAt,
        updatedAt: startedAt,
        batchId: "01.01",
      }),
    )

    const previousSessionId = process.env.SESSION_ID
    const previousOpencodeSessionId = process.env.OPENCODE_SESSION_ID
    process.env.SESSION_ID = "ses_supervision_auto"
    delete process.env.OPENCODE_SESSION_ID

    try {
      const resolved = await resolveRootAgentBranchContext({}, workspace.repoRoot, workspace.streamId)

      expect(resolved).toMatchObject({
        streamId: workspace.streamId,
        branchContext: {
          rootSessionId: "root-session-auto",
          branchSessionId: "branch-supervision-auto",
          checkpointMessageId: "msg-root-auto",
          checkpointCreatedAt: "2026-04-13T00:00:00.000Z",
          parentSessionId: "root-session-auto",
          nativeSessionId: "ses_supervision_auto",
          source: "native_fork",
        },
      })
    } finally {
      if (previousSessionId === undefined) {
        delete process.env.SESSION_ID
      } else {
        process.env.SESSION_ID = previousSessionId
      }

      if (previousOpencodeSessionId === undefined) {
        delete process.env.OPENCODE_SESSION_ID
      } else {
        process.env.OPENCODE_SESSION_ID = previousOpencodeSessionId
      }
    }
  })

  test("resolveRootAgentBranchContext keeps explicit overrides over auto-resolved branch context", async () => {
    workspace = createTestWorkstream("001-supervise-context-overrides")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-context-overrides")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "pending")

    const startedAt = new Date().toISOString()
    await upsertBranchSessionLocked(
      workspace.repoRoot,
      workspace.streamId,
      buildRootAgentBranchSession({
        context: {
          rootSessionId: "root-session-auto",
          branchSessionId: "branch-supervision-auto",
          checkpointMessageId: "msg-root-auto",
          checkpointCreatedAt: "2026-04-13T00:00:00.000Z",
          parentSessionId: "root-session-auto",
          nativeSessionId: "ses_supervision_auto",
        },
        branchRole: "supervision",
        status: "running",
        startedAt,
        updatedAt: startedAt,
        batchId: "01.01",
      }),
    )

    const previousSessionId = process.env.SESSION_ID
    process.env.SESSION_ID = "ses_supervision_auto"

    try {
      const resolved = await resolveRootAgentBranchContext(
        {
          rootSessionId: "root-session-override",
          branchSessionId: "branch-supervision-override",
          parentSessionId: "root-session-override",
          checkpointMessageId: "msg-override",
          checkpointCreatedAt: "2026-04-14T00:00:00.000Z",
        },
        workspace.repoRoot,
        workspace.streamId,
      )

      expect(resolved).toMatchObject({
        streamId: workspace.streamId,
        branchContext: {
          rootSessionId: "root-session-override",
          branchSessionId: "branch-supervision-override",
          parentSessionId: "root-session-override",
          checkpointMessageId: "msg-override",
          checkpointCreatedAt: "2026-04-14T00:00:00.000Z",
          nativeSessionId: "ses_supervision_auto",
          source: "native_fork",
        },
      })
    } finally {
      if (previousSessionId === undefined) {
        delete process.env.SESSION_ID
      } else {
        process.env.SESSION_ID = previousSessionId
      }
    }
  })

  test("CLI auto-resolves the active stream for branch-supervision dry runs", async () => {
    workspace = createTestWorkstream("001-supervise-auto-stream")
    mkdirSync(join(workspace.repoRoot, "work"), { recursive: true })
    writeFileSync(
      join(workspace.repoRoot, "work", "index.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          last_updated: new Date().toISOString(),
          streams: [
            {
              id: workspace.streamId,
              name: "supervise-auto-stream",
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
              path: `work/${workspace.streamId}`,
              generated_by: { workstreams: "test" },
            },
          ],
        },
        null,
        2,
      ),
    )
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "pending")

    const startedAt = new Date().toISOString()
    await upsertBranchSessionLocked(
      workspace.repoRoot,
      workspace.streamId,
      buildRootAgentBranchSession({
        context: {
          rootSessionId: "root-session-auto-stream",
          branchSessionId: "branch-supervision-auto-stream",
          checkpointMessageId: "msg-root-auto-stream",
          checkpointCreatedAt: "2026-04-13T00:00:00.000Z",
          parentSessionId: "root-session-auto-stream",
          nativeSessionId: "ses_supervision_auto_stream",
        },
        branchRole: "supervision",
        status: "running",
        startedAt,
        updatedAt: startedAt,
        batchId: "01.01",
      }),
    )

    process.env.SESSION_ID = "ses_supervision_auto_stream"
    delete process.env.OPENCODE_SESSION_ID

    const { stdout } = await captureCliOutput(async () => {
      await superviseMain([
        "bun",
        "work-supervise",
        "--repo-root",
        workspace!.repoRoot,
        "--dry-run",
      ])
    })

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] resolved branch context: root=root-session-auto-stream")
    expect(output).toContain("[supervise] dry run for stream")
    expect(output).toContain("[supervise] would launch batch 01.01")
  })

  test("CLI preserve stage-scoped supervision progress when recording follow-up branch state", async () => {
    workspace = createTestWorkstream("001-supervise-stage-scope")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-stage-scope")
    writeTwoBatchPlan(workspace.workDir)
    writeTasksList(workspace.workDir, workspace.streamId, [
      {
        id: "01.01.01.01",
        status: "completed",
        threadName: "Thread 1",
        batchName: "Batch 1",
        stageName: "Stage 1",
        report: "Completed first batch before supervise handoff.",
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
      threads: [{ threadId: "01.01.01", sessions: [] }],
    })

    writeFileSync(
      getRunResultPath(workspace.streamId, "01.01.01"),
      JSON.stringify({ status: "completed", exitCode: 0 }),
    )

    const startedAt = new Date().toISOString()
    await upsertBranchSessionLocked(
      workspace.repoRoot,
      workspace.streamId,
      buildRootAgentBranchSession({
        context: {
          rootSessionId: "root-session-stage-1",
          branchSessionId: "branch-supervision-stage-1",
          checkpointMessageId: "msg-root-checkpoint-stage",
          checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
          parentSessionId: "root-session-stage-1",
          nativeSessionId: "ses_supervision_stage_1",
          scope: {
            level: "stage",
            stageId: "01",
          },
        },
        branchRole: "supervision",
        status: "pending",
        startedAt,
        updatedAt: startedAt,
        batchId: "01.01",
      }),
    )

    const fakeRuntime = join(workspace.repoRoot, "fake-bun-stage-scope")
    writeFileSync(fakeRuntime, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    process.execPath = fakeRuntime

    const previousOpencodeSessionId = process.env.OPENCODE_SESSION_ID
    process.env.OPENCODE_SESSION_ID = "ses_supervision_stage_1"

    try {
      await captureCliOutput(async () => {
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
    } finally {
      if (previousOpencodeSessionId === undefined) {
        delete process.env.OPENCODE_SESSION_ID
      } else {
        process.env.OPENCODE_SESSION_ID = previousOpencodeSessionId
      }
    }

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.branch_sessions[0]).toMatchObject({
      branchSessionId: "branch-supervision-stage-1",
      scope: {
        level: "stage",
        stageId: "01",
      },
      supervisionProgress: {
        executionMode: "stage_batch_loop",
        currentBatchId: "01.01",
      },
    })
    expect(supervisorState?.branch_sessions[0]?.batchId).toBeUndefined()
  })

  test("stage-scoped plain work supervise stays bounded to the active stage", async () => {
    workspace = createTestWorkstream("001-supervise-stage-bounded-rerun")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-stage-bounded-rerun")
    writeValidPlan(workspace.workDir)
    writeTasksList(workspace.workDir, workspace.streamId, [
      {
        id: "01.01.01.01",
        status: "completed",
        threadName: "Thread 1",
        batchName: "Batch 1",
        stageName: "Stage 1",
        report: "Completed stage batch 01.01.",
      },
      {
        id: "01.02.01.01",
        status: "completed",
        threadName: "Thread 1",
        batchName: "Batch 2",
        stageName: "Stage 1",
        report: "Completed stage batch 01.02.",
      },
      {
        id: "02.01.01.01",
        status: "pending",
        threadName: "Thread 1",
        batchName: "Batch 1",
        stageName: "Stage 2",
      },
    ])

    const startedAt = new Date().toISOString()
    await upsertBranchSessionLocked(
      workspace.repoRoot,
      workspace.streamId,
      buildRootAgentBranchSession({
        context: {
          rootSessionId: "root-session-stage-bounded",
          branchSessionId: "branch-supervision-stage-bounded",
          checkpointMessageId: "msg-root-stage-bounded",
          checkpointCreatedAt: "2026-04-13T00:00:00.000Z",
          parentSessionId: "root-session-stage-bounded",
          nativeSessionId: "ses_supervision_stage_bounded",
          scope: {
            level: "stage",
            stageId: "01",
          },
        },
        branchRole: "supervision",
        status: "running",
        startedAt,
        updatedAt: startedAt,
      }),
    )

    const previousOpencodeSessionId = process.env.OPENCODE_SESSION_ID
    process.env.OPENCODE_SESSION_ID = "ses_supervision_stage_bounded"

    try {
      const { stdout } = await captureCliOutput(async () => {
        await superviseMain([
          "bun",
          "work-supervise",
          "--repo-root",
          workspace!.repoRoot,
          "--stream",
          workspace!.streamId,
        ])
      })

      const output = stdout.join("\n")
      expect(output).toContain("[supervise] resolved branch context:")
      expect(output).toContain(
        `[supervise] No incomplete batches remain within stage 01 for ${workspace.streamId}.`,
      )
      expect(output).not.toContain("02.01")
    } finally {
      if (previousOpencodeSessionId === undefined) {
        delete process.env.OPENCODE_SESSION_ID
      } else {
        process.env.OPENCODE_SESSION_ID = previousOpencodeSessionId
      }
    }
  })

  test("supervise resolves native branch ancestry and multi persists it into thread lineage", async () => {
    workspace = createTestWorkstream("001-supervise-thread-lineage")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-thread-lineage")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "pending")
    saveThreads(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      threads: [],
    })

    const startedAt = new Date().toISOString()
    await upsertBranchSessionLocked(
      workspace.repoRoot,
      workspace.streamId,
      buildRootAgentBranchSession({
        context: {
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-1",
          checkpointMessageId: "msg-root-checkpoint",
          checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
          parentSessionId: "root-session-1",
        },
        branchRole: "supervision",
        status: "pending",
        startedAt,
        updatedAt: startedAt,
        batchId: "01.01",
      }),
    )

    setTimeout(() => {
      void upsertBranchSessionLocked(
        workspace!.repoRoot,
        workspace!.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            checkpointMessageId: "msg-root-checkpoint",
            checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_1",
          },
          branchRole: "supervision",
          status: "running",
          startedAt,
          updatedAt: new Date().toISOString(),
          batchId: "01.01",
        }),
      )
    }, 25)

    const resolved = await resolveRootAgentBranchContext(
      {
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        checkpointMessageId: "msg-root-checkpoint",
        checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
        parentSessionId: "root-session-1",
      },
      workspace.repoRoot,
      workspace.streamId,
    )

    expect(resolved).toMatchObject({
      streamId: workspace.streamId,
      branchContext: {
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        checkpointMessageId: "msg-root-checkpoint",
        checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
        parentSessionId: "root-session-1",
        nativeSessionId: "ses_supervision_1",
        source: "native_fork",
      },
    })

    const branchContext = resolved.branchContext
    expect(branchContext).toBeTruthy()

    const lineage = buildRootAgentThreadSessionLineage(
      {
        rootSessionId: branchContext!.rootSessionId,
        parentSessionId: branchContext!.nativeSessionId,
        parentBranchSessionId: branchContext!.branchSessionId,
        branchRole: "supervision",
      },
      "thread-session-1",
    )

    await startMultipleSessionsLocked(workspace.repoRoot, workspace.streamId, [
      {
        taskId: "01.01.01.01",
        agentName: "systems-engineer",
        model: "openai/gpt-5.4",
        sessionId: "thread-session-1",
        lineage,
      },
    ])

    expect(getThreadMetadata(workspace.repoRoot, workspace.streamId, "01.01.01")?.sessions[0]?.lineage).toEqual({
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "thread-session-1",
      branchRole: "supervision",
      parentBranchSessionId: "branch-supervision-1",
      parentSessionId: "ses_supervision_1",
      source: "native_fork",
    })
  })

  test("timeout while waiting keeps the helper resumable and resumed recovery avoids review ownership", async () => {
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
    expect(timeoutMessage).toContain("Timed out after 5ms waiting for batch 01.01")

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] waiting for batch-status 01.01")
    expect(output).toContain("[supervise] timeout:")
    expect(output).not.toContain("[supervise] handoff:")
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
    expect(resumedOutput).toContain("[supervise] resume: batch 01.01 already reached completed; recovering persisted results from run")
    expect(resumedOutput).toContain("[supervise] recovering terminal batch-status 01.01")
    expect(resumedOutput).toContain("[supervise] handoff: batch 01.01 reached completed")
    expect(resumedOutput).not.toContain("[supervise] review 01.01")

    supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs).toHaveLength(1)
    expect(supervisorState?.runs[0]?.status).toBe("paused")
    expect(supervisorState?.reviewed_batches).toHaveLength(0)
    expect(supervisorState?.stage_stops).toHaveLength(0)
    expect(supervisorState?.active_run_id).toBeUndefined()
  })

  test("rerunning without --batch after timeout prioritizes the paused batch before the next incomplete batch", async () => {
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

    const { stdout } = await captureCliOutput(async () => {
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
    })

    const output = stdout.join("\n")
    expect(output).toContain("[supervise] resume: batch 01.01 already reached completed; recovering persisted results from run")
    expect(output).toContain("[supervise] recovering terminal batch-status 01.01")
    expect(output).toContain("[supervise] handoff: batch 01.01 reached completed")
    expect(output).not.toContain("[supervise] waiting for batch-status 01.02")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.runs[0]?.currentBatchId).toBe("01.01")
    expect(supervisorState?.runs[0]?.status).toBe("paused")
    expect(supervisorState?.reviewed_batches).toHaveLength(0)
  })

  test("rerunning an already-terminal paused batch recovers without relaunching work", async () => {
    workspace = createTestWorkstream("001-supervise-terminal-rerun")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-terminal-rerun")
    writeValidPlan(workspace.workDir)
    writeTasks(workspace.workDir, workspace.streamId, "completed", "Already handled.")

    writeFileSync(
      getRunResultPath(workspace.streamId, "01.01.01"),
      JSON.stringify({ status: "completed", exitCode: 0 }),
    )

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
              status: "paused",
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              currentBatchId: "01.01",
              reviewPasses: 0,
              issueSummaryIds: [],
              escalationIds: [],
            },
          ],
          reviewed_batches: [],
          issue_summaries: [],
          fix_cycles: [],
          escalations: [],
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
    expect(output).toContain("[supervise] recovering terminal batch-status 01.01")
    expect(output).toContain("[supervise] handoff: batch 01.01 reached completed")
    expect(output).not.toContain("[supervise] start batch 01.01")
    expect(output).not.toContain("already has a persisted supervisor outcome")
  })

  test("rerunning a failed interrupted batch resumes recovery for the requested batch instead of relaunching completed work", async () => {
    workspace = createTestWorkstream("001-supervise-interrupted-failure-recovery")
    writeIndex(workspace.repoRoot, workspace.streamId, "supervise-interrupted-failure-recovery")
    writeValidPlan(workspace.workDir)
    writeTasks(
      workspace.workDir,
      workspace.streamId,
      "completed",
      "Completed before the helper caller was interrupted.",
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

    saveSupervisorState(workspace.repoRoot, workspace.streamId, {
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
      checkpoint_pointers: [],
      branch_sessions: [],
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
    })

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
    expect(output).toContain(
      "[supervise] resume: batch 01.01 already reached completed; recovering persisted results from run sup-01-failed.",
    )
    expect(output).toContain("[supervise] recovering terminal batch-status 01.01")
    expect(output).toContain("[supervise] handoff: batch 01.01 reached completed")
    expect(output).not.toContain("[supervise] start batch 01.01")
    expect(output).not.toContain("[supervise] review 01.01")

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState?.active_run_id).toBeUndefined()
    expect(supervisorState?.runs.find((run) => run.runId === "sup-00-stale")?.status).toBe("running")
    expect(supervisorState?.runs.find((run) => run.runId === "sup-01-failed")?.status).toBe("paused")
    expect(
      supervisorState?.stage_stops.find((stop) => stop.stopId === "sup-01-failed-error-stop"),
    ).toBeUndefined()
    expect(supervisorState?.reviewed_batches).toHaveLength(0)
    expect(supervisorState?.stage_stops).toHaveLength(0)
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
      expect(stdout.join("\n")).toMatch(
        /^[\s]+supervise\s+Run batch-bounded supervision execution\/recovery helper$/m,
      )
    } finally {
      process.exit = originalExit
    }
  })
})
