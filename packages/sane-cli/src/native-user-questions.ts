import { lstatSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DomainError, normalizeNativeSource } from "../../sane-core/src/server.ts"
import type { NativeCaller } from "./native-caller.ts"
import { parsePresentQuestionsInput, type NativeUserQuestionsRequest, type UserQuestionsReceipt } from "./native-user-questions-contract.ts"

type Invocation = NativeUserQuestionsRequest["invocation"]
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)
const UNKNOWN_ACKNOWLEDGMENT = "App question form transport was interrupted or returned an invalid reply. Presentation acknowledgment is unknown: the App may have saved and presented the form. Inspect this conversation before presenting again; do not blindly re-present it. A new tool invocation creates a distinct form. No automatic retry was attempted."

/** Only the consumed Claude hook binding supplies the native invocation ID. */
export function claudeUserQuestionsInvocation(caller: NativeCaller): Invocation {
  if (caller.source.harness !== "cc" || !text(caller.invocation?.toolCallId)) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Presenting questions requires a trusted native invocation.")
  return { toolCallId: caller.invocation.toolCallId, invocationId: caller.invocation.toolCallId, ...(caller.invocation.messageId ? { messageId: caller.invocation.messageId } : {}) }
}

function projectReceipt(value: unknown): UserQuestionsReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  const receipt = value as Record<string, unknown>
  if (!text(receipt.form_id) || receipt.status !== "presented") throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  return { form_id: receipt.form_id, status: "presented" }
}

/** Bound both the transport duration and its small acknowledgment body. */
async function readReply(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing acknowledgment")
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 16 * 1024) { await reader.cancel(); throw new Error("Oversized acknowledgment") }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
}

/** Admission and attachment are authorized by the App, never domain enrollment.
 * This call returns after presentation, not after the user answers the form. */
export async function presentQuestionsNativeCaller(caller: NativeCaller, input: unknown, connectionFile: string, invocation: Invocation, signal?: AbortSignal): Promise<UserQuestionsReceipt> {
  const args = parsePresentQuestionsInput(input), source = normalizeNativeSource(caller.source)
  if (source.authorityId !== caller.authorityId || !text(caller.nativeId) || !isAbsolute(caller.cwd) || !text(caller.cwd) || !text(invocation.toolCallId) || !text(invocation.invocationId) || invocation.messageId !== undefined && !text(invocation.messageId) || invocation.wrapper !== undefined && invocation.wrapper !== "execute") throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Incomplete or changed native question form caller.")
  if (invocation.toolCallId !== caller.invocation?.toolCallId || invocation.messageId !== caller.invocation?.messageId || (source.descriptor.harness === "cc" ? invocation.invocationId !== invocation.toolCallId || invocation.wrapper !== undefined : !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(invocation.invocationId))) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Question form invocation differs from its trusted native callback.")
  const request: NativeUserQuestionsRequest = {
    version: 1,
    caller: { source: source.descriptor, authorityId: source.authorityId, nativeId: caller.nativeId, cwd: caller.cwd },
    invocation: { toolCallId: invocation.toolCallId, invocationId: invocation.invocationId, ...(invocation.messageId ? { messageId: invocation.messageId } : {}), ...(invocation.wrapper ? { wrapper: invocation.wrapper } : {}) },
    input: args,
  }
  let url: URL, token: string
  try {
    if (typeof connectionFile !== "string" || !isAbsolute(connectionFile)) throw new Error()
    const stat = lstatSync(connectionFile)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error()
    const connection = JSON.parse(readFileSync(connectionFile, "utf8"))
    url = new URL(connection.url)
    if (connection.version !== 1 || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/native/handoffs" || url.search || url.hash || url.username || url.password || typeof connection.token !== "string" || !connection.token || !Number.isSafeInteger(connection.pid) || connection.pid < 1) throw new Error()
    process.kill(connection.pid, 0)
    token = connection.token
    url.pathname = "/native/user-questions"
  } catch { throw new DomainError("UNAVAILABLE", "Configure a valid private local App native handoff connection file for question forms.") }
  const timeout = AbortSignal.timeout(20000), transportSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response, result: unknown
  try {
    response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(request), signal: transportSignal })
    result = await readReply(response)
  } catch { throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT) }
  if (!response.ok) {
    const reply = result && typeof result === "object" ? result as Record<string, unknown> : {}
    if (response.status >= 500) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
    const label = typeof reply.code === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(reply.code) ? ` [${reply.code}]` : ""
    throw new DomainError("UNAVAILABLE", `App question form request rejected (HTTP ${response.status})${label}: ${typeof reply.error === "string" ? reply.error.slice(0, 4000) : "Presenting questions is unavailable for this conversation."}`)
  }
  return projectReceipt(result)
}
