import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BootstrapError,
  INITIAL_DIRECTORIES,
  copyTemplateRegistry,
  createSaneWorkstream,
  initialTemplateRegistry,
  type TemplateRegistry,
  validateTemplateRegistry,
} from "../src/create-sane-workstream.ts"

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

// Resources directory contains only the current fallback templates.
function expectedResourcesListing(): string[] {
  return [
    "EXECUTION_FINAL_REPORT_TEMPLATE.md",
    "EXECUTION_REPORT_TEMPLATE.md",
    "JOB_TEMPLATE.md",
    "PLAN_TEMPLATE.md",
    "RESEARCH_REPORT_TEMPLATE.md",
    "SDD_TEMPLATE.md",
    "SOLUTION_SPEC_TEMPLATE.md",
  ]
}

const RETIRED_RESOURCE_TEMPLATES = [
  "EXECUTION_BRIEF_TEMPLATE.md",
  "EXECUTION_PLAN_TEMPLATE.md",
  "IMPLEMENTATION_REPORT_TEMPLATE.md",
  "ROOT_DESIGN_SPEC_TEMPLATE.md",
  "SECTION_SPEC_TEMPLATE.md",
  "STAGES_TEMPLATE.md",
  "STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md",
  "STAGE_SECTIONS_TEMPLATE.md",
]

describe("create-sane-workstream", () => {
  let tempDirectory: string
  let templateRoot: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-bootstrap-"))
    templateRoot = join(tempDirectory, "templates")
    await mkdir(templateRoot)
    const sources = new Set(
      (
        [
          ...initialTemplateRegistry("feature"),
          ...initialTemplateRegistry("foundation"),
          ...initialTemplateRegistry("issue"),
          ...initialTemplateRegistry("maintenance"),
        ] as TemplateRegistry
      ).map((template) => template.source),
    )
    for (const source of sources) {
      await mkdir(join(templateRoot, source, ".."), { recursive: true })
      await Bun.write(join(templateRoot, source), `${source}\n`)
    }
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  test("creates feature templates, metadata, and directories", async () => {
    const destination = join(tempDirectory, "new-workstream")
    const lines: string[] = []

    const result = await createSaneWorkstream({
      destination,
      type: "feature",
      templateRoot,
      write: (line) => lines.push(line),
    })

    expect(result.dryRun).toBe(false)
    for (const template of initialTemplateRegistry("feature")) {
      expect(await readFile(join(destination, template.destination), "utf8")).toBe(
        await readFile(join(templateRoot, template.source), "utf8"),
      )
    }
    // No type file: type lives in sqlite only.
    await expectMissing(join(destination, "type"))
    // Exactly one root doc per type.
    expect(await readFile(join(destination, "PRD.md"), "utf8")).toBe("feature/PRD.md\n")
    // design/SDD.md is copied from shared/sdd/SDD.md alongside the fallback.
    expect(await readFile(join(destination, "design", "SDD.md"), "utf8")).toBe("shared/sdd/SDD.md\n")
    expect(await readFile(join(destination, "resources", "SDD_TEMPLATE.md"), "utf8")).toBe(
      "shared/sdd/SDD.md\n",
    )
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe("shared/README.md\n")
    await expectMissing(join(destination, "SANE_CONTEXT.md"))
    await expectMissing(join(destination, "SDD.md"))
    await expectMissing(join(destination, "FOUNDATION.md"))
    await expectMissing(join(destination, "ISSUE.md"))
    await expectMissing(join(destination, "MAINTENANCE.md"))
    expect([...INITIAL_DIRECTORIES].sort().join(",")).toBe(
      "design,execution,research,resources",
    )
    for (const directory of INITIAL_DIRECTORIES) {
      await access(join(destination, directory))
      expect((await readdir(join(destination, directory))).sort()).toEqual(
        directory === "resources" ? expectedResourcesListing() : directory === "design" ? ["SDD.md"] : [],
      )
    }
    // Retired Stage / implementation fallbacks must not be created.
    for (const retired of RETIRED_RESOURCE_TEMPLATES) {
      await expectMissing(join(destination, "resources", retired))
    }
    await expectMissing(join(destination, "resources", "TECHNICAL_REFERENCE_TEMPLATE.md"))
    // Retired directories must not be created.
    await expectMissing(join(destination, "solutions"))
    await expectMissing(join(destination, "plan"))
    await expectMissing(join(destination, "planning"))
    await expectMissing(join(destination, "implementation"))
    await expectMissing(join(destination, "docs"))
    // New top-level directories must exist.
    await access(join(destination, "design"))
    await access(join(destination, "execution"))
    await access(join(destination, "research"))
    await access(join(destination, "resources"))
    expect(lines).toContain(`Created: ${destination}`)
  })

  test("creates the correct root doc per workstream type", async () => {
    const cases = [
      { type: "feature", root: "PRD.md", source: "feature/PRD.md" },
      { type: "foundation", root: "FOUNDATION.md", source: "foundation/FOUNDATION.md" },
      { type: "issue", root: "ISSUE.md", source: "issue/ISSUE.md" },
      { type: "maintenance", root: "MAINTENANCE.md", source: "maintenance/MAINTENANCE.md" },
    ] as const

    for (const { type, root, source } of cases) {
      const destination = join(tempDirectory, `${type}-workstream`)
      await createSaneWorkstream({ destination, type, templateRoot, write: () => {} })

      await expectMissing(join(destination, "type"))
      expect(await readFile(join(destination, root), "utf8")).toBe(`${source}\n`)
      // design/SDD.md is always copied from shared/sdd/SDD.md.
      expect(await readFile(join(destination, "design", "SDD.md"), "utf8")).toBe("shared/sdd/SDD.md\n")
      // Exactly one root doc present.
      for (const other of ["PRD.md", "FOUNDATION.md", "ISSUE.md", "MAINTENANCE.md"]) {
        if (other === root) continue
        await expectMissing(join(destination, other))
      }
    }
  })

  test.each(["feature", "foundation", "issue", "maintenance"])("%s bootstrap retains execution paths and copies compact plan and Job Spec resources", async (type) => {
    const destination = join(tempDirectory, `${type}-planning`)
    await createSaneWorkstream({ destination, type, write: () => {} })
    const plan = await readFile(join(destination, "resources", "PLAN_TEMPLATE.md"), "utf8")
    const spec = await readFile(join(destination, "resources", "JOB_TEMPLATE.md"), "utf8")
    expect(plan.match(/^#{1,2} .+$/gm)).toEqual(["# Plan", "## Jobs", "## Split Notes", "## Execution Checkpoints"])
    expect(plan).toContain("Every job belongs to exactly one checkpoint's Jobs")
    expect(plan).toContain("Execution defaults to listed order.")
    expect(plan).toContain("state sequencing exceptions and parallel authorization explicitly")
    expect(spec.match(/^#{1,2} .+$/gm)).toEqual([
      "# Job Spec <id>: <job name>", "## Goal", "## Context", "## Instructions",
      "## Boundaries", "## Verification", "## Report Requirements", "## Resolutions",
    ])
    expect(spec).toBe(await readFile(new URL("../../../templates/shared/plan/JOB.md", import.meta.url), "utf8"))
    await access(join(destination, "execution"))
    await access(join(destination, "design"))
    await access(join(destination, "research"))
    await expectMissing(join(destination, "implementation"))
    await expectMissing(join(destination, "solutions"))
    await expectMissing(join(destination, "plan"))
    await expectMissing(join(destination, "planning"))
    // Retired single-file and Stage artifacts must not be created.
    await expectMissing(join(destination, "design", "SPEC.md"))
    await expectMissing(join(destination, "design", "STAGES.md"))
    await expectMissing(join(destination, "execution", "PLAN.md"))
    await expectMissing(join(destination, "resources", "STAGES_TEMPLATE.md"))
    await expectMissing(join(destination, "resources", "EXECUTION_PLAN_TEMPLATE.md"))
    await expectMissing(join(destination, "resources", "ROOT_DESIGN_SPEC_TEMPLATE.md"))
    await expectMissing(join(destination, "SANE_CONTEXT.md"))
    await expectMissing(join(destination, "SDD.md"))
    await expectMissing(join(destination, "execution", "BRIEF.md"))
    // New fallbacks must exist.
    await access(join(destination, "resources", "SDD_TEMPLATE.md"))
    await access(join(destination, "resources", "SOLUTION_SPEC_TEMPLATE.md"))
    await access(join(destination, "resources", "PLAN_TEMPLATE.md"))
    await access(join(destination, "resources", "EXECUTION_FINAL_REPORT_TEMPLATE.md"))
    await access(join(destination, "resources", "EXECUTION_REPORT_TEMPLATE.md"))
    // design/SDD.md matches the shared template and its resources fallback.
    expect(await readFile(join(destination, "design", "SDD.md"), "utf8")).toBe(
      await readFile(join(destination, "resources", "SDD_TEMPLATE.md"), "utf8"),
    )
    expect(await readFile(join(destination, "design", "SDD.md"), "utf8")).toContain(
      "# Solution Design Document",
    )
    expect(await readFile(join(destination, "README.md"), "utf8"))
      .toContain("# SANE Context")

    const rootName = {
      feature: "PRD.md", foundation: "FOUNDATION.md",
      issue: "ISSUE.md", maintenance: "MAINTENANCE.md",
    }[type]!
    const root = await readFile(join(destination, rootName), "utf8")
    expect(root).not.toContain("## Open Questions")
    if (type === "issue") {
      expect(root).toContain("## Diagnosis")
      expect(root).not.toContain("## Suspected Area")
    }

    const sdd = await readFile(join(destination, "design", "SDD.md"), "utf8")
    expect(sdd.match(/^## .+$/gm)).toEqual([
      "## Goals and Non-Goals", "## Constraints", "## Technical Direction",
      "## Architecture", "## Verification Approach", "## Solution Areas",
    ])
    for (const [resource, source, headings] of [
      ["EXECUTION_REPORT_TEMPLATE.md", "REPORT.md", ["## Outcome", "## Unresolved Issues", "## Recommendations"]],
      ["EXECUTION_FINAL_REPORT_TEMPLATE.md", "FINAL_REPORT.md", ["## Accomplished", "## Found Issues", "## Notes", "## Implementation Recommendations"]],
    ] as const) {
      const report = await readFile(join(destination, "resources", resource), "utf8")
      expect(report.match(/^## .+$/gm)).toEqual([...headings])
      expect(report).toBe(await readFile(new URL(`../../../templates/shared/execution/${source}`, import.meta.url), "utf8"))
    }
    const solution = await readFile(join(destination, "resources", "SOLUTION_SPEC_TEMPLATE.md"), "utf8")
    expect(solution).toContain("`design/solutions/<name>.md`")
    expect(solution).toContain("`design/SDD.md`")
  })

  test("dry run leaves no destination", async () => {
    const destination = join(tempDirectory, "dry-run-workstream")
    const lines: string[] = []

    const result = await createSaneWorkstream({
      destination,
      type: "foundation",
      templateRoot,
      dryRun: true,
      write: (line) => lines.push(line),
    })

    expect(result.dryRun).toBe(true)
    expect(lines).toContain("Planned workstream type: foundation")
    await expectMissing(destination)
  })

  test("refuses an existing destination without changing it", async () => {
    const destination = join(tempDirectory, "existing-workstream")
    await Bun.write(join(destination, "existing.md"), "keep this file\n")

    await expect(
      createSaneWorkstream({ destination, type: "feature", templateRoot, write: () => {} }),
    ).rejects.toBeInstanceOf(BootstrapError)
    expect(await readFile(join(destination, "existing.md"), "utf8")).toBe(
      "keep this file\n",
    )
  })

  test("a missing source template leaves no destination", async () => {
    const destination = join(tempDirectory, "missing-template-workstream")
    await rm(join(templateRoot, "feature", "PRD.md"))

    await expect(
      createSaneWorkstream({ destination, type: "feature", templateRoot, write: () => {} }),
    ).rejects.toThrow("Required source template")
    await expectMissing(destination)
  })

  test("copies an arbitrary nested template registry without changing bootstrap templates", async () => {
    const registry: TemplateRegistry = [
      {
        source: "roles/product/ROLE.md",
        destination: "skills/product/SKILL.md",
      },
    ]
    const stagingRoot = join(tempDirectory, "role-staging")
    await mkdir(join(templateRoot, "roles", "product"), { recursive: true })
    await Bun.write(
      join(templateRoot, "roles", "product", "ROLE.md"),
      "product role template\n",
    )
    await mkdir(stagingRoot)

    await validateTemplateRegistry(templateRoot, registry)
    await copyTemplateRegistry(templateRoot, stagingRoot, registry)

    expect(await readFile(join(stagingRoot, "skills", "product", "SKILL.md"), "utf8")).toBe(
      "product role template\n",
    )
    expect(initialTemplateRegistry("feature")).toHaveLength(10)
    expect(initialTemplateRegistry("foundation")).toHaveLength(10)
    expect(initialTemplateRegistry("issue")).toHaveLength(10)
    expect(initialTemplateRegistry("maintenance")).toHaveLength(10)
  })

  test("rejects unsupported types before writing a destination", async () => {
    const destination = join(tempDirectory, "invalid-type")

    await expect(
      createSaneWorkstream({ destination, type: "legacy", templateRoot, write: () => {} }),
    ).rejects.toThrow("Unsupported workstream type")
    await expectMissing(destination)
  })
})
