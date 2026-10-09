import type { ScienceEnvironmentStatus, ScienceWorkspace } from "./contracts.ts"

export interface MarimoRuntimeStartOptions {
  workspace: ScienceWorkspace
  /** Caller-supplied evidence from getScienceEnvironmentStatus; checked again at admission. */
  environment: ScienceEnvironmentStatus
  /** Exact absolute path of an existing, regular .py file under science/notebooks. */
  notebookPath: string
  port: number
  /** Bounds process spawn only, not HTTP or kernel readiness. Default 10 seconds. */
  spawnTimeoutMs?: number
}

export interface MarimoRuntimeRef {
  notebookPath: string
  generation: string
}

export interface MarimoRuntimeSnapshot extends MarimoRuntimeRef {
  repositoryId: string
  notebookIdentity: { device: number; inode: number }
  state: "starting" | "process-started" | "stopping" | "stopped" | "exited" | "failed" | "stop-timeout"
  host: "127.0.0.1"
  port: number
  pid?: number
  serverReadiness: "unverified"
  kernelReadiness: "unverified"
  /** Separate Marimo kernel process groups cannot be proven terminated by server exit. */
  descendantCleanup: "not-started" | "unverified"
  tokenFileCleanup: "not-created" | "pending" | "complete" | "failed"
  /** Output is drained and discarded, never returned or retained (it can contain credentials). */
  outputBytes: { stdout: number; stderr: number }
  exitCode?: number | null
  exitSignal?: string | null
  failure?: "launch-failed" | "port-unavailable" | "spawn-timeout" | "stop-timeout"
}

export interface MarimoRuntimeStopOptions {
  /** SIGINT grace period, default 5 seconds; then SIGTERM, default 2 seconds. */
  interruptTimeoutMs?: number
  terminateTimeoutMs?: number
  /** Final SIGKILL observation bound, default 2 seconds. */
  killTimeoutMs?: number
}

/** Explicit credential access only; never include this object in logs or public status. */
export interface MarimoRuntimeConnection {
  baseUrl: string
  token: string
  /** Backend-only path for the bounded pair CLI; valid only for this live generation. */
  tokenFile: string
}

export type MarimoRuntimeErrorCode = "INVALID_INPUT" | "UNSAFE_NOTEBOOK" | "ENVIRONMENT_NOT_READY" | "BUSY" | "PORT_UNAVAILABLE" | "STALE_GENERATION" | "NOT_RUNNING" | "UNSUPPORTED_PLATFORM"

export class MarimoRuntimeError extends Error {
  constructor(readonly code: MarimoRuntimeErrorCode, message: string) {
    super(message)
    this.name = "MarimoRuntimeError"
  }
}
