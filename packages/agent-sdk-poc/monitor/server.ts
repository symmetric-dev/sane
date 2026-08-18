import {
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs"
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"

const REPO_ROOT = "/Users/beto/gene"
const PORT = 43120
const HOSTNAME = "127.0.0.1"
const MONITOR_HTML_PATH = join(import.meta.dir, "index.html")
const ACTIVITY_LIMIT = 50
const EXECUTOR_LOG_LIMIT = 200

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

function isWithinRepo(candidate: string): boolean {
  const relativePath = relative(REPO_ROOT, candidate)
  return relativePath === ""
    || (!relativePath.startsWith("../")
      && !relativePath.startsWith("..\\")
      && relativePath !== ".."
      && !isAbsolute(relativePath))
}

/**
 * Resolve a path recorded in canonical state without allowing it to escape the
 * fixed PoC repository. Existing symlinks are checked with realpath as well.
 */
function resolveRecordedPath(
  value: unknown,
  source: string,
  errors: ReadError[],
): string | null {
  const recorded = asString(value)
  if (!recorded) {
    return null
  }

  const candidate = isAbsolute(recorded)
    ? resolve(recorded)
    : resolve(REPO_ROOT, recorded)

  if (!isWithinRepo(candidate)) {
    addReadError(errors, source, "Recorded path escapes the fixed repository root", recorded)
    return null
  }

  // Check the path itself, or the nearest existing parent when the artifact is
  // still being initialized. This also catches a missing file beneath a
  // symlink that points outside the repository.
  let existingPath = candidate
  while (true) {
    try {
      const realPath = realpathSync(existingPath)
      if (!isWithinRepo(realPath)) {
        addReadError(errors, source, "Recorded path resolves outside the fixed repository root", recorded)
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
): PathInfo | null {
  const recorded = asString(recordedValue)
  if (!recorded) {
    return null
  }

  const absolute = resolveRecordedPath(recorded, source, errors)
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

function readActivity(
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
  const tail = lines.slice(-ACTIVITY_LIMIT)
  for (const [index, line] of tail.entries()) {
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

function createSessionView(session: JsonObject): JsonObject {
  return pickDefined(session, [
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
}

function createThreadViews(state: JsonObject, batch: JsonObject): JsonObject[] {
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
    const sessions = rawSessions.map(createSessionView)
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

function buildPayload(): MonitorPayload {
  const capturedAt = new Date().toISOString()
  const readErrors: ReadError[] = []
  const empty: MonitorPayload = {
    capturedAt,
    streamId: null,
    batch: null,
    executor: null,
    runtime: null,
    sessions: [],
    activity: [],
    executorLog: [],
    readErrors,
  }

  const index = readJsonFile(join(REPO_ROOT, "work", "index.json"), "index", readErrors)
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
  empty.sessions = createThreadViews(state, batch)
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

  const runtimeDirectory = pathInfo(batch.runtimeDirectory, "runtimeDirectory", readErrors)
  const activityPath = pathInfo(batch.activityJournalPath, "activityJournalPath", readErrors)
  const snapshotPath = pathInfo(batch.snapshotPath, "snapshotPath", readErrors)
  const executorLogPath = pathInfo(batch.executorLogPath, "executorLogPath", readErrors)
  empty.runtime = {
    runPath: runtimeDirectory,
    runtimeDirectory,
    activityJournalPath: activityPath,
    snapshotPath,
    executorLogPath,
  }

  const activityRecordedPath = asString(batch.activityJournalPath)
  const executorLogRecordedPath = asString(batch.executorLogPath)
  empty.activity = readActivity(activityPath?.absolute ?? null, activityRecordedPath, readErrors)
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

function requestHandler(request: Request): Response {
  const url = new URL(request.url)

  if (request.method !== "GET") {
    return new Response("Method Not Allowed\n", {
      status: 405,
      headers: { allow: "GET" },
    })
  }

  // This PoC has no query-parameter API. Rejecting a query string makes it
  // impossible to turn this endpoint into an arbitrary path reader later.
  if (url.search.length > 0) {
    return new Response("Query parameters are not supported\n", { status: 400 })
  }

  if (url.pathname === "/") {
    try {
      return new Response(readFileSync(MONITOR_HTML_PATH, "utf8"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    } catch (error) {
      return new Response(`Monitor page unavailable: ${errorMessage(error)}\n`, { status: 500 })
    }
  }

  if (url.pathname === "/api/sdk-monitor") {
    try {
      return jsonResponse(buildPayload())
    } catch (error) {
      // A partially written canonical file should never take down the tiny
      // server. Keep the response shape useful for the page.
      return jsonResponse({
        capturedAt: new Date().toISOString(),
        streamId: null,
        batch: null,
        executor: null,
        runtime: null,
        sessions: [],
        activity: [],
        executorLog: [],
        readErrors: [{ source: "monitor", message: errorMessage(error) }],
      }, 500)
    }
  }

  return new Response("Not Found\n", { status: 404 })
}

const server = Bun.serve({
  hostname: HOSTNAME,
  port: PORT,
  fetch: requestHandler,
})

console.log(`SDK monitor PoC listening at ${server.url}`)
