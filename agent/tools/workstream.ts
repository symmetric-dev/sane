// @ts-nocheck
import { tool } from "@opencode-ai/plugin"
import { spawn } from "child_process"
import {
  getResolvedStream,
  loadIndex,
} from "../../packages/workstreams/src/lib/index.ts"
import {
  buildRootAgentBranchSession,
  createRootAgentBranchSessionId,
} from "../../packages/workstreams/src/lib/root-agent-branch.ts"
import {
  loadSupervisorState,
  upsertBranchSessionLocked,
} from "../../packages/workstreams/src/lib/supervisor-state.ts"
import { parseSynthesisJsonl } from "../../packages/workstreams/src/lib/synthesis/output.ts"

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("error", reject)
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function findNativeSessionIdByTitle(repoRoot: string, title: string): Promise<string | undefined> {
  const result = await runCommand(
    "opencode",
    ["session", "list", "--max-count", "50", "--format", "json"],
    repoRoot,
  )

  if (result.code !== 0) {
    return undefined
  }

  try {
    const sessions = JSON.parse(result.stdout) as Array<{ id: string; title: string }>
    return sessions.find((session) => session.title === title)?.id
  } catch {
    return undefined
  }
}

export interface LaunchSupervisionBranchDeps {
  getRepoRoot: () => string
  getResolvedStreamId: (repoRoot: string, streamId?: string) => string
  createBranchSessionId: () => string
  persistBranchSession: typeof upsertBranchSessionLocked
  loadStoredBranchSession: (repoRoot: string, streamId: string, branchSessionId: string) => any
  runForkedBranch: (args: {
    rootSessionId: string
    repoRoot: string
    title: string
    prompt: string
    onNativeSessionId?: (nativeSessionId: string) => Promise<void> | void
  }) => Promise<{ code: number; stdout: string; stderr: string; nativeSessionId?: string }>
  runCommand: typeof runCommand
  findNativeSessionIdByTitle: typeof findNativeSessionIdByTitle
  parseOutput: typeof parseSynthesisJsonl
  now: () => string
}

function getDefaultLaunchSupervisionBranchDeps(): LaunchSupervisionBranchDeps {
  return {
    getRepoRoot: () => process.cwd(),
    getResolvedStreamId: (repoRoot, streamId) => getResolvedStream(loadIndex(repoRoot), streamId).id,
    createBranchSessionId: () => createRootAgentBranchSessionId("supervision"),
    persistBranchSession: upsertBranchSessionLocked,
    loadStoredBranchSession: (repoRoot, streamId, branchSessionId) =>
      loadSupervisorState(repoRoot, streamId)?.branch_sessions.find(
        (branch) => branch.branchSessionId === branchSessionId,
      ),
    runForkedBranch: async ({ rootSessionId, repoRoot, title, prompt, onNativeSessionId }) => {
      const child = spawn(
        "opencode",
        [
          "run",
          "--session",
          rootSessionId,
          "--fork",
          "--dir",
          repoRoot,
          "--title",
          title,
          "--format",
          "json",
          prompt,
        ],
        {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        },
      )

      let stdout = ""
      let stderr = ""
      let nativeSessionId: string | undefined
      let stopped = false
      let pollError: unknown
      let pollPromise: Promise<void> | undefined

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString()
      })

      if (onNativeSessionId) {
        pollPromise = (async () => {
          while (!stopped && !nativeSessionId) {
            try {
              const foundSessionId = await findNativeSessionIdByTitle(repoRoot, title)
              if (foundSessionId) {
                nativeSessionId = foundSessionId
                await onNativeSessionId(foundSessionId)
                return
              }
            } catch (error) {
              pollError = error
              return
            }

            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        })()
      }

      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        child.on("error", reject)
        child.on("close", (code) => {
          stopped = true
          resolve({ code: code ?? 1, stdout, stderr })
        })
      })

      await pollPromise

      if (pollError) {
        throw pollError
      }

      if (!nativeSessionId) {
        nativeSessionId = await findNativeSessionIdByTitle(repoRoot, title)
      }

      return {
        ...result,
        ...(nativeSessionId ? { nativeSessionId } : {}),
      }
    },
    runCommand,
    findNativeSessionIdByTitle,
    parseOutput: parseSynthesisJsonl,
    now: () => new Date().toISOString(),
  }
}

function getTerminalBranchStatus(storedStatus: string | undefined, runCode: number): "completed" | "stopped" | "failed" {
  if (storedStatus === "completed" || storedStatus === "stopped" || storedStatus === "failed") {
    return storedStatus
  }

  return runCode === 0 ? "completed" : "failed"
}

async function persistSupervisionBranchState(args: {
  deps: LaunchSupervisionBranchDeps
  repoRoot: string
  streamId: string
  rootSessionId: string
  branchSessionId: string
  nativeSessionId?: string
  status: "pending" | "running" | "completed" | "stopped" | "failed"
  startedAt: string
  updatedAt: string
  completedAt?: string
  batchId?: string
  runId?: string
  notes: string
}): Promise<void> {
  await args.deps.persistBranchSession(
    args.repoRoot,
    args.streamId,
    buildRootAgentBranchSession({
      context: {
        rootSessionId: args.rootSessionId,
        branchSessionId: args.branchSessionId,
        parentSessionId: args.rootSessionId,
        ...(args.nativeSessionId ? { nativeSessionId: args.nativeSessionId } : {}),
        source: args.nativeSessionId ? "native_fork" : "repo_local_fallback",
      },
      branchRole: "supervision",
      status: args.status,
      startedAt: args.startedAt,
      updatedAt: args.updatedAt,
      completedAt: args.completedAt,
      runId: args.runId,
      batchId: args.batchId,
      notes: args.notes,
    }),
  )
}

export async function executeLaunchSupervisionBranch(
  args: {
    streamId?: string
    batch?: string
    timeoutMs?: number
    pollIntervalMs?: number
    noServer?: boolean
    silent?: boolean
  },
  context: { sessionID?: string },
  deps: LaunchSupervisionBranchDeps = getDefaultLaunchSupervisionBranchDeps(),
): Promise<string> {
  const rootSessionId = context.sessionID

  if (!rootSessionId) {
    return "Error: Could not determine current Root Agent session ID"
  }

  const repoRoot = deps.getRepoRoot()
  const streamId = deps.getResolvedStreamId(repoRoot, args.streamId)
  const branchSessionId = deps.createBranchSessionId()
  const title = `root-supervision-${streamId}-${branchSessionId}`
  const startedAt = deps.now()

  await persistSupervisionBranchState({
    deps,
    repoRoot,
    streamId,
    rootSessionId,
    branchSessionId,
    status: "pending",
    startedAt,
    updatedAt: startedAt,
    batchId: args.batch,
    notes: `Launching Root Agent supervision branch for ${args.batch ?? "next resumable batch"}.`,
  })

  const promptLines = [
    "You are a Root Agent supervision branch.",
    "Use the implementing-workstreams skill.",
    "",
    "Run this exact command:",
    `work supervise --repo-root \"${repoRoot}\" --stream \"${streamId}\"${args.batch ? ` --batch \"${args.batch}\"` : ""}${args.timeoutMs !== undefined ? ` --timeout-ms ${args.timeoutMs}` : ""}${args.pollIntervalMs !== undefined ? ` --poll-interval-ms ${args.pollIntervalMs}` : ""}${args.noServer ? " --no-server" : ""}${args.silent ? " --silent" : ""} --root-session-id \"${rootSessionId}\" --branch-session-id \"${branchSessionId}\" --parent-session-id \"${rootSessionId}\"`,
    "",
    "After the command completes:",
    "- summarize the persisted batch handoff state for the Root Agent",
    "- state whether the Root Agent should continue, inspect, or escalate to the user",
    "- treat any escalation as escalation to the Root Agent first, not directly to the user",
    "",
    "Return exactly 3 short bullets: execution result, persisted state, recommended Root Agent next action.",
  ]

  try {
    const runResult = await deps.runForkedBranch({
      rootSessionId,
      repoRoot,
      title,
      prompt: promptLines.join("\n"),
      onNativeSessionId: async (nativeSessionId) => {
        const updatedAt = deps.now()
        const storedBranch = deps.loadStoredBranchSession(repoRoot, streamId, branchSessionId)

        await persistSupervisionBranchState({
          deps,
          repoRoot,
          streamId,
          rootSessionId,
          branchSessionId,
          nativeSessionId,
          status: storedBranch?.status === "running" ? "running" : "pending",
          startedAt: storedBranch?.startedAt ?? startedAt,
          updatedAt,
          runId: storedBranch?.runId,
          batchId: storedBranch?.batchId ?? args.batch,
          notes:
            storedBranch?.notes ??
            `Launching Root Agent supervision branch for ${args.batch ?? "next resumable batch"}.`,
        })
      },
    })

    const nativeSessionId = runResult.nativeSessionId

    const parsed = deps.parseOutput(runResult.stdout)
    const summary =
      parsed.text.trim() || runResult.stderr.trim() || "(branch session produced no summary)"
    const storedBranch = deps.loadStoredBranchSession(repoRoot, streamId, branchSessionId)
    const completedAt = deps.now()
    const status = getTerminalBranchStatus(storedBranch?.status, runResult.code)

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      nativeSessionId,
      status,
      startedAt: storedBranch?.startedAt ?? startedAt,
      updatedAt: completedAt,
      completedAt,
      runId: storedBranch?.runId,
      batchId: storedBranch?.batchId ?? args.batch,
      notes: summary,
    })

    if (runResult.code !== 0) {
      return `Supervision branch ${branchSessionId} failed${nativeSessionId ? ` (native session ${nativeSessionId})` : ""}.\n\n${summary}`
    }

    return `Supervision branch ${branchSessionId}${nativeSessionId ? ` (native session ${nativeSessionId})` : ""} completed.\n\n${summary}`
  } catch (error: any) {
    const failedAt = deps.now()

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      status: "failed",
      startedAt,
      updatedAt: failedAt,
      completedAt: failedAt,
      batchId: args.batch,
      notes: `Failed to launch Root Agent supervision branch: ${error?.message || error}`,
    })

    return `Supervision branch ${branchSessionId} failed to launch.\n\n${error?.message || error}`
  }
}

/**
 * Link the current session to a workstream as its planning session.
 * 
 * Usage: After creating a workstream with `work create`, use this tool
 * to link the current opencode session as the planning session.
 */
export const link_planning_session = tool({
  description: "Link the current opencode session to a workstream as its planning session. Use this after creating a workstream to enable resuming this conversation later with 'work plan'.",
  args: {
    streamId: tool.schema.string().describe("The workstream ID or name (e.g., '012-my-feature' or 'my-feature'). If omitted, uses the current workstream.").optional(),
  },
  async execute(args, context) {
    const sessionId = context.sessionID
    
    if (!sessionId) {
      return "Error: Could not determine current session ID"
    }

    // Build the command
    const cmdArgs = ["plan", "--set", sessionId]
    if (args.streamId) {
      cmdArgs.push("--stream", args.streamId)
    }

    try {
      const result = await Bun.$`work ${cmdArgs}`.text()
      return result.trim()
    } catch (error: any) {
      return `Error linking session: ${error.message || error}`
    }
  },
})

/**
 * Get information about the current workstream.
 */
export const current_workstream = tool({
  description: "Get information about the current workstream, including its ID, name, and planning session status.",
  args: {},
  async execute() {
    try {
      const result = await Bun.$`work current`.text()
      return result.trim()
    } catch (error: any) {
      return `Error getting current workstream: ${error.message || error}`
    }
  },
})

export const launch_supervision_branch = tool({
  description: "Fork the current Root Agent session into a supervision child session, record durable workstream lineage metadata, and return the branch handoff summary.",
  args: {
    streamId: tool.schema.string().describe("The workstream ID or name. If omitted, uses the current workstream.").optional(),
    batch: tool.schema.string().describe("Optional batch ID to supervise (e.g. 10.01). If omitted, the helper resumes the next resumable batch.").optional(),
    timeoutMs: tool.schema.number().describe("Optional wait timeout in milliseconds for work supervise.").optional(),
    pollIntervalMs: tool.schema.number().describe("Optional poll interval in milliseconds for work supervise.").optional(),
    noServer: tool.schema.boolean().describe("Skip starting opencode serve for the headless batch launch.").optional(),
    silent: tool.schema.boolean().describe("Disable notification sounds during batch execution.").optional(),
  },
  async execute(args, context) {
    return executeLaunchSupervisionBranch(args, context)
  },
})
