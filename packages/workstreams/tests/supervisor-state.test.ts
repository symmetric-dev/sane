import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import { join } from "path"
import {
  createEmptySupervisorState,
  getSupervisorStateFilePath,
  loadSupervisorState,
  modifySupervisorState,
  recordStageStopLocked,
  saveSupervisorState,
  setActiveSupervisorRunLocked,
  upsertEscalationOutcomeLocked,
  upsertFixCycleLocked,
  upsertIssueSummaryLocked,
  upsertReviewedBatchLocked,
  upsertSupervisorRunLocked,
} from "../src/lib/supervisor-state"
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
    expect(empty.reviewed_batches).toHaveLength(0)
    expect(empty.issue_summaries).toHaveLength(0)
    expect(empty.fix_cycles).toHaveLength(0)
    expect(empty.escalations).toHaveLength(0)
    expect(empty.stage_stops).toHaveLength(0)
    expect(empty.last_updated).toBeDefined()
  })

  test("saveSupervisorState persists supervisor-state.json separately from threads.json", () => {
    const supervisorState: SupervisorStateFile = {
      version: "1.0.0",
      stream_id: workspace.streamId,
      last_updated: new Date().toISOString(),
      runs: [],
      reviewed_batches: [],
      issue_summaries: [],
      fix_cycles: [],
      escalations: [],
      stage_stops: [],
    }

    saveSupervisorState(workspace.repoRoot, workspace.streamId, supervisorState)

    const supervisorStatePath = getSupervisorStateFilePath(workspace.repoRoot, workspace.streamId)
    expect(supervisorStatePath).toEndWith("supervisor-state.json")
    expect(existsSync(supervisorStatePath)).toBe(true)
    expect(existsSync(join(workspace.workDir, "threads.json"))).toBe(false)

    const loaded = loadSupervisorState(workspace.repoRoot, workspace.streamId)
    expect(loaded).not.toBeNull()
    expect(loaded!.stream_id).toBe(workspace.streamId)
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
