import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverRepository, initializeRepository, openRepositoryDomain } from "../src/server.ts"
import type { MutationContext } from "../src/contracts.ts"
export const mutation: MutationContext = { actor: { kind: "local" }, correlationId: "core-test" }
export function git(path: string, ...args: string[]) { return execFileSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: "pipe" }).trim() }
export function fixture(linked = false) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "opencode/sane-core-")))
  const repo = join(temporary, "repo"); mkdirSync(repo); git(repo, "init", "-q")
  git(repo, "-c", "user.name=Core Test", "-c", "user.email=core@example.invalid", "commit", "--allow-empty", "-qm", "fixture")
  const checkout = linked ? join(temporary, "linked") : repo
  if (linked) git(repo, "worktree", "add", "--detach", checkout)
  const context = initializeRepository(discoverRepository(checkout)), domain = openRepositoryDomain(context)
  const profile = join(temporary, "profile"); mkdirSync(profile)
  const authority = domain.declareNativeAuthority({ version: 1, harness: "cc", kind: "local-profile", profileRoot: profile }, mutation)
  const ref = (nativeId: string) => ({ harness: "cc" as const, authorityId: authority.authorityId, nativeId })
  return { temporary, repo, checkout, context, domain, profile, authority, ref, stateRoot: context.stateRoot, cleanup: () => { domain.close(); rmSync(temporary, { recursive: true, force: true }) } }
}
