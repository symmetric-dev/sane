import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { Rpc } from "@opencode/plugin/rpc"
import { createHash } from "node:crypto"
import { decodeCompactionContextTransport, type CompactionContextTransport } from "../../../packages/sane-app/shared/compaction-context-contract.ts"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
type Binding = { schema: 1; agent: string; context: CompactionContextTransport }
type RestorationEntry = { offset: number; prefixHash: string; hash: string; text: string }
type RestorationWindow = { schema: 1; checkpoint: string; entries: RestorationEntry[] }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

// Authenticated server RPC, not a model-visible tool. Execution and native
// identity must already have been configured by the owning App.
const CompactionContextRpc = Rpc.define({
  id: "sane-context",
  events: {},
  methods: {
    configure: {
      input: { type: "object", additionalProperties: false, required: ["agent", "context"], properties: {
        agent: { type: "string", minLength: 1 }, readOnly: { type: "boolean" },
        context: { type: "object", additionalProperties: true },
      } },
      output: { type: "object", additionalProperties: false, required: ["sessionID", "transportSha256", "channel"], properties: {
        sessionID: { type: "string" }, transportSha256: { type: "string" }, channel: { const: "user-context" },
      } },
    },
  },
})

/** Native request-boundary restoration covers manual, automatic, background,
 * and provider-native compaction. Recorded USER context is reconstructed at its
 * fixed chronological position, never a system entry or a second inbox turn.
 * Retries/reloads do not append another copy to native history. */
export async function registerCompactionContext(ctx: Context, execution: {
  managed: (sessionID: string) => boolean
  selected: (sessionID: string) => string
}) {
  const bindings = new Map<string, Binding>()
  const prefix = `compaction-context/v1/${encodeURIComponent(ctx.location.directory)}/`
  const bindingPrefix = prefix + "bindings/"
  const key = (id: string) => bindingPrefix + encodeURIComponent(id)
  const validate = (context: CompactionContextTransport) => {
    if (context.message.binding.harnessId !== "opencode" || context.message.binding.cwd !== ctx.location.directory)
      throw new Error("Compaction restoration native location mismatch")
    const transport = context.message.transport
    if (digest(transport.text) !== transport.sha256 || Buffer.byteLength(transport.text, "utf8") !== transport.byteLength)
      throw new Error("Compaction restoration native bytes differ from their hash or length")
  }
  let after: string | undefined
  do {
    const page = await ctx.storage.scan({ prefix: bindingPrefix, ...(after ? { after } : {}) })
    for (const entry of page.entries) {
      const value = entry.value as unknown as Binding
      if (value.schema !== 1 || typeof value.agent !== "string") throw new Error("Invalid stored compaction restoration")
      const context = decodeCompactionContextTransport(value.context)
      validate(context)
      if (entry.key !== key(context.message.binding.nativeSessionId)) throw new Error("Stored compaction restoration native identity mismatch")
      bindings.set(context.message.binding.nativeSessionId, { schema: 1, agent: value.agent, context })
    }
    after = page.next
  } while (after)
  const registration = await ctx.rpc.register(CompactionContextRpc, {
    configure: async (raw, call) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid compaction context configuration")
      const input = raw as { agent: string; context: unknown; readOnly?: boolean }
      if (typeof input.agent !== "string" || !input.agent || input.readOnly !== undefined && typeof input.readOnly !== "boolean")
        throw new Error("Invalid compaction context execution selection")
      const context = decodeCompactionContextTransport(input.context)
      validate(context)
      const id = context.message.binding.nativeSessionId, agent = input.agent
      const current = () => {
        call.signal.throwIfAborted()
        if (execution.selected(id) !== agent) throw new Error("Compaction restoration execution selection changed")
      }
      current()
      const session = await ctx.session.get({ sessionID: id })
      current()
      if (session.id !== id || session.location.directory !== context.message.binding.cwd || session.agent !== agent)
        throw new Error("Compaction restoration requires its exact configured native conversation")
      const binding: Binding = { schema: 1, agent, context }
      if (input.readOnly) {
        if (JSON.stringify(bindings.get(id)) !== JSON.stringify(binding)) throw new Error("Queued restoration requires the original idle-configured context")
      } else {
        await ctx.storage.set(key(id), JSON.parse(JSON.stringify(binding)))
        // Publish only after the complete binding is durable. Never mark an
        // interrupted write as an acknowledged configuration.
        current()
        bindings.set(id, binding)
      }
      return { sessionID: id, transportSha256: context.message.transport.sha256, channel: "user-context" as const }
    },
  })
  const configured = (sessionID: string, agent: string) => {
    const binding = bindings.get(sessionID)
    if (!binding || binding.agent !== agent || execution.selected(sessionID) !== agent)
      throw new Error("SANE compaction restoration is not configured for this native execution; send through the updated App")
    return binding
  }
  const restore = async (event: SessionContext, executionAgent: string) => {
    if (!execution.managed(event.sessionID)) return
    const before = bindings.get(event.sessionID)
    const history = await ctx.session.context({ sessionID: event.sessionID })
    const checkpoint = history.findLast(message => message.type === "compaction" && message.status === "completed")
    if (!checkpoint) return
    // An already-running, un-compacted session can finish after a plugin reload
    // without inventing a restoration binding. Compaction itself still refuses
    // to discard its activation until an updated App configures restoration.
    const binding = configured(event.sessionID, executionAgent)
    if (binding !== before) throw new Error("Compaction restoration changed during native request preparation")
    if (event.messages.some(message => (message.metadata?.saneCompactionRestoration as { checkpoint?: string } | undefined)?.checkpoint === checkpoint.id)) return
    const windowKey = `${prefix}windows/${encodeURIComponent(event.sessionID)}/${encodeURIComponent(checkpoint.id)}`
    const stored = await ctx.storage.get(windowKey)
    const window: RestorationWindow = stored === undefined ? { schema: 1, checkpoint: checkpoint.id, entries: [] } : structuredClone(stored) as unknown as RestorationWindow
    if (!window || window.schema !== 1 || window.checkpoint !== checkpoint.id || !Array.isArray(window.entries) || window.entries.length > 64)
      throw new Error("Invalid native compaction restoration window")
    for (const entry of window.entries) {
      if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || entry.offset > event.messages.length
        || typeof entry.prefixHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.prefixHash)
        || typeof entry.hash !== "string" || typeof entry.text !== "string" || entry.text.length > 256000
        || digest(entry.text) !== entry.hash || digest(JSON.stringify(event.messages.slice(0, entry.offset))) !== entry.prefixHash)
        throw new Error("Native compacted prefix changed; compaction restoration requires a new checkpoint")
      event.messages.splice(entry.offset, 0, { role: "user", content: [{ type: "text", text: entry.text }],
        metadata: { saneCompactionRestoration: { schema: 1, checkpoint: checkpoint.id, hash: entry.hash } } })
    }
    const hash = binding.context.message.transport.sha256
    if (window.entries.at(-1)?.hash !== hash) {
      if (window.entries.length >= 64) throw new Error("Compact again before adding another SANE context restoration version")
      // Append AFTER the complete checkpoint/retained prefix, including any
      // signed thinking, and remember the exact position. Moving a transient
      // restoration to the latest user turn on every call would rewrite prior
      // model input and invalidate reasoning/cache prefixes. A later explicit
      // context revision is another chronological update, never a history edit.
      const entry = { offset: event.messages.length, prefixHash: digest(JSON.stringify(event.messages)),
        hash, text: binding.context.message.transport.text }
      window.entries.push(entry)
      await ctx.storage.set(windowKey, JSON.parse(JSON.stringify(window)))
      event.messages.push({ role: "user", content: [{ type: "text", text: entry.text }],
        metadata: { saneCompactionRestoration: { schema: 1, checkpoint: checkpoint.id, hash } } })
    }
    if (configured(event.sessionID, executionAgent) !== binding) throw new Error("Compaction restoration changed before native model dispatch")
  }
  const compaction = await ctx.session.hook("compaction", async event => {
    if (!execution.managed(event.sessionID)) return
    // The summarizer can have its own utility agent/model. Bind restoration to
    // the conversation's configured execution, not that auxiliary agent name.
    const agent = execution.selected(event.sessionID)
    configured(event.sessionID, agent)
    const session = await ctx.session.get({ sessionID: event.sessionID })
    if (session.agent !== agent || session.location.directory !== ctx.location.directory)
      throw new Error("Compaction restoration native execution selection changed")
    // Subsequent summaries must see the same restored conversation prefix as
    // primary requests, including provider-signed reasoning generated under it.
    await restore(event, agent)
  })
  const request = await ctx.session.hook("context", event => restore(event, event.agent))
  return { dispose: async () => { await request.dispose(); await compaction.dispose(); await registration.dispose(); bindings.clear() } }
}
