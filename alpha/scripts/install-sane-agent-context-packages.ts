import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"

export const AGENT_FILENAMES = [
  "sane-design.md",
  "sane-engineering.md",
  "sane-execution.md",
  "sane-implementation.md",
  "sane-product.md",
  "sane-research.md",
] as const

export const ROLE_SKILL_NAMES = [
  "sane-design-assistant-role",
  "sane-engineering-assistant-role",
  "sane-execution-assistant-role",
  "sane-implementation-assistant-role",
  "sane-product-assistant-role",
  "sane-research-assistant-role",
] as const

export const DEFAULT_SOURCE_ROOT = fileURLToPath(new URL("../", import.meta.url))

export class AgentContextPackageInstallationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentContextPackageInstallationError"
  }
}

export interface AgentContextPackageInstallationOptions {
  /** Enables isolated tests and an explicitly configured local SANE home. */
  homeDirectory?: string
  /** Root containing the source `opencode/agents` and `skills` directories. */
  sourceRoot?: string
  dryRun?: boolean
  overwrite?: boolean
  write?: (line: string) => void
}

export interface AgentContextPackageInstallationResult {
  homeDirectory: string
  dryRun: boolean
  created: string[]
  updated: string[]
  unchanged: string[]
}

interface InstallationEntry {
  source: string
  destination: string
  content?: string
}

interface PlannedInstallationEntry extends InstallationEntry {
  content: string
  action: "create" | "update" | "unchanged"
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
  if (!home.trim()) {
    throw new AgentContextPackageInstallationError("Could not resolve a home directory.")
  }
  return resolve(home)
}

function installationEntries(
  sourceRoot: string,
  homeDirectory: string,
): InstallationEntry[] {
  return [
    ...AGENT_FILENAMES.map((filename) => ({
      source: join(sourceRoot, "opencode", "agents", filename),
      destination: join(homeDirectory, ".config", "opencode", "agents", filename),
    })),
    ...ROLE_SKILL_NAMES.map((skillName) => ({
      source: join(sourceRoot, "skills", skillName, "SKILL.md"),
      destination: join(homeDirectory, ".agents", "skills", skillName, "SKILL.md"),
    })),
  ]
}

async function validateSources(entries: InstallationEntry[]): Promise<InstallationEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const stat = await lstatOrUndefined(entry.source)
      if (!stat?.isFile()) {
        throw new AgentContextPackageInstallationError(
          `Required source must be a regular file: ${entry.source}`,
        )
      }
      return { ...entry, content: await readFile(entry.source, "utf8") }
    }),
  )
}

/** Reject an existing non-directory ancestor before any installation write. */
async function validateDestinationParent(destination: string): Promise<void> {
  let ancestor = dirname(destination)
  while (true) {
    const stat = await lstatOrUndefined(ancestor)
    if (stat) {
      if (!stat.isDirectory()) {
        throw new AgentContextPackageInstallationError(
          `Destination parent is not a directory: ${ancestor}`,
        )
      }
      return
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) return
    ancestor = parent
  }
}

async function planDestinations(
  entries: InstallationEntry[],
  overwrite: boolean,
): Promise<PlannedInstallationEntry[]> {
  await Promise.all(entries.map((entry) => validateDestinationParent(entry.destination)))
  return Promise.all(
    entries.map(async (entry) => {
      const stat = await lstatOrUndefined(entry.destination)
      if (!stat) return { ...entry, content: entry.content!, action: "create" }
      if (!stat.isFile()) {
        throw new AgentContextPackageInstallationError(
          `Destination is not a regular file: ${entry.destination}`,
        )
      }
      if ((await readFile(entry.destination, "utf8")) === entry.content) {
        return { ...entry, content: entry.content!, action: "unchanged" }
      }
      if (!overwrite) {
        throw new AgentContextPackageInstallationError(
          `Destination differs; rerun with --overwrite to replace this regular file: ${entry.destination}`,
        )
      }
      return { ...entry, content: entry.content!, action: "update" }
    }),
  )
}

/**
 * Install all Alpha OpenCode agents and role skills.
 * All source and destination checks finish before this function creates a directory
 * or writes a destination file.
 */
export async function installSaneAgentContextPackages(
  options: AgentContextPackageInstallationOptions = {},
): Promise<AgentContextPackageInstallationResult> {
  const write = options.write ?? console.log
  const homeDirectory = resolveHomeDirectory(options.homeDirectory)
  const sourceRoot = resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT)
  const sourcedEntries = await validateSources(installationEntries(sourceRoot, homeDirectory))
  const plannedEntries = await planDestinations(sourcedEntries, options.overwrite === true)
  const result: AgentContextPackageInstallationResult = {
    homeDirectory,
    dryRun: options.dryRun === true,
    created: plannedEntries.filter((entry) => entry.action === "create").map((entry) => entry.destination),
    updated: plannedEntries.filter((entry) => entry.action === "update").map((entry) => entry.destination),
    unchanged: plannedEntries.filter((entry) => entry.action === "unchanged").map((entry) => entry.destination),
  }

  if (options.dryRun) {
    write("Dry run: no files or directories were modified.")
    for (const entry of plannedEntries) {
      write(`${entry.action === "unchanged" ? "Unchanged" : "Planned"}: ${entry.destination}`)
    }
    return result
  }

  for (const entry of plannedEntries) {
    if (entry.action === "unchanged") {
      write(`Unchanged: ${entry.destination}`)
      continue
    }
    await mkdir(dirname(entry.destination), { recursive: true })
    await writeFile(entry.destination, entry.content)
    write(`${entry.action === "create" ? "Created" : "Updated"}: ${entry.destination}`)
  }
  return result
}

export const USAGE =
  "Usage: sane-alpha install-context-packages [--dry-run] [--overwrite]"

export function parseCliArguments(args: string[]): { dryRun: boolean; overwrite: boolean } {
  let dryRun = false
  let overwrite = false
  const positional: string[] = []
  let parseOptions = true

  for (const argument of args) {
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--dry-run") {
      dryRun = true
    } else if (parseOptions && argument === "--overwrite") {
      overwrite = true
    } else if (parseOptions && argument.startsWith("-")) {
      throw new AgentContextPackageInstallationError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length > 0) {
    throw new AgentContextPackageInstallationError("This command does not accept positional arguments.")
  }
  return { dryRun, overwrite }
}

export async function runCli(args: string[]): Promise<number> {
  try {
    await installSaneAgentContextPackages(parseCliArguments(args))
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
