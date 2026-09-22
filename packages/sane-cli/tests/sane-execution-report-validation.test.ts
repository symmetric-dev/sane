import { describe, expect, test } from "bun:test"
import { jobSpecTitle, validateExecutionReport } from "../src/sane-execution-report-validation.ts"

const report = "# Job 01: Investigate Report\n\n## Accomplished\nDiscovery completed; implementation failed.\n## Found Issues\nBuild failed.\n## Notes\nNone\n## Implementation Recommendations\nNone\n"
const validate = (content: string) => validateExecutionReport(content, "execution/reports/01-investigate.md", "01", "Investigate")

describe("execution report structure", () => {
  test("literal placeholder evidence and prose mentioning markers remain valid", () => {
    for (const evidence of ["No TODO markers remain.", "The FIXME comment explains the failure.", "Reviewed `TODO: retry` and `<job name>` examples.", "```ts\n// TODO: retry\n// FIXME: investigate\nconst example = '{{value}}'\n<!-- literal example -->\n```", "~~~text\nTBD\n~~~"]) {
      expect(validate(report.replace("Build failed.", evidence))).toEqual([])
    }
    for (const placeholder of ["TODO", "TBD", "FIXME: fill in results", "- [ ] TODO: add evidence", "<job name>", "{{result}}", "<!-- fill in -->"]) {
      expect(validate(report.replace("Build failed.", placeholder)).length).toBeGreaterThan(0)
    }
  })
  test("thematic breaks after blocks are not setext headings", () => {
    for (const body of ["- Verified behavior.\n---", "1. Verified behavior.\n---", "- Verified behavior.\n  Continuation.\n---", "### Verification\n---\nVerified behavior.", "> Verified behavior.\n---", "Verified behavior.\n\n---"]) {
      expect(validate(report.replace("Build failed.", body))).toEqual([])
    }
    for (const body of ["Extra heading\n---\nEvidence", "Extra heading\n===\nEvidence"]) {
      expect(validate(report.replace("Build failed.", body)).some((d) => d.message.includes("setext"))).toBe(true)
    }
  })
  test("failed and discovery outcomes are valid; fenced headings ignored and nested headings allowed", () => {
    expect(validate(report)).toEqual([])
    expect(validate(report.replace("Build failed.", "### Evidence\n#### Detail\n##### More\n###### Trace\nBuild failed.\n```md\n# Example\n## Wrong\n```\n~~~md\n## Also ignored\n~~~"))).toEqual([])
    expect(jobSpecTitle("```\n# Job Spec 01: Wrong\n```\n# Job Spec 01: Investigate", "01")).toBe("Investigate")
  })
  test("indented evidence is literal and a thematic break terminates list state", () => {
    expect(validate(report.replace("Build failed.", "Literal evidence:\n\n    TODO: upstream marker\n    FIXME: investigate"))).toEqual([])
    expect(validate(report.replace("Build failed.", "- Verified behavior.\n---\nExtra heading\n===\nEvidence")).some((d) => d.message.includes("setext"))).toBe(true)
  })
  test.each([
    report.replace("Job 01", "Job 02"),
    report.replace("Investigate Report", "Wrong Report"),
    report + "\n# Extra\n",
    report + "\n## Extra\nContent\n",
    report + "\n## Notes\nAgain\n",
    report.replace("## Notes\nNone\n", ""),
    report.replace("## Notes", "## TEMP").replace("## Found Issues", "## Notes").replace("## TEMP", "## Found Issues"),
    report.replace("## Notes\nNone", "## Notes\n### Empty nested heading"),
    report.replace("## Notes\nNone", "## Notes\n<!-- guidance -->"),
    report.replace("## Notes\nNone", "## Notes\nTBD"),
    report.replace("Investigate", "<job name>"),
    report + "\nExtra heading\n===\n",
  ])("rejects malformed report with actionable line diagnostics", (content) => {
    const diagnostics = validate(content)
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics.every((d) => d.line > 0 && d.path.endsWith(".md") && d.message.length > 0)).toBe(true)
  })
})
