import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_OPENCODE_SERVER_URL, runOpenCode } from "../src/opencode-runner.ts"

const liveEnabled = process.env.SDK_POC_OPENCODE_E2E === "1"
const liveTest = liveEnabled ? test : test.skip

describe("live OpenCode SDK probes", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  liveTest("live OpenCode — synchronous completion", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-sdk-poc-opencode-live-"))
    temporaryDirectories.push(workspace)

    const artifact = await runOpenCode({
      serverUrl: process.env.SDK_POC_OPENCODE_SERVER ?? DEFAULT_OPENCODE_SERVER_URL,
      prompt: "Respond exactly SDK POC OPENCODE LIVE and do not use any tools.",
      cwd: workspace,
      runDirectory: join(workspace, "artifacts"),
      timeoutMs: 120_000,
    })

    expect(artifact.status).toBe("finished")
    expect(artifact.sessionId).toBeString()
    expect(artifact.messageId).toBeString()
    expect(artifact.serverUrl).toBeString()
  }, 180_000)
})
