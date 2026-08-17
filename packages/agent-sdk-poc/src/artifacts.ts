import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import type {
  AsyncAcceptedArtifactInput,
  ArtifactStoreOptions,
  EventCorrelation,
  FinishArtifactInput,
  PocEventEnvelope,
  PocManifest,
  PocAsyncLaunchArtifact,
  PocResultArtifact,
  PocStatus,
  SerializedError,
} from "./types.ts"

export const ARTIFACT_FILES = ["manifest.json", "events.jsonl", "stdout.log", "stderr.log", "result.json"] as const

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

function json(value: unknown, pretty = false): string {
  return `${JSON.stringify(value, jsonReplacer, pretty ? 2 : undefined) ?? "null"}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function recordField(records: Record<string, unknown>[], names: string[]): string | undefined {
  for (const record of records) {
    for (const name of names) {
      const value = stringField(record[name])
      if (value) return value
    }
  }
  return undefined
}

function nestedRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (!isRecord(value)) return []
  const records: Record<string, unknown>[] = [value]
  if (depth >= 3) return records
  for (const key of ["payload", "properties", "data", "info", "part", "message"]) {
    const nested = value[key]
    if (isRecord(nested)) records.push(...nestedRecords(nested, depth + 1))
  }
  return records
}

/** Extract IDs without changing or interpreting the provider payload in the event log. */
export function correlateProviderEvent(raw: unknown): EventCorrelation {
  if (!isRecord(raw)) return {}

  const records = nestedRecords(raw)

  return {
    agentId: recordField(records, ["agent_id", "agentId"]),
    runId: recordField(records, ["run_id", "runId"]),
    requestId: recordField(records, ["request_id", "requestId"]),
    sessionId: recordField(records, ["session_id", "sessionId", "sessionID"]),
    messageId: recordField(records, ["message_id", "messageId", "messageID"]),
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; requestId?: unknown }
    return {
      message: error.message,
      name: error.name,
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      ...(typeof candidate.requestId === "string" ? { requestId: candidate.requestId } : {}),
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }

  if (isRecord(error)) {
    const data = isRecord(error.data) ? error.data : undefined
    const message = stringField(error.message) ?? stringField(data?.message) ?? String(error)
    return {
      message,
      ...(stringField(error.name) ? { name: error.name as string } : {}),
      ...(stringField(error.code) ? { code: error.code as string } : {}),
      ...(stringField(error.requestId) ? { requestId: error.requestId as string } : {}),
      ...(stringField(error.stack) ? { stack: error.stack as string } : {}),
    }
  }

  return { message: String(error) }
}

function safeTimestamp(timestamp: Date): string {
  return timestamp.toISOString().replaceAll(":", "-")
}

export function defaultRunDirectory(
  provider: "cursor" | "opencode" = "cursor",
  baseDirectory = process.cwd(),
  timestamp = new Date(),
): string {
  return resolve(baseDirectory, ".tmp", "agent-sdk-poc", `${safeTimestamp(timestamp)}-${provider}`)
}

/**
 * File-backed logging for one PoC run. This is deliberately not an AgentRuntime
 * or durable execution state abstraction.
 */
export class ArtifactStore {
  readonly runDirectory: string
  readonly files: Record<(typeof ARTIFACT_FILES)[number], string>

  private manifest: PocManifest
  private writeQueue: Promise<void> = Promise.resolve()

  private constructor(manifest: PocManifest) {
    this.manifest = manifest
    this.runDirectory = manifest.runDirectory
    this.files = {
      "manifest.json": resolve(this.runDirectory, "manifest.json"),
      "events.jsonl": resolve(this.runDirectory, "events.jsonl"),
      "stdout.log": resolve(this.runDirectory, "stdout.log"),
      "stderr.log": resolve(this.runDirectory, "stderr.log"),
      "result.json": resolve(this.runDirectory, "result.json"),
    }
  }

  static async create(options: ArtifactStoreOptions): Promise<ArtifactStore> {
    const startedAt = options.startedAt ?? new Date()
    const runDirectory = resolve(options.runDirectory)
    const manifest: PocManifest = {
      provider: options.provider ?? "cursor",
      runDirectory,
      prompt: options.prompt,
      model: options.model,
      cwd: resolve(options.cwd),
      pid: options.pid ?? process.pid,
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      status: "starting",
      ...(options.launchKind ? { launchKind: options.launchKind } : {}),
      ...(options.observerRequired !== undefined ? { observerRequired: options.observerRequired } : {}),
      ...(options.cursorRuntime ? { cursorRuntime: options.cursorRuntime } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.serverUrl ? { serverUrl: options.serverUrl } : {}),
      ...(options.sessionTitle ? { sessionTitle: options.sessionTitle } : {}),
    }
    const store = new ArtifactStore(manifest)

    await mkdir(runDirectory, { recursive: true })
    await Promise.all([
      writeFile(store.files["manifest.json"], json(manifest, true), "utf8"),
      writeFile(store.files["events.jsonl"], "", "utf8"),
      writeFile(store.files["stdout.log"], "", "utf8"),
      writeFile(store.files["stderr.log"], "", "utf8"),
      writeFile(store.files["result.json"], json(manifest, true), "utf8"),
    ])

    return store
  }

  getManifest(): PocManifest {
    return structuredClone(this.manifest)
  }

  async update(patch: Partial<PocManifest>): Promise<void> {
    this.manifest = {
      ...this.manifest,
      ...patch,
      updatedAt: new Date().toISOString(),
    }
    await this.enqueue(() => this.writeManifest())
  }

  async appendEvent(kind: string, raw: unknown, timestamp = new Date()): Promise<PocEventEnvelope> {
    const envelope: PocEventEnvelope = {
      timestamp: timestamp.toISOString(),
      provider: this.manifest.provider,
      runDirectory: this.runDirectory,
      kind,
      raw,
    }
    const correlation = correlateProviderEvent(raw)
    const manifestChanged = this.applyCorrelation(correlation)

    await this.enqueue(async () => {
      await appendFile(this.files["events.jsonl"], json(envelope), "utf8")
      if (manifestChanged) await this.writeManifest()
    })
    return envelope
  }

  async writeStdout(text: string): Promise<void> {
    const value = text.endsWith("\n") ? text : `${text}\n`
    await this.enqueue(() => appendFile(this.files["stdout.log"], value, "utf8"))
  }

  async writeStderr(text: string): Promise<void> {
    if (!text) return
    await this.enqueue(() => appendFile(this.files["stderr.log"], text, "utf8"))
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  async finish(input: FinishArtifactInput): Promise<PocResultArtifact> {
    const finishedAt = input.finishedAt ?? new Date()
    const cancellationRequestedAt = input.cancellationRequestedAt?.toISOString()
    this.manifest = {
      ...this.manifest,
      status: input.status,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.sessionStatus !== undefined ? { sessionStatus: input.sessionStatus } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(cancellationRequestedAt ? { cancellationRequestedAt } : {}),
      finishedAt: finishedAt.toISOString(),
      updatedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - new Date(this.manifest.startedAt).getTime()),
    }
    const manifestFinishedAt = this.manifest.finishedAt
    const manifestDurationMs = this.manifest.durationMs
    if (!manifestFinishedAt || manifestDurationMs === undefined) {
      throw new Error("Terminal artifact is missing completion metadata")
    }
    const result: PocResultArtifact = {
      provider: this.manifest.provider,
      runDirectory: this.runDirectory,
      status: input.status,
      ...(this.manifest.launchKind ? { launchKind: this.manifest.launchKind } : {}),
      ...(this.manifest.observerRequired !== undefined ? { observerRequired: this.manifest.observerRequired } : {}),
      ...(this.manifest.agentId ? { agentId: this.manifest.agentId } : {}),
      ...(this.manifest.runId ? { runId: this.manifest.runId } : {}),
      ...(this.manifest.requestId ? { requestId: this.manifest.requestId } : {}),
      ...(this.manifest.sessionId ? { sessionId: this.manifest.sessionId } : {}),
      ...(this.manifest.messageId ? { messageId: this.manifest.messageId } : {}),
      ...(this.manifest.serverUrl ? { serverUrl: this.manifest.serverUrl } : {}),
      ...(this.manifest.sessionStatus !== undefined ? { sessionStatus: this.manifest.sessionStatus } : {}),
      model: this.manifest.model,
      cwd: this.manifest.cwd,
      pid: this.manifest.pid,
      startedAt: this.manifest.startedAt,
      finishedAt: manifestFinishedAt,
      durationMs: manifestDurationMs,
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.providerResult !== undefined ? { providerResult: input.providerResult } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(cancellationRequestedAt ? { cancellationRequestedAt } : {}),
      ...(this.manifest.asyncRequestStartedAt ? { asyncRequestStartedAt: this.manifest.asyncRequestStartedAt } : {}),
      ...(this.manifest.asyncRequestCompletedAt ? { asyncRequestCompletedAt: this.manifest.asyncRequestCompletedAt } : {}),
      ...(this.manifest.acceptedAt ? { acceptedAt: this.manifest.acceptedAt } : {}),
      ...(this.manifest.asyncAcceptedStatus !== undefined ? { asyncAcceptedStatus: this.manifest.asyncAcceptedStatus } : {}),
      ...(this.manifest.timeoutMs !== undefined ? { timeoutMs: this.manifest.timeoutMs } : {}),
      ...(this.manifest.cursorRuntime ? { cursorRuntime: this.manifest.cursorRuntime } : {}),
    }

    await this.enqueue(async () => {
      await this.writeManifest()
      await writeFile(this.files["result.json"], json(result, true), "utf8")
    })
    return result
  }

  /**
   * Persist acceptance of an OpenCode async request without manufacturing a
   * terminal result. The response is kept in result.json and events.jsonl as
   * diagnostic evidence; the manifest only carries timestamps/status metadata.
   */
  async recordAsyncAccepted(input: AsyncAcceptedArtifactInput): Promise<PocAsyncLaunchArtifact> {
    const requestStartedAt = input.requestStartedAt.toISOString()
    const requestCompletedAt = input.requestCompletedAt.toISOString()
    const acceptedAt = (input.acceptedAt ?? input.requestCompletedAt).toISOString()
    this.manifest = {
      ...this.manifest,
      status: "running",
      launchKind: "async",
      observerRequired: true,
      sessionId: input.sessionId,
      asyncRequestStartedAt: requestStartedAt,
      asyncRequestCompletedAt: requestCompletedAt,
      acceptedAt,
      ...(input.responseStatus !== undefined ? { asyncAcceptedStatus: input.responseStatus } : {}),
      updatedAt: acceptedAt,
    }
    const artifact: PocAsyncLaunchArtifact = {
      provider: "opencode",
      runDirectory: this.runDirectory,
      status: "running",
      launchKind: "async",
      observerRequired: true,
      sessionId: input.sessionId,
      serverUrl: this.manifest.serverUrl ?? "",
      model: this.manifest.model,
      cwd: this.manifest.cwd,
      pid: this.manifest.pid,
      startedAt: this.manifest.startedAt,
      updatedAt: this.manifest.updatedAt,
      asyncRequestStartedAt: requestStartedAt,
      asyncRequestCompletedAt: requestCompletedAt,
      acceptedAt,
      ...(input.responseStatus !== undefined ? { asyncAcceptedStatus: input.responseStatus } : {}),
      acceptanceResponse: input.response,
    }
    await this.enqueue(async () => {
      await this.writeManifest()
      await writeFile(this.files["result.json"], json(artifact, true), "utf8")
    })
    return artifact
  }

  private applyCorrelation(correlation: EventCorrelation): boolean {
    let changed = false
    if (correlation.agentId && !this.manifest.agentId) {
      this.manifest.agentId = correlation.agentId
      changed = true
    }
    if (correlation.runId && !this.manifest.runId) {
      this.manifest.runId = correlation.runId
      changed = true
    }
    if (correlation.requestId && !this.manifest.requestId) {
      this.manifest.requestId = correlation.requestId
      changed = true
    }
    if (correlation.sessionId && !this.manifest.sessionId) {
      this.manifest.sessionId = correlation.sessionId
      changed = true
    }
    if (correlation.messageId && !this.manifest.messageId) {
      this.manifest.messageId = correlation.messageId
      changed = true
    }
    if (changed) this.manifest.updatedAt = new Date().toISOString()
    return changed
  }

  private async writeManifest(): Promise<void> {
    await writeFile(this.files["manifest.json"], json(this.manifest, true), "utf8")
  }

  private async enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.catch(() => undefined)
    await next
  }
}

export async function createArtifactStore(options: ArtifactStoreOptions): Promise<ArtifactStore> {
  return ArtifactStore.create(options)
}
