/**
 * SANE `sane provide <phase>` tests.
 *
 * Covers starter provisioning per phase, never-overwrite, and the
 * bare-only parser.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"
import {
  parseCliArguments,
  runCli,
  runSaneProvideCommand,
  USAGE,
} from "../src/sane-provide-command.ts"
import { resolveSaneIdentity, type SaneIdentity } from "../src/sane-db.ts"

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

  test("parseCliArguments takes a bare phase positional only", () => {
    expect(parseCliArguments(["planning"])).toMatchObject({ phase: "planning" })
    expect(() => parseCliArguments([])).toThrow(/exactly one phase/)
    expect(() => parseCliArguments(["bogus"])).toThrow(/Invalid phase/)
    expect(() => parseCliArguments(["planning", "--bogus"])).toThrow(/Unknown option/)
    expect(USAGE).toContain("sane provide")
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
