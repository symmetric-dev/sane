import { spawn } from "child_process"
import { logWorkstreamToolEvent } from "./debug-log.ts"

export const DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS = 5000
export const DEFAULT_OPENCODE_COMMAND_TIMEOUT_MS = 5000
export const DEFAULT_BRANCH_TOOL_TIMEOUT_MS = 60 * 60 * 1000
export const DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS = 1000

type JsonEnvelopeScanResult =
  | { kind: "complete"; endIndex: number }
  | { kind: "incomplete"; reason: "unterminated_string" | "unbalanced_delimiter" }

export interface ForkedSessionArgs {
  sessionId: string
  repoRoot: string
  title: string
  prompt: string
  checkpointMessageId?: string
  forkMode?: "message" | "latest_session_fork"
  tmuxSessionName?: string
  onNativeSessionId?: (nativeSessionId: string) => Promise<void> | void
}

export interface ForkedSessionResult {
  code: number
  stdout: string
  stderr: string
  nativeSessionId?: string
  tmuxSessionName?: string
  tmuxMetadata?: unknown
}

export interface MessageBoundaryForkTransport {
  startServer: typeof startOpencodeServer
  requestJson: typeof requestOpencodeJson
  runCommand: typeof runCommand
}

function scanJsonEnvelope(stdout: string, startIndex: number): JsonEnvelopeScanResult {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startIndex; index < stdout.length; index++) {
    const char = stdout[index]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === "\\") {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === "{" || char === "[") {
      depth += 1
      continue
    }

    if (char === "}" || char === "]") {
      depth -= 1
      if (depth === 0) {
        return { kind: "complete", endIndex: index }
      }
    }
  }

  if (inString) {
    return { kind: "incomplete", reason: "unterminated_string" }
  }

  return { kind: "incomplete", reason: "unbalanced_delimiter" }
}

function parseJsonPayloadFromStdout<T>(stdout: string): T | undefined {
  const trimmedStdout = stdout.trim()
  if (!trimmedStdout) {
    return undefined
  }

  try {
    return JSON.parse(trimmedStdout) as T
  } catch {
    // Fall through to tolerant mixed-output scan.
  }

  for (let index = 0; index < stdout.length; index++) {
    const char = stdout[index]
    if (char !== "{" && char !== "[") {
      continue
    }

    const scan = scanJsonEnvelope(stdout, index)
    if (scan.kind === "incomplete") {
      continue
    }

    const payload = stdout.slice(index, scan.endIndex + 1)
    try {
      return JSON.parse(payload) as T
    } catch {
      continue
    }
  }

  return undefined
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = DEFAULT_OPENCODE_COMMAND_TIMEOUT_MS,
): Promise<{ code: number; stdout: string; stderr: string }> {
  logWorkstreamToolEvent("workstream.launch.opencode", "runCommand:before", {
    command,
    args,
    cwd,
    timeoutMs,
  })
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const finalizeResolve = (value: { code: number; stdout: string; stderr: string }) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutHandle)
      logWorkstreamToolEvent("workstream.launch.opencode", "runCommand:after", {
        command,
        code: value.code,
        stdoutLength: value.stdout.length,
        stderrLength: value.stderr.length,
      })
      resolve(value)
    }

    const finalizeReject = (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeoutHandle)
      logWorkstreamToolEvent("workstream.launch.opencode", "runCommand:error", {
        command,
        error,
      })
      reject(error)
    }

    const timeoutHandle = setTimeout(() => {
      child.kill()
      finalizeReject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for command "${command}" to finish.`,
        ),
      )
    }, timeoutMs)

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) =>
      finalizeReject(error instanceof Error ? error : new Error(String(error))),
    )
    child.on("close", (code) => {
      finalizeResolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

export async function findNativeSessionIdByTitle(
  repoRoot: string,
  title: string,
): Promise<string | undefined> {
  logWorkstreamToolEvent("workstream.launch.opencode", "findNativeSessionIdByTitle:before", {
    repoRoot,
    title,
  })
  const result = await runCommand(
    "opencode",
    ["session", "list", "--max-count", "50", "--format", "json"],
    repoRoot,
    DEFAULT_OPENCODE_COMMAND_TIMEOUT_MS,
  )

  if (result.code !== 0) {
    logWorkstreamToolEvent("workstream.launch.opencode", "findNativeSessionIdByTitle:nonzero", {
      code: result.code,
    })
    return undefined
  }

  const sessions = parseJsonPayloadFromStdout<Array<{ id: string; title: string }>>(result.stdout)
  if (!Array.isArray(sessions)) {
    logWorkstreamToolEvent("workstream.launch.opencode", "findNativeSessionIdByTitle:parse-miss", {
      stdoutLength: result.stdout.length,
    })
    return undefined
  }

  const nativeSessionId = sessions.find((session) => session.title === title)?.id
  logWorkstreamToolEvent("workstream.launch.opencode", "findNativeSessionIdByTitle:after", {
    found: Boolean(nativeSessionId),
    nativeSessionId,
  })
  return nativeSessionId
}

export async function startOpencodeServer(repoRoot: string): Promise<{
  url: string
  close: () => void
}> {
  logWorkstreamToolEvent("workstream.launch.opencode", "startOpencodeServer:before", { repoRoot })
  const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let output = ""

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(
        new Error(
          `Timeout waiting for opencode server to start.\n${output}`.trim(),
        ),
      )
    }, DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS)

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

        const matchedUrl = match[1]
        if (!matchedUrl) {
          continue
        }

        clearTimeout(timeout)
        resolve(matchedUrl)
        return
      }
    }

    child.stdout?.on("data", onChunk)
    child.stderr?.on("data", onChunk)
    child.on("error", (error) =>
      finalizeError(`Failed to start opencode server: ${error?.message || error}`),
    )
    child.on("exit", (code) =>
      finalizeError(
        `Opencode server exited before becoming ready (code ${code ?? 1}).`,
      ),
    )
  })

  logWorkstreamToolEvent("workstream.launch.opencode", "startOpencodeServer:after", { url })
  return {
    url,
    close: () => {
      logWorkstreamToolEvent("workstream.launch.opencode", "startOpencodeServer:close", { url })
      child.kill()
    },
  }
}

export async function requestOpencodeJson(args: {
  url: string
  method: "POST" | "PATCH"
  path: string
  body?: any
}): Promise<any> {
  logWorkstreamToolEvent("workstream.launch.opencode", "requestOpencodeJson:before", {
    method: args.method,
    path: args.path,
  })
  const response = await fetch(`${args.url}${args.path}`, {
    method: args.method,
    headers: {
      "Content-Type": "application/json",
    },
    ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
  })

  const text = await response.text()
  const data = text
    ? (() => {
        try {
          return JSON.parse(text)
        } catch {
          return text
        }
      })()
    : undefined

  if (!response.ok) {
    const message =
      typeof data === "string"
        ? data
        : data?.message || data?.error || JSON.stringify(data)
    throw new Error(
      `${args.method} ${args.path} failed (${response.status}): ${message}`,
    )
  }

  logWorkstreamToolEvent("workstream.launch.opencode", "requestOpencodeJson:after", {
    method: args.method,
    path: args.path,
    ok: response.ok,
  })
  return data
}

export async function prepareMessageBoundaryForkLaunch(
  args: Omit<ForkedSessionArgs, "forkMode" | "tmuxSessionName"> & {
    checkpointMessageId: string
  },
  transport: Pick<MessageBoundaryForkTransport, "startServer" | "requestJson"> = {
    startServer: startOpencodeServer,
    requestJson: requestOpencodeJson,
  },
): Promise<{ nativeSessionId: string; commandArgs: string[] }> {
  logWorkstreamToolEvent("workstream.launch.opencode", "prepareMessageBoundaryForkLaunch:before", {
    sessionId: args.sessionId,
    title: args.title,
    checkpointMessageId: args.checkpointMessageId,
  })
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

    const prepared = {
      nativeSessionId,
      commandArgs: [
        "run",
        "--session",
        nativeSessionId,
        "--dir",
        args.repoRoot,
        "--format",
        "json",
        args.prompt,
      ],
    }
    logWorkstreamToolEvent("workstream.launch.opencode", "prepareMessageBoundaryForkLaunch:after", {
      nativeSessionId,
      commandArgsLength: prepared.commandArgs.length,
    })
    return prepared
  } finally {
    server.close()
  }
}

export async function runMessageBoundaryForkLaunch(
  args: Omit<ForkedSessionArgs, "forkMode"> & { checkpointMessageId: string },
  transport: MessageBoundaryForkTransport = {
    startServer: startOpencodeServer,
    requestJson: requestOpencodeJson,
    runCommand,
  },
): Promise<ForkedSessionResult> {
  logWorkstreamToolEvent("workstream.launch.opencode", "runMessageBoundaryForkLaunch:before", {
    sessionId: args.sessionId,
    title: args.title,
  })
  const preparedLaunch = await prepareMessageBoundaryForkLaunch(args, transport)
  const runResult = await transport.runCommand(
    "opencode",
    preparedLaunch.commandArgs,
    args.repoRoot,
    DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
  )

  const result = {
    ...runResult,
    nativeSessionId: preparedLaunch.nativeSessionId,
  }
  logWorkstreamToolEvent("workstream.launch.opencode", "runMessageBoundaryForkLaunch:after", {
    code: result.code,
    nativeSessionId: result.nativeSessionId,
  })
  return result
}

export async function runForkedSession(
  args: ForkedSessionArgs,
  helpers: {
    findNativeSessionIdByTitle: typeof findNativeSessionIdByTitle
  } = {
    findNativeSessionIdByTitle,
  },
): Promise<ForkedSessionResult> {
  logWorkstreamToolEvent("workstream.launch.opencode", "runForkedSession:before", {
    sessionId: args.sessionId,
    title: args.title,
    forkMode: args.forkMode,
  })
  if (args.forkMode === "message") {
    if (!args.checkpointMessageId) {
      throw new Error("Message-boundary fork requires checkpointMessageId.")
    }

    return runMessageBoundaryForkLaunch({
      sessionId: args.sessionId,
      repoRoot: args.repoRoot,
      title: args.title,
      prompt: args.prompt,
      checkpointMessageId: args.checkpointMessageId,
      onNativeSessionId: args.onNativeSessionId,
    })
  }

  const child = spawn(
    "opencode",
    [
      "run",
      "--session",
      args.sessionId,
      "--fork",
      "--dir",
      args.repoRoot,
      "--title",
      args.title,
      "--format",
      "json",
      args.prompt,
    ],
    {
      cwd: args.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  let stdout = ""
  let stderr = ""
  let nativeSessionId: string | undefined
  let stopped = false
  let pollError: unknown
  let pollPromise: Promise<void> | undefined
  let settled = false

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  if (args.onNativeSessionId) {
    const handleNativeSessionId = args.onNativeSessionId
    pollPromise = (async () => {
      while (!stopped && !nativeSessionId) {
        try {
          const foundSessionId = await helpers.findNativeSessionIdByTitle(
            args.repoRoot,
            args.title,
          )
          if (foundSessionId) {
            nativeSessionId = foundSessionId
            logWorkstreamToolEvent("workstream.launch.opencode", "runForkedSession:poll-native-session", {
              nativeSessionId: foundSessionId,
              title: args.title,
            })
            await handleNativeSessionId(foundSessionId)
            return
          }
        } catch (error) {
          pollError = error
          return
        }

        await new Promise((resolve) =>
          setTimeout(resolve, DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS),
        )
      }
    })()
  }

  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const finalizeResolve = (value: { code: number; stdout: string; stderr: string }) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timeoutHandle)
        resolve(value)
      }

      const finalizeReject = (error: Error) => {
        if (settled) {
          return
        }

        settled = true
        clearTimeout(timeoutHandle)
        reject(error)
      }

      const timeoutHandle = setTimeout(() => {
        stopped = true
        child.kill()
        finalizeReject(
          new Error(
            `Timed out after ${DEFAULT_BRANCH_TOOL_TIMEOUT_MS}ms waiting for supervision branch session "${args.title}" to finish.`,
          ),
        )
      }, DEFAULT_BRANCH_TOOL_TIMEOUT_MS)

      child.on("error", (error) =>
        finalizeReject(error instanceof Error ? error : new Error(String(error))),
      )
      child.on("close", (code) => {
        stopped = true
        finalizeResolve({ code: code ?? 1, stdout, stderr })
      })
    },
  )

  await pollPromise

  if (pollError) {
    throw pollError
  }

  if (!nativeSessionId) {
    nativeSessionId = await helpers.findNativeSessionIdByTitle(args.repoRoot, args.title)
  }

  const forkedResult = {
    ...result,
    ...(nativeSessionId ? { nativeSessionId } : {}),
  }
  logWorkstreamToolEvent("workstream.launch.opencode", "runForkedSession:after", {
    code: forkedResult.code,
    nativeSessionId: forkedResult.nativeSessionId,
    stdoutLength: forkedResult.stdout.length,
  })
  return forkedResult
}
