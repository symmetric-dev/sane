import { lstatSync, readFileSync } from "node:fs"
import { isAbsolute } from "node:path"
import { DomainError, normalizeNativeSource } from "../../sane-core/src/server.ts"
import { nativeRuntimeHeaders, type NativeCaller } from "./native-caller.ts"
import { CODE_SHARE_LIMITS, codeShareInputSnippets, codeShareSnippetRange, isInlineCodeShareSnippet, parseCodeShareInput, type CodeSharePageInput, type CodeSharePageRange, type CodeShareReceipt, type NativeCodeShareRequest } from "./native-share-code-contract.ts"

type Invocation = NativeCodeShareRequest["invocation"]
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)
const UNKNOWN_ACKNOWLEDGMENT = "App code share transport was interrupted or returned an invalid reply. Code share acknowledgment is unknown: the App may have saved the frozen snapshot. Inspect this conversation before sharing again; a new tool invocation creates a distinct share. No automatic retry was attempted."

/** Only Claude's consumed hook binding may use its native tool ID as invocation ID.
 * OpenCode allocates a separate UUID per callback, including Code Mode inner calls. */
export function claudeCodeShareInvocation(caller: NativeCaller): Invocation {
  if (caller.source.harness !== "cc" || !text(caller.invocation?.toolCallId)) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Code sharing requires a trusted native invocation.")
  return { toolCallId: caller.invocation.toolCallId, invocationId: caller.invocation.toolCallId, ...(caller.invocation.messageId ? { messageId: caller.invocation.messageId } : {}) }
}

/** The App resolves omitted file boundaries. Verify all supplied boundaries and
 * project only bounded, concrete ranges, without reading the live file again. */
function projectRange(value: unknown, input: CodeSharePageInput): CodeSharePageRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  const range = value as Record<string, unknown>
  if (isInlineCodeShareSnippet(input)) {
    const expected = codeShareSnippetRange(input)
    if (Object.entries(expected).some(([key, value]) => range[key] !== value)) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
    return expected
  }
  const { startLine, endLine } = range
  if (range.kind !== undefined || range.path !== input.path
    || typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine !== (input.startLine ?? 1)
    || typeof endLine !== "number" || !Number.isSafeInteger(endLine) || endLine < startLine || endLine - startLine + 1 > CODE_SHARE_LIMITS.lines
    || input.endLine !== undefined && endLine !== input.endLine
    || input.highlights?.some(highlight => highlight.startLine < startLine || highlight.endLine > endLine)) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  return { path: input.path, startLine, endLine }
}

/** Project only the compact receipt; source text and internal project/session fields
 * never become tool output. A successful but invalid reply is an unknown acknowledgment. */
function projectReceipt(value: unknown, input: NativeCodeShareRequest["input"]): CodeShareReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  const receipt = value as Record<string, unknown>
  if (receipt.type !== "sane.code-share" || !text(receipt.shareId)) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  if ("snippets" in input) {
    const pages = codeShareInputSnippets(input), version = pages.some(isInlineCodeShareSnippet) ? 3 : 2
    if (receipt.version !== version || !Array.isArray(receipt.snippets) || receipt.snippets.length !== pages.length) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
    const received = receipt.snippets
    const ranges = pages.map((page, index) => projectRange(received[index], page))
    if (version === 3) return { type: "sane.code-share", version: 3, shareId: receipt.shareId, snippets: ranges }
    return { type: "sane.code-share", version: 2, shareId: receipt.shareId, snippets: ranges.flatMap(snippet => "path" in snippet ? [{ path: snippet.path, startLine: snippet.startLine, endLine: snippet.endLine }] : []) }
  }
  if (receipt.version !== 1) throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT)
  const range = projectRange(receipt, input)
  return { type: "sane.code-share", version: 1, shareId: receipt.shareId, path: input.path, startLine: range.startLine, endLine: range.endLine }
}

/** App admission, checkout confinement, and snapshot persistence are server-side.
 * Deliberately does not open a repository domain or infer worker operation identity. */
export async function shareCodeNativeCaller(caller: NativeCaller, input: unknown, connectionFile: string, invocation: Invocation, signal?: AbortSignal): Promise<CodeShareReceipt> {
  const args = parseCodeShareInput(input), source = normalizeNativeSource(caller.source)
  if (source.authorityId !== caller.authorityId || !text(caller.nativeId) || !isAbsolute(caller.cwd) || !text(caller.cwd) || !text(invocation.toolCallId) || !text(invocation.invocationId) || invocation.messageId !== undefined && !text(invocation.messageId) || invocation.wrapper !== undefined && invocation.wrapper !== "execute") throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Incomplete or changed native code share caller.")
  if (invocation.toolCallId !== caller.invocation?.toolCallId || invocation.messageId !== caller.invocation?.messageId || (source.descriptor.harness === "cc" || source.descriptor.harness === "gk" ? invocation.invocationId !== invocation.toolCallId || invocation.wrapper !== undefined : !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(invocation.invocationId))) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Code share invocation differs from its trusted native callback.")
  const request: NativeCodeShareRequest = {
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
    url.pathname = "/native/code-shares"
  } catch { throw new DomainError("UNAVAILABLE", "Configure a valid private local App native handoff connection file for code sharing.") }
  const timeout = AbortSignal.timeout(20000), transportSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response, result: unknown
  try {
    response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...nativeRuntimeHeaders(caller) }, body: JSON.stringify(request), signal: transportSignal })
    result = await response.json()
  } catch { throw new DomainError("UNAVAILABLE", UNKNOWN_ACKNOWLEDGMENT) }
  if (!response.ok) {
    const reply = result && typeof result === "object" ? result as Record<string, unknown> : {}
    const label = typeof reply.code === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(reply.code) ? ` [${reply.code}]` : ""
    throw new DomainError("UNAVAILABLE", `App code share request rejected (HTTP ${response.status})${label}: ${typeof reply.error === "string" ? reply.error.slice(0, 4000) : "Code sharing is unavailable for this conversation."}`)
  }
  return projectReceipt(result, args)
}
