import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ARTIFACT_FILES, createArtifactStore } from "../src/artifacts.ts"

describe("agent SDK PoC artifacts", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test("creates the inspectable artifact directory and initial files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-sdk-poc-artifacts-"))
    temporaryDirectories.push(root)
    const runDirectory = join(root, "run")

    const store = await createArtifactStore({
      runDirectory,
      prompt: "hello",
      model: "composer-2.5",
      cwd: root,
      pid: 1234,
    })

    expect(store.runDirectory).toBe(runDirectory)
    for (const file of ARTIFACT_FILES) expect(await readFile(join(runDirectory, file), "utf8")).toBeDefined()

    const manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8"))
    expect(manifest).toMatchObject({
      provider: "cursor",
      prompt: "hello",
      model: "composer-2.5",
      cwd: root,
      pid: 1234,
      status: "starting",
    })
  })

  test("appends raw provider events as JSONL and correlates their IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-sdk-poc-events-"))
    temporaryDirectories.push(root)
    const store = await createArtifactStore({
      runDirectory: join(root, "run"),
      prompt: "event test",
      model: "composer-2.5",
      cwd: root,
    })
    const rawEvent = {
      type: "tool_call",
      agent_id: "agent-test",
      run_id: "run-test",
      request_id: "request-test",
      name: "shell",
      args: { command: "printf test" },
    }

    await store.appendEvent("tool_call", rawEvent, new Date("2026-01-01T00:00:00.000Z"))
    const lines = (await readFile(join(root, "run", "events.jsonl"), "utf8")).trim().split("\n")
    expect(lines).toHaveLength(1)
    const firstLine = lines[0]
    expect(firstLine).toBeDefined()
    expect(JSON.parse(firstLine!)).toEqual({
      timestamp: "2026-01-01T00:00:00.000Z",
      provider: "cursor",
      runDirectory: join(root, "run"),
      kind: "tool_call",
      raw: rawEvent,
    })

    const manifest = JSON.parse(await readFile(join(root, "run", "manifest.json"), "utf8"))
    expect(manifest).toMatchObject({ agentId: "agent-test", runId: "run-test", requestId: "request-test" })
  })

  test("updates manifest and result artifacts on terminal completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-sdk-poc-result-"))
    temporaryDirectories.push(root)
    const store = await createArtifactStore({
      runDirectory: join(root, "run"),
      prompt: "finish test",
      model: "composer-2.5",
      cwd: root,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
    })

    const result = await store.finish({
      status: "finished",
      agentId: "agent-finished",
      runId: "run-finished",
      requestId: "request-finished",
      result: "TEST COMPLETED",
      providerResult: { status: "finished", result: "TEST COMPLETED" },
      finishedAt: new Date("2026-01-01T00:00:01.250Z"),
    })

    expect(result).toMatchObject({
      status: "finished",
      agentId: "agent-finished",
      runId: "run-finished",
      requestId: "request-finished",
      result: "TEST COMPLETED",
      durationMs: 1250,
    })
    const manifest = JSON.parse(await readFile(join(root, "run", "manifest.json"), "utf8"))
    const resultFile = JSON.parse(await readFile(join(root, "run", "result.json"), "utf8"))
    expect(manifest).toMatchObject({ status: "finished", result: "TEST COMPLETED", durationMs: 1250 })
    expect(resultFile).toMatchObject({ status: "finished", result: "TEST COMPLETED", providerResult: { status: "finished" } })
  })
})
