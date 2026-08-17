import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"

import { parseBatchExecutorArgs } from "../src/cli/batch-executor.ts"
import { observeBatchEvents, parseBatchEventsArgs } from "../src/cli/batch-events.ts"
import type { ReadActivityFileSystem } from "../src/lib/agent-runtime/observability.ts"
import { parseWorkSdkCommand } from "../src/cli/work-sdk.ts"
import {
  launchHeadlessBatchExecution,
  type SupervisionHelperDependencies,
} from "../src/lib/supervision-helper.ts"

function fakeChild(args: { closeCode?: number } = {}): any {
  const child = new EventEmitter() as any
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.unref = () => undefined
  queueMicrotask(() => child.emit("close", args.closeCode ?? 0))
  return child
}

describe("work-sdk command dispatch and validation", () => {
  test("dispatches only the SDK commands and validates the worker backend", () => {
    expect(parseWorkSdkCommand(["bun", "work-sdk", "supervise", "--batch", "01.01"])).toEqual({
      command: "supervise",
      args: ["--batch", "01.01"],
      help: false,
    })
    expect(parseWorkSdkCommand(["bun", "work-sdk", "batch-executor", "--batch", "01.01"])).toMatchObject({
      command: "batch-executor",
      help: false,
    })
    expect(parseBatchExecutorArgs([
      "bun",
      "work-sdk-batch-executor",
      "--stream",
      "001-test",
      "--batch-id",
      "01.01",
      "--execution-backend",
      "sdk",
      "--runtime",
      "cursor",
      "--port",
      "4097",
      "--no-server",
    ])).toMatchObject({
      streamId: "001-test",
      batchId: "01.01",
      runtime: "cursor",
      port: 4097,
      noServer: true,
    })
    expect(parseBatchExecutorArgs([
      "bun",
      "work-sdk-batch-executor",
      "--stream",
      "001-test",
      "--batch-id",
      "01.01",
      "--execution-backend",
      "legacy",
    ])).toBeNull()
    expect(parseBatchEventsArgs([
      "bun",
      "work-sdk-batch-events",
      "--repo-root",
      "/tmp/repo",
      "--stream",
      "001-test",
      "--batch",
      "01.01",
      "--follow",
      "--timeout-ms",
      "5000",
      "--format",
      "json",
    ])).toEqual({
      repoRoot: "/tmp/repo",
      streamId: "001-test",
      batch: "01.01",
      follow: true,
      timeoutMs: 5000,
      format: "json",
    })
  })
})

describe("supervision helper backend launch seams", () => {
  test("launches SDK worker detached with executor.log and forwards runtime options", async () => {
    const calls: { command: string[]; options: any } = { command: [], options: undefined }
    let closedFd: number | undefined
    let reads = 0
    const dependencies: SupervisionHelperDependencies = {
      prepareSdkBatchRun: (options) => ({
        prepared: {} as any,
        ownerToken: "owner-1",
        batch: {
          batchId: options.batchId,
          runId: "run-1",
          executionBackend: "sdk",
          status: "pending",
          executorLogPath: "work/001-test/runtime/batches/01.01/runs/run-1/executor.log",
        } as any,
      }),
      openExecutorLog: () => 41,
      closeExecutorLog: (fd) => { closedFd = fd },
      spawn: ((command: string, args: string[], options: any) => {
        calls.command = [command, ...args]
        calls.options = options
        return fakeChild()
      }) as any,
      readBatchStatus: () => {
        reads += 1
        return {
          batchId: "01.01",
          runId: "run-1",
          executionBackend: "sdk",
          status: "running",
          executorPid: 123,
        } as any
      },
      sleep: async () => undefined,
    }

    await launchHeadlessBatchExecution({
      repoRoot: "/tmp/repo",
      streamId: "001-test",
      batchId: "01.01",
      executionBackend: "sdk",
      runtime: "cursor",
      port: 4097,
      noServer: true,
      silent: true,
    }, dependencies)

    expect(calls.command[1]).toContain("work-sdk")
    expect(calls.command).toContain("batch-executor")
    expect(calls.command).toContain("--execution-backend")
    expect(calls.command).toContain("sdk")
    expect(calls.command).toContain("--runtime")
    expect(calls.command).toContain("cursor")
    expect(calls.command).toContain("--port")
    expect(calls.command).toContain("4097")
    expect(calls.command).toContain("--no-server")
    expect(calls.command).toContain("--silent")
    expect(calls.options).toMatchObject({ detached: true, stdio: ["ignore", 41, 41] })
    expect(calls.options.stdio).not.toContain("pipe")
    expect(closedFd).toBe(41)
    expect(reads).toBeGreaterThan(0)
  })

  test("keeps legacy work multi attached and pipe-backed", async () => {
    let command: string[] = []
    let options: any
    await launchHeadlessBatchExecution({
      repoRoot: "/tmp/repo",
      streamId: "001-test",
      batchId: "01.01",
    }, {
      spawn: ((executable: string, args: string[], spawnOptions: any) => {
        command = [executable, ...args]
        options = spawnOptions
        return fakeChild()
      }) as any,
    })

    expect(command[1]).toContain("work.ts")
    expect(command).toContain("multi")
    expect(command).toContain("--headless")
    expect(command).toContain("--async")
    expect(options.detached).toBeUndefined()
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"])
  })

  test("batch-events follow handles journal creation and stops on terminal activity", async () => {
    let available = false
    let now = 0
    let content = Buffer.from("")
    const fileSystem: ReadActivityFileSystem = {
      existsSync: () => available,
      readFileSync: () => content,
    }
    const output: string[] = []
    const resultPromise = observeBatchEvents({
      repoRoot: "/tmp/repo",
      streamId: "001-test",
      batchId: "01.01",
      follow: true,
      timeoutMs: 1000,
      format: "text",
      readStatus: () => ({
        activityJournalPath: "work/001-test/runtime/batches/01.01/runs/run-1/activity.jsonl",
      } as any),
      fileSystem,
      now: () => now,
      sleep: async () => {
        available = true
        content = Buffer.from([
          JSON.stringify({
            timestamp: "2026-08-17T00:00:00.000Z",
            streamId: "001-test",
            batchId: "01.01",
            kind: "batch_completed",
            summary: "done",
          }),
          "",
        ].join("\n"))
        now = 1
      },
      write: (line) => output.push(line),
    })
    const result = await resultPromise

    expect(result.terminal).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(output).toHaveLength(1)
    expect(output[0]).toContain("batch_completed")
  })
})
