/**
 * SANE `sane validate <phase>` tests (phase model, no gates).
 *
 * Covers per-phase document expectations, pristine-template and guidance
 * comment refusal, unexpected root docs, research warnings, and the
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
  runSaneValidateCommand,
  validatePhaseDocs,
  USAGE,
} from "../src/sane-validate-command.ts"
import {
  initSchema,
  createJob,
  updateJobStatus,
  openSaneDb,
  resolveSaneIdentity,
  type SaneIdentity,
} from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

const CLEAN_SDD = "# Solution Design Document\nReal direction.\n"
const CLEAN_PRD = "# PRD\nReal product direction.\n"

describe("sane-validate (phase documents)", () => {
  let tempDirectory: string
  let implementationRepository: string
  let identity: SaneIdentity
  let workstreamDir: string

  async function writeDoc(relativePath: string, content: string): Promise<void> {
    const full = join(workstreamDir, relativePath)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content)
  }

  async function validate(phase: "design" | "engineering" | "planning" | "execution") {
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      return await validatePhaseDocs(db, identity, workstreamDir, phase, "feature")
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  }

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-validate-"))
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

  test("fresh bootstrap design fails on pristine template docs", async () => {
    const result = await validate("design")
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("PRD.md")
    expect(result.problems.join("\n")).toContain("design/SDD.md")
  })

  test("design passes with authored root doc and SDD", async () => {
    await writeDoc("PRD.md", CLEAN_PRD)
    await writeDoc("design/SDD.md", CLEAN_SDD)
    const result = await validate("design")
    expect(result.problems).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.files).toEqual(["PRD.md", "design/SDD.md"])
    expect(result.hash.trim()).not.toBe("")
  })

  test("design rejects an unexpected extra root doc", async () => {
    await writeDoc("PRD.md", CLEAN_PRD)
    await writeDoc("design/SDD.md", CLEAN_SDD)
    await writeDoc("FOUNDATION.md", "# Foundation\nWrong type.\n")
    const result = await validate("design")
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("FOUNDATION.md")
  })

  test("engineering requires at least one authored solution spec", async () => {
    expect((await validate("engineering")).ok).toBe(false)
    // A pristine template copy does not count (guidance comments unresolved).
    const template = await readFile(join(workstreamDir, "resources/SOLUTION_SPEC_TEMPLATE.md"), "utf8")
    await writeDoc("design/solutions/api.md", template)
    const pristine = await validate("engineering")
    expect(pristine.ok).toBe(false)
    expect(pristine.problems.join("\n")).toContain("design/solutions/api.md")
    await writeDoc("design/solutions/api.md", "# Spec\nReal spec.\n")
    const result = await validate("engineering")
    expect(result.ok).toBe(true)
    expect(result.files).toEqual(["design/solutions/api.md"])
  })

  test("planning requires PLAN plus at least one job spec", async () => {
    await writeDoc("execution/PLAN.md", "# Plan\nReal plan.\n")
    expect((await validate("planning")).ok).toBe(false)
    await writeDoc("execution/jobs/01-first.md", "# Job\nReal job.\n")
    const result = await validate("planning")
    expect(result.ok).toBe(true)
    expect(result.files).toEqual(["execution/PLAN.md", "execution/jobs/01-first.md"])
  })

  test("execution requires coverage of completed jobs; scoped validation needs only assigned report", async () => {
    const db = await openSaneDb(identity.repoRoot)
    createJob(db, identity, { jobId: "01", specPath: "execution/jobs/01-first.md" }, { actorRole: "planning", sessionId: "test" })
    updateJobStatus(db, identity, "01", "completed", { actorRole: "execution", sessionId: "test" })
    db.close()
    await writeDoc("execution/jobs/01-first.md", "# Job Spec 01: first\n")
    await writeDoc("execution/FINAL_REPORT.md", "# Final Report\nReal outcomes.\n")
    expect((await validate("execution")).ok).toBe(false)
    await writeDoc("execution/reports/01-first.md", "# Job 01: first Report\n## Outcome\nInvestigation completed; implementation failed.\n## Unresolved Issues\nBuild failed.\n## Recommendations\nRetry with corrected configuration.\n")
    const result = await validate("execution")
    expect(result.ok).toBe(true)
    await rm(join(workstreamDir, "execution/FINAL_REPORT.md"))
    await writeDoc("execution/reports/unrelated.md", "unfinished")
    const output: string[] = []
    const scoped = await runSaneValidateCommand({ implementationRepository, workstreamPath: "01-demo", phase: "execution", reportId: "01", json: true, write: (line) => output.push(line) })
    expect(scoped.ok).toBe(true)
    expect(scoped.files).toEqual(["execution/reports/01-first.md"])
    expect(JSON.parse(output[0]!).reportId).toBe("01")
    expect((await validate("execution")).ok).toBe(false)
  })

  test("parseCliArguments takes a bare phase positional only", () => {
    expect(parseCliArguments(["design"])).toMatchObject({ phase: "design", json: false })
    expect(() => parseCliArguments([])).toThrow(/exactly one phase/)
    expect(() => parseCliArguments(["design", "extra"])).toThrow(/exactly one phase/)
    expect(() => parseCliArguments(["bogus"])).toThrow(/Invalid phase/)
    expect(() => parseCliArguments(["design", "--bogus"])).toThrow(/Unknown option/)
    expect(USAGE).toContain("sane validate")
    expect(parseCliArguments(["execution", "report", "--id", "01", "--json"])).toMatchObject({ phase: "execution", reportId: "01", json: true })
    for (const args of [["execution", "report"], ["design", "--id", "01"], ["execution", "--id", "01"], ["execution", "report", "--id", "01", "--id", "02"]]) expect(() => parseCliArguments(args)).toThrow()
  })

  test("runCli resolves the workstream from CWD and exits by validity", async () => {
    const previousCwd = process.cwd()
    process.chdir(implementationRepository)
    try {
      expect(await runCli(["design"])).toBe(1)
      await writeDoc("PRD.md", CLEAN_PRD)
      await writeDoc("design/SDD.md", CLEAN_SDD)
      expect(await runCli(["design"])).toBe(0)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("runSaneValidateCommand prints problems and warnings", async () => {
    const lines: string[] = []
    const result = await runSaneValidateCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "design",
      write: (line) => lines.push(line),
    })
    expect(result.ok).toBe(false)
    expect(lines.join("\n")).toContain("Invalid design")
  })
})
