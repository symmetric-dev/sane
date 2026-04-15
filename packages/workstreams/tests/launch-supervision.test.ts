import { describe, expect, test } from "bun:test"
import {
  isActiveSupervisionBranchStatus,
  isTerminalStoppedSupervisionBranch,
  shouldBlockDuplicateSupervisionLaunch,
} from "../src/lib/workstream-tool/launch-supervision.ts"

describe("launch supervision duplicate guard", () => {
  test("treats only pending and running statuses as live blockers by status alone", () => {
    expect(isActiveSupervisionBranchStatus("pending")).toBe(true)
    expect(isActiveSupervisionBranchStatus("running")).toBe(true)
    expect(isActiveSupervisionBranchStatus("stopped")).toBe(false)
    expect(isActiveSupervisionBranchStatus("completed")).toBe(false)
  })

  test("does not block relaunch for terminal stopped branches with reconciliation evidence", () => {
    const branch = {
      status: "stopped",
      completedAt: "2026-04-12T01:00:00.000Z",
      processEndedAt: "2026-04-12T01:00:00.000Z",
      finalizationSource: "parent_process_exit_reconciliation",
      finalizationReason: "session_missing_with_recovered_report",
    }

    expect(isTerminalStoppedSupervisionBranch(branch)).toBe(true)
    expect(shouldBlockDuplicateSupervisionLaunch(branch)).toBe(false)
  })

  test("keeps blocking legacy stopped branches without terminal metadata", () => {
    const branch = {
      status: "stopped",
    }

    expect(isTerminalStoppedSupervisionBranch(branch)).toBe(false)
    expect(shouldBlockDuplicateSupervisionLaunch(branch)).toBe(true)
  })
})
