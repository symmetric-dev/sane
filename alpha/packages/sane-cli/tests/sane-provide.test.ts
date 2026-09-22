/**
 * SANE `sane provide <phase>` tests.
 *
 * Covers starter provisioning per phase, never-overwrite, and the
 * bare-only parser.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"
import {
  parseCliArguments,
  runCli,
  runSaneProvideCommand,
  refreshResourceTemplates,
  USAGE,
} from "../src/sane-provide-command.ts"
import { resolveSaneIdentity, type SaneIdentity } from "../src/sane-db.ts"
import { initialTemplateRegistry } from "../src/create-sane-workstream.ts"

const execFileAsync = promisify(execFile)

describe("sane-provide (phase starters)", () => {
  let tempDirectory: string
  let implementationRepository: string
  let identity: SaneIdentity
  let workstreamDir: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-provide-"))
    implementationRepository = join(tempDirectory, "repo")
    await mkdir(implementationRepository, { recursive: true })
    await execFileAsync("git", ["init", "--quiet", implementationRepository])
    await initializeSaneRepository({ implementationRepository, write: () => {} })
    await createSaneRepositoryWorkstream({
      implementationRepository,
      workstreamPath: "01-demo",
      type: "feature",
      write: () => {},
    })
    identity = await resolveSaneIdentity(implementationRepository, "01-demo")
    workstreamDir = join(identity.repoRoot, ".sane", "workstreams", identity.workstreamId)
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  async function provide(
    phase: "design" | "engineering" | "planning" | "execution",
  ) {
    const lines: string[] = []
    const result = await runSaneProvideCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase,
      write: (line) => lines.push(line),
    })
    return { result, lines }
  }

  test("engineering provisions a solutions starter once", async () => {
    const first = await provide("engineering")
    expect(first.result.created).toEqual(["design/solutions/SOLUTION.md"])
    const template = await readFile(
      join(workstreamDir, "resources/SOLUTION_SPEC_TEMPLATE.md"),
      "utf8",
    )
    expect(await readFile(join(workstreamDir, "design/solutions/SOLUTION.md"), "utf8")).toBe(template)

    // Never overwrites: agent edits survive a second run.
    await writeFile(join(workstreamDir, "design/solutions/SOLUTION.md"), "# Mine\n")
    const second = await provide("engineering")
    expect(second.result.created).toEqual([])
    expect(await readFile(join(workstreamDir, "design/solutions/SOLUTION.md"), "utf8")).toBe("# Mine\n")
    expect(second.lines.join("\n")).toContain("already provided")
  })

  test("planning and execution provision their starters", async () => {
    const planning = await provide("planning")
    expect(planning.result.created).toEqual(["execution/PLAN.md"])
    const execution = await provide("execution")
    expect(execution.result.created).toEqual(["execution/FINAL_REPORT.md"])
  })

  test("design keeps the bootstrap root and SDD", async () => {
    const { result } = await provide("design")
    expect(result.created).toEqual([])
    expect(result.existed).toContain("PRD.md")
    expect(result.existed).toContain("design/SDD.md")
  })

  test("explicit refresh replaces resource templates only and preserves authored documents", async () => {
    await writeFile(join(workstreamDir, "resources/EXECUTION_REPORT_TEMPLATE.md"), "obsolete")
    await writeFile(join(workstreamDir, "design/SDD.md"), "authored")
    const result = await runSaneProvideCommand({ implementationRepository, workstreamPath: "01-demo", phase: "execution", refreshTemplates: true, write: () => {} })
    expect(result.created).toEqual([])
    expect(result.refreshed).toContain("resources/EXECUTION_REPORT_TEMPLATE.md")
    expect(result.refreshed.every((path) => path.startsWith("resources/"))).toBe(true)
    expect(await readFile(join(workstreamDir, "design/SDD.md"), "utf8")).toBe("authored")
    expect(await readFile(join(workstreamDir, "resources/EXECUTION_REPORT_TEMPLATE.md"), "utf8")).toContain("## Accomplished")
    expect(await Bun.file(join(workstreamDir, "execution/FINAL_REPORT.md")).exists()).toBe(false)
    expect(parseCliArguments(["execution", "--refresh-templates"])).toMatchObject({ refreshTemplates: true })
  })

  test("parseCliArguments takes a bare phase positional only", () => {
    expect(parseCliArguments(["planning"])).toMatchObject({ phase: "planning" })
    expect(() => parseCliArguments([])).toThrow(/exactly one phase/)
    expect(() => parseCliArguments(["bogus"])).toThrow(/Invalid phase/)
    expect(() => parseCliArguments(["planning", "--bogus"])).toThrow(/Unknown option/)
    expect(USAGE).toContain("sane provide")
  })

  test.each(["destination file", "destination directory", "destination dangling", "source file", "source ancestor", "destination nonfile", "missing source"])("refresh preflights all templates before writes: %s", async (scenario) => {
    const source = join(tempDirectory, "templates")
    const target = join(tempDirectory, "refresh-target")
    const registry = initialTemplateRegistry("feature").filter((entry) => entry.destination.startsWith("resources/"))
    for (const entry of registry) {
      await mkdir(join(source, entry.source, ".."), { recursive: true })
      await mkdir(join(target, entry.destination, ".."), { recursive: true })
      await writeFile(join(source, entry.source), "new template")
      await writeFile(join(target, entry.destination), "retained template")
    }
    const authored = join(tempDirectory, "authored.md")
    await writeFile(authored, "authored evidence")
    const last = registry.at(-1)!
    if (scenario.startsWith("destination") && scenario !== "destination directory") {
      const path = join(target, last.destination)
      await rm(path)
      if (scenario === "destination nonfile") await mkdir(path)
      else await symlink(scenario === "destination dangling" ? join(tempDirectory, "absent.md") : authored, path)
    } else if (scenario === "destination directory") {
      await rm(join(target, "resources"), { recursive: true })
      await symlink(join(workstreamDir, "resources"), join(target, "resources"))
    } else if (scenario === "source file") {
      await rm(join(source, last.source))
      await symlink(authored, join(source, last.source))
    } else if (scenario === "source ancestor") {
      await rm(join(source, "shared/execution"), { recursive: true })
      await symlink(join(workstreamDir, "resources"), join(source, "shared/execution"))
    } else await rm(join(source, last.source))
    const first = join(target, registry[0]!.destination)
    const before = await readFile(first, "utf8")
    await expect(refreshResourceTemplates(target, "feature", source)).rejects.toThrow()
    expect(await readFile(first, "utf8")).toBe(before)
    expect(await readFile(authored, "utf8")).toBe("authored evidence")
    expect(await Bun.file(join(tempDirectory, "absent.md")).exists()).toBe(false)
  })

  test("runCli resolves the workstream from CWD", async () => {
    const previousCwd = process.cwd()
    process.chdir(implementationRepository)
    try {
      expect(await runCli(["execution"])).toBe(0)
    } finally {
      process.chdir(previousCwd)
    }
  })
})
