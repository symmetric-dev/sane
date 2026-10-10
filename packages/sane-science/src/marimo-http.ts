import { constants } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { Agent, request } from "node:http"
import { MarimoPairError, type MarimoPairOptions } from "./marimo-contracts.ts"
import { scienceSpan } from "./timing.ts"

/** Pinned 0.25.1 wire protocol: _cli/pair/client.py execute/list_sessions,
 * _server/api/endpoints/{execution,health}.py and _server/scratchpad.py.
 * One reusable HTTP pool, no CLI/helper process and no automatic retries.
 */
export class MarimoHttp {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 1_000 })
  private readonly active = new Set<() => void>()
  private disposed = false

  constructor(private readonly options: Required<MarimoPairOptions>) {}

  dispose(): void {
    this.disposed = true
    for (const cancel of this.active) cancel()
    this.agent.destroy()
  }

  async request(url: string, path: string, sessionId?: string, code?: string): Promise<string> {
    const end = scienceSpan(code === undefined ? path === "/api/version" ? "pair-version-http-wall" : "pair-list-http-wall" : "pair-execute-http-wall")
    return new Promise((resolve, reject) => {
      let settled = false
      let admitted = false
      let req: ReturnType<typeof request> | undefined
      let file: FileHandle | undefined
      const failure = (message: string) => new MarimoPairError("PROCESS_FAILED", message, admitted && code !== undefined ? "unknown" : "not-started")
      const closeFile = () => {
        const handle = file
        file = undefined
        // close waits for pending reads; its rejection is always consumed.
        if (handle) void handle.close().catch(() => {})
      }
      const finish = (error?: Error, value?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.active.delete(cancel)
        closeFile()
        if (error) req?.destroy()
        end(error ? "request-error" : "completed")
        if (error) reject(error)
        else resolve(value!)
      }
      const cancel = () => finish(failure("Pair request disposed; inspect before retrying any admitted execution"))
      const deadline = Date.now() + this.options.timeoutMs
      const timer = setTimeout(() => finish(failure("Pair request timed out; inspect before retrying any admitted execution")), this.options.timeoutMs)
      this.active.add(cancel)
      const current = () => {
        if (this.disposed) cancel()
        else if (Date.now() >= deadline) finish(failure("Pair request timed out; inspect before retrying any admitted execution"))
        return !settled
      }
      if (!current()) return
      const start = async () => {
        let token: string
        try {
          const handle = await open(this.options.tokenFile, constants.O_RDONLY | constants.O_NONBLOCK)
          file = handle
          if (!current()) { closeFile(); return }
          const stat = await handle.stat()
          if (!current()) return
          if (!stat.isFile() || stat.size > 4096) throw new Error("Invalid token file")
          const buffer = Buffer.alloc(4097)
          let length = 0
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
            if (!current()) return
            if (!bytesRead) break
            length += bytesRead
          }
          if (length > 4096) throw new Error("Token too large")
          token = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).replace(/[\r\n]+$/, "")
          if (!token || /[\r\n]/.test(token)) throw new Error("Invalid token")
        } catch {
          finish(new MarimoPairError("PROCESS_FAILED", "Could not read a valid pair token file (regular UTF-8 file, maximum 4096 bytes)", "not-started"))
          return
        } finally { closeFile() }
        if (!current()) return
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
        if (sessionId !== undefined) headers["Marimo-Session-Id"] = sessionId
        const body = code === undefined ? undefined : JSON.stringify({ code })
        if (body !== undefined) {
          headers["Content-Type"] = "application/json"
          headers["Content-Length"] = String(Buffer.byteLength(body))
        }
        // No redirects or automatic replay, including on stale pooled sockets.
        if (!current()) return
        req = request(`${url}${path}`, { method: body === undefined ? "GET" : "POST", headers, agent: this.agent })
        req.on("error", () => finish(failure("Pair HTTP connection failed; inspect before retrying any admitted execution")))
        req.on("response", response => {
          const status = response.statusCode ?? 0
          const httpError = status !== 200
          const statusFailure = (raw?: string) => {
            let detail = ""
            // Only source-supported detail classifications escape; never echo remote
            // strings, session IDs, credentials, source, or HTML from an error body.
            if (raw && response.headers["content-type"]?.split(";")[0]?.trim() === "application/json") {
              try {
                const payload = JSON.parse(raw)
                if (payload && !Array.isArray(payload) && typeof payload.detail === "string") {
                  if (payload.detail.startsWith("Invalid session id")) detail = ": stale or unknown session; refresh session listing"
                  else if (payload.detail === "Missing Marimo-Session-Id header") detail = ": required session header missing"
                }
              } catch { /* Unrecognized bodies are discarded. */ }
            }
            if (status === 401 || status === 403) detail = ": authentication or permission rejected; verify the runtime token and edit access"
            const rejected = status === 401 || status === 403 || detail.startsWith(": stale or unknown session") || detail.startsWith(": required session header missing")
            return new MarimoPairError("PAIR_FAILED", `Pair HTTP ${status}${detail}`, code !== undefined && !rejected ? "unknown" : "not-started")
          }
          if (status === 401 || status === 403) { finish(statusFailure()); response.destroy(); return }
          if (!httpError && code !== undefined && !response.headers["content-type"]?.startsWith("text/event-stream")) {
            finish(new MarimoPairError("INVALID_RESPONSE", "Pair execution response was not an event stream", "unknown")); response.destroy(); return
          }
          const chunks: Buffer[] = []
          let bytes = 0
          const limit = httpError ? Math.min(4096, this.options.maxOutputBytes) : this.options.maxOutputBytes
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > limit) { finish(httpError ? statusFailure() : failure("Pair response exceeded its byte limit; inspect before retrying")); response.destroy() }
            else chunks.push(chunk)
          })
          response.on("error", () => finish(httpError ? statusFailure() : failure("Pair response interrupted; inspect before retrying")))
          response.on("aborted", () => finish(httpError ? statusFailure() : failure("Pair response interrupted; inspect before retrying")))
          response.on("end", () => {
            try {
              const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
              if (httpError) finish(statusFailure(raw))
              else finish(undefined, raw)
            } catch { finish(httpError ? statusFailure() : failure("Pair response contained invalid UTF-8; inspect before retrying")) }
          })
        })
        admitted = true
        req.end(body)
      }
      void start().catch(() => finish(failure("Pair request could not be sent; inspect before retrying any admitted execution")))
    })
  }
}

/** The server emits stdout/stderr JSON records and exactly one terminal done.
 * Buffering is bounded at the HTTP layer, including SSE framing and output.
 */
export function marimoExecutionEvents(raw: string): { success: boolean; stdout: string; stderr: string } {
  let stdout = "", stderr = "", success: boolean | undefined
  for (const block of raw.replaceAll("\r\n", "\n").split("\n\n")) {
    let name = "message"
    const data: string[] = []
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue
      const colon = line.indexOf(":")
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
      if (field === "event") name = value
      else if (field === "data") data.push(value)
    }
    if (!data.length) continue
    if (success !== undefined) throw new Error("Event after terminal completion")
    const payload = JSON.parse(data.join("\n"))
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid event")
    if (name === "stdout" || name === "stderr") {
      if (typeof payload.data !== "string") throw new Error("Invalid console output")
      if (name === "stdout") stdout += payload.data
      else stderr += payload.data
    } else if (name === "done") {
      if (typeof payload.success !== "boolean" || !payload.output || typeof payload.output.mimetype !== "string" || typeof payload.output.data !== "string") throw new Error("Invalid completion")
      success = payload.success
    } else throw new Error("Unexpected execution event")
  }
  if (success === undefined) throw new Error("Missing completion")
  return { success, stdout, stderr }
}
