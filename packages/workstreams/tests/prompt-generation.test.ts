import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  generateThreadPrompt,
  generateThreadPromptJson,
  getPromptContext,
  type PromptContext,
} from "../src/lib/prompts.ts"
import { main as createMain } from "../src/cli/create.ts"
import { main as planMain } from "../src/cli/plan.ts"
import { main as promptMain } from "../src/cli/prompt.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

function createPromptContext(): PromptContext {
  return {
    threadId: { stage: 1, batch: 1, thread: 1 },
    threadIdString: "01.01.01",
    streamId: "007-supervision-smoke",
    streamName: "Supervision Smoke",
    thread: {
      id: 1,
      name: "Verify thread execution prep",
      summary: "Confirm the plan describes a thread that will later exercise assignment, prompt generation, and status transitions.",
      details: "- Keep output limited to workstream-local notes or status updates.",
    },
    stage: {
      id: 1,
      name: "Stage 01",
      definition: "",
      constitution: "",
      questions: [],
      batches: [],
    },
    batch: {
      id: 1,
      prefix: "01",
      name: "Prepare supervision execution inputs",
      summary: "",
      threads: [],
    },
    executionItems: [
      {
        id: "01.01.01.01",
        stageId: "01",
        batchId: "01.01",
        threadId: "01.01.01",
        number: 1,
        name: "Execution item",
        status: "pending",
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
        stageName: "Stage 01",
        batchName: "Prepare supervision execution inputs",
        threadName: "Verify thread execution prep",
      },
    ],
    parallelThreads: [],
    references: {
      primaryWorkPath: "work/007-supervision-smoke/stages/01/threads/01.01.01/WORK.md",
      readmePath: "work/007-supervision-smoke/README.md",
      stageRequirementsPath: "work/007-supervision-smoke/stages/01/REQUIREMENTS.md",
      threadWorkPath: "work/007-supervision-smoke/stages/01/threads/01.01.01/WORK.md",
    },
    agentName: "default",
  }
}

describe("prompt generation", () => {
  test("generates a short hierarchical thread prompt", () => {
    const prompt = generateThreadPrompt(createPromptContext())

    expect(prompt).toContain(
      "You are an agent working on thread 01.01.01 (Verify thread execution prep) in stage Stage 01 in workstream 007-supervision-smoke (Supervision Smoke).",
    )
    expect(prompt).toContain("Use the `implementing-workstreams` skill.")
    expect(prompt).toContain(
      "Read this document first: `work/007-supervision-smoke/stages/01/threads/01.01.01/WORK.md`.",
    )
    expect(prompt).toContain(
      "Then read stage requirements at `work/007-supervision-smoke/stages/01/REQUIREMENTS.md` for the required constraints and acceptance criteria.",
    )
    expect(prompt).toContain(
      "If you need overall workstream context, read `work/007-supervision-smoke/README.md`.",
    )
    expect(prompt).toContain("`work/007-supervision-smoke/README.md`")
    expect(prompt).toContain("`work/007-supervision-smoke/stages/01/threads/01.01.01/WORK.md`")
    expect(prompt).toContain("Thread objective:")
    expect(prompt).toContain(
      "Keep execution state current with `work update --thread \"01.01.01\" --status <status>`.",
    )
  })

  test("does not tell agents to read PLAN.md or use legacy wording", () => {
    const prompt = generateThreadPrompt(createPromptContext())

    expect(prompt).not.toContain("Hello Agent!")
    expect(prompt).not.toContain("You are working on the \"")
    expect(prompt).not.toContain("Your tasks are:")
    expect(prompt).not.toContain("work list --tasks")
    expect(prompt).not.toContain("PLAN.md")
  })

  test("does not expose PLAN.md in prompt json references", () => {
    const promptJson = generateThreadPromptJson(createPromptContext()) as {
      references: Record<string, string>
    }

    expect(promptJson.references).toEqual({
      readmePath: "work/007-supervision-smoke/README.md",
      primaryWorkPath: "work/007-supervision-smoke/stages/01/threads/01.01.01/WORK.md",
      stageRequirementsPath: "work/007-supervision-smoke/stages/01/REQUIREMENTS.md",
      threadWorkPath: "work/007-supervision-smoke/stages/01/threads/01.01.01/WORK.md",
    })
  })

  describe("work doc paths", () => {
    let repoRoot: string

    beforeEach(() => {
      repoRoot = mkdtempSync(join(tmpdir(), "agenv-prompt-fallback-"))
      mkdirSync(join(repoRoot, ".git"), { recursive: true })
    })

    afterEach(() => {
      rmSync(repoRoot, { recursive: true, force: true })
    })

    test("fails when the thread WORK.md does not exist yet", () => {
      createMain(["bun", "work-create", "--name", "prompt-fallback", "--repo-root", repoRoot])
      planMain(["bun", "work-plan", "create", "--stream", "000-prompt-fallback", "--stages", "1", "--repo-root", repoRoot])

      writeFileSync(
        join(repoRoot, "work/000-prompt-fallback/README.md"),
        `# Prompt Fallback

## Summary

Prompt generation should not reference missing thread work docs.
`,
      )

      writeFileSync(
        join(repoRoot, "work/000-prompt-fallback/stages/01/PLAN.md"),
        `# Stage 01 Plan

## Summary

Prompt fallback coverage.

## References

- \`packages/workstreams/src/lib/prompts.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Prompt batch

Prompt thread.

#### Thread 01: Prompt thread

**Summary:**
Use a valid work doc path.

**Details:**
Prefer thread work docs when present.
`,
      )

      expect(() => getPromptContext(repoRoot, "000-prompt-fallback", "01.01.01")).toThrow(
        "Thread WORK.md not found for 01.01.01 at work/000-prompt-fallback/stages/01/threads/01.01.01/WORK.md. Run 'work approve plan' or 'work approve revision' to generate thread WORK.md files before running 'work prompt'.",
      )
    })

    test("uses thread WORK.md as the primary prompt document when it exists", () => {
      createMain(["bun", "work-create", "--name", "prompt-thread-primary", "--repo-root", repoRoot])
      planMain(["bun", "work-plan", "create", "--stream", "000-prompt-thread-primary", "--stages", "1", "--repo-root", repoRoot])

      writeFileSync(join(repoRoot, "work/000-prompt-thread-primary/README.md"), "# Prompt Thread Primary\n\n## Summary\n\nPrompt primary path coverage.\n")
      writeFileSync(
        join(repoRoot, "work/000-prompt-thread-primary/stages/01/PLAN.md"),
        `# Stage 01 Plan

## Summary

Prompt primary path coverage.

## References

- \`packages/workstreams/src/lib/prompts.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Prompt batch

Prompt thread.

#### Thread 01: Prompt thread

**Summary:**
Use thread work docs when present.

**Details:**
Prefer the thread-local document.
`,
      )
      const threadWorkPath = join(
        repoRoot,
        "work/000-prompt-thread-primary/stages/01/threads/01.01.01/WORK.md",
      )
      mkdirSync(join(repoRoot, "work/000-prompt-thread-primary/stages/01/threads/01.01.01"), { recursive: true })
      writeFileSync(threadWorkPath, "# Thread 01.01.01\n")

      const context = getPromptContext(repoRoot, "000-prompt-thread-primary", "01.01.01")
      const prompt = generateThreadPrompt(context)

      expect(context.references.primaryWorkPath).toBe("work/000-prompt-thread-primary/stages/01/threads/01.01.01/WORK.md")
      expect(prompt).toContain(
        "Read this document first: `work/000-prompt-thread-primary/stages/01/threads/01.01.01/WORK.md`.",
      )
    })

    test("full-stream prompt generation uses stage-local PLAN.md when no root PLAN.md exists", async () => {
      createMain(["bun", "work-create", "--name", "prompt-cli-stage-local", "--repo-root", repoRoot])
      planMain(["bun", "work-plan", "create", "--stream", "000-prompt-cli-stage-local", "--stages", "1", "--repo-root", repoRoot])

      writeFileSync(join(repoRoot, "work/000-prompt-cli-stage-local/README.md"), "# Prompt CLI Stage Local\n\n## Summary\n\nPrompt CLI should load stage-local plans.\n")
      writeFileSync(
        join(repoRoot, "work/000-prompt-cli-stage-local/stages/01/PLAN.md"),
        `# Stage 01 Plan

## Summary

Prompt CLI should load stage-local plans.

## References

- \`packages/workstreams/src/cli/prompt.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Prompt batch

Prompt batch summary.

#### Thread 01: First thread

**Summary:**
Generate prompt JSON for the first thread.

**Details:**
Use the stage-local plan.

#### Thread 02: Second thread

**Summary:**
Generate prompt JSON for the second thread.

**Details:**
Use the stage-local plan.
`,
      )
      mkdirSync(join(repoRoot, "work/000-prompt-cli-stage-local/stages/01/threads/01.01.01"), { recursive: true })
      mkdirSync(join(repoRoot, "work/000-prompt-cli-stage-local/stages/01/threads/01.01.02"), { recursive: true })
      writeFileSync(join(repoRoot, "work/000-prompt-cli-stage-local/stages/01/threads/01.01.01/WORK.md"), "# Thread 01.01.01\n")
      writeFileSync(join(repoRoot, "work/000-prompt-cli-stage-local/stages/01/threads/01.01.02/WORK.md"), "# Thread 01.01.02\n")

      const { stdout, stderr } = await captureCliOutput(() =>
        promptMain([
          "bun",
          "work-prompt",
          "--repo-root",
          repoRoot,
          "--stream",
          "000-prompt-cli-stage-local",
          "--json",
        ]),
      )

      expect(stderr).toEqual([])
      expect(JSON.parse(stdout.join("\n"))).toHaveLength(2)
    })

    test("stage and batch filtered prompt generation uses stage-local PLAN.md", async () => {
      createMain(["bun", "work-create", "--name", "prompt-cli-filtered", "--repo-root", repoRoot])
      planMain(["bun", "work-plan", "create", "--stream", "000-prompt-cli-filtered", "--stages", "2", "--repo-root", repoRoot])

      writeFileSync(join(repoRoot, "work/000-prompt-cli-filtered/README.md"), "# Prompt CLI Filtered\n\n## Summary\n\nPrompt CLI filtering should use stage-local plans.\n")
      writeFileSync(
        join(repoRoot, "work/000-prompt-cli-filtered/stages/01/PLAN.md"),
        `# Stage 01 Plan

## Summary

Stage 01 summary.

## References

- \`packages/workstreams/src/cli/prompt.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Stage one batch

Stage 01 batch summary.

#### Thread 01: Stage one thread

**Summary:**
Include this thread only when Stage 01 is targeted.

**Details:**
Stage filter coverage.
`,
      )
      writeFileSync(
        join(repoRoot, "work/000-prompt-cli-filtered/stages/02/PLAN.md"),
        `# Stage 02 Plan

## Summary

Stage 02 summary.

## References

- \`packages/workstreams/src/cli/prompt.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Stage two batch

Stage 02 batch summary.

#### Thread 01: Stage two first thread

**Summary:**
This thread should be excluded by the stage filter.

**Details:**
Stage filter coverage.

### Batch 02: Target batch

Stage 02 target batch summary.

#### Thread 01: Target thread

**Summary:**
Return only this thread for stage/batch filtering.

**Details:**
Batch filter coverage.
`,
      )
      mkdirSync(join(repoRoot, "work/000-prompt-cli-filtered/stages/01/threads/01.01.01"), { recursive: true })
      mkdirSync(join(repoRoot, "work/000-prompt-cli-filtered/stages/02/threads/02.01.01"), { recursive: true })
      mkdirSync(join(repoRoot, "work/000-prompt-cli-filtered/stages/02/threads/02.02.01"), { recursive: true })
      writeFileSync(join(repoRoot, "work/000-prompt-cli-filtered/stages/01/threads/01.01.01/WORK.md"), "# Thread 01.01.01\n")
      writeFileSync(join(repoRoot, "work/000-prompt-cli-filtered/stages/02/threads/02.01.01/WORK.md"), "# Thread 02.01.01\n")
      writeFileSync(join(repoRoot, "work/000-prompt-cli-filtered/stages/02/threads/02.02.01/WORK.md"), "# Thread 02.02.01\n")

      const { stdout, stderr } = await captureCliOutput(() =>
        promptMain([
          "bun",
          "work-prompt",
          "--repo-root",
          repoRoot,
          "--stream",
          "000-prompt-cli-filtered",
          "--stage",
          "2",
          "--batch",
          "2",
          "--json",
        ]),
      )

      const prompts = JSON.parse(stdout.join("\n")) as Array<{ threadId: string }>

      expect(stderr).toEqual([])
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({ threadId: "02.02.01" })
    })

    test("cli prompt fails with actionable error when a thread WORK.md is missing", async () => {
      const originalExit = process.exit
      process.exit = ((code?: number) => {
        throw new Error(`Process exited with code ${code ?? 0}`)
      }) as typeof process.exit

      try {
        createMain(["bun", "work-create", "--name", "prompt-missing-thread-work", "--repo-root", repoRoot])
        planMain(["bun", "work-plan", "create", "--stream", "000-prompt-missing-thread-work", "--stages", "1", "--repo-root", repoRoot])
        writeFileSync(join(repoRoot, "work/000-prompt-missing-thread-work/README.md"), "# Prompt Missing Thread Work\n\n## Summary\n\nMissing thread work doc should fail prompt generation.\n")
        writeFileSync(
          join(repoRoot, "work/000-prompt-missing-thread-work/stages/01/PLAN.md"),
          `# Stage 01 Plan

## Summary

Prompt should fail clearly.

## References

- \`packages/workstreams/src/lib/prompts.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Prompt batch

Prompt batch summary.

#### Thread 01: First thread

**Summary:**
Fail when thread work is missing.

**Details:**
Require approval-generated thread work docs first.
`,
        )

        const { stdout, stderr } = await captureCliOutput(async () => {
          try {
            await promptMain([
              "bun",
              "work-prompt",
              "--repo-root",
              repoRoot,
              "--stream",
              "000-prompt-missing-thread-work",
              "--thread",
              "01.01.01",
            ])
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
              throw error
            }
          }
        })

        expect(stdout).toEqual([])
        expect(stderr.join("\n")).toContain("Thread WORK.md not found for 01.01.01")
        expect(stderr.join("\n")).toContain("Run 'work approve plan' or 'work approve revision'")
      } finally {
        process.exit = originalExit
      }
    })
  })
})
