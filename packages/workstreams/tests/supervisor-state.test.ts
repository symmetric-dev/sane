import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "fs"
import { join } from "path"
import { createBatchStatusFile, writeBatchStatus } from "../src/lib/batch-status"
import {
  createEmptySupervisorState,
  getSupervisorStateFilePath,
  loadSupervisorState,
  modifySupervisorState,
  pauseSupervisorRunLocked,
  reconcileSupervisorRunsLocked,
  recordStageStopLocked,
  saveSupervisorState,
  setActiveSupervisorRunLocked,
  upsertBranchSessionLocked,
  upsertCheckpointPointerLocked,
  upsertEscalationOutcomeLocked,
  upsertFixCycleLocked,
  upsertIssueSummaryLocked,
  upsertReviewedBatchLocked,
  upsertSupervisorRunLocked,
} from "../src/lib/supervisor-state"
import { readTasksFile } from "../src/lib/tasks"
import type { SupervisorRunState, SupervisorStateFile } from "../src/lib/types"
import { cleanupTestWorkstream, createTestWorkstream, type TestWorkspace } from "./helpers"

describe("supervisor-state", () => {
  let workspace: TestWorkspace

  beforeEach(() => {
    workspace = createTestWorkstream()
  })

  afterEach(() => {
    cleanupTestWorkstream(workspace)
  })

  test("createEmptySupervisorState creates the dedicated schema", () => {
    const empty = createEmptySupervisorState(workspace.streamId)

    expect(empty.stream_id).toBe(workspace.streamId)
    expect(empty.runs).toHaveLength(0)
    expect(empty.checkpoint_pointers).toHaveLength(0)
    expect(empty.branch_sessions).toHaveLength(0)
    expect(empty.reviewed_batches).toHaveLength(0)
    expect(empty.issue_summaries).toHaveLength(0)
    expect(empty.fix_cycles).toHaveLength(0)
    expect(empty.escalations).toHaveLength(0)
    expect(empty.stage_stops).toHaveLength(0)
    expect(empty.last_updated).toBeDefined()
  })

  test("saveSupervisorState persists unified supervisor state in tasks.json", () => {
    const supervisorState: SupervisorStateFile = {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      runs: [],
      checkpoint_pointers: [],
      branch_sessions: [],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    }

    saveSupervisorState(workspace.repoRoot, workspace.streamId, supervisorState)

    const supervisorStatePath = getSupervisorStateFilePath(workspace.repoRoot, workspace.streamId)
    expect(supervisorStatePath).toEndWith("tasks.json")
    expect(existsSync(supervisorStatePath)).toBe(true)
    expect(existsSync(join(workspace.workDir, "threads.json"))).toBe(false)

    const loaded = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(loaded).not.toBeNull()
    expect(loaded!.stream_id).toBe(workspace.streamId)
    expect(readTasksFile(workspace.repoRoot, workspace.streamId)?.runtime_summary).toBeUndefined()
  })

  test("saveSupervisorState projects latest supervision summary into tasks.json", () => {
    const startedAt = new Date().toISOString()
    const supervisorState: SupervisorStateFile = {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: startedAt,
      active_run_id: "sup-run-1",
      current_branch_supervision: {
        owner: "root_agent",
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        branchRole: "supervision",
        nativeSessionId: "ses-1",
        source: "native_fork",
        updatedAt: startedAt,
        scope: { level: "batch", stageId: "01", batchId: "01.01" },
        supervisionProgress: {
          executionMode: "single_batch_run",
          currentBatchId: "01.01",
        },
      },
      runs: [
        {
          runId: "sup-run-1",
          stageId: "01",
          status: "failed",
          startedAt,
          updatedAt: startedAt,
          currentBatchId: "01.01",
          reviewPasses: 2,
          issueSummaryIds: [],
          escalationIds: [],
        },
      ],
      checkpoint_pointers: [],
      branch_sessions: [
        {
          owner: "root_agent",
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-1",
          branchRole: "supervision",
          nativeSessionId: "ses-1",
          source: "native_fork",
          status: "running",
          startedAt,
          updatedAt: startedAt,
          batchId: "01.01",
          scope: { level: "batch", stageId: "01", batchId: "01.01" },
        },
      ],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    }

    saveSupervisorState(workspace.repoRoot, workspace.streamId, supervisorState)

    expect(readTasksFile(workspace.repoRoot, workspace.streamId)?.runtime_summary?.supervision).toMatchObject({
      active_run_id: "sup-run-1",
      active_run: {
        run_id: "sup-run-1",
        status: "failed",
        current_batch_id: "01.01",
        review_passes: 2,
      },
      current_branch: {
        branch_session_id: "branch-supervision-1",
        status: "running",
        batch_id: "01.01",
        current_batch_id: "01.01",
      },
    })
  })

  test("loadSupervisorState reports the tasks.json path when unified state is malformed", () => {
    const supervisorStatePath = getSupervisorStateFilePath(workspace.repoRoot, workspace.streamId)
    writeFileSync(supervisorStatePath, '{"runs": [}', "utf-8")

    expect(() => loadSupervisorState(workspace.repoRoot, workspace.streamId)).toThrow(
      `Failed to parse unified supervisor state in tasks.json at ${supervisorStatePath}:`,
    )
  })

  test("locked helpers create, update, and keep explicit batch/thread references", async () => {
    const startedAt = new Date().toISOString()
    const run: SupervisorRunState = {
      runId: "sup-run-1",
      stageId: "02",
      status: "running",
      startedAt,
      updatedAt: startedAt,
      currentBatchId: "02.01",
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
    }

    await upsertSupervisorRunLocked(workspace.repoRoot, workspace.streamId, run)
    await setActiveSupervisorRunLocked(workspace.repoRoot, workspace.streamId, run.runId)

    await upsertIssueSummaryLocked(workspace.repoRoot, workspace.streamId, {
      summaryId: "issue-1",
      runId: run.runId,
      stageId: "02",
      batchId: "02.01",
      threadId: "02.01.02",
      status: "open",
      summary: "Reviewer found a resumable state mismatch.",
      severity: "high",
      firstObservedAt: startedAt,
      lastObservedAt: startedAt,
    })

    await upsertReviewedBatchLocked(workspace.repoRoot, workspace.streamId, {
      reviewId: "review-1",
      runId: run.runId,
      stageId: "02",
      batchId: "02.01",
      reviewPass: 1,
      reviewedAt: startedAt,
      outcome: "changes_requested",
      threadIds: ["02.01.02"],
      issueSummaryIds: ["issue-1"],
      notes: "Need one fix cycle before approval.",
    })

    await upsertFixCycleLocked(workspace.repoRoot, workspace.streamId, {
      cycleId: "cycle-1",
      runId: run.runId,
      stageId: "02",
      batchId: "02.01",
      threadId: "02.01.02",
      attemptCount: 1,
      lastAttemptAt: startedAt,
      lastOutcome: "pending_review",
      issueSummaryIds: ["issue-1"],
    })

    await upsertEscalationOutcomeLocked(workspace.repoRoot, workspace.streamId, {
      escalationId: "esc-1",
      runId: run.runId,
      stageId: "02",
      batchId: "02.01",
      threadId: "02.01.02",
      target: "operator",
      reason: "Fix cycle exceeded the safe automatic retry threshold.",
      status: "pending",
      escalatedAt: startedAt,
      notes: "Awaiting human review.",
    })

    await recordStageStopLocked(workspace.repoRoot, workspace.streamId, {
      stopId: "stop-1",
      runId: run.runId,
      stageId: "02",
      batchId: "02.01",
      reason: "issues_escalated",
      summary: "Supervisor paused the stage after escalating unresolved issues.",
      stoppedAt: startedAt,
      escalationId: "esc-1",
    })

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState).not.toBeNull()
    expect(supervisorState!.active_run_id).toBeUndefined()
    expect(supervisorState!.runs).toHaveLength(1)
    expect(supervisorState!.reviewed_batches).toHaveLength(1)
    expect(supervisorState!.issue_summaries).toHaveLength(1)
    expect(supervisorState!.fix_cycles).toHaveLength(1)
    expect(supervisorState!.escalations).toHaveLength(1)
    expect(supervisorState!.stage_stops).toHaveLength(1)

    const storedRun = supervisorState!.runs[0]!
    expect(storedRun.lastReviewedBatchId).toBe("02.01")
    expect(storedRun.reviewPasses).toBe(1)
    expect(storedRun.issueSummaryIds).toEqual(["issue-1"])
    expect(storedRun.escalationIds).toEqual(["esc-1"])
    expect(storedRun.stageStopId).toBe("stop-1")
    expect(storedRun.stopReason).toBe("issues_escalated")
    expect(storedRun.status).toBe("escalated")

    const reviewedBatch = supervisorState!.reviewed_batches[0]!
    expect(reviewedBatch.batchId).toBe("02.01")
    expect(reviewedBatch.threadIds).toEqual(["02.01.02"])

    const issueSummary = supervisorState!.issue_summaries[0]!
    expect(issueSummary.batchId).toBe("02.01")
    expect(issueSummary.threadId).toBe("02.01.02")

    const fixCycle = supervisorState!.fix_cycles[0]!
    expect(fixCycle.batchId).toBe("02.01")
    expect(fixCycle.threadId).toBe("02.01.02")
    expect(fixCycle.attemptCount).toBe(1)

    expect(existsSync(join(workspace.workDir, "threads.json"))).toBe(false)
  })

  test("upsertBranchSessionLocked persists root-agent branch lineage metadata", async () => {
    const startedAt = new Date().toISOString()

    await upsertCheckpointPointerLocked(workspace.repoRoot, workspace.streamId, {
      rootSessionId: "root-session-1",
      checkpointMessageId: "msg_checkpoint_1",
      checkpointMessageIndex: 3,
      checkpointCreatedAt: startedAt,
      breakpointSelection: {
        strategy: "explicit_tag",
        configuredTags: ["SESSION_BREAKPOINT"],
        matchedTag: "SESSION_BREAKPOINT",
        launchMessageId: "msg-launch",
        launchMessageIndex: 4,
        rationale:
          'Selected the tagged user message because it matched configured breakpoint tag "SESSION_BREAKPOINT" before launch message msg-launch.',
      },
    })

    await upsertBranchSessionLocked(workspace.repoRoot, workspace.streamId, {
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      branchRole: "supervision",
      checkpointMessageId: "msg_checkpoint_1",
      checkpointMessageIndex: 3,
      checkpointCreatedAt: startedAt,
      breakpointSelection: {
        strategy: "explicit_tag",
        configuredTags: ["SESSION_BREAKPOINT"],
        matchedTag: "SESSION_BREAKPOINT",
        launchMessageId: "msg-launch",
        launchMessageIndex: 4,
        rationale:
          'Selected the tagged user message because it matched configured breakpoint tag "SESSION_BREAKPOINT" before launch message msg-launch.',
      },
      parentSessionId: "root-session-1",
      nativeSessionId: "ses_supervision_1",
      source: "native_fork",
      status: "completed",
      startedAt,
      updatedAt: startedAt,
      completedAt: startedAt,
      runId: "sup-run-1",
      batchId: "01.01",
      notes: "Returned terminal batch state to the Root Agent.",
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored?.checkpoint_pointers).toHaveLength(1)
    expect(stored?.branch_sessions).toHaveLength(1)
    expect(stored?.current_branch_supervision).toBeUndefined()
    expect(stored?.checkpoint_pointers[0]).toMatchObject({
      rootSessionId: "root-session-1",
      checkpointMessageId: "msg_checkpoint_1",
      checkpointMessageIndex: 3,
      checkpointCreatedAt: startedAt,
      breakpointSelection: {
        strategy: "explicit_tag",
        configuredTags: ["SESSION_BREAKPOINT"],
        matchedTag: "SESSION_BREAKPOINT",
        launchMessageId: "msg-launch",
        launchMessageIndex: 4,
        rationale:
          'Selected the tagged user message because it matched configured breakpoint tag "SESSION_BREAKPOINT" before launch message msg-launch.',
      },
    })
    expect(stored?.branch_sessions[0]).toMatchObject({
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      branchRole: "supervision",
      checkpointMessageId: "msg_checkpoint_1",
      checkpointMessageIndex: 3,
      checkpointCreatedAt: startedAt,
      breakpointSelection: {
        strategy: "explicit_tag",
        configuredTags: ["SESSION_BREAKPOINT"],
        matchedTag: "SESSION_BREAKPOINT",
        launchMessageId: "msg-launch",
        launchMessageIndex: 4,
        rationale:
          'Selected the tagged user message because it matched configured breakpoint tag "SESSION_BREAKPOINT" before launch message msg-launch.',
      },
      parentSessionId: "root-session-1",
      nativeSessionId: "ses_supervision_1",
      source: "native_fork",
      runId: "sup-run-1",
      batchId: "01.01",
      scope: {
        level: "batch",
        stageId: "01",
        batchId: "01.01",
      },
      supervisionProgress: {
        executionMode: "single_batch_run",
        currentBatchId: "01.01",
      },
    })
  })

  test("upsertBranchSessionLocked clears current branch supervision for terminal branch completion", async () => {
    const startedAt = new Date().toISOString()

    await upsertBranchSessionLocked(workspace.repoRoot, workspace.streamId, {
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      branchRole: "supervision",
      parentSessionId: "root-session-1",
      nativeSessionId: "ses_supervision_1",
      source: "native_fork",
      status: "running",
      startedAt,
      updatedAt: startedAt,
      batchId: "01.01",
    })

    await upsertBranchSessionLocked(workspace.repoRoot, workspace.streamId, {
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      branchRole: "supervision",
      parentSessionId: "root-session-1",
      nativeSessionId: "ses_supervision_1",
      source: "native_fork",
      status: "completed",
      startedAt,
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      batchId: "01.01",
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored?.current_branch_supervision).toBeUndefined()
  })

  test("loadSupervisorState normalizes legacy batch-only branch records into batch scope", async () => {
    const startedAt = new Date().toISOString()

    saveSupervisorState(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: startedAt,
      runs: [],
      checkpoint_pointers: [],
      branch_sessions: [
        {
          owner: "root_agent",
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-legacy",
          branchRole: "supervision",
          parentSessionId: "root-session-1",
          source: "repo_local_fallback",
          status: "completed",
          startedAt,
          updatedAt: startedAt,
          batchId: "15.01",
        },
      ],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored?.branch_sessions[0]?.scope).toEqual({
      level: "batch",
      stageId: "15",
      batchId: "15.01",
    })
    expect(stored?.branch_sessions[0]?.supervisionProgress).toEqual({
      executionMode: "single_batch_run",
      currentBatchId: "15.01",
    })
  })

  test("loadSupervisorState ignores stale current branch supervision without an active backing branch session", () => {
    const startedAt = new Date().toISOString()

    saveSupervisorState(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: startedAt,
      current_branch_supervision: {
        owner: "root_agent",
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-stale",
        branchRole: "supervision",
        nativeSessionId: "ses_supervision_1",
        source: "native_fork",
        updatedAt: startedAt,
      },
      runs: [],
      checkpoint_pointers: [],
      branch_sessions: [
        {
          owner: "root_agent",
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-stale",
          branchRole: "supervision",
          parentSessionId: "root-session-1",
          nativeSessionId: "ses_supervision_1",
          source: "native_fork",
          status: "completed",
          startedAt,
          updatedAt: startedAt,
          completedAt: startedAt,
          batchId: "01.01",
        },
      ],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored?.current_branch_supervision).toBeUndefined()
  })

  test("upsertBranchSessionLocked preserves stage scope while updating current batch", async () => {
    const startedAt = new Date().toISOString()

    await upsertBranchSessionLocked(workspace.repoRoot, workspace.streamId, {
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-stage",
      branchRole: "supervision",
      parentSessionId: "root-session-1",
      source: "native_fork",
      status: "running",
      startedAt,
      updatedAt: startedAt,
      batchId: "15.01",
      scope: {
        level: "stage",
        stageId: "15",
      },
    })

    await upsertBranchSessionLocked(workspace.repoRoot, workspace.streamId, {
      owner: "root_agent",
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-stage",
      branchRole: "supervision",
      parentSessionId: "root-session-1",
      source: "native_fork",
      status: "running",
      startedAt,
      updatedAt: new Date().toISOString(),
      batchId: "15.02",
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored?.branch_sessions[0]?.batchId).toBeUndefined()
    expect(stored?.branch_sessions[0]?.scope).toEqual({
      level: "stage",
      stageId: "15",
    })
    expect(stored?.branch_sessions[0]?.supervisionProgress).toEqual({
      executionMode: "stage_batch_loop",
      currentBatchId: "15.02",
    })
  })

  test("loadSupervisorState migrates legacy stage batch targets into supervision progress only", () => {
    const startedAt = new Date().toISOString()

    saveSupervisorState(workspace.repoRoot, workspace.streamId, {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: startedAt,
      runs: [],
      checkpoint_pointers: [],
      branch_sessions: [
        {
          owner: "root_agent",
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-stage-legacy",
          branchRole: "supervision",
          parentSessionId: "root-session-1",
          source: "repo_local_fallback",
          status: "running",
          startedAt,
          updatedAt: startedAt,
          batchId: "15.02",
          scope: {
            level: "stage",
            stageId: "15",
          },
        },
      ],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored?.branch_sessions[0]?.batchId).toBeUndefined()
    expect(stored?.branch_sessions[0]?.scope).toEqual({
      level: "stage",
      stageId: "15",
    })
    expect(stored?.branch_sessions[0]?.supervisionProgress).toEqual({
      executionMode: "stage_batch_loop",
      currentBatchId: "15.02",
    })
  })

  test("modifySupervisorState is the safe mutation path for follow-up runs", async () => {
    const runStartedAt = new Date().toISOString()

    const returnedRunId = await modifySupervisorState(
      workspace.repoRoot,
      workspace.streamId,
      (supervisorState) => {
        expect(supervisorState.stream_id).toBe(workspace.streamId)

        supervisorState.runs.push({
          runId: "sup-run-2",
          stageId: "02",
          status: "paused",
          startedAt: runStartedAt,
          updatedAt: runStartedAt,
          lastReviewedBatchId: "02.01",
          reviewPasses: 2,
          issueSummaryIds: ["issue-a"],
          escalationIds: [],
        })

        return supervisorState.runs[0]!.runId
      },
    )

    expect(returnedRunId).toBe("sup-run-2")

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored!.runs).toHaveLength(1)
    expect(stored!.runs[0]!.lastReviewedBatchId).toBe("02.01")
  })

  test("pauseSupervisorRunLocked clears active ownership without preserving terminal stop metadata", async () => {
    const startedAt = new Date().toISOString()

    await upsertSupervisorRunLocked(workspace.repoRoot, workspace.streamId, {
      runId: "sup-run-pause",
      stageId: "01",
      status: "running",
      startedAt,
      updatedAt: startedAt,
      completedAt: startedAt,
      currentBatchId: "01.01",
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
      stageStopId: "legacy-stop",
      stopReason: "failed",
    })

    await pauseSupervisorRunLocked(workspace.repoRoot, workspace.streamId, {
      runId: "sup-run-pause",
      currentBatchId: "01.01",
      updatedAt: startedAt,
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored?.active_run_id).toBeUndefined()
    expect(stored?.runs[0]?.status).toBe("paused")
    expect(stored?.runs[0]?.currentBatchId).toBe("01.01")
    expect(stored?.runs[0]?.stageStopId).toBeUndefined()
    expect(stored?.runs[0]?.stopReason).toBeUndefined()
    expect(stored?.runs[0]?.completedAt).toBeUndefined()
  })

  test("reconcileSupervisorRunsLocked pauses stale running runs once their batch becomes terminal", async () => {
    const startedAt = new Date().toISOString()

    await upsertSupervisorRunLocked(workspace.repoRoot, workspace.streamId, {
      runId: "sup-run-stale",
      stageId: "01",
      status: "running",
      startedAt,
      updatedAt: startedAt,
      currentBatchId: "01.01",
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
    })
    await setActiveSupervisorRunLocked(workspace.repoRoot, workspace.streamId, "sup-run-stale")

    writeBatchStatus(
      workspace.repoRoot,
      workspace.streamId,
      {
        ...createBatchStatusFile({
          streamId: workspace.streamId,
          batchId: "01.01",
          threads: [{ threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" }],
          startedAt,
          runId: "batch-run-stale",
        }),
        status: "completed",
        updatedAt: startedAt,
        completedAt: startedAt,
        summary: { total: 1, pending: 0, running: 0, completed: 1, failed: 0 },
        threads: [
          {
            threadId: "01.01.01",
            threadName: "Thread 1",
            firstTaskId: "01.01.01.01",
            status: "completed",
            updatedAt: startedAt,
            completedAt: startedAt,
          },
        ],
      },
    )

    const reconciled = await reconcileSupervisorRunsLocked(workspace.repoRoot, workspace.streamId)

    expect(reconciled).toEqual(["sup-run-stale"])

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored?.active_run_id).toBeUndefined()
    expect(stored?.runs[0]?.status).toBe("paused")
    expect(stored?.runs[0]?.currentBatchId).toBe("01.01")
  })

  test("reconcileSupervisorRunsLocked reopens interrupted failed runs once their batch is terminal", async () => {
    const startedAt = new Date().toISOString()

    await upsertSupervisorRunLocked(workspace.repoRoot, workspace.streamId, {
      runId: "sup-run-failed-recover",
      stageId: "01",
      status: "failed",
      startedAt,
      updatedAt: startedAt,
      currentBatchId: "01.01",
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
      stageStopId: "sup-run-failed-recover-error-stop",
      stopReason: "failed",
      completedAt: startedAt,
    })

    await recordStageStopLocked(workspace.repoRoot, workspace.streamId, {
      stopId: "sup-run-failed-recover-error-stop",
      runId: "sup-run-failed-recover",
      stageId: "01",
      batchId: "01.01",
      reason: "failed",
      summary: "Caller crashed after the batch completed.",
      stoppedAt: startedAt,
    })

    writeBatchStatus(
      workspace.repoRoot,
      workspace.streamId,
      {
        ...createBatchStatusFile({
          streamId: workspace.streamId,
          batchId: "01.01",
          threads: [{ threadId: "01.01.01", threadName: "Thread 1", firstTaskId: "01.01.01.01" }],
          startedAt,
          runId: "batch-run-recover",
        }),
        status: "completed",
        updatedAt: startedAt,
        completedAt: startedAt,
        summary: { total: 1, pending: 0, running: 0, completed: 1, failed: 0 },
        threads: [
          {
            threadId: "01.01.01",
            threadName: "Thread 1",
            firstTaskId: "01.01.01.01",
            status: "completed",
            updatedAt: startedAt,
            completedAt: startedAt,
          },
        ],
      },
    )

    const reconciled = await reconcileSupervisorRunsLocked(workspace.repoRoot, workspace.streamId)

    expect(reconciled).toEqual(["sup-run-failed-recover"])

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    const run = stored?.runs.find((value) => value.runId === "sup-run-failed-recover")
    expect(run?.status).toBe("paused")
    expect(run?.stageStopId).toBeUndefined()
    expect(run?.stopReason).toBeUndefined()
    expect(run?.completedAt).toBeUndefined()
    expect(stored?.stage_stops).toHaveLength(0)
  })

  test("supervisor state persists retry and re-review links for a batch fix cycle", async () => {
    const reviewedAt = new Date().toISOString()

    await upsertSupervisorRunLocked(workspace.repoRoot, workspace.streamId, {
      runId: "sup-run-rereview",
      stageId: "03",
      status: "running",
      startedAt: reviewedAt,
      updatedAt: reviewedAt,
      currentBatchId: "03.01",
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
    })

    await upsertReviewedBatchLocked(workspace.repoRoot, workspace.streamId, {
      reviewId: "review-1",
      runId: "sup-run-rereview",
      stageId: "03",
      batchId: "03.01",
      reviewPass: 1,
      reviewKind: "initial",
      reviewedAt,
      outcome: "changes_requested",
      threadIds: ["03.01.01"],
      issueSummaryIds: ["issue-1"],
    })

    await upsertFixCycleLocked(workspace.repoRoot, workspace.streamId, {
      cycleId: "cycle-1",
      runId: "sup-run-rereview",
      stageId: "03",
      batchId: "03.01",
      threadId: "03.01.01",
      attemptCount: 1,
      batchAttempt: 1,
      triggeredByReviewId: "review-1",
      lastAttemptAt: reviewedAt,
      lastOutcome: "pending_review",
      issueSummaryIds: ["issue-1"],
    })

    await upsertReviewedBatchLocked(workspace.repoRoot, workspace.streamId, {
      reviewId: "review-2",
      runId: "sup-run-rereview",
      stageId: "03",
      batchId: "03.01",
      reviewPass: 2,
      reviewKind: "re_review",
      previousReviewId: "review-1",
      fixCycleId: "cycle-1",
      reviewedAt,
      outcome: "approved",
      threadIds: ["03.01.01"],
      issueSummaryIds: [],
    })

    await upsertFixCycleLocked(workspace.repoRoot, workspace.streamId, {
      cycleId: "cycle-1",
      runId: "sup-run-rereview",
      stageId: "03",
      batchId: "03.01",
      threadId: "03.01.01",
      attemptCount: 1,
      batchAttempt: 1,
      triggeredByReviewId: "review-1",
      reReviewId: "review-2",
      lastAttemptAt: reviewedAt,
      lastOutcome: "accepted",
      issueSummaryIds: ["issue-1"],
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored).not.toBeNull()

    const initialReview = stored!.reviewed_batches.find((review) => review.reviewId === "review-1")
    const reReview = stored!.reviewed_batches.find((review) => review.reviewId === "review-2")
    const fixCycle = stored!.fix_cycles.find((cycle) => cycle.cycleId === "cycle-1")

    expect(initialReview?.reviewKind).toBe("initial")
    expect(reReview?.reviewKind).toBe("re_review")
    expect(reReview?.previousReviewId).toBe("review-1")
    expect(reReview?.fixCycleId).toBe("cycle-1")
    expect(fixCycle?.batchAttempt).toBe(1)
    expect(fixCycle?.triggeredByReviewId).toBe("review-1")
    expect(fixCycle?.reReviewId).toBe("review-2")
    expect(fixCycle?.lastOutcome).toBe("accepted")
  })

  test("recordStageStopLocked preserves completed and failed terminal run statuses", async () => {
    const stoppedAt = new Date().toISOString()

    await upsertSupervisorRunLocked(workspace.repoRoot, workspace.streamId, {
      runId: "sup-run-complete",
      stageId: "02",
      status: "running",
      startedAt: stoppedAt,
      updatedAt: stoppedAt,
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
    })

    await recordStageStopLocked(workspace.repoRoot, workspace.streamId, {
      stopId: "stop-complete",
      runId: "sup-run-complete",
      stageId: "02",
      reason: "completed",
      summary: "Stage completed successfully.",
      stoppedAt,
    })

    await upsertSupervisorRunLocked(workspace.repoRoot, workspace.streamId, {
      runId: "sup-run-failed",
      stageId: "02",
      status: "running",
      startedAt: stoppedAt,
      updatedAt: stoppedAt,
      reviewPasses: 0,
      issueSummaryIds: [],
      escalationIds: [],
    })

    await recordStageStopLocked(workspace.repoRoot, workspace.streamId, {
      stopId: "stop-failed",
      runId: "sup-run-failed",
      stageId: "02",
      reason: "failed",
      summary: "Stage failed after an unrecoverable supervisor error.",
      stoppedAt,
    })

    const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(stored).not.toBeNull()
    expect(stored!.runs.find((run) => run.runId === "sup-run-complete")?.status).toBe("completed")
    expect(stored!.runs.find((run) => run.runId === "sup-run-failed")?.status).toBe("failed")
  })

  test("parallel modifySupervisorState operations are serialized", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        modifySupervisorState(workspace.repoRoot, workspace.streamId, (supervisorState) => {
          supervisorState.issue_summaries.push({
            summaryId: `issue-${index}`,
            runId: "sup-run-3",
            stageId: "02",
            batchId: "02.01",
            threadId: `02.01.${String(index).padStart(2, "0")}`,
            status: "open",
            summary: `Issue ${index}`,
            firstObservedAt: new Date().toISOString(),
            lastObservedAt: new Date().toISOString(),
          })

          return index
        }),
      ),
    )

    const supervisorState = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(supervisorState).not.toBeNull()
    expect(supervisorState!.issue_summaries).toHaveLength(10)
  })
})
