import { describe, expect, test } from "bun:test"
import type { ReviewerIssue } from "../../src/lib/reviewer/types"
import {
  buildSupervisorIssueBreakdown,
  evaluateSupervisorEscalation,
  getDefaultSupervisorConfig,
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

describe("supervisor escalation", () => {
  test("continues automatically for engineering-owned regular task issues", () => {
    const decision = evaluateSupervisorEscalation({
      config: getDefaultSupervisorConfig(),
      issues: [issue()],
    })

    expect(decision.outcome).toBe("continue")
    expect(decision.shouldContinue).toBe(true)
    expect(decision.shouldContactUser).toBe(false)
    expect(decision.triggers).toEqual([])
    expect(decision.recordSummary).toBe(
      "Continued automatically: no contact-user thresholds were met.",
    )
  })

  test("contacts user when product-owned findings are present", () => {
    const decision = evaluateSupervisorEscalation({
      config: getDefaultSupervisorConfig(),
      issues: [issue({ summary: "Need product call", ownership: "product" })],
    })

    expect(decision.outcome).toBe("contact_user")
    expect(decision.triggers.map((trigger) => trigger.kind)).toEqual(["ownership"])
    expect(decision.recordSummary).toContain("Stopped for user input")
    expect(decision.chatSummary).toContain("## Ownership")
    expect(decision.chatSummary).toContain("product (1 issue): Need product call")
  })

  test("contacts user when complex or revision-level issues are present", () => {
    const decision = evaluateSupervisorEscalation({
      config: getDefaultSupervisorConfig(),
      issues: [
        issue({ summary: "Complex architecture mismatch", difficulty: "complex" }),
        issue({ summary: "Needs broader revision", effort: "revision" }),
      ],
    })

    expect(decision.outcome).toBe("contact_user")
    expect(decision.triggers.map((trigger) => trigger.kind)).toEqual(["difficulty", "effort"])
  })

  test("contacts user on stage completion even without issues", () => {
    const decision = evaluateSupervisorEscalation({
      config: getDefaultSupervisorConfig(),
      issues: [],
      stageCompleted: true,
    })

    expect(decision.outcome).toBe("contact_user")
    expect(decision.triggers.map((trigger) => trigger.kind)).toEqual(["stage_completion"])
    expect(decision.chatSummary).toContain("Stage completion triggered contact-user")
  })

  test("contacts user when the configured fix-cycle limit is reached", () => {
    const decision = evaluateSupervisorEscalation({
      config: getDefaultSupervisorConfig(),
      issues: [issue()],
      fixCyclesUsed: 1,
    })

    expect(decision.outcome).toBe("contact_user")
    expect(decision.triggers.map((trigger) => trigger.kind)).toEqual(["review_fix_limit_reached"])
    expect(decision.chatSummary).toContain("Fix-cycle limit reached (1/1)")
  })

  test("does not trigger the fix-cycle rule when automatic retries are disabled", () => {
    const config = getDefaultSupervisorConfig()
    config.review_limits.max_fix_cycles_per_batch = 0

    const decision = evaluateSupervisorEscalation({
      config,
      issues: [issue()],
      fixCyclesUsed: 3,
    })

    expect(decision.outcome).toBe("continue")
    expect(decision.triggers).toEqual([])
  })

  test("respects min_count thresholds for issue-based escalation", () => {
    const config = getDefaultSupervisorConfig()
    config.escalation.contact_user_on.severity = {
      values: ["high"],
      min_count: 2,
    }

    const continueDecision = evaluateSupervisorEscalation({
      config,
      issues: [issue({ severity: "high", summary: "single high issue" })],
    })

    expect(continueDecision.outcome).toBe("continue")

    const contactDecision = evaluateSupervisorEscalation({
      config,
      issues: [
        issue({ severity: "high", summary: "first high issue" }),
        issue({ severity: "high", summary: "second high issue" }),
      ],
    })

    expect(contactDecision.outcome).toBe("contact_user")
    expect(contactDecision.triggers.map((trigger) => trigger.kind)).toEqual(["severity"])
  })

  test("builds deterministic grouped findings across all reviewer dimensions", () => {
    const breakdown = buildSupervisorIssueBreakdown([
      issue({ summary: "Missing API edge case", severity: "high", difficulty: "complex" }),
      issue({ summary: "Add regression coverage", severity: "low", effort: "revision" }),
      issue({ summary: "Need PM signoff", ownership: "product", effort: "workstream" }),
    ])

    expect(breakdown.totalIssues).toBe(3)
    expect(breakdown.severity.map((group) => group.value)).toEqual(["high", "medium", "low"])
    expect(breakdown.difficulty.map((group) => group.value)).toEqual(["complex", "regular"])
    expect(breakdown.ownership.map((group) => group.value)).toEqual(["product", "engineering"])
    expect(breakdown.effort.map((group) => group.value)).toEqual([
      "tasks",
      "revision",
      "workstream",
    ])
  })
})
