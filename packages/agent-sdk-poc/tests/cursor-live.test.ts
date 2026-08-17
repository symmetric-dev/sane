import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runCursor } from "../src/cursor-runner.ts"
import type { PocEventEnvelope } from "../src/types.ts"

const liveEnabled = process.env.SDK_POC_CURSOR_E2E === "1" && Boolean(process.env.CURSOR_API_KEY)
const liveTest = liveEnabled ? test : test.skip

async function createWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-sdk-poc-cursor-live-"))
}

async function readEvents(runDirectory: string): Promise<PocEventEnvelope[]> {
  const content = await readFile(join(runDirectory, "events.jsonl"), "utf8")
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PocEventEnvelope)
}

function toolEvents(events: PocEventEnvelope[]): Array<Record<string, unknown>> {
  return events
    .filter((event) => event.kind === "tool_call" && typeof event.raw === "object" && event.raw !== null)
    .map((event) => event.raw as Record<string, unknown>)
}

describe("live Cursor SDK probes", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  liveTest("live Cursor — basic completion", async () => {
    const workspace = await createWorkspace()
    temporaryDirectories.push(workspace)

    const artifact = await runCursor({
      prompt: "Respond exactly TEST COMPLETED and do not use any tools.",
      cwd: workspace,
      runDirectory: join(workspace, "artifacts"),
    })

    expect(artifact.status).toBe("finished")
    expect(artifact.result).toBe("TEST COMPLETED")
    expect(artifact.agentId).toBeString()
    expect(artifact.runId).toBeString()
  }, 120_000)

  liveTest("live Cursor — tool activity and artifact", async () => {
    const workspace = await createWorkspace()
    temporaryDirectories.push(workspace)

    const artifact = await runCursor({
      prompt:
        "Create a file named poc-output.txt in the current working directory containing exactly POC FILE CREATED with no trailing newline. Then respond exactly TEST COMPLETED.",
      cwd: workspace,
      runDirectory: join(workspace, "artifacts"),
    })

    expect(artifact.status).toBe("finished")
    expect(artifact.result).toBe("TEST COMPLETED")
    expect(await readFile(join(workspace, "poc-output.txt"), "utf8")).toBe("POC FILE CREATED")

    const events = await readEvents(artifact.runDirectory)
    const tools = toolEvents(events)
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.some((event) => typeof event.name === "string" && ["shell", "write", "edit"].includes(event.name))).toBe(true)
    expect(await readFile(join(artifact.runDirectory, "stderr.log"), "utf8")).toBeDefined()
  }, 120_000)

  liveTest("live Cursor — delayed completion", async () => {
    const workspace = await createWorkspace()
    temporaryDirectories.push(workspace)

    const artifact = await runCursor({
      prompt: "Use the shell tool to run `sleep 5`. After it finishes, respond exactly TEST COMPLETED.",
      cwd: workspace,
      runDirectory: join(workspace, "artifacts"),
      timeoutMs: 30_000,
    })

    expect(artifact.status).toBe("finished")
    expect(artifact.result).toBe("TEST COMPLETED")
    const tools = toolEvents(await readEvents(artifact.runDirectory))
    expect(tools.some((event) => event.name === "shell")).toBe(true)
  }, 120_000)

  liveTest("live Cursor — cancellation", async () => {
    const workspace = await createWorkspace()
    temporaryDirectories.push(workspace)
    const startedAt = Date.now()

    const artifact = await runCursor({
      prompt: "Use the shell tool to run `sleep 60`. Do not respond until the command finishes.",
      cwd: workspace,
      runDirectory: join(workspace, "artifacts"),
      timeoutMs: 2_000,
    })

    expect(artifact.status).toBe("cancelled")
    expect(artifact.cancellationRequestedAt).toBeString()
    expect(Date.now() - startedAt).toBeLessThan(15_000)
  }, 120_000)

  liveTest("live Cursor — concurrent runs correlate agent and run IDs", async () => {
    const workspaces = await Promise.all([createWorkspace(), createWorkspace()])
    temporaryDirectories.push(...workspaces)

    const artifacts = await Promise.all(
      workspaces.map((workspace, index) =>
        runCursor({
          prompt: `Respond exactly CONCURRENT ${index + 1} and do not use any tools.`,
          cwd: workspace,
          runDirectory: join(workspace, "artifacts"),
        }),
      ),
    )

    expect(new Set(artifacts.map((artifact) => artifact.agentId)).size).toBe(2)
    expect(new Set(artifacts.map((artifact) => artifact.runId)).size).toBe(2)
    expect(artifacts.map((artifact) => artifact.result)).toEqual(["CONCURRENT 1", "CONCURRENT 2"])

    for (const artifact of artifacts) {
      const events = await readEvents(artifact.runDirectory)
      const correlated = events.filter((event) => {
        if (typeof event.raw !== "object" || event.raw === null) return false
        const raw = event.raw as Record<string, unknown>
        return raw.agent_id === artifact.agentId && raw.run_id === artifact.runId
      })
      expect(correlated.length).toBeGreaterThan(0)
      expect(correlated.every((event) => event.runDirectory === artifact.runDirectory)).toBe(true)
    }
  }, 120_000)
})
