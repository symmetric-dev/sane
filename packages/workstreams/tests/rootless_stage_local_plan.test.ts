import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as checkMain } from "../src/cli/check.ts"
import { main as validateMain } from "../src/cli/validate.ts"
import { consolidateStream } from "../src/lib/consolidate.ts"
import { loadIndex, saveIndex } from "../src/lib/index.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("rootless stage-local plan model", () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = join(tmpdir(), `workstreams-rootless-${Date.now()}-${Math.random().toString(36).slice(2)}`)

    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    mkdirSync(join(repoRoot, "work", "stream-rootless", "stages", "01"), { recursive: true })
    mkdirSync(join(repoRoot, "work", "stream-rootless", "stages", "02"), { recursive: true })

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
        },
      ],
    }

    saveIndex(repoRoot, index)

    writeFileSync(
      join(repoRoot, "work", "stream-rootless", "README.md"),
      `# Rootless Stage Local Smoke

Stream ID: \`stream-rootless\`

## Summary

Validate that stage-local plans work without a root PLAN.md file.
`,
    )

    writeFileSync(
      join(repoRoot, "work", "stream-rootless", "stages", "01", "PLAN.md"),
      `# Stage 01 Plan

## Summary

Exercise validation and approval from stage-local planning only.

## References

- \`./WORK.md\`

## Questions

- [x] Is a root PLAN needed? → No.

## Batches

### Batch 01: Rootless validation

Check the rootless workflow.

#### Thread 01: Validate stage-local plan flow

**Summary:**
Run validate, check, and approve against the stage-local plan.

**Details:**
- Confirm no root PLAN.md exists.
`,
    )

    writeFileSync(
      join(repoRoot, "work", "stream-rootless", "stages", "02", "PLAN.md"),
      `# Stage 02 Plan

## Summary

<!-- High-level overview of what this stage accomplishes -->

## References

- <!-- Add references here -->

## Questions

- [ ]

## Batches

### Batch 01: <!-- Batch Name -->

#### Thread 01: <!-- Thread Name -->

**Summary:**
<!-- Short description -->
`,
    )
  })

  afterEach(() => {
    if (existsSync(repoRoot)) {
      rmSync(repoRoot, { recursive: true, force: true })
    }
    delete process.env.WORKSTREAM_ROLE
  })

  test("consolidateStream aggregates stage-local plans and ignores empty scaffolds", () => {
    const result = consolidateStream(repoRoot, "stream-rootless", true)

    expect(result.success).toBe(true)
    expect(result.streamDocument?.streamName).toBe("Rootless Stage Local Smoke")
    expect(result.streamDocument?.stages).toHaveLength(1)
    expect(result.streamDocument?.stages[0]?.batches[0]?.threads[0]?.name).toBe(
      "Validate stage-local plan flow",
    )
    expect(result.warnings).toContain(
      `Ignored unfilled stage scaffold at ${join(repoRoot, "work", "stream-rootless", "stages", "02", "PLAN.md")}`,
    )
  })

  test("validate and check work without a root PLAN.md", async () => {
    const validateOutput = await captureCliOutput(() => {
      validateMain(["node", "validate", "plan", "--stream", "stream-rootless", "--repo-root", repoRoot])
    })

    expect(validateOutput.stderr).toHaveLength(0)
    expect(validateOutput.stdout.join("\n")).toContain("✓ PLAN.md validation passed")

    const checkOutput = await captureCliOutput(() => {
      checkMain(["node", "check", "plan", "--stream", "stream-rootless", "--repo-root", repoRoot])
    })

    expect(checkOutput.stdout.join("\n")).toContain("checks passed")
    expect(checkOutput.stdout.join("\n")).not.toContain("Open Questions")
  })

  test("approve plan works from stage-local plans only", async () => {
    process.env.WORKSTREAM_ROLE = "USER"

    const { stdout, stderr } = await captureCliOutput(async () => {
      await approveMain([
        "node",
        "approve",
        "plan",
        "--stream",
        "stream-rootless",
        "--repo-root",
        repoRoot,
      ])
    })

    expect(stderr).toHaveLength(0)
    expect(stdout.join("\n")).toContain("Approved plan for workstream")
    expect(loadIndex(repoRoot).streams[0]?.approval?.status).toBe("approved")
    expect(existsSync(join(repoRoot, "work", "stream-rootless", "tasks.json"))).toBe(true)
    expect(readFileSync(join(repoRoot, "work", "stream-rootless", "tasks.json"), "utf-8")).toContain(
      "Validate stage-local plan flow",
    )
  })
})
