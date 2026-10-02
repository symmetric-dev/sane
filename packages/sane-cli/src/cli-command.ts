import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { discoverRepository, inspectRepositoryStore, initializeRepository, upgradeRepository, openRepositoryDomain, normalizeNativeSource, DomainError } from "../../sane-core/src/server.ts"
import type { RepositoryDomain } from "../../sane-core/src/server.ts"
import type { ConversationRef, MutationContext, Phase, RepositoryContext, WorkstreamType } from "../../sane-core/src/contracts.ts"
import { parseCliCommand, type CallerSignals, type CliIntent } from "./cli-arguments.ts"
import { capEvidence, compactSummary, formatCompactLines } from "./cli-verbosity.ts"
import { openCompactCaller } from "./native-caller.ts"
import { nativeIntegrationConfiguration } from "./native-configuration.ts"
import { equivalentSlots } from "../../sane-core/src/slots.ts"

export const USAGE = `Usage: sane <command> [--repo PATH] [--workstream ID] [--json|--verbose]
  native-config --plugin-directory PATH --registration-file PATH --profile-root PATH
    --binding-root PATH --bun-executable PATH --app-connection-file PATH
    [--format all|opencode|claude-mcp|claude-settings]
    Prints configuration JSON only; paths must be absolute. Use the installed plugin directory,
    the App's configured native sources, and APP_DATA_DIR/native-handoff.json.
    Merge opencode output into opencode.json; Claude uses both MCP and settings outputs.
  init [--dry-run] | upgrade [--dry-run] | inspect | list
    upgrade is local/human only: back up the store and stop other SANE processes first.
    Upgrades sane-domain v1/v2 to v3 explicitly; rerun locally to finish an interrupted upgrade.
  create --name ID --type feature|foundation|issue|maintenance [--title TEXT] [--dry-run]
  select --workstream ID [--dry-run]
  view|detail|status [ID] | audit | sessions [--slot SLOT]
  provide PHASE [--refresh-templates] | validate PHASE
  validate execution report --id JOB | approve PHASE --ref USER_REFERENCE
  job JOB [running|completed] | job --register
  research index | research register --topic SLUG --path research/REPORT.md
  research unregister --topic SLUG
  default-checkout --workstream ID --checkout PATH|--clear
  authority declare --repo PATH --source JSON
  conversation register --repo PATH --harness cc|oc --authority ID --native-id ID --checkout PATH
    [--parent-harness cc|oc --parent-authority ID --parent-native-id ID]
  conversation get|context|associate|unassign --repo PATH --harness cc|oc --authority ID --native-id ID
    (associate requires --workstream ID)
  phase assign SLOT --repo PATH --harness cc|oc --authority ID --native-id ID
  phase target SLOT --repo PATH --workstream ID [--harness cc|oc --authority ID --native-id ID]
  phase end --repo PATH --assignment-id ID
Slots: design, engineering, planning, execution (lifecycle);
  research, research:<safe-topic>, curation, experimentation (support tracks).
  Legacy knowledge/prototype inputs match aliases; new assignments use canonical slots.
  Safe topics: 1–96 lowercase a-z/0-9/_/- characters, starting with a-z/0-9.
  provide/validate/approve accept lifecycle phases only.
Caller envelope: SANE_CALLER_CONTEXT v1 full envelope or compact shell
  reference {version,harness,nativeId} (authority + paths resolve server-side);
  explicit equivalent requires all of
  --caller-repo PATH --caller-source JSON --caller-authority ID --caller-native-id ID.
Native link/handoff are supplied by the configured native tools; their CLI commands
and candidate/merge/worktree/destructive operations are unavailable.
Bare native session signals fail, even with explicit targets.
No implicit initialization, native registration, or migration. See docs/SANE_WORKFLOW.md.`

export interface CliRuntime {
  cwd?: string
  signals?: CallerSignals
  write?: (line: string) => void
  error?: (line: string) => void
}

/** Snapshot signals without treating present-but-empty evidence as absent. */
export function callerSignals(env: NodeJS.ProcessEnv = process.env): CallerSignals {
  return { SANE_CALLER_CONTEXT: env.SANE_CALLER_CONTEXT, SANE_SESSION_ID: env.SANE_SESSION_ID, OPENCODE_SESSION_ID: env.OPENCODE_SESSION_ID }
}
function ready(path: string): RepositoryContext {
  const state = inspectRepositoryStore(discoverRepository(path))
  if (state.state !== "ready") throw new DomainError(state.code, state.message)
  return state.context
}
function reference(options: CliIntent["options"], prefix = ""): ConversationRef {
  return { harness: options[`${prefix}harness`] as "cc" | "oc", authorityId: options[`${prefix}authority`] as string, nativeId: options[`${prefix}native-id`] as string }
}

/** Full domain result. Programmatic callers that need complete evidence use
 * `executeCliCommand` with `--verbose`/`--json`; this entry stays unprojected. */
async function executeCliFull(args: readonly string[], runtime: CliRuntime = {}): Promise<unknown> {
  const parsed = parseCliCommand(args, runtime.signals ?? callerSignals())
  if (parsed.kind === "error") throw Object.assign(new Error(parsed.message), { code: parsed.code })
  if (parsed.kind === "unavailable") throw new DomainError("FEATURE_UNAVAILABLE", `${parsed.command} is unavailable.`)
  if (parsed.kind === "help") return { help: USAGE }
  const { intent } = parsed
  const cwd = runtime.cwd ?? process.cwd()
  const o = intent.options
  const arg = (key: string) => o[key] as string
  if (intent.caller.actorKind === "native-bootstrap") {
    // Bootstrap is deliberately separate from enrolled mutation authority.
    // Recheck source, repository and native execution checkout before init;
    // --repo and shell directory changes cannot redirect this authority.
    const envelope = intent.caller.envelope, source = normalizeNativeSource(envelope.source)
    if (source.authorityId !== envelope.authorityId) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Caller source and authority do not agree.")
    const discovery = discoverRepository(envelope.executionCheckout)
    const current = discoverRepository(cwd), target = discoverRepository(resolve(cwd, intent.repository ?? cwd))
    if (discovery.primaryCheckout !== envelope.repository || discovery.invocationCheckout.path !== envelope.executionCheckout || current.invocationCheckout.path !== envelope.executionCheckout || target.commonDir !== discovery.commonDir || target.primaryCheckout !== discovery.primaryCheckout) throw new DomainError("INVALID_CONTEXT", "Bootstrap caller repository or execution checkout changed.")
    const availability = inspectRepositoryStore(discovery)
    if (availability.state === "ready") {
      const domain = openRepositoryDomain(availability.context)
      try {
        const ref = { harness: source.descriptor.harness, authorityId: source.authorityId, nativeId: envelope.nativeId }
        if (domain.getConversation(ref) && domain.resolveContext(ref).executionCheckout !== envelope.executionCheckout) throw new DomainError("INVALID_CHECKOUT", "Native directory differs from the enrolled execution checkout.")
      } finally { domain.close() }
    }
    if (intent.operation === "inspect") return availability
    if (intent.operation !== "init") throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Bootstrap context only permits init and inspect.")
    if (availability.state !== "ready" && availability.state !== "uninitialized") throw new DomainError(availability.code, availability.message)
    return o["dry-run"] ? { dryRun: true, operation: "init", availability } : initializeRepository(discovery)
  }
  if (intent.operation === "native-config") {
    const configuration = nativeIntegrationConfiguration({ pluginDirectory: arg("plugin-directory"), registrationFile: arg("registration-file"), profileRoot: arg("profile-root"), bindingRoot: arg("binding-root"), bunExecutable: arg("bun-executable"), appConnectionFile: arg("app-connection-file") })
    switch (arg("format")) {
      case "opencode": return configuration.opencode
      case "claude-mcp": return configuration.claudeMcp
      case "claude-settings": return configuration.claudeSettings
      default: return configuration
    }
  }
  let callerDomain: RepositoryDomain | undefined
  let domain: RepositoryDomain | undefined
  try {
    let nativeRef: ConversationRef | null = null
    let member: string | undefined
    if (intent.caller.actorKind === "native") {
      const envelope = intent.caller.envelope
      const authority = normalizeNativeSource(envelope.source)
      if (authority.authorityId !== envelope.authorityId) throw new DomainError("INVALID_CONTEXT", "Caller source and authority do not agree.")
      callerDomain = openRepositoryDomain(ready(envelope.repository))
      nativeRef = { harness: authority.descriptor.harness, authorityId: authority.authorityId, nativeId: envelope.nativeId }
      // Revalidates registered caller and its pinned execution checkout even for reads/init.
      const invocation = callerDomain.resolveInvocation(nativeRef)
      member = invocation.workstream?.id
    } else if (intent.caller.actorKind === "native-ref") {
      // C11 Phase 4: compact shell reference. Repository resolves from cwd
      // discovery; authority resolves from the enrolled conversation row.
      const resolved = openCompactCaller(intent.caller.ref.harness, intent.caller.ref.nativeId, cwd)
      callerDomain = resolved.domain
      nativeRef = resolved.ref
      member = resolved.context.workstream?.id
    }
    const target = resolve(cwd, intent.repository ?? (intent.caller.actorKind === "native" ? intent.caller.envelope.repository : cwd))
    const discovery = discoverRepository(target)
    if (callerDomain && (discovery.commonDir !== callerDomain.context.commonDir || discovery.primaryCheckout !== callerDomain.primaryCheckout)) {
      throw new DomainError("INVALID_CONTEXT", "Native caller cannot read or mutate a different repository.")
    }
    if (intent.operation === "inspect") return inspectRepositoryStore(discovery)
    if (intent.operation === "upgrade") {
      if (intent.caller.actorKind !== "local" || callerDomain) throw new DomainError("INVALID_CONTEXT", "Only a local/human caller can upgrade the store.")
      return upgradeRepository(discovery, { dryRun: Boolean(o["dry-run"]) })
    }
    if (intent.operation === "init") {
      if (o["dry-run"]) {
        const availability = inspectRepositoryStore(discovery)
        if (availability.state !== "ready" && availability.state !== "uninitialized") throw new DomainError(availability.code, availability.message)
        return { dryRun: true, operation: "init", availability }
      }
      return initializeRepository(discovery)
    }
    const availability = inspectRepositoryStore(discovery)
    if (availability.state !== "ready") throw new DomainError(availability.code, availability.message)
    if (callerDomain && availability.context.repositoryId !== callerDomain.repositoryId) throw new DomainError("INVALID_CONTEXT", "Caller repository identity changed.")
    domain = openRepositoryDomain(availability.context)
    const mutation: MutationContext = { actor: nativeRef ? { kind: "native", repositoryId: callerDomain!.repositoryId, ref: nativeRef } : { kind: "local" }, correlationId: randomUUID() }
    const workstream = () => {
      const id = intent.workstream ?? (nativeRef ? member : domain!.getSelectedWorkstream()?.id)
      if (!id) throw new DomainError("INVALID_CONTEXT", "No workstream target: supply --workstream ID; native callers never use local selection.")
      return id
    }
    const phase = intent.positionals[0]!
    switch (intent.operation) {
      case "create": {
        if (o["dry-run"]) {
          if (domain.listWorkstreams().some(w => w.id === arg("name")) || existsSync(resolve(domain.stateRoot, "workstreams", arg("name")))) throw new DomainError("CONFLICT", "Workstream or artifact destination already exists.")
          return { dryRun: true, operation: "create", repositoryId: domain.repositoryId, id: arg("name"), type: arg("type") }
        }
        return domain.createWorkstream({ id: arg("name"), title: arg("title") ?? arg("name"), type: arg("type") as WorkstreamType }, mutation)
      }
      case "list": return { repositoryId: domain.repositoryId, workstreams: domain.listWorkstreams() }
      case "select": {
        const selected = domain.getWorkstream(workstream())
        if (!o["dry-run"]) domain.selectWorkstream(selected.id, mutation)
        return { dryRun: Boolean(o["dry-run"]), selected }
      }
      case "view": case "detail": case "status": return domain.getStatus(workstream())
      case "audit": return { repositoryId: domain.repositoryId, events: domain.readAudit(intent.workstream) }
      case "sessions": {
        const id = intent.workstream ?? (nativeRef ? member : undefined)
        const assignments = (id ? [domain.getWorkstreamStatus(id)] : domain.listWorkstreams().map(w => domain!.getWorkstreamStatus(w.id))).flatMap(w => w.activePhases).filter(a => !o.slot || equivalentSlots(a.phase, o.slot as Phase))
        const conversations = domain.listConversations().filter(c => (!id || c.workstreamId === id) && (!o.slot || assignments.some(a => a.ref.harness === c.ref.harness && a.ref.authorityId === c.ref.authorityId && a.ref.nativeId === c.ref.nativeId)))
        return { repositoryId: domain.repositoryId, conversations, assignments }
      }
      case "provide": return await domain.providePhase(workstream(), phase, { refreshTemplates: Boolean(o["refresh-templates"]) }, mutation)
      case "validate": return await domain.validatePhase(workstream(), phase, { reportId: arg("id") })
      case "approve": return await domain.approvePhase(workstream(), phase, arg("ref"), mutation)
      case "job.register": return await domain.registerJobs(workstream(), mutation)
      case "job.context": {
        const id = workstream()
        return { ...domain.getJobContext(id, phase, nativeRef), repositoryId: domain.repositoryId,
          planningApproval: domain.getWorkstream(id).lifecycle.approvals.find(a => a.phase === "planning") ?? null,
          supportingDocuments: domain.listArtifacts(id).filter(path => !path.startsWith("resources/") && !path.startsWith("execution/reports/")) }
      }
      case "job.update": return domain.updateJob(workstream(), phase, intent.positionals[1] as "running" | "completed", mutation)
      case "research.index": return domain.getResearchIndex(workstream())
      case "research.register": return domain.registerResearch(workstream(), arg("topic"), arg("path"), mutation)
      case "research.unregister": domain.unregisterResearch(workstream(), arg("topic"), mutation); return { unregistered: arg("topic") }
      case "default-checkout": return domain.setDefaultCheckout(workstream(), o.clear ? null : resolve(cwd, arg("checkout")), mutation)
      case "authority.declare": return domain.declareNativeAuthority(JSON.parse(arg("source")), mutation)
      case "conversation.register": return domain.registerConversation({ ref: reference(o), executionCheckout: resolve(cwd, arg("checkout")), parent: o["parent-harness"] ? reference(o, "parent-") : null }, mutation)
      case "conversation.get": return domain.getConversation(reference(o))
      case "conversation.context": return domain.resolveInvocation(reference(o))
      case "conversation.associate": return domain.associateConversation(reference(o), workstream(), mutation)
      case "conversation.unassign": return domain.associateConversation(reference(o), null, mutation)
      case "phase.assign": return domain.assignPhase(reference(o), intent.positionals[1] as Phase, mutation)
      case "phase.target": return domain.resolvePhaseTarget(workstream(), intent.positionals[1] as Phase, o.harness ? reference(o) : undefined)
      case "phase.end": domain.endAssignment(arg("assignment-id"), mutation); return { ended: arg("assignment-id") }
      default: throw new DomainError("FEATURE_UNAVAILABLE", "Unsupported CLI operation.")
    }
  } finally { domain?.close(); callerDomain?.close() }
}

/** All entrypoints reparse/classify before any repository access, including exported callers.
 * Default calls return compact projections; `--verbose`/`--json` return the
 * full evidence with bounded arrays (see cli-verbosity.ts). */
export async function executeCliCommand(args: readonly string[], runtime: CliRuntime = {}): Promise<unknown> {
  const result = await executeCliFull(args, runtime)
  if (!result || typeof result !== "object" || "help" in result) return result
  const parsed = parseCliCommand(args, runtime.signals ?? callerSignals())
  if (parsed.kind !== "command") return result
  if (parsed.intent.options.verbose || parsed.intent.options.json) return capEvidence(result)
  return compactSummary(parsed.intent.operation, result, parsed.intent)
}

/** Compact default lines for agents/humans; full evidence behind --verbose/--json. */
export async function runCliCommand(args: string[], runtime: CliRuntime = {}): Promise<number> {
  const write = runtime.write ?? console.log
  const error = runtime.error ?? console.error
  try {
    const result = await executeCliCommand(args, runtime)
    if (result && typeof result === "object" && "help" in result) { write(String(result.help)); return 0 }
    if (args.includes("--json")) write(JSON.stringify(result))
    else if (args.includes("--verbose")) write(JSON.stringify(result, null, 2))
    else {
      const parsed = parseCliCommand(args, runtime.signals ?? callerSignals())
      const operation = parsed.kind === "command" ? parsed.intent.operation : "unknown"
      for (const line of formatCompactLines(operation, result)) write(line)
    }
    if (result && typeof result === "object" && "ok" in result && result.ok === false) return 1
    return 0
  } catch (cause) {
    const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "CLI_ERROR"
    error(JSON.stringify({ code, message: cause instanceof Error ? cause.message : "CLI operation failed." }))
    return 1
  }
}
