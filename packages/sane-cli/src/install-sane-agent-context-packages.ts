import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { injectAgentModel, loadAgentModelConfig, validateAgentTaskPermissions } from "./agent-model-config.ts"
import { ccAgentFilename, parseSaneAgent, serializeCcAgent, serializeCcSettings } from "./agent-serialization.ts"
import { CLAUDE_PRE_TOOL_USE_MATCHER } from "./native-configuration.ts"

export const AGENT_FILENAMES = [
  "sane/assistant/curation.md",
  "sane/assistant/design.md",
  "sane/assistant/engineering.md",
  "sane/assistant/experimentation.md",
  "sane/assistant/execution.md",
  "sane/assistant/planning.md",
  "sane/assistant/research.md",
  "sane/worker/fixer.md",
  "sane/worker/grounder.md",
  "sane/worker/implementer.md",
  "sane/worker/researcher.md",
  "sane/worker/reviewer.md",
  "sane/worker/scout-crew.md",
  "sane/worker/scout.md",
  "sane/worker/tester.md",
] as const

export const ROLE_SKILL_NAMES = [
  "sane-assistant-curation-pickup",
  "sane-assistant-curation-assistance",
  "sane-assistant-curation-delivery",
  "sane-assistant-design-pickup",
  "sane-assistant-design-assistance",
  "sane-assistant-design-delivery",
  "sane-assistant-engineering-pickup",
  "sane-assistant-engineering-assistance",
  "sane-assistant-engineering-delivery",
  "sane-assistant-experimentation-pickup",
  "sane-assistant-experimentation-assistance",
  "sane-assistant-experimentation-delivery",
  "sane-assistant-execution-pickup",
  "sane-assistant-execution-assistance",
  "sane-assistant-execution-delivery",
  "sane-assistant-planning-pickup",
  "sane-assistant-planning-assistance",
  "sane-assistant-planning-delivery",
  "sane-assistant-research-pickup",
  "sane-assistant-research-assistance",
  "sane-assistant-research-delivery",
] as const

/** Project-authored skills needed across implementation repositories. */
export const GLOBAL_SUPPORT_SKILL_NAMES = ["review-opencode-sessions"] as const

const RETIRED_ROLE_SKILL_NAMES = [
  "sane-design-assistant-role",
  "sane-engineering-assistant-role",
  "sane-planning-assistant-role",
  "sane-execution-assistant-role",
  "sane-research-assistant-role",
] as const

export const PLUGIN_SRC_FILES: readonly string[] = ["cli-arguments.ts", "native-caller.ts", "native-opencode.ts", "native-claude.ts", "native-claude-hook.ts", "native-claude-mcp.ts", "native-configuration.ts", "native-handoff.ts", "native-worker-contract.ts", "native-worker.ts"]

export const PLUGIN_CORE_SRC_FILES: readonly string[] = ["agent-catalog.ts", "artifact-lock.ts", "bootstrap-registry.ts", "bootstrap-validation.ts", "confined-lifecycle-filesystem.ts", "contracts.ts", "document-catalog.ts", "errors.ts", "execution-report-validation.ts", "handoff.ts", "job-policy.ts", "lifecycle-filesystem.ts", "lifecycle.ts", "native-source.ts", "provision.ts", "repository.ts", "schema.ts", "schema-upgrade.ts", "server.ts", "slots.ts", "validation.ts", "workstream-type.ts"]

export const PLUGIN_FILENAMES = [
  "sane/index.ts",
  ...PLUGIN_SRC_FILES.map((filename) => `sane/runtime/packages/sane-cli/src/${filename}`),
  ...PLUGIN_CORE_SRC_FILES.map(filename => `sane/runtime/packages/sane-core/src/${filename}`),
] as const

/** Prefix used by the plugin source for `sane-cli` imports (rewritten on install). */
export const PLUGIN_SRC_IMPORT_PREFIX = "../../../packages/sane-cli/src/"
/** Replacement prefix pointing at the vendored closure next to the installed plugin. */
export const PLUGIN_DEST_IMPORT_PREFIX = "./runtime/packages/sane-cli/src/"

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
  /** Install only this global support skill, leaving agents, plugins, and other skills untouched. */
  onlySkill?: (typeof GLOBAL_SUPPORT_SKILL_NAMES)[number]
  write?: (line: string) => void
}

export interface AgentContextPackageInstallationResult {
  homeDirectory: string
  dryRun: boolean
  created: string[]
  updated: string[]
  unchanged: string[]
  /** Retired skill directories removed, or planned for removal in a dry run. */
  removed: string[]
}

interface InstallationEntry {
  source: string
  destination: string
  agentName?: string
  /** Rewrite `sane-cli` import prefixes for the installed plugin copy. */
  rewriteImports?: boolean
  resource?: boolean
}

interface LoadedInstallationEntry extends InstallationEntry {
  content: string | Buffer
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
    ...ROLE_SKILL_NAMES.map((skillName) => ({
      source: join(sourceRoot, "skills", skillName, "SKILL.md"),
      destination: join(homeDirectory, ".claude", "skills", skillName, "SKILL.md"),
    })),
    ...GLOBAL_SUPPORT_SKILL_NAMES.map((skillName) => ({
      source: join(sourceRoot, ".opencode", "skills", skillName, "SKILL.md"),
      destination: join(homeDirectory, ".config", "opencode", "skills", skillName, "SKILL.md"),
    })),
    ...GLOBAL_SUPPORT_SKILL_NAMES.map((skillName) => ({
      source: join(sourceRoot, ".opencode", "skills", skillName, "SKILL.md"),
      destination: join(homeDirectory, ".claude", "skills", skillName, "SKILL.md"),
    })),
    {
      rewriteImports: true,
      source: join(sourceRoot, "opencode", "plugins", "sane", "index.ts"),
      destination: join(homeDirectory, ".config", "opencode", "plugins", "sane", "index.ts"),
    },
    ...PLUGIN_SRC_FILES.map((filename) => ({
      rewriteImports: true,
      source: join(sourceRoot, "packages", "sane-cli", "src", filename),
      destination: join(
        homeDirectory,
        ".config",
        "opencode",
        "plugins",
        "sane",
        "runtime", "packages", "sane-cli", "src",
        filename,
      ),
    })),
    ...PLUGIN_CORE_SRC_FILES.map(filename => ({
      source: join(sourceRoot, "packages", "sane-core", "src", filename),
      destination: join(homeDirectory, ".config", "opencode", "plugins", "sane", "runtime", "packages", "sane-core", "src", filename),
    })),
  ]
}

async function resourceInstallationEntries(
  sourceRoot: string,
  homeDirectory: string,
): Promise<InstallationEntry[]> {
  const entries: InstallationEntry[] = []
  async function visit(source: string, destination: string, optional = false): Promise<void> {
    const stat = await lstatOrUndefined(source)
    if (!stat && optional) return
    if (!stat?.isDirectory()) {
      throw new AgentContextPackageInstallationError(`Resource source must be a directory: ${source}`)
    }
    for (const name of (await readdir(source)).sort()) {
      const childSource = join(source, name)
      const childDestination = join(destination, name)
      const childStat = await lstatOrUndefined(childSource)
      if (childStat?.isDirectory()) {
        await visit(childSource, childDestination)
      } else if (childStat?.isFile()) {
        entries.push({ source: childSource, destination: childDestination, resource: true })
      } else {
        throw new AgentContextPackageInstallationError(`Required source must be a regular file: ${childSource}`)
      }
    }
  }
  for (const skillName of ROLE_SKILL_NAMES) {
    await visit(
      join(sourceRoot, "skills", skillName, "resources"),
      join(homeDirectory, ".agents", "skills", skillName, "resources"),
      true,
    )
    await visit(
      join(sourceRoot, "skills", skillName, "resources"),
      join(homeDirectory, ".claude", "skills", skillName, "resources"),
      true,
    )
  }
  return entries
}

/**
 * Derive global CC agent files + per-agent settings profiles from loaded OC
 * agent entries. CC agents keep all tools (no `tools` restriction); the
 * ask/allow profile lives in the sibling settings file. OC model overrides
 * never leak into CC output.
 */
function ccAgentEntriesFromLoaded(
  entries: LoadedInstallationEntry[],
  homeDirectory: string,
): LoadedInstallationEntry[] {
  return entries
    .filter((entry) => entry.agentName !== undefined && typeof entry.content === "string")
    .flatMap((entry) => {
      const spec = parseSaneAgent(entry.content.toString(), entry.agentName!)
      const ccName = ccAgentFilename(entry.agentName!)
      return [
        {
          source: entry.source,
          destination: join(homeDirectory, ".claude", "agents", ccName),
          content: serializeCcAgent(spec),
        },
        {
          source: entry.source,
          destination: join(homeDirectory, ".claude", "sane-agent-settings", ccName.replace(/\.md$/, ".settings.json")),
          content: serializeCcSettings(spec),
        },
      ]
    })
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
      return { ...entry, content: entry.resource ? await readFile(entry.source) : await readFile(entry.source, "utf8") }
    }),
  )
}

/** Reject an existing non-directory ancestor before any installation write. */
async function validateDestinationParent(destination: string): Promise<void> {
  const ancestors: string[] = []
  let ancestor = dirname(destination)
  while (true) {
    ancestors.push(ancestor)
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  // Check from the root so even lstat never traverses a symlinked ancestor.
  for (const ancestor of ancestors.reverse()) {
    const stat = await lstatOrUndefined(ancestor)
    if (stat) {
      if (!stat.isDirectory()) {
        throw new AgentContextPackageInstallationError(
          `Destination parent is not a directory: ${ancestor}`,
        )
      }
    }
  }
}

async function planRetiredSkillRemovals(homeDirectory: string): Promise<string[]> {
  const removals: string[] = []
  for (const name of RETIRED_ROLE_SKILL_NAMES) {
    const destination = join(homeDirectory, ".agents", "skills", name)
    await validateDestinationParent(destination)
    const stat = await lstatOrUndefined(destination)
    if (!stat) continue
    if (!stat.isDirectory()) {
      throw new AgentContextPackageInstallationError(`Retired skill is not a directory: ${destination}`)
    }
    removals.push(destination)
  }
  return removals
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
      const identical = typeof entry.content === "string"
        ? (await readFile(entry.destination, "utf8")) === entry.content
        : (await readFile(entry.destination)).equals(entry.content)
      if (identical) {
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

/** Upgrade only existing native SANE hooks, retaining their configured command paths. */
async function loadClaudeHookSettingsEntries(homeDirectory: string): Promise<LoadedInstallationEntry[]> {
  const destination = join(homeDirectory, ".claude", "settings.json")
  await validateDestinationParent(destination)
  const stat = await lstatOrUndefined(destination)
  if (!stat) return []
  if (!stat.isFile()) {
    throw new AgentContextPackageInstallationError(`Destination is not a regular file: ${destination}`)
  }
  const existing = await readFile(destination, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(existing)
  } catch {
    throw new AgentContextPackageInstallationError(`Existing Claude settings are not valid JSON: ${destination}`)
  }
  if (!isPlainObject(parsed)) {
    throw new AgentContextPackageInstallationError(`Existing Claude settings are not a JSON object: ${destination}`)
  }
  if (!isPlainObject(parsed.hooks) || !Array.isArray(parsed.hooks.PreToolUse)) return []
  const isSaneHook = (hook: unknown): boolean =>
    isPlainObject(hook) && hook.type === "command" && typeof hook.command === "string" &&
    /\/runtime\/packages\/sane-cli\/src\/native-claude-hook\.ts(?:['"])?(?=\s|$)/.test(hook.command)
  let found = false
  let changed = false
  parsed.hooks.PreToolUse = parsed.hooks.PreToolUse.flatMap((entry: unknown) => {
    if (!isPlainObject(entry) || !Array.isArray(entry.hooks) || !entry.hooks.some(isSaneHook)) return [entry]
    found = true
    if (entry.matcher === CLAUDE_PRE_TOOL_USE_MATCHER) return [entry]
    changed = true
    if (entry.hooks.every(isSaneHook)) return [{ ...entry, matcher: CLAUDE_PRE_TOOL_USE_MATCHER }]
    // Keep mixed hook groups in order without broadening unrelated hook matchers.
    return entry.hooks.map((hook: unknown) => ({
      ...entry,
      ...(isSaneHook(hook) ? { matcher: CLAUDE_PRE_TOOL_USE_MATCHER } : {}),
      hooks: [hook],
    }))
  })
  return found ? [{
    source: "generated:claude-sane-hook-matcher",
    destination,
    content: changed ? `${JSON.stringify(parsed, null, 2)}\n` : existing,
  }] : []
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
  const requiredDependencies = { [OPENCODE_PLUGIN_DEPENDENCY]: version, "@opencode/client": "2.0.18", "@modelcontextprotocol/sdk": "^1.25.0" }
  await validateDestinationParent(destination)
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
      content: `${JSON.stringify({ dependencies: requiredDependencies }, null, 2)}\n`,
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
    Object.keys(requiredDependencies).every(name => typeof dependencies[name] === "string")
  ) {
    return { source, destination, content: existing }
  }
  const merged: Record<string, unknown> = {
    ...parsed,
    dependencies: { ...requiredDependencies, ...(isPlainObject(dependencies) ? dependencies : {}) },
  }
  return { source, destination, content: `${JSON.stringify(merged, null, 2)}\n` }
}

/**
 * Install all Alpha OpenCode agents, role skills, and the SANE plugin.
 * All source, destination, and removal checks finish before any mutation.
 * Retired skills are removed only after installation writes succeed.
 */
export async function installSaneAgentContextPackages(
  options: AgentContextPackageInstallationOptions = {},
): Promise<AgentContextPackageInstallationResult> {
  const write = options.write ?? console.log
  const homeDirectory = resolveHomeDirectory(options.homeDirectory)
  const sourceRoot = resolve(options.sourceRoot ?? DEFAULT_SOURCE_ROOT)
  if (options.onlySkill === undefined) {
    for (const name of ["sane-src", "sane-core"]) {
      const retired = join(homeDirectory, ".config", "opencode", "plugins", "sane", name)
      await validateDestinationParent(retired)
      if (await lstatOrUndefined(retired)) {
        throw new AgentContextPackageInstallationError(
          `Obsolete native plugin closure present: ${retired}. Use a fresh isolated home or explicitly retire obsolete copies and unload the old plugin before installation. --overwrite does not authorize cleanup.`,
        )
      }
    }
  }
  if (options.onlySkill !== undefined && !GLOBAL_SUPPORT_SKILL_NAMES.includes(options.onlySkill)) {
    throw new AgentContextPackageInstallationError(`Unknown global support skill: ${options.onlySkill}`)
  }
  const sourcedEntries = await validateSources(options.onlySkill === undefined
    ? [...installationEntries(sourceRoot, homeDirectory), ...await resourceInstallationEntries(sourceRoot, homeDirectory)]
    : [{
        source: join(sourceRoot, ".opencode", "skills", options.onlySkill, "SKILL.md"),
        destination: join(homeDirectory, ".config", "opencode", "skills", options.onlySkill, "SKILL.md"),
      }, {
        source: join(sourceRoot, ".opencode", "skills", options.onlySkill, "SKILL.md"),
        destination: join(homeDirectory, ".claude", "skills", options.onlySkill, "SKILL.md"),
      }])
  const rewrittenEntries = sourcedEntries.map((entry) =>
    entry.rewriteImports ? { ...entry, content: rewritePluginImports(entry.content.toString()) } : entry,
  )
  try {
    for (const entry of rewrittenEntries) {
      if (entry.agentName !== undefined) {
        validateAgentTaskPermissions(entry.content.toString(), entry.agentName, AGENT_FILENAMES)
      }
    }
  } catch (error) {
    throw new AgentContextPackageInstallationError((error as Error).message)
  }
  let ccDerivedEntries: LoadedInstallationEntry[] = []
  if (options.onlySkill === undefined) {
    try {
      ccDerivedEntries = ccAgentEntriesFromLoaded(rewrittenEntries, homeDirectory)
    } catch (error) {
      throw new AgentContextPackageInstallationError((error as Error).message)
    }
  }
  const allEntries = [...rewrittenEntries, ...ccDerivedEntries]
  let configuredEntries = allEntries
  if (options.modelConfigPath !== undefined) {
    try {
      const models = await loadAgentModelConfig(options.modelConfigPath, AGENT_FILENAMES)
      configuredEntries = allEntries.map((entry) => ({
        ...entry,
        content: entry.agentName ? injectAgentModel(entry.content.toString(), models.get(entry.agentName)) : entry.content,
      }))
    } catch (error) {
      throw new AgentContextPackageInstallationError((error as Error).message)
    }
  }
  const configPackageEntry = options.onlySkill === undefined
    ? [await loadConfigPackageEntry(homeDirectory, sourceRoot)] : []
  const claudeHookSettingsEntries = options.onlySkill === undefined
    ? await loadClaudeHookSettingsEntries(homeDirectory) : []
  const plannedEntries = await planDestinations(
    [...configuredEntries, ...configPackageEntry, ...claudeHookSettingsEntries],
    options.overwrite === true,
  )
  const removals = options.onlySkill === undefined ? await planRetiredSkillRemovals(homeDirectory) : []
  const result: AgentContextPackageInstallationResult = {
    homeDirectory,
    dryRun: options.dryRun === true,
    created: plannedEntries.filter((entry) => entry.action === "create").map((entry) => entry.destination),
    updated: plannedEntries.filter((entry) => entry.action === "update").map((entry) => entry.destination),
    unchanged: plannedEntries.filter((entry) => entry.action === "unchanged").map((entry) => entry.destination),
    removed: removals,
  }

  if (options.dryRun) {
    write("Dry run: no files or directories were modified.")
    for (const entry of plannedEntries) {
      write(`${entry.action === "unchanged" ? "Unchanged" : "Planned"}: ${entry.destination}`)
    }
    for (const destination of removals) write(`Planned removal: ${destination}`)
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
  for (const destination of removals) {
    // rm unlinks descendant symlinks rather than following them. Local contents
    // of these exact retired directories are intentionally removed as well.
    await rm(destination, { recursive: true, force: true })
    write(`Removed: ${destination}`)
  }
  return result
}

export const USAGE =
  "Usage: sane install context-packages [--dry-run] [--overwrite] [--model-config <path>] [--only <global-support-skill>]"

export function parseCliArguments(args: string[]): { dryRun: boolean; overwrite: boolean; modelConfigPath?: string; onlySkill?: (typeof GLOBAL_SUPPORT_SKILL_NAMES)[number] } {
  let dryRun = false
  let overwrite = false
  let modelConfigPath: string | undefined
  let onlySkill: (typeof GLOBAL_SUPPORT_SKILL_NAMES)[number] | undefined
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
    } else if (parseOptions && argument === "--only") {
      const skill = args[++index]
      if (!skill || !GLOBAL_SUPPORT_SKILL_NAMES.includes(skill as (typeof GLOBAL_SUPPORT_SKILL_NAMES)[number])) {
        throw new AgentContextPackageInstallationError(`--only requires a global support skill: ${GLOBAL_SUPPORT_SKILL_NAMES.join(", ")}.`)
      }
      if (onlySkill !== undefined) throw new AgentContextPackageInstallationError("--only may only be specified once.")
      onlySkill = skill as (typeof GLOBAL_SUPPORT_SKILL_NAMES)[number]
    } else if (parseOptions && argument.startsWith("-")) {
      throw new AgentContextPackageInstallationError(`Unknown option: ${argument}`)
    } else {
      positional.push(argument)
    }
  }

  if (positional.length > 0) {
    throw new AgentContextPackageInstallationError("This command does not accept positional arguments.")
  }
  if (onlySkill !== undefined && modelConfigPath !== undefined) {
    throw new AgentContextPackageInstallationError("--only cannot be combined with --model-config.")
  }
  return { dryRun, overwrite, ...(modelConfigPath === undefined ? {} : { modelConfigPath }), ...(onlySkill === undefined ? {} : { onlySkill }) }
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
