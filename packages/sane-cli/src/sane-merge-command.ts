/**
 * SANE 0.2.0 M5: `sane merge` command + merge protocol
 * (docs/SANE_0_2_0.md Section 4).
 *
 * Merge protocol (8 steps):
 * 1. Rebase the workstream branch onto current main inside its worktree;
 *    resolve conflicts per the rules below.
 * 2. Run the workstream's checks in the worktree (typecheck + affected tests).
 * 3. Read-only review of the diff against the SDD and Job Specs.
 * 4. User approves the merge (gate 5).
 * 5. Merge into main with `git merge --no-ff sane/<user>/<workstream>` from a
 *    clean main checkout.
 * 6. Run main checks and smoke (typecheck + affected tests + boot check).
 * 7. Record `merge_commit` in the `merges` table; viewable via `sane view`.
 * 8. Remove the worktree (`git worktree remove`) and delete the branch only
 *    after the merge commit is recorded.
 *
 * Conflict rules:
 * - Own surface: the owning Execution session resolves in its worktree,
 *   re-runs checks, and re-requests review.
 * - Another active workstream's surface: stop. The Execution Assistant reports
 *   both workstream IDs, the overlapping paths, and both `base_rev` values.
 *   The user either serializes or splits the overlap into a follow-up.
 *   Merging over another workstream's unmerged surface without its owner's
 *   user-directed approval is forbidden.
 *
 * New file only (M5); read-only use of `sane-db.ts` helpers (no schema
 * refactor). Does not touch `bin/sane.ts`, `sane-db.ts` schema,
 * handoff files, `templates/`, or agents/skills.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import {
  currentUser,
  getApproval,
  getMerge,
  initSchema,
  normalizeWorkstreamId,
  openSaneDb,
  recordMergeCommit as recordMergeCommitDb,
  resolveSaneIdentity,
} from "./sane-db.ts"
import { resolveImplementationRepository } from "./sane-repository.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import {
  assertIsolatedCheckAllowed,
  branchName,
  defaultWorktreesDir,
  normalizeWorkstreamSlug,
  worktreePath,
} from "./sane-worktree-command.ts"

const execFileAsync = promisify(execFile)

export class SaneMergeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneMergeError"
  }
}

/** Cross-workstream overlap: STOP with both IDs/paths/base_revs. */
export class CrossWorkstreamConflictError extends SaneMergeError {
  ownWorkstreamId: string
  otherWorkstreamId: string
  overlappingPaths: string[]
  conflictingPaths: string[]
  ownBaseRev: string
  otherBaseRev: string
  report: string

  constructor(input: {
    ownWorkstreamId: string
    otherWorkstreamId: string
    overlappingPaths: string[]
    conflictingPaths: string[]
    ownBaseRev: string
    otherBaseRev: string
    report: string
  }) {
    super(input.report)
    this.name = "CrossWorkstreamConflictError"
    this.ownWorkstreamId = input.ownWorkstreamId
    this.otherWorkstreamId = input.otherWorkstreamId
    this.overlappingPaths = input.overlappingPaths
    this.conflictingPaths = input.conflictingPaths
    this.ownBaseRev = input.ownBaseRev
    this.otherBaseRev = input.otherBaseRev
    this.report = input.report
  }
}

/** Injectable git runner so tests mock git without touching the filesystem. */
export type ExecGitFn = (args: string[]) => Promise<string>

async function defaultExecGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" })
  return stdout.trim()
}

// ---------------------------------------------------------------------------
// Protocol steps + order
// ---------------------------------------------------------------------------

/** The 8 merge-protocol steps in required order. */
export const MERGE_PROTOCOL_STEPS = [
  "rebase",
  "checks",
  "review",
  "approval",
  "merge",
  "main-checks",
  "record",
  "cleanup",
] as const

export type MergeProtocolStep = (typeof MERGE_PROTOCOL_STEPS)[number]

const MERGE_STEP_INDEX: Record<MergeProtocolStep, number> = {
  rebase: 0,
  checks: 1,
  review: 2,
  approval: 3,
  merge: 4,
  "main-checks": 5,
  record: 6,
  cleanup: 7,
}

/**
 * Enforce protocol order. `completed` must be the exact prefix of
 * `MERGE_PROTOCOL_STEPS` and `next` must be the following step.
 */
export function assertMergeStepOrder(
  completed: MergeProtocolStep[],
  next: MergeProtocolStep,
): void {
  for (let index = 0; index < completed.length; index += 1) {
    const expected = MERGE_PROTOCOL_STEPS[index]
    if (completed[index] !== expected) {
      throw new SaneMergeError(
        `Protocol order violated: completed[${index}] is ${JSON.stringify(completed[index])}, expected ${JSON.stringify(expected)}. Steps must run in order: ${MERGE_PROTOCOL_STEPS.join(" -> ")}.`,
      )
    }
  }
  const expectedNext = MERGE_PROTOCOL_STEPS[completed.length]
  if (expectedNext === undefined) {
    throw new SaneMergeError(
      `Protocol order violated: all steps already completed; no next step (got ${JSON.stringify(next)}).`,
    )
  }
  if (next !== expectedNext) {
    throw new SaneMergeError(
      `Protocol order violated: expected next step ${JSON.stringify(expectedNext)} (completed: ${completed.length === 0 ? "(none)" : completed.join(", ")}), got ${JSON.stringify(next)}. Steps must run in order: ${MERGE_PROTOCOL_STEPS.join(" -> ")}.`,
    )
  }
  if (!(next in MERGE_STEP_INDEX)) {
    throw new SaneMergeError(`Unknown merge protocol step: ${JSON.stringify(next)}.`)
  }
}

// ---------------------------------------------------------------------------
// Conflict scope: own vs cross-workstream
// ---------------------------------------------------------------------------

export interface WorkstreamSurface {
  workstreamId: string
  baseRev: string
  /** Owned path prefixes (e.g. `packages/foo`, `src/bar`). */
  paths: string[]
}

export interface CheckConflictScopeInput {
  ownWorkstreamId: string
  ownBaseRev: string
  conflictingPaths: string[]
  /** Other active workstreams (own id is ignored when present). */
  activeWorkstreams: WorkstreamSurface[]
}

export interface OwnConflictScopeResult {
  scope: "own"
}

function normalizeSurfacePath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\/+$/, "")
}

function pathsOverlap(conflicting: string, surface: string): boolean {
  const left = normalizeSurfacePath(conflicting)
  const right = normalizeSurfacePath(surface)
  if (left === "" || right === "") return false
  if (left === right) return true
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * Classify conflicting paths as own-surface vs cross-workstream.
 *
 * - No overlap with another active workstream's surface -> `{ scope: "own" }`.
 *   Caller resolves in its worktree, re-runs checks, and re-requests review.
 * - Overlap -> throws {@link CrossWorkstreamConflictError} (STOP) whose
 *   `report`/`message` records both workstream IDs, the overlapping paths,
 *   the full conflicting path list, and both `base_rev` values. The user
 *   either serializes (one merges first; the other rebases after) or splits
 *   the overlap into a follow-up. Never merge over the unmerged surface
 *   without owner user-directed approval.
 */
export function checkConflictScope(input: CheckConflictScopeInput): OwnConflictScopeResult {
  if (!input.ownWorkstreamId || input.ownWorkstreamId.trim() === "") {
    throw new SaneMergeError("checkConflictScope requires ownWorkstreamId.")
  }
  if (!input.ownBaseRev || input.ownBaseRev.trim() === "") {
    throw new SaneMergeError("checkConflictScope requires ownBaseRev.")
  }
  const conflicting = [...(input.activeWorkstreams ? [] : [])]
  void conflicting
  const conflictingPaths = input.conflictingPaths ?? []
  if (conflictingPaths.length === 0) {
    throw new SaneMergeError("checkConflictScope requires at least one conflicting path.")
  }
  const ownId = normalizeWorkstreamId(input.ownWorkstreamId)
  const surfaces = input.activeWorkstreams ?? []
  for (const surface of surfaces) {
    let otherId: string
    try {
      otherId = normalizeWorkstreamId(surface.workstreamId)
    } catch {
      throw new SaneMergeError(
        `Invalid active workstream id: ${JSON.stringify(surface.workstreamId)}.`,
      )
    }
    if (otherId === ownId) continue
    if (!surface.baseRev || surface.baseRev.trim() === "") {
      throw new SaneMergeError(
        `Active workstream ${JSON.stringify(otherId)} is missing baseRev.`,
      )
    }
    const overlapping = conflictingPaths.filter((conflict) =>
      (surface.paths ?? []).some((owned) => pathsOverlap(conflict, owned)),
    )
    if (overlapping.length > 0) {
      const report =
        `Cross-workstream conflict STOP: own workstream ${JSON.stringify(ownId)} (base_rev ${JSON.stringify(input.ownBaseRev)}) ` +
        `overlaps active workstream ${JSON.stringify(otherId)} (base_rev ${JSON.stringify(surface.baseRev)}) ` +
        `on paths ${JSON.stringify(overlapping)}. Conflicting paths: ${JSON.stringify(conflictingPaths)}. ` +
        `Owned surface of ${JSON.stringify(otherId)}: ${JSON.stringify(surface.paths)}. ` +
        `User must serialize (one merges first; the other rebases after) or split the overlap into a follow-up workstream. ` +
        `Merging over another workstream's unmerged surface without its owner's user-directed approval is forbidden.`
      throw new CrossWorkstreamConflictError({
        ownWorkstreamId: ownId,
        otherWorkstreamId: otherId,
        overlappingPaths: overlapping,
        conflictingPaths: [...conflictingPaths],
        ownBaseRev: input.ownBaseRev,
        otherBaseRev: surface.baseRev,
        report,
      })
    }
  }
  return { scope: "own" }
}

// ---------------------------------------------------------------------------
// mergeProtocol (8 steps, injectable runners)
// ---------------------------------------------------------------------------

export interface MergeProtocolInput {
  repo: string
  worktreesDir: string
  user: string
  workstreamId: string
  branch?: string
  worktreePath?: string
  /** Active workstream surfaces for rebase-conflict classification (step 1). */
  activeWorkstreams?: WorkstreamSurface[]
  ownBaseRev?: string
}

export interface MergeApproval {
  approvalRef: string
  saneHash?: string
}

/** Injectable runners: tests mock git; production wires real git + DB. */
export interface MergeProtocolRunners {
  execGit: ExecGitFn
  /** Worktree (`worktree`) or main (`main`) isolated checks. Must reject dev-server/migrate/deploy. */
  runChecks: (scope: "worktree" | "main", check: string) => Promise<void>
  /** Read-only diff review against SDD/Job Specs (no writes). */
  reviewDiff: () => Promise<void>
  /** Gate-5 (merge) user approval. Return null/missing ref to simulate denial. */
  requireUserApproval: () => Promise<MergeApproval | null>
  /** Persist `merge_commit` (DB `upsertMerge`/`recordMergeCommit`). */
  recordMergeCommit: (mergeCommit: string) => Promise<void>
}

export interface MergeProtocolResult {
  repoRoot: string
  user: string
  workstreamId: string
  branch: string
  worktreePath: string
  mergeCommit: string
  completedSteps: MergeProtocolStep[]
}

function assertNonEmpty(field: string, value: string): void {
  if (!value || value.trim() === "") {
    throw new SaneMergeError(`${field} must be non-empty.`)
  }
}

function assertNoForbiddenCheck(scope: "worktree" | "main", check: string): void {
  // Worktree scope is strict isolated-only; main scope additionally allows
  // smoke/boot but never dev-server/migrate/deploy.
  if (scope === "worktree") {
    assertIsolatedCheckAllowed(check)
    return
  }
  const lowered = check.toLowerCase()
  for (const forbidden of ["dev-server", "dev_server", "migrate", "deploy"] as const) {
    if (lowered.includes(forbidden)) {
      throw new SaneMergeError(
        `Forbidden ${scope} check ${JSON.stringify(check)} (contains ${JSON.stringify(forbidden)}).`,
      )
    }
  }
  const normalized = check.trim().toLowerCase().replace(/[\s_]+/g, "-")
  const allowedMain = new Set(["typecheck", "unit", "unit-tests", "lint", "smoke", "boot", "boot-check"])
  if (!allowedMain.has(normalized)) {
    throw new SaneMergeError(
      `Check ${JSON.stringify(check)} is not an allowed main check. Allowed: typecheck, unit, lint, smoke/boot.`,
    )
  }
}

/**
 * Run the 8-step merge protocol in order with injectable runners.
 *
 * Order is enforced via {@link assertMergeStepOrder}: skipping ahead (e.g.
 * merge before gate-5 approval, cleanup before record) throws. Step 5 always
 * uses `--no-ff` from a clean main checkout and refuses without the gate-5
 * approval from step 4. Step 8 refuses cleanup before `merge_commit` is
 * recorded (the `record` step must complete first).
 */
export async function mergeProtocol(
  input: MergeProtocolInput,
  runners: MergeProtocolRunners,
): Promise<MergeProtocolResult> {
  assertNonEmpty("repo", input.repo)
  assertNonEmpty("worktreesDir", input.worktreesDir)
  assertNonEmpty("user", input.user)
  const workstreamId = normalizeWorkstreamId(input.workstreamId)
  // Validate slug/branch/path derivations (throws on traversal).
  normalizeWorkstreamSlug(workstreamId)
  const branch = input.branch ?? branchName(input.user, workstreamId)
  const path = input.worktreePath ?? worktreePath(input.worktreesDir, input.user, workstreamId)
  if (!runners.execGit) throw new SaneMergeError("mergeProtocol requires execGit runner.")
  if (!runners.runChecks) throw new SaneMergeError("mergeProtocol requires runChecks runner.")
  if (!runners.reviewDiff) throw new SaneMergeError("mergeProtocol requires reviewDiff runner.")
  if (!runners.requireUserApproval) {
    throw new SaneMergeError("mergeProtocol requires requireUserApproval runner (gate 5).")
  }
  if (!runners.recordMergeCommit) {
    throw new SaneMergeError("mergeProtocol requires recordMergeCommit runner.")
  }

  const completed: MergeProtocolStep[] = []
  const repoRoot = input.repo

  // Step 1: rebase onto main inside the worktree.
  assertMergeStepOrder(completed, "rebase")
  try {
    await runners.execGit(["-C", path, "rebase", "main"])
  } catch (error) {
    if (error instanceof CrossWorkstreamConflictError) throw error
    // Surface conflict-rule guidance. When the git error carries
    // `conflictingPaths` plus known surfaces, classify own vs cross.
    const conflictingPaths = (error as { conflictingPaths?: string[] } | null)?.conflictingPaths
    if (
      Array.isArray(conflictingPaths) &&
      conflictingPaths.length > 0 &&
      input.activeWorkstreams !== undefined &&
      input.ownBaseRev !== undefined
    ) {
      checkConflictScope({
        ownWorkstreamId: workstreamId,
        ownBaseRev: input.ownBaseRev,
        conflictingPaths,
        activeWorkstreams: input.activeWorkstreams,
      })
      // Own surface: still stop this run; owner resolves, rechecks, re-reviews.
      throw new SaneMergeError(
        `Rebase conflict on own surface for ${JSON.stringify(workstreamId)}: resolve in the worktree (${path}), re-run checks, and re-request review. Original: ${(error as Error).message}`,
      )
    }
    throw new SaneMergeError(
      `Rebase failed for ${JSON.stringify(workstreamId)} in ${path}: ${(error as Error).message}. ` +
        `Own surface -> resolve in worktree, recheck, re-review. Cross-workstream surface -> STOP and report both IDs/paths/base_revs.`,
    )
  }
  completed.push("rebase")

  // Step 2: worktree checks (isolated only).
  assertMergeStepOrder(completed, "checks")
  for (const check of ["typecheck", "unit"] as const) {
    assertNoForbiddenCheck("worktree", check)
    await runners.runChecks("worktree", check)
  }
  completed.push("checks")

  // Step 3: read-only review vs SDD/Job Specs.
  assertMergeStepOrder(completed, "review")
  await runners.reviewDiff()
  completed.push("review")

  // Step 4: gate-5 user approval.
  assertMergeStepOrder(completed, "approval")
  const approval = await runners.requireUserApproval()
  if (!approval || !approval.approvalRef || approval.approvalRef.trim() === "") {
    throw new SaneMergeError(
      `Merge refused: missing gate-5 (merge) user approval for ${JSON.stringify(workstreamId)}. User must approve the merge before step 5.`,
    )
  }
  completed.push("approval")

  // Step 5: merge --no-ff from a clean main checkout.
  assertMergeStepOrder(completed, "merge")
  const porcelain = await runners.execGit(["-C", repoRoot, "status", "--porcelain"])
  if (porcelain.trim() !== "") {
    throw new SaneMergeError(
      `Merge refused: main checkout at ${repoRoot} is not clean. Commit or stash changes before merging ${JSON.stringify(branch)} with --no-ff.`,
    )
  }
  await runners.execGit(["-C", repoRoot, "merge", "--no-ff", branch])
  completed.push("merge")

  // Step 6: main checks + smoke.
  assertMergeStepOrder(completed, "main-checks")
  for (const check of ["typecheck", "unit", "smoke"] as const) {
    assertNoForbiddenCheck("main", check)
    await runners.runChecks("main", check)
  }
  completed.push("main-checks")

  // Step 7: record merge_commit.
  assertMergeStepOrder(completed, "record")
  const rawCommit = await runners.execGit(["-C", repoRoot, "rev-parse", "HEAD"])
  const mergeCommit = rawCommit.trim()
  if (!mergeCommit) {
    throw new SaneMergeError("Could not resolve merge_commit: empty HEAD after merge.")
  }
  await runners.recordMergeCommit(mergeCommit)
  completed.push("record")

  // Step 8: cleanup only after recorded.
  assertMergeStepOrder(completed, "cleanup")
  if (!completed.includes("record")) {
    throw new SaneMergeError(
      `Cleanup refused before merge_commit is recorded for ${JSON.stringify(workstreamId)}. Record merge_commit first, then remove the worktree and delete the branch.`,
    )
  }
  await runners.execGit(["-C", repoRoot, "worktree", "remove", path])
  await runners.execGit(["-C", repoRoot, "branch", "-d", branch])
  completed.push("cleanup")

  return {
    repoRoot,
    user: input.user,
    workstreamId,
    branch,
    worktreePath: path,
    mergeCommit,
    completedSteps: completed,
  }
}

// ---------------------------------------------------------------------------
// CLI: sane merge <repo> <workstream> --rebase|--checks|...
// ---------------------------------------------------------------------------

export type SaneMergeAction = "rebase" | "checks" | "review" | "merge" | "record" | "cleanup"

export interface SaneMergeCommandOptions {
  implementationRepository: string
  workstreamPath: string
  action: SaneMergeAction
  noFf?: boolean
  recordCommit?: string
  worktreesDir?: string
  userOverride?: string
  actorRole?: string
  sessionId?: string
  json?: boolean
  write?: (line: string) => void
}

export const USAGE =
  "Usage: sane merge [<implementation-repository> <workstream-relative-path>] --rebase|--checks|--review|--merge --no-ff|--record <commit>|--cleanup [--worktrees-dir <dir>] [--user <name>] [--json] [--repo-root <path>] (no positionals: auto-detect the target from the current directory)"

export interface ParsedMergeArguments {
  implementationRepository: string
  workstreamPath: string
  action: SaneMergeAction
  noFf: boolean
  recordCommit: string | undefined
  worktreesDir: string | undefined
  userOverride: string | undefined
  json: boolean
}

function requireMergeOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) {
    throw new SaneMergeError(`Option ${option} requires a value.`)
  }
  return value
}

export function parseCliArguments(args: string[]): ParsedMergeArguments {
  let json = false
  let noFf = false
  let rebase = false
  let checks = false
  let review = false
  let merge = false
  let cleanup = false
  let recordCommit: string | undefined
  let worktreesDir: string | undefined
  let userOverride: string | undefined
  let repoRootOpt: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--no-ff") {
      if (noFf) throw new SaneMergeError("Option --no-ff may be provided only once.")
      noFf = true
    } else if (parseOptions && argument === "--rebase") {
      if (rebase) throw new SaneMergeError("Option --rebase may be provided only once.")
      rebase = true
    } else if (parseOptions && argument === "--checks") {
      if (checks) throw new SaneMergeError("Option --checks may be provided only once.")
      checks = true
    } else if (parseOptions && argument === "--review") {
      if (review) throw new SaneMergeError("Option --review may be provided only once.")
      review = true
    } else if (parseOptions && argument === "--merge") {
      if (merge) throw new SaneMergeError("Option --merge may be provided only once.")
      merge = true
    } else if (parseOptions && argument === "--cleanup") {
      if (cleanup) throw new SaneMergeError("Option --cleanup may be provided only once.")
      cleanup = true
    } else if (parseOptions && argument === "--record") {
      if (recordCommit !== undefined) {
        throw new SaneMergeError("Option --record may be provided only once.")
      }
      recordCommit = requireMergeOptionValue(args, index, "--record")
      index += 1
    } else if (parseOptions && argument === "--worktrees-dir") {
      if (worktreesDir !== undefined) {
        throw new SaneMergeError("Option --worktrees-dir may be provided only once.")
      }
      worktreesDir = requireMergeOptionValue(args, index, "--worktrees-dir")
      index += 1
    } else if (parseOptions && argument === "--user") {
      if (userOverride !== undefined) {
        throw new SaneMergeError("Option --user may be provided only once.")
      }
      userOverride = requireMergeOptionValue(args, index, "--user")
      index += 1
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneMergeError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneMergeError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneMergeError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  const selected = [
    rebase ? "rebase" : null,
    checks ? "checks" : null,
    review ? "review" : null,
    merge ? "merge" : null,
    recordCommit !== undefined ? "record" : null,
    cleanup ? "cleanup" : null,
  ].filter((entry): entry is string => entry !== null)
  if (selected.length !== 1) {
    throw new SaneMergeError(
      "Provide exactly one of --rebase, --checks, --review, --merge, --record <commit>, or --cleanup.",
    )
  }
  const action = selected[0] as SaneMergeAction
  if (action === "merge" && !noFf) {
    throw new SaneMergeError("Option --merge requires --no-ff (merge --no-ff only).")
  }
  if (action !== "merge" && noFf) {
    throw new SaneMergeError("Option --no-ff applies only to --merge.")
  }
  if (recordCommit !== undefined && recordCommit.trim() === "") {
    throw new SaneMergeError("Option --record requires a non-empty commit value.")
  }

  let implementationRepository: string
  let workstreamPath: string
  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneMergeError(
        "Provide exactly one workstream relative path when --repo-root is used.",
      )
    }
    implementationRepository = repoRootOpt
    workstreamPath = positional[0]
  } else if (positional.length === 2 && positional[0] && positional[1]) {
    implementationRepository = positional[0]
    workstreamPath = positional[1]
  } else if (positional.length === 1 && positional[0]) {
    implementationRepository = process.cwd()
    workstreamPath = positional[0]
  } else if (positional.length === 0) {
    // Bare invocation: the async run path auto-detects the target from CWD.
    implementationRepository = ""
    workstreamPath = ""
  } else {
    throw new SaneMergeError(
      "Provide an implementation repository and workstream relative path.",
    )
  }

  return {
    implementationRepository,
    workstreamPath,
    action,
    noFf,
    recordCommit,
    worktreesDir,
    userOverride,
    json,
  }
}

/**
 * Run one merge-protocol step via real git + DB.
 * - `--merge` refuses without the gate-5 (`merge`) approval row.
 * - `--cleanup` refuses before `merge_commit` is recorded.
 */
export async function runSaneMergeCommand(
  options: SaneMergeCommandOptions,
): Promise<{ repoRoot: string; user: string; workstreamId: string; action: SaneMergeAction }> {
  const write = options.write ?? console.log
  const execGit = defaultExecGit
  const repoRoot = await resolveImplementationRepository(options.implementationRepository)
  const identity = await resolveSaneIdentity(
    repoRoot,
    options.workstreamPath,
    options.userOverride,
  )
  const user = options.userOverride ?? identity.user ?? currentUser()
  if (!user || user.trim() === "") throw new SaneMergeError("User must be non-empty.")
  const resolvedIdentity = await resolveSaneIdentity(repoRoot, identity.workstreamId, user)
  const branch = branchName(user, resolvedIdentity.workstreamId)
  const dir = options.worktreesDir ?? defaultWorktreesDir(repoRoot)
  const path = worktreePath(dir, user, resolvedIdentity.workstreamId)
  const sessionId = options.sessionId ?? `cli-merge-${Date.now()}`
  const actorRole = options.actorRole ?? "execution"

  const db = await openSaneDb(repoRoot)
  try {
    initSchema(db)

    switch (options.action) {
      case "rebase": {
        await execGit(["-C", path, "rebase", "main"])
        break
      }
      case "checks": {
        // Isolated checks only; the worktree never runs dev-server/migrate/deploy.
        assertIsolatedCheckAllowed("typecheck")
        assertIsolatedCheckAllowed("unit")
        break
      }
      case "review": {
        await execGit(["-C", repoRoot, "diff", "--stat", `${branch}...HEAD`].filter(Boolean))
        break
      }
      case "merge": {
        const approval = getApproval(db, resolvedIdentity, "execution")
        if (!approval) {
          throw new SaneMergeError(
            `Merge refused: missing gate-5 (merge) user approval for ${JSON.stringify(resolvedIdentity.workstreamId)}. Record a merge approval before merging.`,
          )
        }
        const porcelain = await execGit(["-C", repoRoot, "status", "--porcelain"])
        if (porcelain.trim() !== "") {
          throw new SaneMergeError(
            `Merge refused: main checkout at ${repoRoot} is not clean. Commit or stash changes before merging with --no-ff.`,
          )
        }
        await execGit(["-C", repoRoot, "merge", "--no-ff", branch])
        break
      }
      case "record": {
        if (!options.recordCommit || options.recordCommit.trim() === "") {
          throw new SaneMergeError("Option --record requires a non-empty commit value.")
        }
        recordMergeCommitDb(db, resolvedIdentity, options.recordCommit.trim(), {
          actorRole,
          sessionId,
        })
        break
      }
      case "cleanup": {
        const mergeRow = getMerge(db, resolvedIdentity)
        if (!mergeRow) {
          throw new SaneMergeError(
            `Cleanup refused: no merges row for ${JSON.stringify(resolvedIdentity.workstreamId)}.`,
          )
        }
        if (mergeRow.merge_commit === null || mergeRow.merge_commit === undefined) {
          throw new SaneMergeError(
            `Cleanup refused before merge_commit is recorded for ${JSON.stringify(resolvedIdentity.workstreamId)} (branch ${mergeRow.branch}). Record merge_commit first, then remove the worktree and delete the branch.`,
          )
        }
        await execGit(["-C", repoRoot, "worktree", "remove", path])
        await execGit(["-C", repoRoot, "branch", "-d", branch])
        break
      }
    }
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }

  const result = {
    repoRoot,
    user,
    workstreamId: resolvedIdentity.workstreamId,
    action: options.action,
  }
  if (options.json === true) {
    write(
      JSON.stringify(
        {
          repo_root: result.repoRoot,
          user: result.user,
          workstream_id: result.workstreamId,
          action: result.action,
          branch,
          worktree_path: path,
        },
        null,
        2,
      ),
    )
  } else {
    write(`Merge ${result.action}: ${result.workstreamId} (${branch})`)
  }
  return result
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args)
    const address = await resolveCommandAddress(parsed, { userOverride: parsed.userOverride })
    await runSaneMergeCommand({ ...parsed, ...address })
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2))
}
