import { afterEach, describe, expect, mock, test } from "bun:test"

const src = (path: string) => new URL(`../src/${path}`, import.meta.url).href

describe("multi headless initialization order", () => {
  afterEach(() => {
    mock.restore()
  })

  test("resets headless batch status before tmux threads start", async () => {
    const callOrder: string[] = []

    mock.module(src("lib/repo.ts"), () => ({
      getRepoRoot: () => "/tmp/test-repo",
    }))

    mock.module(src("lib/index.ts"), () => ({
      loadIndex: () => ({ current_stream: "001-test-stream" }),
      getResolvedStream: () => ({ id: "001-test-stream" }),
    }))

    mock.module(src("lib/agents-yaml.ts"), () => ({
      loadAgentsConfig: () => ({}),
      getDefaultSynthesisAgent: () => null,
      getSynthesisAgent: () => null,
      getSynthesisAgentModels: () => [],
    }))

    mock.module(src("lib/tasks.ts"), () => ({
      readTasksFile: () => ({ tasks: [] }),
      parseTaskId: () => null,
      generateSessionId: () => "generated-session-id",
      startMultipleSessionsLocked: async () => {},
      getBatchMetadata: () => ({ stageName: "Stage 1", batchName: "Batch 1" }),
    }))

    mock.module(src("lib/types.ts"), () => ({
      MAX_THREADS_PER_BATCH: 8,
    }))

    mock.module(src("lib/tmux.ts"), () => ({
      sessionExists: () => false,
      attachSession: () => {
        throw new Error("attachSession should not run in headless async mode")
      },
      getWorkSessionName: () => "work-001-test-stream",
      buildCreateSessionCommand: () => "",
      buildAddWindowCommand: () => "",
      buildAttachCommand: () => "",
      waitForAllPanesExit: async () => {},
    }))

    mock.module(src("lib/approval.ts"), () => ({
      getStageApprovalStatus: () => "approved",
    }))

    mock.module(src("lib/opencode.ts"), () => ({
      isServerRunning: async () => true,
      startServer: () => undefined,
      waitForServer: async () => true,
      buildServeCommand: () => "",
    }))

    mock.module(src("lib/notifications.ts"), () => ({
      NotificationTracker: class NotificationTracker {
        constructor(_: unknown) {}
      },
    }))

    mock.module(src("lib/synthesis/config.ts"), () => ({
      isSynthesisEnabled: () => false,
      getSynthesisAgentOverride: () => null,
    }))

    mock.module(src("lib/cli-utils.ts"), () => ({
      parseBatchId: () => ({ stage: 1, batch: 1 }),
    }))

    mock.module(src("lib/multi-orchestrator.ts"), () => ({
      collectThreadInfoFromTasks: () => [
        {
          threadId: "01.01.01",
          threadName: "Thread 1",
          stageName: "Stage 1",
          batchName: "Batch 1",
          promptPath: "/tmp/test-repo/work/001-test-stream/prompts/thread-1.md",
          models: [{ model: "model-one" }],
          agentName: "default",
          firstTaskId: "01.01.01.01",
        },
      ],
      buildThreadRunCommand: () => "",
      setupTmuxSession: () => {
        callOrder.push("setupTmuxSession")
        return { sessionName: "work-001-test-stream", threadSessionMap: [] }
      },
      setupGridController: async () => {},
      setupKillSessionKeybind: () => {},
      validateThreadPrompts: () => [],
    }))

    mock.module(src("lib/marker-polling.ts"), () => ({
      startMarkerPolling: () => ({
        promise: Promise.resolve(),
        state: { active: true, completedThreadIds: new Set<string>() },
      }),
    }))

    mock.module(src("lib/multi-finalization.ts"), () => ({
      finalizeMultiRun: async () => ({ exitCode: 0 }),
    }))

    mock.module(src("lib/batch-monitor.ts"), () => ({
      resetBatchStatusRun: () => {
        callOrder.push("resetBatchStatusRun")
        return { runId: "run-1" }
      },
      startDetachedBatchMonitor: () => {
        callOrder.push("startDetachedBatchMonitor")
      },
    }))

    const { main } = await import(`${src("cli/multi.ts")}?headless-order=${Date.now()}`)

    await main(["bun", "work", "--batch", "01.01", "--headless", "--async"])

    expect(callOrder).toEqual([
      "resetBatchStatusRun",
      "setupTmuxSession",
      "startDetachedBatchMonitor",
    ])
  })

  test("does not start local marker polling in headless async mode", async () => {
    const callOrder: string[] = []

    mock.module(src("lib/repo.ts"), () => ({
      getRepoRoot: () => "/tmp/test-repo",
    }))

    mock.module(src("lib/index.ts"), () => ({
      loadIndex: () => ({ current_stream: "001-test-stream" }),
      getResolvedStream: () => ({ id: "001-test-stream" }),
    }))

    mock.module(src("lib/agents-yaml.ts"), () => ({
      loadAgentsConfig: () => ({}),
      getDefaultSynthesisAgent: () => null,
      getSynthesisAgent: () => null,
      getSynthesisAgentModels: () => [],
    }))

    mock.module(src("lib/tasks.ts"), () => ({
      readTasksFile: () => ({ tasks: [] }),
      parseTaskId: () => null,
      generateSessionId: () => "generated-session-id",
      startMultipleSessionsLocked: async () => {},
      getBatchMetadata: () => ({ stageName: "Stage 1", batchName: "Batch 1" }),
    }))

    mock.module(src("lib/types.ts"), () => ({
      MAX_THREADS_PER_BATCH: 8,
    }))

    mock.module(src("lib/tmux.ts"), () => ({
      sessionExists: () => false,
      attachSession: () => {
        throw new Error("attachSession should not run in headless async mode")
      },
      getWorkSessionName: () => "work-001-test-stream",
      buildCreateSessionCommand: () => "",
      buildAddWindowCommand: () => "",
      buildAttachCommand: () => "",
      waitForAllPanesExit: async () => {},
    }))

    mock.module(src("lib/approval.ts"), () => ({
      getStageApprovalStatus: () => "approved",
    }))

    mock.module(src("lib/opencode.ts"), () => ({
      isServerRunning: async () => true,
      startServer: () => undefined,
      waitForServer: async () => true,
      buildServeCommand: () => "",
    }))

    mock.module(src("lib/notifications.ts"), () => ({
      NotificationTracker: class NotificationTracker {
        constructor(_: unknown) {
          callOrder.push("NotificationTracker")
        }
      },
    }))

    mock.module(src("lib/synthesis/config.ts"), () => ({
      isSynthesisEnabled: () => false,
      getSynthesisAgentOverride: () => null,
    }))

    mock.module(src("lib/cli-utils.ts"), () => ({
      parseBatchId: () => ({ stage: 1, batch: 1 }),
    }))

    mock.module(src("lib/multi-orchestrator.ts"), () => ({
      collectThreadInfoFromTasks: () => [
        {
          threadId: "01.01.01",
          threadName: "Thread 1",
          stageName: "Stage 1",
          batchName: "Batch 1",
          promptPath: "/tmp/test-repo/work/001-test-stream/prompts/thread-1.md",
          models: [{ model: "model-one" }],
          agentName: "default",
          firstTaskId: "01.01.01.01",
        },
      ],
      buildThreadRunCommand: () => "",
      setupTmuxSession: () => ({ sessionName: "work-001-test-stream", threadSessionMap: [] }),
      setupGridController: async () => {},
      setupKillSessionKeybind: () => {},
      validateThreadPrompts: () => [],
    }))

    mock.module(src("lib/marker-polling.ts"), () => ({
      startMarkerPolling: () => {
        callOrder.push("startMarkerPolling")
        return {
          promise: Promise.resolve(),
          state: { active: true, completedThreadIds: new Set<string>() },
        }
      },
    }))

    mock.module(src("lib/multi-finalization.ts"), () => ({
      finalizeMultiRun: async () => ({ exitCode: 0 }),
    }))

    mock.module(src("lib/batch-monitor.ts"), () => ({
      resetBatchStatusRun: () => ({ runId: "run-1" }),
      startDetachedBatchMonitor: () => {
        callOrder.push("startDetachedBatchMonitor")
      },
    }))

    const { main } = await import(`${src("cli/multi.ts")}?headless-async-no-poll=${Date.now()}`)

    await main(["bun", "work", "--batch", "01.01", "--headless", "--async"])

    expect(callOrder).toEqual(["startDetachedBatchMonitor"])
  })

  test("still starts local marker polling in blocking headless mode", async () => {
    const callOrder: string[] = []

    mock.module(src("lib/repo.ts"), () => ({
      getRepoRoot: () => "/tmp/test-repo",
    }))

    mock.module(src("lib/index.ts"), () => ({
      loadIndex: () => ({ current_stream: "001-test-stream" }),
      getResolvedStream: () => ({ id: "001-test-stream" }),
    }))

    mock.module(src("lib/agents-yaml.ts"), () => ({
      loadAgentsConfig: () => ({}),
      getDefaultSynthesisAgent: () => null,
      getSynthesisAgent: () => null,
      getSynthesisAgentModels: () => [],
    }))

    mock.module(src("lib/tasks.ts"), () => ({
      readTasksFile: () => ({ tasks: [] }),
      parseTaskId: () => null,
      generateSessionId: () => "generated-session-id",
      startMultipleSessionsLocked: async () => {},
      getBatchMetadata: () => ({ stageName: "Stage 1", batchName: "Batch 1" }),
    }))

    mock.module(src("lib/types.ts"), () => ({
      MAX_THREADS_PER_BATCH: 8,
    }))

    mock.module(src("lib/tmux.ts"), () => ({
      sessionExists: () => false,
      attachSession: () => {
        throw new Error("attachSession should not run in headless mode")
      },
      getWorkSessionName: () => "work-001-test-stream",
      buildCreateSessionCommand: () => "",
      buildAddWindowCommand: () => "",
      buildAttachCommand: () => "",
      waitForAllPanesExit: async () => {
        callOrder.push("waitForAllPanesExit")
      },
    }))

    mock.module(src("lib/approval.ts"), () => ({
      getStageApprovalStatus: () => "approved",
    }))

    mock.module(src("lib/opencode.ts"), () => ({
      isServerRunning: async () => true,
      startServer: () => undefined,
      waitForServer: async () => true,
      buildServeCommand: () => "",
    }))

    mock.module(src("lib/notifications.ts"), () => ({
      NotificationTracker: class NotificationTracker {
        constructor(_: unknown) {
          callOrder.push("NotificationTracker")
        }
      },
    }))

    mock.module(src("lib/synthesis/config.ts"), () => ({
      isSynthesisEnabled: () => false,
      getSynthesisAgentOverride: () => null,
    }))

    mock.module(src("lib/cli-utils.ts"), () => ({
      parseBatchId: () => ({ stage: 1, batch: 1 }),
    }))

    mock.module(src("lib/multi-orchestrator.ts"), () => ({
      collectThreadInfoFromTasks: () => [
        {
          threadId: "01.01.01",
          threadName: "Thread 1",
          stageName: "Stage 1",
          batchName: "Batch 1",
          promptPath: "/tmp/test-repo/work/001-test-stream/prompts/thread-1.md",
          models: [{ model: "model-one" }],
          agentName: "default",
          firstTaskId: "01.01.01.01",
        },
      ],
      buildThreadRunCommand: () => "",
      setupTmuxSession: () => ({ sessionName: "work-001-test-stream", threadSessionMap: [] }),
      setupGridController: async () => {},
      setupKillSessionKeybind: () => {},
      validateThreadPrompts: () => [],
    }))

    mock.module(src("lib/marker-polling.ts"), () => ({
      startMarkerPolling: () => {
        callOrder.push("startMarkerPolling")
        return {
          promise: Promise.resolve(),
          state: { active: true, completedThreadIds: new Set<string>() },
        }
      },
    }))

    mock.module(src("lib/multi-finalization.ts"), () => ({
      finalizeMultiRun: async () => {
        callOrder.push("finalizeMultiRun")
        return { exitCode: 0 }
      },
    }))

    mock.module(src("lib/batch-monitor.ts"), () => ({
      resetBatchStatusRun: () => {
        return { runId: "run-1" }
      },
      startDetachedBatchMonitor: () => {},
    }))

    const originalExit = process.exit
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`)
    }) as typeof process.exit

    try {
      const { main } = await import(`${src("cli/multi.ts")}?headless-sync-poll=${Date.now()}`)

      await expect(main(["bun", "work", "--batch", "01.01", "--headless"]))
        .rejects.toThrow("process.exit:0")
    } finally {
      process.exit = originalExit
    }

    expect(callOrder).toEqual([
      "NotificationTracker",
      "startMarkerPolling",
      "waitForAllPanesExit",
      "finalizeMultiRun",
    ])
  })
})
