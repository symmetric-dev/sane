import type { Database } from "bun:sqlite"
import type { WorkstreamStatusResult } from "./sane-workstream-state.ts"

/**
 * State renderer from sqlite (docs/SANE_0_2_0.md Section 2).
 *
 * `sqlite` at `<repo>/.sane/sane.db` is the source of truth; the rendered
 * markdown is printed to stdout by `sane view` and never written to a
 * file. On conflict, the database wins. This renderer replaced the old
 * Stage-shaped workstream-state layout (Workstream
 * Foundation/Stages/Implementation) with the 0.2.0 single-scope shape.
 */

export interface SaneViewIdentity {
  repoRoot: string
  user: string
  workstreamId: string
}

/** Accepted runtime shape (camelCase primary, snake_case tolerated). */
type IdentityInput =
  | SaneViewIdentity
  | { repo_root: string; user: string; workstream_id: string }
  | (Record<string, unknown> & { user?: unknown })

export const SANE_PHASES = ["design", "engineering", "planning", "execution"] as const
export type SanePhase = (typeof SANE_PHASES)[number]

export class SaneViewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneViewError"
  }
}

/**
 * Canonical sqlite schema for the renderer (docs/SANE_0_2_0.md Section 2).
 * One database per repository; every row keyed by
 * `(repo_root, user, workstream_id)`.
 */
export const SANE_VIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS workstreams(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id)
);
CREATE TABLE IF NOT EXISTS selections(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  session_id TEXT NOT NULL,
  worktree_path TEXT,
  branch TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, slot)
);
CREATE TABLE IF NOT EXISTS state_entries(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_role TEXT NOT NULL,
  approval_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, phase)
);
CREATE TABLE IF NOT EXISTS approvals(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  sane_hash TEXT NOT NULL,
  git_commit TEXT,
  approval_ref TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, phase)
);
CREATE TABLE IF NOT EXISTS research_reports(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sane_hash TEXT NOT NULL,
  git_commit TEXT,
  actor_role TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, topic)
);
CREATE TABLE IF NOT EXISTS jobs(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  spec_path TEXT NOT NULL,
  report_path TEXT,
  status TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, job_id)
);
CREATE TABLE IF NOT EXISTS merges(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_rev TEXT NOT NULL,
  merge_commit TEXT,
  PRIMARY KEY (repo_root, user, workstream_id)
);
CREATE TABLE IF NOT EXISTS current_workstreams(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user)
);
`.trim()

interface StateEntryRow {
  status: string
  approval_ref: string | null
}

interface ApprovalRow {
  artifact_path: string
  sane_hash: string
  git_commit: string | null
  approval_ref: string
  approved_at: string
}

interface JobRow {
  job_id: string
  spec_path: string
  report_path: string | null
  status: string
}

interface ResearchReportRow {
  topic: string
  path: string
  created_at: string
  sane_hash: string
  git_commit: string | null
}

interface MergeRow {
  branch: string
  base_rev: string
  merge_commit: string | null
}

function normalizeIdentity(identity: IdentityInput): SaneViewIdentity {
  const record = identity as Record<string, unknown>
  const repoRoot = (record["repoRoot"] ?? record["repo_root"]) as unknown
  const workstreamId = (record["workstreamId"] ?? record["workstream_id"]) as unknown
  const user = record["user"] as unknown
  if (typeof repoRoot !== "string" || !repoRoot) {
    throw new SaneViewError("SaneView identity requires repoRoot (repo_root).")
  }
  if (typeof user !== "string" || !user) {
    throw new SaneViewError("SaneView identity requires user.")
  }
  if (typeof workstreamId !== "string" || !workstreamId) {
    throw new SaneViewError("SaneView identity requires workstreamId (workstream_id).")
  }
  return { repoRoot, user, workstreamId }
}

function none(value: string | null | undefined, emptyLabel = "(none)"): string {
  if (value === null || value === undefined || value === "") return emptyLabel
  return value
}

function esc(value: string): string {
  // Keep one-line markdown cells readable; preserve DB content otherwise.
  return value.replace(/\r?\n/g, " / ")
}

/**
 * Render workstream state from the database. The database always wins: there
 * is no state file to merge with; callers print this return value.
 */
export function renderSaneView(db: Database, identity: IdentityInput): string {
  const { repoRoot, user, workstreamId } = normalizeIdentity(identity)
  const key = [repoRoot, user, workstreamId] as const

  const workstream = db
    .query("SELECT 1 FROM workstreams WHERE repo_root = ? AND user = ? AND workstream_id = ?")
    .get(...key) as { "1": number } | null
  if (!workstream) {
    throw new SaneViewError(
      `No workstream row for repo_root=${JSON.stringify(repoRoot)} user=${JSON.stringify(user)} workstream_id=${JSON.stringify(workstreamId)}.`,
    )
  }

  const lines: string[] = []
  lines.push(`# SANE State — ${workstreamId}`)
  lines.push("")
  lines.push("<!-- SANE workstream state. View via `sane view`. -->")
  lines.push("")
  lines.push(`- repo_root: ${esc(repoRoot)}`)
  lines.push(`- user: ${esc(user)}`)
  lines.push(`- workstream_id: ${esc(workstreamId)}`)
  lines.push("")

  // --- Phases (design|engineering|planning|execution) ---
  lines.push("## Phases")
  lines.push("")
  for (const phase of SANE_PHASES) {
    const entry = db
      .query(
        "SELECT status, approval_ref FROM state_entries WHERE repo_root = ? AND user = ? AND workstream_id = ? AND phase = ?",
      )
      .get(repoRoot, user, workstreamId, phase) as StateEntryRow | null
    lines.push(`### ${phase}`)
    lines.push("")
    lines.push(`- status: ${esc(entry?.status ?? "pending")}`)
    lines.push(`- approval_ref: ${esc(none(entry?.approval_ref))}`)
    lines.push("")
  }

  // --- Approvals (one row per phase, at most) ---
  // Pending phases render "[ ] Pending" and never "[✓] Approved"; approved
  // phases render approval_ref + sane_hash + "[✓] Approved".
  lines.push("## Approvals")
  lines.push("")
  for (const phase of SANE_PHASES) {
    const approval = db
      .query(
        "SELECT artifact_path, sane_hash, git_commit, approval_ref, approved_at FROM approvals WHERE repo_root = ? AND user = ? AND workstream_id = ? AND phase = ?",
      )
      .get(repoRoot, user, workstreamId, phase) as ApprovalRow | null
    lines.push(`### ${phase}`)
    lines.push("")
    if (!approval) {
      lines.push("- status: [ ] Pending")
      lines.push("- artifact_path: (none)")
      lines.push("- sane_hash: (none)")
      lines.push("- git_commit: (none)")
      lines.push("- approval_ref: (none)")
    } else {
      lines.push("- status: [✓] Approved")
      lines.push(`- artifact_path: ${esc(approval.artifact_path)}`)
      lines.push(`- sane_hash: ${esc(approval.sane_hash)}`)
      lines.push(`- git_commit: ${esc(none(approval.git_commit))}`)
      lines.push(`- approval_ref: ${esc(approval.approval_ref)}`)
      lines.push(`- approved_at: ${esc(approval.approved_at)}`)
    }
    lines.push("")
  }

  // --- Jobs (job_id/spec/report/status) ---
  lines.push("## Jobs")
  lines.push("")
  const jobs = db
    .query(
      "SELECT job_id, spec_path, report_path, status FROM jobs WHERE repo_root = ? AND user = ? AND workstream_id = ? ORDER BY job_id ASC",
    )
    .all(repoRoot, user, workstreamId) as JobRow[]
  if (jobs.length === 0) {
    lines.push("(no jobs recorded)")
    lines.push("")
  } else {
    lines.push("| job_id | spec_path | report_path | status |")
    lines.push("| --- | --- | --- | --- |")
    for (const job of jobs) {
      lines.push(
        `| ${esc(job.job_id)} | ${esc(job.spec_path)} | ${esc(none(job.report_path))} | ${esc(job.status)} |`,
      )
    }
    lines.push("")
  }

  // --- Research (append-only registry of completed topic reports) ---
  lines.push("## Research")
  lines.push("")
  const reports = db
    .query("SELECT topic, path, created_at, sane_hash, git_commit FROM research_reports WHERE repo_root = ? AND user = ? AND workstream_id = ? ORDER BY topic")
    .all(...key) as ResearchReportRow[]
  if (reports.length === 0) {
    lines.push("(no research registered)")
    lines.push("")
  } else {
    lines.push("| topic | created | sane_hash | git_commit | path |")
    lines.push("| --- | --- | --- | --- | --- |")
    for (const report of reports) {
      lines.push(
        `| ${esc(report.topic)} | ${esc(report.created_at)} | ${esc(report.sane_hash.slice(0, 12))} | ${esc(report.git_commit ? report.git_commit.slice(0, 12) : "-")} | ${esc(report.path)} |`,
      )
    }
    lines.push("")
  }

  // --- Merge (branch/base_rev/merge_commit) ---
  lines.push("## Merge")
  lines.push("")
  const merge = db
    .query("SELECT branch, base_rev, merge_commit FROM merges WHERE repo_root = ? AND user = ? AND workstream_id = ?")
    .get(...key) as MergeRow | null
  if (!merge) {
    lines.push("(no merge recorded)")
    lines.push("")
  } else {
    lines.push(`- branch: ${esc(merge.branch)}`)
    lines.push(`- base_rev: ${esc(merge.base_rev)}`)
    lines.push(`- merge_commit: ${esc(none(merge.merge_commit, "(not merged)"))}`)
    lines.push("")
  }

  return lines.join("\n")
}

/** Human overview; paths are relative to the workstream directory. */
export function renderCompactSaneView(state: WorkstreamStatusResult): string {
  const phases = new Map(state.phases.map((entry) => [entry.phase, entry.status]))
  const lines = [
    `${state.workstreamId} (${state.workstream.type}): ${state.workstream.status}`,
    `Phases: ${SANE_PHASES.map((phase) => `${phase} ${phases.get(phase) ?? "pending"}`).join(" · ")}`,
    `Approvals: ${state.approvals.map((entry) => entry.phase).join(", ") || "none"}`,
    `Jobs (${state.jobs.length}; paths relative to workstream):`,
  ]
  for (const job of state.jobs) {
    lines.push(`  ${job.job_id} ${job.status} — ${job.spec_path}${job.report_path ? ` → ${job.report_path}` : ""}`)
  }
  lines.push(`Research (${state.researchReports.length}; paths relative to workstream):`)
  for (const report of state.researchReports) lines.push(`  ${report.topic} — ${report.path}`)
  lines.push(`Merge: ${state.merge ? `${state.merge.branch} (${state.merge.merge_commit ? "merged" : "open"})` : "none"}`)
  return lines.join("\n")
}
