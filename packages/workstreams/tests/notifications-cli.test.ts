import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import {
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
} from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { main as notificationsMain } from "../src/cli/notifications.ts"

describe("work notifications", () => {
  let tempDir: string
  let workDir: string
  let consoleLogSpy: any
  let consoleErrorSpy: any
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "work-notifications-test-"))
    workDir = join(tempDir, "work")
    mkdirSync(workDir, { recursive: true })
    
    logs = []
    errors = []
    consoleLogSpy = spyOn(console, "log").mockImplementation((msg: any) => logs.push(String(msg)))
    consoleErrorSpy = spyOn(console, "error").mockImplementation((msg: any) => errors.push(String(msg)))
  })

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }
    consoleLogSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it("should display default configuration when file doesn't exist", () => {
    // Run command
    notificationsMain(["bun", "work", "notifications", "--repo-root", tempDir])
    
    // Check output
    const output = logs.join("\n")
    expect(output).toContain("Notification Configuration")
    expect(output).toContain("Global Status: Enabled")
    expect(output).toContain("Providers:")
    expect(output).toContain("- Sound:             Enabled")
    expect(output).toContain("- Notification Center: Enabled")
    expect(output).toContain("Events:")
  })

  it("should display configuration from file", () => {
    // Create config file
    const config = {
      enabled: true,
      providers: {
        sound: { enabled: false },
        notification_center: { enabled: true },
        terminal_notifier: { enabled: true },
        tts: { enabled: false }
      },
      events: {
        thread_complete: false,
        batch_complete: true,
        error: true
      }
    }
    writeFileSync(join(workDir, "notifications.json"), JSON.stringify(config))

    // Run command
    notificationsMain(["bun", "work", "notifications", "--repo-root", tempDir])
    
    // Check output
    const output = logs.join("\n")
    expect(output).toContain("Notification Configuration")
    expect(output).toContain("- Sound:             Disabled")
    expect(output).toContain("- Notification Center: Enabled")
    expect(output).toContain("- Terminal Notifier: Enabled")
    expect(output).toContain("- Thread Complete:    Off")
    expect(output).toContain("- Batch Complete:     On")
  })

  it("should output JSON when --json flag is used", () => {
    // Run command
    notificationsMain(["bun", "work", "notifications", "--repo-root", tempDir, "--json"])
    
    // Check output
    const output = logs.join("\n")
    const parsed = JSON.parse(output)
    
    expect(parsed).toHaveProperty("enabled")
    expect(parsed).toHaveProperty("providers")
    expect(parsed).toHaveProperty("events")
    expect(parsed.providers.sound.enabled).toBe(true) // Default
  })
})

// Mock jest for bun test compatibility if needed, or use bun:test spies
// Since bun:test uses different spy syntax, I'll adjust the imports and spy usage
// bun:test exports spyOn
