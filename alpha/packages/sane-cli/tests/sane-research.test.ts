/**
 * SANE research index: append-only `research_reports` registry plus
 * `sane research --index|--register|--unregister`, pickup snapshot,
 * and delivery freshness over report hashes.
 */
import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import type { Database } from "bun:sqlite"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"

import {
  getResearchReport,
  initSchema,
  listResearchReports,
  openInMemoryDb,
  recordApproval,
  registerResearchReport,
  upsertWorkstream,
  type MutationContext,
  type SaneIdentity,
} from "../src/sane-db.ts"
import { sha256Hex } from "../src/sane-hash.ts"
import {
  SaneWorkstreamStateError,
  recheckResearchIndex,
  recordPickupRevisions,
  verifyDeliveryFreshness,
} from "../src/sane-workstream-state.ts"
import {
  parseCliArguments,
  runSaneResearchCommand,
} from "../src/sane-research-command.ts"
import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"

const execFileAsync = promisify(execFileCallback)

function mutation(
  role = "research",
  session = "ses_research_test",
  timestamp = "2026-09-16T00:00:00.000Z",
): MutationContext {
  return { actorRole: role, sessionId: session, timestamp }
}

describe("research registry (db + index check)", () => {
  let tempDirectory = ""
  let workstreamDir = ""
  let db: Database | undefined

  const identity: SaneIdentity = { repoRoot: "/repo", user: "alice", workstreamId: "01-demo" }

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-research-"))
    workstreamDir = join(tempDirectory, "ws")
    await mkdir(join(workstreamDir, "design", "solutions"), { recursive: true })
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

  test("register upserts rows and recheck flags missing, modified, and unregistered files", async () => {
    upsertWorkstream(db!, identity, { type: "feature", status: "open" }, mutation())
    await mkdir(join(workstreamDir, "research", "auth"), { recursive: true })
    await writeFile(join(workstreamDir, "research", "auth", "REPORT.md"), "auth evidence\n")
    const row = registerResearchReport(
      db!,
      identity,
      {
        topic: "auth",
        path: "research/auth/REPORT.md",
        createdAt: "2026-09-16T00:00:00.000Z",
        saneHash: sha256Hex("auth evidence\n"),
        gitCommit: "abc123",
      },
      mutation(),
    )
    expect(row.topic).toBe("auth")
    expect(getResearchReport(db!, identity, "auth")?.git_commit).toBe("abc123")

    // Re-register refreshes the row.
    await writeFile(join(workstreamDir, "research", "auth", "REPORT.md"), "auth evidence v2\n")
    registerResearchReport(
      db!,
      identity,
      {
        topic: "auth",
        path: "research/auth/REPORT.md",
        createdAt: "2026-09-17T00:00:00.000Z",
        saneHash: sha256Hex("auth evidence v2\n"),
      },
      mutation(),
    )
    expect(getResearchReport(db!, identity, "auth")?.sane_hash).toBe(sha256Hex("auth evidence v2\n"))

    // Edited after registration is a mismatch.
    await writeFile(join(workstreamDir, "research", "auth", "REPORT.md"), "auth evidence v3\n")
    await mkdir(join(workstreamDir, "research", "stray"), { recursive: true })
    await writeFile(join(workstreamDir, "research", "stray", "REPORT.md"), "never registered\n")
    const checked = await recheckResearchIndex(db!, identity, workstreamDir)
    expect(checked.ok).toBe(false)
    expect(checked.mismatches.join("\n")).toContain("edited after registration")
    expect(checked.unregisteredFiles).toEqual(["research/stray/REPORT.md"])
    expect(checked.mismatches.join("\n")).toContain("not registered")
  })

  test("missing registered files are mismatches", async () => {
    upsertWorkstream(db!, identity, { type: "feature", status: "open" }, mutation())
    registerResearchReport(
      db!,
      identity,
      {
        topic: "gone",
        path: "research/gone/REPORT.md",
        createdAt: "2026-09-16T00:00:00.000Z",
        saneHash: sha256Hex("x\n"),
      },
      mutation(),
    )
    const checked = await recheckResearchIndex(db!, identity, workstreamDir)
    expect(checked.ok).toBe(false)
    expect(checked.reports).toEqual([
      {
        topic: "gone",
        path: "research/gone/REPORT.md",
        registeredHash: sha256Hex("x\n"),
        currentHash: null,
        fileExists: false,
      },
    ])
  })

  test("legacy baseline databases migrate to the registry shape", () => {
    const legacy = openInMemoryDb()
    try {
      legacy.exec(`
CREATE TABLE baselines(
  repo_root TEXT NOT NULL, user TEXT NOT NULL, workstream_id TEXT NOT NULL,
  revision INTEGER NOT NULL, path TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id));
CREATE TABLE research_reports(
  repo_root TEXT NOT NULL, user TEXT NOT NULL, workstream_id TEXT NOT NULL,
  topic TEXT NOT NULL, baseline_rev INTEGER NOT NULL, path TEXT NOT NULL,
  PRIMARY KEY (repo_root, user, workstream_id, topic));
INSERT INTO baselines VALUES ('/repo', 'alice', '01-demo', 2, 'research/BASELINE.md');
INSERT INTO research_reports VALUES ('/repo', 'alice', '01-demo', 'auth', 2, 'research/auth/REPORT.md');
`)
      initSchema(legacy)
      const tables = legacy
        .query(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as Array<{ name: string }>
      expect(tables.map((row) => row.name)).not.toContain("baselines")
      const migrated = getResearchReport(legacy, identity, "auth")
      expect(migrated?.path).toBe("research/auth/REPORT.md")
      expect(migrated?.sane_hash).toBe("")
      expect(listResearchReports(legacy, identity)).toHaveLength(1)
    } finally {
      try {
        legacy.close()
      } catch {
        // Best effort.
      }
    }
  })

  test("pickup snapshot then delivery detects new, edited, and removed reports", async () => {
    upsertWorkstream(db!, identity, { type: "feature", status: "open" }, mutation())
    await writeFile(join(workstreamDir, "design", "SDD.md"), "sdd v1\n")
    await mkdir(join(workstreamDir, "research", "auth"), { recursive: true })
    await writeFile(join(workstreamDir, "research", "auth", "REPORT.md"), "auth v1\n")
    registerResearchReport(
      db!,
      identity,
      {
        topic: "auth",
        path: "research/auth/REPORT.md",
        createdAt: "2026-09-16T00:00:00.000Z",
        saneHash: sha256Hex("auth v1\n"),
      },
      mutation(),
    )
    recordApproval(
      db!,
      identity,
      {
        phase: "design",
        artifactPath: "design/SDD.md",
        saneHash: sha256Hex("sdd v1\n"),
        approvalRef: "user-ok-sdd",
      },
      { actorRole: "user", sessionId: "ses_user" },
    )

    const snapshot = await recordPickupRevisions(db!, identity, workstreamDir)
    expect(snapshot.reports).toEqual([
      {
        topic: "auth",
        path: "research/auth/REPORT.md",
        registeredHash: sha256Hex("auth v1\n"),
        currentHash: sha256Hex("auth v1\n"),
      },
    ])
    expect(snapshot).not.toHaveProperty("baselineRev")

    // Edited after registration + brand-new topic both conflict at delivery.
    await writeFile(join(workstreamDir, "research", "auth", "REPORT.md"), "auth v2\n")
    await mkdir(join(workstreamDir, "research", "late"), { recursive: true })
    await writeFile(join(workstreamDir, "research", "late", "REPORT.md"), "late evidence\n")
    const fresh = await verifyDeliveryFreshness(db!, identity, workstreamDir, snapshot, {
      throwOnMismatch: false,
    })
    expect(fresh.ok).toBe(false)
    const messages = fresh.mismatches.map((entry) => entry.message).join("\n")
    expect(messages).toContain('"auth"')
    expect(messages).toContain("research/late/REPORT.md")
    expect(fresh.mismatches.every((entry) => entry.kind === "research")).toBe(true)
  })

  test("delivery is clean when nothing changed", async () => {
    upsertWorkstream(db!, identity, { type: "feature", status: "open" }, mutation())
    await writeFile(join(workstreamDir, "design", "SDD.md"), "sdd v1\n")
    const snapshot = await recordPickupRevisions(db!, identity, workstreamDir)
    const fresh = await verifyDeliveryFreshness(db!, identity, workstreamDir, snapshot, {
      throwOnMismatch: false,
    })
    expect(fresh.ok).toBe(true)
  })
})

describe("sane research command", () => {
  let tempDirectory = ""
  let implementationRepository = ""

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-research-cli-"))
    implementationRepository = join(tempDirectory, "repo")
    await mkdir(implementationRepository, { recursive: true })
    await execFileAsync("git", ["init", "--quiet", implementationRepository])
    await initializeSaneRepository({ implementationRepository, write: () => {} })
    await createSaneRepositoryWorkstream({
      implementationRepository,
      workstreamPath: "01-demo",
      type: "feature",
      write: () => {},
    })
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  async function writeReport(topic: string, content: string): Promise<string> {
    const dir = join(implementationRepository, ".sane", "workstreams", "01-demo", "research", topic)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "REPORT.md"), content)
    return `research/${topic}/REPORT.md`
  }

  test("parses modes and rejects bad option combinations", () => {
    expect(parseCliArguments(["r", "w"]).mode).toBe("index")
    expect(parseCliArguments(["r", "w", "--index"]).mode).toBe("index")
    expect(parseCliArguments(["r", "w", "--register", "--topic", "t"]).mode).toBe("register")
    expect(parseCliArguments(["r", "w", "--unregister", "--topic", "t"]).mode).toBe("unregister")
    expect(() => parseCliArguments(["r", "w", "--register"])).toThrow("--topic")
    expect(() => parseCliArguments(["r", "w", "--unregister"])).toThrow("--topic")
    expect(() => parseCliArguments(["r", "w", "--index", "--register", "--topic", "t"])).toThrow(
      "at most one",
    )
    expect(() => parseCliArguments(["r", "w", "--path", "x.md"])).toThrow("--register")
    expect(() => parseCliArguments(["r", "w", "--unknown"])).toThrow("Unknown option")
  })

  test("register, index, and unregister round-trip with hashes", async () => {
    await writeReport("auth", "auth evidence\n")
    const registered: string[] = []
    await runSaneResearchCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      mode: "register",
      topic: "auth",
      gitCommit: "commit-1",
      write: (line) => registered.push(line),
    })
    expect(registered.join("\n")).toContain('"auth"')

    const indexed: string[] = []
    await runSaneResearchCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      mode: "index",
      write: (line) => indexed.push(line),
    })
    const table = indexed.join("\n")
    expect(table).toContain("research index: 01-demo (1 report(s))")
    expect(table).toContain("research/auth/REPORT.md")
    expect(table).toContain(sha256Hex("auth evidence\n").slice(0, 12))
    expect(table).toContain("| ok |")

    const unregistered: string[] = []
    await runSaneResearchCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      mode: "unregister",
      topic: "auth",
      write: (line) => unregistered.push(line),
    })
    expect(unregistered.join("\n")).toContain('"auth"')

    const empty: string[] = []
    await runSaneResearchCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      mode: "index",
      write: (line) => empty.push(line),
    })
    expect(empty.join("\n")).toContain("(no research registered)")
    // The file is still on disk, so the index flags it as unregistered.
    expect(empty.join("\n")).toContain("unregistered report files:")
  })

  test("register rejects missing files, escapes, and unknown unregister topics", async () => {
    await expect(
      runSaneResearchCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        mode: "register",
        topic: "ghost",
        write: () => {},
      }),
    ).rejects.toThrow("Report file missing")
    await expect(
      runSaneResearchCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        mode: "register",
        topic: "evil",
        reportPath: "../../outside.md",
        write: () => {},
      }),
    ).rejects.toThrow("must stay inside the workstream")
    await expect(
      runSaneResearchCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        mode: "unregister",
        topic: "ghost",
        write: () => {},
      }),
    ).rejects.toThrow("No research report registered")
  })

  test("index JSON reports presence for each row", async () => {
    await writeReport("auth", "auth evidence\n")
    await runSaneResearchCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      mode: "register",
      topic: "auth",
      write: () => {},
    })
    const lines: string[] = []
    await runSaneResearchCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      mode: "index",
      json: true,
      write: (line) => lines.push(line),
    })
    const parsed = JSON.parse(lines.join("\n")) as {
      reports: Array<{ topic: string; sane_hash: string; status: string; file_present: boolean }>
      unregistered_files: string[]
    }
    expect(parsed.reports).toHaveLength(1)
    expect(parsed.reports[0]).toMatchObject({
      topic: "auth",
      sane_hash: sha256Hex("auth evidence\n"),
      status: "ok",
      file_present: true,
    })
    expect(parsed.unregistered_files).toEqual([])
  })
})
