import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { handoffInput, normalizeNativeSource } from "../../sane-core/src/server.ts"
import type { GrokSourceDescriptor } from "../../sane-core/src/contracts.ts"
import type { NativeCaller } from "./native-caller.ts"
import { nativeWorkerInput, nativeWorkerOperations } from "./native-worker-contract.ts"
import { parseCodeShareInput } from "./native-share-code-contract.ts"
import { parseMediaShareInput } from "./native-share-media-contract.ts"
import { parsePresentQuestionsInput } from "./native-user-questions-contract.ts"
import { nativeBrowserToolNames } from "./native-browser.ts"

export const GROK_RUNTIME_HEADER = "x-sane-grok-runtime"
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v)
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
function fail(): never { throw new Error("Grok native tool requires its original live App runtime binding") }
const knownTools = new Set<string>(["sane_link", "sane_context", "sane_handoff", "sane_handoff_status", "sane_share_code", "sane_share_media", "present_questions_to_user", ...nativeWorkerOperations.map(op => `sane_worker_${op}`), ...nativeBrowserToolNames])

export type GrokRuntimeBindingInput = {
  runId: string; appSessionId: string; nativeSessionId: string; source: GrokSourceDescriptor
  authorityId: string; cwd: string; repository?: string
}
export type GrokRuntimeBinding = GrokRuntimeBindingInput & { version: 1; bindingId: string; secret: string }
/** A private runtime capability paired with a real Grok PreToolUse ID. This is
 * neither provider acceptance nor a native session-persistence receipt. */
export type GrokRuntimeProof = {
  version: 1; bindingId: string; invocationId: string; toolCallId: string
  toolName: string; inputDigest: string; signature: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
  return JSON.stringify(value)
}

/** The worker transport adds requestId and materializes wait's default. Hash the
 * semantic tool input on both sides, without that derived admission key. */
export function grokRuntimeInputDigest(toolName: string, input: unknown): string {
  // The hook is not a generic signing oracle for arbitrary MCP tools/payloads.
  if (!knownTools.has(toolName) || !object(input)) fail()
  let value: unknown = input
  const operation = nativeWorkerOperations.find(op => toolName === `sane_worker_${op}`)
  if (operation && object(value)) {
    const { requestId: _requestId, ...args } = value
    value = nativeWorkerInput(operation, args)
  }
  if (toolName === "sane_handoff") value = handoffInput(value)
  if (toolName === "sane_share_code") value = parseCodeShareInput(value)
  if (toolName === "sane_share_media") value = parseMediaShareInput(value)
  if (toolName === "present_questions_to_user") value = parsePresentQuestionsInput(value)
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function privateDirectory(directory: string, create = false): void {
  if (!isAbsolute(directory)) fail()
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const s = lstatSync(directory)
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0) fail()
}
function bindingPath(directory: string, id: string): string {
  if (!uuid.test(id)) fail()
  privateDirectory(directory)
  return join(directory, `${id}.binding.json`)
}
export function readGrokRuntimeBinding(directory: string, id: string): GrokRuntimeBinding {
  const fd = openSync(bindingPath(directory, id), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0 || s.size > 32_768) fail()
    const value = JSON.parse(readFileSync(fd, "utf8")) as GrokRuntimeBinding
    if (value.version !== 1 || value.bindingId !== id || !/^[a-f0-9]{64}$/.test(value.secret) || !text(value.runId) || !text(value.appSessionId)
      || !text(value.nativeSessionId) || !text(value.cwd) || !isAbsolute(value.cwd) || value.source?.harness !== "gk"
      || normalizeNativeSource(value.source).authorityId !== value.authorityId || value.repository !== undefined && (!text(value.repository) || !isAbsolute(value.repository))) fail()
    return value
  } finally { closeSync(fd) }
}

export function createGrokRuntimeBinding(directory: string, input: GrokRuntimeBindingInput): { binding: GrokRuntimeBinding; remove: () => void } {
  privateDirectory(directory, true)
  const binding: GrokRuntimeBinding = { ...structuredClone(input), version: 1, bindingId: randomUUID(), secret: randomBytes(32).toString("hex") }
  const path = bindingPath(directory, binding.bindingId)
  writeFileSync(path, JSON.stringify(binding), { flag: "wx", mode: 0o600 })
  try { readGrokRuntimeBinding(directory, binding.bindingId) } catch (error) { unlinkSync(path); throw error }
  return { binding, remove: () => { try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error } } }
}

const signed = ({ signature: _signature, ...proof }: GrokRuntimeProof) => canonical(proof)

/** Called only by our Grok hook process, using documented camelCase fields. A
 * native subagent must not impersonate its root App session through inherited MCP. */
export function issueGrokRuntimeProof(directory: string, bindingId: string, event: unknown): Record<string, unknown> {
  const binding = readGrokRuntimeBinding(directory, bindingId)
  if (!object(event) || event.hookEventName !== "pre_tool_use" || event.sessionId !== binding.nativeSessionId
    || process.env.GROK_SESSION_ID !== binding.nativeSessionId || event.cwd !== binding.cwd || event.toolInputTruncated !== false
    || !text(event.toolUseId) || !text(event.toolName) || !event.toolName.startsWith("sane__") || !object(event.toolInput)) fail()
  // Grok matches hooks on the qualified MCP name, but use_tool retains its
  // dispatcher envelope. Sign/rewrite the nested arguments without changing
  // the selected tool or placing provenance outside the MCP payload.
  const wrapped = Object.hasOwn(event.toolInput, "tool_name") && Object.hasOwn(event.toolInput, "tool_input")
  if (wrapped && event.toolInput.tool_name !== event.toolName) fail()
  const args = wrapped ? event.toolInput.tool_input : event.toolInput
  if (!object(args)) fail()
  if ("_saneGrok" in args) throw new Error("Leave _saneGrok absent; Grok supplies native invocation provenance")
  const toolName = event.toolName.slice("sane__".length)
  const proof: GrokRuntimeProof = { version: 1, bindingId, invocationId: randomUUID(), toolCallId: event.toolUseId,
    toolName, inputDigest: grokRuntimeInputDigest(toolName, args), signature: "" }
  proof.signature = createHmac("sha256", binding.secret).update(signed(proof)).digest("hex")
  const updatedInput = { ...args, _saneGrok: Buffer.from(JSON.stringify(proof)).toString("base64url") }
  return wrapped ? { ...event.toolInput, tool_input: updatedInput } : updatedInput
}

export function parseGrokRuntimeProof(value: unknown): GrokRuntimeProof {
  if (typeof value === "string" && value.length <= 16_384) {
    try { value = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) } catch { fail() }
  }
  if (!object(value) || Object.keys(value).sort().join(",") !== "bindingId,inputDigest,invocationId,signature,toolCallId,toolName,version"
    || value.version !== 1 || typeof value.bindingId !== "string" || !uuid.test(value.bindingId) || typeof value.invocationId !== "string" || !uuid.test(value.invocationId)
    || !text(value.toolCallId) || !text(value.toolName) || !knownTools.has(value.toolName) || typeof value.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.inputDigest)
    || typeof value.signature !== "string" || !/^[a-f0-9]{64}$/.test(value.signature)) fail()
  return value as unknown as GrokRuntimeProof
}

/** Bridge must ALSO resolve and match the current live owner, admission, source,
 * runId and App session. A matching file alone never grants App-only enrollment.
 * `caller` accepts either a native envelope (nativeId) or an App source
 * (nativeSessionId); source/cwd, when present, must match exactly. */
export function verifyGrokRuntimeProof(input: {
  bindingDirectory: string; proof: unknown
  caller: { authorityId: string; nativeId?: string; nativeSessionId?: string; cwd?: string; source?: unknown }
  invocation?: { toolCallId: string; invocationId?: string; messageId?: string; wrapper?: unknown }
  toolName?: string; input?: unknown
}): Omit<GrokRuntimeBinding, "secret"> & { proof: GrokRuntimeProof } {
  const proof = parseGrokRuntimeProof(input.proof), binding = readGrokRuntimeBinding(input.bindingDirectory, proof.bindingId)
  const expected = createHmac("sha256", binding.secret).update(signed(proof)).digest()
  if (!timingSafeEqual(expected, Buffer.from(proof.signature, "hex")) || input.caller.authorityId !== binding.authorityId
    || (input.caller.nativeId ?? input.caller.nativeSessionId) !== binding.nativeSessionId
    || input.caller.cwd !== undefined && input.caller.cwd !== binding.cwd
    || input.caller.source !== undefined && !isDeepStrictEqual(input.caller.source, binding.source)
    || input.toolName !== undefined && input.toolName !== proof.toolName
    || input.invocation && (input.invocation.toolCallId !== proof.toolCallId || input.invocation.invocationId !== undefined && input.invocation.invocationId !== proof.toolCallId || input.invocation.messageId !== undefined || input.invocation.wrapper !== undefined)
    || input.input !== undefined && grokRuntimeInputDigest(proof.toolName, input.input) !== proof.inputDigest) fail()
  const { secret: _secret, ...publicBinding } = binding
  return { ...publicBinding, proof }
}

export function consumeGrokRuntimeInvocation(directory: string, bindingId: string, toolName: string, input: unknown): {
  caller: NativeCaller; input: Record<string, unknown>; invocation: { toolCallId: string; invocationId: string }
} {
  if (!object(input)) fail()
  const { _saneGrok, ...args } = input, binding = readGrokRuntimeBinding(directory, bindingId)
  const verified = verifyGrokRuntimeProof({ bindingDirectory: directory, proof: _saneGrok, caller: { authorityId: binding.authorityId, nativeId: binding.nativeSessionId }, toolName, input: args })
  if (verified.bindingId !== bindingId || process.env.GROK_SESSION_ID !== binding.nativeSessionId) fail()
  // The same hook capability can cross the MCP boundary once, never be reused
  // for a second tool execution. App admission recovery still uses its receipt.
  writeFileSync(join(directory, `${bindingId}.${verified.proof.invocationId}.used`), "", { flag: "wx", mode: 0o600 })
  // Storage anchors use the genuine native ID. The random signed invocationId
  // above is private one-use proof bookkeeping, not a fabricated native ID.
  const invocation = { toolCallId: verified.proof.toolCallId, invocationId: verified.proof.toolCallId }
  return { input: args, invocation, caller: { source: binding.source, authorityId: binding.authorityId, nativeId: binding.nativeSessionId,
    cwd: binding.cwd, ancestors: [], correlationId: `grok:${binding.runId}:${verified.proof.toolCallId}`, invocation: { toolCallId: invocation.toolCallId },
    grokRuntimeProof: Buffer.from(JSON.stringify(verified.proof)).toString("base64url") } }
}
