/**
 * work init - Initialize workstream configuration in a repository
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { getRepoRoot, getWorkDir, getIndexPath } from "../lib/repo.ts"
import { getOrCreateIndex, saveIndex } from "../lib/index.ts"
import { getAgentsYamlPath } from "../lib/agents-yaml.ts"
import { getGitHubConfigPath } from "../lib/github/config.ts"
import { bootstrapSqliteStructuredStorage } from "../lib/sqlite-storage.ts"
import {
  DEFAULT_AGENTS_YAML,
  DEFAULT_GITHUB_JSON,
} from "../defaults/index.ts"

const WORKSTREAM_ROLE_EXPORT = 'export WORKSTREAM_ROLE="USER"'

/**
 * Detect the user's shell config file path
 */
function getShellConfigPath(): string {
  const home = homedir()
  const shell = process.env.SHELL || ""

  if (shell.includes("zsh")) {
    return join(home, ".zshrc")
  } else if (shell.includes("bash")) {
    // Prefer .bash_profile on macOS, .bashrc on Linux
    const bashProfile = join(home, ".bash_profile")
    if (existsSync(bashProfile)) {
      return bashProfile
    }
    return join(home, ".bashrc")
  }
  // Fallback to .profile
  return join(home, ".profile")
}

/**
 * Check if WORKSTREAM_ROLE is already set in the shell config
 */
function isWorkstreamRoleConfigured(configPath: string): boolean {
  if (!existsSync(configPath)) {
    return false
  }
  const content = readFileSync(configPath, "utf-8")
  return content.includes("WORKSTREAM_ROLE")
}

/**
 * Add WORKSTREAM_ROLE=USER to the user's shell config
 * Returns true if added, false if already present
 */
function setupUserEnvironment(): { added: boolean; configPath: string } {
  const configPath = getShellConfigPath()

  if (isWorkstreamRoleConfigured(configPath)) {
    return { added: false, configPath }
  }

  // Ensure file exists
  if (!existsSync(configPath)) {
    writeFileSync(configPath, "", "utf-8")
  }

  // Add the export with a comment
  const addition = `\n# Workstreams CLI - Enable user commands (approve, start, complete)\n${WORKSTREAM_ROLE_EXPORT}\n`
  appendFileSync(configPath, addition, "utf-8")

  return { added: true, configPath }
}

function printHelp(): void {
  console.log(`
Usage: work init [options]

Initialize work/ directory with default configuration files and set up
user environment for workstream commands.

Options:
  --user        Only set up user environment (add WORKSTREAM_ROLE to shell config)
  --sqlite      Bootstrap local sqlite structured storage at work/db.sqlite
  --force       Overwrite existing configuration files
  --help, -h    Show this help message

Environment Setup:
  This command automatically adds WORKSTREAM_ROLE=USER to your shell config
  (~/.zshrc, ~/.bashrc, or ~/.profile) to enable user-only commands like
  'work approve', 'work start', and 'work complete'.
`)
}

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2)
  const force = args.includes("--force")
  const userOnly = args.includes("--user")
  const bootstrapSqlite = args.includes("--sqlite")

  const repoRootIdx = args.indexOf("--repo-root")
  let repoRootArg: string | undefined
  if (repoRootIdx !== -1 && repoRootIdx + 1 < args.length) {
    repoRootArg = args[repoRootIdx + 1]
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    return
  }

  try {
    // Always set up user environment (unless running as agent)
    const { added, configPath } = setupUserEnvironment()
    if (added) {
      console.log(`Added WORKSTREAM_ROLE=USER to ${configPath}`)
      console.log(`Run 'source ${configPath}' or restart your terminal to apply.\n`)
    } else {
      console.log(`WORKSTREAM_ROLE already configured in ${configPath}\n`)
    }

    // If --user flag, only do env setup
    if (userOnly) {
      console.log("User environment setup complete.")
      return
    }

    const repoRoot = getRepoRoot(repoRootArg)
    const workDir = getWorkDir(repoRoot)

    if (!existsSync(workDir)) {
      console.log(`Creating ${workDir}/...`)
      mkdirSync(workDir, { recursive: true })
    }

    // 1. Initialize github.json
    const githubConfigPath = getGitHubConfigPath(repoRoot)
    if (!existsSync(githubConfigPath) || force) {
      console.log(
        `${force && existsSync(githubConfigPath) ? "Overwriting" : "Creating"} github.json (disabled by default)...`,
      )
      writeFileSync(githubConfigPath, DEFAULT_GITHUB_JSON, "utf-8")
    } else {
      console.log("github.json already exists, skipping.")
    }

    // 2. Initialize index.json compatibility projection when needed
    const indexPath = getIndexPath(repoRoot)
    const shouldInitializeCompatibilityIndex = !bootstrapSqlite || existsSync(indexPath) || force
    if (shouldInitializeCompatibilityIndex && (!existsSync(indexPath) || force)) {
      console.log(
        `${force && existsSync(indexPath) ? "Overwriting" : "Initializing"} index.json...`,
      )
      const index = getOrCreateIndex(repoRoot)
      saveIndex(repoRoot, index)
    } else if (existsSync(indexPath)) {
      console.log("index.json already exists, skipping.")
    } else if (bootstrapSqlite) {
      console.log("Skipping index.json compatibility projection; sqlite will be canonical.")
    }

    // 3. Initialize agents.yaml
    const agentsPath = getAgentsYamlPath(repoRoot)
    if (!existsSync(agentsPath) || force) {
      console.log(
        `${force && existsSync(agentsPath) ? "Overwriting" : "Initializing"} agents.yaml...`,
      )
      writeFileSync(agentsPath, DEFAULT_AGENTS_YAML, "utf-8")
    } else {
      console.log("agents.yaml already exists, skipping.")
    }

    if (bootstrapSqlite) {
      const result = bootstrapSqliteStructuredStorage(repoRoot)
      console.log(`Bootstrapped sqlite structured storage at ${result.databasePath}`)
    }

    console.log("\nInitialization complete.")
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}
