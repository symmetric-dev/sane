import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as revisionMain } from "../src/cli/revision.ts"
import { saveIndex } from "../src/lib/index.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("rootless staged revisions", () => {
  let repoRoot: string
  let originalCwd: string

  beforeEach(() => {
    repoRoot = join(tmpdir(), `workstreams-rootless-revision-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    originalCwd = process.cwd()

    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(join(repoRoot, "work", "stream-rootless", "stages"), { recursive: true })

    const index: WorkIndex = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      streams: [
        {
          id: "stream-rootless",
          name: "rootless-stream",
          order: 1,
          size: "short",
          session_estimated: {
            length: 2,
            unit: "session",
            session_minutes: [30, 45],
            session_iterations: [4, 8],
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          path: "work/stream-rootless",
          generated_by: { workstreams: "1.0.0" },
          approval: {
            status: "approved",
            tasks: { status: "approved", task_count: 1 },
            stages: {
              1: { status: "approved", approved_at: new Date().toISOString() },
              2: { status: "approved", approved_at: new Date().toISOString() },
            },
          },
        },
      ],
    }

    saveIndex(repoRoot, index)

    writeFileSync(
      join(repoRoot, "work", "stream-rootless", "README.md"),
      `# Rootless Revision Test\n\n## Summary\n\nValidate rootless staged revisions.\n`,
    )
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true })
    }
    delete process.env.WORKSTREAM_ROLE
  })

  function writeStagePlan(stageDirName: string, summary: string): void {
    const stageDir = join(repoRoot, "work", "stream-rootless", "stages", stageDirName)
    mkdirSync(join(stageDir, "specs"), { recursive: true })
    writeFileSync(join(stageDir, "REQUIREMENTS.md"), `# Stage ${stageDirName} Requirements\n\n## Summary\n\n${summary}\n\n## Deliverables\n\n- Deliver something\n\n## Dependencies\n\n- \`packages/workstreams/src/lib/fix.ts\`\n\n## Resources\n\n- \`resources/example.md\`\n`)
    writeFileSync(
      join(stageDir, "PLAN.md"),
      `# Stage ${stageDirName} Plan\n\n## Summary\n\n${summary}\n\n## References\n\n- \`./WORK.md\`\n\n## Questions\n\n- [x] Ready? → Yes.\n\n## Batches\n\n### Batch 01: ${stageDirName} batch\n\n#### Thread 01: ${stageDirName} thread\n\n**Summary:**\n${summary}\n\n**Details:**\n- Do the work.\n`,
    )
    writeFileSync(join(stageDir, "WORK.md"), `# Stage ${stageDirName} Work\n`)
  }

  function writeEmptyStageScaffold(stageDirName: string): void {
    const stageDir = join(repoRoot, "work", "stream-rootless", "stages", stageDirName)
    mkdirSync(join(stageDir, "specs"), { recursive: true })
    writeFileSync(join(stageDir, "REQUIREMENTS.md"), `# Stage ${stageDirName} Requirements\n\n## Summary\n\n<!-- empty -->\n\n## Deliverables\n\n- Replace with a concrete stage deliverable\n\n## Dependencies\n\n- \`packages/workstreams/src/lib/generate.ts\`\n\n## Resources\n\n- \`resources/example-notes.md\`\n`)
    writeFileSync(
      join(stageDir, "PLAN.md"),
      `# Stage ${stageDirName} Plan\n\n## Summary\n\n<!-- High-level overview of what this stage accomplishes -->\n\n## References\n\n- <!-- Add references here -->\n\n## Questions\n\n- [ ]\n\n## Batches\n\n### Batch 01: <!-- Batch Name -->\n\n#### Thread 01: <!-- Thread Name -->\n\n**Summary:**\n<!-- Short description -->\n`,
    )
    writeFileSync(join(stageDir, "WORK.md"), `# Stage ${stageDirName} Work\n`)
  }

  function expectExactStageScaffold(stageDirName: string): void {
    const stageDir = join(repoRoot, "work", "stream-rootless", "stages", stageDirName)
    expect(readdirSync(stageDir).sort()).toEqual([
      "PLAN.md",
      "REQUIREMENTS.md",
      "WORK.md",
      "specs",
    ])
  }

  test("append-at-end revision creates the next normal numeric stage from a stage-local directory", async () => {
    writeStagePlan("01", "Stage 01 summary")
    writeStagePlan("02", "Stage 02 summary")

    process.chdir(join(repoRoot, "work", "stream-rootless", "stages", "01"))

    const { stderr } = await captureCliOutput(() => {
      revisionMain(["node", "revision", "--stream", "stream-rootless", "--name", "append-end"])
    })

    expect(stderr).toHaveLength(0)
    expectExactStageScaffold("03")
  })

  test("inserted revision creates NN-r1 without renaming later normal stages", () => {
    writeStagePlan("01", "Stage 01 summary")
    writeStagePlan("02", "Stage 02 summary")

    revisionMain([
      "node",
      "revision",
      "--stream",
      "stream-rootless",
      "--repo-root",
      repoRoot,
      "--name",
      "inserted-revision",
      "--after-stage",
      "1",
    ])

    expect(existsSync(join(repoRoot, "work", "stream-rootless", "stages", "01-r1"))).toBe(true)
    expect(existsSync(join(repoRoot, "work", "stream-rootless", "stages", "02"))).toBe(true)
    expectExactStageScaffold("01-r1")
  })

  test("second inserted revision after the same stage creates NN-r2", () => {
    writeStagePlan("01", "Stage 01 summary")
    writeStagePlan("02", "Stage 02 summary")

    revisionMain([
      "node",
      "revision",
      "--stream",
      "stream-rootless",
      "--repo-root",
      repoRoot,
      "--name",
      "first-revision",
      "--after-stage",
      "1",
    ])

    revisionMain([
      "node",
      "revision",
      "--stream",
      "stream-rootless",
      "--repo-root",
      repoRoot,
      "--name",
      "second-revision",
      "--after-stage",
      "1",
    ])

    expectExactStageScaffold("01-r2")
    expect(existsSync(join(repoRoot, "work", "stream-rootless", "stages", "01-r1"))).toBe(true)
    expect(existsSync(join(repoRoot, "work", "stream-rootless", "stages", "01-r2"))).toBe(true)
    expect(existsSync(join(repoRoot, "work", "stream-rootless", "stages", "02"))).toBe(true)
  })

  test("approve revision recognizes inserted rootless revision directories", async () => {
    process.env.WORKSTREAM_ROLE = "USER"

    writeStagePlan("01", "Stage 01 summary")
    writeEmptyStageScaffold("02")
    writeFileSync(
      join(repoRoot, "work", "stream-rootless", "tasks.json"),
      JSON.stringify(
        {
          version: "1.0.0",
          stream_id: "stream-rootless",
          last_updated: new Date().toISOString(),
          tasks: [
            {
              id: "01.01.01.01",
              name: "Stage 01 task",
              stage_name: "Stage 01",
              batch_name: "Batch 01",
              thread_name: "Thread 01",
              status: "completed",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        },
        null,
        2,
      ),
    )

    revisionMain([
      "node",
      "revision",
      "--stream",
      "stream-rootless",
      "--repo-root",
      repoRoot,
      "--name",
      "first-revision",
      "--after-stage",
      "1",
    ])

    writeStagePlan("01-r1", "Revision stage summary")

    const { stderr } = await captureCliOutput(async () => {
      await approveMain([
        "node",
        "approve",
        "revision",
        "--stream",
        "stream-rootless",
        "--repo-root",
        repoRoot,
      ])
    })

    expect(stderr).toHaveLength(0)
    expect(readFileSync(join(repoRoot, "work", "stream-rootless", "tasks.json"), "utf-8")).toContain(
      "02.01.01.01",
    )
  })
})
