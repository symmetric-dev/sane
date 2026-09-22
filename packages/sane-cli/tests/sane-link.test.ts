/**
 * SANE `sane link`: session-to-slot self-registration tests.
 *
 * - link design ok; second link to design without --force fails;
 *   with --force replaces (old row gone, count still 1)
 * - two links to engineering both kept, indexes 1 then 2 in order
 * - duplicate (slot, session) re-links in place
 * - missing --slot/--session fail; bogus slot fails; unknown option fails
 * - --json envelope parses with expected keys
 * - e2e via runCli on a tmp repo (init + create workstream first)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { initializeSaneRepository } from "../src/init-sane-repository.ts"
import { createSaneRepositoryWorkstream } from "../src/create-sane-repository-workstream.ts"
import {
  parseCliArguments,
  runCli,
  runSaneLinkCommand,
  SaneLinkError,
  USAGE,
} from "../src/sane-link-command.ts"
import {
  initSchema,
  listSelectionsBySlot,
  openInMemoryDb,
  openSaneDb,
  resolveSaneIdentity,
  type SaneIdentity,
} from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

describe("sane-link (session-to-slot self-registration)", () => {
  let db: Database | undefined
  const identity: SaneIdentity = { repoRoot: "/repo", user: "alice", workstreamId: "01-demo" }

  beforeEach(() => {
    db = openInMemoryDb()
    initSchema(db)
  })

  afterEach(() => {
    try {
      db?.close()
    } catch {
      // Best effort.
    }
    db = undefined
  })

  test("CLI parses --slot/--session with --json/--repo-root/--force idioms", () => {
    expect(USAGE).toContain("sane link")
    expect(USAGE).toContain("--slot")
    expect(USAGE).toContain("--session")
    expect(USAGE).toContain("--worktree-path")
    expect(USAGE).toContain("--branch")
    expect(USAGE).toContain("--force")
    expect(USAGE).toContain("--json")
    expect(USAGE).toContain("--repo-root")

    const parsed = parseCliArguments([
      "/repo",
      "01-demo",
      "--slot",
      "design",
      "--session",
      "ses_design_1",
      "--json",
    ])
    expect(parsed).toMatchObject({
      implementationRepository: "/repo",
      workstreamPath: "01-demo",
      slot: "design",
      sessionId: "ses_design_1",
      json: true,
      force: false,
    })

    const viaRoot = parseCliArguments([
      "--repo-root",
      "/repo",
      "01-demo",
      "--slot",
      "research:auth",
      "--session",
      "ses_r1",
    ])
    expect(viaRoot.implementationRepository).toBe("/repo")
    expect(viaRoot.slot).toBe("research:auth")
    expect(viaRoot.sessionId).toBe("ses_r1")

    const forced = parseCliArguments([
      "/repo",
      "01-demo",
      "--slot",
      "design",
      "--session",
      "ses_b",
      "--force",
    ])
    expect(forced.force).toBe(true)

    const withPaths = parseCliArguments([
      "/repo",
      "01-demo",
      "--slot",
      "engineering",
      "--session",
      "ses_e1",
      "--worktree-path",
      "/wt/opencode-managed/01-demo",
      "--branch",
      "opencode/some-branch",
    ])
    expect(withPaths.worktreePath).toBe("/wt/opencode-managed/01-demo")
    expect(withPaths.branch).toBe("opencode/some-branch")
  })

  test("missing --slot/--session fail; bogus slot fails; unknown option fails", () => {
    expect(() => parseCliArguments(["/repo", "01-demo", "--session", "ses_x"])).toThrow(
      /Option --slot is required\./,
    )
    expect(() => parseCliArguments(["/repo", "01-demo", "--slot", "design"])).toThrow(
      /Option --session is required\./,
    )
    expect(() =>
      parseCliArguments(["/repo", "01-demo", "--slot", "bogus", "--session", "ses_x"]),
    ).toThrow(/Invalid selection slot/)
    expect(() =>
      parseCliArguments([
        "/repo",
        "01-demo",
        "--slot",
        "design",
        "--session",
        "ses_x",
        "--bogus",
      ]),
    ).toThrow(/Unknown option: --bogus/)
  })

  test("runSaneLinkCommand validates slot/session without touching the DB", async () => {
    await expect(
      runSaneLinkCommand({
        implementationRepository: "/repo",
        workstreamPath: "01-demo",
        slot: "",
        sessionId: "ses_x",
        write: () => {},
      }),
    ).rejects.toThrow(/Option --slot is required\./)
    await expect(
      runSaneLinkCommand({
        implementationRepository: "/repo",
        workstreamPath: "01-demo",
        slot: "design",
        sessionId: "",
        write: () => {},
      }),
    ).rejects.toThrow(/Option --session is required\./)
    await expect(
      runSaneLinkCommand({
        implementationRepository: "/repo",
        workstreamPath: "01-demo",
        slot: "bogus",
        sessionId: "ses_x",
        write: () => {},
      }),
    ).rejects.toThrow(/Invalid selection slot/)
  })
})

describe("sane-link CLI end to end (tmp repo)", () => {
  let tempDirectory = ""
  let implementationRepository = ""

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-link-"))
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
    tempDirectory = ""
  })

  async function readSlot(slot: string) {
    const identity = await resolveSaneIdentity(implementationRepository, "01-demo")
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      return listSelectionsBySlot(db, identity, slot)
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  }

  test("link design ok; second link without --force fails; with --force replaces", async () => {
    const lines: string[] = []
    const first = await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "design",
      sessionId: "ses_design_1",
      write: (line) => lines.push(line),
    })
    expect(first.slot).toBe("design")
    expect(first.sessionId).toBe("ses_design_1")
    expect(first.index).toBe(1)
    expect(first.count).toBe(1)
    expect(lines.join("\n")).toContain("Linked: design -> ses_design_1 (workstream 01-demo)")
    expect(lines.join("\n")).toContain("session 1 of 1 for slot design")

    // Second distinct link without --force fails with the replacement hint.
    await expect(
      runSaneLinkCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        slot: "design",
        sessionId: "ses_design_2",
        write: () => {},
      }),
    ).rejects.toThrow(
      /Slot "design" is already linked to ses_design_1 \(1 session\(s\)\); rerun with --force to replace\./,
    )
    expect((await readSlot("design")).map((row) => row.session_id)).toEqual(["ses_design_1"])

    // With --force the old row is gone and the count stays 1.
    const replaced = await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "design",
      sessionId: "ses_design_2",
      force: true,
      write: () => {},
    })
    expect(replaced.sessionId).toBe("ses_design_2")
    expect(replaced.index).toBe(1)
    expect(replaced.count).toBe(1)
    expect((await readSlot("design")).map((row) => row.session_id)).toEqual(["ses_design_2"])
  })

  test("two links to engineering both kept, indexes 1 then 2 in order", async () => {
    const first = await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "engineering",
      sessionId: "ses_eng_1",
      write: () => {},
    })
    expect(first.index).toBe(1)
    expect(first.count).toBe(1)

    const second = await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "engineering",
      sessionId: "ses_eng_2",
      write: () => {},
    })
    expect(second.index).toBe(2)
    expect(second.count).toBe(2)
    expect((await readSlot("engineering")).map((row) => row.session_id)).toEqual([
      "ses_eng_1",
      "ses_eng_2",
    ])
  })

  test("research slots are 1:many; --worktree-path/--branch recorded", async () => {
    await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "research:auth",
      sessionId: "ses_r1",
      write: () => {},
    })
    const second = await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "research:auth",
      sessionId: "ses_r2",
      worktreePath: "/wt/opencode-managed/01-demo",
      branch: "opencode/some-branch",
      write: () => {},
    })
    expect(second.index).toBe(2)
    expect(second.count).toBe(2)
    expect(second.worktreePath).toBe("/wt/opencode-managed/01-demo")
    expect(second.branch).toBe("opencode/some-branch")
    const rows = await readSlot("research:auth")
    expect(rows.map((row) => row.session_id)).toEqual(["ses_r1", "ses_r2"])
    expect(rows[1]!.worktree_path).toBe("/wt/opencode-managed/01-demo")
    expect(rows[1]!.branch).toBe("opencode/some-branch")
  })

  test("bare research is 1:many: two links both kept", async () => {
    const first = await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "research",
      sessionId: "ses_bare_1",
      write: () => {},
    })
    expect(first.index).toBe(1)
    expect(first.count).toBe(1)
    const second = await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "research",
      sessionId: "ses_bare_2",
      write: () => {},
    })
    expect(second.index).toBe(2)
    expect(second.count).toBe(2)
    expect((await readSlot("research")).map((row) => row.session_id)).toEqual([
      "ses_bare_1",
      "ses_bare_2",
    ])
  })

  test("duplicate (slot, session) re-links in place", async () => {
    await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "engineering",
      sessionId: "ses_dup",
      write: () => {},
    })
    const relinked = await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "engineering",
      sessionId: "ses_dup",
      write: () => {},
    })
    expect(relinked.sessionId).toBe("ses_dup")
    expect((await readSlot("engineering"))).toHaveLength(1)
  })

  test("planning and execution are 1:1 like design", async () => {
    for (const slot of ["planning", "execution"] as const) {
      await runSaneLinkCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        slot,
        sessionId: `ses_${slot}_1`,
        write: () => {},
      })
      await expect(
        runSaneLinkCommand({
          implementationRepository,
          workstreamPath: "01-demo",
          slot,
          sessionId: `ses_${slot}_2`,
          write: () => {},
        }),
      ).rejects.toThrow(new RegExp(`Slot "${slot}" is already linked`))
      const replaced = await runSaneLinkCommand({
        implementationRepository,
        workstreamPath: "01-demo",
        slot,
        sessionId: `ses_${slot}_2`,
        force: true,
        write: () => {},
      })
      expect(replaced.count).toBe(1)
      expect((await readSlot(slot)).map((row) => row.session_id)).toEqual([`ses_${slot}_2`])
    }
  })

  test("--json envelope parses with expected keys", async () => {
    const lines: string[] = []
    await runSaneLinkCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "design",
      sessionId: "ses_json_1",
      worktreePath: "/wt/json",
      branch: "opencode/json",
      json: true,
      write: (line) => lines.push(line),
    })
    const parsed = JSON.parse(lines.join("\n"))
    expect(parsed).toMatchObject({
      workstream_id: "01-demo",
      slot: "design",
      session_id: "ses_json_1",
      index: 1,
      count: 1,
      worktree_path: "/wt/json",
      branch: "opencode/json",
    })
    expect(typeof parsed.repo_root).toBe("string")
    expect(typeof parsed.user).toBe("string")
    expect(Object.keys(parsed).sort()).toEqual(
      ["branch", "count", "index", "implementation_root", "repo_root", "session_id", "slot", "user", "workstream_id", "worktree_path"].sort(),
    )
  })

  test("runCli returns 0/1 and surfaces required/unknown/slot errors", async () => {
    expect(
      await runCli([implementationRepository, "01-demo", "--slot", "design", "--session", "ses_cli_1"]),
    ).toBe(0)
    expect((await readSlot("design")).map((row) => row.session_id)).toEqual(["ses_cli_1"])

    // Missing --slot / --session, bogus slot, unknown option all fail.
    expect(await runCli([implementationRepository, "01-demo", "--session", "ses_x"])).toBe(1)
    expect(await runCli([implementationRepository, "01-demo", "--slot", "design"])).toBe(1)
    expect(
      await runCli([implementationRepository, "01-demo", "--slot", "bogus", "--session", "ses_x"]),
    ).toBe(1)
    expect(
      await runCli([
        implementationRepository,
        "01-demo",
        "--slot",
        "design",
        "--session",
        "ses_x",
        "--nope",
      ]),
    ).toBe(1)

    // Second distinct design link via runCli without --force fails; --force succeeds.
    expect(
      await runCli([implementationRepository, "01-demo", "--slot", "design", "--session", "ses_cli_2"]),
    ).toBe(1)
    expect(
      await runCli([
        implementationRepository,
        "01-demo",
        "--slot",
        "design",
        "--session",
        "ses_cli_2",
        "--force",
      ]),
    ).toBe(0)
    expect((await readSlot("design")).map((row) => row.session_id)).toEqual(["ses_cli_2"])
  })

  test("runCli --json emits the link envelope on stdout", async () => {
    const lines: string[] = []
    const originalLog = console.log
    console.log = (line?: unknown) => {
      lines.push(String(line))
    }
    try {
      const code = await runCli([
        implementationRepository,
        "01-demo",
        "--slot",
        "engineering",
        "--session",
        "ses_e_json",
        "--json",
      ])
      expect(code).toBe(0)
    } finally {
      console.log = originalLog
    }
    const parsed = JSON.parse(lines.join("\n"))
    expect(parsed).toMatchObject({ slot: "engineering", session_id: "ses_e_json", count: 1, index: 1 })
  })
})
