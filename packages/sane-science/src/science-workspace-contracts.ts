import type { MarimoRuntimeRef, MarimoRuntimeSnapshot } from "./marimo-runtime-contracts.ts"
import type { MarimoNativeSessionStatus } from "./marimo-session-contracts.ts"

export interface ScienceNotebookRef extends MarimoRuntimeRef {}
export interface ScienceSessionRef extends ScienceNotebookRef { sessionId: string }

export interface ScienceNotebookStatus {
  ref: ScienceNotebookRef
  state: "server-unverified" | "awaiting-browser-session" | "awaiting-session-selection" | "session-ready" | "session-lost" | "stopped" | "failed"
  runtime: MarimoRuntimeSnapshot
  /** Authenticated, warning-free pair listing observed on this generation. */
  serverReadiness: "unverified" | "ready"
  sessionIds: string[]
  selectedSession?: ScienceSessionRef
  /** Present only for an explicitly backend-owned native session. */
  nativeSession?: MarimoNativeSessionStatus
  observedAt?: string
  issue?: "listing-unconfirmed" | "session-missing" | "session-inspection-failed" | "native-session-disconnected"
}

export interface OpenScienceNotebookOptions {
  /** Exact absolute path of a direct .py child of science/notebooks. */
  notebookPath: string
  port: number
  /** Bounded authenticated readiness polling, default 15 seconds, max 60 seconds. */
  readinessTimeoutMs?: number
}

/** Credential-bearing URL; explicitly request it for a trusted browser surface only. */
export interface ScienceBrowserConnection { ref: ScienceNotebookRef; url: string }

export class ScienceWorkspaceError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "ENVIRONMENT_NOT_READY" | "BUSY" | "STALE_GENERATION" | "SESSION_NOT_READY", message: string) {
    super(message)
    this.name = "ScienceWorkspaceError"
  }
}
