import { AsyncLocalStorage } from "node:async_hooks"
import type { ModelSelection, Run, RunResult, SDKAgent, SDKMessage } from "@cursor/sdk/bundled"
import { createArtifactStore, defaultRunDirectory, serializeError, type ArtifactStore } from "./artifacts.ts"
import { CURSOR_RUNTIME_DIAGNOSTICS } from "./cursor-runtime.ts"
import type { PocResultArtifact } from "./types.ts"

export interface CursorRunOptions {
  prompt: string
  cwd?: string
  model?: string
  runDirectory?: string
  timeoutMs?: number
  apiKey?: string
  pid?: number
  onActivity?: (line: string) => void | Promise<void>
}

const DEFAULT_MODEL = "auto"

const stderrContext = new AsyncLocalStorage<ArtifactStore>()
const originalStderrWrite = process.stderr.write.bind(process.stderr)

// Cursor's bundled runtime reports ignore-scan diagnostics through stderr.
// Keep that channel separate from the PoC's human-readable stdout log without
// changing or suppressing the provider output. AsyncLocalStorage keeps the
// capture associated with the right artifact when live probes run concurrently.
process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
  const store = stderrContext.getStore()
  if (store) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    void store.writeStderr(text)
  }
  return (originalStderrWrite as (...writeArgs: unknown[]) => boolean)(chunk, ...args)
}) as typeof process.stderr.write

function modelSelection(model: string): ModelSelection {
  return { id: model }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function textFromAssistantEvent(event: SDKMessage): string[] {
  if (event.type !== "assistant" || !isRecord(event.message)) return []
  const content = event.message.content
  if (!Array.isArray(content)) return []

  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return []
    return [block.text]
  })
}

function activityLines(event: SDKMessage): string[] {
  switch (event.type) {
    case "assistant":
      return textFromAssistantEvent(event).map((text) => `[assistant] ${text}`)
    case "thinking":
      return event.text ? [`[thinking] ${event.text}`] : []
    case "tool_call":
      return [`[tool] ${event.name} ${event.status}`]
    case "status":
      return [`[status] ${event.status}${event.message ? `: ${event.message}` : ""}`]
    case "task":
      return [`[task] ${event.status ?? "update"}${event.text ? `: ${event.text}` : ""}`]
    case "request":
      return [`[request] ${event.request_id}`]
    case "usage":
      return [`[usage] ${event.usage.totalTokens} tokens`]
    case "system":
      return [`[system] ${event.subtype ?? "update"}`]
    case "user":
      return []
  }
  return []
}

async function activity(store: ArtifactStore, line: string, onActivity?: CursorRunOptions["onActivity"]): Promise<void> {
  await store.writeStdout(line)
  if (onActivity) await onActivity(line)
  else process.stdout.write(`${line}\n`)
}

function resultStatus(result: RunResult): "finished" | "error" | "cancelled" {
  return result.status
}

/**
 * Runs exactly one local Cursor agent prompt and records raw SDK events.
 * This is intentionally provider-specific and does not provide a runtime
 * abstraction for other providers.
 */
async function runCursorWithStore(
  options: CursorRunOptions,
  store: ArtifactStore,
  cwd: string,
  model: string,
): Promise<PocResultArtifact> {
  type CursorSdk = typeof import("@cursor/sdk/bundled")
  let Agent: CursorSdk["Agent"] | undefined
  let agent: SDKAgent | undefined
  let run: Run | undefined
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let cancellationRequestedAt: Date | undefined

  try {
    await activity(store, `[cursor] artifacts: ${store.runDirectory}`, options.onActivity)
    await activity(store, `[cursor] cwd: ${store.getManifest().cwd}`, options.onActivity)
    await activity(store, `[cursor] model: ${model}`, options.onActivity)
    await store.appendEvent("runtime_diagnostics", CURSOR_RUNTIME_DIAGNOSTICS)
    await activity(
      store,
      `[cursor] ripgrep: ${CURSOR_RUNTIME_DIAGNOSTICS.ripgrepWarningStatus} (${CURSOR_RUNTIME_DIAGNOSTICS.ripgrepConfiguration}${CURSOR_RUNTIME_DIAGNOSTICS.nativeRipgrepPath ? `: ${CURSOR_RUNTIME_DIAGNOSTICS.nativeRipgrepPath}` : ""})`,
      options.onActivity,
    )

    const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY
    if (!apiKey) throw new Error("CURSOR_API_KEY is required for a live Cursor run")

    // The runtime module has already set CURSOR_RIPGREP_PATH. Load the SDK
    // only after that startup configuration so a bundled entry cannot observe
    // an unconfigured native helper during module initialization.
    Agent = (await import("@cursor/sdk/bundled")).Agent

    agent = await Agent.create({
      apiKey,
      model: modelSelection(model),
      local: { cwd },
    })
    await store.update({ agentId: agent.agentId, status: "running" })
    await activity(store, `[cursor] agent: ${agent.agentId}`, options.onActivity)

    run = await agent.send(options.prompt)
    await store.update({
      runId: run.id,
      ...(run.requestId ? { requestId: run.requestId } : {}),
    })
    await activity(
      store,
      `[cursor] run: ${run.id}${run.requestId ? ` request=${run.requestId}` : ""}`,
      options.onActivity,
    )

    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        cancellationRequestedAt = new Date()
        void (async () => {
          await activity(store, `[timeout] cancelling after ${options.timeoutMs}ms`, options.onActivity)
          try {
            await run?.cancel()
          } catch (error) {
            await activity(store, `[timeout] cancellation failed: ${serializeError(error).message}`, options.onActivity)
          }
        })()
      }, options.timeoutMs)
    }

    const streamPromise = (async () => {
      for await (const event of run!.stream()) {
        await store.appendEvent(event.type, event)
        for (const line of activityLines(event)) await activity(store, line, options.onActivity)
      }
    })()

    const providerResult = await run.wait()
    await streamPromise
    if (timeoutHandle) clearTimeout(timeoutHandle)
    await store.flush()

    const artifact = await store.finish({
      status: resultStatus(providerResult),
      agentId: agent.agentId,
      runId: providerResult.id || run.id,
      ...(providerResult.requestId ?? run.requestId
        ? { requestId: providerResult.requestId ?? run.requestId }
        : {}),
      ...(providerResult.result !== undefined ? { result: providerResult.result } : {}),
      providerResult,
      ...(providerResult.error ? { error: serializeError(providerResult.error) } : {}),
      ...(cancellationRequestedAt ? { cancellationRequestedAt } : {}),
    })
    if (providerResult.error) {
      await activity(store, `[error] ${serializeError(providerResult.error).message}`, options.onActivity)
    }
    await activity(store, `[result] ${artifact.status} (${artifact.durationMs}ms)`, options.onActivity)
    await activity(store, `[result] artifact directory: ${store.runDirectory}`, options.onActivity)
    return artifact
  } catch (error) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    await store.flush()
    const serialized = serializeError(error)
    const artifact = await store.finish({
      status: cancellationRequestedAt ? "cancelled" : "error",
      ...(agent ? { agentId: agent.agentId } : {}),
      ...(run ? { runId: run.id } : {}),
      ...(run?.requestId ? { requestId: run.requestId } : {}),
      error: serialized,
      ...(cancellationRequestedAt ? { cancellationRequestedAt } : {}),
    })
    await activity(store, `[error] ${serialized.message}`, options.onActivity)
    await activity(store, `[result] artifact directory: ${store.runDirectory}`, options.onActivity)
    return artifact
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (agent) await agent[Symbol.asyncDispose]()
    await store.flush()
  }
}

export async function runCursor(options: CursorRunOptions): Promise<PocResultArtifact> {
  const cwd = options.cwd ?? process.cwd()
  const model = options.model ?? DEFAULT_MODEL
  const runDirectory = options.runDirectory ?? defaultRunDirectory("cursor")
  const store = await createArtifactStore({
    provider: "cursor",
    runDirectory,
    prompt: options.prompt,
    model,
    cwd,
    pid: options.pid,
    timeoutMs: options.timeoutMs,
    cursorRuntime: CURSOR_RUNTIME_DIAGNOSTICS,
  })

  return stderrContext.run(store, () => runCursorWithStore(options, store, cwd, model))
}

export { DEFAULT_MODEL }
