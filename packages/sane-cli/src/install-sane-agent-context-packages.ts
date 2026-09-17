import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { injectAgentModel, loadAgentModelConfig } from "./agent-model-config.ts"

export const AGENT_FILENAMES = [
  "sane/assistant/design.md",
  "sane/assistant/engineering.md",
  "sane/assistant/execution.md",
  "sane/assistant/planning.md",
  "sane/assistant/research.md",
  "sane/worker/fixer.md",
  "sane/worker/grounder.md",
  "sane/worker/implementer.md",
  "sane/worker/researcher.md",
  "sane/worker/reviewer.md",
  "sane/worker/scout.md",
] as const

export const ROLE_SKILL_NAMES = [
  "sane-design-assistant-role",
  "sane-engineering-assistant-role",
  "sane-execution-assistant-role",
  "sane-planning-assistant-role",
  "sane-research-assistant-role",
] as const

export const DEFAULT_SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url))

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
  /** YAML mapping of agent names (without .md) to model strings or model/variant objects. */
  modelConfigPath?: string
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
  agentName?: string
}

interface LoadedInstallationEntry extends InstallationEntry {
  content: string
}

interface PlannedInstallationEntry extends LoadedInstallationEntry {
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
      agentName: filename.slice(0, -3),
      source: join(sourceRoot, "opencode", "agents", filename),
      destination: join(homeDirectory, ".config", "opencode", "agents", filename),
    })),
    ...ROLE_SKILL_NAMES.map((skillName) => ({
      source: join(sourceRoot, "skills", skillName, "SKILL.md"),
      destination: join(homeDirectory, ".agents", "skills", skillName, "SKILL.md"),
    })),
  ]
}

async function validateSources(entries: InstallationEntry[]): Promise<LoadedInstallationEntry[]> {
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
  entries: LoadedInstallationEntry[],
  overwrite: boolean,
): Promise<PlannedInstallationEntry[]> {
  await Promise.all(entries.map((entry) => validateDestinationParent(entry.destination)))
  return Promise.all(
    entries.map(async (entry) => {
      const stat = await lstatOrUndefined(entry.destination)
      if (!stat) return { ...entry, action: "create" }
      if (!stat.isFile()) {
        throw new AgentContextPackageInstallationError(
          `Destination is not a regular file: ${entry.destination}`,
        )
      }
      if ((await readFile(entry.destination, "utf8")) === entry.content) {
        return { ...entry, action: "unchanged" }
      }
      if (!overwrite) {
        throw new AgentContextPackageInstallationError(
          `Destination differs; rerun with --overwrite to replace this regular file: ${entry.destination}`,
        )
      }
      return { ...entry, action: "update" }
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
  let configuredEntries = sourcedEntries
  if (options.modelConfigPath !== undefined) {
    try {
      const models = await loadAgentModelConfig(options.modelConfigPath, AGENT_FILENAMES)
      configuredEntries = sourcedEntries.map((entry) => ({
        ...entry,
        content: injectAgentModel(entry.content, entry.agentName ? models.get(entry.agentName) : undefined),
      }))
    } catch (error) {
      throw new AgentContextPackageInstallationError((error as Error).message)
    }
  }
  const plannedEntries = await planDestinations(configuredEntries, options.overwrite === true)
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
  "Usage: sane-alpha install-context-packages [--dry-run] [--overwrite] [--model-config <path>]"

export function parseCliArguments(args: string[]): { dryRun: boolean; overwrite: boolean; modelConfigPath?: string } {
  let dryRun = false
  let overwrite = false
  let modelConfigPath: string | undefined
  const positional: string[] = []
  let parseOptions = true

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (parseOptions && argument === "--") {
      parseOptions = false
    } else if (parseOptions && argument === "--dry-run") {
      dryRun = true
    } else if (parseOptions && argument === "--overwrite") {
      overwrite = true
    } else if (parseOptions && argument === "--model-config") {
      const path = args[++index]
      if (!path?.trim() || path.startsWith("-")) {
        throw new AgentContextPackageInstallationError("--model-config requires a path.")
      }
      if (modelConfigPath !== undefined) {
        throw new AgentContextPackageInstallationError("--model-config may only be specified once.")
      }
      modelConfigPath = path
    } else if (parseOptions && argument.startsWith("-")) {
      throw new AgentContextPackageInstallationError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length > 0) {
    throw new AgentContextPackageInstallationError("This command does not accept positional arguments.")
  }
  return { dryRun, overwrite, ...(modelConfigPath === undefined ? {} : { modelConfigPath }) }
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
