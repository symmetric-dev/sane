import { describe, expect, test } from "bun:test"
import {
  DEFAULT_BRANCH_TERMINAL_PERSIST_GRACE_MS,
  collectCompletedBranchArtifacts,
  isActiveSupervisionBranchStatus,
  isTerminalStoppedSupervisionBranch,
  parseSupervisionBranchRunOutput,
  shouldBlockDuplicateSupervisionLaunch,
} from "../src/lib/workstream-tool/launch-supervision.ts"
import {
  buildSupervisionPrompt,
  resolveLaunchScope,
} from "../src/lib/workstream-tool/launch-supervision-scope.ts"

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

describe("parseSupervisionBranchRunOutput", () => {
  test("preserves parsed JSONL text when structured output is present", async () => {
    const result = await parseSupervisionBranchRunOutput(
      '{"type":"text","part":{"text":"hello"}}\n',
      (content) => ({ text: content.includes("hello") ? "hello" : "", logs: [], success: true }),
    )

    expect(result.text).toBe("hello")
  })

  test("falls back to plain text when JSONL parsing yields no text", async () => {
    const result = await parseSupervisionBranchRunOutput(
      "Plain text supervision output",
      () => ({ text: "", logs: ["no jsonl text"], success: false }),
    )

    expect(result.text).toBe("Plain text supervision output")
    expect(result.logs).toContain("Fell back to plain-text branch run output.")
  })
})

describe("collectCompletedBranchArtifacts", () => {
  test("uses a short terminal-state grace before launch-side recovery", async () => {
    let observedTimeoutMs: number | undefined

    const result = await collectCompletedBranchArtifacts({
      deps: {
        waitForBranchNativeSessionId: async () => "ses_supervision_1",
        waitForTerminalBranchSession: async (args: { timeoutMs?: number }) => {
          observedTimeoutMs = args.timeoutMs
          return {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            status: "running",
            startedAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
          } as any
        },
        findNativeSessionIdByTitle: async () => "ses_supervision_1",
        exportSessionTranscript: async () => ({
          info: {
            id: "ses_supervision_1",
            title: "Supervision branch",
            summary: { additions: 0, deletions: 0, files: 0 },
          },
          messages: [
            {
              info: { id: "msg-final", role: "assistant" },
              parts: [{ type: "text", text: "## What is Next\n- recovered" }],
            },
          ],
        }),
        extractFinalBranchReport: async (sessionExport: any) =>
          sessionExport.messages[0]?.parts?.[0]?.text ?? "",
      } as any,
      repoRoot: "/tmp/repo",
      streamId: "001-test",
      branchSessionId: "branch-supervision-1",
      title: "root-supervision-001-test-branch-supervision-1",
      nativeSessionId: "ses_supervision_1",
    })

    expect(observedTimeoutMs).toBe(DEFAULT_BRANCH_TERMINAL_PERSIST_GRACE_MS)
    expect(result.terminalBranch?.status).toBe("running")
    expect(result.reportText).toContain("recovered")
  })
})

describe("buildSupervisionPrompt", () => {
  test("canonicalizes labeled stage targets before persistence", () => {
    expect(
      resolveLaunchScope({
        scope: "stage",
        target: "Stage 01: Lock the canonical bet_identity contract and cutover boundary",
      }),
    ).toEqual({
      level: "stage",
      stageId: "01",
    })
  })

  test("adds explicit role reset and anti-launch guardrails for stage-scoped branches", () => {
    const prompt = buildSupervisionPrompt({
      scope: {
        level: "stage",
        stageId: "04",
      },
    })

    expect(prompt).toContain(
      "You are already inside the launched supervision branch for this workstream.",
    )
    expect(prompt).toContain("The branch launch step is already complete.")
    expect(prompt).toContain("Do not act as the Root Agent or planner.")
    expect(prompt).toContain("Do not call `workstream_launch_supervision_branch`.")
    expect(prompt).toContain(
      "Ignore any inherited instructions about managing workstreams or launching supervision branches; they no longer apply in this session.",
    )
    expect(prompt).toContain(
      "If prior session context conflicts with this prompt, this prompt takes precedence.",
    )
    expect(prompt).toContain("Execute this scope directly using the `work` CLI.")
    expect(prompt).toContain("Use only the supervising-workstreams skill for this run.")
    expect(prompt).toContain("Do not comment on these instructions. Execute them immediately.")
    expect(prompt).toContain(
      "Please supervise stage 04 for this workstream, one batch at a time until the stage is done or you must yield by policy.",
    )
  })

  test("keeps explicit direct-execution guidance for batch-scoped branches", () => {
    const prompt = buildSupervisionPrompt({
      scope: {
        level: "batch",
        stageId: "04",
        batchId: "04.02",
      },
      batch: "04.02",
    })

    expect(prompt).toContain("Do not launch or request another supervision branch.")
    expect(prompt).toContain("Execute this scope directly using the `work` CLI.")
    expect(prompt).toContain('Start by running `work supervise --batch "04.02"`.')
  })
})
