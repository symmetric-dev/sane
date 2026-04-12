import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { captureCliOutput } from "./helpers/cli-runner"
import {
  resetBatchStatusRun,
  startDetachedBatchMonitor,
  syncBatchStatus,
  waitForBatchStatus,
} from "../src/lib/batch-monitor"
import { createBatchStatusFile, readBatchStatus, writeBatchStatus } from "../src/lib/batch-status"
import {
  getCompletionMarkerPath,
  getSessionFilePath,
} from "../src/lib/opencode"
import { getThreadMetadata, startThreadSession } from "../src/lib/threads"
import { main as batchStatusMain } from "../src/cli/batch-status"

describe("batch status", () => {
  let repoRoot: string
  let streamId: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "agenv-batch-status-"))
    streamId = `001-test-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    rmSync(getCompletionMarkerPath(streamId, "01.01.01"), { force: true })
    rmSync(getCompletionMarkerPath(streamId, "01.01.02"), { force: true })
    rmSync(getSessionFilePath(streamId, "01.01.01"), { force: true })
    rmSync(getSessionFilePath(streamId, "01.01.02"), { force: true })
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(join(repoRoot, "work", streamId), { recursive: true })

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
              name: "test-stream",
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

    writeFileSync(
      join(repoRoot, "work", streamId, "tasks.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: streamId,
          last_updated: new Date().toISOString(),
          tasks: [
            {
              id: "01.01.01.01",
              name: "Thread 1 task",
              thread_name: "Thread 1",
              batch_name: "Batch Status",
              stage_name: "Headless Runtime",
              status: "pending",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            {
              id: "01.01.02.01",
              name: "Thread 2 task",
              thread_name: "Thread 2",
              batch_name: "Batch Status",
              stage_name: "Headless Runtime",
              status: "pending",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    )
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
    rmSync(getCompletionMarkerPath(streamId, "01.01.01"), { force: true })
    rmSync(getCompletionMarkerPath(streamId, "01.01.02"), { force: true })
    rmSync(getSessionFilePath(streamId, "01.01.01"), { force: true })
    rmSync(getSessionFilePath(streamId, "01.01.02"), { force: true })
  })

  test("syncBatchStatus persists running and pending thread counts", async () => {
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-1",
    )

    const status = await syncBatchStatus({
      repoRoot,
      streamId,
      batchId: "01.01",
    })

    expect(status.status).toBe("running")
    expect(status.summary).toEqual({
      total: 2,
      pending: 1,
      running: 1,
      completed: 0,
      failed: 0,
    })

    const saved = readBatchStatus(repoRoot, streamId, "01.01")
    expect(saved?.threads[0]?.status).toBe("running")
    expect(saved?.threads[1]?.status).toBe("pending")
  })

  test("syncBatchStatus finalizes completed markers into thread metadata", async () => {
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-1",
    )

    writeFileSync(getSessionFilePath(streamId, "01.01.01"), "opencode-session-123\n")
    writeFileSync(getCompletionMarkerPath(streamId, "01.01.01"), "done\n")
    writeFileSync(getCompletionMarkerPath(streamId, "01.01.02"), "done\n")

    const status = await syncBatchStatus({
      repoRoot,
      streamId,
      batchId: "01.01",
    })

    expect(status.status).toBe("completed")
    expect(status.summary.completed).toBe(2)

    const thread = getThreadMetadata(repoRoot, streamId, "01.01.01")
    expect(thread?.currentSessionId).toBeUndefined()
    expect(thread?.sessions.at(-1)?.status).toBe("completed")
    expect(thread?.opencodeSessionId).toBe("opencode-session-123")
  })

  test("syncBatchStatus retries canonical artifact capture while marker remains", async () => {
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-retry-1",
    )

    writeFileSync(getCompletionMarkerPath(streamId, "01.01.01"), "done\n")
    writeBatchStatus(
      repoRoot,
      streamId,
      createBatchStatusFile({
        streamId,
        batchId: "01.01",
        stageName: "Headless Runtime",
        batchName: "Batch Status",
        runId: "run-retry-test",
        startedAt: new Date().toISOString(),
        threads: [
          { threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" },
          { threadId: "01.01.02", threadName: "Thread 2", firstTaskId: "01.01.02.01" },
        ],
      }),
    )

    const seeded = readBatchStatus(repoRoot, streamId, "01.01")!
    seeded.threads[0] = {
      ...seeded.threads[0]!,
      status: "completed",
      markerDetectedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }
    seeded.status = "running"
    seeded.summary = {
      total: 2,
      pending: 1,
      running: 0,
      completed: 1,
      failed: 0,
    }
    writeBatchStatus(repoRoot, streamId, seeded)

    writeFileSync(getSessionFilePath(streamId, "01.01.01"), "late-session-123\n")

    const secondPass = await syncBatchStatus({
      repoRoot,
      streamId,
      batchId: "01.01",
    })

    expect(secondPass.status).toBe("running")
    expect(secondPass.threads[0]?.opencodeSessionId).toBe("late-session-123")
    expect(getThreadMetadata(repoRoot, streamId, "01.01.01")?.opencodeSessionId).toBe(
      "late-session-123",
    )
  })

  test("syncBatchStatus reconciles completed threads from canonical task state when tmux is gone and artifacts are incomplete", async () => {
    const run = resetBatchStatusRun({
      repoRoot,
      streamId,
      batchId: "01.01",
      stageName: "Headless Runtime",
      batchName: "Batch Status",
      threads: [
        { threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" },
        { threadId: "01.01.02", threadName: "Thread 2", firstTaskId: "01.01.02.01" },
      ],
    })

    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-canonical-1",
    )
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.02",
      "agent-two",
      "model-two",
      "session-canonical-2",
    )

    writeFileSync(getSessionFilePath(streamId, "01.01.01"), "recovered-session-1\n")

    writeFileSync(
      join(repoRoot, "work", streamId, "tasks.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: streamId,
          last_updated: new Date().toISOString(),
          tasks: [
            {
              id: "01.01.01.01",
              name: "Thread 1 task",
              thread_name: "Thread 1",
              batch_name: "Batch Status",
              stage_name: "Headless Runtime",
              status: "completed",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            {
              id: "01.01.02.01",
              name: "Thread 2 task",
              thread_name: "Thread 2",
              batch_name: "Batch Status",
              stage_name: "Headless Runtime",
              status: "completed",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    )

    const status = await syncBatchStatus({
      repoRoot,
      streamId,
      batchId: "01.01",
    })

    expect(status.runId).toBe(run.runId)
    expect(status.status).toBe("completed")
    expect(status.summary.completed).toBe(2)
    expect(status.summary.running).toBe(0)

    const threadOne = getThreadMetadata(repoRoot, streamId, "01.01.01")
    const threadTwo = getThreadMetadata(repoRoot, streamId, "01.01.02")
    expect(threadOne?.currentSessionId).toBeUndefined()
    expect(threadTwo?.currentSessionId).toBeUndefined()
    expect(threadOne?.sessions.at(-1)?.status).toBe("completed")
    expect(threadTwo?.sessions.at(-1)?.status).toBe("completed")
    expect(threadOne?.opencodeSessionId).toBe("recovered-session-1")
  })

  test("waitForBatchStatus does not false-positive completed while canonical tasks remain incomplete", async () => {
    resetBatchStatusRun({
      repoRoot,
      streamId,
      batchId: "01.01",
      stageName: "Headless Runtime",
      batchName: "Batch Status",
      threads: [
        { threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" },
        { threadId: "01.01.02", threadName: "Thread 2", firstTaskId: "01.01.02.01" },
      ],
    })

    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-still-running-1",
    )
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.02",
      "agent-two",
      "model-two",
      "session-still-running-2",
    )

    writeFileSync(
      join(repoRoot, "work", streamId, "tasks.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: streamId,
          last_updated: new Date().toISOString(),
          tasks: [
            {
              id: "01.01.01.01",
              name: "Thread 1 task",
              thread_name: "Thread 1",
              batch_name: "Batch Status",
              stage_name: "Headless Runtime",
              status: "completed",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            {
              id: "01.01.02.01",
              name: "Thread 2 task",
              thread_name: "Thread 2",
              batch_name: "Batch Status",
              stage_name: "Headless Runtime",
              status: "pending",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    )

    await expect(
      waitForBatchStatus({
        repoRoot,
        streamId,
        batchId: "01.01",
        pollIntervalMs: 10,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/Timed out after 25ms waiting for batch 01\.01/)

    const persisted = readBatchStatus(repoRoot, streamId, "01.01")
    expect(persisted?.status).toBe("running")
    expect(persisted?.summary.completed).toBe(1)
    expect(persisted?.summary.running).toBe(1)
    expect(getThreadMetadata(repoRoot, streamId, "01.01.01")?.currentSessionId).toBeUndefined()
    expect(getThreadMetadata(repoRoot, streamId, "01.01.02")?.currentSessionId).toBe(
      "session-still-running-2",
    )
  })

  test("new headless run resets batch status with a fresh runId", async () => {
    const firstRun = resetBatchStatusRun({
      repoRoot,
      streamId,
      batchId: "01.01",
      stageName: "Headless Runtime",
      batchName: "Batch Status",
      threads: [
        { threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" },
        { threadId: "01.01.02", threadName: "Thread 2", firstTaskId: "01.01.02.01" },
      ],
    })

    writeFileSync(getCompletionMarkerPath(streamId, "01.01.01"), "done\n")
    writeFileSync(getCompletionMarkerPath(streamId, "01.01.02"), "done\n")
    await syncBatchStatus({ repoRoot, streamId, batchId: "01.01" })

    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-rerun",
    )

    const rerun = resetBatchStatusRun({
      repoRoot,
      streamId,
      batchId: "01.01",
      stageName: "Headless Runtime",
      batchName: "Batch Status",
      threads: [
        { threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" },
        { threadId: "01.01.02", threadName: "Thread 2", firstTaskId: "01.01.02.01" },
      ],
    })

    const status = await syncBatchStatus({ repoRoot, streamId, batchId: "01.01" })
    expect(rerun.runId).not.toBe(firstRun.runId)
    expect(status.runId).toBe(rerun.runId)
    expect(status.status).toBe("running")
    expect(status.summary.completed).toBe(0)
    expect(status.summary.running).toBe(1)
  })

  test("concurrent batch-status writes keep a valid persisted file", async () => {
    const baseStatus = createBatchStatusFile({
      streamId,
      batchId: "01.01",
      stageName: "Headless Runtime",
      batchName: "Batch Status",
      threads: [
        { threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" },
        { threadId: "01.01.02", threadName: "Thread 2", firstTaskId: "01.01.02.01" },
      ],
    })

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        Promise.resolve().then(() => {
          const updatedAt = new Date(Date.now() + index).toISOString()
          writeBatchStatus(repoRoot, streamId, {
            ...baseStatus,
            updatedAt,
            summary: { total: 2, pending: 0, running: 0, completed: 2, failed: 0 },
            status: "completed",
            completedAt: updatedAt,
            threads: baseStatus.threads.map((thread) => ({
              ...thread,
              status: "completed",
              updatedAt,
              completedAt: updatedAt,
            })),
          })
        }),
      ),
    )

    const persisted = readBatchStatus(repoRoot, streamId, "01.01")
    expect(persisted?.status).toBe("completed")
    expect(persisted?.summary.completed).toBe(2)
    expect(persisted?.threads).toHaveLength(2)
    expect(persisted?.threads.every((thread) => thread.status === "completed")).toBe(true)
  })

  test("detached async monitor finalizes canonical state while batch-status wait observes completion", async () => {
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-async-1",
    )
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.02",
      "agent-two",
      "model-two",
      "session-async-2",
    )

    const run = resetBatchStatusRun({
      repoRoot,
      streamId,
      batchId: "01.01",
      stageName: "Headless Runtime",
      batchName: "Batch Status",
      threads: [
        { threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" },
        { threadId: "01.01.02", threadName: "Thread 2", firstTaskId: "01.01.02.01" },
      ],
    })

    startDetachedBatchMonitor({
      repoRoot,
      streamId,
      batchId: "01.01",
      pollIntervalMs: 25,
      timeoutMs: 5000,
    })

    setTimeout(() => {
      writeFileSync(getSessionFilePath(streamId, "01.01.01"), "async-session-1\n")
      writeFileSync(getSessionFilePath(streamId, "01.01.02"), "async-session-2\n")
      writeFileSync(getCompletionMarkerPath(streamId, "01.01.01"), "done\n")
      writeFileSync(getCompletionMarkerPath(streamId, "01.01.02"), "done\n")
    }, 100)

    const status = await waitForBatchStatus({
      repoRoot,
      streamId,
      batchId: "01.01",
      pollIntervalMs: 25,
      timeoutMs: 5000,
    })

    expect(status.runId).toBe(run.runId)
    expect(status.status).toBe("completed")
    expect(status.summary.completed).toBe(2)

    const threadOne = getThreadMetadata(repoRoot, streamId, "01.01.01")
    const threadTwo = getThreadMetadata(repoRoot, streamId, "01.01.02")
    expect(threadOne?.currentSessionId).toBeUndefined()
    expect(threadTwo?.currentSessionId).toBeUndefined()
    expect(threadOne?.sessions.at(-1)?.status).toBe("completed")
    expect(threadTwo?.sessions.at(-1)?.status).toBe("completed")
    expect(threadOne?.opencodeSessionId).toBe("async-session-1")
    expect(threadTwo?.opencodeSessionId).toBe("async-session-2")
  })

  test("waitForBatchStatus throws on timeout and keeps the latest persisted non-terminal state", async () => {
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-timeout-1",
    )

    await expect(
      waitForBatchStatus({
        repoRoot,
        streamId,
        batchId: "01.01",
        pollIntervalMs: 10,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/Timed out after 25ms waiting for batch 01\.01 to reach a terminal state/)

    const persisted = readBatchStatus(repoRoot, streamId, "01.01")
    expect(persisted?.status).toBe("running")
    expect(persisted?.summary).toEqual({
      total: 2,
      pending: 1,
      running: 1,
      completed: 0,
      failed: 0,
    })
  })

  test("batch-status cli can wait for completion and emit json", async () => {
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.01",
      "agent-one",
      "model-one",
      "session-cli-1",
    )
    startThreadSession(
      repoRoot,
      streamId,
      "01.01.02",
      "agent-two",
      "model-two",
      "session-cli-2",
    )

    setTimeout(() => {
      writeFileSync(getSessionFilePath(streamId, "01.01.01"), "cli-session-1\n")
      writeFileSync(getSessionFilePath(streamId, "01.01.02"), "cli-session-2\n")
      writeFileSync(getCompletionMarkerPath(streamId, "01.01.01"), "done\n")
      writeFileSync(getCompletionMarkerPath(streamId, "01.01.02"), "done\n")
    }, 25)

    const { stdout } = await captureCliOutput(async () => {
      await batchStatusMain([
        "bun",
        "work",
        "--batch",
        "01.01",
        "--format",
        "json",
        "--wait",
        "--timeout-ms",
        "500",
        "--poll-interval-ms",
        "10",
        "--repo-root",
        repoRoot,
      ])
    })

    const parsed = JSON.parse(stdout.join("\n"))
    expect(parsed.batchId).toBe("01.01")
    expect(parsed.status).toBe("completed")
    expect(parsed.summary.completed).toBe(2)
  })
})
