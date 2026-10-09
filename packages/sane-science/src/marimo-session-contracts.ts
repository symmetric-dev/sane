export interface MarimoNativeSessionStatus {
  sessionId: string
  state: "connecting" | "attached" | "ready" | "disconnected" | "closed"
  /** Same-ID reconnect does not replay missed outputs; inspect before ready. */
  attachment?: "new" | "reconnected"
  revision: number
  issue?: "connection-failed" | "version-mismatch" | "timeout" | "protocol-error" | "not-editor" | "runtime-unavailable" | "inspection-failed"
}

export class MarimoSessionError extends Error {
  constructor(readonly code: NonNullable<MarimoNativeSessionStatus["issue"]>, message: string) {
    super(message)
    this.name = "MarimoSessionError"
  }
}
