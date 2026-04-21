import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "fs"
import { join } from "path"

import { main as currentMain } from "../src/cli/current.ts"
import { main as statusMain } from "../src/cli/status.ts"
import { syncStructuredStorageWorkspaceStateToSqlite } from "../src/lib/sqlite-storage.ts"
import { createStructuredStorageWorkstreamRecord } from "../src/lib/structured-storage.ts"
import type { StreamMetadata } from "../src/lib/types.ts"
import { cleanupTestWorkstream, createTestWorkstream, type TestWorkspace } from "./helpers"

function buildStream(streamId: string): StreamMetadata {
  return {
    id: streamId,
    name: streamId.replace(/^\d+-/, ""),
    order: 1,
    size: "medium",
    session_estimated: {
      length: 2,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8],
    },
    created_at: "2026-04-20T00:00:00.000Z",
    updated_at: "2026-04-20T00:00:00.000Z",
    path: `work/${streamId}`,
    generated_by: { workstreams: "0.0.0-test" },
  }
}

describe("current/status sqlite-backed read model", () => {
  let workspace: TestWorkspace
  let originalLog: typeof console.log
  let originalError: typeof console.error
  let originalExit: typeof process.exit
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    workspace = createTestWorkstream(`001-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    logs = []
    errors = []
    originalLog = console.log
    originalError = console.error
    originalExit = process.exit
    console.log = (...args) => {
      logs.push(args.join(" "))
    }
    console.error = (...args) => {
      errors.push(args.join(" "))
    }
    process.exit = ((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`)
    }) as typeof process.exit
})

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
    cleanupTestWorkstream(workspace)
  })

  test("work current reads the current stream from sqlite without index.json", () => {
    const stream = buildStream(workspace.streamId)
    syncStructuredStorageWorkspaceStateToSqlite(workspace.repoRoot, {
      currentStreamId: stream.id,
      workstreams: [createStructuredStorageWorkstreamRecord(stream)],
    })

    currentMain(["bun", "work", "current", "--repo-root", workspace.repoRoot])

    expect(errors).toEqual([])
    expect(logs).toEqual([
      `Current workstream: ${stream.id}`,
      `   Name: ${stream.name}`,
      `   Path: ${stream.path}`,
    ])
  })

  test("work status resolves workstream identity from sqlite without index.json", () => {
    const stream = buildStream(workspace.streamId)
    writeFileSync(
      join(workspace.workDir, "tasks.json"),
      JSON.stringify({
        version: "1.0.0",
        stream_id: stream.id,
        last_updated: "2026-04-20T00:00:00.000Z",
        tasks: [
          {
            id: "01.01.01.01",
            name: "Switch canonical reads",
            stage_name: "Move canonical read paths onto sqlite-backed storage/query interfaces",
            batch_name: "Cut over workspace and hierarchy reads",
            thread_name: "Current stream and workstream identity reads",
            status: "in_progress",
            created_at: "2026-04-20T00:00:00.000Z",
            updated_at: "2026-04-20T00:00:00.000Z",
          },
        ],
      }, null, 2),
    )
    syncStructuredStorageWorkspaceStateToSqlite(workspace.repoRoot, {
      currentStreamId: stream.id,
      workstreams: [createStructuredStorageWorkstreamRecord(stream)],
    })

    statusMain(["bun", "work", "status", "--repo-root", workspace.repoRoot, "--json"])

    expect(errors).toEqual([])
    expect(JSON.parse(logs.join("\n"))).toMatchObject([
      {
        stream: {
          id: stream.id,
          name: stream.name,
          is_current: true,
        },
        status: "in_progress",
      },
    ])
  })
})
