import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverRepository, initializeRepository, normalizeNativeSource, openRepositoryDomain } from "../../sane-core/src/server.ts"
import { linkNativeCaller, nativeCallerContext, type NativeCaller } from "../src/native-caller.ts"

const BUDGET = 600

function seedRepo(root: string): { repo: string; caller: NativeCaller } {
  const repo = join(root, "repo"), profile = join(root, "profile")
  for (const path of [repo, profile]) mkdirSync(path)
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" })
  git("init")
  git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "initial")
  const domain = openRepositoryDomain(initializeRepository(discoverRepository(repo)))
  try { domain.createWorkstream({ id: "native", title: "Native", type: "feature" }, { actor: { kind: "local" }, correlationId: crypto.randomUUID() }) } finally { domain.close() }
  const source = normalizeNativeSource({ version: 1, harness: "cc", kind: "local-profile", profileRoot: profile })
  const caller: NativeCaller = { source: source.descriptor, authorityId: source.authorityId, nativeId: crypto.randomUUID(), cwd: repo, ancestors: [], correlationId: crypto.randomUUID() }
  return { repo, caller }
}

describe("context/link verbosity", () => {
  test("link and subsequent context replies fit the budget and retain compact identity", () => {
    const root = mkdtempSync(join(tmpdir(), "sane-t-"))
    try {
      const { caller } = seedRepo(root)
      const linked = linkNativeCaller(caller, { slot: "engineering", workstream: "native" })
      expect(linked.phase).toBe("engineering")
      for (const reply of [linked, nativeCallerContext(caller)]) {
        const text = JSON.stringify(reply)
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(BUDGET)
        expect(reply.workstream).toBe("native")
        expect(reply.harness).toBe("cc")
        expect(text).toContain("native")
        expect(text).toContain("cc")
        expect(reply.context).toContain("Workstream root: ")
        expect(reply.context).toContain("Implementation root: ")
        for (const heavy of ["assignment", "caller", "conversation", "lifecycle", "repositoryId", "authorityId", "nativeId", "executionCheckout", "artifactsRoot"]) expect(reply).not.toHaveProperty(heavy)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
