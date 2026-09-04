import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BootstrapError,
  INITIAL_DIRECTORIES,
  INITIAL_TEMPLATE_REGISTRY,
  copyTemplateRegistry,
  createSaneWorkstream,
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
    await Bun.write(join(templateRoot, "SANE_CONTEXT.md"), "context template\n")
    await Bun.write(join(templateRoot, "SANE_STATE.md"), "state template\n")
    await Bun.write(join(templateRoot, "PRD.md"), "prd template\n")
    await mkdir(join(templateRoot, "implementation"))
    await Bun.write(join(templateRoot, "implementation", "REPORT.md"), "report template\n")
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  test("creates exactly the initial templates and directories", async () => {
    const destination = join(tempDirectory, "new-workstream")
    const lines: string[] = []

    const result = await createSaneWorkstream({
      destination,
      templateRoot,
      write: (line) => lines.push(line),
    })

    expect(result.dryRun).toBe(false)
    for (const template of INITIAL_TEMPLATE_REGISTRY) {
      expect(await readFile(join(destination, template.destination), "utf8")).toBe(
        await readFile(join(templateRoot, template.source), "utf8"),
      )
    }
    for (const directory of INITIAL_DIRECTORIES) {
      await access(join(destination, directory))
      expect(await readdir(join(destination, directory))).toEqual(
        directory === "resources" ? ["IMPLEMENTATION_REPORT_TEMPLATE.md"] : [],
      )
    }
    expect(lines).toContain(`Created: ${destination}`)
    expect(lines).toContain(
      `Next action: start a Product Assistant session for ${destination}.`,
    )
  })

  test("dry run leaves no destination", async () => {
    const destination = join(tempDirectory, "dry-run-workstream")

    const result = await createSaneWorkstream({
      destination,
      templateRoot,
      dryRun: true,
      write: () => {},
    })

    expect(result.dryRun).toBe(true)
    await expectMissing(destination)
  })

  test("refuses an existing destination without changing it", async () => {
    const destination = join(tempDirectory, "existing-workstream")
    await Bun.write(join(destination, "existing.md"), "keep this file\n")

    await expect(
      createSaneWorkstream({ destination, templateRoot, write: () => {} }),
    ).rejects.toBeInstanceOf(BootstrapError)
    expect(await readFile(join(destination, "existing.md"), "utf8")).toBe(
      "keep this file\n",
    )
  })

  test("a missing source template leaves no destination", async () => {
    const destination = join(tempDirectory, "missing-template-workstream")
    await rm(join(templateRoot, "PRD.md"))

    await expect(
      createSaneWorkstream({ destination, templateRoot, write: () => {} }),
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
    expect(INITIAL_TEMPLATE_REGISTRY).toHaveLength(4)
  })
})
