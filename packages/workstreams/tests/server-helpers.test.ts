import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  getResolvedRuntimeSummary,
  getResolvedWorkstreamStatusSnapshot,
  getResolvedWorkstreamTreeSnapshot,
  resolveWorkstreamReadTarget,
  resolveWorkstreamReadTargetFromIndex,
} from "../src/internal/server.ts"
import * as serverHelpers from "../src/internal/server.ts"
import type { StreamMetadata, WorkIndex } from "../src/lib/types.ts"

describe("internal server helpers", () => {
  const stream: StreamMetadata = {
    id: "999-server-helper-fixture",
    name: "server-helper-fixture",
    order: 999,
    size: "medium",
    session_estimated: {
      length: 4,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8],
    },
    created_at: "2026-04-15T00:00:00.000Z",
    updated_at: "2026-04-15T00:00:00.000Z",
    path: "work/999-server-helper-fixture",
    generated_by: { workstreams: "0.5.1" },
  }

  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-server-helpers-"))
    await mkdir(join(tempDir, "work", stream.id), { recursive: true })
    await writeFile(
      join(tempDir, "work", "index.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          last_updated: new Date().toISOString(),
          current_stream: stream.id,
          streams: [stream],
        } satisfies WorkIndex,
        null,
        2,
      ),
    )
    await writeFile(
      join(tempDir, "work", stream.id, "tasks.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: stream.id,
          last_updated: new Date().toISOString(),
          runtime_summary: {
            updated_at: "2026-04-15T12:00:00.000Z",
            batches: {
              "01.02": {
                batch_id: "01.02",
                run_id: "run-01",
                status: "running",
                updated_at: "2026-04-15T12:00:00.000Z",
                started_at: "2026-04-15T11:30:00.000Z",
                thread_summary: {
                  total: 1,
                  pending: 0,
                  running: 1,
                  completed: 0,
                  failed: 0,
                },
              },
            },
          },
          tasks: [
            {
              id: "01.02.01.01",
              name: "Export helpers",
              stage_name: "Extract reusable workstream read models",
              batch_name: "Stabilize server-facing helper surface",
              thread_name: "Export server-safe workstream helpers",
              status: "in_progress",
              created_at: "2026-04-15T11:00:00.000Z",
              updated_at: "2026-04-15T12:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    )
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("resolves the current workstream without CLI-specific messaging", () => {
    const resolved = resolveWorkstreamReadTarget(tempDir)
    expect(resolved.currentStreamId).toBe(stream.id)
    expect(resolved.stream.id).toBe(stream.id)

    const fromIndex = resolveWorkstreamReadTargetFromIndex(resolved.index)
    expect(fromIndex.stream.name).toBe(stream.name)
  })

  test("reads structured status, tree, and runtime projections", () => {
    const tasks = [
      {
        id: "01.02.01.01",
        name: "Export helpers",
        stage_name: "Extract reusable workstream read models",
        batch_name: "Stabilize server-facing helper surface",
        thread_name: "Export server-safe workstream helpers",
        status: "in_progress" as const,
        created_at: "2026-04-15T11:00:00.000Z",
        updated_at: "2026-04-15T12:00:00.000Z",
      },
    ]
    const runtimeSummary = {
      updated_at: "2026-04-15T12:00:00.000Z",
      batches: {
        "01.02": {
          batch_id: "01.02",
          run_id: "run-01",
          status: "running" as const,
          updated_at: "2026-04-15T12:00:00.000Z",
          started_at: "2026-04-15T11:30:00.000Z",
          thread_summary: {
            total: 1,
            pending: 0,
            running: 1,
            completed: 0,
            failed: 0,
          },
        },
      },
    }
    const statusSnapshot = serverHelpers.createWorkstreamStatusSnapshot({
      stream,
      tasks,
      runtimeSummary,
      currentStreamId: stream.id,
    })
    const treeSnapshot = serverHelpers.buildWorkstreamTreeSnapshot({
      streamId: stream.id,
      tasks,
      runtimeSummary,
      batchId: "1.2",
    })
    const runtimeProjection = serverHelpers.getRuntimeSummaryProjection(statusSnapshot.stages, runtimeSummary)

    expect(statusSnapshot.stream.is_current).toBe(true)
    expect(statusSnapshot.aggregate_status).toBe("in_progress")
    expect(statusSnapshot.runtime?.entries[0]).toMatchObject({
      kind: "batch",
      batch_id: "01.02",
      runtime_status: "running",
      entry_status: "runtime",
    })

    expect(treeSnapshot.streamId).toBe(stream.id)
    expect(treeSnapshot.stages[0]?.batches[0]?.runtimeOverlay).toMatchObject({
      kind: "runtime",
      runtimeStatus: "running",
    })

    expect(runtimeProjection?.entries[0]).toMatchObject({
      kind: "batch",
      batch_id: "01.02",
      entry_status: "runtime",
    })
  })

  test("rejects invalid batch ids with server-safe errors", () => {
    expect(() => getResolvedWorkstreamTreeSnapshot(tempDir, { batchId: "bad-batch" })).toThrow(
      'Invalid batch ID format: "bad-batch"',
    )
  })

  test("keeps the exported surface focused on read-only helpers", () => {
    expect("setCurrentStream" in serverHelpers).toBe(false)
    expect("clearCurrentStream" in serverHelpers).toBe(false)
    expect("renderWorkstreamTree" in serverHelpers).toBe(false)
    expect("formatProgress" in serverHelpers).toBe(false)
    expect("updateTaskStatus" in serverHelpers).toBe(false)
    expect("getResolvedWorkstreamStatusSnapshot" in serverHelpers).toBe(true)
    expect("getResolvedWorkstreamTreeSnapshot" in serverHelpers).toBe(true)
  })

  test("publishes the helper module as a package export", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: Record<string, { types?: string; import?: string }>
    }

    expect(packageJson.exports?.["./internal/server"]).toEqual({
      types: "./dist/src/internal/server.d.ts",
      import: "./dist/src/internal/server.js",
    })
  })
})
