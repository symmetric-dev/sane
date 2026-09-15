import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
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
  let homeDirectory: string
  let implementationRepository: string
  let templateRoot: string

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "sane-alpha-repository-"))
    homeDirectory = join(tempDirectory, "home")
    implementationRepository = join(tempDirectory, "implementation")
    templateRoot = join(tempDirectory, "templates")
    await mkdir(implementationRepository)
    await execFileAsync("git", ["init", "--quiet", implementationRepository])
    await mkdir(join(templateRoot, "shared", "repository"), { recursive: true })
    await Bun.write(
      join(templateRoot, "shared", "repository", "paths"),
      "implementation-path: <absolute-path-to-implementation-repository>\nworkstream-repository-path: <absolute-path-to-workstream-repository>\n",
    )
  })

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true })
  })

  function options(extra: { dryRun?: boolean } = {}) {
    return {
      implementationRepository,
      homeDirectory,
      templateRoot,
      write: () => {},
      ...extra,
    }
  }

  test("creates the paired Git repository, local paths file, and ignore entry", async () => {
    const result = await initializeSaneRepository(options())
    const workstreamRepository = join(homeDirectory, "workstreams", "implementation-work")
    const canonicalImplementationRepository = await realpath(implementationRepository)

    expect(result).toMatchObject({
      implementationRepository: canonicalImplementationRepository,
      workstreamRepository,
      dryRun: false,
      createdWorkstreamRepository: true,
      addedIgnoreEntry: true,
    })
    expect(
      (await execFileAsync("git", ["-C", workstreamRepository, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
      })).stdout.trim(),
    ).toBe("true")
    expect(
      await readFile(join(implementationRepository, ".sane", "paths"), "utf8"),
    ).toBe(
      `implementation-path: ${canonicalImplementationRepository}\n` +
        `workstream-repository-path: ${workstreamRepository}\n`,
    )
    expect(await readFile(join(implementationRepository, ".gitignore"), "utf8")).toBe(
      "/.sane/\n",
    )
  })

  test("safely repeats without changing an existing ignore entry", async () => {
    await Bun.write(join(implementationRepository, ".gitignore"), "dist/\n/.sane/\n")
    await initializeSaneRepository(options())
    const repeat = await initializeSaneRepository(options())

    expect(repeat).toMatchObject({
      createdWorkstreamRepository: false,
      addedIgnoreEntry: false,
    })
    expect(await readFile(join(implementationRepository, ".gitignore"), "utf8")).toBe(
      "dist/\n/.sane/\n",
    )
  })

  test("preserves existing .gitignore content and adds one ignore entry", async () => {
    await Bun.write(join(implementationRepository, ".gitignore"), "node_modules/\n.env")

    await initializeSaneRepository(options())

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
    await expectMissing(join(homeDirectory, "workstreams"))
  })

  test("rejects an unrelated nonempty workstream destination", async () => {
    const workstreamRepository = join(homeDirectory, "workstreams", "implementation-work")
    await mkdir(workstreamRepository, { recursive: true })
    await Bun.write(join(workstreamRepository, "unrelated.txt"), "do not replace\n")

    await expect(initializeSaneRepository(options())).rejects.toBeInstanceOf(
      RepositoryInitializationError,
    )
    expect(await readFile(join(workstreamRepository, "unrelated.txt"), "utf8")).toBe(
      "do not replace\n",
    )
    await expectMissing(join(implementationRepository, ".sane"))
  })

  test("rejects a destination that is only a directory inside another Git repository", async () => {
    const workstreamsDirectory = join(homeDirectory, "workstreams")
    const workstreamRepository = join(workstreamsDirectory, "implementation-work")
    await mkdir(workstreamRepository, { recursive: true })
    await execFileAsync("git", ["init", "--quiet", workstreamsDirectory])

    await expect(initializeSaneRepository(options())).rejects.toThrow(
      "not the expected Git repository",
    )
    await expectMissing(join(implementationRepository, ".sane"))
  })

  test("rejects a differing local SANE paths file without changing it", async () => {
    const workstreamRepository = join(homeDirectory, "workstreams", "implementation-work")
    await mkdir(join(implementationRepository, ".sane"))
    await Bun.write(join(implementationRepository, ".sane", "paths"), "different\n")
    await execFileAsync("git", ["init", "--quiet", workstreamRepository])

    await expect(initializeSaneRepository(options())).rejects.toThrow("paths file differs")
    expect(
      await readFile(join(implementationRepository, ".sane", "paths"), "utf8"),
    ).toBe("different\n")
    await expectMissing(join(implementationRepository, ".gitignore"))
  })

  test("dry run validates and describes setup without mutation", async () => {
    const lines: string[] = []
    const result = await initializeSaneRepository({
      ...options({ dryRun: true }),
      write: (line) => lines.push(line),
    })

    expect(result).toMatchObject({ dryRun: true, createdWorkstreamRepository: true })
    expect(lines).toContain("Dry run: no files or directories were modified.")
    await expectMissing(join(homeDirectory, "workstreams"))
    await expectMissing(join(implementationRepository, ".sane"))
    await expectMissing(join(implementationRepository, ".gitignore"))
  })

  test("validates the paths template before creating destinations", async () => {
    await Bun.write(join(templateRoot, "shared", "repository", "paths"), "missing placeholders\n")

    await expect(initializeSaneRepository(options())).rejects.toThrow("exact .sane/paths schema")
    await expectMissing(join(homeDirectory, "workstreams"))
    await expectMissing(join(implementationRepository, ".sane"))
  })

  test("uses the default shared repository paths source", async () => {
    const result = await initializeSaneRepository({
      ...options({ dryRun: true }),
      templateRoot: undefined,
    })

    expect(result).toMatchObject({ dryRun: true, createdWorkstreamRepository: true })
  })
})
