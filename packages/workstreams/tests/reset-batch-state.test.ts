import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { main as resetBatchStateMain } from "../src/cli/reset-batch-state.ts"
import { main as treeMain } from "../src/cli/tree.ts"
import { readBatchStatus } from "../src/lib/batch-status.ts"
import { syncBatchStatus } from "../src/lib/batch-monitor.ts"
import {
  getCompletionMarkerPath,
  getRunResultPath,
  getSessionFilePath,
  getSynthesisLogPath,
  getSynthesisOutputPath,
  getWorkingAgentSessionPath,
} from "../src/lib/opencode.ts"
import { buildSupervisionExecutionPlan } from "../src/lib/supervision-helper.ts"
import { loadSupervisorState } from "../src/lib/supervisor-state.ts"
import { createEmptyTasksFile, readTasksFile, writeTasksFile } from "../src/lib/tasks.ts"
import { loadThreads } from "../src/lib/threads.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"
import {
  cleanupTestWorkstream,
  createTestWorkstream,
  type TestWorkspace,
} from "./helpers/index.ts"

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

describe("reset-batch-state", () => {
  let workspace: TestWorkspace | undefined

  afterEach(() => {
    if (workspace) {
      rmSync(getCompletionMarkerPath(workspace.streamId, "03.01.01"), { force: true })
      rmSync(getSessionFilePath(workspace.streamId, "03.01.01"), { force: true })
      rmSync(getRunResultPath(workspace.streamId, "03.01.01"), { force: true })
      rmSync(getWorkingAgentSessionPath(workspace.streamId, "03.01.01"), { force: true })
      rmSync(getSynthesisOutputPath(workspace.streamId, "03.01.01"), { force: true })
      rmSync(getSynthesisLogPath(workspace.streamId, "03.01.01"), { force: true })
      cleanupTestWorkstream(workspace)
      workspace = undefined
    }
  })

  test("resets a desynced batch to a clean pending state without touching unrelated batch history", async () => {
    workspace = createTestWorkstream("001-reset-batch")
    writeIndex(workspace.repoRoot, workspace.streamId, "reset-batch")

    const now = new Date().toISOString()
    const tasksFile = createEmptyTasksFile(workspace.streamId)
    tasksFile.tasks = [
      {
        id: "03.01.01.01",
        name: "Batch 03.01 Task",
        thread_name: "Thread 1",
        batch_name: "Batch 03.01",
        stage_name: "Stage 03",
        status: "pending",
        report: "stale report",
        breadcrumb: "stale breadcrumb",
        created_at: now,
        updated_at: now,
      },
      {
        id: "03.02.01.01",
        name: "Batch 03.02 Task",
        thread_name: "Thread 1",
        batch_name: "Batch 03.02",
        stage_name: "Stage 03",
        status: "completed",
        report: "keep me",
        created_at: now,
        updated_at: now,
      },
    ]
    tasksFile.runtime_state = {
      version: "1.0.0",
      last_updated: now,
      threads: [
        {
          threadId: "03.01.01",
          promptPath: "prompts/03-stage/01-batch/thread-01.md",
          currentSessionId: "stale-current-03-01",
          opencodeSessionId: "stale-outer-03-01",
          workingAgentSessionId: "stale-working-03-01",
          synthesisOutput: "stale synthesis",
          synthesis: {
            sessionId: "stale-synthesis-session",
            output: "stale synthesis output",
            completedAt: now,
          },
          sessions: [
            {
              sessionId: "stale-session-03-01",
              agentName: "default",
              model: "openai/gpt-5.4",
              startedAt: now,
              completedAt: now,
              status: "failed",
              exitCode: 1,
            },
          ],
        },
        {
          threadId: "03.02.01",
          promptPath: "prompts/03-stage/02-batch/thread-01.md",
          currentSessionId: "keep-current-03-02",
          sessions: [
            {
              sessionId: "keep-session-03-02",
              agentName: "default",
              model: "openai/gpt-5.4",
              startedAt: now,
              status: "running",
            },
          ],
        },
      ],
      batches: {
        "03.01": {
          version: "1.0.0",
          streamId: workspace.streamId,
          batchId: "03.01",
          runId: "batch-run-03-01",
          mode: "headless",
          status: "failed",
          stageName: "Stage 03",
          batchName: "Batch 03.01",
          startedAt: now,
          updatedAt: now,
          completedAt: now,
          summary: { total: 1, pending: 0, running: 0, completed: 0, failed: 1 },
          threads: [
            {
              threadId: "03.01.01",
              threadName: "Thread 1",
              firstTaskId: "03.01.01.01",
              status: "failed",
              updatedAt: now,
              completedAt: now,
              currentSessionId: "stale-current-03-01",
            },
          ],
        },
        "03.02": {
          version: "1.0.0",
          streamId: workspace.streamId,
          batchId: "03.02",
          runId: "batch-run-03-02",
          mode: "headless",
          status: "completed",
          stageName: "Stage 03",
          batchName: "Batch 03.02",
          startedAt: now,
          updatedAt: now,
          completedAt: now,
          summary: { total: 1, pending: 0, running: 0, completed: 1, failed: 0 },
          threads: [
            {
              threadId: "03.02.01",
              threadName: "Thread 1",
              firstTaskId: "03.02.01.01",
              status: "completed",
              updatedAt: now,
              completedAt: now,
            },
          ],
        },
      },
      supervision: {
        version: "1.0.0",
        stream_id: workspace.streamId,
        last_updated: now,
        active_run_id: "sup-run-03-01",
        current_branch_supervision: {
          owner: "root_agent",
          rootSessionId: "root-1",
          branchSessionId: "branch-03-01",
          branchRole: "supervision",
          nativeSessionId: "native-1",
          source: "repo_local_fallback",
          updatedAt: now,
          scope: { level: "batch", stageId: "03", batchId: "03.01" },
          supervisionProgress: {
            executionMode: "single_batch_run",
            currentBatchId: "03.01",
          },
        },
        runs: [
          {
            runId: "sup-run-03-01",
            stageId: "03",
            status: "stopped",
            startedAt: now,
            updatedAt: now,
            currentBatchId: "03.01",
            lastReviewedBatchId: "03.01",
            reviewPasses: 1,
            issueSummaryIds: ["issue-03-01"],
            escalationIds: ["esc-03-01"],
            branchSessionId: "branch-03-01",
            stageStopId: "stop-03-01",
            stopReason: "failed",
          },
          {
            runId: "sup-run-03-02",
            stageId: "03",
            status: "completed",
            startedAt: now,
            updatedAt: now,
            currentBatchId: "03.02",
            lastReviewedBatchId: "03.02",
            reviewPasses: 1,
            issueSummaryIds: [],
            escalationIds: [],
          },
        ],
        checkpoint_pointers: [],
        branch_sessions: [
          {
            owner: "root_agent",
            rootSessionId: "root-1",
            branchSessionId: "branch-03-01",
            branchRole: "supervision",
            source: "repo_local_fallback",
            nativeSessionId: "native-1",
            status: "stopped",
            startedAt: now,
            updatedAt: now,
            batchId: "03.01",
            runId: "sup-run-03-01",
            supervisionProgress: {
              executionMode: "single_batch_run",
              currentBatchId: "03.01",
            },
            scope: { level: "batch", stageId: "03", batchId: "03.01" },
          },
          {
            owner: "root_agent",
            rootSessionId: "root-2",
            branchSessionId: "branch-03-02",
            branchRole: "supervision",
            source: "repo_local_fallback",
            nativeSessionId: "native-2",
            status: "completed",
            startedAt: now,
            updatedAt: now,
            batchId: "03.02",
            runId: "sup-run-03-02",
            supervisionProgress: {
              executionMode: "single_batch_run",
              currentBatchId: "03.02",
            },
            scope: { level: "batch", stageId: "03", batchId: "03.02" },
          },
        ],
        reviewed_batches: [
          {
            reviewId: "review-03-01",
            runId: "sup-run-03-01",
            stageId: "03",
            batchId: "03.01",
            reviewPass: 1,
            reviewedAt: now,
            outcome: "stopped",
            threadIds: ["03.01.01"],
            issueSummaryIds: ["issue-03-01"],
          },
          {
            reviewId: "review-03-02",
            runId: "sup-run-03-02",
            stageId: "03",
            batchId: "03.02",
            reviewPass: 1,
            reviewedAt: now,
            outcome: "approved",
            threadIds: ["03.02.01"],
            issueSummaryIds: [],
          },
        ],
        issue_summaries: [
          {
            summaryId: "issue-03-01",
            runId: "sup-run-03-01",
            stageId: "03",
            batchId: "03.01",
            threadId: "03.01.01",
            status: "open",
            summary: "stale issue",
            firstObservedAt: now,
            lastObservedAt: now,
          },
        ],
        fix_cycles: [
          {
            cycleId: "cycle-03-01",
            runId: "sup-run-03-01",
            stageId: "03",
            batchId: "03.01",
            threadId: "03.01.01",
            attemptCount: 1,
            lastAttemptAt: now,
            lastOutcome: "stopped",
            issueSummaryIds: ["issue-03-01"],
          },
        ],
        escalations: [
          {
            escalationId: "esc-03-01",
            runId: "sup-run-03-01",
            stageId: "03",
            batchId: "03.01",
            threadId: "03.01.01",
            target: "batch",
            reason: "stale escalation",
            status: "pending",
            escalatedAt: now,
          },
        ],
        stage_stops: [
          {
            stopId: "stop-03-01",
            runId: "sup-run-03-01",
            stageId: "03",
            batchId: "03.01",
            reason: "failed",
            summary: "stale stop",
            stoppedAt: now,
          },
        ],
      },
    }
    writeTasksFile(workspace.repoRoot, workspace.streamId, tasksFile)

    writeFileSync(getCompletionMarkerPath(workspace.streamId, "03.01.01"), "done\n")
    writeFileSync(getSessionFilePath(workspace.streamId, "03.01.01"), "stale-session-file\n")
    writeFileSync(
      getRunResultPath(workspace.streamId, "03.01.01"),
      JSON.stringify({ status: "failed", exitCode: 1 }),
    )
    writeFileSync(getWorkingAgentSessionPath(workspace.streamId, "03.01.01"), "working\n")
    writeFileSync(getSynthesisOutputPath(workspace.streamId, "03.01.01"), "summary\n")
    writeFileSync(getSynthesisLogPath(workspace.streamId, "03.01.01"), "log\n")

    writeFileSync(
      join(workspace.workDir, "threads.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: now,
          threads: [
            {
              threadId: "03.01.01",
              promptPath: "prompts/03-stage/01-batch/thread-01.md",
              currentSessionId: "legacy-current-03-01",
              opencodeSessionId: "legacy-outer-03-01",
              sessions: [
                {
                  sessionId: "legacy-session-03-01",
                  agentName: "default",
                  model: "openai/gpt-5.4",
                  startedAt: now,
                  status: "failed",
                  completedAt: now,
                  exitCode: 1,
                },
              ],
            },
            {
              threadId: "03.02.01",
              promptPath: "prompts/03-stage/02-batch/thread-01.md",
              currentSessionId: "legacy-keep-03-02",
              sessions: [],
            },
          ],
        },
        null,
        2,
      ),
    )

    writeFileSync(
      join(workspace.workDir, "supervisor-state.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: workspace.streamId,
          last_updated: now,
          active_run_id: "sup-run-03-01",
          current_branch_supervision: {
            owner: "root_agent",
            rootSessionId: "root-1",
            branchSessionId: "branch-03-01",
            branchRole: "supervision",
            nativeSessionId: "native-1",
            source: "repo_local_fallback",
            updatedAt: now,
            scope: { level: "batch", stageId: "03", batchId: "03.01" },
            supervisionProgress: {
              executionMode: "single_batch_run",
              currentBatchId: "03.01",
            },
          },
          runs: [
            {
              runId: "sup-run-03-01",
              stageId: "03",
              status: "stopped",
              startedAt: now,
              updatedAt: now,
              currentBatchId: "03.01",
              lastReviewedBatchId: "03.01",
              reviewPasses: 1,
              issueSummaryIds: ["issue-03-01"],
              escalationIds: ["esc-03-01"],
              branchSessionId: "branch-03-01",
              stageStopId: "stop-03-01",
              stopReason: "failed",
            },
            {
              runId: "sup-run-03-02",
              stageId: "03",
              status: "completed",
              startedAt: now,
              updatedAt: now,
              currentBatchId: "03.02",
              lastReviewedBatchId: "03.02",
              reviewPasses: 1,
              issueSummaryIds: [],
              escalationIds: [],
            },
          ],
          checkpoint_pointers: [],
          branch_sessions: [
            {
              owner: "root_agent",
              rootSessionId: "root-1",
              branchSessionId: "branch-03-01",
              branchRole: "supervision",
              source: "repo_local_fallback",
              nativeSessionId: "native-1",
              status: "stopped",
              startedAt: now,
              updatedAt: now,
              batchId: "03.01",
              runId: "sup-run-03-01",
              supervisionProgress: {
                executionMode: "single_batch_run",
                currentBatchId: "03.01",
              },
              scope: { level: "batch", stageId: "03", batchId: "03.01" },
            },
            {
              owner: "root_agent",
              rootSessionId: "root-2",
              branchSessionId: "branch-03-02",
              branchRole: "supervision",
              source: "repo_local_fallback",
              nativeSessionId: "native-2",
              status: "completed",
              startedAt: now,
              updatedAt: now,
              batchId: "03.02",
              runId: "sup-run-03-02",
              supervisionProgress: {
                executionMode: "single_batch_run",
                currentBatchId: "03.02",
              },
              scope: { level: "batch", stageId: "03", batchId: "03.02" },
            },
          ],
          reviewed_batches: [
            {
              reviewId: "review-03-01",
              runId: "sup-run-03-01",
              stageId: "03",
              batchId: "03.01",
              reviewPass: 1,
              reviewedAt: now,
              outcome: "stopped",
              threadIds: ["03.01.01"],
              issueSummaryIds: ["issue-03-01"],
            },
            {
              reviewId: "review-03-02",
              runId: "sup-run-03-02",
              stageId: "03",
              batchId: "03.02",
              reviewPass: 1,
              reviewedAt: now,
              outcome: "approved",
              threadIds: ["03.02.01"],
              issueSummaryIds: [],
            },
          ],
          issue_summaries: [
            {
              summaryId: "issue-03-01",
              runId: "sup-run-03-01",
              stageId: "03",
              batchId: "03.01",
              threadId: "03.01.01",
              status: "open",
              summary: "legacy stale issue",
              firstObservedAt: now,
              lastObservedAt: now,
            },
          ],
          fix_cycles: [
            {
              cycleId: "cycle-03-01",
              runId: "sup-run-03-01",
              stageId: "03",
              batchId: "03.01",
              threadId: "03.01.01",
              attemptCount: 1,
              lastAttemptAt: now,
              lastOutcome: "stopped",
              issueSummaryIds: ["issue-03-01"],
            },
          ],
          escalations: [
            {
              escalationId: "esc-03-01",
              runId: "sup-run-03-01",
              stageId: "03",
              batchId: "03.01",
              threadId: "03.01.01",
              target: "batch",
              reason: "legacy stale escalation",
              status: "pending",
              escalatedAt: now,
            },
          ],
          stage_stops: [
            {
              stopId: "stop-03-01",
              runId: "sup-run-03-01",
              stageId: "03",
              batchId: "03.01",
              reason: "failed",
              summary: "legacy stale stop",
              stoppedAt: now,
            },
          ],
        },
        null,
        2,
      ),
    )

    mkdirSync(join(workspace.workDir, "batch-status"), { recursive: true })
    writeFileSync(
      join(workspace.workDir, "batch-status", "03.01.json"),
      JSON.stringify(tasksFile.runtime_state.batches["03.01"], null, 2),
    )
    writeFileSync(
      join(workspace.workDir, "batch-status", "03.02.json"),
      JSON.stringify(tasksFile.runtime_state.batches["03.02"], null, 2),
    )

    const { stdout, stderr } = await captureCliOutput(async () => {
      await resetBatchStateMain([
        "bun",
        "work-reset-batch-state",
        "--repo-root",
        workspace!.repoRoot,
        "--stream",
        workspace!.streamId,
        "--batch",
        "03.01",
      ])
    })

    expect(stderr).toHaveLength(0)
    expect(stdout.join("\n")).toContain("Reset batch 03.01")
    expect(stdout.join("\n")).toContain("Runtime:")
    expect(stdout.join("\n")).toContain("Supervision:")
    expect(stdout.join("\n")).toContain("Artifacts:")

    const persisted = readTasksFile(workspace.repoRoot, workspace.streamId)
    expect(persisted).not.toBeNull()

    const targetTask = persisted!.tasks.find((task) => task.id === "03.01.01.01")
    expect(targetTask?.status).toBe("pending")
    expect(targetTask?.report).toBeUndefined()
    expect(targetTask?.breadcrumb).toBeUndefined()

    const unrelatedTask = persisted!.tasks.find((task) => task.id === "03.02.01.01")
    expect(unrelatedTask?.status).toBe("completed")
    expect(unrelatedTask?.report).toBe("keep me")

    expect(persisted!.runtime_state?.batches["03.01"]).toBeUndefined()
    expect(persisted!.runtime_state?.batches["03.02"]?.status).toBe("completed")
    expect(persisted!.runtime_summary?.batches["03.01"]).toBeUndefined()
    expect(persisted!.runtime_summary?.batches["03.02"]?.status).toBe("completed")

    const resetThread = persisted!.runtime_state?.threads.find((thread) => thread.threadId === "03.01.01")
    expect(resetThread).toMatchObject({
      threadId: "03.01.01",
      promptPath: "prompts/03-stage/01-batch/thread-01.md",
      sessions: [],
    })
    expect(resetThread?.currentSessionId).toBeUndefined()
    expect(resetThread?.opencodeSessionId).toBeUndefined()
    expect(resetThread?.workingAgentSessionId).toBeUndefined()
    expect(resetThread?.synthesis).toBeUndefined()

    const unrelatedThread = persisted!.runtime_state?.threads.find((thread) => thread.threadId === "03.02.01")
    expect(unrelatedThread?.currentSessionId).toBe("keep-current-03-02")
    expect(unrelatedThread?.sessions).toHaveLength(1)

    expect(persisted!.runtime_state?.supervision.active_run_id).toBeUndefined()
    expect(persisted!.runtime_state?.supervision.current_branch_supervision).toBeUndefined()
    expect(persisted!.runtime_state?.supervision.branch_sessions.map((branch) => branch.branchSessionId)).toEqual([
      "branch-03-02",
    ])
    expect(persisted!.runtime_state?.supervision.reviewed_batches.map((review) => review.reviewId)).toEqual([
      "review-03-02",
    ])
    expect(persisted!.runtime_state?.supervision.issue_summaries).toHaveLength(0)
    expect(persisted!.runtime_state?.supervision.fix_cycles).toHaveLength(0)
    expect(persisted!.runtime_state?.supervision.escalations).toHaveLength(0)
    expect(persisted!.runtime_state?.supervision.stage_stops).toHaveLength(0)

    expect(existsSync(getCompletionMarkerPath(workspace.streamId, "03.01.01"))).toBe(false)
    expect(existsSync(getSessionFilePath(workspace.streamId, "03.01.01"))).toBe(false)
    expect(existsSync(getRunResultPath(workspace.streamId, "03.01.01"))).toBe(false)
    expect(existsSync(getWorkingAgentSessionPath(workspace.streamId, "03.01.01"))).toBe(false)
    expect(existsSync(getSynthesisOutputPath(workspace.streamId, "03.01.01"))).toBe(false)
    expect(existsSync(getSynthesisLogPath(workspace.streamId, "03.01.01"))).toBe(false)
    expect(existsSync(join(workspace.workDir, "batch-status", "03.01.json"))).toBe(false)
    expect(existsSync(join(workspace.workDir, "batch-status", "03.02.json"))).toBe(true)

    const legacyThreadsOnDisk = JSON.parse(readFileSync(join(workspace.workDir, "threads.json"), "utf-8")) as {
      threads: Array<{ threadId: string }>
    }
    expect(legacyThreadsOnDisk.threads.map((thread) => thread.threadId)).toEqual(["03.02.01"])

    const legacySupervisorOnDisk = JSON.parse(
      readFileSync(join(workspace.workDir, "supervisor-state.json"), "utf-8"),
    ) as {
      active_run_id?: string
      current_branch_supervision?: { branchSessionId: string }
      branch_sessions: Array<{ branchSessionId: string }>
      reviewed_batches: Array<{ reviewId: string }>
      issue_summaries: Array<{ summaryId: string }>
      fix_cycles: Array<{ cycleId: string }>
      escalations: Array<{ escalationId: string }>
      stage_stops: Array<{ stopId: string }>
    }
    expect(legacySupervisorOnDisk.active_run_id).toBeUndefined()
    expect(legacySupervisorOnDisk.current_branch_supervision).toBeUndefined()
    expect(legacySupervisorOnDisk.branch_sessions.map((branch) => branch.branchSessionId)).toEqual([
      "branch-03-02",
    ])
    expect(legacySupervisorOnDisk.reviewed_batches.map((review) => review.reviewId)).toEqual([
      "review-03-02",
    ])
    expect(legacySupervisorOnDisk.issue_summaries).toHaveLength(0)
    expect(legacySupervisorOnDisk.fix_cycles).toHaveLength(0)
    expect(legacySupervisorOnDisk.escalations).toHaveLength(0)
    expect(legacySupervisorOnDisk.stage_stops).toHaveLength(0)

    const reloaded = readTasksFile(workspace.repoRoot, workspace.streamId)
    expect(reloaded?.runtime_state?.batches["03.01"]).toBeUndefined()
    expect(reloaded?.runtime_summary?.batches["03.01"]).toBeUndefined()
    expect(reloaded?.runtime_state?.threads.find((thread) => thread.threadId === "03.01.01")?.sessions).toEqual(
      [],
    )
    expect(reloaded?.runtime_state?.supervision.active_run_id).toBeUndefined()

    const treeOutput = await captureCliOutput(() => {
      treeMain([
        "bun",
        "work-tree",
        "--repo-root",
        workspace!.repoRoot,
        "--stream",
        workspace!.streamId,
      ])
    })
    expect(treeOutput.stderr).toHaveLength(0)
    expect(treeOutput.stdout.join("\n")).not.toContain("Runtime: batch 03.01 failed")
    expect(treeOutput.stdout.join("\n")).not.toContain("runtime failed")

    expect(loadThreads(workspace.repoRoot, workspace.streamId)?.threads.map((thread) => thread.threadId)).toEqual([
      "03.01.01",
      "03.02.01",
    ])
    expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions.map((branch) => branch.branchSessionId)).toEqual([
      "branch-03-02",
    ])
    expect(readBatchStatus(workspace.repoRoot, workspace.streamId, "03.01")).toBeNull()
    expect(readBatchStatus(workspace.repoRoot, workspace.streamId, "03.02")?.status).toBe("completed")

    const cleanBatchStatus = await syncBatchStatus({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      batchId: "03.01",
    })
    expect(cleanBatchStatus.status).toBe("pending")
    expect(cleanBatchStatus.summary).toEqual({
      total: 1,
      pending: 1,
      running: 0,
      completed: 0,
      failed: 0,
    })

    const supervisePlan = await buildSupervisionExecutionPlan({
      repoRoot: workspace.repoRoot,
      streamId: workspace.streamId,
      requestedBatchId: "03.01",
    })
    expect(supervisePlan.action).toBe("launch")
    expect(supervisePlan.reusingExistingRun).toBe(false)
  })
})
