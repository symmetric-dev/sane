import { describe, expect, test } from "bun:test"
import type { ReviewerIssue } from "../../src/lib/reviewer/types"
import type { StreamDocument } from "../../src/lib/types"
import {
  decideSupervisorBatchFollowUp,
  decideSupervisorStageBoundary,
  getDefaultSupervisorConfig,
  getSupervisorBatchCycleState,
  isSupervisorStageCompleteAfterBatch,
} from "../../src/lib/supervisor"

function issue(overrides: Partial<ReviewerIssue> = {}): ReviewerIssue {
  return {
    summary: "Engineering follow-up needed",
    severity: "medium",
    difficulty: "regular",
    ownership: "engineering",
    effort: "tasks",
    ...overrides,
  }
}

const streamDocument: StreamDocument = {
  streamName: "super-agent-v1",
  summary: "Test supervisor workflow",
  references: [],
  stages: [
    {
      id: 3,
      name: "Supervisor Loop and Escalation Workflow",
      definition: "Test stage",
      constitution: "Test constitution",
      questions: [],
      batches: [
        {
          id: 1,
          prefix: "01",
          name: "control-loop-a",
          summary: "First batch",
          threads: [],
        },
        {
          id: 2,
          prefix: "02",
          name: "control-loop-b",
          summary: "Final batch",
          threads: [],
        },
      ],
    },
  ],
}

describe("supervisor workflow", () => {
  test("tracks one batch-level retry across thread fix records and pending re-review state", () => {
    const cycleState = getSupervisorBatchCycleState({
      config: getDefaultSupervisorConfig(),
      runId: "sup-run-1",
      batchId: "03.01",
      supervisorState: {
        reviewed_batches: [
          {
            runId: "sup-run-1",
            batchId: "03.01",
            reviewId: "review-1",
            reviewPass: 1,
          },
        ],
        fix_cycles: [
          {
            runId: "sup-run-1",
            batchId: "03.01",
            cycleId: "cycle-1-thread-a",
            attemptCount: 1,
            batchAttempt: 1,
            lastOutcome: "pending_review",
          },
          {
            runId: "sup-run-1",
            batchId: "03.01",
            cycleId: "cycle-1-thread-b",
            attemptCount: 1,
            batchAttempt: 1,
            lastOutcome: "pending_review",
          },
        ],
      },
    })

    expect(cycleState.completedReviewPasses).toBe(1)
    expect(cycleState.currentReviewPass).toBe(2)
    expect(cycleState.fixCyclesUsed).toBe(1)
    expect(cycleState.fixCyclesRemaining).toBe(0)
    expect(cycleState.hasPendingReReview).toBe(true)
    expect(cycleState.lastReviewId).toBe("review-1")
    expect(cycleState.lastFixCycleId).toBe("cycle-1-thread-a")
  })

  test("runs one automatic fix cycle for safe batch-local follow-up work", () => {
    const decision = decideSupervisorBatchFollowUp({
      config: getDefaultSupervisorConfig(),
      runId: "sup-run-1",
      batchId: "03.01",
      issues: [issue()],
      supervisorState: {
        reviewed_batches: [],
        fix_cycles: [],
      },
    })

    expect(decision.action).toBe("run_fix_cycle")
    expect(decision.reviewOutcome).toBe("changes_requested")
    expect(decision.shouldContinue).toBe(true)
    expect(decision.shouldContactUser).toBe(false)
    expect(decision.requiresReReview).toBe(true)
    expect(decision.nextFixCycleAttempt).toBe(1)
    expect(decision.nextReviewPass).toBe(2)
    expect(decision.cycleState.fixCyclesUsed).toBe(0)
    expect(decision.summary).toContain("re-review on pass 2")
  })

  test("contacts the user when post-fix review still reports stop conditions", () => {
    const config = getDefaultSupervisorConfig()
    config.escalation.contact_user_on.severity.values = ["high"]

    const decision = decideSupervisorBatchFollowUp({
      config,
      runId: "sup-run-1",
      batchId: "03.01",
      issues: [issue({ summary: "Data corruption risk", severity: "high" })],
      supervisorState: {
        reviewed_batches: [
          {
            runId: "sup-run-1",
            batchId: "03.01",
            reviewId: "review-1",
            reviewPass: 1,
          },
        ],
        fix_cycles: [
          {
            runId: "sup-run-1",
            batchId: "03.01",
            cycleId: "cycle-1",
            attemptCount: 1,
            batchAttempt: 1,
            lastOutcome: "pending_review",
          },
        ],
      },
    })

    expect(decision.action).toBe("contact_user")
    expect(decision.reviewOutcome).toBe("escalated")
    expect(decision.shouldContinue).toBe(false)
    expect(decision.shouldContactUser).toBe(true)
    expect(decision.stopReason).toBe("issues_escalated")
    expect(decision.escalation.triggers.map((trigger) => trigger.kind)).toEqual([
      "severity",
      "review_fix_limit_reached",
    ])
    expect(decision.summary).toContain("stopped for user input")
  })

  test("detects stage completion and stops without automatic stage-level fix cycles", () => {
    expect(isSupervisorStageCompleteAfterBatch(streamDocument, "03.01")).toBe(false)
    expect(isSupervisorStageCompleteAfterBatch(streamDocument, "03.02")).toBe(true)

    const decision = decideSupervisorStageBoundary({
      config: getDefaultSupervisorConfig(),
      streamDocument,
      batchId: "03.02",
    })

    expect(decision.stageCompleted).toBe(true)
    expect(decision.action).toBe("contact_user")
    expect(decision.shouldStop).toBe(true)
    expect(decision.shouldContactUser).toBe(true)
    expect(decision.shouldRunStageFixCycle).toBe(false)
    expect(decision.stopReason).toBe("completed")
    expect(decision.escalation?.triggers.map((trigger) => trigger.kind)).toEqual(["stage_completion"])
    expect(decision.summary).toContain("no automatic stage-level fix cycle")
  })
})
