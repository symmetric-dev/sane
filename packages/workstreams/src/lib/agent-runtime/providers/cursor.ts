import { accessSync, constants, existsSync, readFileSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { isValidCursorModel } from "../../model.ts"
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

type RecordValue = Record<string, unknown>
type ClockValue = string | number | Date

/**
 * Provider-local SDK seams.  These deliberately use no Cursor SDK types so
 * generated declarations cannot leak through the neutral runtime boundary.
 */
export interface CursorRunLike {
  readonly id: string
  readonly requestId?: string
  stream(): AsyncIterable<unknown>
  wait(): Promise<unknown>
  cancel(): Promise<void>
}

export interface CursorAgentLike {
  readonly agentId: string
  send(prompt: string): Promise<CursorRunLike>
  close?(): void | Promise<void>
  [Symbol.asyncDispose]?(): Promise<void>
}

export interface CursorSdkLike {
  Agent: {
    create(options: RecordValue): Promise<CursorAgentLike>
  }
}

export type CursorSdkLoader = () => CursorSdkLike | Promise<CursorSdkLike>

export type CursorSdkFactory = CursorSdkLoader

export interface CursorRuntimeDiagnostics {
  sdkEntry: "@cursor/sdk/bundled"
  nativeRipgrepPath?: string
  ripgrepConfiguration: "CURSOR_RIPGREP_PATH" | "PATH" | "unavailable"
  ripgrepWarningStatus: "fixed" | "fallback" | "unavailable"
}

export interface CursorModelSelection {
  id: string
}

export interface CursorLocalAdapterOptions {
  /** An injected SDK is preferred in unit tests. */
  sdk?: CursorSdkLike
  /** Used to replace the production dynamic import in unit tests. */
  sdkLoader?: CursorSdkLoader
  /** Explicit key override; process.env.CURSOR_API_KEY is read at startup otherwise. */
  apiKey?: string
  /** Bounds SDK import and Agent.create. Falls back to timeoutMs. */
  setupTimeoutMs?: number
  /** Bounds Agent.send. Falls back to timeoutMs. */
  sendTimeoutMs?: number
  /** Bounds the provider attempt, including send and wait. */
  timeoutMs?: number
  /** Bounds cancellation, stream return, and agent disposal. */
  cleanupTimeoutMs?: number
  clock?: () => ClockValue
  /** Test/caller override for the documented ripgrep path resolution. */
  ripgrepPath?: string
}

export type CursorAdapterOptions = CursorLocalAdapterOptions
export type CursorV1AdapterOptions = CursorLocalAdapterOptions

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
    return new Promise<IteratorResult<T>>((resolvePromise) => this.waiters.push(resolvePromise))
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}

interface AttemptState {
  input: AttemptInput
  native: NativeAttempt
  agent: CursorAgentLike
  queue: AsyncEventQueue<AgentEvent>
  eventSequence: number
  terminalEventEmitted: boolean
  terminalResult?: AttemptResult
  run?: CursorRunLike
  runStarted: boolean
  stream?: AsyncIterable<unknown> & { return?: () => Promise<unknown> | unknown }
  streamTask?: Promise<void>
  streamStopping: boolean
  streamFailure?: AgentAttemptError
  streamFailureSignal: Deferred<void>
  cancelSignal: Deferred<"cancel" | "timeout">
  cancellationKind?: "cancel" | "timeout"
  cancellationReason?: string
  cancellationResultPromise?: Promise<AttemptResult>
  providerCancelPromise?: Promise<void>
  timeoutHandle?: ReturnType<typeof setTimeout>
  sendTimeoutHandle?: ReturnType<typeof setTimeout>
  usageEventSeen: boolean
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

function clockTimestamp(clock: () => ClockValue): string {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error("Cursor adapter clock returned an invalid timestamp")
  return date.toISOString()
}

function timestampFromProvider(raw: unknown, clock: () => ClockValue): string {
  if (isRecord(raw)) {
    const value = raw.timestamp ?? raw.timestamp_ms ?? raw.timestampMs
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value)
      if (!Number.isNaN(date.getTime())) return date.toISOString()
    }
  }
  return clockTimestamp(clock)
}

function compactDiagnostic(value: unknown, maxLength = 2_000): string {
  const redact = (_key: string, nested: unknown): unknown => {
    if (!/api.?key|authorization|access.?token|refresh.?token|secret|password/i.test(_key)) return nested
    return "[REDACTED]"
  }
  let text: string
  try {
    const encoded = JSON.stringify(value, redact)
    text = encoded === undefined ? String(value) : encoded
  } catch {
    text = String(value)
  }
  text = text.replace(/CURSOR_API_KEY\s*[=:]\s*[^\s,}]+/gi, "CURSOR_API_KEY=[REDACTED]")
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

function redactText(value: string): string {
  return value
    .replace(/CURSOR_API_KEY\s*[=:]\s*[^\s,}]+/gi, "CURSOR_API_KEY=[REDACTED]")
    .replace(/(bearer\s+)[^\s,}]+/gi, "$1[REDACTED]")
}

function providerDiagnostic(raw: unknown, extra: RecordValue = {}): RecordValue {
  return {
    provider: "cursor",
    ...extra,
    raw: compactDiagnostic(raw),
  }
}

function providerError(raw: unknown, fallback = "Cursor provider error"): AgentAttemptError {
  const normalized = normalizeAttemptError(raw)
  if (!isRecord(raw)) {
    return {
      ...normalized,
      message: redactText(normalized.message || fallback),
      diagnostic: providerDiagnostic(raw),
    }
  }

  const message = stringField(raw.message) ?? stringField(raw.error) ?? (normalized.message || fallback)
  const code = stringField(raw.code) ?? stringField(raw.name)
  return {
    ...normalized,
    message: redactText(message),
    ...(stringField(raw.name) === undefined ? {} : { name: stringField(raw.name) }),
    ...(code === undefined ? {} : { code }),
    diagnostic: providerDiagnostic(raw),
  }
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), {
    name: "TimeoutError",
    code: "TIMEOUT",
    timedOut: true,
    retryable: true,
  })
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<{ value?: T; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then((value) => ({ value, timedOut: false })),
      new Promise<{ value?: T; timedOut: boolean }>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise({ timedOut: true }), Math.max(1, timeoutMs))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function validExecutable(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

function packageRoot(): string | undefined {
  try {
    let current = dirname(fileURLToPath(import.meta.resolve("@cursor/sdk/bundled")))
    while (true) {
      const manifestPath = join(current, "package.json")
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RecordValue
        if (manifest.name === "@cursor/sdk") return current
      }
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  } catch {
    return undefined
  }
}

function packageRipgrepPath(root: string | undefined): string | undefined {
  if (!root) return undefined
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg"
  const packageName = `sdk-${process.platform}-${process.arch}`
  let current = root
  while (true) {
    const candidates = [
      join(current, packageName, "bin", binaryName),
      join(current, "node_modules", "@cursor", packageName, "bin", binaryName),
    ]
    for (const candidate of candidates) if (validExecutable(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function pathRipgrepPath(): string | undefined {
  const binaryName = process.platform === "win32" ? "rg.exe" : "rg"
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, binaryName)
    if (validExecutable(candidate)) return resolve(candidate)
  }
  return undefined
}

/** Validate and map a normalized AgENV Cursor model to the native selection. */
export function parseCursorModel(model: string): CursorModelSelection {
  if (!isValidCursorModel(model)) {
    throw new Error(`Cursor model is invalid: ${model}`)
  }
  return { id: model }
}

/** Exact local Agent.create request shape used by this adapter. */
export function buildCursorAgentCreateRequest(apiKey: string, model: string, cwd: string): RecordValue {
  return {
    apiKey,
    model: parseCursorModel(model),
    local: { cwd },
  }
}

/** Configure Cursor's bundled native helper without capturing or rewriting stderr. */
export function configureCursorRuntime(requestedPath = process.env.CURSOR_RIPGREP_PATH): CursorRuntimeDiagnostics {
  const requested = requestedPath ? resolve(requestedPath) : undefined
  const root = packageRoot()
  const bundledPath = packageRipgrepPath(root)
  const nativePath = requested && validExecutable(requested)
    ? requested
    : bundledPath ?? pathRipgrepPath()

  if (nativePath) process.env.CURSOR_RIPGREP_PATH = nativePath
  const configuration = requested && validExecutable(requested)
    ? "CURSOR_RIPGREP_PATH" as const
    : bundledPath
      ? "CURSOR_RIPGREP_PATH" as const
      : nativePath
        ? "PATH" as const
        : "unavailable" as const

  return {
    sdkEntry: "@cursor/sdk/bundled",
    ...(nativePath === undefined ? {} : { nativeRipgrepPath: nativePath }),
    ripgrepConfiguration: configuration,
    ripgrepWarningStatus: nativePath ? "fixed" : "unavailable",
  }
}

const loadBundledCursorSdk: CursorSdkLoader = async () =>
  await import("@cursor/sdk/bundled") as unknown as CursorSdkLike

function eventCorrelationId(raw: RecordValue): string | undefined {
  return stringField(raw.call_id) ?? stringField(raw.request_id) ?? stringField(raw.id)
}

function eventType(raw: unknown): string | undefined {
  return isRecord(raw) ? stringField(raw.type) : undefined
}

function usageFromProvider(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = numberField(value.inputTokens)
  const outputTokens = numberField(value.outputTokens)
  const totalTokens = numberField(value.totalTokens)
  const cachedInputTokens = numberField(value.cacheReadTokens) ?? numberField(value.cachedInputTokens)
  const cacheWriteTokens = numberField(value.cacheWriteTokens)
  const reasoningTokens = numberField(value.reasoningTokens)
  if (
    inputTokens === undefined && outputTokens === undefined && totalTokens === undefined &&
    cachedInputTokens === undefined && cacheWriteTokens === undefined && reasoningTokens === undefined
  ) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function textBlocks(message: RecordValue): string[] {
  const content = isRecord(message.message) && Array.isArray(message.message.content)
    ? message.message.content
    : []
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return []
    return [block.text]
  })
}

function toolBlocks(message: RecordValue): RecordValue[] {
  const content = isRecord(message.message) && Array.isArray(message.message.content)
    ? message.message.content
    : []
  return content.filter((block): block is RecordValue => isRecord(block) && block.type === "tool_use")
}

function phaseForToolStatus(status: unknown): "started" | "updated" | "completed" | "failed" {
  if (status === "running") return "started"
  if (status === "completed") return "completed"
  if (status === "error") return "failed"
  return "updated"
}

function baseCorrelation(state: AttemptState): Pick<AgentEvent, "provider" | "attemptId" | "workSessionId" | "nativeSessionId" | "nativeRunId"> {
  return {
    provider: "cursor",
    attemptId: state.input.attemptId,
    workSessionId: state.input.workSessionId,
    ...(state.native.nativeSessionId === undefined ? {} : { nativeSessionId: state.native.nativeSessionId }),
    ...(state.native.nativeRunId === undefined ? {} : { nativeRunId: state.native.nativeRunId }),
  }
}

export class CursorLocalAdapter implements AgentAttemptAdapter {
  readonly executionBackend = "sdk" as const
  readonly provider: AgentProvider = "cursor"

  private readonly injectedSdk?: CursorSdkLike
  private readonly sdkLoader: CursorSdkLoader
  private readonly apiKey?: string
  private readonly setupTimeoutMs?: number
  private readonly sendTimeoutMs?: number
  private readonly timeoutMs?: number
  private readonly cleanupTimeoutMs: number
  private readonly clock: () => ClockValue
  private readonly ripgrepPath?: string
  private readonly attempts = new Map<string, AttemptState>()
  private closed = false
  private closePromise?: Promise<void>

  constructor(options: CursorLocalAdapterOptions = {}) {
    this.injectedSdk = options.sdk
    this.sdkLoader = options.sdkLoader ?? loadBundledCursorSdk
    this.apiKey = options.apiKey
    this.setupTimeoutMs = options.setupTimeoutMs ?? options.timeoutMs
    this.sendTimeoutMs = options.sendTimeoutMs
    this.timeoutMs = options.timeoutMs
    this.cleanupTimeoutMs = Math.max(1, options.cleanupTimeoutMs ?? 1_500)
    this.clock = options.clock ?? (() => new Date())
    this.ripgrepPath = options.ripgrepPath
  }

  private stateFor(attempt: NativeAttempt): AttemptState | undefined {
    const state = this.attempts.get(attempt.attemptId)
    if (!state || state.native.nativeSessionId !== attempt.nativeSessionId) return undefined
    return state
  }

  private emit(state: AttemptState, event: RecordValue, raw?: unknown): void {
    const eventRecord = event
    const diagnostic = raw === undefined
      ? eventRecord.diagnostic
      : providerDiagnostic(raw, { eventType: eventRecord.type })
    state.queue.push({
      ...baseCorrelation(state),
      eventId: `${state.input.attemptId}:event-${++state.eventSequence}`,
      timestamp: timestampFromProvider(raw, this.clock),
      ...event,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    } as AgentEvent)
  }

  private metadata(state: AttemptState): ProviderMetadata {
    return {
      model: state.input.model.model,
      agentId: state.native.nativeSessionId,
      ...(state.native.nativeRunId === undefined ? {} : { runId: state.native.nativeRunId }),
      ...(state.run?.requestId === undefined ? {} : { requestId: state.run.requestId }),
      ...(state.input.model.variant === undefined ? {} : { variant: state.input.model.variant }),
      runtimeDiagnostics: configureCursorRuntime(this.ripgrepPath),
    }
  }

  private baseResult(state: AttemptState): Pick<AttemptResult, "provider" | "attemptId" | "workSessionId" | "eventId" | "timestamp" | "nativeSessionId" | "nativeRunId"> {
    return {
      provider: "cursor",
      attemptId: state.input.attemptId,
      workSessionId: state.input.workSessionId,
      eventId: `${state.input.attemptId}:result`,
      timestamp: clockTimestamp(this.clock),
      ...(state.native.nativeSessionId === undefined ? {} : { nativeSessionId: state.native.nativeSessionId }),
      ...(state.native.nativeRunId === undefined ? {} : { nativeRunId: state.native.nativeRunId }),
    }
  }

  private complete(state: AttemptState, result: AttemptResult): AttemptResult {
    if (state.terminalResult) return state.terminalResult
    state.terminalResult = result
    return result
  }

  private failed(state: AttemptState, error: AgentAttemptError): AttemptResult {
    return this.complete(state, {
      ...this.baseResult(state),
      status: "failed",
      error,
      providerMetadata: this.metadata(state),
    })
  }

  private cancelled(state: AttemptState, reason: string): AttemptResult {
    return this.complete(state, {
      ...this.baseResult(state),
      status: "cancelled",
      reason,
      providerMetadata: this.metadata(state),
    })
  }

  private terminalEvent(state: AttemptState, result: AttemptResult): void {
    if (state.terminalEventEmitted) return
    state.terminalEventEmitted = true
    if (result.status === "completed") this.emit(state, { type: "completed", result: result.result, diagnostic: result.providerMetadata?.diagnostic })
    else if (result.status === "failed") this.emit(state, { type: "failed", error: result.error, diagnostic: result.error.diagnostic })
    else this.emit(state, { type: "cancelled", reason: result.reason, diagnostic: result.error?.diagnostic })
  }

  private finalize(state: AttemptState): void {
    if (!state.terminalResult) return
    this.terminalEvent(state, state.terminalResult)
    state.queue.close()
  }

  private normalizeEvent(state: AttemptState, raw: unknown): void {
    if (!isRecord(raw)) return
    const type = eventType(raw)
    if (!type) return
    const diagnostic = providerDiagnostic(raw, { eventType: type })
    const correlationId = eventCorrelationId(raw)
    const common = correlationId === undefined ? { diagnostic } : { correlationId, diagnostic }

    if (type === "assistant") {
      for (const text of textBlocks(raw)) this.emit(state, { type: "assistant", text, delta: false, ...common }, raw)
      for (const block of toolBlocks(raw)) {
        this.emit(state, {
          type: "tool",
          toolName: stringField(block.name),
          phase: "started",
          input: block.input,
          ...common,
        }, raw)
      }
      return
    }

    if (type === "thinking") {
      this.emit(state, {
        type: "assistant",
        text: stringField(raw.text),
        delta: true,
        contentKind: "reasoning",
        ...common,
      }, raw)
      return
    }

    if (type === "tool_call") {
      this.emit(state, {
        type: "tool",
        toolName: stringField(raw.name),
        phase: phaseForToolStatus(raw.status),
        ...(raw.args === undefined ? {} : { input: raw.args }),
        ...(raw.result === undefined ? {} : { output: raw.result }),
        ...common,
      }, raw)
      return
    }

    if (type === "status") {
      this.emit(state, { type: "status", status: stringField(raw.status) ?? "updated", message: stringField(raw.message), ...common }, raw)
      return
    }

    if (type === "task") {
      this.emit(state, {
        type: "status",
        status: stringField(raw.status) ?? "task",
        message: stringField(raw.text),
        ...common,
      }, raw)
      return
    }

    if (type === "request") {
      this.emit(state, {
        type: "status",
        status: "request",
        message: stringField(raw.request_id),
        ...common,
      }, raw)
      return
    }

    if (type === "usage") {
      const usage = usageFromProvider(raw.usage)
      if (usage) {
        state.usageEventSeen = true
        this.emit(state, { type: "usage", usage, ...common }, raw)
      }
      return
    }

    if (type === "system") {
      this.emit(state, {
        type: "status",
        status: stringField(raw.subtype) ?? "system",
        message: stringField(raw.message),
        ...common,
      }, raw)
    }
  }

  private async consumeStream(state: AttemptState, stream: AttemptState["stream"]): Promise<void> {
    if (!stream) return
    try {
      for await (const raw of stream) {
        if (state.streamStopping) return
        this.normalizeEvent(state, raw)
      }
    } catch (error) {
      if (state.streamStopping || state.terminalResult) return
      state.streamFailure = providerError(error, "Cursor event stream failed")
      state.streamFailureSignal.resolve()
    }
  }

  private async stopStream(state: AttemptState): Promise<void> {
    if (!state.streamTask || !state.stream) return
    const drained = await bounded(state.streamTask, Math.min(25, this.cleanupTimeoutMs))
    if (!drained.timedOut) return
    state.streamStopping = true
    try {
      await bounded(Promise.resolve(state.stream.return?.()), this.cleanupTimeoutMs)
    } catch {
      // Iterator return is best effort; the provider result remains authoritative.
    }
    await bounded(state.streamTask, Math.min(250, this.cleanupTimeoutMs))
  }

  private requestTimeout(state: AttemptState, reason: string): void {
    if (state.terminalResult || state.cancellationKind) return
    state.cancellationKind = "timeout"
    state.cancellationReason = reason
    state.cancelSignal.resolve("timeout")
  }

  private async requestProviderCancel(state: AttemptState): Promise<void> {
    if (state.providerCancelPromise) return state.providerCancelPromise
    if (!state.run) return
    const run = state.run
    state.providerCancelPromise = (async () => {
      const outcome = await bounded(Promise.resolve().then(() => run.cancel()), this.cleanupTimeoutMs)
      if (outcome.timedOut) throw timeoutError("Cursor run cancellation timed out")
    })()
    return state.providerCancelPromise
  }

  private interruptionResult(state: AttemptState, kind: "cancel" | "timeout" | "stream"): Promise<AttemptResult> {
    if (state.cancellationResultPromise) return state.cancellationResultPromise
    state.cancellationResultPromise = (async () => {
      if (kind === "stream") {
        try { await this.requestProviderCancel(state) } catch { /* stream failure is primary */ }
        return this.failed(state, state.streamFailure ?? { message: "Cursor event stream failed", code: "STREAM_ERROR" })
      }

      let cancellationError: unknown
      try { await this.requestProviderCancel(state) } catch (error) { cancellationError = error }
      if (cancellationError !== undefined && kind === "cancel") {
        return this.failed(state, providerError(cancellationError, "Cursor run cancellation failed"))
      }
      if (kind === "timeout") {
        return this.failed(state, {
          message: state.cancellationReason ?? "Cursor attempt timed out",
          name: "TimeoutError",
          code: "TIMEOUT",
          timedOut: true,
          retryable: true,
          ...(cancellationError === undefined ? {} : { diagnostic: providerDiagnostic(cancellationError, { cancellation: "timeout" }) }),
        })
      }
      return this.cancelled(state, state.cancellationReason ?? "Cursor attempt cancelled")
    })()
    return state.cancellationResultPromise
  }

  private async disposeAgent(agent: CursorAgentLike): Promise<void> {
    const asyncDispose = agent[Symbol.asyncDispose]
    if (typeof asyncDispose === "function") {
      const outcome = await bounded(Promise.resolve().then(() => asyncDispose.call(agent)), this.cleanupTimeoutMs)
      if (outcome.timedOut) throw timeoutError("Cursor agent disposal timed out")
      return
    }
    if (typeof agent.close === "function") {
      const outcome = await bounded(Promise.resolve().then(() => agent.close!()), this.cleanupTimeoutMs)
      if (outcome.timedOut) throw timeoutError("Cursor agent close timed out")
    }
  }

  private async createSdk(): Promise<CursorSdkLike> {
    const outcome = await bounded(Promise.resolve().then(() => this.injectedSdk ?? this.sdkLoader()), this.setupTimeoutMs ?? 30_000)
    if (outcome.timedOut) throw timeoutError(`Cursor SDK setup timed out after ${this.setupTimeoutMs ?? 30_000}ms`)
    if (!outcome.value || typeof outcome.value.Agent?.create !== "function") throw new Error("Cursor SDK did not expose Agent.create")
    return outcome.value
  }

  async startAttempt(input: AttemptInput): Promise<NativeAttempt> {
    if (this.closed) throw new Error("Cursor adapter is closed")
    if (this.attempts.has(input.attemptId)) throw new Error(`Cursor attempt has already been started: ${input.attemptId}`)
    if (input.model.runtime !== "cursor") throw new Error(`Cursor adapter requires a Cursor model, received ${input.model.runtime}`)
    if (!isValidCursorModel(input.model.model)) throw new Error(`Cursor model is invalid: ${input.model.model}`)

    const apiKey = this.apiKey ?? process.env.CURSOR_API_KEY
    if (!apiKey || apiKey.trim().length === 0) throw new Error("CURSOR_API_KEY or apiKey is required to start a Cursor local attempt")

    // This is intentionally performed immediately before the production SDK is
    // loaded/created. It uses the SDK package binary or PATH as documented by
    // the PoC and never intercepts process-global stderr.
    const runtimeDiagnostics = configureCursorRuntime(this.ripgrepPath)
    const sdk = await this.createSdk()
    const createRequest = buildCursorAgentCreateRequest(apiKey, input.model.model, input.repoRoot)
    const createPromise = Promise.resolve().then(() => sdk.Agent.create(createRequest))
    const createOutcome = await bounded(createPromise, this.setupTimeoutMs ?? 30_000)
    if (createOutcome.timedOut) {
      void createPromise.then((agent) => this.disposeAgent(agent).catch(() => undefined), () => undefined)
      throw timeoutError(`Cursor agent setup timed out after ${this.setupTimeoutMs ?? 30_000}ms`)
    }
    const agent = createOutcome.value
    if (!agent || !stringField(agent.agentId)) throw new Error("Cursor Agent.create returned an agent without an ID")
    if (this.closed) {
      await this.disposeAgent(agent).catch(() => undefined)
      throw new Error("Cursor adapter was closed during agent setup")
    }

    const native: NativeAttempt = {
      provider: "cursor",
      attemptId: input.attemptId,
      nativeSessionId: agent.agentId,
      metadata: {
        model: input.model.model,
        ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
        runtimeDiagnostics,
      },
    }
    const state: AttemptState = {
      input,
      native,
      agent,
      queue: new AsyncEventQueue<AgentEvent>(),
      eventSequence: 0,
      terminalEventEmitted: false,
      runStarted: false,
      streamStopping: false,
      streamFailureSignal: deferred<void>(),
      cancelSignal: deferred<"cancel" | "timeout">(),
      usageEventSeen: false,
    }
    this.attempts.set(input.attemptId, state)
    this.emit(state, { type: "started", metadata: native.metadata, diagnostic: runtimeDiagnostics })
    return native
  }

  async run(attempt: NativeAttempt, prompt: string): Promise<AttemptResult> {
    const state = this.stateFor(attempt)
    if (!state) throw new Error(`Cursor attempt was not started: ${attempt.attemptId}`)
    if (state.terminalResult) return state.terminalResult
    if (state.runStarted) throw new Error(`Cursor attempt is already running: ${attempt.attemptId}`)
    state.runStarted = true
    if (this.timeoutMs !== undefined && this.timeoutMs > 0) {
      state.timeoutHandle = setTimeout(() => this.requestTimeout(state, "Cursor attempt timed out"), this.timeoutMs)
    }

    let sendPromise: Promise<CursorRunLike>
    try {
      if (state.cancellationKind) {
        const result = await this.interruptionResult(state, state.cancellationKind)
        this.finalize(state)
        return result
      }
      sendPromise = Promise.resolve().then(() => state.agent.send(prompt))
      const sendTimeout = this.sendTimeoutMs ?? (this.timeoutMs === undefined ? undefined : this.timeoutMs)
      if (sendTimeout !== undefined && sendTimeout > 0 &&
        (this.timeoutMs === undefined || sendTimeout < this.timeoutMs)) {
        state.sendTimeoutHandle = setTimeout(() => this.requestTimeout(state, "Cursor prompt submission timed out"), sendTimeout)
      }
      const sendOutcome = await Promise.race([
        sendPromise.then((run) => ({ kind: "sent" as const, run }), (error) => ({ kind: "send_error" as const, error })),
        state.cancelSignal.promise.then((kind) => ({ kind })),
        state.streamFailureSignal.promise.then(() => ({ kind: "stream" as const })),
      ])
      if (sendOutcome.kind === "cancel" || sendOutcome.kind === "timeout") {
        sendPromise.then((run) => {
          state.run = run
          state.native.nativeRunId = stringField(run.id)
          void this.requestProviderCancel(state).catch(() => undefined)
        }, () => undefined)
        const result = await this.interruptionResult(state, sendOutcome.kind)
        this.finalize(state)
        return result
      }
      if (sendOutcome.kind === "stream") {
        const result = await this.interruptionResult(state, "stream")
        this.finalize(state)
        return result
      }
      if (sendOutcome.kind === "send_error") {
        if (state.cancellationKind) {
          const result = await this.interruptionResult(state, state.cancellationKind)
          this.finalize(state)
          return result
        }
        const result = this.failed(state, providerError(sendOutcome.error, "Cursor prompt submission failed"))
        this.finalize(state)
        return result
      }

      if (!("run" in sendOutcome)) {
        const result = this.failed(state, { message: "Cursor prompt submission was interrupted", code: "INTERRUPTED" })
        this.finalize(state)
        return result
      }
      const sentRun = sendOutcome.run
      state.run = sentRun
      if (!stringField(sentRun.id)) {
        const result = this.failed(state, { message: "Cursor Agent.send returned a run without an ID", code: "INVALID_RUN" })
        this.finalize(state)
        return result
      }
      state.native.nativeRunId = sentRun.id
      if (state.cancellationKind) {
        const result = await this.interruptionResult(state, state.cancellationKind)
        this.finalize(state)
        return result
      }

      state.stream = sentRun.stream() as AttemptState["stream"]
      state.streamTask = this.consumeStream(state, state.stream)
      const waitPromise = Promise.resolve().then(() => state.run!.wait()).then(
        (result) => ({ kind: "wait" as const, result }),
        (error) => ({ kind: "wait_error" as const, error }),
      )
      const outcome = await Promise.race([
        waitPromise,
        state.cancelSignal.promise.then((kind) => ({ kind })),
        state.streamFailureSignal.promise.then(() => ({ kind: "stream" as const })),
      ])

      let result: AttemptResult
      if (outcome.kind === "cancel" || outcome.kind === "timeout") {
        result = await this.interruptionResult(state, outcome.kind)
      } else if (outcome.kind === "stream") {
        result = await this.interruptionResult(state, "stream")
      } else if (outcome.kind === "wait_error") {
        result = this.failed(state, providerError(outcome.error, "Cursor run wait failed"))
      } else {
        if (!("result" in outcome)) {
          result = this.failed(state, { message: "Cursor run was interrupted", code: "INTERRUPTED" })
          return result
        }
        const waitResult = isRecord(outcome.result) ? outcome.result : {}
        const usage = usageFromProvider(waitResult.usage)
        if (usage && !state.usageEventSeen) this.emit(state, { type: "usage", usage, diagnostic: providerDiagnostic(waitResult, { eventType: "result" }) })
        const status = stringField(waitResult.status)
        if (status === "finished") {
          result = this.complete(state, {
            ...this.baseResult(state),
            status: "completed",
            ...(waitResult.result === undefined ? {} : { result: waitResult.result }),
            providerMetadata: this.metadata(state),
          })
        } else if (status === "cancelled") {
          result = this.cancelled(state, stringField(isRecord(waitResult.error) ? waitResult.error.message : undefined) ?? "Cursor run cancelled")
        } else {
          const error = waitResult.error === undefined
            ? { message: `Cursor run ended with status ${status ?? "unknown"}`, code: "PROVIDER_ERROR" }
            : providerError(waitResult.error, "Cursor run failed")
          result = this.failed(state, error)
        }
      }
      return result
    } catch (error) {
      if (state.cancellationKind) return await this.interruptionResult(state, state.cancellationKind)
      if (state.run && !state.stream) {
        try { await this.requestProviderCancel(state) } catch { /* cleanup remains best effort */ }
      }
      return this.failed(state, providerError(error, "Cursor attempt failed"))
    } finally {
      if (state.timeoutHandle !== undefined) clearTimeout(state.timeoutHandle)
      if (state.sendTimeoutHandle !== undefined) clearTimeout(state.sendTimeoutHandle)
      state.timeoutHandle = undefined
      state.sendTimeoutHandle = undefined
      await this.stopStream(state)
      this.finalize(state)
    }
  }

  events(attempt: NativeAttempt): AsyncIterable<AgentEvent> {
    const state = this.stateFor(attempt)
    if (!state) return (async function* () { throw new Error(`Cursor attempt was not started: ${attempt.attemptId}`) })()
    return state.queue
  }

  async cancel(attempt: NativeAttempt): Promise<CancelResult> {
    const state = this.stateFor(attempt)
    if (!state) {
      return {
        provider: "cursor",
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
      return { ...this.baseResult(state), status: "already_terminal", cancelled: false, acknowledged: true, providerMetadata: this.metadata(state) }
    }
    state.cancellationKind = "cancel"
    state.cancellationReason = "Cursor attempt cancelled"
    state.cancelSignal.resolve("cancel")
    const result = await this.interruptionResult(state, "cancel")
    this.finalize(state)
    if (result.status === "failed") {
      return { ...this.baseResult(state), status: "failed", cancelled: false, acknowledged: false, error: result.error, providerMetadata: result.providerMetadata }
    }
    return { ...this.baseResult(state), status: "cancelled", cancelled: true, acknowledged: true, providerMetadata: result.providerMetadata }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      await Promise.all([...this.attempts.values()].map(async (state) => {
        if (!state.terminalResult) {
          try { await bounded(this.cancel(state.native), this.cleanupTimeoutMs) } catch { /* best effort */ }
        }
        try { await this.stopStream(state) } catch { /* best effort */ }
        this.finalize(state)
        try { await bounded(this.disposeAgent(state.agent), this.cleanupTimeoutMs) } catch { /* best effort */ }
        state.queue.close()
      }))
    })()
    return this.closePromise
  }

  reconcile(nativeSessionId: string) {
    return Promise.resolve({
      provider: "cursor" as const,
      nativeSessionId,
      status: "unknown" as const,
      timestamp: clockTimestamp(this.clock),
      diagnostic: { reason: "Cursor local reconciliation is unsupported; conversation resume is not implemented" },
    })
  }
}

export const CursorAdapter = CursorLocalAdapter
export const CursorV1Adapter = CursorLocalAdapter

export function createCursorAdapter(options: CursorLocalAdapterOptions = {}): CursorLocalAdapter {
  return new CursorLocalAdapter(options)
}
