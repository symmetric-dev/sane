/**
 * CLI: Show Notification Configuration
 *
 * Displays the current notification configuration and provider status.
 */

import { getRepoRoot } from "../lib/repo.ts"
import {
  loadNotificationsConfig,
  getNotificationsConfigPath,
} from "../lib/notifications/config.ts"
import type { NotificationsConfig } from "../lib/notifications/types.ts"

/**
 * Arguments for the notifications CLI command
 */
interface NotificationsCliArgs {
  repoRoot?: string
  json: boolean
}

/**
 * Print help message for the notifications command
 */
function printHelp(): void {
  console.log(`
work notifications - Show notification configuration

Usage:
  work notifications                    # Show configuration
  work notifications --json             # Output as JSON

Options:
  --repo-root, -r    Repository root (auto-detected if omitted)
  --json, -j         Output as JSON for machine-readable format
  --help, -h         Show this help message
  `)
}

/**
 * Parse CLI arguments
 * @param argv - Process arguments
 * @returns Parsed arguments or null if validation fails
 */
function parseCliArgs(argv: string[]): NotificationsCliArgs | null {
  const args = argv.slice(2)
  const parsed: NotificationsCliArgs = { json: false }


  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value")
          return null
        }
        parsed.repoRoot = next
        i++
        break

      case "--json":
      case "-j":
        parsed.json = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed
}

/**
 * Format configuration output for human-readable display
 * @param config - The notification configuration object
 * @param path - Path to the configuration file
 */
function formatOutput(config: NotificationsConfig, path: string): void {
  console.log("Notification Configuration")
  console.log("==========================")
  console.log(`Global Status: ${config.enabled ? "Enabled" : "Disabled"}`)
  console.log(`Config File:   ${path}`)
  console.log("")

  console.log("Providers:")
  const providers = config.providers
  if (providers.sound) {
    console.log(`- Sound:             ${providers.sound.enabled ? "Enabled" : "Disabled"}`)
  }
  if (providers.notification_center) {
    console.log(`- Notification Center: ${providers.notification_center.enabled ? "Enabled" : "Disabled"}`)
  }
  if (providers.terminal_notifier) {
    console.log(`- Terminal Notifier: ${providers.terminal_notifier.enabled ? "Enabled" : "Disabled"}`)
  }
  if (providers.tts) {
    console.log(`- Text-to-Speech:    ${providers.tts.enabled ? "Enabled" : "Disabled"}`)
  }
  console.log("")

  console.log("Events:")
  const events = config.events
  console.log(`- Thread Complete:    ${events.thread_complete ? "On" : "Off"}`)
  console.log(`- Batch Complete:     ${events.batch_complete ? "On" : "Off"}`)
  console.log(`- Error:              ${events.error ? "On" : "Off"}`)
}

/**
 * Main entry point for the notifications command
 * @param argv - Command line arguments
 */
export function main(argv: string[] = process.argv): void {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  // Auto-detect repo root if not provided
  let repoRoot: string
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  const config = loadNotificationsConfig(repoRoot)
  const configPath = getNotificationsConfigPath(repoRoot)

  if (cliArgs.json) {
    console.log(JSON.stringify(config, null, 2))
  } else {
    formatOutput(config, configPath)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
