import { afterEach, describe, expect, test } from "bun:test"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers/test-workspace.ts"
import { createEmptyStructuredStorageWorkstreamState } from "../src/lib/structured-storage.ts"
import { replaceStructuredWorkstreamStateSync, loadStructuredWorkstreamStateSync } from "../src/lib/storage-adapter.ts"
import { updateThreadExecution } from "../src/lib/update.ts"
import { readBatchStatus } from "../src/lib/batch-status.ts"
import type { StreamMetadata } from "../src/lib/types.ts"

function createStream(streamId: string): StreamMetadata {
  const now = new Date().toISOString()
  return {
    id: streamId,
    name: "Test Stream",
    path: `work/${streamId}`,
    order: 1,
    created_at: now,
    updated_at: now,
    generated_by: { workstreams: "test" },
    session_estimated: {
      length: 1,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [1, 1],
    },
    size: "short",
  }
}

describe("updateThreadExecution", () => {
  const workspaces: Array<ReturnType<typeof createTestWorkstream>> = []

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupTestWorkstream(workspaces.pop()!)
    }
  })

  test("reconciles a failed batch run after the last thread is manually completed", async () => {
    const workspace = createTestWorkstream(`001-update-reconcile-${Date.now()}`)
    workspaces.push(workspace)

    const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
    state.hierarchy.stages = [{ id: "01", number: 1, name: "Stage 01" }]
    state.hierarchy.batches = [{ id: "01.01", stageId: "01", number: 1, name: "Batch 01" }]
    state.hierarchy.threads = [
      { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "First thread" },
      { id: "01.01.02", stageId: "01", batchId: "01.01", number: 2, name: "Second thread" },
    ]
    state.threadRuntime = [
      {
        threadId: "01.01.01",
        sessions: [],
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        itemName: "First thread",
      },
      {
        threadId: "01.01.02",
        sessions: [],
        status: "blocked",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        itemName: "Second thread",
      },
    ]
    state.batchRuns = [
      {
        version: "1.0.0",
        streamId: workspace.streamId,
        batchId: "01.01",
        runId: "01.01-run-1",
        mode: "headless",
        status: "failed",
        stageName: "Stage 01",
        batchName: "Batch 01",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:10:00.000Z",
        completedAt: "2026-01-01T00:10:00.000Z",
        summary: {
          total: 2,
          pending: 0,
          running: 0,
          completed: 1,
          failed: 1,
        },
        threads: [
          {
            threadId: "01.01.01",
            threadName: "First thread",
            status: "completed",
            updatedAt: "2026-01-01T00:10:00.000Z",
            completedAt: "2026-01-01T00:05:00.000Z",
          },
          {
            threadId: "01.01.02",
            threadName: "Second thread",
            status: "failed",
            updatedAt: "2026-01-01T00:10:00.000Z",
            completedAt: "2026-01-01T00:10:00.000Z",
          },
        ],
      },
    ]

    replaceStructuredWorkstreamStateSync({
      repoRoot: workspace.repoRoot,
      workstreamState: state,
    })

    await updateThreadExecution({
      repoRoot: workspace.repoRoot,
      stream: createStream(workspace.streamId),
      threadId: "01.01.02",
      status: "completed",
      report: "Recovered on the correct stream.",
    })

    const nextState = loadStructuredWorkstreamStateSync(workspace.repoRoot, workspace.streamId)
    expect(nextState?.threadRuntime.find((thread) => thread.threadId === "01.01.02")?.status).toBe("completed")

    const batchStatus = readBatchStatus(workspace.repoRoot, workspace.streamId, "01.01")
    expect(batchStatus?.status).toBe("completed")
    expect(batchStatus?.summary).toEqual({
      total: 2,
      pending: 0,
      running: 0,
      completed: 2,
      failed: 0,
    })
    expect(batchStatus?.threads.map((thread) => thread.status)).toEqual(["completed", "completed"])
    expect(batchStatus?.threads[1]?.recoveryNote).toContain("restored from canonical execution state")
  })
})
