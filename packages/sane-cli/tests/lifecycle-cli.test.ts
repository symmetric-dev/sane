/**
 * CLI-level lifecycle coverage against the current architecture.
 *
 * Thin-wrapper layer only (`executeCliCommand` / `runSane*Command(args)` with
 * disposable tmp git repos). Core domain logic is covered by
 * `packages/sane-core/tests/lifecycle-parity.test.ts`; artifact setup writes go
 * through the domain because the CLI has no artifact-write command.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeCliCommand } from "../src/cli-command.ts"
import { runSaneApproveCommand } from "../src/sane-approve-command.ts"
import { runSaneJobRegisterCommand } from "../src/sane-job-command.ts"
import {
  discoverRepository,
  inspectRepositoryStore,
  openRepositoryDomain,
} from "../../sane-core/src/server.ts"
import type { MutationContext } from "../../sane-core/src/contracts.ts"

const mutation: MutationContext = { actor: { kind: "local" }, correlationId: "lifecycle-cli" }
const PLAN = "# Plan\n## Execution Checkpoints\n| Checkpoint | After job(s) |\n| --- | --- |\n| Checkpoint 1 | 01 |\n"
const JOB_A = "# Job Spec 01: first\nWork.\n"
const JOB_B = "# Job Spec 02: second\nAdditional authorized work.\n"
const VERIFY = "# Verify\n"
const REPORT_A = "# Job 01: first Report\n\n## Outcome\nResults.\n## Unresolved Issues\nNone\n## Recommendations\nNone\n"
const REPORT_B = "# Job 02: second Report\n\n## Outcome\nResults.\n## Unresolved Issues\nNone\n## Recommendations\nNone\n"

let temporary = ""
let repo = ""
// Explicit empty signals: the ambient session may export SANE_CALLER_CONTEXT,
// which must never turn these local CLI calls into native invocations.
const cli = (args: string[]) => executeCliCommand(args, { cwd: repo, signals: {} })

function write(path: string, content: string): void {
  const discovery = discoverRepository(repo)
  const state = inspectRepositoryStore(discovery)
  if (state.state !== "ready") throw new Error(state.message)
  const domain = openRepositoryDomain(state.context)
  try {
    domain.writeArtifact("demo", path, content, mutation)
  } finally {
    domain.close()
  }
}

async function status(): Promise<any> {
  // Full evidence lives behind --verbose; default CLI output is compact.
  return (await cli(["status", "--workstream", "demo", "--verbose"])) as any
}

function planningDocs(): void {
  write("execution/PLAN.md", PLAN)
  write("execution/jobs/01-first.md", JOB_A)
  write("execution/verification/checkpoint-1.md", VERIFY)
}

beforeEach(async () => {
  temporary = realpathSync(await mkdtemp(join(tmpdir(), "sane-lifecycle-")))
  repo = join(temporary, "repo")
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "-c", "user.name=Sane Test", "-c", "user.email=sane-test.invalid", "commit", "--allow-empty", "-qm", "fixture"])
  await cli(["init"])
  await cli(["create", "--name", "demo", "--type", "feature", "--title", "Demo"])
})

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true })
})

describe("c9 lifecycle CLI: approvals and advancement", () => {
  test("refuses planning approval when docs are invalid (validation-first)", async () => {
    await expect(cli(["approve", "planning", "--ref", "owner", "--workstream", "demo"])).rejects.toThrow(/Cannot approve planning/)
  })

  test("records engineering approval with hash and advances phase status", async () => {
    write("design/solutions/SOLUTION.md", "# Solution\n")
    const approval = (await cli(["approve", "engineering", "--ref", "owner-approval", "--workstream", "demo"])) as any
    expect(approval.phase).toBe("engineering")
    expect(approval.sane_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(approval.approval_ref).toBe("owner-approval")
    const current = await status()
    expect(current.workstream.lifecycle.phases.find((p: any) => p.phase === "engineering")?.status).toBe("approved")
  })

  test("records design approval via thin wrapper after root doc and SDD", async () => {
    write("PRD.md", "# Direction\n")
    write("design/SDD.md", "# Design\n")
    const approval = (await runSaneApproveCommand(["design", "--ref", "owner", "--workstream", "demo"], { cwd: repo, signals: {} })) as any
    expect(approval.phase).toBe("design")
    const current = await status()
    expect(current.workstream.lifecycle.approvals.filter((a: any) => a.phase === "design")).toHaveLength(1)
  })

  test("amendment warns and reapproval supersedes while history keeps both snapshots", async () => {
    write("PRD.md", "# Direction\n")
    write("design/SDD.md", "# Design\n")
    await cli(["approve", "design", "--ref", "owner", "--workstream", "demo"])
    write("design/SDD.md", "# Amended design\n")
    const validation = (await cli(["validate", "design", "--workstream", "demo"])) as any
    expect(validation.ok).toBe(true)
    expect(validation.warnings.some((w: string) => w.includes("changed since approval"))).toBe(true)
    await cli(["approve", "design", "--ref", "owner reapproval", "--workstream", "demo"])
    const current = await status()
    expect(current.workstream.lifecycle.approvals.filter((a: any) => a.phase === "design")).toHaveLength(1)
    const discovery = discoverRepository(repo)
    const state = inspectRepositoryStore(discovery)
    if (state.state !== "ready") throw new Error(state.message)
    const domain = openRepositoryDomain(state.context)
    try {
      const history = domain.getApprovalHistory("demo").filter((a) => a.phase === "design")
      expect(history).toHaveLength(2)
      expect(history[0]!.snapshotHash).not.toBe(history[1]!.snapshotHash)
    } finally {
      domain.close()
    }
  })
})

describe("c9 lifecycle CLI: planning authority and job progression", () => {
  test("job registration requires an existing Planning approval", async () => {
    planningDocs()
    await expect(cli(["job", "--register", "--workstream", "demo"])).rejects.toThrow(/existing Planning approval/)
    expect((await status()).workstream.lifecycle.jobs).toHaveLength(0)
  })

  test("planning approval registers jobs as planned; routine amendment preserves authority", async () => {
    planningDocs()
    const approval = (await cli(["approve", "planning", "--ref", "owner", "--workstream", "demo"])) as any
    expect(approval.jobs.map((j: any) => j.job_id)).toEqual(["01"])
    const before = (await status()).workstream.lifecycle.approvals
    write("execution/jobs/02-second.md", JOB_B)
    const registration = (await runSaneJobRegisterCommand(["--workstream", "demo"], { cwd: repo, signals: {} })) as any
    expect(registration.jobs.map((j: any) => j.job_id)).toEqual(["01", "02"])
    expect(registration.warnings.some((w: string) => w.includes("routine amendments"))).toBe(true)
    expect((await status()).workstream.lifecycle.approvals).toEqual(before)
  })

  test("job progresses planned->running->completed; backward moves rejected", async () => {
    planningDocs()
    await cli(["approve", "planning", "--ref", "owner", "--workstream", "demo"])
    expect(((await cli(["job", "01", "running", "--workstream", "demo"])) as any).changed).toBe(true)
    expect(((await cli(["job", "01", "running", "--workstream", "demo"])) as any).changed).toBe(false)
    expect(((await cli(["job", "01", "completed", "--workstream", "demo"])) as any).status).toBe("completed")
    await expect(cli(["job", "01", "running", "--workstream", "demo"])).rejects.toThrow(/backward moves rejected/)
  })

  test("job context resolves spec and report paths", async () => {
    planningDocs()
    await cli(["approve", "planning", "--ref", "owner", "--workstream", "demo"])
    const context = (await cli(["job", "01", "--workstream", "demo", "--verbose"])) as any
    expect(context.job.jobId).toBe("01")
    expect(context.job.specExists).toBe(true)
    expect(context.planningApproval).not.toBeNull()
  })
})

describe("c9 lifecycle CLI: execution reports", () => {
  async function executionDocs(): Promise<void> {
    planningDocs()
    await cli(["approve", "planning", "--ref", "owner", "--workstream", "demo"])
    write("execution/FINAL_REPORT.md", "# Final\nDelivered.\n")
    write("execution/reports/01-first.md", REPORT_A)
  }

  test("scoped report validation accepts a well-formed report", async () => {
    await executionDocs()
    expect(((await cli(["validate", "execution", "report", "--id", "01", "--workstream", "demo"])) as any).ok).toBe(true)
  })

  test("scoped report validation rejects placeholders and unknown ids", async () => {
    await executionDocs()
    write("execution/reports/01-first.md", REPORT_A.replace("Results.", "{{unresolved}}"))
    expect(((await cli(["validate", "execution", "report", "--id", "01", "--workstream", "demo"])) as any).ok).toBe(false)
    expect(((await cli(["validate", "execution", "report", "--id", "unknown", "--workstream", "demo"])) as any).ok).toBe(false)
  })

  test("execution approval requires test reports, then completes jobs", async () => {
    await executionDocs()
    write("execution/jobs/02-second.md", JOB_B)
    write("execution/reports/02-second.md", REPORT_B)
    await cli(["job", "--register", "--workstream", "demo"])
    await expect(cli(["approve", "execution", "--ref", "owner", "--workstream", "demo"])).rejects.toThrow(/execution\/test-reports\/checkpoint-1\.md/)
    write("execution/test-reports/checkpoint-1.md", "# Verification\nPassed.\n")
    await cli(["approve", "execution", "--ref", "owner", "--workstream", "demo"])
    const current = await status()
    expect(current.workstream.lifecycle.jobs.every((j: any) => j.status === "completed")).toBe(true)
  })
})

describe("c9 lifecycle CLI: research registration and freshness", () => {
  test("index surfaces unregistered reports; register tracks freshness", async () => {
    write("research/topic.md", "# Evidence\n")
    expect(((await cli(["research", "index", "--workstream", "demo", "--verbose"])) as any).unregistered).toEqual(["research/topic.md"])
    await cli(["research", "register", "--topic", "topic", "--path", "research/topic.md", "--workstream", "demo"])
    expect(((await cli(["research", "index", "--workstream", "demo", "--verbose"])) as any).registered[0]).toMatchObject({ missing: false, modified: false })
    write("research/topic.md", "# Changed\n")
    const index = (await cli(["research", "--workstream", "demo", "--verbose"])) as any
    expect(index.registered[0].modified).toBe(true)
    expect(index.warnings.some((w: string) => w.includes("modified"))).toBe(true)
  })

  test("unregister retains the artifact and audit trail", async () => {
    write("research/topic.md", "# Evidence\n")
    await cli(["research", "register", "--topic", "topic", "--path", "research/topic.md", "--workstream", "demo"])
    expect(((await cli(["research", "unregister", "--topic", "topic", "--workstream", "demo"])) as any)).toEqual({ unregistered: "topic" })
    expect(((await cli(["research", "index", "--workstream", "demo", "--verbose"])) as any).unregistered).toEqual(["research/topic.md"])
    const discovery = discoverRepository(repo)
    const state = inspectRepositoryStore(discovery)
    if (state.state !== "ready") throw new Error(state.message)
    const domain = openRepositoryDomain(state.context)
    try {
      expect(domain.readArtifact("demo", "research/topic.md")).toBe("# Evidence\n")
      expect(domain.readAudit("demo").some((e) => e.operation === "research_unregistered")).toBe(true)
    } finally {
      domain.close()
    }
  })
})
