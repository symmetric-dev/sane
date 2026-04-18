import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import * as childProcess from "child_process"
import {
  type NotificationEvent,
  type NotificationProvider,
  type NotificationConfig,
  MacOSSoundProvider,
  ExternalApiProvider,
  MacOSNotificationCenterProvider,
  NotificationManager,
  NotificationTracker,
  loadConfig,
  DEFAULT_SOUNDS,
  playNotification,
  getNotificationManager,
  resetNotificationManager,
} from "../src/lib/notifications"
import { createSpawnMock, createChildProcessMock } from "./helpers/mocks"

describe("NotificationEvent types", () => {
  test("has expected event types", () => {
    const events: NotificationEvent[] = ["thread_complete", "batch_complete", "error"]
    expect(events).toHaveLength(3)
  })
})

describe("DEFAULT_SOUNDS", () => {
  test("has sound mappings for all event types", () => {
    expect(DEFAULT_SOUNDS.thread_complete).toBe("/System/Library/Sounds/Glass.aiff")
    expect(DEFAULT_SOUNDS.batch_complete).toBe("/System/Library/Sounds/Hero.aiff")
    expect(DEFAULT_SOUNDS.error).toBe("/System/Library/Sounds/Basso.aiff")
  })
})

describe("loadConfig", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notifications-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("returns empty object when config file does not exist", () => {
    const nonExistentPath = join(tempDir, "nonexistent.json")
    const config = loadConfig(nonExistentPath)
    expect(config).toEqual({})
  })

  test("returns empty object for invalid JSON", () => {
    const configPath = join(tempDir, "invalid.json")
    writeFileSync(configPath, "not valid json {")
    const config = loadConfig(configPath)
    expect(config).toEqual({})
  })

  test("loads valid config file", () => {
    const configPath = join(tempDir, "valid.json")
    const expectedConfig: NotificationConfig = {
      enabled: true,
      sounds: {
        thread_complete: "/custom/sound.aiff",
      },
    }
    writeFileSync(configPath, JSON.stringify(expectedConfig))

    const config = loadConfig(configPath)
    expect(config).toEqual(expectedConfig)
  })

  test("loads config with external_api settings", () => {
    const configPath = join(tempDir, "api.json")
    const expectedConfig: NotificationConfig = {
      enabled: true,
      external_api: {
        enabled: true,
        webhook_url: "https://example.com/webhook",
        headers: { Authorization: "Bearer token" },
        events: ["error"],
      },
    }
    writeFileSync(configPath, JSON.stringify(expectedConfig))

    const config = loadConfig(configPath)
    expect(config.external_api?.enabled).toBe(true)
    expect(config.external_api?.webhook_url).toBe("https://example.com/webhook")
    expect(config.external_api?.events).toEqual(["error"])
  })
})

describe("MacOSSoundProvider", () => {
  let spawnMock: ReturnType<typeof spyOn>

  beforeEach(() => {
    spawnMock = createSpawnMock()
  })

  afterEach(() => {
    spawnMock.mockRestore()
  })

  test("provider name and availability", () => {
    const provider = new MacOSSoundProvider()
    expect(provider.name).toBe("macos-sound")
    expect(provider.isAvailable()).toBe(process.platform === "darwin")
  })

  test("playNotification behavior", () => {
    // Does not spawn when disabled
    const disabledProvider = new MacOSSoundProvider({ enabled: false })
    disabledProvider.playNotification("thread_complete")
    expect(spawnMock).not.toHaveBeenCalled()

    if (process.platform !== "darwin") return

    // Spawns afplay with default sound (no detached since we need exit events for queue)
    const defaultProvider = new MacOSSoundProvider()
    defaultProvider.playNotification("thread_complete")
    expect(spawnMock).toHaveBeenCalledWith(
      "afplay",
      [DEFAULT_SOUNDS.thread_complete],
      expect.objectContaining({ stdio: "ignore" })
    )

    // Uses custom sound path when configured
    const customPath = "/System/Library/Sounds/Ping.aiff"
    const customProvider = new MacOSSoundProvider({ sounds: { thread_complete: customPath } })
    customProvider.playNotification("thread_complete")
    expect(spawnMock).toHaveBeenCalledWith("afplay", [customPath], expect.anything())

    // Falls back to default when custom path does not exist
    const fallbackProvider = new MacOSSoundProvider({ sounds: { thread_complete: "/nonexistent/custom.aiff" } })
    fallbackProvider.playNotification("thread_complete")
    expect(spawnMock).toHaveBeenCalledWith("afplay", [DEFAULT_SOUNDS.thread_complete], expect.anything())
  })

  test("sound queue prevents overlapping playback", () => {
    if (process.platform !== "darwin") return

    const provider = new MacOSSoundProvider()
    
    // Initially empty queue and not playing
    expect(provider.getQueueLength()).toBe(0)
    expect(provider.getIsPlaying()).toBe(false)

    // First sound starts playing immediately
    provider.playNotification("thread_complete")
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(provider.getIsPlaying()).toBe(true)
    // Queue should be empty since first sound is playing
    expect(provider.getQueueLength()).toBe(0)

    // Second sound gets queued (not spawned immediately)
    provider.playNotification("batch_complete")
    expect(spawnMock).toHaveBeenCalledTimes(1) // Still only 1 spawn
    expect(provider.getQueueLength()).toBe(1) // One sound waiting in queue

    // Third sound also gets queued
    provider.playNotification("error")
    expect(spawnMock).toHaveBeenCalledTimes(1) // Still only 1 spawn
    expect(provider.getQueueLength()).toBe(2) // Two sounds waiting in queue
  })

  test("clearQueue resets state", () => {
    if (process.platform !== "darwin") return

    const provider = new MacOSSoundProvider()
    
    // Add some sounds
    provider.playNotification("thread_complete")
    provider.playNotification("batch_complete")
    provider.playNotification("error")
    
    expect(provider.getIsPlaying()).toBe(true)
    expect(provider.getQueueLength()).toBe(2)
    
    // Clear queue
    provider.clearQueue()
    
    expect(provider.getIsPlaying()).toBe(false)
    expect(provider.getQueueLength()).toBe(0)
  })
})

describe("MacOSNotificationCenterProvider", () => {
  let spawnMock: ReturnType<typeof spyOn>

  beforeEach(() => {
    spawnMock = createSpawnMock()
  })

  afterEach(() => {
    spawnMock.mockRestore()
  })

  test("provider name and availability", () => {
    const provider = new MacOSNotificationCenterProvider()
    expect(provider.name).toBe("macos-notification-center")
    // Only available on macOS
    expect(provider.isAvailable()).toBe(process.platform === "darwin")
  })

  test("does not play notification when disabled", () => {
    const disabledProvider = new MacOSNotificationCenterProvider({ enabled: false })
    disabledProvider.playNotification("thread_complete")
    expect(spawnMock).not.toHaveBeenCalled()
  })

  test("plays notification with osascript on macOS", () => {
    if (process.platform !== "darwin") return

    const provider = new MacOSNotificationCenterProvider()
    provider.playNotification("thread_complete")

    expect(spawnMock).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.stringContaining('display notification')],
      expect.objectContaining({ stdio: "ignore", detached: true })
    )
  })

  test("includes title and message in osascript command", () => {
    if (process.platform !== "darwin") return

    const provider = new MacOSNotificationCenterProvider()
    provider.playNotification("batch_complete")

    const call = spawnMock.mock.calls[0]
    const script = call[1][1]
    expect(script).toContain('with title "Batch Complete"')
    expect(script).toContain('sound name "default"')
  })

  test("includes thread ID in message when provided", () => {
    if (process.platform !== "darwin") return

    const provider = new MacOSNotificationCenterProvider()
    provider.playNotification("thread_complete", { threadId: "01.01.01" })

    const call = spawnMock.mock.calls[0]
    const script = call[1][1]
    expect(script).toContain("Thread 01.01.01")
  })

  test("escapes special characters for AppleScript", () => {
    if (process.platform !== "darwin") return

    const provider = new MacOSNotificationCenterProvider()
    provider.playNotification("thread_complete", {
      threadId: '01"\\'
    })

    const call = spawnMock.mock.calls[0]
    const script = call[1][1]
    expect(script).toContain('01\\"\\\\')
  })

  test("handles all event types", () => {
    if (process.platform !== "darwin") return

    const provider = new MacOSNotificationCenterProvider()
    const events: NotificationEvent[] = [
      "thread_complete",
      "batch_complete",
      "error",
    ]

    for (const event of events) {
      provider.playNotification(event)
    }

    expect(spawnMock).toHaveBeenCalledTimes(3)
  })

  test("does not spawn when not available (non-macOS)", () => {
    // This test is relevant on non-macOS platforms
    if (process.platform === "darwin") return

    const provider = new MacOSNotificationCenterProvider()
    expect(provider.isAvailable()).toBe(false)
    
    provider.playNotification("thread_complete")
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe("ExternalApiProvider", () => {
  test("provider name and availability", () => {
    const provider = new ExternalApiProvider()
    expect(provider.name).toBe("external-api")
    
    // isAvailable checks for enabled flag and webhook_url
    expect(new ExternalApiProvider().isAvailable()).toBe(false)
    expect(new ExternalApiProvider({ enabled: false, webhook_url: "https://example.com/webhook" }).isAvailable()).toBe(false)
    expect(new ExternalApiProvider({ enabled: true }).isAvailable()).toBe(false)
    expect(new ExternalApiProvider({ enabled: true, webhook_url: "https://example.com/webhook" }).isAvailable()).toBe(true)
  })

  test("buildPayload creates correct structure with and without metadata", () => {
    const provider = new ExternalApiProvider()
    const withMetadata = provider.buildPayload("thread_complete", { task: "test" })
    expect(withMetadata.event).toBe("thread_complete")
    expect(withMetadata.timestamp).toBeDefined()
    expect(withMetadata.metadata).toEqual({ task: "test" })

    const withoutMetadata = provider.buildPayload("error")
    expect(withoutMetadata.event).toBe("error")
    expect(withoutMetadata.metadata).toBeUndefined()
  })

  test("playNotification respects event filter", () => {
    const provider = new ExternalApiProvider({
      enabled: true,
      webhook_url: "https://example.com/webhook",
      events: ["error"], // Only error events
    })

    // Should not throw for filtered events
    provider.playNotification("thread_complete")
    provider.playNotification("error")
  })
})

describe("NotificationManager", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "notifications-manager-test-"))
    resetNotificationManager()
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    resetNotificationManager()
  })

  test("initializes with default providers", () => {
    const manager = new NotificationManager({})
    const providers = manager.getProviders()

    // Should have MacOSSoundProvider by default
    expect(providers.some((p) => p.name === "macos-sound")).toBe(true)
  })

  test("adds external API provider when configured", () => {
    const manager = new NotificationManager({
      external_api: {
        enabled: true,
        webhook_url: "https://example.com/webhook",
      },
    })
    const providers = manager.getProviders()

    expect(providers.some((p) => p.name === "external-api")).toBe(true)
  })

  test("add and remove providers", () => {
    const manager = new NotificationManager({})
    const initialCount = manager.getProviders().length
    
    const customProvider: NotificationProvider = {
      name: "custom-test",
      isAvailable: () => true,
      playNotification: () => {},
    }
    manager.addProvider(customProvider)
    expect(manager.getProviders().some((p) => p.name === "custom-test")).toBe(true)

    manager.removeProvider("macos-sound")
    const providers = manager.getProviders()
    expect(providers.length).toBe(initialCount)
    expect(providers.some((p) => p.name === "macos-sound")).toBe(false)
  })

  test("playNotification behavior with providers", () => {
    // Does not throw when disabled
    const disabledManager = new NotificationManager({ enabled: false })
    expect(() => disabledManager.playNotification("thread_complete")).not.toThrow()

    // Calls all available providers
    const mockProvider1: NotificationProvider = {
      name: "mock-1",
      isAvailable: () => true,
      playNotification: mock(() => {}),
    }
    const mockProvider2: NotificationProvider = {
      name: "mock-2",
      isAvailable: () => true,
      playNotification: mock(() => {}),
    }
    const unavailableProvider: NotificationProvider = {
      name: "unavailable",
      isAvailable: () => false,
      playNotification: mock(() => {}),
    }

    const manager = new NotificationManager({ enabled: true })
    manager.removeProvider("macos-sound")
    manager.addProvider(mockProvider1)
    manager.addProvider(mockProvider2)
    manager.addProvider(unavailableProvider)

    manager.playNotification("batch_complete")

    expect(mockProvider1.playNotification).toHaveBeenCalledWith("batch_complete", undefined)
    expect(mockProvider2.playNotification).toHaveBeenCalledWith("batch_complete", undefined)
    expect(unavailableProvider.playNotification).not.toHaveBeenCalled()
  })
})

describe("Convenience functions", () => {
  beforeEach(() => resetNotificationManager())
  afterEach(() => resetNotificationManager())

  test("singleton manager and playNotification", () => {
    const manager1 = getNotificationManager()
    const manager2 = getNotificationManager()
    expect(manager1).toBe(manager2)

    resetNotificationManager()
    const manager3 = getNotificationManager()
    expect(manager1).not.toBe(manager3)

    expect(() => playNotification("thread_complete")).not.toThrow()
    expect(() => playNotification("batch_complete")).not.toThrow()
    expect(() => playNotification("error")).not.toThrow()
  })
})

describe("NotificationTracker", () => {
  let spawnMock: ReturnType<typeof spyOn>

  beforeEach(() => {
    resetNotificationManager()
    spawnMock = createSpawnMock()
  })

  afterEach(() => {
    spawnMock.mockRestore()
    resetNotificationManager()
  })

  describe("thread completion deduplication", () => {
    test("tracks thread completion notification", () => {
      const tracker = new NotificationTracker()
      
      expect(tracker.hasThreadCompleteNotified("01.01.01")).toBe(false)
      tracker.markThreadCompleteNotified("01.01.01")
      expect(tracker.hasThreadCompleteNotified("01.01.01")).toBe(true)
    })

    test("tracks multiple threads independently", () => {
      const tracker = new NotificationTracker()
      
      tracker.markThreadCompleteNotified("01.01.01")
      tracker.markThreadCompleteNotified("01.01.02")
      
      expect(tracker.hasThreadCompleteNotified("01.01.01")).toBe(true)
      expect(tracker.hasThreadCompleteNotified("01.01.02")).toBe(true)
      expect(tracker.hasThreadCompleteNotified("01.01.03")).toBe(false)
    })

    test("getNotifiedThreadCount returns correct count", () => {
      const tracker = new NotificationTracker()
      
      expect(tracker.getNotifiedThreadCount()).toBe(0)
      
      tracker.markThreadCompleteNotified("01.01.01")
      expect(tracker.getNotifiedThreadCount()).toBe(1)
      
      tracker.markThreadCompleteNotified("01.01.02")
      expect(tracker.getNotifiedThreadCount()).toBe(2)
      
      // Marking same thread again should not increase count
      tracker.markThreadCompleteNotified("01.01.01")
      expect(tracker.getNotifiedThreadCount()).toBe(2)
    })
  })

  describe("error notification deduplication", () => {
    test("tracks error notification per thread", () => {
      const tracker = new NotificationTracker()
      
      expect(tracker.hasErrorNotified("01.01.01")).toBe(false)
      tracker.markErrorNotified("01.01.01")
      expect(tracker.hasErrorNotified("01.01.01")).toBe(true)
    })

    test("error and completion tracking are independent", () => {
      const tracker = new NotificationTracker()
      
      tracker.markThreadCompleteNotified("01.01.01")
      expect(tracker.hasThreadCompleteNotified("01.01.01")).toBe(true)
      expect(tracker.hasErrorNotified("01.01.01")).toBe(false)
      
      tracker.markErrorNotified("01.01.01")
      expect(tracker.hasErrorNotified("01.01.01")).toBe(true)
    })

    test("getErrorNotifiedThreadCount returns correct count", () => {
      const tracker = new NotificationTracker()
      
      expect(tracker.getErrorNotifiedThreadCount()).toBe(0)
      
      tracker.markErrorNotified("01.01.01")
      expect(tracker.getErrorNotifiedThreadCount()).toBe(1)
      
      tracker.markErrorNotified("01.01.02")
      expect(tracker.getErrorNotifiedThreadCount()).toBe(2)
    })
  })

  describe("batch completion deduplication", () => {
    test("tracks batch completion and ignores duplicates", () => {
      const tracker = new NotificationTracker()
      
      expect(tracker.hasBatchCompleteNotified()).toBe(false)
      tracker.markBatchCompleteNotified()
      expect(tracker.hasBatchCompleteNotified()).toBe(true)
      
      // Marking multiple times has no effect
      tracker.markBatchCompleteNotified()
      tracker.markBatchCompleteNotified()
      expect(tracker.hasBatchCompleteNotified()).toBe(true)
    })
  })

  describe("play helpers", () => {
    test("playThreadComplete deduplicates per thread", () => {
      const tracker = new NotificationTracker()
      
      expect(tracker.playThreadComplete("01.01.01")).toBe(true)
      expect(tracker.hasThreadCompleteNotified("01.01.01")).toBe(true)
      expect(tracker.playThreadComplete("01.01.01")).toBe(false)
      
      expect(tracker.playThreadComplete("01.01.02")).toBe(true)
      expect(tracker.playThreadComplete("01.01.02")).toBe(false)
    })

    test("playError deduplicates per thread", () => {
      const tracker = new NotificationTracker()
      
      expect(tracker.playError("01.01.01")).toBe(true)
      expect(tracker.hasErrorNotified("01.01.01")).toBe(true)
      expect(tracker.playError("01.01.01")).toBe(false)
    })

    test("playBatchComplete deduplicates", () => {
      const tracker = new NotificationTracker()
      
      expect(tracker.playBatchComplete()).toBe(true)
      expect(tracker.hasBatchCompleteNotified()).toBe(true)
      expect(tracker.playBatchComplete()).toBe(false)
    })
  })

  describe("reset", () => {
    test("clears all tracked state", () => {
      const tracker = new NotificationTracker()
      
      // Set up some state
      tracker.markThreadCompleteNotified("01.01.01")
      tracker.markThreadCompleteNotified("01.01.02")
      tracker.markErrorNotified("01.01.03")
      tracker.markBatchCompleteNotified()
      
      // Verify state exists
      expect(tracker.getNotifiedThreadCount()).toBe(2)
      expect(tracker.getErrorNotifiedThreadCount()).toBe(1)
      expect(tracker.hasBatchCompleteNotified()).toBe(true)
      
      // Reset
      tracker.reset()
      
      // Verify all state is cleared
      expect(tracker.getNotifiedThreadCount()).toBe(0)
      expect(tracker.getErrorNotifiedThreadCount()).toBe(0)
      expect(tracker.hasBatchCompleteNotified()).toBe(false)
      expect(tracker.hasThreadCompleteNotified("01.01.01")).toBe(false)
      expect(tracker.hasErrorNotified("01.01.03")).toBe(false)
    })
  })

  describe("edge cases and usage patterns", () => {
    test("handles various thread IDs and tracking independence", () => {
      const tracker = new NotificationTracker()
      
      // Empty and special character thread IDs
      tracker.markThreadCompleteNotified("")
      expect(tracker.hasThreadCompleteNotified("")).toBe(true)
      
      const specialId = "__session_error__"
      tracker.markErrorNotified(specialId)
      expect(tracker.hasErrorNotified(specialId)).toBe(true)
      
      // Thread and batch tracking are independent
      tracker.markThreadCompleteNotified("01.01.01")
      expect(tracker.hasBatchCompleteNotified()).toBe(false)
      tracker.markBatchCompleteNotified()
      expect(tracker.hasThreadCompleteNotified("01.01.01")).toBe(true)
      expect(tracker.hasBatchCompleteNotified()).toBe(true)
    })

    test("simulates multi.ts usage pattern: normal completion", () => {
      const tracker = new NotificationTracker()
      
      // Simulate 3 threads completing normally
      const threads = ["01.01.01", "01.01.02", "01.01.03"]
      
      for (const threadId of threads) {
        // First completion plays sound
        expect(tracker.playThreadComplete(threadId)).toBe(true)
      }
      
      // Then batch complete plays once
      expect(tracker.playBatchComplete()).toBe(true)
      expect(tracker.playBatchComplete()).toBe(false) // Duplicate blocked
    })

    test("simulates multi.ts usage pattern: early tmux close (Ctrl+b X)", () => {
      const tracker = new NotificationTracker()
      
      // When user closes tmux session early, we only play batch_complete
      // (not per-thread sounds)
      const threads = ["01.01.01", "01.01.02", "01.01.03"]
      
      // Skip thread notifications entirely
      // Just play batch_complete once
      expect(tracker.playBatchComplete()).toBe(true)
      expect(tracker.playBatchComplete()).toBe(false) // Duplicate blocked
      
      // Thread complete tracking should still be empty
      expect(tracker.getNotifiedThreadCount()).toBe(0)
    })

    test("simulates multi.ts usage pattern: mixed success and failure", () => {
      const tracker = new NotificationTracker()
      
      // Thread 1 completes successfully
      expect(tracker.playThreadComplete("01.01.01")).toBe(true)
      
      // Thread 2 fails
      expect(tracker.playError("01.01.02")).toBe(true)
      
      // Thread 3 completes successfully
      expect(tracker.playThreadComplete("01.01.03")).toBe(true)
      
      // Duplicates are blocked
      expect(tracker.playThreadComplete("01.01.01")).toBe(false)
      expect(tracker.playError("01.01.02")).toBe(false)
      
      // Batch complete at the end
      expect(tracker.playBatchComplete()).toBe(true)
      
      // Stats
      expect(tracker.getNotifiedThreadCount()).toBe(2) // Only successes
      expect(tracker.getErrorNotifiedThreadCount()).toBe(1) // Only failures
    })
  })
})
