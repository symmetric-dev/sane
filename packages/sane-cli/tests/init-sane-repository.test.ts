import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import {
  RepositoryInitializationError,
  initializeSaneRepository,
  parseCliArguments,
} from "../src/init-sane-repository.ts"
import {
  REQUIRED_WORKSTREAM_FILES,
  RETIRED_WORKSTREAM_FILES,
  ROOT_DOC_BY_TYPE,
  validateBootstrappedWorkstream,
} from "../src/sane-repository.ts"
import { saneDbPath } from "../src/sane-db.ts"
import { Database } from "bun:sqlite"

const execFileAsync = promisify(execFile)

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

describe("init-sane-repository", () => {
  let tempDirectory: string
  let implementationRepository: string
  let workstreamsRoot: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-alpha-repository-"))
    implementationRepository = join(tempDirectory, "implementation")
    workstreamsRoot = join(implementationRepository, ".sane", "workstreams")
    await mkdir(implementationRepository)
    await execFileAsync("git", ["init", "--quiet", implementationRepository])
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  function options(extra: { dryRun?: boolean } = {}) {
    return {
      implementationRepository,
      write: () => {},
      ...extra,
    }
  }

  test("creates the workstreams root and ignore entry", async () => {
    const result = await initializeSaneRepository(options())
    const canonicalImplementationRepository = await realpath(implementationRepository)

    expect(result).toMatchObject({
      implementationRepository: canonicalImplementationRepository,
      workstreamsRoot: join(canonicalImplementationRepository, ".sane", "workstreams"),
      dryRun: false,
      createdWorkstreamsRoot: true,
      addedIgnoreEntry: true,
    })
    expect((await lstat(workstreamsRoot)).isDirectory()).toBe(true)
    expect(await readFile(join(implementationRepository, ".gitignore"), "utf8")).toBe(
      "/.sane/\n",
    )
  })

  test("safely repeats without changing an existing ignore entry", async () => {
    await Bun.write(join(implementationRepository, ".gitignore"), "dist/\n/.sane/\n")
    await initializeSaneRepository(options())
    const repeat = await initializeSaneRepository(options())

    expect(repeat).toMatchObject({
      dryRun: false,
      createdWorkstreamsRoot: false,
      addedIgnoreEntry: false,
    })
    expect(await readFile(join(implementationRepository, ".gitignore"), "utf8")).toBe(
      "dist/\n/.sane/\n",
    )
    expect((await lstat(workstreamsRoot)).isDirectory()).toBe(true)
  })

  test("preserves existing .gitignore content and adds one ignore entry", async () => {
    await Bun.write(join(implementationRepository, ".gitignore"), "node_modules/\n.env")

    const result = await initializeSaneRepository(options())

    expect(result).toMatchObject({ createdWorkstreamsRoot: true, addedIgnoreEntry: true })
    expect(await readFile(join(implementationRepository, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.env\n/.sane/\n",
    )
  })

  test("rejects missing, extra, and unknown CLI arguments", () => {
    expect(() => parseCliArguments([])).toThrow("exactly one")
    expect(() => parseCliArguments(["--dry-run"])).toThrow("exactly one")
    expect(() => parseCliArguments(["first", "second"])).toThrow("exactly one")
    expect(() => parseCliArguments(["--unexpected", "repository"])).toThrow("Unknown option")
  })

  test("rejects an implementation path that is not a Git repository", async () => {
    const nonGitDirectory = join(tempDirectory, "not-a-repository")
    await mkdir(nonGitDirectory)

    await expect(
      initializeSaneRepository({ ...options(), implementationRepository: nonGitDirectory }),
    ).rejects.toThrow("not a Git working tree")
    await expectMissing(join(nonGitDirectory, ".sane"))
  })

  test("rejects when .sane is a file", async () => {
    await Bun.write(join(implementationRepository, ".sane"), "not a directory\n")

    await expect(initializeSaneRepository(options())).rejects.toThrow(
      "not a directory",
    )
    await expectMissing(workstreamsRoot)
    await expectMissing(join(implementationRepository, ".gitignore"))
  })

  test("rejects when the workstreams path is a file", async () => {
    await mkdir(join(implementationRepository, ".sane"))
    await Bun.write(workstreamsRoot, "not a directory\n")

    await expect(initializeSaneRepository(options())).rejects.toThrow(
      "not a directory",
    )
    expect((await lstat(workstreamsRoot)).isFile()).toBe(true)
    await expectMissing(join(implementationRepository, ".gitignore"))
  })

  test("rejects a legacy .sane/paths file without changing it", async () => {
    await mkdir(join(implementationRepository, ".sane"))
    await Bun.write(join(implementationRepository, ".sane", "paths"), "different\n")

    await expect(initializeSaneRepository(options())).rejects.toBeInstanceOf(
      RepositoryInitializationError,
    )
    await expect(initializeSaneRepository(options())).rejects.toThrow("Legacy .sane/paths")
    expect(
      await readFile(join(implementationRepository, ".sane", "paths"), "utf8"),
    ).toBe("different\n")
    await expectMissing(workstreamsRoot)
    await expectMissing(join(implementationRepository, ".gitignore"))
  })

  test("dry run validates and describes setup without mutation", async () => {
    const lines: string[] = []
    const result = await initializeSaneRepository({
      ...options({ dryRun: true }),
      write: (line) => lines.push(line),
    })

    expect(result).toMatchObject({ dryRun: true, createdWorkstreamsRoot: true })
    expect(lines).toContain("Dry run: no files or directories were modified.")
    await expectMissing(join(implementationRepository, ".sane"))
    await expectMissing(join(implementationRepository, ".gitignore"))
  })

  test("dry run validates an existing workstreams root without mutation", async () => {
    await initializeSaneRepository(options())
    const lines: string[] = []
    const result = await initializeSaneRepository({
      ...options({ dryRun: true }),
      write: (line) => lines.push(line),
    })

    expect(result).toMatchObject({ dryRun: true, createdWorkstreamsRoot: false })
    expect(lines).toContain("Dry run: no files or directories were modified.")
  })

  test("0.2.0 REQUIRED_WORKSTREAM_FILES uses the new layout without Stage templates", () => {
    const required: string[] = [...REQUIRED_WORKSTREAM_FILES]
    expect(required).toContain("SANE_CONTEXT.md")
    expect(required).toContain("SANE_STATE.md")
    expect(required).toContain("SDD.md")
    expect(required).toContain("resources/SDD_TEMPLATE.md")
    expect(required).toContain("resources/SOLUTION_SPEC_TEMPLATE.md")
    expect(required).toContain("resources/RESEARCH_REPORT_TEMPLATE.md")
    expect(required).toContain("resources/PLAN_TEMPLATE.md")
    expect(required).toContain("resources/JOB_TEMPLATE.md")
    expect(required).toContain("resources/EXECUTION_REPORT_TEMPLATE.md")
    expect(required).toContain("resources/EXECUTION_BRIEF_TEMPLATE.md")
    for (const retired of RETIRED_WORKSTREAM_FILES) {
      expect(required).not.toContain(retired as string)
    }
    expect(required.join("\n")).not.toContain("STAGES_TEMPLATE")
    expect(required.join("\n")).not.toContain("EXECUTION_PLAN_TEMPLATE")
    expect(ROOT_DOC_BY_TYPE).toMatchObject({
      feature: "PRD.md",
      foundation: "FOUNDATION.md",
      issue: "ISSUE.md",
      maintenance: "MAINTENANCE.md",
    })
  })

  test("initialized repository validates a 0.2.0 workstream and rejects Stage artifacts", async () => {
    await initializeSaneRepository(options())
    const workstream = join(workstreamsRoot, "01-0-2-0")
    await mkdir(join(workstream, "resources"), { recursive: true })
    await Bun.write(join(workstream, "type"), "issue\n")
    await Bun.write(join(workstream, "ISSUE.md"), "issue root\n")
    await Bun.write(join(workstream, "SANE_CONTEXT.md"), "context\n")
    await Bun.write(join(workstream, "SANE_STATE.md"), "state\n")
    await Bun.write(join(workstream, "SDD.md"), "sdd placeholder\n")
    for (const file of REQUIRED_WORKSTREAM_FILES) {
      if (file === "SANE_CONTEXT.md" || file === "SANE_STATE.md" || file === "SDD.md") continue
      await Bun.write(join(workstream, file), `${file}\n`)
    }
    expect(await validateBootstrappedWorkstream(workstream)).toBe("issue")

    await Bun.write(join(workstream, "resources/STAGES_TEMPLATE.md"), "retired\n")
    await expect(validateBootstrappedWorkstream(workstream)).rejects.toThrow("retired Stage artifact")
  })

  test("initialized repository rejects an old Stage layout missing new files", async () => {
    await initializeSaneRepository(options())
    const legacy = join(workstreamsRoot, "01-legacy-stage")
    await mkdir(join(legacy, "resources"), { recursive: true })
    await Bun.write(join(legacy, "type"), "feature\n")
    await Bun.write(join(legacy, "PRD.md"), "old\n")
    await Bun.write(join(legacy, "SANE_CONTEXT.md"), "old\n")
    await Bun.write(join(legacy, "SANE_STATE.md"), "old\n")
    for (const retired of RETIRED_WORKSTREAM_FILES) {
      await Bun.write(join(legacy, retired), "old\n")
    }
    await expect(validateBootstrappedWorkstream(legacy)).rejects.toThrow("retired Stage artifact")
  })

  test("creates the per-repo sqlite source of truth with schema tables (M2 P0)", async () => {
    const result = await initializeSaneRepository(options())
    const dbPath = saneDbPath(result.implementationRepository)
    expect((await lstat(dbPath)).isFile()).toBe(true)

    const db = new Database(dbPath)
    try {
      const tables = db
        .query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as Array<{ name: string }>
      const names = tables.map((table) => table.name)
      for (const expected of [
        "workstreams",
        "selections",
        "state_entries",
        "approvals",
        "research_reports",
        "jobs",
        "merges",
      ]) {
        expect(names).toContain(expected)
      }
    } finally {
      db.close()
    }

    // Idempotent: second init keeps the DB and schema.
    await initializeSaneRepository(options())
    expect((await lstat(dbPath)).isFile()).toBe(true)
  })

  test("dry run creates no sqlite database file", async () => {
    await initializeSaneRepository({ ...options(), dryRun: true })
    const canonicalImplementationRepository = await realpath(implementationRepository)
    await expectMissing(saneDbPath(canonicalImplementationRepository))
  })
})
