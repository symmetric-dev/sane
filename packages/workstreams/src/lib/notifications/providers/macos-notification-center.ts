/**
 * macOS Notification Center Provider
 *
 * Uses osascript to display native macOS Notification Center notifications.
 * Always available on macOS without external dependencies.
 */

import { spawn } from "child_process"
import {
  type NotificationProvider,
  type NotificationEvent,
  type NotificationMetadata,
  type NotificationCenterConfig,
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
 * macOS Notification Center provider using osascript
 *
 * Features:
 * - No external dependencies (uses built-in osascript)
 * - Always available on macOS
 * - Supports title, message, and sound
 */
export class MacOSNotificationCenterProvider implements NotificationProvider {
  readonly name = "macos-notification-center"

  private config: NotificationCenterConfig

  constructor(config?: NotificationCenterConfig) {
    this.config = config ?? { enabled: true }
  }

  /**
   * Check if osascript is available (macOS only)
   */
  isAvailable(): boolean {
    return process.platform === "darwin"
  }

  /**
   * Play notification using osascript
   * @param event The notification event type
   * @param metadata Optional metadata
   */
  playNotification(event: NotificationEvent, metadata?: NotificationMetadata): void {
    if (!this.config.enabled) {
      return
    }

    if (!this.isAvailable()) {
      return
    }

    const title = EVENT_TITLES[event]
    let message = EVENT_MESSAGES[event]

    // Include thread ID if available
    if (metadata?.threadId) {
      message = `Thread ${metadata.threadId}: ${message}`
    }

    // Escape special characters for AppleScript
    const escapedTitle = this.escapeAppleScript(title)
    const escapedMessage = this.escapeAppleScript(message)

    // Build osascript command
    const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name "default"`

    // Spawn osascript and detach
    spawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    }).unref()
  }

  /**
   * Escape special characters for AppleScript strings
   * Handles backslashes, double quotes, and newlines
   */
  private escapeAppleScript(str: string): string {
    return str
      .replace(/\\/g, "\\\\") // Escape backslashes first
      .replace(/"/g, '\\"') // Escape double quotes
      .replace(/\n/g, "\\n") // Escape newlines
      .replace(/\r/g, "\\r") // Escape carriage returns
  }
}
