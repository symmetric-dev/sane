/**
 * Notification system for workstream events
 *
 * This file re-exports the modular notification system for backward compatibility.
 * The implementation is split across multiple files in ./notifications/ for easier
 * parallel editing:
 *
 * - notifications/types.ts: Types, interfaces, and configuration
 * - notifications/providers/macos-sound.ts: MacOS sound provider with queue
 * - notifications/providers/external-api.ts: External webhook provider
 * - notifications/manager.ts: Central notification manager
 * - notifications/tracker.ts: Deduplication tracker
 *
 * @see ./notifications/index.ts for the main entry point
 */

// Re-export everything from the modular notification system
export {
  // Types and configuration
  type NotificationEvent,
  type NotificationMetadata,
  type NotificationProvider,
  type SoundMappings,
  type ExternalApiConfig,
  type NotificationConfig,
  type WebhookPayload,
  CONFIG_PATH,
  DEFAULT_SOUNDS,
  loadConfig,
  // Workstream notifications config types
  type SoundProviderConfig,
  type NotificationCenterConfig,
  type TerminalNotifierConfig,
  type TTSProviderConfig,
  type NotificationProvidersConfig,
  type NotificationEventsConfig,
  type NotificationsConfig,
  // Workstream notifications config loader
  getNotificationsConfigPath,
  getDefaultNotificationsConfig,
  loadNotificationsConfig,
  // Providers
  MacOSSoundProvider,
  ExternalApiProvider,
  TerminalNotifierProvider,
  MacOSNotificationCenterProvider,
  // Manager and convenience functions
  NotificationManager,
  type NotificationManagerOptions,
  getNotificationManager,
  resetNotificationManager,
  playNotification,
  // Tracker for deduplication
  NotificationTracker,
  type NotificationTrackerOptions,
} from "./notifications/index"
