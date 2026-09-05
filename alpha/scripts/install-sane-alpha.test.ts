import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  COMMAND_FILENAME,
  DEFAULT_SOURCE_ROOT,
  SaneAlphaInstallationError,
  installSaneAlpha,
  managedWrapperContent,
  parseCliArguments,
} from "./install-sane-alpha.ts"

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}

describe("install-sane-alpha", () => {
  let temporaryDirectory: string
  let homeDirectory: string
  let sourceRoot: string
  let binDirectory: string

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "sane-alpha-install-"))
    homeDirectory = join(temporaryDirectory, "home")
    sourceRoot = join(temporaryDirectory, "source")
    binDirectory = join(homeDirectory, ".local", "bin")
    await mkdir(join(sourceRoot, "bin"), { recursive: true })
    await writeFile(join(sourceRoot, "bin", "sane-alpha.ts"), "export const runSaneAlpha = async () => 0\n")
  })

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true })
  })

  function options(extra: { dryRun?: boolean; overwrite?: boolean; pathEnvironment?: string } = {}) {
    return { homeDirectory, sourceRoot, binDirectory, write: () => {}, ...extra }
  }

  test("creates an executable wrapper anchored to the Alpha checkout", async () => {
    const result = await installSaneAlpha(options({ pathEnvironment: binDirectory }))
    const destination = join(binDirectory, COMMAND_FILENAME)

    expect(result).toMatchObject({ destination, action: "create", pathConfigured: true })
    expect(await readFile(destination, "utf8")).toBe(
      managedWrapperContent(join(sourceRoot, "bin", "sane-alpha.ts")),
    )
    expect((await lstat(destination)).mode & 0o111).not.toBe(0)
  })

  test("repeats unchanged when the managed wrapper is identical", async () => {
    await installSaneAlpha(options())
    const result = await installSaneAlpha(options())

    expect(result.action).toBe("unchanged")
  })

  test("dry run validates and plans without creating the binary directory", async () => {
    const result = await installSaneAlpha(options({ dryRun: true }))

    expect(result).toMatchObject({ dryRun: true, action: "create" })
    await expectMissing(binDirectory)
  })

  test("refuses a differing regular file without overwrite and preserves it", async () => {
    await mkdir(binDirectory, { recursive: true })
    const destination = join(binDirectory, COMMAND_FILENAME)
    await writeFile(destination, "user command\n")

    await expect(installSaneAlpha(options())).rejects.toBeInstanceOf(SaneAlphaInstallationError)
    expect(await readFile(destination, "utf8")).toBe("user command\n")
  })

  test("replaces a differing regular file only with explicit overwrite", async () => {
    await mkdir(binDirectory, { recursive: true })
    const destination = join(binDirectory, COMMAND_FILENAME)
    await writeFile(destination, "user command\n")

    const result = await installSaneAlpha(options({ overwrite: true }))

    expect(result.action).toBe("update")
    expect(await readFile(destination, "utf8")).toBe(
      managedWrapperContent(join(sourceRoot, "bin", "sane-alpha.ts")),
    )
  })

  test("rejects a non-regular destination even with overwrite", async () => {
    await mkdir(join(binDirectory, COMMAND_FILENAME), { recursive: true })

    await expect(installSaneAlpha(options({ overwrite: true }))).rejects.toThrow("not a regular file")
  })

  test("validates source and destination parents before creating any path", async () => {
    await rm(join(sourceRoot, "bin", "sane-alpha.ts"))
    await expect(installSaneAlpha(options())).rejects.toThrow("Required source command")
    await expectMissing(binDirectory)

    await writeFile(join(sourceRoot, "bin", "sane-alpha.ts"), "export const runSaneAlpha = async () => 0\n")
    await mkdir(homeDirectory, { recursive: true })
    await writeFile(join(homeDirectory, ".local"), "not a directory\n")
    await expect(installSaneAlpha(options())).rejects.toThrow("Destination parent is not a directory")
    await expectMissing(join(homeDirectory, ".local", "bin"))
  })

  test("the installed command runs from another working directory and preserves its failure status", async () => {
    const actualBinDirectory = join(temporaryDirectory, "actual-bin")
    const result = await installSaneAlpha({
      sourceRoot: DEFAULT_SOURCE_ROOT,
      binDirectory: actualBinDirectory,
      write: () => {},
    })
    const process = Bun.spawn([result.destination, "not-an-alpha-command"], {
      cwd: temporaryDirectory,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = await new Response(process.stderr).text()

    expect(await process.exited).toBe(1)
    expect(stderr).toContain('Unknown SANE Alpha command "not-an-alpha-command"')
  })

  test("supports a configurable home through SANE_HOME", async () => {
    const previousSaneHome = process.env.SANE_HOME
    process.env.SANE_HOME = homeDirectory
    try {
      const result = await installSaneAlpha({ sourceRoot, write: () => {} })
      expect(result.destination).toBe(join(homeDirectory, ".local", "bin", COMMAND_FILENAME))
    } finally {
      if (previousSaneHome === undefined) delete process.env.SANE_HOME
      else process.env.SANE_HOME = previousSaneHome
    }
  })

  test("validates CLI options", () => {
    expect(parseCliArguments([])).toEqual({ binDirectory: undefined, dryRun: false, overwrite: false })
    expect(parseCliArguments(["--bin-dir", "custom-bin", "--dry-run", "--overwrite"])).toEqual({
      binDirectory: "custom-bin", dryRun: true, overwrite: true,
    })
    expect(() => parseCliArguments(["--bin-dir"])).toThrow("requires a value")
    expect(() => parseCliArguments(["--unexpected"])).toThrow("Unknown option")
    expect(() => parseCliArguments(["destination"])).toThrow("does not accept positional")
  })
})
