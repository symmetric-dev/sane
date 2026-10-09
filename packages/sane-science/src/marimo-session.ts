import { randomUUID } from "node:crypto"
import type { MarimoRuntimeService } from "./marimo-runtime.ts"
import type { MarimoRuntimeRef } from "./marimo-runtime-contracts.ts"
import { MarimoSessionError, type MarimoNativeSessionStatus } from "./marimo-session-contracts.ts"

type Issue = NonNullable<MarimoNativeSessionStatus["issue"]>
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function editor(value: unknown): boolean {
  const capabilities = record(value)
  return capabilities?.edit === true && capabilities.interact === true
}

/** Backend-only, private Marimo 0.25.1 protocol. No commands travel over this socket.
 * Sources: _server/api/endpoints/ws/{ws_connection_validator,ws_session_connector,
 * session_handler,ws_message_loop}.py; _messaging/notification.py.
 * Explicit reconnect only; no mutation retries and no claims of output replay.
 */
export class MarimoNativeSession {
  private readonly ref: MarimoRuntimeRef
  private value: MarimoNativeSessionStatus = { sessionId: randomUUID(), state: "disconnected", revision: 0 }
  private socket?: WebSocket
  private cleanupSocket?: () => void
  private monitor?: ReturnType<typeof setInterval>
  private cancelConnect?: () => void
  private connecting?: Promise<MarimoNativeSessionStatus>
  private established = false

  constructor(private readonly runtime: MarimoRuntimeService, ref: MarimoRuntimeRef) {
    this.ref = { ...ref }
  }

  status(): MarimoNativeSessionStatus {
    if (this.value.state !== "closed") {
      try { this.runtime.connection(this.ref) }
      catch { this.disconnect("runtime-unavailable") }
    }
    return { ...this.value }
  }

  /** Waits for authenticated version evidence and a kernel attachment, not inspection. */
  connect(timeoutMs = 15_000): Promise<MarimoNativeSessionStatus> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new MarimoSessionError("timeout", "Readiness timeout must be between 1 and 60000 milliseconds.")
    if (this.connecting) return this.connecting
    const current = this.status()
    if (current.state === "closed") throw new MarimoSessionError("connection-failed", "The native session owner is closed.")
    if (current.state === "ready" || current.state === "attached") return Promise.resolve(current)
    this.value = { sessionId: current.sessionId, state: "connecting", revision: current.revision + 1 }
    const revision = this.value.revision
    this.monitor = setInterval(() => { this.status() }, 250)
    this.monitor.unref()
    this.connecting = this.attach(Date.now() + timeoutMs, revision).catch(error => {
      const issue = error instanceof MarimoSessionError ? error.code : "connection-failed"
      if (this.value.state !== "closed") this.disconnect(issue)
      throw new MarimoSessionError(issue, "Native notebook attachment failed; inspect status before reconnecting.")
    }).finally(() => { this.connecting = undefined })
    return this.connecting
  }

  /** Caller must finish a fresh pair inspection of this attachment before confirming. */
  confirmReady(revision: number): MarimoNativeSessionStatus {
    const status = this.status()
    if (status.revision !== revision || status.state !== "attached") throw new MarimoSessionError("connection-failed", "Native attachment changed during inspection.")
    this.value.state = "ready"
    return this.status()
  }

  inspectionFailed(): void { this.disconnect("inspection-failed") }

  close(): void {
    this.value.state = "closed"
    this.release()
  }

  private disconnect(issue: Issue): void {
    if (this.value.state === "closed") return
    this.value.state = "disconnected"
    this.value.issue = issue
    this.release()
  }

  private release(): void {
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = undefined
    this.cancelConnect?.()
    this.cancelConnect = undefined
    this.cleanupSocket?.()
    this.cleanupSocket = undefined
    const socket = this.socket
    this.socket = undefined
    try { socket?.close() } catch { /* Never expose transport errors or headers. */ }
  }

  private async attach(deadline: number, revision: number): Promise<MarimoNativeSessionStatus> {
    // /api/version is authenticated; /health does not prove token or version ownership.
    while (true) {
      this.assertConnecting(revision)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new MarimoSessionError("timeout", "Native session readiness timed out.")
      const connection = this.runtime.connection(this.ref)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.min(remaining, 2_000))
      this.cancelConnect = () => controller.abort()
      try {
        const response = await fetch(`${connection.baseUrl}/api/version`, {
          headers: { Authorization: `Bearer ${connection.token}` }, signal: controller.signal, redirect: "error",
        })
        if (response.ok) {
          const text = await response.text()
          if (text.trim() !== "0.25.1") throw new MarimoSessionError("version-mismatch", "Native sessions require Marimo 0.25.1.")
          break
        }
        await response.body?.cancel()
      } catch (error) {
        if (error instanceof MarimoSessionError) throw error
      } finally {
        clearTimeout(timer)
        this.cancelConnect = undefined
      }
      this.assertConnecting(revision)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(150, deadline - Date.now()))))
    }
    this.assertConnecting(revision)
    if (Date.now() >= deadline) throw new MarimoSessionError("timeout", "Native session readiness timed out.")
    const connection = this.runtime.connection(this.ref)
    const url = new URL("/ws", connection.baseUrl)
    url.protocol = "ws:"
    url.searchParams.set("session_id", this.value.sessionId)
    // Bun's backend WebSocket constructor accepts headers; no credential URL exists.
    // App typechecking includes lib.dom, whose constructor omits Bun's options.
    const BackendWebSocket = globalThis.WebSocket as unknown as {
      new(url: string | URL, options: Bun.WebSocketOptions): WebSocket
    }
    const socket = new BackendWebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } })
    this.socket = socket
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (issue?: Issue) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.cancelConnect = undefined
        if (issue) reject(new MarimoSessionError(issue, "Native notebook attachment was not confirmed."))
        else resolve({ ...this.value })
      }
      const fail = (issue: Issue) => { finish(issue); this.disconnect(issue) }
      const timer = setTimeout(() => fail("timeout"), Math.max(1, deadline - Date.now()))
      const onClose = () => fail("connection-failed")
      const onError = () => fail("connection-failed")
      const onMessage = (event: MessageEvent) => {
        if (this.socket !== socket) return
        try {
          this.runtime.connection(this.ref)
          if (typeof event.data !== "string") return fail("protocol-error")
          const message = record(JSON.parse(event.data)), data = record(message?.data)
          if (!message || typeof message.op !== "string" || !data) return fail("protocol-error")
          if (message.op === "kernel-startup-error") return fail("connection-failed")
          if (message.op === "consumer-capabilities" && !editor(data.consumer_capabilities)) return fail("not-editor")
          if (message.op === "kernel-ready") {
            if (settled) return fail("protocol-error")
            if (data.kiosk !== false || !editor(data.consumer_capabilities)) return fail("not-editor")
            this.established = true
            this.value.attachment = "new"
          } else if (message.op === "reconnected") {
            // Same-ID reconnect emits no kernel-ready and replays no output state.
            if (!this.established || settled) return fail("protocol-error")
            this.value.attachment = "reconnected"
          } else return
          this.value.state = "attached"
          finish()
        } catch { fail("protocol-error") }
      }
      socket.addEventListener("message", onMessage)
      socket.addEventListener("close", onClose)
      socket.addEventListener("error", onError)
      this.cancelConnect = () => finish("connection-failed")
      this.cleanupSocket = () => {
        clearTimeout(timer)
        socket.removeEventListener("message", onMessage)
        socket.removeEventListener("close", onClose)
        socket.removeEventListener("error", onError)
      }
    })
  }

  private assertConnecting(revision: number): void {
    const status = this.status()
    if (status.state !== "connecting" || status.revision !== revision) throw new MarimoSessionError("connection-failed", "Native connection attempt is no longer current.")
  }
}
