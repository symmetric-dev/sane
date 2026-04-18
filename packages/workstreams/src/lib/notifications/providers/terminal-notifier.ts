/**
 * Terminal Notifier Provider
 *
 * Uses terminal-notifier for enhanced macOS notifications with additional features:
 * - Custom app icon
 * - Click to activate VSCode
 * - Notification grouping
 */

import { spawn, execSync } from "child_process"
import {
  type NotificationProvider,
  type NotificationEvent,
  type NotificationMetadata,
  type TerminalNotifierConfig,
} from "../types"

/**
 * Human-readable titles for notification events
 */
const EVENT_TITLES: Record<NotificationEvent, string> = {
  thread_complete: "Thread Complete",
  batch_complete: "Batch Complete",
  error: "Error",
}

/**
 * Human-readable messages for notification events
 */
const EVENT_MESSAGES: Record<NotificationEvent, string> = {
  thread_complete: "A thread has completed successfully",
  batch_complete: "Batch processing complete",
  error: "An error occurred during processing",
}

/**
 * Terminal Notifier provider for enhanced macOS notifications
 *
 * Features:
 * - Click to activate VSCode or open URL
 * - Notification grouping for workstreams
 * - Configurable click actions
 * - Helpful installation message if not found
 */
export class TerminalNotifierProvider implements NotificationProvider {
  readonly name = "terminal-notifier"

  private config: TerminalNotifierConfig
  private availabilityChecked: boolean = false
  private isAvailableCache: boolean = false
  private installMessageLogged: boolean = false

  constructor(config?: TerminalNotifierConfig) {
    this.config = config ?? { enabled: true }
  }

  /**
   * Check if terminal-notifier is available in PATH
   * Uses 'which' command for feature detection
   */
  isAvailable(): boolean {
    // Return cached result if already checked
    if (this.availabilityChecked) {
      return this.isAvailableCache
    }

    this.availabilityChecked = true

    // Only available on macOS
    if (process.platform !== "darwin") {
      this.isAvailableCache = false
      return false
    }

    try {
      // Use which to check if terminal-notifier is in PATH
      execSync("which terminal-notifier", { stdio: "ignore" })
      this.isAvailableCache = true
      return true
    } catch {
      // Command not found
      this.isAvailableCache = false
      return false
    }
  }

  /**
   * Play notification using terminal-notifier
   * @param event The notification event type
   * @param metadata Optional metadata
   */
  playNotification(event: NotificationEvent, metadata?: NotificationMetadata): void {
    if (!this.config.enabled) {
      return
    }

    if (!this.isAvailable()) {
      this.logInstallationMessage()
      return
    }

    const title = EVENT_TITLES[event]
    let message = EVENT_MESSAGES[event]

    // Include thread ID if available
    if (metadata?.threadId) {
      message = `Thread ${metadata.threadId}: ${message}`
    }

    // Build command arguments
    const args = ["-title", title, "-message", message, "-sound", "default", "-group", "workstreams"]

    // Add click action based on config
    const clickAction = this.config.click_action ?? "activate_vscode"
    if (clickAction === "activate_vscode") {
      args.push("-activate", "com.microsoft.VSCode")
    } else if (clickAction === "open_url" && metadata?.threadId) {
      // Future: could open a specific URL related to the thread
      // For now, just activate VSCode as fallback
      args.push("-activate", "com.microsoft.VSCode")
    }
    // 'none' - no additional action on click

    // Spawn terminal-notifier and detach
    spawn("terminal-notifier", args, {
      stdio: "ignore",
      detached: true,
    }).unref()
  }

  /**
   * Log a helpful message about installing terminal-notifier
   * Only logs once per session to avoid spam
   */
  private logInstallationMessage(): void {
    if (this.installMessageLogged) {
      return
    }

    this.installMessageLogged = true
    console.log(
      "\n[notifications] terminal-notifier is enabled but not installed.\n" +
        "Install it with: brew install terminal-notifier\n" +
        "For more info: https://github.com/julienXX/terminal-notifier\n"
    )
  }
}
