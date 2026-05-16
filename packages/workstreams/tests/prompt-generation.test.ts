import { describe, expect, test } from "bun:test"

import {
  generateThreadPrompt,
  generateThreadPromptJson,
  type PromptContext,
} from "../src/lib/prompts.ts"

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
      workPath: "work/007-supervision-smoke/stages/01/WORK.md",
    },
    agentName: "default",
  }
}

describe("prompt generation", () => {
  test("generates a short hierarchical thread prompt", () => {
    const prompt = generateThreadPrompt(createPromptContext())

    expect(prompt).toContain(
      "You are an agent working on thread 01.01.01 (Verify thread execution prep) in stage 01 (Stage 01) in workstream 007-supervision-smoke (Supervision Smoke).",
    )
    expect(prompt).toContain("Use the `implementing-workstreams` skill.")
    expect(prompt).toContain(
      "Read this document `work/007-supervision-smoke/stages/01/WORK.md` before making any changes.",
    )
    expect(prompt).toContain(
      "If you need stage requirements, read `work/007-supervision-smoke/stages/01/REQUIREMENTS.md`.",
    )
    expect(prompt).toContain(
      "If you need overall workstream context, read `work/007-supervision-smoke/README.md`.",
    )
    expect(prompt).toContain("`work/007-supervision-smoke/README.md`")
    expect(prompt).toContain("`work/007-supervision-smoke/stages/01/WORK.md`")
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
      requirementsPath: "work/007-supervision-smoke/stages/01/REQUIREMENTS.md",
      workPath: "work/007-supervision-smoke/stages/01/WORK.md",
    })
  })
})
