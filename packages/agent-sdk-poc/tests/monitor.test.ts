import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("isolated SDK monitor session text", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    delete process.env.AGENV_MONITOR_REPO_ROOT
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test("reads and tails safe derived session logs from canonical runtime metadata", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "agent-sdk-monitor-"))
    temporaryDirectories.push(repoRoot)
    process.env.AGENV_MONITOR_REPO_ROOT = repoRoot

    const runtimeDirectory = join(repoRoot, "work", "stream-1", "runtime", "batches", "01.01", "runs", "run-1")
     const sessionDirectory = join(runtimeDirectory, "sessions", "a~2Fb", "attempt-1")
    await mkdir(sessionDirectory, { recursive: true })
    await mkdir(join(repoRoot, "work", "stream-1"), { recursive: true })
    await writeFile(join(repoRoot, "work", "index.json"), JSON.stringify({ current_stream: "stream-1" }))
    await writeFile(join(repoRoot, "work", "stream-1", "workstream-state.json"), JSON.stringify({
      hierarchy: {
         threads: [{ id: "a/b", batchId: "01.01", name: "First thread" }],
      },
      batchRuns: [{
        streamId: "stream-1",
        batchId: "01.01",
        runId: "run-1",
        executionBackend: "sdk",
        status: "running",
        startedAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:01.000Z",
        runtimeDirectory: "work/stream-1/runtime/batches/01.01/runs/run-1",
        activityJournalPath: "work/stream-1/runtime/batches/01.01/runs/run-1/activity.jsonl",
        snapshotPath: "work/stream-1/runtime/batches/01.01/runs/run-1/snapshot.json",
        executorLogPath: "work/stream-1/runtime/batches/01.01/runs/run-1/executor.log",
         threads: [{ threadId: "a/b", threadName: "First thread", status: "running", attemptId: "attempt-1" }],
        summary: { total: 1, pending: 0, running: 1, completed: 0, failed: 0 },
      }],
      threadRuntime: [{
         threadId: "a/b",
        itemName: "First thread",
        sessions: [{
          sessionId: "session-1",
          attemptId: "attempt-1",
          status: "running",
          provider: "cursor",
          startedAt: "2026-08-17T00:00:00.000Z",
        }],
      }],
    }))
    const runSessionLog = Array.from({ length: 205 }, (_, index) => `run-line-${index}`).join("\n") + "\n"
    await Promise.all([
      writeFile(join(runtimeDirectory, "activity.jsonl"), ""),
      writeFile(join(runtimeDirectory, "snapshot.json"), "{}"),
      writeFile(join(runtimeDirectory, "executor.log"), ""),
      writeFile(join(runtimeDirectory, "session.log"), runSessionLog),
    ])
    await writeFile(join(sessionDirectory, "session.log"), Array.from({ length: 205 }, (_, index) => `line-${index}`).join("\n") + "\n")

    const monitor = await import("../monitor/server.ts")
    const payload = monitor.buildMonitorPayload()
    const thread = payload.sessions[0] as { sessions: Array<{ sessionText: { path: { recorded: string }; lines: string[] } }> }
    const session = thread.sessions[0]!

     expect(session.sessionText.path.recorded).toContain("sessions/a~2Fb/attempt-1/session.log")
    expect(session.sessionText.lines).toHaveLength(200)
    expect(session.sessionText.lines[0]).toBe("line-5")
    expect(session.sessionText.lines.at(-1)).toBe("line-204")
    const runText = (payload.runtime as { sessionTextLog: { exists: boolean; lines: string[] } }).sessionTextLog
    expect(runText.exists).toBe(true)
    expect(runText.lines).toHaveLength(200)
    expect(runText.lines[0]).toBe("run-line-5")
    expect(runText.lines.at(-1)).toBe("run-line-204")

    const response = monitor.requestHandler(new Request("http://127.0.0.1:43120/api/sdk-monitor"))
    expect(response.status).toBe(200)
    expect(monitor.requestHandler(new Request("http://127.0.0.1:43120/api/sdk-monitor?path=../../secret")).status).toBe(400)
  })
})
