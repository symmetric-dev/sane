import { createHash, randomBytes, randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { DomainError, normalizeNativeSource } from "../../sane-core/src/server.ts"
import type { NativeCaller } from "./native-caller.ts"

export const claudeNativeTools = ["sane_link", "sane_context", "sane_handoff", "sane_handoff_status", "sane_worker_start", "sane_worker_status", "sane_worker_wait", "sane_worker_acknowledge", "sane_worker_cancel", "sane_worker_cancel_all"] as const
type ClaudeTool = typeof claudeNativeTools[number]
function unavailable(): never { throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Claude native caller binding is missing, invalid, expired or already consumed.") }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return unavailable()
  return input as Record<string, unknown>
}
function text(input: unknown): input is string { return typeof input === "string" && input.length > 0 && !/[\u0000-\u001f]/.test(input) }
function canonical(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`
  if (input && typeof input === "object") return `{${Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`
  return JSON.stringify(input)
}
function bindingRoot(root: string): string {
  if (!isAbsolute(root)) return unavailable()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return unavailable()
  return root
}
export function qualifyClaudeHook(profileRoot: string, input: unknown): NativeCaller {
  const hook = object(input)
  if (hook.hook_event_name !== "PreToolUse" || !text(hook.session_id) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(hook.session_id) || !text(hook.cwd) || !isAbsolute(hook.cwd) || !text(hook.tool_use_id)) return unavailable()
  if (hook.agent_id !== undefined) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Claude child agent identity is not a qualified resumable conversation.")
  const source = normalizeNativeSource({ version: 1, harness: "cc", kind: "local-profile", profileRoot })
  return { source: source.descriptor, authorityId: source.authorityId, nativeId: hook.session_id, cwd: hook.cwd, ancestors: [], correlationId: `cc:${text(hook.prompt_id) ? hook.prompt_id : hook.session_id}:${hook.tool_use_id}`, invocation: { toolCallId: hook.tool_use_id }, ...(text(hook.agent_type) ? { agent: hook.agent_type } : {}) }
}
export function issueClaudeInvocation(root: string, profileRoot: string, input: unknown) {
  const hook = object(input)
  const tool = claudeNativeTools.find(name => hook.tool_name === `mcp__sane__${name}`)
  if (!tool) return unavailable()
  const caller = qualifyClaudeHook(profileRoot, hook), body = { ...object(hook.tool_input) }
  delete body._invocation
  const token = randomBytes(32).toString("hex"), key = createHash("sha256").update(token).digest("hex")
  writeFileSync(join(bindingRoot(root), `${key}.json`), JSON.stringify({ version: 1, caller, tool, body: canonical(body), issuedAt: Date.now() }), { flag: "wx", mode: 0o600 })
  return { ...body, _invocation: token }
}
export function consumeClaudeInvocation(root: string, profileRoot: string, tool: ClaudeTool, input: unknown): { caller: NativeCaller; input: Record<string, unknown> } {
  const body = { ...object(input) }, token = body._invocation
  delete body._invocation
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return unavailable()
  const key = createHash("sha256").update(token).digest("hex"), directory = bindingRoot(root)
  const path = join(directory, `${key}.json`), used = join(directory, `${key}.${randomUUID()}.used`)
  let moved = false
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return unavailable()
    renameSync(path, used); moved = true
    const binding = JSON.parse(readFileSync(used, "utf8"))
    const source = normalizeNativeSource({ version: 1, harness: "cc", kind: "local-profile", profileRoot })
    if (binding.version !== 1 || binding.tool !== tool || binding.body !== canonical(body) || !Number.isFinite(binding.issuedAt) || Date.now() - binding.issuedAt > 300000 || binding.issuedAt > Date.now() || binding.caller?.authorityId !== source.authorityId || canonical(binding.caller.source) !== canonical(source.descriptor)) return unavailable()
    return { caller: binding.caller, input: body }
  } catch { return unavailable() } finally { if (moved) unlinkSync(used) }
}
