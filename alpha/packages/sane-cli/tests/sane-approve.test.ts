/**
 * SANE `sane approve <phase>` tests (phase model, no gates).
 *
 * Covers validation-first refusal, approval recording with composite hash,
 * phase status advancement to `approved`, planning job-spec registration +
 * authorize, direct `planned -> authorized` rejection, and actor_role audit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"
import {
  parseCliArguments,
  runCli,
  runSaneApproveCommand,
  USAGE,
} from "../src/sane-approve-command.ts"
import {
  createJob,
  getApproval,
  getJob,
  initSchema,
  listMutations,
  listStateEntries,
  openSaneDb,
  resolveSaneIdentity,
  updateJobStatus,
  type SaneIdentity,
} from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

const CLEAN_PRD = "# PRD\nReal product direction.\n"
const CLEAN_SDD = "# Solution Design Document\nReal technical direction.\n"
const CLEAN_PLAN = "# Plan\nReal plan package.\n"
const CLEAN_JOB_A = "# Job Spec 01: first\nReal job.\n"
const CLEAN_JOB_B = "# Job Spec 02: second\nReal job.\n"
const CLEAN_FINAL_REPORT = "# Final Report\nReal outcomes.\n"
const CLEAN_REPORT = "# Report\nReal results.\n"

describe("sane-approve (phase approvals)", () => {
  let tempDirectory: string
  let implementationRepository: string
  let identity: SaneIdentity
  let workstreamDir: string

  async function writeDoc(relativePath: string, content: string): Promise<void> {
    const full = join(workstreamDir, relativePath)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content)
  }

  async function approvalFor(phase: string) {
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      return getApproval(db, identity, phase)
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  }

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-approve-phase-"))
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

  test("approve design validates, records, and marks the phase approved", async () => {
    await writeDoc("PRD.md", CLEAN_PRD)
    await writeDoc("design/SDD.md", CLEAN_SDD)
    const lines: string[] = []
    const result = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "design",
      approvalRef: "user-ok-design",
      write: (line) => lines.push(line),
    })
    expect(result.phase).toBe("design")
    expect(result.files).toEqual(["PRD.md", "design/SDD.md"])
    expect(result.approvalRef).toBe("user-ok-design")
    expect(result.saneHash.trim()).not.toBe("")
    expect(lines.join("\n")).toContain("Approved design")

    const row = await approvalFor("design")
    expect(row).not.toBeNull()
    expect(row?.phase).toBe("design")
    expect(row?.approval_ref).toBe("user-ok-design")
    expect(row?.artifact_path).toBe("PRD.md, design/SDD.md")

    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      const entry = listStateEntries(db, identity).find((row) => row.phase === "design")
      expect(entry?.status).toBe("approved")
      expect(entry?.approval_ref).toBe("user-ok-design")
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("approve refuses when validation finds problems and records nothing", async () => {
    // Fresh bootstrap files still carry template guidance comments.
    await expect(
      runSaneApproveCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        phase: "design",
        approvalRef: "user-ok",
        write: () => {},
      }),
    ).rejects.toThrow(/Cannot approve design/)
    expect(await approvalFor("design")).toBeNull()
  })

  test("approve planning registers job specs from disk and authorizes them", async () => {
    await writeDoc("execution/PLAN.md", CLEAN_PLAN)
    await writeDoc("execution/jobs/01-first.md", CLEAN_JOB_A)
    await writeDoc("execution/jobs/02-second.md", CLEAN_JOB_B)
    const result = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "planning",
      approvalRef: "user-ok-plan",
      write: () => {},
    })
    expect(result.jobs.map((job) => `${job.job_id}=${job.status}`).sort()).toEqual([
      "01=authorized",
      "02=authorized",
    ])

    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      expect(getJob(db, identity, "01")?.spec_path).toBe("execution/jobs/01-first.md")
      expect(getJob(db, identity, "02")?.status).toBe("authorized")
      expect(getApproval(db, identity, "planning")?.approval_ref).toBe("user-ok-plan")
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("approve engineering and execution record without touching jobs", async () => {
    await writeDoc("design/solutions/api.md", "# Spec\nReal spec.\n")
    const engineering = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "engineering",
      approvalRef: "user-ok-eng",
      write: () => {},
    })
    expect(engineering.jobs).toEqual([])
    expect(await approvalFor("engineering")).not.toBeNull()

    await writeDoc("execution/FINAL_REPORT.md", CLEAN_FINAL_REPORT)
    await writeDoc("execution/reports/01-first.md", CLEAN_REPORT)
    const execution = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "execution",
      approvalRef: "user-ok-exec",
      write: () => {},
    })
    expect(execution.files).toEqual(["execution/FINAL_REPORT.md", "execution/reports/01-first.md"])
    expect(await approvalFor("execution")).not.toBeNull()
  })

  test("direct planned -> authorized without approval is still rejected", async () => {
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      createJob(
        db,
        identity,
        { jobId: "job-direct", specPath: "execution/jobs/job-direct-a.md" },
        { actorRole: "planning", sessionId: "ses-plan" },
      )
      expect(() =>
        updateJobStatus(db, identity, "job-direct", "authorized", {
          actorRole: "planning",
          sessionId: "ses-plan",
        }),
      ).toThrow(/planned -> authorized directly/)
      expect(getJob(db, identity, "job-direct")?.status).toBe("planned")
      expect(getApproval(db, identity, "planning")).toBeNull()
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("approval mutations record actor_role=user", async () => {
    await writeDoc("PRD.md", CLEAN_PRD)
    await writeDoc("design/SDD.md", CLEAN_SDD)
    await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "design",
      approvalRef: "user-ok-audit",
      write: () => {},
    })
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      const mutations = listMutations(db, {
        repoRoot: identity.repoRoot,
        user: identity.user,
        workstreamId: identity.workstreamId,
        tableName: "approvals",
      })
      expect(mutations.length).toBeGreaterThan(0)
      expect(mutations.some((m) => m.actor_role === "user")).toBe(true)
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("parseCliArguments takes a phase positional plus --ref (bare auto-detect)", () => {
    const parsed = parseCliArguments(["design", "--ref", "user-ok"])
    expect(parsed).toMatchObject({ phase: "design", approvalRef: "user-ok", json: false })
    expect(parsed.implementationRepository).toBe("")
    expect(parsed.workstreamPath).toBe("")

    expect(() => parseCliArguments([])).toThrow(/exactly one phase/)
    expect(() => parseCliArguments(["design", "extra", "--ref", "r"])).toThrow(
      /exactly one phase/,
    )
    expect(() => parseCliArguments(["bogus", "--ref", "r"])).toThrow(/Invalid approval phase/)
    expect(() => parseCliArguments(["design"])).toThrow(/Option --ref is required/)
    expect(() => parseCliArguments(["design", "--ref", "r", "--bogus"])).toThrow(
      /Unknown option: --bogus/,
    )
  })

  test("runCli returns 0/1 and USAGE documents the command", async () => {
    expect(USAGE).toContain("sane approve")
    expect(USAGE).toContain("--ref")
    expect(USAGE).not.toContain("--gate")
    expect(USAGE).not.toContain("--artifact")
    expect(USAGE).not.toContain("--job")

    await writeDoc("PRD.md", CLEAN_PRD)
    await writeDoc("design/SDD.md", CLEAN_SDD)
    const previousCwd = process.cwd()
    process.chdir(implementationRepository)
    try {
      expect(await runCli(["design", "--ref", "user-ok-cli"])).toBe(0)
      expect((await approvalFor("design"))?.approval_ref).toBe("user-ok-cli")
      // Validation problems -> 1.
      expect(await runCli(["engineering", "--ref", "r"])).toBe(1)
    } finally {
      process.chdir(previousCwd)
    }
  })
})
