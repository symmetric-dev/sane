import {
  REVIEWER_DIFFICULTIES,
  REVIEWER_EFFORTS,
  REVIEWER_OWNERSHIPS,
  REVIEWER_SEVERITIES,
  type ReviewerIssue,
} from "../reviewer/types.js"
import type {
  SupervisorConfig,
  SupervisorDecisionTrigger,
  SupervisorEscalationDecision,
  SupervisorEscalationEvaluationInput,
  SupervisorIssueBreakdown,
  SupervisorIssueDimension,
  SupervisorIssueGroup,
} from "./types.js"

const DIMENSION_LABELS: Record<SupervisorIssueDimension, string> = {
  severity: "Severity",
  difficulty: "Difficulty",
  ownership: "Ownership",
  effort: "Effort",
}

type OrderedDimensionValues = {
  severity: (typeof REVIEWER_SEVERITIES)[number]
  difficulty: (typeof REVIEWER_DIFFICULTIES)[number]
  ownership: (typeof REVIEWER_OWNERSHIPS)[number]
  effort: (typeof REVIEWER_EFFORTS)[number]
}

const DIMENSION_ORDERS: {
  [K in SupervisorIssueDimension]: readonly OrderedDimensionValues[K][]
} = {
  severity: REVIEWER_SEVERITIES,
  difficulty: REVIEWER_DIFFICULTIES,
  ownership: REVIEWER_OWNERSHIPS,
  effort: REVIEWER_EFFORTS,
}

function pluralize(word: string, count: number): string {
  return count === 1 ? word : `${word}s`
}

function formatList(values: string[]): string {
  if (values.length === 0) return ""
  if (values.length === 1) return values[0]!
  if (values.length === 2) return `${values[0]} and ${values[1]}`

  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`
}

function groupIssuesByDimension<K extends SupervisorIssueDimension>(
  issues: ReviewerIssue[],
  dimension: K,
): SupervisorIssueGroup<OrderedDimensionValues[K]>[] {
  const grouped = new Map<OrderedDimensionValues[K], { count: number; summaries: Set<string> }>()

  for (const issue of issues) {
    const value = issue[dimension] as OrderedDimensionValues[K]
    const current = grouped.get(value) ?? { count: 0, summaries: new Set<string>() }
    current.count += 1
    current.summaries.add(issue.summary)
    grouped.set(value, current)
  }

  return DIMENSION_ORDERS[dimension]
    .filter((value) => grouped.has(value))
    .map((value) => {
      const entry = grouped.get(value)!
      const summaries = Array.from(entry.summaries).sort((left, right) =>
        left.localeCompare(right),
      )

      return {
        value,
        count: entry.count,
        summaries,
      }
    })
}

export function buildSupervisorIssueBreakdown(issues: ReviewerIssue[]): SupervisorIssueBreakdown {
  return {
    totalIssues: issues.length,
    severity: groupIssuesByDimension(issues, "severity"),
    difficulty: groupIssuesByDimension(issues, "difficulty"),
    ownership: groupIssuesByDimension(issues, "ownership"),
    effort: groupIssuesByDimension(issues, "effort"),
  }
}

function evaluateThreshold<K extends SupervisorIssueDimension>(
  issues: ReviewerIssue[],
  config: SupervisorConfig,
  dimension: K,
): SupervisorDecisionTrigger | null {
  const threshold = config.escalation.contact_user_on[dimension]
  if (threshold.values.length === 0) {
    return null
  }

  const allowedValues = new Set<string>(threshold.values)
  const matched = issues.filter((issue) => allowedValues.has(issue[dimension]))
  if (matched.length < threshold.min_count) {
    return null
  }

  return {
    kind: dimension,
    count: matched.length,
    matchedValues: [...threshold.values],
    summary: `${DIMENSION_LABELS[dimension]} triggered contact-user (${matched.length} ${pluralize("issue", matched.length)} matched ${formatList(threshold.values)}).`,
  }
}

function buildGroupedFindingsLines(issueBreakdown: SupervisorIssueBreakdown): string[] {
  const sections: SupervisorIssueDimension[] = ["severity", "difficulty", "ownership", "effort"]
  const lines: string[] = []

  for (const section of sections) {
    lines.push(`## ${DIMENSION_LABELS[section]}`)

    const groups = issueBreakdown[section]
    if (groups.length === 0) {
      lines.push("- none")
      lines.push("")
      continue
    }

    for (const group of groups) {
      lines.push(
        `- ${group.value} (${group.count} ${pluralize("issue", group.count)}): ${group.summaries.join("; ")}`,
      )
    }

    lines.push("")
  }

  return lines
}

function buildDecisionSummary(
  outcome: SupervisorEscalationDecision["outcome"],
  triggers: SupervisorDecisionTrigger[],
  issueBreakdown: SupervisorIssueBreakdown,
  fixCyclesUsed: number,
  config: SupervisorConfig,
): { chatSummary: string; recordSummary: string } {
  const headline =
    outcome === "contact_user"
      ? "Supervisor stopped and needs user input before continuing."
      : "Supervisor continued automatically."

  const triggerLines =
    triggers.length === 0
      ? ["- No contact-user thresholds were met."]
      : triggers.map((trigger) => `- ${trigger.summary}`)

  const limitLine = `Fix cycles used: ${fixCyclesUsed}/${config.review_limits.max_fix_cycles_per_batch}.`
  const groupedFindings = buildGroupedFindingsLines(issueBreakdown)

  const chatSummary = [
    headline,
    "",
    "## Decision",
    ...triggerLines,
    `- ${limitLine}`,
    "",
    "## Findings",
    ...groupedFindings,
  ]
    .join("\n")
    .trim()

  const recordSummary =
    outcome === "contact_user"
      ? `Stopped for user input: ${triggers.map((trigger) => trigger.summary).join(" ")}`
      : triggers.length === 0
        ? "Continued automatically: no contact-user thresholds were met."
        : `Continued automatically despite non-blocking triggers: ${triggers.map((trigger) => trigger.summary).join(" ")}`

  return {
    chatSummary,
    recordSummary,
  }
}

export function evaluateSupervisorEscalation(
  input: SupervisorEscalationEvaluationInput,
): SupervisorEscalationDecision {
  const { issues, config } = input
  const stageCompleted = input.stageCompleted === true
  const fixCyclesUsed = input.fixCyclesUsed ?? 0
  const issueBreakdown = buildSupervisorIssueBreakdown(issues)

  const triggers: SupervisorDecisionTrigger[] = []
  for (const dimension of ["severity", "difficulty", "ownership", "effort"] as const) {
    const trigger = evaluateThreshold(issues, config, dimension)
    if (trigger) {
      triggers.push(trigger)
    }
  }

  if (
    stageCompleted &&
    config.stage_completion.contact_user &&
    config.escalation.contact_user_on.stage_completion
  ) {
    triggers.push({
      kind: "stage_completion",
      summary: "Stage completion triggered contact-user.",
    })
  }

  if (
    config.escalation.contact_user_on.review_fix_limit_reached &&
    config.review_limits.max_fix_cycles_per_batch > 0 &&
    fixCyclesUsed >= config.review_limits.max_fix_cycles_per_batch
  ) {
    triggers.push({
      kind: "review_fix_limit_reached",
      summary: `Fix-cycle limit reached (${fixCyclesUsed}/${config.review_limits.max_fix_cycles_per_batch}).`,
    })
  }

  const outcome: SupervisorEscalationDecision["outcome"] =
    triggers.length > 0 ? "contact_user" : "continue"

  const { chatSummary, recordSummary } = buildDecisionSummary(
    outcome,
    triggers,
    issueBreakdown,
    fixCyclesUsed,
    config,
  )

  return {
    outcome,
    shouldContactUser: outcome === "contact_user",
    shouldContinue: outcome === "continue",
    triggers,
    issueBreakdown,
    chatSummary,
    recordSummary,
  }
}
