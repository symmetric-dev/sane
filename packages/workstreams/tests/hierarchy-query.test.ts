import { describe, expect, test } from "bun:test"

import { bootstrapSqliteStructuredStorage, syncStructuredStorageWorkstreamStateToSqlite } from "../src/lib/sqlite-storage.ts"
import { createEmptyStructuredStorageWorkstreamState } from "../src/lib/structured-storage.ts"
import {
  loadWorkstreamHierarchyQueryResult,
  queryTasksForWorkstream,
} from "../src/lib/hierarchy-query.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers"

describe("hierarchy query read model", () => {
  test("reads ordered hierarchy and task views from sqlite rows", () => {
    const workspace = createTestWorkstream(`001-hierarchy-query-${Date.now()}`)

    try {
      const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
      state.hierarchy.stages = [
        { id: "01", number: 1, name: "Read model stage" },
        { id: "02", number: 2, name: "Follow-up stage" },
      ]
      state.hierarchy.batches = [
        { id: "01.01", stageId: "01", number: 1, name: "Primary batch" },
        { id: "02.01", stageId: "02", number: 1, name: "Secondary batch" },
      ]
      state.hierarchy.threads = [
        { id: "01.01.02", stageId: "01", batchId: "01.01", number: 2, name: "Thread beta" },
        { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Thread alpha" },
        { id: "02.01.01", stageId: "02", batchId: "02.01", number: 1, name: "Thread gamma" },
      ]
      state.hierarchy.tasks = [
        {
          id: "01.01.02.02",
          stageId: "01",
          batchId: "01.01",
          threadId: "01.01.02",
          number: 2,
          name: "Second sqlite task",
          status: "pending",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        },
        {
          id: "01.01.01.01",
          stageId: "01",
          batchId: "01.01",
          threadId: "01.01.01",
          number: 1,
          name: "First sqlite task",
          status: "completed",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          assignedAgent: "reader",
        },
        {
          id: "02.01.01.01",
          stageId: "02",
          batchId: "02.01",
          threadId: "02.01.01",
          number: 1,
          name: "Blocked sqlite task",
          status: "blocked",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        },
      ]

      bootstrapSqliteStructuredStorage(workspace.repoRoot)
      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, state)

      const query = loadWorkstreamHierarchyQueryResult(workspace.repoRoot, workspace.streamId)
      expect(query.source).toBe("sqlite")
      expect(query.stages.map((stage) => stage.id)).toEqual(["01", "02"])
      expect(query.threads.map((thread) => thread.id)).toEqual(["01.01.01", "01.01.02", "02.01.01"])
      expect(query.tasks.map((task) => task.id)).toEqual([
        "01.01.01.01",
        "01.01.02.02",
        "02.01.01.01",
      ])
      expect(query.tasks[0]).toMatchObject({
        stageName: "Read model stage",
        batchName: "Primary batch",
        threadName: "Thread alpha",
        assignedAgent: "reader",
      })

      expect(queryTasksForWorkstream(workspace.repoRoot, workspace.streamId, "blocked")).toEqual([
        expect.objectContaining({ id: "02.01.01.01", name: "Blocked sqlite task", status: "blocked" }),
      ])
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
