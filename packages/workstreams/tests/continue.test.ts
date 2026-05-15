import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getContinueContext } from "../src/lib/continue"
import { buildHeadlessThreadStatuses, findIncompleteThreadsInBatch, parseCliArgs as parseContinueCliArgs, resolveHeadlessContinueAction } from "../src/cli/continue"
import type { TasksFile, Task, ThreadMetadata } from "../src/lib/types"
import { bootstrapSqliteStructuredStorage, syncStructuredStorageWorkstreamStateToSqlite } from "../src/lib/sqlite-storage"
import { createEmptyStructuredStorageWorkstreamState } from "../src/lib/structured-storage"

describe("getContinueContext", () => {
  let tempDir: string
  const streamId = "001-test-stream"
  const streamName = "test-stream"

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-continue-test-"))
    await mkdir(join(tempDir, "work", streamId), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("returns active task if one exists", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: streamId,
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "1.1.1",
          name: "Completed Task",
          thread_name: "T1",
          batch_name: "B00",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
        {
          id: "1.1.2",
          name: "Active Task",
          thread_name: "T1",
          batch_name: "B00",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "in_progress",
          breadcrumb: "working on it",
        },
        {
          id: "1.1.3",
          name: "Pending Task",
          thread_name: "T1",
          batch_name: "B00",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work", streamId, "tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const ctx = getContinueContext(tempDir, streamId, streamName)

    expect(ctx.activeTask).toBeDefined()
    expect(ctx.activeTask?.id).toBe("1.1.2")
    expect(ctx.activeTask?.breadcrumb).toBe("working on it")
    expect(ctx.nextTask?.id).toBe("1.1.3")
    expect(ctx.lastCompletedTask?.id).toBe("1.1.1")
  })

  test("returns next pending task if no active task", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: streamId,
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "1.1.1",
          name: "Completed Task",
          thread_name: "T1",
          batch_name: "B00",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
        {
          id: "1.1.2",
          name: "Pending Task",
          thread_name: "T1",
          batch_name: "B00",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "pending",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work", streamId, "tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const ctx = getContinueContext(tempDir, streamId, streamName)

    expect(ctx.activeTask).toBeUndefined()
    expect(ctx.nextTask?.id).toBe("1.1.2")
    expect(ctx.lastCompletedTask?.id).toBe("1.1.1")
  })

  test("returns last completed task even if no pending tasks", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: streamId,
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "1.1.1",
          name: "Completed Task",
          thread_name: "T1",
          batch_name: "B00",
          stage_name: "S1",
          created_at: "",
          updated_at: "",
          status: "completed",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work", streamId, "tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const ctx = getContinueContext(tempDir, streamId, streamName)

    expect(ctx.activeTask).toBeUndefined()
    expect(ctx.nextTask).toBeUndefined()
    expect(ctx.lastCompletedTask?.id).toBe("1.1.1")
  })

  test("prefers canonical thread views over compatibility task ordering", async () => {
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: streamId,
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.02.01.01",
          name: "Later compatibility task",
          thread_name: "Compatibility thread 2",
          batch_name: "Compatibility batch 2",
          stage_name: "Compatibility stage 1",
          created_at: "",
          updated_at: "",
          status: "pending",
          assigned_agent: "compat-agent",
        },
      ],
    }

    await writeFile(
      join(tempDir, "work", streamId, "tasks.json"),
      JSON.stringify(tasksFile, null, 2),
    )

    const state = createEmptyStructuredStorageWorkstreamState(streamId)
    state.hierarchy.stages = [{ id: "01", number: 1, name: "Canonical stage" }]
    state.hierarchy.batches = [
      { id: "01.01", stageId: "01", number: 1, name: "Canonical batch 1" },
      { id: "01.02", stageId: "01", number: 2, name: "Canonical batch 2" },
    ]
    state.hierarchy.threads = [
      { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Canonical thread 1" },
      { id: "01.02.01", stageId: "01", batchId: "01.02", number: 1, name: "Canonical thread 2" },
    ]
    state.hierarchy.tasks = [
      {
        id: "01.01.01.01",
        stageId: "01",
        batchId: "01.01",
        threadId: "01.01.01",
        number: 1,
        name: "Canonical next task",
        status: "pending",
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        assignedAgent: "canonical-agent",
      },
      {
        id: "01.02.01.01",
        stageId: "01",
        batchId: "01.02",
        threadId: "01.02.01",
        number: 1,
        name: "Canonical later task",
        status: "pending",
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        assignedAgent: "later-agent",
      },
    ]

    bootstrapSqliteStructuredStorage(tempDir)
    syncStructuredStorageWorkstreamStateToSqlite(tempDir, state)

    const ctx = getContinueContext(tempDir, streamId, streamName)

    expect(ctx.nextTask?.id).toBe("01.01.01.01")
    expect(ctx.assignedAgent).toBe("canonical-agent")
  })
})

describe("continue cli helpers", () => {
  const baseTask: Task = {
    id: "01.01.01.01",
    name: "Test task",
    thread_name: "Thread 1",
    batch_name: "Batch 1",
    stage_name: "Stage 1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "pending",
  }

  test("parses headless and async flags", () => {
    const cliArgs = parseContinueCliArgs([
      "bun",
      "work",
      "--headless",
      "--async",
      "--stream",
      "001-test-stream",
    ])

    expect(cliArgs).toMatchObject({
      headless: true,
      async: true,
      streamId: "001-test-stream",
    })
  })

  test("finds incomplete threads from threads.json metadata", () => {
    const tasks: Task[] = [
      { ...baseTask, id: "01.01.01.01", status: "in_progress" },
      { ...baseTask, id: "01.01.02.01", thread_name: "Thread 2", status: "pending" },
      { ...baseTask, id: "01.02.01.01", batch_name: "Batch 2", status: "pending" },
    ]
    const threadMetadata: ThreadMetadata[] = [
      {
        threadId: "01.01.01",
        sessions: [
          {
            sessionId: "ses-1",
            agentName: "systems-engineer",
            model: "anthropic/claude-sonnet-4",
            startedAt: new Date().toISOString(),
            status: "failed",
          },
        ],
      },
      {
        threadId: "01.01.02",
        sessions: [],
      },
    ]

    expect(findIncompleteThreadsInBatch(tasks, "01.01", threadMetadata)).toEqual([
      "01.01.01",
    ])
  })

  test("builds thread statuses from thread metadata", () => {
    const tasks: Task[] = [
      { ...baseTask, id: "01.01.01.01", status: "in_progress" },
      { ...baseTask, id: "01.01.02.01", thread_name: "Thread 2", status: "pending" },
    ]
    const threadMetadata: ThreadMetadata[] = [
      {
        threadId: "01.01.01",
        sessions: [
          {
            sessionId: "ses-1",
            agentName: "systems-engineer",
            model: "anthropic/claude-sonnet-4",
            startedAt: new Date().toISOString(),
            status: "failed",
          },
        ],
      },
      {
        threadId: "01.01.02",
        sessions: [
          {
            sessionId: "ses-2",
            agentName: "default",
            model: "google/gemini-2.5-pro",
            startedAt: new Date().toISOString(),
            status: "running",
          },
        ],
      },
    ]

    expect(buildHeadlessThreadStatuses(tasks, ["01.01.01", "01.01.02"], threadMetadata)).toEqual([
      {
        threadId: "01.01.01",
        threadName: "Thread 1",
        status: "failed",
        sessionsCount: 1,
        lastAgent: "systems-engineer",
      },
      {
        threadId: "01.01.02",
        threadName: "Thread 2",
        status: "incomplete",
        sessionsCount: 1,
        lastAgent: "default",
      },
    ])
  })

  test("headless mode resolves unresolved history by aborting", () => {
    expect(resolveHeadlessContinueAction(["01.01.01"])).toBe("abort")
    expect(resolveHeadlessContinueAction([])).toBe("continue")
  })
})
