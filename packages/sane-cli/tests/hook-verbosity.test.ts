import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverRepository, initializeRepository, normalizeNativeSource, openRepositoryDomain } from "../../sane-core/src/server.ts"
import { linkNativeCaller, nativeCallerEnvelope, nativeCallerReference, nativeShellCaller, openCompactCaller, type NativeCaller } from "../src/native-caller.ts"
import { classifyCaller } from "../src/cli-arguments.ts"
import { executeCliCommand } from "../src/cli-command.ts"

// Enrolled shell callers use compact references; bootstrap envelopes are a
// separate contract. This is a payload budget, not a copied hook formatter.
const REFERENCE_BUDGET = 200

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

describe("shell-hook caller reference verbosity", () => {
  test("enrolled shell reference is compact and round-trips with session checks", () => {
    const root = mkdtempSync(join(tmpdir(), "sane-t-hook-"))
    try {
      const { caller } = seedRepo(root)
      linkNativeCaller(caller, { slot: "design", workstream: "native" })
      const reference = nativeShellCaller(caller)
      expect(reference).toEqual(nativeCallerReference(caller))
      const payload = JSON.stringify(reference)
      expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(REFERENCE_BUDGET)
      expect(payload).not.toContain("/")
      expect(payload).not.toMatch(/[a-f0-9]{64}/)
      expect(payload).not.toContain("authority")
      const parsed = JSON.parse(payload)
      expect(parsed).toEqual({ version: 1, harness: "cc", nativeId: caller.nativeId })
      expect(classifyCaller({ SANE_CALLER_CONTEXT: payload })).toEqual({ actorKind: "native-ref", ref: { version: 1, harness: "cc", nativeId: caller.nativeId } })
      expect(classifyCaller({ SANE_CALLER_CONTEXT: payload, SANE_SESSION_ID: caller.nativeId })).toMatchObject({ actorKind: "native-ref" })
      expect(() => classifyCaller({ SANE_CALLER_CONTEXT: payload, SANE_SESSION_ID: "different" })).toThrow()
      expect(() => classifyCaller({ SANE_CALLER_CONTEXT: payload, OPENCODE_SESSION_ID: caller.nativeId })).toThrow()
      // Full envelope stays accepted for MCP/explicit-flag compatibility.
      const full = JSON.stringify(nativeCallerEnvelope(caller))
      expect(classifyCaller({ SANE_CALLER_CONTEXT: full }).actorKind).toBe("native")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("compact reference resolves server-side and drives CLI qualification", async () => {
    const root = mkdtempSync(join(tmpdir(), "sane-t-hook-"))
    try {
      const { repo, caller } = seedRepo(root)
      linkNativeCaller(caller, { slot: "design", workstream: "native" })
      const ref = nativeCallerReference(caller)
      const resolved = openCompactCaller(ref.harness, ref.nativeId, repo)
      try {
        expect(resolved.ref).toEqual({ harness: "cc", authorityId: caller.authorityId, nativeId: caller.nativeId })
        expect(resolved.context.workstream?.id).toBe("native")
      } finally { resolved.domain.close() }
      const status = await executeCliCommand(["status", "--verbose"], { signals: { SANE_CALLER_CONTEXT: JSON.stringify(ref) }, cwd: repo }) as { workstream: { id: string } }
      expect(status.workstream.id).toBe("native")
      expect(() => openCompactCaller(ref.harness, crypto.randomUUID(), repo)).toThrow("not enrolled")
      const other = join(root, "other")
      mkdirSync(other)
      execFileSync("git", ["-C", other, "init"], { stdio: "pipe" })
      expect(() => openCompactCaller(ref.harness, ref.nativeId, other)).toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
