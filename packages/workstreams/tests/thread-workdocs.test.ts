import { beforeEach, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { main as approveMain } from "../src/cli/approve/index.ts"
import { main as createMain } from "../src/cli/create.ts"
import { main as multiMain } from "../src/cli/multi.ts"
import { main as planMain } from "../src/cli/plan.ts"
import { getPromptContext, generateThreadPrompt } from "../src/lib/prompts.ts"
import { generateRuntimeThreadPrompt } from "../src/lib/multi-orchestrator.ts"
import {
  getThreadWorkMdPath,
  resolveStageDirectoryName,
} from "../src/lib/thread-workdocs.ts"
import { loadWorkstreamPlan } from "../src/lib/consolidate.ts"
import { parseStreamDocument } from "../src/lib/stream-parser.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

async function captureCliOutputAndExit(fn: () => Promise<void> | void): Promise<{
  stdout: string[]
  stderr: string[]
  exitCode: number | undefined
}> {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit
  let exitCode: number | undefined

  console.log = (...args: any[]) => stdout.push(args.map((a) => String(a)).join(" "))
  console.error = (...args: any[]) => stderr.push(args.map((a) => String(a)).join(" "))
  process.exit = ((code?: string | number | null | undefined) => {
    exitCode = typeof code === "number" ? code : code ? Number(code) : 0
    throw new Error("__PROCESS_EXIT__")
  }) as typeof process.exit

  try {
    await fn()
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__PROCESS_EXIT__") {
      throw e
    }
  } finally {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
  }

  return { stdout, stderr, exitCode }
}

function writeDefaultAgentsYaml(repoRoot: string): void {
  writeFileSync(
    join(repoRoot, "work/agents.yaml"),
    `agents:
  - name: default
    description: Default implementation agent
    best_for: general implementation work
    models:
      - openai/gpt-4o
`,
  )
}

async function createApprovedSingleThreadWorkstream(repoRoot: string): Promise<void> {
  createMain(["bun", "work-create", "--name", "runtime-prompts", "--repo-root", repoRoot])
  writeDefaultAgentsYaml(repoRoot)
  planMain(["bun", "work-plan", "create", "--stream", "000-runtime-prompts", "--stages", "1", "--repo-root", repoRoot])

  writeFileSync(
    join(repoRoot, "work/000-runtime-prompts/README.md"),
    `# Runtime Prompts

## Summary

Runtime prompt generation should use thread WORK.md as the canonical contract.
`,
  )

  writeFileSync(
    join(repoRoot, "work/000-runtime-prompts/stages/01/PLAN.md"),
    `# Stage 01 Plan

## Summary

Validate runtime prompt generation.

## References

- \`packages/workstreams/src/lib/multi-orchestrator.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Runtime prompt batch

Generate execution prompts in memory.

#### Thread 01: Runtime prompt thread

**Summary:**
Use generated wrapper prompt content.

**Details:**
Do not use raw WORK.md as the complete prompt.
`,
  )

  await approveMain([
    "bun",
    "work-approve",
    "plan",
    "--stream",
    "000-runtime-prompts",
    "--repo-root",
    repoRoot,
  ])
}

describe("thread WORK.md generation", () => {
  let repoRoot: string

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "agenv-thread-workdocs-"))
    mkdirSync(join(repoRoot, ".git"), { recursive: true })
    process.env.WORKSTREAM_ROLE = "USER"
  })

  afterEach(() => {
    delete process.env.WORKSTREAM_ROLE
    rmSync(repoRoot, { recursive: true, force: true })
  })

  test("plan approval creates missing thread WORK.md files and preserves existing ones", async () => {
    createMain(["bun", "work-create", "--name", "thread-workdocs", "--repo-root", repoRoot])
    planMain(["bun", "work-plan", "create", "--stream", "000-thread-workdocs", "--stages", "1", "--repo-root", repoRoot])

    writeFileSync(
      join(repoRoot, "work/000-thread-workdocs/README.md"),
      `# Thread Workdocs

## Summary

Approval should create per-thread work docs.
`,
    )

    writeFileSync(
      join(repoRoot, "work/000-thread-workdocs/stages/01/PLAN.md"),
      `# Stage 01 Plan

## Summary

Create the first execution stage.

## References

- \`packages/workstreams/src/lib/thread-workdocs.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Prepare execution

Create thread-local work documents.

#### Thread 01: Create thread work doc

**Summary:**
Create the canonical thread work document.

**Details:**
Keep notes concise.

#### Thread 02: Preserve existing work doc

**Summary:**
Do not overwrite an existing thread work document.

**Details:**
Preserve manual edits.
`,
    )

    const existingThreadWorkPath = join(
      repoRoot,
      "work/000-thread-workdocs/stages/01/threads/01.01.02/WORK.md",
    )
    mkdirSync(dirname(existingThreadWorkPath), { recursive: true })
    writeFileSync(existingThreadWorkPath, "manual thread work doc\n")

    const { stdout, stderr } = await captureCliOutput(async () => {
      await approveMain([
        "bun",
        "work-approve",
        "plan",
        "--stream",
        "000-thread-workdocs",
        "--repo-root",
        repoRoot,
      ])
    })

    expect(stderr).toEqual([])
    const output = stdout.join("\n")
    expect(output).toContain("Thread WORK.md: 1 created, 1 preserved")
    expect(output).not.toContain("Prompts:")

    const createdThreadWorkPath = join(
      repoRoot,
      "work/000-thread-workdocs/stages/01/threads/01.01.01/WORK.md",
    )
    const createdContent = readFileSync(createdThreadWorkPath, "utf-8")

    expect(existsSync(createdThreadWorkPath)).toBe(true)
    expect(createdContent).toContain("# Thread 01.01.01 — Create thread work doc")
    expect(createdContent).toContain("## Objective")
    expect(createdContent).toContain("## Do")
    expect(createdContent).toContain("## Done When")
    expect(createdContent).toContain("## Files to Know")
    expect(createdContent).toContain("## Verify")
    expect(createdContent).toContain("## Locked Decisions")
    expect(createdContent).toContain("## Not In Scope")
    expect(createdContent).toContain("## If Blocked")
    expect(createdContent.indexOf("## Objective")).toBeLessThan(createdContent.indexOf("## Do"))
    expect(createdContent.indexOf("## Do")).toBeLessThan(createdContent.indexOf("## Done When"))
    expect(createdContent.indexOf("## Done When")).toBeLessThan(createdContent.indexOf("## Files to Know"))
    expect(createdContent.indexOf("## Files to Know")).toBeLessThan(createdContent.indexOf("## Verify"))
    expect(createdContent.indexOf("## Verify")).toBeLessThan(createdContent.indexOf("## Locked Decisions"))
    expect(createdContent.indexOf("## Locked Decisions")).toBeLessThan(createdContent.indexOf("## Not In Scope"))
    expect(createdContent.indexOf("## Not In Scope")).toBeLessThan(createdContent.indexOf("## If Blocked"))
    expect(createdContent).toContain("### READ")
    expect(createdContent).toContain("### ALLOWED")
    expect(createdContent).toContain("### FORBIDDEN")
    expect(createdContent).toContain("- `./WORK.md` — this thread's execution contract")
    expect(createdContent).toContain("- `../../REQUIREMENTS.md` — stage requirements")
    expect(createdContent).toContain("- `../../../README.md` — overall workstream context")
    expect(createdContent).toContain("Keep this short. Use the groups below with path + reason.")
    expect(createdContent).toContain("Keep this short. List the checks that prove the thread is done.")
    expect(createdContent).toContain("Keep this short. Record decisions this thread must not reopen.")
    expect(createdContent).toContain("Keep this short. State what this thread must avoid changing.")
    expect(createdContent).toContain("Keep this short. State what to capture before stopping.")
    expect(readFileSync(existingThreadWorkPath, "utf-8")).toBe("manual thread work doc\n")
    expect(existsSync(join(repoRoot, "work/000-thread-workdocs/prompts"))).toBe(false)
  })

  test("multi dry-run generates runtime prompts from WORK.md without prompt files", async () => {
    await createApprovedSingleThreadWorkstream(repoRoot)

    const promptsDir = join(repoRoot, "work/000-runtime-prompts/prompts")
    expect(existsSync(promptsDir)).toBe(false)

    const { stdout, stderr } = await captureCliOutput(async () => {
      await multiMain([
        "bun",
        "work-multi",
        "--batch",
        "01.01",
        "--stream",
        "000-runtime-prompts",
        "--repo-root",
        repoRoot,
        "--dry-run",
        "--no-server",
      ])
    })

    expect(stderr).toEqual([])
    const output = stdout.join("\n")
    expect(output).toContain("Prompt: generated in memory from thread context and WORK.md")
    expect(output).toContain("You are an agent working on thread 01.01.01")
    expect(output).toContain("work/000-runtime-prompts/stages/01/threads/01.01.01/WORK.md")
    expect(output).not.toContain("Run 'work prompt")
    expect(existsSync(promptsDir)).toBe(false)
  })

  test("multi dry-run fails with a WORK.md-specific error when thread work doc is missing", async () => {
    await createApprovedSingleThreadWorkstream(repoRoot)
    rmSync(getThreadWorkMdPath(repoRoot, "000-runtime-prompts", "01.01.01"), { force: true })

    const { stderr, exitCode } = await captureCliOutputAndExit(async () => {
      await multiMain([
        "bun",
        "work-multi",
        "--batch",
        "01.01",
        "--stream",
        "000-runtime-prompts",
        "--repo-root",
        repoRoot,
        "--dry-run",
        "--no-server",
      ])
    })

    const errors = stderr.join("\n")
    expect(exitCode).toBe(1)
    expect(errors).toContain("Error: Missing thread WORK.md files:")
    expect(errors).toContain("01.01.01: work/000-runtime-prompts/stages/01/threads/01.01.01/WORK.md")
    expect(errors).toContain("work approve plan")
    expect(errors).toContain("work approve revision")
    expect(errors).toContain("work validate work")
    expect(errors).not.toContain("prompt files")
    expect(errors).not.toContain("work prompt")
  })

  test("runtime prompt is generated with wrapper text instead of raw WORK.md", async () => {
    await createApprovedSingleThreadWorkstream(repoRoot)

    const context = getPromptContext(repoRoot, "000-runtime-prompts", "01.01.01")
    const generatedPrompt = generateRuntimeThreadPrompt(repoRoot, "000-runtime-prompts", "01.01.01")
    const expectedPrompt = generateThreadPrompt(context)
    const rawWorkMd = readFileSync(getThreadWorkMdPath(repoRoot, "000-runtime-prompts", "01.01.01"), "utf-8")

    expect(generatedPrompt).toBe(expectedPrompt)
    expect(generatedPrompt).not.toBe(rawWorkMd)
    expect(generatedPrompt).toContain("You are an agent working on thread 01.01.01")
    expect(generatedPrompt).toContain("Read this document first: `work/000-runtime-prompts/stages/01/threads/01.01.01/WORK.md`.")
  })

  test("skips untouched scaffold stage directories when mapping synthetic stage ids", () => {
    createMain(["bun", "work-create", "--name", "skipped-scaffold-mapping", "--repo-root", repoRoot])
    planMain(["bun", "work-plan", "create", "--stream", "000-skipped-scaffold-mapping", "--stages", "3", "--repo-root", repoRoot])

    writeFileSync(
      join(repoRoot, "work/000-skipped-scaffold-mapping/README.md"),
      `# Skipped Scaffold Mapping

## Summary

Untouched scaffold stages should not shift effective stage-to-directory mapping.
`,
    )

    writeFileSync(
      join(repoRoot, "work/000-skipped-scaffold-mapping/stages/01/PLAN.md"),
      `# Stage 01 Plan

## Summary

Filled first stage.

## References

- \`packages/workstreams/src/lib/thread-workdocs.ts\`

## Questions

- [x] None

## Batches

### Batch 01: First batch

First thread.

#### Thread 01: First thread

**Summary:**
First summary.

**Details:**
First details.
`,
    )

    writeFileSync(
      join(repoRoot, "work/000-skipped-scaffold-mapping/stages/03/PLAN.md"),
      `# Stage 03 Plan

## Summary

Filled third directory but synthetic second stage.

## References

- \`packages/workstreams/src/lib/thread-workdocs.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Third-dir batch

Thread in effective stage two.

#### Thread 01: Third-dir thread

**Summary:**
Map stage two to directory 03.

**Details:**
Do not incorrectly use stage directory 02.
`,
    )

    expect(resolveStageDirectoryName(repoRoot, "000-skipped-scaffold-mapping", 2)).toBe("03")

    approveMain([
      "bun",
      "work-approve",
      "plan",
      "--stream",
      "000-skipped-scaffold-mapping",
      "--repo-root",
      repoRoot,
    ])

    expect(existsSync(getThreadWorkMdPath(repoRoot, "000-skipped-scaffold-mapping", "02.01.01"))).toBe(true)
    expect(
      existsSync(join(repoRoot, "work/000-skipped-scaffold-mapping/stages/02/threads/02.01.01/WORK.md")),
    ).toBe(false)
  })

  test("revision approval creates thread WORK.md inside revision stage directories", async () => {
    createMain(["bun", "work-create", "--name", "revision-thread-workdocs", "--repo-root", repoRoot])
    planMain(["bun", "work-plan", "create", "--stream", "000-revision-thread-workdocs", "--stages", "2", "--repo-root", repoRoot])

    writeFileSync(
      join(repoRoot, "work/000-revision-thread-workdocs/README.md"),
      `# Revision Thread Workdocs

## Summary

Validate revision stage path resolution.
`,
    )

    writeFileSync(
      join(repoRoot, "work/000-revision-thread-workdocs/stages/01/PLAN.md"),
      `# Stage 01 Plan

## Summary

Initial stage.

## References

- \`packages/workstreams/src/lib/thread-workdocs.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Initial batch

Initial thread.

#### Thread 01: Initial thread

**Summary:**
Initial summary.

**Details:**
Initial details.
`,
    )

    approveMain([
      "bun",
      "work-approve",
      "plan",
      "--stream",
      "000-revision-thread-workdocs",
      "--repo-root",
      repoRoot,
    ])

    const revisionStageDir = join(repoRoot, "work/000-revision-thread-workdocs/stages/01-r1")
    mkdirSync(revisionStageDir, { recursive: true })
    writeFileSync(
      join(revisionStageDir, "PLAN.md"),
      `# Stage 01-r1 Plan

## Summary

Revision stage.

## References

- \`packages/workstreams/src/lib/thread-workdocs.ts\`

## Questions

- [x] None

## Batches

### Batch 01: Revision batch

Revision thread.

#### Thread 01: Revision thread

**Summary:**
Revision summary.

**Details:**
Revision details.
`,
    )

    const loadedPlan = loadWorkstreamPlan(repoRoot, "000-revision-thread-workdocs")
    expect(loadedPlan).not.toBeNull()

    const parseErrors: { message: string }[] = []
    const doc = loadedPlan ? parseStreamDocument(loadedPlan.content, parseErrors) : null
    expect(doc).not.toBeNull()
    expect(resolveStageDirectoryName(repoRoot, "000-revision-thread-workdocs", 2)).toBe("01-r1")

    const { stdout, stderr } = await captureCliOutput(() => {
      approveMain([
        "bun",
        "work-approve",
        "revision",
        "--stream",
        "000-revision-thread-workdocs",
        "--repo-root",
        repoRoot,
      ])
    })

    expect(stderr).toEqual([])
    const output = stdout.join("\n")
    expect(output).toContain("Thread WORK.md: 1 created, 1 preserved")
    expect(output).not.toContain("Prompts:")

    expect(existsSync(getThreadWorkMdPath(repoRoot, "000-revision-thread-workdocs", "02.01.01"))).toBe(true)
    expect(existsSync(join(repoRoot, "work/000-revision-thread-workdocs/prompts"))).toBe(false)
  })
})
