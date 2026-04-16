import { describe, expect, test } from "bun:test"

import { createLiveRefreshHub, type LiveRefreshEventType } from "../src/live-refresh.ts"

const LIVE_EVENT_TYPES = [
  "snapshot",
  "observability",
  "heartbeat",
  "error",
] as const satisfies readonly LiveRefreshEventType[]

describe("live refresh hub", () => {
  test("matches the approved live event surface", () => {
    expect(LIVE_EVENT_TYPES).toEqual([
      "snapshot",
      "observability",
      "heartbeat",
      "error",
    ])
  })

  test("emits contract-aligned heartbeat and error events over SSE", async () => {
    const hub = createLiveRefreshHub({
      heartbeatIntervalMs: 60_000,
      now: () => new Date("2026-04-15T12:00:00.000Z"),
    })
    const response = hub.createResponse()
    const reader = response.body?.getReader()

    expect(reader).toBeDefined()

    const decoder = new TextDecoder()
    const firstChunk = await reader!.read()
    expect(decoder.decode(firstChunk.value)).toContain("event: heartbeat")

    hub.publishError({
      code: "test_error",
      message: "Test error",
      retryable: true,
    })

    const secondChunk = await reader!.read()
    const secondText = decoder.decode(secondChunk.value)
    expect(secondText).toContain("event: error")
    expect(secondText).toContain('"code":"test_error"')
    expect(secondText).toContain('"retryable":true')

    await reader!.cancel()
    hub.close()
  })

  test("removes disconnected subscribers and ignores later emits", async () => {
    const abortController = new AbortController()
    const hub = createLiveRefreshHub({
      heartbeatIntervalMs: 60_000,
      now: () => new Date("2026-04-15T12:00:00.000Z"),
    })
    const response = hub.createResponse(abortController.signal)
    const reader = response.body?.getReader()

    expect(reader).toBeDefined()
    expect(hub.getSubscriberCount()).toBe(1)

    await reader!.read()
    abortController.abort()
    await Promise.resolve()

    expect(hub.getSubscriberCount()).toBe(0)

    expect(() => {
      hub.publishError({
        code: "after_disconnect",
        message: "safe after disconnect",
        retryable: false,
      })
    }).not.toThrow()

    await reader!.cancel()
    hub.close()
  })
})
