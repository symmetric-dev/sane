/**
 * Supervisor policy configuration types.
 *
 * The v1 supervisor policy is intentionally explicit and conservative.
 * Config is stored at the repository level in work/supervisor.json.
 */

import {
  REVIEWER_DIFFICULTIES,
  REVIEWER_EFFORTS,
  REVIEWER_OWNERSHIPS,
  REVIEWER_SEVERITIES,
  type ReviewerIssue,
  type ReviewerDifficulty,
  type ReviewerEffort,
  type ReviewerOwnership,
  type ReviewerSeverity,
} from "../reviewer/types.js"
import type {
  StreamDocument,
  SupervisorReviewOutcome,
  SupervisorStageStopReason,
} from "../types.js"

export const SUPERVISOR_CONFIG_FILE = "work/supervisor.json"

export const SUPERVISOR_SEVERITY_VALUES = REVIEWER_SEVERITIES
export type SupervisorSeverity = ReviewerSeverity

export const SUPERVISOR_DIFFICULTY_VALUES = REVIEWER_DIFFICULTIES
export type SupervisorDifficulty = ReviewerDifficulty

export const SUPERVISOR_OWNERSHIP_VALUES = REVIEWER_OWNERSHIPS
export type SupervisorOwnership = ReviewerOwnership

export const SUPERVISOR_EFFORT_VALUES = REVIEWER_EFFORTS
export type SupervisorEffort = ReviewerEffort

export interface SupervisorIssueTaxonomy {
  severity: SupervisorSeverity[]
  difficulty: SupervisorDifficulty[]
  ownership: SupervisorOwnership[]
  effort: SupervisorEffort[]
}

export interface SupervisorEscalationThreshold<TValue extends string> {
  values: TValue[]
  min_count: number
}

export interface SupervisorReviewLimits {
  /** Maximum automatic review/fix retries per batch. Set to 0 to disable. */
  max_fix_cycles_per_batch: number
}

export interface SupervisorStageCompletionConfig {
  /** Stop supervisor automation when a stage boundary is reached. */
  stop: boolean
  /** Contact the user when a stage boundary is reached. */
  contact_user: boolean
}

export interface SupervisorContactUserConditions {
  severity: SupervisorEscalationThreshold<SupervisorSeverity>
  difficulty: SupervisorEscalationThreshold<SupervisorDifficulty>
  ownership: SupervisorEscalationThreshold<SupervisorOwnership>
  effort: SupervisorEscalationThreshold<SupervisorEffort>
  review_fix_limit_reached: boolean
  stage_completion: boolean
}

export interface SupervisorEscalationConfig {
  contact_user_on: SupervisorContactUserConditions
}

export interface SupervisorConfig {
  issue_taxonomy: SupervisorIssueTaxonomy
  review_limits: SupervisorReviewLimits
  stage_completion: SupervisorStageCompletionConfig
  escalation: SupervisorEscalationConfig
}

export interface SupervisorIssueTaxonomyInput {
  severity?: string[]
  difficulty?: string[]
  ownership?: string[]
  effort?: string[]
}

export interface SupervisorEscalationThresholdInput {
  values?: string[]
  min_count?: number
}

export interface SupervisorContactUserConditionsInput {
  severity?: SupervisorEscalationThresholdInput
  difficulty?: SupervisorEscalationThresholdInput
  ownership?: SupervisorEscalationThresholdInput
  effort?: SupervisorEscalationThresholdInput
  review_fix_limit_reached?: boolean
  stage_completion?: boolean
}

export interface SupervisorEscalationConfigInput {
  contact_user_on?: SupervisorContactUserConditionsInput
}

export interface SupervisorConfigInput {
  issue_taxonomy?: SupervisorIssueTaxonomyInput
  review_limits?: Partial<SupervisorReviewLimits>
  stage_completion?: Partial<SupervisorStageCompletionConfig>
  escalation?: SupervisorEscalationConfigInput
}

export type SupervisorIssueDimension = keyof SupervisorIssueTaxonomy

export type SupervisorDecisionOutcome = "continue" | "contact_user"

export type SupervisorDecisionTriggerKind =
  | SupervisorIssueDimension
  | "review_fix_limit_reached"
  | "stage_completion"

export interface SupervisorIssueGroup<TValue extends string = string> {
  value: TValue
  count: number
  summaries: string[]
}

export interface SupervisorIssueBreakdown {
  totalIssues: number
  severity: SupervisorIssueGroup<SupervisorSeverity>[]
  difficulty: SupervisorIssueGroup<SupervisorDifficulty>[]
  ownership: SupervisorIssueGroup<SupervisorOwnership>[]
  effort: SupervisorIssueGroup<SupervisorEffort>[]
}

export interface SupervisorDecisionTrigger {
  kind: SupervisorDecisionTriggerKind
  summary: string
  count?: number
  matchedValues?: string[]
}

export interface SupervisorEscalationEvaluationInput {
  issues: Array<{
    summary: string
    severity: SupervisorSeverity
    difficulty: SupervisorDifficulty
    ownership: SupervisorOwnership
    effort: SupervisorEffort
  }>
  config: SupervisorConfig
  stageCompleted?: boolean
  fixCyclesUsed?: number
}

export interface SupervisorEscalationDecision {
  outcome: SupervisorDecisionOutcome
  shouldContactUser: boolean
  shouldContinue: boolean
  triggers: SupervisorDecisionTrigger[]
  issueBreakdown: SupervisorIssueBreakdown
  chatSummary: string
  recordSummary: string
}

export interface SupervisorBatchCycleState {
  completedReviewPasses: number
  currentReviewPass: number
  fixCyclesUsed: number
  fixCyclesRemaining: number
  hasPendingReReview: boolean
  lastReviewId?: string
  lastFixCycleId?: string
}

export type SupervisorBatchFollowUpAction =
  | "approve_batch"
  | "run_fix_cycle"
  | "contact_user"

export interface SupervisorBatchFollowUpInput {
  config: SupervisorConfig
  supervisorState: {
    reviewed_batches: Array<{ runId: string; batchId: string; reviewId: string; reviewPass: number }>
    fix_cycles: Array<{
      runId: string
      batchId: string
      cycleId: string
      attemptCount: number
      batchAttempt?: number
      lastOutcome: "pending_review" | "accepted" | "rejected" | "escalated" | "stopped"
    }>
  }
  runId: string
  batchId: string
  issues: ReviewerIssue[]
}

export interface SupervisorBatchFollowUpDecision {
  action: SupervisorBatchFollowUpAction
  reviewOutcome: SupervisorReviewOutcome
  cycleState: SupervisorBatchCycleState
  escalation: SupervisorEscalationDecision
  shouldContactUser: boolean
  shouldContinue: boolean
  requiresReReview: boolean
  nextFixCycleAttempt?: number
  nextReviewPass?: number
  stopReason?: SupervisorStageStopReason
  summary: string
}

export type SupervisorStageBoundaryAction = "continue" | "stop" | "contact_user"

export interface SupervisorStageBoundaryInput {
  config: SupervisorConfig
  streamDocument: Pick<StreamDocument, "stages">
  batchId: string
  issues?: ReviewerIssue[]
  fixCyclesUsed?: number
}

export interface SupervisorStageBoundaryDecision {
  stageCompleted: boolean
  action: SupervisorStageBoundaryAction
  shouldStop: boolean
  shouldContactUser: boolean
  shouldRunStageFixCycle: false
  stopReason?: SupervisorStageStopReason
  escalation?: SupervisorEscalationDecision
  summary: string
}
