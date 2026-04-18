// @ts-nocheck
import { beforeAll, describe, expect, mock, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync as nodeSpawnSync } from "node:child_process"
import { loadSupervisorState, upsertBranchSessionLocked } from "../../packages/workstreams/src/lib/supervisor-state.ts"
import {
  getRootAgentCheckpointSessionForkEligibility,
  refreshRootAgentCheckpointPointer,
} from "../../packages/workstreams/src/lib/root-agent-checkpoint.ts"
import { buildRootAgentBranchSession } from "../../packages/workstreams/src/lib/root-agent-branch.ts"
import {
  buildFinalizationNotes,
  executeFinalizeWorkstreamSupervision,
} from "../../packages/workstreams/src/lib/workstream-tool/finalize-supervision.ts"
import { executeReconcileWorkstreamSupervision } from "../../packages/workstreams/src/lib/workstream-tool/reconcile-supervision.ts"
import {
  DEFAULT_BRANCH_TERMINAL_PERSIST_GRACE_MS,
  executeLaunchSupervisionBranch,
  shouldBlockDuplicateSupervisionLaunch,
  type LaunchSupervisionBranchDeps,
} from "../../packages/workstreams/src/lib/workstream-tool/launch-supervision.ts"
import { runMessageBoundaryForkLaunch } from "../../packages/workstreams/src/lib/workstream-tool/launch-supervision-opencode.ts"
import {
  runForkedSessionInTmux,
  waitForTmuxSessionExit,
} from "../../packages/workstreams/src/lib/workstream-tool/launch-supervision-tmux.ts"
import { cleanupTestWorkstream, createTestWorkstream } from "../../packages/workstreams/tests/helpers/test-workspace.ts"
import { createEmptyTasksFile, writeTasksFile } from "../../packages/workstreams/src/lib/tasks.ts"
import { getThreadMetadata } from "../../packages/workstreams/src/lib/threads.ts"

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
let linkThreadSessionTool: typeof import("./workstream.ts").link_thread_session
let finalizeWorkstreamSupervisionTool: typeof import("./workstream.ts").finalize_workstream_supervision
let reconcileWorkstreamSupervisionTool: typeof import("./workstream.ts").reconcile_workstream_supervision
let launchSupervisionBranchTool: typeof import("./workstream.ts").launch_supervision_branch
let executeFinalizeToolDelegate: any
let executeReconcileToolDelegate: any
let executeLaunchToolDelegate: any
let getWorkstreamsToolRuntimeInfo: any
let loadWorkstreamsToolRuntime: any
let resetWorkstreamsToolRuntimeCache: () => void
let resolveWorkstreamsRuntimeModulePath: any
let workstreamToolVersion: string

beforeAll(async () => {
  const workstreamModule = await import("./workstream.ts")

  toolRuntimeInfoTool = workstreamModule.tool_runtime_info
  linkThreadSessionTool = workstreamModule.link_thread_session
  finalizeWorkstreamSupervisionTool = workstreamModule.finalize_workstream_supervision
  reconcileWorkstreamSupervisionTool = workstreamModule.reconcile_workstream_supervision
  launchSupervisionBranchTool = workstreamModule.launch_supervision_branch
  ;({ executeFinalizeWorkstreamSupervision: executeFinalizeToolDelegate } =
    (finalizeWorkstreamSupervisionTool as any).__test)
  ;({ executeReconcileWorkstreamSupervision: executeReconcileToolDelegate } =
    (reconcileWorkstreamSupervisionTool as any).__test)
  ;({ executeLaunchSupervisionBranch: executeLaunchToolDelegate } =
    (launchSupervisionBranchTool as any).__test)
  ;({
    WORKSTREAM_TOOL_VERSION: workstreamToolVersion,
    getWorkstreamsToolRuntimeInfo,
    loadWorkstreamsToolRuntime,
    resetWorkstreamsToolRuntimeCache,
    resolveWorkstreamsRuntimeModulePath,
  } = (toolRuntimeInfoTool as any).__test)
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
    findActiveMatchingSupervisionBranch: ({ rootSessionId, repoRoot: root, streamId: stream, scope }) =>
      loadSupervisorState(root, stream)?.branch_sessions.find(
        (branch) =>
          branch.branchRole === "supervision" &&
          branch.rootSessionId === rootSessionId &&
          shouldBlockDuplicateSupervisionLaunch(branch) &&
          (!!branch.nativeSessionId || !!branch.tmuxSessionName) &&
          ((branch.scope?.level ?? undefined) === (scope?.level ?? undefined)) &&
          (branch.scope?.level === "stage"
            ? branch.scope?.stageId === scope?.stageId
            : branch.scope?.level === "batch"
              ? branch.scope?.stageId === scope?.stageId &&
                branch.scope?.batchId === (scope?.level === "batch" ? scope.batchId : undefined)
              : !branch.scope && !scope),
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
    createSupervisionTmuxSessionName: () => "001-supervision-test01",
    tmuxSessionExists: () => false,
    runForkedSession: async () => ({
      code: 0,
      stdout: '{"type":"text","part":{"text":"## Accomplished\\n- execution result\\n## Issues Found\\n- None.\\n## Fixes Applied\\n- None.\\n## What is Next\\n- next action"}}\n',
      stderr: "",
      nativeSessionId: "ses_supervision_1",
    }),
    runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    findNativeSessionIdByTitle: async () => "ses_supervision_1",
    parseOutput: () => ({
      text: "## Accomplished\n- execution result\n## Issues Found\n- None.\n## Fixes Applied\n- None.\n## What is Next\n- next action",
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
                parts: [{ type: "text", text: "## Accomplished\n- execution result\n## Issues Found\n- None.\n## Fixes Applied\n- None.\n## What is Next\n- next action" }],
              },
            ],
          },
    extractFinalBranchReport: (sessionExport) =>
      sessionExport.messages.at(-1)?.parts?.[0]?.text ?? "",
    now: () => "2026-04-12T00:00:00.000Z",
    ...overrides,
  }
}

function writeIndex(repoRoot: string, streamId: string, name: string): void {
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

function createReconcileDeps(
  repoRoot: string,
  streamId: string,
  overrides: Record<string, any> = {},
) {
  return {
    getRepoRoot: () => repoRoot,
    loadCandidateBranches: ({ streamId: requestedStreamId, branchSessionId, rootSessionId }) => {
      const resolvedStreamId = requestedStreamId ?? streamId
      return (loadSupervisorState(repoRoot, resolvedStreamId)?.branch_sessions ?? [])
        .filter(
          (branch) =>
            branch.branchRole === "supervision" &&
            !["completed", "stopped", "failed"].includes(branch.status) &&
            (!branchSessionId || branch.branchSessionId === branchSessionId) &&
            (!rootSessionId || branch.rootSessionId === rootSessionId),
        )
        .map((branch) => ({ streamId: resolvedStreamId, branch }))
    },
    buildBranchSession: buildRootAgentBranchSession,
    persistBranchSession: upsertBranchSessionLocked,
    inspectTmuxSession: async () => ({
      exists: true,
      paneDead: true,
      exitStatus: 0,
      paneOutput: "branch pane output",
    }),
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
          parts: [{ type: "text", text: "## What is Next\n- recovered report" }],
        },
      ],
    }),
    extractFinalBranchReport: (sessionExport) => sessionExport.messages[0]?.parts?.[0]?.text ?? "",
    now: () => "2026-04-12T03:00:00.000Z",
    ...overrides,
  }
}

async function createRuntimeFixture(
  layout: "dev" | "dist",
  runtimeSource?: string,
) {
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
    await chmod(join(packageRoot, "bin", "work.ts"), 0o755)
    await writeFile(
      join(packageRoot, "src", "tool-runtime.ts"),
      runtimeSource ?? "export const runtimeMarker = 'dev-runtime'\n",
    )
    await writeFile(
      join(packageRoot, "src", "tool-runtime-loader.ts"),
      [
        'import { fileURLToPath, pathToFileURL } from "url"',
        "",
        "let cachedRuntimePromise",
        "",
        "export function resolveWorkstreamsRuntimeModulePath() {",
        '  return fileURLToPath(new URL("./tool-runtime.ts", import.meta.url))',
        "}",
        "",
        "export async function loadWorkstreamsToolRuntime(options = {}) {",
        "  const loadRuntime = async () => import(pathToFileURL(resolveWorkstreamsRuntimeModulePath()).href)",
        "  if (options.cache === false) {",
        "    return loadRuntime()",
        "  }",
        "  cachedRuntimePromise ??= loadRuntime()",
        "  return cachedRuntimePromise",
        "}",
        "",
        "export function createResolvedWorkstreamsToolRuntimeInfo(args) {",
        "  return {",
        "    toolVersion: args.toolVersion,",
        "    ...(args.toolFilePath ? { toolFilePath: args.toolFilePath } : {}),",
        "    workCommandPath: args.workCommandPath,",
        "    resolvedWorkCommandPath: args.resolvedWorkCommandPath,",
        "    workstreamsPackageRoot: args.packageRoot,",
        '    workstreamsPackageVersion: "9.9.9-test",',
        "    resolvedRuntimeModulePath: resolveWorkstreamsRuntimeModulePath(),",
        "    capabilities: {",
        "      fakeUserPrompt: true,",
        "      metadataOnlyCheckpoints: true,",
        "      messageBoundaryFork: true,",
        "      breakpointTags: true,",
        "      breakpointModes: true,",
        "      autoResolvedBranchSupervisionContext: true,",
        "    },",
        "  }",
        "}",
      ].join("\n"),
    )
    await symlink(join(packageRoot, "bin", "work.ts"), workLinkPath)
  } else {
    await mkdir(join(packageRoot, "dist", "bin"), { recursive: true })
    await mkdir(join(packageRoot, "dist", "src"), { recursive: true })
    await writeFile(join(packageRoot, "dist", "bin", "work.js"), "export {}\n")
    await chmod(join(packageRoot, "dist", "bin", "work.js"), 0o755)
    await writeFile(
      join(packageRoot, "dist", "src", "tool-runtime.js"),
      runtimeSource ?? "export const runtimeMarker = 'dist-runtime'\n",
    )
    await writeFile(
      join(packageRoot, "dist", "src", "tool-runtime-loader.js"),
      [
        'import { fileURLToPath, pathToFileURL } from "url"',
        "",
        "let cachedRuntimePromise",
        "",
        "export function resolveWorkstreamsRuntimeModulePath() {",
        '  return fileURLToPath(new URL("./tool-runtime.js", import.meta.url))',
        "}",
        "",
        "export async function loadWorkstreamsToolRuntime(options = {}) {",
        "  const loadRuntime = async () => import(pathToFileURL(resolveWorkstreamsRuntimeModulePath()).href)",
        "  if (options.cache === false) {",
        "    return loadRuntime()",
        "  }",
        "  cachedRuntimePromise ??= loadRuntime()",
        "  return cachedRuntimePromise",
        "}",
        "",
        "export function createResolvedWorkstreamsToolRuntimeInfo(args) {",
        "  return {",
        "    toolVersion: args.toolVersion,",
        "    ...(args.toolFilePath ? { toolFilePath: args.toolFilePath } : {}),",
        "    workCommandPath: args.workCommandPath,",
        "    resolvedWorkCommandPath: args.resolvedWorkCommandPath,",
        "    workstreamsPackageRoot: args.packageRoot,",
        '    workstreamsPackageVersion: "9.9.9-test",',
        "    resolvedRuntimeModulePath: resolveWorkstreamsRuntimeModulePath(),",
        "    capabilities: {",
        "      fakeUserPrompt: true,",
        "      metadataOnlyCheckpoints: true,",
        "      messageBoundaryFork: true,",
        "      breakpointTags: true,",
        "      breakpointModes: true,",
        "      autoResolvedBranchSupervisionContext: true,",
        "    },",
        "  }",
        "}",
      ].join("\n"),
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
      const modulePath = await resolveWorkstreamsRuntimeModulePath({
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
      const modulePath = await resolveWorkstreamsRuntimeModulePath({
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
      const info = await getWorkstreamsToolRuntimeInfo({
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
        breakpointModes: true,
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
      "finalize_workstream_supervision",
      "launch_supervision_branch",
      "link_planning_session",
      "link_thread_session",
      "reconcile_workstream_supervision",
      "tool_runtime_info",
    ])
  })

  test("links the current session to a thread in the current workstream", async () => {
    const workspace = createTestWorkstream("001-agent-tool-link-thread")
    const originalCwd = process.cwd()
    try {
      writeIndex(workspace.repoRoot, workspace.streamId, "agent-tool-link-thread")
      const tasksFile = createEmptyTasksFile(workspace.streamId)
      const now = new Date().toISOString()
      tasksFile.tasks = [
        {
          id: "01.01.01.01",
          name: "Implement linked thread session",
          thread_name: "Thread 1",
          batch_name: "Batch 1",
          stage_name: "Stage 1",
          created_at: now,
          updated_at: now,
          status: "pending",
        },
      ]
      writeTasksFile(workspace.repoRoot, workspace.streamId, tasksFile)

      process.chdir(workspace.repoRoot)
      const result = await linkThreadSessionTool.execute(
        { threadId: "01.01.01" },
        { sessionID: "ses_thread_1" },
      )

      expect(result).toBe(
        `Linked current session ses_thread_1 to thread 01.01.01 in ${workspace.streamId}.`,
      )
      expect(getThreadMetadata(workspace.repoRoot, workspace.streamId, "01.01.01")).toMatchObject({
        threadId: "01.01.01",
        opencodeSessionId: "ses_thread_1",
      })
    } finally {
      process.chdir(originalCwd)
      cleanupTestWorkstream(workspace)
    }
  })

  test("returns an error when the current session ID is unavailable", async () => {
    const result = await linkThreadSessionTool.execute({ threadId: "01.01.01" }, {})

    expect(result).toBe("Error: Could not determine current session ID")
  })

  test("returns an error when the target thread does not exist", async () => {
    const workspace = createTestWorkstream("001-agent-tool-missing-thread")
    const originalCwd = process.cwd()
    try {
      writeIndex(workspace.repoRoot, workspace.streamId, "agent-tool-missing-thread")
      writeTasksFile(workspace.repoRoot, workspace.streamId, createEmptyTasksFile(workspace.streamId))

      process.chdir(workspace.repoRoot)
      const result = await linkThreadSessionTool.execute(
        { threadId: "01.01.99" },
        { sessionID: "ses_thread_missing" },
      )

      expect(result).toBe(
        `Error linking thread session: Thread "01.01.99" not found in workstream "${workspace.streamId}"`,
      )
    } finally {
      process.chdir(originalCwd)
      cleanupTestWorkstream(workspace)
    }
  })

  test("captures resolution errors when the work binary is unavailable", async () => {
    const info = await getWorkstreamsToolRuntimeInfo({
      resolveWorkCommandPath: () => {
        throw new Error("missing work binary")
      },
    })

    expect(info.toolVersion).toBe(workstreamToolVersion)
    expect(info.workCommandPath).toBeUndefined()
    expect(info.errors?.workCommandPath).toContain("missing work binary")
    expect(info.resolvedRuntimeModulePath).toBeUndefined()
  })

  test("delegates finalize tool execution to the package runtime", async () => {
    const fixture = await createRuntimeFixture(
      "dist",
      [
        "export function createDefaultFinalizeWorkstreamSupervisionDeps(_runtime, options = {}) {",
        "  return { marker: 'finalize', repoRoot: options.getRepoRoot?.() }",
        "}",
        "export async function executeFinalizeWorkstreamSupervision(args, context, deps) {",
        "  return JSON.stringify({ args, context, deps })",
        "}",
      ].join("\n"),
    )
    try {
      resetWorkstreamsToolRuntimeCache()
      const result = await executeFinalizeToolDelegate(
        { status: "completed", summary: "done" },
        { sessionID: "ses_test_1" },
        {
          resolveWorkCommandPath: () => fixture.workLinkPath,
          cache: false,
        },
      )
      const parsed = JSON.parse(result)

      expect(parsed.args).toEqual({ status: "completed", summary: "done" })
      expect(parsed.context).toEqual({ sessionID: "ses_test_1" })
      expect(parsed.deps.marker).toBe("finalize")
      expect(parsed.deps.repoRoot).toBe("/Users/beto/agenv")
    } finally {
      resetWorkstreamsToolRuntimeCache()
      await fixture.cleanup()
    }
  })

  test("delegates launch tool execution to the package runtime", async () => {
    const fixture = await createRuntimeFixture(
      "dist",
      [
        "export function createDefaultLaunchSupervisionBranchDeps(_runtime, options = {}) {",
        "  return { marker: 'launch', repoRoot: options.getRepoRoot?.() }",
        "}",
        "export async function executeLaunchSupervisionBranch(args, context, deps) {",
        "  return JSON.stringify({ args, context, deps })",
        "}",
      ].join("\n"),
    )
    try {
      resetWorkstreamsToolRuntimeCache()
      const result = await executeLaunchToolDelegate(
        { scope: "batch", target: "10.01", silent: true },
        { sessionID: "root-session-1" },
        {
          resolveWorkCommandPath: () => fixture.workLinkPath,
          cache: false,
        },
      )
      const parsed = JSON.parse(result)

      expect(parsed.args).toEqual({ scope: "batch", target: "10.01", silent: true })
      expect(parsed.context).toEqual({ sessionID: "root-session-1" })
      expect(parsed.deps.marker).toBe("launch")
      expect(parsed.deps.repoRoot).toBe("/Users/beto/agenv")
    } finally {
      resetWorkstreamsToolRuntimeCache()
      await fixture.cleanup()
    }
  })

  test("delegates reconcile tool execution to the package runtime", async () => {
    const fixture = await createRuntimeFixture(
      "dist",
      [
        "export function createDefaultReconcileWorkstreamSupervisionDeps(_runtime, options = {}) {",
        "  return { marker: 'reconcile', repoRoot: options.getRepoRoot?.() }",
        "}",
        "export async function executeReconcileWorkstreamSupervision(args, context, deps) {",
        "  return JSON.stringify({ args, context, deps })",
        "}",
      ].join("\n"),
    )
    try {
      resetWorkstreamsToolRuntimeCache()
      const result = await executeReconcileToolDelegate(
        { streamId: "001-test", branchSessionId: "branch-supervision-1" },
        { sessionID: "root-session-1" },
        {
          resolveWorkCommandPath: () => fixture.workLinkPath,
          cache: false,
        },
      )
      const parsed = JSON.parse(result)

      expect(parsed.args).toEqual({
        streamId: "001-test",
        branchSessionId: "branch-supervision-1",
      })
      expect(parsed.context).toEqual({ sessionID: "root-session-1" })
      expect(parsed.deps.marker).toBe("reconcile")
      expect(parsed.deps.repoRoot).toBe("/Users/beto/agenv")
    } finally {
      resetWorkstreamsToolRuntimeCache()
      await fixture.cleanup()
    }
  })
})

describe("finalize_workstream_supervision", () => {
  test("marks the current supervision session terminal and persists report details", async () => {
    const workspace = createTestWorkstream("001-agent-tool-finalize")
    const startedAt = "2026-04-12T00:00:00.000Z"

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
            scope: { level: "batch", stageId: "10", batchId: "10.01" },
          },
          branchRole: "supervision",
          status: "running",
          startedAt,
          updatedAt: startedAt,
          batchId: "10.01",
          notes: "Execution complete.",
        }),
      )

      const result = await executeFinalizeWorkstreamSupervision(
        {
          status: "completed",
          summary: "Paused for user review.",
          reportText: "## Accomplished\n- Implemented the requested change.\n## Issues Found\n- None.\n## Fixes Applied\n- None.\n## What is Next\n- Review the patch.",
        },
        { sessionID: "ses_supervision_1" },
        {
          getRepoRoot: () => workspace.repoRoot,
          resolveFinalizableSupervision: async () => {
            const branchSession = loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions[0]
            return {
              streamId: workspace.streamId,
              current: {
                rootSessionId: "root-session-1",
                branchSessionId: "branch-supervision-1",
                nativeSessionId: "ses_supervision_1",
                parentSessionId: "root-session-1",
                scope: { level: "batch", stageId: "10", batchId: "10.01" },
                supervisionProgress: { currentBatchId: "10.01" },
              },
              branchSession,
              resolutionSource: "current_supervision_context",
            }
          },
          buildBranchSession: buildRootAgentBranchSession,
          persistBranchSession: upsertBranchSessionLocked,
          now: () => "2026-04-12T01:00:00.000Z",
        },
      )

      expect(result).toContain(`Marked workstream supervision as completed for ${workspace.streamId}.`)

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.current_branch_supervision).toBeUndefined()
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "completed",
        completedAt: "2026-04-12T01:00:00.000Z",
        updatedAt: "2026-04-12T01:00:00.000Z",
        nativeSessionId: "ses_supervision_1",
        finalizationSource: "explicit_finalize",
        finalizationReason: "persisted_terminal_status",
      })
      expect(stored?.branch_sessions[0]?.notes).toContain("Execution complete.")
      expect(stored?.branch_sessions[0]?.notes).toContain("Summary:\nPaused for user review.")
      expect(stored?.branch_sessions[0]?.notes).toContain("Final report:\n## Accomplished")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("is idempotent and preserves an existing terminal status", async () => {
    const workspace = createTestWorkstream("001-agent-tool-finalize-idempotent")
    const completedAt = "2026-04-12T01:00:00.000Z"

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
          status: "completed",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: completedAt,
          completedAt,
          notes: "Summary:\nAlready finalized.",
        }),
      )

      const result = await executeFinalizeWorkstreamSupervision(
        {
          status: "failed",
          summary: "Already finalized.",
        },
        { sessionID: "ses_supervision_1" },
        {
          getRepoRoot: () => workspace.repoRoot,
          resolveFinalizableSupervision: async () => {
            const branchSession = loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions[0]
            return {
              streamId: workspace.streamId,
              current: {
                rootSessionId: "root-session-1",
                branchSessionId: "branch-supervision-1",
                nativeSessionId: "ses_supervision_1",
              },
              branchSession,
              resolutionSource: "persisted_session_fallback",
            }
          },
          buildBranchSession: buildRootAgentBranchSession,
          persistBranchSession: upsertBranchSessionLocked,
          now: () => "2026-04-12T02:00:00.000Z",
        },
      )

      expect(result).toContain(`Workstream supervision was already finalized as completed for ${workspace.streamId}.`)
      expect(result).toContain("Existing terminal status completed was preserved.")
      expect(result).toContain("Persisted session fallback was used.")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "completed",
        completedAt,
        updatedAt: "2026-04-12T02:00:00.000Z",
      })
      expect(stored?.branch_sessions[0]?.notes?.match(/Summary:\nAlready finalized\./g)?.length).toBe(1)
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("deduplicates repeated finalization note content", () => {
    expect(
      buildFinalizationNotes({
        existingNotes: "Summary:\nAlready finalized.",
        summary: "Already finalized.",
      }),
    ).toBe("Summary:\nAlready finalized.")
  })
})

describe("reconcile_workstream_supervision", () => {
  test("exposes the public recovery tool args", () => {
    expect(Object.keys((reconcileWorkstreamSupervisionTool as any).args).sort()).toEqual([
      "branchSessionId",
      "streamId",
    ])
  })

  test("reconciles a dead tmux-backed supervision branch using authoritative exit evidence", async () => {
    const workspace = createTestWorkstream("001-agent-tool-reconcile-dead-pane")

    try {
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
          status: "running",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          tmuxSessionName: "001-supervision-reconcile1",
          notes: "Awaiting parent reconciliation.",
        }),
      )

      const result = await executeReconcileWorkstreamSupervision(
        {},
        { sessionID: "root-session-1" },
        createReconcileDeps(workspace.repoRoot, workspace.streamId, {
          inspectTmuxSession: async () => ({
            exists: true,
            paneDead: true,
            exitStatus: 0,
            paneOutput: "finished cleanly",
          }),
        }),
      )

      expect(result).toContain("Reconciled 1 supervision session")
      expect(result).toContain(`${workspace.streamId}:branch-supervision-1 -> completed`)
      expect(result).toContain("reason: ended_without_explicit_finalize")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "completed",
        processExitCode: 0,
        processEndedAt: "2026-04-12T03:00:00.000Z",
        finalizationSource: "parent_process_exit_reconciliation",
        finalizationReason: "ended_without_explicit_finalize",
      })
      expect(stored?.branch_sessions[0]?.notes).toContain(
        "Authoritative process-end evidence: tmux pane exited with status 0.",
      )
      expect(stored?.branch_sessions[0]?.notes).toContain("Recovered final branch report:")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("marks a missing tmux session as stopped when report evidence is recoverable", async () => {
    const workspace = createTestWorkstream("001-agent-tool-reconcile-missing-session")

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
            scope: { level: "batch", stageId: "10", batchId: "10.01" },
          },
          branchRole: "supervision",
          status: "pending",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          tmuxSessionName: "001-supervision-reconcile2",
        }),
      )

      const result = await executeReconcileWorkstreamSupervision(
        {},
        { sessionID: "root-session-1" },
        createReconcileDeps(workspace.repoRoot, workspace.streamId, {
          inspectTmuxSession: async () => ({ exists: false, paneDead: false }),
        }),
      )

      expect(result).toContain(`${workspace.streamId}:branch-supervision-1 -> stopped`)
      expect(result).toContain("reason: session_missing_with_recovered_report")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "stopped",
        processEndedAt: "2026-04-12T03:00:00.000Z",
        finalizationSource: "parent_process_exit_reconciliation",
        finalizationReason: "session_missing_with_recovered_report",
      })
      expect(stored?.branch_sessions[0]?.notes).toContain("tmux session 001-supervision-reconcile2 no longer exists")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("reports when nothing needs reconciliation", async () => {
    const workspace = createTestWorkstream("001-agent-tool-reconcile-noop")

    try {
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
          status: "running",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          tmuxSessionName: "001-supervision-live1",
        }),
      )

      const result = await executeReconcileWorkstreamSupervision(
        {},
        { sessionID: "root-session-1" },
        createReconcileDeps(workspace.repoRoot, workspace.streamId, {
          inspectTmuxSession: async () => ({ exists: true, paneDead: false }),
        }),
      )

      expect(result).toContain("No supervision sessions needed reconciliation.")
      expect(result).toContain("still live")
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions[0]?.status).toBe(
        "running",
      )
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})

describe("launch_supervision_branch", () => {
  test("exposes the target-based public tool args", () => {
    expect(Object.keys((launchSupervisionBranchTool as any).args).sort()).toEqual([
      "noServer",
      "scope",
      "silent",
      "streamId",
      "target",
    ])
  })

  test("persists successful supervision branch lineage and summary", async () => {
    const workspace = createTestWorkstream("001-agent-tool-success")

    try {
      const result = await executeLaunchSupervisionBranch(
        { scope: "batch", target: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId),
      )

      expect(result).toContain("Supervision session branch-supervision-1 (native session ses_supervision_1) completed from checkpoint pointer message msg-root-checkpoint")
      expect(result).toContain(
        "Breakpoint selection: Selected the previous user message before launch message msg-root-launch because no configured breakpoint tag was found.",
      )
      expect(result).toContain("Extracted final supervision report:")
      expect(result).toContain(
        "Finalization handling: Parent-side reconciliation finalized the supervision session after process end because no explicit finalize_workstream_supervision call was persisted.",
      )

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions).toHaveLength(1)
      expect(stored?.branch_sessions[0]).toMatchObject({
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        tmuxSessionName: "001-supervision-test01",
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
        processExitCode: 0,
        finalizationSource: "parent_process_exit_reconciliation",
        finalizationReason: "ended_without_explicit_finalize",
      })
      expect(stored?.branch_sessions[0]?.processEndedAt).toBe("2026-04-12T00:00:00.000Z")
      expect(stored?.branch_sessions[0]?.notes).toContain(
        "Parent reconciled supervision state after process end because no explicit finalize_workstream_supervision call was persisted, but transcript/report evidence was available.",
      )
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("preserves explicit completedAt when explicit finalization lands before a later zero-exit reconciliation", async () => {
    const workspace = createTestWorkstream("001-agent-tool-explicit-finalize-zero-exit")

    try {
      const explicitCompletedAt = "2026-04-12T00:30:00.000Z"
      const reconciledAt = "2026-04-12T02:00:00.000Z"

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          now: () => reconciledAt,
          runForkedSession: async ({ onNativeSessionId, tmuxSessionName }) => {
            await onNativeSessionId?.("ses_supervision_explicit_zero")
            await upsertBranchSessionLocked(
              workspace.repoRoot,
              workspace.streamId,
              buildRootAgentBranchSession({
                context: {
                  rootSessionId: "root-session-1",
                  branchSessionId: "branch-supervision-1",
                  parentSessionId: "root-session-1",
                  checkpointMessageId: "msg-root-checkpoint",
                  checkpointMessageIndex: 0,
                  checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
                  nativeSessionId: "ses_supervision_explicit_zero",
                  scope: { level: "batch", stageId: "10", batchId: "10.01" },
                },
                branchRole: "supervision",
                status: "completed",
                startedAt: "2026-04-12T00:00:00.000Z",
                updatedAt: explicitCompletedAt,
                completedAt: explicitCompletedAt,
                tmuxSessionName: tmuxSessionName ?? "001-supervision-test01",
                batchId: "10.01",
                finalizationSource: "explicit_finalize",
                finalizationReason: "persisted_terminal_status",
                notes: "Summary:\nExplicit finalize completed before process exit.",
              }),
            )

            return {
              code: 0,
              stdout: "",
              stderr: "",
              nativeSessionId: "ses_supervision_explicit_zero",
              tmuxSessionName,
            }
          },
          waitForTerminalBranchSession: async () =>
            loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions.find(
              (branch) => branch.branchSessionId === "branch-supervision-1",
            ),
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
                    id: "ses_supervision_explicit_zero",
                    title: "Supervision branch",
                    summary: { additions: 0, deletions: 0, files: 0 },
                  },
                  messages: [
                    {
                      info: { id: "msg-final", role: "assistant" },
                      parts: [
                        {
                          type: "text",
                          text: "## What is Next\n- explicit finalize completed before process exit",
                        },
                      ],
                    },
                  ],
                },
        }),
      )

      expect(result).toContain(
        "Supervision session branch-supervision-1 (native session ses_supervision_explicit_zero) completed",
      )
      expect(result).toContain("Process end evidence: tmux pane exited with status 0.")
      expect(result).toContain(
        "Finalization handling: Explicit supervision finalization was already persisted before parent-side reconciliation.",
      )
      expect(result).toContain(
        "Extracted final supervision report:\n## What is Next\n- explicit finalize completed before process exit",
      )

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]?.completedAt).toBe(explicitCompletedAt)
      expect(stored?.branch_sessions[0]?.updatedAt).toBe(reconciledAt)
      expect(stored?.branch_sessions[0]?.processEndedAt).toBe(reconciledAt)
      expect(stored?.branch_sessions[0]?.processExitCode).toBe(0)
      expect(stored?.branch_sessions[0]?.finalizationSource).toBe("explicit_finalize")
      expect(stored?.branch_sessions[0]?.finalizationReason).toBe("persisted_terminal_status")
      expect(stored?.branch_sessions[0]?.notes).toContain(
        "Persisted terminal supervision state was already finalized before parent-side process-end reconciliation.",
      )
      expect(stored?.branch_sessions[0]?.notes).toContain(
        "Authoritative process-end evidence: tmux pane exited with status 0.",
      )
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("passes the dedicated supervision tmux session through launch and persistence", async () => {
    const workspace = createTestWorkstream("001-agent-tool-tmux-persist")
    const calls: Array<{ tmuxSessionName?: string }> = []

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          createSupervisionTmuxSessionName: () => "001-supervision-observe1",
          runForkedSession: async ({ tmuxSessionName }) => {
            calls.push({ tmuxSessionName })
            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"## What is Next\\n- done"}}\n',
              stderr: "",
              nativeSessionId: "ses_supervision_1",
              tmuxSessionName,
              tmuxMetadata: {
                sessionName: tmuxSessionName!,
                attachCommand: `tmux attach -t ${tmuxSessionName}`,
                launchDirectory: "/tmp/workstream-supervision-observe1",
                wrapperPath: "/tmp/workstream-supervision-observe1/launch-supervision.sh",
                readyMarkerPath: "/tmp/workstream-supervision-observe1/launch.ready",
                commandPath: "/tmp/workstream-supervision-observe1/opencode-command.sh",
                metadataPath: "/tmp/workstream-supervision-observe1/launch-metadata.json",
              },
            }
          },
        }),
      )

      expect(calls).toEqual([{ tmuxSessionName: "001-supervision-observe1" }])
      expect(result).toContain("Tmux session: 001-supervision-observe1")
      expect(result).toContain("tmux attach -t 001-supervision-observe1")
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions[0])
        .toMatchObject({ tmuxSessionName: "001-supervision-observe1" })
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions[0]?.notes)
        .toContain("Tmux observability:")
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions[0]?.notes)
        .toContain("/tmp/workstream-supervision-observe1/launch.ready")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("refuses duplicate supervision launches for the same active batch scope", async () => {
    const workspace = createTestWorkstream("001-agent-tool-duplicate-supervision")

    try {
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-existing",
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_existing",
            scope: {
              level: "batch",
              stageId: "10",
              batchId: "10.01",
            },
          },
          branchRole: "supervision",
          status: "running",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          tmuxSessionName: "001-supervision-dup001",
          batchId: "10.01",
          notes: "existing supervision branch",
        }),
      )

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async () => {
            throw new Error("should not launch duplicate supervision session")
          },
        }),
      )

      expect(result).toContain("Refusing duplicate supervision launch for batch 10.01")
      expect(result).toContain("branch-supervision-existing")
      expect(result).toContain("tmux attach -t 001-supervision-dup001")
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions).toHaveLength(1)
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("refuses duplicate supervision launches when an equivalent pending or running branch is still live", async () => {
    for (const status of ["pending", "running"] as const) {
      const workspace = createTestWorkstream(`001-agent-tool-duplicate-${status}`)

      try {
        await upsertBranchSessionLocked(
          workspace.repoRoot,
          workspace.streamId,
          buildRootAgentBranchSession({
            context: {
              rootSessionId: "root-session-1",
              branchSessionId: `branch-supervision-${status}`,
              parentSessionId: "root-session-1",
              nativeSessionId: `ses_supervision_${status}`,
              scope: {
                level: "batch",
                stageId: "10",
                batchId: "10.01",
              },
            },
            branchRole: "supervision",
            status,
            startedAt: "2026-04-12T00:00:00.000Z",
            updatedAt: "2026-04-12T00:00:00.000Z",
            tmuxSessionName: `001-supervision-${status}`,
            batchId: "10.01",
            notes: `existing ${status} supervision branch`,
          }),
        )

        const result = await executeLaunchSupervisionBranch(
          { batch: "10.01" },
          { sessionID: "root-session-1" },
          createDeps(workspace.repoRoot, workspace.streamId, {
            runForkedSession: async () => {
              throw new Error("should not launch duplicate supervision session")
            },
          }),
        )

        expect(result).toContain("Refusing duplicate supervision launch for batch 10.01")
        expect(result).toContain(`branch-supervision-${status}`)
      } finally {
        cleanupTestWorkstream(workspace)
      }
    }
  })

  test("allows relaunch after reconcile marks the prior stopped branch terminal", async () => {
    const workspace = createTestWorkstream("001-agent-tool-reconciled-stopped-relaunch")

    try {
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-reconciled",
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_reconciled",
            scope: {
              level: "batch",
              stageId: "10",
              batchId: "10.01",
            },
          },
          branchRole: "supervision",
          status: "stopped",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T01:00:00.000Z",
          completedAt: "2026-04-12T01:00:00.000Z",
          processEndedAt: "2026-04-12T01:00:00.000Z",
          finalizationSource: "parent_process_exit_reconciliation",
          finalizationReason: "session_missing_with_recovered_report",
          tmuxSessionName: "001-supervision-reconciled",
          batchId: "10.01",
          notes: "reconciled stopped supervision branch",
        }),
      )

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          createBranchSessionId: () => "branch-supervision-2",
          createSupervisionTmuxSessionName: () => "001-supervision-relaunch",
        }),
      )

      expect(result).toContain("branch-supervision-2")
      expect(result).not.toContain("Refusing duplicate supervision launch")
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions).toHaveLength(2)
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("still protects against legacy stopped branches that lack terminal reconciliation evidence", async () => {
    const workspace = createTestWorkstream("001-agent-tool-stopped-without-terminal-evidence")

    try {
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-stopped-legacy",
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_stopped_legacy",
            scope: {
              level: "batch",
              stageId: "10",
              batchId: "10.01",
            },
          },
          branchRole: "supervision",
          status: "stopped",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:30:00.000Z",
          tmuxSessionName: "001-supervision-stopped-legacy",
          batchId: "10.01",
          notes: "stopped branch without persisted terminal metadata",
        }),
      )

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async () => {
            throw new Error("should not launch duplicate supervision session")
          },
        }),
      )

      expect(result).toContain("Refusing duplicate supervision launch for batch 10.01")
      expect(result).toContain("branch-supervision-stopped-legacy")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("allows a different scope to launch even when another supervision branch is still active", async () => {
    const workspace = createTestWorkstream("001-agent-tool-distinct-scope-launch")

    try {
      await upsertBranchSessionLocked(
        workspace.repoRoot,
        workspace.streamId,
        buildRootAgentBranchSession({
          context: {
            rootSessionId: "root-session-1",
            branchSessionId: "branch-supervision-stage-10",
            parentSessionId: "root-session-1",
            nativeSessionId: "ses_supervision_stage_10",
            scope: {
              level: "stage",
              stageId: "10",
            },
          },
          branchRole: "supervision",
          status: "running",
          startedAt: "2026-04-12T00:00:00.000Z",
          updatedAt: "2026-04-12T00:00:00.000Z",
          tmuxSessionName: "001-supervision-stage10",
          notes: "existing stage supervision branch",
        }),
      )

      const result = await executeLaunchSupervisionBranch(
        { batch: "11.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          createBranchSessionId: () => "branch-supervision-2",
          createSupervisionTmuxSessionName: () => "001-supervision-batch1101",
        }),
      )

      expect(result).toContain("branch-supervision-2")
      expect(result).not.toContain("Refusing duplicate supervision launch")
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions).toHaveLength(2)
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("persists failed supervision launch state when tmux validation fails fast", async () => {
    const workspace = createTestWorkstream("001-agent-tool-launch-validation-fail")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          createSupervisionTmuxSessionName: () => "001-supervision-failfast",
          runForkedSession: async () => {
            throw new Error(
              "Supervision tmux launch validation failed for 001-supervision-failfast within 3000ms.\nAttach with `tmux attach -t 001-supervision-failfast` to inspect it.",
            )
          },
        }),
      )

      expect(result).toContain("failed to launch")
      expect(result).toContain("launch validation failed")
      expect(result).toContain("tmux attach -t 001-supervision-failfast")

      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions[0])
        .toMatchObject({
          status: "failed",
          tmuxSessionName: "001-supervision-failfast",
        })
      expect(loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions[0]?.notes)
        .toContain("launch validation failed")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("uses explicit prefer_tagged breakpoint mode in the real launch path", async () => {
    const workspace = createTestWorkstream("001-agent-tool-explicit-breakpoint")

    try {
      const result = await executeLaunchSupervisionBranch(
        {
          batch: "10.01",
          breakpointTags: "ROOT_BRANCH_BOUNDARY, ALT_BOUNDARY, ROOT_BRANCH_BOUNDARY",
          breakpointMode: "prefer_tagged",
        },
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
                      parts: [{ type: "text", text: "## Accomplished\n- execution result\n## Issues Found\n- None.\n## Fixes Applied\n- None.\n## What is Next\n- next action" }],
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

  test("uses explicit previous_user breakpoint mode and ignores older tags", async () => {
    const workspace = createTestWorkstream("001-agent-tool-previous-user-breakpoint-mode")

    try {
      const result = await executeLaunchSupervisionBranch(
        {
          batch: "10.01",
          breakpointMode: "previous_user",
        },
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
                      parts: [{ type: "text", text: "Pause here\nSESSION_BREAKPOINT" }],
                    },
                    {
                      info: { id: "msg-latest-user", role: "user" },
                      parts: [{ type: "text", text: "Use this latest untagged user request" }],
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
                      parts: [{ type: "text", text: "## What is Next\n- next action" }],
                    },
                  ],
                },
        }),
      )

      expect(result).toContain("from checkpoint pointer message msg-latest-user")
      expect(result).toContain(
        "Breakpoint selection: Selected the previous user message before launch message msg-root-launch because breakpoint mode was set to previous_user.",
      )
      expect(result).not.toContain('configured breakpoint tag "SESSION_BREAKPOINT"')

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        checkpointMessageId: "msg-latest-user",
        breakpointSelection: {
          strategy: "previous_user_before_launch",
          configuredTags: ["SESSION_BREAKPOINT"],
          launchMessageId: "msg-root-launch",
          launchMessageIndex: 2,
          rationale:
            "Selected the previous user message before launch message msg-root-launch because breakpoint mode was set to previous_user.",
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
                      parts: [{ type: "text", text: "## What is Next\n- next action" }],
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

      expect(result).toContain("Supervision session branch-supervision-1 (native session ses_supervision_1) stopped from checkpoint pointer message msg-root-checkpoint")
      expect(result).toContain("Persisted supervision status: stopped.")
      expect(result).toContain("Extracted final supervision report:")
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

  test("auto-reconciles after a short launch wait when process end is known but no terminal state was persisted", async () => {
    const workspace = createTestWorkstream("001-agent-tool-auto-reconcile-grace")
    const waitTimeouts: number[] = []

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ onNativeSessionId, tmuxSessionName }) => {
            await onNativeSessionId?.("ses_supervision_grace")

            await upsertBranchSessionLocked(
              workspace.repoRoot,
              workspace.streamId,
              buildRootAgentBranchSession({
                context: {
                  rootSessionId: "root-session-1",
                  branchSessionId: "branch-supervision-1",
                  parentSessionId: "root-session-1",
                  checkpointMessageId: "msg-root-checkpoint",
                  checkpointMessageIndex: 0,
                  checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
                  nativeSessionId: "ses_supervision_grace",
                  scope: { level: "batch", stageId: "10", batchId: "10.01" },
                },
                branchRole: "supervision",
                status: "running",
                startedAt: "2026-04-12T00:00:00.000Z",
                updatedAt: "2026-04-12T00:00:00.000Z",
                tmuxSessionName: tmuxSessionName ?? "001-supervision-test01",
                batchId: "10.01",
                notes: "child run ended without explicit finalization",
              }),
            )

            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"## What is Next\\n- recovered after launch wait"}}\n',
              stderr: "",
              nativeSessionId: "ses_supervision_grace",
              tmuxSessionName,
            }
          },
          waitForTerminalBranchSession: async (args) => {
            waitTimeouts.push(args.timeoutMs ?? -1)

            if ((args.timeoutMs ?? 0) > DEFAULT_BRANCH_TERMINAL_PERSIST_GRACE_MS) {
              throw new Error(`launch waited too long for terminal persistence: ${args.timeoutMs}`)
            }

            await new Promise((resolve) => setTimeout(resolve, 10))

            return loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions.find(
              (branch) => branch.branchSessionId === args.branchSessionId,
            )
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
                    id: "ses_supervision_grace",
                    title: "Supervision branch",
                    summary: { additions: 0, deletions: 0, files: 0 },
                  },
                  messages: [
                    {
                      info: { id: "msg-final", role: "assistant" },
                      parts: [
                        {
                          type: "text",
                          text: "## What is Next\n- recovered after launch wait",
                        },
                      ],
                    },
                  ],
                },
          extractFinalBranchReport: (sessionExport) =>
            sessionExport.messages.at(-1)?.parts?.[0]?.text ?? "",
        }),
      )

      expect(waitTimeouts).toEqual([DEFAULT_BRANCH_TERMINAL_PERSIST_GRACE_MS])
      expect(result).toContain(
        "Finalization handling: Parent-side reconciliation finalized the supervision session after process end because no explicit finalize_workstream_supervision call was persisted.",
      )
      expect(result).toContain(
        "Extracted final supervision report:\n## What is Next\n- recovered after launch wait",
      )

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "completed",
        nativeSessionId: "ses_supervision_grace",
        processExitCode: 0,
        finalizationSource: "parent_process_exit_reconciliation",
        finalizationReason: "ended_without_explicit_finalize",
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

  test("finalizes branch state even when child transcript export is unavailable", async () => {
    const workspace = createTestWorkstream("001-agent-tool-transcript-unavailable")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async () => ({
            code: 0,
            stdout: '{"type":"text","part":{"text":"stdout fallback summary"}}\n',
            stderr: "",
          }),
          waitForBranchNativeSessionId: async () => "ses_supervision_export_missing",
          exportSessionTranscript: async (sessionId) => {
            if (sessionId === "root-session-1") {
              return {
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
            }

            throw new Error("session export unavailable")
          },
          parseOutput: () => ({
            text: "stdout fallback summary",
            logs: [],
            success: true,
          }),
        }),
      )

      expect(result).toContain("native session ses_supervision_export_missing")
      expect(result).toContain("Transcript export unavailable: session export unavailable")
      expect(result).toContain("Process end evidence: tmux pane exited with status 0.")
      expect(result).toContain(
        "Finalization handling: Parent-side reconciliation finalized the supervision session after process end with exit code 0, but no usable finalization/report was persisted.",
      )
      expect(result).toContain("Supervision run summary:\nstdout fallback summary")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "completed",
        nativeSessionId: "ses_supervision_export_missing",
        processExitCode: 0,
        finalizationSource: "parent_process_exit_reconciliation",
        finalizationReason: "exit_zero_without_usable_finalization",
      })
      expect(stored?.branch_sessions[0]?.notes).toContain("stdout fallback summary")
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("marks the branch failed when the tmux-hosted run ends nonzero without explicit finalization", async () => {
    const workspace = createTestWorkstream("001-agent-tool-nonzero-exit")

    try {
      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async () => ({
            code: 17,
            stdout: "",
            stderr: "branch process exited with code 17",
            nativeSessionId: "ses_supervision_nonzero",
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
                    id: "ses_supervision_nonzero",
                    title: "Supervision branch",
                    summary: { additions: 0, deletions: 0, files: 0 },
                  },
                  messages: [],
                },
        }),
      )

      expect(result).toContain(
        "Supervision session branch-supervision-1 (native session ses_supervision_nonzero) failed",
      )
      expect(result).toContain("Process end evidence: tmux pane exited with status 17.")
      expect(result).toContain(
        "Finalization handling: Parent-side reconciliation marked the supervision session failed after observing a nonzero tmux process exit.",
      )

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]).toMatchObject({
        status: "failed",
        nativeSessionId: "ses_supervision_nonzero",
        processExitCode: 17,
        finalizationSource: "parent_process_exit_reconciliation",
        finalizationReason: "nonzero_exit",
      })
      expect(stored?.branch_sessions[0]?.notes).toContain(
        "Authoritative process-end evidence: tmux pane exited with status 17.",
      )
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("preserves explicit finalization status and completedAt when a later tmux exit is nonzero", async () => {
    const workspace = createTestWorkstream("001-agent-tool-explicit-finalize-precedence")

    try {
      const explicitCompletedAt = "2026-04-12T00:30:00.000Z"
      const reconciledAt = "2026-04-12T02:00:00.000Z"

      const result = await executeLaunchSupervisionBranch(
        { batch: "10.01" },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          now: () => reconciledAt,
          runForkedSession: async ({ onNativeSessionId, tmuxSessionName }) => {
            await onNativeSessionId?.("ses_supervision_explicit")
            await upsertBranchSessionLocked(
              workspace.repoRoot,
              workspace.streamId,
              buildRootAgentBranchSession({
                context: {
                  rootSessionId: "root-session-1",
                  branchSessionId: "branch-supervision-1",
                  parentSessionId: "root-session-1",
                  checkpointMessageId: "msg-root-checkpoint",
                  checkpointMessageIndex: 0,
                  checkpointCreatedAt: "2026-04-12T00:00:00.000Z",
                  nativeSessionId: "ses_supervision_explicit",
                  scope: { level: "batch", stageId: "10", batchId: "10.01" },
                },
                branchRole: "supervision",
                status: "completed",
                startedAt: "2026-04-12T00:00:00.000Z",
                updatedAt: explicitCompletedAt,
                completedAt: explicitCompletedAt,
                tmuxSessionName: tmuxSessionName ?? "001-supervision-test01",
                batchId: "10.01",
                finalizationSource: "explicit_finalize",
                finalizationReason: "persisted_terminal_status",
                notes: "Summary:\nExplicit finalize won the race.",
              }),
            )

            return {
              code: 17,
              stdout: "",
              stderr: "",
              nativeSessionId: "ses_supervision_explicit",
              tmuxSessionName,
            }
          },
          waitForTerminalBranchSession: async () =>
            loadSupervisorState(workspace.repoRoot, workspace.streamId)?.branch_sessions.find(
              (branch) => branch.branchSessionId === "branch-supervision-1",
            ),
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
                    id: "ses_supervision_explicit",
                    title: "Supervision branch",
                    summary: { additions: 0, deletions: 0, files: 0 },
                  },
                  messages: [
                    {
                      info: { id: "msg-final", role: "assistant" },
                      parts: [
                        { type: "text", text: "## What is Next\n- explicit finalize already persisted" },
                      ],
                    },
                  ],
                },
        }),
      )

      expect(result).toContain(
        "Supervision session branch-supervision-1 (native session ses_supervision_explicit) completed",
      )
      expect(result).toContain("Process end evidence: tmux pane exited with status 17.")
      expect(result).toContain(
        "Finalization handling: Explicit supervision finalization was already persisted before parent-side reconciliation.",
      )
      expect(result).toContain(
        "Extracted final supervision report:\n## What is Next\n- explicit finalize already persisted",
      )

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions[0]?.status).toBe("completed")
      expect(stored?.branch_sessions[0]?.nativeSessionId).toBe("ses_supervision_explicit")
      expect(stored?.branch_sessions[0]?.completedAt).toBe(explicitCompletedAt)
      expect(stored?.branch_sessions[0]?.updatedAt).toBe(reconciledAt)
      expect(stored?.branch_sessions[0]?.processEndedAt).toBe(reconciledAt)
      expect(stored?.branch_sessions[0]?.processExitCode).toBe(17)
      expect(stored?.branch_sessions[0]?.finalizationSource).toBe("explicit_finalize")
      expect(stored?.branch_sessions[0]?.finalizationReason).toBe("persisted_terminal_status")
      expect(stored?.branch_sessions[0]?.notes).toContain(
        "Persisted explicit supervision finalization takes precedence over the later observed nonzero tmux process exit (17)",
      )
      expect(stored?.branch_sessions[0]?.notes).toContain(
        "Authoritative process-end evidence: tmux pane exited with status 17.",
      )
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
      expect(calls[0]?.prompt).toContain("Keep this supervision session focused on one bounded batch supervision pass.")
      expect(calls[0]?.prompt).not.toContain("--timeout-ms")
      expect(calls[0]?.prompt).not.toContain("--poll-interval-ms")
      expect(calls[0]?.prompt).toContain("## Accomplished")
      expect(calls[0]?.prompt).toContain("## What is Next")
      expect(calls[0]?.prompt).toContain(
        "In What is Next, please let me know what I need to do to test, verify or review the implementation, or if there are any alignment issues or design decisions to consider before starting the next implementation batch.",
      )
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
          target: "10",
        },
        { sessionID: "root-session-1" },
        createDeps(workspace.repoRoot, workspace.streamId, {
          runForkedSession: async ({ prompt }) => {
            calls.push({ prompt })

            return {
              code: 0,
              stdout: '{"type":"text","part":{"text":"## What is Next\\n- Stage 10 complete."}}\n',
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
                      parts: [{ type: "text", text: "## What is Next\n- Stage 10 complete." }],
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
      expect(calls[0]?.prompt).toContain('In What is Next, please let me know what I need to do to test, verify or review the implementation, or if there are any alignment issues or design decisions to consider before starting the next implementation stage.')
      expect(calls[0]?.prompt).not.toContain("Branch scope:")
      expect(calls[0]?.prompt).not.toContain("--root-session-id")
      expect(calls[0]?.prompt).not.toContain("--checkpoint-message-id")
      expect(result).toContain("## What is Next\n- Stage 10 complete.")

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
              stdout: '{"type":"text","part":{"text":"## What is Next\\n- Continue."}}\n',
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

  test("requires a stage target for stage-scoped launches", async () => {
    const workspace = createTestWorkstream("001-agent-tool-stage-scope-requires-target")

    try {
      await expect(
        executeLaunchSupervisionBranch(
          {
            scope: "stage",
          },
          { sessionID: "root-session-1" },
          createDeps(workspace.repoRoot, workspace.streamId),
        ),
      ).rejects.toThrow(
        "Stage scope requires --target with a stage id (for example: 10).",
      )
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })

  test("rejects non stage-qualified batch targets in the new contract", async () => {
    const workspace = createTestWorkstream("001-agent-tool-batch-scope-invalid-target")

    try {
      await expect(
        executeLaunchSupervisionBranch(
          {
            scope: "batch",
            target: "10",
          },
          { sessionID: "root-session-1" },
          createDeps(workspace.repoRoot, workspace.streamId),
        ),
      ).rejects.toThrow(
        'Batch scope requires a stage-qualified batch id (received "10").',
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
                      parts: [{ type: "text", text: "## What is Next\n- Batch 10.01 is done." }],
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
      expect(result).toContain("Extracted final supervision report:")
      expect(result).toContain("## What is Next\n- Batch 10.01 is done.")
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
              stdout: '{"type":"text","part":{"text":"## What is Next\\n- Batch 10.01 is done."}}\n',
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
                      parts: [{ type: "text", text: "## What is Next\n- Batch 10.01 is done." }],
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

  test("runMessageBoundaryForkLaunch issues the expected HTTP fork/title requests and runs the child session headlessly", async () => {
    const calls: Array<{ method: string; path: string; body: any }> = []
    const commandCalls: Array<{ command: string; args: string[]; cwd: string }> = []
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
        runCommand: async (command: string, args: string[], cwd: string) => {
          commandCalls.push({ command, args, cwd })
          events.push(`run:${args[2]}`)
          return {
            code: 0,
            stdout: '{"type":"text","part":{"text":"## What is Next\\n- done"}}\n',
            stderr: "",
          }
        },
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

          return { ok: true }
        },
      },
    )

    expect(result).toEqual({
      code: 0,
      stdout: '{"type":"text","part":{"text":"## What is Next\\n- done"}}\n',
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
    ])
    expect(commandCalls).toEqual([
      {
        command: "opencode",
        args: [
          "run",
          "--session",
          "ses_child_123",
          "--dir",
          "/repo/root",
          "Please supervise batch 10.01 for this workstream.",
        ],
        cwd: "/repo/root",
      },
    ])
    expect(events).toEqual(["native:ses_child_123", "close", "run:ses_child_123"])
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
          runCommand: async () => {
            throw new Error("runCommand should not be called")
          },
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

describe("runForkedSessionInTmux", () => {
  const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0

  async function createFakeOpencodeFixture(scriptBody: string) {
    const tempRoot = await mkdtemp(join(tmpdir(), "workstream-fake-opencode-"))
    const fakeBin = join(tempRoot, "bin")
    const repoRoot = join(tempRoot, "repo")
    const opencodePath = join(fakeBin, "opencode")

    await mkdir(fakeBin, { recursive: true })
    await mkdir(repoRoot, { recursive: true })
    await writeFile(opencodePath, `#!/bin/sh\n${scriptBody}\n`)
    await chmod(opencodePath, 0o755)

    return {
      repoRoot,
      tempRoot,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true })
      },
    }
  }

  test.if(hasTmux)("records launch metadata and validates wrapper readiness", async () => {
    const fixture = await createFakeOpencodeFixture([
      'if [ "$1" = "run" ]; then',
      '  printf \'{"type":"text","part":{"text":"## What is Next\\n- tmux ok"}}\\n\'',
      '  sleep 1',
      '  exit 0',
      'fi',
      'echo "unexpected args: $*" >&2',
      'exit 1',
    ].join("\n"))
    const sessionName = `test-supervision-${Date.now().toString(36)}`
    const originalPath = process.env.PATH

    try {
      process.env.PATH = `${join(fixture.tempRoot, "bin")}:${originalPath ?? ""}`

      const result = await runForkedSessionInTmux(
        {
          sessionId: "root-session-1",
          repoRoot: fixture.repoRoot,
          title: "root-supervision-001-branch-supervision-1",
          prompt: "Please supervise batch 10.01",
          tmuxSessionName: sessionName,
        },
        {
          findNativeSessionIdByTitle: async () => "ses_tmux_test_1",
        },
      )

      expect(result.code).toBe(0)
      expect(result.nativeSessionId).toBe("ses_tmux_test_1")
      expect(result.tmuxSessionName).toBe(sessionName)
      expect(result.tmuxMetadata?.sessionName).toBe(sessionName)
      expect(result.tmuxMetadata?.attachCommand).toBe(`tmux attach -t ${sessionName}`)
      expect(existsSync(result.tmuxMetadata!.readyMarkerPath)).toBe(true)
      expect(readFileSync(result.tmuxMetadata!.commandPath, "utf-8")).toContain(
        'exec opencode "$@"',
      )
      expect(readFileSync(result.tmuxMetadata!.wrapperPath, "utf-8")).toContain(
        "'run' '--session' 'root-session-1' '--fork'",
      )
      expect(result.stdout).toContain("tmux ok")
    } finally {
      process.env.PATH = originalPath
      Bun.spawnSync(["tmux", "kill-session", "-t", sessionName])
      await fixture.cleanup()
    }
  })

  test.if(hasTmux)("creates a live tmux session before the mocked opencode run exits", async () => {
    const fixture = await createFakeOpencodeFixture([
      'if [ "$1" = "run" ]; then',
      '  printf \'{"type":"text","part":{"text":"## What is Next\\n- tmux live"}}\\n\'',
      '  sleep 2',
      '  exit 0',
      'fi',
      'echo "unexpected args: $*" >&2',
      'exit 1',
    ].join("\n"))
    const sessionName = `test-supervision-live-${Date.now().toString(36)}`
    const originalPath = process.env.PATH

    try {
      process.env.PATH = `${join(fixture.tempRoot, "bin")}:${originalPath ?? ""}`

      const launchPromise = runForkedSessionInTmux(
        {
          sessionId: "root-session-1",
          repoRoot: fixture.repoRoot,
          title: "root-supervision-001-branch-supervision-live",
          prompt: "Please supervise batch 10.01",
          tmuxSessionName: sessionName,
        },
        {
          findNativeSessionIdByTitle: async () => "ses_tmux_test_live_1",
        },
      )

      let sawLiveSession = false
      const startedAt = Date.now()
      while (Date.now() - startedAt < 5000) {
        const hasSession = nodeSpawnSync("tmux", ["has-session", "-t", sessionName], {
          stdio: "ignore",
        }).status === 0

        if (hasSession) {
          const paneState = nodeSpawnSync(
            "tmux",
            ["list-panes", "-t", sessionName, "-F", "#{pane_dead}:#{pane_current_command}"],
            { encoding: "utf-8" },
          )
          const [paneLine] = (paneState.stdout ?? "").trim().split("\n")
          if (paneLine?.startsWith("0:")) {
            sawLiveSession = true
            break
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      expect(sawLiveSession).toBe(true)

      const result = await launchPromise
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("tmux live")
    } finally {
      process.env.PATH = originalPath
      Bun.spawnSync(["tmux", "kill-session", "-t", sessionName])
      await fixture.cleanup()
    }
  })

  test.if(hasTmux)("treats a vanished tmux session as an error instead of implicit success", async () => {
    const sessionName = `test-supervision-vanish-${Date.now().toString(36)}`

    try {
      const createResult = nodeSpawnSync(
        "tmux",
        ["new-session", "-d", "-s", sessionName, "-n", "supervision", "sleep", "5"],
        { encoding: "utf-8" },
      )
      expect(createResult.status).toBe(0)

      const waitPromise = waitForTmuxSessionExit(sessionName, 2000)
      await new Promise((resolve) => setTimeout(resolve, 100))

      const killResult = nodeSpawnSync("tmux", ["kill-session", "-t", sessionName], {
        encoding: "utf-8",
      })
      expect(killResult.status).toBe(0)

      await expect(waitPromise).rejects.toThrow(
        `Supervision tmux session "${sessionName}" vanished before an exit status could be observed.`,
      )
      await expect(waitPromise).rejects.toThrow(
        "This is not treated as implicit success; inspect tmux/server lifecycle and supervision logs for the missing process-end evidence.",
      )
    } finally {
      Bun.spawnSync(["tmux", "kill-session", "-t", sessionName])
    }
  })
})
