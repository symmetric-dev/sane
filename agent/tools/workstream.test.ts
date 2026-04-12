import { beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSupervisorState, upsertBranchSessionLocked } from "../../packages/workstreams/src/lib/supervisor-state.ts"
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
    createBranchSessionId: () => "branch-supervision-1",
    buildBranchSession: buildRootAgentBranchSession,
    persistBranchSession: upsertBranchSessionLocked,
    loadStoredBranchSession: (root, stream, branchSessionId) =>
      loadSupervisorState(root, stream)?.branch_sessions.find(
        (branch) => branch.branchSessionId === branchSessionId,
      ),
    runForkedBranch: async () => ({
      code: 0,
      stdout: '{"type":"text","part":{"text":"- execution result\\n- persisted state\\n- next action"}}\n',
      stderr: "",
      nativeSessionId: "ses_supervision_1",
    }),
    runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
    findNativeSessionIdByTitle: async () => "ses_supervision_1",
    parseOutput: () => ({
      text: "- execution result\n- persisted state\n- next action",
      logs: [],
      success: true,
    }),
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

      expect(result).toContain("Supervision branch branch-supervision-1 (native session ses_supervision_1) completed")

      const stored = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(stored?.branch_sessions).toHaveLength(1)
      expect(stored?.branch_sessions[0]).toMatchObject({
        rootSessionId: "root-session-1",
        branchSessionId: "branch-supervision-1",
        nativeSessionId: "ses_supervision_1",
        source: "native_fork",
        status: "completed",
        batchId: "10.01",
      })
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
          runForkedBranch: async ({ onNativeSessionId }) => {
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
    } finally {
      cleanupTestWorkstream(workspace)
    }
  })
})
