import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const DEFAULT_SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url))
export const COMMAND_FILENAME = "sane"

export class SaneAlphaInstallationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SaneAlphaInstallationError"
  }
}

export interface SaneAlphaInstallationOptions {
  /** Enables isolated tests and an explicitly configured local SANE home. */
  homeDirectory?: string
  /** Root of the Alpha checkout containing bin/sane.ts. */
  sourceRoot?: string
  /** User-owned directory in which the managed command is installed. */
  binDirectory?: string
  /** Override PATH when reporting whether the installed command is immediately available. */
  pathEnvironment?: string
  dryRun?: boolean
  overwrite?: boolean
  write?: (line: string) => void
}

export interface SaneAlphaInstallationResult {
  sourceCommand: string
  destination: string
  binDirectory: string
  dryRun: boolean
  action: "create" | "update" | "unchanged"
  pathConfigured: boolean
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return undefined
    throw error
  }
}

function resolveHomeDirectory(configuredHome?: string): string {
  const home = configuredHome ?? process.env.SANE_HOME ?? homedir()
  if (!home.trim()) throw new SaneAlphaInstallationError("Could not resolve a home directory.")
  return resolve(home)
}

function resolveBinDirectory(options: SaneAlphaInstallationOptions, homeDirectory: string): string {
  const binDirectory = options.binDirectory ?? process.env.SANE_ALPHA_BIN ?? join(homeDirectory, ".local", "bin")
  if (!binDirectory.trim()) throw new SaneAlphaInstallationError("Binary directory cannot be empty.")
  return resolve(binDirectory)
}

/** Build the only file content recognized as a SANE-managed global wrapper. */
export function managedWrapperContent(sourceCommand: string): string {
  return `#!/usr/bin/env bun
// Managed by SANE Alpha. Reinstall from the checkout if it moves.
import { runSaneAlpha } from ${JSON.stringify(pathToFileURL(sourceCommand).href)}

process.exitCode = await runSaneAlpha(Bun.argv.slice(2))
`
}

/** Reject an existing non-directory ancestor before making an installation write. */
async function validateDestinationParent(destination: string): Promise<void> {
  let ancestor = dirname(destination)
  while (true) {
    const stat = await lstatOrUndefined(ancestor)
    if (stat) {
      if (!stat.isDirectory()) {
        throw new SaneAlphaInstallationError(`Destination parent is not a directory: ${ancestor}`)
      }
      return
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return
    ancestor = parent
  }
}

function isOnPath(binDirectory: string, pathEnvironment: string | undefined): boolean {
  return (pathEnvironment ?? process.env.PATH ?? "")
    .split(delimiter)
    .some((entry) => entry.length > 0 && resolve(entry) === binDirectory)
}

/**
 * Install a generated Bun wrapper that imports the dispatcher by absolute file
 * URL. This keeps `sane` tied to its checkout rather than the caller's
 * working directory. All validation completes before any directory or file is
 * changed.
 */
export async function installSaneAlpha(
  options: SaneAlphaInstallationOptions = {},
): Promise<SaneAlphaInstallationResult> {
  const write = options.write ?? console.log
  const homeDirectory = resolveHomeDirectory(options.homeDirectory)
  const sourceRoot = resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT)
  const sourceCommand = join(sourceRoot, "bin", "sane.ts")
  const binDirectory = resolveBinDirectory(options, homeDirectory)
  const destination = join(binDirectory, COMMAND_FILENAME)

  const sourceStat = await lstatOrUndefined(sourceCommand)
  if (!sourceStat?.isFile()) {
    throw new SaneAlphaInstallationError(`Required source command must be a regular file: ${sourceCommand}`)
  }
  const content = managedWrapperContent(sourceCommand)
  await validateDestinationParent(destination)

  const destinationStat = await lstatOrUndefined(destination)
  let action: SaneAlphaInstallationResult["action"]
  if (!destinationStat) {
    action = "create"
  } else if (!destinationStat.isFile()) {
    throw new SaneAlphaInstallationError(`Destination is not a regular file: ${destination}`)
  } else if ((await readFile(destination, "utf8")) === content) {
    action = "unchanged"
  } else if (!options.overwrite) {
    throw new SaneAlphaInstallationError(
      `Destination differs; rerun with --overwrite to replace this regular file: ${destination}`,
    )
  } else {
    action = "update"
  }

  const result: SaneAlphaInstallationResult = {
    sourceCommand,
    destination,
    binDirectory,
    dryRun: options.dryRun === true,
    action,
    pathConfigured: isOnPath(binDirectory, options.pathEnvironment),
  }
  if (options.dryRun) {
    write("Dry run: no files or directories were modified.")
    write(`${action === "unchanged" ? "Unchanged" : "Planned"}: ${destination}`)
    return result
  }
  if (action === "unchanged") {
    write(`Unchanged: ${destination}`)
  } else {
    await mkdir(binDirectory, { recursive: true })
    await writeFile(destination, content)
    await chmod(destination, 0o755)
    write(`${action === "create" ? "Created" : "Updated"}: ${destination}`)
  }
  write(result.pathConfigured
    ? `PATH includes ${binDirectory}`
    : `Add this directory to PATH to use sane: export PATH="${binDirectory}:$PATH"`)
  return result
}

export const USAGE =
  "Usage: bun alpha/packages/sane-cli/src/install-sane.ts [--bin-dir <path>] [--dry-run] [--overwrite]"

export function parseCliArguments(args: string[]): {
  binDirectory?: string
  dryRun: boolean
  overwrite: boolean
} {
  let binDirectory: string | undefined
  let dryRun = false
  let overwrite = false
  const positional: string[] = []
  let parseOptions = true
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--dry-run") {
      dryRun = true
    } else if (parseOptions && argument === "--overwrite") {
      overwrite = true
    } else if (parseOptions && argument === "--bin-dir") {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new SaneAlphaInstallationError("Option --bin-dir requires a value.")
      }
      if (binDirectory) throw new SaneAlphaInstallationError("Option --bin-dir may be provided only once.")
      binDirectory = value
      index += 1
    } else if (parseOptions && argument.startsWith("-")) {
      throw new SaneAlphaInstallationError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }
  if (positional.length > 0) {
    throw new SaneAlphaInstallationError("This command does not accept positional arguments.")
  }
  return { binDirectory, dryRun, overwrite }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    await installSaneAlpha(parseCliArguments(args))
    return 0
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`)
    console.error(USAGE)
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2))
}
