/**
 * C11 Phase 3 — CLI compact default output budgets.
 *
 * Default CLI output is compact pretty lines (a few per op); full evidence
 * moves behind --verbose (pretty JSON) / --json (single-line JSON) with
 * unbounded arrays capped at EVIDENCE_LIST_CAP + truncated/total flags.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeCliCommand, runCliCommand } from "../src/cli-command.ts"
import { EVIDENCE_LIST_CAP, capEvidence } from "../src/cli-verbosity.ts"
import { discoverRepository, inspectRepositoryStore, normalizeNativeSource, openRepositoryDomain } from "../../sane-core/src/server.ts"
import type { MutationContext } from "../../sane-core/src/contracts.ts"

const mutation: MutationContext = { actor: { kind: "local" }, correlationId: "c11-cli-verbosity" }
const PLAN = "# Plan\n## Execution Checkpoints\n| Checkpoint | After job(s) |\n| --- | --- |\n| Checkpoint 1 | 01 |\n"
const JOB_A = "# Job Spec 01: first\nWork.\n"

let temporary = ""
let repo = ""
const cli = (args: string[]) => executeCliCommand(args, { cwd: repo, signals: {} })
async function printed(args: string[]): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = []
  const code = await runCliCommand(args, { cwd: repo, signals: {}, write: (line) => lines.push(line), error: (line) => lines.push(line) })
  return { lines, code }
}
const bytes = (lines: string[]) => Buffer.byteLength(lines.join("\n"), "utf8")

function write(path: string, content: string): void {
  const discovery = discoverRepository(repo)
  const state = inspectRepositoryStore(discovery)
  if (state.state !== "ready") throw new Error(state.message)
  const domain = openRepositoryDomain(state.context)
  try {
    domain.writeArtifact("demo", path, content, mutation)
  } finally {
    domain.close()
  }
}

beforeEach(async () => {
  temporary = realpathSync(await mkdtemp(join(tmpdir(), "sane-c11-cli-")))
  repo = join(temporary, "repo")
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "-c", "user.name=C11 Test", "-c", "user.email=c11@example.invalid", "commit", "--allow-empty", "-qm", "fixture"])
  await cli(["init"])
  await cli(["create", "--name", "demo", "--type", "feature", "--title", "Demo"])
})

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true })
})

describe("C11 Phase 3: compact default output budgets", () => {
  test("view/status default to a few short lines with id, status and next step", async () => {
    for (const op of ["view", "status", "detail"]) {
      const { lines, code } = await printed([op, "--workstream", "demo"])
      expect(code).toBe(0)
      expect(lines.length).toBeLessThanOrEqual(4)
      expect(bytes(lines)).toBeLessThanOrEqual(1500)
      expect(lines[0]).toContain("demo")
      expect(lines.join("\n")).toContain("phases:")
      expect(lines.join("\n")).toContain("next:")
    }
  })

  test("default view projection stays small and drops full evidence keys", async () => {
    const compact = (await cli(["view", "--workstream", "demo"])) as any
    expect(compact.workstream).toBe("demo")
    expect(compact.next).toContain("sane approve")
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThanOrEqual(1500)
    for (const heavy of ["audit", "lifecycle", "research", "manifest"]) expect(compact).not.toHaveProperty(heavy)
    expect(typeof compact.conversations).toBe("number")
    expect(typeof compact.auditTotal).toBe("number")
  })

  test("approve default prints Approved + hash lines, not full evidence", async () => {
    write("PRD.md", "# Direction\n")
    write("design/SDD.md", "# Design\n")
    const { lines, code } = await printed(["approve", "design", "--ref", "owner", "--workstream", "demo"])
    expect(code).toBe(0)
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(lines[0]).toMatch(/^Approved design for demo/)
    expect(lines.join("\n")).toMatch(/hash [0-9a-f]{64}/)
    expect(bytes(lines)).toBeLessThanOrEqual(1000)
  })

  test("validate default prints ok/FAILED with bounded problem lines", async () => {
    const { lines, code } = await printed(["validate", "design", "--workstream", "demo"])
    expect(code).toBe(1)
    expect(lines.length).toBeLessThanOrEqual(20)
    expect(lines[0]).toContain("FAILED")
    expect(lines.join("\n")).toContain("next:")
    expect(bytes(lines)).toBeLessThanOrEqual(3000)
  })

  test("job register/context defaults stay within a few lines", async () => {
    write("execution/PLAN.md", PLAN)
    write("execution/jobs/01-first.md", JOB_A)
    write("execution/verification/checkpoint-1.md", "# Verify\n")
    await cli(["approve", "planning", "--ref", "owner", "--workstream", "demo"])
    const registered = await printed(["job", "--register", "--workstream", "demo"])
    expect(registered.code).toBe(0)
    expect(registered.lines.length).toBeLessThanOrEqual(8)
    expect(registered.lines[0]).toContain("Registered")
    const context = await printed(["job", "01", "--workstream", "demo"])
    expect(context.code).toBe(0)
    expect(context.lines.length).toBeLessThanOrEqual(4)
    expect(context.lines[0]).toMatch(/^job 01 \[/)
    expect(context.lines.join("\n")).toContain("next:")
  })

  test("sessions default stays within a bounded line count", async () => {
    const profile = join(temporary, "profile")
    mkdirSync(profile)
    const source = normalizeNativeSource({ version: 1, harness: "cc", kind: "local-profile", profileRoot: profile })
    const discovery = discoverRepository(repo)
    const state = inspectRepositoryStore(discovery)
    if (state.state !== "ready") throw new Error(state.message)
    const domain = openRepositoryDomain(state.context)
    try {
      domain.declareNativeAuthority({ version: 1, harness: "cc", kind: "local-profile", profileRoot: profile }, mutation)
      for (const nativeId of ["session-a", "session-b"]) {
        domain.registerConversation({ ref: { harness: "cc", authorityId: source.authorityId, nativeId }, executionCheckout: repo, parent: null }, mutation)
      }
    } finally {
      domain.close()
    }
    const { lines, code } = await printed(["sessions"])
    expect(code).toBe(0)
    expect(lines.length).toBeLessThanOrEqual(2 * EVIDENCE_LIST_CAP + 2)
    expect(lines[0]).toContain("2 conversations")
  })
})

describe("C11 Phase 3: verbose/json full evidence with capped arrays", () => {
  test("verbose returns full shapes; json returns single-line full JSON", async () => {
    const { lines: verbose } = await printed(["status", "--workstream", "demo", "--verbose"])
    const pretty = verbose.join("\n").split("\n")
    expect(pretty.length).toBeGreaterThan(1)
    const full = JSON.parse(verbose.join("\n")) as any
    expect(full.workstream.lifecycle.phases).toBeDefined()
    expect(Array.isArray(full.audit)).toBe(true)
    const { lines: single } = await printed(["status", "--workstream", "demo", "--json"])
    expect(single).toHaveLength(1)
    expect(JSON.parse(single[0]!) as any).toMatchObject({ workstream: full.workstream })
  })

  test("verbose validate carries manifest/fileHashes; verbose job context keeps approval evidence", async () => {
    write("execution/PLAN.md", PLAN)
    write("execution/jobs/01-first.md", JOB_A)
    write("execution/verification/checkpoint-1.md", "# Verify\n")
    await cli(["approve", "planning", "--ref", "owner", "--workstream", "demo"])
    const validation = (await cli(["validate", "planning", "--workstream", "demo", "--verbose"])) as any
    expect(Array.isArray(validation.manifest)).toBe(true)
    expect(Array.isArray(validation.fileHashes)).toBe(true)
    const context = (await cli(["job", "01", "--workstream", "demo", "--verbose"])) as any
    expect(context.planningApproval).not.toBeNull()
    expect(Array.isArray(context.supportingDocuments)).toBe(true)
  })

  test("large audit fixtures truncate verbose arrays with flags; default stays small", async () => {
    const discovery = discoverRepository(repo)
    const state = inspectRepositoryStore(discovery)
    if (state.state !== "ready") throw new Error(state.message)
    const domain = openRepositoryDomain(state.context)
    try {
      for (let i = 0; i < 30; i++) domain.writeArtifact("demo", `research/note-${i}.md`, `# Note ${i}\n`, mutation)
    } finally {
      domain.close()
    }
    const full = (await cli(["status", "--workstream", "demo", "--verbose"])) as any
    expect(full.auditTotal).toBeGreaterThan(EVIDENCE_LIST_CAP)
    expect(full.auditTruncated).toBe(true)
    expect(full.audit).toHaveLength(EVIDENCE_LIST_CAP)
    const { lines } = await printed(["status", "--workstream", "demo"])
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(bytes(lines)).toBeLessThanOrEqual(1500)
  }, 30000)

  test("capEvidence bounds arrays, flags truncation, and keeps the most recent audit events", () => {
    expect(EVIDENCE_LIST_CAP).toBe(50)
    const exact = capEvidence({ items: Array.from({ length: 50 }, (_, i) => i) }) as any
    expect(exact.items).toHaveLength(50)
    expect(exact).not.toHaveProperty("itemsTruncated")
    const over = capEvidence({ items: Array.from({ length: 60 }, (_, i) => i) }) as any
    expect(over.items).toHaveLength(50)
    expect(over.itemsTruncated).toBe(true)
    expect(over.itemsTotal).toBe(60)
    const audit = capEvidence({ audit: Array.from({ length: 60 }, (_, i) => ({ id: i + 1 })) }) as any
    expect(audit.audit.map((e: any) => e.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 11))
    expect(audit.auditTruncated).toBe(true)
    expect(audit.auditTotal).toBe(60)
    const nested = capEvidence({ workstream: { lifecycle: { approvals: Array.from({ length: 55 }, (_, i) => i) } } }) as any
    expect(nested.workstream.lifecycle.approvals).toHaveLength(50)
    expect(nested.workstream.lifecycle.approvalsTruncated).toBe(true)
  })
})
