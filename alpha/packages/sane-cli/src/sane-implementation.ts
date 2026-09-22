import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import type { Database } from "bun:sqlite"
import { getWorkstreamImplementation, type SaneIdentity } from "./sane-db.ts"
import { SaneRepositoryError } from "./sane-repository.ts"

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" })
  return stdout.trim()
}

/** Resolve the common repository even for an as-yet unregistered linked worktree. */
export async function resolveSaneMainRepository(directory: string): Promise<string> {
  const list = await git(resolve(directory), "worktree", "list", "--porcelain", "-z")
  const first = list.split("\0")[0]
  if (!first?.startsWith("worktree ")) throw new SaneRepositoryError(`Cannot resolve main repository from ${directory}.`)
  return realpath(first.slice("worktree ".length))
}

/** Require an existing checkout root belonging to the same Git common directory. */
export async function validateImplementationWorktree(repoRoot: string, directory: string): Promise<{ worktreePath: string; branch: string | null }> {
  try {
    const worktreePath = await realpath(resolve(directory))
    const top = await realpath(await git(worktreePath, "rev-parse", "--show-toplevel"))
    if (top !== worktreePath) throw new Error("Path must name the worktree root, not a subdirectory.")
    const common = async (path: string) => realpath(await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    if (await common(repoRoot) !== await common(worktreePath)) throw new Error("Worktree belongs to a different Git repository.")
    const branch = await git(worktreePath, "symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "")
    return { worktreePath, branch: branch || null }
  } catch (error) {
    throw new SaneRepositoryError(`Invalid implementation worktree ${directory}: ${(error as Error).message}`)
  }
}

/** Revalidate persisted roots when consumed; stale bindings must not silently target main. */
export async function resolveImplementationRoot(db: Database, identity: SaneIdentity): Promise<string> {
  const binding = getWorkstreamImplementation(db, identity)
  if (!binding) return identity.repoRoot
  return (await validateImplementationWorktree(identity.repoRoot, binding.worktree_path)).worktreePath
}
