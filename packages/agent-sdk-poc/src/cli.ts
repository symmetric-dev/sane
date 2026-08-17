#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { DEFAULT_MODEL, runCursor } from "./cursor-runner.ts"
import {
  DEFAULT_OPENCODE_SERVER_URL,
  launchOpenCodeAsync,
  observeOpenCode,
  runOpenCode,
} from "./opencode-runner.ts"

interface CommonArgs {
  cwd: string
  runDirectory?: string
  timeoutMs?: number
}

interface CursorArgs extends CommonArgs {
  prompt?: string
  promptFile?: string
  model: string
}

interface OpenCodeRunArgs extends CommonArgs {
  prompt?: string
  promptFile?: string
  serverUrl: string
  model?: string
  title?: string
  parentID?: string
}

interface OpenCodeAsyncArgs {
  cwd: string
  runDirectory?: string
  prompt?: string
  promptFile?: string
  serverUrl: string
  model?: string
  title?: string
  parentID?: string
}

interface OpenCodeObserveArgs extends CommonArgs {
  serverUrl: string
  sessionId?: string
}

const USAGE = `Usage:
  sdk-poc cursor run [options]
  sdk-poc opencode run [options]
  sdk-poc opencode async [options]
  sdk-poc opencode observe [options]

Cursor run options:
  --prompt <text>          Inline prompt
  --prompt-file <path>     Read prompt text from a file
  --cwd <path>             Local agent working directory (default: current directory)
  --model <id>             Cursor model id (default: ${DEFAULT_MODEL})
  --run-dir <path>         Artifact directory (default: .tmp/agent-sdk-poc/...)
  --timeout-ms <ms>        Cancel the run after this many milliseconds
  --timeout <ms>           Alias for --timeout-ms

OpenCode run options:
  --server <url>           Existing opencode serve URL (default: ${DEFAULT_OPENCODE_SERVER_URL})
  --prompt <text>          Inline prompt
  --prompt-file <path>     Read prompt text from a file
  --cwd <path>             OpenCode session directory (default: current directory)
  --model <provider/model> OpenCode provider/model; omit for server default
  --title <text>           Native session title
  --parent-id <id>         Optional native parent session ID
  --run-dir <path>         Artifact directory (default: .tmp/agent-sdk-poc/...)
  --timeout-ms <ms>        Abort the session after this many milliseconds
  --timeout <ms>           Alias for --timeout-ms

OpenCode async options:
  --server <url>           Existing opencode serve URL (default: ${DEFAULT_OPENCODE_SERVER_URL})
  --prompt <text>          Inline prompt
  --prompt-file <path>     Read prompt text from a file
  --cwd <path>             OpenCode session directory (default: current directory)
  --model <provider/model> OpenCode provider/model; omit for server default
  --title <text>           Native session title
  --parent-id <id>         Optional native parent session ID
  --run-dir <path>         Artifact directory (default: .tmp/agent-sdk-poc/...)
  The command returns after prompt_async is accepted; observe separately.

OpenCode observe options:
  --server <url>           Existing opencode serve URL (default: ${DEFAULT_OPENCODE_SERVER_URL})
  --session <id>           Native OpenCode session ID (required)
  --cwd <path>             OpenCode session directory (default: current directory)
  --run-dir <path>         Artifact directory (default: .tmp/agent-sdk-poc/...)
  --timeout-ms <ms>        Stop observing after this many milliseconds
  --timeout <ms>           Alias for --timeout-ms

  --help                   Show this help
`

function usageError(message: string): never {
  throw new Error(`${message}\n\n${USAGE}`)
}

function valueAfter(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) usageError(`${flag} requires a value`)
  return value
}

function parseMilliseconds(value: string, flag: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) usageError(`${flag} must be a positive integer`)
  return parsed
}

function parseCommonOption(parsed: CommonArgs, args: string[], index: number, arg: string): number | undefined {
  switch (arg) {
    case "--cwd":
      parsed.cwd = resolve(valueAfter(args, index, arg))
      return index + 1
    case "--run-dir":
      parsed.runDirectory = resolve(valueAfter(args, index, arg))
      return index + 1
    case "--timeout-ms":
    case "--timeout":
      parsed.timeoutMs = parseMilliseconds(valueAfter(args, index, arg), arg)
      return index + 1
    default:
      return undefined
  }
}

function parseCursorArgs(args: string[]): CursorArgs {
  const parsed: CursorArgs = { cwd: process.cwd(), model: DEFAULT_MODEL }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    const commonIndex = parseCommonOption(parsed, args, index, arg)
    if (commonIndex !== undefined) {
      index = commonIndex
      continue
    }
    switch (arg) {
      case "--prompt":
        parsed.prompt = valueAfter(args, index, arg)
        index += 1
        break
      case "--prompt-file":
        parsed.promptFile = valueAfter(args, index, arg)
        index += 1
        break
      case "--model":
        parsed.model = valueAfter(args, index, arg)
        index += 1
        break
      case "--help":
        process.stdout.write(USAGE)
        return parsed
      default:
        usageError(`Unknown option: ${arg}`)
    }
  }
  return parsed
}

function parseOpenCodeRunArgs(args: string[]): OpenCodeRunArgs {
  const parsed: OpenCodeRunArgs = { cwd: process.cwd(), serverUrl: DEFAULT_OPENCODE_SERVER_URL }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    const commonIndex = parseCommonOption(parsed, args, index, arg)
    if (commonIndex !== undefined) {
      index = commonIndex
      continue
    }
    switch (arg) {
      case "--server":
        parsed.serverUrl = valueAfter(args, index, arg)
        index += 1
        break
      case "--prompt":
        parsed.prompt = valueAfter(args, index, arg)
        index += 1
        break
      case "--prompt-file":
        parsed.promptFile = valueAfter(args, index, arg)
        index += 1
        break
      case "--model":
        parsed.model = valueAfter(args, index, arg)
        index += 1
        break
      case "--title":
        parsed.title = valueAfter(args, index, arg)
        index += 1
        break
      case "--parent-id":
        parsed.parentID = valueAfter(args, index, arg)
        index += 1
        break
      case "--help":
        process.stdout.write(USAGE)
        return parsed
      default:
        usageError(`Unknown option: ${arg}`)
    }
  }
  return parsed
}

function parseOpenCodeAsyncArgs(args: string[]): OpenCodeAsyncArgs {
  const parsed: OpenCodeAsyncArgs = { cwd: process.cwd(), serverUrl: DEFAULT_OPENCODE_SERVER_URL }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    switch (arg) {
      case "--cwd":
        parsed.cwd = resolve(valueAfter(args, index, arg))
        index += 1
        break
      case "--run-dir":
        parsed.runDirectory = resolve(valueAfter(args, index, arg))
        index += 1
        break
      case "--server":
        parsed.serverUrl = valueAfter(args, index, arg)
        index += 1
        break
      case "--prompt":
        parsed.prompt = valueAfter(args, index, arg)
        index += 1
        break
      case "--prompt-file":
        parsed.promptFile = valueAfter(args, index, arg)
        index += 1
        break
      case "--model":
        parsed.model = valueAfter(args, index, arg)
        index += 1
        break
      case "--title":
        parsed.title = valueAfter(args, index, arg)
        index += 1
        break
      case "--parent-id":
        parsed.parentID = valueAfter(args, index, arg)
        index += 1
        break
      case "--help":
        process.stdout.write(USAGE)
        return parsed
      default:
        usageError(`Unknown option: ${arg}`)
    }
  }
  return parsed
}

function parseOpenCodeObserveArgs(args: string[]): OpenCodeObserveArgs {
  const parsed: OpenCodeObserveArgs = { cwd: process.cwd(), serverUrl: DEFAULT_OPENCODE_SERVER_URL }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg) continue
    const commonIndex = parseCommonOption(parsed, args, index, arg)
    if (commonIndex !== undefined) {
      index = commonIndex
      continue
    }
    switch (arg) {
      case "--server":
        parsed.serverUrl = valueAfter(args, index, arg)
        index += 1
        break
      case "--session":
        parsed.sessionId = valueAfter(args, index, arg)
        index += 1
        break
      case "--help":
        process.stdout.write(USAGE)
        return parsed
      default:
        usageError(`Unknown option: ${arg}`)
    }
  }
  return parsed
}

async function promptFromArgs(parsed: { prompt?: string; promptFile?: string }): Promise<string> {
  const inline = parsed.prompt?.trim()
  const file = parsed.promptFile ? await readFile(resolve(parsed.promptFile), "utf8") : undefined
  const parts = [inline, file?.trim()].filter((part): part is string => Boolean(part))
  if (parts.length === 0) usageError("Provide --prompt, --prompt-file, or both")
  return parts.join("\n\n")
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.includes("--help")) {
    process.stdout.write(USAGE)
    return 0
  }

  if (args[0] === "cursor" && args[1] === "run") {
    const parsed = parseCursorArgs(args.slice(2))
    const prompt = await promptFromArgs(parsed)
    const artifact = await runCursor({ ...parsed, prompt })
    return artifact.status === "finished" ? 0 : 1
  }

  if (args[0] === "opencode" && args[1] === "run") {
    const parsed = parseOpenCodeRunArgs(args.slice(2))
    const prompt = await promptFromArgs(parsed)
    const artifact = await runOpenCode({ ...parsed, prompt })
    return artifact.status === "finished" ? 0 : 1
  }

  if (args[0] === "opencode" && args[1] === "async") {
    const parsed = parseOpenCodeAsyncArgs(args.slice(2))
    const prompt = await promptFromArgs(parsed)
    const artifact = await launchOpenCodeAsync({ ...parsed, prompt })
    return artifact.status === "running" ? 0 : 1
  }

  if (args[0] === "opencode" && args[1] === "observe") {
    const parsed = parseOpenCodeObserveArgs(args.slice(2))
    if (!parsed.sessionId) usageError("opencode observe requires --session <id>")
    const observerController = new AbortController()
    const stopObserver = () => observerController.abort()
    process.once("SIGINT", stopObserver)
    process.once("SIGTERM", stopObserver)
    try {
      const artifact = await observeOpenCode({ ...parsed, sessionId: parsed.sessionId, signal: observerController.signal })
      return artifact.status === "error" ? 1 : 0
    } finally {
      process.removeListener("SIGINT", stopObserver)
      process.removeListener("SIGTERM", stopObserver)
    }
  }

  usageError("Expected `cursor run`, `opencode run`, `opencode async`, or `opencode observe`")
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
