/**
 * SANE 0.2.0 M3-A: `sane-alpha approve` approvals + jobs tests.
 *
 * Covers all five gates with `sane_hash` recording (record only, no
 * enforcement), plan authorizes jobs, jobs-batch accepts (plus retry),
 * direct `planned -> authorized` rejection, and actor_role audit
 * (no self-approve bypass).
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
  openSaneDb,
  resolveSaneIdentity,
  SaneDbError,
  updateJobStatus,
  type SaneIdentity,
} from "../src/sane-db.ts"
import { sha256Hex } from "../src/sane-hash.ts"
import { SaneWorkstreamStateError } from "../src/sane-workstream-state.ts"

const execFileAsync = promisify(execFile)

const GATES = ["root-plus-sdd", "solutions", "plan", "jobs-batch", "merge"] as const

describe("sane-approve (M3-A approvals + jobs)", () => {
  let tempDirectory: string
  let implementationRepository: string
  let identity: SaneIdentity
  let workstreamDir: string

  async function writeArtifact(relativePath: string, content: string): Promise<string> {
    const full = join(workstreamDir, relativePath)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content)
    return full
  }

  async function approvalFor(gate: string) {
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      return getApproval(db, identity, gate)
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  }

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-approve-m3a-"))
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

  test("approves all five gates and records sane_hash (record only)", async () => {
    for (const gate of GATES) {
      const content = `artifact content for ${gate}\n`
      const relative = `artifact-${gate}.md`
      await writeArtifact(relative, content)
      const lines: string[] = []
      const result = await runSaneApproveCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        gate,
        artifact: relative,
        approvalRef: `user-ok-${gate}`,
        actorRole: "user",
        sessionId: `ses-approve-${gate}`,
        write: (line) => lines.push(line),
      })
      expect(result.gate).toBe(gate)
      expect(result.saneHash).toBe(sha256Hex(content))
      expect(result.approvalRef).toBe(`user-ok-${gate}`)
      expect(result.gitCommit).toBeNull()
      expect(result.approvedAt.trim()).not.toBe("")
      expect(lines.join("\n")).toContain(`Approved ${gate}`)

      const row = await approvalFor(gate)
      expect(row).not.toBeNull()
      expect(row?.sane_hash).toBe(sha256Hex(content))
      expect(row?.artifact_path).toBe(relative)
      expect(row?.approval_ref).toBe(`user-ok-${gate}`)
      expect(row?.git_commit).toBeNull()
    }

    // git-commit passthrough is recorded alongside the hash.
    const mergeContent = "merge artifact v2\n"
    await writeArtifact("artifact-merge.md", mergeContent)
    const withCommit = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "merge",
      artifact: "artifact-merge.md",
      approvalRef: "user-ok-merge-v2",
      gitCommit: "deadbeef",
      actorRole: "user",
      sessionId: "ses-merge-commit",
      write: () => {},
    })
    expect(withCommit.gitCommit).toBe("deadbeef")
    expect(withCommit.saneHash).toBe(sha256Hex(mergeContent))
    const mergeRow = await approvalFor("merge")
    expect(mergeRow?.git_commit).toBe("deadbeef")
    expect(mergeRow?.sane_hash).toBe(sha256Hex(mergeContent))
  })

  test("plan approval authorizes jobs (planned -> authorized only via approval)", async () => {
    // Seed two planned jobs directly (Planning owns planned rows).
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        createJob(
          db,
          identity,
          { jobId: "job-01", specPath: "plan/jobs/job-01-a.md" },
          { actorRole: "planning", sessionId: "ses-plan" },
        )
        createJob(
          db,
          identity,
          { jobId: "job-02", specPath: "plan/jobs/job-02-b.md" },
          { actorRole: "planning", sessionId: "ses-plan" },
        )
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }

    // Direct transition is rejected even before approval.
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        expect(() => updateJobStatus(db, identity, "job-01", "authorized", {
          actorRole: "planning",
          sessionId: "ses-plan",
        })).toThrow(SaneDbError)
        expect(() => updateJobStatus(db, identity, "job-01", "authorized", {
          actorRole: "planning",
          sessionId: "ses-plan",
        })).toThrow(/authorizeJobsViaApproval/)
        expect(getJob(db, identity, "job-01")?.status).toBe("planned")
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }

    const planContent = "# Plan\nplan package\n"
    await writeArtifact("plan/PLAN.md", planContent)
    const result = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "plan",
      artifact: "plan/PLAN.md",
      approvalRef: "user-ok-plan",
      jobIds: ["job-01", "job-02"],
      actorRole: "user",
      sessionId: "ses-user-plan",
      write: () => {},
    })
    expect(result.jobs.map((j) => j.status)).toEqual(["authorized", "authorized"])
    expect(result.saneHash).toBe(sha256Hex(planContent))

    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      expect(getJob(db, identity, "job-01")?.status).toBe("authorized")
      expect(getJob(db, identity, "job-02")?.status).toBe("authorized")
      expect(getApproval(db, identity, "plan")?.approval_ref).toBe("user-ok-plan")
      expect(getApproval(db, identity, "plan")?.sane_hash).toBe(sha256Hex(planContent))
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("jobs-batch approval accepts reported/reviewed jobs and supports retry", async () => {
    // Seed, authorize via plan approval, then advance to reported/reviewed.
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        createJob(
          db,
          identity,
          { jobId: "job-01", specPath: "plan/jobs/job-01-a.md" },
          { actorRole: "planning", sessionId: "ses-plan" },
        )
        createJob(
          db,
          identity,
          { jobId: "job-02", specPath: "plan/jobs/job-02-b.md" },
          { actorRole: "planning", sessionId: "ses-plan" },
        )
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }
    await writeArtifact("plan/PLAN.md", "plan package\n")
    await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "plan",
      artifact: "plan/PLAN.md",
      approvalRef: "user-ok-plan",
      jobIds: ["job-01", "job-02"],
      actorRole: "user",
      sessionId: "ses-user-plan",
      write: () => {},
    })
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        updateJobStatus(db, identity, "job-01", "running", {
          actorRole: "execution",
          sessionId: "ses-exec",
        })
        updateJobStatus(db, identity, "job-01", "reported", {
          actorRole: "execution",
          sessionId: "ses-exec",
        })
        updateJobStatus(db, identity, "job-01", "reviewed", {
          actorRole: "execution",
          sessionId: "ses-exec",
        })
        updateJobStatus(db, identity, "job-02", "running", {
          actorRole: "execution",
          sessionId: "ses-exec",
        })
        updateJobStatus(db, identity, "job-02", "reported", {
          actorRole: "execution",
          sessionId: "ses-exec",
        })
        // Direct accept is rejected; only the approval helper accepts.
        expect(() =>
          updateJobStatus(db, identity, "job-01", "accepted", {
            actorRole: "execution",
            sessionId: "ses-exec",
          }),
        ).toThrow(/acceptJobsViaApproval/)
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }

    const briefContent = "# Brief\noutcomes\n"
    await writeArtifact("execution/BRIEF.md", briefContent)
    const accepted = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "jobs-batch",
      artifact: "execution/BRIEF.md",
      approvalRef: "user-ok-batch",
      jobIds: ["job-01", "job-02"],
      actorRole: "user",
      sessionId: "ses-user-batch",
      write: () => {},
    })
    expect(accepted.jobs.map((j) => j.status)).toEqual(["accepted", "accepted"])
    expect(accepted.retried).toBe(false)
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        expect(getJob(db, identity, "job-01")?.status).toBe("accepted")
        expect(getJob(db, identity, "job-02")?.status).toBe("accepted")
        expect(getApproval(db, identity, "jobs-batch")?.sane_hash).toBe(
          sha256Hex(briefContent),
        )
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }

    // Retry path: a reported job goes back to authorized for fix/retry.
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        createJob(
          db,
          identity,
          { jobId: "job-03", specPath: "plan/jobs/job-03-c.md" },
          { actorRole: "planning", sessionId: "ses-plan" },
        )
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }
    await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "plan",
      artifact: "plan/PLAN.md",
      approvalRef: "user-ok-plan-2",
      jobIds: ["job-03"],
      actorRole: "user",
      sessionId: "ses-user-plan-2",
      write: () => {},
    })
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        updateJobStatus(db, identity, "job-03", "running", {
          actorRole: "execution",
          sessionId: "ses-exec",
        })
        updateJobStatus(db, identity, "job-03", "reported", {
          actorRole: "execution",
          sessionId: "ses-exec",
        })
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }
    const retried = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "jobs-batch",
      artifact: "execution/BRIEF.md",
      approvalRef: "user-ok-retry",
      jobIds: ["job-03"],
      retry: true,
      actorRole: "user",
      sessionId: "ses-user-retry",
      write: () => {},
    })
    expect(retried.retried).toBe(true)
    expect(retried.jobs[0]?.status).toBe("authorized")
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        expect(getJob(db, identity, "job-03")?.status).toBe("authorized")
        expect(getApproval(db, identity, "jobs-batch")?.approval_ref).toBe("user-ok-retry")
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }
  })

  test("direct planned -> authorized without approval is still rejected", async () => {
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      createJob(
        db,
        identity,
        { jobId: "job-direct", specPath: "plan/jobs/job-direct-a.md" },
        { actorRole: "planning", sessionId: "ses-plan" },
      )
      expect(() =>
        updateJobStatus(db, identity, "job-direct", "authorized", {
          actorRole: "planning",
          sessionId: "ses-plan",
        }),
      ).toThrow(/planned -> authorized directly/)
      expect(getJob(db, identity, "job-direct")?.status).toBe("planned")
      expect(getApproval(db, identity, "plan")).toBeNull()
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("no self-approve bypass: actor_role is always recorded", async () => {
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        createJob(
          db,
          identity,
          { jobId: "job-self", specPath: "plan/jobs/job-self-a.md" },
          { actorRole: "planning", sessionId: "ses-plan" },
        )
        // Even the owning role cannot bypass the approval helper.
        expect(() =>
          updateJobStatus(db, identity, "job-self", "authorized", {
            actorRole: "planning",
            sessionId: "ses-plan",
          }),
        ).toThrow(SaneDbError)
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }
    await writeArtifact("plan/PLAN.md", "plan for self-approve check\n")
    await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "plan",
      artifact: "plan/PLAN.md",
      approvalRef: "planning-tries-self-approve",
      jobIds: ["job-self"],
      actorRole: "planning",
      sessionId: "ses-planning-self",
      write: () => {},
    })
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        expect(getJob(db, identity, "job-self")?.status).toBe("authorized")
        const mutations = listMutations(db, {
          repoRoot: identity.repoRoot,
          user: identity.user,
          workstreamId: identity.workstreamId,
          tableName: "approvals",
        })
        expect(mutations.length).toBeGreaterThan(0)
        // The non-user actor is recorded, not silently treated as user.
        expect(mutations.some((m) => m.actor_role === "planning")).toBe(true)
        expect(
          mutations.some(
            (m) => m.actor_role === "planning" && m.session_id === "ses-planning-self",
          ),
        ).toBe(true)
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }

    // A user approval records actor_role=user distinctly.
    await writeArtifact("sdd-user.md", "user sdd content\n")
    await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "root-plus-sdd",
      artifact: "sdd-user.md",
      approvalRef: "user-ok-sdd",
      actorRole: "user",
      sessionId: "ses-user-sdd",
      write: () => {},
    })
    {
      const db = await openSaneDb(identity.repoRoot)
      try {
        initSchema(db)
        const mutations = listMutations(db, {
          repoRoot: identity.repoRoot,
          user: identity.user,
          workstreamId: identity.workstreamId,
          tableName: "approvals",
        })
        expect(mutations.some((m) => m.actor_role === "user" && m.session_id === "ses-user-sdd")).toBe(
          true,
        )
      } finally {
        try {
          db.close()
        } catch {
          // Best effort.
        }
      }
    }
  })

  test("parseCliArguments matches existing idioms (Unknown option, required, repo-root)", async () => {
    await writeArtifact("plan/PLAN.md", "plan\n")
    const parsed = parseCliArguments([
      implementationRepository,
      "01-demo",
      "--gate",
      "plan",
      "--artifact",
      "plan/PLAN.md",
      "--ref",
      "user-ok",
      "--job",
      "job-01",
      "--job",
      "job-02",
      "--json",
    ])
    expect(parsed).toMatchObject({
      gate: "plan",
      artifact: "plan/PLAN.md",
      approvalRef: "user-ok",
      jobIds: ["job-01", "job-02"],
      json: true,
      retry: false,
      actorRole: "user",
    })

    // --repo-root takes exactly one positional.
    const viaRoot = parseCliArguments([
      "--repo-root",
      implementationRepository,
      "01-demo",
      "--gate",
      "merge",
      "--artifact",
      "plan/PLAN.md",
      "--ref",
      "r",
    ])
    expect(viaRoot.implementationRepository).toBe(implementationRepository)
    expect(viaRoot.workstreamPath).toBe("01-demo")

    expect(() =>
      parseCliArguments([
        implementationRepository,
        "01-demo",
        "--gate",
        "plan",
        "--artifact",
        "a",
        "--ref",
        "r",
        "--bogus",
      ]),
    ).toThrow(/Unknown option: --bogus/)
    expect(() =>
      parseCliArguments([implementationRepository, "01-demo", "--artifact", "a", "--ref", "r"]),
    ).toThrow(/Option --gate is required/)
    expect(() =>
      parseCliArguments([implementationRepository, "01-demo", "--gate", "plan", "--ref", "r"]),
    ).toThrow(/Option --artifact is required/)
    expect(() =>
      parseCliArguments([
        implementationRepository,
        "01-demo",
        "--gate",
        "plan",
        "--artifact",
        "a",
      ]),
    ).toThrow(/Option --ref is required/)
    expect(() =>
      parseCliArguments([
        implementationRepository,
        "01-demo",
        "--gate",
        "bogus",
        "--artifact",
        "a",
        "--ref",
        "r",
      ]),
    ).toThrow(/Invalid approval gate/)
    expect(() =>
      parseCliArguments([
        implementationRepository,
        "01-demo",
        "--gate",
        "plan",
        "--artifact",
        "a",
        "--ref",
        "r",
        "--gate",
        "merge",
      ]),
    ).toThrow(/only once/)
    expect(() =>
      parseCliArguments([
        implementationRepository,
        "01-demo",
        "--gate",
        "plan",
        "--artifact",
        "a",
        "--ref",
        "r",
        "--retry",
      ]),
    ).toThrow(/--retry applies only to gate jobs-batch/)
    // Single positional defaults to cwd (repo-root detection idiom).
    const single = parseCliArguments(["01-demo", "--gate", "merge", "--artifact", "a", "--ref", "r"])
    expect(single.workstreamPath).toBe("01-demo")
    expect(single.implementationRepository).toBe(process.cwd())
  })

  test("runCli returns 0/1 and USAGE documents the command", async () => {
    expect(USAGE).toContain("sane-alpha approve")
    expect(USAGE).toContain("--gate")
    expect(USAGE).toContain("--artifact")
    expect(USAGE).toContain("--ref")
    expect(USAGE).toContain("--json")
    expect(USAGE).toContain("--repo-root")

    await writeArtifact("cli-artifact.md", "cli content\n")
    expect(
      await runCli([
        implementationRepository,
        "01-demo",
        "--gate",
        "solutions",
        "--artifact",
        "cli-artifact.md",
        "--ref",
        "user-ok-cli",
      ]),
    ).toBe(0)
    expect((await approvalFor("solutions"))?.approval_ref).toBe("user-ok-cli")

    // Missing file -> 1.
    expect(
      await runCli([
        implementationRepository,
        "01-demo",
        "--gate",
        "solutions",
        "--artifact",
        "missing.md",
        "--ref",
        "r",
      ]),
    ).toBe(1)
    // Unknown option -> 1.
    expect(
      await runCli([
        implementationRepository,
        "01-demo",
        "--gate",
        "solutions",
        "--artifact",
        "cli-artifact.md",
        "--ref",
        "r",
        "--nope",
      ]),
    ).toBe(1)
    // Invalid gate -> 1.
    expect(
      await runCli([
        implementationRepository,
        "01-demo",
        "--gate",
        "bogus",
        "--artifact",
        "cli-artifact.md",
        "--ref",
        "r",
      ]),
    ).toBe(1)
  })

  test("supports --json, --git-commit, and absolute artifact paths", async () => {
    const content = "json artifact\n"
    const absolute = await writeArtifact("json-artifact.md", content)
    const lines: string[] = []
    const result = await runSaneApproveCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      gate: "root-plus-sdd",
      artifact: absolute,
      approvalRef: "user-ok-json",
      gitCommit: "abc123",
      json: true,
      actorRole: "user",
      sessionId: "ses-json",
      write: (line) => lines.push(line),
    })
    expect(result.saneHash).toBe(sha256Hex(content))
    expect(result.gitCommit).toBe("abc123")
    const parsed = JSON.parse(lines.join("\n"))
    expect(parsed).toMatchObject({
      gate: "root-plus-sdd",
      sane_hash: sha256Hex(content),
      git_commit: "abc123",
      approval_ref: "user-ok-json",
    })
  })

  test("rejects SaneWorkstreamStateError-style Unknown option via runSaneApproveCommand guards", async () => {
    await expect(
      runSaneApproveCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        gate: "bogus" as never,
        artifact: "a",
        approvalRef: "r",
        write: () => {},
      }),
    ).rejects.toBeInstanceOf(SaneWorkstreamStateError)
  })
})
