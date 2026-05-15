import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateStream, createGenerateArgs } from "../src/lib/generate"
import { main as planMain } from "../src/cli/plan.ts"

describe("work plan create", () => {
  let tempDir: string
  let consoleLogSpy: any
  let consoleErrorSpy: any
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "work-plan-test-"))
    logs = []
    errors = []
    consoleLogSpy = spyOn(console, "log").mockImplementation((msg: any) => logs.push(String(msg)))
    consoleErrorSpy = spyOn(console, "error").mockImplementation((msg: any) => errors.push(String(msg)))
    generateStream(createGenerateArgs("draft-feature", tempDir))
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("scaffolds stages for an existing draft workstream", () => {
    planMain([
      "bun",
      "work-plan",
      "create",
      "--repo-root",
      tempDir,
      "--stream",
      "000-draft-feature",
      "--stages",
      "2",
    ])

    const stagePlanContent = readFileSync(
      join(tempDir, "work", "000-draft-feature", "stages", "01", "PLAN.md"),
      "utf-8",
    )

    expect(stagePlanContent).toContain("# Stage 01 Plan")
    expect(existsSync(join(tempDir, "work", "000-draft-feature", "stages", "02", "PLAN.md"))).toBe(true)
    expect(logs.join("\n")).toContain("Scaffolded 2 stages in workstream \"000-draft-feature\".")
    expect(logs.join("\n")).toContain(join(tempDir, "work", "000-draft-feature", "stages"))
    expect(errors).toEqual([])
  })
})
