import { describe, expect, test } from "bun:test"

import {
  buildWorkstreamTreeSnapshot,
  filterTasksForBatch,
  renderWorkstreamTree,
} from "../src/lib/tree.ts"
import type { Task, WorkstreamRuntimeSummary } from "../src/lib/types.ts"

describe("workstream tree read model", () => {
  test("builds a stable hierarchy with ids, labels, statuses, and counts", () => {
    const tasks: Task[] = [
      {
        id: "01.01.02.02",
        name: "Second task",
        stage_name: "Read models",
        batch_name: "Extract projections",
        thread_name: "Tree snapshot",
        status: "pending",
        assigned_agent: "systems-engineer",
        created_at: "",
        updated_at: "",
      },
      {
        id: "01.01.02.01",
        name: "First task",
        stage_name: "Read models",
        batch_name: "Extract projections",
        thread_name: "Tree snapshot",
        status: "completed",
        assigned_agent: "systems-engineer",
        created_at: "",
        updated_at: "",
      },
      {
        id: "02.01.01.01",
        name: "Other stage task",
        stage_name: "Dashboard",
        batch_name: "Server",
        thread_name: "Backend",
        status: "blocked",
        created_at: "",
        updated_at: "",
      },
    ]

    const snapshot = buildWorkstreamTreeSnapshot({
      streamId: "002-web-workstream-dashboard",
      tasks,
    })

    expect(snapshot.id).toBe("002-web-workstream-dashboard")
    expect(snapshot.displayLabel).toBe("Workstream: 002-web-workstream-dashboard")
    expect(snapshot.status).toBe("blocked")
    expect(snapshot.taskCount).toBe(3)
    expect(snapshot.taskCounts).toEqual({
      total: 3,
      pending: 1,
      in_progress: 0,
      completed: 1,
      blocked: 1,
      cancelled: 0,
      done: 1,
    })

    expect(snapshot.stages.map((stage) => stage.id)).toEqual(["01", "02"])

    const firstStage = snapshot.stages[0]!
    expect(firstStage.stageNumber).toBe(1)
    expect(firstStage.label).toBe("Stage 01")
    expect(firstStage.displayLabel).toBe("Stage 01: Read models")
    expect(firstStage.status).toBe("pending")
    expect(firstStage.taskCount).toBe(2)

    const firstBatch = firstStage.batches[0]!
    expect(firstBatch.id).toBe("01.01")
    expect(firstBatch.batchNumber).toBe(1)
    expect(firstBatch.displayLabel).toBe("Batch 01: Extract projections")
    expect(firstBatch.status).toBe("pending")
    expect(firstBatch.taskCount).toBe(2)

    const firstThread = firstBatch.threads[0]!
    expect(firstThread.id).toBe("01.01.02")
    expect(firstThread.threadNumber).toBe(2)
    expect(firstThread.displayLabel).toBe("Thread 02: Tree snapshot")
    expect(firstThread.assignedAgent).toBe("systems-engineer")
    expect(firstThread.status).toBe("pending")
    expect(firstThread.taskCount).toBe(2)
    expect(firstThread.tasks.map((task) => task.id)).toEqual(["01.01.02.01", "01.01.02.02"])
    expect(firstThread.tasks[0]).toMatchObject({
      label: "Task 01",
      displayLabel: "Task 01: First task",
      taskNumber: 1,
      status: "completed",
      taskCount: 1,
    })
  })

  test("preserves runtime notice and batch overlay metadata", () => {
    const tasks: Task[] = [
      {
        id: "01.01.01.01",
        name: "Task 1",
        stage_name: "Planning",
        batch_name: "Setup",
        thread_name: "Init",
        status: "pending",
        created_at: "",
        updated_at: "",
      },
    ]
    const runtimeSummary: WorkstreamRuntimeSummary = {
      updated_at: new Date().toISOString(),
      batches: {
        "01.01": {
          batch_id: "01.01",
          run_id: "run-1",
          status: "failed",
          updated_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          thread_summary: {
            total: 1,
            pending: 0,
            running: 0,
            completed: 0,
            failed: 1,
          },
        },
      },
    }

    const snapshot = buildWorkstreamTreeSnapshot({
      streamId: "001-test",
      tasks,
      runtimeSummary,
    })

    expect(snapshot.runtimeNotice).toMatchObject({
      kind: "failed_batch",
      batchId: "01.01",
      text: "batch 01.01 failed (1 failed thread)",
    })
    expect(snapshot.stages[0]?.batches[0]?.runtimeOverlay).toMatchObject({
      kind: "desync",
      taskStatus: "pending",
      runtimeStatus: "failed",
      detail: "1 failed",
      text: "desync: tasks pending, runtime failed (1 failed)",
    })

    expect(renderWorkstreamTree(snapshot).join("\n")).toContain(
      "Batch 01: Setup (1) [desync: tasks pending, runtime failed (1 failed)]",
    )
  })

  test("filters tasks for a normalized batch id", () => {
    const tasks: Task[] = [
      {
        id: "01.01.01.01",
        name: "Task 1",
        stage_name: "Planning",
        batch_name: "Setup",
        thread_name: "Init",
        status: "pending",
        created_at: "",
        updated_at: "",
      },
      {
        id: "01.02.01.01",
        name: "Task 2",
        stage_name: "Planning",
        batch_name: "Build",
        thread_name: "Work",
        status: "pending",
        created_at: "",
        updated_at: "",
      },
    ]

    expect(filterTasksForBatch(tasks, "1.2")?.map((task) => task.id)).toEqual(["01.02.01.01"])
    expect(filterTasksForBatch(tasks, "invalid")).toBeNull()
  })
})
