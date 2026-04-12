/**
 * Structured reviewer output contract.
 *
 * Reviewer output is intentionally separate from execution state:
 * - Canonical workstream state captures task status, task reports, and runtime metadata.
 * - Reviewer output judges quality/alignment and identifies actionable issues.
 */

export const REVIEWER_SEVERITIES = ["high", "medium", "low"] as const
export const REVIEWER_DIFFICULTIES = ["complex", "regular", "trivial"] as const
export const REVIEWER_OWNERSHIPS = ["product", "engineering"] as const
export const REVIEWER_EFFORTS = ["tasks", "revision", "workstream"] as const
export const REVIEWER_ALIGNMENT_STATUSES = [
  "aligned",
  "partially_aligned",
  "misaligned",
] as const
export const REVIEWER_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const

export type ReviewerSeverity = (typeof REVIEWER_SEVERITIES)[number]
export type ReviewerDifficulty = (typeof REVIEWER_DIFFICULTIES)[number]
export type ReviewerOwnership = (typeof REVIEWER_OWNERSHIPS)[number]
export type ReviewerEffort = (typeof REVIEWER_EFFORTS)[number]
export type ReviewerAlignmentStatus = (typeof REVIEWER_ALIGNMENT_STATUSES)[number]
export type ReviewerConfidence = (typeof REVIEWER_CONFIDENCE_LEVELS)[number]

export interface ReviewerIssue {
  summary: string
  severity: ReviewerSeverity
  difficulty: ReviewerDifficulty
  ownership: ReviewerOwnership
  effort: ReviewerEffort
  evidence?: string
  suggestedAction?: string
}

export interface ReviewerAlignment {
  status: ReviewerAlignmentStatus
  rationale: string
}

/**
 * Contract returned by a review pass.
 *
 * `schemaVersion` allows future non-breaking contract evolution.
 */
export interface ReviewerResult {
  schemaVersion: "1.0"
  alignment: ReviewerAlignment
  missingOutputs: string[]
  issues: ReviewerIssue[]
  confidence?: ReviewerConfidence
  notes?: string[]
}

export interface ReviewerValidationError {
  /** Path to the invalid field (for example: "issues[0].severity") */
  path: string
  /** Human-readable validation error */
  message: string
  /** Optional expected value description */
  expected?: string
  /** Optional received value description */
  received?: string
}

export interface ReviewerNormalizeSuccess {
  success: true
  value: ReviewerResult
  errors: []
}

export interface ReviewerNormalizeFailure {
  success: false
  value: null
  errors: ReviewerValidationError[]
}

export type ReviewerNormalizeResult =
  | ReviewerNormalizeSuccess
  | ReviewerNormalizeFailure
