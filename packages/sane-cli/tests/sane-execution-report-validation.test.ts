import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { jobSpecTitle, validateExecutionReport } from "../src/sane-execution-report-validation.ts"

const report = "# Job 01: Investigate Report\n\n## Outcome\nDiscovery completed; implementation failed.\n## Unresolved Issues\nBuild failed.\n## Recommendations\nNone\n"
const validate = (content: string) => validateExecutionReport(content, "execution/reports/01-investigate.md", "01", "Investigate")

describe("execution report structure", () => {
  test("every report template slot is rejected after guidance is removed, including verification slots", async () => {
    const template = (await readFile(new URL("../../../templates/shared/execution/REPORT.md", import.meta.url), "utf8"))
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace("{{id}}", "01").replace("{{job name}}", "Investigate")
    const slots = [...template.matchAll(/\{\{[^}]*\}\}/g)]
    expect(slots.length).toBeGreaterThan(0)
    for (let unresolved = 0; unresolved < slots.length; unresolved++) {
      let index = 0
      const content = template.replace(/\{\{[^}]*\}\}/g, (slot) => index++ === unresolved ? slot : "Verified evidence")
      expect(validate(content).some((d) => d.message.includes("{{...}}"))).toBe(true)
    }
    expect(validate(template.replace(/\{\{[^}]*\}\}/g, "Verified evidence"))).toEqual([])
  })

  test("bracket text and literal template evidence are valid, but multiline prose slots are not", () => {
    for (const evidence of ["Expected [a-z] and [optional] values; see [source](./source.md).", "Reviewed `{{value}}` and ``{{other}}``.", "```text\n{{value}}\n```", "Evidence:\n\n    {{value}}", "~~~text\n{{value}}\n~~~"]) {
      expect(validate(report.replace("Build failed.", evidence))).toEqual([])
    }
    expect(validate(report.replace("Build failed.", "{{Current issue\nand evidence}}"))).toEqual([
      { path: "execution/reports/01-investigate.md", line: 6, message: "Replace unresolved {{...}} placeholder with authored content." },
    ])
  })

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
    report + "\n## Recommendations\nAgain\n",
    report.replace("## Recommendations\nNone\n", ""),
    report.replace("## Recommendations", "## TEMP").replace("## Unresolved Issues", "## Recommendations").replace("## TEMP", "## Unresolved Issues"),
    report.replace("## Recommendations\nNone", "## Recommendations\n### Empty nested heading"),
    report.replace("## Recommendations\nNone", "## Recommendations\n<!-- guidance -->"),
    report.replace("## Recommendations\nNone", "## Recommendations\nTBD"),
    report.replace("Investigate", "<job name>"),
    report + "\nExtra heading\n===\n",
  ])("rejects malformed report with actionable line diagnostics", (content) => {
    const diagnostics = validate(content)
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics.every((d) => d.line > 0 && d.path.endsWith(".md") && d.message.length > 0)).toBe(true)
  })
})
