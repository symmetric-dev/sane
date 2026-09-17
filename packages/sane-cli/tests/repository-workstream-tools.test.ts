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
  REQUIRED_WORKSTREAM_FILES,
  RETIRED_WORKSTREAM_FILES,
  ROOT_DOC_BY_TYPE,
  SaneRepositoryError,
} from "../src/sane-repository.ts"
import {
  parseCliArguments as parseSelectCliArguments,
  selectSaneWorkstream,
} from "../src/select-sane-workstream.ts"

const execFileAsync = promisify(execFile)

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

const NEW_TEMPLATE_SOURCES = [
  "shared/SANE_CONTEXT.md",
  "shared/SANE_STATE.md",
  "shared/sdd/SDD.md",
  "shared/solutions/SOLUTION.md",
  "shared/research/REPORT.md",
  "shared/plan/PLAN.md",
  "shared/plan/JOB.md",
  "shared/execution/REPORT.md",
  "shared/execution/BRIEF.md",
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
  "resources/EXECUTION_BRIEF_TEMPLATE.md",
]

describe("repository-aware Alpha workstream tools", () => {
  let tempDirectory: string
  let implementationRepository: string
  let workstreamsRoot: string
  let templateRoot: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-alpha-tools-"))
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
    // SDD.md root is provided by the shared bootstrap registry
    // (shared/sdd/SDD.md -> SDD.md). Access is tolerant when the file exists.
    await access(join(workstreamPath, "SDD.md"))
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

  test("refuses missing or invalid type metadata without changing selection", async () => {
    await bootstrap("01-valid")
    const missingType = await bootstrap("02-missing")
    await selectSaneWorkstream({ implementationRepository, workstreamPath: "01-valid", write: () => {} })
    await rm(join(missingType, "type"))
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "02-missing", write: () => {} }))
      .rejects.toThrow("type file is missing")
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("01-valid\n")

    await Bun.write(join(missingType, "type"), "unknown\n")
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "02-missing", write: () => {} }))
      .rejects.toThrow("Workstream type is invalid")
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("01-valid\n")

    await Bun.write(join(missingType, "type"), "feature")
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "02-missing", write: () => {} }))
      .rejects.toThrow("Workstream type is invalid")
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("01-valid\n")
  })

  test("REQUIRED_WORKSTREAM_FILES matches the 0.2.0 bootstrap shape", () => {
    const required: string[] = [...REQUIRED_WORKSTREAM_FILES]
    expect(required).toContain("SANE_CONTEXT.md")
    expect(required).toContain("SANE_STATE.md")
    expect(required).toContain("SDD.md")
    for (const resource of NEW_RESOURCE_FILES) {
      expect(required).toContain(resource)
    }
    for (const retired of RETIRED_WORKSTREAM_FILES) {
      expect(required).not.toContain(retired as string)
    }
    expect(required.join("\n")).not.toContain("STAGES_TEMPLATE")
    expect(required.join("\n")).not.toContain("STAGE_DESIGN_SPEC")
    expect(required.join("\n")).not.toContain("EXECUTION_PLAN_TEMPLATE")
    expect(required.join("\n")).not.toContain("IMPLEMENTATION_REPORT")
  })

  test("requires the 0.2.0 fixed roots SANE_CONTEXT.md, SANE_STATE.md, and SDD.md", async () => {
    for (const missing of ["SANE_CONTEXT.md", "SANE_STATE.md", "SDD.md"] as const) {
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
      })).rejects.toThrow("missing regular file")
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
    // Simulate the pre-0.2.0 bootstrap which wrote PRD.md for foundation.
    await rm(join(workstream, "FOUNDATION.md"))
    await Bun.write(join(workstream, "PRD.md"), "old foundation PRD\n")
    await expect(selectSaneWorkstream({
      implementationRepository,
      workstreamPath: "01-foundation-old-root",
      write: () => {},
    })).rejects.toThrow("missing regular file")
  })

  test("requires every new 0.2.0 fallback template for selection", async () => {
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
    await Bun.write(join(legacyPath, "type"), "feature\n")
    await Bun.write(join(legacyPath, "PRD.md"), "old\n")
    await Bun.write(join(legacyPath, "SANE_CONTEXT.md"), "old\n")
    await Bun.write(join(legacyPath, "SANE_STATE.md"), "old\n")
    for (const retired of RETIRED_WORKSTREAM_FILES) {
      await Bun.write(join(legacyPath, retired), "old\n")
    }
    await expect(selectSaneWorkstream({
      implementationRepository, workstreamPath: "01-legacy-stage", write: () => {},
    })).rejects.toThrow("retired Stage artifact")
  })

  test("requires a supported public create-workstream type argument", () => {
    expect(() => parseCreateCliArguments([implementationRepository, "01-new"])).toThrow("--type is required")
    expect(() => parseCreateCliArguments([implementationRepository, "01-new", "--type", "legacy"])).toThrow("Unsupported workstream type")
    for (const type of ["feature", "foundation", "issue", "maintenance"] as const) {
      expect(parseCreateCliArguments([implementationRepository, "01-new", "--type", type])).toMatchObject({ type })
    }
    expect(parseCreateCliArguments([implementationRepository, "01-new", "--type", "foundation", "--dry-run"])).toMatchObject({
      type: "foundation",
      dryRun: true,
    })
  })

  test("select-workstream takes no type argument", () => {
    expect(parseSelectCliArguments([implementationRepository, "01-one"])).toMatchObject({
      implementationRepository,
      workstreamPath: "01-one",
    })
    expect(() => parseSelectCliArguments([implementationRepository, "01-one", "--type", "feature"])).toThrow("Unknown option")
  })
})
