import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

const DEFAULT_WORKSTREAM_TOOL_LOG_PATH = join(tmpdir(), "agenv-workstream-tool.log")

type LogDetails = Record<string, unknown> | undefined

function normalizeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (typeof value === "string") {
    return value.length > 2000 ? `${value.slice(0, 2000)}…` : value
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => normalizeValue(entry))
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, normalizeValue(entry)]),
    )
  }

  return value
}

export function getWorkstreamToolLogPath(): string {
  const configured = process.env.WORKSTREAM_TOOL_LOG_PATH?.trim()
  return configured && configured.length > 0 ? configured : DEFAULT_WORKSTREAM_TOOL_LOG_PATH
}

export function logWorkstreamToolEvent(component: string, step: string, details?: LogDetails): void {
  const logPath = getWorkstreamToolLogPath()

  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        component,
        step,
        ...(details ? { details: normalizeValue(details) } : {}),
      })}\n`,
      "utf-8",
    )
  } catch {
    // Logging must never break the runtime.
  }
}

export async function logWorkstreamToolAsyncStep<T>(args: {
  component: string
  step: string
  details?: LogDetails
  run: () => Promise<T>
}): Promise<T> {
  logWorkstreamToolEvent(args.component, `${args.step}:start`, args.details)
  try {
    const result = await args.run()
    logWorkstreamToolEvent(args.component, `${args.step}:success`)
    return result
  } catch (error) {
    logWorkstreamToolEvent(args.component, `${args.step}:error`, { error })
    throw error
  }
}

export function logWorkstreamToolStep<T>(args: {
  component: string
  step: string
  details?: LogDetails
  run: () => T
}): T {
  logWorkstreamToolEvent(args.component, `${args.step}:start`, args.details)
  try {
    const result = args.run()
    logWorkstreamToolEvent(args.component, `${args.step}:success`)
    return result
  } catch (error) {
    logWorkstreamToolEvent(args.component, `${args.step}:error`, { error })
    throw error
  }
}
