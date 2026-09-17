/**
 * SANE 0.2.0 M2 P0: workstream status + pickup checks (docs/SANE_0_2_0.md Sec 2).
 *
 * `sqlite` at `<repo>/.sane/sane.db` is the source of truth; markdown files are
 * renders. This module reads the DB plus workstream files to report status and
 * to run pickup precondition checks:
 * - `foundation_rev` declared precondition missing/superseded -> throw.
 * - Baseline revision recorded vs current (file presence + report revs).
 * - SDD/solutions `sane_hash` current vs approved (reported, never auto-revoked
 *   per Explicit Non-Goals; mismatches are warnings, not throws).
 *
 * New file only (M2 wiring P0); does not modify M1 validation.
 */
import type { Database } from "bun:sqlite"
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

import { sha256Hex } from "./sane-hash.ts"
import {
  bumpBaselineRevision,
  getApproval,
  getBaseline,
  getMerge,
  getWorkstream,
  listApprovals,
  listJobs,
  listResearchReports,
  listSelections,
  listStateEntries,
  normalizeWorkstreamId,
  type ApprovalRow,
  type BaselineRow,
  type JobRow,
  type MergeRow,
  type MutationContext,
  type ResearchReportRow,
  type SaneIdentity,
  type SelectionRow,
  type StateEntryRow,
  type WorkstreamRow,
} from "./sane-db.ts"

export class SaneWorkstreamStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneWorkstreamStateError"
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false
    throw error
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false
    throw error
  }
}

// ---------------------------------------------------------------------------
// getWorkstreamStatus
// ---------------------------------------------------------------------------

export interface WorkstreamStatusResult {
  repoRoot: string
  user: string
  workstreamId: string
  workstream: WorkstreamRow
  phases: StateEntryRow[]
  approvals: ApprovalRow[]
  jobs: JobRow[]
  baseline: BaselineRow | null
  merge: MergeRow | null
  selections: SelectionRow[]
  researchReports: ResearchReportRow[]
}

/**
 * Read the full DB status for one workstream identity.
 * Throws when no `workstreams` row exists for the identity.
 */
export function getWorkstreamStatus(db: Database, identity: SaneIdentity): WorkstreamStatusResult {
  const workstream = getWorkstream(db, identity)
  if (!workstream) {
    throw new SaneWorkstreamStateError(
      `No workstream row for repo_root=${JSON.stringify(identity.repoRoot)} user=${JSON.stringify(identity.user)} workstream_id=${JSON.stringify(identity.workstreamId)}.`,
    )
  }
  return {
    repoRoot: identity.repoRoot,
    user: identity.user,
    workstreamId: identity.workstreamId,
    workstream,
    phases: listStateEntries(db, identity),
    approvals: listApprovals(db, identity),
    jobs: listJobs(db, identity),
    baseline: getBaseline(db, identity),
    merge: getMerge(db, identity),
    selections: listSelections(db, identity),
    researchReports: listResearchReports(db, identity),
  }
}

// ---------------------------------------------------------------------------
// runPickupChecks
// ---------------------------------------------------------------------------

export type FoundationCheckStatus = "none" | "ok" | "missing" | "superseded"

export interface PickupFoundationCheck {
  rev: string | null
  referencedId: string | null
  declaredRev: string | null
  status: FoundationCheckStatus
}

export interface PickupBaselineCheck {
  recorded: BaselineRow | null
  baselinePath: string
  fileExists: boolean
  reportsChecked: number
  staleReports: Array<{ topic: string; baselineRev: number; recordedRev: number }>
}

export interface PickupFileHash {
  path: string
  relativePath: string
  fileExists: boolean
  currentHash: string | null
  approvedHash: string | null
  approvedPath: string | null
  match: boolean | null
}

export interface PickupCheckResult {
  repoRoot: string
  user: string
  workstreamId: string
  workstreamDir: string
  foundation: PickupFoundationCheck
  baseline: PickupBaselineCheck
  sdd: PickupFileHash
  solutions: PickupFileHash[]
  warnings: string[]
  ok: boolean
}

function parseFoundationRev(
  foundationRev: string,
): { referencedId: string; declaredRev: string } {
  const at = foundationRev.lastIndexOf("@")
  if (at <= 0 || at === foundationRev.length - 1) {
    throw new SaneWorkstreamStateError(
      `Invalid foundation_rev ${JSON.stringify(foundationRev)}. Expected "<workstream-id>@<revision>".`,
    )
  }
  const referencedId = foundationRev.slice(0, at)
  const declaredRev = foundationRev.slice(at + 1)
  // Re-validate the referenced id so traversal cannot bypass DB key checks.
  try {
    normalizeWorkstreamId(referencedId)
  } catch (error) {
    throw new SaneWorkstreamStateError(
      `Invalid foundation_rev ${JSON.stringify(foundationRev)}: ${(error as Error).message}`,
    )
  }
  if (!declaredRev.trim()) {
    throw new SaneWorkstreamStateError(
      `Invalid foundation_rev ${JSON.stringify(foundationRev)}. Expected "<workstream-id>@<revision>".`,
    )
  }
  return { referencedId, declaredRev }
}

async function hashExistingFile(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path)
    return sha256Hex(bytes)
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null
    throw error
  }
}

/**
 * Run pickup precondition checks for one workstream.
 *
 * - Foundation: when `workstreams.foundation_rev` is set, the referenced
 *   foundation workstream row must exist for the same `(repo_root, user)`
 *   (otherwise throw "missing"); when that foundation has a recorded
 *   `merges.merge_commit` differing from the declared revision, throw
 *   "superseded" until the user re-confirms. `NULL` means no precondition.
 * - Baseline: compares the recorded `baselines` revision/path against the
 *   workstream file and each `research_reports.baseline_rev` (warnings only).
 * - SDD/solutions: compares current file `sane_hash` values against the
 *   `approvals` rows for gates `root-plus-sdd`/`solutions` (warnings only;
 *   no auto-revoke per Explicit Non-Goals).
 *
 * Throws `SaneWorkstreamStateError` for missing workstream rows and for
 * foundation missing/superseded. All other divergences are returned as
 * `warnings` with `ok: false`.
 */
export async function runPickupChecks(
  db: Database,
  identity: SaneIdentity,
  workstreamDir: string,
): Promise<PickupCheckResult> {
  const workstream = getWorkstream(db, identity)
  if (!workstream) {
    throw new SaneWorkstreamStateError(
      `No workstream row for repo_root=${JSON.stringify(identity.repoRoot)} user=${JSON.stringify(identity.user)} workstream_id=${JSON.stringify(identity.workstreamId)}.`,
    )
  }
  const warnings: string[] = []

  // --- Foundation precondition (throwing) ---
  let foundation: PickupFoundationCheck
  if (workstream.foundation_rev === null || workstream.foundation_rev === undefined) {
    foundation = { rev: null, referencedId: null, declaredRev: null, status: "none" }
  } else {
    const { referencedId, declaredRev } = parseFoundationRev(workstream.foundation_rev)
    const referencedIdentity: SaneIdentity = {
      repoRoot: identity.repoRoot,
      user: identity.user,
      workstreamId: referencedId,
    }
    const referenced = getWorkstream(db, referencedIdentity)
    if (!referenced) {
      throw new SaneWorkstreamStateError(
        `foundation precondition missing: ${JSON.stringify(workstream.foundation_rev)} references unknown workstream ${JSON.stringify(referencedId)} for user ${JSON.stringify(identity.user)}.`,
      )
    }
    const foundationMerge = getMerge(db, referencedIdentity)
    if (
      foundationMerge?.merge_commit !== null &&
      foundationMerge?.merge_commit !== undefined &&
      foundationMerge.merge_commit !== declaredRev
    ) {
      throw new SaneWorkstreamStateError(
        `foundation precondition superseded: declared ${JSON.stringify(workstream.foundation_rev)} but foundation ${JSON.stringify(referencedId)} merge_commit is ${JSON.stringify(foundationMerge.merge_commit)}. Re-confirm foundation_rev.`,
      )
    }
    foundation = {
      rev: workstream.foundation_rev,
      referencedId,
      declaredRev,
      status: "ok",
    }
  }

  // --- Baseline recorded vs current (warnings) ---
  const recorded = getBaseline(db, identity)
  const baselinePath = recorded && !isAbsolute(recorded.path)
    ? join(workstreamDir, recorded.path)
    : (recorded ? recorded.path : join(workstreamDir, "research/BASELINE.md"))
  const baselineFileExists = await fileExists(baselinePath)
  if (recorded && !baselineFileExists) {
    warnings.push(
      `baseline revision r${recorded.revision} recorded but file missing: ${baselinePath}`,
    )
  }
  if (!recorded && baselineFileExists) {
    warnings.push(`baseline file exists but no revision recorded: ${baselinePath}`)
  }
  const reports = listResearchReports(db, identity)
  const staleReports: PickupBaselineCheck["staleReports"] = []
  if (recorded) {
    for (const report of reports) {
      if (report.baseline_rev !== recorded.revision) {
        staleReports.push({
          topic: report.topic,
          baselineRev: report.baseline_rev,
          recordedRev: recorded.revision,
        })
        warnings.push(
          `research report ${JSON.stringify(report.topic)} written against baseline r${report.baseline_rev} but current is r${recorded.revision}`,
        )
      }
    }
  } else if (reports.length > 0) {
    warnings.push(
      `no baseline recorded but ${reports.length} research report(s) exist; record a baseline revision first`,
    )
  }
  const baseline: PickupBaselineCheck = {
    recorded,
    baselinePath,
    fileExists: baselineFileExists,
    reportsChecked: reports.length,
    staleReports,
  }

  // --- SDD sane_hash (warnings) ---
  const sddPath = join(workstreamDir, "SDD.md")
  const sddExists = await fileExists(sddPath)
  const sddCurrentHash = sddExists ? await hashExistingFile(sddPath) : null
  const sddApproval = getApproval(db, identity, "root-plus-sdd")
  let sddMatch: boolean | null = null
  if (sddApproval && sddCurrentHash !== null) {
    sddMatch = sddCurrentHash === sddApproval.sane_hash
    if (!sddMatch) {
      warnings.push(
        `SDD.md hash ${sddCurrentHash.slice(0, 12)}… differs from approved ${sddApproval.sane_hash.slice(0, 12)}… (gate root-plus-sdd); re-approval required before Planning/Execution follows new direction`,
      )
    }
  } else if (!sddExists) {
    warnings.push(`SDD.md missing: ${sddPath}`)
  }
  const sdd: PickupFileHash = {
    path: sddPath,
    relativePath: "SDD.md",
    fileExists: sddExists,
    currentHash: sddCurrentHash,
    approvedHash: sddApproval?.sane_hash ?? null,
    approvedPath: sddApproval?.artifact_path ?? null,
    match: sddMatch,
  }

  // --- Solutions sane_hash (warnings) ---
  const solutionsDir = join(workstreamDir, "solutions")
  const solutionsApproval = getApproval(db, identity, "solutions")
  const solutions: PickupFileHash[] = []
  if (await dirExists(solutionsDir)) {
    let entries: string[] = []
    try {
      entries = (await readdir(solutionsDir)).filter((name) => name.endsWith(".md")).sort()
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    for (const name of entries) {
      const full = join(solutionsDir, name)
      if (!(await fileExists(full))) continue
      const currentHash = await hashExistingFile(full)
      let match: boolean | null = null
      if (solutionsApproval && currentHash !== null) {
        // Single-hash gate: any matching file satisfies; mismatch warns.
        // Multi-file exact mapping is future work.
        match = currentHash === solutionsApproval.sane_hash
      }
      solutions.push({
        path: full,
        relativePath: `solutions/${name}`,
        fileExists: true,
        currentHash,
        approvedHash: solutionsApproval?.sane_hash ?? null,
        approvedPath: solutionsApproval?.artifact_path ?? null,
        match,
      })
    }
  }
  if (solutionsApproval && solutions.length > 0) {
    const anyMatch = solutions.some((entry) => entry.match === true)
    if (!anyMatch) {
      warnings.push(
        `solutions hash differs from approved ${solutionsApproval.sane_hash.slice(0, 12)}… (gate solutions); re-approval required before Planning/Execution follows new direction`,
      )
      // Mark each as non-matching for clarity when a single gate hash exists.
      for (const entry of solutions) {
        if (entry.match === null) continue
        entry.match = false
      }
    }
  }
  if (solutions.length === 0) {
    warnings.push(`no solutions found in ${solutionsDir}`)
  }

  return {
    repoRoot: identity.repoRoot,
    user: identity.user,
    workstreamId: identity.workstreamId,
    workstreamDir,
    foundation,
    baseline,
    sdd,
    solutions,
    warnings,
    ok: warnings.length === 0,
  }
}

// ---------------------------------------------------------------------------
// M3-B baseline record/recheck + pickup/delivery revision checks
// (docs/SANE_0_2_0.md Sec 2: research support track owns research/BASELINE.md,
// `baselines.revision`, `research_reports` rows with no gates; pickup records
// consumed revisions; delivery rechecks and reconciles/reports instead of
// delivering stale; approved SDD/Specs remain authority; later research
// conflicts require a Design/Engineering update + re-approval).
//
// Additive only: existing getWorkstreamStatus/runPickupChecks are unchanged.
// ---------------------------------------------------------------------------

export const DEFAULT_BASELINE_PATH = "research/BASELINE.md"

function defaultBaselineMutation(): MutationContext {
  return {
    actorRole: "research",
    sessionId: "baseline-record",
    timestamp: new Date().toISOString(),
  }
}

function resolveBaselineFilePath(recorded: BaselineRow | null, workstreamDir: string): string {
  if (recorded && !isAbsolute(recorded.path)) return join(workstreamDir, recorded.path)
  if (recorded) return recorded.path
  return join(workstreamDir, DEFAULT_BASELINE_PATH)
}

export interface RecordBaselineRevisionInput {
  /** Baseline file path stored in the `baselines` row. Defaults to the existing row path or `research/BASELINE.md`. */
  path?: string
  mutation?: MutationContext
}

/**
 * Increment the support-track baseline revision by one and update the path.
 * First record yields revision 0; each subsequent call adds one.
 * Thin wrapper over `bumpBaselineRevision` with M3-B defaults.
 */
export function recordBaselineRevision(
  db: Database,
  identity: SaneIdentity,
  input?: RecordBaselineRevisionInput,
): BaselineRow {
  const existing = getBaseline(db, identity)
  const path = input?.path ?? existing?.path ?? DEFAULT_BASELINE_PATH
  if (!path || path.trim() === "") {
    throw new SaneWorkstreamStateError("Baseline path must be a non-empty string.")
  }
  return bumpBaselineRevision(db, identity, path, input?.mutation ?? defaultBaselineMutation())
}

export interface RecheckBaselineResult {
  recorded: BaselineRow | null
  baselinePath: string
  fileExists: boolean
  reportsChecked: number
  staleReports: Array<{ topic: string; baselineRev: number; recordedRev: number }>
  mismatches: string[]
  ok: boolean
}

/**
 * Compare the recorded `baselines` revision against the workstream file and
 * each `research_reports.baseline_rev`. Returns per-report mismatches;
 * never throws for stale content (throws only for missing workstream rows
 * via the underlying readers, which return null/empty when absent).
 */
export async function recheckBaseline(
  db: Database,
  identity: SaneIdentity,
  workstreamDir: string,
): Promise<RecheckBaselineResult> {
  const recorded = getBaseline(db, identity)
  const baselinePath = resolveBaselineFilePath(recorded, workstreamDir)
  const exists = await fileExists(baselinePath)
  const reports = listResearchReports(db, identity)
  const staleReports: RecheckBaselineResult["staleReports"] = []
  const mismatches: string[] = []
  if (recorded && !exists) {
    mismatches.push(
      `baseline revision r${recorded.revision} recorded but file missing: ${baselinePath}`,
    )
  }
  if (!recorded && exists) {
    mismatches.push(`baseline file exists but no revision recorded: ${baselinePath}`)
  }
  if (recorded) {
    for (const report of reports) {
      if (report.baseline_rev !== recorded.revision) {
        staleReports.push({
          topic: report.topic,
          baselineRev: report.baseline_rev,
          recordedRev: recorded.revision,
        })
        mismatches.push(
          `research report ${JSON.stringify(report.topic)} written against baseline r${report.baseline_rev} but current is r${recorded.revision}`,
        )
      }
    }
  } else if (reports.length > 0) {
    mismatches.push(
      `no baseline recorded but ${reports.length} research report(s) exist; record a baseline revision first`,
    )
  }
  return {
    recorded,
    baselinePath,
    fileExists: exists,
    reportsChecked: reports.length,
    staleReports,
    mismatches,
    ok: mismatches.length === 0,
  }
}

export interface PickupRevisionSnapshotReport {
  topic: string
  baselineRev: number
  path: string
}

/**
 * Point-in-time snapshot of every revision consumed at pickup.
 * JSON-serializable so it can persist to a sidecar file; when a future
 * `pickup_revisions` DB table exists an integrator may store it there,
 * otherwise callers keep the returned object.
 */
export interface PickupRevisionSnapshot {
  repoRoot: string
  user: string
  workstreamId: string
  recordedAt: string
  baselineRev: number | null
  baselinePath: string | null
  sddHash: string | null
  sddApprovedHash: string | null
  solutionHashes: Record<string, string | null>
  solutionsApprovedHash: string | null
  foundationRev: string | null
  foundationMergeCommit: string | null
  approvalHashes: Record<string, string>
  reports: PickupRevisionSnapshotReport[]
}

export interface RecordPickupRevisionsOptions {
  /**
   * When set, the snapshot JSON is written atomically to this path
   * (parent directories are created). When null/undefined, no file is
   * written and the snapshot is only returned.
   */
  sidecarPath?: string | null
  recordedAt?: string
}

async function collectSolutionHashes(
  workstreamDir: string,
): Promise<Record<string, string | null>> {
  const solutionsDir = join(workstreamDir, "solutions")
  const hashes: Record<string, string | null> = {}
  if (!(await dirExists(solutionsDir))) return hashes
  let entries: string[] = []
  try {
    entries = (await readdir(solutionsDir)).filter((name) => name.endsWith(".md")).sort()
  } catch (error) {
    if (errorCode(error) === "ENOENT") return hashes
    throw error
  }
  for (const name of entries) {
    const full = join(solutionsDir, name)
    if (!(await fileExists(full))) continue
    hashes[`solutions/${name}`] = await hashExistingFile(full)
  }
  return hashes
}

function readFoundationMergeCommit(
  db: Database,
  identity: SaneIdentity,
  foundationRev: string | null,
): string | null {
  if (foundationRev === null) return null
  const at = foundationRev.lastIndexOf("@")
  if (at <= 0 || at === foundationRev.length - 1) return null
  const referencedId = foundationRev.slice(0, at)
  let normalized: string
  try {
    normalized = normalizeWorkstreamId(referencedId)
  } catch {
    return null
  }
  const referencedIdentity: SaneIdentity = {
    repoRoot: identity.repoRoot,
    user: identity.user,
    workstreamId: normalized,
  }
  try {
    return getMerge(db, referencedIdentity)?.merge_commit ?? null
  } catch {
    return null
  }
}

/**
 * Snapshot baseline rev + SDD hash + solution hashes + `foundation_rev`
 * (+ foundation merge commit) + approval hashes + research reports.
 *
 * Persistence: when `options.sidecarPath` is set, the snapshot is written as
 * formatted JSON to that sidecar file. A future `pickup_revisions` DB table
 * may hold the same payload (checked best-effort via `sqlite_master`; no
 * such table exists in the M3-B schema, which is intentionally unchanged).
 * Otherwise the snapshot is only returned.
 */
export async function recordPickupRevisions(
  db: Database,
  identity: SaneIdentity,
  workstreamDir: string,
  options?: RecordPickupRevisionsOptions,
): Promise<PickupRevisionSnapshot> {
  const workstream = getWorkstream(db, identity)
  if (!workstream) {
    throw new SaneWorkstreamStateError(
      `No workstream row for repo_root=${JSON.stringify(identity.repoRoot)} user=${JSON.stringify(identity.user)} workstream_id=${JSON.stringify(identity.workstreamId)}.`,
    )
  }
  const baseline = getBaseline(db, identity)
  const sddHash = await hashExistingFile(join(workstreamDir, "SDD.md"))
  const solutionHashes = await collectSolutionHashes(workstreamDir)
  const approvals = listApprovals(db, identity)
  const approvalHashes: Record<string, string> = {}
  for (const approval of approvals) approvalHashes[approval.gate] = approval.sane_hash
  const reports = listResearchReports(db, identity).map((report) => ({
    topic: report.topic,
    baselineRev: report.baseline_rev,
    path: report.path,
  }))
  const foundationRev = workstream.foundation_rev ?? null
  const snapshot: PickupRevisionSnapshot = {
    repoRoot: identity.repoRoot,
    user: identity.user,
    workstreamId: identity.workstreamId,
    recordedAt: options?.recordedAt ?? new Date().toISOString(),
    baselineRev: baseline?.revision ?? null,
    baselinePath: baseline?.path ?? null,
    sddHash,
    sddApprovedHash: approvalHashes["root-plus-sdd"] ?? null,
    solutionHashes,
    solutionsApprovedHash: approvalHashes["solutions"] ?? null,
    foundationRev,
    foundationMergeCommit: readFoundationMergeCommit(db, identity, foundationRev),
    approvalHashes,
    reports,
  }
  // Best-effort note: a `pickup_revisions`/`pickup_snapshots` table does not
  // exist in the M3-B schema (sane-db.ts is untouched); when a future schema
  // adds one, persist there. For now the JSON sidecar is the durable form.
  try {
    db.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pickup_revisions','pickup_snapshots')`,
    ).all() as Array<{ name: string }>
  } catch {
    // Read-only probe; ignore failures.
  }
  if (options?.sidecarPath !== undefined && options.sidecarPath !== null) {
    const sidecarPath = options.sidecarPath
    if (!sidecarPath || sidecarPath.trim() === "") {
      throw new SaneWorkstreamStateError("Pickup sidecar path must be non-empty when provided.")
    }
    await mkdir(dirname(sidecarPath), { recursive: true })
    await writeFile(sidecarPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
  }
  return snapshot
}

export type DeliveryMismatchKind =
  | "baseline"
  | "sdd"
  | "solutions"
  | "foundation"
  | "research"
  | "approvals"

export interface DeliveryMismatch {
  kind: DeliveryMismatchKind
  message: string
}

export interface DeliveryFreshnessResult {
  ok: boolean
  mismatches: DeliveryMismatch[]
  snapshot: PickupRevisionSnapshot
  current: PickupRevisionSnapshot
}

export interface VerifyDeliveryFreshnessOptions {
  /** When false, return mismatches instead of throwing. Defaults to true. */
  throwOnMismatch?: boolean
}

function normalizeSnapshotInput(snapshot: PickupRevisionSnapshot): PickupRevisionSnapshot {
  return {
    repoRoot: snapshot.repoRoot,
    user: snapshot.user,
    workstreamId: snapshot.workstreamId,
    recordedAt: snapshot.recordedAt,
    baselineRev: snapshot.baselineRev ?? null,
    baselinePath: snapshot.baselinePath ?? null,
    sddHash: snapshot.sddHash ?? null,
    sddApprovedHash: snapshot.sddApprovedHash ?? null,
    solutionHashes: snapshot.solutionHashes ?? {},
    solutionsApprovedHash: snapshot.solutionsApprovedHash ?? null,
    foundationRev: snapshot.foundationRev ?? null,
    foundationMergeCommit: snapshot.foundationMergeCommit ?? null,
    approvalHashes: snapshot.approvalHashes ?? {},
    reports: Array.isArray(snapshot.reports) ? snapshot.reports : [],
  }
}

/**
 * Re-read current revisions and compare against a pickup snapshot.
 * On any mismatch, report/reconcile guidance is returned (and, by default,
 * thrown as `SaneWorkstreamStateError`) instead of silently delivering
 * stale inputs. Approved SDD/Specs remain authority; later research
 * conflicts require a Design/Engineering update + re-approval.
 */
export async function verifyDeliveryFreshness(
  db: Database,
  identity: SaneIdentity,
  workstreamDir: string,
  snapshotOrPath: PickupRevisionSnapshot | string,
  options?: VerifyDeliveryFreshnessOptions,
): Promise<DeliveryFreshnessResult> {
  let rawSnapshot: PickupRevisionSnapshot
  if (typeof snapshotOrPath === "string") {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(snapshotOrPath, "utf8"))
    } catch (error) {
      throw new SaneWorkstreamStateError(
        `Could not read pickup snapshot at ${snapshotOrPath}: ${(error as Error).message}`,
      )
    }
    rawSnapshot = parsed as PickupRevisionSnapshot
  } else {
    rawSnapshot = snapshotOrPath
  }
  const snapshot = normalizeSnapshotInput(rawSnapshot)
  const current = await recordPickupRevisions(db, identity, workstreamDir)
  const mismatches: DeliveryMismatch[] = []

  if (snapshot.baselineRev !== current.baselineRev) {
    mismatches.push({
      kind: "baseline",
      message: `baseline revision changed since pickup: pickup r${String(snapshot.baselineRev)} vs current r${String(current.baselineRev)}. Reconcile research against the current baseline instead of delivering stale.`,
    })
  }
  if ((snapshot.baselinePath ?? null) !== (current.baselinePath ?? null)) {
    mismatches.push({
      kind: "baseline",
      message: `baseline path changed since pickup: ${JSON.stringify(snapshot.baselinePath)} vs ${JSON.stringify(current.baselinePath)}.`,
    })
  }

  if ((snapshot.sddHash ?? null) !== (current.sddHash ?? null)) {
    mismatches.push({
      kind: "sdd",
      message: `SDD.md hash changed since pickup: pickup ${snapshot.sddHash ?? "(missing)"} vs current ${current.sddHash ?? "(missing)"}. Approved SDD remains authority; reconcile or report instead of delivering stale.`,
    })
  }

  {
    const keys = new Set([
      ...Object.keys(snapshot.solutionHashes),
      ...Object.keys(current.solutionHashes),
    ])
    for (const key of [...keys].sort()) {
      const before = snapshot.solutionHashes[key] ?? null
      const after = current.solutionHashes[key] ?? null
      if (before !== after) {
        mismatches.push({
          kind: "solutions",
          message: `solution ${JSON.stringify(key)} hash changed since pickup: pickup ${before ?? "(missing)"} vs current ${after ?? "(missing)"}. Approved Specs remain authority; reconcile or report instead of delivering stale.`,
        })
      }
    }
  }

  if ((snapshot.foundationRev ?? null) !== (current.foundationRev ?? null)) {
    mismatches.push({
      kind: "foundation",
      message: `foundation_rev changed since pickup: pickup ${JSON.stringify(snapshot.foundationRev)} vs current ${JSON.stringify(current.foundationRev)}. Re-confirm the foundation precondition.`,
    })
  }
  if ((snapshot.foundationMergeCommit ?? null) !== (current.foundationMergeCommit ?? null)) {
    mismatches.push({
      kind: "foundation",
      message: `foundation superseded since pickup: pickup merge_commit ${JSON.stringify(snapshot.foundationMergeCommit)} vs current ${JSON.stringify(current.foundationMergeCommit)} for ${JSON.stringify(current.foundationRev)}. Re-confirm foundation_rev before delivery.`,
    })
  }

  {
    const beforeByTopic = new Map(snapshot.reports.map((report) => [report.topic, report]))
    const afterByTopic = new Map(current.reports.map((report) => [report.topic, report]))
    for (const [topic, after] of [...afterByTopic.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const before = beforeByTopic.get(topic)
      if (!before) {
        mismatches.push({
          kind: "research",
          message: `new research report ${JSON.stringify(topic)} (baseline r${after.baselineRev}) appeared since pickup. Reconcile the conflict instead of delivering stale; later research conflicts require a Design/Engineering update + re-approval.`,
        })
        continue
      }
      if (before.baselineRev !== after.baselineRev) {
        mismatches.push({
          kind: "research",
          message: `research report ${JSON.stringify(topic)} baseline_rev changed since pickup: pickup r${before.baselineRev} vs current r${after.baselineRev}. Reconcile instead of delivering stale.`,
        })
      }
      if (before.path !== after.path) {
        mismatches.push({
          kind: "research",
          message: `research report ${JSON.stringify(topic)} path changed since pickup: ${JSON.stringify(before.path)} vs ${JSON.stringify(after.path)}.`,
        })
      }
    }
    for (const [topic] of [...beforeByTopic.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (!afterByTopic.has(topic)) {
        mismatches.push({
          kind: "research",
          message: `research report ${JSON.stringify(topic)} present at pickup is missing now. Reconcile instead of delivering stale.`,
        })
      }
    }
    // Any current report stale against the current baseline is a conflict,
    // even when the snapshot itself was taken while stale.
    if (current.baselineRev !== null) {
      for (const report of [...current.reports].sort((a, b) =>
        a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0,
      )) {
        if (report.baselineRev !== current.baselineRev) {
          const alreadyReported = mismatches.some(
            (entry) =>
              entry.kind === "research" &&
              entry.message.includes(JSON.stringify(report.topic)) &&
              entry.message.includes(`r${report.baselineRev}`),
          )
          if (!alreadyReported) {
            mismatches.push({
              kind: "research",
              message: `research report ${JSON.stringify(report.topic)} written against baseline r${report.baselineRev} but current is r${current.baselineRev} (stale/conflicting). Design/Engineering update + re-approval required before Planning/Execution follows the new direction.`,
            })
          }
        }
      }
    }
  }

  {
    const gates = new Set([
      ...Object.keys(snapshot.approvalHashes),
      ...Object.keys(current.approvalHashes),
    ])
    for (const gate of [...gates].sort()) {
      const before = snapshot.approvalHashes[gate] ?? null
      const after = current.approvalHashes[gate] ?? null
      if (before !== after) {
        mismatches.push({
          kind: "approvals",
          message: `approval ${JSON.stringify(gate)} hash changed since pickup: pickup ${before ?? "(missing)"} vs current ${after ?? "(missing)"}. Approved artifacts remain authority; re-approval required before following the new direction.`,
        })
      }
    }
  }

  const ok = mismatches.length === 0
  if (!ok && options?.throwOnMismatch !== false) {
    throw new SaneWorkstreamStateError(
      `Delivery blocked: ${mismatches.length} freshness mismatch(s) since pickup; reconcile or report instead of delivering stale:\n${mismatches.map((entry) => `- [${entry.kind}] ${entry.message}`).join("\n")}`,
    )
  }
  return { ok, mismatches, snapshot, current }
}
