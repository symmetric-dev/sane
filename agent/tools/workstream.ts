// @ts-nocheck
import { tool } from "@opencode-ai/plugin"
import { spawn, spawnSync } from "child_process"
import { existsSync, readFileSync, realpathSync } from "fs"
import { dirname, join } from "path"
import { pathToFileURL } from "url"

interface WorkstreamsToolRuntime {
  getResolvedStream: (index: any, streamId?: string) => { id: string }
  loadIndex: (repoRoot: string) => any
  buildRootAgentBranchSession: (args: any) => any
  createRootAgentBranchSessionId: (role: string) => string
  findRootAgentBranchSessionForLaunchSessionId: (args: {
    repoRoot: string
    streamId: string
    sessionId: string
  }) => any
  waitForRootAgentBranchNativeSessionId: (args: {
    repoRoot: string
    streamId: string
    branchSessionId: string
    timeoutMs?: number
    pollIntervalMs?: number
  }) => Promise<string | undefined>
  waitForRootAgentBranchTerminalSession: (args: {
    repoRoot: string
    streamId: string
    branchSessionId: string
    timeoutMs?: number
    pollIntervalMs?: number
  }) => Promise<any>
  loadSupervisorState: (repoRoot: string, streamId: string) => any
  upsertBranchSessionLocked: (repoRoot: string, streamId: string, branchSession: any) => Promise<any>
  refreshRootAgentCheckpointPointer: (args: any) => Promise<any>
  getRootAgentCheckpointSessionForkEligibility: (args: any) => {
    valid: boolean
    canForkCurrentSession: boolean
    reason?: string
    resolvedMessageId?: string
    resolvedMessageIndex?: number
    latestMessageIndex?: number
  }
  parseSynthesisJsonl: (content: string) => { text: string; logs: string[]; success: boolean }
  exportSession: (sessionId: string) => Promise<any>
  extractLastCompletedAssistantText: (sessionExport: any) => string
}

interface WorkstreamsRuntimeResolutionOptions {
  resolveWorkCommandPath?: () => string
}

interface WorkstreamsRuntimeLoadOptions extends WorkstreamsRuntimeResolutionOptions {
  cache?: boolean
}

interface ForkedSessionArgs {
  sessionId: string
  repoRoot: string
  title: string
  prompt: string
  checkpointMessageId?: string
  forkMode?: "message" | "latest_session_fork"
  onNativeSessionId?: (nativeSessionId: string) => Promise<void> | void
}

interface RootCheckpointPointer {
  rootSessionId?: string
  checkpointMessageId?: string
  checkpointMessageIndex?: number
  checkpointCreatedAt: string
  breakpointSelection?: {
    strategy: "explicit_tag" | "previous_user_before_launch"
    configuredTags: string[]
    matchedTag?: string
    launchMessageId?: string
    launchMessageIndex?: number
    rationale: string
  }
}

interface ForkedSessionResult {
  code: number
  stdout: string
  stderr: string
  nativeSessionId?: string
}

interface CheckpointSessionForkEligibility {
  valid: boolean
  canForkCurrentSession: boolean
  reason?: string
  resolvedMessageId?: string
  resolvedMessageIndex?: number
  latestMessageIndex?: number
}

export interface MessageBoundaryForkTransport {
  startServer: typeof startOpencodeServer
  requestJson: typeof requestOpencodeJson
}

function parseBreakpointTagsArg(rawValue?: string): string[] | undefined {
  if (typeof rawValue !== "string") {
    return undefined
  }

  const normalized = new Set<string>()

  for (const candidate of rawValue.split(/[\n,]/)) {
    const trimmed = candidate.trim()
    if (trimmed.length > 0) {
      normalized.add(trimmed)
    }
  }

  return normalized.size > 0 ? [...normalized] : undefined
}

function buildWorkSuperviseCommand(args: {
  repoRoot: string
  streamId: string
  batch?: string
  timeoutMs?: number
  pollIntervalMs?: number
  noServer?: boolean
  silent?: boolean
  rootSessionId: string
  branchSessionId: string
  parentSessionId: string
  checkpointMessageId?: string
  checkpointMessageIndex?: number
  checkpointCreatedAt?: string
}): string {
  return `work supervise --repo-root "${args.repoRoot}" --stream "${args.streamId}"${args.batch ? ` --batch "${args.batch}"` : ""}${args.timeoutMs !== undefined ? ` --timeout-ms ${args.timeoutMs}` : ""}${args.pollIntervalMs !== undefined ? ` --poll-interval-ms ${args.pollIntervalMs}` : ""}${args.noServer ? " --no-server" : ""}${args.silent ? " --silent" : ""} --root-session-id "${args.rootSessionId}" --branch-session-id "${args.branchSessionId}" --parent-session-id "${args.parentSessionId}"${args.checkpointMessageId ? ` --checkpoint-message-id "${args.checkpointMessageId}"` : ""}${typeof args.checkpointMessageIndex === "number" ? ` --checkpoint-message-index ${args.checkpointMessageIndex}` : ""}${args.checkpointCreatedAt ? ` --checkpoint-created-at "${args.checkpointCreatedAt}"` : ""}`
}

function buildSupervisionPrompt(args: {
  batch?: string
  command: string
}): string {
  const batchTarget = args.batch ? `batch ${args.batch}` : "the next resumable batch"

  return [
    `Please supervise ${batchTarget} for this workstream.`,
    "Use the implementing-workstreams skill.",
    "",
    "Start with this exact command:",
    args.command,
    "",
    "Then continue the supervision loop yourself:",
    "- inspect persisted batch and supervisor state after each supervise run",
    "- if the run times out or remains resumable, resume with plain work supervise so the interrupted batch continues deterministically",
    "- launch review subagents to inspect the completed work",
    "- evaluate the fix-cycle versus escalation policy from persisted evidence",
    "- launch fix subagents when review finds issues and a fix cycle is still appropriate",
    "- re-review after fixes until the batch is done or a real escalation is required",
    "",
    "When you yield back, return a semi-structured final report with these headings exactly:",
    "## Accomplished",
    "## Issues Found",
    "## Fixes Applied",
    "## Next For The User",
    "",
    `In \"Next For The User\", explicitly say whether ${batchTarget} is done, why it is done or not done, and what the user should do next. If a section has nothing to report, write \"None.\"`,
  ].join("\n")
}

function extractTextParts(parts: any): string {
  return (Array.isArray(parts) ? parts : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function formatPromptAsJsonl(text: string): string {
  return `${JSON.stringify({ type: "text", part: { text } })}\n`
}

async function startOpencodeServer(repoRoot: string): Promise<{
  url: string
  close: () => void
}> {
  const child = spawn(
    "opencode",
    ["serve", "--hostname=127.0.0.1", "--port=0"],
    {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let output = ""

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`Timeout waiting for opencode server to start.\n${output}`.trim()))
    }, 5000)

    const finalizeError = (message: string) => {
      clearTimeout(timeout)
      reject(new Error(output.trim() ? `${message}\n${output}` : message))
    }

    const onChunk = (chunk: Buffer | string) => {
      output += chunk.toString()
      const lines = output.split("\n")

      for (const line of lines) {
        const match = line.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/)
        if (!match) {
          continue
        }

        clearTimeout(timeout)
        resolve(match[1])
        return
      }
    }

    child.stdout?.on("data", onChunk)
    child.stderr?.on("data", onChunk)
    child.on("error", (error) => finalizeError(`Failed to start opencode server: ${error?.message || error}`))
    child.on("exit", (code) => finalizeError(`Opencode server exited before becoming ready (code ${code ?? 1}).`))
  })

  return {
    url,
    close: () => {
      child.kill()
    },
  }
}

async function requestOpencodeJson(args: {
  url: string
  method: "POST" | "PATCH"
  path: string
  body?: any
}): Promise<any> {
  const response = await fetch(`${args.url}${args.path}`, {
    method: args.method,
    headers: {
      "Content-Type": "application/json",
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  })

  const text = await response.text()
  const data = text ? (() => {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })() : undefined

  if (!response.ok) {
    const message =
      typeof data === "string"
        ? data
        : data?.message || data?.error || JSON.stringify(data)
    throw new Error(`${args.method} ${args.path} failed (${response.status}): ${message}`)
  }

  return data
}

export async function runMessageBoundaryForkLaunch(
  args: Omit<ForkedSessionArgs, "forkMode"> & { checkpointMessageId: string },
  transport: MessageBoundaryForkTransport = {
    startServer: startOpencodeServer,
    requestJson: requestOpencodeJson,
  },
): Promise<ForkedSessionResult> {
  const server = await transport.startServer(args.repoRoot)

  try {
    const forkedSession = await transport.requestJson({
      url: server.url,
      method: "POST",
      path: `/session/${encodeURIComponent(args.sessionId)}/fork?directory=${encodeURIComponent(args.repoRoot)}`,
      body: { messageID: args.checkpointMessageId },
    })

    const nativeSessionId = forkedSession?.id
    if (typeof nativeSessionId !== "string" || nativeSessionId.trim().length === 0) {
      throw new Error("Fork response did not include a child session ID.")
    }

    await transport.requestJson({
      url: server.url,
      method: "PATCH",
      path: `/session/${encodeURIComponent(nativeSessionId)}?directory=${encodeURIComponent(args.repoRoot)}`,
      body: { title: args.title },
    })

    if (args.onNativeSessionId) {
      await args.onNativeSessionId(nativeSessionId)
    }

    const promptResponse = await transport.requestJson({
      url: server.url,
      method: "POST",
      path: `/session/${encodeURIComponent(nativeSessionId)}/message?directory=${encodeURIComponent(args.repoRoot)}`,
      body: {
        parts: [{ type: "text", text: args.prompt }],
      },
    })

    return {
      code: 0,
      stdout: formatPromptAsJsonl(extractTextParts(promptResponse?.parts)),
      stderr: "",
      nativeSessionId,
    }
  } finally {
    server.close()
  }
}

function resolveWorkCommandPath(): string {
  const result = spawnSync("which", ["work"], {
    encoding: "utf-8",
  })

  const resolvedPath = result.stdout?.trim()
  if (!resolvedPath) {
    throw new Error("Could not resolve active 'work' binary from PATH")
  }

  return resolvedPath
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

  throw new Error(`Could not find @agenv/workstreams package root from active work binary: ${binaryPath}`)
}

export function resolveWorkstreamsRuntimeModulePath(
  options: WorkstreamsRuntimeResolutionOptions = {},
): string {
  const workCommandPath = (options.resolveWorkCommandPath ?? resolveWorkCommandPath)()
  const resolvedBinaryPath = realpathSync(workCommandPath)
  const packageRoot = findWorkstreamsPackageRoot(resolvedBinaryPath)
  const preferDistRuntime = resolvedBinaryPath.includes(`${join("dist", "bin")}`)

  const candidates = preferDistRuntime
    ? [
        join(packageRoot, "dist", "src", "tool-runtime.js"),
        join(packageRoot, "src", "tool-runtime.ts"),
      ]
    : [
        join(packageRoot, "src", "tool-runtime.ts"),
        join(packageRoot, "dist", "src", "tool-runtime.js"),
      ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(
    `Could not locate workstream tool runtime next to active work binary. Checked: ${candidates.join(", ")}`,
  )
}

let cachedWorkstreamsToolRuntimePromise: Promise<WorkstreamsToolRuntime> | undefined

export async function loadWorkstreamsToolRuntime(
  options: WorkstreamsRuntimeLoadOptions = {},
): Promise<WorkstreamsToolRuntime> {
  const loadRuntime = async () => {
    const modulePath = resolveWorkstreamsRuntimeModulePath(options)
    return (await import(pathToFileURL(modulePath).href)) as WorkstreamsToolRuntime
  }

  if (options.cache === false) {
    return loadRuntime()
  }

  cachedWorkstreamsToolRuntimePromise ??= loadRuntime()
  return cachedWorkstreamsToolRuntimePromise
}

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
  getResolvedStreamId: (repoRoot: string, streamId?: string) => string | Promise<string>
  findBranchSessionForLaunchSessionId: (repoRoot: string, streamId: string, sessionId: string) => any | Promise<any>
  findBranchSessionByNativeSessionId: (repoRoot: string, streamId: string, nativeSessionId: string) => any | Promise<any>
  createBranchSessionId: () => string | Promise<string>
  buildBranchSession: (args: any) => any | Promise<any>
  persistBranchSession: (repoRoot: string, streamId: string, branchSession: any) => any | Promise<any>
  loadStoredBranchSession: (repoRoot: string, streamId: string, branchSessionId: string) => any | Promise<any>
  waitForBranchNativeSessionId: (args: {
    repoRoot: string
    streamId: string
    branchSessionId: string
    timeoutMs?: number
    pollIntervalMs?: number
  }) => Promise<string | undefined>
  waitForTerminalBranchSession: (args: {
    repoRoot: string
    streamId: string
    branchSessionId: string
    timeoutMs?: number
    pollIntervalMs?: number
  }) => Promise<any>
  runForkedSession: (args: ForkedSessionArgs) => Promise<ForkedSessionResult>
  runCommand: typeof runCommand
  findNativeSessionIdByTitle: typeof findNativeSessionIdByTitle
  parseOutput: (content: string) => { text: string; logs: string[]; success: boolean } | Promise<{ text: string; logs: string[]; success: boolean }>
  exportSessionTranscript: (sessionId: string) => Promise<any>
  refreshCheckpointPointer: (args: {
    repoRoot: string
    streamId: string
    rootSessionId: string
    sessionExport: any
    checkpointCreatedAt: string
    breakpointTags?: readonly string[]
  }) => Promise<RootCheckpointPointer>
  getCheckpointSessionForkEligibility: (args: {
    pointer: RootCheckpointPointer
    sessionExport: any
  }) => CheckpointSessionForkEligibility | Promise<CheckpointSessionForkEligibility>
  extractFinalBranchReport: (sessionExport: any) => string | Promise<string>
  now: () => string
}

function getDefaultLaunchSupervisionBranchDeps(): LaunchSupervisionBranchDeps {
  const runtime = loadWorkstreamsToolRuntime()

  return {
    getRepoRoot: () => process.cwd(),
    getResolvedStreamId: async (repoRoot, streamId) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.getResolvedStream(resolvedRuntime.loadIndex(repoRoot), streamId).id
    },
    findBranchSessionForLaunchSessionId: async (repoRoot, streamId, sessionId) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.findRootAgentBranchSessionForLaunchSessionId({
        repoRoot,
        streamId,
        sessionId,
      })
    },
    findBranchSessionByNativeSessionId: async (repoRoot, streamId, nativeSessionId) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.loadSupervisorState(repoRoot, streamId)?.branch_sessions.find(
        (branch: any) => branch.nativeSessionId === nativeSessionId,
      )
    },
    createBranchSessionId: async () => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.createRootAgentBranchSessionId("supervision")
    },
    buildBranchSession: async (args) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.buildRootAgentBranchSession(args)
    },
    persistBranchSession: async (repoRoot, streamId, branchSession) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.upsertBranchSessionLocked(repoRoot, streamId, branchSession)
    },
    refreshCheckpointPointer: async (args) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.refreshRootAgentCheckpointPointer(args)
    },
    getCheckpointSessionForkEligibility: async (args) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.getRootAgentCheckpointSessionForkEligibility(args)
    },
    loadStoredBranchSession: async (repoRoot, streamId, branchSessionId) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.loadSupervisorState(repoRoot, streamId)?.branch_sessions.find(
        (branch) => branch.branchSessionId === branchSessionId,
      )
    },
    waitForBranchNativeSessionId: async (args) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.waitForRootAgentBranchNativeSessionId(args)
    },
    waitForTerminalBranchSession: async (args) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.waitForRootAgentBranchTerminalSession(args)
    },
    runForkedSession: async ({ sessionId, repoRoot, title, prompt, checkpointMessageId, forkMode, onNativeSessionId }) => {
      if (forkMode === "message") {
        if (!checkpointMessageId) {
          throw new Error("Message-boundary fork requires checkpointMessageId.")
        }

        return runMessageBoundaryForkLaunch({
          sessionId,
          repoRoot,
          title,
          prompt,
          checkpointMessageId,
          onNativeSessionId,
        })
      }

      const child = spawn(
        "opencode",
        [
          "run",
          "--session",
          sessionId,
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
    parseOutput: async (content) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.parseSynthesisJsonl(content)
    },
    exportSessionTranscript: async (sessionId) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.exportSession(sessionId)
    },
    extractFinalBranchReport: async (sessionExport) => {
      const resolvedRuntime = await runtime
      return resolvedRuntime.extractLastCompletedAssistantText(sessionExport)
    },
    now: () => new Date().toISOString(),
  }
}

async function resolveCompletedBranchNativeSessionId(args: {
  deps: LaunchSupervisionBranchDeps
  repoRoot: string
  streamId: string
  branchSessionId: string
  title: string
  nativeSessionId?: string
}): Promise<string | undefined> {
  if (args.nativeSessionId) {
    return args.nativeSessionId
  }

  const storedNativeSessionId = await args.deps.waitForBranchNativeSessionId({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    timeoutMs: 5000,
    pollIntervalMs: 100,
  })

  if (storedNativeSessionId) {
    return storedNativeSessionId
  }

  return args.deps.findNativeSessionIdByTitle(args.repoRoot, args.title)
}

async function collectCompletedBranchArtifacts(args: {
  deps: LaunchSupervisionBranchDeps
  repoRoot: string
  streamId: string
  branchSessionId: string
  title: string
  nativeSessionId?: string
}): Promise<{
  nativeSessionId?: string
  terminalBranch?: any
  transcript?: any
  reportText: string
  transcriptError?: string
}> {
  const nativeSessionId = await resolveCompletedBranchNativeSessionId(args)
  const terminalBranch = await args.deps.waitForTerminalBranchSession({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    timeoutMs: 5000,
    pollIntervalMs: 100,
  })

  if (!nativeSessionId) {
    return {
      terminalBranch,
      reportText: "",
    }
  }

  try {
    const transcript = await args.deps.exportSessionTranscript(nativeSessionId)
    return {
      nativeSessionId,
      terminalBranch,
      transcript,
      reportText: (await args.deps.extractFinalBranchReport(transcript)).trim(),
    }
  } catch (error: any) {
    return {
      nativeSessionId,
      terminalBranch,
      reportText: "",
      transcriptError: error?.message || String(error),
    }
  }
}

function formatCheckpointPointer(pointer: RootCheckpointPointer): string {
  if (pointer.checkpointMessageId) {
    return `message ${pointer.checkpointMessageId}`
  }

  if (typeof pointer.checkpointMessageIndex === "number") {
    return `message-index ${pointer.checkpointMessageIndex}`
  }

  return "unknown-pointer"
}

function formatBreakpointSelection(selection: RootCheckpointPointer["breakpointSelection"]): string | undefined {
  if (!selection) {
    return undefined
  }

  if (typeof selection.rationale === "string" && selection.rationale.trim().length > 0) {
    return selection.rationale.trim()
  }

  if (selection.strategy === "explicit_tag") {
    return selection.matchedTag
      ? `Selected the tagged user message because it matched configured breakpoint tag "${selection.matchedTag}".`
      : "Selected the tagged user message because it matched a configured breakpoint tag."
  }

  return "Selected the previous user message before branch launch because no configured breakpoint tag was found."
}

function buildCheckpointCaptureNotes(pointer: RootCheckpointPointer, batch?: string): string {
  const selectionText = formatBreakpointSelection(pointer.breakpointSelection)

  return [
    `Checkpoint pointer ${formatCheckpointPointer(pointer)} captured; launching Root Agent supervision branch for ${batch ?? "next resumable batch"}.`,
    ...(selectionText ? [`Breakpoint selection: ${selectionText}`] : []),
  ].join("\n")
}

function getCheckpointPointerFromBranchSession(branch: any): RootCheckpointPointer | undefined {
  if (!branch || !branch.checkpointCreatedAt) {
    return undefined
  }

  if (typeof branch.checkpointMessageId === "string" && branch.checkpointMessageId.trim().length > 0) {
    return {
      checkpointMessageId: branch.checkpointMessageId,
      ...(typeof branch.checkpointMessageIndex === "number"
        ? { checkpointMessageIndex: branch.checkpointMessageIndex }
        : {}),
      checkpointCreatedAt: branch.checkpointCreatedAt,
      ...(branch.breakpointSelection ? { breakpointSelection: branch.breakpointSelection } : {}),
    }
  }

  if (typeof branch.checkpointMessageIndex === "number") {
    return {
      checkpointMessageIndex: branch.checkpointMessageIndex,
      checkpointCreatedAt: branch.checkpointCreatedAt,
      ...(branch.breakpointSelection ? { breakpointSelection: branch.breakpointSelection } : {}),
    }
  }

  return undefined
}

function formatCheckpointLaunchFallbackError(args: {
  checkpointPointer: RootCheckpointPointer
  eligibility: CheckpointSessionForkEligibility
  cause?: unknown
}): Error {
  const pointerLabel = formatCheckpointPointer(args.checkpointPointer)
  const detail = args.cause ? ` Native fork error: ${args.cause instanceof Error ? args.cause.message : String(args.cause)}` : ""

  if (!args.checkpointPointer.checkpointMessageId) {
    return new Error(
      `Cannot launch supervision branch from checkpoint pointer ${pointerLabel}: the selected boundary has no stable message ID, so native fork-from-message is unavailable.${
        args.eligibility.canForkCurrentSession
          ? ""
          : ` Plain session --fork would start from the live session tip (message-index ${args.eligibility.latestMessageIndex ?? "unknown"}) instead of the selected boundary (message-index ${args.eligibility.resolvedMessageIndex ?? args.checkpointPointer.checkpointMessageIndex ?? "unknown"}).`
      }${detail}`,
    )
  }

  return new Error(
    `Native fork-from-message could not launch from checkpoint pointer ${pointerLabel}.${
      args.eligibility.canForkCurrentSession
        ? " Falling back to plain session --fork is only safe when the selected boundary is already the live session tip."
        : ` Plain session --fork would inherit the live session tip (message-index ${args.eligibility.latestMessageIndex ?? "unknown"}) instead of the selected boundary (message-index ${args.eligibility.resolvedMessageIndex ?? args.checkpointPointer.checkpointMessageIndex ?? "unknown"}).`
    }${detail}`,
  )
}

function formatBranchCompletionMessage(args: {
  branchSessionId: string
  checkpointPointer?: RootCheckpointPointer
  nativeSessionId?: string
  observedPersistedStatus?: string
  status: "completed" | "stopped" | "failed"
  summary: string
  reportText: string
  transcript?: any
  transcriptError?: string
}): string {
  const transcriptLabel = args.transcript
    ? `Transcript export captured (${Array.isArray(args.transcript.messages) ? args.transcript.messages.length : 0} messages).`
    : args.nativeSessionId
      ? `Transcript export unavailable: ${args.transcriptError ?? "unknown export error"}`
      : "Transcript export unavailable: native branch session ID was not resolved."

  const sections = [
    `Supervision branch ${args.branchSessionId}${args.nativeSessionId ? ` (native session ${args.nativeSessionId})` : ""} ${args.status}${args.checkpointPointer ? ` from checkpoint pointer ${formatCheckpointPointer(args.checkpointPointer)}` : ""}.`,
    ...(args.checkpointPointer?.breakpointSelection
      ? [`Breakpoint selection: ${formatBreakpointSelection(args.checkpointPointer.breakpointSelection)}`]
      : []),
    `Persisted branch status: ${args.status}.`,
    transcriptLabel,
  ]

  if (args.observedPersistedStatus && args.observedPersistedStatus !== args.status) {
    sections.push(
      `Pre-final persisted branch status: ${args.observedPersistedStatus} (for example, supervise-pass handoff recorded before parent-side finalization).`,
    )
  }

  if (args.reportText) {
    sections.push(`Extracted final branch report:\n${args.reportText}`)
  }

  if (args.summary && args.summary !== args.reportText) {
    sections.push(`Branch run summary:\n${args.summary}`)
  }

  return sections.join("\n\n")
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
  parentSessionId?: string
  checkpointMessageId?: string
  checkpointMessageIndex?: number
  checkpointCreatedAt?: string
  breakpointSelection?: RootCheckpointPointer["breakpointSelection"]
  checkpointSessionId?: string
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
    await args.deps.buildBranchSession({
      context: {
        rootSessionId: args.rootSessionId,
        branchSessionId: args.branchSessionId,
        ...(args.checkpointMessageId ? { checkpointMessageId: args.checkpointMessageId } : {}),
        ...(typeof args.checkpointMessageIndex === "number"
          ? { checkpointMessageIndex: args.checkpointMessageIndex }
          : {}),
        ...(args.checkpointCreatedAt ? { checkpointCreatedAt: args.checkpointCreatedAt } : {}),
        ...(args.breakpointSelection ? { breakpointSelection: args.breakpointSelection } : {}),
        ...(args.checkpointSessionId ? { checkpointSessionId: args.checkpointSessionId } : {}),
        parentSessionId: args.parentSessionId ?? args.rootSessionId,
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
    breakpointTags?: string
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
  const streamId = await deps.getResolvedStreamId(repoRoot, args.streamId)
  const breakpointTags = parseBreakpointTagsArg(args.breakpointTags)

  const parentBranch = await deps.findBranchSessionForLaunchSessionId(
    repoRoot,
    streamId,
    rootSessionId,
  )

  if (parentBranch) {
    const parentBranchLabel = parentBranch.branchSessionId ?? rootSessionId
    return [
      "Error: Supervision branches cannot launch additional supervision branches.",
      `Current session is already branch ${parentBranchLabel}.`,
      "Current guard is intentionally one-level only and triggers when the current native session is already recorded as a branch session.",
      "Yield back to the Root Agent so it can inspect persisted branch state and decide the next action.",
    ].join("\n")
  }

  const branchSessionId = await deps.createBranchSessionId()
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
    notes: `Capturing checkpoint pointer metadata for ${args.batch ?? "next resumable batch"}; branch is not active yet.`,
  })

  let checkpointPointer: RootCheckpointPointer | undefined

  try {
    const checkpointCreatedAt = deps.now()
    const rootSessionExport = await deps.exportSessionTranscript(rootSessionId)
    checkpointPointer = await deps.refreshCheckpointPointer({
      repoRoot,
      streamId,
      rootSessionId,
      sessionExport: rootSessionExport,
      checkpointCreatedAt,
      ...(breakpointTags ? { breakpointTags } : {}),
    })

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: rootSessionId,
      checkpointMessageId: checkpointPointer.checkpointMessageId,
      checkpointMessageIndex: checkpointPointer.checkpointMessageIndex,
      checkpointCreatedAt,
      breakpointSelection: checkpointPointer.breakpointSelection,
      status: "pending",
      startedAt,
      updatedAt: deps.now(),
      batchId: args.batch,
      notes: buildCheckpointCaptureNotes(checkpointPointer, args.batch),
    })

    const checkpointForkEligibility = await deps.getCheckpointSessionForkEligibility({
      pointer: checkpointPointer,
      sessionExport: rootSessionExport,
    })

    if (!checkpointForkEligibility.valid) {
      throw new Error(
        `Checkpoint pointer ${formatCheckpointPointer(checkpointPointer)} no longer resolves against the current root transcript (${checkpointForkEligibility.reason ?? "unknown validation failure"}).`,
      )
    }

    const workSuperviseCommand = buildWorkSuperviseCommand({
      repoRoot,
      streamId,
      batch: args.batch,
      timeoutMs: args.timeoutMs,
      pollIntervalMs: args.pollIntervalMs,
      noServer: args.noServer,
      silent: args.silent,
      rootSessionId,
      branchSessionId,
      parentSessionId: rootSessionId,
      checkpointMessageId: checkpointPointer.checkpointMessageId,
      checkpointMessageIndex: checkpointPointer.checkpointMessageIndex,
      checkpointCreatedAt: checkpointPointer.checkpointCreatedAt,
    })

    const supervisionPrompt = buildSupervisionPrompt({
      batch: args.batch,
      command: workSuperviseCommand,
    })
    const persistNativeSessionId = async (nativeSessionId: string) => {
      const updatedAt = deps.now()
      const storedBranch = await deps.loadStoredBranchSession(repoRoot, streamId, branchSessionId)

      await persistSupervisionBranchState({
        deps,
        repoRoot,
        streamId,
        rootSessionId,
        branchSessionId,
        parentSessionId: storedBranch?.parentSessionId ?? rootSessionId,
        checkpointMessageId:
          storedBranch?.checkpointMessageId ?? checkpointPointer.checkpointMessageId,
        checkpointMessageIndex:
          storedBranch?.checkpointMessageIndex ?? checkpointPointer.checkpointMessageIndex,
        checkpointCreatedAt:
          storedBranch?.checkpointCreatedAt ?? checkpointPointer.checkpointCreatedAt,
        breakpointSelection:
          storedBranch?.breakpointSelection ?? checkpointPointer.breakpointSelection,
        nativeSessionId,
        status: storedBranch?.status === "running" ? "running" : "pending",
        startedAt: storedBranch?.startedAt ?? startedAt,
        updatedAt,
        runId: storedBranch?.runId,
        batchId: storedBranch?.batchId ?? args.batch,
        notes:
          storedBranch?.notes ??
          buildCheckpointCaptureNotes(checkpointPointer, args.batch),
      })
    }

    let runResult: ForkedSessionResult

    if (!checkpointPointer.checkpointMessageId) {
      if (!checkpointForkEligibility.canForkCurrentSession) {
        throw formatCheckpointLaunchFallbackError({
          checkpointPointer,
          eligibility: checkpointForkEligibility,
        })
      }

      runResult = await deps.runForkedSession({
        sessionId: rootSessionId,
        repoRoot,
        title,
        prompt: supervisionPrompt,
        forkMode: "latest_session_fork",
        onNativeSessionId: persistNativeSessionId,
      })
    } else {
      try {
        runResult = await deps.runForkedSession({
          sessionId: rootSessionId,
          repoRoot,
          title,
          prompt: supervisionPrompt,
          checkpointMessageId: checkpointPointer.checkpointMessageId,
          forkMode: "message",
          onNativeSessionId: persistNativeSessionId,
        })
      } catch (error) {
        if (!checkpointForkEligibility.canForkCurrentSession) {
          throw formatCheckpointLaunchFallbackError({
            checkpointPointer,
            eligibility: checkpointForkEligibility,
            cause: error,
          })
        }

        runResult = await deps.runForkedSession({
          sessionId: rootSessionId,
          repoRoot,
          title,
          prompt: supervisionPrompt,
          forkMode: "latest_session_fork",
          onNativeSessionId: persistNativeSessionId,
        })
      }
    }

    const parsed = await deps.parseOutput(runResult.stdout)
    const fallbackSummary =
      parsed.text.trim() || runResult.stderr.trim() || "(branch session produced no summary)"
    const { nativeSessionId, terminalBranch, transcript, reportText, transcriptError } =
      await collectCompletedBranchArtifacts({
        deps,
        repoRoot,
        streamId,
        branchSessionId,
        title,
        nativeSessionId: runResult.nativeSessionId,
      })
    const storedBranch = terminalBranch ?? await deps.loadStoredBranchSession(repoRoot, streamId, branchSessionId)
    const completedAt = deps.now()
    const status = getTerminalBranchStatus(storedBranch?.status, runResult.code)
    const summary = reportText || fallbackSummary
    const storedCheckpointPointer = getCheckpointPointerFromBranchSession(storedBranch)

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: storedBranch?.parentSessionId ?? rootSessionId,
      checkpointMessageId:
        storedBranch?.checkpointMessageId ?? checkpointPointer.checkpointMessageId,
      checkpointMessageIndex:
        storedBranch?.checkpointMessageIndex ?? checkpointPointer.checkpointMessageIndex,
      checkpointCreatedAt:
        storedBranch?.checkpointCreatedAt ?? storedCheckpointPointer?.checkpointCreatedAt ?? checkpointPointer.checkpointCreatedAt,
      breakpointSelection:
        storedBranch?.breakpointSelection ?? storedCheckpointPointer?.breakpointSelection ?? checkpointPointer.breakpointSelection,
      nativeSessionId,
      status,
      startedAt: storedBranch?.startedAt ?? startedAt,
      updatedAt: completedAt,
      completedAt,
      runId: storedBranch?.runId,
      batchId: storedBranch?.batchId ?? args.batch,
      notes:
        storedBranch?.status === "running"
          ? `Parent/root finalized branch after supervise-pass handoff.\n\n${summary}`
          : summary,
    })

    return formatBranchCompletionMessage({
      branchSessionId,
      checkpointPointer: storedCheckpointPointer ?? checkpointPointer,
      nativeSessionId,
      observedPersistedStatus: storedBranch?.status,
      status,
      summary,
      reportText,
      transcript,
      transcriptError,
    })
  } catch (error: any) {
    const failedAt = deps.now()

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: rootSessionId,
      checkpointMessageId: checkpointPointer?.checkpointMessageId,
      checkpointMessageIndex: checkpointPointer?.checkpointMessageIndex,
      checkpointCreatedAt: checkpointPointer?.checkpointCreatedAt,
      breakpointSelection: checkpointPointer?.breakpointSelection,
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
    breakpointTags: tool.schema.string().describe("Optional comma-separated breakpoint tags to search for before launch (for example: 'SESSION_BREAKPOINT,ROOT_BRANCH_BOUNDARY').").optional(),
    timeoutMs: tool.schema.number().describe("Optional wait timeout in milliseconds for work supervise.").optional(),
    pollIntervalMs: tool.schema.number().describe("Optional poll interval in milliseconds for work supervise.").optional(),
    noServer: tool.schema.boolean().describe("Skip starting opencode serve for the headless batch launch.").optional(),
    silent: tool.schema.boolean().describe("Disable notification sounds during batch execution.").optional(),
  },
  async execute(args, context) {
    return executeLaunchSupervisionBranch(args, context)
  },
})
