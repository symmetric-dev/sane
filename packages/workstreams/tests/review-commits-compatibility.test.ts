import { describe, expect, test } from "bun:test"

import { isApprovalCommitSubject } from "../src/cli/review.ts"

describe("review commit approval subject compatibility", () => {
  test("matches current approval wording", () => {
    expect(isApprovalCommitSubject("Stage 2 approved: Shared Infrastructure")).toBe(true)
    expect(isApprovalCommitSubject("Plan approved: Approval Auto Commit Centralization")).toBe(true)
    expect(isApprovalCommitSubject("Tasks approved: Approval Auto Commit Centralization")).toBe(true)
  })

  test("matches legacy approve wording", () => {
    expect(isApprovalCommitSubject("Approve stage 1: Foundation")).toBe(true)
    expect(isApprovalCommitSubject("approve plan for stream-001")).toBe(true)
  })

  test("does not classify non-approval wording", () => {
    expect(isApprovalCommitSubject("Implement stage 1 parser")).toBe(false)
    expect(isApprovalCommitSubject("Refactor task prompt generation")).toBe(false)
    expect(isApprovalCommitSubject("Add tests for approve command")).toBe(false)
    expect(isApprovalCommitSubject("Update approved reviewer output docs")).toBe(false)
  })
})
