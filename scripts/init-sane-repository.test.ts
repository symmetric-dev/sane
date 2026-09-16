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
} from "./init-sane-repository.ts"

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
})
