import { Service } from "@opencode/client/service"
import { OpenCode } from "@opencode/client"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import type { NativeWorkerInvocation, NativeWorkerOperation } from "./native-worker-contract.ts"
import { normalizeNativeSource, DomainError, discoverRepository } from "../../sane-core/src/server.ts"
import type { NativeCaller } from "./native-caller.ts"

type Session = { id: string; parentID?: string; location?: { directory?: string } }
export interface OpenCodeCallerContext { session: { get(input: { sessionID: string }): Promise<Session> } }
export interface OpenCodeToolCaller { sessionID: string; messageID: string; id: string; agent: string }

/** Installed V2 shares execute's context ID with every Code Mode inner call.
 * Hooks establish wrapper provenance; only the registered SANE handler chooses
 * operation. Allocate synchronously once per callback, before qualification. */
export class OpenCodeWorkerInvocations {
  private activeExecute = new Set<string>()
  private key(tool: OpenCodeToolCaller) { return JSON.stringify([tool.sessionID, tool.messageID, tool.id, tool.agent]) }
  before(event: OpenCodeToolCaller & { tool: string }) { if (event.tool === "execute") this.activeExecute.add(this.key(event)) }
  after(event: OpenCodeToolCaller & { tool: string }) { if (event.tool === "execute") this.activeExecute.delete(this.key(event)) }
  clear() { this.activeExecute.clear() }
  callback(tool: OpenCodeToolCaller, operation: NativeWorkerOperation): NativeWorkerInvocation {
    return { toolCallId: tool.id, messageId: tool.messageID, opencode: { invocationId: randomUUID(), operation, ...(this.activeExecute.has(this.key(tool)) ? { wrapper: "execute" as const } : {}) } }
  }
}

export async function qualifyOpenCodeCaller(registrationFile: string, ctx: OpenCodeCallerContext, tool: OpenCodeToolCaller): Promise<NativeCaller> {
  try {
    if (![tool.sessionID, tool.messageID, tool.id].every(value => typeof value === "string" && value.length > 0)) throw new Error()
    const source = normalizeNativeSource({ version: 1, harness: "oc", kind: "local-registration", registrationFile })
    const before = readFileSync(registrationFile, "utf8"), registration = JSON.parse(before)
    const endpoint = await Service.discover({ file: registrationFile })
    if (!endpoint || registration.pid !== process.pid || registration.url !== endpoint.url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint.url).hostname)) throw new Error()
    const selected = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const get = async (sessionID: string) => {
      const [local, remote] = await Promise.all([ctx.session.get({ sessionID }), selected.session.get({ sessionID }, { signal: AbortSignal.timeout(10000) })])
      if (local.id !== sessionID || remote.id !== sessionID || !local.location?.directory || local.location.directory !== remote.location?.directory || (local.parentID ?? null) !== (remote.parentID ?? null)) throw new Error()
      return local
    }
    const session = await get(tool.sessionID), cwd = session.location!.directory!
    const repository = discoverRepository(cwd)
    const ancestors: NativeCaller["ancestors"] = [], visited = new Set([session.id])
    let cursor = session.parentID
    while (cursor) {
      if (visited.has(cursor) || visited.size >= 64) throw new Error()
      visited.add(cursor)
      const parent = await get(cursor), directory = parent.location!.directory!
      if (discoverRepository(directory).commonDir !== repository.commonDir) break
      ancestors.push({ nativeId: cursor, cwd: directory })
      cursor = parent.parentID
    }
    if (readFileSync(registrationFile, "utf8") !== before) throw new Error()
    return { source: source.descriptor, authorityId: source.authorityId, nativeId: session.id, cwd, ancestors, correlationId: `oc:${tool.messageID}:${tool.id}`, invocation: { toolCallId: tool.id, messageId: tool.messageID }, agent: tool.agent }
  } catch { throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Cannot qualify caller against the selected managed-local OpenCode registration.") }
}
