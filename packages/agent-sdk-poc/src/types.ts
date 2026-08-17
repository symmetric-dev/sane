import type { CursorRuntimeDiagnostics } from "./cursor-runtime.ts"

export type PocProvider = "cursor" | "opencode"

export type PocStatus = "starting" | "running" | "finished" | "error" | "cancelled"

export type PocLaunchKind = "sync" | "async" | "observe"

/**
 * Intentionally small and raw. Provider payloads are not normalized here.
 */
export interface PocEventEnvelope {
  timestamp: string
  provider: PocProvider
  runDirectory: string
  kind: string
  raw: unknown
}

export interface EventCorrelation {
  agentId?: string
  runId?: string
  requestId?: string
  sessionId?: string
  messageId?: string
}

export interface SerializedError {
  message: string
  name?: string
  code?: string
  requestId?: string
  stack?: string
}

export interface PocManifest {
  provider: PocProvider
  runDirectory: string
  prompt: string
  model: string
  cwd: string
  pid: number
  startedAt: string
  updatedAt: string
  finishedAt?: string
  status: PocStatus
  launchKind?: PocLaunchKind
  observerRequired?: boolean
  agentId?: string
  runId?: string
  requestId?: string
  sessionId?: string
  messageId?: string
  serverUrl?: string
  sessionTitle?: string
  sessionStatus?: unknown
  durationMs?: number
  result?: string
  error?: SerializedError
  timeoutMs?: number
  cancellationRequestedAt?: string
  asyncRequestStartedAt?: string
  asyncRequestCompletedAt?: string
  acceptedAt?: string
  asyncAcceptedStatus?: number
  cursorRuntime?: CursorRuntimeDiagnostics
}

export interface PocResultArtifact {
  provider: PocProvider
  runDirectory: string
  status: PocStatus
  launchKind?: PocLaunchKind
  observerRequired?: boolean
  agentId?: string
  runId?: string
  requestId?: string
  sessionId?: string
  messageId?: string
  serverUrl?: string
  sessionStatus?: unknown
  model: string
  cwd: string
  pid: number
  startedAt: string
  finishedAt: string
  durationMs: number
  result?: string
  providerResult?: unknown
  error?: SerializedError
  timeoutMs?: number
  cancellationRequestedAt?: string
  asyncRequestStartedAt?: string
  asyncRequestCompletedAt?: string
  acceptedAt?: string
  asyncAcceptedStatus?: number
  cursorRuntime?: CursorRuntimeDiagnostics
}

/**
 * The async launcher deliberately returns a nonterminal artifact. Terminal
 * status belongs to a later observer process, not to this launch command.
 */
export interface PocAsyncLaunchArtifact {
  provider: "opencode"
  runDirectory: string
  status: "running"
  launchKind: "async"
  observerRequired: true
  sessionId: string
  serverUrl: string
  model: string
  cwd: string
  pid: number
  startedAt: string
  updatedAt: string
  asyncRequestStartedAt: string
  asyncRequestCompletedAt: string
  acceptedAt: string
  asyncAcceptedStatus?: number
  acceptanceResponse?: unknown
}

export interface ArtifactStoreOptions {
  provider?: PocProvider
  runDirectory: string
  prompt: string
  model: string
  cwd: string
  pid?: number
  timeoutMs?: number
  startedAt?: Date
  cursorRuntime?: CursorRuntimeDiagnostics
  serverUrl?: string
  sessionTitle?: string
  launchKind?: PocLaunchKind
  observerRequired?: boolean
}

export interface FinishArtifactInput {
  status: Exclude<PocStatus, "starting" | "running">
  agentId?: string
  runId?: string
  requestId?: string
  sessionId?: string
  messageId?: string
  sessionStatus?: unknown
  result?: string
  providerResult?: unknown
  error?: SerializedError
  finishedAt?: Date
  cancellationRequestedAt?: Date
}

export interface AsyncAcceptedArtifactInput {
  sessionId: string
  response: unknown
  requestStartedAt: Date
  requestCompletedAt: Date
  acceptedAt?: Date
  responseStatus?: number
}
