/**
 * SANE 0.2.0 M2-A: sqlite source of truth tests.
 *
 * Temp repo + temp DB coverage: composite-key isolation
 * (multi-user/repo/workstream), enum rejection, selections address-book
 * upsert, and jobs lifecycle (planned means authorized, batch complete only).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import {
  completeAllJobs,
  branchForWorkstream,
  createJob,
  currentUser,
  deleteSelection,
  getApproval,
  getCurrentWorkstream,
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
  listSelectionsBySlot,
  normalizeWorkstreamId,
  openInMemoryDb,
  openSaneDb,
  openSaneDbAtPath,
  recordApproval,
  recordMergeCommit,
  registerResearchReport,
  SaneDbError,
  saneDbPath,
  setCurrentWorkstream,
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
      "current_workstreams",
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

    upsertWorkstream(db, alice, { type: "feature", status: "open" }, mutation())
    upsertWorkstream(db, bob, { type: "feature", status: "blocked" }, mutation())
    upsertWorkstream(
      db,
      aliceOtherRepo,
      { type: "foundation", status: "done" },
      mutation(),
    )
    upsertWorkstream(
      db,
      aliceOtherStream,
      { type: "issue", status: "open" },
      mutation(),
    )

    expect(getWorkstream(db, alice)?.status).toBe("open")
    expect(getWorkstream(db, bob)?.status).toBe("blocked")
    expect(getWorkstream(db, aliceOtherRepo)?.status).toBe("done")
    expect(getWorkstream(db, aliceOtherStream)?.status).toBe("open")
    expect(getWorkstream(db, alice)?.type).toBe("feature")
    expect(getWorkstream(db, aliceOtherRepo)?.type).toBe("foundation")

    // Mutating one identity never leaks into another.
    upsertWorkstream(db, alice, { type: "feature", status: "done" }, mutation())
    expect(getWorkstream(db, alice)?.status).toBe("done")
    expect(getWorkstream(db, bob)?.status).toBe("blocked")

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
      upsertWorkstream(db!, identity, { type: "feature", status: "bogus" }, m),
    ).toThrow(SaneDbError)
    expect(() =>
      upsertWorkstream(db!, identity, { type: "feature", status: "bogus" }, m),
    ).toThrow(/Invalid workstream status/)
    expect(() =>
      upsertWorkstream(db!, identity, { type: "bogus", status: "open" }, m),
    ).toThrow(/Invalid workstream type/)

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
        { phase: "bogus", artifactPath: "a", saneHash: "h", approvalRef: "r" },
        m,
      ),
    ).toThrow(/Invalid approval phase/)

    // Composite PK: repeated upsert for the same key updates instead of duplicating.
    upsertWorkstream(db, identity, { type: "feature", status: "open" }, m)
    upsertWorkstream(db, identity, { type: "foundation", status: "blocked" }, m)
    const rows = db
      .query(`SELECT * FROM workstreams WHERE repo_root = ? AND user = ? AND workstream_id = ?`)
      .all(identity.repoRoot, identity.user, identity.workstreamId) as unknown[]
    expect(rows).toHaveLength(1)
    expect(getWorkstream(db, identity)?.status).toBe("blocked")
    expect(getWorkstream(db, identity)?.type).toBe("foundation")

    // Raw CHECK enforcement also rejects bad enums at the SQL layer.
    expect(() =>
      db!
        .query(
          `INSERT INTO workstreams (repo_root, user, workstream_id, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(identity.repoRoot, identity.user, "other", "feature", "bogus", new Date().toISOString()),
    ).toThrow()
  })

  test("selections registry keeps one row per linked session with latest-wins reads", async () => {
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

    // Same slot, different session adds a row (1:many registry); latest wins.
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
    expect(listSelectionsBySlot(db, identity, "design")).toHaveLength(2)

    // Same (slot, session) re-upsert refreshes in place instead of duplicating.
    upsertSelection(
      db,
      identity,
      {
        slot: "design",
        sessionId: "ses_design_2",
        worktreePath: "/tmp/u/01-export-v2",
        branch: branchForWorkstream(identity.user, identity.workstreamId),
      },
      mutation("design", "ses_design_2"),
    )
    const designRows = listSelectionsBySlot(db, identity, "design")
    expect(designRows).toHaveLength(2)
    expect(getSelection(db, identity, "design")?.session_id).toBe("ses_design_2")
    expect(getSelection(db, identity, "design")?.worktree_path).toBe("/tmp/u/01-export-v2")

    // Other slots coexist.
    upsertSelection(db, identity, { slot: "engineering", sessionId: "ses_eng" }, mutation())
    upsertSelection(
      db,
      identity,
      { slot: "research:auth", sessionId: "ses_research" },
      mutation("research", "ses_research"),
    )
    const all = listSelections(db, identity)
    expect(all.map((r) => r.slot).sort()).toEqual([
      "design",
      "design",
      "engineering",
      "research:auth",
    ])
    expect(getSelection(db, identity, "design")?.session_id).toBe("ses_design_2")

    // Delete removes every row for that slot only.
    deleteSelection(db, identity, "engineering", mutation())
    expect(getSelection(db, identity, "engineering")).toBeNull()
    expect(listSelections(db, identity)).toHaveLength(3)
  })

  test("jobs lifecycle: planned means authorized, direct progress, batch completes stragglers", async () => {
    db = openInMemoryDb()
    initSchema(db)
    const { resolve } = await import("node:path")
    const identity: SaneIdentity = {
      repoRoot: resolve(repoA),
      user: "alice",
      workstreamId: "01-export",
    }
    const m = mutation("planning", "ses_plan")

    createJob(db, identity, { jobId: "job-01", specPath: "execution/jobs/job-01-a.md" }, m)
    createJob(db, identity, { jobId: "job-02", specPath: "execution/jobs/job-02-a.md" }, m)
    expect(getJob(db, identity, "job-01")?.status).toBe("planned")

    // New jobs must start planned (planned already means authorized).
    expect(() =>
      createJob(db!, identity, { jobId: "job-bad", specPath: "p", status: "running" }, m),
    ).toThrow(/must start as "planned"/)

    // Progress works directly and forward: planned -> running -> completed.
    updateJobStatus(db, identity, "job-01", "running", mutation("execution", "ses_exec"))
    expect(getJob(db, identity, "job-01")?.status).toBe("running")
    updateJobStatus(db, identity, "job-01", "completed", mutation("execution", "ses_exec"))
    expect(getJob(db, identity, "job-01")?.status).toBe("completed")

    // Backward moves are rejected.
    expect(() => updateJobStatus(db!, identity, "job-01", "running", m)).toThrow(
      /backward moves rejected/,
    )
    expect(getJob(db, identity, "job-01")?.status).toBe("completed")

    // Batch complete closes every outstanding job at once.
    const completed = completeAllJobs(db, identity, { actorRole: "user", sessionId: "ses_user" })
    expect(completed.map((job) => `${job.job_id}=${job.status}`).sort()).toEqual([
      "job-01=completed",
      "job-02=completed",
    ])
    expect(getJob(db, identity, "job-01")?.status).toBe("completed")
    expect(getJob(db, identity, "job-02")?.status).toBe("completed")
    expect(listJobs(db, identity)).toHaveLength(2)
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
      { type: "feature", status: "open" },
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

  test("current_workstreams is strictly per-user with one row per repo+user", async () => {
    db = openInMemoryDb()
    initSchema(db)
    const { resolve } = await import("node:path")
    const absA = resolve(repoA)
    const absB = resolve(repoB)
    const m = mutation("system", "ses_current")

    expect(getCurrentWorkstream(db, { repoRoot: absA, user: "alice" })).toBeNull()

    const first = setCurrentWorkstream(
      db,
      { repoRoot: absA, user: "alice", workstreamId: "01-export" },
      m,
    )
    expect(first.workstream_id).toBe("01-export")
    expect(getCurrentWorkstream(db, { repoRoot: absA, user: "alice" })?.workstream_id).toBe(
      "01-export",
    )
    // Other users, repos are isolated (no cross-user adoption).
    expect(getCurrentWorkstream(db, { repoRoot: absA, user: "bob" })).toBeNull()
    expect(getCurrentWorkstream(db, { repoRoot: absB, user: "alice" })).toBeNull()

    // Re-setting the same user replaces the row (one row per repo+user).
    setCurrentWorkstream(db, { repoRoot: absA, user: "alice", workstreamId: "02-import" }, m)
    expect(getCurrentWorkstream(db, { repoRoot: absA, user: "alice" })?.workstream_id).toBe(
      "02-import",
    )
    const rows = db
      .query(`SELECT * FROM current_workstreams WHERE repo_root = ? AND user = ?`)
      .all(absA, "alice") as unknown[]
    expect(rows).toHaveLength(1)

    // Mutations are recorded.
    const log = listMutations(db, { tableName: "current_workstreams" })
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log[0]).toMatchObject({ table_name: "current_workstreams" })

    // Validation rejects bad keys.
    expect(() =>
      setCurrentWorkstream(db!, { repoRoot: absA, user: "alice", workstreamId: "../outside" }, m),
    ).toThrow(SaneDbError)
    expect(() =>
      setCurrentWorkstream(db!, { repoRoot: absA, user: "", workstreamId: "01-export" }, m),
    ).toThrow(SaneDbError)
  })
})
