import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"

import {
  getAgentModels,
  getAgentYaml,
  loadAgentsConfig,
} from "../agents-yaml.ts"
import { getServerUrl, isServerRunning, startServer, waitForServer } from "../opencode.ts"
import {
  generateThreadPrompt,
  getPromptContext,
} from "../prompts.ts"
import {
  modifySqliteCanonicalRuntimeWorkstreamStateSync,
  loadStructuredWorkstreamStateSync,
  readStructuredBatchRunSync,
} from "../storage-adapter.ts"
import { upsertStructuredBatchRun, upsertStructuredThreadRuntime } from "../structured-storage.ts"
import { getWorkDir } from "../repo.ts"
import { parseModelReference } from "../model.ts"
import { generateSessionId } from "../session-id.ts"
import {
  createBatchStatusFile,
  isTerminalBatchStatus,
  summarizeBatchThreads,
  type BatchStatusFile,
} from "../batch-status.ts"
import {
  reconcileBatchStatusRunIfNeeded,
  type SyncBatchStatusOptions,
} from "../batch-monitor.ts"
import type {
  AgentAttemptAdapter,
  AgentAttemptError,
  AttemptInput,
  AttemptResult,
  NativeAttempt,
} from "./contracts.ts"
import {
  ActivityJournal,
  AtomicSnapshotWriter,
  describeAgentEvent,
  ensureRuntimeArtifactFiles,
  normalizeActivityUsage,
  projectBatchExecutionSnapshot,
  redactTextLogValue,
  safeFilePart,
  type ActivityRecordInput,
  type ObservabilityFileSystem,
} from "./observability.ts"
import { normalizeAttemptError, validateResolvedModelSpec } from "./execute.ts"
import type {
  AgentsConfigYaml,
  ModelSpec,
  ResolvedModelSpec,
  RuntimeSelectionSource,
  SessionRecord,
} from "../types.ts"

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_EXECUTOR_STALE_AFTER_MS = 30_000
const DEFAULT_SERVER_PORT = 4096
const MAX_SUMMARY_LENGTH = 1_000
const SDK_RUN_RESERVATION_STALE_AFTER_MS = 15_000
const ASSISTANT_CANONICAL_FLUSH_EVENT_COUNT = 20
const ASSISTANT_CANONICAL_FLUSH_INTERVAL_MS = 1_000

type MaybePromise<T> = T | Promise<T>

export type BatchExecutorAdapterFactory = (
  candidate: ResolvedModelSpec,
  input: AttemptInput,
) => MaybePromise<AgentAttemptAdapter>

export interface BatchExecutorReadiness {
  port?: number
  serverUrl?: string
  isServerRunning?: (port: number) => MaybePromise<boolean>
  startServer?: (port: number, cwd: string) => MaybePromise<unknown>
  waitForServer?: (port: number, timeoutMs: number) => MaybePromise<boolean>
  timeoutMs?: number
}

export interface BatchExecutorOptions {
  repoRoot: string
  streamId: string
  batchId: string
  /** Explicit runtime override, normally supplied by a future CLI. */
  runtimeOverride?: string
  /** Alias accepted for callers that describe this as a forced runtime. */
  forcedRuntime?: string
  /** Short alias for internal callers forwarding a runtime option. */
  runtime?: string
  adapterFactory?: BatchExecutorAdapterFactory
  /** Optional provider-local seam for default Cursor adapter construction. */
  cursorAdapterFactory?: BatchExecutorAdapterFactory
  readiness?: BatchExecutorReadiness
  /** Top-level readiness aliases make dependency injection convenient. */
  isServerRunning?: (port: number) => MaybePromise<boolean>
  startServer?: (port: number, cwd: string) => MaybePromise<unknown>
  waitForServer?: (port: number, timeoutMs: number) => MaybePromise<boolean>
  serverUrl?: string
  serverPort?: number
  heartbeatIntervalMs?: number
  eventDrainTimeoutMs?: number
  executorStaleAfterMs?: number
  serverReadyTimeoutMs?: number
  createAttemptId?: () => string
  createWorkSessionId?: () => string
  now?: () => string
  pid?: number | (() => number)
  clock?: () => string
  sleep?: (ms: number) => Promise<void>
  isProcessAlive?: (pid: number) => boolean
  /** Set false only for a caller that installs its own signal ownership. */
  handleSignals?: boolean
  /** Run ID reserved by the manager for detached-worker adoption. */
  runId?: string
  /** Opaque token proving ownership of a manager-prepared run. */
  ownerToken?: string
  /** Do not start OpenCode; fail if the requested server is unavailable. */
  noServer?: boolean
  /** Filesystem seam for best-effort activity/snapshot tests. */
  observabilityFileSystem?: ObservabilityFileSystem
  activityFlushIntervalMs?: number
  activityMaxPendingBytes?: number
  activityMaxPendingRecords?: number
  activityMaxAssistantChars?: number
  activityMaxTextSummaryLength?: number
}

export interface PreparedSdkBatchRun {
  batch: BatchStatusFile
  prepared: PreparedSdkBatch
  ownerToken: string
}

export interface PreparedBatchCandidate {
  model: ResolvedModelSpec
  runtimeSelectionSource: RuntimeSelectionSource
}

export interface PreparedBatchThread {
  threadId: string
  threadName: string
  stageName: string
  batchName: string
  logicalAgent: string
  prompt: string
  title: string
  candidates: readonly PreparedBatchCandidate[]
}

export interface PreparedSdkBatch {
  streamId: string
  batchId: string
  stageName: string
  batchName: string
  threads: readonly PreparedBatchThread[]
  hasOpenCodeCandidates: boolean
}

export interface BatchThreadExecutionResult {
  threadId: string
  status: "completed" | "failed" | "cancelled"
  result?: AttemptResult
  attempts: readonly {
    attemptId: string
    workSessionId: string
    candidate: ResolvedModelSpec
    nativeSessionId?: string
    nativeRunId?: string
    status: AttemptResult["status"]
  }[]
}

export interface BatchExecutorResult {
  batch: BatchStatusFile
  prepared: PreparedSdkBatch
  threads: readonly BatchThreadExecutionResult[]
}

interface ActiveAttempt {
  threadId: string
  adapter: AgentAttemptAdapter
  native: NativeAttempt
  input: AttemptInput
  cancelPromise?: Promise<AttemptResult>
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

function compact(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  let text: string | undefined
  if (typeof value === "string") text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (!text) return undefined
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text
}

function errorSummary(error: AgentAttemptError | unknown): string {
  const normalized =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error as AgentAttemptError
      : normalizeAttemptError(error)
  return compact(normalized.message) ?? "Provider attempt failed"
}

function redactFailureMessage(message: string): string {
  let redacted = message
    .replace(/(https?:\/\/[^\s/@]+:)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[-_ ]?(?:key|token)|access[-_ ]?token|auth(?:orization)?(?:[-_ ]?token)?|password|passwd|secret|client[-_ ]?secret|private[-_ ]?key|credential|token|key)\s*[:=]\s*)(["']?)[^"'\s,;}\]]+/gi,
      "$1$2[REDACTED]",
    )

  return redacted.replace(
    /\b(?:sk|pk|rk|ghp|glpat|github_pat|xox[baprs])-[A-Za-z0-9_-]{8,}\b/gi,
    "[REDACTED]",
  )
}

function redactedFailureSummary(error: AgentAttemptError | unknown): string {
  return redactTextLogValue(redactFailureMessage(errorSummary(error)))
}

interface RuntimeArtifactPaths {
  runtimeDirectory: string
  activityJournalPath: string
  snapshotPath: string
  executorLogPath: string
}

function deriveRuntimeArtifactPaths(
  streamId: string,
  batchId: string,
  runId: string,
): RuntimeArtifactPaths {
  const runtimeDirectory = join(
    "work",
    safeFilePart(streamId),
    "runtime",
    "batches",
    safeFilePart(batchId),
    "runs",
    safeFilePart(runId),
  )
  return {
    runtimeDirectory,
    activityJournalPath: join(runtimeDirectory, "activity.jsonl"),
    snapshotPath: join(runtimeDirectory, "snapshot.json"),
    executorLogPath: join(runtimeDirectory, "executor.log"),
  }
}

function fillMissingRuntimeArtifactPaths(
  batch: Pick<BatchStatusFile, keyof RuntimeArtifactPaths>,
  paths: RuntimeArtifactPaths,
): void {
  if (!batch.runtimeDirectory) batch.runtimeDirectory = paths.runtimeDirectory
  if (!batch.activityJournalPath) batch.activityJournalPath = paths.activityJournalPath
  if (!batch.snapshotPath) batch.snapshotPath = paths.snapshotPath
  if (!batch.executorLogPath) batch.executorLogPath = paths.executorLogPath
}

function nowIso(now: () => string): string {
  const timestamp = now()
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) throw new Error(`Clock returned an invalid timestamp: ${timestamp}`)
  return date.toISOString()
}

function createDefaultAdapterFactory(options: BatchExecutorOptions): BatchExecutorAdapterFactory {
  const readiness = options.readiness ?? {}
  const serverUrl = readiness.serverUrl ?? options.serverUrl ?? getServerUrl(readiness.port ?? options.serverPort ?? DEFAULT_SERVER_PORT)

  return async (candidate, input) => {
    if (candidate.runtime === "cursor") {
      if (options.cursorAdapterFactory) return options.cursorAdapterFactory(candidate, input)
      const { CursorLocalAdapter } = await import("./providers/cursor.ts")
      return new CursorLocalAdapter()
    }

    if (candidate.runtime !== "opencode") throw new Error(`Unsupported SDK runtime "${candidate.runtime}"`)

    // The import is provider-local. Provider SDK types never cross this factory
    // or the provider-neutral attempt contract.
    const { OpenCodeV1Adapter } = await import("./providers/opencode.ts")
    return new OpenCodeV1Adapter({
      serverUrl,
      cwd: options.repoRoot,
    })
  }
}

/** Factory used by the detached executor when no test/provider factory is injected. */
export function createDefaultBatchExecutorAdapterFactory(
  options: BatchExecutorOptions,
): BatchExecutorAdapterFactory {
  return createDefaultAdapterFactory(options)
}

function runtimeSelectionSource(
  spec: ModelSpec,
  config: AgentsConfigYaml,
  runtimeOverride: string | undefined,
): RuntimeSelectionSource {
  if (runtimeOverride !== undefined) return "cli_override"
  const parsed = parseModelReference(spec)
  if (parsed.runtime !== undefined) return "model_reference"
  if (config.execution?.defaultRuntime !== undefined) return "config_default"
  return "legacy_default"
}

function ensureFreshId(
  createId: () => string,
  used: Set<string>,
  label: string,
): string {
  const value = createId()
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} factory must return a non-empty string`)
  }
  if (used.has(value)) throw new Error(`${label} factory returned a duplicate ID: ${value}`)
  used.add(value)
  return value
}

function defaultPid(): number {
  return process.pid
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function threadStatusForResult(status: AttemptResult["status"]): "completed" | "failed" {
  return status === "completed" ? "completed" : "failed"
}

function sessionStatusForResult(status: AttemptResult["status"]): SessionRecord["status"] {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted"
}

function candidateMetadata(candidate: ResolvedModelSpec, source: RuntimeSelectionSource) {
  return {
    executionBackend: "sdk" as const,
    provider: candidate.runtime,
    runtime: candidate.runtime,
    resolvedModel: candidate.model,
    ...(candidate.variant === undefined ? {} : { resolvedVariant: candidate.variant }),
    runtimeSelectionSource: source,
  }
}

/**
 * Detached, provider-neutral owner for one SDK batch.
 *
 * The class deliberately owns no OpenCode server process. It only requests a
 * shared server when an OpenCode candidate is present and closes adapters after
 * each atomic attempt.
 */
export class BatchExecutor {
  private readonly options: BatchExecutorOptions
  private readonly now: () => string
  private readonly createAttemptId: () => string
  private readonly createWorkSessionId: () => string
  private readonly adapterFactory: BatchExecutorAdapterFactory
  private readonly ownerToken: string
  private readonly ownerPid: number
  private readonly usedAttemptIds = new Set<string>()
  private readonly usedWorkSessionIds = new Set<string>()
  private readonly activeAttempts = new Map<string, ActiveAttempt>()
  private readonly cancellationSignal = deferred<string>()
  private cancellationRequested = false
  private cancellationReason = "SDK batch cancellation requested"
  private cancellationPromise?: Promise<void>
  private prepared?: PreparedSdkBatch
  private batch?: BatchStatusFile
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private signalHandlersInstalled = false
  private signalHandler?: () => void
  private runPromise?: Promise<BatchExecutorResult>
  private activityJournal?: ActivityJournal
  private snapshotWriter?: AtomicSnapshotWriter
  private observabilityDisabled = false
  private observationFailureReported = false

  constructor(options: BatchExecutorOptions) {
    this.options = options
    this.now = options.now ?? options.clock ?? (() => new Date().toISOString())
    this.createAttemptId = options.createAttemptId ?? randomUUID
    this.createWorkSessionId = options.createWorkSessionId ?? generateSessionId
    this.adapterFactory = options.adapterFactory ?? createDefaultAdapterFactory(options)
    this.ownerToken = options.ownerToken ?? randomUUID()
    this.ownerPid = typeof options.pid === "function" ? options.pid() : options.pid ?? defaultPid()
  }

  /** Prepare and validate every thread/candidate without starting a provider. */
  prepare(): PreparedSdkBatch {
    if (this.prepared) return this.prepared

    const config = loadAgentsConfig(this.options.repoRoot)
    if (!config) {
      throw new Error(`agents.yaml not found at ${join(getWorkDir(this.options.repoRoot), "agents.yaml")}`)
    }

    const state = loadStructuredWorkstreamStateSync(this.options.repoRoot, this.options.streamId)
    if (!state) throw new Error(`Workstream state for "${this.options.streamId}" not found`)

    const batchRecord = state.hierarchy.batches.find((batch) => batch.id === this.options.batchId)
    if (!batchRecord) {
      throw new Error(`Batch "${this.options.batchId}" not found in canonical workstream hierarchy`)
    }

    const runtimeByThread = new Map(state.threadRuntime.map((runtime) => [runtime.threadId, runtime] as const))
    const threads = state.hierarchy.threads
      .filter((thread) => thread.batchId === this.options.batchId)
      .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))

    if (threads.length === 0) throw new Error(`No canonical threads found for batch ${this.options.batchId}`)

    const runtimeOverride = this.options.runtimeOverride ?? this.options.forcedRuntime ?? this.options.runtime
    const preparedThreads: PreparedBatchThread[] = threads.map((thread) => {
      // getPromptContext intentionally remains the single prompt/WORK.md
      // validation path used by legacy execution. Nothing is written to disk.
      const promptContext = getPromptContext(this.options.repoRoot, this.options.streamId, thread.id)
      const logicalAgent = runtimeByThread.get(thread.id)?.assignedAgent ?? promptContext.agentName ?? "default"
      if (!getAgentYaml(config, logicalAgent)) {
        throw new Error(`Agent "${logicalAgent}" not found in agents.yaml (thread ${thread.id})`)
      }

      const rawAgent = getAgentYaml(config, logicalAgent)!
      const resolvedModels = getAgentModels(config, logicalAgent, {
        ...(runtimeOverride === undefined ? {} : { runtimeOverride }),
      })
      if (resolvedModels.length === 0) {
        throw new Error(`Agent "${logicalAgent}" has no model candidates (thread ${thread.id})`)
      }

      const candidates = resolvedModels.map((model, index) => {
        // Resolve again at the executor boundary so forced runtime/model shape
        // validation happens before readiness or adapter startup.
        const validated = validateResolvedModelSpec(model)
        return {
          model: validated,
          runtimeSelectionSource: runtimeSelectionSource(rawAgent.models[index]!, config, runtimeOverride),
        }
      }).filter((candidate, index, all) => {
        // A duplicated exact candidate is not an independent fallback. Keep
        // the first listed occurrence so the executor never retries the same
        // model/runtime/variant accidentally.
        const key = `${candidate.model.runtime}:${candidate.model.model}:${candidate.model.variant ?? ""}`
        return all.findIndex((other) =>
          `${other.model.runtime}:${other.model.model}:${other.model.variant ?? ""}` === key,
        ) === index
      })

      return {
        threadId: thread.id,
        threadName: thread.name,
        stageName: state.hierarchy.stages.find((stage) => stage.id === thread.stageId)?.name ?? `Stage ${thread.stageId}`,
        batchName: batchRecord.name,
        logicalAgent,
        prompt: generateThreadPrompt(promptContext),
        title: thread.name,
        candidates,
      }
    })

    this.prepared = {
      streamId: this.options.streamId,
      batchId: this.options.batchId,
      stageName: state.hierarchy.stages.find((stage) => stage.id === batchRecord.stageId)?.name ?? `Stage ${batchRecord.stageId}`,
      batchName: batchRecord.name,
      threads: preparedThreads,
      hasOpenCodeCandidates: preparedThreads.some((thread) =>
        thread.candidates.some((candidate) => candidate.model.runtime === "opencode"),
      ),
    }
    return this.prepared
  }

  /** Alias useful to future internal command callers. */
  prepareBatch(): PreparedSdkBatch {
    return this.prepare()
  }

  private currentBatch(): BatchStatusFile {
    if (!this.batch) throw new Error("SDK batch has not been initialized")
    return this.batch
  }

  private persistBatch(mutator: (batch: BatchStatusFile) => void): BatchStatusFile {
    const current = modifySqliteCanonicalRuntimeWorkstreamStateSync({
      repoRoot: this.options.repoRoot,
      streamId: this.options.streamId,
      fn: (state) => {
        const batch = state.batchRuns.find((candidate) => candidate.batchId === this.options.batchId)
        if (!batch) {
          throw new Error(`Canonical batch run ${this.options.batchId} disappeared during execution`)
        }
        this.assertOwnership(batch)
        mutator(batch)
        batch.updatedAt = nowIso(this.now)
        upsertStructuredBatchRun(state, batch)
        return batch
      },
    })
    this.batch = current
    this.writeSnapshot(current)
    return current
  }

  private reportObservabilityFailure(error: unknown): void {
    if (this.observationFailureReported) return
    this.observationFailureReported = true
    const message = error instanceof Error ? error.message : String(error)
    // The detached worker's descriptors are redirected to executor.log. This
    // diagnostic must never be routed through canonical persistence or alter the
    // provider result when the local observability directory is unavailable.
    try {
      console.error(`[sdk observability] ${message}`)
    } catch {
      // Diagnostics are best effort too.
    }
  }

  private initializeObservability(batch: BatchStatusFile): void {
    if (this.observabilityDisabled) return
    const activityPath = batch.activityJournalPath
    const snapshotPath = batch.snapshotPath
    if (!activityPath && !snapshotPath) return

    try {
      const runtimeDirectory = batch.runtimeDirectory
        ? join(this.options.repoRoot, batch.runtimeDirectory)
        : undefined
      if (!this.activityJournal && activityPath) {
        this.activityJournal = new ActivityJournal({
          path: join(this.options.repoRoot, activityPath),
          streamId: batch.streamId,
          batchId: batch.batchId,
          runtimeDirectory,
          rawDirectory: runtimeDirectory ? join(runtimeDirectory, "raw") : undefined,
          now: this.now,
          fileSystem: this.options.observabilityFileSystem,
          flushIntervalMs: this.options.activityFlushIntervalMs,
          maxPendingBytes: this.options.activityMaxPendingBytes,
          maxPendingRecords: this.options.activityMaxPendingRecords,
          maxAssistantChars: this.options.activityMaxAssistantChars,
          maxTextSummaryLength: this.options.activityMaxTextSummaryLength,
          onTextLogError: (error) => this.reportObservabilityFailure(error),
        })
      }
      if (!this.snapshotWriter && snapshotPath) {
        this.snapshotWriter = new AtomicSnapshotWriter({
          path: join(this.options.repoRoot, snapshotPath),
          fileSystem: this.options.observabilityFileSystem,
        })
      }
      this.writeSnapshot(batch)
    } catch (error) {
      this.observabilityDisabled = true
      this.reportObservabilityFailure(error)
    }
  }

  private writeSnapshot(batch = this.batch): void {
    if (this.observabilityDisabled || !batch || !this.snapshotWriter) return
    try {
      this.snapshotWriter.write(projectBatchExecutionSnapshot(batch, nowIso(this.now)))
    } catch (error) {
      // A snapshot is supporting evidence only; canonical batch state remains
      // authoritative if replacement fails.
      this.reportObservabilityFailure(error)
    }
  }

  private ensureRuntimeArtifacts(batch: BatchStatusFile): void {
    if (
      !batch.runtimeDirectory ||
      !batch.activityJournalPath ||
      !batch.snapshotPath ||
      !batch.executorLogPath
    ) {
      return
    }

    try {
      ensureRuntimeArtifactFiles({
        runtimeDirectory: join(this.options.repoRoot, batch.runtimeDirectory),
        activityJournalPath: join(this.options.repoRoot, batch.activityJournalPath),
        snapshotPath: join(this.options.repoRoot, batch.snapshotPath),
        executorLogPath: join(this.options.repoRoot, batch.executorLogPath),
      }, this.options.observabilityFileSystem)
    } catch (error) {
      // Runtime artifact setup is supporting evidence only. Provider execution
      // remains authoritative when the local filesystem is unavailable.
      this.reportObservabilityFailure(error)
    }
  }

  private logAttemptFailure(args: {
    thread: PreparedBatchThread
    candidate: PreparedBatchCandidate
    attemptId: string
    workSessionId: string
    result: Extract<AttemptResult, { status: "failed" }>
  }): void {
    const executorLogPath = this.batch?.executorLogPath
    if (!executorLogPath) return

    const message = redactedFailureSummary(args.result.error)
    const record = {
      event: "sdk_attempt_failed",
      timestamp: args.result.timestamp,
      streamId: this.options.streamId,
      batchId: this.options.batchId,
      threadId: args.thread.threadId,
      attemptId: args.attemptId,
      workSessionId: args.workSessionId,
      provider: args.candidate.model.runtime,
      message,
    }
    const line = `${JSON.stringify(record)}\n`
    const absolutePath = join(this.options.repoRoot, executorLogPath)

    try {
      if (this.options.observabilityFileSystem) {
        this.options.observabilityFileSystem.mkdirSync(dirname(absolutePath), { recursive: true })
        this.options.observabilityFileSystem.appendFileSync(absolutePath, line)
      } else {
        mkdirSync(dirname(absolutePath), { recursive: true })
        appendFileSync(absolutePath, line, "utf8")
      }
    } catch (error) {
      // Failure logging must not turn a provider failure into a different
      // execution result. The detached worker's stderr remains a best-effort
      // fallback because supervision redirects it to executor.log.
      this.reportObservabilityFailure(error)
      try {
        console.error(`[sdk attempt failure] ${line.trim()}`)
      } catch {
        // Diagnostics are best effort too.
      }
    }
  }

  private observe(input: ActivityRecordInput): void {
    if (this.observabilityDisabled) return
    const batch = this.batch
    if (!batch) return
    try {
      this.initializeObservability(batch)
      this.activityJournal?.append(input)
    } catch (error) {
      this.activityJournal?.discardPending()
      this.observabilityDisabled = true
      this.reportObservabilityFailure(error)
    }
  }

  private closeObservability(): void {
    if (this.observabilityDisabled) return
    try {
      this.activityJournal?.close()
    } catch (error) {
      this.observabilityDisabled = true
      this.reportObservabilityFailure(error)
    }
  }

  private observeBatch(kind: ActivityRecordInput["kind"], summary: string, flush = true): void {
    this.observe({ kind, summary, flush })
  }

  private assertOwnership(batch: BatchStatusFile): void {
    if (batch.executionBackend !== "sdk") {
      throw new Error(`SDK executor cannot own a legacy batch run ${batch.batchId}`)
    }
    if (batch.executorOwnerToken !== this.ownerToken) {
      throw new Error(`SDK executor ownership token does not match batch ${batch.batchId}`)
    }
    if (batch.executorPid !== this.ownerPid) {
      throw new Error(`SDK executor PID ${this.ownerPid} does not own batch ${batch.batchId}`)
    }
  }

  private persistThreadSession(args: {
    thread: PreparedBatchThread
    candidate: PreparedBatchCandidate
    workSessionId: string
    attemptId: string
    status: SessionRecord["status"]
    startedAt: string
    completedAt?: string
    nativeSessionId?: string
    nativeRunId?: string
    lastEventAt?: string
    lastActivityAt?: string
    cancellationRequestedAt?: string
    cancellationAcknowledgedAt?: string
    terminalOutcome?: AttemptResult["status"]
    errorSummary?: string
    resultSummary?: string
  }): void {
    const metadata = candidateMetadata(args.candidate.model, args.candidate.runtimeSelectionSource)
    modifySqliteCanonicalRuntimeWorkstreamStateSync({
      repoRoot: this.options.repoRoot,
      streamId: this.options.streamId,
      fn: (state) => {
        const existing = state.threadRuntime.find((record) => record.threadId === args.thread.threadId)
        const sessions = existing?.sessions ? [...existing.sessions] : []
        const index = sessions.findIndex((session) => session.sessionId === args.workSessionId)
        const session: SessionRecord = {
          ...(index === -1 ? {} : sessions[index]),
          sessionId: args.workSessionId,
          agentName: args.thread.logicalAgent,
          logicalAgent: args.thread.logicalAgent,
          model: args.candidate.model.model,
          startedAt: args.startedAt,
          status: args.status,
          ...metadata,
          attemptId: args.attemptId,
          ...(args.nativeSessionId === undefined ? {} : { nativeSessionId: args.nativeSessionId }),
          ...(args.nativeRunId === undefined ? {} : { nativeRunId: args.nativeRunId }),
          ...(args.lastEventAt === undefined ? {} : { lastEventAt: args.lastEventAt }),
          ...(args.lastActivityAt === undefined ? {} : { lastActivityAt: args.lastActivityAt }),
          ...(args.cancellationRequestedAt === undefined ? {} : { cancellationRequestedAt: args.cancellationRequestedAt }),
          ...(args.cancellationAcknowledgedAt === undefined ? {} : { cancellationAcknowledgedAt: args.cancellationAcknowledgedAt }),
          ...(args.terminalOutcome === undefined ? {} : { terminalOutcome: args.terminalOutcome }),
          ...(args.errorSummary === undefined ? {} : { errorSummary: args.errorSummary }),
          ...(args.resultSummary === undefined ? {} : { resultSummary: args.resultSummary }),
          ...(args.completedAt === undefined ? {} : { completedAt: args.completedAt }),
        }
        if (args.status !== "running" && args.errorSummary === undefined) delete session.errorSummary
        if (args.status !== "running" && args.resultSummary === undefined) delete session.resultSummary
        if (index === -1) sessions.push(session)
        else sessions[index] = session

        upsertStructuredThreadRuntime(state, {
          threadId: args.thread.threadId,
          sessions,
          ...(existing?.status ? { status: existing.status } : {}),
          ...(existing?.createdAt ? { createdAt: existing.createdAt } : { createdAt: args.startedAt }),
          updatedAt: args.lastActivityAt ?? args.completedAt ?? args.startedAt,
          ...(existing?.itemName ? { itemName: existing.itemName } : { itemName: args.thread.threadName }),
          ...(existing?.breadcrumb ? { breadcrumb: existing.breadcrumb } : {}),
          ...(existing?.report ? { report: existing.report } : {}),
          ...(existing?.assignedAgent ? { assignedAgent: existing.assignedAgent } : {}),
          ...(args.status === "running" ? { currentSessionId: args.workSessionId } : {}),
          ...(existing?.opencodeSessionId ? { opencodeSessionId: existing.opencodeSessionId } : {}),
          ...(existing?.workingAgentSessionId ? { workingAgentSessionId: existing.workingAgentSessionId } : {}),
          ...(existing?.synthesisOutput ? { synthesisOutput: existing.synthesisOutput } : {}),
          ...(existing?.synthesis ? { synthesis: existing.synthesis } : {}),
        })
      },
    })
  }

  private persistThreadLifecycle(args: {
    thread: PreparedBatchThread
    candidate: PreparedBatchCandidate
    workSessionId: string
    attemptId: string
    status: SessionRecord["status"]
    startedAt: string
    completedAt?: string
    nativeSessionId?: string
    nativeRunId?: string
    lastEventAt?: string
    lastActivityAt?: string
    cancellationRequestedAt?: string
    cancellationAcknowledgedAt?: string
    terminalOutcome?: AttemptResult["status"]
    errorSummary?: string
    resultSummary?: string
  }): void {
    const safeErrorSummary = args.errorSummary === undefined
      ? undefined
      : redactFailureMessage(args.errorSummary)
    const persistedArgs = safeErrorSummary === undefined
      ? args
      : { ...args, errorSummary: safeErrorSummary }
    this.persistThreadSession(persistedArgs)
    const threadStatus = args.status === "running" ? "running" : threadStatusForResult(args.terminalOutcome ?? "failed")
    const batch = this.persistBatch((current) => {
      const thread = current.threads.find((entry) => entry.threadId === args.thread.threadId)
      if (!thread) throw new Error(`Batch thread ${args.thread.threadId} disappeared during execution`)
      thread.status = threadStatus
      thread.updatedAt = args.lastActivityAt ?? args.completedAt ?? args.startedAt
      if (args.status === "running") {
        thread.startedAt = thread.startedAt ?? args.startedAt
        thread.currentSessionId = args.workSessionId
      } else {
        thread.completedAt = args.completedAt ?? thread.completedAt
        delete thread.currentSessionId
      }
      thread.executionBackend = "sdk"
      thread.provider = args.candidate.model.runtime
      thread.runtime = args.candidate.model.runtime
      thread.logicalAgent = args.thread.logicalAgent
      thread.resolvedModel = args.candidate.model.model
      if (args.candidate.model.variant === undefined) delete thread.resolvedVariant
      else thread.resolvedVariant = args.candidate.model.variant
      thread.runtimeSelectionSource = args.candidate.runtimeSelectionSource
      thread.attemptId = args.attemptId
      if (args.nativeSessionId === undefined) delete thread.nativeSessionId
      else thread.nativeSessionId = args.nativeSessionId
      if (args.nativeRunId === undefined) delete thread.nativeRunId
      else thread.nativeRunId = args.nativeRunId
      if (args.lastEventAt === undefined) delete thread.lastEventAt
      else thread.lastEventAt = args.lastEventAt
      thread.lastActivityAt = args.lastActivityAt ?? args.completedAt ?? args.startedAt
      if (args.cancellationRequestedAt === undefined) delete thread.cancellationRequestedAt
      else thread.cancellationRequestedAt = args.cancellationRequestedAt
      if (args.cancellationAcknowledgedAt === undefined) delete thread.cancellationAcknowledgedAt
      else thread.cancellationAcknowledgedAt = args.cancellationAcknowledgedAt
      if (args.terminalOutcome === undefined) delete thread.terminalOutcome
      else thread.terminalOutcome = args.terminalOutcome
      if (safeErrorSummary === undefined) delete thread.errorSummary
      else thread.errorSummary = safeErrorSummary
      if (args.resultSummary === undefined) delete thread.resultSummary
      else thread.resultSummary = args.resultSummary
      if (args.nativeSessionId && args.candidate.model.runtime === "opencode") {
        thread.opencodeSessionId = args.nativeSessionId
      }
      if (args.lastEventAt !== undefined) current.lastEventAt = args.lastEventAt
      current.lastActivityAt = args.lastActivityAt ?? args.completedAt ?? args.startedAt
      current.summary = summarizeBatchThreads(current.threads)
    })
    this.batch = batch
  }

  private async ensureOpenCodeReadiness(prepared: PreparedSdkBatch): Promise<void> {
    if (!prepared.hasOpenCodeCandidates) return

    const readiness = this.options.readiness ?? {}
    const configuredServerUrl = readiness.serverUrl ?? this.options.serverUrl
    const configuredPort = configuredServerUrl
      ? Number.parseInt(new URL(configuredServerUrl).port || String(DEFAULT_SERVER_PORT), 10)
      : (this.options.serverPort ?? DEFAULT_SERVER_PORT)
    const port = readiness.port ?? (Number.isFinite(configuredPort) ? configuredPort : DEFAULT_SERVER_PORT)
    const check = readiness.isServerRunning ?? this.options.isServerRunning ?? isServerRunning
    const start = readiness.startServer ?? this.options.startServer ?? ((serverPort: number, cwd: string) => startServer(serverPort, cwd))
    const wait = readiness.waitForServer ?? this.options.waitForServer ?? waitForServer
    const timeout = readiness.timeoutMs ?? this.options.serverReadyTimeoutMs ?? 30_000

    if (await check(port)) return
    if (this.options.noServer) {
      throw new Error(
        `OpenCode server is unavailable on port ${port}; --no-server was specified, so the SDK executor will not start one`,
      )
    }
    await start(port, this.options.repoRoot)
    if (!(await wait(port, timeout))) {
      throw new Error(`OpenCode server did not become ready on port ${port} within ${timeout}ms`)
    }
  }

  private createInitialBatch(prepared: PreparedSdkBatch, status: "pending" | "running"): BatchStatusFile {
    const runId = this.options.runId ?? `${this.options.batchId}-${Date.now()}-${randomUUID().slice(0, 8)}`
    const artifactPaths = deriveRuntimeArtifactPaths(this.options.streamId, this.options.batchId, runId)

    const startedAt = nowIso(this.now)
    const initial = createBatchStatusFile({
      streamId: this.options.streamId,
      batchId: this.options.batchId,
      stageName: prepared.stageName,
      batchName: prepared.batchName,
      runId,
      threads: prepared.threads.map((thread) => ({ threadId: thread.threadId, threadName: thread.threadName })),
      executionBackend: "sdk",
      executorOwnerToken: this.ownerToken,
      ...(status === "running" ? { executorPid: this.ownerPid, executorStartedAt: startedAt, executorHeartbeatAt: startedAt } : {
        // This timestamp is a short-lived reservation timestamp until the
        // detached worker claims the run and replaces it with its true start.
        executorStartedAt: startedAt,
      }),
      ...artifactPaths,
      ...(this.cancellationRequested ? { cancellationRequestedAt: startedAt } : {}),
    })
    initial.status = status
    initial.updatedAt = startedAt
    this.ensureRuntimeArtifacts(initial)

    return initial
  }

  private initializeBatch(prepared: PreparedSdkBatch): BatchStatusFile {
    const initial = this.createInitialBatch(prepared, "running")
    modifySqliteCanonicalRuntimeWorkstreamStateSync({
      repoRoot: this.options.repoRoot,
      streamId: this.options.streamId,
      fn: (state) => {
        const existing = state.batchRuns.find((batch) => batch.batchId === this.options.batchId)
        const canReplacePlannedPending =
          existing?.status === "pending" && existing.executionBackend === undefined
        if (existing && !isTerminalBatchStatus(existing.status) && !canReplacePlannedPending) {
          throw new Error(`Batch ${this.options.batchId} already has an active canonical run (${existing.runId})`)
        }
        upsertStructuredBatchRun(state, initial)
      },
    })
    this.batch = initial
    this.initializeObservability(initial)
    this.observeBatch("batch_started", `SDK batch ${initial.batchId} started`)
    return initial
  }

  private adoptPreparedBatch(observed: BatchStatusFile): BatchStatusFile {
    if (this.options.runId !== undefined && observed.runId !== this.options.runId) {
      throw new Error(
        `Prepared SDK run ID ${observed.runId} does not match requested run ${this.options.runId}`,
      )
    }
    if (observed.executorOwnerToken !== this.ownerToken) {
      throw new Error(`Prepared SDK batch ${observed.batchId} is owned by another executor launch`)
    }

    const adopted = modifySqliteCanonicalRuntimeWorkstreamStateSync({
      repoRoot: this.options.repoRoot,
      streamId: this.options.streamId,
      fn: (state) => {
        const current = state.batchRuns.find((candidate) => candidate.batchId === this.options.batchId)
        if (!current) throw new Error(`Prepared SDK batch ${this.options.batchId} disappeared before adoption`)
        if (current.runId !== observed.runId || current.status !== "pending") {
          throw new Error(`Batch ${this.options.batchId} is no longer available for SDK adoption`)
        }
        if (current.executionBackend !== "sdk" || current.executorOwnerToken !== this.ownerToken) {
          throw new Error(`Prepared SDK batch ${this.options.batchId} is owned by another executor launch`)
        }

        const startedAt = nowIso(this.now)
        current.status = "running"
        current.executorPid = this.ownerPid
        current.executorStartedAt = startedAt
        current.executorHeartbeatAt = startedAt
        current.updatedAt = startedAt
        fillMissingRuntimeArtifactPaths(
          current,
          deriveRuntimeArtifactPaths(this.options.streamId, this.options.batchId, current.runId),
        )
        upsertStructuredBatchRun(state, current)
        return current
      },
    })
    this.batch = adopted
    this.ensureRuntimeArtifacts(adopted)
    this.initializeObservability(adopted)
    this.observeBatch("batch_adopted", `SDK batch ${adopted.batchId} adopted by executor ${this.ownerPid}`)
    return adopted
  }

  private initializeOrAdoptBatch(prepared: PreparedSdkBatch): BatchStatusFile {
    const observed = readStructuredBatchRunSync(this.options.repoRoot, this.options.streamId, this.options.batchId)
    if (observed && !isTerminalBatchStatus(observed.status)) {
      if (observed.status === "pending" && observed.executionBackend === "sdk") {
        return this.adoptPreparedBatch(observed)
      }
      throw new Error(`Batch ${this.options.batchId} already has an active canonical run (${observed.runId})`)
    }

    return this.initializeBatch(prepared)
  }

  /**
   * Reserve a canonical pending SDK run before a detached worker is spawned.
   * The worker must present the returned run ID and owner token to atomically
   * transition it to running. This closes the manager/worker initialization
   * race without making a pending legacy projection look like an SDK run.
   */
  prepareCanonicalRun(): PreparedSdkBatchRun {
    if (this.batch?.status === "pending" && this.batch.executionBackend === "sdk") {
      return { batch: this.batch, prepared: this.prepare(), ownerToken: this.ownerToken }
    }

    const prepared = this.prepare()
    const initial = this.createInitialBatch(prepared, "pending")

    modifySqliteCanonicalRuntimeWorkstreamStateSync({
      repoRoot: this.options.repoRoot,
      streamId: this.options.streamId,
      fn: (state) => {
        const existing = state.batchRuns.find((batch) => batch.batchId === this.options.batchId)
        if (existing && !isTerminalBatchStatus(existing.status)) {
          const canReplaceUnclaimedPending =
            existing.status === "pending" &&
            existing.executionBackend === "sdk" &&
            existing.executorPid === undefined &&
            existing.executorStartedAt !== undefined &&
            Date.now() - new Date(existing.executorStartedAt).getTime() > SDK_RUN_RESERVATION_STALE_AFTER_MS

          // The ordinary supervise planning pass leaves a provider-neutral
          // pending projection. It is safe for SDK to claim that projection;
          // a pending SDK reservation is otherwise treated as a duplicate.
          const canClaimPlannedPending = existing.status === "pending" && existing.executionBackend === undefined
          if (!canClaimPlannedPending && !canReplaceUnclaimedPending) {
            throw new Error(`Batch ${this.options.batchId} already has an active canonical run (${existing.runId})`)
          }
        }
        upsertStructuredBatchRun(state, initial)
      },
    })

    this.batch = initial
    this.initializeObservability(initial)
    this.observeBatch("batch_reserved", `SDK batch ${initial.batchId} reserved for detached execution`)
    return { batch: initial, prepared, ownerToken: this.ownerToken }
  }

  /** Alias for callers that describe this as SDK run preparation. */
  prepareRun(): PreparedSdkBatchRun {
    return this.prepareCanonicalRun()
  }

  private startHeartbeat(): void {
    const interval = Math.max(1, this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer = setInterval(() => {
      try {
        this.heartbeat()
      } catch {
        // A terminal/failing persistence path is finalized by run(); heartbeat
        // must never turn a sibling provider failure into an uncaught rejection.
      }
    }, interval)
    const timer = this.heartbeatTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    timer.unref?.()
  }

  /** Persist one immediate owner heartbeat; useful to detached hosts/tests. */
  heartbeat(): void {
    this.persistBatch((batch) => {
      const heartbeatAt = nowIso(this.now)
      batch.executorHeartbeatAt = heartbeatAt
      batch.lastActivityAt = heartbeatAt
    })
    this.observeBatch("heartbeat", `SDK executor heartbeat for batch ${this.options.batchId}`)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  /** Request cancellation; active adapters are asked independently in parallel. */
  async cancel(reason = "SDK batch cancellation requested"): Promise<void> {
    if (this.cancellationPromise) return this.cancellationPromise
    if (this.batch && isTerminalBatchStatus(this.batch.status)) return
    this.cancellationRequested = true
    this.cancellationReason = reason
    this.cancellationSignal.resolve(reason)
    const requestedAt = nowIso(this.now)
    try {
      this.persistBatch((batch) => {
        batch.cancellationRequestedAt = requestedAt
        batch.lastActivityAt = requestedAt
      })
    } catch {
      // The run may not have initialized its canonical batch yet.
    }
    this.observeBatch("cancellation_requested", redactFailureMessage(this.cancellationReason))

    this.cancellationPromise = Promise.all(
      [...this.activeAttempts.values()].map(async (active) => {
        if (!active.cancelPromise) {
          active.cancelPromise = (async () => {
            try {
              const cancelled = await active.adapter.cancel(active.native)
              if (cancelled.status === "cancelled" && cancelled.cancelled) {
                this.observe({
                  kind: "cancellation_acknowledged",
                  threadId: active.threadId,
                  attemptId: active.input.attemptId,
                  workSessionId: active.input.workSessionId,
                  provider: active.input.model.runtime,
                  nativeSessionId: active.native.nativeSessionId,
                  nativeRunId: active.native.nativeRunId,
                  eventId: cancelled.eventId,
                  timestamp: cancelled.timestamp,
                  summary: `Provider cancellation acknowledged: ${redactFailureMessage(reason)}`,
                  flush: true,
                })
                return {
                  provider: active.input.model.runtime,
                  attemptId: active.input.attemptId,
                  workSessionId: active.input.workSessionId,
                  eventId: cancelled.eventId,
                  timestamp: cancelled.timestamp,
                  nativeSessionId: active.native.nativeSessionId,
                  nativeRunId: active.native.nativeRunId,
                  status: "cancelled" as const,
                  reason,
                }
              }
              this.observe({
                kind: "cancellation_failed",
                threadId: active.threadId,
                attemptId: active.input.attemptId,
                workSessionId: active.input.workSessionId,
                provider: active.input.model.runtime,
                nativeSessionId: active.native.nativeSessionId,
                nativeRunId: active.native.nativeRunId,
                eventId: cancelled.eventId,
                timestamp: cancelled.timestamp,
                summary: cancelled.error
                  ? redactFailureMessage(cancelled.error.message)
                  : "Provider cancellation was not acknowledged",
                flush: true,
              })
              return {
                provider: active.input.model.runtime,
                attemptId: active.input.attemptId,
                workSessionId: active.input.workSessionId,
                eventId: cancelled.eventId,
                timestamp: cancelled.timestamp,
                nativeSessionId: active.native.nativeSessionId,
                nativeRunId: active.native.nativeRunId,
                status: "failed" as const,
                error: cancelled.error ?? { message: "Provider cancellation was not acknowledged" },
              }
            } catch (error) {
              this.observe({
                kind: "cancellation_failed",
                threadId: active.threadId,
                attemptId: active.input.attemptId,
                workSessionId: active.input.workSessionId,
                provider: active.input.model.runtime,
                nativeSessionId: active.native.nativeSessionId,
                nativeRunId: active.native.nativeRunId,
                summary: redactedFailureSummary(error),
                flush: true,
              })
              return {
                provider: active.input.model.runtime,
                attemptId: active.input.attemptId,
                workSessionId: active.input.workSessionId,
                eventId: `${active.input.attemptId}:cancel-error`,
                timestamp: nowIso(this.now),
                nativeSessionId: active.native.nativeSessionId,
                nativeRunId: active.native.nativeRunId,
                status: "failed" as const,
                error: normalizeAttemptError(error),
              }
            }
          })()
        }
        await active.cancelPromise
      }),
    ).then(() => undefined)
    return this.cancellationPromise
  }

  /** Testable cancellation alias matching signal terminology. */
  requestCancellation(reason?: string): Promise<void> {
    return this.cancel(reason)
  }

  private installSignalHandlers(): void {
    if (this.signalHandlersInstalled || this.options.handleSignals === false) return
    const handler = () => {
      void this.cancel("SDK batch interrupted by process signal")
    }
    this.signalHandler = handler
    process.on("SIGINT", handler)
    process.on("SIGTERM", handler)
    this.signalHandlersInstalled = true
  }

  private removeSignalHandlers(): void {
    if (!this.signalHandlersInstalled) return
    if (this.signalHandler) {
      process.off("SIGINT", this.signalHandler)
      process.off("SIGTERM", this.signalHandler)
    }
    this.signalHandler = undefined
    this.signalHandlersInstalled = false
  }

  private persistAttemptActivity(args: {
    thread: PreparedBatchThread
    workSessionId: string
    attemptId: string
    nativeSessionId?: string
    nativeRunId?: string
    lastEventAt?: string
    lastActivityAt: string
    errorSummary?: string
  }): void {
    const safeErrorSummary = args.errorSummary === undefined
      ? undefined
      : redactFailureMessage(args.errorSummary)
    modifySqliteCanonicalRuntimeWorkstreamStateSync({
      repoRoot: this.options.repoRoot,
      streamId: this.options.streamId,
      fn: (state) => {
        const runtime = state.threadRuntime.find((record) => record.threadId === args.thread.threadId)
        if (!runtime) return
        const sessions = runtime.sessions.map((session) => {
          if (session.sessionId !== args.workSessionId) return session
          return {
            ...session,
            attemptId: args.attemptId,
            ...(args.nativeSessionId === undefined ? {} : { nativeSessionId: args.nativeSessionId }),
            ...(args.nativeRunId === undefined ? {} : { nativeRunId: args.nativeRunId }),
            ...(args.lastEventAt === undefined ? {} : { lastEventAt: args.lastEventAt }),
            lastActivityAt: args.lastActivityAt,
            ...(safeErrorSummary === undefined ? {} : { errorSummary: safeErrorSummary }),
          }
        })
        upsertStructuredThreadRuntime(state, {
          ...runtime,
          sessions,
          updatedAt: args.lastActivityAt,
        })
      },
    })
    this.persistBatch((batch) => {
      const thread = batch.threads.find((entry) => entry.threadId === args.thread.threadId)
      if (!thread) return
      if (args.nativeSessionId !== undefined) thread.nativeSessionId = args.nativeSessionId
      if (args.nativeRunId !== undefined) thread.nativeRunId = args.nativeRunId
      if (args.lastEventAt !== undefined) thread.lastEventAt = args.lastEventAt
      thread.lastActivityAt = args.lastActivityAt
      if (safeErrorSummary !== undefined) thread.errorSummary = safeErrorSummary
      batch.lastEventAt = args.lastEventAt ?? batch.lastEventAt
      batch.lastActivityAt = args.lastActivityAt
    })
  }

  private async consumeEvents(
    active: ActiveAttempt,
    thread: PreparedBatchThread,
  ): Promise<void> {
    let pendingAssistantActivity: { lastEventAt: string; lastActivityAt: string } | undefined
    let assistantDeltaCount = 0
    let lastAssistantCanonicalFlushAt = nowIso(this.now)
    const flushAssistantCanonicalActivity = (): void => {
      if (!pendingAssistantActivity) return
      this.persistAttemptActivity({
        thread,
        workSessionId: active.input.workSessionId,
        attemptId: active.input.attemptId,
        nativeSessionId: active.native.nativeSessionId,
        nativeRunId: active.native.nativeRunId,
        lastEventAt: pendingAssistantActivity.lastEventAt,
        lastActivityAt: pendingAssistantActivity.lastActivityAt,
      })
      pendingAssistantActivity = undefined
      assistantDeltaCount = 0
      lastAssistantCanonicalFlushAt = nowIso(this.now)
    }

    try {
      for await (const event of active.adapter.events(active.native)) {
        if (!this.activeAttempts.has(active.input.attemptId)) return
        if (event.attemptId !== active.input.attemptId || event.workSessionId !== active.input.workSessionId) continue
        const eventTimestamp = event.timestamp || nowIso(this.now)
        const activityAt = nowIso(this.now)
        const isAssistantDelta = event.type === "assistant" && event.delta === true
        if (isAssistantDelta) {
          pendingAssistantActivity = {
            lastEventAt: eventTimestamp,
            lastActivityAt: activityAt,
          }
          assistantDeltaCount += 1
        } else {
          flushAssistantCanonicalActivity()
          this.persistAttemptActivity({
            thread,
            workSessionId: active.input.workSessionId,
            attemptId: active.input.attemptId,
            nativeSessionId: active.native.nativeSessionId,
            nativeRunId: active.native.nativeRunId,
            lastEventAt: eventTimestamp,
            lastActivityAt: activityAt,
          })
        }
        const isPromptlyPersisted = event.type === "started" ||
          event.type === "usage" ||
          event.type === "tool" && (event.phase === "started" || event.phase === "completed" || event.phase === "failed") ||
          event.type === "failed" || event.type === "cancelled" || event.type === "completed"
        const usage = event.type === "usage" ? normalizeActivityUsage(event.usage) : undefined
        this.observe({
          timestamp: eventTimestamp,
          threadId: thread.threadId,
          attemptId: active.input.attemptId,
          workSessionId: active.input.workSessionId,
          provider: active.input.model.runtime,
          nativeSessionId: event.nativeSessionId ?? active.native.nativeSessionId,
          nativeRunId: event.nativeRunId ?? active.native.nativeRunId,
          eventId: event.eventId,
          ...(event.type === "assistant" && event.contentKind !== undefined
            ? { contentKind: event.contentKind }
            : {}),
          kind: event.type,
          summary: event.type === "failed" || event.type === "cancelled"
            ? redactFailureMessage(describeAgentEvent(event))
            : describeAgentEvent(event),
          ...(usage === undefined ? {} : { usage }),
          ...(event.type === "assistant" && event.text !== undefined ? { assistantText: event.text } : {}),
          ...(event.type === "assistant" ? { coalesceAssistant: true } : {}),
          ...(event.diagnostic === undefined ? {} : { diagnostic: event.diagnostic }),
          flush: isPromptlyPersisted,
        })
        if (isAssistantDelta && (
          assistantDeltaCount >= ASSISTANT_CANONICAL_FLUSH_EVENT_COUNT ||
          new Date(activityAt).getTime() - new Date(lastAssistantCanonicalFlushAt).getTime() >= ASSISTANT_CANONICAL_FLUSH_INTERVAL_MS
        )) {
          flushAssistantCanonicalActivity()
        }
      }
      flushAssistantCanonicalActivity()
    } catch (error) {
      // Adapters that surface stream failures also make run() terminal. Keep
      // the event observer best effort and retain a compact diagnostic.
      try {
        flushAssistantCanonicalActivity()
      } catch {
        // Canonical event metadata is best effort, just like stream observation.
      }
      if (!this.activeAttempts.has(active.input.attemptId)) return
      const at = nowIso(this.now)
      this.persistAttemptActivity({
        thread,
        workSessionId: active.input.workSessionId,
        attemptId: active.input.attemptId,
        nativeSessionId: active.native.nativeSessionId,
        nativeRunId: active.native.nativeRunId,
        lastEventAt: at,
        lastActivityAt: at,
        errorSummary: redactedFailureSummary(error),
      })
      this.observe({
        threadId: thread.threadId,
        attemptId: active.input.attemptId,
        workSessionId: active.input.workSessionId,
        provider: active.input.model.runtime,
        nativeSessionId: active.native.nativeSessionId,
        nativeRunId: active.native.nativeRunId,
        kind: "observation_error",
        summary: `Provider event stream failed: ${redactedFailureSummary(error)}`,
        diagnostic: error,
        flush: true,
      })
    }
  }

  private cancellationResult(active: ActiveAttempt): Promise<AttemptResult> {
    if (!active.cancelPromise) {
      active.cancelPromise = this.cancel(this.cancellationReason).then(async () => ({
        provider: active.input.model.runtime,
        attemptId: active.input.attemptId,
        workSessionId: active.input.workSessionId,
        eventId: `${active.input.attemptId}:cancelled`,
        timestamp: nowIso(this.now),
        nativeSessionId: active.native.nativeSessionId,
        nativeRunId: active.native.nativeRunId,
        status: "cancelled" as const,
        reason: this.cancellationReason,
      }))
    }
    return active.cancelPromise
  }

  private async executeThread(thread: PreparedBatchThread): Promise<BatchThreadExecutionResult> {
    const attempts: Array<BatchThreadExecutionResult["attempts"][number]> = []
    let lastResult: AttemptResult | undefined

    for (const candidate of thread.candidates) {
      if (this.cancellationRequested) {
        break
      }

      const attemptId = ensureFreshId(this.createAttemptId, this.usedAttemptIds, "Attempt ID")
      const workSessionId = ensureFreshId(this.createWorkSessionId, this.usedWorkSessionIds, "Work session ID")
      const startedAt = nowIso(this.now)
      const input: AttemptInput = {
        repoRoot: this.options.repoRoot,
        streamId: this.options.streamId,
        batchId: this.options.batchId,
        threadId: thread.threadId,
        workSessionId,
        attemptId,
        logicalAgent: thread.logicalAgent,
        model: candidate.model,
        prompt: thread.prompt,
        title: thread.title,
        executionBackend: "sdk",
      }
      this.persistThreadLifecycle({
        thread,
        candidate,
        workSessionId,
        attemptId,
        status: "running",
        startedAt,
        lastActivityAt: startedAt,
      })
      this.observe({
        threadId: thread.threadId,
        attemptId,
        workSessionId,
        provider: candidate.model.runtime,
        kind: "attempt_started",
        summary: `Attempt started for ${candidate.model.runtime}/${candidate.model.model}`,
        flush: true,
      })

      let adapter: AgentAttemptAdapter | undefined
      let native: NativeAttempt | undefined
      let eventsTask: Promise<void> | undefined
      let result: AttemptResult
      let active: ActiveAttempt | undefined

      try {
        adapter = await this.adapterFactory(candidate.model, input)
        if (!adapter || typeof adapter !== "object") throw new Error("Adapter factory returned no adapter")
        if (adapter.executionBackend !== "sdk") throw new Error(`Adapter for ${candidate.model.runtime} is not an SDK adapter`)
        if (adapter.provider !== candidate.model.runtime) {
          throw new Error(`Adapter provider "${adapter.provider}" does not match candidate runtime "${candidate.model.runtime}"`)
        }
        if (this.cancellationRequested) {
          result = {
            provider: candidate.model.runtime,
            attemptId,
            workSessionId,
            eventId: `${attemptId}:cancelled-before-start`,
            timestamp: nowIso(this.now),
            status: "cancelled",
            reason: this.cancellationReason,
          }
        } else {
          native = await adapter.startAttempt(input)
          if (native.provider !== candidate.model.runtime) throw new Error(`Native attempt provider "${native.provider}" does not match candidate runtime "${candidate.model.runtime}"`)
          if (native.attemptId !== attemptId) throw new Error(`Native attempt ID "${native.attemptId}" does not match input attempt ID "${attemptId}"`)

          // This mutation is deliberately before events/run/prompt.
          this.persistThreadLifecycle({
            thread,
            candidate,
            workSessionId,
            attemptId,
            status: "running",
            startedAt,
            nativeSessionId: native.nativeSessionId,
            nativeRunId: native.nativeRunId,
            lastActivityAt: nowIso(this.now),
          })
          this.observe({
            threadId: thread.threadId,
            attemptId,
            workSessionId,
            provider: candidate.model.runtime,
            nativeSessionId: native.nativeSessionId,
            nativeRunId: native.nativeRunId,
            kind: "attempt_native_started",
            summary: `Provider session started${native.nativeSessionId ? `: ${native.nativeSessionId}` : ""}`,
            flush: true,
          })

          active = { threadId: thread.threadId, adapter, native, input }
          this.activeAttempts.set(attemptId, active)
          eventsTask = this.consumeEvents(active, thread)
          const runPromise = Promise.resolve().then(() => adapter!.run(native!, input.prompt))
          void runPromise.catch(() => undefined)
          result = await Promise.race([runPromise, this.cancellationSignal.promise.then(() => this.cancellationResult(active!))])
        }
      } catch (error) {
        result = {
          provider: candidate.model.runtime,
          attemptId,
          workSessionId,
          eventId: `${attemptId}:failed`,
          timestamp: nowIso(this.now),
          ...(native?.nativeSessionId === undefined ? {} : { nativeSessionId: native.nativeSessionId }),
          ...(native?.nativeRunId === undefined ? {} : { nativeRunId: native.nativeRunId }),
          status: "failed",
          error: normalizeAttemptError(error),
        }
      } finally {
        if (eventsTask) {
          const drainTimeoutMs = Math.max(0, this.options.eventDrainTimeoutMs ?? 250)
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await Promise.race([
              eventsTask,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, drainTimeoutMs)
              }),
            ])
          } catch {
            // Event observation is best effort; the provider result remains
            // authoritative for the attempt terminal state.
          } finally {
            if (timer !== undefined) clearTimeout(timer)
          }
          void eventsTask.catch(() => undefined)
        }
        if (active) this.activeAttempts.delete(attemptId)
        if (adapter) {
          try {
            await adapter.close()
          } catch {
            // Provider cleanup is best effort and must not suppress the attempt result.
          }
        }
      }

      const completedAt = nowIso(this.now)
      const terminalError = result.status === "failed" ? result.error : result.status === "cancelled" ? result.error : undefined
      const terminalMessage = result.status === "cancelled"
        ? result.reason ?? this.cancellationReason
        : terminalError
      this.persistThreadLifecycle({
        thread,
        candidate,
        workSessionId,
        attemptId,
        status: sessionStatusForResult(result.status),
        startedAt,
        completedAt,
        nativeSessionId: result.nativeSessionId ?? native?.nativeSessionId,
        nativeRunId: result.nativeRunId ?? native?.nativeRunId,
        lastEventAt: result.timestamp,
        lastActivityAt: completedAt,
        ...(this.cancellationRequested ? { cancellationRequestedAt: this.batch?.cancellationRequestedAt ?? completedAt } : {}),
        ...(this.cancellationRequested ? { cancellationAcknowledgedAt: completedAt } : {}),
        terminalOutcome: result.status,
        ...(terminalMessage ? { errorSummary: redactedFailureSummary(terminalMessage) } : {}),
        ...(result.status === "completed" ? { resultSummary: compact(result.result) } : {}),
      })
      if (result.status === "failed") {
        this.logAttemptFailure({
          thread,
          candidate,
          attemptId,
          workSessionId,
          result,
        })
      }
      this.observe({
        threadId: thread.threadId,
        attemptId,
        workSessionId,
        provider: candidate.model.runtime,
        nativeSessionId: result.nativeSessionId ?? native?.nativeSessionId,
        nativeRunId: result.nativeRunId ?? native?.nativeRunId,
        eventId: result.eventId,
        kind: result.status === "completed"
          ? "attempt_completed"
          : result.status === "cancelled"
            ? "attempt_cancelled"
            : "attempt_failed",
        timestamp: result.timestamp,
        summary: result.status === "completed"
          ? `Attempt completed${result.result === undefined ? "" : `: ${compact(result.result)}`}`
          : result.status === "cancelled"
            ? `Attempt cancelled: ${redactFailureMessage(result.reason ?? this.cancellationReason)}`
            : `Attempt failed: ${redactedFailureSummary(result.error)}`,
        diagnostic: result.status === "failed" ? result.error.diagnostic : undefined,
        flush: true,
      })

      attempts.push({
        attemptId,
        workSessionId,
        candidate: candidate.model,
        ...(native?.nativeSessionId === undefined ? {} : { nativeSessionId: native.nativeSessionId }),
        ...(native?.nativeRunId === undefined ? {} : { nativeRunId: native.nativeRunId }),
        status: result.status,
      })
      lastResult = result

      if (result.status !== "failed" || this.cancellationRequested) break
    }

    if (!lastResult) {
      const at = nowIso(this.now)
      lastResult = {
        provider: thread.candidates[0]!.model.runtime,
        attemptId: "none",
        workSessionId: "none",
        eventId: `${thread.threadId}:cancelled`,
        timestamp: at,
        status: "cancelled",
        reason: this.cancellationReason,
      }
      this.persistBatch((batch) => {
        const record = batch.threads.find((entry) => entry.threadId === thread.threadId)
        if (!record) return
        record.status = "failed"
        record.completedAt = at
        record.updatedAt = at
        record.terminalOutcome = "cancelled"
        record.errorSummary = redactFailureMessage(this.cancellationReason)
        delete record.currentSessionId
        batch.summary = summarizeBatchThreads(batch.threads)
      })
      this.observe({
        threadId: thread.threadId,
        kind: "attempt_cancelled",
        summary: `Thread cancelled before an attempt could start: ${redactFailureMessage(this.cancellationReason)}`,
        flush: true,
      })
    }

    return {
      threadId: thread.threadId,
      status: lastResult.status,
      result: lastResult,
      attempts,
    }
  }

  private async runInternal(): Promise<BatchExecutorResult> {
    const prepared = this.prepare()
    await reconcileBatchStatusRunIfNeeded({
      repoRoot: this.options.repoRoot,
      streamId: this.options.streamId,
      batchId: this.options.batchId,
      sdkExecutorStaleAfterMs: this.options.executorStaleAfterMs,
      now: this.now,
      isProcessAlive: this.options.isProcessAlive,
    } satisfies SyncBatchStatusOptions)
    this.initializeOrAdoptBatch(prepared)
    this.installSignalHandlers()
    this.startHeartbeat()

    const threadResults: BatchThreadExecutionResult[] = []
    let runFailure: unknown
    try {
      const readinessPromise = this.ensureOpenCodeReadiness(prepared)
      void readinessPromise.catch(() => undefined)
      await Promise.race([
        readinessPromise,
        this.cancellationSignal.promise.then(() => undefined),
      ])
      // Promise.all is intentional: this preserves the existing unbounded
      // thread parallelism model and isolates one provider failure from peers.
      const settled = await Promise.all(
        prepared.threads.map(async (thread) => {
          try {
            return await this.executeThread(thread)
          } catch (error) {
            const at = nowIso(this.now)
            this.persistBatch((batch) => {
              const record = batch.threads.find((entry) => entry.threadId === thread.threadId)
              if (!record) return
              record.status = "failed"
              record.completedAt = at
              record.updatedAt = at
              record.terminalOutcome = "failed"
              record.errorSummary = redactedFailureSummary(error)
              delete record.currentSessionId
              batch.summary = summarizeBatchThreads(batch.threads)
            })
            this.observe({
              threadId: thread.threadId,
              kind: "attempt_failed",
              summary: `Thread execution failed: ${redactedFailureSummary(error)}`,
              diagnostic: error,
              flush: true,
            })
            return {
              threadId: thread.threadId,
              status: "failed" as const,
              attempts: [],
              result: undefined,
            }
          }
        }),
      )
      threadResults.push(...settled)
    } catch (error) {
      runFailure = error
      throw error
    } finally {
      this.stopHeartbeat()
      if (this.cancellationRequested) await this.cancel(this.cancellationReason)
      const finishedAt = nowIso(this.now)
      const finalBatch = this.persistBatch((batch) => {
        const allCompleted = batch.threads.length > 0 && batch.threads.every((thread) => thread.status === "completed")
        const anyCancelled = batch.threads.some((thread) => thread.terminalOutcome === "cancelled")
        batch.status = allCompleted ? "completed" : "failed"
        batch.summary = summarizeBatchThreads(batch.threads)
        batch.completedAt = finishedAt
        batch.executorFinishedAt = finishedAt
        batch.executorHeartbeatAt = finishedAt
        batch.terminalOutcome = allCompleted ? "completed" : anyCancelled || this.cancellationRequested ? "cancelled" : "failed"
        batch.lastActivityAt = finishedAt
        if (this.cancellationRequested) batch.cancellationAcknowledgedAt = finishedAt
        if (batch.status === "failed" && !batch.errorSummary) {
          batch.errorSummary = runFailure
            ? redactedFailureSummary(runFailure)
            : anyCancelled
              ? redactFailureMessage(this.cancellationReason)
              : `${batch.summary.failed} SDK thread(s) failed`
        }
        if (batch.status === "completed") batch.resultSummary = `${batch.summary.completed} SDK thread(s) completed`
      })
      this.observeBatch(
        finalBatch.terminalOutcome === "completed"
          ? "batch_completed"
          : finalBatch.terminalOutcome === "cancelled"
            ? "batch_cancelled"
            : "batch_failed",
        finalBatch.terminalOutcome === "completed"
          ? `SDK batch ${finalBatch.batchId} completed: ${finalBatch.summary.completed}/${finalBatch.summary.total} threads`
          : `SDK batch ${finalBatch.batchId} finished with ${finalBatch.summary.failed} failed thread(s)`,
        true,
      )
      this.closeObservability()
      this.removeSignalHandlers()
    }

    return {
      batch: this.currentBatch(),
      prepared,
      threads: threadResults,
    }
  }

  /** Execute one detached SDK batch. Repeated calls share the same run promise. */
  run(): Promise<BatchExecutorResult> {
    if (!this.runPromise) this.runPromise = this.runInternal()
    return this.runPromise
  }

  execute(): Promise<BatchExecutorResult> {
    return this.run()
  }
}

export async function executeSdkBatch(options: BatchExecutorOptions): Promise<BatchExecutorResult> {
  return new BatchExecutor(options).run()
}

/** Prepare a manager-owned SDK run without starting provider execution. */
export function prepareSdkBatchRun(options: BatchExecutorOptions): PreparedSdkBatchRun {
  return new BatchExecutor(options).prepareCanonicalRun()
}

export function isSdkBatchExecutorHealthy(
  batch: Pick<BatchStatusFile, "executionBackend" | "status" | "executorPid" | "executorHeartbeatAt">,
  options: {
    now?: () => string
    isProcessAlive?: (pid: number) => boolean
    staleAfterMs?: number
  } = {},
): boolean {
  if (batch.executionBackend !== "sdk" || batch.status !== "running") return false
  if (batch.executorPid === undefined || batch.executorHeartbeatAt === undefined) return false
  const processAlive = options.isProcessAlive ?? defaultProcessAlive
  if (!processAlive(batch.executorPid)) return false
  const heartbeatAt = new Date(batch.executorHeartbeatAt).getTime()
  const now = new Date(nowIso(options.now ?? (() => new Date().toISOString()))).getTime()
  return Number.isFinite(heartbeatAt) && now - heartbeatAt <= (options.staleAfterMs ?? DEFAULT_EXECUTOR_STALE_AFTER_MS)
}
