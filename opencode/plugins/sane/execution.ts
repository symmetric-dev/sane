import type { Plugin } from "@opencode/plugin"
import type { OpenCodeExecutionConfiguration as Configuration, OperationModel, OperationPermission } from "../../../packages/sane-app/src/canonical-agent-operations.ts"
import { SaneExecution } from "./execution-rpc.ts"

type Context = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]
type Binding = { schema: 2; state: "pending" | "ready"; configuration: Configuration; legacyRecovered?: boolean }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const ruleEqual = (a: OperationPermission, b: OperationPermission) => a.action === b.action && a.resource === b.resource && a.effect === b.effect
const prefix = (actual: readonly OperationPermission[], expected: readonly OperationPermission[]) => actual.length >= expected.length && expected.every((rule, i) => ruleEqual(actual[i]!, rule))
const permissionRules = (value: unknown): value is OperationPermission[] => Array.isArray(value) && value.every(rule => rule && typeof rule.action === "string" && typeof rule.resource === "string" && ["allow", "ask", "deny"].includes(rule.effect))

/** Normalize legacy bindings and retry payloads without changing generated IDs
 * or durable authored snapshots. Read-only recovery accepts the same policy
 * rendered without the retired sampling control. */
function withoutTemperature(input: Configuration): Configuration {
  const { temperature: _temperature, nativeChildren, ...configuration } = input
  return { ...configuration, nativeChildren: nativeChildren.map(({ temperature: _temperature, ...child }) => child) }
}

/** OC 2.0.26 materializes an omitted variant as `default`. Never accept another
 * provider/model or normalize an explicitly requested non-default variant. */
export const executionModelMatches = (actual: OperationModel | undefined, expected: OperationModel | undefined) =>
  actual?.providerID === expected?.providerID && actual?.id === expected?.id && (actual?.variant ?? "default") === (expected?.variant ?? "default")

/** Restore OC V2's ordered base policy at the runtime boundary, not in durable
 * authored snapshots (or generated IDs). Replacing draft.permissions with only
 * authored restrictions otherwise makes every unmatched normal/MCP action ask.
 * https://opencode.ai/v2/docs/permissions#defaults
 * Do not copy build/global policy: canonical agents must remain role-isolated. */
function executionPermissions(authored: readonly OperationPermission[]): OperationPermission[] {
  return [
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    ...structuredClone(authored),
    { action: "browser", resource: "*", effect: "deny" },
  ]
}

/** Exact runtime baseline + authored policy + browser restriction. Only duplicate
 * native browser denies may follow; missing baseline or arbitrary suffixes fail. */
export function executionPermissionsMatch(actual: readonly OperationPermission[], expected: readonly OperationPermission[]) {
  const rendered = executionPermissions(expected)
  return prefix(actual, rendered) && actual.slice(rendered.length).every(rule => rule.action === "browser" && rule.resource === "*" && rule.effect === "deny")
}

function validate(input: Configuration, directory: string) {
  if (!input || typeof input.sessionID !== "string" || !input.sessionID || input.directory !== directory) throw new Error("Canonical execution location mismatch")
  // OC 2.0.26 rejects RPC JSON-schema regex patterns; enforce before mutation.
  if (!/^sane-execution-[a-f0-9]{64}$/.test(input.executionAgent) || input.agent !== input.executionAgent) throw new Error("Invalid canonical execution-agent identifier")
  if (!Array.isArray(input.nativeChildren) || input.nativeChildren.some(child => !/^sane-private-[a-f0-9]{64}-[a-z][a-z-]*$/.test(child.id)
    || !/^sane\/worker\/[a-z][a-z-]*$/.test(child.canonicalId))) throw new Error("Invalid canonical native-child identifier")
  if (!permissionRules(input.permissions) || input.nativeChildren.some(child => !permissionRules(child.permissions) || typeof child.system !== "string" || !child.system.trim())) throw new Error("Invalid canonical execution policy")
  const ids = new Set(input.nativeChildren.map(child => child.id))
  if (ids.size !== input.nativeChildren.length || [...input.directChildren, ...input.nativeChildren.flatMap(child => child.children)].some(id => !ids.has(id))
    || Object.entries(input.delegation).some(([name, id]) => !input.nativeChildren.some(child => child.id === id && child.canonicalId === name))) throw new Error("Invalid canonical delegation graph")
}

/** Root and child policy belongs to generated agent definitions BEFORE OC's
 * registry snapshot/tool inventory. Session permissions remain genuine user
 * overrides and are never rewritten by a context hook.
 * Storage is plugin-private durable binding state, not a published agent file.
 * Ready IDs restore at setup; configure/prompt admission restores precedence
 * before inventory. Pending records block until idle configure retries the
 * idempotent selection/readback protocol. A bare native continuation after reload
 * still fails closed if it bypasses those early boundaries and readback differs.
 * OC 2.0.26: agent.update creates IDs; native subagent resolves hidden IDs and
 * establishes parentID. Native execution owns child cancellation and depth limits. */
export async function registerExecutionOperations(ctx: Context) {
  const bindings = new Map<string, Binding>()
  const active = new Map<string, Configuration>()
  const configuring = new Set<string>()
  const storagePrefix = `canonical-execution/v2/${encodeURIComponent(ctx.location.directory)}/`
  const key = (id: string) => storagePrefix + encodeURIComponent(id)
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(ctx.app.version)
  const supported = !!version && (Number(version[1]) > 2 || Number(version[1]) === 2 && (Number(version[2]) > 0 || Number(version[3]) >= 26))
    && typeof ctx.agent.transform === "function" && typeof ctx.agent.reload === "function" && typeof ctx.storage?.scan === "function" && typeof ctx.storage?.set === "function"
  if (supported) {
    let after: string | undefined
    do {
      const page = await ctx.storage.scan({ prefix: storagePrefix, ...(after ? { after } : {}) })
      for (const entry of page.entries) {
        const binding = entry.value as unknown as Binding
        if (binding.schema !== 2 || !["ready", "pending"].includes(binding.state)) throw new Error("Invalid canonical execution storage binding")
        validate(binding.configuration, ctx.location.directory)
        binding.configuration = withoutTemperature(binding.configuration)
        if (entry.key !== key(binding.configuration.sessionID)) throw new Error("Canonical execution storage identity mismatch")
        bindings.set(binding.configuration.sessionID, binding)
        if (binding.state === "ready") active.set(binding.configuration.sessionID, binding.configuration)
      }
      after = page.next
    } while (after)
  }
  const defineAgents: Parameters<Context["agent"]["transform"]>[0] = editor => {
    for (const configuration of active.values()) {
      const definitions = [{ id: configuration.executionAgent, description: "App-managed execution", permissions: configuration.permissions, model: configuration.model, mode: "primary" as const },
        ...configuration.nativeChildren.map(child => ({ ...child, mode: "subagent" as const }))]
      for (const definition of definitions) {
        if (editor.get(definition.id)) throw new Error(`Canonical execution alias collision: ${definition.id}`)
        editor.update(definition.id, draft => {
          draft.description = definition.description
          draft.mode = definition.mode
          draft.hidden = true
          draft.system = ""
          // Native BrowserConnection normally appends this restriction after
          // setup. Late-created agents must retain it too; browser connections
          // grant access using genuine session overrides.
          draft.permissions = executionPermissions(definition.permissions)
          draft.model = definition.model as typeof draft.model
        })
      }
    }
  }
  // ConfigAgentPlugin is a native *post* plugin in OC 2.0.26: setup-time
  // registrations run before it, regardless of the configured plugin order.
  // Register at the configure boundary (after location activation), so canonical
  // agents are created after global config has been applied to ordinary agents.
  // Restore IDs immediately for native session selection. Re-register once at
  // configure or prompt admission, after native post plugins, BEFORE inventory.
  // Never repair policy from the late context hook: inventory is already captured.
  let agents = supported ? await ctx.agent.transform(defineAgents) : undefined
  let agentsPromoted = false
  let installingAgents: Promise<void> | undefined
  const ensureAgents = async () => {
    if (agentsPromoted) return
    if (!installingAgents) installingAgents = (async () => {
      await agents?.dispose()
      agents = await ctx.agent.transform(defineAgents)
      agentsPromoted = true
    })().finally(() => { installingAgents = undefined })
    await installingAgents
  }

  const verifyDefinitions = async (input: Configuration) => {
    for (const definition of [{ id: input.executionAgent, mode: "primary", permissions: input.permissions, model: input.model }, ...input.nativeChildren.map(child => ({ ...child, mode: "subagent" }))]) {
      const actual = (await ctx.agent.get({ agentID: definition.id })).data
      if (!executionPermissionsMatch(actual.permissions, definition.permissions)) {
        // Do not accept arbitrary native suffixes: configuration rules appended
        // after this transform can override the canonical role's denies.
        throw new Error("Canonical in-memory agent verification failed: permissions differ; OpenCode configuration permissions may be appended after the canonical policy")
      }
      if (actual.system !== "" || actual.mode !== definition.mode || !actual.hidden
        || !executionModelMatches(actual.model, definition.model)) throw new Error("Canonical in-memory agent verification failed: system, mode, visibility, or model differs")
    }
  }
  const verifySelection = async (input: Configuration) => {
    const session = await ctx.session.get({ sessionID: input.sessionID })
    if (session.location.directory !== input.directory || session.agent !== input.executionAgent) throw new Error("Canonical execution selection changed")
    if (input.model && !executionModelMatches(session.model, input.model)) throw new Error("Canonical execution model changed")
  }
  // Optional recovery from the previous prototype's session-policy layering.
  // Metadata and permissions were NOT atomic: either the full old policy or the
  // original baseline may be present. Strip only a positively identified prefix.
  const recoverLegacyOverrides = async (session: Awaited<ReturnType<Context["session"]["get"]>>) => {
    const old = session.metadata?.saneCanonicalExecution as { schema?: number; root?: string; permissions?: OperationPermission[] } | undefined
    if (!old) return
    const last = session.metadata?.saneCanonicalPermissions
    if (old.schema !== 1 || old.root !== session.id || !permissionRules(old.permissions) || !permissionRules(last)) throw new Error("Invalid legacy canonical permission baseline")
    const current = session.permissions ?? []
    let restored: OperationPermission[]
    if (prefix(current, last)) restored = [...old.permissions, ...current.slice(last.length)]
    else if (equal(current, old.permissions)) restored = [...current]
    else throw new Error("Legacy canonical permissions changed independently; reconcile before migration")
    if (!equal(restored, current)) {
      await ctx.session.update({ sessionID: session.id, permissions: restored })
      if (!equal((await ctx.session.get({ sessionID: session.id })).permissions, restored)) throw new Error("Legacy permission recovery was not applied")
    }
  }
  const receipt = (input: Configuration) => ({ sessionID: input.sessionID, agent: input.executionAgent, executionAgent: input.executionAgent, nativeChildren: input.nativeChildren.map(child => child.id) })
  const registration = await ctx.rpc.register(SaneExecution, {
    configure: async (raw, call) => {
      const { readOnly = false, ...configuration } = structuredClone(raw) as Configuration & { readOnly?: boolean }
      let input = configuration as Configuration
      if (!supported) throw new Error("Canonical execution requires OpenCode 2.0.26+ agent transforms and durable plugin storage")
      validate(input, ctx.location.directory)
      input = withoutTemperature(input)
      call.signal.throwIfAborted()
      await ensureAgents()
      call.signal.throwIfAborted()
      if (configuring.has(input.sessionID)) throw new Error("Canonical execution configuration already in progress")
      if (readOnly) {
        const binding = bindings.get(input.sessionID)
        if (binding?.state !== "ready" || !equal(binding.configuration, input)) throw new Error("Canonical execution requires idle reconfiguration before queued dispatch")
        await verifySelection(input)
        await verifyDefinitions(input)
        call.signal.throwIfAborted()
        if (configuring.has(input.sessionID) || bindings.get(input.sessionID) !== binding) throw new Error("Canonical execution changed during queued verification")
        return receipt(input)
      }
      configuring.add(input.sessionID)
      const prior = active.get(input.sessionID)
      try {
        const session = await ctx.session.get({ sessionID: input.sessionID })
        if (session.location.directory !== input.directory) throw new Error("Canonical execution session location mismatch")
        const previous = bindings.get(input.sessionID)
        const pending: Binding = { schema: 2, state: "pending", configuration: input,
          legacyRecovered: previous?.legacyRecovered === true || previous?.state === "ready" || !session.metadata?.saneCanonicalExecution }
        // Write intent before native mutations. No metadata+permissions atomicity
        // is assumed; a crash at any subsequent await leaves a retryable intent.
        bindings.set(input.sessionID, pending)
        await ctx.storage.set(key(input.sessionID), JSON.parse(JSON.stringify(pending)))
        call.signal.throwIfAborted()
        active.set(input.sessionID, input)
        await ctx.agent.reload()
        await verifyDefinitions(input)
        call.signal.throwIfAborted()
        if (!pending.legacyRecovered) {
          await recoverLegacyOverrides(session)
          pending.legacyRecovered = true
          await ctx.storage.set(key(input.sessionID), JSON.parse(JSON.stringify(pending)))
        }
        call.signal.throwIfAborted()
        await ctx.session.switchAgent({ sessionID: input.sessionID, agent: input.executionAgent })
        call.signal.throwIfAborted()
        if (input.model) await ctx.session.switchModel({ sessionID: input.sessionID, model: input.model })
        call.signal.throwIfAborted()
        await verifySelection(input)
        call.signal.throwIfAborted()
        const ready: Binding = { ...pending, state: "ready" }
        await ctx.storage.set(key(input.sessionID), JSON.parse(JSON.stringify(ready)))
        bindings.set(input.sessionID, ready)
        return receipt(input)
      } catch (error) {
        if (prior) active.set(input.sessionID, prior)
        else active.delete(input.sessionID)
        await ctx.agent.reload()
        throw error
      } finally { configuring.delete(input.sessionID) }
    },
  })
  const admission = await ctx.session.hook("prompt", async event => {
    // Prompt hooks run after location activation and before agent selection.
    // This also restores precedence for durable bindings after plugin reload.
    if (!supported || !bindings.size) return
    const binding = bindings.get(event.sessionID)
    if (binding?.state === "pending" || configuring.has(event.sessionID)) throw new Error("Canonical execution configuration is incomplete; idle configure can retry")
    await ensureAgents()
  })
  const hook = await ctx.session.hook("context", async event => {
    const binding = bindings.get(event.sessionID)
    if (binding) {
      if (binding.state !== "ready" || configuring.has(event.sessionID)) throw new Error("Canonical execution configuration is incomplete; idle configure can retry")
      const input = binding.configuration
      if (event.agent !== input.executionAgent) throw new Error("Canonical execution selection changed")
      await verifySelection(input)
      await verifyDefinitions(input)
      // Authored temperature in older durable bindings is retained as evidence,
      // but App-managed execution leaves sampling to the native provider.
      if (input.directChildren.length) event.system.push({ type: "text", text: delegationText(input.directChildren, input) })
      return
    }
    if (!/^sane-private-[a-f0-9]{64}-[a-z][a-z-]*$/.test(event.agent) && !/^sane-execution-[a-f0-9]{64}$/.test(event.agent)) return
    const owner = [...bindings.values()].find(item => item.configuration.nativeChildren.some(child => child.id === event.agent))
    if (!owner || owner.state !== "ready" || configuring.has(owner.configuration.sessionID)) throw new Error("Canonical child definition unavailable or root configuration incomplete")
    const root = owner.configuration, definition = root.nativeChildren.find(child => child.id === event.agent)!
    const childSession = await ctx.session.get({ sessionID: event.sessionID })
    let current = childSession
    let selected: string = event.agent
    const seen = new Set<string>()
    while (current.id !== root.sessionID) {
      if (!current.parentID || seen.has(current.id) || current.location.directory !== root.directory) throw new Error("Canonical child native ancestry mismatch")
      seen.add(current.id)
      const parent = await ctx.session.get({ sessionID: current.parentID })
      const allowed = parent.id === root.sessionID ? root.directChildren : root.nativeChildren.find(child => child.id === parent.agent)?.children
      if (!allowed?.includes(selected)) throw new Error("Canonical child delegation is not authorized by its native parent")
      selected = parent.agent ?? ""
      current = parent
    }
    if (current.location.directory !== root.directory || current.agent !== root.executionAgent) throw new Error("Canonical child root selection changed")
    const legacy = current.metadata?.saneCanonicalExecution as { permissions?: unknown } | undefined
    const retired = current.metadata?.saneCanonicalPermissions
    if (permissionRules(legacy?.permissions) && permissionRules(retired) && !equal(legacy.permissions, retired) && prefix(childSession.permissions ?? [], retired)) {
      // Never mistake an old inherited managed policy for a child-specific user
      // grant, nor mutate it after inventory capture. Operator reconciliation or
      // a fresh native child is required for these pre-migration children.
      throw new Error("Native child retains legacy managed permissions; recreate or reconcile before resume")
    }
    await verifyDefinitions(root)
    // No session-policy mutation here: inventory already reflects this child's
    // generated agent plus its inherited/individually granted user overrides.
    event.system.push({ type: "text", text: definition.system })
    if (definition.children.length) event.system.push({ type: "text", text: delegationText(definition.children, root) })
  })
  return async () => { bindings.clear(); active.clear(); await admission.dispose(); await hook.dispose(); await registration.dispose(); await agents?.dispose() }
}

function delegationText(ids: string[], configuration: Configuration) {
  return `For native subagent calls, use these execution-specific IDs instead of the canonical names:\n${ids.map(id => `${configuration.nativeChildren.find(child => child.id === id)!.canonicalId}: ${id}`).join("\n")}`
}
