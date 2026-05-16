import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as createMain } from "../src/cli/create.ts"
import { main as planMain } from "../src/cli/plan.ts"
import { main as validateMain } from "../src/cli/validate.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("CLI: validate work", () => {
  let repoRoot: string
  let originalExit: typeof process.exit

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "agenv-validate-work-"))
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    originalExit = process.exit

    createMain(["bun", "work-create", "--name", "validate-work", "--repo-root", repoRoot])
    planMain(["bun", "work-plan", "create", "--stream", "000-validate-work", "--stages", "1", "--repo-root", repoRoot])

    writeFileSync(
      join(repoRoot, "work/000-validate-work/README.md"),
      `# Validate Work

## Summary

Validate thread WORK docs.
`,
    )

    writeFileSync(
      join(repoRoot, "work/000-validate-work/stages/01/PLAN.md"),
      `# Stage 01 Plan

## Summary

Validate thread-local work docs.

## References

- \`packages/workstreams/src/lib/thread-workdocs.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Validate docs

Check planned thread docs.

#### Thread 01: Valid thread doc

**Summary:**
Fill all required sections.

**Details:**
Keep content concrete.

#### Thread 02: Another valid thread doc

**Summary:**
Needs its own WORK.md.

**Details:**
Do not leave placeholders behind.
`,
    )
  })

  afterEach(() => {
    process.exit = originalExit
    rmSync(repoRoot, { recursive: true, force: true })
  })

  test("passes when each planned thread has a filled WORK.md", async () => {
    const threadRoot = join(repoRoot, "work/000-validate-work/stages/01/threads")
    mkdirSync(join(threadRoot, "01.01.01"), { recursive: true })
    mkdirSync(join(threadRoot, "01.01.02"), { recursive: true })

    const validDoc = (threadId: string, objective: string) => `# Thread ${threadId}

## Objective

${objective}

## Do

- Update the implementation.

## Done When

- The change is complete.

## Files to Know

### READ

- \`./WORK.md\` — this thread's execution contract
- \`../../WORK.md\` — shared stage guidance

### ALLOWED

- \`packages/workstreams/src/lib/thread-workdocs.ts\` — allowed target

### FORBIDDEN

- \`packages/other-package/\` — out of scope

## Verify

- Run the relevant test command.

## Locked Decisions

- Reuse the approved stage naming.

## Not In Scope

- No unrelated refactors.

## If Blocked

- Capture the blocker and stop.
`

    writeFileSync(join(threadRoot, "01.01.01", "WORK.md"), validDoc("01.01.01", "Implement the first thread."))
    writeFileSync(join(threadRoot, "01.01.02", "WORK.md"), validDoc("01.01.02", "Implement the second thread."))

    const { stdout, stderr } = await captureCliOutput(() => {
      validateMain(["bun", "work-validate", "work", "--repo-root", repoRoot, "--stream", "000-validate-work"])
    })

    expect(stderr).toEqual([])
    expect(stdout.join("\n")).toContain("WORK.md validation passed")
  })

  test("fails when a planned thread WORK.md is missing or placeholder-only", async () => {
    process.exit = ((code?: number) => {
      throw new Error(`Process exited with code ${code ?? 0}`)
    }) as typeof process.exit

    const firstThreadDir = join(repoRoot, "work/000-validate-work/stages/01/threads/01.01.01")
    mkdirSync(firstThreadDir, { recursive: true })
    writeFileSync(
      join(firstThreadDir, "WORK.md"),
      `# Thread 01.01.01

## Objective

<!-- Explain the thread goal in 1-3 sentences so the objective is unambiguous. -->

## Do

<!-- Describe the concrete work to perform in this thread. Keep it actionable and specific. -->

## Done When

- <!-- Add a concrete completion condition here. -->

## Files to Know

### READ

- \`./WORK.md\` — this thread's execution contract
- \`../../WORK.md\` — shared stage guidance

### ALLOWED

- <!-- Add the files or directories this thread is allowed to change. -->

### FORBIDDEN

- <!-- Add the files or boundaries this thread must not cross. -->

## Verify

- <!-- Add a short verification step here. -->

## Locked Decisions

- <!-- Add a locked decision here. -->

## Not In Scope

- <!-- Add an explicit out-of-scope boundary here. -->

## If Blocked

- <!-- Add a short blocked-state instruction here. -->
`,
    )

    const { stdout, stderr } = await captureCliOutput(() => {
      try {
        validateMain(["bun", "work-validate", "work", "--repo-root", repoRoot, "--stream", "000-validate-work", "--json"])
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
          throw error
        }
      }
    })

    expect(stderr).toEqual([])
    const parsed = JSON.parse(stdout.join("\n")) as {
      valid: boolean
      errors: string[]
      warnings: string[]
    }

    expect(parsed.valid).toBe(false)
    expect(parsed.errors).toContain(
      "work/000-validate-work/stages/01/threads/01.01.01/WORK.md: [Objective] Objective section must contain real content",
    )
    expect(parsed.errors).toContain(
      "work/000-validate-work/stages/01/threads/01.01.01/WORK.md: [Files to Know] Files to Know section must contain real content",
    )
    expect(parsed.errors).toContain(
      "work/000-validate-work/stages/01/threads/01.01.01/WORK.md: [Locked Decisions] Locked Decisions section must contain real content",
    )
    expect(parsed.errors).toContain(
      "work/000-validate-work/stages/01/threads/01.01.01/WORK.md: [If Blocked] If Blocked section must contain real content",
    )
    expect(parsed.errors).toContain(
      "work/000-validate-work/stages/01/threads/01.01.02/WORK.md: missing WORK.md for planned thread 01.01.02",
    )
    expect(parsed.warnings).toEqual([])
  })
})
