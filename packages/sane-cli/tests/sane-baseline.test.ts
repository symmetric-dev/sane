/**
 * SANE 0.2.0 M3-B: baseline record/recheck + pickup/delivery revision checks.
 *
 * - record increments revision
 * - recheck passes when fresh, fails on stale baseline
 * - pickup snapshot then delivery detects SDD change + foundation superseded
 *   + conflicting report
 */
import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  initSchema,
  openInMemoryDb,
  recordApproval,
  recordMergeCommit,
  upsertMerge,
  upsertResearchReport,
  upsertWorkstream,
  type MutationContext,
  type SaneIdentity,
} from "../src/sane-db.ts"
import { sha256Hex } from "../src/sane-hash.ts"
import {
  SaneWorkstreamStateError,
  recheckBaseline,
  recordBaselineRevision,
  recordPickupRevisions,
  verifyDeliveryFreshness,
} from "../src/sane-workstream-state.ts"
import { parseCliArguments } from "../src/sane-baseline-command.ts"

function mutation(
  role = "research",
  session = "ses_baseline_test",
  timestamp = "2026-09-16T00:00:00.000Z",
): MutationContext {
  return { actorRole: role, sessionId: session, timestamp }
}

describe("sane-baseline (M3-B record/recheck + pickup/delivery)", () => {
  let tempDirectory = ""
  let workstreamDir = ""
  let db: Database | undefined

  const identity: SaneIdentity = { repoRoot: "/repo", user: "alice", workstreamId: "01-demo" }

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-baseline-"))
    workstreamDir = join(tempDirectory, "ws")
    await mkdir(join(workstreamDir, "solutions"), { recursive: true })
    await mkdir(join(workstreamDir, "research"), { recursive: true })
    db = openInMemoryDb()
    initSchema(db)
  })

  afterEach(async () => {
    try {
      db?.close()
    } catch {
      // Best effort.
    }
    db = undefined
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
    tempDirectory = ""
  })

  test("record increments revision", () => {
    upsertWorkstream(db!, identity, { scope: "demo scope", status: "open" }, mutation())
    const first = recordBaselineRevision(db!, identity, { mutation: mutation() })
    expect(first.revision).toBe(0)
    expect(first.path).toBe("research/BASELINE.md")

    const second = recordBaselineRevision(db!, identity, { mutation: mutation() })
    expect(second.revision).toBe(1)
    expect(second.path).toBe("research/BASELINE.md")

    const third = recordBaselineRevision(db!, identity, {
      path: "research/BASELINE.md",
      mutation: mutation(),
    })
    expect(third.revision).toBe(2)
  })

  test("recheck passes when fresh", async () => {
    upsertWorkstream(db!, identity, { scope: "demo scope", status: "open" }, mutation())
    await writeFile(join(workstreamDir, "research", "BASELINE.md"), "# baseline\n")
    recordBaselineRevision(db!, identity, { mutation: mutation() })
    upsertResearchReport(
      db!,
      identity,
      { topic: "auth", baselineRev: 0, path: "research/auth/REPORT.md" },
      mutation(),
    )

    const result = await recheckBaseline(db!, identity, workstreamDir)
    expect(result.recorded?.revision).toBe(0)
    expect(result.fileExists).toBe(true)
    expect(result.reportsChecked).toBe(1)
    expect(result.staleReports).toEqual([])
    expect(result.mismatches).toEqual([])
    expect(result.ok).toBe(true)
  })

  test("fails on stale baseline", async () => {
    upsertWorkstream(db!, identity, { scope: "demo scope", status: "open" }, mutation())
    await writeFile(join(workstreamDir, "research", "BASELINE.md"), "# baseline\n")
    recordBaselineRevision(db!, identity, { mutation: mutation() })
    upsertResearchReport(
      db!,
      identity,
      { topic: "auth", baselineRev: 0, path: "research/auth/REPORT.md" },
      mutation(),
    )

    const fresh = await recheckBaseline(db!, identity, workstreamDir)
    expect(fresh.ok).toBe(true)

    // Support track bumps the baseline without rewriting the old report.
    recordBaselineRevision(db!, identity, { mutation: mutation() })

    const stale = await recheckBaseline(db!, identity, workstreamDir)
    expect(stale.recorded?.revision).toBe(1)
    expect(stale.ok).toBe(false)
    expect(stale.staleReports).toEqual([{ topic: "auth", baselineRev: 0, recordedRev: 1 }])
    expect(stale.mismatches.length).toBeGreaterThan(0)
    expect(stale.mismatches.join("\n")).toContain('"auth"')
  })

  test("pickup snapshot then delivery detects SDD change + foundation superseded + conflicting report", async () => {
    const foundation: SaneIdentity = {
      repoRoot: "/repo",
      user: "alice",
      workstreamId: "00-foundation",
    }
    upsertWorkstream(db!, foundation, { scope: "foundation scope", status: "open" }, mutation())
    upsertMerge(
      db!,
      foundation,
      { branch: "sane/alice/00-foundation", baseRev: "base1", mergeCommit: "commit-a" },
      mutation(),
    )
    upsertWorkstream(
      db!,
      identity,
      { scope: "demo scope", status: "open", foundationRev: "00-foundation@commit-a" },
      mutation(),
    )

    await writeFile(join(workstreamDir, "SDD.md"), "sdd v1\n")
    await writeFile(join(workstreamDir, "solutions", "api.md"), "solution v1\n")
    await writeFile(join(workstreamDir, "research", "BASELINE.md"), "# baseline v1\n")
    recordBaselineRevision(db!, identity, { mutation: mutation() })
    upsertResearchReport(
      db!,
      identity,
      { topic: "auth", baselineRev: 0, path: "research/auth/REPORT.md" },
      mutation(),
    )
    const sddHash = sha256Hex("sdd v1\n")
    recordApproval(
      db!,
      identity,
      {
        gate: "root-plus-sdd",
        artifactPath: "SDD.md",
        saneHash: sddHash,
        approvalRef: "user-ok-sdd",
      },
      { actorRole: "user", sessionId: "ses_user" },
    )
    recordApproval(
      db!,
      identity,
      {
        gate: "solutions",
        artifactPath: "solutions/api.md",
        saneHash: sha256Hex("solution v1\n"),
        approvalRef: "user-ok-solutions",
      },
      { actorRole: "user", sessionId: "ses_user" },
    )

    const sidecarPath = join(workstreamDir, ".sane-pickup.json")
    const snapshot = await recordPickupRevisions(db!, identity, workstreamDir, { sidecarPath })
    expect(snapshot.baselineRev).toBe(0)
    expect(snapshot.sddHash).toBe(sddHash)
    expect(snapshot.foundationRev).toBe("00-foundation@commit-a")
    expect(snapshot.foundationMergeCommit).toBe("commit-a")
    expect(snapshot.reports).toEqual([
      { topic: "auth", baselineRev: 0, path: "research/auth/REPORT.md" },
    ])
    // Sidecar is durable JSON.
    const onDisk = JSON.parse(await readFile(sidecarPath, "utf8"))
    expect(onDisk.baselineRev).toBe(0)
    expect(onDisk.sddHash).toBe(sddHash)

    // Fresh delivery passes, including via the sidecar path.
    const fresh = await verifyDeliveryFreshness(db!, identity, workstreamDir, snapshot, {
      throwOnMismatch: false,
    })
    expect(fresh.ok).toBe(true)
    expect(fresh.mismatches).toEqual([])
    const freshViaPath = await verifyDeliveryFreshness(db!, identity, workstreamDir, sidecarPath, {
      throwOnMismatch: false,
    })
    expect(freshViaPath.ok).toBe(true)

    // Mutate all three consumed inputs: SDD bytes, foundation merge commit,
    // and a late conflicting research report.
    await writeFile(join(workstreamDir, "SDD.md"), "sdd v2 changed\n")
    recordMergeCommit(db!, foundation, "commit-b", mutation())
    upsertResearchReport(
      db!,
      identity,
      { topic: "late-topic", baselineRev: 0, path: "research/late-topic/REPORT.md" },
      mutation(),
    )

    const stale = await verifyDeliveryFreshness(db!, identity, workstreamDir, snapshot, {
      throwOnMismatch: false,
    })
    expect(stale.ok).toBe(false)
    const kinds = stale.mismatches.map((entry) => entry.kind)
    expect(kinds).toContain("sdd")
    expect(kinds).toContain("foundation")
    expect(kinds).toContain("research")
    const joined = stale.mismatches.map((entry) => `[${entry.kind}] ${entry.message}`).join("\n")
    expect(joined).toContain("SDD.md")
    expect(joined).toContain("superseded")
    expect(joined).toContain('"late-topic"')

    // Default mode throws instead of silently delivering stale.
    await expect(
      verifyDeliveryFreshness(db!, identity, workstreamDir, snapshot),
    ).rejects.toThrow(SaneWorkstreamStateError)
    await expect(
      verifyDeliveryFreshness(db!, identity, workstreamDir, snapshot),
    ).rejects.toThrow(/Delivery blocked/)
  })

  test("baseline CLI parses --record|--recheck with --topic/--baseline-rev/--json/--repo-root idioms", () => {
    expect(parseCliArguments(["my-ws", "--record"])).toMatchObject({
      workstreamPath: "my-ws",
      mode: "record",
      json: false,
    })
    expect(
      parseCliArguments(["/repo", "my-ws", "--recheck", "--json"]).mode,
    ).toBe("recheck")
    expect(
      parseCliArguments(["my-ws", "--recheck", "--topic", "auth", "--baseline-rev", "2"]),
    ).toMatchObject({ topic: "auth", baselineRev: 2, mode: "recheck" })
    expect(
      parseCliArguments(["--repo-root", "/repo", "my-ws", "--record", "--topic", "auth"]),
    ).toMatchObject({
      implementationRepository: "/repo",
      workstreamPath: "my-ws",
      mode: "record",
      topic: "auth",
    })
    expect(() => parseCliArguments(["my-ws"])).toThrow(/--record.*--recheck/)
    expect(() => parseCliArguments(["my-ws", "--record", "--recheck"])).toThrow(
      /exactly one/,
    )
    expect(() => parseCliArguments(["my-ws", "--record", "--baseline-rev", "1"])).toThrow(
      /--topic/,
    )
    expect(() => parseCliArguments(["my-ws", "--recheck", "--baseline-rev", "nope"])).toThrow(
      /integer/,
    )
  })
})
