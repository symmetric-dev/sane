import { randomUUID } from "node:crypto"
import type { OpenCode } from "@opencode/client"
import { DomainError } from "../../sane-core/src/server.ts"
import type { OpenCodeToolCaller } from "./native-opencode.ts"

type Client = ReturnType<typeof OpenCode.make>
type PermissionInput = Parameters<Client["permission"]["create"]>[0]
type PermissionAssertion = { assert?: (input: PermissionInput, options?: { signal?: AbortSignal }) => Promise<unknown> }

/** OC 2.0.26 exposes permission.create on its authenticated client, but not
 * permission.assert on its plugin context. create evaluates the same engine;
 * an ask is NOT authorization until the exact request receives a positive reply. */
async function assertLegacyPermission(client: Client, input: PermissionInput, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController()
  const subscriptionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const id = `per_${randomUUID()}`
  const connected = Promise.withResolvers<void>()
  const replied = Promise.withResolvers<"once" | "always" | "reject">()
  // Both may reject while the other is awaited; observe them immediately.
  void connected.promise.catch(() => {})
  void replied.promise.catch(() => {})
  const monitor = (async () => {
    for await (const event of client.event.subscribe({ signal: subscriptionSignal })) {
      if (event.type === "server.connected") connected.resolve()
      if (event.type === "permission.replied" && event.data.sessionID === input.sessionID && event.data.requestID === id) {
        replied.resolve(event.data.reply)
        return
      }
    }
    throw new DomainError("UNAVAILABLE", "OpenCode permission approval was interrupted or its event connection closed. No code was shared.")
  })()
  void monitor.catch(error => { connected.reject(error); replied.reject(error) })
  const timer = setTimeout(() => controller.abort(), 10000)
  timer.unref?.()
  try {
    // Events are live-only. Wait for the authenticated stream's connection
    // marker BEFORE creating the request, including instant user responses.
    await connected.promise
    clearTimeout(timer)
    subscriptionSignal.throwIfAborted()
    const result = await client.permission.create({ ...input, id }, { signal: AbortSignal.any([subscriptionSignal, AbortSignal.timeout(10000)]) })
    if (result.id !== id) throw new DomainError("UNAVAILABLE", "OpenCode returned a different permission request. No code was shared.")
    if (result.effect === "allow") return
    if (result.effect !== "ask") throw new DomainError("UNAVAILABLE", `OpenCode denied ${input.action} permission for this code share.`)
    const decision = await replied.promise
    subscriptionSignal.throwIfAborted()
    if (decision !== "once" && decision !== "always") throw new DomainError("UNAVAILABLE", `OpenCode rejected ${input.action} permission for this code share.`)
  } finally {
    clearTimeout(timer)
    controller.abort()
    await monitor.catch(() => {})
    // Never submit an automatic permission reply: on these versions rejecting
    // one request can reject unrelated concurrent requests in the same session.
  }
}

/** Prefer the documented current API. The compatibility client must come from
 * the same process/source/session qualification, never from tool arguments. */
export async function assertOpenCodeCodeSharePermissions(ctx: { permission: unknown }, tool: OpenCodeToolCaller & { signal?: AbortSignal }, path: string, legacyClient: Client): Promise<void> {
  const permission = ctx.permission as PermissionAssertion | undefined
  for (const action of ["sane_share_code", "read"]) {
    const input: PermissionInput = {
      sessionID: tool.sessionID, agent: tool.agent,
      source: { type: "tool", messageID: tool.messageID, id: tool.id },
      action, resources: [path], save: [path],
    }
    tool.signal?.throwIfAborted()
    if (typeof permission?.assert === "function") await permission.assert(input, { signal: tool.signal })
    else await assertLegacyPermission(legacyClient, input, tool.signal)
  }
}
