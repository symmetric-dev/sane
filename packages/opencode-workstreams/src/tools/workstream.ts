import { tool } from "@opencode-ai/plugin"
import { spawnSync } from "child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath, pathToFileURL } from "url"

import {
  getResolvedStream,
  getTasksByThread,
  loadIndex,
  parseThreadId,
  updateThreadMetadataLocked,
} from "@agenv/workstreams"
import type {
  FinalizeWorkstreamRuntimeDeps,
  FinalizeWorkstreamSupervisionArgs,
  FinalizeWorkstreamSupervisionDeps,
  LaunchSupervisionBranchDeps,
  LaunchSupervisionRuntimeDeps,
  ReconcileWorkstreamRuntimeDeps,
  ReconcileWorkstreamSupervisionArgs,
  ReconcileWorkstreamSupervisionDeps,
  SupervisionTerminalStatus,
  WorkstreamsToolRuntimeInfo,
  WorkstreamsToolRuntimeLoadOptions as PackageWorkstreamsToolRuntimeLoadOptions,
  WorkstreamsToolRuntimeModule,
} from "@agenv/workstreams/tool-runtime"

const WORKSTREAM_TOOL_VERSION = "2026-04-14-supervision-tmux-fix-v1"
const DEFAULT_WORKSTREAM_TOOL_LOG_PATH = "/tmp/agenv-workstream-tool.log"

const WORKSTREAM_TOOL_CAPABILITIES: WorkstreamsToolRuntimeInfo["capabilities"] = {
  fakeUserPrompt: true,
  metadataOnlyCheckpoints: true,
  messageBoundaryFork: true,
  breakpointTags: true,
  breakpointModes: true,
  autoResolvedBranchSupervisionContext: true,
}

interface WorkstreamsRuntimeResolutionOptions {
  resolveWorkCommandPath?: () => string
}

interface WorkstreamsRuntimeLoadOptions extends WorkstreamsRuntimeResolutionOptions {
  cache?: boolean
}

type WorkstreamsToolRuntimeLoader = Pick<
  typeof import("@agenv/workstreams/tool-runtime"),
  | "createResolvedWorkstreamsToolRuntimeInfo"
  | "loadWorkstreamsToolRuntime"
  | "resolveWorkstreamsRuntimeModulePath"
>

type LaunchSupervisionBranchArgs = {
  streamId?: string
  scope?: string
  target?: string
  stage?: string
  batch?: string
  breakpointTags?: string
  breakpointMode?: string
  noServer?: boolean
  silent?: boolean
}

type WorkstreamsToolRuntime = FinalizeWorkstreamRuntimeDeps &
  ReconcileWorkstreamRuntimeDeps &
  LaunchSupervisionRuntimeDeps & {
    formatWorkstreamsToolRuntimeInfo?: (info: WorkstreamsToolRuntimeInfo) => string
    createDefaultFinalizeWorkstreamSupervisionDeps: (
      runtime: FinalizeWorkstreamRuntimeDeps,
      options?: {
        getRepoRoot?: () => string
        now?: () => string
      },
    ) => FinalizeWorkstreamSupervisionDeps
    executeFinalizeWorkstreamSupervision: (
      args: FinalizeWorkstreamSupervisionArgs,
      context: { sessionID?: string },
      deps: FinalizeWorkstreamSupervisionDeps,
    ) => Promise<string>
    createDefaultReconcileWorkstreamSupervisionDeps: (
      runtime: ReconcileWorkstreamRuntimeDeps,
      options?: {
        getRepoRoot?: () => string
        now?: () => string
      },
    ) => ReconcileWorkstreamSupervisionDeps
    executeReconcileWorkstreamSupervision: (
      args: ReconcileWorkstreamSupervisionArgs,
      context: { sessionID?: string },
      deps: ReconcileWorkstreamSupervisionDeps,
    ) => Promise<string>
    createDefaultLaunchSupervisionBranchDeps: (
      runtime: LaunchSupervisionRuntimeDeps,
      options?: {
        getRepoRoot?: () => string
        now?: () => string
      },
    ) => LaunchSupervisionBranchDeps
    executeLaunchSupervisionBranch: (
      args: LaunchSupervisionBranchArgs,
      context: { sessionID?: string },
      deps: LaunchSupervisionBranchDeps,
    ) => Promise<string>
  }

function logWorkstreamToolEvent(component: string, step: string, details?: Record<string, unknown>): void {
  const logPath = process.env.WORKSTREAM_TOOL_LOG_PATH?.trim() || DEFAULT_WORKSTREAM_TOOL_LOG_PATH

  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        component,
        step,
        ...(details ? { details } : {}),
      })}\n`,
      "utf-8",
    )
  } catch {
    // Logging must never break the tool entrypoint.
  }
}

function getWorkstreamToolLogPath(): string {
  return process.env.WORKSTREAM_TOOL_LOG_PATH?.trim() || DEFAULT_WORKSTREAM_TOOL_LOG_PATH
}

function formatToolExecutionError(operation: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return [`Error ${operation}: ${message}`, `Debug log: ${getWorkstreamToolLogPath()}`].join("\n")
}

function resolveWorkCommandPath(): string {
  logWorkstreamToolEvent("agent.tools.workstream", "resolveWorkCommandPath:before")
  const result = spawnSync("which", ["work"], {
    encoding: "utf-8",
  })

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Could not find 'work' binary on PATH").trim())
  }

  const resolvedPath = result.stdout?.trim()
  if (!resolvedPath) {
    throw new Error("Could not resolve active 'work' binary from PATH")
  }

  logWorkstreamToolEvent("agent.tools.workstream", "resolveWorkCommandPath:after", {
    resolvedPath,
  })
  return resolvedPath
}

function getToolFilePath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return undefined
  }
}

function findWorkstreamsPackageRoot(binaryPath: string): string {
  let currentDir = dirname(realpathSync(binaryPath))

  while (true) {
    const packageJsonPath = join(currentDir, "package.json")
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
          name?: string
        }
        if (packageJson.name === "@agenv/workstreams") {
          return currentDir
        }
      } catch {
        // Ignore unreadable package metadata while walking upward.
      }
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }

  throw new Error(
    `Could not find @agenv/workstreams package root from active work binary: ${binaryPath}`,
  )
}

function resolvePackageSideSupportModulePath(options: WorkstreamsRuntimeResolutionOptions = {}): string {
  const workCommandPath = (options.resolveWorkCommandPath ?? resolveWorkCommandPath)()
  const resolvedBinaryPath = realpathSync(workCommandPath)
  const packageRoot = findWorkstreamsPackageRoot(resolvedBinaryPath)
  const preferDistSupportModule = resolvedBinaryPath.includes(`${join("dist", "bin")}`)

  const candidates = preferDistSupportModule
    ? [
        join(packageRoot, "dist", "src", "tool-runtime-loader.js"),
        join(packageRoot, "src", "tool-runtime-loader.ts"),
      ]
    : [
        join(packageRoot, "src", "tool-runtime-loader.ts"),
        join(packageRoot, "dist", "src", "tool-runtime-loader.js"),
      ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Could not locate workstream tool runtime loader next to active work binary. Checked: ${candidates.join(", ")}`,
  )
}

let cachedWorkstreamsToolRuntimeLoaderPromise: Promise<WorkstreamsToolRuntimeLoader> | undefined

function resetWorkstreamsToolRuntimeCache(): void {
  cachedWorkstreamsToolRuntimeLoaderPromise = undefined
}

async function loadWorkstreamsToolRuntimeLoader(
  options: WorkstreamsRuntimeLoadOptions = {},
): Promise<WorkstreamsToolRuntimeLoader> {
  logWorkstreamToolEvent("agent.tools.workstream", "loadWorkstreamsToolRuntimeLoader:before", {
    cache: options.cache,
  })
  const loadRuntimeLoader = async () => {
    const modulePath = resolvePackageSideSupportModulePath(options)
    return (await import(pathToFileURL(modulePath).href)) as WorkstreamsToolRuntimeLoader
  }

  if (options.cache === false) {
    const loader = await loadRuntimeLoader()
    logWorkstreamToolEvent("agent.tools.workstream", "loadWorkstreamsToolRuntimeLoader:after", {
      cache: false,
    })
    return loader
  }

  cachedWorkstreamsToolRuntimeLoaderPromise ??= loadRuntimeLoader()
  const loader = await cachedWorkstreamsToolRuntimeLoaderPromise
  logWorkstreamToolEvent("agent.tools.workstream", "loadWorkstreamsToolRuntimeLoader:after", {
    cache: true,
  })
  return loader
}

async function loadWorkstreamsToolRuntime(
  options: WorkstreamsRuntimeLoadOptions = {},
): Promise<WorkstreamsToolRuntime> {
  logWorkstreamToolEvent("agent.tools.workstream", "loadWorkstreamsToolRuntime:before", {
    cache: options.cache,
  })
  const loader = await loadWorkstreamsToolRuntimeLoader(options)
  const workCommandPath = (options.resolveWorkCommandPath ?? resolveWorkCommandPath)()
  const resolvedWorkCommandPath = realpathSync(workCommandPath)
  const packageRoot = findWorkstreamsPackageRoot(resolvedWorkCommandPath)

  const runtime = (await loader.loadWorkstreamsToolRuntime({
    packageRoot,
    resolvedWorkCommandPath,
    cache: options.cache,
  } satisfies PackageWorkstreamsToolRuntimeLoadOptions)) as WorkstreamsToolRuntimeModule as WorkstreamsToolRuntime
  logWorkstreamToolEvent("agent.tools.workstream", "loadWorkstreamsToolRuntime:after", {
    resolvedWorkCommandPath,
    packageRoot,
  })
  return runtime
}

async function resolveWorkstreamsRuntimeModulePath(
  options: WorkstreamsRuntimeResolutionOptions = {},
): Promise<string> {
  const loader = await loadWorkstreamsToolRuntimeLoader({
    ...options,
    cache: false,
  })
  const workCommandPath = (options.resolveWorkCommandPath ?? resolveWorkCommandPath)()
  const resolvedWorkCommandPath = realpathSync(workCommandPath)
  const packageRoot = findWorkstreamsPackageRoot(resolvedWorkCommandPath)

  return loader.resolveWorkstreamsRuntimeModulePath({
    packageRoot,
    resolvedWorkCommandPath,
  })
}

async function getWorkstreamsToolRuntimeInfo(
  options: WorkstreamsRuntimeResolutionOptions = {},
): Promise<WorkstreamsToolRuntimeInfo> {
  logWorkstreamToolEvent("agent.tools.workstream", "getWorkstreamsToolRuntimeInfo:before")
  const info: WorkstreamsToolRuntimeInfo = {
    toolVersion: WORKSTREAM_TOOL_VERSION,
    ...(getToolFilePath() ? { toolFilePath: getToolFilePath() } : {}),
    capabilities: { ...WORKSTREAM_TOOL_CAPABILITIES },
  }

  try {
    const workCommandPath = (options.resolveWorkCommandPath ?? resolveWorkCommandPath)()
    const resolvedWorkCommandPath = realpathSync(workCommandPath)
    const packageRoot = findWorkstreamsPackageRoot(resolvedWorkCommandPath)
    const loader = await loadWorkstreamsToolRuntimeLoader({
      ...options,
      cache: false,
    })

    return loader.createResolvedWorkstreamsToolRuntimeInfo({
      toolVersion: WORKSTREAM_TOOL_VERSION,
      toolFilePath: getToolFilePath(),
      workCommandPath,
      resolvedWorkCommandPath,
      packageRoot,
    })
  } catch (error) {
    logWorkstreamToolEvent("agent.tools.workstream", "getWorkstreamsToolRuntimeInfo:error", { error })
    return {
      ...info,
      errors: {
        ...info.errors,
        workCommandPath: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function getRequiredRuntimeMethod<Key extends keyof WorkstreamsToolRuntime>(
  runtime: WorkstreamsToolRuntime,
  key: Key,
  message: string,
): NonNullable<WorkstreamsToolRuntime[Key]> {
  logWorkstreamToolEvent("agent.tools.workstream", "getRequiredRuntimeMethod:before", {
    key: String(key),
  })
  const value = runtime[key]
  if (typeof value !== "function") {
    logWorkstreamToolEvent("agent.tools.workstream", "getRequiredRuntimeMethod:error", {
      key: String(key),
      actualType: typeof value,
      message,
    })
    throw new Error(message)
  }

  logWorkstreamToolEvent("agent.tools.workstream", "getRequiredRuntimeMethod:after", {
    key: String(key),
  })
  return value as NonNullable<WorkstreamsToolRuntime[Key]>
}

async function executeFinalizeWorkstreamSupervision(
  args: FinalizeWorkstreamSupervisionArgs,
  context: { sessionID?: string },
  runtimeLoadOptions?: WorkstreamsRuntimeLoadOptions,
): Promise<string> {
  logWorkstreamToolEvent("agent.tools.workstream", "executeFinalizeWorkstreamSupervision:before", {
    sessionID: context.sessionID,
    status: args.status,
    streamId: args.streamId,
  })
  try {
    const runtime = await loadWorkstreamsToolRuntime(runtimeLoadOptions)
    logWorkstreamToolEvent("agent.tools.workstream", "executeFinalizeWorkstreamSupervision:runtime-loaded")
    const createDeps = getRequiredRuntimeMethod(
      runtime,
      "createDefaultFinalizeWorkstreamSupervisionDeps",
      "Loaded workstreams tool runtime does not expose createDefaultFinalizeWorkstreamSupervisionDeps.",
    )
    const execute = getRequiredRuntimeMethod(
      runtime,
      "executeFinalizeWorkstreamSupervision",
      "Loaded workstreams tool runtime does not expose executeFinalizeWorkstreamSupervision.",
    )

    logWorkstreamToolEvent("agent.tools.workstream", "executeFinalizeWorkstreamSupervision:createDeps:before")
    const deps = createDeps(runtime, {
      getRepoRoot: () => process.cwd(),
      now: () => new Date().toISOString(),
    })
    logWorkstreamToolEvent("agent.tools.workstream", "executeFinalizeWorkstreamSupervision:createDeps:after")

    logWorkstreamToolEvent("agent.tools.workstream", "executeFinalizeWorkstreamSupervision:execute:before")
    const result = await execute(args, context, deps)
    logWorkstreamToolEvent("agent.tools.workstream", "executeFinalizeWorkstreamSupervision:after")
    return result
  } catch (error) {
    logWorkstreamToolEvent("agent.tools.workstream", "executeFinalizeWorkstreamSupervision:error", {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    })
    return formatToolExecutionError("finalizing workstream supervision", error)
  }
}

async function executeReconcileWorkstreamSupervision(
  args: ReconcileWorkstreamSupervisionArgs,
  context: { sessionID?: string },
  runtimeLoadOptions?: WorkstreamsRuntimeLoadOptions,
): Promise<string> {
  logWorkstreamToolEvent("agent.tools.workstream", "executeReconcileWorkstreamSupervision:before", {
    sessionID: context.sessionID,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
  })
  try {
    const runtime = await loadWorkstreamsToolRuntime(runtimeLoadOptions)
    const createDeps = getRequiredRuntimeMethod(
      runtime,
      "createDefaultReconcileWorkstreamSupervisionDeps",
      "Loaded workstreams tool runtime does not expose createDefaultReconcileWorkstreamSupervisionDeps.",
    )
    const execute = getRequiredRuntimeMethod(
      runtime,
      "executeReconcileWorkstreamSupervision",
      "Loaded workstreams tool runtime does not expose executeReconcileWorkstreamSupervision.",
    )

    const deps = createDeps(runtime, {
      getRepoRoot: () => process.cwd(),
      now: () => new Date().toISOString(),
    })

    return execute(args, context, deps)
  } catch (error) {
    logWorkstreamToolEvent("agent.tools.workstream", "executeReconcileWorkstreamSupervision:error", {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    })
    return formatToolExecutionError("reconciling workstream supervision", error)
  }
}

async function executeLaunchSupervisionBranch(
  args: LaunchSupervisionBranchArgs,
  context: { sessionID?: string },
  runtimeLoadOptions?: WorkstreamsRuntimeLoadOptions,
): Promise<string> {
  logWorkstreamToolEvent("agent.tools.workstream", "executeLaunchSupervisionBranch:before", {
    sessionID: context.sessionID,
    scope: args.scope,
    target: args.target,
    streamId: args.streamId,
  })
  try {
    const runtime = await loadWorkstreamsToolRuntime(runtimeLoadOptions)
    logWorkstreamToolEvent("agent.tools.workstream", "executeLaunchSupervisionBranch:runtime-loaded")
    const createDeps = getRequiredRuntimeMethod(
      runtime,
      "createDefaultLaunchSupervisionBranchDeps",
      "Loaded workstreams tool runtime does not expose createDefaultLaunchSupervisionBranchDeps.",
    )
    const execute = getRequiredRuntimeMethod(
      runtime,
      "executeLaunchSupervisionBranch",
      "Loaded workstreams tool runtime does not expose executeLaunchSupervisionBranch.",
    )

    logWorkstreamToolEvent("agent.tools.workstream", "executeLaunchSupervisionBranch:createDeps:before")
    const deps = createDeps(runtime, {
      getRepoRoot: () => process.cwd(),
      now: () => new Date().toISOString(),
    })
    logWorkstreamToolEvent("agent.tools.workstream", "executeLaunchSupervisionBranch:createDeps:after")

    logWorkstreamToolEvent("agent.tools.workstream", "executeLaunchSupervisionBranch:execute:before")
    const result = await execute(args, context, deps)
    logWorkstreamToolEvent("agent.tools.workstream", "executeLaunchSupervisionBranch:after")
    return result
  } catch (error) {
    logWorkstreamToolEvent("agent.tools.workstream", "executeLaunchSupervisionBranch:error", {
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    })
    return formatToolExecutionError("launching supervision branch", error)
  }
}

export const link_planning_session = tool({
  description:
    "Link the current opencode session to a workstream as its planning session. Use this after creating a workstream to enable resuming this conversation later with 'work plan'.",
  args: {
    streamId: tool.schema
      .string()
      .describe(
        "The workstream ID or name (e.g., '012-my-feature' or 'my-feature'). If omitted, uses the current workstream.",
      )
      .optional(),
  },
  async execute(args: { streamId?: string }, context: { sessionID?: string }) {
    const sessionId = context.sessionID
    if (!sessionId) {
      return "Error: Could not determine current session ID"
    }

    const cmdArgs = ["plan", "--set", sessionId]
    if (args.streamId) {
      cmdArgs.push("--stream", args.streamId)
    }

    try {
      const result = await Bun.$`work ${cmdArgs}`.text()
      return result.trim()
    } catch (error) {
      return `Error linking session: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})

export const link_thread_session = tool({
  description:
    "Link the current opencode session to a workstream thread. Use this from inside the implementing session after confirming thread scope and before substantive implementation work.",
  args: {
    threadId: tool.schema
      .string()
      .describe('The thread ID to link the current session to (e.g., "01.01.01").'),
    streamId: tool.schema
      .string()
      .describe(
        "The workstream ID or name (e.g., '012-my-feature' or 'my-feature'). If omitted, uses the current workstream.",
      )
      .optional(),
  },
  async execute(args: { threadId: string; streamId?: string }, context: { sessionID?: string }) {
    const sessionId = context.sessionID
    if (!sessionId) {
      return "Error: Could not determine current session ID"
    }

    try {
      const repoRoot = process.cwd()
      const stream = getResolvedStream(loadIndex(repoRoot), args.streamId)
      const parsedThreadId = parseThreadId(args.threadId)
      if (!parsedThreadId) {
        return `Error linking thread session: Invalid thread ID format: "${args.threadId}". Expected "stage.batch.thread" (e.g., "01.01.02")`
      }

      const { stage, batch, thread } = parsedThreadId
      const tasks = getTasksByThread(repoRoot, stream.id, stage, batch, thread)

      if (tasks.length === 0) {
        return `Error linking thread session: Thread "${args.threadId}" not found in workstream "${stream.id}"`
      }

      await updateThreadMetadataLocked(repoRoot, stream.id, args.threadId, {
        opencodeSessionId: sessionId,
      })

      return `Linked current session ${sessionId} to thread ${args.threadId} in ${stream.id}.`
    } catch (error) {
      return `Error linking thread session: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})

export const current_workstream = tool({
  description:
    "Get information about the current workstream, including its ID, name, and planning session status.",
  args: {},
  async execute() {
    try {
      const result = await Bun.$`work current`.text()
      return result.trim()
    } catch (error) {
      return `Error getting current workstream: ${error instanceof Error ? error.message : String(error)}`
    }
  },
})

export const finalize_workstream_supervision = Object.assign(
  tool({
    description:
      "Mark the current workstream supervision session as completed, stopped, or failed and persist optional notes before the final report.",
    args: {
      status: tool.schema
        .string()
        .describe("Terminal supervision status: 'completed', 'stopped', or 'failed'."),
      streamId: tool.schema
        .string()
        .describe(
          "Optional workstream ID or name. Usually omitted because the current supervision context is inferred automatically.",
        )
        .optional(),
      notes: tool.schema.string().describe("Optional supervision notes to persist.").optional(),
      summary: tool.schema.string().describe("Optional short supervision summary to persist.").optional(),
      reportText: tool.schema
        .string()
        .describe("Optional final report text to persist before sending it to the user.")
        .optional(),
    },
    async execute(
      args: {
        status: SupervisionTerminalStatus
        streamId?: string
        notes?: string
        summary?: string
        reportText?: string
      },
      context: { sessionID?: string },
    ) {
      return executeFinalizeWorkstreamSupervision(args as FinalizeWorkstreamSupervisionArgs, context)
    },
  }),
  {
    __test: {
      executeFinalizeWorkstreamSupervision,
    },
  },
)

export const reconcile_workstream_supervision = Object.assign(
  tool({
    description:
      "Inspect persisted workstream supervision state and reconcile ended-but-nonterminal supervision sessions whose tmux-hosted run has already ended.",
    args: {
      streamId: tool.schema
        .string()
        .describe("Optional workstream ID or name. If omitted, search focuses on the current root session context first.")
        .optional(),
      branchSessionId: tool.schema
        .string()
        .describe("Optional persisted branch session ID to narrow recovery to one supervision session.")
        .optional(),
    },
    async execute(
      args: {
        streamId?: string
        branchSessionId?: string
      },
      context: { sessionID?: string },
    ) {
      return executeReconcileWorkstreamSupervision(args, context)
    },
  }),
  {
    __test: {
      executeReconcileWorkstreamSupervision,
    },
  },
)

export const tool_runtime_info = Object.assign(
  tool({
    description:
      "Report the loaded workstream tool version, runtime resolution paths, and branch-work capability flags for debugging stale tool loads.",
    args: {},
    async execute() {
      const info = await getWorkstreamsToolRuntimeInfo()

      try {
        const runtime = await loadWorkstreamsToolRuntime()
        return runtime.formatWorkstreamsToolRuntimeInfo?.(info) ?? JSON.stringify(info, null, 2)
      } catch {
        return JSON.stringify(info, null, 2)
      }
    },
  }),
  {
    __test: {
      WORKSTREAM_TOOL_VERSION,
      getWorkstreamsToolRuntimeInfo,
      loadWorkstreamsToolRuntime,
      resetWorkstreamsToolRuntimeCache,
      resolveWorkstreamsRuntimeModulePath,
    },
  },
)

export const launch_supervision_branch = Object.assign(
  tool({
    description:
      "Fork the current Root Agent session into a supervision child session, record durable workstream lineage metadata, and return the branch handoff summary.",
    args: {
      streamId: tool.schema
        .string()
        .describe("The workstream ID or name. If omitted, uses the current workstream.")
        .optional(),
      scope: tool.schema
        .string()
        .describe(
          "Supervision scope: 'batch' for a single explicit batch target or 'stage' for a stage loop that derives the next resumable batch from persisted state.",
        ),
      target: tool.schema
        .string()
        .describe(
          "Scope target. Use a stage id like '10' when scope='stage', or a stage-qualified batch id like '10.01' when scope='batch'.",
        ),
      noServer: tool.schema
        .boolean()
        .describe("Skip starting opencode serve for the headless batch launch.")
        .optional(),
      silent: tool.schema
        .boolean()
        .describe("Disable notification sounds during batch execution.")
        .optional(),
    },
    async execute(
      args: {
        streamId?: string
        scope?: string
        target?: string
        noServer?: boolean
        silent?: boolean
      },
      context: { sessionID?: string },
    ) {
      return executeLaunchSupervisionBranch(args, context)
    },
  }),
  {
    __test: {
      executeLaunchSupervisionBranch,
    },
  },
)

export const workstreamTools = {
  link_planning_session,
  link_thread_session,
  current_workstream,
  finalize_workstream_supervision,
  reconcile_workstream_supervision,
  tool_runtime_info,
  launch_supervision_branch,
}

export type { LaunchSupervisionBranchDeps }
export type { SupervisionTerminalStatus }
