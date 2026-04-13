import { beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSupervisorState, upsertBranchSessionLocked } from "../../packages/workstreams/src/lib/supervisor-state.ts"
import { refreshRootAgentCheckpointPointer } from "../../packages/workstreams/src/lib/root-agent-checkpoint.ts"
import { buildRootAgentBranchSession } from "../../packages/workstreams/src/lib/root-agent-branch.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "../../packages/workstreams/tests/helpers/test-workspace.ts"

mock.module("@opencode-ai/plugin", () => ({
  tool: Object.assign(
    (definition: unknown) => definition,
    {
      schema: {
        string: () => ({ describe: () => ({ optional: () => ({}) }) }),
        number: () => ({ describe: () => ({ optional: () => ({}) }) }),
        boolean: () => ({ describe: () => ({ optional: () => ({}) }) }),
      },
    },
  ),
}))

let executeLaunchSupervisionBranch: typeof import("./workstream.ts").executeLaunchSupervisionBranch
let loadWorkstreamsToolRuntime: typeof import("./workstream.ts").loadWorkstreamsToolRuntime
let resolveWorkstreamsRuntimeModulePath: typeof import("./workstream.ts").resolveWorkstreamsRuntimeModulePath
type LaunchSupervisionBranchDeps = import("./workstream.ts").LaunchSupervisionBranchDeps

beforeAll(async () => {
  ;({
    executeLaunchSupervisionBranch,
    loadWorkstreamsToolRuntime,
    resolveWorkstreamsRuntimeModulePath,
  } = await import("./workstream.ts"))
})

function createDeps(
  repoRoot: string,
  streamId: string,
  overrides: Partial<LaunchSupervisionBranchDeps> = {},
): LaunchSupervisionBranchDeps {
  return {
    getRepoRoot: () => repoRoot,
    getResolvedStreamId: () => streamId,
    findBranchSessionForLaunchSessionId: (root, stream, sessionId) =>
      loadSupervisorState(root, stream)?.branch_sessions.find(
        (branch) =>
          branch.nativeSessionId === sessionId ||
          branch.checkpointSessionId === sessionId ||
          (branch.parentSessionId === sessionId && branch.rootSessionId !== sessionId),
      ),
    createBranchSessionId: () => "branch-supervision-1",
    buildBranchSession: buildRootAgentBranchSession,
    persistBranchSession: upsertBranchSessionLocked,
    refreshCheckpointPointer: (args) => refreshRootAgentCheckpointPointer(args),
    loadStoredBranchSession: (root, stream, branchSessionId) =>
      loadSupervisorState(root, stream)?.branch_sessions.find(
        (branch) => branch.branchSessionId === branchSessionId,
      ),
    findBranchSessionByNativeSessionId: (root, stream, nativeSessionId) =>
      loadSupervisorState(root, stream)?.branch_sessions.find(
        (branch) => branch.nativeSessionId === nativeSessionId,
      ),
    waitForBranchNativeSessionId: async () => "ses_supervision_1",
    waitForTerminalBranchSession: async (args) =>
      loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions.find(
        (branch) => branch.branchSessionId === args.branchSessionId,
      ),
    runForkedSession: async () => ({
      code: 0,
      stdout: '{"type":"text","part":{"text":"## Accomplished\\n- execution result\\n## Issues Found\\n- None.\\n## Fixes Applied\\n- None.\\n## Next For The User\\n- next action"}}\n',
      stderr: "",
      nativeSessionId: "ses_supervision_1",
    }),
    runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    findNativeSessionIdByTitle: async () => "ses_supervision_1",
    parseOutput: () => ({
      text: "## Accomplished\n- execution result\n## Issues Found\n- None.\n## Fixes Applied\n- None.\n## Next For The User\n- next action",
      logs: [],
      success: true,
    }),
    exportSessionTranscript: async (sessionId) =>
      sessionId === "root-session-1"
        ? {
            info: {
              id: "root-session-1",
              title: "Root session",
              summary: { additions: 0, deletions: 0, files: 0 },
            },
            messages: [
              {
                info: {
                  id: "msg-root-checkpoint",
                  role: "assistant",
                  time: { created: 1, completed: 2 },
                },
                parts: [{ type: "text", text: "Root checkpoint boundary" }],
              },
            ],
          }
        : {
            info: {
              id: "ses_supervision_1",
              title: "Supervision branch",
              summary: { additions: 0, deletions: 0, files: 0 },
            },
            messages: [
              {
                info: {
                  id: "msg-final",
                  role: "assistant",
                  time: { created: 1, completed: 2 },
                },
                parts: [{ type: "text", text: "## Accomplished\n- execution result\n## Issues Found\n- None.\n## Fixes Applied\n- None.\n## Next For The User\n- next action" }],
              },
            ],
          },
    extractFinalBranchReport: (sessionExport) =>
      sessionExport.messages.at(-1)?.parts?.[0]?.text ?? "",
    now: () => "2026-04-12T00:00:00.000Z",
    ...overrides,
  }
}

async function createRuntimeFixture(layout: "dev" | "dist") {
  const tempRoot = await mkdtemp(join(tmpdir(), `workstream-runtime-${layout}-`))
  const packageRoot = join(tempRoot, "node_modules", "@agenv", "workstreams")
  const workLinkPath = join(tempRoot, "bin", "work")

  await mkdir(join(tempRoot, "bin"), { recursive: true })
  await mkdir(packageRoot, { recursive: true })
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@agenv/workstreams" }),
  )

  if (layout === "dev") {
    await mkdir(join(packageRoot, "bin"), { recursive: true })
    await mkdir(join(packageRoot, "src"), { recursive: true })
    await writeFile(join(packageRoot, "bin", "work.ts"), "export {}\n")
    await writeFile(
      join(packageRoot, "src", "tool-runtime.ts"),
      "export const runtimeMarker = 'dev-runtime'\n",
    )
    await symlink(join(packageRoot, "bin", "work.ts"), workLinkPath)
  } else {
    await mkdir(join(packageRoot, "dist", "bin"), { recursive: true })
    await mkdir(join(packageRoot, "dist", "src"), { recursive: true })
    await writeFile(join(packageRoot, "dist", "bin", "work.js"), "export {}\n")
    await writeFile(
      join(packageRoot, "dist", "src", "tool-runtime.js"),
      "export const runtimeMarker = 'dist-runtime'\n",
    )
    await symlink(join(packageRoot, "dist", "bin", "work.js"), workLinkPath)
  }

  return {
    tempRoot,
    workLinkPath,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true })
    },
  }
}

describe("workstream runtime resolution", () => {
  test("resolves runtime module next to active dev work binary", async () => {
    const fixture = await createRuntimeFixture("dev")

    try {
      const modulePath = resolveWorkstreamsRuntimeModulePath({
        resolveWorkCommandPath: () => fixture.workLinkPath,
      })
      const runtime = await loadWorkstreamsToolRuntime({
        resolveWorkCommandPath: () => fixture.workLinkPath,
        cache: false,
      })

      expect(modulePath.endsWith(join("node_modules", "@agenv", "workstreams", "src", "tool-runtime.ts"))).toBe(true)
      expect((runtime as any).runtimeMarker).toBe("dev-runtime")
    } finally {
      await fixture.cleanup()
    }
  })

  test("resolves runtime module next to active dist work binary", async () => {
    const fixture = await createRuntimeFixture("dist")

    try {
      const modulePath = resolveWorkstreamsRuntimeModulePath({
        resolveWorkCommandPath: () => fixture.workLinkPath,
      })
      const runtime = await loadWorkstreamsToolRuntime({
        resolveWorkCommandPath: () => fixture.workLinkPath,
        cache: false,
      })

      expect(modulePath.endsWith(join("node_modules", "@agenv", "workstreams", "dist", "src", "tool-runtime.js"))).toBe(true)
      expect((runtime as any).runtimeMarker).toBe("dist-runtime")
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("launch_supervision_branch", () => {
  test("persists successful supervision branch lineage and summary", async () => {
    const workspace = createTestWorkstream("001-agent-tool-success")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId),
      )

      expect(result).toContain("Supervision branch branch-supervision-1 (native session ses_supervision_1) completed from checkpoint pointer message msg-root-checkpoint")
      expect(result).toContain("Extracted final branch report:")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions).toHaveLength(1)
      expect(stored?.branch_sessions[0]).toMatchObject({
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        checkpointMessageId: "msg-root-checkpoint",
        nativeSessionId: "ses_supervision_1",
        source: "native_fork",
        status: "completed",
        batchId: "10.01",
        parentSessionId: "root-session-1",
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("waits for terminal branch state and surfaces the final extracted report", async () => {
    const workspace = createTestWorkstream("001-agent-tool-stopped")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ onNativeSessionId }) => {
            await onNativeSessionId?.("ses_supervision_1")
            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"- execution result\\n- persisted state\\n- next action"}}\n',
              stderr: "",
            }
          },
          waitForTerminalBranchSession: async () => ({
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            nativeSessionId: "ses_supervision_1",
            status: "stopped",
            startedAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            completedAt: "2026-04-12T00:00:00.000Z",
            batchId: "10.01",
          }),
          exportSessionTranscript: async () => ({
            info: {
              id: "ses_supervision_1",
              title: "Supervision branch",
              summary: { additions: 0, deletions: 0, files: 0 },
            },
            messages: [
              {
                info: {
                  id: "msg-earlier",
                  role: "assistant",
                  time: { created: 1, completed: 2 },
                },
                parts: [{ type: "text", text: "Earlier status" }],
              },
              {
                info: {
                  id: "msg-final",
                  role: "assistant",
                  time: { created: 3, completed: 4 },
                },
                parts: [
                  {
                    type: "text",
                    text: [
                      "Accomplished work: monitored the child branch parent-side.",
                      "Issues found: none.",
                      "Fixes applied: transcript/report extraction.",
                      "Reason for yielding: batch paused for Root Agent review.",
                    ].join("\n"),
                  },
                ],
              },
            ],
          }),
          extractFinalBranchReport: (sessionExport) =>
            sessionExport.messages[1]?.parts?.[0]?.text ?? "",
        }),
      )

      expect(result).toContain("Supervision branch branch-supervision-1 (native session ses_supervision_1) stopped from checkpoint pointer message msg-final")
      expect(result).toContain("Persisted branch status: stopped.")
      expect(result).toContain("Extracted final branch report:")
      expect(result).toContain("Reason for yielding: batch paused for Root Agent review.")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "stopped",
        notes: expect.stringContaining("Reason for yielding: batch paused for Root Agent review."),
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("resolves the native child session after branch completion before exporting the transcript", async () => {
    const workspace = createTestWorkstream("001-agent-tool-native-resolution")

    try {
      const exportSessionTranscript = mock(async (sessionId: string) => ({
        info: {
          id: sessionId,
          title: "Supervision branch",
          summary: { additions: 0, deletions: 0, files: 0 },
        },
        messages: [
          {
            info: {
              id: "msg-final",
              role: "assistant",
              time: { created: 1, completed: 2 },
            },
            parts: [{ type: "text", text: "Recovered via parent-side session lookup." }],
          },
        ],
      }))

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async () => ({
            code: 0,
            stdout: '{"type":"text","part":{"text":"- execution result\\n- persisted state\\n- next action"}}\n',
            stderr: "",
          }),
          waitForBranchNativeSessionId: async () => "ses_resolved_after_completion",
          exportSessionTranscript,
          extractFinalBranchReport: (sessionExport) =>
            sessionExport.messages[0]?.parts?.[0]?.text ?? "",
        }),
      )

      expect(exportSessionTranscript).toHaveBeenCalledWith("ses_resolved_after_completion")
      expect(result).toContain("native session ses_resolved_after_completion")
      expect(result).toContain("from checkpoint pointer message msg-final")
      expect(result).toContain("Recovered via parent-side session lookup.")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]?.nativeSessionId).toBe("ses_resolved_after_completion")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("marks branch failed when fork launch rejects instead of leaving pending state", async () => {
    const workspace = createTestWorkstream("001-agent-tool-failure")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ onNativeSessionId }) => {
            await onNativeSessionId?.("ses_supervision_1")
            throw new Error("spawn failed")
          },
        }),
      )

      expect(result).toContain("failed to launch")
      expect(result).toContain("spawn failed")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions).toHaveLength(1)
      expect(stored?.branch_sessions[0]?.status).toBe("failed")
      expect(stored?.branch_sessions[0]?.completedAt).toBe("2026-04-12T00:00:00.000Z")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("normalizes stale pending branch status after successful fork completion", async () => {
    const workspace = createTestWorkstream("001-agent-tool-pending")

    try {
      const startedAt = "2026-04-12T00:00:00.000Z"
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-1",
            parentSessionId: "root-session-1",
          },
          branchRole: "supervision",
          status: "pending",
          startedAt,
          updatedAt: startedAt,
          batchId: "10.01",
        }),
      )

      await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId),
      )

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]?.status).toBe("completed")
      expect(stored?.branch_sessions[0]?.checkpointMessageId).toBe("msg-root-checkpoint")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("launches from checkpoint-boundary metadata with a fake-user supervision prompt", async () => {
    const workspace = createTestWorkstream("001-agent-tool-prompt")
    const calls: Array<{ sessionId: string; title: string; prompt: string }> = []

    try {
      await executeLaunchSupervisionBranch(
        {
          batch: "10.01",
          timeoutMs: 1200000,
          pollIntervalMs: 1000,
          noServer: true,
          silent: true,
        },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ sessionId, title, prompt }) => {
            calls.push({ sessionId, title, prompt })

            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"## Accomplished\\n- done"}}\n',
              stderr: "",
              nativeSessionId: "ses_supervision_1",
            }
          },
          parseOutput: () => ({
            text: "## Accomplished\n- done",
            logs: [],
            success: true,
          }),
          exportSessionTranscript: async () => ({
            info: {
              id: "ses_supervision_1",
              title: "Supervision branch",
              summary: { additions: 0, deletions: 0, files: 0 },
            },
            messages: [
              {
                info: {
                  id: "msg-final",
                  role: "assistant",
                  time: { created: 1, completed: 2 },
                },
                parts: [{ type: "text", text: "## Accomplished\n- done" }],
              },
            ],
          }),
          extractFinalBranchReport: (sessionExport) =>
            sessionExport.messages[0]?.parts?.[0]?.text ?? "",
        }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ sessionId: "root-session-1" })
      expect(calls[0]?.title).toBe(`root-supervision-${workspace.streamId}-branch-supervision-1`)
      expect(calls[0]?.prompt).toContain("Please supervise batch 10.01 for this workstream.")
      expect(calls[0]?.prompt).toContain(
        `work supervise --repo-root \"${workspace.repoRoot}\" --stream \"${workspace.streamId}\" --batch \"10.01\" --timeout-ms 1200000 --poll-interval-ms 1000 --no-server --silent --root-session-id \"root-session-1\" --branch-session-id \"branch-supervision-1\" --parent-session-id \"root-session-1\" --checkpoint-message-id \"msg-final\" --checkpoint-message-index 0 --checkpoint-created-at \"2026-04-12T00:00:00.000Z\"`,
      )
      expect(calls[0]?.prompt).toContain("launch review subagents")
      expect(calls[0]?.prompt).toContain("launch fix subagents")
      expect(calls[0]?.prompt).toContain("## Accomplished")
      expect(calls[0]?.prompt).toContain("## Next For The User")
      expect(calls[0]?.prompt).not.toContain("You are a Root Agent supervision branch")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("falls back to checkpointMessageIndex when checkpoint message IDs are unavailable", async () => {
    const workspace = createTestWorkstream("001-agent-tool-checkpoint-index-fallback")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          exportSessionTranscript: async () => ({
            info: {
              id: "ses_export_without_ids",
              title: "Session without message IDs",
              summary: { additions: 0, deletions: 0, files: 0 },
            },
            messages: [
              {
                info: {
                  role: "assistant",
                  time: { created: 1, completed: 2 },
                },
                parts: [{ type: "text", text: "Message without a stable ID" }],
              },
            ],
          }),
          extractFinalBranchReport: () => "Message without a stable ID",
        }),
      )

      expect(result).toContain("checkpoint pointer message-index 0")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        checkpointMessageIndex: 0,
        parentSessionId: "root-session-1",
      })
      expect(stored?.branch_sessions[0]?.checkpointMessageId).toBeUndefined()
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("blocks nested supervision launches from an existing branch session", async () => {
    const workspace = createTestWorkstream("001-agent-tool-nested-branch")

    try {
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
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          batchId: "10.01",
        }),
      )

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.02" },
        { sessionID: "ses_supervision_1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async () => {
            throw new Error("nested branch launch should not run")
          },
        }),
      )

      expect(result).toContain("cannot launch additional supervision branches")
      expect(result).toContain("branch branch-supervision-1")
      expect(result).toContain("one-level only")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions).toHaveLength(1)
      expect(stored?.branch_sessions[0]?.batchId).toBe("10.01")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("blocks nested launches from legacy checkpoint child sessions via persisted metadata", async () => {
    const workspace = createTestWorkstream("001-agent-tool-legacy-checkpoint-guard")

    try {
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-parent",
            parentSessionId: "ses_checkpoint_legacy",
            checkpointSessionId: "ses_checkpoint_legacy",
            nativeSessionId: "ses_supervision_parent",
          },
          branchRole: "supervision",
          status: "running",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          batchId: "10.01",
        }),
      )

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.02" },
        { sessionID: "ses_checkpoint_legacy" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async () => {
            throw new Error("legacy checkpoint child session should be blocked")
          },
        }),
      )

      expect(result).toContain("cannot launch additional supervision branches")
      expect(result).toContain("branch branch-supervision-parent")
      expect(result).toContain("one-level only")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("allows the real root session to launch again when prior metadata-only branches exist", async () => {
    const workspace = createTestWorkstream("001-agent-tool-one-level-guard")

    try {
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-parent",
            parentSessionId: "root-session-1",
            checkpointMessageId: "msg-root-boundary",
            nativeSessionId: "ses_supervision_parent",
          },
          branchRole: "supervision",
          status: "running",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          batchId: "10.01",
        }),
      )

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.02" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          createBranchSessionId: () => "branch-supervision-2",
        }),
      )

      expect(result).toContain("branch-supervision-2")
      expect(result).not.toContain("cannot launch additional supervision branches")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions.map((branch) => branch.branchSessionId)).toEqual([
        "branch-supervision-parent",
        "branch-supervision-2",
      ])
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
