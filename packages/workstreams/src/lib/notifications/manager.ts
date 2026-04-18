/**
 * Notification Manager
 *
 * Central manager that dispatches notifications to all registered providers.
 * Supports workstream-specific configuration via repoRoot parameter.
 */

import {
  type NotificationProvider,
  type NotificationEvent,
  type NotificationMetadata,
  type NotificationConfig,
  type NotificationsConfig,
  loadConfig,
} from "./types"
import { loadNotificationsConfig } from "./config"
import { MacOSSoundProvider } from "./providers/macos-sound"
import { ExternalApiProvider } from "./providers/external-api"
import { MacOSNotificationCenterProvider } from "./providers/macos-notification-center"
import { TerminalNotifierProvider } from "./providers/terminal-notifier"

/**
 * Options for creating a NotificationManager
 */
export interface NotificationManagerOptions {
  /** Repository root for loading workstream-specific config (work/notifications.json) */
  repoRoot?: string
  /** Legacy config (used when repoRoot not provided, falls back to ~/.config/agenv/notifications.json) */
  config?: NotificationConfig
}

/**
 * Central notification manager
 *
 * Manages multiple notification providers and dispatches events to all of them.
 * 
 * Config loading priority (fallback chain):
 * 1. If repoRoot provided: work/notifications.json (workstream-specific)
 * 2. Fallback: ~/.config/agenv/notifications.json (global config)
 * 3. Default: built-in defaults
 */
export class NotificationManager {
  private providers: NotificationProvider[] = []
  private legacyConfig: NotificationConfig
  private workstreamConfig: NotificationsConfig | null = null
  private repoRoot?: string

  constructor(options?: NotificationConfig | NotificationManagerOptions) {
    // Handle both legacy signature (NotificationConfig) and new signature (NotificationManagerOptions)
    if (options && "repoRoot" in options) {
      // New options-style constructor
      const opts = options as NotificationManagerOptions
      this.repoRoot = opts.repoRoot
      this.legacyConfig = opts.config ?? loadConfig()
      
      if (this.repoRoot) {
        // Load workstream-specific config
        this.workstreamConfig = loadNotificationsConfig(this.repoRoot)
      }
    } else {
      // Legacy constructor (NotificationConfig or undefined)
      this.legacyConfig = (options as NotificationConfig | undefined) ?? loadConfig()
    }
    
    this.initializeProviders()
  }

  /**
   * Initialize providers based on configuration
   * Uses workstream config if available, falls back to legacy config
   */
  private initializeProviders(): void {
    if (this.workstreamConfig) {
      this.initializeFromWorkstreamConfig()
    } else {
      this.initializeFromLegacyConfig()
    }
  }

  /**
   * Initialize providers from workstream config (work/notifications.json)
   * Only enables providers that are explicitly configured
   */
  private initializeFromWorkstreamConfig(): void {
    const config = this.workstreamConfig!
    const providers = config.providers

    // Sound provider
    if (providers.sound?.enabled) {
      this.providers.push(new MacOSSoundProvider({
        enabled: true,
        sounds: this.legacyConfig.sounds, // Use legacy config for sound mappings
      }))
    }

    // macOS Notification Center provider
    if (providers.notification_center?.enabled) {
      this.providers.push(new MacOSNotificationCenterProvider({
        enabled: true,
      }))
    }

    // Terminal Notifier provider
    if (providers.terminal_notifier?.enabled) {
      this.providers.push(new TerminalNotifierProvider({
        enabled: true,
        click_action: providers.terminal_notifier.click_action,
      }))
    }

    // External API provider (from legacy config if available)
    if (this.legacyConfig.external_api?.enabled) {
      this.providers.push(new ExternalApiProvider(this.legacyConfig.external_api))
    }

    // TTS provider - placeholder for future implementation
    // if (providers.tts?.enabled) {
    //   this.providers.push(new TTSProvider(providers.tts))
    // }
  }

  /**
   * Initialize providers from legacy config (~/.config/agenv/notifications.json)
   * Backwards compatible with existing behavior
   */
  private initializeFromLegacyConfig(): void {
    // Always add macOS sound provider (it checks availability internally)
    this.providers.push(new MacOSSoundProvider(this.legacyConfig))

    // Add external API provider if configured
    if (this.legacyConfig.external_api) {
      this.providers.push(new ExternalApiProvider(this.legacyConfig.external_api))
    }
  }

  /**
   * Add a custom notification provider
   */
  addProvider(provider: NotificationProvider): void {
    this.providers.push(provider)
  }

  /**
   * Remove a provider by name
   */
  removeProvider(name: string): void {
    this.providers = this.providers.filter((p) => p.name !== name)
  }

  /**
   * Get all registered providers
   */
  getProviders(): NotificationProvider[] {
    return [...this.providers]
  }

  /**
   * Play notification across all available providers
   * Non-blocking - each provider handles its own async behavior
   * 
   * Checks both master enabled flag and per-event configuration
   * @param event The notification event type
   * @param metadata Optional metadata to pass to providers
   */
  playNotification(event: NotificationEvent, metadata?: NotificationMetadata): void {
    // Check master enabled flag
    if (this.workstreamConfig) {
      if (this.workstreamConfig.enabled === false) {
        return
      }
    } else {
      if (this.legacyConfig.enabled === false) {
        return
      }
    }

    // Check per-event configuration (only when using workstream config)
    if (this.workstreamConfig && !this.isEventEnabled(event)) {
      return
    }

    for (const provider of this.providers) {
      if (provider.isAvailable()) {
        provider.playNotification(event, metadata)
      }
    }
  }

  /**
   * Check if a specific event is enabled in workstream config
   * Maps notification events to config event names
   */
  private isEventEnabled(event: NotificationEvent): boolean {
    if (!this.workstreamConfig) {
      return true // No workstream config means all events enabled
    }

    const events = this.workstreamConfig.events

    switch (event) {
      case "thread_complete":
        return events.thread_complete !== false
      case "batch_complete":
        return events.batch_complete !== false
      case "error":
        return events.error !== false
      default:
        return true
    }
  }
}

// ============================================
// SINGLETON & CONVENIENCE FUNCTIONS
// ============================================

// Singleton instance for simple usage
let defaultManager: NotificationManager | null = null

/**
 * Get or create the default notification manager
 */
export function getNotificationManager(): NotificationManager {
  if (!defaultManager) {
    defaultManager = new NotificationManager()
  }
  return defaultManager
}

/**
 * Reset the default notification manager (useful for testing)
 */
export function resetNotificationManager(): void {
  defaultManager = null
}

/**
 * Play a notification for the given event
 * Uses the default notification manager
 *
 * @param event The notification event type
 * @param metadata Optional metadata to pass to providers
 *
 * @example
 * // Play thread completion sound
 * playNotification('thread_complete')
 *
 * // Play error sound
 * playNotification('error')
 *
 */
export function playNotification(event: NotificationEvent, metadata?: NotificationMetadata): void {
  getNotificationManager().playNotification(event, metadata)
}
