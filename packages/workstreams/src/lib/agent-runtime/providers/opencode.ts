import { createOpencodeClient } from "@opencode-ai/sdk"
import { isValidOpenCodeModel } from "../../model.ts"
import { normalizeAttemptError } from "../execute.ts"
import type {
  AgentAttemptAdapter,
  AgentAttemptError,
  AgentEvent,
  AgentProvider,
  AgentUsage,
  AttemptInput,
  AttemptResult,
  CancelResult,
  NativeAttempt,
  ProviderMetadata,
} from "../contracts.ts"

/** The default is only an endpoint default; this adapter never owns it. */
export const DEFAULT_OPENCODE_SERVER_URL = "http://127.0.0.1:4096"

type RecordValue = Record<string, unknown>
type ClockValue = string | number | Date
type AgentEventPayload = RecordValue & { type: AgentEvent["type"] }

/**
 * A deliberately small provider-local seam around the generated V1 SDK.
 *
 * It uses unknown request/response values on purpose: generated SDK types do
 * not cross the provider-neutral AgentAttemptAdapter boundary, and this seam
 * makes all unit tests independent of a running OpenCode server.
 */
export interface OpenCodeClientLike {
  session: {
    create(options: RecordValue): Promise<unknown>
    prompt(options: RecordValue): Promise<unknown>
    abort?(options: RecordValue): Promise<unknown>
  }
  event: {
    subscribe(options?: RecordValue): Promise<{
      stream: AsyncIterable<unknown> & {
        return?: () => Promise<unknown> | unknown
      }
    }>
  }
}

export interface OpenCodeClientFactoryOptions {
  serverUrl: string
  cwd: string
}

export type OpenCodeClientFactory =
  | ((options: OpenCodeClientFactoryOptions) => OpenCodeClientLike | Promise<OpenCodeClientLike>)
  | ((serverUrl: string, cwd: string) => OpenCodeClientLike | Promise<OpenCodeClientLike>)

export interface OpenCodeV1AdapterOptions {
  serverUrl: string
  cwd: string
  /** An injected client is preferred in unit tests. */
  client?: OpenCodeClientLike
  /** Used when a test needs to observe client construction or provide a fake. */
  clientFactory?: OpenCodeClientFactory
  timeoutMs?: number
  clock?: () => ClockValue
  /** Bounds abort/stream cleanup; it does not bound provider execution itself. */
  cleanupTimeoutMs?: number
}

export interface OpenCodeModelSelection {
  providerID: string
  modelID: string
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

class AsyncEventQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.values.push(value)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ done: true, value: undefined as never })
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.closed) return Promise.resolve({ done: true, value: undefined as never })
    return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve))
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}

interface EventSubscription {
  controller: AbortController
  stream: AsyncIterable<unknown> & {
    return?: () => Promise<unknown> | unknown
  }
  task: Promise<void>
  intentionalStop: boolean
}

interface AttemptState {
  input: AttemptInput
  native: NativeAttempt
  client: OpenCodeClientLike
  model: OpenCodeModelSelection
  queue: AsyncEventQueue<AgentEvent>
  eventSequence: number
  terminalEventEmitted: boolean
  terminalResult?: AttemptResult
  subscription?: EventSubscription
  streamFailure?: AgentAttemptError
  streamFailureSignal: Deferred<void>
  cancelSignal: Deferred<"cancel" | "timeout">
  cancellationKind?: "cancel" | "timeout"
  cancellationReason?: string
  promptController?: AbortController
  abortPromise?: Promise<void>
  cancellationSettlePromise?: Promise<AttemptResult>
  timeoutHandle?: ReturnType<typeof setTimeout>
  nativeMessageId?: string
  pendingUsage?: Array<{ usage: AgentUsage; diagnostic: unknown }>
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
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
  if (!isRecord(response)) return undefined
  return response.error === undefined || response.error === null ? undefined : response.error
}

function responseStatus(response: unknown): number | undefined {
  if (!isRecord(response)) return undefined
  const responseMetadata = response.response
  return (
    numberField(isRecord(responseMetadata) ? responseMetadata.status : undefined) ??
    numberField(response.status)
  )
}

function providerError(raw: unknown, fallback = "OpenCode provider error"): AgentAttemptError {
  const normalized = normalizeAttemptError(raw)
  if (!isRecord(raw)) {
    return {
      ...normalized,
      message: normalized.message || fallback,
      diagnostic: { raw },
    }
  }

  const data = isRecord(raw.data) ? raw.data : undefined
  const message =
    stringField(raw.message) ??
    stringField(data?.message) ??
    stringField(raw.error) ??
    (stringField(raw.name) ? `${raw.name}` : fallback)
  const code = stringField(raw.code) ?? stringField(data?.code) ?? stringField(raw.name)
  const retryable =
    typeof raw.retryable === "boolean"
      ? raw.retryable
      : typeof data?.isRetryable === "boolean"
        ? data.isRetryable
        : undefined

  return {
    ...normalized,
    message,
    ...(stringField(raw.name) === undefined ? {} : { name: stringField(raw.name) }),
    ...(code === undefined ? {} : { code }),
    ...(retryable === undefined ? {} : { retryable }),
    diagnostic: { raw },
  }
}

/** Parse the resolved OpenCode provider/model identifier without guessing a runtime. */
export function parseOpenCodeModel(model: string): OpenCodeModelSelection {
  if (!isValidOpenCodeModel(model)) {
    throw new Error(`OpenCode model must use provider/model form: ${model}`)
  }
  const separator = model.indexOf("/")
  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  }
}

function requestDirectory(cwd: string): RecordValue {
  return { query: { directory: cwd } }
}

/** Exact V1 session.create request shape used by this adapter. */
export function buildOpenCodeSessionCreateRequest(cwd: string, title: string): RecordValue {
  return {
    ...requestDirectory(cwd),
    body: { title },
  }
}

/**
 * Exact V1 session.prompt request shape. The SDK has no variant field in its
 * installed V1 prompt body, so variants are retained in adapter metadata.
 * An unset model is intentionally omitted by this provider-local helper; a
 * resolved OpenCode AttemptInput always supplies one and is mapped below.
 */
export function buildOpenCodePromptRequest(
  sessionId: string,
  cwd: string,
  prompt: string,
  model?: OpenCodeModelSelection,
  signal?: AbortSignal,
): RecordValue {
  return {
    path: { id: sessionId },
    ...requestDirectory(cwd),
    body: {
      parts: [{ type: "text", text: prompt }],
      ...(model === undefined ? {} : { model }),
    },
    ...(signal === undefined ? {} : { signal }),
  }
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

function nestedRecords(value: unknown, depth = 0): RecordValue[] {
  if (!isRecord(value)) return []
  const records: RecordValue[] = [value]
  if (depth >= 3) return records
  for (const key of ["payload", "properties", "info", "part", "status", "error", "message"]) {
    const nested = value[key]
    if (isRecord(nested)) records.push(...nestedRecords(nested, depth + 1))
  }
  return records
}

function eventSessionId(raw: unknown): string | undefined {
  const type = eventType(raw)
  const records = nestedRecords(raw)
  for (const record of records) {
    for (const key of ["sessionID", "sessionId", "session_id"]) {
      const sessionId = stringField(record[key])
      if (sessionId) return sessionId
    }
  }

  // session.created is the one event whose info.id is itself the session ID.
  if (type === "session.created") return stringField(recordAt(eventProperties(raw), "info")?.id)
  return undefined
}

function eventBelongsToSession(raw: unknown, sessionId: string): boolean {
  return eventSessionId(raw) === sessionId
}

function usageFromTokens(tokens: unknown, cost?: unknown): AgentUsage | undefined {
  if (!isRecord(tokens)) return undefined
  const inputTokens = numberField(tokens.input)
  const outputTokens = numberField(tokens.output)
  const reasoningTokens = numberField(tokens.reasoning)
  const cache = isRecord(tokens.cache) ? tokens.cache : undefined
  const cachedInputTokens = numberField(cache?.read)
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    cachedInputTokens === undefined &&
    numberField(cost) === undefined
  ) {
    return undefined
  }

  const totalTokens =
    inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0)
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(numberField(cost) === undefined ? {} : { cost: numberField(cost) }),
  }
}

function infoFromPromptResponse(response: unknown): RecordValue | undefined {
  return recordAt(responseData(response), "info")
}

function partsFromPromptResponse(response: unknown): unknown[] {
  const parts = responseData(response)
  return isRecord(parts) && Array.isArray(parts.parts) ? parts.parts : []
}

function messageIdFromPromptResponse(response: unknown): string | undefined {
  const info = infoFromPromptResponse(response)
  return stringField(info?.id) ?? stringField(info?.messageId) ?? stringField(info?.messageID)
}

function textFromParts(parts: readonly unknown[]): string | undefined {
  const text = parts
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return []
      return [part.text]
    })
    .join("")
  return text.length === 0 ? undefined : text
}

function responseFailure(response: unknown): unknown {
  return responseError(response) ?? recordAt(responseData(response), "info")?.error
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<{ value?: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      promise.then((result) => ({ value: result, timedOut: false })),
      new Promise<{ value?: T; timedOut: boolean }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      }),
    ])
    return value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function clockTimestamp(clock: () => ClockValue): string {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error("OpenCode adapter clock returned an invalid timestamp")
  return date.toISOString()
}

function normalizeServerUrl(serverUrl: string): string {
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

export class OpenCodeV1Adapter implements AgentAttemptAdapter {
  readonly executionBackend = "sdk" as const
  readonly provider: AgentProvider = "opencode"

  readonly serverUrl: string
  readonly cwd: string

  private readonly timeoutMs?: number
  private readonly cleanupTimeoutMs: number
  private readonly clock: () => ClockValue
  private readonly injectedClient?: OpenCodeClientLike
  private readonly clientFactory: OpenCodeClientFactory
  private client?: OpenCodeClientLike
  private readonly attempts = new Map<string, AttemptState>()
  private closed = false
  private closePromise?: Promise<void>

  constructor(options: OpenCodeV1AdapterOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl)
    this.cwd = options.cwd
    this.timeoutMs = options.timeoutMs
    this.cleanupTimeoutMs = Math.max(1, options.cleanupTimeoutMs ?? 1_500)
    this.clock = options.clock ?? (() => new Date())
    this.injectedClient = options.client
    this.clientFactory =
      options.clientFactory ??
      ((factoryOptions: OpenCodeClientFactoryOptions) =>
        createOpencodeClient({
          baseUrl: factoryOptions.serverUrl,
          directory: factoryOptions.cwd,
        }) as unknown as OpenCodeClientLike)
  }

  private async getClient(): Promise<OpenCodeClientLike> {
    if (this.client) return this.client
    const client = this.injectedClient ??
      (await (this.clientFactory.length >= 2
        ? (this.clientFactory as (serverUrl: string, cwd: string) => OpenCodeClientLike | Promise<OpenCodeClientLike>)(
            this.serverUrl,
            this.cwd,
          )
        : (this.clientFactory as (options: OpenCodeClientFactoryOptions) => OpenCodeClientLike | Promise<OpenCodeClientLike>)({
            serverUrl: this.serverUrl,
            cwd: this.cwd,
          })))
    if (!client || typeof client !== "object") throw new Error("OpenCode client factory returned no client")
    this.client = client
    return client
  }

  private stateFor(attempt: NativeAttempt): AttemptState | undefined {
    const state = this.attempts.get(attempt.attemptId)
    if (!state || state.native.nativeSessionId !== attempt.nativeSessionId) return undefined
    return state
  }

  private correlation(state: AttemptState): Pick<AgentEvent, "provider" | "attemptId" | "workSessionId" | "nativeSessionId" | "nativeRunId"> {
    return {
      provider: "opencode",
      attemptId: state.input.attemptId,
      workSessionId: state.input.workSessionId,
      ...(state.native.nativeSessionId === undefined ? {} : { nativeSessionId: state.native.nativeSessionId }),
      ...(state.native.nativeRunId === undefined ? {} : { nativeRunId: state.native.nativeRunId }),
    }
  }

  private emit(state: AttemptState, event: AgentEventPayload): void {
    const correlation = this.correlation(state)
    state.queue.push({
      ...correlation,
      eventId: `${state.input.attemptId}:event-${++state.eventSequence}`,
      timestamp: clockTimestamp(this.clock),
      ...event,
    } as AgentEvent)
  }

  private providerMetadata(state: AttemptState, rawResponse?: unknown): ProviderMetadata {
    return {
      providerID: state.model.providerID,
      modelID: state.model.modelID,
      ...(state.input.model.variant === undefined ? {} : { variant: state.input.model.variant }),
      ...(state.nativeMessageId === undefined ? {} : { messageId: state.nativeMessageId }),
      ...(rawResponse === undefined ? {} : { diagnostic: { response: rawResponse } }),
    }
  }

  private terminalEventForResult(state: AttemptState, result: AttemptResult): void {
    if (state.terminalEventEmitted) return
    state.terminalEventEmitted = true
    if (result.status === "completed") {
      this.emit(state, {
        type: "completed",
        result: result.result,
        diagnostic: result.providerMetadata?.diagnostic,
      })
    } else if (result.status === "failed") {
      this.emit(state, {
        type: "failed",
        error: result.error,
        diagnostic: result.error.diagnostic,
      })
    } else {
      this.emit(state, {
        type: "cancelled",
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.error === undefined ? {} : { diagnostic: result.error.diagnostic }),
      })
    }
  }

  private complete(state: AttemptState, result: AttemptResult): AttemptResult {
    if (state.terminalResult) return state.terminalResult
    state.terminalResult = result
    return result
  }

  private finalize(state: AttemptState): void {
    if (!state.terminalResult) return
    for (const pending of state.pendingUsage ?? []) {
      this.emit(state, { type: "usage", usage: pending.usage, diagnostic: pending.diagnostic as RecordValue })
    }
    state.pendingUsage = undefined
    this.terminalEventForResult(state, state.terminalResult)
    state.queue.close()
  }

  private baseResult(state: AttemptState): Pick<AttemptResult, "provider" | "attemptId" | "workSessionId" | "eventId" | "timestamp" | "nativeSessionId" | "nativeRunId"> {
    return {
      provider: "opencode",
      attemptId: state.input.attemptId,
      workSessionId: state.input.workSessionId,
      eventId: `${state.input.attemptId}:result`,
      timestamp: clockTimestamp(this.clock),
      ...(state.native.nativeSessionId === undefined ? {} : { nativeSessionId: state.native.nativeSessionId }),
      ...(state.native.nativeRunId === undefined ? {} : { nativeRunId: state.native.nativeRunId }),
    }
  }

  private failed(state: AttemptState, error: AgentAttemptError, raw?: unknown): AttemptResult {
    return this.complete(state, {
      ...this.baseResult(state),
      status: "failed",
      error: {
        ...error,
        ...(raw === undefined || error.diagnostic !== undefined ? {} : { diagnostic: { raw } }),
      },
      providerMetadata: this.providerMetadata(state),
    })
  }

  private cancelled(state: AttemptState, reason: string): AttemptResult {
    return this.complete(state, {
      ...this.baseResult(state),
      status: "cancelled",
      reason,
      providerMetadata: this.providerMetadata(state),
    })
  }

  private emitStreamFailure(state: AttemptState, error: AgentAttemptError): void {
    if (state.terminalResult || state.streamFailure) return
    state.streamFailure = error
    if (!state.terminalEventEmitted) {
      state.terminalEventEmitted = true
      this.emit(state, { type: "failed", error, diagnostic: error.diagnostic })
    }
    state.promptController?.abort()
    state.streamFailureSignal.resolve()
    void this.requestProviderAbort(state).catch(() => undefined)
  }

  private async consumeSubscription(state: AttemptState, stream: EventSubscription["stream"]): Promise<void> {
    try {
      for await (const raw of stream) {
        if (state.subscription?.intentionalStop) return
        this.normalizeProviderEvent(state, raw)
      }
    } catch (error) {
      if (!state.subscription?.intentionalStop) {
        this.emitStreamFailure(state, providerError(error, "OpenCode event stream failed"))
      }
    }
  }

  private normalizeProviderEvent(state: AttemptState, raw: unknown): void {
    const sessionId = state.native.nativeSessionId
    if (!sessionId || !eventBelongsToSession(raw, sessionId)) return

    const type = eventType(raw)
    const properties = eventProperties(raw)
    if (!type || !properties) return
    const diagnostic = { raw }

    if (type === "session.status") {
      const status = recordAt(properties, "status")
      const statusName = stringField(status?.type) ?? "updated"
      const message = stringField(status?.message)
      const progress = numberField(status?.progress)
      this.emit(state, {
        type: "status",
        status: statusName,
        ...(message === undefined ? {} : { message }),
        ...(progress === undefined ? {} : { progress }),
        diagnostic,
      })
      if (progress !== undefined) this.emit(state, { type: "progress", progress, ...(message === undefined ? {} : { message }), diagnostic })
      return
    }

    if (type === "session.idle") {
      this.emit(state, { type: "status", status: "idle", diagnostic })
      return
    }

    if (type === "session.error") {
      this.emitStreamFailure(state, providerError(properties.error ?? properties, "OpenCode session failed"))
      return
    }

    if (type === "message.updated") {
      const info = recordAt(properties, "info")
      const messageId = stringField(info?.id) ?? stringField(info?.messageID) ?? stringField(info?.messageId)
      if (messageId) {
        state.nativeMessageId = messageId
        state.native.nativeRunId = messageId
      }
      const usage = usageFromTokens(info?.tokens, info?.cost)
      if (usage) this.emit(state, { type: "usage", usage, diagnostic })
      return
    }

    if (type === "message.part.updated") {
      const part = recordAt(properties, "part")
      if (!part) return
      const messageId = stringField(part.messageID) ?? stringField(part.messageId)
      if (messageId) {
        state.nativeMessageId = messageId
        state.native.nativeRunId = messageId
      }
      if (part.type === "text" && typeof part.text === "string") {
        const delta = typeof properties.delta === "string" ? properties.delta : part.text
        this.emit(state, {
          type: "assistant",
          text: delta,
          delta: typeof properties.delta === "string",
          diagnostic,
        })
      } else if (part.type === "tool") {
        const toolState = recordAt(part, "state")
        const providerPhase = stringField(toolState?.status)
        const phase =
          providerPhase === "pending" || providerPhase === "running"
            ? providerPhase === "pending"
              ? "started"
              : "updated"
            : providerPhase === "completed"
              ? "completed"
              : providerPhase === "error"
                ? "failed"
                : "updated"
        this.emit(state, {
          type: "tool",
          toolName: stringField(part.tool),
          phase,
          ...(toolState?.input === undefined ? {} : { input: toolState.input }),
          ...(toolState?.output === undefined ? {} : { output: toolState.output }),
          diagnostic,
        })
        const usage = usageFromTokens(recordAt(part, "tokens"), undefined)
        if (usage) this.emit(state, { type: "usage", usage, diagnostic })
      }
      return
    }

    // These names are present in some V1 server versions even when omitted
    // from the generated union shipped by the installed SDK.
    if (type === "session.next.text.delta" || type === "session.next.reasoning.delta") {
      if (typeof properties.delta === "string") {
        this.emit(state, { type: "assistant", text: properties.delta, delta: true, diagnostic })
      }
      return
    }
    if (type === "session.next.tool.called" || type === "session.next.tool.success" || type === "session.next.tool.failed") {
      const phase = type.endsWith("called") ? "started" : type.endsWith("success") ? "completed" : "failed"
      this.emit(state, {
        type: "tool",
        toolName: stringField(properties.tool),
        phase,
        diagnostic,
      })
    }
  }

  private async startSubscription(state: AttemptState): Promise<void> {
    const controller = new AbortController()
    const client = state.client
    const subscription = await client.event.subscribe({
      signal: controller.signal,
      sseMaxRetryAttempts: 0,
      sseDefaultRetryDelay: 0,
    })
    if (!subscription || typeof subscription !== "object" || !subscription.stream) {
      throw new Error("OpenCode event.subscribe returned no stream")
    }
    const eventSubscription: EventSubscription = {
      controller,
      stream: subscription.stream,
      task: Promise.resolve(),
      intentionalStop: false,
    }
    eventSubscription.task = this.consumeSubscription(state, eventSubscription.stream)
    state.subscription = eventSubscription
  }

  private async stopSubscription(state: AttemptState): Promise<void> {
    const subscription = state.subscription
    if (!subscription) return

    // A synchronous prompt can resolve in the same turn in which a finite
    // fake/test stream has been scheduled. Give a normally ending stream a
    // short chance to drain so correlated events are not lost, while keeping
    // cleanup bounded for the real long-lived SSE stream.
    await Promise.resolve()
    const drained = await bounded(subscription.task, Math.min(25, this.cleanupTimeoutMs))
    if (!drained.timedOut) {
      state.subscription = undefined
      return
    }

    subscription.intentionalStop = true
    subscription.controller.abort()
    const consumed = await bounded(subscription.task, this.cleanupTimeoutMs)
    if (consumed.timedOut) {
      try {
        await bounded(Promise.resolve(subscription.stream.return?.()), this.cleanupTimeoutMs)
      } catch {
        // The generated SDK has no client close method. Iterator return is the
        // best-effort release path for fakes and SDK stream implementations.
      }
      await bounded(subscription.task, Math.min(250, this.cleanupTimeoutMs))
    }
    state.subscription = undefined
  }

  private async requestProviderAbort(state: AttemptState): Promise<void> {
    if (state.abortPromise) return state.abortPromise
    if (!state.native.nativeSessionId || !state.client.session.abort) return
    const controller = new AbortController()
    state.abortPromise = (async () => {
      const abortPromise = state.client.session.abort!({
        path: { id: state.native.nativeSessionId },
        ...requestDirectory(this.cwd),
        signal: controller.signal,
      })
      const abortTimer = setTimeout(() => controller.abort(), this.cleanupTimeoutMs)
      try {
        const response = await bounded(abortPromise, this.cleanupTimeoutMs)
        if (response.timedOut) return
        const failure = responseError(response.value)
        if (failure !== undefined) {
          throw Object.assign(new Error(providerError(failure, "OpenCode session abort failed").message), {
            diagnostic: failure,
          })
        }
      } finally {
        clearTimeout(abortTimer)
      }
    })()
    void state.abortPromise.catch(() => undefined)
    return state.abortPromise
  }

  private triggerTimeout(state: AttemptState): void {
    if (state.terminalResult || state.cancellationKind) return
    state.cancellationKind = "timeout"
    state.cancellationReason = "OpenCode attempt timed out"
    state.promptController?.abort()
    void this.requestProviderAbort(state).catch(() => undefined)
    state.cancelSignal.resolve("timeout")
  }

  private async settleInterruption(state: AttemptState, kind: "cancel" | "timeout" | "stream"): Promise<AttemptResult> {
    if (state.cancellationSettlePromise) return state.cancellationSettlePromise
    state.cancellationSettlePromise = (async () => {
      if (kind === "stream" || state.streamFailure) {
        const error = state.streamFailure ?? {
          message: "OpenCode event stream failed",
          code: "STREAM_ERROR",
        }
        try {
          await bounded(state.abortPromise ?? Promise.resolve(), this.cleanupTimeoutMs)
        } catch {
          // The stream failure remains the terminal provider error even if
          // the best-effort native abort also fails.
        }
        return this.failed(state, error)
      }

      let abortError: unknown
      try {
        await bounded(state.abortPromise ?? Promise.resolve(), this.cleanupTimeoutMs)
      } catch (error) {
        abortError = error
      }
      if (kind === "cancel" && abortError !== undefined) {
        return this.failed(state, providerError(abortError, "OpenCode session abort failed"))
      }
      if (kind === "timeout") {
        return this.failed(state, {
          message: state.cancellationReason ?? "OpenCode attempt timed out",
          name: "TimeoutError",
          code: "TIMEOUT",
          timedOut: true,
          retryable: true,
        })
      }
      return this.cancelled(state, state.cancellationReason ?? "OpenCode attempt cancelled")
    })()
    return state.cancellationSettlePromise
  }

  async startAttempt(input: AttemptInput): Promise<NativeAttempt> {
    if (this.closed) throw new Error("OpenCode adapter is closed")
    if (this.attempts.has(input.attemptId)) {
      throw new Error(`OpenCode attempt has already been started: ${input.attemptId}`)
    }
    if (input.model.runtime !== "opencode") {
      throw new Error(`OpenCode adapter requires an OpenCode model, received ${input.model.runtime}`)
    }
    const model = parseOpenCodeModel(input.model.model)
    const client = await this.getClient()
    const sessionResponse = await client.session.create(buildOpenCodeSessionCreateRequest(this.cwd, input.title))
    const sessionError = responseError(sessionResponse)
    if (sessionError !== undefined) throw Object.assign(new Error(providerError(sessionError).message), { diagnostic: sessionError })
    const nativeSessionId =
      stringField(responseData(sessionResponse) && isRecord(responseData(sessionResponse)) ? (responseData(sessionResponse) as RecordValue).id : undefined) ??
      stringField(recordAt(responseData(sessionResponse), "info")?.id) ??
      stringField(recordAt(responseData(sessionResponse), "session")?.id)
    if (!nativeSessionId) {
      throw new Error(`OpenCode session.create response did not contain a native session ID (HTTP ${responseStatus(sessionResponse) ?? "unknown"})`)
    }

    const metadata: ProviderMetadata = {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
      diagnostic: { response: sessionResponse },
    }
    const native: NativeAttempt = {
      provider: "opencode",
      attemptId: input.attemptId,
      nativeSessionId,
      metadata,
    }
    const state: AttemptState = {
      input,
      native,
      client,
      model,
      queue: new AsyncEventQueue<AgentEvent>(),
      eventSequence: 0,
      terminalEventEmitted: false,
      streamFailureSignal: deferred<void>(),
      cancelSignal: deferred<"cancel" | "timeout">(),
    }
    this.attempts.set(input.attemptId, state)
    this.emit(state, { type: "started", metadata, diagnostic: { response: sessionResponse } })
    return native
  }

  async run(attempt: NativeAttempt, prompt: string): Promise<AttemptResult> {
    const state = this.stateFor(attempt)
    if (!state) {
      throw new Error(`OpenCode attempt was not started: ${attempt.attemptId}`)
    }
    if (state.terminalResult) return state.terminalResult
    if (state.subscription) throw new Error(`OpenCode attempt is already running: ${attempt.attemptId}`)

    state.promptController = new AbortController()
    try {
      await this.startSubscription(state)
    } catch (error) {
      const result = this.failed(state, providerError(error, "OpenCode event subscription failed"), error)
      this.finalize(state)
      return result
    }

    if (state.terminalResult) return state.terminalResult
    if (state.streamFailure) {
      const result = await this.settleInterruption(state, "stream")
      await this.stopSubscription(state)
      this.finalize(state)
      return result
    }
    if (this.timeoutMs !== undefined && this.timeoutMs > 0) {
      // Install the timer before constructing/invoking the prompt promise so
      // request setup is covered by the same timeout budget.
      state.timeoutHandle = setTimeout(() => this.triggerTimeout(state), this.timeoutMs)
    }

    const request = buildOpenCodePromptRequest(
      state.native.nativeSessionId!,
      this.cwd,
      prompt,
      state.model,
      state.promptController.signal,
    )
    const promptPromise = Promise.resolve().then(() => state.client.session.prompt(request))
    const promptOutcome = promptPromise.then(
      (response) => ({ kind: "prompt" as const, response }),
      (error) => ({ kind: "prompt_error" as const, error }),
    )
    const interruption = Promise.race([
      state.cancelSignal.promise.then((kind) => ({ kind })),
      state.streamFailureSignal.promise.then(() => ({ kind: "stream" as const })),
    ])

    try {
      const outcome = (await Promise.race([promptOutcome, interruption])) as
        | { kind: "prompt"; response: unknown }
        | { kind: "prompt_error"; error: unknown }
        | { kind: "cancel" | "timeout" }
        | { kind: "stream" }
      if (outcome.kind === "cancel" || outcome.kind === "timeout") {
        return await this.settleInterruption(state, outcome.kind)
      }
      if (outcome.kind === "stream") {
        return await this.settleInterruption(state, "stream")
      }
      if (outcome.kind === "prompt_error") {
        if (state.cancellationKind) return await this.settleInterruption(state, state.cancellationKind)
        return this.failed(state, providerError(outcome.error, "OpenCode prompt failed"), outcome.error)
      }
      if (outcome.kind !== "prompt") {
        return this.failed(state, {
          message: "OpenCode attempt was interrupted before a prompt result was received",
          code: "INTERRUPTED",
        })
      }

      if (state.streamFailure) return await this.settleInterruption(state, "stream")
      const failure = responseFailure(outcome.response)
      const info = infoFromPromptResponse(outcome.response)
      const messageId = messageIdFromPromptResponse(outcome.response)
      if (messageId) {
        state.nativeMessageId = messageId
        state.native.nativeRunId = messageId
      }
      const usage = usageFromTokens(info?.tokens, info?.cost)
      if (usage) {
        ;(state.pendingUsage ??= []).push({ usage, diagnostic: { response: outcome.response } })
      }
      if (failure !== undefined) return this.failed(state, providerError(failure, "OpenCode prompt returned an error"), outcome.response)

      const result = textFromParts(partsFromPromptResponse(outcome.response))
      return this.complete(state, {
        ...this.baseResult(state),
        status: "completed",
        ...(result === undefined ? {} : { result }),
        providerMetadata: this.providerMetadata(state, outcome.response),
      })
    } finally {
      if (state.timeoutHandle !== undefined) clearTimeout(state.timeoutHandle)
      state.timeoutHandle = undefined
      await this.stopSubscription(state)
      this.finalize(state)
    }
  }

  events(attempt: NativeAttempt): AsyncIterable<AgentEvent> {
    const state = this.stateFor(attempt)
    if (!state) {
      return (async function* () {
        throw new Error(`OpenCode attempt was not started: ${attempt.attemptId}`)
      })()
    }
    return state.queue
  }

  async cancel(attempt: NativeAttempt): Promise<CancelResult> {
    const state = this.stateFor(attempt)
    if (!state) {
      return {
        provider: "opencode",
        attemptId: attempt.attemptId,
        workSessionId: "unknown",
        eventId: `${attempt.attemptId}:cancel-not-found`,
        timestamp: clockTimestamp(this.clock),
        status: "not_found",
        cancelled: false,
        acknowledged: false,
      }
    }
    if (state.terminalResult) {
      return {
        ...this.baseResult(state),
        status: "already_terminal",
        cancelled: false,
        acknowledged: true,
        providerMetadata: this.providerMetadata(state),
      }
    }

    state.cancellationKind = "cancel"
    state.cancellationReason = "OpenCode attempt cancelled"
    state.promptController?.abort()
    state.cancelSignal.resolve("cancel")
    let abortError: AgentAttemptError | undefined
    if (state.client.session.abort) {
      try {
        await this.requestProviderAbort(state)
      } catch (error) {
        abortError = providerError(error, "OpenCode session abort failed")
      }
    }

    if (abortError) {
      const failedResult = this.failed(state, abortError)
      await this.stopSubscription(state)
      this.finalize(state)
      return {
        ...this.baseResult(state),
        status: "failed",
        cancelled: false,
        acknowledged: false,
        error: abortError,
        providerMetadata: failedResult.providerMetadata,
      }
    }

    const result = await this.settleInterruption(state, "cancel")
    await this.stopSubscription(state)
    this.finalize(state)
    return {
      ...this.baseResult(state),
      status: "cancelled",
      cancelled: true,
      acknowledged: true,
      providerMetadata: result.status === "cancelled" ? result.providerMetadata : this.providerMetadata(state),
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      const states = [...this.attempts.values()]
      await Promise.all(
        states.map(async (state) => {
          if (!state.terminalResult) {
            try {
              await this.cancel(state.native)
            } catch {
              // Close is best effort; the stream cleanup below still runs.
            }
          }
          await this.stopSubscription(state)
          this.finalize(state)
          state.queue.close()
        }),
      )
    })()
    return this.closePromise
  }
}

/** Convenience factory for callers that prefer a function over `new`. */
export function createOpenCodeV1Adapter(options: OpenCodeV1AdapterOptions): OpenCodeV1Adapter {
  return new OpenCodeV1Adapter(options)
}

export { OpenCodeV1Adapter as OpenCodeAdapter }
