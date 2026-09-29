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

describe("C11 Phase 1: context/link verbosity", () => {
  test("context reply fits the per-turn budget and carries workstream id + harness", () => {
    const root = mkdtempSync(join(tmpdir(), "sane-c11-"))
    try {
      const { caller } = seedRepo(root)
      linkNativeCaller(caller, { slot: "design", workstream: "native" })
      const reply = nativeCallerContext(caller)
      const bytes = Buffer.byteLength(JSON.stringify(reply), "utf8")
      expect(bytes).toBeLessThanOrEqual(BUDGET)
      expect(reply.workstream).toBe("native")
      expect(reply.harness).toBe("cc")
      const text = JSON.stringify(reply)
      expect(text).toContain("native")
      expect(text).toContain("cc")
      expect(reply.context).toContain("Artifacts root: ")
      expect(reply.context).toContain("Implementation root: ")
      for (const heavy of ["assignment", "caller", "conversation", "lifecycle", "repositoryId", "authorityId", "nativeId", "executionCheckout", "artifactsRoot"]) expect(reply).not.toHaveProperty(heavy)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("link reply fits the per-turn budget and carries workstream id + harness", () => {
    const root = mkdtempSync(join(tmpdir(), "sane-c11-"))
    try {
      const { caller } = seedRepo(root)
      const reply = linkNativeCaller(caller, { slot: "engineering", workstream: "native" })
      const bytes = Buffer.byteLength(JSON.stringify(reply), "utf8")
      expect(bytes).toBeLessThanOrEqual(BUDGET)
      expect(reply.workstream).toBe("native")
      expect(reply.harness).toBe("cc")
      expect(reply.phase).toBe("engineering")
      const text = JSON.stringify(reply)
      expect(text).toContain("native")
      expect(text).toContain("cc")
      expect(reply.context).toContain("Artifacts root: ")
      expect(reply.context).toContain("Implementation root: ")
      for (const heavy of ["assignment", "caller", "conversation", "lifecycle", "repositoryId", "authorityId", "nativeId", "executionCheckout", "artifactsRoot"]) expect(reply).not.toHaveProperty(heavy)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
