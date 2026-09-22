/**
 * SANE 0.2.0 M2-A: sqlite source of truth.
 *
 * One database per repository at `<repo>/.sane/sane.db`. Markdown files are
 * renders; on conflict the database wins. Every row is keyed by
 * `(repo_root, user, workstream_id)` so multiple users/repos/workstreams never
 * clash. Every mutation records `(actor_role, session_id, timestamp)`.
 *
 * See docs/SANE_0_2_0.md Section 2. New file only (M2-A); does not modify M1
 * validation in packages/sane-cli/src/sane-repository.ts.
 */
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path"

import { resolveImplementationRepository } from "./sane-repository.ts"

export const SANE_DB_FILENAME = "sane.db"

export class SaneDbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneDbError"
  }
}

// ---------------------------------------------------------------------------
// Enumerations (docs/SANE_0_2_0.md Section 2, Status values)
// ---------------------------------------------------------------------------

export const WORKSTREAM_STATUSES = ["open", "blocked", "done", "abandoned"] as const
export type WorkstreamStatus = (typeof WORKSTREAM_STATUSES)[number]

export const STATE_ENTRY_STATUSES = [
  "pending",
  "in_progress",
  "delivered",
  "approved",
  "blocked",
] as const
export type StateEntryStatus = (typeof STATE_ENTRY_STATUSES)[number]

export const JOB_STATUSES = [
  "planned",
  "running",
  "completed",
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const PHASES = ["design", "engineering", "planning", "execution"] as const
export type Phase = (typeof PHASES)[number]

/** Approvals are keyed by phase: one approval row per phase at most. */
export type ApprovalPhase = Phase

/** Phase slots plus support-track slots (`research` or `research:<topic>`). */
export type SelectionSlot = Phase | "research" | `research:${string}`

export const WORKSTREAM_TYPES = ["feature", "foundation", "issue", "maintenance"] as const
export type WorkstreamType = (typeof WORKSTREAM_TYPES)[number]

const PHASE_SET = new Set<string>(PHASES)
const WORKSTREAM_TYPE_SET = new Set<string>(WORKSTREAM_TYPES)
const WORKSTREAM_STATUS_SET = new Set<string>(WORKSTREAM_STATUSES)
const STATE_ENTRY_STATUS_SET = new Set<string>(STATE_ENTRY_STATUSES)
const JOB_STATUS_SET = new Set<string>(JOB_STATUSES)

/** Linear job order used for transition validation. */
const JOB_STATUS_ORDER: Record<JobStatus, number> = {
  planned: 0,
  running: 1,
  completed: 2,
}

// ---------------------------------------------------------------------------
// Identity and mutation context
// ---------------------------------------------------------------------------

export interface SaneIdentity {
  repoRoot: string
  user: string
  workstreamId: string
}

export interface MutationContext {
  actorRole: string
  sessionId: string
  timestamp?: string
}

export interface OpenSaneDbOptions {
  /** Override the database file location (primarily for isolated tests). */
  dbPath?: string
}

export function currentUser(): string {
  return userInfo().username
}

/**
 * Normalize a user-supplied workstream path to the canonical `workstream_id`.
 * Mirrors the traversal rejection in `resolveSafeWorkstreamPath` without
 * requiring a workstreams root on disk.
 */
export function normalizeWorkstreamId(requestedPath: string): string {
  if (!requestedPath || requestedPath.trim() === "" || isAbsolute(requestedPath)) {
    throw new SaneDbError("Workstream path must be a non-empty relative path.")
  }
  if (requestedPath.split(/[\\/]+/).some((part) => part === "." || part === "..")) {
    throw new SaneDbError("Workstream path must not contain traversal segments.")
  }
  const normalized = normalize(requestedPath)
  if (normalized === "" || normalized === "." || isAbsolute(normalized)) {
    throw new SaneDbError("Workstream path must be a non-empty relative path.")
  }
  const segments = normalized.split(sep)
  if (segments.some((part) => part === "." || part === "..")) {
    throw new SaneDbError("Workstream path must not contain traversal segments.")
  }
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new SaneDbError("Workstream path must not escape the workstreams root.")
  }
  return normalized
}

/** Flatten separators for `sane/<user>/<workstream>` branch/worktree names. */
export function flattenWorkstreamId(workstreamId: string): string {
  return workstreamId.split(/[\\/]+/).join("-")
}

export function branchForWorkstream(user: string, workstreamId: string): string {
  if (!user || user.trim() === "") throw new SaneDbError("User must be non-empty.")
  return `sane/${user}/${flattenWorkstreamId(normalizeWorkstreamId(workstreamId))}`
}

export function saneDbPath(repoRoot: string): string {
  return join(repoRoot, ".sane", SANE_DB_FILENAME)
}

/**
 * Resolve the composite identity for a workstream. `repo_root` is the absolute
 * git root via the existing `resolveImplementationRepository` logic, `user` is
 * the operating user (overridable for tests), and `workstream_id` is the
 * normalized relative path.
 */
export async function resolveSaneIdentity(
  repoPath: string,
  workstreamPath: string,
  userOverride?: string,
): Promise<SaneIdentity> {
  const repoRoot = await resolveImplementationRepository(repoPath)
  const user = userOverride ?? currentUser()
  if (!user || user.trim() === "") throw new SaneDbError("User must be non-empty.")
  return { repoRoot, user, workstreamId: normalizeWorkstreamId(workstreamPath) }
}

function assertIdentity(identity: SaneIdentity): void {
  if (!identity.repoRoot || !isAbsolute(identity.repoRoot)) {
    throw new SaneDbError("Identity repoRoot must be an absolute path.")
  }
  if (!identity.user || identity.user.trim() === "") {
    throw new SaneDbError("Identity user must be non-empty.")
  }
  // Re-validate normalization so callers cannot bypass traversal checks.
  const normalized = normalizeWorkstreamId(identity.workstreamId)
  if (normalized !== identity.workstreamId) {
    throw new SaneDbError(`Identity workstreamId is not normalized: ${identity.workstreamId}`)
  }
}

function resolveTimestamp(mutation: MutationContext): string {
  if (!mutation.actorRole || mutation.actorRole.trim() === "") {
    throw new SaneDbError("Mutation actorRole must be non-empty.")
  }
  if (!mutation.sessionId || mutation.sessionId.trim() === "") {
    throw new SaneDbError("Mutation sessionId must be non-empty.")
  }
  return mutation.timestamp ?? new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Enum validation
// ---------------------------------------------------------------------------

function assertWorkstreamStatus(status: string): asserts status is WorkstreamStatus {
  if (!WORKSTREAM_STATUS_SET.has(status)) {
    throw new SaneDbError(
      `Invalid workstream status "${status}". Expected one of: ${WORKSTREAM_STATUSES.join(", ")}.`,
    )
  }
}

function assertWorkstreamType(type: string): asserts type is WorkstreamType {
  if (!WORKSTREAM_TYPE_SET.has(type)) {
    throw new SaneDbError(
      `Invalid workstream type "${type}". Expected one of: ${WORKSTREAM_TYPES.join(", ")}.`,
    )
  }
}

function assertStateEntryStatus(status: string): asserts status is StateEntryStatus {
  if (!STATE_ENTRY_STATUS_SET.has(status)) {
    throw new SaneDbError(
      `Invalid state entry status "${status}". Expected one of: ${STATE_ENTRY_STATUSES.join(", ")}.`,
    )
  }
}

function assertJobStatus(status: string): asserts status is JobStatus {
  if (!JOB_STATUS_SET.has(status)) {
    throw new SaneDbError(
      `Invalid job status "${status}". Expected one of: ${JOB_STATUSES.join(", ")}.`,
    )
  }
}

function assertApprovalPhase(phase: string): asserts phase is ApprovalPhase {
  if (!PHASE_SET.has(phase)) {
    throw new SaneDbError(
      `Invalid approval phase "${phase}". Expected one of: ${PHASES.join(", ")}.`,
    )
  }
}

function assertPhase(phase: string): asserts phase is Phase {
  if (!PHASE_SET.has(phase)) {
    throw new SaneDbError(`Invalid phase "${phase}". Expected one of: ${PHASES.join(", ")}.`)
  }
}

function assertOwnerRole(ownerRole: string): asserts ownerRole is Phase {
  assertPhase(ownerRole)
}

export function assertSelectionSlot(slot: string): asserts slot is SelectionSlot {
  if (PHASE_SET.has(slot)) return
  if (slot === "research") return
  if (slot.startsWith("research:")) {
    const topic = slot.slice("research:".length)
    if (topic.trim() !== "" && !topic.includes("\n")) return
  }
  throw new SaneDbError(
    `Invalid selection slot "${slot}". Expected one of: ${PHASES.join(", ")}, research, or research:<topic>.`,
  )
}

function assertNonEmpty(field: string, value: string): void {
  if (!value || value.trim() === "") throw new SaneDbError(`${field} must be non-empty.`)
}

// ---------------------------------------------------------------------------
// Database open and schema
// ---------------------------------------------------------------------------

/**
 * Open the per-repo sqlite database. Resolves `repoPath` to the absolute git
 * root and opens `<repo>/.sane/sane.db` (one DB per repo). Pass
 * `{ dbPath }` for isolated tests. Call `initSchema(db)` before use.
 */
export async function openSaneDb(
  repoPath: string,
  options?: OpenSaneDbOptions,
): Promise<Database> {
  if (repoPath === ":memory:") {
    const memory = new Database(":memory:")
    memory.exec("PRAGMA foreign_keys = ON;")
    return memory
  }
  const repoRoot = await resolveImplementationRepository(repoPath)
  const dbPath = options?.dbPath ?? saneDbPath(repoRoot)
  if (dbPath === ":memory:") {
    const memory = new Database(":memory:")
    memory.exec("PRAGMA foreign_keys = ON;")
    return memory
  }
  await mkdir(dirname(resolve(dbPath)), { recursive: true })
  const db = new Database(resolve(dbPath))
  db.exec("PRAGMA foreign_keys = ON;")
  return db
}

/** Open a database at an explicit file path without git-root resolution. */
export function openSaneDbAtPath(dbPath: string): Database {
  if (dbPath === ":memory:") {
    const memory = new Database(":memory:")
    memory.exec("PRAGMA foreign_keys = ON;")
    return memory
  }
  mkdirSync(dirname(resolve(dbPath)), { recursive: true })
  const db = new Database(resolve(dbPath))
  db.exec("PRAGMA foreign_keys = ON;")
  return db
}

/** Open an in-memory database (isolated tests). */
export function openInMemoryDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA foreign_keys = ON;")
  return db
}

/**
 * Create all M2-A tables with composite primary keys and enum CHECKs.
 * Idempotent (`IF NOT EXISTS`).
 */
export function initSchema(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS workstreams(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('feature','foundation','issue','maintenance')),
  status TEXT NOT NULL CHECK(status IN ('open','blocked','done','abandoned')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id)
);
CREATE TABLE IF NOT EXISTS selections(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK(slot IN ('design','engineering','planning','execution') OR slot LIKE 'research:%' OR slot = 'research'),
  session_id TEXT NOT NULL,
  worktree_path TEXT,
  branch TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, slot, session_id)
);
CREATE TABLE IF NOT EXISTS state_entries(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('design','engineering','planning','execution')),
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','delivered','approved','blocked')),
  owner_role TEXT NOT NULL CHECK(owner_role IN ('design','engineering','planning','execution')),
  approval_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, phase)
);
CREATE TABLE IF NOT EXISTS approvals(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('design','engineering','planning','execution')),
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
  status TEXT NOT NULL CHECK(status IN ('planned','running','completed')),
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
CREATE TABLE IF NOT EXISTS workstream_implementations(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id)
);
CREATE TABLE IF NOT EXISTS session_workstreams(
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, session_id)
);
CREATE TABLE IF NOT EXISTS sane_mutations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_root TEXT NOT NULL,
  user TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
`)
  migrateResearchRegistry(db)
}

/**
 * One-way migration off the retired baseline model: drop the `baselines`
 * table and rebuild legacy `research_reports` rows (which carried
 * `baseline_rev`) into the append-only registry shape. Migrated rows keep
 * their topic/path with empty hash/created placeholders until re-registered.
 */
function migrateResearchRegistry(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS baselines`)
  const columns = db
    .query(`PRAGMA table_info(research_reports)`)
    .all() as Array<{ name: string }>
  const names = new Set(columns.map((column) => column.name))
  if (!names.has("baseline_rev")) return
  db.exec(`
CREATE TABLE IF NOT EXISTS research_reports_new(
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
INSERT OR IGNORE INTO research_reports_new
  (repo_root, user, workstream_id, topic, path, created_at, sane_hash, git_commit, actor_role, session_id)
  SELECT repo_root, user, workstream_id, topic, path, '', '', NULL, 'research', 'legacy-migration'
  FROM research_reports;
DROP TABLE research_reports;
ALTER TABLE research_reports_new RENAME TO research_reports;
`)
}

function recordMutation(
  db: Database,
  identity: SaneIdentity,
  tableName: string,
  operation: string,
  mutation: MutationContext,
  timestamp: string,
): void {
  db.query(
    `INSERT INTO sane_mutations (repo_root, user, workstream_id, table_name, operation, actor_role, session_id, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
    tableName,
    operation,
    mutation.actorRole,
    mutation.sessionId,
    timestamp,
  )
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface WorkstreamRow {
  repo_root: string
  user: string
  workstream_id: string
  type: WorkstreamType
  status: WorkstreamStatus
  created_at: string
}

export interface SelectionRow {
  repo_root: string
  user: string
  workstream_id: string
  slot: string
  session_id: string
  worktree_path: string | null
  branch: string | null
  updated_at: string
}

export interface WorkstreamImplementationRow {
  repo_root: string
  user: string
  workstream_id: string
  worktree_path: string
  branch: string | null
  updated_at: string
}

export function getWorkstreamImplementation(db: Database, identity: SaneIdentity): WorkstreamImplementationRow | null {
  assertIdentity(identity)
  return db.query("SELECT * FROM workstream_implementations WHERE repo_root = ? AND user = ? AND workstream_id = ?")
    .get(identity.repoRoot, identity.user, identity.workstreamId) as WorkstreamImplementationRow | null
}

/** Paths are validated by the asynchronous binding boundary before this write. */
export function setWorkstreamImplementation(
  db: Database, identity: SaneIdentity, input: { worktreePath: string; branch?: string | null; reassign?: boolean }, mutation: MutationContext,
): WorkstreamImplementationRow {
  assertIdentity(identity)
  if (!isAbsolute(input.worktreePath)) throw new SaneDbError("Implementation worktree must be an absolute path.")
  const timestamp = resolveTimestamp(mutation)
  const existing = getWorkstreamImplementation(db, identity)
  if (existing && existing.worktree_path !== input.worktreePath && !input.reassign) {
    throw new SaneDbError(`Workstream ${identity.workstreamId} already has implementation worktree ${existing.worktree_path}; use --reassign to replace explicitly.`)
  }
  db.query(`INSERT INTO workstream_implementations VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_root, user, workstream_id) DO UPDATE SET worktree_path=excluded.worktree_path, branch=excluded.branch, updated_at=excluded.updated_at`)
    .run(identity.repoRoot, identity.user, identity.workstreamId, input.worktreePath, input.branch ?? null, timestamp)
  recordMutation(db, identity, "workstream_implementations", "bind", mutation, timestamp)
  return getWorkstreamImplementation(db, identity)!
}

/** Includes legacy selection rows; ambiguity must never fall through to mutable selection. */
export function getSessionWorkstream(db: Database, key: { repoRoot: string; user: string; sessionId: string }): string | null {
  const rows = db.query(`SELECT workstream_id FROM session_workstreams WHERE repo_root = ? AND user = ? AND session_id = ?
    UNION SELECT workstream_id FROM selections WHERE repo_root = ? AND user = ? AND session_id = ?`)
    .all(key.repoRoot, key.user, key.sessionId, key.repoRoot, key.user, key.sessionId) as Array<{ workstream_id: string }>
  if (rows.length > 1) throw new SaneDbError(`Session ${key.sessionId} is linked to multiple workstreams; explicitly reassign it with sane link --reassign.`)
  return rows[0]?.workstream_id ?? null
}

export function bindSessionWorkstream(db: Database, identity: SaneIdentity, sessionId: string, mutation: MutationContext, reassign = false): void {
  assertIdentity(identity)
  assertNonEmpty("sessionId", sessionId)
  const timestamp = resolveTimestamp(mutation)
  if (!reassign) {
    const existing = getSessionWorkstream(db, { ...identity, sessionId })
    if (existing && existing !== identity.workstreamId) throw new SaneDbError(`Session ${sessionId} is already linked to workstream ${existing}; use --reassign to move it explicitly.`)
  } else {
    db.query("DELETE FROM selections WHERE repo_root = ? AND user = ? AND session_id = ? AND workstream_id != ?")
      .run(identity.repoRoot, identity.user, sessionId, identity.workstreamId)
  }
  db.query(`INSERT INTO session_workstreams VALUES (?, ?, ?, ?) ON CONFLICT(repo_root, user, session_id) DO UPDATE SET workstream_id=excluded.workstream_id`)
    .run(identity.repoRoot, identity.user, sessionId, identity.workstreamId)
  recordMutation(db, identity, "session_workstreams", "bind", mutation, timestamp)
}

export interface StateEntryRow {
  repo_root: string
  user: string
  workstream_id: string
  phase: string
  status: StateEntryStatus
  owner_role: string
  approval_ref: string | null
  updated_at: string
}

export interface ApprovalRow {
  repo_root: string
  user: string
  workstream_id: string
  phase: ApprovalPhase
  artifact_path: string
  sane_hash: string
  git_commit: string | null
  approval_ref: string
  approved_at: string
}

export interface ResearchReportRow {
  repo_root: string
  user: string
  workstream_id: string
  topic: string
  path: string
  created_at: string
  sane_hash: string
  git_commit: string | null
  actor_role: string
  session_id: string
}

export interface JobRow {
  repo_root: string
  user: string
  workstream_id: string
  job_id: string
  spec_path: string
  report_path: string | null
  status: JobStatus
}

export interface MergeRow {
  repo_root: string
  user: string
  workstream_id: string
  branch: string
  base_rev: string
  merge_commit: string | null
}

export interface MutationLogRow {
  id: number
  repo_root: string
  user: string
  workstream_id: string
  table_name: string
  operation: string
  actor_role: string
  session_id: string
  timestamp: string
}

export interface CurrentWorkstreamRow {
  repo_root: string
  user: string
  workstream_id: string
  updated_at: string
}

export interface CurrentWorkstreamKey {
  repoRoot: string
  user: string
}

export interface SetCurrentWorkstreamInput extends CurrentWorkstreamKey {
  workstreamId: string
}

// ---------------------------------------------------------------------------
// workstreams
// ---------------------------------------------------------------------------

export interface UpsertWorkstreamInput {
  type: string
  status: string
}

export function upsertWorkstream(
  db: Database,
  identity: SaneIdentity,
  input: UpsertWorkstreamInput,
  mutation: MutationContext,
): WorkstreamRow {
  assertIdentity(identity)
  assertWorkstreamType(input.type)
  assertWorkstreamStatus(input.status)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `INSERT INTO workstreams (repo_root, user, workstream_id, type, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_root, user, workstream_id)
     DO UPDATE SET type=excluded.type, status=excluded.status`,
  ).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
    input.type,
    input.status,
    timestamp,
  )
  recordMutation(db, identity, "workstreams", "upsert", mutation, timestamp)
  const row = getWorkstream(db, identity)
  if (!row) throw new SaneDbError("Failed to read back workstream after upsert.")
  return row
}

export function getWorkstream(db: Database, identity: SaneIdentity): WorkstreamRow | null {
  assertIdentity(identity)
  const row = db
    .query(`SELECT * FROM workstreams WHERE repo_root = ? AND user = ? AND workstream_id = ?`)
    .get(identity.repoRoot, identity.user, identity.workstreamId) as WorkstreamRow | null
  return row ?? null
}

/** Return the workstream type stored in sqlite (DB is the sole type authority). */
export function getWorkstreamType(db: Database, identity: SaneIdentity): WorkstreamType | null {
  const row = getWorkstream(db, identity)
  if (!row) return null
  assertWorkstreamType(row.type)
  return row.type
}

export function listWorkstreams(
  db: Database,
  filter?: { repoRoot?: string; user?: string },
): WorkstreamRow[] {
  const clauses: string[] = []
  const params: string[] = []
  if (filter?.repoRoot) {
    clauses.push("repo_root = ?")
    params.push(filter.repoRoot)
  }
  if (filter?.user) {
    clauses.push("user = ?")
    params.push(filter.user)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
  return db.query(`SELECT * FROM workstreams ${where} ORDER BY repo_root, user, workstream_id`).all(
    ...params,
  ) as WorkstreamRow[]
}

export function deleteWorkstream(
  db: Database,
  identity: SaneIdentity,
  mutation: MutationContext,
): void {
  assertIdentity(identity)
  const timestamp = resolveTimestamp(mutation)
  db.query(`DELETE FROM workstreams WHERE repo_root = ? AND user = ? AND workstream_id = ?`).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
  )
  recordMutation(db, identity, "workstreams", "delete", mutation, timestamp)
}

// ---------------------------------------------------------------------------
// current_workstreams (per-user current selection; sole authority)
// ---------------------------------------------------------------------------

function assertCurrentKey(key: CurrentWorkstreamKey): void {
  if (!key.repoRoot || !isAbsolute(key.repoRoot)) {
    throw new SaneDbError("Current workstream repoRoot must be an absolute path.")
  }
  if (!key.user || key.user.trim() === "") {
    throw new SaneDbError("Current workstream user must be non-empty.")
  }
}

function assertCurrentInput(input: SetCurrentWorkstreamInput): void {
  assertCurrentKey(input)
  const normalized = normalizeWorkstreamId(input.workstreamId)
  if (normalized !== input.workstreamId) {
    throw new SaneDbError(`Current workstream workstreamId is not normalized: ${input.workstreamId}`)
  }
}

/**
 * Set the current workstream for one `(repo_root, user)` pair.
 * One row per user per repo; strict per-user with no cross-user fallback.
 */
export function setCurrentWorkstream(
  db: Database,
  input: SetCurrentWorkstreamInput,
  mutation: MutationContext,
): CurrentWorkstreamRow {
  assertCurrentInput(input)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `INSERT INTO current_workstreams (repo_root, user, workstream_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_root, user)
     DO UPDATE SET workstream_id=excluded.workstream_id, updated_at=excluded.updated_at`,
  ).run(input.repoRoot, input.user, input.workstreamId, timestamp)
  recordMutation(
    db,
    { repoRoot: input.repoRoot, user: input.user, workstreamId: input.workstreamId },
    "current_workstreams",
    "set",
    mutation,
    timestamp,
  )
  const row = getCurrentWorkstream(db, { repoRoot: input.repoRoot, user: input.user })
  if (!row) throw new SaneDbError("Failed to read back current workstream after set.")
  return row
}

/** Read the current workstream for one `(repo_root, user)` pair (strict per-user). */
export function getCurrentWorkstream(
  db: Database,
  key: CurrentWorkstreamKey,
): CurrentWorkstreamRow | null {
  assertCurrentKey(key)
  const row = db
    .query(`SELECT * FROM current_workstreams WHERE repo_root = ? AND user = ?`)
    .get(key.repoRoot, key.user) as CurrentWorkstreamRow | null
  return row ?? null
}

// ---------------------------------------------------------------------------
// selections (session registry / address book)
// ---------------------------------------------------------------------------

export interface UpsertSelectionInput {
  slot: string
  sessionId: string
  worktreePath?: string | null
  branch?: string | null
}

export function upsertSelection(
  db: Database,
  identity: SaneIdentity,
  input: UpsertSelectionInput,
  mutation: MutationContext,
): SelectionRow {
  // Multiplicity choice: one row per (slot, session_id). `upsertSelection` is
  // the legacy single-call writer (`resolveOrCreateSession`): it inserts the
  // (slot, session_id) row, refreshes that exact row when re-upserted, and
  // never deletes sibling rows for the slot. It returns the latest row
  // (latest-wins) so existing callers keep working unchanged. The future
  // `link` CLI enforces 1:1 vs 1:many policy via link/unlinkSelection.
  assertIdentity(identity)
  assertSelectionSlot(input.slot)
  assertNonEmpty("sessionId", input.sessionId)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `INSERT INTO selections (repo_root, user, workstream_id, slot, session_id, worktree_path, branch, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_root, user, workstream_id, slot, session_id)
     DO UPDATE SET worktree_path=excluded.worktree_path, branch=excluded.branch, updated_at=excluded.updated_at`,
  ).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
    input.slot,
    input.sessionId,
    input.worktreePath ?? null,
    input.branch ?? null,
    timestamp,
  )
  recordMutation(db, identity, "selections", "upsert", mutation, timestamp)
  const row = getLatestSelection(db, identity, input.slot)
  if (!row) throw new SaneDbError("Failed to read back selection after upsert.")
  return row
}

/**
 * Link one more session to a slot (1:many registry). Each (slot, session_id)
 * pair is its own row; multiplicity lives in rows (stable 1-based index by
 * updated_at for later CLI work). Re-linking the exact same (slot,
 * session_id) pair is idempotent: it refreshes that row in place (handoff
 * tracking followed by Pickup self-registration must not collide). Use
 * `upsertSelection` only when the legacy latest-wins return is needed.
 */
export function linkSelection(
  db: Database,
  identity: SaneIdentity,
  input: UpsertSelectionInput,
  mutation: MutationContext,
): SelectionRow {
  assertIdentity(identity)
  assertSelectionSlot(input.slot)
  assertNonEmpty("sessionId", input.sessionId)
  const timestamp = resolveTimestamp(mutation)
  try {
    db.query(
      `INSERT INTO selections (repo_root, user, workstream_id, slot, session_id, worktree_path, branch, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identity.repoRoot,
      identity.user,
      identity.workstreamId,
      input.slot,
      input.sessionId,
      input.worktreePath ?? null,
      input.branch ?? null,
      timestamp,
    )
  } catch (error) {
    const existing = db
      .query(
        `SELECT * FROM selections WHERE repo_root = ? AND user = ? AND workstream_id = ? AND slot = ? AND session_id = ?`,
      )
      .get(
        identity.repoRoot,
        identity.user,
        identity.workstreamId,
        input.slot,
        input.sessionId,
      ) as SelectionRow | null
    if (existing) {
      // Idempotent re-link: the same session registering again (Pickup
      // self-link after handoff tracking, or a retried link) refreshes its
      // row in place instead of throwing.
      db.query(
        `UPDATE selections SET worktree_path = ?, branch = ?, updated_at = ?
         WHERE repo_root = ? AND user = ? AND workstream_id = ? AND slot = ? AND session_id = ?`,
      ).run(
        input.worktreePath ?? null,
        input.branch ?? null,
        timestamp,
        identity.repoRoot,
        identity.user,
        identity.workstreamId,
        input.slot,
        input.sessionId,
      )
      recordMutation(db, identity, "selections", "link", mutation, timestamp)
      const refreshed = db
        .query(
          `SELECT * FROM selections WHERE repo_root = ? AND user = ? AND workstream_id = ? AND slot = ? AND session_id = ?`,
        )
        .get(
          identity.repoRoot,
          identity.user,
          identity.workstreamId,
          input.slot,
          input.sessionId,
        ) as SelectionRow | null
      if (!refreshed) throw new SaneDbError("Failed to read back selection after link.")
      return refreshed
    }
    throw new SaneDbError(`Could not link selection: ${(error as Error).message}`)
  }
  recordMutation(db, identity, "selections", "link", mutation, timestamp)
  const row = db
    .query(
      `SELECT * FROM selections WHERE repo_root = ? AND user = ? AND workstream_id = ? AND slot = ? AND session_id = ?`,
    )
    .get(
      identity.repoRoot,
      identity.user,
      identity.workstreamId,
      input.slot,
      input.sessionId,
    ) as SelectionRow | null
  if (!row) throw new SaneDbError("Failed to read back selection after link.")
  return row
}

/**
 * All linked sessions for one slot, oldest first. Position in this list is
 * the stable 1-based index later CLI work addresses (`engineering:<n>` lives
 * here, not in the slot grammar). `rowid` breaks updated_at ties so the
 * order is deterministic.
 */
export function listSelectionsBySlot(
  db: Database,
  identity: SaneIdentity,
  slot: string,
): SelectionRow[] {
  assertIdentity(identity)
  assertSelectionSlot(slot)
  return db
    .query(
      `SELECT * FROM selections WHERE repo_root = ? AND user = ? AND workstream_id = ? AND slot = ? ORDER BY updated_at ASC, rowid ASC`,
    )
    .all(identity.repoRoot, identity.user, identity.workstreamId, slot) as SelectionRow[]
}

/** Newest linked session for one slot (single row or null). */
export function getLatestSelection(
  db: Database,
  identity: SaneIdentity,
  slot: string,
): SelectionRow | null {
  assertIdentity(identity)
  assertSelectionSlot(slot)
  const row = db
    .query(
      `SELECT * FROM selections WHERE repo_root = ? AND user = ? AND workstream_id = ? AND slot = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    )
    .get(identity.repoRoot, identity.user, identity.workstreamId, slot) as SelectionRow | null
  return row ?? null
}

export function getSelection(
  db: Database,
  identity: SaneIdentity,
  slot: string,
): SelectionRow | null {
  // Backward-compat latest-wins read: existing callers
  // (`sane-handoff-command.ts`) keep working unchanged against multi-row slots.
  return getLatestSelection(db, identity, slot)
}

export function listSelections(db: Database, identity: SaneIdentity): SelectionRow[] {
  assertIdentity(identity)
  return db
    .query(
      `SELECT * FROM selections WHERE repo_root = ? AND user = ? AND workstream_id = ? ORDER BY slot`,
    )
    .all(identity.repoRoot, identity.user, identity.workstreamId) as SelectionRow[]
}

export function deleteSelection(
  db: Database,
  identity: SaneIdentity,
  slot: string,
  mutation: MutationContext,
): void {
  assertIdentity(identity)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `DELETE FROM selections WHERE repo_root = ? AND user = ? AND workstream_id = ? AND slot = ?`,
  ).run(identity.repoRoot, identity.user, identity.workstreamId, slot)
  recordMutation(db, identity, "selections", "delete", mutation, timestamp)
}

/** Remove one linked session from a slot, keeping sibling rows. */
export function unlinkSelection(
  db: Database,
  identity: SaneIdentity,
  slot: string,
  sessionId: string,
  mutation: MutationContext,
): void {
  assertIdentity(identity)
  assertSelectionSlot(slot)
  assertNonEmpty("sessionId", sessionId)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `DELETE FROM selections WHERE repo_root = ? AND user = ? AND workstream_id = ? AND slot = ? AND session_id = ?`,
  ).run(identity.repoRoot, identity.user, identity.workstreamId, slot, sessionId)
  recordMutation(db, identity, "selections", "unlink", mutation, timestamp)
}

// ---------------------------------------------------------------------------
// state_entries
// ---------------------------------------------------------------------------

export interface UpsertStateEntryInput {
  phase: string
  status: string
  ownerRole: string
  approvalRef?: string | null
}

export function upsertStateEntry(
  db: Database,
  identity: SaneIdentity,
  input: UpsertStateEntryInput,
  mutation: MutationContext,
): StateEntryRow {
  assertIdentity(identity)
  assertPhase(input.phase)
  assertStateEntryStatus(input.status)
  assertOwnerRole(input.ownerRole)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `INSERT INTO state_entries (repo_root, user, workstream_id, phase, status, owner_role, approval_ref, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_root, user, workstream_id, phase)
     DO UPDATE SET status=excluded.status, owner_role=excluded.owner_role, approval_ref=excluded.approval_ref, updated_at=excluded.updated_at`,
  ).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
    input.phase,
    input.status,
    input.ownerRole,
    input.approvalRef ?? null,
    timestamp,
  )
  recordMutation(db, identity, "state_entries", "upsert", mutation, timestamp)
  const row = getStateEntry(db, identity, input.phase)
  if (!row) throw new SaneDbError("Failed to read back state entry after upsert.")
  return row
}

export function getStateEntry(
  db: Database,
  identity: SaneIdentity,
  phase: string,
): StateEntryRow | null {
  assertIdentity(identity)
  const row = db
    .query(
      `SELECT * FROM state_entries WHERE repo_root = ? AND user = ? AND workstream_id = ? AND phase = ?`,
    )
    .get(identity.repoRoot, identity.user, identity.workstreamId, phase) as StateEntryRow | null
  return row ?? null
}

export function listStateEntries(db: Database, identity: SaneIdentity): StateEntryRow[] {
  assertIdentity(identity)
  return db
    .query(
      `SELECT * FROM state_entries WHERE repo_root = ? AND user = ? AND workstream_id = ? ORDER BY phase`,
    )
    .all(identity.repoRoot, identity.user, identity.workstreamId) as StateEntryRow[]
}

export function deleteStateEntry(
  db: Database,
  identity: SaneIdentity,
  phase: string,
  mutation: MutationContext,
): void {
  assertIdentity(identity)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `DELETE FROM state_entries WHERE repo_root = ? AND user = ? AND workstream_id = ? AND phase = ?`,
  ).run(identity.repoRoot, identity.user, identity.workstreamId, phase)
  recordMutation(db, identity, "state_entries", "delete", mutation, timestamp)
}

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

export interface RecordApprovalInput {
  phase: string
  artifactPath: string
  saneHash: string
  gitCommit?: string | null
  approvalRef: string
}

export function recordApproval(
  db: Database,
  identity: SaneIdentity,
  input: RecordApprovalInput,
  mutation: MutationContext,
): ApprovalRow {
  assertIdentity(identity)
  assertApprovalPhase(input.phase)
  assertNonEmpty("artifactPath", input.artifactPath)
  assertNonEmpty("saneHash", input.saneHash)
  assertNonEmpty("approvalRef", input.approvalRef)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `INSERT INTO approvals (repo_root, user, workstream_id, phase, artifact_path, sane_hash, git_commit, approval_ref, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_root, user, workstream_id, phase)
     DO UPDATE SET artifact_path=excluded.artifact_path, sane_hash=excluded.sane_hash, git_commit=excluded.git_commit, approval_ref=excluded.approval_ref, approved_at=excluded.approved_at`,
  ).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
    input.phase,
    input.artifactPath,
    input.saneHash,
    input.gitCommit ?? null,
    input.approvalRef,
    timestamp,
  )
  recordMutation(db, identity, "approvals", "record", mutation, timestamp)
  const row = getApproval(db, identity, input.phase)
  if (!row) throw new SaneDbError("Failed to read back approval after record.")
  return row
}

export function getApproval(
  db: Database,
  identity: SaneIdentity,
  phase: string,
): ApprovalRow | null {
  assertIdentity(identity)
  const row = db
    .query(
      `SELECT * FROM approvals WHERE repo_root = ? AND user = ? AND workstream_id = ? AND phase = ?`,
    )
    .get(identity.repoRoot, identity.user, identity.workstreamId, phase) as ApprovalRow | null
  return row ?? null
}

export function listApprovals(db: Database, identity: SaneIdentity): ApprovalRow[] {
  assertIdentity(identity)
  return db
    .query(
      `SELECT * FROM approvals WHERE repo_root = ? AND user = ? AND workstream_id = ? ORDER BY phase`,
    )
    .all(identity.repoRoot, identity.user, identity.workstreamId) as ApprovalRow[]
}

export function deleteApproval(
  db: Database,
  identity: SaneIdentity,
  phase: string,
  mutation: MutationContext,
): void {
  assertIdentity(identity)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `DELETE FROM approvals WHERE repo_root = ? AND user = ? AND workstream_id = ? AND phase = ?`,
  ).run(identity.repoRoot, identity.user, identity.workstreamId, phase)
  recordMutation(db, identity, "approvals", "delete", mutation, timestamp)
}

// ---------------------------------------------------------------------------
// research_reports (append-only registry of completed topic reports)
// ---------------------------------------------------------------------------

export interface RegisterResearchReportInput {
  topic: string
  path: string
  createdAt: string
  saneHash: string
  gitCommit?: string | null
  actorRole?: string
  sessionId?: string
}

export function registerResearchReport(
  db: Database,
  identity: SaneIdentity,
  input: RegisterResearchReportInput,
  mutation: MutationContext,
): ResearchReportRow {
  assertIdentity(identity)
  assertNonEmpty("topic", input.topic)
  if (input.topic.includes("\n")) throw new SaneDbError("Research topic must not contain newlines.")
  assertNonEmpty("path", input.path)
  assertNonEmpty("createdAt", input.createdAt)
  assertNonEmpty("saneHash", input.saneHash)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `INSERT INTO research_reports (repo_root, user, workstream_id, topic, path, created_at, sane_hash, git_commit, actor_role, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_root, user, workstream_id, topic)
     DO UPDATE SET path=excluded.path, created_at=excluded.created_at, sane_hash=excluded.sane_hash,
       git_commit=excluded.git_commit, actor_role=excluded.actor_role, session_id=excluded.session_id`,
  ).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
    input.topic,
    input.path,
    input.createdAt,
    input.saneHash,
    input.gitCommit ?? null,
    input.actorRole ?? mutation.actorRole,
    input.sessionId ?? mutation.sessionId,
  )
  recordMutation(db, identity, "research_reports", "register", mutation, timestamp)
  const row = getResearchReport(db, identity, input.topic)
  if (!row) throw new SaneDbError("Failed to read back research report after register.")
  return row
}

export function getResearchReport(
  db: Database,
  identity: SaneIdentity,
  topic: string,
): ResearchReportRow | null {
  assertIdentity(identity)
  const row = db
    .query(
      `SELECT * FROM research_reports WHERE repo_root = ? AND user = ? AND workstream_id = ? AND topic = ?`,
    )
    .get(identity.repoRoot, identity.user, identity.workstreamId, topic) as ResearchReportRow | null
  return row ?? null
}

export function listResearchReports(db: Database, identity: SaneIdentity): ResearchReportRow[] {
  assertIdentity(identity)
  return db
    .query(
      `SELECT * FROM research_reports WHERE repo_root = ? AND user = ? AND workstream_id = ? ORDER BY topic`,
    )
    .all(identity.repoRoot, identity.user, identity.workstreamId) as ResearchReportRow[]
}

export function deleteResearchReport(
  db: Database,
  identity: SaneIdentity,
  topic: string,
  mutation: MutationContext,
): void {
  assertIdentity(identity)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `DELETE FROM research_reports WHERE repo_root = ? AND user = ? AND workstream_id = ? AND topic = ?`,
  ).run(identity.repoRoot, identity.user, identity.workstreamId, topic)
  recordMutation(db, identity, "research_reports", "delete", mutation, timestamp)
}

// ---------------------------------------------------------------------------
// jobs (planned means authorized: planning approval registers specs as planned)
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  jobId: string
  specPath: string
  reportPath?: string | null
  /** New jobs must start as `planned`. Defaults to `planned`. */
  status?: JobStatus
}

export function createJob(
  db: Database,
  identity: SaneIdentity,
  input: CreateJobInput,
  mutation: MutationContext,
): JobRow {
  assertIdentity(identity)
  assertNonEmpty("jobId", input.jobId)
  assertNonEmpty("specPath", input.specPath)
  const status = input.status ?? "planned"
  assertJobStatus(status)
  if (status !== "planned") {
    throw new SaneDbError(
      `New jobs must start as "planned" (got "${status}"). Jobs are registered as planned by planning approval.`,
    )
  }
  const timestamp = resolveTimestamp(mutation)
  try {
    db.query(
      `INSERT INTO jobs (repo_root, user, workstream_id, job_id, spec_path, report_path, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identity.repoRoot,
      identity.user,
      identity.workstreamId,
      input.jobId,
      input.specPath,
      input.reportPath ?? null,
      status,
    )
  } catch (error) {
    throw new SaneDbError(`Could not create job "${input.jobId}": ${(error as Error).message}`)
  }
  recordMutation(db, identity, "jobs", "create", mutation, timestamp)
  const row = getJob(db, identity, input.jobId)
  if (!row) throw new SaneDbError("Failed to read back job after create.")
  return row
}

export function getJob(db: Database, identity: SaneIdentity, jobId: string): JobRow | null {
  assertIdentity(identity)
  const row = db
    .query(
      `SELECT * FROM jobs WHERE repo_root = ? AND user = ? AND workstream_id = ? AND job_id = ?`,
    )
    .get(identity.repoRoot, identity.user, identity.workstreamId, jobId) as JobRow | null
  return row ?? null
}

export function listJobs(db: Database, identity: SaneIdentity): JobRow[] {
  assertIdentity(identity)
  return db
    .query(
      `SELECT * FROM jobs WHERE repo_root = ? AND user = ? AND workstream_id = ? ORDER BY job_id`,
    )
    .all(identity.repoRoot, identity.user, identity.workstreamId) as JobRow[]
}

/**
 * Direct job status update (progress tracking, ungated). The Execution
 * Assistant moves jobs `planned -> running -> completed` as work proceeds;
 * moves must go forward (same status is a no-op). `planned` comes only from
 * planning-approval registration. `sane approve execution` batch-completes
 * stragglers via `completeAllJobs`.
 */
export function updateJobStatus(
  db: Database,
  identity: SaneIdentity,
  jobId: string,
  newStatus: string,
  mutation: MutationContext,
  options?: { reportPath?: string | null },
): JobRow {
  assertIdentity(identity)
  assertJobStatus(newStatus)
  const timestamp = resolveTimestamp(mutation)
  const current = getJob(db, identity, jobId)
  if (!current) throw new SaneDbError(`Job not found: ${jobId}`)
  const currentOrder = JOB_STATUS_ORDER[current.status as JobStatus]
  const nextOrder = JOB_STATUS_ORDER[newStatus as JobStatus]
  if (nextOrder < currentOrder) {
    throw new SaneDbError(
      `Job "${jobId}" cannot move ${current.status} -> ${newStatus} (backward moves rejected; statuses only track forward progress).`,
    )
  }
  const reportPath = options?.reportPath !== undefined ? options.reportPath : current.report_path
  db.query(
    `UPDATE jobs SET status = ?, report_path = ? WHERE repo_root = ? AND user = ? AND workstream_id = ? AND job_id = ?`,
  ).run(newStatus, reportPath, identity.repoRoot, identity.user, identity.workstreamId, jobId)
  recordMutation(db, identity, "jobs", `status:${current.status}->${newStatus}`, mutation, timestamp)
  const row = getJob(db, identity, jobId)
  if (!row) throw new SaneDbError("Failed to read back job after status update.")
  return row
}

/**
 * Complete every outstanding job in one batch (execution approval). Moves each
 * non-`completed` job to `completed` and records a mutation per job. Covers
 * stragglers the Execution Assistant did not mark itself; already-`completed`
 * jobs are left untouched. The user gate itself is the phase approval row.
 */
export function completeAllJobs(
  db: Database,
  identity: SaneIdentity,
  mutation: MutationContext,
): JobRow[] {
  assertIdentity(identity)
  const timestamp = resolveTimestamp(mutation)
  const complete = db.transaction(() => {
    const completed: JobRow[] = []
    for (const job of listJobs(db, identity)) {
      if (job.status === "completed") {
        completed.push(job)
        continue
      }
      db.query(
        `UPDATE jobs SET status = 'completed' WHERE repo_root = ? AND user = ? AND workstream_id = ? AND job_id = ?`,
      ).run(identity.repoRoot, identity.user, identity.workstreamId, job.job_id)
      recordMutation(db, identity, "jobs", `status:${job.status}->completed`, mutation, timestamp)
      const row = getJob(db, identity, job.job_id)
      if (!row) throw new SaneDbError(`Failed to read back job "${job.job_id}" after complete.`)
      completed.push(row)
    }
    return completed
  })
  return complete()
}

export function deleteJob(
  db: Database,
  identity: SaneIdentity,
  jobId: string,
  mutation: MutationContext,
): void {
  assertIdentity(identity)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `DELETE FROM jobs WHERE repo_root = ? AND user = ? AND workstream_id = ? AND job_id = ?`,
  ).run(identity.repoRoot, identity.user, identity.workstreamId, jobId)
  recordMutation(db, identity, "jobs", "delete", mutation, timestamp)
}

// ---------------------------------------------------------------------------
// merges
// ---------------------------------------------------------------------------

export interface UpsertMergeInput {
  branch: string
  baseRev: string
  mergeCommit?: string | null
}

export function upsertMerge(
  db: Database,
  identity: SaneIdentity,
  input: UpsertMergeInput,
  mutation: MutationContext,
): MergeRow {
  assertIdentity(identity)
  assertNonEmpty("branch", input.branch)
  assertNonEmpty("baseRev", input.baseRev)
  const timestamp = resolveTimestamp(mutation)
  db.query(
    `INSERT INTO merges (repo_root, user, workstream_id, branch, base_rev, merge_commit)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_root, user, workstream_id)
     DO UPDATE SET branch=excluded.branch, base_rev=excluded.base_rev, merge_commit=excluded.merge_commit`,
  ).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
    input.branch,
    input.baseRev,
    input.mergeCommit ?? null,
  )
  recordMutation(db, identity, "merges", "upsert", mutation, timestamp)
  const row = getMerge(db, identity)
  if (!row) throw new SaneDbError("Failed to read back merge after upsert.")
  return row
}

export function getMerge(db: Database, identity: SaneIdentity): MergeRow | null {
  assertIdentity(identity)
  const row = db
    .query(`SELECT * FROM merges WHERE repo_root = ? AND user = ? AND workstream_id = ?`)
    .get(identity.repoRoot, identity.user, identity.workstreamId) as MergeRow | null
  return row ?? null
}

export function recordMergeCommit(
  db: Database,
  identity: SaneIdentity,
  mergeCommit: string,
  mutation: MutationContext,
): MergeRow {
  assertNonEmpty("mergeCommit", mergeCommit)
  const current = getMerge(db, identity)
  if (!current) throw new SaneDbError("No merge row to record a commit against.")
  return upsertMerge(
    db,
    identity,
    { branch: current.branch, baseRev: current.base_rev, mergeCommit },
    mutation,
  )
}

export function deleteMerge(
  db: Database,
  identity: SaneIdentity,
  mutation: MutationContext,
): void {
  assertIdentity(identity)
  const timestamp = resolveTimestamp(mutation)
  db.query(`DELETE FROM merges WHERE repo_root = ? AND user = ? AND workstream_id = ?`).run(
    identity.repoRoot,
    identity.user,
    identity.workstreamId,
  )
  recordMutation(db, identity, "merges", "delete", mutation, timestamp)
}

// ---------------------------------------------------------------------------
// mutation audit
// ---------------------------------------------------------------------------

export function listMutations(
  db: Database,
  filter?: { repoRoot?: string; user?: string; workstreamId?: string; tableName?: string },
): MutationLogRow[] {
  const clauses: string[] = []
  const params: string[] = []
  if (filter?.repoRoot) {
    clauses.push("repo_root = ?")
    params.push(filter.repoRoot)
  }
  if (filter?.user) {
    clauses.push("user = ?")
    params.push(filter.user)
  }
  if (filter?.workstreamId) {
    clauses.push("workstream_id = ?")
    params.push(filter.workstreamId)
  }
  if (filter?.tableName) {
    clauses.push("table_name = ?")
    params.push(filter.tableName)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""
  return db.query(`SELECT * FROM sane_mutations ${where} ORDER BY id`).all(
    ...params,
  ) as MutationLogRow[]
}

export function jobStatusOrder(status: JobStatus): number {
  return JOB_STATUS_ORDER[status]
}
