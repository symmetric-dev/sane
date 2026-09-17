import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Database } from "bun:sqlite"

/**
 * SANE_STATE.md renderer from sqlite (docs/SANE_0_2_0.md Section 2).
 *
 * `sqlite` at `<repo>/.sane/sane.db` is the source of truth; markdown files
 * are renders for humans and agent context. On conflict, the database wins;
 * this renderer regenerates the file. It deliberately replaces the old
 * Stage-shaped `templates/shared/SANE_STATE.md` layout (Workstream
 * Foundation/Stages/Implementation) with the 0.2.0 single-scope shape.
 */

export interface SaneStateIdentity {
  repoRoot: string
  user: string
  workstreamId: string
}

/** Accepted runtime shape (camelCase primary, snake_case tolerated). */
type IdentityInput =
  | SaneStateIdentity
  | { repo_root: string; user: string; workstream_id: string }
  | (Record<string, unknown> & { user?: unknown })

export const SANE_PHASES = ["design", "engineering", "planning", "execution"] as const
export type SanePhase = (typeof SANE_PHASES)[number]

export const SANE_GATES = ["root-plus-sdd", "solutions", "plan", "jobs-batch", "merge"] as const
export type SaneGate = (typeof SANE_GATES)[number]

export class SaneStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneStateError"
  }
}

/**
 * Canonical sqlite schema for the renderer (docs/SANE_0_2_0.md Section 2).
 * One database per repository; every row keyed by
 * `(repo_root, user, workstream_id)`.
 */
export const SANE_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workstreams(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL,
  foundation_rev TEXT,
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
  gate TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  sane_hash TEXT NOT NULL,
  git_commit TEXT,
  approval_ref TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, gate)
);
CREATE TABLE IF NOT EXISTS baselines(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id)
);
CREATE TABLE IF NOT EXISTS research_reports(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  baseline_rev INTEGER NOT NULL,
  path TEXT NOT NULL,
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
`.trim()

interface WorkstreamRow {
  scope: string
  status: string
  foundation_rev: string | null
}

interface StateEntryRow {
  status: string
  owner_role: string
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

interface BaselineRow {
  revision: number
  path: string
}

interface MergeRow {
  branch: string
  base_rev: string
  merge_commit: string | null
}

function normalizeIdentity(identity: IdentityInput): SaneStateIdentity {
  const record = identity as Record<string, unknown>
  const repoRoot = (record["repoRoot"] ?? record["repo_root"]) as unknown
  const workstreamId = (record["workstreamId"] ?? record["workstream_id"]) as unknown
  const user = record["user"] as unknown
  if (typeof repoRoot !== "string" || !repoRoot) {
    throw new SaneStateError("SaneState identity requires repoRoot (repo_root).")
  }
  if (typeof user !== "string" || !user) {
    throw new SaneStateError("SaneState identity requires user.")
  }
  if (typeof workstreamId !== "string" || !workstreamId) {
    throw new SaneStateError("SaneState identity requires workstreamId (workstream_id).")
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
 * Render SANE_STATE.md from the database. The database always wins: callers
 * overwrite the file with this return value instead of merging edits.
 */
export function renderSaneState(db: Database, identity: IdentityInput): string {
  const { repoRoot, user, workstreamId } = normalizeIdentity(identity)
  const key = [repoRoot, user, workstreamId] as const

  const workstream = db
    .query("SELECT scope, status, foundation_rev FROM workstreams WHERE repo_root = ? AND user = ? AND workstream_id = ?")
    .get(...key) as WorkstreamRow | null
  if (!workstream) {
    throw new SaneStateError(
      `No workstream row for repo_root=${JSON.stringify(repoRoot)} user=${JSON.stringify(user)} workstream_id=${JSON.stringify(workstreamId)}.`,
    )
  }

  const lines: string[] = []
  lines.push(`# SANE State — ${workstreamId}`)
  lines.push("")
  lines.push("<!-- Rendered from sqlite sane.db; database wins. Renderer regenerates this file. -->")
  lines.push("")
  lines.push(`- repo_root: ${esc(repoRoot)}`)
  lines.push(`- user: ${esc(user)}`)
  lines.push(`- workstream_id: ${esc(workstreamId)}`)
  lines.push("")

  // --- Workstream (scope, status, foundation_rev) ---
  lines.push("## Workstream")
  lines.push("")
  lines.push(`- scope: ${esc(workstream.scope)}`)
  lines.push(`- status: ${esc(workstream.status)}`)
  lines.push(`- foundation_rev: ${esc(none(workstream.foundation_rev))}`)
  lines.push("")

  // --- Phases (design|engineering|planning|execution) ---
  lines.push("## Phases")
  lines.push("")
  for (const phase of SANE_PHASES) {
    const entry = db
      .query(
        "SELECT status, owner_role, approval_ref FROM state_entries WHERE repo_root = ? AND user = ? AND workstream_id = ? AND phase = ?",
      )
      .get(repoRoot, user, workstreamId, phase) as StateEntryRow | null
    lines.push(`### ${phase}`)
    lines.push("")
    lines.push(`- status: ${esc(entry?.status ?? "pending")}`)
    lines.push(`- owner (owner_role): ${esc(entry?.owner_role ?? phase)}`)
    lines.push(`- approval_ref: ${esc(none(entry?.approval_ref))}`)
    lines.push("")
  }

  // --- Gates (approvals 1-5) ---
  // Pending gates render "[ ] Pending" and never "[✓] Approved"; approved
  // gates render approval_ref + sane_hash + "[✓] Approved".
  lines.push("## Gates")
  lines.push("")
  for (const gate of SANE_GATES) {
    const approval = db
      .query(
        "SELECT artifact_path, sane_hash, git_commit, approval_ref, approved_at FROM approvals WHERE repo_root = ? AND user = ? AND workstream_id = ? AND gate = ?",
      )
      .get(repoRoot, user, workstreamId, gate) as ApprovalRow | null
    lines.push(`### ${gate}`)
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
    for (const job of jobs) {
      lines.push(`### ${esc(job.job_id)}`)
      lines.push("")
      lines.push(`- job_id: ${esc(job.job_id)}`)
      lines.push(`- spec_path: ${esc(job.spec_path)}`)
      lines.push(`- report_path: ${esc(none(job.report_path))}`)
      lines.push(`- status: ${esc(job.status)}`)
      lines.push("")
    }
  }

  // --- Baseline (revision/path) ---
  lines.push("## Baseline")
  lines.push("")
  const baseline = db
    .query("SELECT revision, path FROM baselines WHERE repo_root = ? AND user = ? AND workstream_id = ?")
    .get(...key) as BaselineRow | null
  if (!baseline) {
    lines.push("(no baseline recorded)")
    lines.push("")
  } else {
    lines.push(`- revision: ${baseline.revision}`)
    lines.push(`- path: ${esc(baseline.path)}`)
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

/**
 * Regenerate a SANE_STATE.md file from the database, overwriting any manual
 * edits (database wins). Returns the rendered markdown.
 *
 * Atomic: writes to a temp file in the same directory then renames, so a
 * crash never leaves a partial SANE_STATE.md.
 */
export async function writeSaneState(
  db: Database,
  identity: IdentityInput,
  filePath: string,
): Promise<string> {
  const rendered = renderSaneState(db, identity)
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const tempPath = join(
    directory,
    `.SANE_STATE.md.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  await writeFile(tempPath, rendered)
  try {
    await rename(tempPath, filePath)
  } catch (error) {
    try {
      await rm(tempPath, { force: true })
    } catch {
      // Best effort cleanup; surface the original rename failure.
    }
    throw error
  }
  return rendered
}
