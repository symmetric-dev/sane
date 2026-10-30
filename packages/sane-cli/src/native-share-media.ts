import { lstatSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DomainError, normalizeNativeSource } from "../../sane-core/src/server.ts"
import { nativeRuntimeHeaders, type NativeCaller } from "./native-caller.ts"
import { MEDIA_SHARE_LIMITS, parseMediaShareInput, type MediaShareReceipt, type NativeMediaShareRequest } from "./native-share-media-contract.ts"

type Invocation = NativeMediaShareRequest["invocation"]
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)
const UNKNOWN_ACKNOWLEDGMENT = "App media share transport was interrupted or returned an invalid reply. Media share acknowledgment is unknown: the App may have saved the frozen snapshot. Inspect this conversation before sharing again; a new tool invocation creates a distinct share. No automatic retry was attempted."

/** Only Claude's consumed hook binding may supply its native invocation ID. */
export function claudeMediaShareInvocation(caller: NativeCaller): Invocation {
  if (caller.source.harness !== "cc" || !text(caller.invocation?.toolCallId)) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Media sharing requires a trusted native invocation.")
  return { toolCallId: caller.invocation.toolCallId, invocationId: caller.invocation.toolCallId, ...(caller.invocation.messageId ? { messageId: caller.invocation.messageId } : {}) }
}

/** Project only the compact receipt, never binary content or internal metadata. */
function projectReceipt(value: unknown, input: NativeMediaShareRequest["input"]): MediaShareReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  const receipt = value as Record<string, unknown>
  if (receipt.type !== "sane.media-share" || receipt.version !== 1 || !text(receipt.shareId) || !Array.isArray(receipt.media) || receipt.media.length !== input.media.length || receipt.media.some((item, index) => !item || typeof item !== "object" || Array.isArray(item) || item.path !== input.media[index]!.path)) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  return { type: "sane.media-share", version: 1, shareId: receipt.shareId, media: input.media.map(({ path }) => ({ path })) }
}

/** App admission, checkout confinement (including protected .sane paths), byte
 * validation, and frozen snapshot persistence are server-side, not enrollment. */
export async function shareMediaNativeCaller(caller: NativeCaller, input: unknown, connectionFile: string, invocation: Invocation, signal?: AbortSignal): Promise<MediaShareReceipt> {
  const args = parseMediaShareInput(input), source = normalizeNativeSource(caller.source)
  if (source.authorityId !== caller.authorityId || !text(caller.nativeId) || !isAbsolute(caller.cwd) || !text(caller.cwd) || !text(invocation.toolCallId) || !text(invocation.invocationId) || invocation.messageId !== undefined && !text(invocation.messageId) || invocation.wrapper !== undefined && invocation.wrapper !== "execute") throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Incomplete or changed native media share caller.")
  if (invocation.toolCallId !== caller.invocation?.toolCallId || invocation.messageId !== caller.invocation?.messageId || (source.descriptor.harness === "cc" || source.descriptor.harness === "gk" ? invocation.invocationId !== invocation.toolCallId || invocation.wrapper !== undefined : !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(invocation.invocationId))) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Media share invocation differs from its trusted native callback.")
  const request: NativeMediaShareRequest = {
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
    url.pathname = "/native/media-shares"
  } catch { throw new DomainError("UNAVAILABLE", "Configure a valid private local App native handoff connection file for media sharing.") }
  // Allow the bounded binary capture plus native-evidence reads to finish;
  // the App listener retains finite 60-second inactivity headroom.
  const timeout = AbortSignal.timeout(MEDIA_SHARE_LIMITS.captureMs + 20000), transportSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response, result: unknown
  try {
    response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...nativeRuntimeHeaders(caller) }, body: JSON.stringify(request), signal: transportSignal })
    result = await response.json()
  } catch { throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT) }
  if (!response.ok) {
    const reply = result && typeof result === "object" ? result as Record<string, unknown> : {}
    const label = typeof reply.code === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(reply.code) ? ` [${reply.code}]` : ""
    // A failed durable commit can return 5xx after the rename reached disk.
    // An HTTP response is not proof that no snapshot was saved.
    if (response.status >= 500) throw new DomainError("UNAVAILABLE", `${UNKNOWN_ACKNOWLEDGMENT} The App returned HTTP ${response.status}${label}.`)
    throw new DomainError("UNAVAILABLE", `App media share request rejected (HTTP ${response.status})${label}: ${typeof reply.error === "string" ? reply.error.slice(0, 4000) : "Media sharing is unavailable for this conversation."}`)
  }
  return projectReceipt(result, args)
}
