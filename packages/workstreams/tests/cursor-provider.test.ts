import { describe, expect, test } from "bun:test"

import {
  CursorLocalAdapter,
  type CursorAgentLike,
  type CursorRunLike,
  type CursorSdkLike,
} from "../src/lib/agent-runtime/providers/cursor.ts"
import type { AgentEvent, AttemptInput } from "../src/lib/agent-runtime/contracts.ts"
import { resolveModelSpec } from "../src/lib/model.ts"

const cwd = "/workspace"

function input(overrides: Partial<AttemptInput> = {}): AttemptInput {
  return {
    repoRoot: cwd,
    streamId: "stream-1",
    batchId: "batch-1",
    threadId: "thread-1",
    workSessionId: "work-session-1",
    attemptId: "attempt-1",
    logicalAgent: "builder",
    model: resolveModelSpec("auto@cursor"),
    prompt: "ignored by run",
    title: "Build the feature",
    executionBackend: "sdk",
    ...overrides,
  }
}

function finiteStream(events: readonly unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const event of events) {
      await Promise.resolve()
      yield event
    }
  })()
}

interface FakeRunOptions {
  id?: string
  stream?: AsyncIterable<unknown>
  wait?: () => Promise<unknown>
  sendCancel?: () => Promise<void>
}

function fakeRun(options: FakeRunOptions = {}): CursorRunLike & { cancelCalls: number } {
  let cancelCalls = 0
  return {
    id: options.id ?? "run-1",
    stream: () => options.stream ?? finiteStream([]),
    wait: options.wait ?? (async () => ({ id: options.id ?? "run-1", status: "finished", result: "done" })),
    cancel: async () => {
      cancelCalls += 1
      if (options.sendCancel) await options.sendCancel()
    },
    get cancelCalls() { return cancelCalls },
  }
}

function fakeSdk(options: {
  agentId?: string
  create?: () => Promise<CursorAgentLike>
  send?: (prompt: string) => Promise<CursorRunLike>
  disposed?: () => void
} = {}): { sdk: CursorSdkLike; createRequests: Record<string, unknown>[] } {
  const createRequests: Record<string, unknown>[] = []
  const sdk: CursorSdkLike = {
    Agent: {
      async create(request) {
        createRequests.push(request)
        if (options.create) return options.create()
        return {
          agentId: options.agentId ?? "agent-1",
          send: options.send ?? (async () => fakeRun()),
          [Symbol.asyncDispose]: async () => options.disposed?.(),
        }
      },
    },
  }
  return { sdk, createRequests }
}

async function collect(adapter: CursorLocalAdapter, native: Awaited<ReturnType<CursorLocalAdapter["startAttempt"]>>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of adapter.events(native)) events.push(event)
  return events
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  expect(predicate()).toBe(true)
}

describe("Cursor local provider adapter", () => {
  test("fails clearly for setup errors and missing credentials without importing the SDK", async () => {
    const { sdk } = fakeSdk({ create: async () => { throw new Error("setup failed") } })
    await expect(new CursorLocalAdapter({ sdk, apiKey: "test-key" }).startAttempt(input())).rejects.toThrow("setup failed")

    const previous = process.env.CURSOR_API_KEY
    delete process.env.CURSOR_API_KEY
    try {
      const neverLoaded = async () => { throw new Error("SDK must not load") }
      await expect(new CursorLocalAdapter({ sdkLoader: neverLoaded }).startAttempt(input({ attemptId: "missing-key" })))
        .rejects.toThrow(/CURSOR_API_KEY or apiKey is required/)
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY
      else process.env.CURSOR_API_KEY = previous
    }
  })

  test("bounds Agent.create setup and disposes a late-created agent", async () => {
    let resolveAgent!: (agent: CursorAgentLike) => void
    let disposed = false
    const create = new Promise<CursorAgentLike>((resolve) => { resolveAgent = resolve })
    const { sdk } = fakeSdk({ create: async () => create })
    const adapter = new CursorLocalAdapter({ sdk, apiKey: "test-key", setupTimeoutMs: 5, cleanupTimeoutMs: 20 })
    await expect(adapter.startAttempt(input({ attemptId: "setup-timeout" }))).rejects.toMatchObject({ code: "TIMEOUT", timedOut: true })
    resolveAgent({ agentId: "late-agent", send: async () => fakeRun(), [Symbol.asyncDispose]: async () => { disposed = true } })
    await waitFor(() => disposed)
    await adapter.close()
  })

  test("creates and exposes the native agent before prompt submission", async () => {
    let promptStarted = false
    const { sdk, createRequests } = fakeSdk({
      agentId: "native-agent",
      send: async () => {
        promptStarted = true
        return fakeRun({ id: "native-run" })
      },
    })
    const adapter = new CursorLocalAdapter({ sdk, apiKey: "test-key" })
    const native = await adapter.startAttempt(input())
    expect(native).toMatchObject({ provider: "cursor", nativeSessionId: "native-agent" })
    expect(promptStarted).toBe(false)
    const result = await adapter.run(native, "actual prompt")
    expect(promptStarted).toBe(true)
    expect(native.nativeRunId).toBe("native-run")
    expect(result).toMatchObject({ status: "completed", result: "done", nativeSessionId: "native-agent", nativeRunId: "native-run" })
    expect(createRequests[0]).toEqual({ apiKey: "test-key", model: { id: "auto" }, local: { cwd } })
    await adapter.close()
  })

  test("normalizes typed Cursor events with correlation and compact diagnostics", async () => {
    const events = [
      { type: "system", subtype: "init", agent_id: "native-agent", run_id: "native-run", tools: ["shell"] },
      { type: "assistant", agent_id: "native-agent", run_id: "native-run", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
      { type: "thinking", agent_id: "native-agent", run_id: "native-run", text: "reasoning" },
      { type: "tool_call", agent_id: "native-agent", run_id: "native-run", call_id: "call-1", name: "shell", status: "completed", args: { command: "pwd" }, result: "/workspace" },
      { type: "status", agent_id: "native-agent", run_id: "native-run", status: "RUNNING", message: "working" },
      { type: "task", agent_id: "native-agent", run_id: "native-run", status: "started", text: "subtask" },
      { type: "request", agent_id: "native-agent", run_id: "native-run", request_id: "request-1" },
      { type: "usage", agent_id: "native-agent", run_id: "native-run", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cacheReadTokens: 1 } },
    ]
    const { sdk } = fakeSdk({ send: async () => fakeRun({ id: "native-run", stream: finiteStream(events) }) })
    const adapter = new CursorLocalAdapter({ sdk, apiKey: "test-key", clock: () => "2026-08-17T00:00:00.000Z" })
    const native = await adapter.startAttempt(input({ attemptId: "event-attempt", workSessionId: "event-session" }))
    await adapter.run(native, "prompt")
    const observed = await collect(adapter, native)

    expect(observed.map((event) => event.type)).toEqual([
      "started", "status", "assistant", "assistant", "tool", "status", "status", "status", "usage", "completed",
    ])
    expect(observed.every((event) => event.provider === "cursor" && event.attemptId === "event-attempt" && event.workSessionId === "event-session")).toBe(true)
    expect(observed.find((event) => event.type === "assistant" && event.text === "hello")).toMatchObject({ delta: false })
    expect(observed.find((event) => event.type === "assistant" && event.text === "reasoning")).toMatchObject({ delta: true, contentKind: "reasoning" })
    expect(observed.find((event) => event.type === "tool")).toMatchObject({ toolName: "shell", phase: "completed", input: { command: "pwd" }, output: "/workspace", correlationId: "call-1" })
    expect(observed.find((event) => event.type === "usage")).toMatchObject({ usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cachedInputTokens: 1 } })
    expect(observed.filter((event) => event.diagnostic !== undefined).every((event) => JSON.stringify(event.diagnostic).length < 3_000)).toBe(true)
    await adapter.close()
  })

  test("normalizes send failures and bounds prompt submission", async () => {
    const { sdk } = fakeSdk({ send: async () => { throw new Error("send failed") } })
    const adapter = new CursorLocalAdapter({ sdk, apiKey: "test-key" })
    const native = await adapter.startAttempt(input({ attemptId: "send-failure" }))
    await expect(adapter.run(native, "prompt")).resolves.toMatchObject({ status: "failed", error: { message: "send failed" }, nativeSessionId: "agent-1" })
    await adapter.close()

    const hanging = fakeSdk({ send: async () => new Promise<CursorRunLike>(() => undefined) })
    const boundedAdapter = new CursorLocalAdapter({ sdk: hanging.sdk, apiKey: "test-key", sendTimeoutMs: 5 })
    const boundedNative = await boundedAdapter.startAttempt(input({ attemptId: "send-timeout" }))
    await expect(boundedAdapter.run(boundedNative, "prompt")).resolves.toMatchObject({ status: "failed", error: { code: "TIMEOUT", timedOut: true } })
    await boundedAdapter.close()
  })

  test("cancels safely before and after run creation", async () => {
    const first = fakeSdk()
    const firstAdapter = new CursorLocalAdapter({ sdk: first.sdk, apiKey: "test-key" })
    const firstNative = await firstAdapter.startAttempt(input({ attemptId: "cancel-before-run" }))
    await expect(firstAdapter.cancel(firstNative)).resolves.toMatchObject({ status: "cancelled", cancelled: true, acknowledged: true })
    await expect(firstAdapter.run(firstNative, "prompt")).resolves.toMatchObject({ status: "cancelled" })
    await firstAdapter.close()

    let runStarted = false
    let releaseWait!: () => void
    const wait = new Promise<void>((resolve) => { releaseWait = resolve })
    const run = fakeRun({ wait: async () => { await wait; return { id: "cancel-run", status: "cancelled" } } })
    const second = fakeSdk({ send: async () => { runStarted = true; return run } })
    const secondAdapter = new CursorLocalAdapter({ sdk: second.sdk, apiKey: "test-key" })
    const secondNative = await secondAdapter.startAttempt(input({ attemptId: "cancel-after-run" }))
    const running = secondAdapter.run(secondNative, "prompt")
    await waitFor(() => runStarted)
    await expect(secondAdapter.cancel(secondNative)).resolves.toMatchObject({ status: "cancelled", cancelled: true, acknowledged: true })
    releaseWait()
    await expect(running).resolves.toMatchObject({ status: "cancelled" })
    expect(run.cancelCalls).toBe(1)
    await secondAdapter.close()
  })

  test("disposes agents best-effort and keeps concurrent adapters independent", async () => {
    let disposeCalls = 0
    const make = (agentId: string) => fakeSdk({
      agentId,
      disposed: () => { disposeCalls += 1 },
      send: async () => fakeRun({ id: `run-${agentId}`, stream: finiteStream([]), wait: async () => ({ id: `run-${agentId}`, status: "finished", result: agentId }) }),
    })
    const first = new CursorLocalAdapter({ sdk: make("agent-a").sdk, apiKey: "test-key" })
    const second = new CursorLocalAdapter({ sdk: make("agent-b").sdk, apiKey: "test-key" })
    const [firstNative, secondNative] = await Promise.all([
      first.startAttempt(input({ attemptId: "concurrent-a", threadId: "thread-a" })),
      second.startAttempt(input({ attemptId: "concurrent-b", threadId: "thread-b" })),
    ])
    const [firstResult, secondResult] = await Promise.all([first.run(firstNative, "a"), second.run(secondNative, "b")])
    expect(firstResult).toMatchObject({ status: "completed", result: "agent-a", nativeSessionId: "agent-a" })
    expect(secondResult).toMatchObject({ status: "completed", result: "agent-b", nativeSessionId: "agent-b" })
    await Promise.all([first.close(), second.close()])
    expect(disposeCalls).toBe(2)

    const failingDispose = fakeSdk({ disposed: () => { throw new Error("dispose failed") } })
    const cleanupAdapter = new CursorLocalAdapter({ sdk: failingDispose.sdk, apiKey: "test-key" })
    await cleanupAdapter.startAttempt(input({ attemptId: "cleanup-failure" }))
    await expect(cleanupAdapter.close()).resolves.toBeUndefined()
  })
})
