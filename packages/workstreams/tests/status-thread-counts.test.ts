import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as statusMain } from "../src/cli/status.ts"
import { saveIndex } from "../src/lib/index.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("work status with thread-level execution records", () => {
  let repoRoot: string
  const streamId = "001-thread-status"

  beforeEach(() => {
    repoRoot = join(tmpdir(), `workstreams-status-${Date.now()}-${Math.random().toString(36).slice(2)}`)

    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(join(repoRoot, "work", streamId), { recursive: true })

    const now = new Date().toISOString()
    const index: WorkIndex = {
      version: "1.0.0",
      last_updated: now,
      current_stream: streamId,
      streams: [
        {
          id: streamId,
          name: "thread-status",
          order: 1,
          size: "short",
          session_estimated: {
            length: 1,
            unit: "session",
            session_minutes: [30, 45],
            session_iterations: [4, 8],
          },
          created_at: now,
          updated_at: now,
          path: `work/${streamId}`,
          generated_by: { workstreams: "test" },
        },
      ],
    }

    saveIndex(repoRoot, index)

    writeFileSync(
      join(repoRoot, "work", streamId, "workstream-state.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          streamId,
          hierarchy: {
            stages: [
              { id: "01", number: 1, name: "Foundation" },
              { id: "02", number: 2, name: "Follow-up" },
            ],
            batches: [
              { id: "01.01", stageId: "01", number: 1, name: "Build" },
              { id: "02.01", stageId: "02", number: 1, name: "Verify" },
            ],
            threads: [
              { id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Completed thread" },
              { id: "01.01.02", stageId: "01", batchId: "01.01", number: 2, name: "Pending thread" },
              { id: "02.01.01", stageId: "02", batchId: "02.01", number: 1, name: "Active thread" },
            ],
          },
          approvals: [],
          threadRuntime: [
            { threadId: "01.01.01", status: "completed", sessions: [], createdAt: now, updatedAt: now },
            { threadId: "01.01.02", status: "pending", sessions: [], createdAt: now, updatedAt: now },
            { threadId: "02.01.01", status: "in_progress", sessions: [], createdAt: now, updatedAt: now },
          ],
          batchRuns: [],
          supervision: {
            version: "1.0.0",
            stream_id: streamId,
            last_updated: now,
            runs: [],
            checkpoint_pointers: [],
            branch_sessions: [],
            reviewed_batches: [],
            issue_summaries: [],
            fix_cycles: [],
            escalations: [],
            stage_stops: [],
          },
        },
        null,
        2,
      ),
    )
  })

  afterEach(() => {
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true })
    }
  })

  test("shows per-stage thread counts for three-part thread IDs", async () => {
    const { stdout, stderr } = await captureCliOutput(() => {
      statusMain(["node", "status", "--stream", streamId, "--repo-root", repoRoot])
    })

    const output = stdout.join("\n")
    expect(stderr).toHaveLength(0)
    expect(output).toContain("Threads: 1/3 complete, 1 in-progress, 0 blocked")
    expect(output).toContain("Stage 01: Foundation (1/2)")
    expect(output).toContain("Stage 02: Follow-up (0/1)")
  })
})
