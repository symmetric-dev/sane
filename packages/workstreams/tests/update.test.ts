import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { updateTask, updateThreadTasks } from "../src/lib/update"
import { addTasks, getTasks, readTasksFile } from "../src/lib/tasks"
import type { StreamMetadata, Task, TasksFile } from "../src/lib/types"

describe("updateTask", () => {
  let tempDir: string

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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-update-test-"))
    await mkdir(join(tempDir, "work", "001-test-stream"), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe("task status updates", () => {
    test("updates task status from pending to completed", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "01.01.01.02",
            name: "Second task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
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

      const result = await updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.01.01",
        status: "completed",
      })

      expect(result.updated).toBe(true)
      expect(result.taskId).toBe("01.01.01.01")
      expect(result.status).toBe("completed")
      expect(result.file).toBe("tasks.json")

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks[0]?.status).toBe("completed")
      expect(tasks[1]?.status).toBe("completed")
      expect(result.task?.id).toBe("01.01.01.01")
      expect(result.threadId).toBe("01.01.01")
      expect(result.count).toBe(2)
    })

    test("updates task status to in_progress", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
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

      const result = await updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.01.01",
        status: "in_progress",
      })

      expect(result.updated).toBe(true)
      expect(result.status).toBe("in_progress")

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks[0]?.status).toBe("in_progress")
    })

    test("resolves compatibility task updates to the owning thread mutation", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "01.01.01.02",
            name: "Second task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "01.01.02.01",
            name: "Other thread task",
            thread_name: "T2",
            batch_name: "B01",
            stage_name: "S1",
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

      const result = await updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.01.02",
        status: "completed",
        report: "done",
      })

      expect(result.threadId).toBe("01.01.01")
      expect(result.count).toBe(2)

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks.find((task) => task.id === "01.01.01.01")).toMatchObject({
        status: "completed",
        report: "done",
      })
      expect(tasks.find((task) => task.id === "01.01.01.02")).toMatchObject({
        status: "completed",
        report: "done",
      })
      expect(tasks.find((task) => task.id === "01.01.02.01")?.status).toBe("pending")
    })

    test("updates task status to blocked", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
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

      updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.01.01",
        status: "blocked",
      })

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks[0]?.status).toBe("blocked")
    })

    test("updates task status to cancelled", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
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

      updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.01.01",
        status: "cancelled",
      })

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks[0]?.status).toBe("cancelled")
    })

    test("updates task with report", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
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

      const reportText = "Completed the task successfully"
      const result = await updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.01.01",
        status: "completed",
        report: reportText,
      })

      expect(result.updated).toBe(true)
      expect(result.status).toBe("completed")
      expect(result.task?.report).toBe(reportText)

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks[0]?.report).toBe(reportText)
    })
  })

  describe("task selection", () => {
    test("updates specific task by ID", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Task 01.01.01.01",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "01.01.01.02",
            name: "Task 01.01.01.02",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "01.01.02.01",
            name: "Task 01.01.02.01",
            thread_name: "T2",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "02.01.01.01",
            name: "Task 02.01.01.01",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S2",
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

      updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.02.01",
        status: "completed",
      })

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks.find((t) => t.id === "01.01.01.01")?.status).toBe("pending")
      expect(tasks.find((t) => t.id === "01.01.01.02")?.status).toBe("pending")
      expect(tasks.find((t) => t.id === "01.01.02.01")?.status).toBe(
        "completed",
      )
      expect(tasks.find((t) => t.id === "02.01.01.01")?.status).toBe("pending")
    })

    test("updates task in different stage", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Stage 01 Task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "02.01.01.01",
            name: "Stage 2 Task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S2",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "03.01.01.01",
            name: "Stage 3 Task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S3",
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

      updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "02.01.01.01",
        status: "completed",
      })

      const tasks = getTasks(tempDir, "001-test-stream")
      expect(tasks.find((t) => t.id === "01.01.01.01")?.status).toBe("pending")
      expect(tasks.find((t) => t.id === "02.01.01.01")?.status).toBe(
        "completed",
      )
      expect(tasks.find((t) => t.id === "03.01.01.01")?.status).toBe("pending")
    })
  })

  describe("error handling", () => {
    test("throws when task not found", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
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

      expect(() =>
        updateTask({
          repoRoot: tempDir,
          stream: baseStream,
          taskId: "01.01.01.05",
          status: "completed",
        }),
      ).toThrow('Task "01.01.01.05" not found')
    })

    test("throws when tasks.json does not exist", async () => {
      // Don't create tasks.json file

      expect(() =>
        updateTask({
          repoRoot: tempDir,
          stream: baseStream,
          taskId: "01.01.01.01",
          status: "completed",
        }),
      ).toThrow('Task "01.01.01.01" not found')
    })

    test("throws on invalid task ID format (two parts)", () => {
      expect(() =>
        updateTask({
          repoRoot: tempDir,
          stream: baseStream,
          taskId: "1.1",
          status: "completed",
        }),
      ).toThrow(
        'Invalid task ID: 1.1. Expected format "stage.batch.thread.task" (e.g., "01.01.02.03")',
      )
    })

    test("throws on invalid task ID format (single number)", () => {
      expect(() =>
        updateTask({
          repoRoot: tempDir,
          stream: baseStream,
          taskId: "1",
          status: "completed",
        }),
      ).toThrow("Invalid task ID")
    })

    test("accepts four-part task ID format (new batch format)", () => {
      // With the new batch hierarchy, 4-part IDs are valid
      // This test verifies that 4-part IDs don't throw an "Invalid task ID" error
      // (They may throw "task not found" if the task doesn't exist, which is expected)
      expect(() =>
        updateTask({
          repoRoot: tempDir,
          stream: baseStream,
          taskId: "01.01.02.03",
          status: "completed",
        }),
      ).toThrow("not found") // Task not found error, not "Invalid task ID"
    })
  })

  describe("timestamp updates", () => {
    test("updates task updated_at timestamp", async () => {
      const oldDate = "2020-01-01T00:00:01.000Z"
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: oldDate,
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: oldDate,
            updated_at: oldDate,
            status: "pending",
          },
        ],
      }

      await writeFile(
        join(tempDir, "work/001-test-stream/tasks.json"),
        JSON.stringify(tasksFile, null, 2),
      )

      const before = new Date()

      updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.01.01",
        status: "completed",
      })

      const tasks = getTasks(tempDir, "001-test-stream")
      const updatedTask = tasks[0]!
      const updatedDate = new Date(updatedTask.updated_at)

      expect(updatedDate.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(updatedTask.created_at).toBe(oldDate) // Created date unchanged
    })
  })

  describe("result object", () => {
    test("returns complete result object", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
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

      const result = await updateTask({
        repoRoot: tempDir,
        stream: baseStream,
        taskId: "01.01.01.01",
        status: "completed",
      })

      expect(result.updated).toBe(true)
      expect(result.file).toBe("tasks.json")
      expect(result.taskId).toBe("01.01.01.01")
      expect(result.threadId).toBe("01.01.01")
      expect(result.count).toBe(1)
      expect(result.status).toBe("completed")
      expect(result.task).not.toBeNull()
      expect(result.task?.name).toBe("First task")
    })
  })

  describe("thread updates", () => {
    test("updateThreadTasks preserves runtime state while updating thread tasks", async () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: "001-test-stream",
        last_updated: new Date().toISOString(),
        runtime_state: {
          version: "1.0.0",
          last_updated: new Date().toISOString(),
          threads: [
            {
              threadId: "01.01.01",
              sessions: [],
              currentSessionId: "session-1",
              opencodeSessionId: "opencode-1",
            },
          ],
          batches: {},
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
        },
        tasks: [
          {
            id: "01.01.01.01",
            name: "First task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
            created_at: "",
            updated_at: "",
            status: "pending",
          },
          {
            id: "01.01.01.02",
            name: "Second task",
            thread_name: "T1",
            batch_name: "B01",
            stage_name: "S1",
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

      const result = await updateThreadTasks({
        repoRoot: tempDir,
        stream: baseStream,
        threadId: "01.01.01",
        status: "completed",
        report: "done",
      })

      expect(result.updated).toBe(true)
      expect(result.count).toBe(2)
      expect(result.tasks.every((task) => task.status === "completed")).toBe(true)

      expect(readTasksFile(tempDir, "001-test-stream")?.runtime_state?.threads[0]).toMatchObject({
        threadId: "01.01.01",
        currentSessionId: "session-1",
        opencodeSessionId: "opencode-1",
      })
    })
  })
})
