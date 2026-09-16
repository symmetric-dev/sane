import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import {
  createSaneRepositoryWorkstream,
  parseCliArguments as parseCreateCliArguments,
} from "./create-sane-repository-workstream.ts"
import { SaneRepositoryError } from "./sane-repository.ts"
import { selectSaneWorkstream } from "./select-sane-workstream.ts"

const execFileAsync = promisify(execFile)

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

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
    for (const source of [
        "shared/SANE_CONTEXT.md", "shared/SANE_STATE.md", "feature/PRD.md",
        "foundation/PRD.md", "shared/research/BASELINE.md",
        "shared/research/REPORT.md", "feature/design/SPEC.md",
        "foundation/design/SPEC.md", "shared/design/STAGES.md",
        "shared/design/stage/SPEC.md", "shared/design/stage/SECTIONS.md",
        "shared/execution/EXECUTION_PLAN.md", "shared/design/section/SPEC.md",
        "shared/execution/JOB.md", "shared/implementation/REPORT.md",
        "shared/implementation/STAGE_BRIEF.md",
    ]) {
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
    return join(workstreamsRoot, relativePath)
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

  test("requires PRD.md for a foundation workstream", async () => {
    const foundation = await bootstrap("01-foundation", "foundation")
    await rm(join(foundation, "PRD.md"))

    await expect(selectSaneWorkstream({
      implementationRepository,
      workstreamPath: "01-foundation",
      write: () => {},
    })).rejects.toThrow("missing regular file")
  })

  test("requires every local fallback template for selection", async () => {
    const workstream = await bootstrap("01-resources")
    await rm(join(workstream, "resources", "STAGE_DESIGN_SPEC_TEMPLATE.md"))

    await expect(selectSaneWorkstream({
      implementationRepository,
      workstreamPath: "01-resources",
      write: () => {},
    })).rejects.toThrow("STAGE_DESIGN_SPEC_TEMPLATE.md")
  })

  test("requires the uniform research baseline template and not the obsolete technical reference", async () => {
    const workstream = await bootstrap("01-research-baseline")

    await expectMissing(join(workstream, "resources", "TECHNICAL_REFERENCE_TEMPLATE.md"))
    await rm(join(workstream, "resources", "RESEARCH_BASELINE_TEMPLATE.md"))
    await expect(selectSaneWorkstream({
      implementationRepository,
      workstreamPath: "01-research-baseline",
      write: () => {},
    })).rejects.toThrow("RESEARCH_BASELINE_TEMPLATE.md")
  })

  test("requires a supported public create-workstream type argument", () => {
    expect(() => parseCreateCliArguments([implementationRepository, "01-new"])).toThrow("--type is required")
    expect(() => parseCreateCliArguments([implementationRepository, "01-new", "--type", "legacy"])).toThrow("Unsupported workstream type")
    expect(parseCreateCliArguments([implementationRepository, "01-new", "--type", "foundation", "--dry-run"])).toMatchObject({
      type: "foundation",
      dryRun: true,
    })
  })

})
