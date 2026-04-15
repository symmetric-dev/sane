import { describe, expect, test } from "bun:test"

import {
  buildPlanApprovalCommitMessage,
  buildStageApprovalCommitMessage,
  buildTasksApprovalCommitMessage,
  buildWorkstreamCompletionCommitMessage,
  buildWorkstreamStartCommitMessage,
} from "../src/lib/git/auto-commit-message.ts"

describe("auto commit message builders", () => {
  test("builds workstream start messages with stream trailers", () => {
    const message = buildWorkstreamStartCommitMessage({
      streamId: "001-test-stream",
      streamName: "Test Stream",
    })

    expect(message.title).toBe("workstream start")
    expect(message.body).toContain("Started workstream 001-test-stream.")
    expect(message.body).toContain("Stream-Id: 001-test-stream")
    expect(message.body).toContain("Stream-Name: Test Stream")
  })

  test("builds plan and tasks approval messages", () => {
    const plan = buildPlanApprovalCommitMessage({
      streamId: "001-test-stream",
      streamName: "Test Stream",
    })
    const tasks = buildTasksApprovalCommitMessage({
      streamId: "001-test-stream",
      streamName: "Test Stream",
      taskCount: 7,
    })

    expect(plan.title).toBe("Plan approved: Test Stream")
    expect(plan.body).toContain("Approved plan for workstream 001-test-stream.")
    expect(plan.body).toContain("Stream-Id: 001-test-stream")

    expect(tasks.title).toBe("Tasks approved: Test Stream")
    expect(tasks.body).toContain("Approved 7 tasks for workstream 001-test-stream.")
    expect(tasks.body).toContain("Stream-Name: Test Stream")
    expect(tasks.body).toContain("Task-Count: 7")
  })

  test("builds stage approval messages with stage trailers", () => {
    const message = buildStageApprovalCommitMessage({
      streamId: "001-test-stream",
      streamName: "Test Stream",
      stageNumber: 2,
      stageName: "Shared Infrastructure",
    })

    expect(message.title).toBe("Stage 2 approved: Shared Infrastructure")
    expect(message.body).toContain("Approved stage 2 of workstream 001-test-stream.")
    expect(message.body).toContain("Stage: 2")
    expect(message.body).toContain("Stage-Name: Shared Infrastructure")
  })

  test("builds completion messages with summary and stream trailers", () => {
    const message = buildWorkstreamCompletionCommitMessage({
      streamId: "001-test-stream",
      streamName: "Test Stream",
      summary: "Centralized auto-commit formatting.",
    })

    expect(message.title).toBe("Completed workstream: Test Stream")
    expect(message.body).toContain("Completed workstream 001-test-stream.")
    expect(message.body).toContain("Centralized auto-commit formatting.")
    expect(message.body).toContain("Stream-Id: 001-test-stream")
    expect(message.body).toContain("Stream-Name: Test Stream")
  })
})
