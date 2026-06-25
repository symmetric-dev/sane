import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as previewMain } from "../src/cli/preview.ts"
import { loadWorkstreamPlan } from "../src/lib/consolidate.ts"
import { saveIndex } from "../src/lib/index.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("work preview with canonical stage-local plans", () => {
  let repoRoot: string
  const streamId = "012-dashboard-terminal-first-ui"

  beforeEach(() => {
    repoRoot = join(tmpdir(), `workstreams-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`)

    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(join(repoRoot, "work", streamId, "stages", "01"), { recursive: true })

    const index: WorkIndex = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      current_stream: streamId,
      streams: [
        {
          id: streamId,
          name: "dashboard-terminal-first-ui",
          order: 12,
          size: "short",
          session_estimated: {
            length: 2,
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
    }

    saveIndex(repoRoot, index)

    writeFileSync(
      join(repoRoot, "work", streamId, "README.md"),
      `# Dashboard terminal-first UI

## Summary

Terminal-first dashboard implementation.
`,
    )

    writeFileSync(
      join(repoRoot, "work", streamId, "stages", "01", "PLAN.md"),
      `# Stage 01 Implementation Plan

## Summary

Define the first terminal-driven dashboard slice.

## References

- \`packages/workstreams/src/cli/preview.ts\`

## Questions

- [ ] Confirm the initial viewport layout.
- [x] Keep the first slice terminal-first.

## Batches

### Batch 01: UI scaffolding

Bootstrap the first vertical slice.

#### Thread 01: Preview stage-local plan

**Summary:**
Verify preview can read stage-local planning.

**Details:**
Use the shared loader instead of requiring a root PLAN.md.
`,
    )

    writeFileSync(
      join(repoRoot, "work", streamId, "workstream-state.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          streamId,
          hierarchy: {
            stages: [{ id: "01", number: 1, name: "Discovery" }],
            batches: [{ id: "01.01", stageId: "01", number: 1, name: "UI scaffolding" }],
            threads: [{ id: "01.01.01", stageId: "01", batchId: "01.01", number: 1, name: "Preview stage-local plan" }],
          },
          approvals: [],
          threadRuntime: [
            {
              threadId: "01.01.01",
              status: "completed",
              sessions: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          batchRuns: [],
          supervision: {
            version: "1.0.0",
            stream_id: streamId,
            last_updated: new Date().toISOString(),
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

  test("shared plan loader synthesizes a stream document from stage-local PLAN.md files", () => {
    const loadedPlan = loadWorkstreamPlan(repoRoot, streamId)

    expect(loadedPlan).not.toBeNull()
    expect(loadedPlan?.source).toBe("stages")
    expect(loadedPlan?.stagePlanPaths).toHaveLength(1)
    expect(loadedPlan?.displayPath).toContain(`work/${streamId}/stages`)
    expect(loadedPlan?.content).toContain("# Plan: Dashboard terminal-first UI")
    expect(loadedPlan?.content).toContain("### Stage 1: Implementation")
  })

  test("work preview --stream succeeds for a workstream with only stage-local plans", async () => {
    const { stdout, stderr } = await captureCliOutput(() => {
      previewMain(["node", "preview", "--stream", streamId, "--repo-root", repoRoot])
    })

    const output = stdout.join("\n")
    expect(stderr).toHaveLength(0)
    expect(output).toContain("Workstream: Dashboard terminal-first UI")
    expect(output).toContain("(1/1 threads)")
    expect(output).toContain("1. Implementation")
    expect(output).toContain("Thread 1: Preview stage-local plan [1/1] ✓")
    expect(output).toContain("Questions: 1 open, 1 resolved")
  })
})
