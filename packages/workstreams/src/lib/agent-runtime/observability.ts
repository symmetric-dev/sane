import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { createHash, randomUUID } from "node:crypto"

import type { AgentEvent, AgentProvider, AgentUsage } from "./contracts.ts"
import type { BatchStatusFile } from "../batch-status.ts"

const DEFAULT_MAX_SUMMARY_LENGTH = 1_000
const DEFAULT_FLUSH_INTERVAL_MS = 1_000
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024
const DEFAULT_MAX_PENDING_RECORDS = 100
const DEFAULT_MAX_ASSISTANT_CHARS = 4_000
const DEFAULT_MAX_ASSISTANT_STREAMS = 128
const DEFAULT_MAX_TEXT_SUMMARY_LENGTH = 320

/** Provider-neutral token usage persisted on normalized activity records. */
export interface ActivityUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type ActivityKind =
  | "batch_reserved"
  | "batch_started"
  | "batch_adopted"
  | "batch_completed"
  | "batch_failed"
  | "batch_cancelled"
  | "heartbeat"
  | "attempt_started"
  | "attempt_native_started"
  | "attempt_completed"
  | "attempt_failed"
  | "attempt_cancelled"
  | "cancellation_requested"
  | "cancellation_acknowledged"
  | "cancellation_failed"
  | "observation_error"
  | AgentEvent["type"]

/** Compact AgENV-owned evidence for operator observation. */
export interface ActivityRecord {
  timestamp: string
  streamId: string
  batchId: string
  threadId?: string
  attemptId?: string
  workSessionId?: string
  provider?: AgentProvider
  nativeSessionId?: string
  nativeRunId?: string
  eventId?: string
  contentKind?: "assistant" | "reasoning"
  kind: ActivityKind | (string & {})
  summary: string
  usage?: ActivityUsage
  rawDiagnosticRef?: string
}

export interface ActivityRecordInput {
  timestamp?: string
  threadId?: string
  attemptId?: string
  workSessionId?: string
  provider?: AgentProvider
  nativeSessionId?: string
  nativeRunId?: string
  eventId?: string
  contentKind?: "assistant" | "reasoning"
  kind: ActivityKind | (string & {})
  summary: string
  usage?: ActivityUsage
  /** Assistant text is coalesced instead of writing one record per delta. */
  assistantText?: string
  coalesceAssistant?: boolean
  diagnostic?: unknown
  /** Lifecycle, error, heartbeat, and terminal records bypass batching. */
  flush?: boolean
}

export interface ObservabilityFileSystem {
  mkdirSync(path: string, options?: { recursive?: boolean }): void
  appendFileSync(path: string, content: string): void
  writeFileSync(path: string, content: string): void
  renameSync(oldPath: string, newPath: string): void
  rmSync(path: string): void
}

const defaultFileSystem: ObservabilityFileSystem = {
  mkdirSync: (path, options) => {
    mkdirSync(path, options)
  },
  appendFileSync: (path, content) => {
    appendFileSync(path, content, "utf8")
  },
  writeFileSync: (path, content) => {
    writeFileSync(path, content, "utf8")
  },
  renameSync: (oldPath, newPath) => {
    renameSync(oldPath, newPath)
  },
  rmSync: (path) => {
    rmSync(path, { force: true })
  },
}

export function ensureRuntimeArtifactFiles(
  paths: {
    runtimeDirectory: string
    activityJournalPath: string
    snapshotPath: string
    executorLogPath: string
  },
  fileSystem: ObservabilityFileSystem = defaultFileSystem,
): void {
  fileSystem.mkdirSync(paths.runtimeDirectory, { recursive: true })
  fileSystem.appendFileSync(paths.activityJournalPath, "")
  fileSystem.appendFileSync(paths.executorLogPath, "")
  // snapshotPath is intentionally not prewritten. The first useful projection
  // is created by AtomicSnapshotWriter after canonical initialization, so every
  // snapshot replacement uses temp-file-plus-rename.
}

export interface ActivityJournalOptions {
  path: string
  streamId: string
  batchId: string
  runtimeDirectory?: string
  rawDirectory?: string
  now?: () => string
  fileSystem?: ObservabilityFileSystem
  createDiagnosticId?: () => string
  maxSummaryLength?: number
  flushIntervalMs?: number
  maxPendingBytes?: number
  maxPendingRecords?: number
  maxAssistantChars?: number
  maxAssistantStreams?: number
  /** Optional root for derived, human-readable session logs. */
  textLogDirectory?: string
  /** Bounds each derived text-log summary independently of JSON summaries. */
  maxTextSummaryLength?: number
  /** Supporting text-log failures are reported without escaping the append path. */
  onTextLogError?: (error: unknown) => void
}

interface PendingAssistant {
  record: Omit<ActivityRecord, "summary">
  text: string
  firstTimestamp: string
  lastTimestamp: string
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Normalize provider usage into the compact activity-record shape. */
export function normalizeActivityUsage(usage: AgentUsage | undefined): ActivityUsage | undefined {
  if (!usage) return undefined
  const inputTokens = usageNumber(usage.inputTokens)
  const outputTokens = usageNumber(usage.outputTokens)
  const totalTokens = usageNumber(usage.totalTokens)
  const cacheReadTokens = usageNumber(usage.cacheReadTokens)
    ?? usageNumber(usage.cachedInputTokens)
  const cacheWriteTokens = usageNumber(usage.cacheWriteTokens)
  const reasoningTokens = usageNumber(usage.reasoningTokens)
  if (
    inputTokens === undefined && outputTokens === undefined && totalTokens === undefined &&
    cacheReadTokens === undefined && cacheWriteTokens === undefined && reasoningTokens === undefined
  ) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function formatUsageTokenFields(usage: ActivityUsage): string {
  const parts: string[] = []
  if (usage.inputTokens !== undefined) parts.push(`inputTokens=${usage.inputTokens}`)
  if (usage.outputTokens !== undefined) parts.push(`outputTokens=${usage.outputTokens}`)
  if (usage.totalTokens !== undefined) parts.push(`totalTokens=${usage.totalTokens}`)
  if (usage.cacheReadTokens !== undefined) parts.push(`cacheReadTokens=${usage.cacheReadTokens}`)
  if (usage.cacheWriteTokens !== undefined) parts.push(`cacheWriteTokens=${usage.cacheWriteTokens}`)
  if (usage.reasoningTokens !== undefined) parts.push(`reasoningTokens=${usage.reasoningTokens}`)
  return parts.join(" ")
}

function compactText(value: unknown, maxLength = DEFAULT_MAX_SUMMARY_LENGTH): string {
  const text = typeof value === "string" ? value : (() => {
    try {
      return JSON.stringify(value) ?? String(value)
    } catch {
      return String(value)
    }
  })()
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`
}

const SECRET_ASSIGNMENT_PATTERN = /((['"]?)(?:api[-_ ]?(?:key|token)|access[-_ ]?token|auth(?:orization)?(?:[-_ ]?token)?|password|passwd|secret|client[-_ ]?secret|private[-_ ]?key|credential|token|key)\2\s*[:=]\s*)(?:(['"])(?:\\[\s\S]|(?!\3)[\s\S])*\3|([^\s,;)}\]]+))/gi

/** Redact secrets from the small, human-readable projection only. */
export function redactTextLogValue(value: string): string {
  return value
    .replace(/(https?:\/\/[^\s/@]+:)[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(\b(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, _keyQuote: string, valueQuote: string | undefined) =>
      `${prefix}${valueQuote ? `${valueQuote}[REDACTED]${valueQuote}` : "[REDACTED]"}`,
    )
    .replace(/\b(?:sk|pk|rk|ghp|glpat|github_pat|xox[baprs])-[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
}

function validTimestamp(value: string | undefined, fallback: () => string): string {
  const candidate = value ?? fallback()
  const date = new Date(candidate)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function timestampMs(timestamp: string): number {
  const value = new Date(timestamp).getTime()
  return Number.isFinite(value) ? value : 0
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return JSON.stringify({ diagnostic: String(value) }, null, 2)
  }
}

/**
 * Keep readable identifiers when they are already safe, and encode every
 * other byte instead of replacing it. Encoding avoids collisions such as
 * `a/b` and `a-b`, while also ensuring a component can never add a path
 * separator or become `.`/`..`.
 */
export function safeFilePart(value: string): string {
  const readable = /^[a-zA-Z0-9._-]+$/.test(value) && value !== "." && value !== ".."
  if (readable && value.length <= 80) return value

  const encoded = Array.from(value).map((character) => {
    if (/^[a-zA-Z0-9._-]$/.test(character) && value !== "." && value !== "..") return character
    return [...Buffer.from(character, "utf8")]
      .map((byte) => `~${byte.toString(16).toUpperCase().padStart(2, "0")}`)
      .join("")
  }).join("") || "~00"

  if (encoded.length <= 80 && encoded !== "." && encoded !== "..") return encoded

  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16)
  const suffix = `~${digest}`
  return `${encoded.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`
}

function sessionTextPath(textLogDirectory: string, record: ActivityRecord): string {
  if (record.threadId && record.attemptId) {
    return join(textLogDirectory, safeFilePart(record.threadId), safeFilePart(record.attemptId), "session.log")
  }
  if (record.threadId) {
    return join(textLogDirectory, safeFilePart(record.threadId), "session.log")
  }
  return join(dirname(textLogDirectory), "session.log")
}

/**
 * Format only the safe, derived projection of an activity record. Raw provider
 * diagnostics and tool arguments/results are intentionally not available here.
 */
export function formatSessionTextRecord(
  record: ActivityRecord,
  maxSummaryLength = DEFAULT_MAX_TEXT_SUMMARY_LENGTH,
): string {
  const scope = record.threadId
    ? [record.threadId, record.attemptId].filter(Boolean).map((value) => safeFilePart(value!)).join("/")
    : `batch/${safeFilePart(record.batchId)}`
  const kind = record.contentKind && record.kind === "assistant" ? record.contentKind : record.kind
  const provider = safeFilePart(record.provider ?? "unknown")
  const rawSummary = record.kind === "attempt_completed"
    ? "Attempt completed"
    : record.kind === "completed"
      ? "Provider attempt completed"
      : record.summary
  const summary = compactText(redactTextLogValue(rawSummary), maxSummaryLength) || "(no summary)"
  const usageSuffix = record.kind === "usage" && record.usage
    ? ` ${formatUsageTokenFields(record.usage)}`
    : ""
  return `${record.timestamp} provider=${provider} scope=${scope} kind=${safeFilePart(kind)} ${summary}${usageSuffix}`
}

/**
 * Synchronous on-purpose journal writer. The executor already performs
 * synchronous canonical persistence, and synchronous append/rename operations
 * keep concurrent in-process attempts from interleaving records.
 */
export class ActivityJournal {
  private readonly path: string
  private readonly streamId: string
  private readonly batchId: string
  private readonly runtimeDirectory?: string
  private readonly rawDirectory?: string
  private readonly now: () => string
  private readonly fileSystem: ObservabilityFileSystem
  private readonly createDiagnosticId: () => string
  private readonly maxSummaryLength: number
  private readonly flushIntervalMs: number
  private readonly maxPendingBytes: number
  private readonly maxPendingRecords: number
  private readonly maxAssistantChars: number
  private readonly maxAssistantStreams: number
  private readonly textLogDirectory?: string
  private readonly maxTextSummaryLength: number
  private readonly onTextLogError?: (error: unknown) => void
  private readonly pendingRecords: ActivityRecord[] = []
  private readonly pendingAssistants = new Map<string, PendingAssistant>()
  private pendingBytes = 0
  private lastFlushAt: string
  private textLogErrorReported = false

  constructor(options: ActivityJournalOptions) {
    this.path = options.path
    this.streamId = options.streamId
    this.batchId = options.batchId
    this.runtimeDirectory = options.runtimeDirectory
    this.rawDirectory = options.rawDirectory
    this.now = options.now ?? (() => new Date().toISOString())
    this.fileSystem = options.fileSystem ?? defaultFileSystem
    this.createDiagnosticId = options.createDiagnosticId ?? randomUUID
    this.maxSummaryLength = options.maxSummaryLength ?? DEFAULT_MAX_SUMMARY_LENGTH
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS)
    this.maxPendingBytes = Math.max(1, options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES)
    this.maxPendingRecords = Math.max(1, options.maxPendingRecords ?? DEFAULT_MAX_PENDING_RECORDS)
    this.maxAssistantChars = Math.max(1, options.maxAssistantChars ?? DEFAULT_MAX_ASSISTANT_CHARS)
    this.maxAssistantStreams = Math.max(1, options.maxAssistantStreams ?? DEFAULT_MAX_ASSISTANT_STREAMS)
    this.textLogDirectory = options.textLogDirectory ?? (options.runtimeDirectory ? join(options.runtimeDirectory, "sessions") : undefined)
    this.maxTextSummaryLength = Math.max(1, options.maxTextSummaryLength ?? DEFAULT_MAX_TEXT_SUMMARY_LENGTH)
    this.onTextLogError = options.onTextLogError
    this.lastFlushAt = validTimestamp(undefined, this.now)
  }

  append(input: ActivityRecordInput): void {
    const timestamp = validTimestamp(input.timestamp, this.now)
    const diagnosticRef = input.diagnostic === undefined
      ? undefined
      : this.writeDiagnostic(input, timestamp)
    const base: Omit<ActivityRecord, "summary"> = {
      timestamp,
      streamId: this.streamId,
      batchId: this.batchId,
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      ...(input.workSessionId === undefined ? {} : { workSessionId: input.workSessionId }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId }),
      ...(input.nativeRunId === undefined ? {} : { nativeRunId: input.nativeRunId }),
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      ...(input.contentKind === undefined ? {} : { contentKind: input.contentKind }),
      kind: input.kind,
      ...(input.usage === undefined ? {} : { usage: input.usage }),
      ...(diagnosticRef === undefined ? {} : { rawDiagnosticRef: diagnosticRef }),
    }

    if (input.assistantText !== undefined && input.coalesceAssistant !== false) {
      this.appendAssistant(base, input.assistantText, input.flush === true)
      return
    }

    this.flushAssistants()
    this.enqueue({
      ...base,
      summary: compactText(input.summary, this.maxSummaryLength),
    })
    if (input.flush === true || this.shouldFlush(timestamp)) this.flush()
  }

  /** Flush coalesced output and all queued records immediately. */
  flush(): void {
    this.flushAssistants()
    if (this.pendingRecords.length === 0) return
    this.fileSystem.mkdirSync(dirname(this.path), { recursive: true })
    const content = `${this.pendingRecords.map((record) => JSON.stringify(record)).join("\n")}\n`
    this.fileSystem.appendFileSync(this.path, content)
    this.flushTextLogs(this.pendingRecords)
    this.pendingRecords.length = 0
    this.pendingBytes = 0
    this.lastFlushAt = validTimestamp(undefined, this.now)
  }

  close(): void {
    this.flush()
  }

  /** Discard only in-memory observations after a best-effort write failure. */
  discardPending(): void {
    this.pendingRecords.length = 0
    this.pendingAssistants.clear()
    this.pendingBytes = 0
  }

  private appendAssistant(
    base: Omit<ActivityRecord, "summary">,
    text: string,
    flushRequested: boolean,
  ): void {
    const key = [
      base.threadId ?? "",
      base.attemptId ?? "",
      base.workSessionId ?? "",
      base.provider ?? "",
      base.nativeSessionId ?? "",
      base.contentKind ?? "",
    ].join("\u0000")
    const timestamp = base.timestamp
    let pending = this.pendingAssistants.get(key)
    if (!pending) {
      if (this.pendingAssistants.size >= this.maxAssistantStreams) {
        const oldest = this.pendingAssistants.keys().next().value as string | undefined
        if (oldest !== undefined) this.flushAssistant(oldest)
      }
      pending = {
        record: base,
        text: "",
        firstTimestamp: timestamp,
        lastTimestamp: timestamp,
      }
      this.pendingAssistants.set(key, pending)
    }

    const remaining = Math.max(0, this.maxAssistantChars - pending.text.length)
    if (remaining > 0) pending.text += text.slice(0, remaining)
    pending.lastTimestamp = timestamp

    if (pending.text.length >= this.maxAssistantChars || flushRequested || this.shouldFlush(timestamp)) {
      this.flushAssistant(key)
      if (flushRequested || this.shouldFlush(timestamp)) this.flush()
    }
  }

  private flushAssistants(): void {
    for (const key of [...this.pendingAssistants.keys()]) this.flushAssistant(key)
  }

  private flushAssistant(key: string): void {
    const pending = this.pendingAssistants.get(key)
    if (!pending) return
    this.pendingAssistants.delete(key)
    const text = compactText(pending.text || "assistant output", this.maxSummaryLength)
    this.enqueue({
      ...pending.record,
      timestamp: pending.lastTimestamp || pending.firstTimestamp,
      summary: text,
    })
  }

  private enqueue(record: ActivityRecord): void {
    this.pendingRecords.push(record)
    this.pendingBytes += Buffer.byteLength(JSON.stringify(record)) + 1
  }

  private shouldFlush(timestamp: string): boolean {
    return this.pendingRecords.length >= this.maxPendingRecords ||
      this.pendingBytes >= this.maxPendingBytes ||
      timestampMs(timestamp) - timestampMs(this.lastFlushAt) >= this.flushIntervalMs
  }

  private writeDiagnostic(input: ActivityRecordInput, timestamp: string): string | undefined {
    if (!this.rawDirectory) return undefined
    try {
      this.fileSystem.mkdirSync(this.rawDirectory, { recursive: true })
      const eventPart = safeFilePart(input.eventId ?? input.attemptId ?? "event")
      const path = join(this.rawDirectory, `${timestamp.replace(/[^0-9]/g, "").slice(0, 17)}-${eventPart}-${safeFilePart(this.createDiagnosticId())}.json`)
      this.fileSystem.writeFileSync(path, `${safeJson(input.diagnostic)}\n`)
      const relativePath = this.runtimeDirectory
        ? relative(this.runtimeDirectory, path)
        : basename(path)
      return relativePath || basename(path)
    } catch {
      return undefined
    }
  }

  private flushTextLogs(records: readonly ActivityRecord[]): void {
    if (!this.textLogDirectory || records.length === 0) return

    const contents = new Map<string, string>()
    for (const record of records) {
      const path = sessionTextPath(this.textLogDirectory, record)
      const line = `${formatSessionTextRecord(record, this.maxTextSummaryLength)}\n`
      contents.set(path, `${contents.get(path) ?? ""}${line}`)
    }

    // A text projection is supporting evidence. Failure of one session log
    // must not prevent sibling logs, JSONL, or provider execution from
    // continuing.
    for (const [path, content] of contents) {
      try {
        this.fileSystem.mkdirSync(dirname(path), { recursive: true })
        this.fileSystem.appendFileSync(path, content)
      } catch (error) {
        if (!this.textLogErrorReported) {
          this.textLogErrorReported = true
          try {
            this.onTextLogError?.(error)
          } catch {
            // Reporting is best effort too.
          }
        }
      }
    }
  }
}

export interface ExecutionSnapshot {
  version: 1
  capturedAt: string
  streamId: string
  batchId: string
  runId: string
  status: BatchStatusFile["status"]
  executionBackend?: BatchStatusFile["executionBackend"]
  stageName?: string
  batchName?: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  terminalOutcome?: BatchStatusFile["terminalOutcome"]
  summary: BatchStatusFile["summary"]
  runtimeDirectory?: string
  activityJournalPath?: string
  executorLogPath?: string
  executor: {
    pid?: number
    startedAt?: string
    heartbeatAt?: string
    finishedAt?: string
    lastEventAt?: string
    lastActivityAt?: string
  }
  threads: Array<{
    threadId: string
    threadName: string
    status: BatchStatusFile["threads"][number]["status"]
    startedAt?: string
    updatedAt: string
    completedAt?: string
    provider?: AgentProvider
    runtime?: AgentProvider
    resolvedModel?: string
    resolvedVariant?: string
    attemptId?: string
    nativeSessionId?: string
    nativeRunId?: string
    lastEventAt?: string
    lastActivityAt?: string
    terminalOutcome?: BatchStatusFile["threads"][number]["terminalOutcome"]
    errorSummary?: string
    resultSummary?: string
  }>
}

export function projectBatchExecutionSnapshot(batch: BatchStatusFile, capturedAt: string): ExecutionSnapshot {
  return {
    version: 1,
    capturedAt,
    streamId: batch.streamId,
    batchId: batch.batchId,
    runId: batch.runId,
    status: batch.status,
    ...(batch.executionBackend === undefined ? {} : { executionBackend: batch.executionBackend }),
    ...(batch.stageName === undefined ? {} : { stageName: batch.stageName }),
    ...(batch.batchName === undefined ? {} : { batchName: batch.batchName }),
    startedAt: batch.startedAt,
    updatedAt: batch.updatedAt,
    ...(batch.completedAt === undefined ? {} : { completedAt: batch.completedAt }),
    ...(batch.terminalOutcome === undefined ? {} : { terminalOutcome: batch.terminalOutcome }),
    summary: { ...batch.summary },
    ...(batch.runtimeDirectory === undefined ? {} : { runtimeDirectory: batch.runtimeDirectory }),
    ...(batch.activityJournalPath === undefined ? {} : { activityJournalPath: batch.activityJournalPath }),
    ...(batch.executorLogPath === undefined ? {} : { executorLogPath: batch.executorLogPath }),
    executor: {
      ...(batch.executorPid === undefined ? {} : { pid: batch.executorPid }),
      ...(batch.executorStartedAt === undefined ? {} : { startedAt: batch.executorStartedAt }),
      ...(batch.executorHeartbeatAt === undefined ? {} : { heartbeatAt: batch.executorHeartbeatAt }),
      ...(batch.executorFinishedAt === undefined ? {} : { finishedAt: batch.executorFinishedAt }),
      ...(batch.lastEventAt === undefined ? {} : { lastEventAt: batch.lastEventAt }),
      ...(batch.lastActivityAt === undefined ? {} : { lastActivityAt: batch.lastActivityAt }),
    },
    threads: batch.threads.map((thread) => ({
      threadId: thread.threadId,
      threadName: thread.threadName,
      status: thread.status,
      ...(thread.startedAt === undefined ? {} : { startedAt: thread.startedAt }),
      updatedAt: thread.updatedAt,
      ...(thread.completedAt === undefined ? {} : { completedAt: thread.completedAt }),
      ...(thread.provider === undefined ? {} : { provider: thread.provider }),
      ...(thread.runtime === undefined ? {} : { runtime: thread.runtime }),
      ...(thread.resolvedModel === undefined ? {} : { resolvedModel: thread.resolvedModel }),
      ...(thread.resolvedVariant === undefined ? {} : { resolvedVariant: thread.resolvedVariant }),
      ...(thread.attemptId === undefined ? {} : { attemptId: thread.attemptId }),
      ...(thread.nativeSessionId === undefined ? {} : { nativeSessionId: thread.nativeSessionId }),
      ...(thread.nativeRunId === undefined ? {} : { nativeRunId: thread.nativeRunId }),
      ...(thread.lastEventAt === undefined ? {} : { lastEventAt: thread.lastEventAt }),
      ...(thread.lastActivityAt === undefined ? {} : { lastActivityAt: thread.lastActivityAt }),
      ...(thread.terminalOutcome === undefined ? {} : { terminalOutcome: thread.terminalOutcome }),
      ...(thread.errorSummary === undefined ? {} : { errorSummary: thread.errorSummary }),
      ...(thread.resultSummary === undefined ? {} : { resultSummary: thread.resultSummary }),
    })),
  }
}

export interface AtomicSnapshotWriterOptions {
  path: string
  fileSystem?: ObservabilityFileSystem
  createTempPath?: (path: string) => string
}

/** Writes a complete snapshot through a unique temp file and POSIX rename. */
export class AtomicSnapshotWriter {
  private readonly path: string
  private readonly fileSystem: ObservabilityFileSystem
  private readonly createTempPath: (path: string) => string

  constructor(options: AtomicSnapshotWriterOptions) {
    this.path = options.path
    this.fileSystem = options.fileSystem ?? defaultFileSystem
    this.createTempPath = options.createTempPath ?? ((path) => `${path}.${process.pid}.${randomUUID()}.tmp`)
  }

  write(snapshot: ExecutionSnapshot): void {
    const tempPath = this.createTempPath(this.path)
    this.fileSystem.mkdirSync(dirname(this.path), { recursive: true })
    try {
      this.fileSystem.writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`)
      this.fileSystem.renameSync(tempPath, this.path)
    } finally {
      this.fileSystem.rmSync(tempPath)
    }
  }
}

export function writeAtomicExecutionSnapshot(
  path: string,
  snapshot: ExecutionSnapshot,
  fileSystem?: ObservabilityFileSystem,
): void {
  new AtomicSnapshotWriter({ path, fileSystem }).write(snapshot)
}

export interface ReadActivityFileSystem {
  existsSync(path: string): boolean
  readFileSync(path: string): Buffer
}

const defaultReadActivityFileSystem: ReadActivityFileSystem = {
  existsSync,
  readFileSync: (path) => readFileSync(path),
}

export function readActivityJournal(
  path: string,
  fileSystem: ReadActivityFileSystem = defaultReadActivityFileSystem,
): ActivityRecord[] {
  if (!fileSystem.existsSync(path)) return []
  const content = fileSystem.readFileSync(path).toString("utf8")
  const records: ActivityRecord[] = []
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as ActivityRecord
      if (parsed && typeof parsed === "object" && typeof parsed.timestamp === "string" && typeof parsed.kind === "string") {
        records.push(parsed)
      }
    } catch {
      // A reader can encounter a line being appended. Ignore malformed lines;
      // the next follow poll will read the completed record.
    }
  }
  return records
}

export function resolveRecordedRuntimePath(repoRoot: string, recordedPath: string): string {
  return isAbsolute(recordedPath) ? recordedPath : join(repoRoot, recordedPath)
}

export function describeAgentEvent(event: AgentEvent): string {
  switch (event.type) {
    case "started":
      return "Provider attempt started"
    case "assistant":
      return event.text
        ? `${event.contentKind === "reasoning" ? "Reasoning" : "Assistant"}: ${compactText(event.text)}`
        : `${event.contentKind === "reasoning" ? "Reasoning" : "Assistant"} output updated`
    case "tool":
      return `${event.phase ?? "updated"} tool${event.toolName ? ` ${event.toolName}` : ""}`
    case "status":
      return event.message ? `${event.status}: ${compactText(event.message)}` : `Status: ${event.status}`
    case "progress":
      return event.message
        ? `Progress${event.progress === undefined ? "" : ` ${Math.round(event.progress * 100)}%`}: ${compactText(event.message)}`
        : `Progress${event.progress === undefined ? "" : ` ${Math.round(event.progress * 100)}%`}`
    case "completed":
      return "Provider attempt completed"
    case "failed":
      return `Provider attempt failed: ${compactText(event.error.message)}`
    case "cancelled":
      return `Provider attempt cancelled${event.reason ? `: ${compactText(event.reason)}` : ""}`
    case "usage":
      return `Usage${event.usage.totalTokens === undefined ? "" : `: ${event.usage.totalTokens} tokens`}`
  }
}

export function formatActivityRecordText(record: ActivityRecord): string {
  const scope = [record.threadId, record.attemptId].filter(Boolean).join("/")
  const provider = record.provider ? ` ${record.provider}` : ""
  return `${record.timestamp}${provider} [${record.kind}]${scope ? ` ${scope}` : ""} ${record.summary}`
}
