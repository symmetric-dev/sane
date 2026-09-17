import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"

import { SANE_STATE_SCHEMA, renderSaneState } from "../src/sane-state.ts"
import { hashFile, normalizeGitCommit, sha256Hex, toApprovalHash } from "../src/sane-hash.ts"

const IDENTITY = { repoRoot: "/repo", user: "alice", workstreamId: "01-demo" } as const
const CREATED_AT = "2026-09-16T00:00:00.000Z"

function createDb(): Database {
  const db = new Database(":memory:")
  db.exec(SANE_STATE_SCHEMA)
  return db
}

function seedWorkstream(db: Database): void {
  db.query(
    "INSERT INTO workstreams(repo_root, user, workstream_id, scope, status, foundation_rev, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(IDENTITY.repoRoot, IDENTITY.user, IDENTITY.workstreamId, "Demo one-aspect scope", "open", "foundation-ws@2", CREATED_AT)
}

function seedPhases(db: Database): void {
  const rows = [
    { phase: "design", status: "approved", owner: "design", ref: "user-ok-design" },
    { phase: "engineering", status: "delivered", owner: "engineering", ref: null },
    { phase: "planning", status: "in_progress", owner: "planning", ref: null },
    { phase: "execution", status: "pending", owner: "execution", ref: null },
  ] as const
  for (const row of rows) {
    db.query(
      "INSERT INTO state_entries(repo_root, user, workstream_id, phase, status, owner_role, approval_ref, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(IDENTITY.repoRoot, IDENTITY.user, IDENTITY.workstreamId, row.phase, row.status, row.owner, row.ref, CREATED_AT)
  }
}

function seedApprovals(db: Database): void {
  const gates = ["root-plus-sdd", "solutions", "plan", "jobs-batch", "merge"] as const
  for (const gate of gates) {
    const saneHash = sha256Hex(`artifact:${gate}`)
    db.query(
      "INSERT INTO approvals(repo_root, user, workstream_id, gate, artifact_path, sane_hash, git_commit, approval_ref, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      IDENTITY.repoRoot,
      IDENTITY.user,
      IDENTITY.workstreamId,
      gate,
      `artifacts/${gate}.md`,
      saneHash,
      null,
      `user-approves-${gate}`,
      CREATED_AT,
    )
  }
}

function seedJobsResearchMerge(db: Database): void {
  db.query(
    "INSERT INTO jobs(repo_root, user, workstream_id, job_id, spec_path, report_path, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    IDENTITY.repoRoot,
    IDENTITY.user,
    IDENTITY.workstreamId,
    "01",
    "plan/jobs/01-first-job.md",
    "execution/reports/01-first-job.md",
    "reported",
  )
  db.query(
    "INSERT INTO jobs(repo_root, user, workstream_id, job_id, spec_path, report_path, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    IDENTITY.repoRoot,
    IDENTITY.user,
    IDENTITY.workstreamId,
    "02",
    "plan/jobs/02-second-job.md",
    null,
    "planned",
  )
  db.query("INSERT INTO research_reports(repo_root, user, workstream_id, topic, path, created_at, sane_hash, git_commit, actor_role, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    IDENTITY.repoRoot,
    IDENTITY.user,
    IDENTITY.workstreamId,
    "auth",
    "research/auth/REPORT.md",
    "2026-09-16T00:00:00.000Z",
    "abc123def456",
    null,
    "research",
    "ses_test",
  )
  db.query(
    "INSERT INTO merges(repo_root, user, workstream_id, branch, base_rev, merge_commit) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    IDENTITY.repoRoot,
    IDENTITY.user,
    IDENTITY.workstreamId,
    "sane/alice/01-demo",
    "main-abc123",
    null,
  )
}

describe("sane-state renderer from DB", () => {
  test("renders all sections from DB rows", () => {
    const db = createDb()
    try {
      seedWorkstream(db)
      seedPhases(db)
      seedApprovals(db)
      seedJobsResearchMerge(db)

      const rendered = renderSaneState(db, { ...IDENTITY })

      // Section headings (0.2.0 single-scope shape, not the old Stage shape).
      for (const heading of ["## Workstream", "## Phases", "## Gates", "## Jobs", "## Research", "## Merge"]) {
        expect(rendered).toContain(heading)
      }

      // Workstream (scope, status, foundation_rev).
      expect(rendered).toContain("Demo one-aspect scope")
      expect(rendered).toContain("scope:")
      expect(rendered).toContain("status:")
      expect(rendered).toContain("foundation_rev:")
      expect(rendered).toContain("foundation-ws@2")

      // Phases (all four with status/owner/approval_ref).
      for (const phase of ["design", "engineering", "planning", "execution"]) {
        expect(rendered).toContain(`### ${phase}`)
      }
      expect(rendered).toContain("owner (owner_role):")
      expect(rendered).toContain("approval_ref:")
      expect(rendered).toContain("user-ok-design")

      // Gates (all five with sane_hash/approval_ref/[✓] Approved).
      for (const gate of ["root-plus-sdd", "solutions", "plan", "jobs-batch", "merge"]) {
        expect(rendered).toContain(`### ${gate}`)
        expect(rendered).toContain(`user-approves-${gate}`)
      }
      expect(rendered).toContain("sane_hash:")
      expect(rendered).toContain(sha256Hex("artifact:root-plus-sdd"))
      expect(rendered).toContain("[✓] Approved")

      // Jobs (job_id/spec/report/status).
      expect(rendered).toContain("01")
      expect(rendered).toContain("plan/jobs/01-first-job.md")
      expect(rendered).toContain("execution/reports/01-first-job.md")
      expect(rendered).toContain("reported")
      expect(rendered).toContain("plan/jobs/02-second-job.md")
      expect(rendered).toContain("job_id:")
      expect(rendered).toContain("spec_path:")
      expect(rendered).toContain("report_path:")
      expect(rendered).toContain("planned")

      // Research registry.
      expect(rendered).toContain("## Research")
      expect(rendered).toContain("research/auth/REPORT.md")
      expect(rendered).toContain("2026-09-16T00:00:00.000Z")
      expect(rendered).toContain("abc123def456")

      // Merge (branch/base_rev/merge_commit).
      expect(rendered).toContain("sane/alice/01-demo")
      expect(rendered).toContain("branch:")
      expect(rendered).toContain("base_rev:")
      expect(rendered).toContain("main-abc123")
      expect(rendered).toContain("merge_commit:")
    } finally {
      db.close()
    }
  })

  test("DB wins: re-rendering reflects DB rows with no state file", () => {
    const db = createDb()
    try {
      seedWorkstream(db)
      seedPhases(db)

      const first = renderSaneState(db, { ...IDENTITY })
      expect(first).toContain("Demo one-aspect scope")

      // A DB update changes the next render; there is no file to diverge.
      db.query(
        "UPDATE workstreams SET scope = ? WHERE repo_root = ? AND user = ? AND workstream_id = ?",
      ).run("Updated scope", IDENTITY.repoRoot, IDENTITY.user, IDENTITY.workstreamId)
      const second = renderSaneState(db, { ...IDENTITY })
      expect(second).toContain("Updated scope")
      expect(second).not.toContain("Demo one-aspect scope")
      // Re-rendering without DB changes is deterministic.
      expect(renderSaneState(db, { ...IDENTITY })).toBe(second)
    } finally {
      db.close()
    }
  })

  test("approval [✓] Approved appears only after an approval row exists", () => {
    const db = createDb()
    try {
      seedWorkstream(db)
      seedPhases(db)

      const before = renderSaneState(db, { ...IDENTITY })
      expect(before).toContain("### root-plus-sdd")
      expect(before).toContain("[ ] Pending")
      expect(before).not.toContain("[✓] Approved")

      const { sane_hash, git_commit } = toApprovalHash("root doc plus sdd content", null)
      expect(git_commit).toBeNull()
      db.query(
        "INSERT INTO approvals(repo_root, user, workstream_id, gate, artifact_path, sane_hash, git_commit, approval_ref, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        IDENTITY.repoRoot,
        IDENTITY.user,
        IDENTITY.workstreamId,
        "root-plus-sdd",
        "PRD.md + SDD.md",
        sane_hash,
        git_commit,
        "user-approves-root-plus-sdd",
        CREATED_AT,
      )

      const after = renderSaneState(db, { ...IDENTITY })
      expect(after).toContain("[✓] Approved")
      expect(after).toContain(sane_hash)
      expect(after).toContain("user-approves-root-plus-sdd")
      // Other gates without approvals stay pending.
      expect(after).toContain("### solutions")
      expect(after).toContain("[ ] Pending")
    } finally {
      db.close()
    }
  })

  test("sane-hash helpers produce stable sha256 and nullable git_commit passthrough", async () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")

    expect(normalizeGitCommit(null)).toBeNull()
    expect(normalizeGitCommit(undefined)).toBeNull()
    expect(normalizeGitCommit("deadbeef")).toBe("deadbeef")

    const approval = toApprovalHash("hello", "deadbeef")
    expect(approval).toEqual({ sane_hash: sha256Hex("hello"), git_commit: "deadbeef" })
    expect(toApprovalHash("hello", null).git_commit).toBeNull()

    let tempDirectory = ""
    try {
      tempDirectory = await mkdtemp(join(tmpdir(), "sane-hash-"))
      const filePath = join(tempDirectory, "artifact.md")
      await writeFile(filePath, "artifact bytes\n")
      expect(await hashFile(filePath)).toBe(sha256Hex("artifact bytes\n"))
    } finally {
      if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
    }
  })
})
