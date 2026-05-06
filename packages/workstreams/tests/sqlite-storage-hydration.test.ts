import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

import { createBatchStatusFile } from "../src/lib/batch-status"
import {
  hydrateLegacyFilesystemStateToSqliteSync,
} from "../src/lib/storage-adapter"
import { createEmptySupervisorState } from "../src/lib/supervisor-state"
import {
  loadSqliteStructuredStorageWorkspaceState,
  loadSqliteStructuredStorageWorkstreamState,
} from "../src/lib/sqlite-storage"
import { saveIndex } from "../src/lib/index"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers"

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function saveLegacyIndex(repoRoot: string, streamId: string, currentStreamId: string): void {
  const now = new Date().toISOString()

  saveIndex(repoRoot, {
    version: "1.0.0",
    last_updated: now,
    current_stream: currentStreamId,
    streams: [
      {
        id: streamId,
        name: "legacy-hydration",
        order: 1,
        size: "short",
        session_estimated: {
          length: 2,
          unit: "session",
          session_minutes: [30, 45],
          session_iterations: [4, 8],
        },
        created_at: now,
        updated_at: now,
        path: `work/${streamId}`,
        generated_by: { workstreams: "test" },
        approval: {
          status: "approved",
          approved_at: now,
          approved_by: "test",
          plan_hash: "plan-hash",
          tasks: {
            status: "approved",
            approved_at: now,
            task_count: 2,
          },
          stages: {
            2: {
              status: "approved",
              approved_at: now,
              approved_by: "test",
              commit_sha: "abc123",
            },
          },
        },
      },
    ],
  })
}

describe("sqlite legacy hydration", () => {
  test("hydrates legacy filesystem state into sqlite idempotently without re-projecting batch-status compatibility files", () => {
    const workspace = createTestWorkstream(`001-legacy-hydration-${Date.now()}`)

    try {
      saveLegacyIndex(workspace.repoRoot, workspace.streamId, workspace.streamId)

      writeJson(join(workspace.workDir, "tasks.json"), {
        version: "2.0.0",
        stream_id: workspace.streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Bootstrap sqlite state",
            thread_name: "Hydration thread",
            batch_name: "Import legacy state",
            stage_name: "Bootstrap",
            status: "completed",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:10:00.000Z",
          },
          {
            id: "02.01.01.01",
            name: "Project compatibility files",
            thread_name: "Compatibility thread",
            batch_name: "Revision import",
            stage_name: "Revision stage",
            status: "pending",
            created_at: "2026-01-02T00:00:00.000Z",
            updated_at: "2026-01-02T00:05:00.000Z",
          },
        ],
      })

      writeJson(join(workspace.workDir, "threads.json"), {
        version: "1.0.0",
        stream_id: workspace.streamId,
        last_updated: new Date().toISOString(),
        threads: [
          {
            threadId: "01.01.01",
            currentSessionId: "session-1",
            opencodeSessionId: "opencode-1",
            sessions: [
              {
                sessionId: "session-1",
                agentName: "systems-engineer",
                model: "gpt-test",
                startedAt: "2026-01-01T00:01:00.000Z",
                completedAt: "2026-01-01T00:09:00.000Z",
                status: "completed",
              },
            ],
          },
        ],
      })

      const supervisorState = createEmptySupervisorState(workspace.streamId)
      supervisorState.active_run_id = "sup-1"
      supervisorState.runs.push({
        runId: "sup-1",
        stageId: "02",
        status: "running",
        startedAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:04:00.000Z",
        reviewPasses: 1,
        issueSummaryIds: [],
        escalationIds: [],
      })
      writeJson(join(workspace.workDir, "supervisor-state.json"), supervisorState)

      mkdirSync(join(workspace.workDir, "batch-status"), { recursive: true })
      const batchStatus = createBatchStatusFile({
        streamId: workspace.streamId,
        batchId: "02.01",
        stageName: "Revision stage",
        batchName: "Revision import",
        threads: [
          {
            threadId: "02.01.01",
            threadName: "Compatibility thread",
            firstTaskId: "02.01.01.01",
          },
        ],
      })
      batchStatus.status = "running"
      writeJson(join(workspace.workDir, "batch-status", "02.01.json"), batchStatus)

      const firstHydration = hydrateLegacyFilesystemStateToSqliteSync({
        repoRoot: workspace.repoRoot,
      })
      expect(firstHydration.hydratedStreamIds).toEqual([workspace.streamId])
      expect(firstHydration.projectedStreamIds).toEqual([workspace.streamId])
      expect(firstHydration.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "legacy-runtime-merged",
      )

      const sqliteWorkspace = loadSqliteStructuredStorageWorkspaceState(workspace.repoRoot)
      expect(sqliteWorkspace?.currentStreamId).toBe(workspace.streamId)

      const sqliteState = loadSqliteStructuredStorageWorkstreamState(workspace.repoRoot, workspace.streamId)
      expect(sqliteState?.hierarchy.tasks.map((task) => task.id)).toEqual([
        "01.01.01.01",
        "02.01.01.01",
      ])
      expect(
        sqliteState?.approvals.find((approval) => approval.scope === "stage" && approval.stageId === "02")
          ?.commitSha,
      ).toBe("abc123")
      expect(sqliteState?.threadRuntime.find((runtime) => runtime.threadId === "01.01.01")?.sessions).toHaveLength(1)
      expect(
        sqliteState?.threadRuntime.find((runtime) => runtime.threadId === "01.01.01")?.sessions[0]?.sessionId,
      ).toBe("session-1")
      expect(sqliteState?.batchRuns[0]?.batchId).toBe("02.01")
      expect(sqliteState?.supervision.active_run_id).toBe("sup-1")

      const legacyThreads = JSON.parse(readFileSync(join(workspace.workDir, "threads.json"), "utf-8")) as {
        threads: Array<{ threadId: string; sessions: Array<{ sessionId: string }> }>
      }
      expect(legacyThreads.threads[0]?.threadId).toBe("01.01.01")
      expect(legacyThreads.threads[0]?.sessions[0]?.sessionId).toBe("session-1")
      expect(existsSync(join(workspace.workDir, "supervisor-state.json"))).toBeTrue()
      expect(existsSync(join(workspace.workDir, "batch-status", "02.01.json"))).toBeTrue()

      const secondHydration = hydrateLegacyFilesystemStateToSqliteSync({
        repoRoot: workspace.repoRoot,
      })
      expect(secondHydration.hydratedStreamIds).toEqual([workspace.streamId])

      const sqliteStateAfterSecondHydration = loadSqliteStructuredStorageWorkstreamState(
        workspace.repoRoot,
        workspace.streamId,
      )
      expect(sqliteStateAfterSecondHydration).toEqual(sqliteState)
      expect(JSON.parse(readFileSync(join(workspace.workDir, "threads.json"), "utf-8"))).toMatchObject({
        threads: [{ threadId: "01.01.01", sessions: [{ sessionId: "session-1" }] }],
      })

      expect(JSON.parse(readFileSync(join(workspace.workDir, "batch-status", "02.01.json"), "utf-8"))).toMatchObject({
        status: "running",
        runId: batchStatus.runId,
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("returns clear diagnostics for incomplete legacy state while preserving inferred runtime rows", () => {
    const workspace = createTestWorkstream(`001-legacy-hydration-diag-${Date.now()}`)

    try {
      saveLegacyIndex(workspace.repoRoot, workspace.streamId, "999-missing-stream")

      writeJson(join(workspace.workDir, "tasks.json"), {
        version: "2.0.0",
        stream_id: workspace.streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Existing task",
            thread_name: "Declared thread",
            batch_name: "Declared batch",
            stage_name: "Declared stage",
            status: "pending",
            created_at: "2026-02-01T00:00:00.000Z",
            updated_at: "2026-02-01T00:00:00.000Z",
          },
        ],
      })

      writeJson(join(workspace.workDir, "threads.json"), {
        version: "1.0.0",
        stream_id: workspace.streamId,
        last_updated: new Date().toISOString(),
        threads: [
          {
            threadId: "03.01.07",
            sessions: [
              {
                sessionId: "legacy-thread-session",
                agentName: "systems-engineer",
                model: "gpt-test",
                startedAt: "2026-02-02T00:00:00.000Z",
                status: "running",
              },
            ],
          },
        ],
      })

      const supervisorState = createEmptySupervisorState(workspace.streamId)
      supervisorState.active_run_id = "legacy-supervision"
      supervisorState.runs.push({
        runId: "legacy-supervision",
        stageId: "03",
        status: "running",
        startedAt: "2026-02-02T00:00:00.000Z",
        updatedAt: "2026-02-02T00:05:00.000Z",
        reviewPasses: 0,
        issueSummaryIds: [],
        escalationIds: [],
        currentBatchId: "03.01",
      })
      writeJson(join(workspace.workDir, "supervisor-state.json"), supervisorState)

      mkdirSync(join(workspace.workDir, "batch-status"), { recursive: true })
      const batchStatus = createBatchStatusFile({
        streamId: workspace.streamId,
        batchId: "03.01",
        stageName: "Inferred stage",
        batchName: "Inferred batch",
        threads: [
          {
            threadId: "03.01.07",
            threadName: "Inferred thread",
            firstTaskId: "03.01.07.01",
          },
        ],
      })
      batchStatus.status = "running"
      writeJson(join(workspace.workDir, "batch-status", "03.01.json"), batchStatus)

      const hydration = hydrateLegacyFilesystemStateToSqliteSync({
        repoRoot: workspace.repoRoot,
      })

      expect(hydration.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
        expect.arrayContaining([
          "workspace-current-stream-missing",
          "legacy-runtime-merged",
          "missing-stage-hierarchy",
          "missing-batch-hierarchy",
          "missing-thread-hierarchy",
          "missing-task-hierarchy",
        ]),
      )

      const sqliteState = loadSqliteStructuredStorageWorkstreamState(workspace.repoRoot, workspace.streamId)
      expect(sqliteState?.hierarchy.threads.map((thread) => thread.id)).toEqual(
        expect.arrayContaining(["03.01.07"]),
      )
      expect(sqliteState?.hierarchy.tasks.map((task) => task.id)).toEqual(
        expect.arrayContaining(["01.01.01.01", "03.01.07.01"]),
      )
      expect(sqliteState?.batchRuns[0]?.threads[0]?.firstTaskId).toBe("03.01.07.01")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("hydrates orphan legacy workstream directories that are missing from index.json", () => {
    const workspace = createTestWorkstream(`001-orphan-hydration-${Date.now()}`)

    try {
      writeJson(join(workspace.workDir, "tasks.json"), {
        version: "2.0.0",
        stream_id: workspace.streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Hydrate orphaned tasks",
            thread_name: "Hydration thread",
            batch_name: "Hydration batch",
            stage_name: "Hydration stage",
            status: "pending",
            created_at: "2026-03-01T00:00:00.000Z",
            updated_at: "2026-03-01T00:00:00.000Z",
          },
        ],
      })

      const hydration = hydrateLegacyFilesystemStateToSqliteSync({
        repoRoot: workspace.repoRoot,
      })

      expect(hydration.workspaceState.workstreams.map((stream) => stream.id)).toEqual([
        workspace.streamId,
      ])
      expect(hydration.hydratedStreamIds).toEqual([workspace.streamId])
      expect(hydration.projectedStreamIds).toEqual([workspace.streamId])
      expect(hydration.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "workstream-missing-from-index",
      )

      const sqliteWorkspace = loadSqliteStructuredStorageWorkspaceState(workspace.repoRoot)
      expect(sqliteWorkspace?.workstreams.map((stream) => stream.id)).toEqual([workspace.streamId])

      const sqliteState = loadSqliteStructuredStorageWorkstreamState(workspace.repoRoot, workspace.streamId)
      expect(sqliteState?.hierarchy.tasks.map((task) => task.id)).toEqual(["01.01.01.01"])
      expect(existsSync(join(workspace.workDir, "threads.json"))).toBeFalse()
      expect(existsSync(join(workspace.workDir, "supervisor-state.json"))).toBeTrue()
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("can hydrate into sqlite without projecting legacy runtime compatibility artifacts", () => {
    const workspace = createTestWorkstream(`001-no-legacy-runtime-projection-${Date.now()}`)

    try {
      saveLegacyIndex(workspace.repoRoot, workspace.streamId, workspace.streamId)

      writeJson(join(workspace.workDir, "tasks.json"), {
        version: "2.0.0",
        stream_id: workspace.streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Hydrate sqlite without projections",
            thread_name: "Hydration thread",
            batch_name: "Hydration batch",
            stage_name: "Hydration stage",
            status: "pending",
            created_at: "2026-03-02T00:00:00.000Z",
            updated_at: "2026-03-02T00:00:00.000Z",
          },
        ],
      })

      const hydration = hydrateLegacyFilesystemStateToSqliteSync({
        repoRoot: workspace.repoRoot,
        projectLegacyRuntimeCompatibilityArtifacts: false,
      })

      expect(hydration.hydratedStreamIds).toEqual([workspace.streamId])
      expect(hydration.projectedStreamIds).toEqual([])

      const sqliteState = loadSqliteStructuredStorageWorkstreamState(workspace.repoRoot, workspace.streamId)
      expect(sqliteState?.hierarchy.tasks.map((task) => task.id)).toEqual(["01.01.01.01"])
      expect(existsSync(join(workspace.workDir, "threads.json"))).toBeFalse()
      expect(existsSync(join(workspace.workDir, "supervisor-state.json"))).toBeFalse()
      expect(existsSync(join(workspace.workDir, "batch-status"))).toBeFalse()
      expect(existsSync(join(workspace.workDir, "tasks.json"))).toBeTrue()
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
