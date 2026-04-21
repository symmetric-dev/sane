import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { createBatchStatusFile, readBatchStatus, writeBatchStatus, writeBatchStatusLocked } from "../src/lib/batch-status"
import { loadSqliteStructuredStorageWorkstreamState } from "../src/lib/sqlite-storage"
import {
  modifyThreadMetadataViewSync,
  replaceThreadMetadataViewSync,
  writeStructuredBatchRunSync,
} from "../src/lib/storage-adapter"
import { loadThreads } from "../src/lib/threads"

describe("runtime write-side normalization", () => {
  let repoRoot: string
  let streamId: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "agenv-runtime-write-normalization-"))
    streamId = `001-runtime-write-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(join(repoRoot, "work", streamId), { recursive: true })

    writeFileSync(
      join(repoRoot, "work", "index.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          last_updated: new Date().toISOString(),
          current_stream: streamId,
          streams: [
            {
              id: streamId,
              name: "runtime-write-normalization",
              order: 1,
              size: "short",
              session_estimated: {
                length: 1,
                unit: "session",
                session_minutes: [30, 45],
                session_iterations: [4, 8],
              },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              path: `work/${streamId}`,
              generated_by: { workstreams: "test" },
            },
          ],
        },
        null,
        2,
      ),
    )

    writeFileSync(
      join(repoRoot, "work", streamId, "tasks.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: streamId,
          last_updated: new Date().toISOString(),
          tasks: [
            {
              id: "01.01.01.01",
              name: "Thread 1 task",
              thread_name: "Thread 1",
              batch_name: "Batch 1",
              stage_name: "Stage 1",
              status: "pending",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    )
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  function buildRawBatchStatus() {
    return {
      ...createBatchStatusFile({
        streamId,
        batchId: "1.1",
        stageName: "Stage 1",
        batchName: "Batch 1",
        threads: [{ threadId: "1.1.1", threadName: "Thread 1", firstTaskId: "1.1.1.1" }],
      }),
      batchId: "1.1",
      threads: [
        {
          threadId: "1.1.1",
          threadName: "Thread 1",
          firstTaskId: "1.1.1.1",
          status: "running" as const,
          updatedAt: new Date().toISOString(),
        },
      ],
    }
  }

  test("replaceThreadMetadataViewSync normalizes unambiguous raw thread ids", () => {
    replaceThreadMetadataViewSync({
      repoRoot,
      streamId,
      threadsFile: {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        threads: [{ threadId: "1.1.1", sessions: [], currentSessionId: "session-raw" }],
      },
    })

    expect(loadThreads(repoRoot, streamId)?.threads).toEqual([
      expect.objectContaining({ threadId: "01.01.01", currentSessionId: "session-raw" }),
    ])

    const sqliteState = loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId, {
      normalizeIds: false,
    })
    expect(sqliteState?.threadRuntime).toEqual([
      expect.objectContaining({ threadId: "01.01.01", currentSessionId: "session-raw" }),
    ])
  })

  test("modifyThreadMetadataViewSync collapses unambiguous raw thread ids onto canonical rows", () => {
    replaceThreadMetadataViewSync({
      repoRoot,
      streamId,
      threadsFile: {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        threads: [{ threadId: "01.01.01", sessions: [], currentSessionId: "session-1" }],
      },
    })

    modifyThreadMetadataViewSync({
      repoRoot,
      streamId,
      fn: (threadsFile) => {
        threadsFile.threads = [{ threadId: "1.1.1", sessions: [], currentSessionId: "session-2" }]
      },
    })

    expect(loadThreads(repoRoot, streamId)?.threads).toEqual([
      expect.objectContaining({ threadId: "01.01.01", currentSessionId: "session-2" }),
    ])
  })

  test("writeStructuredBatchRunSync normalizes unambiguous raw batch ids", () => {
    writeStructuredBatchRunSync(repoRoot, streamId, buildRawBatchStatus())

    expect(readBatchStatus(repoRoot, streamId, "01.01")).toMatchObject({
      batchId: "01.01",
      threads: [expect.objectContaining({ threadId: "01.01.01", firstTaskId: "01.01.01.01" })],
    })

    const sqliteState = loadSqliteStructuredStorageWorkstreamState(repoRoot, streamId, {
      normalizeIds: false,
    })
    expect(sqliteState?.batchRuns[0]).toMatchObject({
      batchId: "01.01",
      threads: [expect.objectContaining({ threadId: "01.01.01", firstTaskId: "01.01.01.01" })],
    })
  })

  test("writeBatchStatus normalizes unambiguous raw batch ids", () => {
    writeBatchStatus(repoRoot, streamId, buildRawBatchStatus())

    expect(readBatchStatus(repoRoot, streamId, "01.01")).toMatchObject({
      batchId: "01.01",
      threads: [expect.objectContaining({ threadId: "01.01.01", firstTaskId: "01.01.01.01" })],
    })
  })

  test("writeBatchStatusLocked normalizes unambiguous raw batch ids", async () => {
    await writeBatchStatusLocked(repoRoot, streamId, buildRawBatchStatus())

    expect(readBatchStatus(repoRoot, streamId, "01.01")).toMatchObject({
      batchId: "01.01",
      threads: [expect.objectContaining({ threadId: "01.01.01", firstTaskId: "01.01.01.01" })],
    })
  })
})
