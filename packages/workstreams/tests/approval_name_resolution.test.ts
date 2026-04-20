import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"

import {
  getPlanApprovalCommitNamingStatus,
  getStageApprovalCommitNamingStatus,
  resolvePlanNames,
  resolveStageApprovalNames,
} from "../src/lib/approval.ts"
import type { StreamMetadata } from "../src/lib/types.ts"

const TEST_DIR = join(import.meta.dir, "temp_approval_name_resolution_test")

const stream: StreamMetadata = {
  id: "stream-001",
  name: "fallback-stream-name",
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
  path: "work/stream-001",
  generated_by: { workstreams: "1.0.0" },
}

describe("approval name resolution", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }

    mkdirSync(join(TEST_DIR, "work", "stream-001"), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  test("parses workstream and stage names from PLAN.md", () => {
    writeFileSync(
      join(TEST_DIR, "work", "stream-001", "PLAN.md"),
      `# Plan: Approval Auto Commit Centralization

## Summary
Centralize approval auto-commit flows.

## Stages

### Stage 1: Shared Auto-Commit Infrastructure

#### Stage Definition
Create shared infrastructure.

#### Stage Constitution
Reuse naming helpers across approvals.

#### Stage Questions
- [x] None

#### Stage Batches

##### Batch 01: Message Builders and Name Resolution

###### Thread 01: Plan-Derived Naming Helpers

**Summary:** Resolve real names.

**Details:** Use parsed names in approval integrations.
`
    )

    expect(resolvePlanNames(TEST_DIR, stream)).toEqual({
      streamName: "Approval Auto Commit Centralization",
      stageNames: {
        1: "Shared Auto-Commit Infrastructure",
      },
      streamSource: "plan",
      stageSources: {
        1: "plan",
      },
    })

    expect(resolveStageApprovalNames(TEST_DIR, stream, 1)).toEqual({
      streamName: "Approval Auto Commit Centralization",
      stageName: "Shared Auto-Commit Infrastructure",
      streamSource: "plan",
      stageSource: "plan",
    })
  })

  test("falls back safely when PLAN.md is missing or invalid", () => {
    expect(resolveStageApprovalNames(TEST_DIR, stream, 2)).toEqual({
      streamName: "fallback-stream-name",
      stageName: "Stage 2",
      streamSource: "fallback",
      stageSource: "fallback",
    })

    writeFileSync(join(TEST_DIR, "work", "stream-001", "PLAN.md"), "# Invalid Plan")

    expect(resolveStageApprovalNames(TEST_DIR, stream, 3)).toEqual({
      streamName: "fallback-stream-name",
      stageName: "Stage 3",
      streamSource: "fallback",
      stageSource: "fallback",
    })
  })

  test("flags generic stream approval names as unsafe", () => {
    writeFileSync(
      join(TEST_DIR, "work", "stream-001", "PLAN.md"),
      `# Plan: stream-001

## Summary
Keep approval naming trustworthy.

## Stages

### Stage 1: Real Stage Name
`
    )

    expect(getPlanApprovalCommitNamingStatus(TEST_DIR, stream)).toEqual({
      trustworthy: false,
      reason: "unsafe_generic_stream_name",
    })
    expect(getStageApprovalCommitNamingStatus(TEST_DIR, stream, 1)).toEqual({
      trustworthy: false,
      reason: "unsafe_generic_stream_name",
    })
  })

  test("flags generic stage approval names as unsafe", () => {
    writeFileSync(
      join(TEST_DIR, "work", "stream-001", "PLAN.md"),
      `# Plan: Approval Auto Commit Centralization

## Summary
Keep approval naming trustworthy.

## Stages

### Stage 1: Stage 1
`
    )

    expect(getStageApprovalCommitNamingStatus(TEST_DIR, stream, 1)).toEqual({
      trustworthy: false,
      reason: "unsafe_generic_stage_name",
    })
  })
})
