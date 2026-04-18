/**
 * External API Provider
 *
 * Sends notifications to external webhooks/APIs.
 * Currently a stub for future webhook integrations.
 */

import {
  type NotificationProvider,
  type NotificationEvent,
  type NotificationMetadata,
  type ExternalApiConfig,
  type WebhookPayload,
} from "../types"

/**
 * External API notification provider stub
 *
 * Placeholder for future webhook/API integrations.
 * Can send notifications to external services like Slack, Discord, etc.
 *
 * TODO: Implement actual HTTP requests when needed
 */
export class ExternalApiProvider implements NotificationProvider {
  readonly name = "external-api"

  private config: ExternalApiConfig

  constructor(config?: ExternalApiConfig) {
    this.config = config ?? { enabled: false }
  }

  /**
   * Check if external API is configured and enabled
   */
  isAvailable(): boolean {
    return this.config.enabled && !!this.config.webhook_url
  }

  /**
   * Send notification to external API
   * Currently a stub - logs intent but doesn't make HTTP requests
   * @param event The notification event type
   * @param metadata Optional metadata to include in the webhook payload
   */
  playNotification(event: NotificationEvent, metadata?: NotificationMetadata): void {
    if (!this.isAvailable()) {
      return
    }

    // Check if this event type is enabled
    if (this.config.events && !this.config.events.includes(event)) {
      return
    }

    // Stub: In future, this would make an HTTP POST request
    // const payload: WebhookPayload = this.buildPayload(event, metadata)
    // fetch(this.config.webhook_url!, {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json', ...this.config.headers },
    //   body: JSON.stringify(payload),
    // }).catch(() => {}) // Fire and forget

    // Store metadata for potential future use
    void metadata
  }

  /**
   * Build webhook payload for an event
   * @param event The notification event type
   * @param metadata Optional metadata
   */
  buildPayload(event: NotificationEvent, metadata?: NotificationMetadata): WebhookPayload {
    return {
      event,
      timestamp: new Date().toISOString(),
      metadata,
      threadId: metadata?.threadId,
    }
  }
}
