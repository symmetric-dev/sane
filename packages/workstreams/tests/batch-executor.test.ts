import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  BatchExecutor,
  AtomicSnapshotWriter,
  createDefaultBatchExecutorAdapterFactory,
  executeSdkBatch,
  prepareSdkBatchRun,
  projectBatchExecutionSnapshot,
  readActivityJournal,
  type AgentAttemptAdapter,
  type AttemptInput,
  type BatchStatusFile,
  type ObservabilityFileSystem,
  type ResolvedModelSpec,
} from "../src/index.ts"
import {
  createEmptyStructuredStorageWorkstreamState,
} from "../src/lib/structured-storage.ts"
import {
  loadStructuredWorkstreamStateSync,
  replaceStructuredWorkstreamStateSync,
} from "../src/lib/storage-adapter.ts"
import { readBatchStatus, writeBatchStatus } from "../src/lib/batch-status.ts"
import { reconcileBatchStatusRunIfNeeded } from "../src/lib/batch-monitor.ts"
import { resolveModelSpec } from "../src/lib/model.ts"
import { CursorLocalAdapter, type CursorSdkLike } from "../src/lib/agent-runtime/providers/cursor.ts"
import { observeBatchEvents } from "../src/cli/batch-events.ts"
import { FakeAgentAttemptAdapter } from "./fixtures/fake-agent-runtime.ts"
import { cleanupTestWorkstream, createTestWorkstream, type TestWorkspace } from "./helpers/test-workspace.ts"
import type { PersistedBatchStatusFile, SessionRecord } from "../src/lib/types.ts"

const PLAN = `# Plan: Executor Test Plan

## Summary
Executor tests.

## Stages

### Stage 01: Runtime Stage

#### Definition
Runtime stage.

#### Constitution

**Inputs:**

- None

**Structure:**

- None

**Outputs:**

- None

#### Stage Questions

- [x] Ready

#### Batches

##### Batch 01: Runtime Batch

###### Thread 01: First Thread

**Summary:**

First executor thread.

**Details:**

- Exercise provider execution.

###### Thread 02: Second Thread

**Summary:**

Second executor thread.

**Details:**

- Exercise sibling isolation.
`

const WORK = `# Thread contract

## Objective
Run the executor test.

## Do
- Run the fake attempt.

## Done When
- The fake result is persisted.

## Files to Know
### READ
- ./WORK.md
### ALLOWED
- tests
### FORBIDDEN
- none

## Verify
- bun test

## Locked Decisions
- Use fake adapters.

## Not In Scope
- CLI wiring.

## If Blocked
- Report the blocker.
`

const workspaces: TestWorkspace[] = []

function createExecutorWorkspace(args: {
  models?: string
  threadCount?: number
  assignedAgent?: string
  streamId?: string
} = {}): TestWorkspace {
  const workspace = createTestWorkstream(args.streamId ?? `001-batch-executor-${Date.now()}-${workspaces.length}`)
  workspaces.push(workspace)
  writeFileSync(join(workspace.workDir, "PLAN.md"), PLAN)
  writeFileSync(
    join(workspace.repoRoot, "work", "agents.yaml"),
    `agents:\n  - name: default\n    description: Test agent\n    best_for: Executor tests\n    models: [${args.models ?? '"auto@cursor"'}]\n`,
  )

  const threadCount = args.threadCount ?? 2
  for (let index = 1; index <= threadCount; index += 1) {
    mkdirSync(join(workspace.workDir, "stages", "01", "threads", `01.01.0${index}`), { recursive: true })
    writeFileSync(join(workspace.workDir, "stages", "01", "threads", `01.01.0${index}`, "WORK.md"), WORK)
  }

  const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
  state.hierarchy.stages = [{ id: "01", number: 1, name: "Runtime Stage" }]
  state.hierarchy.batches = [{ id: "01.01", stageId: "01", number: 1, name: "Runtime Batch" }]
  state.hierarchy.threads = Array.from({ length: threadCount }, (_, index) => ({
    id: `01.01.0${index + 1}`,
    stageId: "01",
    batchId: "01.01",
    number: index + 1,
    name: index === 0 ? "First Thread" : "Second Thread",
  }))
  state.threadRuntime = state.hierarchy.threads.map((thread) => ({
    threadId: thread.id,
    sessions: [],
    status: "pending",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...(args.assignedAgent ? { assignedAgent: args.assignedAgent } : {}),
  }))
  replaceStructuredWorkstreamStateSync({ repoRoot: workspace.repoRoot, workstreamState: state })
  return workspace
}

function fakeFactory(
  adapters: FakeAgentAttemptAdapter[],
  plan: (candidate: ResolvedModelSpec, input: AttemptInput) => ConstructorParameters<typeof FakeAgentAttemptAdapter>[1],
) {
  return (candidate: ResolvedModelSpec, input: AttemptInput): AgentAttemptAdapter => {
    const adapter = new FakeAgentAttemptAdapter(candidate.runtime, plan(candidate, input))
    adapters.push(adapter)
    return adapter
  }
}

afterEach(() => {
  while (workspaces.length > 0) cleanupTestWorkstream(workspaces.pop()!)
})

describe("detached SDK BatchExecutor", () => {
  test("default adapter factory selects Cursor without starting a provider", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1, models: '"auto@cursor"' })
    const factory = createDefaultBatchExecutorAdapterFactory({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
    })
    const candidate = resolveModelSpec("auto@cursor")
    const attempt: AttemptInput = {
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      threadId: "01.01.01",
      workSessionId: "session-factory",
      attemptId: "attempt-factory",
      logicalAgent: "default",
      model: candidate,
      prompt: "prompt",
      title: "title",
      executionBackend: "sdk",
    }
    const first = await factory(candidate, attempt)
    const second = await factory(candidate, { ...attempt, attemptId: "attempt-factory-2" })
    expect(first.provider).toBe("cursor")
    expect(second.provider).toBe("cursor")
    expect(second).not.toBe(first)
    await Promise.all([first.close(), second.close()])
  })

  test("explicit Cursor fallback creates a fresh local agent and does not retry a duplicate model", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1, models: '"auto@cursor", "composer-1@cursor"' })
    let agentSequence = 0
    let factoryCalls = 0
    const agentIds: string[] = []
    const cursorAdapterFactory = (_candidate: ResolvedModelSpec, attempt: AttemptInput) => {
      factoryCalls += 1
      const agentId = `cursor-agent-${++agentSequence}`
      agentIds.push(agentId)
      const sdk: CursorSdkLike = {
        Agent: {
          async create() {
            return {
              agentId,
              send: async () => ({
                id: `cursor-run-${agentId}`,
                stream: () => (async function* () {})(),
                wait: async () => attempt.attemptId.endsWith("1")
                  ? { id: `cursor-run-${agentId}`, status: "error", error: { message: "first Cursor model failed" } }
                  : { id: `cursor-run-${agentId}`, status: "finished", result: "fallback" },
                cancel: async () => undefined,
              }),
              [Symbol.asyncDispose]: async () => undefined,
            }
          },
        },
      }
      return new CursorLocalAdapter({ sdk, apiKey: "test-key" })
    }

    const result = await executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      createAttemptId: (() => { let count = 0; return () => `attempt-${++count}` })(),
      cursorAdapterFactory,
    })
    expect(result.batch.status).toBe("completed")
    expect(result.threads[0]!.attempts.map((attempt) => attempt.candidate.model)).toEqual(["auto", "composer-1"])
    expect(agentIds).toEqual(["cursor-agent-1", "cursor-agent-2"])
    expect(new Set(agentIds).size).toBe(2)

    const duplicateWorkspace = createExecutorWorkspace({ threadCount: 1, models: '"auto@cursor", "auto@cursor"' })
    let duplicateFactoryCalls = 0
    const duplicate = await executeSdkBatch({
      repoRoot: duplicateWorkspace.repoRoot,
      streamId: duplicateWorkspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      cursorAdapterFactory: () => {
        duplicateFactoryCalls += 1
        return new CursorLocalAdapter({
          sdk: {
            Agent: {
              async create() {
                return {
                  agentId: "duplicate-agent",
                  send: async () => ({ id: "duplicate-run", stream: () => (async function* () {})(), wait: async () => ({ id: "duplicate-run", status: "error", error: { message: "failed" } }), cancel: async () => undefined }),
                  [Symbol.asyncDispose]: async () => undefined,
                }
              },
            },
          },
          apiKey: "test-key",
        })
      },
    })
    expect(duplicate.batch.status).toBe("failed")
    expect(duplicate.threads[0]!.attempts).toHaveLength(1)
    expect(duplicateFactoryCalls).toBe(1)
  })

  test("runs canonical threads in parallel and isolates one provider failure", async () => {
    const workspace = createExecutorWorkspace()
    const adapters: FakeAgentAttemptAdapter[] = []
    const started: string[] = []
    const result = await executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      adapterFactory: fakeFactory(adapters, (_candidate, input) => {
        started.push(input.threadId)
        return input.threadId.endsWith("01")
          ? { outcome: { status: "failed", error: { message: "one failed" } }, runDelayMs: 10 }
          : { outcome: { status: "completed", result: "sibling completed" }, runDelayMs: 10 }
      }),
    })

    expect(result.batch.status).toBe("failed")
    expect(result.batch.summary).toMatchObject({ total: 2, completed: 1, failed: 1 })
    expect(started.sort()).toEqual(["01.01.01", "01.01.02"])
    expect(adapters).toHaveLength(2)
    expect(result.threads.map((thread) => thread.status).sort()).toEqual(["completed", "failed"])
    expect(result.threads.find((thread) => thread.threadId === "01.01.01")!.attempts).toHaveLength(1)
  })

  test("persists ownership, heartbeat, native IDs, and compact lifecycle metadata", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1 })
    const adapter = new FakeAgentAttemptAdapter("cursor", {
      outcome: { status: "completed", result: "done" },
      runDelayMs: 20,
    })
    const result = await executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      heartbeatIntervalMs: 2,
      adapterFactory: () => adapter,
      pid: () => 1234,
      createAttemptId: () => "attempt-heartbeat",
      createWorkSessionId: () => "session-heartbeat",
    })

    expect(result.batch.executorPid).toBe(1234)
    expect(result.batch.executorStartedAt).toBeTruthy()
    expect(result.batch.executorHeartbeatAt).toBeTruthy()
    expect(result.batch.runtimeDirectory).toContain(`/runtime/batches/01.01/runs/${result.batch.runId}`)
    expect(result.batch.activityJournalPath).toContain("activity.jsonl")
    expect(JSON.parse(readFileSync(join(workspace.repoRoot, result.batch.snapshotPath!), "utf8"))).toMatchObject({
      batchId: "01.01",
      runId: result.batch.runId,
      status: "completed",
      threads: [{ nativeSessionId: "fake-session-cursor-attempt-heartbeat" }],
    })

    const state = loadStructuredWorkstreamStateSync(workspace.repoRoot, workspace.streamId)!
    const session = state.threadRuntime[0]!.sessions[0]!
    expect(session).toMatchObject({
      sessionId: "session-heartbeat",
      attemptId: "attempt-heartbeat",
      logicalAgent: "default",
      nativeSessionId: "fake-session-cursor-attempt-heartbeat",
      executionBackend: "sdk",
      provider: "cursor",
      runtime: "cursor",
      runtimeSelectionSource: "model_reference",
      terminalOutcome: "completed",
    })
    expect(session.lastActivityAt).toBeTruthy()
  })

  test("cancellation requests active adapters and prevents fallback", async () => {
    const workspace = createExecutorWorkspace({ models: '"auto@cursor", "composer-1@cursor"', threadCount: 1 })
    const adapters: FakeAgentAttemptAdapter[] = []
    const executor = new BatchExecutor({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      adapterFactory: fakeFactory(adapters, () => ({
        outcome: { status: "completed", result: "late" },
        runDelayMs: 100,
      })),
    })
    const running = executor.run()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await executor.cancel("test cancellation")
    const result = await running

    expect(result.batch.status).toBe("failed")
    expect(result.batch.terminalOutcome).toBe("cancelled")
    expect(adapters).toHaveLength(1)
    expect(adapters[0]!.cancelCalls).toHaveLength(1)
  })

  test("uses only explicit fallback candidates with fresh AgENV/native IDs", async () => {
    const workspace = createExecutorWorkspace({ models: '"auto@cursor", "composer-1@cursor"', threadCount: 1 })
    const adapters: FakeAgentAttemptAdapter[] = []
    const result = await executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      createAttemptId: (() => {
        let count = 0
        return () => `attempt-${++count}`
      })(),
      createWorkSessionId: (() => {
        let count = 0
        return () => `session-${++count}`
      })(),
      adapterFactory: fakeFactory(adapters, (_candidate, input) => input.attemptId === "attempt-1"
        ? { outcome: { status: "failed", error: { message: "first model failed" } } }
        : { outcome: { status: "completed", result: "fallback" } }),
    })

    expect(result.threads[0]!.attempts.map((attempt) => attempt.attemptId)).toEqual(["attempt-1", "attempt-2"])
    expect(result.threads[0]!.attempts.map((attempt) => attempt.workSessionId)).toEqual(["session-1", "session-2"])
    expect(adapters[0]!.nativeAttempts[0]!.nativeSessionId).not.toBe(adapters[1]!.nativeAttempts[0]!.nativeSessionId)
  })

  test("validates all forced-runtime candidates before readiness/provider startup", async () => {
    const workspace = createExecutorWorkspace({ models: '"openai/gpt-5@opencode"', threadCount: 1 })
    let startupCalls = 0
    await expect(new BatchExecutor({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      runtimeOverride: "cursor",
      handleSignals: false,
      adapterFactory: () => {
        startupCalls += 1
        return new FakeAgentAttemptAdapter("cursor", { outcome: { status: "completed" } })
      },
    }).run()).rejects.toThrow(/Cursor model/)
    expect(startupCalls).toBe(0)
  })

  test("does not call OpenCode readiness for a Cursor-only plan and supports mixed injected providers", async () => {
    let checks = 0
    let starts = 0
    const cursorWorkspace = createExecutorWorkspace({ models: '"auto@cursor"', threadCount: 1 })
    await executeSdkBatch({
      repoRoot: cursorWorkspace.repoRoot,
      streamId: cursorWorkspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      adapterFactory: () => new FakeAgentAttemptAdapter("cursor", { outcome: { status: "completed" } }),
      readiness: {
        isServerRunning: async () => { checks += 1; return true },
        startServer: async () => { starts += 1 },
        waitForServer: async () => true,
      },
    })
    expect(checks).toBe(0)
    expect(starts).toBe(0)

    const mixedWorkspace = createExecutorWorkspace({ models: '"auto@cursor", "anthropic/claude-sonnet-4@opencode"', threadCount: 1 })
    const mixedAdapters: FakeAgentAttemptAdapter[] = []
    const mixed = await executeSdkBatch({
      repoRoot: mixedWorkspace.repoRoot,
      streamId: mixedWorkspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      adapterFactory: fakeFactory(mixedAdapters, (candidate) => candidate.runtime === "cursor"
        ? { outcome: { status: "failed", error: { message: "force explicit fallback" } } }
        : { outcome: { status: "completed", result: "opencode fake" } }),
      readiness: {
        isServerRunning: async () => { checks += 1; return false },
        startServer: async () => { starts += 1 },
        waitForServer: async () => true,
      },
    })
    expect(mixed.batch.status).toBe("completed")
    expect(checks).toBe(1)
    expect(starts).toBe(1)
    expect(mixedAdapters.map((adapter) => adapter.provider)).toEqual(["cursor", "opencode"])
  })

  test("reconciles dead SDK ownership and refuses duplicate active launch", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1 })
    const existing: PersistedBatchStatusFile = {
      version: "1.0.0",
      streamId: workspace.streamId,
      batchId: "01.01",
      runId: "run-active",
      mode: "headless",
      status: "running",
      executionBackend: "sdk",
      executorPid: 99999,
      executorStartedAt: "2026-08-17T00:00:00.000Z",
      executorHeartbeatAt: "2026-08-17T00:00:00.000Z",
      startedAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      summary: { total: 1, pending: 0, running: 1, completed: 0, failed: 0 },
      threads: [{ threadId: "01.01.01", threadName: "First Thread", status: "running", updatedAt: "2026-08-17T00:00:00.000Z" }],
    }
    const recoveryState = loadStructuredWorkstreamStateSync(workspace.repoRoot, workspace.streamId)!
    const runningSession: SessionRecord = {
      sessionId: "session-lost",
      agentName: "default",
      model: "auto",
      startedAt: "2026-08-17T00:00:00.000Z",
      status: "running",
      executionBackend: "sdk",
      provider: "cursor",
      runtime: "cursor",
      attemptId: "attempt-lost",
    }
    recoveryState.threadRuntime[0]!.sessions = [runningSession]
    recoveryState.threadRuntime[0]!.currentSessionId = runningSession.sessionId
    replaceStructuredWorkstreamStateSync({ repoRoot: workspace.repoRoot, workstreamState: recoveryState })
    writeBatchStatus(workspace.repoRoot, workspace.streamId, existing)
    const recovered = await reconcileBatchStatusRunIfNeeded({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      now: () => "2026-08-17T00:01:00.000Z",
      isProcessAlive: () => false,
      sdkExecutorStaleAfterMs: 1,
    })
    expect(recovered?.status).toBe("failed")
    expect(recovered?.threads[0]?.recoveryNote).toContain("SDK executor")
    expect(loadStructuredWorkstreamStateSync(workspace.repoRoot, workspace.streamId)!.threadRuntime[0]!.sessions[0]).toMatchObject({
      status: "interrupted",
      terminalOutcome: "failed",
    })

    const active = { ...existing, runId: "run-still-active", executorPid: 123, executorHeartbeatAt: "2026-08-17T00:00:00.000Z" }
    writeBatchStatus(workspace.repoRoot, workspace.streamId, active)
    await expect(new BatchExecutor({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      now: () => "2026-08-17T00:00:01.000Z",
      isProcessAlive: () => true,
      adapterFactory: () => new FakeAgentAttemptAdapter("cursor", { outcome: { status: "completed" } }),
    }).run()).rejects.toThrow(/active canonical run/)
  })

  test("adopts a manager-prepared run and rejects a second active owner", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1, models: '"auto@cursor"' })
    const prepared = prepareSdkBatchRun({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      ownerToken: "owner-token",
      now: () => "2026-08-17T00:00:00.000Z",
      pid: 111,
    })

    expect(prepared.batch.status).toBe("pending")
    expect(prepared.batch.executorOwnerToken).toBe("owner-token")
    expect(prepared.batch.executorPid).toBeUndefined()

    const first = new BatchExecutor({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      runId: prepared.batch.runId,
      ownerToken: prepared.ownerToken,
      pid: 111,
      now: () => "2026-08-17T00:00:01.000Z",
      handleSignals: false,
      adapterFactory: () => new FakeAgentAttemptAdapter("cursor", {
        outcome: { status: "completed", result: "adopted" },
        runDelayMs: 50,
      }),
    })
    const firstRun = first.run()
    await new Promise((resolve) => setTimeout(resolve, 10))

    await expect(new BatchExecutor({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      runId: prepared.batch.runId,
      ownerToken: prepared.ownerToken,
      pid: 222,
      now: () => "2026-08-17T00:00:01.000Z",
      isProcessAlive: () => true,
      handleSignals: false,
      adapterFactory: () => new FakeAgentAttemptAdapter("cursor", { outcome: { status: "completed" } }),
    }).run()).rejects.toThrow(/active canonical run/)

    await expect(firstRun).resolves.toMatchObject({ batch: { status: "completed", executorPid: 111 } })
  })

  test("--no-server fails clearly without starting OpenCode", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1, models: '"anthropic/claude-sonnet-4@opencode"' })
    let starts = 0

    await expect(executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      noServer: true,
      handleSignals: false,
      readiness: {
        isServerRunning: async () => false,
        startServer: async () => { starts += 1 },
        waitForServer: async () => true,
      },
      adapterFactory: () => new FakeAgentAttemptAdapter("opencode", { outcome: { status: "completed" } }),
    })).rejects.toThrow(/--no-server/)
    expect(starts).toBe(0)
  })

  test("journals concurrent attempts with thread, attempt, and native correlation", async () => {
    const workspace = createExecutorWorkspace()
    const result = await executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      adapterFactory: (_candidate, input) => new FakeAgentAttemptAdapter("cursor", {
        outcome: { status: "completed", result: input.threadId },
        runDelayMs: 10,
        events: [
          {
            provider: "cursor",
            attemptId: input.attemptId,
            workSessionId: input.workSessionId,
            eventId: `${input.attemptId}:started`,
            timestamp: "2026-08-17T00:00:01.000Z",
            type: "started",
          },
          {
            provider: "cursor",
            attemptId: input.attemptId,
            workSessionId: input.workSessionId,
            eventId: `${input.attemptId}:tool-start`,
            timestamp: "2026-08-17T00:00:02.000Z",
            type: "tool",
            toolName: "edit",
            phase: "started",
          },
          {
            provider: "cursor",
            attemptId: input.attemptId,
            workSessionId: input.workSessionId,
            eventId: `${input.attemptId}:tool-finish`,
            timestamp: "2026-08-17T00:00:03.000Z",
            type: "tool",
            toolName: "edit",
            phase: "completed",
          },
        ],
      }),
    })

    const records = readActivityJournal(join(workspace.repoRoot, result.batch.activityJournalPath!))
    const toolRecords = records.filter((record) => record.kind === "tool")
    expect(toolRecords).toHaveLength(4)
    expect(new Set(toolRecords.map((record) => record.threadId))).toEqual(new Set(["01.01.01", "01.01.02"]))
    expect(toolRecords.every((record) => record.attemptId && record.nativeSessionId?.startsWith("fake-session-cursor-"))).toBe(true)
    expect(records.some((record) => record.kind === "batch_completed" || record.kind === "batch_failed")).toBe(true)
  })

  test("coalesces assistant deltas into bounded journal records", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1 })
    const result = await executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      activityFlushIntervalMs: 60 * 60 * 1000,
      activityMaxAssistantChars: 20,
      adapterFactory: (_candidate, input) => new FakeAgentAttemptAdapter("cursor", {
        outcome: { status: "completed", result: "done" },
        events: Array.from({ length: 150 }, (_, index) => ({
          provider: "cursor" as const,
          attemptId: input.attemptId,
          workSessionId: input.workSessionId,
          eventId: `${input.attemptId}:delta-${index}`,
          timestamp: "2026-08-17T00:00:01.000Z",
          type: "assistant" as const,
          text: "x",
          delta: true,
        })),
      }),
    })

    const assistant = readActivityJournal(join(workspace.repoRoot, result.batch.activityJournalPath!))
      .filter((record) => record.kind === "assistant")
    expect(assistant.length).toBeGreaterThan(0)
    expect(assistant.length).toBeLessThan(150)
    expect(assistant.every((record) => record.summary.length <= 20)).toBe(true)
  })

  test("atomically replaces a useful canonical execution snapshot", () => {
    const files = new Map<string, string>([["snapshot.json", "old snapshot\n"]])
    let renameCount = 0
    const fileSystem: ObservabilityFileSystem = {
      mkdirSync: () => undefined,
      appendFileSync: () => undefined,
      writeFileSync: (path, content) => { files.set(path, content) },
      renameSync: (from, to) => {
        renameCount += 1
        files.set(to, files.get(from) ?? "")
      },
      rmSync: (path) => { files.delete(path) },
    }
    const batch = {
      version: "1.0.0",
      streamId: "001-test",
      batchId: "01.01",
      runId: "run-1",
      mode: "headless",
      status: "running",
      executionBackend: "sdk",
      startedAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:01.000Z",
      summary: { total: 1, pending: 0, running: 1, completed: 0, failed: 0 },
      threads: [{
        threadId: "01.01.01",
        threadName: "First",
        status: "running",
        updatedAt: "2026-08-17T00:00:01.000Z",
        provider: "cursor",
        attemptId: "attempt-1",
        nativeSessionId: "native-1",
      }],
    } satisfies BatchStatusFile
    const writer = new AtomicSnapshotWriter({
      path: "snapshot.json",
      fileSystem,
      createTempPath: () => "snapshot.json.tmp",
    })
    writer.write(projectBatchExecutionSnapshot(batch, "2026-08-17T00:00:01.000Z"))

    expect(renameCount).toBe(1)
    expect(files.get("snapshot.json")).not.toContain("old snapshot")
    expect(JSON.parse(files.get("snapshot.json")!)).toMatchObject({
      batchId: "01.01",
      runId: "run-1",
      status: "running",
      threads: [{ attemptId: "attempt-1", nativeSessionId: "native-1" }],
    })
  })

  test("observer reads the journal without tmux or canonical mutation", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1 })
    const result = await executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      adapterFactory: () => new FakeAgentAttemptAdapter("cursor", { outcome: { status: "completed", result: "done" } }),
    })
    const before = JSON.stringify(loadStructuredWorkstreamStateSync(workspace.repoRoot, workspace.streamId))
    const output: string[] = []
    const observed = await observeBatchEvents({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      format: "json",
      write: (line) => output.push(line),
    })
    const after = JSON.stringify(loadStructuredWorkstreamStateSync(workspace.repoRoot, workspace.streamId))

    expect(observed.terminal).toBe(true)
    expect(output.some((line) => line.includes("batch_completed"))).toBe(true)
    expect(output.every((line) => JSON.parse(line).batchId === "01.01")).toBe(true)
    expect(after).toBe(before)
    expect(result.batch.tmuxSessionName).toBeUndefined()
  })

  test("observability write failures do not fail provider execution", async () => {
    const workspace = createExecutorWorkspace({ threadCount: 1 })
    const failingFileSystem: ObservabilityFileSystem = {
      mkdirSync: () => { throw new Error("observability filesystem unavailable") },
      appendFileSync: () => { throw new Error("unreachable") },
      writeFileSync: () => { throw new Error("unreachable") },
      renameSync: () => { throw new Error("unreachable") },
      rmSync: () => undefined,
    }
    const result = await executeSdkBatch({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "01.01",
      handleSignals: false,
      observabilityFileSystem: failingFileSystem,
      adapterFactory: () => new FakeAgentAttemptAdapter("cursor", { outcome: { status: "completed", result: "still completed" } }),
    })

    expect(result.batch.status).toBe("completed")
    expect(result.threads[0]!.status).toBe("completed")
  })
})
