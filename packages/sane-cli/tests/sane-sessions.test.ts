/**
 * SANE `sane sessions`: list sessions linked to workstream slots.
 *
 * - empty registry: human `(no linked sessions)`, json total 0
 * - seed via `linkSelection`: 1 design + 2 engineering; grouping, indexes
 *   [1]/[1,2], `(latest)` on engineering [2], worktree/branch shown only
 *   when set
 * - `--slot engineering` filters; `--slot bogus` fails; unknown option fails
 * - --json envelope parses: slots.engineering[1].latest === true, index base 1
 * - e2e `runCli` on tmp repo (init + create first)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
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
  runSaneSessionsCommand,
  USAGE,
} from "../src/sane-sessions-command.ts"
import {
  initSchema,
  linkSelection,
  openSaneDb,
  resolveSaneIdentity,
} from "../src/sane-db.ts"

const execFileAsync = promisify(execFile)

describe("sane-sessions CLI parsing", () => {
  test("USAGE and bare/flag idioms", () => {
    expect(USAGE).toContain("sane sessions")
    expect(USAGE).toContain("--slot")
    expect(USAGE).toContain("--json")
    expect(USAGE).toContain("--repo-root")

    // Bare invocation: no required options, auto-detect sentinel.
    const bare = parseCliArguments([])
    expect(bare).toMatchObject({
      implementationRepository: "",
      workstreamPath: "",
      slot: undefined,
      json: false,
    })

    const filtered = parseCliArguments(["/repo", "01-demo", "--slot", "engineering"])
    expect(filtered).toMatchObject({
      implementationRepository: "/repo",
      workstreamPath: "01-demo",
      slot: "engineering",
      json: false,
    })

    const viaRoot = parseCliArguments([
      "--repo-root",
      "/repo",
      "01-demo",
      "--slot",
      "engineering",
      "--json",
    ])
    expect(viaRoot.implementationRepository).toBe("/repo")
    expect(viaRoot.workstreamPath).toBe("01-demo")
    expect(viaRoot.slot).toBe("engineering")
    expect(viaRoot.json).toBe(true)
  })

  test("--slot bogus fails; unknown option fails", () => {
    expect(() => parseCliArguments(["/repo", "01-demo", "--slot", "bogus"])).toThrow(
      /Invalid selection slot/,
    )
    expect(() => parseCliArguments(["/repo", "01-demo", "--nope"])).toThrow(
      /Unknown option: --nope/,
    )
    expect(() => parseCliArguments(["--slot"])).toThrow(/Option --slot requires a value\./)
  })
})

describe("sane-sessions CLI end to end (tmp repo)", () => {
  let tempDirectory = ""
  let implementationRepository = ""

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-sessions-"))
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

  async function seedStandardRegistry(): Promise<void> {
    const identity = await resolveSaneIdentity(implementationRepository, "01-demo")
    const db = await openSaneDb(identity.repoRoot)
    try {
      initSchema(db)
      linkSelection(
        db,
        identity,
        { slot: "design", sessionId: "ses_design_1" },
        { actorRole: "design", sessionId: "ses_design_1", timestamp: "2026-09-16T00:00:01.000Z" },
      )
      linkSelection(
        db,
        identity,
        { slot: "engineering", sessionId: "ses_eng_1" },
        {
          actorRole: "engineering",
          sessionId: "ses_eng_1",
          timestamp: "2026-09-16T00:00:02.000Z",
        },
      )
      linkSelection(
        db,
        identity,
        {
          slot: "engineering",
          sessionId: "ses_eng_2",
          worktreePath: "/wt/opencode-managed/01-demo",
          branch: "opencode/some-branch",
        },
        {
          actorRole: "engineering",
          sessionId: "ses_eng_2",
          timestamp: "2026-09-16T00:00:03.000Z",
        },
      )
    } finally {
      try {
        db.close()
      } catch {
        // Best effort.
      }
    }
  }

  test("empty registry: human (no linked sessions), json total 0", async () => {
    const lines: string[] = []
    const result = await runSaneSessionsCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      write: (line) => lines.push(line),
    })
    expect(result.total).toBe(0)
    expect(result.slots).toEqual({})
    expect(lines.join("\n")).toContain("(no linked sessions)")

    const jsonLines: string[] = []
    const jsonResult = await runSaneSessionsCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      json: true,
      write: (line) => jsonLines.push(line),
    })
    expect(jsonResult.total).toBe(0)
    const parsed = JSON.parse(jsonLines.join("\n"))
    expect(parsed.total).toBe(0)
    expect(parsed.slots).toEqual({})
    expect(typeof parsed.repo_root).toBe("string")
    expect(typeof parsed.user).toBe("string")
    expect(parsed.workstream_id).toBe("01-demo")
  })

  test("grouping, 1-based indexes, (latest), worktree/branch only when set", async () => {
    await seedStandardRegistry()
    const lines: string[] = []
    const result = await runSaneSessionsCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      write: (line) => lines.push(line),
    })
    expect(result.total).toBe(3)
    expect(result.slots["design"]?.map((entry) => entry.index)).toEqual([1])
    expect(result.slots["engineering"]?.map((entry) => entry.index)).toEqual([1, 2])
    expect(result.slots["engineering"]?.[1]?.latest).toBe(true)
    expect(result.slots["engineering"]?.[0]?.latest).toBe(false)
    expect(result.slots["design"]?.[0]?.latest).toBe(true)

    const output = lines.join("\n")
    // Phase order: design groups before engineering.
    expect(output.indexOf("design")).toBeLessThan(output.indexOf("engineering"))
    // Slot, 1-based index, full session id, (latest) on engineering [2].
    expect(output).toContain("design")
    expect(output).toContain("[1] ses_design_1")
    expect(output).toContain("[1] ses_eng_1")
    expect(output).toContain("[2] ses_eng_2 (latest)")
    // Worktree/branch shown only when set.
    expect(output).toContain("/wt/opencode-managed/01-demo")
    expect(output).toContain("opencode/some-branch")
    const designLine = lines.find((line) => line.includes("ses_design_1")) ?? ""
    expect(designLine).not.toContain("worktree")
    expect(designLine).not.toContain("branch")
    const engFirstLine = lines.find((line) => line.includes("ses_eng_1")) ?? ""
    expect(engFirstLine).not.toContain("worktree")
    expect(engFirstLine).not.toContain("(latest)")
  })

  test("--slot engineering filters; --slot bogus fails via runCli", async () => {
    await seedStandardRegistry()
    const lines: string[] = []
    const result = await runSaneSessionsCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      slot: "engineering",
      write: (line) => lines.push(line),
    })
    expect(Object.keys(result.slots)).toEqual(["engineering"])
    expect(result.total).toBe(2)
    const output = lines.join("\n")
    expect(output).toContain("[1] ses_eng_1")
    expect(output).toContain("[2] ses_eng_2 (latest)")
    expect(output).not.toContain("ses_design_1")

    // Bogus slot fails at parse time and through runCli.
    expect(() =>
      parseCliArguments([implementationRepository, "01-demo", "--slot", "bogus"]),
    ).toThrow(/Invalid selection slot/)
    expect(await runCli([implementationRepository, "01-demo", "--slot", "bogus"])).toBe(1)
    // Unknown option fails at parse time and through runCli.
    expect(() =>
      parseCliArguments([implementationRepository, "01-demo", "--bogus"]),
    ).toThrow(/Unknown option: --bogus/)
    expect(await runCli([implementationRepository, "01-demo", "--bogus"])).toBe(1)
  })

  test("--json envelope parses with 1-based latest index", async () => {
    await seedStandardRegistry()
    const lines: string[] = []
    const result = await runSaneSessionsCommand({
      implementationRepository,
      workstreamPath: "01-demo",
      json: true,
      write: (line) => lines.push(line),
    })
    expect(result.total).toBe(3)
    const parsed = JSON.parse(lines.join("\n"))
    expect(parsed.workstream_id).toBe("01-demo")
    expect(parsed.total).toBe(3)
    expect(typeof parsed.repo_root).toBe("string")
    expect(typeof parsed.user).toBe("string")
    expect(Object.keys(parsed).sort()).toEqual(
      ["repo_root", "slots", "total", "user", "workstream_id"].sort(),
    )
    expect(parsed.slots["design"].map((entry: { index: number }) => entry.index)).toEqual([1])
    expect(parsed.slots["engineering"].map((entry: { index: number }) => entry.index)).toEqual([
      1, 2,
    ])
    // Second engineering entry (index 1 in 0-based array access) is latest.
    expect(parsed.slots["engineering"][1].latest).toBe(true)
    expect(parsed.slots["engineering"][1].index).toBe(2)
    expect(parsed.slots["engineering"][1].session_id).toBe("ses_eng_2")
    expect(parsed.slots["engineering"][0].latest).toBe(false)
    const entryKeys = Object.keys(parsed.slots["engineering"][1]).sort()
    expect(entryKeys).toEqual(
      ["branch", "index", "latest", "session_id", "updated_at", "worktree_path"].sort(),
    )
  })

  test("runCli lists every slot and supports --slot/--json", async () => {
    await seedStandardRegistry()
    const lines: string[] = []
    const originalLog = console.log
    console.log = (line?: unknown) => {
      lines.push(String(line))
    }
    try {
      expect(await runCli([implementationRepository, "01-demo"])).toBe(0)
    } finally {
      console.log = originalLog
    }
    const output = lines.join("\n")
    expect(output).toContain("[1] ses_design_1")
    expect(output).toContain("[2] ses_eng_2 (latest)")

    const jsonLines: string[] = []
    console.log = (line?: unknown) => {
      jsonLines.push(String(line))
    }
    try {
      expect(
        await runCli([implementationRepository, "01-demo", "--slot", "engineering", "--json"]),
      ).toBe(0)
    } finally {
      console.log = originalLog
    }
    const parsed = JSON.parse(jsonLines.join("\n"))
    expect(Object.keys(parsed.slots)).toEqual(["engineering"])
    expect(parsed.total).toBe(2)
    expect(parsed.slots["engineering"][1].latest).toBe(true)
  })
})
