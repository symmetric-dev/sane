import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

import {
  checkTasksApprovalReady,
  queryFullApprovalStatus,
  queryStageApprovalStatus,
  queryTasksApprovalStatus,
} from "../src/lib/approval.ts"
import { createBatchStatusFile } from "../src/lib/batch-status.ts"
import { saveIndex } from "../src/lib/index.ts"
import {
  bootstrapSqliteStructuredStorage,
  syncStructuredStorageWorkstreamStateToSqlite,
} from "../src/lib/sqlite-storage.ts"
import {
  approvalMetadataToStructuredApprovalRecords,
  createEmptyStructuredStorageWorkstreamState,
} from "../src/lib/structured-storage.ts"
import { getTaskById, getTasks, readTasksFile } from "../src/lib/tasks.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers"

describe("sqlite-backed approval and task queries", () => {
  test("prefers sqlite task and approval reads over stale compatibility files", () => {
    const workspace = createTestWorkstream(`001-sqlite-read-queries-${Date.now()}`)

    try {
      const index: WorkIndex = {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        streams: [
          {
            id: workspace.streamId,
            name: "sqlite-read-queries",
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
            generated_by: { workstreams: "1.0.0" },
          },
        ],
      }
      saveIndex(workspace.repoRoot, index)

      writeFileSync(
        `${workspace.workDir}/tasks.json`,
        JSON.stringify(
          {
            version: "1.0.0",
            stream_id: workspace.streamId,
            last_updated: new Date().toISOString(),
            tasks: [
              {
                id: "01.01.01.01",
                name: "Legacy pending task",
                thread_name: "Legacy thread",
                batch_name: "Legacy batch",
                stage_name: "Legacy stage",
                created_at: "2026-04-20T00:00:00.000Z",
                updated_at: "2026-04-20T00:00:00.000Z",
                status: "pending",
              },
            ],
          },
          null,
          2,
        ),
      )

      const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
      state.hierarchy.stages = [{ id: "01", number: 1, name: "Sqlite stage" }]
      state.hierarchy.batches = [{ id: "01.01", stageId: "01", number: 1, name: "Sqlite batch" }]
      state.hierarchy.threads = [
        { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Sqlite thread" },
      ]
      state.hierarchy.tasks = [
        {
          id: "01.01.01.01",
          stageId: "01",
          batchId: "01.01",
          threadId: "01.01.01",
          number: 1,
          name: "Sqlite completed task",
          status: "completed",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        },
      ]
      state.approvals = approvalMetadataToStructuredApprovalRecords(workspace.streamId, {
        status: "approved",
        tasks: {
          status: "approved",
          approved_at: "2026-04-20T00:00:00.000Z",
          task_count: 1,
        },
        stages: {
          1: {
            status: "approved",
            approved_at: "2026-04-20T00:00:00.000Z",
            approved_by: "sqlite-user",
          },
        },
      })

      bootstrapSqliteStructuredStorage(workspace.repoRoot)
      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, state)

      expect(getTaskById(workspace.repoRoot, workspace.streamId, "01.01.01.01")).toMatchObject({
        name: "Sqlite completed task",
        status: "completed",
      })
      expect(getTasks(workspace.repoRoot, workspace.streamId, "completed")).toEqual([
        expect.objectContaining({ id: "01.01.01.01", status: "completed" }),
      ])
      expect(queryStageApprovalStatus(workspace.repoRoot, workspace.streamId, 1)).toBe("approved")
      expect(queryTasksApprovalStatus(workspace.repoRoot, workspace.streamId)).toBe("approved")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("readTasksFile skips stale legacy batch-status imports when sqlite canonical state exists", () => {
    const workspace = createTestWorkstream(`001-sqlite-runtime-read-${Date.now()}`)

    try {
      writeFileSync(
        `${workspace.workDir}/tasks.json`,
        JSON.stringify(
          {
            version: "2.0.0",
            stream_id: workspace.streamId,
            last_updated: new Date().toISOString(),
            runtime_state: {
              version: "1.0.0",
              last_updated: new Date().toISOString(),
              threads: [],
              batches: {},
              supervision: {
                version: "1.0.0",
                stream_id: workspace.streamId,
                last_updated: new Date().toISOString(),
                runs: [],
                checkpoint_pointers: [],
                branch_sessions: [],
                reviewed_batches: [],
                issue_summaries: [],
                fix_cycles: [],
                escalations: [],
                stage_stops: [],
              },
            },
            tasks: [],
          },
          null,
          2,
        ),
      )

      mkdirSync(join(workspace.workDir, "batch-status"), { recursive: true })
      writeFileSync(
        join(workspace.workDir, "batch-status", "01.01.json"),
        JSON.stringify(
          {
            ...createBatchStatusFile({
              streamId: workspace.streamId,
              batchId: "01.01",
              stageName: "Legacy stage",
              batchName: "Legacy batch",
              threads: [],
            }),
            status: "failed",
          },
          null,
          2,
        ),
      )

      const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
      state.hierarchy.stages = [{ id: "01", number: 1, name: "Sqlite stage" }]
      state.hierarchy.batches = [{ id: "01.01", stageId: "01", number: 1, name: "Sqlite batch" }]
      state.batchRuns = [
        {
          ...createBatchStatusFile({
            streamId: workspace.streamId,
            batchId: "01.01",
            stageName: "Sqlite stage",
            batchName: "Sqlite batch",
            threads: [],
          }),
          status: "completed",
          completedAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          summary: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 },
        },
      ]

      bootstrapSqliteStructuredStorage(workspace.repoRoot)
      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, state)

      const tasksFile = readTasksFile(workspace.repoRoot, workspace.streamId)
      expect(tasksFile?.runtime_state?.batches).toEqual({})
      expect(tasksFile?.runtime_summary?.batches["01.01"]).toMatchObject({
        batch_id: "01.01",
        status: "completed",
      })

      const persisted = JSON.parse(readFileSync(`${workspace.workDir}/tasks.json`, "utf-8")) as {
        runtime_state?: { batches?: Record<string, unknown> }
      }
      expect(persisted.runtime_state?.batches).toEqual({})
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("thread-first approval readiness ignores stale compatibility task_count snapshots", () => {
    const workspace = createTestWorkstream(`001-sqlite-approval-ready-${Date.now()}`)

    try {
      const index: WorkIndex = {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        current_stream: workspace.streamId,
        streams: [
          {
            id: workspace.streamId,
            name: "sqlite-approval-ready",
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
            generated_by: { workstreams: "1.0.0" },
            approval: {
              status: "approved",
              tasks: {
                status: "approved",
                approved_at: "2026-04-20T00:00:00.000Z",
                task_count: 99,
              },
            },
          },
        ],
      }
      saveIndex(workspace.repoRoot, index)

      bootstrapSqliteStructuredStorage(workspace.repoRoot)

      const emptyState = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
      emptyState.approvals = approvalMetadataToStructuredApprovalRecords(workspace.streamId, {
        status: "approved",
        tasks: {
          status: "approved",
          approved_at: "2026-04-20T00:00:00.000Z",
          task_count: 99,
        },
      })
      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, emptyState)

      expect(checkTasksApprovalReady(workspace.repoRoot, workspace.streamId)).toEqual({
        ready: false,
        reason:
          "Execution hierarchy has not been initialized yet. Run 'work approve plan' to seed compatibility tasks from PLAN.md.",
        taskCount: 0,
      })
      expect(queryFullApprovalStatus(workspace.repoRoot, workspace.streamId)).toEqual({
        plan: "approved",
        tasks: "approved",
        fullyApproved: true,
      })

      const threadedState = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
      threadedState.hierarchy.stages = [{ id: "01", number: 1, name: "Stage 01" }]
      threadedState.hierarchy.batches = [{ id: "01.01", stageId: "01", number: 1, name: "Batch 01" }]
      threadedState.hierarchy.threads = [
        { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Thread 01" },
      ]
      threadedState.approvals = emptyState.approvals
      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, threadedState)

      expect(checkTasksApprovalReady(workspace.repoRoot, workspace.streamId)).toEqual({
        ready: true,
        taskCount: 0,
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
