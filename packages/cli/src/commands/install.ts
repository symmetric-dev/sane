/**
 * ag install - Installation management
 *
 * Subcommands:
 *   skills    - Install skills to agent directories
 *   hooks     - Install hooks to agent directories
 *   plugins   - Install plugins to agent directories
 *   tools     - Install tools to agent directories
 *   commands  - Install commands to agent directories
 */

import {
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  cpSync,
  mkdirSync,
  readFileSync,
} from "fs"
import { join } from "path"

const AGENV_HOME = process.env.HOME + "/agenv"
const AGENV_SKILLS = join(AGENV_HOME, "agent/skills")
const AGENV_HOOKS = join(AGENV_HOME, "agent/hooks")
const AGENV_PLUGINS = join(AGENV_HOME, "agent/plugins")
const AGENV_TOOLS = join(AGENV_HOME, "agent/tools")
const AGENV_COMMANDS = join(AGENV_HOME, "agent/commands")

// Target directories for different agents
const TARGETS: Record<string, string> = {
  claude: process.env.HOME + "/.claude/skills",
  codex: process.env.HOME + "/.codex/skills",
  gemini: process.env.HOME + "/.gemini/skills",
  antigravity: process.env.HOME + "/.gemini/antigravity/skills",
  opencode: process.env.HOME + "/.config/opencode/skills",
} as Record<string, string>

// Colors for output
const RED = "\x1b[0;31m"
const GREEN = "\x1b[0;32m"
const YELLOW = "\x1b[1;33m"
const NC = "\x1b[0m" // No Color

function printHelp(): void {
  console.log(`
ag install - Installation management

Usage:
  ag install <subcommand> [options]

Subcommands:
  skills     Install skills to agent directories
  hooks      Install hooks to agent settings.json
  plugins    Install plugins to agent directories
  tools      Install tools to agent directories
  commands   Install commands to agent directories

Run 'ag install <subcommand> --help' for more information.
`)
}

function printSkillsHelp(): void {
  console.log(`
ag install skills - Install skills to agent directories

Usage:
  ag install skills [options]

Options:
  --claude       Install to ~/.claude/skills (default if no option given)
  --codex        Install to ~/.codex/skills
  --gemini       Install to ~/.gemini/skills
  --all          Install to all supported agent directories
  --target PATH  Install to a custom directory
  --clean        Remove ALL existing skills in target before installing
  --list         List available skills without installing
  --dry-run      Show what would be installed without making changes
  --help, -h     Show this help message

Examples:
  ag install skills --claude
  ag install skills --all
  ag install skills --clean --claude
  ag install skills --target ~/my-agent/skills
  ag install skills --list
`)
}

function listSkills(): void {
  console.log(`Available skills in ${AGENV_SKILLS}:`)
  console.log("")

  if (!existsSync(AGENV_SKILLS)) {
    console.log(`${YELLOW}No skills directory found${NC}`)
    return
  }

  const entries = readdirSync(AGENV_SKILLS)
  for (const entry of entries) {
    const skillDir = join(AGENV_SKILLS, entry)
    if (!statSync(skillDir).isDirectory()) continue

    const skillMdPath = join(skillDir, "SKILL.md")
    if (existsSync(skillMdPath)) {
      console.log(`  ${entry}`)
      // Try to extract description from SKILL.md frontmatter
      try {
        const content = readFileSync(skillMdPath, "utf-8")
        const match = content.match(/^description:\s*(.+)$/m)
        if (match) {
          console.log(`    └─ ${match[1]}`)
        }
      } catch {
        // Ignore read errors
      }
    } else {
      console.log(`  ${entry} (no SKILL.md)`)
    }
  }
}

function cleanTarget(targetDir: string, dryRun: boolean): number {
  if (!existsSync(targetDir)) return 0

  let removedCount = 0
  const entries = readdirSync(targetDir)

  for (const entry of entries) {
    const skillDir = join(targetDir, entry)
    if (!statSync(skillDir).isDirectory()) continue

    const skillMdPath = join(skillDir, "SKILL.md")
    if (existsSync(skillMdPath)) {
      if (dryRun) {
        console.log(`  [REMOVE] ${entry}`)
      } else {
        rmSync(skillDir, { recursive: true, force: true })
        console.log(`  ${RED}✗${NC} ${entry} (removed)`)
      }
      removedCount++
    }
  }

  if (removedCount > 0 && !dryRun) {
    console.log(`${YELLOW}Removed ${removedCount} existing skills${NC}`)
  }

  return removedCount
}

function installSkillsTo(
  targetDir: string,
  dryRun: boolean,
  clean: boolean,
): void {
  if (!existsSync(AGENV_SKILLS)) {
    console.error(
      `${RED}Error: Source skills directory not found: ${AGENV_SKILLS}${NC}`,
    )
    process.exit(1)
  }

  const entries = readdirSync(AGENV_SKILLS).filter((e) =>
    statSync(join(AGENV_SKILLS, e)).isDirectory(),
  )

  if (entries.length === 0) {
    console.log(`${YELLOW}No skills found in ${AGENV_SKILLS}${NC}`)
    return
  }

  if (dryRun) {
    console.log(`${YELLOW}[DRY RUN]${NC} Would install to: ${targetDir}`)
  } else {
    console.log(`Installing skills to: ${targetDir}`)
    mkdirSync(targetDir, { recursive: true })
  }

  // Clean existing skills if requested
  if (clean) {
    if (dryRun) {
      console.log(`${YELLOW}[DRY RUN]${NC} Would remove existing skills:`)
    } else {
      console.log("Removing existing skills...")
    }
    cleanTarget(targetDir, dryRun)
    console.log("")
  }

  if (dryRun) {
    console.log("Would install:")
  } else {
    console.log("Installing:")
  }

  for (const entry of entries) {
    const skillDir = join(AGENV_SKILLS, entry)
    const targetSkill = join(targetDir, entry)

    if (dryRun) {
      if (existsSync(targetSkill) && !clean) {
        console.log(`  [UPDATE] ${entry}`)
      } else {
        console.log(`  [NEW]    ${entry}`)
      }
    } else {
      // Remove existing and copy fresh
      if (existsSync(targetSkill)) {
        rmSync(targetSkill, { recursive: true, force: true })
      }
      cpSync(skillDir, targetSkill, { recursive: true })
      console.log(`  ${GREEN}✓${NC} ${entry}`)
    }
  }

  if (!dryRun) {
    console.log(
      `${GREEN}Done!${NC} Installed ${entries.length} skills to ${targetDir}`,
    )
  }
}

// ============================================================================
// Hooks Installation
// ============================================================================

// Target settings.json files for hooks
const HOOKS_TARGETS: Record<string, string> = {
  claude: process.env.HOME + "/.claude/settings.json",
} as Record<string, string>

function printHooksHelp(): void {
  console.log(`
ag install hooks - Install hooks to agent settings

Usage:
  ag install hooks [options]

Options:
  --claude       Install to ~/.claude/settings.json (default)
  --list         List available hooks without installing
  --dry-run      Show what would be installed without making changes
  --help, -h     Show this help message

Examples:
  ag install hooks --claude
  ag install hooks --list
  ag install hooks --dry-run
`)
}

function listHooks(): void {
  console.log(`Available hooks in ${AGENV_HOOKS}:`)
  console.log("")

  const hooksFile = join(AGENV_HOOKS, "hooks.json")
  if (!existsSync(hooksFile)) {
    console.log(`${YELLOW}No hooks.json found${NC}`)
    return
  }

  try {
    const content = readFileSync(hooksFile, "utf-8")
    const data = JSON.parse(content)

    if (data.hooks) {
      for (const [hookType, hooks] of Object.entries(data.hooks)) {
        console.log(`  ${hookType}:`)
        if (Array.isArray(hooks)) {
          for (const hook of hooks) {
            const matcher = (hook as { matcher?: string }).matcher || "all"
            console.log(`    └─ matcher: ${matcher}`)
          }
        }
      }
    }
  } catch (e) {
    console.error(`${RED}Error reading hooks.json: ${e}${NC}`)
  }
}

function installHooksTo(targetSettingsPath: string, dryRun: boolean): void {
  const hooksFile = join(AGENV_HOOKS, "hooks.json")

  if (!existsSync(hooksFile)) {
    console.error(`${RED}Error: hooks.json not found at ${hooksFile}${NC}`)
    process.exit(1)
  }

  // Read source hooks
  let sourceHooks: Record<string, unknown>
  try {
    const content = readFileSync(hooksFile, "utf-8")
    sourceHooks = JSON.parse(content)
  } catch (e) {
    console.error(`${RED}Error reading hooks.json: ${e}${NC}`)
    process.exit(1)
  }

  // Read existing target settings
  let targetSettings: Record<string, unknown> = {}
  if (existsSync(targetSettingsPath)) {
    try {
      const content = readFileSync(targetSettingsPath, "utf-8")
      targetSettings = JSON.parse(content)
    } catch (e) {
      console.error(`${RED}Error reading ${targetSettingsPath}: ${e}${NC}`)
      process.exit(1)
    }
  }

  // Merge hooks into settings
  const mergedSettings = {
    ...targetSettings,
    hooks: sourceHooks.hooks || sourceHooks,
  }

  if (dryRun) {
    console.log(`${YELLOW}[DRY RUN]${NC} Would update: ${targetSettingsPath}`)
    console.log("With hooks:")
    console.log(JSON.stringify(mergedSettings.hooks, null, 2))
  } else {
    // Ensure directory exists
    const targetDir = targetSettingsPath.replace(/\/[^/]+$/, "")
    mkdirSync(targetDir, { recursive: true })

    // Write merged settings
    const { writeFileSync } = require("fs")
    writeFileSync(targetSettingsPath, JSON.stringify(mergedSettings, null, 2) + "\n")
    console.log(`${GREEN}✓${NC} Installed hooks to ${targetSettingsPath}`)
  }
}

function hooksCommand(args: string[]): void {
  const targets: string[] = []
  let dryRun = false
  let listOnly = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    switch (arg) {
      case "--claude":
        targets.push(HOOKS_TARGETS.claude!)
        break
      case "--list":
        listOnly = true
        break
      case "--dry-run":
        dryRun = true
        break
      case "--help":
      case "-h":
        printHooksHelp()
        process.exit(0)
      default:
        console.error(`${RED}Error: Unknown option: ${arg}${NC}`)
        printHooksHelp()
        process.exit(1)
    }
    i++
  }

  // Handle list mode
  if (listOnly) {
    listHooks()
    return
  }

  // Default to Claude if no targets specified
  if (targets.length === 0) {
    targets.push(HOOKS_TARGETS.claude!)
  }

  // Install to each target
  for (const target of targets) {
    installHooksTo(target, dryRun)
  }
}

// ============================================================================
// Plugins Installation
// ============================================================================

// Target directories for plugins
const PLUGINS_TARGETS: Record<string, string> = {
  opencode: process.env.HOME + "/.config/opencode/plugins",
} as Record<string, string>

function printPluginsHelp(): void {
  console.log(`
ag install plugins - Install plugins to agent directories

Usage:
  ag install plugins [options]

Options:
  --opencode     Install to ~/.config/opencode/plugins (default)
  --target PATH  Install to a custom directory
  --clean        Remove ALL existing plugins in target before installing
  --list         List available plugins without installing
  --dry-run      Show what would be installed without making changes
  --help, -h     Show this help message

Examples:
  ag install plugins --opencode
  ag install plugins --clean --opencode
  ag install plugins --target ~/my-project/.opencode/plugins
  ag install plugins --list
`)
}

function listPlugins(): void {
  console.log(`Available plugins in ${AGENV_PLUGINS}:`)
  console.log("")

  if (!existsSync(AGENV_PLUGINS)) {
    console.log(`${YELLOW}No plugins directory found${NC}`)
    return
  }

  const entries = readdirSync(AGENV_PLUGINS)
  for (const entry of entries) {
    const pluginPath = join(AGENV_PLUGINS, entry)
    const isDir = statSync(pluginPath).isDirectory()
    const ext = entry.split(".").pop()

    if (isDir || ext === "ts" || ext === "js" || ext === "md") {
      console.log(`  ${entry}`)
    }
  }
}

function cleanPluginsTarget(targetDir: string, dryRun: boolean): number {
  if (!existsSync(targetDir)) return 0

  let removedCount = 0
  const entries = readdirSync(targetDir)

  for (const entry of entries) {
    const pluginPath = join(targetDir, entry)
    const isDir = statSync(pluginPath).isDirectory()
    const ext = entry.split(".").pop()

    if (isDir || ext === "ts" || ext === "js" || ext === "md") {
      if (dryRun) {
        console.log(`  [REMOVE] ${entry}`)
      } else {
        rmSync(pluginPath, { recursive: true, force: true })
        console.log(`  ${RED}✗${NC} ${entry} (removed)`)
      }
      removedCount++
    }
  }

  if (removedCount > 0 && !dryRun) {
    console.log(`${YELLOW}Removed ${removedCount} existing plugins${NC}`)
  }

  return removedCount
}

function installPluginsTo(
  targetDir: string,
  dryRun: boolean,
  clean: boolean,
): void {
  if (!existsSync(AGENV_PLUGINS)) {
    console.error(
      `${RED}Error: Source plugins directory not found: ${AGENV_PLUGINS}${NC}`,
    )
    process.exit(1)
  }

  const entries = readdirSync(AGENV_PLUGINS).filter((e) => {
    const pluginPath = join(AGENV_PLUGINS, e)
    const isDir = statSync(pluginPath).isDirectory()
    const ext = e.split(".").pop()
    return isDir || ext === "ts" || ext === "js" || ext === "md"
  })

  if (entries.length === 0) {
    console.log(`${YELLOW}No plugins found in ${AGENV_PLUGINS}${NC}`)
    return
  }

  if (dryRun) {
    console.log(`${YELLOW}[DRY RUN]${NC} Would install to: ${targetDir}`)
  } else {
    console.log(`Installing plugins to: ${targetDir}`)
    mkdirSync(targetDir, { recursive: true })
  }

  // Clean existing plugins if requested
  if (clean) {
    if (dryRun) {
      console.log(`${YELLOW}[DRY RUN]${NC} Would remove existing plugins:`)
    } else {
      console.log("Removing existing plugins...")
    }
    cleanPluginsTarget(targetDir, dryRun)
    console.log("")
  }

  if (dryRun) {
    console.log("Would install:")
  } else {
    console.log("Installing:")
  }

  for (const entry of entries) {
    const pluginPath = join(AGENV_PLUGINS, entry)
    const targetPlugin = join(targetDir, entry)

    if (dryRun) {
      if (existsSync(targetPlugin) && !clean) {
        console.log(`  [UPDATE] ${entry}`)
      } else {
        console.log(`  [NEW]    ${entry}`)
      }
    } else {
      // Remove existing and copy fresh
      if (existsSync(targetPlugin)) {
        rmSync(targetPlugin, { recursive: true, force: true })
      }
      cpSync(pluginPath, targetPlugin, { recursive: true })
      console.log(`  ${GREEN}✓${NC} ${entry}`)
    }
  }

  if (!dryRun) {
    console.log(
      `${GREEN}Done!${NC} Installed ${entries.length} plugins to ${targetDir}`,
    )
  }
}

function pluginsCommand(args: string[]): void {
  const targets: (string | undefined)[] = []
  let dryRun = false
  let listOnly = false
  let clean = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    switch (arg) {
      case "--opencode":
        targets.push(PLUGINS_TARGETS.opencode!)
        break
      case "--target":
        i++
        if (!args[i]) {
          console.error(`${RED}Error: --target requires a path${NC}`)
          process.exit(1)
        }
        targets.push(args[i])
        break
      case "--clean":
        clean = true
        break
      case "--list":
        listOnly = true
        break
      case "--dry-run":
        dryRun = true
        break
      case "--help":
      case "-h":
        printPluginsHelp()
        process.exit(0)
      default:
        console.error(`${RED}Error: Unknown option: ${arg}${NC}`)
        printPluginsHelp()
        process.exit(1)
    }
    i++
  }

  // Handle list mode
  if (listOnly) {
    listPlugins()
    return
  }

  // Default to OpenCode if no targets specified
  if (targets.length === 0) {
    targets.push(PLUGINS_TARGETS.opencode!)
  }

  // Install to each target
  for (const target of targets) {
    if (!target) continue
    installPluginsTo(target, dryRun, clean)
    console.log("")
  }
}

// ============================================================================
// Tools Installation
// ============================================================================

// Target directories for tools
const TOOLS_TARGETS: Record<string, string> = {
  opencode: process.env.HOME + "/.config/opencode/tools",
} as Record<string, string>

// Target directories for commands
const COMMANDS_TARGETS: Record<string, string> = {
  opencode: process.env.HOME + "/.config/opencode/commands",
} as Record<string, string>

function printToolsHelp(): void {
  console.log(`
ag install tools - Install tools to agent directories

Usage:
  ag install tools [options]

Options:
  --opencode     Install to ~/.config/opencode/tools (default)
  --target PATH  Install to a custom directory
  --clean        Remove ALL existing tools in target before installing
  --list         List available tools without installing
  --dry-run      Show what would be installed without making changes
  --help, -h     Show this help message

Examples:
  ag install tools --opencode
  ag install tools --clean --opencode
  ag install tools --target ~/my-project/.opencode/tools
  ag install tools --list
`)
}

function listTools(): void {
  console.log(`Available tools in ${AGENV_TOOLS}:`)
  console.log("")

  if (!existsSync(AGENV_TOOLS)) {
    console.log(`${YELLOW}No tools directory found${NC}`)
    return
  }

  const entries = readdirSync(AGENV_TOOLS)
  for (const entry of entries) {
    const toolPath = join(AGENV_TOOLS, entry)
    if (isInstallableToolEntry(entry, toolPath)) {
      console.log(`  ${entry}`)
    }
  }
}

function isToolArtifactFile(entry: string): boolean {
  return /\.(test|spec)\.(ts|js|md)$/i.test(entry)
}

function isInstallableToolEntry(entry: string, toolPath: string): boolean {
  const isDir = statSync(toolPath).isDirectory()
  if (isDir) return true

  const ext = entry.split(".").pop()
  if (ext !== "ts" && ext !== "js" && ext !== "md") {
    return false
  }

  return !isToolArtifactFile(entry)
}

function shouldRemoveToolEntry(entry: string, toolPath: string): boolean {
  return isInstallableToolEntry(entry, toolPath) || isToolArtifactFile(entry)
}

function cleanToolsTarget(targetDir: string, dryRun: boolean): number {
  if (!existsSync(targetDir)) return 0

  let removedCount = 0
  const entries = readdirSync(targetDir)

  for (const entry of entries) {
    const toolPath = join(targetDir, entry)

    if (shouldRemoveToolEntry(entry, toolPath)) {
      if (dryRun) {
        console.log(`  [REMOVE] ${entry}`)
      } else {
        rmSync(toolPath, { recursive: true, force: true })
        console.log(`  ${RED}✗${NC} ${entry} (removed)`)
      }
      removedCount++
    }
  }

  if (removedCount > 0 && !dryRun) {
    console.log(`${YELLOW}Removed ${removedCount} existing tools${NC}`)
  }

  return removedCount
}

function installToolsTo(
  targetDir: string,
  dryRun: boolean,
  clean: boolean,
): void {
  if (!existsSync(AGENV_TOOLS)) {
    console.error(
      `${RED}Error: Source tools directory not found: ${AGENV_TOOLS}${NC}`,
    )
    process.exit(1)
  }

  const entries = readdirSync(AGENV_TOOLS).filter((e) => {
    const toolPath = join(AGENV_TOOLS, e)
    return isInstallableToolEntry(e, toolPath)
  })

  if (entries.length === 0) {
    console.log(`${YELLOW}No tools found in ${AGENV_TOOLS}${NC}`)
    return
  }

  if (dryRun) {
    console.log(`${YELLOW}[DRY RUN]${NC} Would install to: ${targetDir}`)
  } else {
    console.log(`Installing tools to: ${targetDir}`)
    mkdirSync(targetDir, { recursive: true })
  }

  // Clean existing tools if requested
  if (clean) {
    if (dryRun) {
      console.log(`${YELLOW}[DRY RUN]${NC} Would remove existing tools:`)
    } else {
      console.log("Removing existing tools...")
    }
    cleanToolsTarget(targetDir, dryRun)
    console.log("")
  }

  if (dryRun) {
    console.log("Would install:")
  } else {
    console.log("Installing:")
  }

  for (const entry of entries) {
    const toolPath = join(AGENV_TOOLS, entry)
    const targetTool = join(targetDir, entry)

    if (dryRun) {
      if (existsSync(targetTool) && !clean) {
        console.log(`  [UPDATE] ${entry}`)
      } else {
        console.log(`  [NEW]    ${entry}`)
      }
    } else {
      // Remove existing and copy fresh
      if (existsSync(targetTool)) {
        rmSync(targetTool, { recursive: true, force: true })
      }
      cpSync(toolPath, targetTool, { recursive: true })
      console.log(`  ${GREEN}✓${NC} ${entry}`)
    }
  }

  if (!dryRun) {
    console.log(
      `${GREEN}Done!${NC} Installed ${entries.length} tools to ${targetDir}`,
    )
  }
}

function toolsCommand(args: string[]): void {
  const targets: (string | undefined)[] = []
  let dryRun = false
  let listOnly = false
  let clean = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    switch (arg) {
      case "--opencode":
        targets.push(TOOLS_TARGETS.opencode!)
        break
      case "--target":
        i++
        if (!args[i]) {
          console.error(`${RED}Error: --target requires a path${NC}`)
          process.exit(1)
        }
        targets.push(args[i])
        break
      case "--clean":
        clean = true
        break
      case "--list":
        listOnly = true
        break
      case "--dry-run":
        dryRun = true
        break
      case "--help":
      case "-h":
        printToolsHelp()
        process.exit(0)
      default:
        console.error(`${RED}Error: Unknown option: ${arg}${NC}`)
        printToolsHelp()
        process.exit(1)
    }
    i++
  }

  // Handle list mode
  if (listOnly) {
    listTools()
    return
  }

  // Default to OpenCode if no targets specified
  if (targets.length === 0) {
    targets.push(TOOLS_TARGETS.opencode!)
  }

  // Install to each target
  for (const target of targets) {
    if (!target) continue
    installToolsTo(target, dryRun, clean)
    console.log("")
  }
}

// ============================================================================
// Commands Installation
// ============================================================================

function printCommandsHelp(): void {
  console.log(`
ag install commands - Install commands to agent directories

Usage:
  ag install commands [options]

Options:
  --opencode     Install to ~/.config/opencode/commands (default)
  --target PATH  Install to a custom directory
  --clean        Remove ALL existing commands in target before installing
  --list         List available commands without installing
  --dry-run      Show what would be installed without making changes
  --help, -h     Show this help message

Examples:
  ag install commands --opencode
  ag install commands --clean --opencode
  ag install commands --target ~/my-project/.opencode/commands
  ag install commands --list
`)
}

function listCommands(): void {
  console.log(`Available commands in ${AGENV_COMMANDS}:`)
  console.log("")

  if (!existsSync(AGENV_COMMANDS)) {
    console.log(`${YELLOW}No commands directory found${NC}`)
    return
  }

  const entries = readdirSync(AGENV_COMMANDS)
  for (const entry of entries) {
    const commandPath = join(AGENV_COMMANDS, entry)
    const isDir = statSync(commandPath).isDirectory()
    const ext = entry.split(".").pop()

    if (isDir || ext === "ts" || ext === "js" || ext === "md") {
      console.log(`  ${entry}`)
    }
  }
}

function cleanCommandsTarget(targetDir: string, dryRun: boolean): number {
  if (!existsSync(targetDir)) return 0

  let removedCount = 0
  const entries = readdirSync(targetDir)

  for (const entry of entries) {
    const commandPath = join(targetDir, entry)
    const isDir = statSync(commandPath).isDirectory()
    const ext = entry.split(".").pop()

    if (isDir || ext === "ts" || ext === "js" || ext === "md") {
      if (dryRun) {
        console.log(`  [REMOVE] ${entry}`)
      } else {
        rmSync(commandPath, { recursive: true, force: true })
        console.log(`  ${RED}✗${NC} ${entry} (removed)`)
      }
      removedCount++
    }
  }

  if (removedCount > 0 && !dryRun) {
    console.log(`${YELLOW}Removed ${removedCount} existing commands${NC}`)
  }

  return removedCount
}

function installCommandsTo(
  targetDir: string,
  dryRun: boolean,
  clean: boolean,
): void {
  if (!existsSync(AGENV_COMMANDS)) {
    console.error(
      `${RED}Error: Source commands directory not found: ${AGENV_COMMANDS}${NC}`,
    )
    process.exit(1)
  }

  const entries = readdirSync(AGENV_COMMANDS).filter((e) => {
    const commandPath = join(AGENV_COMMANDS, e)
    const isDir = statSync(commandPath).isDirectory()
    const ext = e.split(".").pop()
    return isDir || ext === "ts" || ext === "js" || ext === "md"
  })

  if (entries.length === 0) {
    console.log(`${YELLOW}No commands found in ${AGENV_COMMANDS}${NC}`)
    return
  }

  if (dryRun) {
    console.log(`${YELLOW}[DRY RUN]${NC} Would install to: ${targetDir}`)
  } else {
    console.log(`Installing commands to: ${targetDir}`)
    mkdirSync(targetDir, { recursive: true })
  }

  // Clean existing commands if requested
  if (clean) {
    if (dryRun) {
      console.log(`${YELLOW}[DRY RUN]${NC} Would remove existing commands:`)
    } else {
      console.log("Removing existing commands...")
    }
    cleanCommandsTarget(targetDir, dryRun)
    console.log("")
  }

  if (dryRun) {
    console.log("Would install:")
  } else {
    console.log("Installing:")
  }

  for (const entry of entries) {
    const commandPath = join(AGENV_COMMANDS, entry)
    const targetCommand = join(targetDir, entry)

    if (dryRun) {
      if (existsSync(targetCommand) && !clean) {
        console.log(`  [UPDATE] ${entry}`)
      } else {
        console.log(`  [NEW]    ${entry}`)
      }
    } else {
      // Remove existing and copy fresh
      if (existsSync(targetCommand)) {
        rmSync(targetCommand, { recursive: true, force: true })
      }
      cpSync(commandPath, targetCommand, { recursive: true })
      console.log(`  ${GREEN}✓${NC} ${entry}`)
    }
  }

  if (!dryRun) {
    console.log(
      `${GREEN}Done!${NC} Installed ${entries.length} commands to ${targetDir}`,
    )
  }
}

function commandsCommand(args: string[]): void {
  const targets: (string | undefined)[] = []
  let dryRun = false
  let listOnly = false
  let clean = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    switch (arg) {
      case "--opencode":
        targets.push(COMMANDS_TARGETS.opencode!)
        break
      case "--target":
        i++
        if (!args[i]) {
          console.error(`${RED}Error: --target requires a path${NC}`)
          process.exit(1)
        }
        targets.push(args[i])
        break
      case "--clean":
        clean = true
        break
      case "--list":
        listOnly = true
        break
      case "--dry-run":
        dryRun = true
        break
      case "--help":
      case "-h":
        printCommandsHelp()
        process.exit(0)
      default:
        console.error(`${RED}Error: Unknown option: ${arg}${NC}`)
        printCommandsHelp()
        process.exit(1)
    }
    i++
  }

  // Handle list mode
  if (listOnly) {
    listCommands()
    return
  }

  // Default to OpenCode if no targets specified
  if (targets.length === 0) {
    targets.push(COMMANDS_TARGETS.opencode!)
  }

  // Install to each target
  for (const target of targets) {
    if (!target) continue
    installCommandsTo(target, dryRun, clean)
    console.log("")
  }
}

function skillsCommand(args: string[]): void {
  const targets: (string | undefined)[] = []
  let dryRun = false
  let listOnly = false
  let clean = false

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    switch (arg) {
      case "--claude":
        targets.push(TARGETS.claude)
        break
      case "--codex":
        targets.push(TARGETS.codex)
        break
      case "--gemini":
        targets.push(TARGETS.gemini)
        break
      case "--antigravity":
        targets.push(TARGETS.antigravity)
        break
      case "--opencode":
        targets.push(TARGETS.opencode)
        break
      case "--all":
        targets.push(
          TARGETS.claude,
          TARGETS.codex,
          TARGETS.gemini,
          TARGETS.antigravity,
          TARGETS.opencode,
        )
        break
      case "--target":
        i++
        if (!args[i]) {
          console.error(`${RED}Error: --target requires a path${NC}`)
          process.exit(1)
        }
        targets.push(args[i])
        break
      case "--clean":
        clean = true
        break
      case "--list":
        listOnly = true
        break
      case "--dry-run":
        dryRun = true
        break
      case "--help":
      case "-h":
        printSkillsHelp()
        process.exit(0)
      default:
        console.error(`${RED}Error: Unknown option: ${arg}${NC}`)
        printSkillsHelp()
        process.exit(1)
    }
    i++
  }

  // Handle list mode
  if (listOnly) {
    listSkills()
    return
  }

  // Default to Claude if no targets specified
  if (targets.length === 0) {
    targets.push(TARGETS.claude)
  }

  // Install to each target
  for (const target of targets) {
    if (!target) continue
    installSkillsTo(target, dryRun, clean)
    console.log("")
  }
}

export function main(argv: string[]): void {
  const args = argv.slice(2) // Remove 'bun' and 'ag-install'

  if (args.length === 0) {
    printHelp()
    process.exit(0)
  }

  const subcommand = args[0]

  if (subcommand === "--help" || subcommand === "-h") {
    printHelp()
    process.exit(0)
  }

  switch (subcommand) {
    case "skills":
      skillsCommand(args.slice(1))
      break
    case "hooks":
      hooksCommand(args.slice(1))
      break
    case "plugins":
      pluginsCommand(args.slice(1))
      break
    case "tools":
      toolsCommand(args.slice(1))
      break
    case "commands":
      commandsCommand(args.slice(1))
      break
    default:
      console.error(`Error: Unknown subcommand "${subcommand}"`)
      console.error("\nAvailable subcommands: skills, hooks, plugins, tools, commands")
      console.error("\nRun 'ag install --help' for usage information.")
      process.exit(1)
  }
}
