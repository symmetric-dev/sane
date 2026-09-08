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
} from "./create-sane-workstream.ts"

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

describe("create-sane-workstream", () => {
  let tempDirectory: string
  let templateRoot: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-alpha-bootstrap-"))
    templateRoot = join(tempDirectory, "templates")
    await mkdir(templateRoot)
    for (const source of [
      ...initialTemplateRegistry("feature"),
      ...initialTemplateRegistry("foundation"),
    ].map((template) => template.source)) {
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
    expect(await readFile(join(destination, "type"), "utf8")).toBe("feature\n")
    for (const directory of INITIAL_DIRECTORIES) {
      await access(join(destination, directory))
      expect((await readdir(join(destination, directory))).sort()).toEqual(
        directory === "resources"
           ? [
               "EXECUTION_PLAN_TEMPLATE.md",
               "IMPLEMENTATION_REPORT_TEMPLATE.md",
               "JOB_TEMPLATE.md",
                "RESEARCH_REPORT_TEMPLATE.md",
               "ROOT_DESIGN_SPEC_TEMPLATE.md",
                "SECTION_SPEC_TEMPLATE.md",
               "STAGES_TEMPLATE.md",
               "STAGE_DESIGN_SPEC_TEMPLATE.md",
                "STAGE_SECTIONS_TEMPLATE.md",
                "TECHNICAL_REFERENCE_TEMPLATE.md",
             ]
          : [],
      )
    }
    expect(lines).toContain(`Created: ${destination}`)
    expect(lines).toContain(
      `Next action: start a Product Assistant session for ${destination}.`,
    )
  })

  test("creates a foundation PRD and type metadata", async () => {
    const destination = join(tempDirectory, "foundation-workstream")

    await createSaneWorkstream({ destination, type: "foundation", templateRoot, write: () => {} })

    expect(await readFile(join(destination, "type"), "utf8")).toBe("foundation\n")
    expect(await readFile(join(destination, "PRD.md"), "utf8")).toBe("foundation/PRD.md\n")
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
    expect(initialTemplateRegistry("feature")).toHaveLength(13)
  })

  test("rejects unsupported types before writing a destination", async () => {
    const destination = join(tempDirectory, "invalid-type")

    await expect(
      createSaneWorkstream({ destination, type: "legacy", templateRoot, write: () => {} }),
    ).rejects.toThrow("Unsupported workstream type")
    await expectMissing(destination)
  })
})
