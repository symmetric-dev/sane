import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import {
  createSaneRepositoryWorkstream,
  parseCliArguments as parseCreateCliArguments,
} from "../src/create-sane-repository-workstream.ts"
import {
  OLD_WORKSTREAM_DIRS,
  OLD_WORKSTREAM_FILES,
  REQUIRED_WORKSTREAM_FILES,
  RETIRED_WORKSTREAM_FILES,
  ROOT_DOC_BY_TYPE,
  SaneRepositoryError,
} from "../src/sane-repository.ts"
import {
  parseCliArguments as parseSelectCliArguments,
  selectSaneWorkstream,
} from "../src/select-sane-workstream.ts"
import { getWorkstream, initSchema, openSaneDb, resolveSaneIdentity } from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

const NEW_TEMPLATE_SOURCES = [
  "shared/README.md",
  "shared/sdd/SDD.md",
  "shared/solutions/SOLUTION.md",
  "shared/research/REPORT.md",
  "shared/plan/PLAN.md",
  "shared/plan/JOB.md",
  "shared/execution/REPORT.md",
  "shared/execution/FINAL_REPORT.md",
  "feature/PRD.md",
  "foundation/FOUNDATION.md",
  "issue/ISSUE.md",
  "maintenance/MAINTENANCE.md",
]

const NEW_RESOURCE_FILES = [
  "resources/SDD_TEMPLATE.md",
  "resources/SOLUTION_SPEC_TEMPLATE.md",
  "resources/RESEARCH_REPORT_TEMPLATE.md",
  "resources/PLAN_TEMPLATE.md",
  "resources/JOB_TEMPLATE.md",
  "resources/EXECUTION_REPORT_TEMPLATE.md",
  "resources/EXECUTION_FINAL_REPORT_TEMPLATE.md",
]

describe("repository-aware Alpha workstream tools", () => {
  let tempDirectory: string
  let implementationRepository: string
  let workstreamsRoot: string
  let templateRoot: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-tools-"))
    implementationRepository = join(tempDirectory, "implementation")
    workstreamsRoot = join(implementationRepository, ".sane", "workstreams")
    templateRoot = join(tempDirectory, "templates")
    await mkdir(implementationRepository)
    await execFileAsync("git", ["init", "--quiet", implementationRepository])
    await mkdir(workstreamsRoot, { recursive: true })
    for (const source of NEW_TEMPLATE_SOURCES) {
      await mkdir(dirname(join(templateRoot, source)), { recursive: true })
      await Bun.write(join(templateRoot, source), `${source}\n`)
    }
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  async function bootstrap(relativePath: string, type = "feature"): Promise<string> {
    await createSaneRepositoryWorkstream({
      implementationRepository,
      workstreamPath: relativePath,
      type,
      templateRoot,
      write: () => {},
    })
    const workstreamPath = join(workstreamsRoot, relativePath)
    // design/SDD.md is provided by the shared bootstrap registry
    // (shared/sdd/SDD.md -> design/SDD.md).
    await access(join(workstreamPath, "design", "SDD.md"))
    return workstreamPath
  }

  test("creates a repository workstream and selects it only after successful creation", async () => {
    await bootstrap("01-first")
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("01-first\n")

    await expect(createSaneRepositoryWorkstream({
      implementationRepository, workstreamPath: "01-first", type: "feature", templateRoot, write: () => {},
    })).rejects.toThrow("Destination already exists")
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("01-first\n")
  })

  test("create records the workstream type in sqlite (no type file)", async () => {
    const workstreamPath = await bootstrap("01-typed", "foundation")
    await expectMissing(join(workstreamPath, "type"))
    const identity = await resolveSaneIdentity(implementationRepository, "01-typed")
    const db = await openSaneDb(implementationRepository)
    try {
      initSchema(db)
      expect(getWorkstream(db, identity)?.type).toBe("foundation")
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("dry-run creation validates but creates and selects nothing", async () => {
    await createSaneRepositoryWorkstream({
      implementationRepository, workstreamPath: "02-dry-run", type: "foundation", templateRoot, dryRun: true, write: () => {},
    })
    await expectMissing(join(workstreamsRoot, "02-dry-run"))
    await expectMissing(join(implementationRepository, ".sane", "current-workstream"))
  })

  test("dry-run selection leaves the current-workstream file absent", async () => {
    await bootstrap("02-dry-select")
    await rm(join(implementationRepository, ".sane", "current-workstream"))
    await selectSaneWorkstream({ implementationRepository, workstreamPath: "02-dry-select", dryRun: true, write: () => {} })
    await expectMissing(join(implementationRepository, ".sane", "current-workstream"))
  })

  test("selects an existing bootstrap, safely repeats, and replaces an explicit prior selection", async () => {
    await bootstrap("01-one")
    await bootstrap("02-two")
    await selectSaneWorkstream({ implementationRepository, workstreamPath: "01-one", write: () => {} })
    await selectSaneWorkstream({ implementationRepository, workstreamPath: "01-one", write: () => {} })
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("01-one\n")
  })

  test("rejects a missing workstreams directory and a legacy paths file", async () => {
    await rm(workstreamsRoot, { recursive: true, force: true })
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "one", write: () => {} }))
      .rejects.toBeInstanceOf(SaneRepositoryError)
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "one", write: () => {} }))
      .rejects.toThrow("missing")
    await expect(createSaneRepositoryWorkstream({
      implementationRepository, workstreamPath: "one", type: "feature", templateRoot, write: () => {},
    })).rejects.toThrow("missing")

    await mkdir(workstreamsRoot, { recursive: true })
    await Bun.write(join(implementationRepository, ".sane", "paths"), "legacy\n")
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "one", write: () => {} }))
      .rejects.toThrow("Legacy .sane/paths")
    await expect(createSaneRepositoryWorkstream({
      implementationRepository, workstreamPath: "one", type: "feature", templateRoot, write: () => {},
    })).rejects.toThrow("Legacy .sane/paths")
  })

  test("rejects traversal, paths redirected outside the repository, and unbootstrapped selections", async () => {
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "../outside", write: () => {} })).rejects.toThrow("traversal")
    const outside = join(tempDirectory, "outside")
    await mkdir(outside)
    await symlink(outside, join(workstreamsRoot, "redirect"))
    await expect(createSaneRepositoryWorkstream({ implementationRepository, workstreamPath: "redirect/new", type: "feature", templateRoot, write: () => {} })).rejects.toThrow("outside")
    await mkdir(join(workstreamsRoot, "unbootstrapped"))
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "unbootstrapped", write: () => {} })).rejects.toThrow("not bootstrapped")
  })

  test("does not overwrite a non-file current-workstream object", async () => {
    await bootstrap("01-safe")
    await rm(join(implementationRepository, ".sane", "current-workstream"))
    await mkdir(join(implementationRepository, ".sane", "current-workstream"))
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "01-safe", write: () => {} })).rejects.toThrow("not a regular file")
  })

  test("no type file is required; selection succeeds without one", async () => {
    await bootstrap("01-valid")
    const workstreamPath = await bootstrap("02-missing")
    await selectSaneWorkstream({ implementationRepository, workstreamPath: "01-valid", write: () => {} })
    // New layout has no type file; its absence must not block selection.
    await expectMissing(join(workstreamPath, "type"))
    await selectSaneWorkstream({ implementationRepository, workstreamPath: "02-missing", write: () => {} })
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("02-missing\n")
  })

  test("REQUIRED_WORKSTREAM_FILES matches the current bootstrap shape", () => {
    const required: string[] = [...REQUIRED_WORKSTREAM_FILES]
    expect(required).toContain("README.md")
    expect(required).not.toContain("SANE_CONTEXT.md")
    expect(required).not.toContain("SANE_STATE.md")
    expect(required).toContain("design/SDD.md")
    expect(required).not.toContain("SDD.md" as string)
    for (const resource of NEW_RESOURCE_FILES) {
      expect(required).toContain(resource)
    }
    expect(required).not.toContain("resources/EXECUTION_BRIEF_TEMPLATE.md")
    for (const retired of RETIRED_WORKSTREAM_FILES) {
      expect(required).not.toContain(retired as string)
    }
    for (const old of OLD_WORKSTREAM_DIRS) {
      expect(required).not.toContain(old as string)
    }
    expect(required).not.toContain("SANE_CONTEXT.md" as string)
    expect(required.join("\n")).not.toContain("STAGES_TEMPLATE")
    expect(required.join("\n")).not.toContain("STAGE_DESIGN_SPEC")
    expect(required.join("\n")).not.toContain("EXECUTION_PLAN_TEMPLATE")
    expect(required.join("\n")).not.toContain("IMPLEMENTATION_REPORT")
  })

  test("requires the fixed roots README.md and design/SDD.md", async () => {
    for (const missing of ["README.md", "design/SDD.md"] as const) {
      const workstream = await bootstrap(`01-fixed-${missing.replace(/[^A-Za-z]+/g, "-")}`)
      await rm(join(workstream, missing))
      await expect(selectSaneWorkstream({
        implementationRepository,
        workstreamPath: `01-fixed-${missing.replace(/[^A-Za-z]+/g, "-")}`,
        write: () => {},
      })).rejects.toThrow("missing regular file")
    }
  })

  test("requires the correct root doc per type and exactly one root doc", async () => {
    const cases = [
      { type: "feature", doc: "PRD.md" },
      { type: "foundation", doc: "FOUNDATION.md" },
      { type: "issue", doc: "ISSUE.md" },
      { type: "maintenance", doc: "MAINTENANCE.md" },
    ] as const
    for (const { type, doc } of cases) {
      expect(ROOT_DOC_BY_TYPE[type]).toBe(doc)
      const workstream = await bootstrap(`01-${type}`, type)
      expect(await readFile(join(workstream, doc), "utf8")).toContain(doc === "PRD.md" ? "PRD" : doc.replace(".md", ""))
      // Exactly one root doc present after bootstrap.
      for (const other of ["PRD.md", "FOUNDATION.md", "ISSUE.md", "MAINTENANCE.md"] as const) {
        if (other === doc) continue
        await expectMissing(join(workstream, other))
      }
      await selectSaneWorkstream({ implementationRepository, workstreamPath: `01-${type}`, write: () => {} })

      // Missing the expected root doc fails.
      await rm(join(workstream, doc))
      await expect(selectSaneWorkstream({
        implementationRepository, workstreamPath: `01-${type}`, write: () => {},
      })).rejects.toThrow("root document")
    }
  })

  test("rejects an extra root doc that does not match the type", async () => {
    const workstream = await bootstrap("01-extra-root", "feature")
    await Bun.write(join(workstream, "FOUNDATION.md"), "wrong root\n")
    await expect(selectSaneWorkstream({
      implementationRepository, workstreamPath: "01-extra-root", write: () => {},
    })).rejects.toThrow("exactly one root document")
  })

  test("rejects a foundation workstream using the old PRD.md root", async () => {
    const workstream = await bootstrap("01-foundation-old-root", "foundation")
    // Simulate the pre-migration bootstrap which wrote PRD.md for foundation.
    await rm(join(workstream, "FOUNDATION.md"))
    await Bun.write(join(workstream, "PRD.md"), "old foundation PRD\n")
    await expect(selectSaneWorkstream({
      implementationRepository,
      workstreamPath: "01-foundation-old-root",
      write: () => {},
    })).rejects.toThrow("type mismatch")
  })

  test("rejects old-layout files and directories", async () => {
    for (const oldFile of OLD_WORKSTREAM_FILES) {
      const slug = oldFile.replace(/[^A-Za-z]+/g, "-")
      const workstream = await bootstrap(`01-oldfile-${slug}`)
      await Bun.write(join(workstream, oldFile), "old layout\n")
      await expect(selectSaneWorkstream({
        implementationRepository,
        workstreamPath: `01-oldfile-${slug}`,
        write: () => {},
      })).rejects.toThrow("old-layout")
    }
    for (const oldDir of OLD_WORKSTREAM_DIRS) {
      const workstream = await bootstrap(`01-olddir-${oldDir}`)
      await mkdir(join(workstream, oldDir), { recursive: true })
      await expect(selectSaneWorkstream({
        implementationRepository,
        workstreamPath: `01-olddir-${oldDir}`,
        write: () => {},
      })).rejects.toThrow("old-layout")
    }
  })

  test("requires every current fallback template for selection", async () => {
    for (const resource of NEW_RESOURCE_FILES) {
      const slug = resource.replace(/[^A-Za-z]+/g, "-")
      const workstream = await bootstrap(`01-resource-${slug}`)
      await rm(join(workstream, resource))
      await expect(selectSaneWorkstream({
        implementationRepository,
        workstreamPath: `01-resource-${slug}`,
        write: () => {},
      })).rejects.toThrow(resource.split("/").pop()!)
    }
  })

  test("requires the research report template and not the obsolete technical reference", async () => {
    const workstream = await bootstrap("01-research-baseline")

    await expectMissing(join(workstream, "resources", "TECHNICAL_REFERENCE_TEMPLATE.md"))
    await rm(join(workstream, "resources", "RESEARCH_REPORT_TEMPLATE.md"))
    await expect(selectSaneWorkstream({
      implementationRepository,
      workstreamPath: "01-research-baseline",
      write: () => {},
    })).rejects.toThrow("RESEARCH_REPORT_TEMPLATE.md")
  })

  test("rejects retired Stage artifacts even when new files are present", async () => {
    const retiredCases = [
      "resources/STAGES_TEMPLATE.md",
      "resources/STAGE_DESIGN_SPEC_TEMPLATE.md",
      "resources/STAGE_SECTIONS_TEMPLATE.md",
      "resources/SECTION_SPEC_TEMPLATE.md",
      "resources/ROOT_DESIGN_SPEC_TEMPLATE.md",
      "resources/STAGE_IMPLEMENTATION_BRIEF_TEMPLATE.md",
      "resources/IMPLEMENTATION_REPORT_TEMPLATE.md",
      "resources/EXECUTION_PLAN_TEMPLATE.md",
    ]
    for (const retired of retiredCases) {
      const slug = retired.replace(/[^A-Za-z]+/g, "-")
      const workstream = await bootstrap(`01-retired-${slug}`)
      await Bun.write(join(workstream, retired), "retired\n")
      await expect(selectSaneWorkstream({
        implementationRepository,
        workstreamPath: `01-retired-${slug}`,
        write: () => {},
      })).rejects.toThrow("retired Stage artifact")
    }
  })

  test("rejects an old Stage layout missing new files", async () => {
    const legacyPath = join(workstreamsRoot, "01-legacy-stage")
    await mkdir(join(legacyPath, "resources"), { recursive: true })
    await Bun.write(join(legacyPath, "PRD.md"), "old\n")
    await Bun.write(join(legacyPath, "README.md"), "old\n")
    for (const retired of RETIRED_WORKSTREAM_FILES) {
      await Bun.write(join(legacyPath, retired), "old\n")
    }
    await expect(selectSaneWorkstream({
      implementationRepository, workstreamPath: "01-legacy-stage", write: () => {},
    })).rejects.toThrow("retired Stage artifact")
  })

  test("requires --name and a supported create type argument", () => {
    expect(() => parseCreateCliArguments([])).toThrow("--name is required")
    expect(() => parseCreateCliArguments(["--name", "01-new"])).toThrow("--type is required")
    expect(() => parseCreateCliArguments(["--name", "01-new", "--type", "legacy"])).toThrow("Unsupported workstream type")
    expect(() => parseCreateCliArguments([implementationRepository, "01-new", "--type", "feature"])).toThrow("no positional arguments")
    for (const type of ["feature", "foundation", "issue", "maintenance"] as const) {
      expect(parseCreateCliArguments(["--name", "01-new", "--type", type])).toMatchObject({ type, workstreamPath: "01-new" })
    }
    expect(parseCreateCliArguments(["--name", "01-new", "--type", "foundation", "--dry-run"])).toMatchObject({
      type: "foundation",
      dryRun: true,
    })
  })

  test("select takes --name and no type argument", () => {
    expect(parseSelectCliArguments(["--name", "01-one"])).toMatchObject({
      workstreamPath: "01-one",
    })
    expect(() => parseSelectCliArguments([])).toThrow("--name is required")
    expect(() => parseSelectCliArguments([implementationRepository, "01-one"])).toThrow("no positional arguments")
    expect(() => parseSelectCliArguments(["--name", "01-one", "--type", "feature"])).toThrow("Unknown option")
  })
})
