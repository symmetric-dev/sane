import { describe, expect, test } from "bun:test"
import {
  buildOpenCodePromptRequest,
  OpenCodeV1Adapter,
  parseOpenCodeModel,
  type OpenCodeClientLike,
} from "../src/lib/agent-runtime/providers/opencode.ts"
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
    model: resolveModelSpec({ model: "anthropic/claude-sonnet", variant: "high" }),
    prompt: "ignored by run",
    title: "Build the feature",
    executionBackend: "sdk",
    ...overrides,
  }
}

function event(type: string, properties: Record<string, unknown>): unknown {
  return { payload: { type, properties } }
}

function finiteStream(events: readonly unknown[], error?: Error, delayMs = 0): AsyncIterable<unknown> {
  return (async function* () {
    for (const value of events) {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      else await Promise.resolve()
      yield value
    }
    if (error) {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      throw error
    }
  })()
}

interface FakeClientOptions {
  sessionId?: string
  prompt?: (request: Record<string, unknown>) => Promise<unknown>
  events?: readonly unknown[]
  streamError?: Error
  streamErrorDelayMs?: number
  abort?: (request: Record<string, unknown>) => Promise<unknown>
}

interface FakeClientState {
  createRequests: Record<string, unknown>[]
  promptRequests: Record<string, unknown>[]
  subscribeRequests: Record<string, unknown>[]
  abortRequests: Record<string, unknown>[]
  streamsReturned: number
}

function fakeClient(options: FakeClientOptions = {}): { client: OpenCodeClientLike; state: FakeClientState } {
  const state: FakeClientState = {
    createRequests: [],
    promptRequests: [],
    subscribeRequests: [],
    abortRequests: [],
    streamsReturned: 0,
  }
  const client: OpenCodeClientLike = {
    session: {
      async create(request) {
        state.createRequests.push(request)
        return { data: { id: options.sessionId ?? "native-session-1" }, response: { status: 200 } }
      },
      async prompt(request) {
        state.promptRequests.push(request)
        if (options.prompt) return options.prompt(request)
        return {
          data: {
            info: {
              id: "native-message-1",
              sessionID: options.sessionId ?? "native-session-1",
              role: "assistant",
              tokens: { input: 3, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
              cost: 0.02,
            },
            parts: [{ type: "text", text: "final answer" }],
          },
          response: { status: 200 },
        }
      },
      async abort(request) {
        state.abortRequests.push(request)
        return options.abort ? options.abort(request) : { data: true, response: { status: 200 } }
      },
    },
    event: {
      async subscribe(request = {}) {
        state.subscribeRequests.push(request)
        const stream = finiteStream(options.events ?? [], options.streamError, options.streamErrorDelayMs)
        state.streamsReturned += 1
        return {
          stream: stream as AsyncIterable<unknown> & { return?: () => Promise<unknown> },
        }
      },
    },
  }
  return { client, state }
}

async function collectEvents(adapter: OpenCodeV1Adapter, native: Awaited<ReturnType<OpenCodeV1Adapter["startAttempt"]>>): Promise<AgentEvent[]> {
  const observed: AgentEvent[] = []
  for await (const item of adapter.events(native)) observed.push(item)
  return observed
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  expect(predicate()).toBe(true)
}

describe("OpenCode V1 provider adapter", () => {
  test("maps resolved models, preserves the native ID before prompt, and uses exact V1 request shapes", async () => {
    const { client, state } = fakeClient()
    const adapter = new OpenCodeV1Adapter({ serverUrl: "http://127.0.0.1:4096/", cwd, client })
    const native = await adapter.startAttempt(input())
    expect(native.nativeSessionId).toBe("native-session-1")

    let nativeIdSeenByPrompt: string | undefined
    const originalPrompt = client.session.prompt
    client.session.prompt = async (request) => {
      nativeIdSeenByPrompt = (request.path as { id?: string } | undefined)?.id
      return originalPrompt(request)
    }
    const result = await adapter.run(native, "actual prompt")

    expect(nativeIdSeenByPrompt).toBe(native.nativeSessionId)
    expect(state.createRequests).toEqual([
      { query: { directory: cwd }, body: { title: "Build the feature" } },
    ])
    expect(state.promptRequests).toHaveLength(1)
    expect(state.promptRequests[0]).toMatchObject({
      path: { id: "native-session-1" },
      query: { directory: cwd },
      body: {
        parts: [{ type: "text", text: "actual prompt" }],
        model: { providerID: "anthropic", modelID: "claude-sonnet" },
      },
    })
    expect(state.promptRequests[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(result).toMatchObject({
      status: "completed",
      result: "final answer",
      nativeSessionId: "native-session-1",
      nativeRunId: "native-message-1",
      providerMetadata: { variant: "high", messageId: "native-message-1" },
    })
    await adapter.close()
  })

  test("parses OpenCode models and intentionally omits only an unset model", () => {
    expect(parseOpenCodeModel("openai/gpt-5.1"))
      .toEqual({ providerID: "openai", modelID: "gpt-5.1" })
    expect(() => parseOpenCodeModel("auto")).toThrow("provider/model")
    expect(buildOpenCodePromptRequest("session", cwd, "hello")).toEqual({
      path: { id: "session" },
      query: { directory: cwd },
      body: { parts: [{ type: "text", text: "hello" }] },
    })
  })

  test("correlates status, message, text, tool, and usage events while filtering other sessions and unscoped globals", async () => {
    const sessionId = "session-events"
    const { client } = fakeClient({
      sessionId,
      events: [
        event("server.connected", {}),
        event("session.status", { sessionID: "other", status: { type: "busy" } }),
        event("session.status", { sessionID: sessionId, status: { type: "busy", progress: 0.25 } }),
        event("message.updated", {
          sessionID: sessionId,
          info: { id: "message-events", sessionID: sessionId, role: "assistant", tokens: { input: 1, output: 2 } },
        }),
        event("message.part.updated", {
          sessionID: sessionId,
          part: { type: "text", sessionID: sessionId, messageID: "message-events", text: "ignored full", id: "part-1" },
          delta: "text delta",
        }),
        event("message.part.updated", {
          sessionID: sessionId,
          part: {
            type: "tool",
            sessionID: sessionId,
            messageID: "message-events",
            tool: "shell",
            state: { status: "completed", input: { command: "pwd" }, output: "/workspace" },
          },
        }),
        event("session.next.reasoning.delta", {
          sessionID: sessionId,
          delta: "thinking delta",
        }),
      ],
    })
    const adapter = new OpenCodeV1Adapter({ serverUrl: "http://127.0.0.1:4096", cwd, client })
    const native = await adapter.startAttempt(input({ attemptId: "attempt-events", model: resolveModelSpec("openai/gpt-5") }))
    await adapter.run(native, "prompt")
    const observed = await collectEvents(adapter, native)

    expect(observed.map((item) => item.type)).toEqual([
      "started",
      "status",
      "progress",
      "usage",
      "assistant",
      "tool",
      "assistant",
      "usage",
      "completed",
    ])
    expect(observed.filter((item) => item.type === "status")[0]).toMatchObject({ status: "busy" })
    expect(observed.filter((item) => item.type === "assistant")[0]).toMatchObject({ text: "text delta", delta: true })
    expect(observed.filter((item) => item.type === "assistant")[1]).toMatchObject({ text: "thinking delta", contentKind: "reasoning" })
    expect(observed.filter((item) => item.type === "tool")[0]).toMatchObject({ toolName: "shell", phase: "completed" })
    expect(observed.every((item) => item.attemptId === "attempt-events")).toBe(true)
    expect(observed.every((item) => item.diagnostic !== undefined || item.type === "started" || item.type === "completed")).toBe(true)
    await adapter.close()
  })

  test("normalizes provider prompt errors with raw diagnostics", async () => {
    const rawError = { name: "ProviderAuthError", data: { providerID: "anthropic", message: "bad key" } }
    const { client } = fakeClient({
      prompt: async () => ({ error: rawError, response: { status: 401 } }),
    })
    const adapter = new OpenCodeV1Adapter({ serverUrl: "http://127.0.0.1:4096", cwd, client })
    const native = await adapter.startAttempt(input({ attemptId: "attempt-provider-error" }))
    const result = await adapter.run(native, "prompt")
    expect(result).toMatchObject({
      status: "failed",
      error: {
        name: "ProviderAuthError",
        message: "bad key",
        diagnostic: { raw: rawError },
      },
    })
    const observed = await collectEvents(adapter, native)
    expect(observed.at(-1)).toMatchObject({ type: "failed" })
    await adapter.close()
  })

  test("turns an SSE stream failure into a failed result and aborts a pending prompt", async () => {
    let promptAborted = false
    const { client, state } = fakeClient({
      streamError: new Error("connection dropped"),
      streamErrorDelayMs: 5,
      prompt: async (request) =>
        new Promise(() => {
          const signal = request.signal as AbortSignal
          if (signal.aborted) promptAborted = true
          signal.addEventListener("abort", () => {
            promptAborted = true
          })
        }),
    })
    const adapter = new OpenCodeV1Adapter({ serverUrl: "http://127.0.0.1:4096", cwd, client })
    const native = await adapter.startAttempt(input({ attemptId: "attempt-stream-error" }))
    const result = await adapter.run(native, "prompt")
    expect(result).toMatchObject({ status: "failed", error: { message: "connection dropped" } })
    expect(promptAborted).toBe(true)
    expect(state.abortRequests).toHaveLength(1)
    expect((await collectEvents(adapter, native)).at(-1)).toMatchObject({ type: "failed" })
    await adapter.close()
  })

  test("explicit cancellation aborts prompt and native session and returns CancelResult", async () => {
    let promptStarted = false
    let promptAborted = false
    const { client, state } = fakeClient({
      prompt: async (request) => {
        promptStarted = true
        return new Promise(() => {
          ;(request.signal as AbortSignal).addEventListener("abort", () => {
            promptAborted = true
          })
        })
      },
    })
    const adapter = new OpenCodeV1Adapter({ serverUrl: "http://127.0.0.1:4096", cwd, client })
    const native = await adapter.startAttempt(input({ attemptId: "attempt-cancel" }))
    const runPromise = adapter.run(native, "prompt")
    await waitFor(() => promptStarted)
    const cancellation = await adapter.cancel(native)
    const result = await runPromise

    expect(cancellation).toMatchObject({ status: "cancelled", cancelled: true, acknowledged: true })
    expect(result).toMatchObject({ status: "cancelled", nativeSessionId: native.nativeSessionId })
    expect(promptAborted).toBe(true)
    expect(state.abortRequests).toHaveLength(1)
    expect(state.abortRequests[0]).toMatchObject({ path: { id: native.nativeSessionId }, query: { directory: cwd } })
    await adapter.close()
  })

  test("starts timeout coverage before prompt and aborts with a normalized timeout failure", async () => {
    const { client, state } = fakeClient({
      prompt: async () => new Promise(() => undefined),
    })
    const adapter = new OpenCodeV1Adapter({
      serverUrl: "http://127.0.0.1:4096",
      cwd,
      client,
      timeoutMs: 5,
    })
    const native = await adapter.startAttempt(input({ attemptId: "attempt-timeout" }))
    const result = await adapter.run(native, "prompt")
    expect(result).toMatchObject({ status: "failed", error: { code: "TIMEOUT", timedOut: true } })
    expect(state.abortRequests).toHaveLength(1)
    await adapter.close()
  })

  test("keeps concurrent sessions independent and closes all native resources", async () => {
    const createdSessionIds = ["session-a", "session-b"]
    let createIndex = 0
    const { client, state } = fakeClient({
      events: [],
      prompt: async (request) => ({
        data: {
          info: {
            id: `message-${(request.path as { id?: string } | undefined)?.id}`,
            sessionID: (request.path as { id?: string } | undefined)?.id,
            role: "assistant",
          },
          parts: [{ type: "text", text: String((request.path as { id?: string } | undefined)?.id) }],
        },
      }),
    })
    client.session.create = async (request) => {
      state.createRequests.push(request)
      return { data: { id: createdSessionIds[createIndex++] }, response: { status: 200 } }
    }
    const adapter = new OpenCodeV1Adapter({ serverUrl: "http://127.0.0.1:4096", cwd, client })
    const firstInput = input({ attemptId: "attempt-a", threadId: "thread-a" })
    const secondInput = input({ attemptId: "attempt-b", threadId: "thread-b" })
    const first = await adapter.startAttempt(firstInput)
    const second = await adapter.startAttempt(secondInput)
    const [firstResult, secondResult] = await Promise.all([
      adapter.run(first, "first"),
      adapter.run(second, "second"),
    ])
    expect(firstResult).toMatchObject({ status: "completed", result: "session-a", nativeSessionId: "session-a" })
    expect(secondResult).toMatchObject({ status: "completed", result: "session-b", nativeSessionId: "session-b" })
    expect(state.subscribeRequests).toHaveLength(2)
    expect(state.promptRequests).toHaveLength(2)
    await adapter.close()
    expect(state.abortRequests).toHaveLength(0)
  })

  test("close is bounded cleanup and never starts or stops the shared server", async () => {
    let streamReturned = false
    const { client, state } = fakeClient({
      prompt: async () => new Promise(() => undefined),
    })
    client.event.subscribe = async (request = {}) => {
      state.subscribeRequests.push(request)
      const stream = {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(() => undefined)
          yield undefined
        },
        async return() {
          streamReturned = true
        },
      }
      return { stream }
    }
    const adapter = new OpenCodeV1Adapter({
      serverUrl: "http://127.0.0.1:4096",
      cwd,
      client,
      cleanupTimeoutMs: 10,
    })
    const native = await adapter.startAttempt(input({ attemptId: "attempt-close" }))
    void adapter.run(native, "prompt")
    await waitFor(() => state.promptRequests.length === 1)
    await adapter.close()
    expect(state.abortRequests).toHaveLength(1)
    expect(streamReturned).toBe(true)
    await expect(adapter.close()).resolves.toBeUndefined()
  })
})
