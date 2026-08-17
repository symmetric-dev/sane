import { afterEach, describe, expect, test } from "bun:test"

import {
  filesystemStructuredStorageAdapter,
  loadStructuredWorkstreamStateSync,
  replaceStructuredWorkstreamStateSync,
} from "../src/lib/storage-adapter.ts"
import { writeBatchStatus } from "../src/lib/batch-status.ts"
import { createEmptyStructuredStorageWorkstreamState } from "../src/lib/structured-storage.ts"
import { cleanupTestWorkstream, createTestWorkstream, type TestWorkspace } from "./helpers/test-workspace.ts"
import type {
  PersistedBatchStatusFile,
  SessionRecord,
} from "../src/lib/types.ts"

function createMetadataState(workspace: TestWorkspace) {
  const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
  state.hierarchy.stages = [{ id: "01", number: 1, name: "Stage 01" }]
  state.hierarchy.batches = [{ id: "01.01", stageId: "01", number: 1, name: "Batch 01" }]
  state.hierarchy.threads = [
    { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Thread 01" },
  ]

  const session: SessionRecord = {
    sessionId: "session-01",
    agentName: "default",
    model: "legacy/model-name",
    startedAt: "2026-08-17T10:00:00.000Z",
    completedAt: "2026-08-17T10:05:00.000Z",
    status: "completed",
    exitCode: 0,
    executionBackend: "sdk",
    provider: "cursor",
    runtime: "cursor",
    logicalAgent: "default",
    resolvedModel: "auto",
    resolvedVariant: "fast",
    runtimeSelectionSource: "cli_override",
    attemptId: "attempt-01",
    nativeSessionId: "cursor-agent-01",
    nativeRunId: "cursor-run-01",
    lastEventAt: "2026-08-17T10:04:00.000Z",
    lastActivityAt: "2026-08-17T10:04:30.000Z",
    cancellationRequestedAt: "2026-08-17T10:04:40.000Z",
    cancellationAcknowledgedAt: "2026-08-17T10:04:41.000Z",
    terminalOutcome: "completed",
    errorSummary: "",
    resultSummary: "Applied the requested changes.",
  }

  state.threadRuntime = [
    {
      threadId: "01.01.01",
      sessions: [session],
      status: "completed",
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:05:00.000Z",
    },
  ]

  const batchRun: PersistedBatchStatusFile = {
    version: "1.0.0",
    streamId: workspace.streamId,
    batchId: "01.01",
    runId: "run-01",
    mode: "headless",
    status: "completed",
    startedAt: "2026-08-17T10:00:00.000Z",
    updatedAt: "2026-08-17T10:05:00.000Z",
    completedAt: "2026-08-17T10:05:00.000Z",
    executionBackend: "sdk",
    provider: "cursor",
    runtime: "cursor",
    logicalAgent: "default",
    resolvedModel: "auto",
    resolvedVariant: "fast",
    runtimeSelectionSource: "cli_override",
    executorPid: 4242,
    executorStartedAt: "2026-08-17T09:59:59.000Z",
    executorHeartbeatAt: "2026-08-17T10:04:59.000Z",
    executorFinishedAt: "2026-08-17T10:05:00.000Z",
    lastEventAt: "2026-08-17T10:04:58.000Z",
    lastActivityAt: "2026-08-17T10:04:59.000Z",
    cancellationRequestedAt: "2026-08-17T10:04:40.000Z",
    cancellationAcknowledgedAt: "2026-08-17T10:04:41.000Z",
    terminalOutcome: "completed",
    errorSummary: "",
    resultSummary: "All implementation threads completed.",
    runtimeDirectory: "work/001-sdk-state/runtime/batches/01.01/runs/run-01",
    activityJournalPath: "work/001-sdk-state/runtime/batches/01.01/runs/run-01/activity.jsonl",
    snapshotPath: "work/001-sdk-state/runtime/batches/01.01/runs/run-01/snapshot.json",
    executorLogPath: "work/001-sdk-state/runtime/batches/01.01/runs/run-01/executor.log",
    summary: { total: 1, pending: 0, running: 0, completed: 1, failed: 0 },
    threads: [
      {
        threadId: "01.01.01",
        threadName: "Thread 01",
        status: "completed",
        startedAt: "2026-08-17T10:00:00.000Z",
        updatedAt: "2026-08-17T10:05:00.000Z",
        completedAt: "2026-08-17T10:05:00.000Z",
        executionBackend: "sdk",
        provider: "cursor",
        runtime: "cursor",
        logicalAgent: "default",
        resolvedModel: "auto",
        resolvedVariant: "fast",
        runtimeSelectionSource: "cli_override",
        attemptId: "attempt-01",
        nativeSessionId: "cursor-agent-01",
        nativeRunId: "cursor-run-01",
        lastEventAt: "2026-08-17T10:04:00.000Z",
        lastActivityAt: "2026-08-17T10:04:30.000Z",
        cancellationRequestedAt: "2026-08-17T10:04:40.000Z",
        cancellationAcknowledgedAt: "2026-08-17T10:04:41.000Z",
        terminalOutcome: "completed",
        errorSummary: "",
        resultSummary: "Applied the requested changes.",
      },
    ],
  }

  state.batchRuns = [batchRun]
  return { state, session, batchRun }
}

describe("SDK execution metadata in canonical state", () => {
  const workspaces: TestWorkspace[] = []

  afterEach(() => {
    while (workspaces.length > 0) {
      cleanupTestWorkstream(workspaces.pop()!)
    }
  })

  test("round-trips session and batch metadata through filesystem and SQLite state", async () => {
    const workspace = createTestWorkstream(`001-sdk-state-metadata-${Date.now()}`)
    workspaces.push(workspace)
    const { state, session, batchRun } = createMetadataState(workspace)

    replaceStructuredWorkstreamStateSync({ repoRoot: workspace.repoRoot, workstreamState: state })
    writeBatchStatus(workspace.repoRoot, workspace.streamId, batchRun)

    const filesystemState = await filesystemStructuredStorageAdapter.loadWorkstreamState(
      workspace.repoRoot,
      workspace.streamId,
    )
    expect(filesystemState?.threadRuntime[0]?.sessions[0]).toEqual(session)
    expect(filesystemState?.batchRuns[0]).toEqual(batchRun)

    const sqliteState = loadStructuredWorkstreamStateSync(workspace.repoRoot, workspace.streamId)
    expect(sqliteState?.threadRuntime[0]?.sessions[0]).toMatchObject(session)
    expect(sqliteState?.batchRuns[0]).toEqual(batchRun)
    expect(sqliteState?.batchRuns[0]?.threads[0]).toEqual(batchRun.threads[0])
  })

  test("keeps legacy session and batch fixtures unchanged", async () => {
    const workspace = createTestWorkstream(`001-legacy-state-metadata-${Date.now()}`)
    workspaces.push(workspace)
    const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
    state.hierarchy.stages = [{ id: "01", number: 1, name: "Stage 01" }]
    state.hierarchy.batches = [{ id: "01.01", stageId: "01", number: 1, name: "Batch 01" }]
    state.hierarchy.threads = [
      { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Legacy thread" },
    ]

    const legacySession: SessionRecord = {
      sessionId: "legacy-session",
      agentName: "default",
      model: "anthropic/claude-sonnet-4",
      startedAt: "2026-08-17T10:00:00.000Z",
      status: "running",
    }
    const legacyBatch: PersistedBatchStatusFile = {
      version: "1.0.0",
      streamId: workspace.streamId,
      batchId: "01.01",
      runId: "legacy-run",
      mode: "headless",
      status: "running",
      startedAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:01:00.000Z",
      summary: { total: 1, pending: 0, running: 1, completed: 0, failed: 0 },
      threads: [
        {
          threadId: "01.01.01",
          threadName: "Legacy thread",
          status: "running",
          updatedAt: "2026-08-17T10:01:00.000Z",
        },
      ],
    }
    state.threadRuntime = [{ threadId: "01.01.01", sessions: [legacySession] }]
    state.batchRuns = [legacyBatch]

    replaceStructuredWorkstreamStateSync({ repoRoot: workspace.repoRoot, workstreamState: state })

    const filesystemState = await filesystemStructuredStorageAdapter.loadWorkstreamState(
      workspace.repoRoot,
      workspace.streamId,
    )
    expect(filesystemState?.threadRuntime[0]?.sessions[0]).toEqual(legacySession)
    expect(filesystemState?.batchRuns[0]).toEqual(legacyBatch)

    const sqliteState = loadStructuredWorkstreamStateSync(workspace.repoRoot, workspace.streamId)
    expect(JSON.parse(JSON.stringify(sqliteState?.threadRuntime[0]?.sessions[0]))).toEqual(legacySession)
    expect(JSON.parse(JSON.stringify(sqliteState?.batchRuns[0]))).toEqual(legacyBatch)
  })
})
