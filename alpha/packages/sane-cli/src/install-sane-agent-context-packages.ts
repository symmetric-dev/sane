import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { injectAgentModel, loadAgentModelConfig, validateAgentTaskPermissions } from "./agent-model-config.ts"

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

/**
 * SANE OpenCode plugin (`sane_link` self-registration tool).
 *
 * `PLUGIN_FILENAMES` are installed from `<sourceRoot>/opencode/plugins/` to
 * `<home>/.config/opencode/plugins/` — the global plugin directory OpenCode
 * V2 auto-loads at startup (per https://opencode.ai/v2/docs/build/plugins/
 * "From local files"; the directory exists on any machine with OpenCode
 * installed).
 * No plugin-local package.json is needed for discovery: local plugins load
 * directly; the only npm dependency (`@opencode/plugin`) resolves via
 * `<home>/.config/opencode/package.json` (see `OPENCODE_PLUGIN_*` below).
 *
 * `PLUGIN_SRC_FILES` is the vendored `sane-cli` closure the plugin imports.
 * A straight copy of `index.ts` would leave its
 * `../../../packages/sane-cli/src/*.ts` imports pointing at
 * `<home>/.config/packages/...` (missing), so the installer copies these
 * sources to `plugins/sane/sane-src/` and rewrites the import prefix in the
 * installed `index.ts` to `./sane-src/`. All vendored files import each
 * other via flat `./*.ts` specifiers, which keep working in the flat
 * destination directory. Keep this list in sync with the relative imports in
 * `opencode/plugins/sane/index.ts`.
 */
export const PLUGIN_SRC_FILES = [
  "sane-link-tool.ts",
  "sane-handoff-tool.ts",
  "sane-handoff-command.ts",
  "sane-workstream-state.ts",
  "sane-hash.ts",
  "sane-db.ts",
  "sane-repository.ts",
  "sane-cwd-target.ts",
  "create-sane-workstream.ts",
  "workstream-type.ts",
] as const

export const PLUGIN_FILENAMES = [
  "sane/index.ts",
  ...PLUGIN_SRC_FILES.map((filename) => `sane/sane-src/${filename}`),
] as const

/** Prefix used by the plugin source for `sane-cli` imports (rewritten on install). */
export const PLUGIN_SRC_IMPORT_PREFIX = "../../../packages/sane-cli/src/"
/** Replacement prefix pointing at the vendored closure next to the installed plugin. */
export const PLUGIN_DEST_IMPORT_PREFIX = "./sane-src/"

/**
 * Runtime npm dependency of the installed plugin, resolved from
 * `<home>/.config/opencode/package.json` (OpenCode installs local-plugin
 * dependencies declared there at startup). The installer merges this entry
 * without touching any other keys.
 */
export const OPENCODE_PLUGIN_DEPENDENCY = "@opencode/plugin"
export const OPENCODE_PLUGIN_VERSION = "^2.0.8"
export const OPENCODE_CONFIG_PACKAGE_FILENAME = "package.json"

export function rewritePluginImports(content: string): string {
  return content.split(PLUGIN_SRC_IMPORT_PREFIX).join(PLUGIN_DEST_IMPORT_PREFIX)
}

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
  /** Rewrite `sane-cli` import prefixes for the installed plugin copy. */
  rewriteImports?: boolean
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
    {
      rewriteImports: true,
      source: join(sourceRoot, "opencode", "plugins", "sane", "index.ts"),
      destination: join(homeDirectory, ".config", "opencode", "plugins", "sane", "index.ts"),
    },
    ...PLUGIN_SRC_FILES.map((filename) => ({
      source: join(sourceRoot, "packages", "sane-cli", "src", filename),
      destination: join(
        homeDirectory,
        ".config",
        "opencode",
        "plugins",
        "sane",
        "sane-src",
        filename,
      ),
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
 * Resolve the `@opencode/plugin` version to declare in the installed
 * config `package.json`: the repo's own devDependency when readable, else
 * the bundled fallback. Never throws: a missing/unparseable source
 * `package.json` falls back silently.
 */
async function resolvePluginDependencyVersion(sourceRoot: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    }
    const pinned =
      parsed.devDependencies?.[OPENCODE_PLUGIN_DEPENDENCY] ??
      parsed.dependencies?.[OPENCODE_PLUGIN_DEPENDENCY]
    if (typeof pinned === "string" && pinned.trim() !== "") return pinned
  } catch {
    // Fall through to the bundled fallback.
  }
  return OPENCODE_PLUGIN_VERSION
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Build the `<home>/.config/opencode/package.json` entry that guarantees the
 * installed plugin's `@opencode/plugin` import resolves at OpenCode
 * startup. Merges the dependency into an existing file without touching any
 * other keys; a user-pinned spec is left untouched (reported unchanged).
 * Shares the create/update/unchanged/dry-run/--overwrite semantics of every
 * other installed file.
 */
async function loadConfigPackageEntry(
  homeDirectory: string,
  sourceRoot: string,
): Promise<LoadedInstallationEntry> {
  const destination = join(homeDirectory, ".config", "opencode", OPENCODE_CONFIG_PACKAGE_FILENAME)
  const source = `generated:${OPENCODE_PLUGIN_DEPENDENCY}`
  const version = await resolvePluginDependencyVersion(sourceRoot)
  const stat = await lstatOrUndefined(destination)
  if (stat && !stat.isFile()) {
    throw new AgentContextPackageInstallationError(
      `Destination is not a regular file: ${destination}`,
    )
  }
  if (!stat) {
    return {
      source,
      destination,
      content: `${JSON.stringify({ dependencies: { [OPENCODE_PLUGIN_DEPENDENCY]: version } }, null, 2)}\n`,
    }
  }
  const existing = await readFile(destination, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(existing)
  } catch {
    throw new AgentContextPackageInstallationError(
      `Existing config package is not valid JSON: ${destination}`,
    )
  }
  if (!isPlainObject(parsed)) {
    throw new AgentContextPackageInstallationError(
      `Existing config package is not a JSON object: ${destination}`,
    )
  }
  const dependencies = parsed.dependencies
  if (dependencies !== undefined && !isPlainObject(dependencies)) {
    throw new AgentContextPackageInstallationError(
      `Existing config package has a non-object dependencies field: ${destination}`,
    )
  }
  if (
    isPlainObject(dependencies) &&
    typeof dependencies[OPENCODE_PLUGIN_DEPENDENCY] === "string"
  ) {
    return { source, destination, content: existing }
  }
  const merged: Record<string, unknown> = {
    ...parsed,
    dependencies: { ...(isPlainObject(dependencies) ? dependencies : {}), [OPENCODE_PLUGIN_DEPENDENCY]: version },
  }
  return { source, destination, content: `${JSON.stringify(merged, null, 2)}\n` }
}

/**
 * Install all Alpha OpenCode agents, role skills, and the SANE plugin.
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
  const rewrittenEntries = sourcedEntries.map((entry) =>
    entry.rewriteImports ? { ...entry, content: rewritePluginImports(entry.content) } : entry,
  )
  try {
    for (const entry of rewrittenEntries) {
      if (entry.agentName !== undefined) {
        validateAgentTaskPermissions(entry.content, entry.agentName, AGENT_FILENAMES)
      }
    }
  } catch (error) {
    throw new AgentContextPackageInstallationError((error as Error).message)
  }
  let configuredEntries = rewrittenEntries
  if (options.modelConfigPath !== undefined) {
    try {
      const models = await loadAgentModelConfig(options.modelConfigPath, AGENT_FILENAMES)
      configuredEntries = rewrittenEntries.map((entry) => ({
        ...entry,
        content: injectAgentModel(entry.content, entry.agentName ? models.get(entry.agentName) : undefined),
      }))
    } catch (error) {
      throw new AgentContextPackageInstallationError((error as Error).message)
    }
  }
  const configPackageEntry = await loadConfigPackageEntry(homeDirectory, sourceRoot)
  const plannedEntries = await planDestinations(
    [...configuredEntries, configPackageEntry],
    options.overwrite === true,
  )
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
  "Usage: sane install context-packages [--dry-run] [--overwrite] [--model-config <path>]"

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
