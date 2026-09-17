/**
 * SANE workstream status + pickup checks (docs/SANE_0_2_0.md Sec 2).
 *
 * `sqlite` at `<repo>/.sane/sane.db` is the source of truth; markdown files are
 * renders. This module reads the DB plus workstream files to report status and
 * to run pickup precondition checks:
 * - Research index: registered reports present and unmodified, unregistered
 *   report files surfaced (warnings only).
 * - design/SDD.md + design/solutions `sane_hash` current vs approved (reported,
 *   never auto-revoked per Explicit Non-Goals; mismatches are warnings, not throws).
 */
import type { Database } from "bun:sqlite"
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"

import { sha256Hex } from "./sane-hash.ts"
import {
  getApproval,
  getMerge,
  getWorkstream,
  listApprovals,
  listJobs,
  listResearchReports,
  listSelections,
  listStateEntries,
  type ApprovalRow,
  type JobRow,
  type MergeRow,
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
    merge: getMerge(db, identity),
    selections: listSelections(db, identity),
    researchReports: listResearchReports(db, identity),
  }
}

// ---------------------------------------------------------------------------
// runPickupChecks
// ---------------------------------------------------------------------------

export interface PickupResearchCheck {
  reports: IndexedResearchReport[]
  unregisteredFiles: string[]
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
  research: PickupResearchCheck
  sdd: PickupFileHash
  solutions: PickupFileHash[]
  warnings: string[]
  ok: boolean
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
 * - Research index: registered reports present and unmodified, unregistered
 *   report files surfaced (warnings only).
 * - SDD/solutions: compares current file `sane_hash` values against the
 *   `approvals` rows for gates `root-plus-sdd`/`solutions` (warnings only;
 *   no auto-revoke per Explicit Non-Goals).
 *
 * Throws `SaneWorkstreamStateError` for missing workstream rows.
 * All other divergences are returned as `warnings` with `ok: false`.
 */
export async function runPickupChecks(
  db: Database,
  identity: SaneIdentity,
  workstreamDir: string,
): Promise<PickupCheckResult> {
  if (!getWorkstream(db, identity)) {
    throw new SaneWorkstreamStateError(
      `No workstream row for repo_root=${JSON.stringify(identity.repoRoot)} user=${JSON.stringify(identity.user)} workstream_id=${JSON.stringify(identity.workstreamId)}.`,
    )
  }
  const warnings: string[] = []

  // --- Research index (warnings) ---
  const researchIndex = await recheckResearchIndex(db, identity, workstreamDir)
  for (const mismatch of researchIndex.mismatches) warnings.push(mismatch)
  const research: PickupResearchCheck = {
    reports: researchIndex.reports,
    unregisteredFiles: researchIndex.unregisteredFiles,
  }

  // --- SDD sane_hash (warnings) ---
  const sddPath = join(workstreamDir, "design", "SDD.md")
  const sddExists = await fileExists(sddPath)
  const sddCurrentHash = sddExists ? await hashExistingFile(sddPath) : null
  const sddApproval = getApproval(db, identity, "design")
  let sddMatch: boolean | null = null
  if (sddApproval && sddCurrentHash !== null) {
    sddMatch = sddCurrentHash === sddApproval.sane_hash
    if (!sddMatch) {
      warnings.push(
        `design/SDD.md hash ${sddCurrentHash.slice(0, 12)}… differs from approved ${sddApproval.sane_hash.slice(0, 12)}… (phase design); re-approval required before Planning/Execution follows new direction`,
      )
    }
  } else if (!sddExists) {
    warnings.push(`design/SDD.md missing: ${sddPath}`)
  }
  const sdd: PickupFileHash = {
    path: sddPath,
    relativePath: "design/SDD.md",
    fileExists: sddExists,
    currentHash: sddCurrentHash,
    approvedHash: sddApproval?.sane_hash ?? null,
    approvedPath: sddApproval?.artifact_path ?? null,
    match: sddMatch,
  }

  // --- Solutions sane_hash (warnings) ---
  const solutionsDir = join(workstreamDir, "design", "solutions")
  const solutionsApproval = getApproval(db, identity, "engineering")
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
        relativePath: `design/solutions/${name}`,
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
        `solutions hash differs from approved ${solutionsApproval.sane_hash.slice(0, 12)}… (phase engineering); re-approval required before Planning/Execution follows new direction`,
      )
      // Mark each as non-matching for clarity when a single phase hash exists.
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
    research,
    sdd,
    solutions,
    warnings,
    ok: warnings.length === 0,
  }
}

// ---------------------------------------------------------------------------
// M3-B research index check + pickup/delivery revision checks
// (docs/SANE_0_2_0.md Sec 2: research is an append-only archive of
// `research/<topic>/REPORT.md` rows in `research_reports`; no gates. Pickup
// records consumed report hashes; delivery rechecks and reconciles/reports
// instead of delivering stale; approved SDD/Specs remain authority; later
// research conflicts require a Design/Engineering update + re-approval).
//
// Additive only: existing getWorkstreamStatus/runPickupChecks are unchanged.
// ---------------------------------------------------------------------------

export interface IndexedResearchReport {
  topic: string
  path: string
  registeredHash: string
  currentHash: string | null
  fileExists: boolean
}

export interface RecheckResearchIndexResult {
  reports: IndexedResearchReport[]
  unregisteredFiles: string[]
  mismatches: string[]
  ok: boolean
}

/** List `research/<topic>/REPORT.md` files present on disk (workstream-relative). */
export async function listUnregisteredReportFiles(
  db: Database,
  identity: SaneIdentity,
  workstreamDir: string,
): Promise<string[]> {
  const registered = new Set(listResearchReports(db, identity).map((report) => report.path))
  const researchDir = join(workstreamDir, "research")
  let topics: string[] = []
  try {
    topics = (await readdir(researchDir)).sort()
  } catch (error) {
    if (errorCode(error) === "ENOENT") return []
    throw error
  }
  const unregistered: string[] = []
  for (const topic of topics) {
    const relative = `research/${topic}/REPORT.md`
    if (registered.has(relative)) continue
    if (await fileExists(join(workstreamDir, relative))) unregistered.push(relative)
  }
  return unregistered
}

/**
 * Compare the registered `research_reports` rows against workstream files.
 * Reports are append-only: a registered file that changed hash was edited
 * after registration, and an on-disk report with no row was never registered.
 * Returns mismatches; never throws for stale content.
 */
export async function recheckResearchIndex(
  db: Database,
  identity: SaneIdentity,
  workstreamDir: string,
): Promise<RecheckResearchIndexResult> {
  const reports: IndexedResearchReport[] = []
  const mismatches: string[] = []
  for (const report of listResearchReports(db, identity)) {
    const absolute = !isAbsolute(report.path) ? join(workstreamDir, report.path) : report.path
    const exists = await fileExists(absolute)
    const currentHash = exists ? await hashExistingFile(absolute) : null
    reports.push({
      topic: report.topic,
      path: report.path,
      registeredHash: report.sane_hash,
      currentHash,
      fileExists: exists,
    })
    if (!exists) {
      mismatches.push(`registered research report ${JSON.stringify(report.topic)} missing file: ${report.path}`)
    } else if (report.sane_hash && currentHash !== report.sane_hash) {
      mismatches.push(
        `research report ${JSON.stringify(report.topic)} edited after registration (registered ${report.sane_hash.slice(0, 12)}… vs current ${currentHash?.slice(0, 12) ?? "(missing)"}…). Research is append-only: register a new topic instead of updating ${report.path}`,
      )
    }
  }
  const unregisteredFiles = await listUnregisteredReportFiles(db, identity, workstreamDir)
  for (const relative of unregisteredFiles) {
    mismatches.push(
      `research report file ${relative} is not registered; run research --register to index it`,
    )
  }
  return { reports, unregisteredFiles, mismatches, ok: mismatches.length === 0 }
}

export interface PickupRevisionSnapshotReport {
  topic: string
  path: string
  registeredHash: string
  currentHash: string | null
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
  sddHash: string | null
  sddApprovedHash: string | null
  solutionHashes: Record<string, string | null>
  solutionsApprovedHash: string | null
  approvalHashes: Record<string, string>
  reports: PickupRevisionSnapshotReport[]
  unregisteredFiles: string[]
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
  const solutionsDir = join(workstreamDir, "design", "solutions")
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
    hashes[`design/solutions/${name}`] = await hashExistingFile(full)
  }
  return hashes
}

/**
 * Snapshot SDD hash + solution hashes + approval hashes + research report
 * hashes.
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
  if (!getWorkstream(db, identity)) {
    throw new SaneWorkstreamStateError(
      `No workstream row for repo_root=${JSON.stringify(identity.repoRoot)} user=${JSON.stringify(identity.user)} workstream_id=${JSON.stringify(identity.workstreamId)}.`,
    )
  }
  const sddHash = await hashExistingFile(join(workstreamDir, "design", "SDD.md"))
  const solutionHashes = await collectSolutionHashes(workstreamDir)
  const approvals = listApprovals(db, identity)
  const approvalHashes: Record<string, string> = {}
  for (const approval of approvals) approvalHashes[approval.phase] = approval.sane_hash
  const researchIndex = await recheckResearchIndex(db, identity, workstreamDir)
  const reports = researchIndex.reports.map((report) => ({
    topic: report.topic,
    registeredHash: report.registeredHash,
    currentHash: report.currentHash,
    path: report.path,
  }))
  const snapshot: PickupRevisionSnapshot = {
    repoRoot: identity.repoRoot,
    user: identity.user,
    workstreamId: identity.workstreamId,
    recordedAt: options?.recordedAt ?? new Date().toISOString(),
    sddHash,
    sddApprovedHash: approvalHashes["design"] ?? null,
    solutionHashes,
    solutionsApprovedHash: approvalHashes["engineering"] ?? null,
    approvalHashes,
    reports,
    unregisteredFiles: researchIndex.unregisteredFiles,
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
  | "sdd"
  | "solutions"
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
    sddHash: snapshot.sddHash ?? null,
    sddApprovedHash: snapshot.sddApprovedHash ?? null,
    solutionHashes: snapshot.solutionHashes ?? {},
    solutionsApprovedHash: snapshot.solutionsApprovedHash ?? null,
    approvalHashes: snapshot.approvalHashes ?? {},
    reports: Array.isArray(snapshot.reports)
      ? snapshot.reports.map((report) => ({
        topic: report.topic,
        path: report.path,
        registeredHash: report.registeredHash ?? "",
        currentHash: report.currentHash ?? null,
      }))
      : [],
    unregisteredFiles: Array.isArray(snapshot.unregisteredFiles) ? snapshot.unregisteredFiles : [],
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

  if ((snapshot.sddHash ?? null) !== (current.sddHash ?? null)) {
    mismatches.push({
      kind: "sdd",
      message: `design/SDD.md hash changed since pickup: pickup ${snapshot.sddHash ?? "(missing)"} vs current ${current.sddHash ?? "(missing)"}. Approved SDD remains authority; reconcile or report instead of delivering stale.`,
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
          message: `new research report ${JSON.stringify(topic)} appeared since pickup. Reconcile the conflict instead of delivering stale; later research conflicts require a Design/Engineering update + re-approval.`,
        })
        continue
      }
      if (before.registeredHash !== after.registeredHash) {
        mismatches.push({
          kind: "research",
          message: `research report ${JSON.stringify(topic)} re-registered since pickup: pickup ${before.registeredHash.slice(0, 12)}… vs current ${after.registeredHash.slice(0, 12)}…. Reconcile instead of delivering stale.`,
        })
      }
      if ((before.currentHash ?? null) !== (after.currentHash ?? null)) {
        mismatches.push({
          kind: "research",
          message: `research report ${JSON.stringify(topic)} file changed since pickup: pickup ${before.currentHash?.slice(0, 12) ?? "(missing)"} vs current ${after.currentHash?.slice(0, 12) ?? "(missing)"}. Research is append-only; reconcile instead of delivering stale.`,
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
    // Any current report edited after registration is a conflict,
    // even when the snapshot itself was taken while stale.
    for (const report of [...current.reports].sort((a, b) =>
      a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0,
    )) {
      if (report.registeredHash && report.currentHash !== report.registeredHash) {
        const alreadyReported = mismatches.some(
          (entry) =>
            entry.kind === "research" &&
            entry.message.includes(JSON.stringify(report.topic)) &&
            entry.message.includes("since pickup"),
        )
        if (!alreadyReported) {
          mismatches.push({
            kind: "research",
            message: `research report ${JSON.stringify(report.topic)} edited after registration (registered ${report.registeredHash.slice(0, 12)}… vs current ${report.currentHash?.slice(0, 12) ?? "(missing)"}…). Research is append-only: register a new topic instead of updating ${report.path}.`,
          })
        }
      }
    }
    const beforeUnregistered = new Set(snapshot.unregisteredFiles)
    for (const relative of [...current.unregisteredFiles].sort()) {
      if (!beforeUnregistered.has(relative)) {
        mismatches.push({
          kind: "research",
          message: `new unregistered research file ${relative} appeared since pickup. Register it or reconcile instead of delivering stale.`,
        })
      }
    }
  }

  {
    const phases = new Set([
      ...Object.keys(snapshot.approvalHashes),
      ...Object.keys(current.approvalHashes),
    ])
    for (const phase of [...phases].sort()) {
      const before = snapshot.approvalHashes[phase] ?? null
      const after = current.approvalHashes[phase] ?? null
      if (before !== after) {
        mismatches.push({
          kind: "approvals",
          message: `approval ${JSON.stringify(phase)} hash changed since pickup: pickup ${before ?? "(missing)"} vs current ${after ?? "(missing)"}. Approved artifacts remain authority; re-approval required before following the new direction.`,
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
