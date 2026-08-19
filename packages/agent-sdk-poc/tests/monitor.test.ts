import { afterEach, describe, expect, test } from "bun:test"

import { formatLatestUsageSummary } from "../monitor/usage-format.ts"

describe("SDK monitor repository selection", () => {
  afterEach(() => {
    delete process.env.AGENV_MONITOR_REPO_ROOT
  })

  test("exposes only the fixed monitored repository roots", async () => {
    const monitor = await import("../monitor/server.ts")

    expect(monitor.MONITORED_REPOSITORIES).toEqual([
      { key: "gene", label: "~/gene", root: "/Users/beto/gene" },
      { key: "betalytics-backend", label: "~/betalytics-backend", root: "/Users/beto/betalytics-backend" },
      { key: "agenv", label: "~/agenv", root: "/Users/beto/agenv" },
    ])

    process.env.AGENV_MONITOR_REPO_ROOT = "/tmp/not-a-monitored-repository"
    expect(monitor.getMonitorRepository()).toMatchObject({ key: "gene", root: "/Users/beto/gene" })

    process.env.AGENV_MONITOR_REPO_ROOT = "/Users/beto/agenv"
    expect(monitor.getMonitorRepository()).toMatchObject({ key: "agenv", root: "/Users/beto/agenv" })
    expect(monitor.resolveMonitorRepoRoot()).toBe("/Users/beto/agenv")
  })

  test("selects a whitelisted repository and includes its metadata in the API payload", async () => {
    const monitor = await import("../monitor/server.ts")

    for (const repository of monitor.MONITORED_REPOSITORIES) {
      const response = monitor.requestHandler(new Request(
        `http://127.0.0.1:43120/api/sdk-monitor?repo=${repository.key}`,
      ))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ repository })
    }

    process.env.AGENV_MONITOR_REPO_ROOT = "/Users/beto/betalytics-backend"
    const defaultResponse = monitor.requestHandler(new Request("http://127.0.0.1:43120/api/sdk-monitor"))
    expect(defaultResponse.status).toBe(200)
    expect(await defaultResponse.json()).toMatchObject({
      repository: {
        key: "betalytics-backend",
        label: "~/betalytics-backend",
        root: "/Users/beto/betalytics-backend",
      },
    })
  })

  test("rejects invalid repository selection and arbitrary query input", async () => {
    const monitor = await import("../monitor/server.ts")

    const invalid = monitor.requestHandler(new Request(
      "http://127.0.0.1:43120/api/sdk-monitor?repo=/tmp/not-a-repository",
    ))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("Unknown monitored repository key") })

    const unsupported = monitor.requestHandler(new Request(
      "http://127.0.0.1:43120/api/sdk-monitor?path=../../secret",
    ))
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({ error: expect.stringContaining("Unsupported query parameter") })
  })
})

describe("isolated SDK monitor usage selection", () => {
  test("selects the latest usage for a session from the full activity journal", async () => {
    const monitor = await import("../monitor/server.ts")
    const records = [
      {
        timestamp: "2026-08-17T00:00:01.000Z",
        threadId: "thread-a",
        attemptId: "attempt-1",
        workSessionId: "session-1",
        provider: "cursor",
        kind: "usage",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      ...Array.from({ length: 120 }, (_, index) => ({
        timestamp: `2026-08-17T00:01:${String(index).padStart(2, "0")}.000Z`,
        threadId: "thread-a",
        attemptId: "attempt-1",
        kind: "assistant",
        summary: `assistant-${index}`,
      })),
      {
        timestamp: "2026-08-17T00:02:00.000Z",
        threadId: "thread-a",
        attemptId: "attempt-1",
        workSessionId: "session-1",
        provider: "cursor",
        kind: "usage",
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          cacheReadTokens: 4,
          cacheWriteTokens: 2,
        },
      },
    ]

    expect(monitor.selectLatestSessionUsage(records, {
      threadId: "thread-a",
      attemptId: "attempt-1",
      workSessionId: "session-1",
    })).toMatchObject({
      timestamp: "2026-08-17T00:02:00.000Z",
      provider: "cursor",
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
    })
  })
})

describe("monitor usage formatting", () => {
  test("formats token counts and empty usage state", () => {
    expect(formatLatestUsageSummary(null)).toBe("Usage not reported yet")
    expect(formatLatestUsageSummary({
      inputTokens: 1200,
      outputTokens: 350,
      totalTokens: 1550,
      cacheReadTokens: 80,
      provider: "cursor",
    })).toBe("in 1,200 · out 350 · total 1,550 · cache read 80 · cursor")
  })
})
