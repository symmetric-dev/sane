/**
 * Notification system types, interfaces, and configuration
 *
 * This file contains all shared types used by the notification system.
 * Separated for easier parallel editing of provider implementations.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ============================================
// WORKSTREAM NOTIFICATIONS CONFIG (work/notifications.json)
// ============================================

/**
 * Sound provider configuration
 * Plays system sounds for notification events
 */
export interface SoundProviderConfig {
  enabled: boolean
  /** Volume level from 0.0 to 1.0 */
  volume?: number
}

/**
 * macOS Notification Center provider configuration
 * Shows native macOS notification banners
 */
export interface NotificationCenterConfig {
  enabled: boolean
}

/**
 * terminal-notifier provider configuration
 * Uses terminal-notifier CLI for enhanced macOS notifications
 */
export interface TerminalNotifierConfig {
  enabled: boolean
  /** Action when notification is clicked */
  click_action?: "activate_vscode" | "open_url" | "none"
}

/**
 * Text-to-speech provider configuration (Future)
 * Reads notifications aloud using system TTS
 */
export interface TTSProviderConfig {
  enabled: boolean
  /** Voice name for TTS (e.g., "Samantha", "Alex") */
  voice?: string
}

/**
 * Notification providers configuration
 * Controls which notification providers are enabled and their settings
 */
export interface NotificationProvidersConfig {
  sound?: SoundProviderConfig
  notification_center?: NotificationCenterConfig
  terminal_notifier?: TerminalNotifierConfig
  tts?: TTSProviderConfig
}

/**
 * Notification events configuration
 * Controls which events trigger notifications
 */
export interface NotificationEventsConfig {
  thread_complete?: boolean
  batch_complete?: boolean
  error?: boolean
}

/**
 * Workstream notifications configuration
 * Stored in work/notifications.json within each repository
 *
 * @example
 * {
 *   "enabled": true,
 *   "providers": {
 *     "sound": { "enabled": true, "volume": 0.8 },
 *     "notification_center": { "enabled": true }
 *   },
 *   "events": {
 *     "thread_complete": true,
 *     "batch_complete": true,
 *     "error": true
 *   }
 * }
 */
export interface NotificationsConfig {
  /** Master switch to enable/disable all notifications */
  enabled: boolean
  /** Provider-specific configurations */
  providers: NotificationProvidersConfig
  /** Event-specific enable/disable flags */
  events: NotificationEventsConfig
}

// ============================================
// NOTIFICATION TYPES
// ============================================

/**
 * Events that can trigger notifications
 */
export type NotificationEvent =
  | "thread_complete"
  | "batch_complete"
  | "error"

/**
 * Optional metadata that can be passed with notifications.
 */
export interface NotificationMetadata {
  /** Thread identifier */
  threadId?: string
  /** Additional custom data */
  [key: string]: unknown
}

/**
 * Provider interface for notification implementations
 * Implementations should be non-blocking (fire-and-forget)
 */
export interface NotificationProvider {
  /** Provider name for identification */
  readonly name: string

  /**
   * Play a notification for the given event
   * Should be non-blocking - spawn process and don't await
   * @param event The notification event type
   * @param metadata Optional metadata
   */
  playNotification(event: NotificationEvent, metadata?: NotificationMetadata): void

  /**
   * Check if the provider is available on the current system
   */
  isAvailable(): boolean
}

// ============================================
// CONFIGURATION
// ============================================

/**
 * Custom sound mappings per event
 */
export interface SoundMappings {
  thread_complete?: string
  batch_complete?: string
  error?: string
}

/**
 * External API provider configuration
 */
export interface ExternalApiConfig {
  enabled: boolean
  webhook_url?: string
  headers?: Record<string, string>
  events?: NotificationEvent[]
}

/**
 * Configuration file structure (~/.config/agenv/notifications.json)
 */
export interface NotificationConfig {
  /** Enable/disable all notifications */
  enabled?: boolean

  /** Custom sound file paths per event */
  sounds?: SoundMappings

  /** External API configuration */
  external_api?: ExternalApiConfig
}

/**
 * Default configuration path
 */
export const CONFIG_PATH = join(homedir(), ".config", "agenv", "notifications.json")

/**
 * Load notification configuration from disk
 * Returns empty config if file doesn't exist
 */
export function loadConfig(configPath: string = CONFIG_PATH): NotificationConfig {
  if (!existsSync(configPath)) {
    return {}
  }

  try {
    const content = readFileSync(configPath, "utf-8")
    return JSON.parse(content) as NotificationConfig
  } catch {
    // Invalid JSON or read error - return default config
    return {}
  }
}

/**
 * Default macOS system sounds for each event type
 * Located in /System/Library/Sounds/
 */
export const DEFAULT_SOUNDS: Record<NotificationEvent, string> = {
  thread_complete: "/System/Library/Sounds/Glass.aiff",
  batch_complete: "/System/Library/Sounds/Hero.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
}

/**
 * Webhook payload for external API notifications
 */
export interface WebhookPayload {
  event: NotificationEvent
  timestamp: string
  metadata?: Record<string, unknown>
  /** Thread identifier associated with this notification */
  threadId?: string
}
