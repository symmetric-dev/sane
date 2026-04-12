import { describe, expect, test } from "bun:test"
import {
  normalizeReviewerResult,
  parseReviewerResult,
} from "../src/lib/reviewer/output.js"

describe("Reviewer output contract", () => {
  test("accepts valid reviewer output payload", () => {
    const result = normalizeReviewerResult({
      schemaVersion: "1.0",
      alignment: {
        status: "aligned",
        rationale: "Delivered all required outputs and stayed on scope.",
      },
      missingOutputs: [],
      issues: [
        {
          summary: "Test evidence was missing for one helper",
          severity: "low",
          difficulty: "trivial",
          ownership: "engineering",
          effort: "revision",
        },
      ],
      confidence: "medium",
      notes: ["Follow-up is optional but recommended."],
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.value.alignment.status).toBe("aligned")
    expect(result.value.issues[0]?.effort).toBe("revision")
  })

  test("normalizes enum values from mixed casing and spacing", () => {
    const result = normalizeReviewerResult({
      schemaVersion: "1.0",
      alignment: {
        status: " Partially_Aligned ",
        rationale: "Some outputs are present but one expected artifact is missing.",
      },
      missingOutputs: ["review-report.json"],
      issues: [
        {
          summary: "Missing output artifact",
          severity: " HIGH ",
          difficulty: " Regular ",
          ownership: " Product ",
          effort: " Workstream ",
        },
      ],
      confidence: " Low ",
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.value.alignment.status).toBe("partially_aligned")
    expect(result.value.issues[0]?.severity).toBe("high")
    expect(result.value.issues[0]?.difficulty).toBe("regular")
    expect(result.value.issues[0]?.ownership).toBe("product")
    expect(result.value.issues[0]?.effort).toBe("workstream")
    expect(result.value.confidence).toBe("low")
  })

  test("reports precise validation errors for malformed payload", () => {
    const result = normalizeReviewerResult({
      schemaVersion: "2.0",
      alignment: {
        status: "off-track",
      },
      missingOutputs: "REPORT.md",
      issues: [
        {
          summary: "",
          severity: "critical",
          difficulty: "hard",
          ownership: "ops",
          effort: "big",
        },
      ],
    })

    expect(result.success).toBe(false)
    if (result.success) return

    const paths = result.errors.map((error) => error.path)
    expect(paths).toContain("schemaVersion")
    expect(paths).toContain("alignment.status")
    expect(paths).toContain("alignment.rationale")
    expect(paths).toContain("missingOutputs")
    expect(paths).toContain("issues[0].summary")
    expect(paths).toContain("issues[0].severity")
    expect(paths).toContain("issues[0].difficulty")
    expect(paths).toContain("issues[0].ownership")
    expect(paths).toContain("issues[0].effort")
  })

  test("parses fenced JSON reviewer output", () => {
    const text = `\`\`\`json
{
  "schemaVersion": "1.0",
  "alignment": {
    "status": "misaligned",
    "rationale": "Work omitted required deliverables from the plan."
  },
  "missingOutputs": ["tasks.json"],
  "issues": []
}
\`\`\``

    const result = parseReviewerResult(text)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.value.alignment.status).toBe("misaligned")
    expect(result.value.missingOutputs).toEqual(["tasks.json"])
  })

  test("normalizes optional issue evidence and suggested action strings", () => {
    const result = normalizeReviewerResult({
      schemaVersion: "1.0",
      alignment: {
        status: "aligned",
        rationale: "Payload includes optional issue fields.",
      },
      missingOutputs: [],
      issues: [
        {
          summary: "Non-blocking note",
          severity: "low",
          difficulty: "trivial",
          ownership: "engineering",
          effort: "tasks",
          evidence: "  logs/test-run.txt  ",
          suggestedAction: "  monitor in next iteration  ",
        },
      ],
      notes: ["  first note  "],
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.value.issues[0]?.evidence).toBe("logs/test-run.txt")
    expect(result.value.issues[0]?.suggestedAction).toBe("monitor in next iteration")
    expect(result.value.notes).toEqual(["first note"])
  })

  test("rejects invalid JSON payload with parser error", () => {
    const result = parseReviewerResult("{ invalid-json }")

    expect(result.success).toBe(false)
    if (result.success) return

    expect(result.errors[0]?.path).toBe("$")
    expect(result.errors[0]?.message).toContain("Invalid JSON payload")
  })

  test("rejects unknown keys in the machine-consumable contract", () => {
    const result = normalizeReviewerResult({
      schemaVersion: "1.0",
      alignment: {
        status: "aligned",
        rationale: "Everything expected was delivered.",
        extraField: true,
      },
      missingOutputs: [],
      issues: [
        {
          summary: "Minor follow-up",
          severity: "low",
          difficulty: "trivial",
          ownership: "engineering",
          effort: "revision",
          unexpected: "nope",
        },
      ],
      confidence: "high",
      extraTopLevel: "nope",
    })

    expect(result.success).toBe(false)
    if (result.success) return

    const paths = result.errors.map((error) => error.path)
    expect(paths).toContain("extraTopLevel")
    expect(paths).toContain("alignment.extraField")
    expect(paths).toContain("issues[0].unexpected")
  })
})
