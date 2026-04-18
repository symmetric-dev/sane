/**
 * Workstream notifications configuration loader
 *
 * Handles loading and providing defaults for the work/notifications.json config file.
 * This configuration is per-repository and controls notification behavior during
 * workstream execution.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { NotificationsConfig } from "./types"

/**
 * Get the path to the notifications config file
 * @param repoRoot - The root directory of the repository
 * @returns Path to work/notifications.json
 */
export function getNotificationsConfigPath(repoRoot: string): string {
  return join(repoRoot, "work", "notifications.json")
}

/**
 * Get the default notifications configuration
 * Enables sound and notification_center by default, with all events enabled
 *
 * @returns Default NotificationsConfig with sensible defaults
 */
export function getDefaultNotificationsConfig(): NotificationsConfig {
  return {
    enabled: true,
    providers: {
      sound: {
        enabled: true,
        volume: 0.5,
      },
      notification_center: {
        enabled: true,
      },
      terminal_notifier: {
        enabled: false,
        click_action: "none",
      },
      tts: {
        enabled: false,
      },
    },
    events: {
      thread_complete: true,
      batch_complete: true,
      error: true,
    },
  }
}

/**
 * Load notifications configuration from work/notifications.json
 * Returns default configuration if file doesn't exist or is invalid
 *
 * @param repoRoot - The root directory of the repository
 * @returns NotificationsConfig - merged with defaults for any missing fields
 */
export function loadNotificationsConfig(repoRoot: string): NotificationsConfig {
  const configPath = getNotificationsConfigPath(repoRoot)
  const defaults = getDefaultNotificationsConfig()

  if (!existsSync(configPath)) {
    return defaults
  }

  try {
    const content = readFileSync(configPath, "utf-8")
    const loaded = JSON.parse(content) as Partial<NotificationsConfig>

    // Deep merge with defaults to ensure all fields exist
    return {
      enabled: loaded.enabled ?? defaults.enabled,
      providers: {
        sound: {
          enabled: loaded.providers?.sound?.enabled ?? defaults.providers.sound!.enabled,
          volume: loaded.providers?.sound?.volume ?? defaults.providers.sound!.volume,
        },
        notification_center: {
          enabled:
            loaded.providers?.notification_center?.enabled ??
            defaults.providers.notification_center!.enabled,
        },
        terminal_notifier: {
          enabled:
            loaded.providers?.terminal_notifier?.enabled ??
            defaults.providers.terminal_notifier!.enabled,
          click_action:
            loaded.providers?.terminal_notifier?.click_action ??
            defaults.providers.terminal_notifier!.click_action,
        },
        tts: {
          enabled: loaded.providers?.tts?.enabled ?? defaults.providers.tts!.enabled,
          voice: loaded.providers?.tts?.voice ?? defaults.providers.tts!.voice,
        },
      },
      events: {
        thread_complete: loaded.events?.thread_complete ?? defaults.events.thread_complete,
        batch_complete: loaded.events?.batch_complete ?? defaults.events.batch_complete,
        error: loaded.events?.error ?? defaults.events.error,
      },
    }
  } catch {
    // Invalid JSON or read error - return default config
    return defaults
  }
}
