import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverRepository, initializeRepository, normalizeNativeSource, openRepositoryDomain } from "../../sane-core/src/server.ts"
import { linkNativeCaller, nativeCallerEnvelope, nativeCallerReference, openCompactCaller, type NativeCaller } from "../src/native-caller.ts"
import { classifyCaller } from "../src/cli-arguments.ts"
import { executeCliCommand } from "../src/cli-command.ts"

// C11 Phase 4: per-shell-call hook prefix carries only the compact caller
// reference. Budget: export line stays ≤200B beyond the unset lines.
const EXPORT_BUDGET = 200
const UNSET_LINE = "unset SANE_SESSION_ID OPENCODE_SESSION_ID\n"

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

/** Same construction as both shell-hook transports (OC plugin + Claude hook). */
function hookPrefix(payload: string, command: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  return `export SANE_CALLER_CONTEXT=${quote(payload)}\n${UNSET_LINE}${command}`
}

describe("C11 Phase 4: shell-hook caller reference verbosity", () => {
  test("hook prefix fits budget, carries harness + nativeId, drops paths and authority", () => {
    const root = mkdtempSync(join(tmpdir(), "sane-c11-hook-"))
    try {
      const { repo, caller } = seedRepo(root)
      linkNativeCaller(caller, { slot: "design", workstream: "native" })
      const payload = JSON.stringify(nativeCallerReference(caller))
      const prefix = hookPrefix(payload, "sane status")
      const exportLine = prefix.slice(0, prefix.indexOf(UNSET_LINE))
      expect(Buffer.byteLength(exportLine, "utf8")).toBeLessThanOrEqual(EXPORT_BUDGET)
      expect(prefix).toContain(UNSET_LINE)
      expect(payload).not.toContain("/")
      expect(payload).not.toMatch(/[a-f0-9]{64}/)
      expect(payload).not.toContain("authority")
      const parsed = JSON.parse(payload)
      expect(parsed).toEqual({ version: 1, harness: "cc", nativeId: caller.nativeId })
      expect(repo.length).toBeGreaterThan(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("compact reference round-trips through classifyCaller with session checks", () => {
    const root = mkdtempSync(join(tmpdir(), "sane-c11-hook-"))
    try {
      const { caller } = seedRepo(root)
      linkNativeCaller(caller, { slot: "design", workstream: "native" })
      const payload = JSON.stringify(nativeCallerReference(caller))
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
    const root = mkdtempSync(join(tmpdir(), "sane-c11-hook-"))
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
