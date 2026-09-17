/**
 * SANE 0.2.0 M2-A: sqlite source of truth tests.
 *
 * Temp repo + temp DB coverage: composite-key isolation
 * (multi-user/repo/workstream), enum rejection, selections address-book
 * upsert, and jobs planned -> authorized only via the approval helper.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import {
  acceptJobsViaApproval,
  authorizeJobsViaApproval,
  branchForWorkstream,
  createJob,
  currentUser,
  deleteSelection,
  getApproval,
  getJob,
  getMerge,
  getResearchReport,
  getSelection,
  getStateEntry,
  getWorkstream,
  initSchema,
  listJobs,
  listMutations,
  listSelections,
  normalizeWorkstreamId,
  openInMemoryDb,
  openSaneDb,
  openSaneDbAtPath,
  recordApproval,
  recordMergeCommit,
  registerResearchReport,
  SaneDbError,
  saneDbPath,
  updateJobStatus,
  upsertMerge,
  upsertSelection,
  upsertStateEntry,
  upsertWorkstream,
  type MutationContext,
  type SaneIdentity,
} from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

function mutation(role = "planning", session = "ses_test"): MutationContext {
  return { actorRole: role, sessionId: session, timestamp: new Date().toISOString() }
}

describe("sane-db (M2-A sqlite source of truth)", () => {
  let tempDirectory: string
  let repoA: string
  let repoB: string
  let db: Database | undefined
  let fileDb: Database | undefined

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-db-m2a-"))
    repoA = join(tempDirectory, "repo-a")
    repoB = join(tempDirectory, "repo-b")
    // Minimal git repos so resolveImplementationRepository succeeds.
    const { mkdir } = await import("node:fs/promises")
    await mkdir(repoA, { recursive: true })
    await mkdir(repoB, { recursive: true })
    await execFileAsync("git", ["init", "--quiet", repoA])
    await execFileAsync("git", ["init", "--quiet", repoB])
  })

  afterEach(async () => {
    try {
      db?.close()
    } catch {
      // Best effort; close is idempotent for test cleanup.
    }
    try {
      fileDb?.close()
    } catch {
      // Best effort.
    }
    db = undefined
    fileDb = undefined
    await rm(tempDirectory, { recursive: true, force: true })
  })

  test("opens one DB per repo at .sane/sane.db and initializes the schema", async () => {
    const { access } = await import("node:fs/promises")
    await expect(access(saneDbPath(repoA))).rejects.toThrow()
    fileDb = await openSaneDb(repoA)
    expect(fileDb).toBeInstanceOf(Database)
    initSchema(fileDb)
    const tables = fileDb
      .query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    for (const expected of [
      "workstreams",
      "selections",
      "state_entries",
      "approvals",
      "research_reports",
      "jobs",
      "merges",
    ]) {
      expect(names).toContain(expected)
    }
    // DB file is created at the per-repo path.
    await access(saneDbPath(repoA))
    // Second repo resolves to a different file.
    expect(saneDbPath(repoB)).not.toBe(saneDbPath(repoA))
  })

  test("supports an explicit temp DB path without touching the repo default", async () => {
    const tempDbPath = join(tempDirectory, "isolated", "sane-test.db")
    fileDb = openSaneDbAtPath(tempDbPath)
    initSchema(fileDb)
    const { access } = await import("node:fs/promises")
    await access(tempDbPath)
    // Repo default is untouched.
    await expect(access(saneDbPath(repoA))).rejects.toThrow()
  })

  test("composite-key isolation across user, repo, and workstream", async () => {
    db = openInMemoryDb()
    initSchema(db)
    const { resolve } = await import("node:path")
    const absA = resolve(repoA)
    const absB = resolve(repoB)
    const alice: SaneIdentity = { repoRoot: absA, user: "alice", workstreamId: "01-export" }
    const bob: SaneIdentity = { repoRoot: absA, user: "bob", workstreamId: "01-export" }
    const aliceOtherRepo: SaneIdentity = { repoRoot: absB, user: "alice", workstreamId: "01-export" }
    const aliceOtherStream: SaneIdentity = { repoRoot: absA, user: "alice", workstreamId: "02-import" }

    upsertWorkstream(db, alice, { scope: "alice scope", status: "open" }, mutation())
    upsertWorkstream(db, bob, { scope: "bob scope", status: "blocked" }, mutation())
    upsertWorkstream(
      db,
      aliceOtherRepo,
      { scope: "other repo", status: "done" },
      mutation(),
    )
    upsertWorkstream(
      db,
      aliceOtherStream,
      { scope: "other stream", status: "open" },
      mutation(),
    )

    expect(getWorkstream(db, alice)?.scope).toBe("alice scope")
    expect(getWorkstream(db, bob)?.scope).toBe("bob scope")
    expect(getWorkstream(db, aliceOtherRepo)?.scope).toBe("other repo")
    expect(getWorkstream(db, aliceOtherStream)?.scope).toBe("other stream")

    // Mutating one identity never leaks into another.
    upsertWorkstream(db, alice, { scope: "alice v2", status: "done" }, mutation())
    expect(getWorkstream(db, alice)?.scope).toBe("alice v2")
    expect(getWorkstream(db, bob)?.scope).toBe("bob scope")

    // Child tables are isolated by the same composite prefix.
    upsertSelection(
      db,
      alice,
      { slot: "design", sessionId: "ses_alice" },
      mutation("design", "ses_alice"),
    )
    upsertSelection(db, bob, { slot: "design", sessionId: "ses_bob" }, mutation("design", "ses_bob"))
    expect(getSelection(db, alice, "design")?.session_id).toBe("ses_alice")
    expect(getSelection(db, bob, "design")?.session_id).toBe("ses_bob")
  })

  test("rejects invalid enums and enforces composite PKs", async () => {
    db = openInMemoryDb()
    initSchema(db)
    const { resolve } = await import("node:path")
    const identity: SaneIdentity = {
      repoRoot: resolve(repoA),
      user: "alice",
      workstreamId: "01-export",
    }
    const m = mutation()

    expect(() =>
      upsertWorkstream(db!, identity, { scope: "s", status: "bogus" }, m),
    ).toThrow(SaneDbError)
    expect(() =>
      upsertWorkstream(db!, identity, { scope: "s", status: "bogus" }, m),
    ).toThrow(/Invalid workstream status/)

    expect(() =>
      upsertStateEntry(
        db!,
        identity,
        { phase: "design", status: "bogus", ownerRole: "design" },
        m,
      ),
    ).toThrow(/Invalid state entry status/)
    expect(() =>
      upsertStateEntry(
        db!,
        identity,
        { phase: "bogus", status: "pending", ownerRole: "design" },
        m,
      ),
    ).toThrow(/Invalid phase/)
    expect(() =>
      upsertSelection(db!, identity, { slot: "bogus", sessionId: "s" }, m),
    ).toThrow(/Invalid selection slot/)
    expect(() =>
      recordApproval(
        db!,
        identity,
        { gate: "bogus", artifactPath: "a", saneHash: "h", approvalRef: "r" },
        m,
      ),
    ).toThrow(/Invalid approval gate/)

    // Composite PK: repeated upsert for the same key updates instead of duplicating.
    upsertWorkstream(db, identity, { scope: "v1", status: "open" }, m)
    upsertWorkstream(db, identity, { scope: "v2", status: "open" }, m)
    const rows = db
      .query(`SELECT * FROM workstreams WHERE repo_root = ? AND user = ? AND workstream_id = ?`)
      .all(identity.repoRoot, identity.user, identity.workstreamId) as unknown[]
    expect(rows).toHaveLength(1)
    expect(getWorkstream(db, identity)?.scope).toBe("v2")

    // Raw CHECK enforcement also rejects bad enums at the SQL layer.
    expect(() =>
      db!
        .query(
          `INSERT INTO workstreams (repo_root, user, workstream_id, scope, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(identity.repoRoot, identity.user, "other", "s", "bogus", new Date().toISOString()),
    ).toThrow()
  })

  test("selections address-book upsert keeps one row per slot", async () => {
    db = openInMemoryDb()
    initSchema(db)
    const { resolve } = await import("node:path")
    const identity: SaneIdentity = {
      repoRoot: resolve(repoA),
      user: currentUser() || "tester",
      workstreamId: "01-export",
    }

    const first = upsertSelection(
      db,
      identity,
      { slot: "design", sessionId: "ses_design_1" },
      mutation("design", "ses_design_1"),
    )
    expect(first.session_id).toBe("ses_design_1")

    // Same slot overwrites (address-book behavior).
    const second = upsertSelection(
      db,
      identity,
      {
        slot: "design",
        sessionId: "ses_design_2",
        worktreePath: "/tmp/u/01-export",
        branch: branchForWorkstream(identity.user, identity.workstreamId),
      },
      mutation("design", "ses_design_2"),
    )
    expect(second.session_id).toBe("ses_design_2")
    expect(second.worktree_path).toBe("/tmp/u/01-export")

    // Other slots coexist.
    upsertSelection(db, identity, { slot: "engineering", sessionId: "ses_eng" }, mutation())
    upsertSelection(
      db,
      identity,
      { slot: "research:auth", sessionId: "ses_research" },
      mutation("research", "ses_research"),
    )
    const all = listSelections(db, identity)
    expect(all.map((r) => r.slot).sort()).toEqual(["design", "engineering", "research:auth"])
    expect(getSelection(db, identity, "design")?.session_id).toBe("ses_design_2")

    // Delete removes only that slot.
    deleteSelection(db, identity, "engineering", mutation())
    expect(getSelection(db, identity, "engineering")).toBeNull()
    expect(listSelections(db, identity)).toHaveLength(2)
  })

  test("jobs planned -> authorized only via the approval helper (stub)", async () => {
    db = openInMemoryDb()
    initSchema(db)
    const { resolve } = await import("node:path")
    const identity: SaneIdentity = {
      repoRoot: resolve(repoA),
      user: "alice",
      workstreamId: "01-export",
    }
    const m = mutation("planning", "ses_plan")

    createJob(db, identity, { jobId: "job-01", specPath: "plan/jobs/job-01-a.md" }, m)
    expect(getJob(db, identity, "job-01")?.status).toBe("planned")

    // Direct transition is rejected.
    expect(() => updateJobStatus(db!, identity, "job-01", "authorized", m)).toThrow(
      /only via.*authorizeJobsViaApproval|planned -> authorized/,
    )
    expect(getJob(db, identity, "job-01")?.status).toBe("planned")

    // New jobs must start planned.
    expect(() =>
      createJob(db!, identity, { jobId: "job-bad", specPath: "p", status: "authorized" }, m),
    ).toThrow(/must start as "planned"/)

    // Approval-helper stub authorizes.
    const authorized = authorizeJobsViaApproval(
      db,
      identity,
      ["job-01"],
      { artifactPath: "plan/PLAN.md", saneHash: "hash-plan-1", approvalRef: "user-ok-plan" },
      { actorRole: "user", sessionId: "ses_user" },
    )
    expect(authorized[0]?.status).toBe("authorized")
    expect(getJob(db, identity, "job-01")?.status).toBe("authorized")
    expect(getApproval(db, identity, "plan")?.approval_ref).toBe("user-ok-plan")

    // Normal forward transitions still work directly.
    updateJobStatus(db, identity, "job-01", "running", mutation("execution", "ses_exec"))
    expect(getJob(db, identity, "job-01")?.status).toBe("running")

    // Direct accept is rejected; helper accepts.
    updateJobStatus(db, identity, "job-01", "reported", mutation("execution", "ses_exec"))
    updateJobStatus(db, identity, "job-01", "reviewed", mutation("execution", "ses_exec"))
    expect(() => updateJobStatus(db!, identity, "job-01", "accepted", m)).toThrow(
      /acceptJobsViaApproval/,
    )
    acceptJobsViaApproval(
      db,
      identity,
      ["job-01"],
      { artifactPath: "execution/BRIEF.md", saneHash: "hash-batch-1", approvalRef: "user-ok-batch" },
      { actorRole: "user", sessionId: "ses_user" },
    )
    expect(getJob(db, identity, "job-01")?.status).toBe("accepted")
    expect(listJobs(db, identity)).toHaveLength(1)
  })

  test("every mutation records actor, session, and timestamp", async () => {
    db = openInMemoryDb()
    initSchema(db)
    const { resolve } = await import("node:path")
    const identity: SaneIdentity = {
      repoRoot: resolve(repoA),
      user: "alice",
      workstreamId: "01-export",
    }
    upsertWorkstream(
      db,
      identity,
      { scope: "s", status: "open" },
      { actorRole: "design", sessionId: "ses_design", timestamp: "2026-01-01T00:00:00.000Z" },
    )
    upsertSelection(
      db,
      identity,
      { slot: "planning", sessionId: "ses_plan" },
      { actorRole: "planning", sessionId: "ses_plan", timestamp: "2026-01-02T00:00:00.000Z" },
    )
    const log = listMutations(db, {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: identity.workstreamId,
    })
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log[0]).toMatchObject({ actor_role: "design", session_id: "ses_design" })
    expect(log[1]).toMatchObject({ actor_role: "planning", session_id: "ses_plan" })
    for (const entry of log) {
      expect(entry.timestamp.trim()).not.toBe("")
      expect(entry.table_name.trim()).not.toBe("")
    }
  })

  test("covers remaining tables and identity helpers", async () => {
    db = openInMemoryDb()
    initSchema(db)
    const { resolve } = await import("node:path")
    const identity: SaneIdentity = {
      repoRoot: resolve(repoA),
      user: "alice",
      workstreamId: "nested/01-export",
    }
    const m = mutation()

    expect(normalizeWorkstreamId("01-export")).toBe("01-export")
    expect(() => normalizeWorkstreamId("../outside")).toThrow(SaneDbError)
    expect(() => normalizeWorkstreamId("/absolute")).toThrow(SaneDbError)
    expect(branchForWorkstream("alice", "nested/01-export")).toBe("sane/alice/nested-01-export")

    upsertStateEntry(
      db,
      identity,
      { phase: "design", status: "in_progress", ownerRole: "design" },
      m,
    )
    expect(getStateEntry(db, identity, "design")?.status).toBe("in_progress")

    const registered = registerResearchReport(
      db,
      identity,
      {
        topic: "auth",
        path: "research/auth/REPORT.md",
        createdAt: "2026-09-16T00:00:00.000Z",
        saneHash: "abc123",
        gitCommit: "def456",
      },
      m,
    )
    expect(registered.sane_hash).toBe("abc123")
    expect(getResearchReport(db, identity, "auth")?.git_commit).toBe("def456")

    upsertMerge(
      db,
      identity,
      { branch: branchForWorkstream("alice", "nested/01-export"), baseRev: "abc123" },
      m,
    )
    expect(getMerge(db, identity)?.merge_commit).toBeNull()
    recordMergeCommit(db, identity, "def456", m)
    expect(getMerge(db, identity)?.merge_commit).toBe("def456")
  })
})
