import {
  REVIEWER_ALIGNMENT_STATUSES,
  REVIEWER_CONFIDENCE_LEVELS,
  REVIEWER_DIFFICULTIES,
  REVIEWER_EFFORTS,
  REVIEWER_OWNERSHIPS,
  REVIEWER_SEVERITIES,
  type ReviewerAlignmentStatus,
  type ReviewerConfidence,
  type ReviewerDifficulty,
  type ReviewerEffort,
  type ReviewerIssue,
  type ReviewerNormalizeResult,
  type ReviewerOwnership,
  type ReviewerResult,
  type ReviewerSeverity,
  type ReviewerValidationError,
} from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  errors: ReviewerValidationError[],
): void {
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue

    const fullPath = path === "$" ? key : `${path}.${key}`
    errors.push({
      path: fullPath,
      message: `Unexpected property \"${key}\"`,
      expected: allowedKeys.join(", "),
      received: key,
    })
  }
}

function asNonEmptyString(
  value: unknown,
  path: string,
  errors: ReviewerValidationError[],
): string | null {
  if (typeof value !== "string") {
    errors.push({
      path,
      message: "Expected string",
      expected: "string",
      received: typeof value,
    })
    return null
  }

  const normalized = value.trim()
  if (normalized.length === 0) {
    errors.push({
      path,
      message: "Expected non-empty string",
      expected: "non-empty string",
      received: "empty string",
    })
    return null
  }

  return normalized
}

function asOptionalNonEmptyString(
  value: unknown,
  path: string,
  errors: ReviewerValidationError[],
): string | undefined {
  if (value === undefined) return undefined
  return asNonEmptyString(value, path, errors) ?? undefined
}

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: ReviewerValidationError[],
): T | null {
  if (typeof value !== "string") {
    errors.push({
      path,
      message: "Expected string enum value",
      expected: allowed.join(" | "),
      received: typeof value,
    })
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (!allowed.includes(normalized as T)) {
    errors.push({
      path,
      message: `Invalid enum value \"${value}\"`,
      expected: allowed.join(" | "),
      received: value,
    })
    return null
  }

  return normalized as T
}

function normalizeStringArray(
  value: unknown,
  path: string,
  errors: ReviewerValidationError[],
): string[] | null {
  if (!Array.isArray(value)) {
    errors.push({
      path,
      message: "Expected array of strings",
      expected: "string[]",
      received: Array.isArray(value) ? "array" : typeof value,
    })
    return null
  }

  const normalized: string[] = []
  for (let i = 0; i < value.length; i++) {
    const item = asNonEmptyString(value[i], `${path}[${i}]`, errors)
    if (item) normalized.push(item)
  }

  return normalized
}

function normalizeIssue(
  value: unknown,
  index: number,
  errors: ReviewerValidationError[],
): ReviewerIssue | null {
  const path = `issues[${index}]`
  if (!isRecord(value)) {
    errors.push({
      path,
      message: "Expected object",
      expected: "ReviewerIssue",
      received: Array.isArray(value) ? "array" : typeof value,
    })
    return null
  }

  rejectUnknownKeys(
    value,
    ["summary", "severity", "difficulty", "ownership", "effort", "evidence", "suggestedAction"],
    path,
    errors,
  )

  const summary = asNonEmptyString(value.summary, `${path}.summary`, errors)
  const severity = normalizeEnum<ReviewerSeverity>(
    value.severity,
    REVIEWER_SEVERITIES,
    `${path}.severity`,
    errors,
  )
  const difficulty = normalizeEnum<ReviewerDifficulty>(
    value.difficulty,
    REVIEWER_DIFFICULTIES,
    `${path}.difficulty`,
    errors,
  )
  const ownership = normalizeEnum<ReviewerOwnership>(
    value.ownership,
    REVIEWER_OWNERSHIPS,
    `${path}.ownership`,
    errors,
  )
  const effort = normalizeEnum<ReviewerEffort>(
    value.effort,
    REVIEWER_EFFORTS,
    `${path}.effort`,
    errors,
  )
  const evidence = asOptionalNonEmptyString(value.evidence, `${path}.evidence`, errors)
  const suggestedAction = asOptionalNonEmptyString(
    value.suggestedAction,
    `${path}.suggestedAction`,
    errors,
  )

  if (!summary || !severity || !difficulty || !ownership || !effort) {
    return null
  }

  return {
    summary,
    severity,
    difficulty,
    ownership,
    effort,
    evidence,
    suggestedAction,
  }
}

export function normalizeReviewerResult(input: unknown): ReviewerNormalizeResult {
  const errors: ReviewerValidationError[] = []

  if (!isRecord(input)) {
    return {
      success: false,
      value: null,
      errors: [
        {
          path: "$",
          message: "Expected top-level object",
          expected: "ReviewerResult",
          received: Array.isArray(input) ? "array" : typeof input,
        },
      ],
    }
  }

  rejectUnknownKeys(
    input,
    ["schemaVersion", "alignment", "missingOutputs", "issues", "confidence", "notes"],
    "$",
    errors,
  )

  const schemaVersion = asNonEmptyString(input.schemaVersion, "schemaVersion", errors)
  if (schemaVersion && schemaVersion !== "1.0") {
    errors.push({
      path: "schemaVersion",
      message: `Unsupported schema version \"${schemaVersion}\"`,
      expected: "1.0",
      received: schemaVersion,
    })
  }

  let alignmentStatus: ReviewerAlignmentStatus | null = null
  let alignmentRationale: string | null = null

  if (!isRecord(input.alignment)) {
    errors.push({
      path: "alignment",
      message: "Expected object",
      expected: "{ status, rationale }",
      received: Array.isArray(input.alignment) ? "array" : typeof input.alignment,
    })
  } else {
    rejectUnknownKeys(input.alignment, ["status", "rationale"], "alignment", errors)

    alignmentStatus = normalizeEnum<ReviewerAlignmentStatus>(
      input.alignment.status,
      REVIEWER_ALIGNMENT_STATUSES,
      "alignment.status",
      errors,
    )
    alignmentRationale = asNonEmptyString(
      input.alignment.rationale,
      "alignment.rationale",
      errors,
    )
  }

  const missingOutputs = normalizeStringArray(
    input.missingOutputs,
    "missingOutputs",
    errors,
  )

  if (!Array.isArray(input.issues)) {
    errors.push({
      path: "issues",
      message: "Expected array",
      expected: "ReviewerIssue[]",
      received: Array.isArray(input.issues) ? "array" : typeof input.issues,
    })
  }

  const issues: ReviewerIssue[] = []
  if (Array.isArray(input.issues)) {
    for (let i = 0; i < input.issues.length; i++) {
      const issue = normalizeIssue(input.issues[i], i, errors)
      if (issue) issues.push(issue)
    }
  }

  const confidence =
    input.confidence === undefined
      ? undefined
      : normalizeEnum<ReviewerConfidence>(
          input.confidence,
          REVIEWER_CONFIDENCE_LEVELS,
          "confidence",
          errors,
        ) ?? undefined

  const notes =
    input.notes === undefined
      ? undefined
      : normalizeStringArray(input.notes, "notes", errors) ?? undefined

  if (errors.length > 0) {
    return {
      success: false,
      value: null,
      errors,
    }
  }

  return {
    success: true,
    value: {
      schemaVersion: "1.0",
      alignment: {
        status: alignmentStatus!,
        rationale: alignmentRationale!,
      },
      missingOutputs: missingOutputs!,
      issues,
      confidence,
      notes,
    },
    errors: [],
  }
}

function extractReviewJsonCandidate(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith("```")) {
    return trimmed
  }

  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i)
  if (!match || !match[1]) {
    return trimmed
  }

  return match[1].trim()
}

export function parseReviewerResult(text: string): ReviewerNormalizeResult {
  const candidate = extractReviewJsonCandidate(text)

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (error) {
    return {
      success: false,
      value: null,
      errors: [
        {
          path: "$",
          message: "Invalid JSON payload",
          expected: "valid ReviewerResult JSON",
          received: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }

  return normalizeReviewerResult(parsed)
}
