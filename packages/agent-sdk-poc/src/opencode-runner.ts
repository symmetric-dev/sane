import {
  createOpencodeClient,
  type GlobalEvent as SdkGlobalEvent,
  type Part as OpenCodePart,
  type SessionPromptResponse as OpenCodePromptResponseData,
} from "@opencode-ai/sdk"
import {
  createArtifactStore,
  correlateProviderEvent,
  defaultRunDirectory,
  serializeError,
  type ArtifactStore,
} from "./artifacts.ts"
import type { PocAsyncLaunchArtifact, PocResultArtifact } from "./types.ts"

export const DEFAULT_OPENCODE_SERVER_URL = "http://127.0.0.1:4096"
export const OPENCODE_SERVER_DEFAULT_MODEL = "server-default"

type RecordValue = Record<string, unknown>

export interface OpenCodeModelSelection {
  providerID: string
  modelID: string
}

export interface OpenCodePromptExtraction {
  data?: OpenCodePromptResponseData
  error?: unknown
  info?: RecordValue
  parts: OpenCodePart[]
  messageId?: string
  text?: string
}

/**
 * This is intentionally a small test seam around the generated SDK client.
 * It is not a provider-neutral runtime interface.
 */
export interface OpenCodeClientLike {
  session: {
    create(options: RecordValue): Promise<unknown>
    get(options: RecordValue): Promise<unknown>
    status(options?: RecordValue): Promise<unknown>
    messages(options: RecordValue): Promise<unknown>
    prompt(options: RecordValue): Promise<unknown>
    promptAsync?(options: RecordValue): Promise<unknown>
    abort?(options: RecordValue): Promise<unknown>
  }
  event: {
    subscribe(options?: RecordValue): Promise<{ stream: AsyncIterable<unknown> }>
  }
}

export interface OpenCodeRunOptions {
  serverUrl?: string
  prompt: string
  model?: string
  title?: string
  parentID?: string
  cwd?: string
  runDirectory?: string
  timeoutMs?: number
  pid?: number
  onActivity?: (line: string) => void | Promise<void>
  client?: OpenCodeClientLike
}

export interface OpenCodeObserveOptions {
  serverUrl?: string
  sessionId: string
  cwd?: string
  runDirectory?: string
  timeoutMs?: number
  pid?: number
  signal?: AbortSignal
  onActivity?: (line: string) => void | Promise<void>
  client?: OpenCodeClientLike
}

export interface OpenCodeAsyncOptions {
  serverUrl?: string
  prompt: string
  model?: string
  title?: string
  parentID?: string
  cwd?: string
  runDirectory?: string
  pid?: number
  onActivity?: (line: string) => void | Promise<void>
  client?: OpenCodeClientLike
}

interface EventSubscription {
  controller: AbortController
  stream: AsyncIterable<unknown> & {
    return?: () => Promise<unknown> | unknown
  }
  task: Promise<void>
  terminalState: { observed: boolean }
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function recordAt(value: unknown, ...keys: string[]): RecordValue | undefined {
  let current = value
  for (const key of keys) {
    if (!isRecord(current)) return undefined
    current = current[key]
  }
  return isRecord(current) ? current : undefined
}

function responseData(response: unknown): unknown {
  return isRecord(response) && "data" in response ? response.data : response
}

function responseError(response: unknown): unknown {
  return isRecord(response) && response.error !== undefined && response.error !== null ? response.error : undefined
}

function responseHasError(response: unknown): boolean {
  return responseError(response) !== undefined
}

export function extractOpenCodeResponseStatus(response: unknown): number | undefined {
  if (!isRecord(response)) return undefined
  const metadata = response.response
  if (isRecord(metadata) && typeof metadata.status === "number") return metadata.status
  if (typeof response.status === "number") return response.status
  return undefined
}

/** The installed SDK represents a successful prompt_async response as HTTP 204. */
export function isOpenCodePromptAsyncAccepted(response: unknown): boolean {
  if (responseHasError(response)) return false
  const status = extractOpenCodeResponseStatus(response)
  return status === undefined || (status >= 200 && status < 300)
}

function modelText(model: OpenCodeModelSelection): string {
  return `${model.providerID}/${model.modelID}`
}

export function normalizeOpenCodeServerUrl(serverUrl = DEFAULT_OPENCODE_SERVER_URL): string {
  let parsed: URL
  try {
    parsed = new URL(serverUrl)
  } catch {
    throw new Error(`OpenCode server URL is invalid: ${serverUrl}`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`OpenCode server URL must use HTTP(S): ${serverUrl}`)
  }
  return parsed.toString().replace(/\/$/, "")
}

export function parseOpenCodeModel(model: string): OpenCodeModelSelection {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`OpenCode model must use provider/model form: ${model}`)
  }
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  }
}

/** Normalize the SDK's default fields envelope without discarding the raw response. */
export function extractOpenCodePromptResponse(response: unknown): OpenCodePromptExtraction {
  const data = responseData(response)
  const payload = isRecord(data) ? data : undefined
  const info = payload && isRecord(payload.info) ? payload.info : undefined
  const parts = payload && Array.isArray(payload.parts) ? (payload.parts as OpenCodePart[]) : []
  const messageId = stringField(info?.id) ?? stringField(info?.messageId) ?? stringField(info?.messageID)
  const text = parts
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return []
      return [part.text]
    })
    .join("")

  return {
    ...(data !== undefined ? { data: data as OpenCodePromptResponseData } : {}),
    ...(responseError(response) !== undefined ? { error: responseError(response) } : {}),
    ...(info ? { info } : {}),
    parts,
    ...(messageId ? { messageId } : {}),
    ...(text ? { text } : {}),
  }
}

export function extractOpenCodeSessionId(response: unknown): string | undefined {
  const data = responseData(response)
  if (!isRecord(data)) return undefined
  return (
    stringField(data.id) ??
    stringField(data.sessionID) ??
    stringField(data.sessionId) ??
    stringField(recordAt(data, "info")?.id) ??
    stringField(recordAt(data, "session")?.id)
  )
}

export function extractOpenCodeSessionStatus(response: unknown, sessionId: string): unknown {
  const data = responseData(response)
  if (!isRecord(data)) return undefined
  return data[sessionId] ?? (data.id === sessionId ? data.status : undefined)
}

function eventPayload(raw: unknown): RecordValue | undefined {
  if (!isRecord(raw)) return undefined
  return isRecord(raw.payload) ? raw.payload : raw
}

function eventProperties(raw: unknown): RecordValue | undefined {
  const payload = eventPayload(raw)
  return payload && isRecord(payload.properties) ? payload.properties : undefined
}

function eventType(raw: unknown): string | undefined {
  return stringField(eventPayload(raw)?.type)
}

/** OpenCode's session-created event carries the session ID as info.id. */
export function openCodeEventSessionId(raw: unknown): string | undefined {
  const correlated = correlateProviderEvent(raw).sessionId
  if (correlated) return correlated
  const type = eventType(raw)
  if (!type?.startsWith("session.")) return undefined
  return stringField(recordAt(eventProperties(raw), "info")?.id)
}

/** The raw value yielded by the installed global SSE stream. */
export type OpenCodeGlobalEvent = SdkGlobalEvent

export function openCodeEventBelongsToSession(raw: unknown, sessionId: string): boolean {
  const eventSessionId = openCodeEventSessionId(raw)
  return eventSessionId === undefined || eventSessionId === sessionId
}

function openCodeEventSessionStatus(raw: unknown, sessionId: string | undefined): unknown {
  const eventSessionId = openCodeEventSessionId(raw)
  if (sessionId && eventSessionId !== sessionId) return undefined
  const type = eventType(raw)
  if (type === "session.idle") return { type: "idle" }
  if (type === "session.error") return { type: "error", error: eventProperties(raw)?.error }
  if (type !== "session.status") return undefined
  return recordAt(eventProperties(raw), "status")
}

export function openCodeActivityLines(raw: unknown): string[] {
  const type = eventType(raw)
  const properties = eventProperties(raw)
  if (!type) return []

  switch (type) {
    case "session.status": {
      const status = recordAt(properties, "status")
      return [`[status] ${stringField(status?.type) ?? "update"}`]
    }
    case "session.idle":
      return ["[status] idle"]
    case "session.error":
      return [`[error] ${serializeError(properties?.error ?? properties).message}`]
    case "message.updated": {
      const info = recordAt(properties, "info")
      return info?.role === "assistant" ? [`[assistant] message ${stringField(info.id) ?? "updated"}`] : ["[user] message updated"]
    }
    case "message.part.updated": {
      const part = recordAt(properties, "part")
      if (part?.type === "text" && typeof part.text === "string") return [`[assistant] ${part.text}`]
      if (part?.type === "reasoning" && typeof part.text === "string") return [`[thinking] ${part.text}`]
      if (part?.type === "tool") {
        const state = recordAt(part, "state")
        return [`[tool] ${stringField(part.tool) ?? "tool"} ${stringField(state?.status) ?? "update"}`]
      }
      return [`[part] ${String(part?.type ?? "updated")}`]
    }
    case "session.next.tool.called":
      return [`[tool] ${stringField(properties?.tool) ?? "tool"} called`]
    case "session.next.tool.success":
      return ["[tool] completed"]
    case "session.next.tool.failed":
      return ["[tool] failed"]
    case "session.next.text.delta":
      return typeof properties?.delta === "string" ? [`[assistant] ${properties.delta}`] : []
    case "session.next.reasoning.delta":
      return typeof properties?.delta === "string" ? [`[thinking] ${properties.delta}`] : []
    case "session.created":
      return [`[session] created ${stringField(recordAt(properties, "info")?.id) ?? ""}`.trim()]
    default:
      return [`[event] ${type}`]
  }
}

async function activity(store: ArtifactStore, line: string, onActivity?: (line: string) => void | Promise<void>): Promise<void> {
  await store.writeStdout(line)
  if (onActivity) await onActivity(line)
  else process.stdout.write(`${line}\n`)
}

function sdkClient(serverUrl: string, cwd: string): OpenCodeClientLike {
  return createOpencodeClient({ baseUrl: serverUrl, directory: cwd }) as unknown as OpenCodeClientLike
}

function requestOptions(cwd: string): RecordValue {
  return { query: { directory: cwd } }
}

function promptBody(prompt: string, model?: OpenCodeModelSelection): RecordValue {
  return {
    parts: [{ type: "text", text: prompt }],
    ...(model ? { model } : {}),
  }
}

/** Build the exact request consumed by the installed SDK's promptAsync method. */
export function buildOpenCodePromptAsyncRequest(
  sessionId: string,
  cwd: string,
  prompt: string,
  model?: OpenCodeModelSelection,
): RecordValue {
  return {
    path: { id: sessionId },
    ...requestOptions(cwd),
    body: promptBody(prompt, model),
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function consumeEvents(
  stream: AsyncIterable<unknown>,
  store: ArtifactStore,
  sessionId: string | undefined,
  onActivity?: (line: string) => void | Promise<void>,
  stopOnTerminalStatus = false,
  terminalState?: { observed: boolean },
): Promise<void> {
  for await (const raw of stream) {
    const belongs = !sessionId || openCodeEventBelongsToSession(raw, sessionId)
    await store.appendEvent(belongs ? "sse" : "sse_filtered", raw)
    if (!belongs) continue
    const sessionStatus = openCodeEventSessionStatus(raw, sessionId)
    if (sessionStatus !== undefined) await store.update({ sessionStatus })
    for (const line of openCodeActivityLines(raw)) await activity(store, line, onActivity)
    if (stopOnTerminalStatus && openCodeEventIsTerminal(raw, sessionId)) {
      if (terminalState) terminalState.observed = true
      return
    }
  }
}

function openCodeEventIsTerminal(raw: unknown, sessionId: string | undefined): boolean {
  const eventSessionId = openCodeEventSessionId(raw)
  if (sessionId && eventSessionId !== sessionId) return false
  const type = eventType(raw)
  if (type === "session.idle" || type === "session.error") return true
  if (type !== "session.status") return false
  return recordAt(eventProperties(raw), "status")?.type === "idle"
}

async function startEventSubscription(
  client: OpenCodeClientLike,
  cwd: string,
  store: ArtifactStore,
  sessionId: string | undefined,
  onActivity?: (line: string) => void | Promise<void>,
  stopOnTerminalStatus = false,
): Promise<EventSubscription> {
  const controller = new AbortController()
  const terminalState = { observed: false }
  const subscription = await client.event.subscribe({
    ...requestOptions(cwd),
    signal: controller.signal,
    sseMaxRetryAttempts: 0,
    sseDefaultRetryDelay: 0,
  })
  const stream = subscription.stream as AsyncIterable<unknown> & {
    return?: () => Promise<unknown> | unknown
  }
  const task = consumeEvents(stream, store, sessionId, onActivity, stopOnTerminalStatus, terminalState).catch(async (error) => {
    if (!controller.signal.aborted) {
      await store.appendEvent("sse_error", serializeError(error))
      await activity(store, `[sse] ${serializeError(error).message}`, onActivity)
    }
  })
  return { controller, stream, task, terminalState }
}

async function stopEventSubscription(subscription: EventSubscription | undefined): Promise<void> {
  if (!subscription) return
  subscription.controller.abort()
  const stopped = await bounded(subscription.task.then(() => true), 1_000)
  if (stopped !== true) {
    try {
      await subscription.stream.return?.()
    } catch {
      // The SDK has no client close method; returning the async stream is the
      // best-effort release path for a custom/fake stream that ignores abort.
    }
    await bounded(subscription.task, 250)
  }
}

async function recordMessages(store: ArtifactStore, response: unknown): Promise<string | undefined> {
  await store.appendEvent("messages_response", response)
  const data = responseData(response)
  if (!Array.isArray(data)) return undefined
  let latestMessageId: string | undefined
  for (const message of data) {
    await store.appendEvent("message", message)
    if (!isRecord(message) || !Array.isArray(message.parts)) continue
    const info = isRecord(message.info) ? message.info : undefined
    latestMessageId = stringField(info?.id) ?? latestMessageId
    for (const part of message.parts) await store.appendEvent("part", part)
  }
  return latestMessageId
}

async function recordPromptResponse(store: ArtifactStore, response: unknown): Promise<OpenCodePromptExtraction> {
  const extracted = extractOpenCodePromptResponse(response)
  await store.appendEvent("prompt_response", response)
  if (extracted.info) await store.appendEvent("message", extracted.info)
  for (const part of extracted.parts) await store.appendEvent("part", part)
  return extracted
}

async function recordSessionStatus(
  client: OpenCodeClientLike,
  store: ArtifactStore,
  cwd: string,
  sessionId: string,
): Promise<unknown> {
  const response = await client.session.status(requestOptions(cwd))
  await store.appendEvent("session_status", response)
  const status = extractOpenCodeSessionStatus(response, sessionId)
  if (status !== undefined) await store.update({ sessionStatus: status })
  return status
}

async function requestSessionAbort(
  client: OpenCodeClientLike,
  store: ArtifactStore,
  cwd: string,
  sessionId: string,
  onActivity?: (line: string) => void | Promise<void>,
): Promise<void> {
  if (!client.session.abort) {
    await activity(store, "[timeout] SDK session.abort is unavailable", onActivity)
    return
  }
  const abortController = new AbortController()
  const abortTimeout = setTimeout(() => abortController.abort(), 1_500)
  try {
    const response = await client.session.abort({ path: { id: sessionId }, ...requestOptions(cwd), signal: abortController.signal })
    await store.appendEvent("session_abort", response)
    await activity(store, "[timeout] session.abort completed", onActivity)
  } catch (error) {
    await store.appendEvent("session_abort_error", serializeError(error))
    await activity(store, `[timeout] session.abort failed: ${serializeError(error).message}`, onActivity)
  } finally {
    clearTimeout(abortTimeout)
  }
}

async function runOpenCodeWithStore(
  options: OpenCodeRunOptions,
  store: ArtifactStore,
  serverUrl: string,
  cwd: string,
  model: OpenCodeModelSelection | undefined,
): Promise<PocResultArtifact> {
  const client = options.client ?? sdkClient(serverUrl, cwd)
  let sessionId: string | undefined
  let messageId: string | undefined
  let sessionStatus: unknown
  let observer: EventSubscription | undefined
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let cancellationRequestedAt: Date | undefined
  let cancellationPromise: Promise<void> | undefined
  let promptResponse: unknown

  const stopObserver = async (): Promise<void> => {
    const current = observer
    observer = undefined
    await stopEventSubscription(current)
  }

  try {
    await activity(store, `[opencode] artifacts: ${store.runDirectory}`, options.onActivity)
    await activity(store, `[opencode] server: ${serverUrl}`, options.onActivity)
    await activity(store, `[opencode] cwd: ${cwd}`, options.onActivity)
    await activity(store, `[opencode] model: ${model ? modelText(model) : "server default"}`, options.onActivity)

    const sessionResponse = await client.session.create({
      ...requestOptions(cwd),
      ...(options.title || options.parentID ? { body: { ...(options.title ? { title: options.title } : {}), ...(options.parentID ? { parentID: options.parentID } : {}) } } : {}),
    })
    if (responseHasError(sessionResponse)) {
      await store.appendEvent("session_created", sessionResponse)
      throw responseError(sessionResponse)
    }
    sessionId = extractOpenCodeSessionId(sessionResponse)
    if (!sessionId) {
      await store.appendEvent("session_created", sessionResponse)
      throw new Error("OpenCode session.create response did not contain a native session ID")
    }
    await store.update({ sessionId, status: "running" })
    await store.appendEvent("session_created", sessionResponse)
    await activity(store, `[opencode] session: ${sessionId}`, options.onActivity)

    // The subscription is started before the synchronous prompt request. The
    // SDK's SSE generator receives its AbortSignal so it cannot keep the CLI
    // alive after the prompt completes.
    observer = await startEventSubscription(client, cwd, store, sessionId, options.onActivity)
    await activity(store, "[opencode] event observer: subscribed", options.onActivity)

    const promptController = new AbortController()
    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        cancellationRequestedAt = new Date()
        promptController.abort()
        cancellationPromise = requestSessionAbort(client, store, cwd, sessionId!, options.onActivity)
      }, options.timeoutMs)
    }

    promptResponse = await client.session.prompt({
      path: { id: sessionId },
      ...requestOptions(cwd),
      body: promptBody(options.prompt, model),
      signal: promptController.signal,
    })
    if (cancellationPromise) await bounded(cancellationPromise, 2_000)

    const extracted = await recordPromptResponse(store, promptResponse)
    messageId = extracted.messageId
    if (messageId) await store.update({ messageId })
    try {
      sessionStatus = await recordSessionStatus(client, store, cwd, sessionId)
    } catch (error) {
      await store.appendEvent("session_status_error", serializeError(error))
    }
    await stopObserver()

    const error = extracted.error ?? (isRecord(extracted.info) ? extracted.info.error : undefined)
    const status = cancellationRequestedAt ? "cancelled" : error ? "error" : "finished"
    const result = extracted.text
    await store.appendEvent("terminal_result", { status, result, providerResult: promptResponse })
    const artifact = await store.finish({
      status,
      ...(sessionId ? { sessionId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(result !== undefined ? { result } : {}),
      providerResult: promptResponse,
      ...(error ? { error: serializeError(error) } : {}),
      ...(sessionStatus !== undefined ? { sessionStatus } : {}),
      ...(cancellationRequestedAt ? { cancellationRequestedAt } : {}),
    })
    if (error) await activity(store, `[error] ${serializeError(error).message}`, options.onActivity)
    await activity(store, `[result] ${artifact.status} (${artifact.durationMs}ms)`, options.onActivity)
    await activity(store, `[result] artifact directory: ${store.runDirectory}`, options.onActivity)
    return artifact
  } catch (error) {
    await stopObserver()
    if (cancellationPromise) await bounded(cancellationPromise, 2_000)
    const serialized = serializeError(error)
    const artifact = await store.finish({
      status: cancellationRequestedAt ? "cancelled" : "error",
      ...(sessionId ? { sessionId } : {}),
      ...(messageId ? { messageId } : {}),
      ...(promptResponse !== undefined ? { providerResult: promptResponse } : {}),
      error: serialized,
      ...(cancellationRequestedAt ? { cancellationRequestedAt } : {}),
    })
    await activity(store, `[error] ${serialized.message}`, options.onActivity)
    await activity(store, `[result] artifact directory: ${store.runDirectory}`, options.onActivity)
    return artifact
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    await stopObserver()
    if (cancellationPromise) await bounded(cancellationPromise, 2_000)
    await store.flush()
  }
}

/** Run one synchronous OpenCode prompt against an already-running server. */
export async function runOpenCode(options: OpenCodeRunOptions): Promise<PocResultArtifact> {
  const serverUrl = normalizeOpenCodeServerUrl(options.serverUrl)
  const cwd = options.cwd ?? process.cwd()
  const model = options.model === undefined ? undefined : parseOpenCodeModel(options.model)
  const runDirectory = options.runDirectory ?? defaultRunDirectory("opencode")
  const store = await createArtifactStore({
    provider: "opencode",
    runDirectory,
    prompt: options.prompt,
    model: options.model ?? OPENCODE_SERVER_DEFAULT_MODEL,
    cwd,
    pid: options.pid,
    timeoutMs: options.timeoutMs,
    serverUrl,
    sessionTitle: options.title,
  })
  return runOpenCodeWithStore(options, store, serverUrl, cwd, model)
}

export type OpenCodeAsyncLaunchResult = PocAsyncLaunchArtifact | PocResultArtifact

/**
 * Create a native session and submit OpenCode's prompt_async request. This
 * function intentionally never subscribes to SSE and never owns the server.
 * Its successful artifact is running/nonterminal so a separate observer can
 * inspect the session after this process exits.
 */
export async function launchOpenCodeAsync(options: OpenCodeAsyncOptions): Promise<OpenCodeAsyncLaunchResult> {
  const serverUrl = normalizeOpenCodeServerUrl(options.serverUrl)
  const cwd = options.cwd ?? process.cwd()
  const model = options.model === undefined ? undefined : parseOpenCodeModel(options.model)
  const runDirectory = options.runDirectory ?? defaultRunDirectory("opencode")
  const store = await createArtifactStore({
    provider: "opencode",
    runDirectory,
    prompt: options.prompt,
    model: options.model ?? OPENCODE_SERVER_DEFAULT_MODEL,
    cwd,
    pid: options.pid,
    serverUrl,
    sessionTitle: options.title,
    launchKind: "async",
    observerRequired: true,
  })
  const client = options.client ?? sdkClient(serverUrl, cwd)
  let sessionId: string | undefined
  let promptResponse: unknown

  try {
    await activity(store, `[opencode] async artifacts: ${store.runDirectory}`, options.onActivity)
    await activity(store, `[opencode] server: ${serverUrl}`, options.onActivity)
    await activity(store, `[opencode] cwd: ${cwd}`, options.onActivity)
    await activity(store, `[opencode] model: ${model ? modelText(model) : "server default"}`, options.onActivity)

    const sessionResponse = await client.session.create({
      ...requestOptions(cwd),
      ...(options.title || options.parentID
        ? {
            body: {
              ...(options.title ? { title: options.title } : {}),
              ...(options.parentID ? { parentID: options.parentID } : {}),
            },
          }
        : {}),
    })
    await store.appendEvent("session_created", sessionResponse)
    if (responseHasError(sessionResponse)) throw responseError(sessionResponse)
    sessionId = extractOpenCodeSessionId(sessionResponse)
    if (!sessionId) throw new Error("OpenCode session.create response did not contain a native session ID")

    // This awaited write is the disconnect/reconnect boundary: the native ID
    // is durable in the launch manifest before prompt_async is called.
    await store.update({ sessionId, status: "running" })
    await activity(store, `[opencode] session: ${sessionId}`, options.onActivity)

    if (!client.session.promptAsync) throw new Error("Installed OpenCode SDK client does not expose session.promptAsync")
    const request = buildOpenCodePromptAsyncRequest(sessionId, cwd, options.prompt, model)
    const requestStartedAt = new Date()
    await store.update({ asyncRequestStartedAt: requestStartedAt.toISOString() })
    await store.appendEvent("prompt_async_request", { request, requestStartedAt: requestStartedAt.toISOString() }, requestStartedAt)

    promptResponse = await client.session.promptAsync(request)
    const requestCompletedAt = new Date()
    await store.appendEvent("prompt_async_response", promptResponse, requestCompletedAt)
    const responseStatus = extractOpenCodeResponseStatus(promptResponse)
    if (!isOpenCodePromptAsyncAccepted(promptResponse)) {
      const rejection = responseError(promptResponse) ?? {
        message: `OpenCode prompt_async was not accepted (HTTP ${responseStatus ?? "unknown"})`,
      }
      await store.appendEvent("prompt_async_rejected", rejection, requestCompletedAt)
      throw rejection
    }

    const artifact = await store.recordAsyncAccepted({
      sessionId,
      response: promptResponse,
      requestStartedAt,
      requestCompletedAt,
      acceptedAt: requestCompletedAt,
      ...(responseStatus !== undefined ? { responseStatus } : {}),
    })
    await activity(store, `[result] async accepted (HTTP ${responseStatus ?? "unknown"})`, options.onActivity)
    await activity(store, `[result] session ID: ${artifact.sessionId}`, options.onActivity)
    await activity(store, `[result] observer required for terminal status`, options.onActivity)
    await activity(store, `[result] artifact directory: ${artifact.runDirectory}`, options.onActivity)
    return artifact
  } catch (error) {
    const serialized = serializeError(error)
    const artifact = await store.finish({
      status: "error",
      ...(sessionId ? { sessionId } : {}),
      ...(promptResponse !== undefined ? { providerResult: promptResponse } : {}),
      error: serialized,
    })
    await activity(store, `[error] ${serialized.message}`, options.onActivity)
    await activity(store, `[result] artifact directory: ${store.runDirectory}`, options.onActivity)
    return artifact
  } finally {
    await store.flush()
  }
}

async function inspectSession(
  client: OpenCodeClientLike,
  store: ArtifactStore,
  cwd: string,
  sessionId: string,
  onActivity?: (line: string) => void | Promise<void>,
): Promise<void> {
  const sessionResponse = await client.session.get({ path: { id: sessionId }, ...requestOptions(cwd) })
  await store.appendEvent("session", sessionResponse)
  if (responseHasError(sessionResponse)) throw responseError(sessionResponse)
  const session = responseData(sessionResponse)
  if (isRecord(session)) await activity(store, `[session] ${stringField(session.title) ?? sessionId}`, onActivity)

  const statusResponse = await client.session.status(requestOptions(cwd))
  await store.appendEvent("session_status", statusResponse)
  const status = extractOpenCodeSessionStatus(statusResponse, sessionId)
  if (status !== undefined) {
    await store.update({ sessionStatus: status })
    await activity(store, `[status] ${stringField(isRecord(status) ? status.type : undefined) ?? "unknown"}`, onActivity)
  }

  const messagesResponse = await client.session.messages({ path: { id: sessionId }, ...requestOptions(cwd) })
  if (responseHasError(messagesResponse)) throw responseError(messagesResponse)
  const latestMessageId = await recordMessages(store, messagesResponse)
  if (latestMessageId) await store.update({ messageId: latestMessageId })
  const messages = responseData(messagesResponse)
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isRecord(message)) continue
      const info = isRecord(message.info) ? message.info : undefined
      if (info?.role === "assistant") await activity(store, `[assistant] message ${stringField(info.id) ?? "updated"}`, onActivity)
    }
  }
}

/** Attach to an existing session, inspect it, then follow its global SSE feed. */
export async function observeOpenCode(options: OpenCodeObserveOptions): Promise<PocResultArtifact> {
  const serverUrl = normalizeOpenCodeServerUrl(options.serverUrl)
  const cwd = options.cwd ?? process.cwd()
  const runDirectory = options.runDirectory ?? defaultRunDirectory("opencode")
  const store = await createArtifactStore({
    provider: "opencode",
    runDirectory,
    prompt: `observe session ${options.sessionId}`,
    model: OPENCODE_SERVER_DEFAULT_MODEL,
    cwd,
    pid: options.pid,
    timeoutMs: options.timeoutMs,
    serverUrl,
    launchKind: "observe",
  })
  const client = options.client ?? sdkClient(serverUrl, cwd)
  let observer: EventSubscription | undefined
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let cancellationRequestedAt: Date | undefined
  let removeSignalListener: (() => void) | undefined

  try {
    await store.update({ sessionId: options.sessionId, status: "running" })
    await activity(store, `[opencode] observing session: ${options.sessionId}`, options.onActivity)
    await activity(store, `[opencode] server: ${serverUrl}`, options.onActivity)
    await inspectSession(client, store, cwd, options.sessionId, options.onActivity)
    observer = await startEventSubscription(client, cwd, store, options.sessionId, options.onActivity, true)
    await activity(store, "[opencode] event observer: subscribed", options.onActivity)

    const stopSignal = () => {
      cancellationRequestedAt ??= new Date()
      observer?.controller.abort()
    }
    if (options.signal) {
      if (options.signal.aborted) stopSignal()
      else {
        options.signal.addEventListener("abort", stopSignal, { once: true })
        removeSignalListener = () => options.signal?.removeEventListener("abort", stopSignal)
      }
    }
    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(stopSignal, options.timeoutMs)
    }

    await observer.task
    const terminalObserved = observer.terminalState.observed
    await stopEventSubscription(observer)
    observer = undefined
    // Re-read status and messages after the SSE follow. This is the recovery
    // path for an observer started after the async launcher disconnected.
    await inspectSession(client, store, cwd, options.sessionId, options.onActivity)
    const status = cancellationRequestedAt ? "cancelled" : "finished"
    await store.appendEvent("terminal_result", {
      status,
      sessionId: options.sessionId,
      terminalObserved,
      observationStopped: cancellationRequestedAt ? "timeout-or-signal" : terminalObserved ? "terminal-status" : "stream-ended",
    })
    const artifact = await store.finish({
      status,
      sessionId: options.sessionId,
      ...(cancellationRequestedAt ? { cancellationRequestedAt } : {}),
      ...(store.getManifest().sessionStatus !== undefined ? { sessionStatus: store.getManifest().sessionStatus } : {}),
    })
    await activity(store, `[result] ${artifact.status} (${artifact.durationMs}ms)`, options.onActivity)
    await activity(store, `[result] artifact directory: ${store.runDirectory}`, options.onActivity)
    return artifact
  } catch (error) {
    await stopEventSubscription(observer)
    observer = undefined
    const serialized = serializeError(error)
    const artifact = await store.finish({
      status: cancellationRequestedAt ? "cancelled" : "error",
      sessionId: options.sessionId,
      error: serialized,
      ...(cancellationRequestedAt ? { cancellationRequestedAt } : {}),
    })
    await activity(store, `[error] ${serialized.message}`, options.onActivity)
    await activity(store, `[result] artifact directory: ${store.runDirectory}`, options.onActivity)
    return artifact
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    removeSignalListener?.()
    await stopEventSubscription(observer)
    await store.flush()
  }
}
