import { lstatSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DomainError, handoffInput, handoffSchema } from "../../sane-core/src/server.ts"
import { openNativeCaller, type NativeCaller } from "./native-caller.ts"

export { handoffSchema as nativeHandoffSchema }
export const nativeHandoffStatusSchema = { type: "object", properties: { requestId: { type: "string", minLength: 1, maxLength: 200 } }, required: ["requestId"], additionalProperties: false } as const

// C11 client-side guard: project any server handoff reply down to the approved
// agent-facing shapes, so oversized payloads never reach agent context even if
// the server regresses. Key names match the server projection exactly.
const nativeHandoffStatusKeys = ["id", "status", "revision"] as const
export function projectNativeHandoffReply(handoff: unknown, status: boolean): unknown {
  if (handoff === null || handoff === undefined || typeof handoff !== "object" || Array.isArray(handoff)) return handoff
  const src = handoff as Record<string, unknown>
  const nested = (container: unknown, key: string): { found: boolean; value?: unknown } =>
    typeof container === "object" && container !== null && !Array.isArray(container) && key in container
      ? { found: true, value: (container as Record<string, unknown>)[key] }
      : { found: false }
  if (!status) {
    // Flat approved keys first; fall back to the full-row nesting so a
    // regressed server reply still projects to the shape callers parse.
    const out: Record<string, unknown> = {}
    const take = (key: string, fallback?: { found: boolean; value?: unknown }) => {
      const direct = nested(src, key)
      if (direct.found) out[key] = direct.value
      else if (fallback?.found) out[key] = fallback.value
    }
    take("requestId", nested(src.input, "requestId"))
    take("id")
    take("to", nested(src.input, "to"))
    take("status")
    take("recipientSessionId", nested(src.recipient, "sessionId"))
    take("runId")
    return out
  }
  const out: Record<string, unknown> = {}
  for (const k of nativeHandoffStatusKeys) if (k in src) out[k] = src[k]
  return out
}

export async function handoffNativeCaller(caller: NativeCaller, input: unknown, connectionFile: string, status = false) {
  const opened = openNativeCaller(caller)
  try {
    const args = status ? input as { requestId: string } : handoffInput(input)
    if (!args || typeof args.requestId !== "string" || !args.requestId.trim() || args.requestId.length > 200 || status && Object.keys(args).some(k => k !== "requestId")) throw new DomainError("INVALID_INPUT", "Expected a requestId.")
    if (typeof connectionFile !== "string" || !isAbsolute(connectionFile)) throw new DomainError("UNAVAILABLE", "Configure an explicit App native handoff connection file.")
    const stat = lstatSync(connectionFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new DomainError("UNAVAILABLE", "Invalid App connection file.")
    const connection = JSON.parse(readFileSync(connectionFile, "utf8")), url = new URL(connection.url)
    if (connection.version !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/native/handoffs" || url.search || url.hash || url.username || url.password || typeof connection.token !== "string" || !connection.token || !Number.isSafeInteger(connection.pid) || connection.pid < 1) throw new DomainError("UNAVAILABLE", "Invalid local App endpoint.")
    process.kill(connection.pid, 0)
    let response: Response
    try {
      response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ operation: status ? "status" : "enqueue", caller: opened.envelope, ...(status ? { requestId: args.requestId } : { input: args }) }), signal: AbortSignal.timeout(15000) })
    } catch { throw new DomainError("UNAVAILABLE", `App acknowledgment is unknown. Query sane_handoff_status with requestId ${args.requestId}; reuse this same requestId and payload to recover admission, never invent a replacement ID.`) }
    const result = await response.json() as { handoff?: unknown; error?: string }
    if (!response.ok) throw new DomainError("UNAVAILABLE", result.error ?? "App handoff admission unavailable.")
    return { ...result, handoff: projectNativeHandoffReply(result.handoff, status) }
  } finally { opened.domain.close() }
}
