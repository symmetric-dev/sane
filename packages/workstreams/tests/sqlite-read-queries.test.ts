import { describe, expect, test } from "bun:test"
import { writeFileSync } from "fs"

import {
  queryStageApprovalStatus,
  queryTasksApprovalStatus,
} from "../src/lib/approval.ts"
import { saveIndex } from "../src/lib/index.ts"
import {
  bootstrapSqliteStructuredStorage,
  syncStructuredStorageWorkstreamStateToSqlite,
} from "../src/lib/sqlite-storage.ts"
import {
  approvalMetadataToStructuredApprovalRecords,
  createEmptyStructuredStorageWorkstreamState,
} from "../src/lib/structured-storage.ts"
import { getTaskById, getTasks } from "../src/lib/tasks.ts"
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
})
