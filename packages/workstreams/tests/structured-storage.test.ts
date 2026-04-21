import { describe, expect, test } from "bun:test"

import {
  approvalMetadataToStructuredApprovalRecords,
  createEmptyStructuredStorageWorkstreamState,
  createStreamMetadataFromStructuredStorageRecord,
  createStructuredStorageParitySnapshot,
  createStructuredStorageWorkstreamRecord,
  replaceStructuredApprovals,
  structuredApprovalRecordsToApprovalMetadata,
  updateStructuredTask,
  upsertStructuredBatchRun,
  upsertStructuredThreadRuntime,
} from "../src"
import type {
  PersistedBatchStatusFile,
  StreamMetadata,
  StructuredStorageWorkspaceState,
  StructuredStorageWorkstreamState,
  SupervisorStateFile,
} from "../src"

function buildStreamMetadata(): StreamMetadata {
  return {
    id: "001-storage-contract",
    name: "storage-contract",
    order: 1,
    status: "in_progress",
    approval: {
      status: "approved",
      approved_at: "2026-04-19T00:00:00.000Z",
      approved_by: "reviewer",
      plan_hash: "plan-hash",
      tasks: {
        status: "approved",
        approved_at: "2026-04-19T00:10:00.000Z",
        task_count: 4,
      },
      stages: {
        2: {
          status: "approved",
          approved_at: "2026-04-19T00:20:00.000Z",
          approved_by: "stage-reviewer",
          commit_sha: "abc123",
        },
      },
    },
    size: "short",
    session_estimated: {
      length: 1,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8],
    },
    created_at: "2026-04-19T00:00:00.000Z",
    updated_at: "2026-04-19T01:00:00.000Z",
    path: "work/001-storage-contract",
    generated_by: { workstreams: "0.6.2" },
    files: ["PLAN.md", "TASKS.md"],
    current_batch: "02.01",
    planningSession: {
      sessionId: "ses_plan",
      createdAt: "2026-04-19T00:05:00.000Z",
    },
    github: {
      branch: "feature/storage-contract",
      pr_number: 42,
    },
  }
}

function buildBatchRun(batchId: string, runId: string): PersistedBatchStatusFile {
  return {
    version: "1.0.0",
    streamId: "001-storage-contract",
    batchId,
    runId,
    mode: "headless",
    status: "running",
    startedAt: "2026-04-19T02:00:00.000Z",
    updatedAt: "2026-04-19T02:05:00.000Z",
    summary: {
      total: 2,
      pending: 1,
      running: 1,
      completed: 0,
      failed: 0,
    },
    threads: [
      {
        threadId: `${batchId}.02`,
        threadName: "Thread 2",
        firstTaskId: `${batchId}.02.01`,
        status: "pending",
        updatedAt: "2026-04-19T02:05:00.000Z",
      },
      {
        threadId: `${batchId}.01`,
        threadName: "Thread 1",
        firstTaskId: `${batchId}.01.01`,
        status: "running",
        updatedAt: "2026-04-19T02:05:00.000Z",
      },
    ],
  }
}

function buildSupervisionState(): SupervisorStateFile {
  return {
    version: "1.0.0",
    stream_id: "001-storage-contract",
    last_updated: "2026-04-19T03:00:00.000Z",
    active_run_id: "run-2",
    runs: [
      {
        runId: "run-2",
        stageId: "02",
        status: "running",
        startedAt: "2026-04-19T03:00:00.000Z",
        updatedAt: "2026-04-19T03:05:00.000Z",
        reviewPasses: 1,
        issueSummaryIds: ["issue-2", "issue-1"],
        escalationIds: ["esc-2", "esc-1"],
      },
      {
        runId: "run-1",
        stageId: "01",
        status: "completed",
        startedAt: "2026-04-19T01:00:00.000Z",
        updatedAt: "2026-04-19T01:30:00.000Z",
        completedAt: "2026-04-19T01:30:00.000Z",
        reviewPasses: 2,
        issueSummaryIds: [],
        escalationIds: [],
      },
    ],
    checkpoint_pointers: [
      {
        rootSessionId: "root-2",
        checkpointMessageIndex: 2,
        checkpointCreatedAt: "2026-04-19T03:00:00.000Z",
      },
      {
        rootSessionId: "root-1",
        checkpointMessageIndex: 1,
        checkpointCreatedAt: "2026-04-19T02:00:00.000Z",
      },
    ],
    branch_sessions: [
      {
        owner: "root_agent",
        rootSessionId: "root-2",
        branchSessionId: "branch-2",
        branchRole: "supervision",
        source: "native_fork",
        status: "running",
        startedAt: "2026-04-19T03:00:00.000Z",
        updatedAt: "2026-04-19T03:05:00.000Z",
        nativeSessionId: "native-2",
      },
      {
        owner: "root_agent",
        rootSessionId: "root-1",
        branchSessionId: "branch-1",
        branchRole: "review",
        source: "repo_local_fallback",
        status: "completed",
        startedAt: "2026-04-19T02:00:00.000Z",
        updatedAt: "2026-04-19T02:20:00.000Z",
      },
    ],
    reviewed_batches: [
      {
        reviewId: "review-2",
        runId: "run-2",
        stageId: "02",
        batchId: "02.01",
        reviewPass: 1,
        reviewedAt: "2026-04-19T03:05:00.000Z",
        outcome: "changes_requested",
        threadIds: ["02.01.02", "02.01.01"],
        issueSummaryIds: ["issue-2", "issue-1"],
      },
      {
        reviewId: "review-1",
        runId: "run-1",
        stageId: "01",
        batchId: "01.01",
        reviewPass: 1,
        reviewedAt: "2026-04-19T01:15:00.000Z",
        outcome: "approved",
        threadIds: ["01.01.01"],
        issueSummaryIds: [],
      },
    ],
    issue_summaries: [
      {
        summaryId: "issue-2",
        runId: "run-2",
        stageId: "02",
        batchId: "02.01",
        status: "open",
        summary: "Second issue",
        firstObservedAt: "2026-04-19T03:04:00.000Z",
        lastObservedAt: "2026-04-19T03:05:00.000Z",
      },
      {
        summaryId: "issue-1",
        runId: "run-2",
        stageId: "02",
        batchId: "02.01",
        status: "open",
        summary: "First issue",
        firstObservedAt: "2026-04-19T03:03:00.000Z",
        lastObservedAt: "2026-04-19T03:05:00.000Z",
      },
    ],
    fix_cycles: [
      {
        cycleId: "cycle-2",
        runId: "run-2",
        stageId: "02",
        batchId: "02.01",
        threadId: "02.01.02",
        attemptCount: 2,
        lastAttemptAt: "2026-04-19T03:06:00.000Z",
        lastOutcome: "pending_review",
        issueSummaryIds: ["issue-2", "issue-1"],
      },
      {
        cycleId: "cycle-1",
        runId: "run-1",
        stageId: "01",
        batchId: "01.01",
        threadId: "01.01.01",
        attemptCount: 1,
        lastAttemptAt: "2026-04-19T01:16:00.000Z",
        lastOutcome: "accepted",
        issueSummaryIds: [],
      },
    ],
    escalations: [
      {
        escalationId: "esc-2",
        runId: "run-2",
        stageId: "02",
        target: "batch",
        reason: "Needs attention",
        status: "pending",
        escalatedAt: "2026-04-19T03:07:00.000Z",
      },
      {
        escalationId: "esc-1",
        runId: "run-1",
        stageId: "01",
        target: "thread",
        reason: "Already handled",
        status: "resolved",
        escalatedAt: "2026-04-19T01:17:00.000Z",
      },
    ],
    stage_stops: [
      {
        stopId: "stop-2",
        runId: "run-2",
        stageId: "02",
        reason: "blocked",
        summary: "Blocked by review",
        stoppedAt: "2026-04-19T03:08:00.000Z",
      },
      {
        stopId: "stop-1",
        runId: "run-1",
        stageId: "01",
        reason: "completed",
        summary: "Done",
        stoppedAt: "2026-04-19T01:30:00.000Z",
      },
    ],
  }
}

function buildWorkstreamState(): StructuredStorageWorkstreamState {
  const state = createEmptyStructuredStorageWorkstreamState("001-storage-contract")
  state.hierarchy.stages = [
    { id: "02", number: 2, name: "Stage Two" },
    { id: "01", number: 1, name: "Stage One" },
  ]
  state.hierarchy.batches = [
    { id: "02.01", stageId: "02", number: 1, name: "Batch Two" },
    { id: "01.01", stageId: "01", number: 1, name: "Batch One" },
  ]
  state.hierarchy.threads = [
    { id: "02.01.01", stageId: "02", batchId: "02.01", number: 1, name: "Thread Two" },
    { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Thread One" },
  ]
  state.hierarchy.tasks = [
    {
      id: "01.01.01.02",
      stageId: "01",
      batchId: "01.01",
      threadId: "01.01.01",
      number: 2,
      name: "Second task",
      status: "pending",
      createdAt: "2026-04-19T01:00:00.000Z",
      updatedAt: "2026-04-19T01:00:00.000Z",
      assignedAgent: "agent-two",
    },
    {
      id: "01.01.01.01",
      stageId: "01",
      batchId: "01.01",
      threadId: "01.01.01",
      number: 1,
      name: "First task",
      status: "pending",
      createdAt: "2026-04-19T00:59:00.000Z",
      updatedAt: "2026-04-19T00:59:00.000Z",
      assignedAgent: "agent-one",
    },
  ]
  state.supervision = buildSupervisionState()

  return state
}

describe("structured storage adapter contract helpers", () => {
  test("maps workstream catalog records without embedding approval state", () => {
    const stream = buildStreamMetadata()

    const record = createStructuredStorageWorkstreamRecord(stream)
    const rebuilt = createStreamMetadataFromStructuredStorageRecord({
      record,
      approval: stream.approval,
    })

    expect(record.storageRoot).toBe(stream.path)
    expect(record.manualStatus).toBe(stream.status)
    expect((record as { approval?: unknown }).approval).toBeUndefined()
    expect(rebuilt).toEqual(stream)
  })

  test("round-trips approval metadata through scope-keyed approval records", () => {
    const stream = buildStreamMetadata()

    const records = approvalMetadataToStructuredApprovalRecords(stream.id, stream.approval)
    const rebuilt = structuredApprovalRecordsToApprovalMetadata(records)

    expect(records.map((record) => `${record.scope}:${record.stageId ?? ""}`)).toEqual([
      "plan:",
      "tasks:",
      "stage:02",
    ])
    expect(rebuilt).toEqual(stream.approval)
  })

  test("normalizes stage approval ids and current batch pointers before persistence-facing conversion", () => {
    const stream = buildStreamMetadata()
    const record = createStructuredStorageWorkstreamRecord({
      ...stream,
      current_batch: "2.1",
    })

    expect(record.currentBatch).toBe("02.01")
    expect(
      createStreamMetadataFromStructuredStorageRecord({
        record: {
          ...record,
          currentBatch: "2.1",
        },
      }).current_batch,
    ).toBe("02.01")

    const state = createEmptyStructuredStorageWorkstreamState(stream.id)
    replaceStructuredApprovals(state, [
      {
        streamId: stream.id,
        scope: "stage",
        stageId: "Stage 2: Runtime hardening",
        status: "approved",
        approvedAt: "2026-04-19T00:20:00.000Z",
      },
    ])

    expect(state.approvals).toEqual([
      expect.objectContaining({
        scope: "stage",
        stageId: "02",
      }),
    ])
  })

  test("applies targeted task, thread-runtime, batch-run, and approval mutations", () => {
    const state = buildWorkstreamState()

    const updatedTask = updateStructuredTask(state, {
      taskId: "01.01.01.01",
      status: "completed",
      report: "Finished.",
      breadcrumb: "done",
      assignedAgent: "agent-updated",
      updatedAt: "2026-04-19T02:00:00.000Z",
    })

    upsertStructuredThreadRuntime(state, {
      threadId: "01.01.01",
      currentSessionId: "session-1",
      opencodeSessionId: "opencode-1",
      sessions: [
        {
          sessionId: "session-1",
          agentName: "agent-updated",
          model: "model-a",
          startedAt: "2026-04-19T02:00:00.000Z",
          status: "running",
        },
      ],
    })
    upsertStructuredThreadRuntime(state, {
      threadId: "02.01.01",
      sessions: [],
    })

    upsertStructuredBatchRun(state, buildBatchRun("02.01", "run-02"))
    upsertStructuredBatchRun(state, buildBatchRun("01.01", "run-01"))
    replaceStructuredApprovals(
      state,
      approvalMetadataToStructuredApprovalRecords("001-storage-contract", buildStreamMetadata().approval),
    )

    expect(updatedTask).toMatchObject({
      id: "01.01.01.01",
      status: "completed",
      report: "Finished.",
      breadcrumb: "done",
      assignedAgent: "agent-updated",
      updatedAt: "2026-04-19T02:00:00.000Z",
    })
    expect(state.hierarchy.tasks[0]?.id).toBe("01.01.01.02")
    expect(state.threadRuntime.map((record) => record.threadId)).toEqual([
      "01.01.01",
      "02.01.01",
    ])
    expect(state.batchRuns.map((run) => run.batchId)).toEqual(["01.01", "02.01"])
    expect(state.approvals.map((record) => record.scope)).toEqual(["plan", "tasks", "stage"])
  })

  test("normalizes unambiguous thread runtime ids before upsert replacement", () => {
    const state = buildWorkstreamState()

    upsertStructuredThreadRuntime(state, {
      threadId: "01.01.01",
      sessions: [],
      currentSessionId: "canonical-session",
    })

    upsertStructuredThreadRuntime(state, {
      threadId: "1.1.1",
      sessions: [],
      currentSessionId: "raw-session",
    })

    expect(state.threadRuntime).toHaveLength(1)
    expect(state.threadRuntime[0]).toMatchObject({
      threadId: "01.01.01",
      currentSessionId: "raw-session",
    })
  })

  test("normalizes unambiguous batch runtime ids before upsert replacement", () => {
    const state = buildWorkstreamState()

    upsertStructuredBatchRun(state, buildBatchRun("01.01", "run-01"))
    upsertStructuredBatchRun(state, {
      ...buildBatchRun("1.1", "run-01"),
      threads: [
        {
          threadId: "1.1.1",
          threadName: "Thread 1",
          firstTaskId: "1.1.1.1",
          status: "running",
          updatedAt: "2026-04-19T02:05:00.000Z",
        },
      ],
    })

    expect(state.batchRuns).toHaveLength(1)
    expect(state.batchRuns[0]).toMatchObject({
      batchId: "01.01",
      runId: "run-01",
      threads: [
        expect.objectContaining({
          threadId: "01.01.01",
          firstTaskId: "01.01.01.01",
        }),
      ],
    })
  })

  test("builds deterministically ordered parity snapshots", () => {
    const workspace: StructuredStorageWorkspaceState = {
      currentStreamId: "001-storage-contract",
      workstreams: [
        {
          id: "002-second",
          name: "second",
          order: 2,
          size: "short",
          createdAt: "2026-04-19T00:00:00.000Z",
          updatedAt: "2026-04-19T00:00:00.000Z",
          storageRoot: "work/002-second",
          generatedBy: { workstreams: "0.6.2" },
          sessionEstimated: {
            length: 1,
            unit: "session",
            session_minutes: [30, 45],
            session_iterations: [4, 8],
          },
        },
        createStructuredStorageWorkstreamRecord(buildStreamMetadata()),
      ],
    }

    const state = buildWorkstreamState()
    state.approvals = approvalMetadataToStructuredApprovalRecords(
      state.streamId,
      buildStreamMetadata().approval,
    )
    state.threadRuntime = [
      {
        threadId: "02.01.01",
        sessions: [
          {
            sessionId: "session-2",
            agentName: "agent-b",
            model: "model-b",
            startedAt: "2026-04-19T03:00:00.000Z",
            status: "running",
          },
          {
            sessionId: "session-1",
            agentName: "agent-a",
            model: "model-a",
            startedAt: "2026-04-19T02:00:00.000Z",
            status: "completed",
          },
        ],
      },
      {
        threadId: "01.01.01",
        sessions: [],
      },
    ]
    state.batchRuns = [buildBatchRun("02.01", "run-02"), buildBatchRun("01.01", "run-01")]

    const snapshot = createStructuredStorageParitySnapshot({
      workspace,
      workstream: state,
    })

    expect(snapshot.workspace.workstreams.map((record) => record.id)).toEqual([
      "001-storage-contract",
      "002-second",
    ])
    expect(snapshot.workstream?.hierarchy.stages.map((stage) => stage.id)).toEqual(["01", "02"])
    expect(snapshot.workstream?.hierarchy.tasks.map((task) => task.id)).toEqual([
      "01.01.01.01",
      "01.01.01.02",
    ])
    expect(snapshot.workstream?.threadRuntime.map((record) => record.threadId)).toEqual([
      "01.01.01",
      "02.01.01",
    ])
    expect(snapshot.workstream?.threadRuntime[1]?.sessions.map((session) => session.sessionId)).toEqual([
      "session-1",
      "session-2",
    ])
    expect(snapshot.workstream?.batchRuns.map((run) => run.batchId)).toEqual(["01.01", "02.01"])
    expect(snapshot.workstream?.batchRuns[1]?.threads.map((thread) => thread.threadId)).toEqual([
      "02.01.01",
      "02.01.02",
    ])
    expect(snapshot.workstream?.supervision.runs.map((run) => run.runId)).toEqual(["run-1", "run-2"])
    expect(snapshot.workstream?.supervision.reviewed_batches[1]?.threadIds).toEqual([
      "02.01.01",
      "02.01.02",
    ])
    expect(snapshot.workstream?.supervision.fix_cycles[1]?.issueSummaryIds).toEqual([
      "issue-1",
      "issue-2",
    ])
  })
})
