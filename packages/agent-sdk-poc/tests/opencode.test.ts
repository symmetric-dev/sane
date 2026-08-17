import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { correlateProviderEvent } from "../src/artifacts.ts"
import {
  DEFAULT_OPENCODE_SERVER_URL,
  buildOpenCodePromptAsyncRequest,
  extractOpenCodePromptResponse,
  launchOpenCodeAsync,
  observeOpenCode,
  openCodeEventBelongsToSession,
  parseOpenCodeModel,
  runOpenCode,
  type OpenCodeClientLike,
} from "../src/opencode-runner.ts"
import type { PocEventEnvelope } from "../src/types.ts"

function finiteStream(events: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const event of events) yield event
  })()
}

function asClient(client: OpenCodeClientLike): OpenCodeClientLike {
  return client
}

async function readEvents(runDirectory: string): Promise<PocEventEnvelope[]> {
  const content = await readFile(join(runDirectory, "events.jsonl"), "utf8")
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PocEventEnvelope)
}

describe("OpenCode SDK boundary helpers", () => {
  test("parses provider/model without accepting Cursor's auto sentinel", () => {
    expect(parseOpenCodeModel("anthropic/claude-sonnet")).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
    })
    expect(() => parseOpenCodeModel("auto")).toThrow("provider/model")
    expect(() => parseOpenCodeModel("/model")).toThrow("provider/model")
  })

  test("extracts fields-envelope prompt data while preserving the response shape for callers", () => {
    const response = {
      data: {
        info: { id: "message-1", sessionID: "session-1", role: "assistant" },
        parts: [
          { id: "part-1", messageID: "message-1", sessionID: "session-1", type: "text", text: "hello" },
          { id: "part-2", messageID: "message-1", sessionID: "session-1", type: "text", text: " world" },
        ],
      },
      error: undefined,
      response: { status: 200 },
    }

    expect(extractOpenCodePromptResponse(response)).toMatchObject({
      messageId: "message-1",
      text: "hello world",
      parts: response.data.parts,
    })
  })

  test("correlates OpenCode casing and nested payload identifiers", () => {
    expect(
      correlateProviderEvent({
        payload: { properties: { sessionID: "session-1", messageID: "message-1" } },
      }),
    ).toMatchObject({ sessionId: "session-1", messageId: "message-1" })
  })

  test("filters only events that explicitly belong to another session", () => {
    const matching = { payload: { type: "session.status", properties: { sessionID: "session-1" } } }
    const other = { payload: { type: "session.status", properties: { sessionID: "session-2" } } }
    const global = { payload: { type: "server.connected", properties: {} } }
    expect(openCodeEventBelongsToSession(matching, "session-1")).toBe(true)
    expect(openCodeEventBelongsToSession(other, "session-1")).toBe(false)
    expect(openCodeEventBelongsToSession(global, "session-1")).toBe(true)
  })

  test("builds the installed SDK promptAsync request with the endpoint's body shape", () => {
    expect(buildOpenCodePromptAsyncRequest("session-async", "/workspace", "wait", {
      providerID: "openai",
      modelID: "gpt-5",
    })).toEqual({
      path: { id: "session-async" },
      query: { directory: "/workspace" },
      body: {
        parts: [{ type: "text", text: "wait" }],
        model: { providerID: "openai", modelID: "gpt-5" },
      },
    })
  })
})

describe("OpenCode fake runner and observer", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
  })

  test("persists the native session ID before prompt_async and returns a running acceptance artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-sdk-poc-opencode-async-"))
    temporaryDirectories.push(root)
    let manifestDuringPrompt: Record<string, unknown> | undefined
    let promptOptions: Record<string, unknown> | undefined
    let subscribeCalls = 0
    const client = asClient({
      session: {
        async create() {
          return { data: { id: "session-async" }, response: { status: 200 } }
        },
        async get() {
          throw new Error("not used")
        },
        async status() {
          throw new Error("not used")
        },
        async messages() {
          throw new Error("not used")
        },
        async prompt() {
          throw new Error("not used")
        },
        async promptAsync(options) {
          promptOptions = options
          manifestDuringPrompt = JSON.parse(await readFile(join(root, "artifacts", "manifest.json"), "utf8")) as Record<string, unknown>
          return { data: undefined, error: undefined, response: { status: 204 } }
        },
      },
      event: {
        async subscribe() {
          subscribeCalls += 1
          throw new Error("async launcher must not subscribe")
        },
      },
    })

    const artifact = await launchOpenCodeAsync({
      serverUrl: "http://127.0.0.1:4096/",
      prompt: "wait",
      model: "openai/gpt-5",
      cwd: root,
      runDirectory: join(root, "artifacts"),
      client,
      onActivity: () => undefined,
    })

    expect(artifact).toMatchObject({
      provider: "opencode",
      status: "running",
      launchKind: "async",
      observerRequired: true,
      sessionId: "session-async",
      serverUrl: "http://127.0.0.1:4096",
      model: "openai/gpt-5",
      asyncAcceptedStatus: 204,
    })
    expect(manifestDuringPrompt).toMatchObject({ sessionId: "session-async", status: "running" })
    expect(promptOptions).toEqual({
      path: { id: "session-async" },
      query: { directory: root },
      body: {
        parts: [{ type: "text", text: "wait" }],
        model: { providerID: "openai", modelID: "gpt-5" },
      },
    })
    expect(subscribeCalls).toBe(0)

    const manifest = JSON.parse(await readFile(join(artifact.runDirectory, "manifest.json"), "utf8")) as Record<string, unknown>
    const result = JSON.parse(await readFile(join(artifact.runDirectory, "result.json"), "utf8")) as Record<string, unknown>
    expect(manifest).toMatchObject({ status: "running", observerRequired: true, acceptedAt: expect.any(String) })
    expect(result).toMatchObject({ status: "running", sessionId: "session-async", asyncAcceptedStatus: 204 })
    const events = await readEvents(artifact.runDirectory)
    expect(events.some((event) => event.kind === "prompt_async_request")).toBe(true)
    expect(events.some((event) => event.kind === "prompt_async_response")).toBe(true)
    expect(events.some((event) => event.kind === "terminal_result")).toBe(false)
  })

  test("records session ID before prompting and captures raw SSE, parts, status, and result", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-sdk-poc-opencode-run-"))
    temporaryDirectories.push(root)
    const calls: string[] = []
    let promptOptions: Record<string, unknown> | undefined
    const client = asClient({
      session: {
        async create() {
          calls.push("create")
          return { data: { id: "session-run", title: "fake" }, response: { status: 200 } }
        },
        async get() {
          throw new Error("not used")
        },
        async status() {
          calls.push("status")
          return { data: { "session-run": { type: "idle" } }, response: { status: 200 } }
        },
        async messages() {
          throw new Error("not used")
        },
        async prompt(options) {
          calls.push("prompt")
          promptOptions = options
          return {
            data: {
              info: { id: "message-run", sessionID: "session-run", role: "assistant" },
              parts: [{ id: "part-run", messageID: "message-run", sessionID: "session-run", type: "text", text: "DONE" }],
            },
            response: { status: 200 },
          }
        },
      },
      event: {
        async subscribe() {
          calls.push("subscribe")
          return {
            stream: finiteStream([
              { payload: { type: "session.status", properties: { sessionID: "session-run", status: { type: "busy" } } } },
              { payload: { type: "message.part.updated", properties: { sessionID: "session-run", part: { type: "text", text: "stream" } } } },
            ]),
          }
        },
      },
    })

    const artifact = await runOpenCode({
      serverUrl: "http://127.0.0.1:4096/",
      prompt: "respond",
      cwd: root,
      runDirectory: join(root, "artifacts"),
      client,
      onActivity: () => undefined,
    })

    expect(artifact).toMatchObject({
      provider: "opencode",
      status: "finished",
      sessionId: "session-run",
      messageId: "message-run",
      serverUrl: "http://127.0.0.1:4096",
      result: "DONE",
      sessionStatus: { type: "idle" },
    })
    expect(calls.indexOf("subscribe")).toBeGreaterThan(calls.indexOf("create"))
    expect(calls.indexOf("subscribe")).toBeLessThan(calls.indexOf("prompt"))
    expect(promptOptions?.body).toEqual({ parts: [{ type: "text", text: "respond" }] })

    const events = await readEvents(artifact.runDirectory)
    expect(events.some((event) => event.kind === "sse")).toBe(true)
    expect(events.some((event) => event.kind === "message" && typeof event.raw === "object" && event.raw !== null && "id" in event.raw)).toBe(true)
    expect(events.some((event) => event.kind === "part")).toBe(true)
    expect(events.some((event) => event.kind === "session_status")).toBe(true)
    expect(events.some((event) => event.kind === "terminal_result")).toBe(true)
  })

  test("observer inspects a session and retains, but does not print, other-session events", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-sdk-poc-opencode-observe-"))
    temporaryDirectories.push(root)
    const activity: string[] = []
    let statusCalls = 0
    const client = asClient({
      session: {
        async create() {
          throw new Error("not used")
        },
        async get() {
          return { data: { id: "session-observe", title: "Observed session" } }
        },
        async status() {
          statusCalls += 1
          return statusCalls > 1 ? { data: {} } : { data: { "session-observe": { type: "busy" } } }
        },
        async messages() {
          return {
            data: [
              {
                info: { id: "message-old", sessionID: "session-observe", role: "assistant" },
                parts: [{ id: "part-old", messageID: "message-old", sessionID: "session-observe", type: "text", text: "old" }],
              },
            ],
          }
        },
        async prompt() {
          throw new Error("not used")
        },
      },
      event: {
        async subscribe() {
          return {
            stream: finiteStream([
              { payload: { type: "session.status", properties: { sessionID: "other", status: { type: "busy" } } } },
              { payload: { type: "message.part.updated", properties: { sessionID: "session-observe", part: { type: "text", text: "current" } } } },
              { payload: { type: "session.idle", properties: { sessionID: "session-observe" } } },
            ]),
          }
        },
      },
    })

    const artifact = await observeOpenCode({
      serverUrl: "http://127.0.0.1:4096",
      sessionId: "session-observe",
      cwd: root,
      runDirectory: join(root, "artifacts"),
      client,
      onActivity: (line) => {
        activity.push(line)
      },
    })

    expect(artifact.status).toBe("finished")
    expect(artifact.sessionId).toBe("session-observe")
    expect(artifact.messageId).toBe("message-old")
    expect(artifact.sessionStatus).toEqual({ type: "idle" })
    expect(activity.some((line) => line.includes("current"))).toBe(true)
    expect(activity.some((line) => line.includes("other"))).toBe(false)

    const events = await readEvents(artifact.runDirectory)
    expect(events.some((event) => event.kind === "sse_filtered")).toBe(true)
    expect(events.some((event) => event.kind === "sse")).toBe(true)
    expect(events.some((event) => event.kind === "messages_response")).toBe(true)
    expect(events.some((event) => event.kind === "message")).toBe(true)
    expect(events.some((event) => event.kind === "part")).toBe(true)
  })

  test("uses session.abort and marks a timed-out synchronous prompt cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-sdk-poc-opencode-timeout-"))
    temporaryDirectories.push(root)
    let abortCalls = 0
    const client = asClient({
      session: {
        async create() {
          return { data: { id: "session-timeout" } }
        },
        async get() {
          throw new Error("not used")
        },
        async status() {
          return { data: { "session-timeout": { type: "idle" } } }
        },
        async messages() {
          throw new Error("not used")
        },
        async prompt(options) {
          return new Promise((resolve) => {
            const signal = options.signal as AbortSignal
            signal.addEventListener("abort", () => {
              resolve({
                data: {
                  info: {
                    id: "message-timeout",
                    sessionID: "session-timeout",
                    role: "assistant",
                    error: { name: "MessageAbortedError", data: { message: "aborted" } },
                  },
                  parts: [],
                },
              })
            })
          })
        },
        async abort() {
          abortCalls += 1
          return { data: true }
        },
      },
      event: {
        async subscribe() {
          return { stream: finiteStream([]) }
        },
      },
    })

    const artifact = await runOpenCode({
      serverUrl: DEFAULT_OPENCODE_SERVER_URL,
      prompt: "wait",
      cwd: root,
      runDirectory: join(root, "artifacts"),
      timeoutMs: 10,
      client,
      onActivity: () => undefined,
    })

    expect(artifact.status).toBe("cancelled")
    expect(artifact.cancellationRequestedAt).toBeString()
    expect(abortCalls).toBe(1)
  })
})
