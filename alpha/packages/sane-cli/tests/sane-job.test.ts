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
import { runSaneViewCommand, parseCliArguments as parseView } from "../src/sane-view-command.ts"
import { runSaneStatusCommand, parseCliArguments as parseStatus } from "../src/sane-status-command.ts"
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
    await writeDoc("execution/PLAN.md", "# Plan\n## Execution Checkpoints\n| Checkpoint | After job(s) | Jobs | Review purpose |\n| --- | --- | --- | --- |\n| Checkpoint 1 | 01 | 01 | Review delivery |\n")
    await writeDoc("execution/jobs/01-first.md", "# Job\nReal job.\n")
    await writeDoc("execution/verification/checkpoint-1.md", "# Verification Spec: Checkpoint 1\nCheck delivery.\n")
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
    expect(lines.filter((line) => line.includes(workstreamDir))).toHaveLength(1)
    expect(lines.join("\n")).toContain("Paths below are relative to workstream root:")
    expect(lines.join("\n")).toContain("spec: execution/jobs/01-first.md")
    expect(lines.join("\n")).toContain("report_template: resources/EXECUTION_REPORT_TEMPLATE.md")
    expect(lines).toHaveLength(7)
    for (const unrelated of ["Repository root:", "root_doc:", "sdd:", "plan:", "solution:", "final_report:", "planning_approval:", "design/"]) {
      expect(lines.join("\n")).not.toContain(unrelated)
    }
    const json: string[] = []
    await runSaneJobViewCommand({ implementationRepository, workstreamPath: "01-demo", jobId: "01", json: true, write: (line) => json.push(line) })
    expect(JSON.parse(json.join("\n")).job.spec_path).toBe(bundle.job.specPath)
    const output = JSON.parse(json.join("\n"))
    expect(output.workstream_root).toBe(workstreamDir)
    expect(output).not.toHaveProperty("documents")
    expect(output).not.toHaveProperty("planning_approval")
    expect(json.join("\n")).not.toContain("design/")

    await expect(
      runSaneJobViewCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        jobId: "nope",
        write: () => {},
      }),
    ).rejects.toThrow(/Job not found: nope/)
  })

  test("view and status offer compact defaults, opt-in detail and structured JSON", async () => {
    const lines: string[] = []
    const options = { implementationRepository, workstreamPath: "01-demo", write: (line: string) => lines.push(line) }
    await runSaneViewCommand(options)
    expect(lines.join("\n")).toContain("01 planned")
    expect(lines.join("\n")).not.toContain("sane_hash")
    expect(lines.join("\n").match(/execution\/jobs\/01-first.md/g)).toHaveLength(1)
    lines.length = 0
    await runSaneViewCommand({ ...options, verbose: true })
    expect(lines.join("\n")).toContain("sane_hash:")
    lines.length = 0
    await runSaneViewCommand({ ...options, json: true })
    const state = JSON.parse(lines.join("\n"))
    expect(state.rendered).toBeUndefined()
    expect(state.jobs[0]).toMatchObject({ job_id: "01", status: "planned" })
    expect(state.approvals[0].approval_ref).toBe("user-ok-plan")
    expect(state.sessions).toBeArray()
    lines.length = 0
    await runSaneStatusCommand(options)
    expect(lines.join("\n")).toContain("1 planned")
    expect(lines.join("\n")).not.toContain("user-ok-plan")
    lines.length = 0
    await runSaneStatusCommand({ ...options, verbose: true })
    expect(lines.join("\n")).toContain("01 planned")
    expect(lines.join("\n")).toContain("user-ok-plan")
    lines.length = 0
    await runSaneStatusCommand({ ...options, json: true })
    expect(JSON.parse(lines.join("\n")).jobs).toEqual([{ job_id: "01", status: "planned", spec_path: "execution/jobs/01-first.md", report_path: null }])
    for (const parse of [parseView, parseStatus]) {
      for (const args of [[], ["01-demo"], ["/repo", "01-demo"], ["01-demo", "--repo-root", "/repo"]]) {
        expect(parse([...args, "--verbose"]).verbose).toBe(true)
      }
    }
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
