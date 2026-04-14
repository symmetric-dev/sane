import { beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSupervisorState, upsertBranchSessionLocked } from "../../packages/workstreams/src/lib/supervisor-state.ts"
import {
  getRootAgentCheckpointSessionForkEligibility,
  refreshRootAgentCheckpointPointer,
} from "../../packages/workstreams/src/lib/root-agent-checkpoint.ts"
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

let toolRuntimeInfoTool: typeof import("./workstream.ts").tool_runtime_info
let launchSupervisionBranchTool: typeof import("./workstream.ts").launch_supervision_branch
let executeLaunchSupervisionBranch: any
let getWorkstreamsToolRuntimeInfo: any
let loadWorkstreamsToolRuntime: any
let runMessageBoundaryForkLaunch: any
let resolveWorkstreamsRuntimeModulePath: any
let workstreamToolVersion: string
type LaunchSupervisionBranchDeps = import("./workstream.ts").LaunchSupervisionBranchDeps

beforeAll(async () => {
  const workstreamModule = await import("./workstream.ts")

  toolRuntimeInfoTool = workstreamModule.tool_runtime_info
  launchSupervisionBranchTool = workstreamModule.launch_supervision_branch
  ;({
    WORKSTREAM_TOOL_VERSION: workstreamToolVersion,
    getWorkstreamsToolRuntimeInfo,
    loadWorkstreamsToolRuntime,
    resolveWorkstreamsRuntimeModulePath,
  } = (toolRuntimeInfoTool as any).__test)
  ;({
    executeLaunchSupervisionBranch,
    runMessageBoundaryForkLaunch,
  } = (launchSupervisionBranchTool as any).__test)
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
    getCheckpointSessionForkEligibility: (args) =>
      getRootAgentCheckpointSessionForkEligibility({
        ...args,
        pointer: {
          rootSessionId: args.pointer.rootSessionId ?? "root-session-1",
          checkpointMessageIndex: args.pointer.checkpointMessageIndex ?? 0,
          ...args.pointer,
        },
      }),
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
                  role: "user",
                },
                parts: [{ type: "text", text: "Root checkpoint boundary" }],
              },
              {
                info: {
                  id: "msg-root-launch",
                  role: "assistant",
                },
                parts: [{ type: "text", text: "launch_supervision_branch" }],
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
    JSON.stringify({ name: "@agenv/workstreams", version: "9.9.9-test" }),
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

  test("reports tool/runtime diagnostics for the active work binary", async () => {
    const fixture = await createRuntimeFixture("dist")

    try {
      const info = getWorkstreamsToolRuntimeInfo({
        resolveWorkCommandPath: () => fixture.workLinkPath,
      })

      expect(info.toolVersion).toBe(workstreamToolVersion)
      expect(typeof info.toolFilePath).toBe("string")
      expect(info.workCommandPath).toBe(fixture.workLinkPath)
      expect(info.resolvedWorkCommandPath?.endsWith(join("node_modules", "@agenv", "workstreams", "dist", "bin", "work.js"))).toBe(true)
      expect(info.resolvedRuntimeModulePath?.endsWith(join("node_modules", "@agenv", "workstreams", "dist", "src", "tool-runtime.js"))).toBe(true)
      expect(info.workstreamsPackageVersion).toBe("9.9.9-test")
      expect(info.capabilities).toEqual({
        fakeUserPrompt: true,
        metadataOnlyCheckpoints: true,
        messageBoundaryFork: true,
        breakpointTags: true,
        autoResolvedBranchSupervisionContext: true,
      })
      expect(info.errors).toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  test("diagnostic tool execute returns runtime info", async () => {
    const rawInfo = await toolRuntimeInfoTool.execute({}, {})
    const info = JSON.parse(rawInfo)

    expect(typeof rawInfo).toBe("string")
    expect(info.toolVersion).toBe(workstreamToolVersion)
    expect(typeof info.toolFilePath).toBe("string")
    expect(typeof info.capabilities).toBe("object")
    expect(info.capabilities.messageBoundaryFork).toBe(true)

    if (info.workCommandPath) {
      expect(typeof info.resolvedRuntimeModulePath).toBe("string")
    } else {
      expect(typeof info.errors?.workCommandPath).toBe("string")
    }
  })

  test("module only exposes tool exports at runtime", async () => {
    const workstreamModule = await import("./workstream.ts")

    expect(Object.keys(workstreamModule).sort()).toEqual([
      "current_workstream",
      "launch_supervision_branch",
      "link_planning_session",
      "tool_runtime_info",
    ])
  })

  test("captures resolution errors when the work binary is unavailable", () => {
    const info = getWorkstreamsToolRuntimeInfo({
      resolveWorkCommandPath: () => {
        throw new Error("missing work binary")
      },
    })

    expect(info.toolVersion).toBe(workstreamToolVersion)
    expect(info.workCommandPath).toBeUndefined()
    expect(info.errors?.workCommandPath).toContain("missing work binary")
    expect(info.resolvedRuntimeModulePath).toBeUndefined()
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
      expect(result).toContain(
        "Breakpoint selection: Selected the previous user message before launch message msg-root-launch because no configured breakpoint tag was found.",
      )
      expect(result).toContain("Extracted final branch report:")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions).toHaveLength(1)
      expect(stored?.branch_sessions[0]).toMatchObject({
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        checkpointMessageId: "msg-root-checkpoint",
        breakpointSelection: {
          strategy: "previous_user_before_launch",
          configuredTags: ["SESSION_BREAKPOINT"],
          launchMessageId: "msg-root-launch",
          launchMessageIndex: 1,
          rationale:
            "Selected the previous user message before launch message msg-root-launch because no configured breakpoint tag was found.",
        },
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

  test("surfaces explicit tagged breakpoint selection in branch lineage and output", async () => {
    const workspace = createTestWorkstream("001-agent-tool-explicit-breakpoint")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01", breakpointTags: "ROOT_BRANCH_BOUNDARY, ALT_BOUNDARY, ROOT_BRANCH_BOUNDARY" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
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
                      info: { id: "msg-tagged", role: "user" },
                      parts: [{ type: "text", text: "Pause here\nROOT_BRANCH_BOUNDARY" }],
                    },
                    {
                      info: { id: "msg-latest-user", role: "user" },
                      parts: [{ type: "text", text: "A later user message without a tag" }],
                    },
                    {
                      info: { id: "msg-root-launch", role: "assistant" },
                      parts: [{ type: "text", text: "launch_supervision_branch" }],
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
        }),
      )

      expect(result).toContain("from checkpoint pointer message msg-tagged")
      expect(result).toContain(
        'Breakpoint selection: Selected the tagged user message because it matched configured breakpoint tag "ROOT_BRANCH_BOUNDARY" before launch message msg-root-launch.',
      )

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        checkpointMessageId: "msg-tagged",
        breakpointSelection: {
          strategy: "explicit_tag",
          configuredTags: ["ROOT_BRANCH_BOUNDARY", "ALT_BOUNDARY"],
          matchedTag: "ROOT_BRANCH_BOUNDARY",
          launchMessageId: "msg-root-launch",
          launchMessageIndex: 2,
          rationale:
            'Selected the tagged user message because it matched configured breakpoint tag "ROOT_BRANCH_BOUNDARY" before launch message msg-root-launch.',
        },
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("passes configured breakpoint tags through the real launch path before checkpoint selection", async () => {
    const workspace = createTestWorkstream("001-agent-tool-configurable-breakpoint-tags")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01", breakpointTags: "CUSTOM_BREAKPOINT" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
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
                      info: { id: "msg-default-tag", role: "user" },
                      parts: [{ type: "text", text: "Earlier SESSION_BREAKPOINT marker" }],
                    },
                    {
                      info: { id: "msg-custom-tag", role: "user" },
                      parts: [{ type: "text", text: "Use CUSTOM_BREAKPOINT instead" }],
                    },
                    {
                      info: { id: "msg-root-launch", role: "assistant" },
                      parts: [{ type: "text", text: "launch_supervision_branch" }],
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
                      parts: [{ type: "text", text: "## Next For The User\n- next action" }],
                    },
                  ],
                },
        }),
      )

      expect(result).toContain("from checkpoint pointer message msg-custom-tag")
      expect(result).toContain('configured breakpoint tag "CUSTOM_BREAKPOINT"')
      expect(result).not.toContain('configured breakpoint tag "SESSION_BREAKPOINT"')

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        checkpointMessageId: "msg-custom-tag",
        breakpointSelection: {
          strategy: "explicit_tag",
          configuredTags: ["CUSTOM_BREAKPOINT"],
          matchedTag: "CUSTOM_BREAKPOINT",
        },
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
                      info: { id: "msg-root-checkpoint", role: "user" },
                      parts: [{ type: "text", text: "Checkpoint user message SESSION_BREAKPOINT" }],
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
                },
          extractFinalBranchReport: (sessionExport) =>
            sessionExport.messages[1]?.parts?.[0]?.text ?? "",
        }),
      )

      expect(result).toContain("Supervision branch branch-supervision-1 (native session ses_supervision_1) stopped from checkpoint pointer message msg-root-checkpoint")
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
      const exportSessionTranscript = mock(async (sessionId: string) =>
        sessionId === "root-session-1"
          ? {
              info: {
                id: "root-session-1",
                title: "Root session",
                summary: { additions: 0, deletions: 0, files: 0 },
              },
              messages: [
                {
                  info: { id: "msg-root-checkpoint", role: "user" },
                  parts: [{ type: "text", text: "Checkpoint user message SESSION_BREAKPOINT" }],
                },
              ],
            }
          : {
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
            },
      )

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
      expect(result).toContain("from checkpoint pointer message msg-root-checkpoint")
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
    const calls: Array<{
      sessionId: string
      title: string
      prompt: string
      forkMode?: "message" | "latest_session_fork"
      checkpointMessageId?: string
    }> = []

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
          runForkedSession: async ({ sessionId, title, prompt, forkMode, checkpointMessageId }) => {
            calls.push({ sessionId, title, prompt, forkMode, checkpointMessageId })

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
                      info: { id: "msg-root-checkpoint", role: "user" },
                      parts: [{ type: "text", text: "Checkpoint user message SESSION_BREAKPOINT" }],
                    },
                    {
                      info: { id: "msg-root-launch", role: "assistant" },
                      parts: [{ type: "text", text: "launch_supervision_branch" }],
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
                        id: "msg-branch-final",
                        role: "assistant",
                        time: { created: 1, completed: 2 },
                      },
                      parts: [{ type: "text", text: "## Accomplished\n- done" }],
                    },
                  ],
                },
          extractFinalBranchReport: (sessionExport) =>
            sessionExport.messages[0]?.parts?.[0]?.text ?? "",
        }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        sessionId: "root-session-1",
        forkMode: "message",
        checkpointMessageId: "msg-root-checkpoint",
      })
      expect(calls[0]?.title).toBe(`root-supervision-${workspace.streamId}-branch-supervision-1`)
      expect(calls[0]?.prompt).toContain("Please supervise batch 10.01 for this workstream.")
      expect(calls[0]?.prompt).toContain("Use the supervising-workstreams skill.")
      expect(calls[0]?.prompt).toContain("Start by running `work supervise --batch \"10.01\"`.")
      expect(calls[0]?.prompt).toContain("Keep this branch focused on one bounded batch supervision pass.")
      expect(calls[0]?.prompt).toContain("## Accomplished")
      expect(calls[0]?.prompt).toContain("## Next For The User")
      expect(calls[0]?.prompt).not.toContain("You are a Root Agent supervision branch")
      expect(calls[0]?.prompt).not.toContain("Branch scope:")
      expect(calls[0]?.prompt).not.toContain("--root-session-id")
      expect(calls[0]?.prompt).not.toContain("--checkpoint-message-id")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]?.scope).toEqual({
        level: "batch",
        stageId: "10",
        batchId: "10.01",
      })
      expect(stored?.branch_sessions[0]?.supervisionProgress).toEqual({
        executionMode: "single_batch_run",
        currentBatchId: "10.01",
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("composes stage-scope prompt/report guidance while deriving batch targets from persisted stage state", async () => {
    const workspace = createTestWorkstream("001-agent-tool-stage-scope-prompt")
    const calls: Array<{ prompt: string }> = []

    try {
      const result = await executeLaunchSupervisionBranch(
        {
          scope: "stage",
          stage: "10",
        },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ prompt }) => {
            calls.push({ prompt })

            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"## Next For The User\\n- Stage 10 complete."}}\n',
              stderr: "",
              nativeSessionId: "ses_supervision_1",
            }
          },
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
                      info: { id: "msg-root-checkpoint", role: "user" },
                      parts: [{ type: "text", text: "Checkpoint user message SESSION_BREAKPOINT" }],
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
                      parts: [{ type: "text", text: "## Next For The User\n- Stage 10 complete." }],
                    },
                  ],
                },
        }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]?.prompt).toContain(
        "Please supervise stage 10 for this workstream, one batch at a time until the stage is done or you must yield by policy.",
      )
      expect(calls[0]?.prompt).toContain("Use the supervising-workstreams skill.")
      expect(calls[0]?.prompt).toContain(
        "work supervise itself is still a single-batch primitive",
      )
      expect(calls[0]?.prompt).toContain(
        "Before each supervise pass, inspect the persisted state of stage 10 and identify the next incomplete or resumable batch within that stage.",
      )
      expect(calls[0]?.prompt).toContain(
        "Start by inspecting persisted stage state and running `work supervise --batch \"<next batch in this stage>\"` for the next incomplete or resumable batch in that stage.",
      )
      expect(calls[0]?.prompt).toContain('In "Next For The User", explicitly say whether stage 10 is done')
      expect(calls[0]?.prompt).not.toContain("Branch scope:")
      expect(calls[0]?.prompt).not.toContain("--root-session-id")
      expect(calls[0]?.prompt).not.toContain("--checkpoint-message-id")
      expect(result).toContain("## Next For The User\n- Stage 10 complete.")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]?.scope).toEqual({
        level: "stage",
        stageId: "10",
      })
      expect(stored?.branch_sessions[0]?.batchId).toBeUndefined()
      expect(stored?.branch_sessions[0]?.supervisionProgress).toEqual({
        executionMode: "stage_batch_loop",
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("uses plain work supervise when batch scope is auto-resolved", async () => {
    const workspace = createTestWorkstream("001-agent-tool-auto-batch-prompt")
    const calls: Array<{ prompt: string }> = []

    try {
      await executeLaunchSupervisionBranch(
        {},
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ prompt }) => {
            calls.push({ prompt })

            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"## Next For The User\\n- Continue."}}\n',
              stderr: "",
              nativeSessionId: "ses_supervision_1",
            }
          },
        }),
      )

      expect(calls).toHaveLength(1)
      expect(calls[0]?.prompt).toContain("Please supervise the next resumable batch for this workstream.")
      expect(calls[0]?.prompt).toContain("Start by running `work supervise`.")
      expect(calls[0]?.prompt).not.toContain('work supervise --batch "undefined"')
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("rejects explicit batch targets for stage-scoped launches", async () => {
    const workspace = createTestWorkstream("001-agent-tool-stage-scope-reject-batch")

    try {
      await expect(
        executeLaunchSupervisionBranch(
          {
            scope: "stage",
            stage: "10",
            batch: "10.01",
          },
          { sessionID: "root-session-1" },
          createDeps(workspace.repoRoot, workspace.streamId),
        ),
      ).rejects.toThrow(
        "Stage scope for stage 10 does not accept an explicit batch target; launch with --stage only and derive the next resumable batch from persisted stage state.",
      )
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("falls back to checkpointMessageIndex when checkpoint message IDs are unavailable", async () => {
    const workspace = createTestWorkstream("001-agent-tool-checkpoint-index-fallback")
    const forkModes: Array<string | undefined> = []

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ forkMode }) => {
            forkModes.push(forkMode)
            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"Message without a stable ID"}}\n',
              stderr: "",
              nativeSessionId: "ses_supervision_1",
            }
          },
          exportSessionTranscript: async (sessionId) =>
            sessionId === "root-session-1"
              ? {
                  info: {
                    id: "root-session-1",
                    title: "Session without message IDs",
                    summary: { additions: 0, deletions: 0, files: 0 },
                  },
                  messages: [
                    {
                      info: {
                        role: "user",
                      },
                      parts: [{ type: "text", text: "Message without a stable ID SESSION_BREAKPOINT" }],
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
                        role: "assistant",
                        time: { created: 1, completed: 2 },
                      },
                      parts: [{ type: "text", text: "Message without a stable ID" }],
                    },
                  ],
                },
          extractFinalBranchReport: () => "Message without a stable ID",
        }),
      )

      expect(result).toContain("checkpoint pointer message-index 0")
      expect(forkModes).toEqual(["latest_session_fork"])

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

  test("uses the selected checkpoint message boundary for fork inheritance and still extracts the prompt-first final report", async () => {
    const workspace = createTestWorkstream("001-agent-tool-boundary-fork")
    const forkCalls: Array<{
      checkpointMessageId?: string
      forkMode?: "message" | "latest_session_fork"
      prompt: string
    }> = []

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ checkpointMessageId, forkMode, prompt }) => {
            forkCalls.push({ checkpointMessageId, forkMode, prompt })
            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"fallback stdout summary"}}\n',
              stderr: "",
              nativeSessionId: "ses_supervision_1",
            }
          },
          parseOutput: () => ({
            text: "fallback parsed summary",
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
                      info: { id: "msg-user-1", role: "user" },
                      parts: [{ type: "text", text: "Initial request" }],
                    },
                    {
                      info: { id: "msg-user-breakpoint", role: "user" },
                      parts: [{ type: "text", text: "Freeze here SESSION_BREAKPOINT before branching." }],
                    },
                    {
                      info: { id: "msg-user-latest", role: "user" },
                      parts: [{ type: "text", text: "Later untagged user message" }],
                    },
                    {
                      info: { id: "msg-assistant-draft", role: "assistant" },
                      parts: [{ type: "text", text: "Draft assistant reply" }],
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
                      parts: [{ type: "text", text: "## Next For The User\n- Batch 10.01 is done." }],
                    },
                  ],
                },
          extractFinalBranchReport: (sessionExport) =>
            sessionExport.messages.at(-1)?.parts?.[0]?.text ?? "",
        }),
      )

      expect(forkCalls).toHaveLength(1)
      expect(forkCalls[0]).toMatchObject({
        checkpointMessageId: "msg-user-breakpoint",
        forkMode: "message",
      })
      expect(forkCalls[0]?.prompt).toContain("Please supervise batch 10.01 for this workstream.")
      expect(result).toContain("from checkpoint pointer message msg-user-breakpoint")
      expect(result).toContain("Extracted final branch report:")
      expect(result).toContain("## Next For The User\n- Batch 10.01 is done.")
      expect(result).not.toContain("fallback parsed summary")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("falls back to plain session fork when native message-boundary launch is unavailable at the live tip", async () => {
    const workspace = createTestWorkstream("001-agent-tool-message-fork-fallback")
    const forkModes: Array<string | undefined> = []

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ forkMode }) => {
            forkModes.push(forkMode)

            if (forkMode === "message") {
              throw new Error("native message-boundary fork unavailable")
            }

            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"## Next For The User\\n- Batch 10.01 is done."}}\n',
              stderr: "",
              nativeSessionId: "ses_supervision_1",
            }
          },
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
                      info: { id: "msg-root-checkpoint", role: "user" },
                      parts: [{ type: "text", text: "Checkpoint user message SESSION_BREAKPOINT" }],
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
                      parts: [{ type: "text", text: "## Next For The User\n- Batch 10.01 is done." }],
                    },
                  ],
                },
        }),
      )

      expect(forkModes).toEqual(["message", "latest_session_fork"])
      expect(result).toContain("checkpoint pointer message msg-root-checkpoint")
      expect(result).toContain("native session ses_supervision_1")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("fails deterministically when native message-boundary launch is unavailable away from the live tip", async () => {
    const workspace = createTestWorkstream("001-agent-tool-message-fork-error")
    const forkModes: Array<string | undefined> = []

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ forkMode }) => {
            forkModes.push(forkMode)
            throw new Error("native message-boundary fork unavailable")
          },
          exportSessionTranscript: async () => ({
            info: {
              id: "root-session-1",
              title: "Root session",
              summary: { additions: 0, deletions: 0, files: 0 },
            },
            messages: [
              {
                info: { id: "msg-user-breakpoint", role: "user" },
                parts: [{ type: "text", text: "Stop here SESSION_BREAKPOINT before branching." }],
              },
              {
                info: { id: "msg-assistant-draft", role: "assistant" },
                parts: [{ type: "text", text: "Live draft assistant reply" }],
              },
            ],
          }),
        }),
      )

      expect(forkModes).toEqual(["message"])
      expect(result).toContain("failed to launch")
      expect(result).toContain("checkpoint pointer message msg-user-breakpoint")
      expect(result).toContain("live session tip")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "failed",
        checkpointMessageId: "msg-user-breakpoint",
        checkpointMessageIndex: 0,
      })
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("runMessageBoundaryForkLaunch issues the expected HTTP fork, title, and prompt requests", async () => {
    const calls: Array<{ method: string; path: string; body: any }> = []
    const events: string[] = []

    const result = await runMessageBoundaryForkLaunch(
      {
        sessionId: "root-session-1",
        repoRoot: "/repo/root",
        title: "root-supervision-000-branch-supervision-1",
        prompt: "Please supervise batch 10.01 for this workstream.",
        checkpointMessageId: "msg-checkpoint-1",
        onNativeSessionId: async (nativeSessionId: string) => {
          events.push(`native:${nativeSessionId}`)
        },
      },
      {
        startServer: async () => ({
          url: "http://127.0.0.1:4312",
          close: () => {
            events.push("close")
          },
        }),
        requestJson: async ({
          method,
          path,
          body,
        }: {
          method: string
          path: string
          body: any
        }) => {
          calls.push({ method, path, body })

          if (path.includes("/fork?")) {
            return { id: "ses_child_123" }
          }

          if (path.includes("/message?")) {
            return {
              parts: [{ type: "text", text: "## Next For The User\n- done" }],
            }
          }

          return { ok: true }
        },
      },
    )

    expect(result).toEqual({
      code: 0,
      stdout: '{"type":"text","part":{"text":"## Next For The User\\n- done"}}\n',
      stderr: "",
      nativeSessionId: "ses_child_123",
    })
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/session/root-session-1/fork?directory=%2Frepo%2Froot",
        body: { messageID: "msg-checkpoint-1" },
      },
      {
        method: "PATCH",
        path: "/session/ses_child_123?directory=%2Frepo%2Froot",
        body: { title: "root-supervision-000-branch-supervision-1" },
      },
      {
        method: "POST",
        path: "/session/ses_child_123/message?directory=%2Frepo%2Froot",
        body: {
          parts: [{ type: "text", text: "Please supervise batch 10.01 for this workstream." }],
        },
      },
    ])
    expect(events).toEqual(["native:ses_child_123", "close"])
  })

  test("runMessageBoundaryForkLaunch closes the server when the fork response is missing a child session id", async () => {
    const events: string[] = []

    await expect(
      runMessageBoundaryForkLaunch(
        {
          sessionId: "root-session-1",
          repoRoot: "/repo/root",
          title: "root-supervision-000-branch-supervision-1",
          prompt: "prompt",
          checkpointMessageId: "msg-checkpoint-1",
        },
        {
          startServer: async () => ({
            url: "http://127.0.0.1:4312",
            close: () => {
              events.push("close")
            },
          }),
          requestJson: async () => ({}),
        },
      ),
    ).rejects.toThrow("Fork response did not include a child session ID.")

    expect(events).toEqual(["close"])
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
