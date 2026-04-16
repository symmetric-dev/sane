import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createWorkstreamStatusSnapshot,
  formatProgress,
  getRuntimeSummaryEntries,
  getStreamProgress,
  getWorkstreamStatusSnapshot,
} from "../src/lib/status"
import {
  addTasks,
  getTasks,
  getTaskCounts,
  parseTaskId,
  formatTaskId,
} from "../src/lib/tasks"
import type {
  StreamMetadata,
  Task,
  TasksFile,
  StreamProgress,
} from "../src/lib/types"

describe("task operations", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-tasks-test-"))
    await mkdir(join(tempDir, "work", "001-test-stream"), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe("parseTaskId", () => {
    test("parses four-part ID", () => {
     const result = parseTaskId("01.01.02.03")
     expect(result).toEqual({
       stage: 1,
       batch: 1,
       thread: 2,
       task: 3,
     })
    })

    test("parses larger numbers", () => {
      const result = parseTaskId("04.01.05.10")
      expect(result).toEqual({
        stage: 4,
        batch: 1,
        thread: 5,
        task: 10,
      })
    })

    test("throws on two-part ID", () => {
      expect(() => parseTaskId("1.2")).toThrow(
        'Invalid task ID format: 1.2. Expected "stage.batch.thread.task" (e.g., "01.01.02.03")',
      )
    })

    test("throws on single number", () => {
      expect(() => parseTaskId("1")).toThrow("Invalid task ID format")
    })

    test("throws on empty string", () => {
      expect(() => parseTaskId("")).toThrow("Invalid task ID format")
    })
  })

  describe("formatTaskId", () => {
    test("formats task ID correctly", () => {
      expect(formatTaskId(1, 1, 2, 3)).toBe("01.01.02.03")
    })

    test("formats larger numbers with zero-padded batch", () => {
      expect(formatTaskId(10, 5, 2, 15)).toBe("10.05.02.15")
    })

     test("formats batch 1 as 01", () => {
       expect(formatTaskId(1, 1, 1, 1)).toBe("01.01.01.01")
     })
  })

  describe("addTasks", () => {
    test("creates tasks.json if it doesn't exist", async () => {
      const task: Task = {
        id: "01.01.01.01",
        name: "Test task",
        thread_name: "Thread 01",
        batch_name: "Batch 01",
        stage_name: "Stage 01",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "pending",
      }

      addTasks(tempDir, "001-test-stream", [task])

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.id).toBe("01.01.01.01")
    })

    test("appends tasks to existing file", async () => {
      const task1: Task = {
        id: "01.01.01.01",
        name: "First task",
        thread_name: "Thread 01",
        batch_name: "Batch 01",
        stage_name: "Stage 01",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "pending",
      }

      const task2: Task = {
        id: "01.01.01.02",
        name: "Second task",
        thread_name: "Thread 01",
        batch_name: "Batch 01",
        stage_name: "Stage 01",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "pending",
      }

      addTasks(tempDir, "001-test-stream", [task1])
      addTasks(tempDir, "001-test-stream", [task2])

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks).toHaveLength(2)
      expect(tasks[0]?.id).toBe("01.01.01.01")
      expect(tasks[1]?.id).toBe("01.01.01.02")
    })

    test("preserves existing task status when updating", async () => {
      const task1: Task = {
        id: "01.01.01.01",
        name: "Task",
        thread_name: "Thread 01",
        batch_name: "Batch 01",
        stage_name: "Stage 01",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: "completed",
      }

      addTasks(tempDir, "001-test-stream", [task1])

      // Add same task with different status
      const task1Updated: Task = {
        ...task1,
        name: "Updated Task",
        status: "pending",
      }

      addTasks(tempDir, "001-test-stream", [task1Updated])

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.status).toBe("completed") // Preserved
    })

    test("sorts tasks by ID", async () => {
      const tasks: Task[] = [
        {
          id: "2.01.1.1",
          name: "Task 2.01.1.1",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 2",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
        {
          id: "01.01.02.01",
          name: "Task 01.01.02.01",
          thread_name: "Thread 02",
          batch_name: "Batch 01",
          stage_name: "Stage 01",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
        {
          id: "01.01.01.01",
          name: "Task 01.01.01.01",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 01",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
      ]

      addTasks(tempDir, "001-test-stream", tasks)

      const result = getTasks(tempDir, "001-test-stream")
      expect(result[0]?.id).toBe("01.01.01.01")
      expect(result[1]?.id).toBe("01.01.02.01")
      expect(result[2]?.id).toBe("2.01.1.1")
    })
  })

  describe("getTasks", () => {
    test("returns empty array when no tasks.json exists", () => {
      const tasks = getTasks(tempDir, "nonexistent-stream")
      expect(tasks).toEqual([])
    })

    test("filters by status", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Pending",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "01.01.01.02",
            name: "Completed",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "completed",
          },
          {
            id: "01.01.01.03",
            name: "In Progress",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "in_progress",
          },
        ],
      }

      await writeFile(
        join(tempDir, "work/001-test-stream/tasks.json"),
        JSON.stringify(tasksFile, null, 2),
      )

      expect(getTasks(tempDir, "001-test-stream", "pending")).toHaveLength(1)
      expect(getTasks(tempDir, "001-test-stream", "completed")).toHaveLength(1)
      expect(getTasks(tempDir, "001-test-stream", "in_progress")).toHaveLength(
        1,
      )
    })
  })

  describe("getTaskCounts", () => {
    test("returns correct counts", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "T1",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "01.01.01.02",
            name: "T2",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "completed",
          },
          {
            id: "01.01.01.03",
            name: "T3",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "completed",
          },
          {
            id: "01.01.02.01",
            name: "T4",
            thread_name: "T2",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "in_progress",
          },
          {
            id: "01.01.02.02",
            name: "T5",
            thread_name: "T2",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "blocked",
          },
        ],
      }

      await writeFile(
        join(tempDir, "work/001-test-stream/tasks.json"),
        JSON.stringify(tasksFile, null, 2),
      )

      const counts = getTaskCounts(tempDir, "001-test-stream")
      expect(counts.total).toBe(5)
      expect(counts.pending).toBe(1)
      expect(counts.completed).toBe(2)
      expect(counts.in_progress).toBe(1)
      expect(counts.blocked).toBe(1)
      expect(counts.cancelled).toBe(0)
    })

    test("returns zeros when no tasks", () => {
      const counts = getTaskCounts(tempDir, "nonexistent-stream")
      expect(counts.total).toBe(0)
      expect(counts.pending).toBe(0)
      expect(counts.completed).toBe(0)
    })
  })
})

describe("getStreamProgress", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-progress-test-"))
    await mkdir(join(tempDir, "work", "001-test-stream"), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const baseStream: StreamMetadata = {
    id: "001-test-stream",
    name: "test-stream",
    order: 0,
    size: "medium",
    session_estimated: {
      length: 1,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8],
    },
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    path: "work/001-test-stream",
    generated_by: { workstreams: "0.1.0" },
  }

  test("builds a structured status snapshot for dashboard use", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: "001-test-stream",
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Done task",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
        {
          id: "01.01.01.02",
          name: "Cancelled task",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "cancelled",
        },
        {
          id: "02.01.01.01",
          name: "Active task",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 02",
          created_at: "",
          updated_at: "",
          status: "in_progress",
        },
        {
          id: "02.01.01.02",
          name: "Blocked task",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 02",
          created_at: "",
          updated_at: "",
          status: "blocked",
        },
        {
          id: "02.01.02.01",
          name: "Pending task",
          thread_name: "Thread 02",
          batch_name: "Batch 01",
          stage_name: "Stage 02",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const snapshot = getWorkstreamStatusSnapshot(tempDir, baseStream, baseStream.id)

    expect(snapshot.stream.id).toBe("001-test-stream")
    expect(snapshot.stream.is_current).toBe(true)
    expect(snapshot.aggregate_status).toBe("in_progress")
    expect(snapshot.counts).toMatchObject({
      total: 5,
      completed: 1,
      cancelled: 1,
      done: 2,
      in_progress: 1,
      blocked: 1,
      pending: 1,
    })
    expect(snapshot.completion).toMatchObject({
      total_tasks: 5,
      completed_tasks: 1,
      cancelled_tasks: 1,
      done_tasks: 2,
      remaining_tasks: 3,
      percent_complete: 20,
      percent_done: 40,
    })
    expect(snapshot.stages).toHaveLength(2)
    expect(snapshot.stages[0]).toMatchObject({
      stage_id: "01",
      status: "complete",
    })
    expect(snapshot.stages[0]?.counts.done).toBe(2)
    expect(snapshot.stages[1]).toMatchObject({
      stage_id: "02",
      status: "in_progress",
    })
    expect(snapshot.stages[1]?.counts.blocked).toBe(1)
  })

  test("returns structured runtime entries without CLI formatting", async () => {
    const now = new Date().toISOString()
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: "001-test-stream",
      last_updated: now,
      runtime_summary: {
        updated_at: now,
        batches: {
          "01.01": {
            batch_id: "01.01",
            run_id: "run-1",
            status: "failed",
            updated_at: now,
            started_at: now,
            thread_summary: {
              total: 1,
              pending: 0,
              running: 0,
              completed: 0,
              failed: 1,
            },
          },
        },
        supervision: {
          updated_at: now,
          current_branch: {
            branch_session_id: "branch-1",
            root_session_id: "root-1",
            status: "running",
            updated_at: now,
            stage_id: "01",
            batch_id: "01.01",
            current_batch_id: "01.01",
          },
        },
      },
      tasks: [
        {
          id: "01.01.01.01",
          name: "Pending task",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const snapshot = getWorkstreamStatusSnapshot(tempDir, baseStream)
    const entries = snapshot.runtime?.entries ?? []

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      kind: "batch",
      batch_id: "01.01",
      task_status: "pending",
      runtime_status: "failed",
      entry_status: "desync",
    })
    expect(entries[1]).toMatchObject({
      kind: "supervision_branch",
      target: "01.01",
      is_mismatched_with_tasks: false,
    })
    expect(getRuntimeSummaryEntries(snapshot.stages, snapshot.runtime?.summary)).toEqual(entries)
  })

  test("treats persisted runtime_summary as canonical when runtime_state diverges", async () => {
    const now = new Date().toISOString()
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: "001-test-stream",
      last_updated: now,
      runtime_summary: {
        updated_at: now,
        batches: {
          "01.01": {
            batch_id: "01.01",
            run_id: "summary-run",
            status: "running",
            updated_at: now,
            started_at: now,
            thread_summary: {
              total: 1,
              pending: 0,
              running: 1,
              completed: 0,
              failed: 0,
            },
          },
        },
      },
      runtime_state: {
        version: "1.0.0",
        last_updated: now,
        threads: [],
        batches: {
          "01.01": {
            version: "1.0.0",
            streamId: "001-test-stream",
            batchId: "01.01",
            runId: "state-run",
            mode: "headless",
            status: "failed",
            startedAt: now,
            updatedAt: now,
            summary: {
              total: 1,
              pending: 0,
              running: 0,
              completed: 0,
              failed: 1,
            },
            threads: [],
          },
        },
        supervision: {
          version: "1.0.0",
          stream_id: "001-test-stream",
          last_updated: now,
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
      tasks: [
        {
          id: "01.01.01.01",
          name: "Pending task",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const snapshot = getWorkstreamStatusSnapshot(tempDir, baseStream)
    const batchEntry = snapshot.runtime?.entries.find((entry) => entry.kind === "batch")

    expect(snapshot.runtime?.summary.batches["01.01"]?.run_id).toBe("summary-run")
    expect(batchEntry).toMatchObject({
      kind: "batch",
      runtime_status: "running",
      entry_status: "desync",
    })
  })

  test("marks supervision branch entries as mismatched for non-running states", () => {
    const now = new Date().toISOString()
    const snapshot = createWorkstreamStatusSnapshot({
      stream: baseStream,
      currentStreamId: "001-test-stream",
      tasks: [
        {
          id: "01.01.01.01",
          name: "Pending task",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
      runtimeSummary: {
        updated_at: now,
        batches: {},
        supervision: {
          updated_at: now,
          current_branch: {
            branch_session_id: "branch-1",
            root_session_id: "root-1",
            status: "stopped",
            updated_at: now,
            stage_id: "01",
            batch_id: "01.01",
            current_batch_id: "01.01",
          },
        },
      },
    })

    expect(snapshot.runtime?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "supervision_branch",
          task_status: "pending",
          is_mismatched_with_tasks: true,
        }),
      ]),
    )
  })

  test("handles empty or partial runtime summaries without synthetic entries", () => {
    const snapshot = createWorkstreamStatusSnapshot({
      stream: baseStream,
      tasks: [
        {
          id: "01.01.01.01",
          name: "Pending task",
          thread_name: "Thread 01",
          batch_name: "Batch 01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
      runtimeSummary: {
        updated_at: new Date().toISOString(),
        batches: {},
        supervision: {
          updated_at: new Date().toISOString(),
        },
      },
    })

    expect(snapshot.runtime?.entries).toEqual([])
  })

  test("calculates progress from tasks.json", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: "001-test-stream",
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Task 1",
          thread_name: "Thread 01",
          batch_name: "B01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
        {
          id: "01.01.01.02",
          name: "Task 2",
          thread_name: "Thread 01",
          batch_name: "B01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "in_progress",
        },
        {
          id: "01.01.02.01",
          name: "Task 3",
          thread_name: "Thread 02",
          batch_name: "B01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
        {
          id: "01.01.02.02",
          name: "Task 4",
          thread_name: "Thread 02",
          batch_name: "B01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "blocked",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const result = getStreamProgress(tempDir, baseStream)

    expect(result.streamId).toBe("001-test-stream")
    expect(result.streamName).toBe("test-stream")
    expect(result.totalTasks).toBe(4)
    expect(result.completedTasks).toBe(1)
    expect(result.inProgressTasks).toBe(1)
    expect(result.blockedTasks).toBe(1)
    expect(result.pendingTasks).toBe(1)
    expect(result.percentComplete).toBe(25)
  })

  test("groups tasks by stage", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: "001-test-stream",
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Stage 01 Task",
          thread_name: "Thread 01",
          batch_name: "B01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
        {
          id: "2.01.1.1",
          name: "Stage 2 Task",
          thread_name: "Thread 01",
          batch_name: "B01",
          stage_name: "Stage 2",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
        {
          id: "2.01.1.2",
          name: "Stage 2 Task 2",
          thread_name: "Thread 01",
          batch_name: "B01",
          stage_name: "Stage 2",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const result = getStreamProgress(tempDir, baseStream)

    expect(result.stages).toHaveLength(2)
    expect(result.stages[0]?.number).toBe(1)
    expect(result.stages[0]?.status).toBe("complete")
    expect(result.stages[1]?.number).toBe(2)
    expect(result.stages[1]?.status).toBe("pending")
  })

  test("calculates stage status correctly", async () => {
    // Stage with all completed
    const tasksFile1: TasksFile = {
      version: "1.0.0",
      stream_id: "001-test-stream",
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "T1",
          thread_name: "T1",
          batch_name: "B01",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
        {
          id: "01.01.01.02",
          name: "T2",
          thread_name: "T1",
          batch_name: "B01",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile1, null, 2),
    )

    let result = getStreamProgress(tempDir, baseStream)
    expect(result.stages[0]?.status).toBe("complete")

    // Stage with in_progress
    const tasksFile2: TasksFile = {
      ...tasksFile1,
      tasks: [
        {
          id: "01.01.01.01",
          name: "T1",
          thread_name: "T1",
          batch_name: "B01",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
        {
          id: "01.01.01.02",
          name: "T2",
          thread_name: "T1",
          batch_name: "B01",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "in_progress",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile2, null, 2),
    )

    result = getStreamProgress(tempDir, baseStream)
    expect(result.stages[0]?.status).toBe("in_progress")

    // Stage with only blocked (no progress)
    const tasksFile3: TasksFile = {
      ...tasksFile1,
      tasks: [
        {
          id: "01.01.01.01",
          name: "T1",
          thread_name: "T1",
          batch_name: "B01",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "blocked",
        },
        {
          id: "01.01.01.02",
          name: "T2",
          thread_name: "T1",
          batch_name: "B01",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "blocked",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile3, null, 2),
    )

    result = getStreamProgress(tempDir, baseStream)
    expect(result.stages[0]?.status).toBe("blocked")
  })

  test("returns 0 percent for empty workstream", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: "001-test-stream",
      last_updated: new Date().toISOString(),
      tasks: [],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const result = getStreamProgress(tempDir, baseStream)
    expect(result.totalTasks).toBe(0)
    expect(result.percentComplete).toBe(0)
  })

  test("handles missing tasks.json", () => {
    const result = getStreamProgress(tempDir, baseStream)
    expect(result.totalTasks).toBe(0)
    expect(result.stages).toHaveLength(0)
  })

  test("derives runtime summary from unified runtime_state when runtime_summary is absent", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: "001-test-stream",
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Task 1",
          thread_name: "Thread 01",
          batch_name: "B01",
          stage_name: "Stage 01",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )
    tasksFile.runtime_state = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      threads: [],
      batches: {
        "01.01": {
          version: "1.0.0",
          streamId: "001-test-stream",
          batchId: "01.01",
          runId: "run-1",
          mode: "headless",
          status: "failed",
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          summary: {
            total: 1,
            pending: 0,
            running: 0,
            completed: 0,
            failed: 1,
          },
          threads: [],
        },
      },
      supervision: {
        version: "1.0.0",
        stream_id: "001-test-stream",
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
    }
    delete tasksFile.runtime_summary
    await writeFile(
      join(tempDir, "work/001-test-stream/tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const result = getStreamProgress(tempDir, baseStream)
    expect(result.runtimeSummary?.batches["01.01"]?.status).toBe("failed")
  })
})

describe("formatProgress", () => {
  test("formats progress with all status types", () => {
    const progress: StreamProgress = {
      streamId: "001-test-stream",
      streamName: "test-stream",
      size: "medium",
      stages: [
        {
          number: 1,
          title: "Setup",
          status: "complete",
          tasks: [
            {
              id: "1.1.1",
              description: "Task",
              status: "completed",
              taskGroupNumber: 1,
              subtaskNumber: 1,
              lineNumber: 0,
            },
          ],
          file: "tasks.json",
        },
        {
          number: 2,
          title: "Implementation",
          status: "in_progress",
          tasks: [
            {
              id: "02.01.01.01",
              description: "Task",
              status: "in_progress",
              taskGroupNumber: 1,
              subtaskNumber: 1,
              lineNumber: 0,
            },
          ],
          file: "tasks.json",
        },
        {
          number: 3,
          title: "Testing",
          status: "blocked",
          tasks: [
            {
              id: "3.1.1",
              description: "Task",
              status: "blocked",
              taskGroupNumber: 1,
              subtaskNumber: 1,
              lineNumber: 0,
            },
          ],
          file: "tasks.json",
        },
        {
          number: 4,
          title: "Deploy",
          status: "pending",
          tasks: [
            {
              id: "4.1.1",
              description: "Task",
              status: "pending",
              taskGroupNumber: 1,
              subtaskNumber: 1,
              lineNumber: 0,
            },
          ],
          file: "tasks.json",
        },
      ],
      totalTasks: 4,
      completedTasks: 1,
      inProgressTasks: 1,
      blockedTasks: 1,
      pendingTasks: 1,
      percentComplete: 25,
    }

    const output = formatProgress(progress)

    expect(output).toContain("001-test-stream")
    expect(output).toContain("25%")
    expect(output).toContain("[x] Stage 01: Setup")
    expect(output).toContain("[~] Stage 02: Implementation")
    expect(output).toContain("[!] Stage 03: Testing")
    expect(output).toContain("[ ] Stage 04: Deploy")
  })

  test("shows progress bar", () => {
    const progress: StreamProgress = {
      streamId: "001-stream",
      streamName: "stream",
      size: "medium",
      stages: [],
      totalTasks: 10,
      completedTasks: 5,
      inProgressTasks: 0,
      blockedTasks: 0,
      pendingTasks: 5,
      percentComplete: 50,
    }

    const output = formatProgress(progress)

    expect(output).toContain("Progress:")
    expect(output).toContain("50%")
    expect(output).toContain("#")
    expect(output).toContain(".")
  })

  test("shows task counts", () => {
    const progress: StreamProgress = {
      streamId: "001-stream",
      streamName: "stream",
      size: "medium",
      stages: [],
      totalTasks: 10,
      completedTasks: 3,
      inProgressTasks: 2,
      blockedTasks: 1,
      pendingTasks: 4,
      percentComplete: 30,
    }

    const output = formatProgress(progress)

    expect(output).toContain("3/10 complete")
    expect(output).toContain("2 in-progress")
    expect(output).toContain("1 blocked")
  })

  test("uses stage title from task data", () => {
    const progress: StreamProgress = {
      streamId: "001-stream",
      streamName: "stream",
      size: "medium",
      stages: [
        {
          number: 1,
          title: "Stage 01",
          status: "pending",
          tasks: [],
          file: "tasks.json",
        },
      ],
      totalTasks: 0,
      completedTasks: 0,
      inProgressTasks: 0,
      blockedTasks: 0,
      pendingTasks: 0,
      percentComplete: 0,
    }

    const output = formatProgress(progress)

    expect(output).toContain("Stage 01")
  })

  test("shows supervision branch runtime context", () => {
    const progress: StreamProgress = {
      streamId: "001-stream",
      streamName: "stream",
      size: "medium",
      stages: [
        {
          number: 1,
          title: "Setup",
          status: "pending",
          tasks: [
            {
              id: "01.01.01.01",
              description: "Task",
              status: "pending",
              stageNumber: 1,
              taskGroupNumber: 1,
              subtaskNumber: 1,
              lineNumber: 0,
            },
          ],
          file: "tasks.json",
        },
      ],
      totalTasks: 1,
      completedTasks: 0,
      inProgressTasks: 0,
      blockedTasks: 0,
      pendingTasks: 1,
      percentComplete: 0,
      runtimeSummary: {
        updated_at: new Date().toISOString(),
        batches: {},
        supervision: {
          updated_at: new Date().toISOString(),
          current_branch: {
            stage_id: "01",
            batch_id: "01.01",
            current_batch_id: "01.01",
            status: "running",
            branch_session_id: "branch-session-1",
            root_session_id: "root-session-1",
            updated_at: new Date().toISOString(),
          },
        },
      },
    }

    const output = formatProgress(progress)

    expect(output).toContain("Runtime: supervision branch: running on 01.01")
  })
})
