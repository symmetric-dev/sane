import { parseBatchId } from "../cli-utils.js"
import type { StreamDocument } from "../types.js"
import { evaluateSupervisorEscalation } from "./escalation.js"
import type {
  SupervisorBatchCycleState,
  SupervisorBatchFollowUpDecision,
  SupervisorBatchFollowUpInput,
  SupervisorConfig,
  SupervisorStageBoundaryDecision,
  SupervisorStageBoundaryInput,
} from "./types.js"

function getBatchAttemptValue(fixCycle: {
  attemptCount: number
  batchAttempt?: number
}): number {
  return fixCycle.batchAttempt ?? fixCycle.attemptCount
}

export function getSupervisorBatchCycleState(
  input: Pick<SupervisorBatchFollowUpInput, "config" | "supervisorState" | "runId" | "batchId">,
): SupervisorBatchCycleState {
  const { config, supervisorState, runId, batchId } = input

  const reviewedBatches = supervisorState.reviewed_batches
    .filter((review) => review.runId === runId && review.batchId === batchId)
    .sort((left, right) => right.reviewPass - left.reviewPass)

  const fixCycles = supervisorState.fix_cycles.filter(
    (fixCycle) => fixCycle.runId === runId && fixCycle.batchId === batchId,
  )

  const distinctBatchAttempts = new Set(
    fixCycles.map((fixCycle) => getBatchAttemptValue(fixCycle)).filter((value) => value > 0),
  )

  const lastFixCycle = [...fixCycles].sort(
    (left, right) => getBatchAttemptValue(right) - getBatchAttemptValue(left),
  )[0]

  const completedReviewPasses = reviewedBatches[0]?.reviewPass ?? 0
  const fixCyclesUsed = distinctBatchAttempts.size

  return {
    completedReviewPasses,
    currentReviewPass: completedReviewPasses + 1,
    fixCyclesUsed,
    fixCyclesRemaining: Math.max(0, config.review_limits.max_fix_cycles_per_batch - fixCyclesUsed),
    hasPendingReReview: fixCycles.some((fixCycle) => fixCycle.lastOutcome === "pending_review"),
    lastReviewId: reviewedBatches[0]?.reviewId,
    lastFixCycleId: lastFixCycle?.cycleId,
  }
}

function getFixCycleLimitSummary(config: SupervisorConfig, cycleState: SupervisorBatchCycleState): string {
  return `Fix cycles used: ${cycleState.fixCyclesUsed}/${config.review_limits.max_fix_cycles_per_batch}.`
}

function getEscalationStopReason(
  decision: ReturnType<typeof evaluateSupervisorEscalation>,
): "review_limit_reached" | "issues_escalated" {
  return decision.triggers.every((trigger) => trigger.kind === "review_fix_limit_reached")
    ? "review_limit_reached"
    : "issues_escalated"
}

export function decideSupervisorBatchFollowUp(
  input: SupervisorBatchFollowUpInput,
): SupervisorBatchFollowUpDecision {
  const cycleState = getSupervisorBatchCycleState(input)
  const escalation = evaluateSupervisorEscalation({
    config: input.config,
    issues: input.issues,
    fixCyclesUsed: cycleState.fixCyclesUsed,
  })

  if (input.issues.length === 0) {
    return {
      action: "approve_batch",
      reviewOutcome: "approved",
      cycleState,
      escalation,
      shouldContactUser: false,
      shouldContinue: true,
      requiresReReview: false,
      summary: `Batch ${input.batchId} approved on review pass ${cycleState.currentReviewPass}. ${getFixCycleLimitSummary(input.config, cycleState)}`,
    }
  }

  if (escalation.shouldContactUser) {
    return {
      action: "contact_user",
      reviewOutcome: "escalated",
      cycleState,
      escalation,
      shouldContactUser: true,
      shouldContinue: false,
      requiresReReview: false,
      stopReason: getEscalationStopReason(escalation),
      summary: `Batch ${input.batchId} stopped for user input after review pass ${cycleState.currentReviewPass}. ${escalation.recordSummary}`,
    }
  }

  if (cycleState.fixCyclesRemaining === 0) {
    return {
      action: "contact_user",
      reviewOutcome: "escalated",
      cycleState,
      escalation,
      shouldContactUser: true,
      shouldContinue: false,
      requiresReReview: false,
      stopReason: "review_limit_reached",
      summary: `Batch ${input.batchId} cannot start another automatic fix cycle. ${getFixCycleLimitSummary(input.config, cycleState)}`,
    }
  }

  return {
    action: "run_fix_cycle",
    reviewOutcome: "changes_requested",
    cycleState,
    escalation,
    shouldContactUser: false,
    shouldContinue: true,
    requiresReReview: true,
    nextFixCycleAttempt: cycleState.fixCyclesUsed + 1,
    nextReviewPass: cycleState.currentReviewPass + 1,
    summary: `Batch ${input.batchId} will run automatic fix cycle ${cycleState.fixCyclesUsed + 1} and then re-review on pass ${cycleState.currentReviewPass + 1}. ${getFixCycleLimitSummary(input.config, cycleState)}`,
  }
}

function getStageForBatch(streamDocument: Pick<StreamDocument, "stages">, batchId: string) {
  const parsed = parseBatchId(batchId)
  if (!parsed) {
    throw new Error(`Invalid batch ID "${batchId}". Expected format SS.BB.`)
  }

  const stage = streamDocument.stages.find((value) => value.id === parsed.stage)
  if (!stage) {
    throw new Error(`Stage ${parsed.stage.toString().padStart(2, "0")} not found for batch ${batchId}.`)
  }

  const batch = stage.batches.find((value) => value.id === parsed.batch)
  if (!batch) {
    throw new Error(`Batch ${batchId} not found in stage ${parsed.stage.toString().padStart(2, "0")}.`)
  }

  return { stage, batch }
}

export function isSupervisorStageCompleteAfterBatch(
  streamDocument: Pick<StreamDocument, "stages">,
  batchId: string,
): boolean {
  const { stage, batch } = getStageForBatch(streamDocument, batchId)
  return stage.batches[stage.batches.length - 1]?.id === batch.id
}

export function decideSupervisorStageBoundary(
  input: SupervisorStageBoundaryInput,
): SupervisorStageBoundaryDecision {
  const stageCompleted = isSupervisorStageCompleteAfterBatch(input.streamDocument, input.batchId)
  if (!stageCompleted) {
    return {
      stageCompleted: false,
      action: "continue",
      shouldStop: false,
      shouldContactUser: false,
      shouldRunStageFixCycle: false,
      summary: `Stage remains in progress after batch ${input.batchId}; supervisor may continue within the current stage.`,
    }
  }

  const escalation = evaluateSupervisorEscalation({
    config: input.config,
    issues: input.issues ?? [],
    stageCompleted: true,
    fixCyclesUsed: input.fixCyclesUsed ?? 0,
  })

  const shouldContactUser = input.config.stage_completion.contact_user || escalation.shouldContactUser
  const shouldStop = input.config.stage_completion.stop || shouldContactUser

  return {
    stageCompleted: true,
    action: shouldContactUser ? "contact_user" : shouldStop ? "stop" : "continue",
    shouldStop,
    shouldContactUser,
    shouldRunStageFixCycle: false,
    stopReason: shouldStop ? "completed" : undefined,
    escalation,
    summary: shouldContactUser
      ? `Stage completed at batch ${input.batchId}. Default v1 behavior is to contact the user and stop; no automatic stage-level fix cycle will run.`
      : shouldStop
        ? `Stage completed at batch ${input.batchId}. Supervisor will stop at the stage boundary without starting an automatic stage-level fix cycle.`
        : `Stage completed at batch ${input.batchId}.`,
  }
}
