/**
 * SANE 0.2.0: CWD-based auto-detection of the CLI target repository + workstream.
 *
 * A bare invocation (no positionals, no `--repo-root`) inside a session's
 * working directory resolves its own target. Fallback chain, given a CWD:
 *
 * a. If CWD's `git rev-parse --show-toplevel` contains `.sane/` it is a
 *    main-repo context: repo_root is the toplevel and the workstream is the
 *    per-user `current_workstreams` row in `<repo>/.sane/sane.db` (strict
 *    per-user, no cross-user adoption; a missing row errors and names the
 *    fix: run `select`). The pointed workstream directory is validated via
 *    `validateBootstrappedWorkstream`.
 * b. Else resolve `git rev-parse --git-common-dir` to a main-repo candidate
 *    (strip the trailing `.git`). If `<candidate>/.sane` exists, open its
 *    `sane.db` and match a `selections` row whose `worktree_path` equals the
 *    toplevel (realpath-resolved on both sides, same repo only). The current
 *    OS user wins; otherwise a single other user's registration is adopted
 *    (returned as the effective user). No match, or more than one distinct
 *    `(user, workstream)` registration, errors and asks for explicit args.
 * c. Outside any git tree, or a candidate without `.sane/`, errors and asks
 *    for explicit args.
 *
 * Explicit positionals and `--repo-root` always win: `resolveCommandAddress`
 * returns them untouched without touching git or the DB. Resolution lives in
 * the async run path (parsers stay sync).
 */
import { execFile } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

import {
  currentUser,
  getCurrentWorkstream,
  getSessionWorkstream,
  initSchema,
  normalizeWorkstreamId,
  openSaneDbAtPath,
  saneDbPath,
} from "./sane-db.ts"
import { SaneRepositoryError, validateBootstrappedWorkstream } from "./sane-repository.ts"
import { resolveSaneMainRepository } from "./sane-implementation.ts"

const execFileAsync = promisify(execFile)

export type CwdTargetSource = "main-pointer" | "worktree-selection" | "session-binding"

export interface CwdTarget {
  repoRoot: string
  workstreamId: string
  /** Effective user: the override, the current OS user, or an adopted row user. */
  user: string
  source: CwdTargetSource
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined
    throw error
  }
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined
    throw error
  }
}

async function runGit(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" })
  return stdout.trim()
}

function explicitArgsHint(): string {
  return "Pass <implementation-repository> <workstream-relative-path> explicitly (or --repo-root <path> <workstream-relative-path>)."
}

/** Main-repo context: the per-user DB pointer selects the workstream (strict, no adoption). */
async function resolveMainPointer(repoRoot: string, user: string): Promise<CwdTarget> {
  const dbPath = saneDbPath(repoRoot)
  if (!((await lstatOrUndefined(dbPath))?.isFile())) {
    throw new SaneRepositoryError(
      `No current workstream selected in ${repoRoot} for user ${JSON.stringify(user)} (no current selection in ${dbPath}). ` +
        `Run: sane select --name <workstream-name> (run from the repository root)`,
    )
  }
  const db = openSaneDbAtPath(dbPath)
  let workstreamId: string
  try {
    initSchema(db)
    const row = getCurrentWorkstream(db, { repoRoot, user })
    if (!row) {
      throw new SaneRepositoryError(
        `No current workstream selected in ${repoRoot} for user ${JSON.stringify(user)}. ` +
          `Run: sane select --name <workstream-name> (run from the repository root)`,
      )
    }
    workstreamId = row.workstream_id
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }
  const workstreamDir = join(repoRoot, ".sane", "workstreams", workstreamId)
  try {
    await validateBootstrappedWorkstream(workstreamDir)
  } catch (error) {
    const message = (error as Error).message
    if (message.includes("Re-create")) {
      throw error instanceof SaneRepositoryError ? error : new SaneRepositoryError(message)
    }
    throw new SaneRepositoryError(
      `${message} Re-create the workstream with the current bootstrap.`,
    )
  }
  return { repoRoot, workstreamId, user, source: "main-pointer" }
}

/**
 * Derive the main-repo candidate from `--git-common-dir` (absolute for linked
 * worktrees, `.git`-relative for a main checkout). Returns null when the
 * common dir is missing or not a `.git` directory.
 */
async function mainRepoCandidate(cwd: string, toplevel: string): Promise<string | null> {
  let common: string
  try {
    common = await runGit(["-C", cwd, "rev-parse", "--git-common-dir"])
  } catch {
    return null
  }
  if (!common) return null
  const absolute = isAbsolute(common) ? common : resolve(toplevel, common)
  if (basename(absolute) !== ".git") return null
  return resolve(dirname(absolute))
}

interface SelectionMatch {
  repo_root: string
  user: string
  workstream_id: string
  worktree_path: string | null
}

/** Worktree context: match one `selections` registration by worktree path. */
async function resolveWorktreeSelection(
  candidate: string,
  toplevel: string,
  preferredUser: string,
  strictUser: boolean,
): Promise<CwdTarget> {
  const dbPath = saneDbPath(candidate)
  if (!((await lstatOrUndefined(dbPath))?.isFile())) {
    throw new SaneRepositoryError(
      `Cannot auto-detect a SANE target from ${toplevel}: no SANE database at ${dbPath}. ${explicitArgsHint()}`,
    )
  }
  const realToplevel = (await realpathOrUndefined(toplevel)) ?? resolve(toplevel)
  const realCandidate = (await realpathOrUndefined(candidate)) ?? resolve(candidate)
  const db = openSaneDbAtPath(dbPath)
  let rows: SelectionMatch[]
  try {
    initSchema(db)
    rows = db
      .query(
        `SELECT repo_root, user, workstream_id, worktree_path FROM selections WHERE worktree_path IS NOT NULL
         UNION SELECT repo_root, user, workstream_id, worktree_path FROM workstream_implementations`,
      )
      .all() as SelectionMatch[]
  } catch (error) {
    throw new SaneRepositoryError(
      `Cannot auto-detect a SANE target from ${toplevel}: cannot read selections in ${dbPath} (${(error as Error).message}). ${explicitArgsHint()}`,
    )
  } finally {
    try {
      db.close()
    } catch {
      // Best effort.
    }
  }
  const matches: SelectionMatch[] = []
  for (const row of rows) {
    if (!row.worktree_path) continue
    const realRowPath = await realpathOrUndefined(row.worktree_path)
    if (realRowPath === undefined || realRowPath !== realToplevel) continue
    // Same-repo registrations only; fall back to lexical compare when either
    // side cannot be realpath-resolved.
    const realRowRepo = await realpathOrUndefined(row.repo_root)
    if (realRowRepo !== undefined ? realRowRepo !== realCandidate : resolve(row.repo_root) !== resolve(candidate)) {
      continue
    }
    matches.push(row)
  }
  const pairs = new Map<string, { user: string; workstreamId: string }>()
  for (const match of matches) {
    pairs.set(`${match.user}\n${match.workstream_id}`, {
      user: match.user,
      workstreamId: match.workstream_id,
    })
  }
  const all = [...pairs.values()]
  const own = all.filter((pair) => pair.user === preferredUser)
  // An explicit user never falls back to another user's registration.
  const scoped = strictUser ? own : own.length > 0 ? own : all
  if (scoped.length === 0) {
    const who = strictUser ? ` for user ${JSON.stringify(preferredUser)}` : ""
    throw new SaneRepositoryError(
      `No SANE workstream selection matches this worktree (${toplevel})${who} in ${candidate}. ${explicitArgsHint()}`,
    )
  }
  if (scoped.length > 1) {
    const list = scoped
      .map((pair) => `${pair.user}/${pair.workstreamId}`)
      .sort()
      .join(", ")
    throw new SaneRepositoryError(
      `Ambiguous SANE workstream for this worktree (${toplevel}): ${list}. ${explicitArgsHint()} to choose one.`,
    )
  }
  const winner = scoped[0]
  if (!winner) {
    throw new SaneRepositoryError(
      `No SANE workstream selection matches this worktree (${toplevel}) in ${candidate}. ${explicitArgsHint()}`,
    )
  }
  return {
    repoRoot: candidate,
    workstreamId: winner.workstreamId,
    user: winner.user,
    source: "worktree-selection",
  }
}

/**
 * Resolve the CLI target for a CWD: main-repo pointer first, then worktree
 * selection via `--git-common-dir`. Errors ask for explicit args (or name
 * `select` for a missing pointer).
 */
export async function resolveCwdTarget(
  cwd: string = process.cwd(),
  userOverride?: string,
  sessionId?: string,
): Promise<CwdTarget> {
  const start = resolve(cwd)
  let toplevel: string
  try {
    toplevel = resolve(await runGit(["-C", start, "rev-parse", "--show-toplevel"]))
  } catch {
    throw new SaneRepositoryError(
      `Cannot auto-detect a SANE target from ${start}: not inside a git working tree. ${explicitArgsHint()}`,
    )
  }
  const preferredUser = userOverride ?? currentUser()
  if (!preferredUser || preferredUser.trim() === "") {
    throw new SaneRepositoryError("User must be non-empty.")
  }
  if (sessionId) {
    const repository = await resolveSaneMainRepository(start)
    const path = saneDbPath(repository)
    if ((await lstatOrUndefined(path))?.isFile()) {
      const db = openSaneDbAtPath(path)
      try {
        initSchema(db)
        const workstreamId = getSessionWorkstream(db, { repoRoot: repository, user: preferredUser, sessionId })
        if (workstreamId) {
          await validateBootstrappedWorkstream(join(repository, ".sane", "workstreams", workstreamId))
          return { repoRoot: repository, workstreamId, user: preferredUser, source: "session-binding" }
        }
      } finally {
        db.close()
      }
    }
  }
  if (((await lstatOrUndefined(join(toplevel, ".sane")))?.isDirectory()) === true) {
    return resolveMainPointer(toplevel, preferredUser)
  }
  const candidate = await mainRepoCandidate(start, toplevel)
  if (
    candidate === null ||
    ((await lstatOrUndefined(join(candidate, ".sane")))?.isDirectory() !== true)
  ) {
    throw new SaneRepositoryError(
      `Cannot auto-detect a SANE target from ${start}: it is neither a SANE repository (no .sane/ under ${toplevel}) nor a registered worktree. ${explicitArgsHint()}`,
    )
  }
  return resolveWorktreeSelection(candidate, toplevel, preferredUser, userOverride !== undefined)
}

export interface CommandAddressInput {
  implementationRepository: string
  workstreamPath: string
}

/**
 * Fill a bare parsed address (empty `workstreamPath` sentinel from a
 * zero-positional parse) via CWD auto-detection. Explicit positionals and
 * `--repo-root` pass through untouched: no git or DB access happens for them.
 * The returned `userOverride` is the effective user (adopted from the matched
 * registration on fallback); explicit callers pass it straight into the
 * command options, where `undefined` preserves today's behavior exactly.
 */
export async function resolveCommandAddress<T extends CommandAddressInput>(
  parsed: T,
  options?: { userOverride?: string; cwd?: string; sessionId?: string; workstream?: string },
): Promise<{
  implementationRepository: string
  workstreamPath: string
  userOverride: string | undefined
}> {
  if (parsed.workstreamPath) {
    return {
      implementationRepository: parsed.implementationRepository || await resolveSaneMainRepository(options?.cwd ?? process.cwd()),
      workstreamPath: parsed.workstreamPath,
      userOverride: options?.userOverride,
    }
  }
  if (options?.workstream !== undefined) {
    return {
      implementationRepository: await resolveSaneMainRepository(options.cwd ?? process.cwd()),
      workstreamPath: normalizeWorkstreamId(options.workstream),
      userOverride: options.userOverride,
    }
  }
  const target = await resolveCwdTarget(options?.cwd ?? process.cwd(), options?.userOverride,
    options?.sessionId ?? process.env["SANE_SESSION_ID"] ?? process.env["OPENCODE_SESSION_ID"])
  return {
    implementationRepository: target.repoRoot,
    workstreamPath: target.workstreamId,
    userOverride: target.user,
  }
}
