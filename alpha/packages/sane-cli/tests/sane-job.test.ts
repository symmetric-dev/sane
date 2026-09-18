/**
 * SANE `sane job <job-id> <running|completed>` tests.
 *
 * Covers progress marking forward (planned -> running -> completed),
 * same-status no-op, backward rejection, unknown-job error, and the
 * bare-only parser with CWD auto-detection.
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
  runSaneJobCommand,
  runSaneJobViewCommand,
  USAGE,
} from "../src/sane-job-command.ts"
import { runSaneApproveCommand } from "../src/sane-approve-command.ts"
import {
  getJob,
  initSchema,
  openSaneDb,
  resolveSaneIdentity,
  type SaneIdentity,
} from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

describe("sane-job (progress tracking)", () => {
  let tempDirectory: string
  let implementationRepository: string
  let identity: SaneIdentity
  let workstreamDir: string

  async function writeDoc(relativePath: string, content: string): Promise<void> {
    const full = join(workstreamDir, relativePath)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content)
  }

  async function jobStatus(jobId: string): Promise<string | undefined> {
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      return getJob(db, identity, jobId)?.status
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  }

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-job-"))
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
    await writeDoc("execution/PLAN.md", "# Plan\nReal plan.\n")
    await writeDoc("execution/jobs/01-first.md", "# Job\nReal job.\n")
    await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      phase: "planning",
      approvalRef: "user-ok-plan",
      write: () => {},
    })
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  test("marks running then completed, reports already on no-op", async () => {
    const lines: string[] = []
    const running = await runSaneJobCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      jobId: "01",
      status: "running",
      write: (line) => lines.push(line),
    })
    expect(running).toMatchObject({ jobId: "01", status: "running", changed: true })
    expect(lines.join("\n")).toContain("planned -> running")

    const repeat = await runSaneJobCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      jobId: "01",
      status: "running",
      write: () => {},
    })
    expect(repeat.changed).toBe(false)

    await runSaneJobCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      jobId: "01",
      status: "completed",
      write: () => {},
    })
    expect(await jobStatus("01")).toBe("completed")
  })

  test("rejects backward moves and unknown jobs", async () => {
    await runSaneJobCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      jobId: "01",
      status: "completed",
      write: () => {},
    })
    await expect(
      runSaneJobCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        jobId: "01",
        status: "running",
        write: () => {},
      }),
    ).rejects.toThrow(/backward moves rejected/)
    await expect(
      runSaneJobCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        jobId: "nope",
        status: "running",
        write: () => {},
      }),
    ).rejects.toThrow(/Job not found: nope/)
  })

  test("parseCliArguments takes a job id with an optional running|completed", () => {
    expect(parseCliArguments(["01"])).toMatchObject({ jobId: "01", status: null })
    expect(parseCliArguments(["01", "running"])).toMatchObject({ jobId: "01", status: "running" })
    expect(() => parseCliArguments([])).toThrow(/exactly one job id/)
    expect(() => parseCliArguments(["01", "running", "extra"])).toThrow(/exactly one job id/)
    expect(() => parseCliArguments(["01", "planned"])).toThrow(/Invalid job status/)
    expect(() => parseCliArguments(["01", "running", "--bogus"])).toThrow(/Unknown option/)
    expect(USAGE).toContain("sane job")
  })

  test("view form serializes the worker context bundle", async () => {
    await writeDoc("design/solutions/api.md", "# Spec\nReal spec.\n")
    const lines: string[] = []
    const bundle = await runSaneJobViewCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      jobId: "01",
      write: (line) => lines.push(line),
    })
    expect(bundle.workstreamId).toBe("01-demo")
    expect(bundle.job).toMatchObject({ jobId: "01", status: "planned" })
    expect(bundle.job.specPath).toBe(join(workstreamDir, "execution/jobs/01-first.md"))
    expect(bundle.job.specExists).toBe(true)
    expect(bundle.job.reportPath).toBe(join(workstreamDir, "execution/reports/01-first.md"))
    expect(bundle.job.reportExists).toBe(false)
    expect(bundle.reportTemplate).toBe(
      join(workstreamDir, "resources/EXECUTION_REPORT_TEMPLATE.md"),
    )
    expect(bundle.documents.sdd).toBe(join(workstreamDir, "design/SDD.md"))
    expect(bundle.documents.plan).toBe(join(workstreamDir, "execution/PLAN.md"))
    expect(bundle.documents.solutions).toEqual([join(workstreamDir, "design/solutions/api.md")])
    expect(bundle.planningApproval?.approvalRef).toBe("user-ok-plan")
    expect(lines.join("\n")).toContain("job 01 for 01-demo: planned")

    await expect(
      runSaneJobViewCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        jobId: "nope",
        write: () => {},
      }),
    ).rejects.toThrow(/Job not found: nope/)
  })

  test("runCli resolves the workstream from CWD and exits by outcome", async () => {
    const previousCwd = process.cwd()
    process.chdir(implementationRepository)
    try {
      expect(await runCli(["01"])).toBe(0)
      expect(await runCli(["01", "running"])).toBe(0)
      expect(await jobStatus("01")).toBe("running")
      expect(await runCli(["nope"])).toBe(1)
      expect(await runCli(["nope", "running"])).toBe(1)
      expect(await runCli(["01", "planned"])).toBe(1)
    } finally {
      process.chdir(previousCwd)
    }
  })

  test("records actor_role=execution mutations", async () => {
    await runSaneJobCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      jobId: "01",
      status: "running",
      write: () => {},
    })
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      const { listMutations } = await import("../src/sane-db.ts")
      const mutations = listMutations(db, {
        repoRoot: identity.repoRoot,
        user: identity.user,
        workstreamId: identity.workstreamId,
        tableName: "jobs",
      })
      expect(mutations.some((m) => m.actor_role === "execution")).toBe(true)
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })
})
