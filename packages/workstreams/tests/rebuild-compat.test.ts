import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { main as rebuildCompatMain } from "../src/cli/rebuild-compat.ts"
import {
  syncStructuredStorageWorkspaceStateToSqlite,
  syncStructuredStorageWorkstreamStateToSqlite,
} from "../src/lib/sqlite-storage.ts"
import type {
  StructuredStorageWorkspaceState,
  StructuredStorageWorkstreamState,
} from "../src/lib/structured-storage.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers"

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"))
}

describe("rebuild-compat CLI", () => {
  test("writes deterministic compatibility projections to an alternate output root", () => {
    const workspace = createTestWorkstream(`001-rebuild-compat-${Date.now()}`)
    const outputRoot = mkdtempSync(join(tmpdir(), "rebuild-compat-"))

    const workspaceState: StructuredStorageWorkspaceState = {
      currentStreamId: workspace.streamId,
      workstreams: [
        {
          id: workspace.streamId,
          name: "sqlite-parity",
          order: 1,
          size: "medium",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:01:00.000Z",
          storageRoot: `work/${workspace.streamId}`,
          generatedBy: { workstreams: "0.0.0-test" },
          sessionEstimated: {
            length: 2,
            unit: "session",
            session_minutes: [30, 45],
            session_iterations: [4, 8],
          },
        },
      ],
    }
    const workstreamState: StructuredStorageWorkstreamState = {
      streamId: workspace.streamId,
      hierarchy: {
        stages: [{ id: "01", number: 1, name: "Deliver parity tooling" }],
        batches: [{ id: "01.01", stageId: "01", number: 1, name: "Projection tooling" }],
        threads: [{ id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Compatibility rebuild" }],
        tasks: [
          {
            id: "01.01.01.01",
            stageId: "01",
            batchId: "01.01",
            threadId: "01.01.01",
            number: 1,
            name: "Project index.json",
            status: "completed",
            createdAt: "2026-04-20T00:01:00.000Z",
            updatedAt: "2026-04-20T00:02:00.000Z",
            report: "Projected workspace compatibility files.",
          },
          {
            id: "01.01.01.02",
            stageId: "01",
            batchId: "01.01",
            threadId: "01.01.01",
            number: 2,
            name: "Project tasks.json",
            status: "in_progress",
            createdAt: "2026-04-20T00:03:00.000Z",
            updatedAt: "2026-04-20T00:04:00.000Z",
            assignedAgent: "systems-engineer",
          },
        ],
      },
      approvals: [
        {
          streamId: workspace.streamId,
          scope: "plan",
          status: "approved",
          approvedAt: "2026-04-20T00:08:00.000Z",
          approvedBy: "tester",
          planHash: "plan-hash",
        },
        {
          streamId: workspace.streamId,
          scope: "tasks",
          status: "approved",
          approvedAt: "2026-04-20T00:08:00.000Z",
          taskCount: 2,
        },
      ],
      threadRuntime: [
        {
          threadId: "01.01.01",
          currentSessionId: "session-1",
          opencodeSessionId: "opencode-1",
          sessions: [
            {
              sessionId: "session-1",
              agentName: "systems-engineer",
              model: "gpt-test",
              startedAt: "2026-04-20T00:03:00.000Z",
              completedAt: "2026-04-20T00:04:00.000Z",
              status: "completed",
            },
          ],
        },
      ],
      batchRuns: [
        {
          version: "1.0.0",
          streamId: workspace.streamId,
          batchId: "01.01",
          runId: "run-1",
          mode: "headless",
          status: "running",
          stageName: "Deliver parity tooling",
          batchName: "Projection tooling",
          startedAt: "2026-04-20T00:05:00.000Z",
          updatedAt: "2026-04-20T00:06:00.000Z",
          summary: {
            total: 1,
            pending: 0,
            running: 1,
            completed: 0,
            failed: 0,
          },
          threads: [
            {
              threadId: "01.01.01",
              threadName: "Compatibility rebuild",
              firstTaskId: "01.01.01.01",
              status: "running",
              startedAt: "2026-04-20T00:05:00.000Z",
              updatedAt: "2026-04-20T00:06:00.000Z",
              currentSessionId: "session-1",
              opencodeSessionId: "opencode-1",
            },
          ],
        },
      ],
      supervision: {
        version: "1.0.0",
        stream_id: workspace.streamId,
        last_updated: "2026-04-20T00:07:00.000Z",
        active_run_id: "sup-1",
        current_branch_supervision: {
          owner: "root_agent",
          branchSessionId: "branch-1",
          branchRole: "supervision",
          rootSessionId: "root-1",
          nativeSessionId: "native-1",
          source: "native_fork",
          updatedAt: "2026-04-20T00:07:00.000Z",
          scope: { level: "stage", stageId: "01" },
          supervisionProgress: {
            executionMode: "stage_batch_loop",
            currentBatchId: "01.01",
          },
        },
        runs: [
          {
            runId: "sup-1",
            stageId: "01",
            status: "running",
            startedAt: "2026-04-20T00:06:30.000Z",
            updatedAt: "2026-04-20T00:07:00.000Z",
            reviewPasses: 1,
            issueSummaryIds: [],
            escalationIds: [],
            branchSessionId: "branch-1",
            rootSessionId: "root-1",
            currentBatchId: "01.01",
          },
        ],
        checkpoint_pointers: [],
        branch_sessions: [
          {
            owner: "root_agent",
            rootSessionId: "root-1",
            branchSessionId: "branch-1",
            branchRole: "supervision",
            source: "native_fork",
            status: "running",
            startedAt: "2026-04-20T00:06:15.000Z",
            updatedAt: "2026-04-20T00:07:00.000Z",
            scope: { level: "stage", stageId: "01" },
          },
        ],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      },
    }

    try {
      syncStructuredStorageWorkspaceStateToSqlite(workspace.repoRoot, workspaceState)
      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, workstreamState)

      rebuildCompatMain([
        "bun",
        "work",
        "rebuild-compat",
        "--repo-root",
        workspace.repoRoot,
        "--output-root",
        outputRoot,
      ])

      const indexPath = join(outputRoot, "work", "index.json")
      const tasksPath = join(outputRoot, "work", workspace.streamId, "tasks.json")
      const firstIndex = readFileSync(indexPath, "utf-8")
      const firstTasks = readFileSync(tasksPath, "utf-8")

      rebuildCompatMain([
        "bun",
        "work",
        "rebuild-compat",
        "--repo-root",
        workspace.repoRoot,
        "--output-root",
        outputRoot,
      ])

      expect(readFileSync(indexPath, "utf-8")).toBe(firstIndex)
      expect(readFileSync(tasksPath, "utf-8")).toBe(firstTasks)

      expect(readJson(indexPath)).toEqual({
        version: "1.0.0",
        last_updated: "2026-04-20T00:08:00.000Z",
        current_stream: workspace.streamId,
        streams: [
          {
            id: workspace.streamId,
            name: "sqlite-parity",
            order: 1,
            approval: {
              status: "approved",
              approved_at: "2026-04-20T00:08:00.000Z",
              approved_by: "tester",
              plan_hash: "plan-hash",
              tasks: {
                status: "approved",
                approved_at: "2026-04-20T00:08:00.000Z",
                task_count: 2,
              },
            },
            size: "medium",
            session_estimated: {
              length: 2,
              unit: "session",
              session_minutes: [30, 45],
              session_iterations: [4, 8],
            },
            created_at: "2026-04-20T00:00:00.000Z",
            updated_at: "2026-04-20T00:01:00.000Z",
            path: `work/${workspace.streamId}`,
            generated_by: { workstreams: "0.0.0-test" },
          },
        ],
      })

      expect(readJson(tasksPath)).toEqual({
        version: "2.0.0",
        stream_id: workspace.streamId,
        last_updated: "2026-04-20T00:07:00.000Z",
        runtime_state: {
          version: "1.0.0",
          last_updated: "2026-04-20T00:07:00.000Z",
          threads: [
            {
              threadId: "01.01.01",
              sessions: [
                {
                  sessionId: "session-1",
                  agentName: "systems-engineer",
                  model: "gpt-test",
                  startedAt: "2026-04-20T00:03:00.000Z",
                  completedAt: "2026-04-20T00:04:00.000Z",
                  status: "completed",
                },
              ],
              currentSessionId: "session-1",
              opencodeSessionId: "opencode-1",
            },
          ],
          batches: {
            "01.01": {
              version: "1.0.0",
              streamId: workspace.streamId,
              batchId: "01.01",
              runId: "run-1",
              mode: "headless",
              status: "running",
              stageName: "Deliver parity tooling",
              batchName: "Projection tooling",
              startedAt: "2026-04-20T00:05:00.000Z",
              updatedAt: "2026-04-20T00:06:00.000Z",
              summary: {
                total: 1,
                pending: 0,
                running: 1,
                completed: 0,
                failed: 0,
              },
              threads: [
                {
                  threadId: "01.01.01",
                  threadName: "Compatibility rebuild",
                  firstTaskId: "01.01.01.01",
                  status: "running",
                  startedAt: "2026-04-20T00:05:00.000Z",
                  updatedAt: "2026-04-20T00:06:00.000Z",
                  currentSessionId: "session-1",
                  opencodeSessionId: "opencode-1",
                },
              ],
            },
          },
          supervision: {
            version: "1.0.0",
            stream_id: workspace.streamId,
            last_updated: "2026-04-20T00:07:00.000Z",
            active_run_id: "sup-1",
            current_branch_supervision: {
              owner: "root_agent",
              branchSessionId: "branch-1",
              branchRole: "supervision",
              rootSessionId: "root-1",
              nativeSessionId: "native-1",
              source: "native_fork",
              updatedAt: "2026-04-20T00:07:00.000Z",
              scope: { level: "stage", stageId: "01" },
              supervisionProgress: {
                executionMode: "stage_batch_loop",
                currentBatchId: "01.01",
              },
            },
            runs: [
              {
                runId: "sup-1",
                stageId: "01",
                status: "running",
                startedAt: "2026-04-20T00:06:30.000Z",
                updatedAt: "2026-04-20T00:07:00.000Z",
                reviewPasses: 1,
                issueSummaryIds: [],
                escalationIds: [],
                branchSessionId: "branch-1",
                rootSessionId: "root-1",
                currentBatchId: "01.01",
              },
            ],
            checkpoint_pointers: [],
            branch_sessions: [
              {
                owner: "root_agent",
                rootSessionId: "root-1",
                branchSessionId: "branch-1",
                branchRole: "supervision",
                source: "native_fork",
                status: "running",
                startedAt: "2026-04-20T00:06:15.000Z",
                updatedAt: "2026-04-20T00:07:00.000Z",
                scope: { level: "stage", stageId: "01" },
              },
            ],
            reviewed_batches: [],
            issue_summaries: [],
            fix_cycles: [],
            escalations: [],
            stage_stops: [],
          },
        },
        runtime_summary: {
          updated_at: "2026-04-20T00:07:00.000Z",
          batches: {
            "01.01": {
              batch_id: "01.01",
              run_id: "run-1",
              status: "running",
              started_at: "2026-04-20T00:05:00.000Z",
              updated_at: "2026-04-20T00:06:00.000Z",
              stage_name: "Deliver parity tooling",
              batch_name: "Projection tooling",
              thread_summary: {
                total: 1,
                pending: 0,
                running: 1,
                completed: 0,
                failed: 0,
              },
            },
          },
          supervision: {
            updated_at: "2026-04-20T00:07:00.000Z",
            active_run_id: "sup-1",
            active_run: {
              run_id: "sup-1",
              stage_id: "01",
              status: "running",
              updated_at: "2026-04-20T00:07:00.000Z",
              started_at: "2026-04-20T00:06:30.000Z",
              current_batch_id: "01.01",
              review_passes: 1,
              branch_session_id: "branch-1",
              root_session_id: "root-1",
            },
            latest_run: {
              run_id: "sup-1",
              stage_id: "01",
              status: "running",
              updated_at: "2026-04-20T00:07:00.000Z",
              started_at: "2026-04-20T00:06:30.000Z",
              current_batch_id: "01.01",
              review_passes: 1,
              branch_session_id: "branch-1",
              root_session_id: "root-1",
            },
            current_branch: {
              branch_session_id: "branch-1",
              root_session_id: "root-1",
              status: "running",
              updated_at: "2026-04-20T00:07:00.000Z",
              scope_level: "stage",
              stage_id: "01",
              execution_mode: "stage_batch_loop",
              current_batch_id: "01.01",
            },
          },
        },
        tasks: [
          {
            id: "01.01.01.01",
            name: "Project index.json",
            thread_name: "Compatibility rebuild",
            batch_name: "Projection tooling",
            stage_name: "Deliver parity tooling",
            status: "completed",
            created_at: "2026-04-20T00:01:00.000Z",
            updated_at: "2026-04-20T00:02:00.000Z",
            report: "Projected workspace compatibility files.",
          },
          {
            id: "01.01.01.02",
            name: "Project tasks.json",
            thread_name: "Compatibility rebuild",
            batch_name: "Projection tooling",
            stage_name: "Deliver parity tooling",
            status: "in_progress",
            created_at: "2026-04-20T00:03:00.000Z",
            updated_at: "2026-04-20T00:04:00.000Z",
            assigned_agent: "systems-engineer",
          },
        ],
      })

      expect(existsSync(join(outputRoot, "work", workspace.streamId, "PLAN.md"))).toBeFalse()
    } finally {
      cleanupTestWorkstream(workspace)
      rmSync(outputRoot, { recursive: true, force: true })
    }
  })

  test("writes in-place compatibility files when no alternate output root is provided", () => {
    const workspace = createTestWorkstream(`001-rebuild-compat-in-place-${Date.now()}`)

    try {
      rmSync(join(workspace.repoRoot, "work", "index.json"), { force: true })
      rmSync(join(workspace.workDir, "tasks.json"), { force: true })

      syncStructuredStorageWorkspaceStateToSqlite(workspace.repoRoot, {
        currentStreamId: workspace.streamId,
        workstreams: [
          {
            id: workspace.streamId,
            name: "sqlite-projection",
            order: 1,
            size: "short",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:01:00.000Z",
            storageRoot: `work/${workspace.streamId}`,
            generatedBy: { workstreams: "0.0.0-test" },
            sessionEstimated: {
              length: 1,
              unit: "session",
              session_minutes: [30, 45],
              session_iterations: [4, 8],
            },
          },
        ],
      })
      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, {
        streamId: workspace.streamId,
        hierarchy: {
          stages: [{ id: "01", number: 1, name: "Bootstrap" }],
          batches: [{ id: "01.01", stageId: "01", number: 1, name: "Projection" }],
          threads: [{ id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Compatibility" }],
          tasks: [
            {
              id: "01.01.01.01",
              stageId: "01",
              batchId: "01.01",
              threadId: "01.01.01",
              number: 1,
              name: "Regenerate tasks.json",
              status: "pending",
              createdAt: "2026-04-20T00:01:00.000Z",
              updatedAt: "2026-04-20T00:01:00.000Z",
            },
          ],
        },
        approvals: [],
        threadRuntime: [],
        batchRuns: [],
        supervision: {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: "2026-04-20T00:01:00.000Z",
          runs: [],
          checkpoint_pointers: [],
          branch_sessions: [],
          reviewed_batches: [],
          issue_summaries: [],
          fix_cycles: [],
          escalations: [],
          stage_stops: [],
        },
      })

      rebuildCompatMain(["bun", "work", "rebuild-compat", "--repo-root", workspace.repoRoot])

      expect(existsSync(join(workspace.repoRoot, "work", "index.json"))).toBeTrue()
      expect(existsSync(join(workspace.workDir, "tasks.json"))).toBeTrue()
      expect(readJson(join(workspace.repoRoot, "work", "index.json"))).toMatchObject({
        current_stream: workspace.streamId,
      })
      expect(readJson(join(workspace.workDir, "tasks.json"))).toMatchObject({
        stream_id: workspace.streamId,
        tasks: [
          {
            id: "01.01.01.01",
            name: "Regenerate tasks.json",
          },
        ],
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("scoped rebuild updates only the selected tasks.json without rewriting work/index.json", () => {
    const workspace = createTestWorkstream(`001-rebuild-compat-scoped-${Date.now()}`)
    const originalIndex = JSON.stringify(
      {
        version: "1.0.0",
        last_updated: "1999-01-01T00:00:00.000Z",
        current_stream: workspace.streamId,
        streams: [
          {
            id: workspace.streamId,
            name: "preexisting-index",
          },
        ],
      },
      null,
      2,
    )

    try {
      syncStructuredStorageWorkspaceStateToSqlite(workspace.repoRoot, {
        currentStreamId: workspace.streamId,
        workstreams: [
          {
            id: workspace.streamId,
            name: "scoped-rebuild",
            order: 1,
            size: "short",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:01:00.000Z",
            storageRoot: `work/${workspace.streamId}`,
            generatedBy: { workstreams: "0.0.0-test" },
            sessionEstimated: {
              length: 1,
              unit: "session",
              session_minutes: [30, 45],
              session_iterations: [4, 8],
            },
          },
        ],
      })
      syncStructuredStorageWorkstreamStateToSqlite(workspace.repoRoot, {
        streamId: workspace.streamId,
        hierarchy: {
          stages: [{ id: "01", number: 1, name: "Bootstrap" }],
          batches: [{ id: "01.01", stageId: "01", number: 1, name: "Projection" }],
          threads: [{ id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Compatibility" }],
          tasks: [
            {
              id: "01.01.01.01",
              stageId: "01",
              batchId: "01.01",
              threadId: "01.01.01",
              number: 1,
              name: "Regenerate scoped tasks.json",
              status: "completed",
              createdAt: "2026-04-20T00:01:00.000Z",
              updatedAt: "2026-04-20T00:02:00.000Z",
            },
          ],
        },
        approvals: [],
        threadRuntime: [],
        batchRuns: [],
        supervision: {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: "2026-04-20T00:02:00.000Z",
          runs: [],
          checkpoint_pointers: [],
          branch_sessions: [],
          reviewed_batches: [],
          issue_summaries: [],
          fix_cycles: [],
          escalations: [],
          stage_stops: [],
        },
      })

      rmSync(join(workspace.workDir, "tasks.json"), { force: true })
      rmSync(join(workspace.repoRoot, "work", "index.json"), { force: true })
      writeFileSync(join(workspace.repoRoot, "work", "index.json"), `${originalIndex}\n`)

      rebuildCompatMain([
        "bun",
        "work",
        "rebuild-compat",
        "--repo-root",
        workspace.repoRoot,
        "--stream",
        workspace.streamId,
      ])

      expect(readFileSync(join(workspace.repoRoot, "work", "index.json"), "utf-8")).toBe(`${originalIndex}\n`)
      expect(readJson(join(workspace.workDir, "tasks.json"))).toMatchObject({
        stream_id: workspace.streamId,
        tasks: [
          {
            id: "01.01.01.01",
            name: "Regenerate scoped tasks.json",
          },
        ],
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
