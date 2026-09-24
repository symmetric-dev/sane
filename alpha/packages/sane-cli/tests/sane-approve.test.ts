/**
 * SANE `sane approve <phase>` tests (phase model, no gates).
 *
 * Covers validation-first refusal, approval recording with composite hash,
 * phase status advancement to `approved`, planning job-spec registration as
 * `planned`, execution batch acceptance, and actor_role audit.
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
  parseCliArguments as parseJobArguments,
  runCli as runJobCli,
  runSaneJobRegisterCommand,
} from "../src/sane-job-command.ts"
import { runSaneValidateCommand } from "../src/sane-validate-command.ts"
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
  listJobs,
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
const CLEAN_PLAN = "# Plan\nReal plan package.\n## Execution Checkpoints\n| Checkpoint | After job(s) | Jobs | Review purpose |\n| --- | --- | --- | --- |\n| Checkpoint 1 | 02 | 01, 02 | Review delivery |\n"
const CLEAN_JOB_A = "# Job Spec 01: first\nReal job.\n"
const CLEAN_JOB_B = "# Job Spec 02: second\nReal job.\n"
const CLEAN_FINAL_REPORT = "# Final Report\nReal outcomes.\n"
const CLEAN_REPORT = "# Job 01: first Report\n\n## Outcome\nReal results.\n## Unresolved Issues\nNone\n## Recommendations\nNone\n"

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

  const quiet = { workstreamPath: "01-demo", write: () => {} }

  async function approvePlan() {
    await writeDoc("execution/PLAN.md", CLEAN_PLAN)
    await writeDoc("execution/jobs/01-first.md", CLEAN_JOB_A)
    await writeDoc("execution/jobs/02-second.md", CLEAN_JOB_B)
    await writeDoc("execution/verification/checkpoint-1.md", "# Verification Spec: Checkpoint 1\nCheck delivered behavior.\n")
    return runSaneApproveCommand({ ...quiet, implementationRepository, phase: "planning", approvalRef: "original-user-approval" })
  }

  async function snapshot() {
    const db = await openSaneDb(identity.repoRoot)
    try {
      return {
        approval: getApproval(db, identity, "planning"),
        state: listStateEntries(db, identity),
        jobs: listJobs(db, identity),
        mutations: listMutations(db, identity),
      }
    } finally {
      db.close()
    }
  }

  test("job registration requires an existing Planning approval", async () => {
    await writeDoc("execution/PLAN.md", CLEAN_PLAN)
    await writeDoc("execution/jobs/01-first.md", CLEAN_JOB_A)
    const before = await snapshot()
    await expect(runSaneJobRegisterCommand({ ...quiet, implementationRepository })).rejects.toThrow(/existing Planning approval/)
    expect(await snapshot()).toEqual(before)
  })

  test("job registration preserves progress and approval, audits Planning, and is idempotent", async () => {
    await approvePlan()
    const db = await openSaneDb(identity.repoRoot)
    try {
      updateJobStatus(db, identity, "01", "running", { actorRole: "execution", sessionId: "progress" })
      updateJobStatus(db, identity, "02", "completed", { actorRole: "execution", sessionId: "progress" }, { reportPath: "execution/reports/02-second.md" })
    } finally {
      db.close()
    }
    const before = await snapshot()
    await writeDoc("execution/jobs/03-added.md", "# Added job\nAuthorized follow-up.\n")
    const lines: string[] = []
    const result = await runSaneJobRegisterCommand({ ...quiet, implementationRepository, json: true, write: (line) => lines.push(line) })
    expect(JSON.parse(lines[0]!).jobs).toEqual(result.jobs)
    expect(result.jobs.map((job) => job.status)).toEqual(["running", "completed", "planned"])
    const after = await snapshot()
    expect(after.approval).toEqual(before.approval)
    expect(after.state).toEqual(before.state)
    expect(after.jobs.slice(0, 2)).toEqual(before.jobs)
    expect(after.mutations.length).toBe(before.mutations.length + 1)
    const dbAfter = await openSaneDb(identity.repoRoot)
    try {
      const creates = listMutations(dbAfter, { ...identity, tableName: "jobs" })
      expect(creates.filter((mutation) => mutation.actor_role === "planning")).toHaveLength(1)
      expect(creates.some((mutation) => mutation.session_id.startsWith("cli-job-register-"))).toBe(true)
    } finally {
      dbAfter.close()
    }
    await runSaneJobRegisterCommand({ ...quiet, implementationRepository })
    expect(await snapshot()).toEqual(after)
  })

  test.each(["invalid spec", "invalid plan", "duplicate new ID", "duplicate existing ID", "renamed spec", "path reassignment", "empty ID"])("registration rejects %s without partial mutation", async (scenario) => {
    await approvePlan()
    await writeDoc("execution/jobs/00-valid-addition.md", "# Valid addition\n")
    if (scenario === "invalid spec") await writeDoc("execution/jobs/03-invalid.md", "<!-- unfinished -->")
    if (scenario === "invalid plan") await writeDoc("execution/PLAN.md", "")
    if (scenario === "duplicate new ID") {
      await writeDoc("execution/jobs/03-first.md", "# First\n")
      await writeDoc("execution/jobs/03-second.md", "# Second\n")
    }
    if (scenario === "duplicate existing ID") await writeDoc("execution/jobs/01-collision.md", "# Collision\n")
    if (scenario === "renamed spec") {
      await rm(join(workstreamDir, "execution/jobs/02-second.md"))
      await writeDoc("execution/jobs/02-renamed.md", CLEAN_JOB_B)
    }
    if (scenario === "path reassignment") {
      const db = await openSaneDb(identity.repoRoot)
      try {
        createJob(db, identity, { jobId: "legacy", specPath: "execution/jobs/03-added.md" }, { actorRole: "planning", sessionId: "legacy" })
      } finally {
        db.close()
      }
      await writeDoc("execution/jobs/03-added.md", "# Added\n")
    }
    if (scenario === "empty ID") await writeDoc("execution/jobs/-empty.md", "# Empty ID\n")
    const before = await snapshot()
    await expect(runSaneJobRegisterCommand({ ...quiet, implementationRepository })).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  test("initial approval and reapproval reject colliding IDs atomically", async () => {
    await writeDoc("execution/PLAN.md", CLEAN_PLAN)
    await writeDoc("execution/verification/checkpoint-1.md", "# Verification Spec: Checkpoint 1\nCheck delivery.\n")
    await writeDoc("execution/jobs/00-valid.md", CLEAN_JOB_A)
    await writeDoc("execution/jobs/01-first.md", CLEAN_JOB_A)
    await writeDoc("execution/jobs/01-second.md", CLEAN_JOB_B)
    const before = await snapshot()
    await expect(runSaneApproveCommand({ ...quiet, implementationRepository, phase: "planning", approvalRef: "must-not-record" })).rejects.toThrow(/Duplicate job ID/)
    expect(await snapshot()).toEqual(before)
    await rm(join(workstreamDir, "execution/jobs/01-second.md"))
    await approvePlan()
    await rm(join(workstreamDir, "execution/jobs/02-second.md"))
    await writeDoc("execution/jobs/02-renamed.md", CLEAN_JOB_B)
    const approved = await snapshot()
    await expect(runSaneApproveCommand({ ...quiet, implementationRepository, phase: "planning", approvalRef: "must-not-replace" })).rejects.toThrow(/cannot reassign/)
    expect(await snapshot()).toEqual(approved)
  })

  test("Planning drift retains authority and directs escalation to the user; other phases retain reapproval warning", async () => {
    await approvePlan()
    await writeDoc("execution/PLAN.md", CLEAN_PLAN.replace("Real plan package.", "Amended plan package."))
    const result = await runSaneValidateCommand({ ...quiet, implementationRepository, phase: "planning" })
    expect(result.ok).toBe(true)
    const warning = result.warnings.join("\n")
    expect(warning).toContain("differ from the approved snapshot")
    expect(warning).toContain("within existing authorization may continue without reapproval")
    expect(warning).toContain("directly to the user")
    expect(warning).not.toContain("re-approve to refresh authority")
    await writeDoc("PRD.md", CLEAN_PRD)
    await writeDoc("design/SDD.md", CLEAN_SDD)
    await runSaneApproveCommand({ ...quiet, implementationRepository, phase: "design", approvalRef: "design-ok" })
    await writeDoc("design/SDD.md", "# Changed design\n")
    const design = await runSaneValidateCommand({ ...quiet, implementationRepository, phase: "design" })
    expect(design.warnings.join("\n")).toContain("re-approve to refresh authority")
  })

  test("registration CLI parses, auto-detects the workstream, and returns failures", async () => {
    expect(parseJobArguments(["--register", "--json"])).toMatchObject({ register: true, json: true })
    expect(() => parseJobArguments(["01", "--register"])).toThrow(/cannot be combined/)
    expect(() => parseJobArguments(["--register", "completed"])).toThrow(/cannot be combined/)
    await approvePlan()
    await writeDoc("execution/jobs/03-added.md", "# Added\n")
    const previousCwd = process.cwd()
    process.chdir(implementationRepository)
    try {
      expect(await runJobCli(["--register", "--json"])).toBe(0)
      expect((await snapshot()).jobs).toHaveLength(3)
      await writeDoc("execution/jobs/04-invalid.md", "")
      expect(await runJobCli(["--register"])).toBe(1)
    } finally {
      process.chdir(previousCwd)
    }
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

  test("approve planning registers job specs from disk as planned", async () => {
    await writeDoc("execution/PLAN.md", CLEAN_PLAN)
    await writeDoc("execution/verification/checkpoint-1.md", "# Verification Spec: Checkpoint 1\nCheck delivery.\n")
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
      "01=planned",
      "02=planned",
    ])

    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      expect(getJob(db, identity, "01")?.spec_path).toBe("execution/jobs/01-first.md")
      expect(getJob(db, identity, "02")?.status).toBe("planned")
      expect(getApproval(db, identity, "planning")?.approval_ref).toBe("user-ok-plan")
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("approve engineering records without touching jobs; approve execution batch-accepts", async () => {
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

    await writeDoc("execution/PLAN.md", CLEAN_PLAN)
    await writeDoc("execution/verification/checkpoint-1.md", "# Verification Spec: Checkpoint 1\nCheck delivery.\n")
    await writeDoc("execution/jobs/01-first.md", CLEAN_JOB_A)
    await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "planning",
      approvalRef: "user-ok-plan",
      write: () => {},
    })

    await writeDoc("execution/FINAL_REPORT.md", CLEAN_FINAL_REPORT)
    await expect(runSaneApproveCommand({ ...quiet, implementationRepository, phase: "execution", approvalRef: "must-fail" })).rejects.toThrow(/Missing report for job 01/)
    expect(await approvalFor("execution")).toBeNull()
    expect((await snapshot()).jobs[0]?.status).toBe("planned")
    await writeDoc("execution/reports/01-first.md", CLEAN_REPORT)
    await expect(runSaneApproveCommand({ ...quiet, implementationRepository, phase: "execution", approvalRef: "must-fail" })).rejects.toThrow()
    await writeDoc("execution/test-reports/checkpoint-1.md", "# Test Report: Checkpoint 1\n## Outcome\nVerified.\n## Evidence\nFocused check passed.\n## Findings\nNone.\n")
    const execution = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "execution",
      approvalRef: "user-ok-exec",
      write: () => {},
    })
    expect(execution.jobs.map((job) => `${job.job_id}=${job.status}`)).toEqual([
      "01=completed",
    ])
    expect(await approvalFor("execution")).not.toBeNull()

    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      expect(getJob(db, identity, "01")?.status).toBe("completed")
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("planned jobs move forward directly; backward moves rejected", async () => {
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      createJob(
        db,
        identity,
        { jobId: "job-direct", specPath: "execution/jobs/job-direct-a.md" },
        { actorRole: "planning", sessionId: "ses-plan" },
      )
      updateJobStatus(db, identity, "job-direct", "running", {
        actorRole: "execution",
        sessionId: "ses-exec",
      })
      expect(getJob(db, identity, "job-direct")?.status).toBe("running")
      updateJobStatus(db, identity, "job-direct", "completed", {
        actorRole: "execution",
        sessionId: "ses-exec",
      })
      expect(getJob(db, identity, "job-direct")?.status).toBe("completed")
      expect(() =>
        updateJobStatus(db, identity, "job-direct", "running", {
          actorRole: "execution",
          sessionId: "ses-exec",
        }),
      ).toThrow(/backward moves rejected/)
      expect(getApproval(db, identity, "execution")).toBeNull()
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
