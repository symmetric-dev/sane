/**
 * Notification Tracker
 *
 * Tracks notifications that have already been played to prevent duplicates.
 * Used by multi.ts to prevent duplicate sounds when threads complete.
 */

import { type NotificationMetadata } from "./types"
import { NotificationManager, playNotification } from "./manager"

/**
 * Options for creating a NotificationTracker
 */
export interface NotificationTrackerOptions {
  /** Repository root for loading workstream-specific config (work/notifications.json) */
  repoRoot?: string
}

/**
 * Tracks notifications that have already been played to prevent duplicates.
 *
 * This class ensures:
 * - Each thread only plays thread_complete once
 * - batch_complete only plays once per batch execution
 * - Error notifications are tracked per thread
 *
 * Used by multi.ts to prevent duplicate sounds when:
 * - Thread completes normally
 * - User closes tmux session early
 * - Thread fails/errors
 * 
 * When created with repoRoot, uses workstream-specific notification config.
 */
export class NotificationTracker {
  /** Set of threadIds that have already played thread_complete */
  private notifiedThreadIds: Set<string> = new Set()

  /** Set of threadIds that have already played error notification */
  private errorNotifiedThreadIds: Set<string> = new Set()

  /** Whether batch_complete has already been played */
  private batchCompleteNotified: boolean = false

  /** Optional custom notification manager (uses workstream config when repoRoot provided) */
  private manager: NotificationManager | null = null

  /**
   * Create a new NotificationTracker
   * @param options Optional configuration including repoRoot for workstream-specific notifications
   */
  constructor(options?: NotificationTrackerOptions) {
    if (options?.repoRoot) {
      this.manager = new NotificationManager({ repoRoot: options.repoRoot })
    }
  }

  /**
   * Play a notification using the tracker's manager or the global playNotification
   */
  private play(event: Parameters<typeof playNotification>[0], metadata?: Parameters<typeof playNotification>[1]): void {
    if (this.manager) {
      this.manager.playNotification(event, metadata)
    } else {
      playNotification(event, metadata)
    }
  }

  /**
   * Check if a thread has already been notified for completion
   */
  hasThreadCompleteNotified(threadId: string): boolean {
    return this.notifiedThreadIds.has(threadId)
  }

  /**
   * Mark a thread as having played thread_complete notification
   */
  markThreadCompleteNotified(threadId: string): void {
    this.notifiedThreadIds.add(threadId)
  }

  /**
   * Check if a thread has already been notified for error
   */
  hasErrorNotified(threadId: string): boolean {
    return this.errorNotifiedThreadIds.has(threadId)
  }

  /**
   * Mark a thread as having played error notification
   */
  markErrorNotified(threadId: string): void {
    this.errorNotifiedThreadIds.add(threadId)
  }

  /**
   * Check if batch_complete has already been played
   */
  hasBatchCompleteNotified(): boolean {
    return this.batchCompleteNotified
  }

  /**
   * Mark batch_complete as having been played
   */
  markBatchCompleteNotified(): void {
    this.batchCompleteNotified = true
  }

  /**
   * Play thread_complete notification if not already played for this thread.
   * Returns true if notification was played, false if already notified.
   */
  playThreadComplete(threadId: string): boolean {
    if (this.hasThreadCompleteNotified(threadId)) {
      return false
    }
    this.markThreadCompleteNotified(threadId)
    this.play("thread_complete")
    return true
  }

  /**
   * Play error notification if not already played for this thread.
   * Returns true if notification was played, false if already notified.
   */
  playError(threadId: string): boolean {
    if (this.hasErrorNotified(threadId)) {
      return false
    }
    this.markErrorNotified(threadId)
    this.play("error")
    return true
  }

  /**
   * Play batch_complete notification if not already played.
   * Returns true if notification was played, false if already notified.
   */
  playBatchComplete(): boolean {
    if (this.hasBatchCompleteNotified()) {
      return false
    }
    this.markBatchCompleteNotified()
    this.play("batch_complete")
    return true
  }

  /**
   * Reset the tracker state (useful for testing)
   */
  reset(): void {
    this.notifiedThreadIds.clear()
    this.errorNotifiedThreadIds.clear()
    this.batchCompleteNotified = false
  }

  /**
   * Get the count of threads that have been notified for completion
   */
  getNotifiedThreadCount(): number {
    return this.notifiedThreadIds.size
  }

  /**
   * Get the count of threads that have been notified for errors
   */
  getErrorNotifiedThreadCount(): number {
    return this.errorNotifiedThreadIds.size
  }

}
