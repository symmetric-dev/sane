import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs"
import { createHash } from "node:crypto"
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"

import { formatLatestUsageSummary } from "./usage-format.ts"

export const MONITORED_REPOSITORIES = Object.freeze([
  Object.freeze({ key: "gene", label: "~/gene", root: "/Users/beto/gene" }),
  Object.freeze({ key: "betalytics-backend", label: "~/betalytics-backend", root: "/Users/beto/betalytics-backend" }),
  Object.freeze({ key: "agenv", label: "~/agenv", root: "/Users/beto/agenv" }),
] as const)
const DEFAULT_REPOSITORY_KEY = "gene"
const PORT = 43120
const HOSTNAME = "127.0.0.1"
const MONITOR_HTML_PATH = join(import.meta.dir, "index.html")
const ACTIVITY_LIMIT = 50
const EXECUTOR_LOG_LIMIT = 200
const SESSION_TEXT_LIMIT = 200
const SESSION_TEXT_MAX_BYTES = 64 * 1024

export type MonitorRepository = (typeof MONITORED_REPOSITORIES)[number]

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

function configuredRepository(): MonitorRepository {
  const configured = process.env.AGENV_MONITOR_REPO_ROOT?.trim()
  if (configured) {
    const configuredRoot = canonicalPath(configured)
    const matchingRepository = MONITORED_REPOSITORIES.find((repository) => {
      return canonicalPath(repository.root) === configuredRoot
    })
    if (matchingRepository) return matchingRepository
  }

  return MONITORED_REPOSITORIES.find(({ key }) => key === DEFAULT_REPOSITORY_KEY)!
}

export function getMonitorRepository(key?: string): MonitorRepository | null {
  if (key === undefined) return configuredRepository()
  return MONITORED_REPOSITORIES.find((repository) => repository.key === key) ?? null
}

export function resolveMonitorRepoRoot(key?: string): string {
  const repository = getMonitorRepository(key)
  if (!repository) throw new Error(`Unknown monitored repository key: ${key}`)
  return repository.root
}

/** Default configured repository root for the monitor PoC. */
export const MONITOR_REPO_ROOT = resolveMonitorRepoRoot()

type JsonObject = Record<string, unknown>

interface ReadError {
  source: string
  path?: string
  message: string
}

interface PathInfo {
  recorded: string
  absolute: string
  exists: boolean
}

interface MonitorPayload {
  repository: MonitorRepository
  capturedAt: string
  streamId: string | null
  batch: JsonObject | null
  executor: JsonObject | null
  runtime: JsonObject | null
  sessions: JsonObject[]
  activity: JsonObject[]
  executorLog: string[]
  readErrors: ReadError[]
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function addReadError(
  errors: ReadError[],
  source: string,
  message: string,
  path?: string,
): void {
  errors.push({
    source,
    ...(path === undefined ? {} : { path }),
    message,
  })
}

function isWithinRepo(candidate: string, repository: MonitorRepository): boolean {
  const roots = [repository.root, canonicalPath(repository.root)]
  return roots.some((root, index) => {
    if (index > 0 && root === roots[0]) return false
    const relativePath = relative(root, candidate)
    return relativePath === ""
      || (!relativePath.startsWith("../")
        && !relativePath.startsWith("..\\")
        && relativePath !== ".."
        && !isAbsolute(relativePath))
  })
}

/**
 * Resolve a path recorded in canonical state without allowing it to escape the
 * configured PoC repository. Existing symlinks are checked with realpath as
 * well.
 */
function resolveRecordedPath(
  value: unknown,
  source: string,
  errors: ReadError[],
  repository: MonitorRepository,
): string | null {
  const recorded = asString(value)
  if (!recorded) {
    return null
  }

  const candidate = isAbsolute(recorded)
    ? resolve(recorded)
    : resolve(repository.root, recorded)

  if (!isWithinRepo(candidate, repository)) {
    addReadError(errors, source, "Recorded path escapes the configured repository root", recorded)
    return null
  }

  // Check the path itself, or the nearest existing parent when the artifact is
  // still being initialized. This also catches a missing file beneath a
  // symlink that points outside the repository.
  let existingPath = candidate
  while (true) {
    try {
      const realPath = realpathSync(existingPath)
      if (!isWithinRepo(realPath, repository)) {
        addReadError(errors, source, "Recorded path resolves outside the configured repository root", recorded)
        return null
      }
      break
    } catch {
      const parent = dirname(existingPath)
      if (parent === existingPath) {
        // A path can be valid but not exist yet while a run is initializing.
        // The subsequent read reports the useful missing-file error.
        break
      }
      existingPath = parent
    }
  }

  return candidate
}

function readJsonFile(
  filePath: string,
  source: string,
  errors: ReadError[],
): JsonObject | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"))
    const object = asObject(parsed)
    if (!object) {
      addReadError(errors, source, "Expected a JSON object", filePath)
      return null
    }
    return object
  } catch (error) {
    addReadError(errors, source, errorMessage(error), filePath)
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pathInfo(
  recordedValue: unknown,
  source: string,
  errors: ReadError[],
  repository: MonitorRepository,
): PathInfo | null {
  const recorded = asString(recordedValue)
  if (!recorded) {
    return null
  }

  const absolute = resolveRecordedPath(recorded, source, errors, repository)
  if (!absolute) {
    return null
  }

  return {
    recorded,
    absolute,
    exists: existsSync(absolute),
  }
}

function completeLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  // Artifact writers terminate records/lines with a newline. Do not expose a
  // partially written final record while the executor is appending it.
  if (text.length > 0 && !text.endsWith("\n")) {
    lines.pop()
  }
  return lines.filter((line) => line.trim().length > 0)
}

interface LatestUsageView {
  timestamp?: string
  provider?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

interface SessionUsageSelector {
  threadId: string
  attemptId?: string
  workSessionId?: string
}

function usageFromRecord(record: JsonObject): LatestUsageView | null {
  if (record.kind !== "usage") return null
  const usage = asObject(record.usage)
  if (!usage) return null
  const view: LatestUsageView = {
    ...(asString(record.timestamp) === undefined ? {} : { timestamp: asString(record.timestamp) }),
    ...(asString(record.provider) === undefined ? {} : { provider: asString(record.provider) }),
    ...(asNumber(usage.inputTokens) === undefined ? {} : { inputTokens: asNumber(usage.inputTokens) }),
    ...(asNumber(usage.outputTokens) === undefined ? {} : { outputTokens: asNumber(usage.outputTokens) }),
    ...(asNumber(usage.totalTokens) === undefined ? {} : { totalTokens: asNumber(usage.totalTokens) }),
    ...(asNumber(usage.cacheReadTokens) === undefined ? {} : { cacheReadTokens: asNumber(usage.cacheReadTokens) }),
    ...(asNumber(usage.cacheWriteTokens) === undefined ? {} : { cacheWriteTokens: asNumber(usage.cacheWriteTokens) }),
    ...(asNumber(usage.reasoningTokens) === undefined ? {} : { reasoningTokens: asNumber(usage.reasoningTokens) }),
  }
  return Object.keys(view).length > 0 ? view : null
}

function recordMatchesSession(record: JsonObject, selector: SessionUsageSelector): boolean {
  const threadId = asString(record.threadId)
  if (threadId !== selector.threadId) return false
  const attemptId = asString(record.attemptId)
  if (selector.attemptId !== undefined && attemptId !== undefined && attemptId !== selector.attemptId) {
    return false
  }
  const workSessionId = asString(record.workSessionId)
  if (selector.workSessionId !== undefined && workSessionId !== undefined && workSessionId !== selector.workSessionId) {
    return false
  }
  return true
}

export function selectLatestSessionUsage(
  records: readonly JsonObject[],
  selector: SessionUsageSelector,
): LatestUsageView | null {
  let latest: LatestUsageView | null = null
  let latestTimestamp = Number.NEGATIVE_INFINITY
  for (const record of records) {
    if (!recordMatchesSession(record, selector)) continue
    const usage = usageFromRecord(record)
    if (!usage) continue
    const timestamp = Date.parse(usage.timestamp ?? asString(record.timestamp) ?? "")
    const sortValue = Number.isFinite(timestamp) ? timestamp : latestTimestamp + 1
    if (sortValue >= latestTimestamp) {
      latestTimestamp = sortValue
      latest = usage
    }
  }
  return latest
}

function readActivityRecords(
  filePath: string | null,
  recordedPath: string | undefined,
  errors: ReadError[],
): JsonObject[] {
  if (!filePath) {
    addReadError(errors, "activity", recordedPath
      ? "Activity journal path was rejected"
      : "Activity journal path is not recorded yet", recordedPath)
    return []
  }

  let text: string
  try {
    text = readFileSync(filePath, "utf8")
  } catch (error) {
    addReadError(errors, "activity", errorMessage(error), recordedPath ?? filePath)
    return []
  }

  const lines = completeLines(text)
  const records: JsonObject[] = []
  for (const [index, line] of lines.entries()) {
    try {
      const parsed = asObject(JSON.parse(line))
      if (!parsed) {
        addReadError(errors, "activity", "Expected a JSON object record", `line ${index + 1}`)
        continue
      }
      records.push(parsed)
    } catch (error) {
      addReadError(errors, "activity", `Invalid JSON: ${errorMessage(error)}`, `line ${index + 1}`)
    }
  }
  return records
}

function readActivity(
  records: readonly JsonObject[],
): JsonObject[] {
  return records.slice(-ACTIVITY_LIMIT)
}

function readExecutorLog(
  filePath: string | null,
  recordedPath: string | undefined,
  errors: ReadError[],
): string[] {
  if (!filePath) {
    addReadError(errors, "executorLog", recordedPath
      ? "Executor log path was rejected"
      : "Executor log path is not recorded yet", recordedPath)
    return []
  }

  try {
    return completeLines(readFileSync(filePath, "utf8")).slice(-EXECUTOR_LOG_LIMIT)
  } catch (error) {
    addReadError(errors, "executorLog", errorMessage(error), recordedPath ?? filePath)
    return []
  }
}

function safeLogPart(value: string): string {
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

function readTailLines(
  filePath: string,
  lineLimit: number,
  errors: ReadError[],
  source: string,
  recordedPath: string,
): string[] {
  let descriptor: number | undefined
  try {
    const size = statSync(filePath).size
    const start = Math.max(0, size - SESSION_TEXT_MAX_BYTES)
    const length = size - start
    if (length <= 0) return []

    descriptor = openSync(filePath, "r")
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(descriptor, buffer, 0, length, start)
    let text = buffer.subarray(0, bytesRead).toString("utf8")
    if (start > 0) {
      const firstNewline = text.indexOf("\n")
      if (firstNewline < 0) return []
      text = text.slice(firstNewline + 1)
    }
    return completeLines(text).slice(-lineLimit)
  } catch (error) {
    addReadError(errors, source, errorMessage(error), recordedPath)
    return []
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // The file may disappear between the read and close during a poll.
      }
    }
  }
}

function readSessionText(
  filePath: PathInfo | null,
  errors: ReadError[],
): string[] {
  // A session log is created lazily on its first normalized activity flush.
  // Missing logs are therefore normal for pending/never-started sessions.
  if (!filePath || !filePath.exists) return []
  return readTailLines(filePath.absolute, SESSION_TEXT_LIMIT, errors, "sessionText", filePath.recorded)
}

function derivedSessionTextPath(
  runtimeDirectory: PathInfo | null,
  threadId: string,
  attemptId: string | undefined,
  errors: ReadError[],
  repository: MonitorRepository,
): PathInfo | null {
  if (!runtimeDirectory) return null
  const recorded = join(
    runtimeDirectory.recorded,
    "sessions",
    safeLogPart(threadId),
    ...(attemptId === undefined ? [] : [safeLogPart(attemptId)]),
    "session.log",
  )
  const absolute = resolveRecordedPath(recorded, "sessionText", errors, repository)
  if (!absolute) return null
  return { recorded, absolute, exists: existsSync(absolute) }
}

function timestampValue(batch: JsonObject): number {
  const values = [
    batch.updatedAt,
    batch.lastActivityAt,
    batch.executorHeartbeatAt,
    batch.startedAt,
  ]
  return Math.max(
    0,
    ...values.map((value) => {
      const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN
      return Number.isFinite(timestamp) ? timestamp : 0
    }),
  )
}

function batchIsSdk(batch: JsonObject): boolean {
  if (batch.executionBackend === "sdk") return true
  const threads = Array.isArray(batch.threads) ? batch.threads : []
  return threads.some((thread) => asObject(thread)?.executionBackend === "sdk")
}

function batchIsTerminal(batch: JsonObject): boolean {
  return ["completed", "failed", "cancelled"].includes(String(batch.status))
    || ["completed", "failed", "cancelled"].includes(String(batch.terminalOutcome))
}

function batchIsRunning(batch: JsonObject): boolean {
  return batch.status === "running"
}

function sortNewestSdkBatch(left: JsonObject, right: JsonObject): number {
  const activityRank = (batch: JsonObject): number => batchIsRunning(batch) ? 2 : batch.status === "pending" ? 1 : 0
  const rankDifference = activityRank(right) - activityRank(left)
  if (rankDifference !== 0) return rankDifference

  const timestampDifference = timestampValue(right) - timestampValue(left)
  if (timestampDifference !== 0) return timestampDifference

  return String(right.runId ?? "").localeCompare(String(left.runId ?? ""), undefined, { numeric: true })
}

function selectBatch(state: JsonObject): { batch: JsonObject | null; reason: string | null } {
  const rawBatchRuns = state.batchRuns
  const batchRuns = Array.isArray(rawBatchRuns)
    ? rawBatchRuns.map(asObject).filter((batch): batch is JsonObject => batch !== null)
    : []
  const sdkRuns = batchRuns.filter((batch) => batchIsSdk(batch))
  const activeRuns = sdkRuns.filter((batch) => !batchIsTerminal(batch))

  if (activeRuns.length > 0) {
    return { batch: [...activeRuns].sort(sortNewestSdkBatch)[0] ?? null, reason: "active SDK run" }
  }

  // Keep the monitor useful after a run finishes, while preferring active
  // nonterminal runs whenever one exists.
  return {
    batch: [...sdkRuns].sort(sortNewestSdkBatch)[0] ?? null,
    reason: sdkRuns.length > 0 ? "newest SDK run (no active run)" : null,
  }
}

function normalizeSummary(batch: JsonObject): JsonObject {
  const source = asObject(batch.summary)
  const threads = Array.isArray(batch.threads)
    ? batch.threads.map(asObject).filter((thread): thread is JsonObject => thread !== null)
    : []
  const count = (status: string): number => threads.filter((thread) => thread.status === status).length

  return {
    total: asNumber(source?.total) ?? threads.length,
    pending: asNumber(source?.pending) ?? count("pending"),
    running: asNumber(source?.running) ?? count("running"),
    completed: asNumber(source?.completed) ?? count("completed"),
    failed: asNumber(source?.failed) ?? count("failed"),
  }
}

function pickDefined(source: JsonObject, keys: string[]): JsonObject {
  const result: JsonObject = {}
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  return result
}

function createBatchView(batch: JsonObject, selectionReason: string): JsonObject {
  return {
    ...pickDefined(batch, [
      "version",
      "streamId",
      "batchId",
      "runId",
      "mode",
      "status",
      "stageName",
      "batchName",
      "executionBackend",
      "provider",
      "runtime",
      "logicalAgent",
      "resolvedModel",
      "resolvedVariant",
      "runtimeSelectionSource",
      "startedAt",
      "updatedAt",
      "completedAt",
      "terminalOutcome",
      "errorSummary",
      "resultSummary",
    ]),
    selectionReason,
    summary: normalizeSummary(batch),
  }
}

function sessionSortValue(session: JsonObject): number {
  return Math.max(
    0,
    ...[session.lastActivityAt, session.lastEventAt, session.completedAt, session.startedAt].map((value) => {
      const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN
      return Number.isFinite(timestamp) ? timestamp : 0
    }),
  )
}

function createSessionView(
  session: JsonObject,
  threadId: string,
  runtimeDirectory: PathInfo | null,
  activityRecords: readonly JsonObject[],
  errors: ReadError[],
  repository: MonitorRepository,
): JsonObject {
  const view = pickDefined(session, [
    "sessionId",
    "status",
    "executionBackend",
    "provider",
    "runtime",
    "logicalAgent",
    "resolvedModel",
    "resolvedVariant",
    "runtimeSelectionSource",
    "attemptId",
    "nativeSessionId",
    "nativeRunId",
    "startedAt",
    "completedAt",
    "lastEventAt",
    "lastActivityAt",
    "terminalOutcome",
    "errorSummary",
    "resultSummary",
  ])
  const attemptId = asString(session.attemptId)
  const path = derivedSessionTextPath(runtimeDirectory, threadId, attemptId, errors, repository)
  const latestUsage = selectLatestSessionUsage(activityRecords, {
    threadId,
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(asString(session.sessionId) === undefined ? {} : { workSessionId: asString(session.sessionId) }),
  })
  return {
    ...view,
    sessionText: {
      path,
      lines: readSessionText(path, errors),
    },
    ...(latestUsage === null ? {} : {
      latestUsage,
      latestUsageSummary: formatLatestUsageSummary(latestUsage),
    }),
  }
}

function createThreadViews(
  state: JsonObject,
  batch: JsonObject,
  runtimeDirectory: PathInfo | null,
  activityRecords: readonly JsonObject[],
  errors: ReadError[],
  repository: MonitorRepository,
): JsonObject[] {
  const hierarchy = asObject(state.hierarchy)
  const hierarchyThreads = Array.isArray(hierarchy?.threads)
    ? hierarchy.threads.map(asObject).filter((thread): thread is JsonObject => thread !== null)
    : []
  const runtimeRecords = Array.isArray(state.threadRuntime)
    ? state.threadRuntime.map(asObject).filter((thread): thread is JsonObject => thread !== null)
    : []
  const runtimeById = new Map(runtimeRecords.map((thread) => [asString(thread.threadId), thread] as const))
  const batchThreads = Array.isArray(batch.threads)
    ? batch.threads.map(asObject).filter((thread): thread is JsonObject => thread !== null)
    : hierarchyThreads.filter((thread) => thread.batchId === batch.batchId)

  return batchThreads.map((batchThread) => {
    const threadId = asString(batchThread.threadId) ?? asString(batchThread.id) ?? "unknown-thread"
    const runtime = runtimeById.get(threadId)
    const hierarchyThread = hierarchyThreads.find((thread) => thread.id === threadId)
    const rawSessions = Array.isArray(runtime?.sessions)
      ? runtime.sessions.map(asObject).filter((session): session is JsonObject => session !== null)
      : []
    const sessions = rawSessions.map((session) => createSessionView(session, threadId, runtimeDirectory, activityRecords, errors, repository))
    const currentSessionId = asString(batchThread.currentSessionId) ?? asString(runtime?.currentSessionId)
    const selectedSession = rawSessions.find((session) => session.sessionId === currentSessionId)
      ?? [...rawSessions].sort((left, right) => sessionSortValue(right) - sessionSortValue(left))[0]
    const status = asString(batchThread.status)
      ?? asString(runtime?.status)
      ?? asString(selectedSession?.status)
      ?? "pending"

    return {
      threadId,
      threadName: asString(batchThread.threadName)
        ?? asString(hierarchyThread?.name)
        ?? asString(runtime?.itemName)
        ?? "Unnamed thread",
      status,
      ...(currentSessionId === undefined ? {} : { currentSessionId }),
      ...pickDefined(batchThread, [
        "attemptId",
        "nativeSessionId",
        "nativeRunId",
        "startedAt",
        "updatedAt",
        "completedAt",
        "lastEventAt",
        "lastActivityAt",
        "terminalOutcome",
        "errorSummary",
        "resultSummary",
      ]),
      ...(batchThread.nativeSessionId === undefined && selectedSession?.nativeSessionId !== undefined
        ? { nativeSessionId: selectedSession.nativeSessionId }
        : {}),
      ...(batchThread.nativeRunId === undefined && selectedSession?.nativeRunId !== undefined
        ? { nativeRunId: selectedSession.nativeRunId }
        : {}),
      sessions,
    }
  })
}

function heartbeatAgeMs(value: unknown, capturedAt: string): number | null {
  if (typeof value !== "string") return null
  const heartbeat = Date.parse(value)
  const captured = Date.parse(capturedAt)
  if (!Number.isFinite(heartbeat) || !Number.isFinite(captured)) return null
  return Math.max(0, captured - heartbeat)
}

function emptyMonitorPayload(repository: MonitorRepository, capturedAt = new Date().toISOString()): MonitorPayload {
  return {
    repository,
    capturedAt,
    streamId: null,
    batch: null,
    executor: null,
    runtime: null,
    sessions: [],
    activity: [],
    executorLog: [],
    readErrors: [],
  }
}

export function buildMonitorPayload(repositoryKey?: string): MonitorPayload {
  const repository = getMonitorRepository(repositoryKey)
  if (!repository) throw new Error(`Unknown monitored repository key: ${repositoryKey}`)

  const capturedAt = new Date().toISOString()
  const readErrors: ReadError[] = []
  const empty = emptyMonitorPayload(repository, capturedAt)
  empty.readErrors = readErrors

  const index = readJsonFile(join(repository.root, "work", "index.json"), "index", readErrors)
  const streamId = asString(index?.current_stream)
  if (!streamId) {
    addReadError(readErrors, "index", "current_stream is not set")
    return empty
  }
  empty.streamId = streamId

  const statePath = resolveRecordedPath(
    join("work", streamId, "workstream-state.json"),
    "workstream-state",
    readErrors,
    repository,
  )
  if (!statePath) {
    return empty
  }

  const state = readJsonFile(statePath, "workstream-state", readErrors)
  if (!state) {
    return empty
  }

  const selection = selectBatch(state)
  if (!selection.batch || !selection.reason) {
    addReadError(readErrors, "batchRuns", "No SDK batch run is recorded for the current stream")
    return empty
  }

  const batch = selection.batch
  empty.batch = createBatchView(batch, selection.reason)
  empty.executor = {
    status: asString(batch.status) ?? "unknown",
    ...pickDefined(batch, [
      "executorPid",
      "executorStartedAt",
      "executorHeartbeatAt",
      "executorFinishedAt",
      "lastEventAt",
      "lastActivityAt",
    ]),
    heartbeatAgeMs: heartbeatAgeMs(batch.executorHeartbeatAt, capturedAt),
  }

  const runtimeDirectory = pathInfo(batch.runtimeDirectory, "runtimeDirectory", readErrors, repository)
  const activityPath = pathInfo(batch.activityJournalPath, "activityJournalPath", readErrors, repository)
  const snapshotPath = pathInfo(batch.snapshotPath, "snapshotPath", readErrors, repository)
  const executorLogPath = pathInfo(batch.executorLogPath, "executorLogPath", readErrors, repository)
  const sessionTextLogPath = runtimeDirectory
    ? pathInfo(join(runtimeDirectory.recorded, "session.log"), "sessionTextLog", readErrors, repository)
    : null
  const sessionTextLog = sessionTextLogPath
    ? { ...sessionTextLogPath, lines: readSessionText(sessionTextLogPath, readErrors) }
    : null
  empty.runtime = {
    runPath: runtimeDirectory,
    runtimeDirectory,
    activityJournalPath: activityPath,
    snapshotPath,
    executorLogPath,
    sessionTextLog,
  }

  const activityRecordedPath = asString(batch.activityJournalPath)
  const executorLogRecordedPath = asString(batch.executorLogPath)
  const activityRecords = readActivityRecords(activityPath?.absolute ?? null, activityRecordedPath, readErrors)
  empty.activity = readActivity(activityRecords)
  empty.sessions = createThreadViews(state, batch, runtimeDirectory, activityRecords, readErrors, repository)
  empty.executorLog = readExecutorLog(executorLogPath?.absolute ?? null, executorLogRecordedPath, readErrors)
  return empty
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

export function requestHandler(request: Request): Response {
  const url = new URL(request.url)

  if (request.method !== "GET") {
    return new Response("Method Not Allowed\n", {
      status: 405,
      headers: { allow: "GET" },
    })
  }

  if (url.pathname === "/") {
    if (url.search.length > 0) {
      return new Response("Query parameters are not supported\n", { status: 400 })
    }
    try {
      return new Response(readFileSync(MONITOR_HTML_PATH, "utf8"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    } catch (error) {
      return new Response(`Monitor page unavailable: ${errorMessage(error)}\n`, { status: 500 })
    }
  }

  if (url.pathname === "/api/sdk-monitor") {
    const repositoryValues = url.searchParams.getAll("repo")
    const unsupportedParameter = [...url.searchParams.keys()].find((key) => key !== "repo")
    if (unsupportedParameter) {
      return jsonResponse({
        error: `Unsupported query parameter: ${unsupportedParameter}`,
        supportedRepositories: MONITORED_REPOSITORIES.map(({ key }) => key),
      }, 400)
    }
    if (repositoryValues.length > 1) {
      return jsonResponse({ error: "The repo query parameter may only be provided once" }, 400)
    }

    const requestedRepositoryKey = repositoryValues[0]
    const repository = getMonitorRepository(requestedRepositoryKey)
    if (!repository) {
      return jsonResponse({
        error: `Unknown monitored repository key: ${requestedRepositoryKey ?? ""}`,
        supportedRepositories: MONITORED_REPOSITORIES.map(({ key }) => key),
      }, 400)
    }

    try {
      return jsonResponse(buildMonitorPayload(repository.key))
    } catch (error) {
      // A partially written canonical file should never take down the tiny
      // server. Keep the response shape useful for the page.
      const payload = emptyMonitorPayload(repository)
      payload.readErrors.push({ source: "monitor", message: errorMessage(error) })
      return jsonResponse(payload, 500)
    }
  }

  return new Response("Not Found\n", { status: 404 })
}

if (import.meta.main) {
  const server = Bun.serve({
    hostname: HOSTNAME,
    port: PORT,
    fetch: requestHandler,
  })

  console.log(`SDK monitor PoC listening at ${server.url}`)
}
