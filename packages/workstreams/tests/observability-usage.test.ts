import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ActivityJournal,
  formatSessionTextRecord,
  normalizeActivityUsage,
  readActivityJournal,
  type ActivityRecord,
} from "../src/lib/agent-runtime/observability.ts"

describe("activity usage observability", () => {
  test("normalizes provider usage into provider-neutral activity fields", () => {
    expect(normalizeActivityUsage({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 3,
      cacheWriteTokens: 1,
      reasoningTokens: 2,
    })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      reasoningTokens: 2,
    })
    expect(normalizeActivityUsage({ cacheReadTokens: 4 })).toEqual({ cacheReadTokens: 4 })
    expect(normalizeActivityUsage({})).toBeUndefined()
  })

  test("persists structured usage on activity records and round-trips through JSONL", () => {
    const directory = mkdtempSync(join(tmpdir(), "activity-usage-"))
    const journalPath = join(directory, "activity.jsonl")
    const journal = new ActivityJournal({
      path: journalPath,
      streamId: "stream-1",
      batchId: "01.01",
      now: () => "2026-08-17T00:00:10.000Z",
    })

    journal.append({
      threadId: "01.01.01",
      attemptId: "attempt-1",
      workSessionId: "session-1",
      provider: "cursor",
      kind: "usage",
      summary: "Usage: 15 tokens",
      usage: normalizeActivityUsage({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        reasoningTokens: 2,
      }),
      flush: true,
    })
    journal.close()

    const records = readActivityJournal(journalPath)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: "usage",
      threadId: "01.01.01",
      attemptId: "attempt-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
        cacheWriteTokens: 1,
        reasoningTokens: 2,
      },
    })

    const raw = readFileSync(journalPath, "utf8")
    expect(JSON.parse(raw.trim())).toMatchObject({ usage: { totalTokens: 15 } })
    rmSync(directory, { recursive: true, force: true })
  })

  test("adds token fields to Level 3 session text for usage records only", () => {
    const usageRecord: ActivityRecord = {
      timestamp: "2026-08-17T00:00:10.000Z",
      streamId: "stream-1",
      batchId: "01.01",
      threadId: "01.01.01",
      attemptId: "attempt-1",
      provider: "cursor",
      kind: "usage",
      summary: "Usage: 15 tokens",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
      },
    }
    const assistantRecord: ActivityRecord = {
      ...usageRecord,
      kind: "assistant",
      summary: "hello",
      usage: undefined,
    }

    expect(formatSessionTextRecord(usageRecord)).toContain("inputTokens=10")
    expect(formatSessionTextRecord(usageRecord)).toContain("cacheReadTokens=3")
    expect(formatSessionTextRecord(assistantRecord)).not.toContain("inputTokens=")
  })
})
