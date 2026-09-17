/**
 * SANE 0.2.0 M5: `sane worktree` command (docs/SANE_0_2_0.md Section 4).
 *
 * One git worktree plus one branch per active execution workstream:
 *
 * ```text
 * git -C <implementation-repository> worktree add \
 *   <worktrees-dir>/<user>/<workstream> -b sane/<user>/<workstream> <base_rev>
 * ```
 *
 * The branch name is `sane/<user>/<workstream>` where `<workstream>` is the
 * normalized relative workstream path with separators flattened. The `merges`
 * row records the branch and the `base_rev` (main HEAD at creation). Execution
 * owns worktree and branch lifecycle; no other role creates them.
 *
 * The dev server stays on main. Worktrees run isolated checks only (typecheck,
 * unit tests, lint for the touched surface). No worktree starts a shared dev
 * server, migration against shared data, or deployment.
 *
 * New files only (M5); read-only use of `sane-db.ts` helpers (no schema
 * refactor). Does not touch `bin/sane.ts`, `sane-db.ts` schema,
 * handoff files, `templates/`, or agents/skills.
 */
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import {
  branchForWorkstream,
  currentUser,
  flattenWorkstreamId,
  getMerge,
  initSchema,
  normalizeWorkstreamId,
  openSaneDb,
  resolveSaneIdentity,
  upsertMerge,
} from "./sane-db.ts"
import { resolveImplementationRepository } from "./sane-repository.ts"
import { resolveCommandAddress } from "./sane-cwd-target.ts"
import { SaneWorkstreamStateError } from "./sane-workstream-state.ts"

const execFileAsync = promisify(execFile)

export class SaneWorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneWorktreeError"
  }
}

/** Injectable git runner so tests mock git without touching the filesystem. */
export type ExecGitFn = (args: string[]) => Promise<string>

async function defaultExecGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" })
  return stdout.trim()
}

/** Default parent directory for namespaced worktrees: `<repo>/.sane/worktrees`. */
export function defaultWorktreesDir(repoRoot: string): string {
  return join(resolve(repoRoot), ".sane", "worktrees")
}

// ---------------------------------------------------------------------------
// Naming helpers (docs/SANE_0_2_0.md Section 4)
// ---------------------------------------------------------------------------

/**
 * Flatten a normalized workstream id for branch/worktree names.
 * `nested/01-export` -> `nested-01-export`. Rejects traversal via
 * `normalizeWorkstreamId`.
 */
export function normalizeWorkstreamSlug(workstreamId: string): string {
  try {
    const normalized = normalizeWorkstreamId(workstreamId)
    const slug = flattenWorkstreamId(normalized)
    if (!slug || slug.trim() === "") {
      throw new SaneWorktreeError("Workstream slug must be non-empty.")
    }
    return slug
  } catch (error) {
    if (error instanceof SaneWorktreeError) throw error
    throw new SaneWorktreeError((error as Error).message)
  }
}

/**
 * Branch name for a workstream: `sane/<user>/<slug>`.
 * Delegates to `branchForWorkstream` so the DB and git stay consistent.
 */
export function branchName(user: string, workstreamId: string): string {
  if (!user || user.trim() === "") {
    throw new SaneWorktreeError("User must be non-empty.")
  }
  if (user.includes("/") || user.includes("\\") || user.includes(" ")) {
    throw new SaneWorktreeError(`Invalid user for branch name: ${JSON.stringify(user)}.`)
  }
  try {
    return branchForWorkstream(user, workstreamId)
  } catch (error) {
    throw new SaneWorktreeError((error as Error).message)
  }
}

/**
 * Worktree path for a workstream: `<worktrees-dir>/<user>/<slug>`.
 */
export function worktreePath(worktreesDir: string, user: string, workstreamId: string): string {
  if (!worktreesDir || worktreesDir.trim() === "") {
    throw new SaneWorktreeError("Worktrees directory must be non-empty.")
  }
  if (!user || user.trim() === "") {
    throw new SaneWorktreeError("User must be non-empty.")
  }
  const slug = normalizeWorkstreamSlug(workstreamId)
  return join(worktreesDir, user, slug)
}

// ---------------------------------------------------------------------------
// Isolated checks (dev server stays on main)
// ---------------------------------------------------------------------------

/** Checks allowed inside a worktree: typecheck, unit tests, lint. */
export const ALLOWED_WORKTREE_CHECKS = ["typecheck", "unit", "lint"] as const
export type AllowedWorktreeCheck = (typeof ALLOWED_WORKTREE_CHECKS)[number]

const ALLOWED_WORKTREE_CHECK_SET = new Set<string>([
  "typecheck",
  "unit",
  "unit-tests",
  "unit_tests",
  "lint",
])

/** Commands that must never run inside a worktree (shared state/deployment). */
export const FORBIDDEN_WORKTREE_COMMANDS = [
  "dev-server",
  "dev_server",
  "devserver",
  "serve",
  "migrate",
  "migration",
  "migrations",
  "deploy",
  "deployment",
] as const

const FORBIDDEN_WORKTREE_COMMAND_SET = new Set<string>(FORBIDDEN_WORKTREE_COMMANDS)

function normalizeCheckName(check: string): string {
  return check.trim().toLowerCase().replace(/[\s_]+/g, "-")
}

/**
 * Throw unless `check` is an isolated worktree check (typecheck/unit/lint).
 * Always rejects dev-server / migrate / deploy (shared dev server, shared
 * data migration, deployment).
 */
export function assertIsolatedCheckAllowed(check: string): void {
  if (!check || check.trim() === "") {
    throw new SaneWorktreeError("Check name must be non-empty.")
  }
  const normalized = normalizeCheckName(check)
  if (FORBIDDEN_WORKTREE_COMMAND_SET.has(normalized)) {
    throw new SaneWorktreeError(
      `Forbidden worktree command ${JSON.stringify(check)}: worktrees run isolated checks only (typecheck, unit, lint). No worktree starts a shared dev server, migration against shared data, or deployment.`,
    )
  }
  // Substring guard so `bun run dev-server` / `prisma migrate deploy` style
  // invocations are also refused even when wrapped.
  const lowered = check.toLowerCase()
  for (const forbidden of FORBIDDEN_WORKTREE_COMMAND_SET) {
    if (lowered.includes(forbidden)) {
      throw new SaneWorktreeError(
        `Forbidden worktree command ${JSON.stringify(check)} (contains ${JSON.stringify(forbidden)}): worktrees run isolated checks only (typecheck, unit, lint).`,
      )
    }
  }
  if (!ALLOWED_WORKTREE_CHECK_SET.has(normalized)) {
    throw new SaneWorktreeError(
      `Check ${JSON.stringify(check)} is not an isolated worktree check. Allowed: ${ALLOWED_WORKTREE_CHECKS.join(", ")}.`,
    )
  }
}

/** Non-throwing variant of {@link assertIsolatedCheckAllowed}. */
export function isIsolatedCheckAllowed(check: string): boolean {
  try {
    assertIsolatedCheckAllowed(check)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// createWorktree / removeWorktree
// ---------------------------------------------------------------------------

export interface CreateWorktreeInput {
  repo: string
  worktreesDir: string
  user: string
  workstreamId: string
  baseRev: string
  actorRole?: string
  sessionId?: string
}

export interface CreateWorktreeDeps {
  execGit?: ExecGitFn
  resolveRepoRoot?: (repo: string) => Promise<string>
}

export interface CreateWorktreeResult {
  repoRoot: string
  user: string
  workstreamId: string
  slug: string
  branch: string
  worktreePath: string
  baseRev: string
}

export interface RemoveWorktreeInput {
  repo: string
  worktreesDir: string
  user: string
  workstreamId: string
  /** Bypass the merge_commit guard only with explicit user direction. */
  force?: boolean
  actorRole?: string
  sessionId?: string
}

export interface RemoveWorktreeDeps {
  execGit?: ExecGitFn
  resolveRepoRoot?: (repo: string) => Promise<string>
}

export interface RemoveWorktreeResult {
  repoRoot: string
  user: string
  workstreamId: string
  branch: string
  worktreePath: string
  forced: boolean
}

function assertExecutionOwner(actorRole: string | undefined, action: string): void {
  const role = actorRole ?? "execution"
  if (role !== "execution") {
    throw new SaneWorktreeError(
      `Only the execution role may ${action} (got role ${JSON.stringify(role)}). Execution owns worktree and branch lifecycle; no other role creates them.`,
    )
  }
}

/**
 * Create one git worktree plus one branch for an execution workstream and
 * record the `merges` row (`branch` + `base_rev` = main HEAD at creation).
 *
 * Runs `git -C <repo> worktree add <path> -b <branch> <baseRev>` via the
 * injectable `execGit` (tests mock git), then `upsertMerge`.
 */
export async function createWorktree(
  input: CreateWorktreeInput,
  deps?: CreateWorktreeDeps,
): Promise<CreateWorktreeResult> {
  if (!input.repo || input.repo.trim() === "") {
    throw new SaneWorktreeError("Repo must be a non-empty path.")
  }
  if (!input.worktreesDir || input.worktreesDir.trim() === "") {
    throw new SaneWorktreeError("Worktrees directory must be non-empty.")
  }
  if (!input.user || input.user.trim() === "") {
    throw new SaneWorktreeError("User must be non-empty.")
  }
  if (!input.baseRev || input.baseRev.trim() === "") {
    throw new SaneWorktreeError("baseRev must be non-empty (main HEAD at creation).")
  }
  assertExecutionOwner(input.actorRole, "create worktrees")

  const execGit = deps?.execGit ?? defaultExecGit
  const resolveRepoRoot =
    deps?.resolveRepoRoot ?? ((repo: string) => resolveImplementationRepository(repo))
  const repoRoot = await resolveRepoRoot(input.repo)
  const normalizedId = normalizeWorkstreamId(input.workstreamId)
  const slug = normalizeWorkstreamSlug(normalizedId)
  const branch = branchName(input.user, normalizedId)
  const path = worktreePath(input.worktreesDir, input.user, normalizedId)
  const baseRev = input.baseRev.trim()
  const sessionId = input.sessionId ?? `worktree-create-${Date.now()}`

  await execGit(["-C", repoRoot, "worktree", "add", path, "-b", branch, baseRev])

  const identity = await resolveSaneIdentity(repoRoot, normalizedId, input.user)
  const db = await openSaneDb(repoRoot)
  try {
    initSchema(db)
    upsertMerge(
      db,
      identity,
      { branch, baseRev },
      { actorRole: "execution", sessionId },
    )
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }

  return {
    repoRoot,
    user: input.user,
    workstreamId: normalizedId,
    slug,
    branch,
    worktreePath: path,
    baseRev,
  }
}

/**
 * Remove a worktree (`git worktree remove`) only after `merge_commit` is
 * recorded, or with `force: true` under explicit user direction.
 *
 * Forced removal requires `actorRole: "user"` (owner user-directed approval);
 * without force, a NULL `merge_commit` refuses cleanup so the branch is never
 * dropped before the merge is recorded. The `merges` row is kept (history).
 */
export async function removeWorktree(
  input: RemoveWorktreeInput,
  deps?: RemoveWorktreeDeps,
): Promise<RemoveWorktreeResult> {
  if (!input.repo || input.repo.trim() === "") {
    throw new SaneWorktreeError("Repo must be a non-empty path.")
  }
  if (!input.worktreesDir || input.worktreesDir.trim() === "") {
    throw new SaneWorktreeError("Worktrees directory must be non-empty.")
  }
  if (!input.user || input.user.trim() === "") {
    throw new SaneWorktreeError("User must be non-empty.")
  }
  const forced = input.force === true
  const actorRole = input.actorRole ?? "execution"
  if (forced && actorRole !== "user") {
    throw new SaneWorktreeError(
      `Forced worktree removal requires explicit user direction (actorRole "user", got ${JSON.stringify(actorRole)}). Use --force only with user approval; never drop an unmerged surface unilaterally.`,
    )
  }
  if (!forced) {
    assertExecutionOwner(actorRole, "remove worktrees")
  }

  const execGit = deps?.execGit ?? defaultExecGit
  const resolveRepoRoot =
    deps?.resolveRepoRoot ?? ((repo: string) => resolveImplementationRepository(repo))
  const repoRoot = await resolveRepoRoot(input.repo)
  const normalizedId = normalizeWorkstreamId(input.workstreamId)
  const branch = branchName(input.user, normalizedId)
  const path = worktreePath(input.worktreesDir, input.user, normalizedId)

  const identity = await resolveSaneIdentity(repoRoot, normalizedId, input.user)
  const db = await openSaneDb(repoRoot)
  try {
    initSchema(db)
    const merge = getMerge(db, identity)
    if (!merge) {
      throw new SaneWorktreeError(
        `No merges row for workstream ${JSON.stringify(normalizedId)} (user ${JSON.stringify(input.user)}). Create the worktree first.`,
      )
    }
    if ((merge.merge_commit === null || merge.merge_commit === undefined) && !forced) {
      throw new SaneWorktreeError(
        `Cleanup refused before merge_commit is recorded for ${JSON.stringify(normalizedId)} (branch ${merge.branch}). Merge first and record merge_commit, or retry with --force under explicit user direction.`,
      )
    }
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }

  if (forced) {
    await execGit(["-C", repoRoot, "worktree", "remove", "--force", path])
  } else {
    await execGit(["-C", repoRoot, "worktree", "remove", path])
  }

  return {
    repoRoot,
    user: input.user,
    workstreamId: normalizedId,
    branch,
    worktreePath: path,
    forced,
  }
}

// ---------------------------------------------------------------------------
// CLI: sane worktree <repo> <workstream> --create|--remove
// ---------------------------------------------------------------------------

export type SaneWorktreeMode = "create" | "remove"

export interface SaneWorktreeCommandOptions {
  implementationRepository: string
  workstreamPath: string
  mode: SaneWorktreeMode
  worktreesDir?: string
  baseRev?: string
  force?: boolean
  userOverride?: string
  actorRole?: string
  sessionId?: string
  json?: boolean
  write?: (line: string) => void
}

export const USAGE =
  "Usage: sane worktree [<implementation-repository> <workstream-relative-path>] --create|--remove [--base-rev <rev>] [--worktrees-dir <dir>] [--user <name>] [--force] [--actor-role <role>] [--session-id <id>] [--json] [--repo-root <path>] (no positionals: auto-detect the target from the current directory)"

export interface ParsedWorktreeArguments {
  implementationRepository: string
  workstreamPath: string
  mode: SaneWorktreeMode
  worktreesDir: string | undefined
  baseRev: string | undefined
  force: boolean
  userOverride: string | undefined
  actorRole: string | undefined
  sessionId: string | undefined
  json: boolean
}

function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("-")) {
    throw new SaneWorktreeError(`Option ${option} requires a value.`)
  }
  return value
}

export function parseCliArguments(args: string[]): ParsedWorktreeArguments {
  let json = false
  let create = false
  let remove = false
  let force = false
  let worktreesDir: string | undefined
  let baseRev: string | undefined
  let userOverride: string | undefined
  let actorRole: string | undefined
  let sessionId: string | undefined
  let repoRootOpt: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--json") {
      json = true
    } else if (parseOptions && argument === "--create") {
      if (create) throw new SaneWorktreeError("Option --create may be provided only once.")
      create = true
    } else if (parseOptions && argument === "--remove") {
      if (remove) throw new SaneWorktreeError("Option --remove may be provided only once.")
      remove = true
    } else if (parseOptions && argument === "--force") {
      force = true
    } else if (parseOptions && argument === "--base-rev") {
      if (baseRev !== undefined) {
        throw new SaneWorktreeError("Option --base-rev may be provided only once.")
      }
      baseRev = requireOptionValue(args, index, "--base-rev")
      index += 1
    } else if (parseOptions && argument === "--worktrees-dir") {
      if (worktreesDir !== undefined) {
        throw new SaneWorktreeError("Option --worktrees-dir may be provided only once.")
      }
      worktreesDir = requireOptionValue(args, index, "--worktrees-dir")
      index += 1
    } else if (parseOptions && argument === "--user") {
      if (userOverride !== undefined) {
        throw new SaneWorktreeError("Option --user may be provided only once.")
      }
      userOverride = requireOptionValue(args, index, "--user")
      index += 1
    } else if (parseOptions && argument === "--actor-role") {
      if (actorRole !== undefined) {
        throw new SaneWorktreeError("Option --actor-role may be provided only once.")
      }
      actorRole = requireOptionValue(args, index, "--actor-role")
      index += 1
    } else if (parseOptions && argument === "--session-id") {
      if (sessionId !== undefined) {
        throw new SaneWorktreeError("Option --session-id may be provided only once.")
      }
      sessionId = requireOptionValue(args, index, "--session-id")
      index += 1
    } else if (parseOptions && argument === "--repo-root") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneWorktreeError("Option --repo-root requires a value.")
      }
      if (repoRootOpt !== undefined) {
        throw new SaneWorktreeError("Option --repo-root may be provided only once.")
      }
      repoRootOpt = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneWorktreeError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (create === remove) {
    throw new SaneWorktreeError("Provide exactly one of --create or --remove.")
  }
  const mode: SaneWorktreeMode = create ? "create" : "remove"
  if (force && mode !== "remove") {
    throw new SaneWorktreeError("Option --force applies only to --remove.")
  }
  if (baseRev !== undefined && mode !== "create") {
    throw new SaneWorktreeError("Option --base-rev applies only to --create.")
  }

  let implementationRepository: string
  let workstreamPath: string
  if (repoRootOpt !== undefined) {
    if (positional.length !== 1 || !positional[0]) {
      throw new SaneWorktreeError(
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
    throw new SaneWorktreeError(
      "Provide an implementation repository and workstream relative path.",
    )
  }

  return {
    implementationRepository,
    workstreamPath,
    mode,
    worktreesDir,
    baseRev,
    force,
    userOverride,
    actorRole,
    sessionId,
    json,
  }
}

async function resolveBaseRev(repoRoot: string, explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit.trim() !== "") return explicit.trim()
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    })
    const rev = stdout.trim()
    if (!rev) throw new SaneWorktreeError("Could not resolve base_rev: empty HEAD.")
    return rev
  } catch (error) {
    if (error instanceof SaneWorktreeError) throw error
    throw new SaneWorktreeError(
      `Could not resolve base_rev (main HEAD). Provide --base-rev explicitly: ${(error as Error).message}`,
    )
  }
}

/**
 * Run the worktree command. `--create` records the `merges` row (branch +
 * base_rev); `--remove` refuses cleanup before `merge_commit` unless `--force`
 * with user direction.
 */
export async function runSaneWorktreeCommand(
  options: SaneWorktreeCommandOptions,
): Promise<CreateWorktreeResult | RemoveWorktreeResult> {
  const write = options.write ?? console.log
  const repoRoot = await resolveImplementationRepository(options.implementationRepository)
  const identity = await resolveSaneIdentity(
    repoRoot,
    options.workstreamPath,
    options.userOverride,
  )
  // CLI --user overrides the OS user; otherwise the resolved identity user
  // (currentUser) owns the branch/worktree namespace.
  const user = options.userOverride ?? identity.user
  if (!user || user.trim() === "") {
    throw new SaneWorktreeError("User must be non-empty.")
  }
  const worktreesDir = options.worktreesDir ?? defaultWorktreesDir(repoRoot)
  const sessionId = options.sessionId ?? `cli-worktree-${Date.now()}`

  if (options.mode === "create") {
    const actorRole = options.actorRole ?? "execution"
    const baseRev = await resolveBaseRev(repoRoot, options.baseRev)
    const result = await createWorktree(
      {
        repo: repoRoot,
        worktreesDir,
        user,
        workstreamId: identity.workstreamId,
        baseRev,
        actorRole,
        sessionId,
      },
      {
        resolveRepoRoot: async () => repoRoot,
      },
    )
    if (options.json === true) {
      write(
        JSON.stringify(
          {
            repo_root: result.repoRoot,
            user: result.user,
            workstream_id: result.workstreamId,
            slug: result.slug,
            branch: result.branch,
            worktree_path: result.worktreePath,
            base_rev: result.baseRev,
          },
          null,
          2,
        ),
      )
    } else {
      write(`Worktree created: ${result.worktreePath} (${result.branch} @ ${result.baseRev})`)
    }
    return result
  }

  const actorRole = options.actorRole ?? (options.force === true ? "user" : "execution")
  const result = await removeWorktree(
    {
      repo: repoRoot,
      worktreesDir,
      user,
      workstreamId: identity.workstreamId,
      force: options.force,
      actorRole,
      sessionId,
    },
    {
      resolveRepoRoot: async () => repoRoot,
    },
  )
  if (options.json === true) {
    write(
      JSON.stringify(
        {
          repo_root: result.repoRoot,
          user: result.user,
          workstream_id: result.workstreamId,
          branch: result.branch,
          worktree_path: result.worktreePath,
          forced: result.forced,
        },
        null,
        2,
      ),
    )
  } else {
    write(`Worktree removed: ${result.worktreePath}${result.forced ? " (forced)" : ""}`)
  }
  return result
}

export async function runCli(args: string[]): Promise<number> {
  try {
    const parsed = parseCliArguments(args)
    const address = await resolveCommandAddress(parsed, { userOverride: parsed.userOverride })
    await runSaneWorktreeCommand({ ...parsed, ...address })
    return 0
  } catch (error) {
    if (error instanceof SaneWorkstreamStateError) {
      console.error(`Error: ${error.message}`)
    } else {
      console.error(`Error: ${(error as Error).message}`)
    }
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2))
}
