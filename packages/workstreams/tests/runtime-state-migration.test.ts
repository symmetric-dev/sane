import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import {
  createBatchStatusFile,
  readBatchStatus,
  writeBatchStatus,
  writeBatchStatusLocked,
} from "../src/lib/batch-status"
import { loadSupervisorState, upsertSupervisorRunLocked } from "../src/lib/supervisor-state"
import { readTasksFile } from "../src/lib/tasks"
import { loadThreads, startThreadSessionLocked } from "../src/lib/threads"
import type { TasksFile } from "../src/lib/types"
import { cleanupTestWorkstream, createTestWorkstream, type TestWorkspace } from "./helpers"

describe("runtime-state migration", () => {
  let workspace: TestWorkspace

  beforeEach(() => {
    workspace = createTestWorkstream()
  })

  afterEach(() => {
    cleanupTestWorkstream(workspace)
  })

  test("imports legacy runtime files into tasks.json and keeps current consumers working", () => {
    const tasksFile: TasksFile = {
      version: "2.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Task 1",
          thread_name: "Thread 1",
          batch_name: "Batch 1",
          stage_name: "Stage 1",
          status: "pending",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          sessions: [
            {
              sessionId: "legacy-task-session",
              agentName: "agent-local",
              model: "model-local",
              startedAt: new Date().toISOString(),
              status: "completed",
              completedAt: new Date().toISOString(),
            },
          ],
          currentSessionId: "legacy-task-session",
        },
      ],
    }
    writeFileSync(join(workspace.workDir, "tasks.json"), JSON.stringify(tasksFile, null, 2))

    writeFileSync(
      join(workspace.workDir, "threads.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: new Date().toISOString(),
          threads: [
            {
              threadId: "01.01.02",
              sessions: [],
              opencodeSessionId: "legacy-opencode-session",
            },
          ],
        },
        null,
        2,
      ),
    )

    writeFileSync(
      join(workspace.workDir, "supervisor-state.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: new Date().toISOString(),
          active_run_id: "legacy-run",
          runs: [
            {
              runId: "legacy-run",
              stageId: "01",
              status: "running",
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              reviewPasses: 0,
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
        null,
        2,
      ),
    )

    mkdirSync(join(workspace.workDir, "batch-status"), { recursive: true })
    writeFileSync(
      join(workspace.workDir, "batch-status", "01.01.json"),
      JSON.stringify(
        createBatchStatusFile({
          streamId: workspace.streamId,
          batchId: "01.01",
          stageName: "Stage 1",
          batchName: "Batch 1",
          threads: [{ threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" }],
        }),
        null,
        2,
      ),
    )

    const imported = readTasksFile(workspace.repoRoot, workspace.streamId)
    expect(imported).not.toBeNull()
    expect(imported!.runtime_state?.threads.map((thread) => thread.threadId)).toEqual([
      "01.01.01",
      "01.01.02",
    ])
    expect(imported!.runtime_state?.threads[0]?.sessions[0]?.sessionId).toBe("legacy-task-session")
    expect(imported!.runtime_state?.supervision.runs[0]?.runId).toBe("legacy-run")
    expect(imported!.runtime_state?.batches["01.01"]?.batchId).toBe("01.01")
    expect(imported!.tasks[0]?.sessions).toBeUndefined()
    expect(imported!.tasks[0]?.currentSessionId).toBeUndefined()

    expect(loadThreads(workspace.repoRoot, workspace.streamId)?.threads).toHaveLength(2)
    expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.active_run_id).toBe(
      "legacy-run",
    )
    expect(readBatchStatus(workspace.repoRoot, workspace.streamId, "01.01")?.batchId).toBe("01.01")

    const updatedBatch = createBatchStatusFile({
      streamId: workspace.streamId,
      batchId: "01.01",
      stageName: "Stage 1",
      batchName: "Batch 1",
      threads: [{ threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" }],
    })
    updatedBatch.status = "completed"
    updatedBatch.summary = { total: 1, pending: 0, running: 0, completed: 1, failed: 0 }
    updatedBatch.completedAt = new Date().toISOString()
    updatedBatch.threads[0] = {
      ...updatedBatch.threads[0]!,
      status: "completed",
      completedAt: updatedBatch.completedAt,
    }
    writeBatchStatus(workspace.repoRoot, workspace.streamId, updatedBatch)

    expect(readBatchStatus(workspace.repoRoot, workspace.streamId, "01.01")?.status).toBe("completed")
  })

  test("shared runtime mutation path preserves mixed concurrent writes", async () => {
    const tasksFile: TasksFile = {
      version: "2.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Task 1",
          thread_name: "Thread 1",
          batch_name: "Batch 1",
          stage_name: "Stage 1",
          status: "pending",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    }
    writeFileSync(join(workspace.workDir, "tasks.json"), JSON.stringify(tasksFile, null, 2))

    await Promise.all([
      ...Array.from({ length: 5 }, (_, index) =>
        startThreadSessionLocked(
          workspace.repoRoot,
          workspace.streamId,
          "01.01.01",
          `agent-${index}`,
          "model-one",
          `session-${index}`,
        ),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        upsertSupervisorRunLocked(workspace.repoRoot, workspace.streamId, {
          runId: `run-${index}`,
          stageId: "01",
          status: "running",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reviewPasses: 0,
          issueSummaryIds: [],
          escalationIds: [],
        }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        writeBatchStatusLocked(
          workspace.repoRoot,
          workspace.streamId,
          createBatchStatusFile({
            streamId: workspace.streamId,
            batchId: `01.0${index + 1}`,
            stageName: "Stage 1",
            batchName: `Batch ${index + 1}`,
            threads: [
              {
                threadId: "01.01.01",
                threadName: "Thread 1",
                firstTaskId: "01.01.01.01",
              },
            ],
          }),
        ),
      ),
    ])

    const persisted = readTasksFile(workspace.repoRoot, workspace.streamId)
    expect(persisted?.runtime_state?.threads[0]?.sessions).toHaveLength(5)
    expect(persisted?.runtime_state?.supervision.runs).toHaveLength(5)
    expect(Object.keys(persisted?.runtime_state?.batches ?? {})).toHaveLength(5)
    expect(persisted?.runtime_state?.supervision.runs.map((run) => run.runId).sort()).toEqual([
      "run-0",
      "run-1",
      "run-2",
      "run-3",
      "run-4",
    ])

    const onDisk = JSON.parse(
      readFileSync(join(workspace.workDir, "tasks.json"), "utf-8"),
    ) as TasksFile
    expect(onDisk.runtime_state?.threads[0]?.sessions).toHaveLength(5)
    expect(Object.keys(onDisk.runtime_state?.batches ?? {})).toHaveLength(5)
  })
})
