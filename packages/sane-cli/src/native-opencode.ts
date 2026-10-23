import { Service } from "@opencode/client/service"
import { OpenCode } from "@opencode/client"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import type { NativeWorkerInvocation, NativeWorkerOperation } from "./native-worker-contract.ts"
import type { NativeCodeShareRequest } from "./native-share-code-contract.ts"
import type { NativeUserQuestionsRequest } from "./native-user-questions-contract.ts"
import { normalizeNativeSource, DomainError, discoverRepository } from "../../sane-core/src/server.ts"
import type { NativeCaller } from "./native-caller.ts"

type Session = { id: string; parentID?: string; location?: { directory?: string } }
export interface OpenCodeCallerContext { session: { get(input: { sessionID: string }): Promise<Session> } }
export interface OpenCodeToolCaller { sessionID: string; messageID: string; id: string; agent: string }
export { assertOpenCodeCodeSharePermissions } from "./native-opencode-permissions.ts"

/** Installed V2 shares execute's context ID with every Code Mode inner call.
 * Hooks establish wrapper provenance; only the registered SANE handler chooses
 * operation. Allocate synchronously once per callback, before qualification. */
export class OpenCodeWorkerInvocations {
  private activeExecute = new Set<string>()
  private key(tool: OpenCodeToolCaller) { return JSON.stringify([tool.sessionID, tool.messageID, tool.id, tool.agent]) }
  before(event: OpenCodeToolCaller & { tool: string }) { if (event.tool === "execute") this.activeExecute.add(this.key(event)) }
  after(event: OpenCodeToolCaller & { tool: string }) { if (event.tool === "execute") this.activeExecute.delete(this.key(event)) }
  clear() { this.activeExecute.clear() }
  private appCallback(tool: OpenCodeToolCaller): NativeCodeShareRequest["invocation"] {
    return { toolCallId: tool.id, messageId: tool.messageID, invocationId: randomUUID(), ...(this.activeExecute.has(this.key(tool)) ? { wrapper: "execute" as const } : {}) }
  }
  codeShareCallback(tool: OpenCodeToolCaller): NativeCodeShareRequest["invocation"] { return this.appCallback(tool) }
  userQuestionsCallback(tool: OpenCodeToolCaller): NativeUserQuestionsRequest["invocation"] { return this.appCallback(tool) }
  callback(tool: OpenCodeToolCaller, operation: NativeWorkerOperation): NativeWorkerInvocation {
    return { toolCallId: tool.id, messageId: tool.messageID, opencode: { invocationId: randomUUID(), operation, ...(this.activeExecute.has(this.key(tool)) ? { wrapper: "execute" as const } : {}) } }
  }
}

async function qualifyCaller(registrationFile: string, ctx: OpenCodeCallerContext, tool: OpenCodeToolCaller, repositoryAncestry: boolean): Promise<{ caller: NativeCaller; client: ReturnType<typeof OpenCode.make> }> {
  try {
    if (![tool.sessionID, tool.messageID, tool.id].every(value => typeof value === "string" && value.length > 0)) throw new Error()
    const source = normalizeNativeSource({ version: 1, harness: "oc", kind: "local-registration", registrationFile })
    const before = readFileSync(registrationFile, "utf8"), registration = JSON.parse(before)
    const endpoint = await Service.discover({ file: registrationFile })
    if (!endpoint || registration.pid !== process.pid || registration.url !== endpoint.url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint.url).hostname)) throw new Error()
    const selected = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const get = async (sessionID: string) => {
      const [local, remote] = await Promise.all([ctx.session.get({ sessionID }), selected.session.get({ sessionID }, { signal: AbortSignal.timeout(10000) })])
      if (local.id !== sessionID || remote.id !== sessionID || !local.location?.directory || !isAbsolute(local.location.directory) || local.location.directory.includes("\0") || local.location.directory !== remote.location?.directory || (local.parentID ?? null) !== (remote.parentID ?? null)) throw new Error()
      return local
    }
    const session = await get(tool.sessionID), cwd = session.location!.directory!
    const ancestors: NativeCaller["ancestors"] = [], visited = new Set([session.id])
    if (repositoryAncestry) {
      const repository = discoverRepository(cwd)
      let cursor = session.parentID
      while (cursor) {
        if (visited.has(cursor) || visited.size >= 64) throw new Error()
        visited.add(cursor)
        const parent = await get(cursor), directory = parent.location!.directory!
        if (discoverRepository(directory).commonDir !== repository.commonDir) break
        ancestors.push({ nativeId: cursor, cwd: directory })
        cursor = parent.parentID
      }
    }
    if (readFileSync(registrationFile, "utf8") !== before) throw new Error()
    return { caller: { source: source.descriptor, authorityId: source.authorityId, nativeId: session.id, cwd, ancestors, correlationId: `oc:${tool.messageID}:${tool.id}`, invocation: { toolCallId: tool.id, messageId: tool.messageID }, agent: tool.agent }, client: selected }
  } catch { throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Cannot qualify caller against the selected managed-local OpenCode registration.") }
}

export async function qualifyOpenCodeCaller(registrationFile: string, ctx: OpenCodeCallerContext, tool: OpenCodeToolCaller): Promise<NativeCaller> {
  return (await qualifyCaller(registrationFile, ctx, tool, true)).caller
}

/** App-only chats need native service/session attestation, not domain enrollment
 * or repository ancestry. Retain the authenticated client for the old permission
 * API, separately from caller identity. The App authorizes exact admission. */
export function qualifyOpenCodeAppCaller(registrationFile: string, ctx: OpenCodeCallerContext, tool: OpenCodeToolCaller) {
  return qualifyCaller(registrationFile, ctx, tool, false)
}

/** Question forms have their own native permission, never code-share/read
 * permission. Older installed V2 releases expose create instead of assert;
 * an ask must receive a positive reply for that exact authenticated request. */
export async function assertOpenCodeUserQuestionsPermissions(ctx: { permission: unknown }, tool: OpenCodeToolCaller & { signal?: AbortSignal }, client: ReturnType<typeof OpenCode.make>): Promise<void> {
  type Input = Parameters<typeof client.permission.create>[0]
  const input: Input = {
    sessionID: tool.sessionID, agent: tool.agent,
    source: { type: "tool", messageID: tool.messageID, id: tool.id },
    action: "present_questions_to_user", resources: ["*"], save: ["*"],
  }
  tool.signal?.throwIfAborted()
  const permission = ctx.permission as { assert?: (input: Input, options?: { signal?: AbortSignal }) => Promise<unknown> } | undefined
  if (typeof permission?.assert === "function") { await permission.assert(input, { signal: tool.signal }); return }
  const controller = new AbortController(), id = `per_${randomUUID()}`
  const signal = tool.signal ? AbortSignal.any([tool.signal, controller.signal]) : controller.signal
  const connected = Promise.withResolvers<void>(), replied = Promise.withResolvers<"once" | "always" | "reject">()
  void connected.promise.catch(() => {})
  void replied.promise.catch(() => {})
  const monitor = (async () => {
    for await (const event of client.event.subscribe({ signal })) {
      if (event.type === "server.connected") connected.resolve()
      if (event.type === "permission.replied" && event.data.sessionID === tool.sessionID && event.data.requestID === id) { replied.resolve(event.data.reply); return }
    }
    throw new DomainError("UNAVAILABLE", "OpenCode question form permission approval was interrupted. No form was presented.")
  })()
  void monitor.catch(error => { connected.reject(error); replied.reject(error) })
  const timer = setTimeout(() => controller.abort(), 10000)
  timer.unref?.()
  try {
    await connected.promise
    clearTimeout(timer)
    signal.throwIfAborted()
    const result = await client.permission.create({ ...input, id }, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) })
    if (result.id !== id) throw new DomainError("UNAVAILABLE", "OpenCode returned a different question form permission request. No form was presented.")
    if (result.effect === "allow") return
    if (result.effect !== "ask") throw new DomainError("UNAVAILABLE", "OpenCode denied present_questions_to_user permission. No form was presented.")
    const decision = await replied.promise
    signal.throwIfAborted()
    if (decision !== "once" && decision !== "always") throw new DomainError("UNAVAILABLE", "OpenCode rejected present_questions_to_user permission. No form was presented.")
  } finally {
    clearTimeout(timer)
    controller.abort()
    await monitor.catch(() => {})
    // Never automatically reply: old V2 rejection can affect concurrent asks.
  }
}
