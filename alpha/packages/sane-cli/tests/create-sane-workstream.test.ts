import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
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
    await expectMissing(join(destination, "SANE_CONTEXT.md"))
    await expectMissing(join(destination, "SDD.md"))
    await expectMissing(join(destination, "FOUNDATION.md"))
    await expectMissing(join(destination, "ISSUE.md"))
    await expectMissing(join(destination, "MAINTENANCE.md"))
    for (const directory of INITIAL_DIRECTORIES) {
      await access(join(destination, directory))
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
      expect(await readFile(join(destination, root), "utf8")).toBe(await readFile(join(templateRoot, source), "utf8"))
      // design/SDD.md is always copied from shared/sdd/SDD.md.
      // Exactly one root doc present.
      for (const other of ["PRD.md", "FOUNDATION.md", "ISSUE.md", "MAINTENANCE.md"]) {
        if (other === root) continue
        await expectMissing(join(destination, other))
      }
    }
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
  })

  test("rejects unsupported types before writing a destination", async () => {
    const destination = join(tempDirectory, "invalid-type")

    await expect(
      createSaneWorkstream({ destination, type: "legacy", templateRoot, write: () => {} }),
    ).rejects.toThrow("Unsupported workstream type")
    await expectMissing(destination)
  })
})
