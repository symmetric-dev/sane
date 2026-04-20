import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"

import {
  createEmptyStructuredStorageWorkstreamState,
  createEmptySupervisorState,
  createStructuredStorageWorkstreamRecord,
  getStructuredStorageAdapter,
  getStructuredStorageSqlitePath,
  saveSupervisorState,
  updateTask,
  writeBatchStatus,
} from "../src"
import type {
  PersistedBatchStatusFile,
  StreamMetadata,
  StructuredStorageWorkstreamState,
  SupervisorStateFile,
} from "../src"
import { completeThreadSessionLocked } from "../src/lib/threads.ts"
import { cleanupTestWorkstream, createTestWorkstream, type TestWorkspace } from "./helpers"

function buildStream(streamId: string, timestamp: string): StreamMetadata {
  return {
    id: streamId,
    name: "sqlite-write-adapter",
    order: 1,
    status: "in_progress",
    size: "short",
    session_estimated: {
      length: 1,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8],
    },
    created_at: timestamp,
    updated_at: timestamp,
    path: `work/${streamId}`,
    generated_by: { workstreams: "test" },
    current_batch: "03.01",
  }
}

function buildBatchRun(streamId: string, timestamp: string): PersistedBatchStatusFile {
  return {
    version: "1.0.0",
    streamId,
    batchId: "03.01",
    runId: "run-03.01",
    mode: "headless",
    status: "running",
    startedAt: timestamp,
    updatedAt: timestamp,
    summary: {
      total: 1,
      pending: 0,
      running: 1,
      completed: 0,
      failed: 0,
    },
    threads: [
      {
        threadId: "03.01.02",
        threadName: "Structured write adapter",
        firstTaskId: "03.01.02.01",
        status: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
        currentSessionId: "ses-thread-1",
      },
    ],
  }
}

function buildSupervisorState(streamId: string, timestamp: string): SupervisorStateFile {
  const supervision = createEmptySupervisorState(streamId)
  supervision.last_updated = timestamp
  supervision.active_run_id = "sup-run-1"
  supervision.current_branch_supervision = {
    owner: "root_agent",
    rootSessionId: "root-1",
    branchSessionId: "branch-1",
    branchRole: "supervision",
    source: "native_fork",
    nativeSessionId: "native-1",
    updatedAt: timestamp,
    scope: { level: "batch", stageId: "03", batchId: "03.01" },
    supervisionProgress: {
      executionMode: "single_batch_run",
      currentBatchId: "03.01",
    },
  }
  supervision.runs = [
    {
      runId: "sup-run-1",
      stageId: "03",
      status: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
      currentBatchId: "03.01",
      reviewPasses: 1,
      issueSummaryIds: ["issue-1"],
      escalationIds: [],
      rootSessionId: "root-1",
      branchSessionId: "branch-1",
    },
  ]
  supervision.branch_sessions = [
    {
      owner: "root_agent",
      rootSessionId: "root-1",
      branchSessionId: "branch-1",
      branchRole: "supervision",
      source: "native_fork",
      status: "running",
      startedAt: timestamp,
      updatedAt: timestamp,
      nativeSessionId: "native-1",
      runId: "sup-run-1",
      batchId: "03.01",
      supervisionProgress: {
        executionMode: "single_batch_run",
        currentBatchId: "03.01",
      },
    },
  ]

  return supervision
}

function buildWorkstreamState(streamId: string, timestamp: string): StructuredStorageWorkstreamState {
  const state = createEmptyStructuredStorageWorkstreamState(streamId)
  state.hierarchy.stages = [
    {
      id: "03",
      number: 3,
      name: "Implement sqlite adapter with filesystem-authoritative dual-write",
    },
  ]
  state.hierarchy.batches = [
    {
      id: "03.01",
      stageId: "03",
      number: 1,
      name: "Create sqlite schema and adapter",
    },
  ]
  state.hierarchy.threads = [
    {
      id: "03.01.02",
      stageId: "03",
      batchId: "03.01",
      number: 2,
      name: "Structured write adapter",
      promptPath: "prompts/03.01.02.md",
    },
  ]
  state.hierarchy.tasks = [
    {
      id: "03.01.02.01",
      stageId: "03",
      batchId: "03.01",
      threadId: "03.01.02",
      number: 1,
      name: "Implement sqlite-backed writes",
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      assignedAgent: "systems-engineer",
    },
  ]
  state.approvals = [
    {
      streamId,
      scope: "plan",
      status: "approved",
      approvedAt: timestamp,
      approvedBy: "reviewer",
      planHash: "plan-hash",
    },
    {
      streamId,
      scope: "tasks",
      status: "approved",
      approvedAt: timestamp,
      taskCount: 1,
    },
  ]
  state.threadRuntime = [
    {
      threadId: "03.01.02",
      sessions: [
        {
          sessionId: "ses-thread-1",
          agentName: "systems-engineer",
          model: "gpt-5.4",
          startedAt: timestamp,
          status: "running",
        },
      ],
      currentSessionId: "ses-thread-1",
      opencodeSessionId: "opencode-1",
      workingAgentSessionId: "worker-1",
      synthesisOutput: "report.md",
    },
  ]
  state.batchRuns = [buildBatchRun(streamId, timestamp)]
  state.supervision = buildSupervisorState(streamId, timestamp)

  return state
}

function openDatabase(workspace: TestWorkspace): Database {
  return new Database(getStructuredStorageSqlitePath(workspace.repoRoot), { readonly: true })
}

describe("sqlite structured storage dual-write", () => {
  let workspace: TestWorkspace

  beforeEach(() => {
    workspace = createTestWorkstream(`001-sqlite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  })

  afterEach(() => {
    cleanupTestWorkstream(workspace)
  })

  test("mirrors structured adapter writes into sqlite tables", async () => {
    const timestamp = "2026-04-19T12:00:00.000Z"
    const stream = buildStream(workspace.streamId, timestamp)
    const state = buildWorkstreamState(workspace.streamId, timestamp)
    const adapter = getStructuredStorageAdapter()

    await adapter.replaceWorkspaceState(workspace.repoRoot, {
      currentStreamId: workspace.streamId,
      workstreams: [createStructuredStorageWorkstreamRecord(stream)],
    })
    await adapter.replaceWorkstreamState(workspace.repoRoot, state)

    const database = openDatabase(workspace)
    try {
      expect(
        database.query("select current_stream_id from workspace_state where singleton_id = 1").get(),
      ).toEqual({ current_stream_id: workspace.streamId })

      expect(
        database.query("select stream_id, current_batch_id from workstreams order by stream_id").all(),
      ).toEqual([{ stream_id: workspace.streamId, current_batch_id: "03.01" }])

      expect(database.query("select task_id from tasks order by task_id").all()).toEqual([
        { task_id: "03.01.02.01" },
      ])
      expect(
        database.query("select thread_id, current_session_id from threads order by thread_id").all(),
      ).toEqual([{ thread_id: "03.01.02", current_session_id: "ses-thread-1" }])
      expect(database.query("select session_id from thread_sessions order by session_id").all()).toEqual([
        { session_id: "ses-thread-1" },
      ])
      expect(database.query("select approval_key from approvals order by approval_key").all()).toEqual([
        { approval_key: "plan:" },
        { approval_key: "tasks:" },
      ])
      expect(database.query("select run_id from batch_runs order by run_id").all()).toEqual([
        { run_id: "run-03.01" },
      ])
      expect(
        database.query("select first_task_id from batch_run_threads order by thread_id").all(),
      ).toEqual([{ first_task_id: "03.01.02.01" }])
      expect(database.query("select run_id from supervision_runs order by run_id").all()).toEqual([
        { run_id: "sup-run-1" },
      ])
      expect(
        database.query("select branch_session_id from supervision_sessions order by branch_session_id").all(),
      ).toEqual([{ branch_session_id: "branch-1" }])
    } finally {
      database.close()
    }
  })

  test("mirrors compatibility helper updates into sqlite", async () => {
    const timestamp = "2026-04-19T12:00:00.000Z"
    const completedAt = "2026-04-19T13:00:00.000Z"
    const stream = buildStream(workspace.streamId, timestamp)
    const state = buildWorkstreamState(workspace.streamId, timestamp)
    const adapter = getStructuredStorageAdapter()

    await adapter.replaceWorkspaceState(workspace.repoRoot, {
      currentStreamId: workspace.streamId,
      workstreams: [createStructuredStorageWorkstreamRecord(stream)],
    })
    await adapter.replaceWorkstreamState(workspace.repoRoot, state)

    await updateTask({
      repoRoot: workspace.repoRoot,
      stream,
      taskId: "03.01.02.01",
      status: "completed",
      report: "SQLite dual-write mirrored task completion.",
      assigned_agent: "systems-engineer",
    })
    await completeThreadSessionLocked(
      workspace.repoRoot,
      workspace.streamId,
      "03.01.02",
      "ses-thread-1",
      "completed",
    )

    writeBatchStatus(workspace.repoRoot, workspace.streamId, {
      ...buildBatchRun(workspace.streamId, timestamp),
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      summary: {
        total: 1,
        pending: 0,
        running: 0,
        completed: 1,
        failed: 0,
      },
      threads: [
        {
          threadId: "03.01.02",
          threadName: "Structured write adapter",
          firstTaskId: "03.01.02.01",
          status: "completed",
          startedAt: timestamp,
          updatedAt: completedAt,
          completedAt,
        },
      ],
    })

    saveSupervisorState(workspace.repoRoot, workspace.streamId, {
      ...buildSupervisorState(workspace.streamId, timestamp),
      last_updated: completedAt,
      runs: [
        {
          runId: "sup-run-1",
          stageId: "03",
          status: "completed",
          startedAt: timestamp,
          updatedAt: completedAt,
          completedAt,
          currentBatchId: "03.01",
          reviewPasses: 2,
          issueSummaryIds: ["issue-1"],
          escalationIds: [],
          rootSessionId: "root-1",
          branchSessionId: "branch-1",
        },
      ],
    })

    const database = openDatabase(workspace)
    try {
      expect(
        database.query("select status, report from tasks where task_id = ?").get("03.01.02.01"),
      ).toEqual({
        status: "completed",
        report: "SQLite dual-write mirrored task completion.",
      })
      expect(
        database.query("select current_session_id from threads where thread_id = ?").get("03.01.02"),
      ).toEqual({ current_session_id: null })
      expect(
        database.query("select status, completed_at from thread_sessions where session_id = ?").get("ses-thread-1"),
      ).toMatchObject({ status: "completed" })
      expect(database.query("select status from batch_runs where run_id = ?").get("run-03.01")).toEqual({
        status: "completed",
      })
      expect(
        database.query("select status, review_passes from supervision_runs where run_id = ?").get("sup-run-1"),
      ).toEqual({ status: "completed", review_passes: 2 })
    } finally {
      database.close()
    }
  })
})
