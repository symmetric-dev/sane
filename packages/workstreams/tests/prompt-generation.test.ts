import { describe, expect, test } from "bun:test"

import { generateThreadPrompt, type PromptContext } from "../src/lib/prompts.ts"

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
      readmePath: "work/007-supervision-smoke/README.md",
      requirementsPath: "work/007-supervision-smoke/stages/01/REQUIREMENTS.md",
      planPath: "work/007-supervision-smoke/stages/01/PLAN.md",
      workPath: "work/007-supervision-smoke/stages/01/WORK.md",
    },
    agentName: "default",
  }
}

describe("prompt generation", () => {
  test("generates a simple file-reference-first thread prompt", () => {
    const prompt = generateThreadPrompt(createPromptContext())

    expect(prompt).toContain('You are working on "Supervision Smoke".')
    expect(prompt).toContain("Thread: 01.01.01 — Verify thread execution prep")
    expect(prompt).toContain("Stage: 01 — Stage 01")
    expect(prompt).toContain("Use the `implementing-workstreams` skill.")
    expect(prompt).toContain("`work/007-supervision-smoke/README.md`")
    expect(prompt).toContain("`work/007-supervision-smoke/stages/01/WORK.md`")
    expect(prompt).toContain("Your thread objective:")
    expect(prompt).toContain("Keep execution state current with `work update --thread \"01.01.01\" --status <status>`." )
  })

  test("does not include legacy greeting or task list wording", () => {
    const prompt = generateThreadPrompt(createPromptContext())

    expect(prompt).not.toContain("Hello Agent!")
    expect(prompt).not.toContain("You are working on the \"")
    expect(prompt).not.toContain("Your tasks are:")
    expect(prompt).not.toContain("work list --tasks")
  })
})
