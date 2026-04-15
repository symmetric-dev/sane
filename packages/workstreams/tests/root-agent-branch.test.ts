import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import {
  buildRootAgentBranchSession,
  buildRootAgentLineage,
  findRootAgentBranchSessionForLaunchSessionId,
  findRootAgentBranchSessionByNativeSessionId,
  getCurrentRootAgentNativeSessionId,
  getRootAgentBranchSource,
  normalizeRootAgentBranchScope,
  normalizeRootAgentSupervisionProgress,
  resolveCurrentBranchSupervisionContext,
  waitForRootAgentBranchTerminalSession,
  waitForRootAgentBranchNativeSessionId,
} from "../src/lib/root-agent-branch.ts"
import { saveSupervisorState, upsertBranchSessionLocked } from "../src/lib/supervisor-state.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "./helpers/test-workspace.ts"

function writeIndex(repoRoot: string, streamId: string, name: string): void {
  mkdirSync(join(repoRoot, "work"), { recursive: true })
  writeFileSync(
    join(repoRoot, "work", "index.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        current_stream: streamId,
        streams: [
          {
            id: streamId,
            name,
            order: 1,
            size: "short",
            session_estimated: {
              length: 1,
              unit: "session",
              session_minutes: [30, 45],
              session_iterations: [4, 8],
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            path: `work/${streamId}`,
            generated_by: { workstreams: "test" },
          },
        ],
      },
      null,
      2,
    ),
  )
}

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
          checkpointMessageId: "msg_checkpoint_1",
          checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
          breakpointSelection: {
            strategy: "explicit_tag",
            configuredTags: ["SESSION_BREAKPOINT"],
            matchedTag: "SESSION_BREAKPOINT",
            launchMessageId: "msg-launch",
            launchMessageIndex: 2,
            rationale:
              'Selected the tagged user message because it matched configured breakpoint tag "SESSION_BREAKPOINT" before launch message msg-launch.',
          },
          parentSessionId: "root-session-1",
          nativeSessionId: "ses_supervision_1",
        },
        branchRole: "supervision",
      }),
    ).toMatchObject({
      rootSessionId: "root-session-1",
      branchSessionId: "branch-supervision-1",
      checkpointMessageId: "msg_checkpoint_1",
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
      breakpointSelection: {
        strategy: "explicit_tag",
        configuredTags: ["SESSION_BREAKPOINT"],
        matchedTag: "SESSION_BREAKPOINT",
        launchMessageId: "msg-launch",
        launchMessageIndex: 2,
        rationale:
          'Selected the tagged user message because it matched configured breakpoint tag "SESSION_BREAKPOINT" before launch message msg-launch.',
      },
      parentSessionId: "root-session-1",
      nativeSessionId: "ses_supervision_1",
      source: "native_fork",
    })
  })

  test("buildRootAgentLineage preserves checkpointMessageIndex fallback metadata", () => {
    expect(
      buildRootAgentLineage({
        context: {
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-1",
          checkpointMessageIndex: 42,
          checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
          parentSessionId: "root-session-1",
        },
        branchRole: "supervision",
      }),
    ).toMatchObject({
      checkpointMessageIndex: 42,
      checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
    })
  })

  test("normalizeRootAgentBranchScope infers legacy batch scope from batchId", () => {
    expect(
      normalizeRootAgentBranchScope({
        batchId: "15.01",
      }),
    ).toEqual({
      level: "batch",
      stageId: "15",
      batchId: "15.01",
    })
  })

  test("buildRootAgentBranchSession persists explicit stage scope metadata", () => {
    const session = buildRootAgentBranchSession({
      context: {
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        parentSessionId: "root-session-1",
        scope: {
          level: "stage",
          stageId: "15",
        },
      },
      branchRole: "supervision",
      status: "running",
      tmuxSessionName: "015-supervision-abc123",
      batchId: "15.01",
      startedAt: "2026-04-13T00:00:00.000Z",
      updatedAt: "2026-04-13T00:00:00.000Z",
    })

    expect(session.scope).toEqual({
      level: "stage",
      stageId: "15",
    })
    expect(session.batchId).toBeUndefined()
    expect(session.tmuxSessionName).toBe("015-supervision-abc123")
    expect(session.supervisionProgress).toEqual({
      executionMode: "stage_batch_loop",
      currentBatchId: "15.01",
    })
  })

  test("normalizeRootAgentSupervisionProgress separates stage scope from batch progress", () => {
    expect(
      normalizeRootAgentSupervisionProgress({
        branchRole: "supervision",
        scope: {
          level: "stage",
          stageId: "15",
        },
        batchId: "15.02",
      }),
    ).toEqual({
      executionMode: "stage_batch_loop",
      currentBatchId: "15.02",
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

  test("getCurrentRootAgentNativeSessionId prefers explicit opencode env markers", () => {
    expect(
      getCurrentRootAgentNativeSessionId({
        OPENCODE_SESSION_ID: "ses_opencode_1",
        SESSION_ID: "ses_fallback_1",
      }),
    ).toBe("ses_opencode_1")
    expect(getCurrentRootAgentNativeSessionId({ SESSION_ID: "ses_fallback_1" })).toBe(
      "ses_fallback_1",
    )
    expect(getCurrentRootAgentNativeSessionId({})).toBeUndefined()
  })

  test("resolveCurrentBranchSupervisionContext auto-resolves stream and lineage from current branch session", async () => {
    const workspace = createTestWorkstream("001-root-agent-current-branch-context")

    try {
      writeIndex(workspace.repoRoot, workspace.streamId, "root-agent-current-branch-context")
      const startedAt = new Date().toISOString()
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            checkpointMessageId: "msg-root-checkpoint",
            checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_1",
            scope: {
              level: "stage",
              stageId: "01",
            },
          },
          branchRole: "supervision",
          status: "running",
          startedAt,
          updatedAt: startedAt,
          batchId: "01.01",
        }),
      )

      const resolved = resolveCurrentBranchSupervisionContext({
        repoRoot: workspace.repoRoot,
        env: { SESSION_ID: "ses_supervision_1" },
      })

      expect(resolved).toEqual({
        streamId: workspace.streamId,
        sessionId: "ses_supervision_1",
        source: "current_branch_supervision",
        current: {
          owner: "root_agent",
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-1",
          branchRole: "supervision",
          checkpointMessageId: "msg-root-checkpoint",
          checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
          parentSessionId: "root-session-1",
          nativeSessionId: "ses_supervision_1",
          source: "native_fork",
          scope: {
            level: "stage",
            stageId: "01",
          },
          supervisionProgress: {
            executionMode: "stage_batch_loop",
            currentBatchId: "01.01",
          },
          updatedAt: startedAt,
        },
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("resolveCurrentBranchSupervisionContext ignores completed branch sessions", async () => {
    const workspace = createTestWorkstream("001-root-agent-current-branch-terminal")

    try {
      writeIndex(workspace.repoRoot, workspace.streamId, "root-agent-current-branch-terminal")
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
          status: "completed",
          startedAt,
          updatedAt: startedAt,
          completedAt: startedAt,
          batchId: "01.01",
        }),
      )

      expect(
        resolveCurrentBranchSupervisionContext({
          repoRoot: workspace.repoRoot,
          env: { SESSION_ID: "ses_supervision_1" },
        }),
      ).toBeUndefined()
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("resolveCurrentBranchSupervisionContext ignores stale current branch supervision for terminal backing sessions", () => {
    const workspace = createTestWorkstream("001-root-agent-current-branch-stale-terminal")

    try {
      writeIndex(workspace.repoRoot, workspace.streamId, "root-agent-current-branch-stale-terminal")
      const startedAt = new Date().toISOString()
      saveSupervisorState(workspace.repoRoot, workspace.streamId, {
        version: "1.0.0",
        stream_id: workspace.streamId,
        last_updated: startedAt,
        current_branch_supervision: {
          owner: "root_agent",
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-1",
          branchRole: "supervision",
          nativeSessionId: "ses_supervision_1",
          source: "native_fork",
          updatedAt: startedAt,
        },
        runs: [],
        checkpoint_pointers: [],
        branch_sessions: [
          {
            owner: "root_agent",
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            branchRole: "supervision",
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_1",
            source: "native_fork",
            status: "completed",
            startedAt,
            updatedAt: startedAt,
            completedAt: startedAt,
            batchId: "01.01",
          },
        ],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      })

      expect(
        resolveCurrentBranchSupervisionContext({
          repoRoot: workspace.repoRoot,
          env: { SESSION_ID: "ses_supervision_1" },
        }),
      ).toBeUndefined()
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("resolveCurrentBranchSupervisionContext ignores stale current branch supervision for missing backing sessions", () => {
    const workspace = createTestWorkstream("001-root-agent-current-branch-stale-missing")

    try {
      writeIndex(workspace.repoRoot, workspace.streamId, "root-agent-current-branch-stale-missing")
      const startedAt = new Date().toISOString()
      saveSupervisorState(workspace.repoRoot, workspace.streamId, {
        version: "1.0.0",
        stream_id: workspace.streamId,
        last_updated: startedAt,
        current_branch_supervision: {
          owner: "root_agent",
          rootSessionId: "root-session-1",
          branchSessionId: "branch-supervision-missing",
          branchRole: "supervision",
          nativeSessionId: "ses_supervision_1",
          source: "native_fork",
          updatedAt: startedAt,
        },
        runs: [],
        checkpoint_pointers: [],
        branch_sessions: [],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      })

      expect(
        resolveCurrentBranchSupervisionContext({
          repoRoot: workspace.repoRoot,
          env: { SESSION_ID: "ses_supervision_1" },
        }),
      ).toBeUndefined()
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("findRootAgentBranchSessionForLaunchSessionId blocks legacy checkpoint child sessions", async () => {
    const workspace = createTestWorkstream("001-root-agent-branch-launch-guard")

    try {
      const startedAt = new Date().toISOString()
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            parentSessionId: "ses_checkpoint_1",
            checkpointSessionId: "ses_checkpoint_1",
            nativeSessionId: "ses_supervision_1",
          },
          branchRole: "supervision",
          status: "running",
          startedAt,
          updatedAt: startedAt,
        }),
      )

      expect(
        findRootAgentBranchSessionForLaunchSessionId({
          repoRoot: workspace.repoRoot,
          streamId: workspace.streamId,
          sessionId: "ses_checkpoint_1",
        }),
      ).toMatchObject({
        branchSessionId: "branch-supervision-1",
        checkpointSessionId: "ses_checkpoint_1",
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
