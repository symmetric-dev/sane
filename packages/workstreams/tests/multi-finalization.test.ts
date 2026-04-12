import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "fs"
import { finalizeMultiRun } from "../src/lib/multi-finalization"
import {
  getRunResultPath,
  getSessionFilePath,
} from "../src/lib/opencode"
import { startMultipleSessionsLocked, writeTasksFile } from "../src/lib/tasks"
import {
  getLastSessionForThread,
  getOpencodeSessionId,
} from "../src/lib/threads"
import type { TasksFile, ThreadSessionMap } from "../src/lib/types"
import { createTestWorkstream, cleanupTestWorkstream, type TestWorkspace } from "./helpers"

describe("multi finalization", () => {
  let workspace: TestWorkspace

  beforeEach(() => {
    workspace = createTestWorkstream()

    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Test task",
          thread_name: "Thread One",
          batch_name: "Batch One",
          stage_name: "Stage One",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
      ],
    }

    writeTasksFile(workspace.repoRoot, workspace.streamId, tasksFile)
  })

  afterEach(() => {
    for (const path of [
      getRunResultPath(workspace.streamId, "01.01.01"),
      getSessionFilePath(workspace.streamId, "01.01.01"),
    ]) {
      try {
        if (existsSync(path)) {
          rmSync(path, { force: true })
        }
      } catch {
        // ignore
      }
    }

    cleanupTestWorkstream(workspace)
  })

  test("finalizes completed headless threads from result files", async () => {
    await startMultipleSessionsLocked(workspace.repoRoot, workspace.streamId, [
      {
        taskId: "01.01.01.01",
        agentName: "default",
        model: "anthropic/claude-sonnet-4",
        sessionId: "ses_test_123",
      },
    ])

    writeFileSync(
      getRunResultPath(workspace.streamId, "01.01.01"),
      JSON.stringify({ status: "completed", exitCode: 0 }),
    )
    writeFileSync(
      getSessionFilePath(workspace.streamId, "01.01.01"),
      "opencode-session-123\n",
    )

    const threadSessionMap: ThreadSessionMap[] = [
      {
        threadId: "01.01.01",
        taskId: "01.01.01.01",
        sessionId: "ses_test_123",
        paneId: "%1",
        windowIndex: 0,
      },
    ]

    const result = await finalizeMultiRun({
      sessionName: "missing-headless-session",
      threadSessionMap,
      threadIds: ["01.01.01"],
      notificationTracker: null,
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
    })

    expect(result.completions).toHaveLength(1)
    expect(result.completions[0]?.status).toBe("completed")
    expect(result.exitCode).toBe(0)

    expect(getLastSessionForThread(workspace.repoRoot, workspace.streamId, "01.01.01")?.status).toBe("completed")
    expect(getOpencodeSessionId(workspace.repoRoot, workspace.streamId, "01.01.01")).toBe("opencode-session-123")

    expect(existsSync(getRunResultPath(workspace.streamId, "01.01.01"))).toBe(false)
    expect(existsSync(getSessionFilePath(workspace.streamId, "01.01.01"))).toBe(false)

    expect(result.cleanup.resultFiles).toBe(1)
    expect(result.cleanup.sessionFiles).toBe(1)
  })
})
