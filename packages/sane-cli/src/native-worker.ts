import { lstatSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DomainError } from "../../sane-core/src/server.ts"
import { openNativeCaller, type NativeCaller } from "./native-caller.ts"
import { nativeWorkerInput, nativeWorkerInvocation, nativeWorkerRequestId, parseNativeWorkerRequest, projectNativeWorkerReply, type NativeWorkerOperation } from "./native-worker-contract.ts"

export async function workerNativeCaller(caller: NativeCaller, operation: NativeWorkerOperation, input: unknown, connectionFile: string, signal?: AbortSignal) {
  const args = nativeWorkerInput(operation, input), invocation = nativeWorkerInvocation(caller.invocation)
  const opened = openNativeCaller(caller)
  try {
    const request = parseNativeWorkerRequest({ operation, caller: opened.envelope, invocation, input: { ...args, ...(operation === "start" ? { requestId: nativeWorkerRequestId(opened.envelope, invocation) } : {}) } })
    if (typeof connectionFile !== "string" || !isAbsolute(connectionFile)) throw new DomainError("UNAVAILABLE", "Configure an explicit App native handoff connection file for worker transport.")
    const stat = lstatSync(connectionFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new DomainError("UNAVAILABLE", "Invalid App connection file.")
    const connection = JSON.parse(readFileSync(connectionFile, "utf8")), url = new URL(connection.url)
    if (connection.version !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/native/handoffs" || url.search || url.hash || url.username || url.password || typeof connection.token !== "string" || !connection.token || !Number.isSafeInteger(connection.pid) || connection.pid < 1) throw new DomainError("UNAVAILABLE", "Invalid local App endpoint.")
    process.kill(connection.pid, 0)
    url.pathname = "/native/workers"
    // OC V2 Promise executors expose context.signal. Interrupting this HTTP wait
    // never requests worker cancellation. No transport retry or automatic acknowledgement;
    // only an explicit acknowledge operation requests notification consumption.
    const timeout = AbortSignal.timeout(15000)
    const transportSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response, result: unknown
    try {
      response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` }, body: JSON.stringify(request), signal: transportSignal })
      result = await response.json()
    } catch {
      throw new DomainError("UNAVAILABLE", operation === "start" ? "Worker admission acknowledgment is unknown. Inspect sane_worker_status before another start; a new tool invocation may launch duplicate work. Only the same trusted invocation and payload may recover admission. No automatic retry was attempted." : operation === "acknowledge" ? "Worker acknowledgement receipt is unknown. Inspect status or explicitly acknowledge the same exact references again to recover arbitration state. No automatic retry was attempted." : "App worker transport interrupted or unavailable; workers continue independently. No automatic retry was attempted.")
    }
    if (!response.ok) {
      const error = result && typeof result === "object" && "error" in result ? result.error : undefined
      const code = result && typeof result === "object" && "code" in result ? result.code : undefined
      const label = typeof code === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(code) ? ` [${code}]` : ""
      throw new DomainError("UNAVAILABLE", `App worker request rejected (HTTP ${response.status})${label}: ${typeof error === "string" ? error.slice(0, 4000) : "App worker operation unavailable."}`)
    }
    return projectNativeWorkerReply(result)
  } finally { opened.domain.close() }
}
