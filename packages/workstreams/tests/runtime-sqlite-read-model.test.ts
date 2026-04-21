import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"

import { readBatchStatus } from "../src/lib/batch-status.ts"
import { getWorkstreamStatusSnapshot } from "../src/lib/status.ts"
import { resolveCurrentBranchSupervisionContext } from "../src/lib/root-agent-branch.ts"
import {
  loadSqliteStructuredStorageWorkstreamState,
  syncStructuredStorageWorkstreamStateToSqlite,
} from "../src/lib/sqlite-storage.ts"
import { createEmptyStructuredStorageWorkstreamState } from "../src/lib/structured-storage.ts"
import { loadSupervisorState } from "../src/lib/supervisor-state.ts"
import type { StreamMetadata, TasksFile } from "../src/lib/types.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers/test-workspace.ts"

function writeIndex(repoRoot: string, streamId: string, name: string): void {
  mkdirSync(join(repoRoot, "work"), { recursive: true })
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
            name,
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
}

function buildBaseStream(streamId: string): StreamMetadata {
  return {
    id: streamId,
    name: streamId,
    order: 1,
    size: "short",
    session_estimated: {
      length: 1,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8],
    },
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z",
    path: `work/${streamId}`,
    generated_by: { workstreams: "test" },
  }
}

function writeStaleTasksFile(repoRoot: string, streamId: string): void {
  const now = "2026-04-20T00:00:00.000Z"
  const tasksFile: TasksFile = {
    version: "1.0.0",
    stream_id: streamId,
    last_updated: now,
    runtime_summary: {
      updated_at: now,
      batches: {
        "01.01": {
          batch_id: "01.01",
          run_id: "filesystem-run",
          status: "completed",
          updated_at: now,
          started_at: now,
          completed_at: now,
          thread_summary: {
            total: 1,
            pending: 0,
            running: 0,
            completed: 1,
            failed: 0,
          },
        },
      },
    },
    runtime_state: {
      version: "1.0.0",
      last_updated: now,
      threads: [],
      batches: {},
      supervision: {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: now,
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
        name: "Runtime-backed task",
        stage_name: "Stage 01",
        batch_name: "Batch 01",
        thread_name: "Thread 01",
        status: "pending",
        created_at: now,
        updated_at: now,
      },
    ],
  }

  writeFileSync(join(repoRoot, "work", streamId, "tasks.json"), JSON.stringify(tasksFile, null, 2))
}

function syncCanonicalSqliteState(repoRoot: string, streamId: string): void {
  const now = "2026-04-20T01:00:00.000Z"
  const state = createEmptyStructuredStorageWorkstreamState(streamId)
  state.hierarchy = {
    stages: [{ id: "01", number: 1, name: "Stage 01" }],
    batches: [{ id: "01.01", stageId: "01", number: 1, name: "Batch 01" }],
    threads: [{ id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Thread 01" }],
    tasks: [
      {
        id: "01.01.01.01",
        stageId: "01",
        batchId: "01.01",
        threadId: "01.01.01",
        number: 1,
        name: "Runtime-backed task",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      },
    ],
  }
  state.batchRuns = [
    {
      version: "1.0.0",
      streamId,
      batchId: "01.01",
      runId: "sqlite-run",
      mode: "headless",
      status: "failed",
      stageName: "Stage 01",
      batchName: "Batch 01",
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      summary: {
        total: 1,
        pending: 0,
        running: 0,
        completed: 0,
        failed: 1,
      },
      threads: [
        {
          threadId: "01.01.01",
          threadName: "Thread 01",
          firstTaskId: "01.01.01.01",
          status: "failed",
          updatedAt: now,
        },
      ],
    },
  ]
  state.supervision = {
    version: "1.0.0",
    stream_id: streamId,
    last_updated: now,
    active_run_id: "sup-run-1",
    current_branch_supervision: {
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      branchRole: "supervision",
      nativeSessionId: "ses_supervision_1",
      source: "native_fork",
      scope: { level: "stage", stageId: "01" },
      supervisionProgress: {
        executionMode: "stage_batch_loop",
        currentBatchId: "01.01",
      },
      updatedAt: now,
    },
    runs: [
      {
        runId: "sup-run-1",
        stageId: "01",
        status: "running",
        startedAt: now,
        updatedAt: now,
        currentBatchId: "01.01",
        reviewPasses: 0,
        issueSummaryIds: [],
        escalationIds: [],
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
      },
    ],
    checkpoint_pointers: [],
    branch_sessions: [
      {
        owner: "root_agent",
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        branchRole: "supervision",
        source: "native_fork",
        status: "running",
        startedAt: now,
        updatedAt: now,
        nativeSessionId: "ses_supervision_1",
        batchId: "01.01",
        scope: { level: "stage", stageId: "01" },
        supervisionProgress: {
          executionMode: "stage_batch_loop",
          currentBatchId: "01.01",
        },
      },
    ],
    reviewed_batches: [],
    issue_summaries: [],
    fix_cycles: [],
    escalations: [],
    stage_stops: [],
  }

  syncStructuredStorageWorkstreamStateToSqlite(repoRoot, state)
}

describe("runtime sqlite-backed read model", () => {
  test("normalizes malformed supervision scope stage ids before sqlite stage inference", () => {
    const workspace = createTestWorkstream("001-runtime-sqlite-stage-scope-normalization")

    try {
      writeIndex(workspace.repoRoot, workspace.streamId, workspace.streamId)

      const now = "2026-04-20T01:00:00.000Z"
      const malformedStageLabel =
        "Stage 01: Lock the canonical bet_identity contract and cutover boundary"
      const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
      state.hierarchy = {
        stages: [{ id: "01", number: 1, name: "Lock the canonical bet_identity contract and cutover boundary" }],
        batches: [{ id: "01.01", stageId: "01", number: 1, name: "Batch 01" }],
        threads: [{ id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Thread 01" }],
        tasks: [
          {
            id: "01.01.01.01",
            stageId: "01",
            batchId: "01.01",
            threadId: "01.01.01",
            number: 1,
            name: "Runtime-backed task",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
        ],
      }
      state.supervision = {
        version: "1.0.0",
        stream_id: workspace.streamId,
        last_updated: now,
        current_branch_supervision: {
          owner: "root_agent",
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-1",
          branchRole: "supervision",
          nativeSessionId: "ses_supervision_1",
          source: "native_fork",
          scope: { level: "stage", stageId: malformedStageLabel },
          updatedAt: now,
        },
        runs: [],
        checkpoint_pointers: [],
        branch_sessions: [
          {
            owner: "root_agent",
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            branchRole: "supervision",
            source: "native_fork",
            status: "running",
            startedAt: now,
            updatedAt: now,
            nativeSessionId: "ses_supervision_1",
            batchId: "01.01",
            scope: { level: "stage", stageId: malformedStageLabel },
          },
        ],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      }

      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, state)

      const sqliteState = loadSqliteStructuredStorageWorkstreamState(
        workspace.repoRoot,
        workspace.streamId,
      )
      expect(sqliteState?.hierarchy.stages.map((stage) => stage.id)).toEqual(["01"])
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)).toMatchObject({
        current_branch_supervision: {
          scope: { level: "stage", stageId: "01" },
        },
        branch_sessions: [
          {
            scope: { level: "stage", stageId: "01" },
          },
        ],
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("preserves raw runtime ids on sqlite raw load while normalizing default reads", () => {
    const workspace = createTestWorkstream("001-runtime-sqlite-raw-load")

    try {
      writeIndex(workspace.repoRoot, workspace.streamId, workspace.streamId)

      const now = "2026-04-20T02:00:00.000Z"
      const malformedStageLabel = "Stage 1: Runtime hardening"
      const state = createEmptyStructuredStorageWorkstreamState(workspace.streamId)
      state.hierarchy = {
        stages: [{ id: "1", number: 1, name: "Runtime hardening" }],
        batches: [{ id: "1.1", stageId: "1", number: 1, name: "Batch 1" }],
        threads: [{ id: "1.1.1", stageId: "1", batchId: "1.1", number: 1, name: "Thread 1" }],
        tasks: [
          {
            id: "1.1.1.1",
            stageId: "1",
            batchId: "1.1",
            threadId: "1.1.1",
            number: 1,
            name: "Preserve runtime ids",
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
        ],
      }
      state.threadRuntime = [
        {
          threadId: "1.1.1",
          currentSessionId: "session-1",
          sessions: [
            {
              sessionId: "session-1",
              agentName: "systems-engineer",
              model: "gpt-5.4",
              startedAt: now,
              status: "running",
              lineage: {
                owner: "root_agent",
                rootSessionId: "root-session-1",
                branchSessionId: "branch-supervision-1",
                branchRole: "supervision",
                source: "native_fork",
                scope: { level: "stage", stageId: malformedStageLabel },
              },
            },
          ],
        },
      ]
      state.batchRuns = [
        {
          version: "1.0.0",
          streamId: workspace.streamId,
          batchId: "1.1",
          runId: "run-1",
          mode: "headless",
          status: "running",
          startedAt: now,
          updatedAt: now,
          summary: {
            total: 1,
            pending: 0,
            running: 1,
            completed: 0,
            failed: 0,
          },
          threads: [
            {
              threadId: "1.1.1",
              threadName: "Thread 1",
              firstTaskId: "1.1.1.1",
              status: "running",
              startedAt: now,
              updatedAt: now,
            },
          ],
        },
      ]

      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, state)

      const normalized = loadSqliteStructuredStorageWorkstreamState(workspace.repoRoot, workspace.streamId)
      expect(normalized?.hierarchy.threads[0]).toMatchObject({
        id: "01.01.01",
        stageId: "01",
        batchId: "01.01",
      })
      expect(normalized?.threadRuntime[0]?.threadId).toBe("01.01.01")
      expect(normalized?.threadRuntime[0]?.sessions[0]?.lineage?.scope).toEqual({
        level: "stage",
        stageId: "01",
      })
      expect(normalized?.batchRuns[0]?.batchId).toBe("01.01")
      expect(normalized?.batchRuns[0]?.threads[0]).toMatchObject({
        threadId: "01.01.01",
        firstTaskId: "01.01.01.01",
      })

      const raw = loadSqliteStructuredStorageWorkstreamState(workspace.repoRoot, workspace.streamId, {
        normalizeIds: false,
      })
      expect(raw?.hierarchy.threads[0]?.id).toBe("1.1.1")
      expect(raw?.threadRuntime[0]?.threadId).toBe("1.1.1")
      expect(raw?.threadRuntime[0]?.sessions[0]?.lineage?.scope).toEqual({
        level: "stage",
        stageId: malformedStageLabel,
      })
      expect(raw?.batchRuns[0]?.batchId).toBe("1.1")
      expect(raw?.batchRuns[0]?.threads[0]).toMatchObject({
        threadId: "1.1.1",
        firstTaskId: "1.1.1.1",
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("batch-status and supervisor snapshots read sqlite-backed canonical state", () => {
    const workspace = createTestWorkstream("001-runtime-sqlite-snapshots")

    try {
      writeStaleTasksFile(workspace.repoRoot, workspace.streamId)
      syncCanonicalSqliteState(workspace.repoRoot, workspace.streamId)

      expect(readBatchStatus(workspace.repoRoot, workspace.streamId, "01.01")).toMatchObject({
        runId: "sqlite-run",
        status: "failed",
      })
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)).toMatchObject({
        active_run_id: "sup-run-1",
        current_branch_supervision: {
          branchSessionId: "branch-supervision-1",
        },
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("status snapshot derives desync/runtime entries from sqlite instead of stale filesystem runtime summary", () => {
    const workspace = createTestWorkstream("001-runtime-sqlite-status")

    try {
      writeStaleTasksFile(workspace.repoRoot, workspace.streamId)
      syncCanonicalSqliteState(workspace.repoRoot, workspace.streamId)

      const snapshot = getWorkstreamStatusSnapshot(
        workspace.repoRoot,
        buildBaseStream(workspace.streamId),
      )

      expect(snapshot.runtime?.summary.batches["01.01"]).toMatchObject({
        run_id: "sqlite-run",
        status: "failed",
      })
      expect(snapshot.runtime?.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "batch",
            batch_id: "01.01",
            runtime_status: "failed",
            entry_status: "desync",
          }),
          expect.objectContaining({
            kind: "supervision",
            target: "01.01",
          }),
        ]),
      )
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("root-agent supervision context resolves from sqlite-backed branch metadata", () => {
    const workspace = createTestWorkstream("001-runtime-sqlite-root-agent")

    try {
      writeIndex(workspace.repoRoot, workspace.streamId, workspace.streamId)
      writeStaleTasksFile(workspace.repoRoot, workspace.streamId)
      syncCanonicalSqliteState(workspace.repoRoot, workspace.streamId)

      expect(
        resolveCurrentBranchSupervisionContext({
          repoRoot: workspace.repoRoot,
          env: { SESSION_ID: "ses_supervision_1" },
        }),
      ).toMatchObject({
        streamId: workspace.streamId,
        source: "current_branch_supervision",
        current: {
          branchSessionId: "branch-supervision-1",
          supervisionProgress: {
            currentBatchId: "01.01",
          },
        },
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
