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
import { printSanePath } from "./print-sane-path.ts"
import { provisionSaneRole } from "./provision-sane-role.ts"
import { SaneRepositoryError } from "./sane-repository.ts"
import { selectSaneWorkstream } from "./select-sane-workstream.ts"

const execFileAsync = promisify(execFile)

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

describe("repository-aware Alpha workstream tools", () => {
  let tempDirectory: string
  let implementationRepository: string
  let workstreamRepository: string
  let templateRoot: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-alpha-tools-"))
    implementationRepository = join(tempDirectory, "implementation")
    workstreamRepository = join(tempDirectory, "workstreams")
    templateRoot = join(tempDirectory, "templates")
    await mkdir(implementationRepository)
    await mkdir(workstreamRepository)
    await execFileAsync("git", ["init", "--quiet", implementationRepository])
    await execFileAsync("git", ["init", "--quiet", workstreamRepository])
    await mkdir(join(implementationRepository, ".sane"))
    await Bun.write(
      join(implementationRepository, ".sane", "paths"),
      `implementation-path: ${implementationRepository}\nworkstream-repository-path: ${workstreamRepository}\n`,
    )
    for (const source of [
        "shared/SANE_CONTEXT.md", "shared/SANE_STATE.md", "feature/PRD.md",
        "foundation/FOUNDATION.md", "shared/research/INDEX.md",
        "shared/research/TECH_BRIEF.md", "feature/design/SPEC.md",
        "foundation/design/SPEC.md", "shared/design/STAGES.md",
        "shared/design/stage/SPEC.md", "shared/design/stage/SECTIONS.md",
        "shared/execution/EXECUTION_PLAN.md", "shared/design/section/SPEC.md",
        "shared/execution/JOB.md", "shared/implementation/REPORT.md",
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
    return join(workstreamRepository, relativePath)
  }

  test("creates a repository workstream and selects it only after successful creation", async () => {
    await bootstrap("01-first")
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("01-first\n")

    await expect(createSaneRepositoryWorkstream({
      implementationRepository, workstreamPath: "01-first", type: "feature", templateRoot, write: () => {},
    })).rejects.toThrow("Destination already exists")
    expect(await readFile(join(implementationRepository, ".sane", "current-workstream"), "utf8")).toBe("01-first\n")
  })

  test("prints the paired SANE workstream repository's absolute path", async () => {
    const lines: string[] = []

    await expect(printSanePath({ implementationRepository, write: (line) => lines.push(line) }))
      .resolves.toBe(workstreamRepository)
    expect(lines).toEqual([workstreamRepository])
  })

  test("dry-run creation validates but creates and selects nothing", async () => {
    await createSaneRepositoryWorkstream({
      implementationRepository, workstreamPath: "02-dry-run", type: "foundation", templateRoot, dryRun: true, write: () => {},
    })
    await expectMissing(join(workstreamRepository, "02-dry-run"))
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

  test("rejects missing or malformed paths files and a recorded workstream directory that is only a Git subdirectory", async () => {
    await rm(join(implementationRepository, ".sane", "paths"))
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "one", write: () => {} })).rejects.toBeInstanceOf(SaneRepositoryError)
    await Bun.write(join(implementationRepository, ".sane", "paths"), `implementation-path: ${implementationRepository}\nworkstream-repository-path: relative\n`)
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "one", write: () => {} })).rejects.toThrow("absolute path")
    await Bun.write(join(implementationRepository, ".sane", "paths"), `implementation-path: ${implementationRepository}\nimplementation-path: ${implementationRepository}\nworkstream-repository-path: ${workstreamRepository}\n`)
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "one", write: () => {} })).rejects.toThrow("exact .sane/paths schema")
    const nested = join(workstreamRepository, "nested")
    await mkdir(nested)
    await Bun.write(join(implementationRepository, ".sane", "paths"), `implementation-path: ${implementationRepository}\nworkstream-repository-path: ${nested}\n`)
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "one", write: () => {} })).rejects.toThrow("Git repository root")
  })

  test("rejects traversal, paths redirected outside the repository, and unbootstrapped selections", async () => {
    await expect(selectSaneWorkstream({ implementationRepository, workstreamPath: "../outside", write: () => {} })).rejects.toThrow("traversal")
    const outside = join(tempDirectory, "outside")
    await mkdir(outside)
    await symlink(outside, join(workstreamRepository, "redirect"))
    await expect(createSaneRepositoryWorkstream({ implementationRepository, workstreamPath: "redirect/new", type: "feature", templateRoot, write: () => {} })).rejects.toThrow("outside")
    await mkdir(join(workstreamRepository, "unbootstrapped"))
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

  test("provisions approved roles from current selection or a validated override", async () => {
    const first = await bootstrap("01-first", "foundation")
    const second = await bootstrap("02-second", "feature")
    await provisionSaneRole({ implementationRepository, role: "research", templateRoot, write: () => {} })
    expect(await readFile(join(second, "research", "INDEX.md"), "utf8")).toBe("shared/research/INDEX.md\n")
    await provisionSaneRole({ implementationRepository, role: "design", workstreamPath: "01-first", templateRoot, write: () => {} })
    expect(await readFile(join(first, "design", "SPEC.md"), "utf8")).toBe("foundation/design/SPEC.md\n")
    await provisionSaneRole({ implementationRepository, role: "design", templateRoot, write: () => {} })
    expect(await readFile(join(second, "design", "SPEC.md"), "utf8")).toBe("feature/design/SPEC.md\n")
  })

  test("enforces role and stage constraints and refuses existing artifacts", async () => {
    const workstream = await bootstrap("01-stage")
    await expect(provisionSaneRole({ implementationRepository, role: "product", templateRoot, write: () => {} })).rejects.toThrow("Unsupported role")
    await expect(provisionSaneRole({ implementationRepository, role: "stage-design", templateRoot, write: () => {} })).rejects.toThrow("Stage must")
    await expect(provisionSaneRole({ implementationRepository, role: "engineering", stage: "1-unsafe/path", templateRoot, write: () => {} })).rejects.toThrow("Stage must")
    await provisionSaneRole({ implementationRepository, role: "stage-design", stage: "01-foundation", templateRoot, write: () => {} })
    expect(await readFile(join(workstream, "design", "stages", "01-foundation", "SPEC.md"), "utf8")).toBe("shared/design/stage/SPEC.md\n")
    await expect(provisionSaneRole({ implementationRepository, role: "stage-design", stage: "01-foundation", templateRoot, write: () => {} })).rejects.toThrow("Refusing to overwrite")
  })

  test("role dry run validates all inputs and leaves artifacts and stage directories absent", async () => {
    const workstream = await bootstrap("01-dry")
    await provisionSaneRole({ implementationRepository, role: "execution", stage: "03-release", templateRoot, dryRun: true, write: () => {} })
    await expectMissing(join(workstream, "execution", "stages", "03-release"))
  })

  test("validates every role source before creating any destination", async () => {
    const workstream = await bootstrap("01-sources")
    await rm(join(templateRoot, "shared", "research", "TECH_BRIEF.md"))
    await expect(provisionSaneRole({ implementationRepository, role: "research", templateRoot, write: () => {} })).rejects.toThrow("Required source template")
    await expectMissing(join(workstream, "research", "INDEX.md"))
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
