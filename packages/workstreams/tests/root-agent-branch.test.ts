import { describe, expect, test } from "bun:test"
import {
  buildRootAgentBranchSession,
  buildRootAgentLineage,
  findRootAgentBranchSessionByNativeSessionId,
  getRootAgentBranchSource,
  waitForRootAgentBranchTerminalSession,
  waitForRootAgentBranchNativeSessionId,
} from "../src/lib/root-agent-branch.ts"
import { upsertBranchSessionLocked } from "../src/lib/supervisor-state.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers/test-workspace.ts"

describe("root-agent-branch", () => {
  test("getRootAgentBranchSource prefers native ancestry when present", () => {
    expect(getRootAgentBranchSource("ses_branch_1")).toBe("native_fork")
    expect(getRootAgentBranchSource(undefined)).toBe("repo_local_fallback")
    expect(getRootAgentBranchSource(undefined, "native_fork")).toBe("native_fork")
  })

  test("buildRootAgentLineage derives native source from context", () => {
    expect(
      buildRootAgentLineage({
        context: {
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-1",
          checkpointSessionId: "ses_checkpoint_1",
          checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
          parentSessionId: "root-session-1",
          nativeSessionId: "ses_supervision_1",
        },
        branchRole: "supervision",
      }),
    ).toMatchObject({
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      checkpointSessionId: "ses_checkpoint_1",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      parentSessionId: "root-session-1",
      nativeSessionId: "ses_supervision_1",
      source: "native_fork",
    })
  })

  test("waitForRootAgentBranchNativeSessionId resolves once native branch ancestry is persisted", async () => {
    const workspace = createTestWorkstream("001-root-agent-branch")

    try {
      const branchSessionId = "branch-supervision-1"
      const startedAt = new Date().toISOString()

      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId,
            parentSessionId: "root-session-1",
          },
          branchRole: "supervision",
          status: "pending",
          startedAt,
          updatedAt: startedAt,
        }),
      )

      setTimeout(() => {
        void upsertBranchSessionLocked(
          workspace.repoRoot,
          workspace.streamId,
          buildRootAgentBranchSession({
            context: {
              rootSessionId: "root-session-1",
              branchSessionId,
              parentSessionId: "root-session-1",
              nativeSessionId: "ses_supervision_1",
            },
            branchRole: "supervision",
            status: "running",
            startedAt,
            updatedAt: new Date().toISOString(),
          }),
        )
      }, 25)

      await expect(
        waitForRootAgentBranchNativeSessionId({
          repoRoot: workspace.repoRoot,
          streamId: workspace.streamId,
          branchSessionId,
          timeoutMs: 1000,
          pollIntervalMs: 10,
        }),
      ).resolves.toBe("ses_supervision_1")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("findRootAgentBranchSessionByNativeSessionId resolves the persisted branch session", async () => {
    const workspace = createTestWorkstream("001-root-agent-branch-native-lookup")

    try {
      const startedAt = new Date().toISOString()
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_1",
          },
          branchRole: "supervision",
          status: "running",
          startedAt,
          updatedAt: startedAt,
        }),
      )

      expect(
        findRootAgentBranchSessionByNativeSessionId({
          repoRoot: workspace.repoRoot,
          streamId: workspace.streamId,
          nativeSessionId: "ses_supervision_1",
        }),
      ).toMatchObject({
        branchSessionId: "branch-supervision-1",
        nativeSessionId: "ses_supervision_1",
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("waitForRootAgentBranchTerminalSession resolves once the branch reaches a terminal state", async () => {
    const workspace = createTestWorkstream("001-root-agent-branch-terminal")

    try {
      const branchSessionId = "branch-supervision-1"
      const startedAt = new Date().toISOString()

      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId,
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_1",
          },
          branchRole: "supervision",
          status: "running",
          startedAt,
          updatedAt: startedAt,
        }),
      )

      setTimeout(() => {
        void upsertBranchSessionLocked(
          workspace.repoRoot,
          workspace.streamId,
          buildRootAgentBranchSession({
            context: {
              rootSessionId: "root-session-1",
              branchSessionId,
              parentSessionId: "root-session-1",
              nativeSessionId: "ses_supervision_1",
            },
            branchRole: "supervision",
            status: "stopped",
            startedAt,
            updatedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          }),
        )
      }, 25)

      await expect(
        waitForRootAgentBranchTerminalSession({
          repoRoot: workspace.repoRoot,
          streamId: workspace.streamId,
          branchSessionId,
          timeoutMs: 1000,
          pollIntervalMs: 10,
        }),
      ).resolves.toMatchObject({
        branchSessionId,
        status: "stopped",
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
