import { discoverRepository, inspectRepositoryStore, normalizeNativeSource, openRepositoryDomain, DomainError, type RepositoryDomain } from "../../sane-core/src/server.ts"
import type { ConversationRef, Harness, InvocationContext, NativeSourceDescriptor, Phase, MutationContext } from "../../sane-core/src/contracts.ts"
import type { CallerEnvelope, CallerReference } from "./cli-arguments.ts"

export interface NativeCaller {
  source: NativeSourceDescriptor
  authorityId: string
  nativeId: string
  cwd: string
  correlationId: string
  ancestors: { nativeId: string; cwd: string }[]
  agent?: string
}

export function openNativeCaller(caller: NativeCaller, enroll = false) {
  const source = normalizeNativeSource(caller.source)
  if (source.authorityId !== caller.authorityId) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Native authority changed.")
  if (!caller.nativeId || !caller.correlationId) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Incomplete native caller.")
  const discovery = discoverRepository(caller.cwd), state = inspectRepositoryStore(discovery)
  if (state.state !== "ready") throw new DomainError(state.code, state.message)
  const domain = openRepositoryDomain(state.context)
  try {
    const ref: ConversationRef = { harness: source.descriptor.harness, authorityId: source.authorityId, nativeId: caller.nativeId }
    let conversation = domain.getConversation(ref)
    if (!conversation && enroll) {
      let parent: ConversationRef | null = null
      const visited = new Set([caller.nativeId])
      for (const ancestor of caller.ancestors) {
        if (visited.has(ancestor.nativeId)) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Cyclic native ancestry.")
        visited.add(ancestor.nativeId)
        const ancestorRepo = discoverRepository(ancestor.cwd)
        if (ancestorRepo.commonDir !== discovery.commonDir) break
        const candidate = { ...ref, nativeId: ancestor.nativeId }
        if (domain.getConversation(candidate)) { parent = candidate; break }
      }
      const bootstrap: MutationContext = { actor: { kind: "system" }, correlationId: caller.correlationId }
      domain.declareNativeAuthority(source.descriptor, bootstrap)
      conversation = domain.registerConversation({ ref, executionCheckout: discovery.invocationCheckout.path, parent }, bootstrap)
    }
    if (!conversation) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", "Native conversation is not enrolled in this repository. Use sane_link explicitly.")
    const context = domain.resolveContext(ref)
    if (context.executionCheckout !== discovery.invocationCheckout.path) throw new DomainError("INVALID_CHECKOUT", "Native directory differs from the enrolled execution checkout.")
    const envelope: CallerEnvelope = { version: 1, repository: domain.primaryCheckout, source: source.descriptor, authorityId: ref.authorityId, nativeId: ref.nativeId }
    const mutation: MutationContext = { actor: { kind: "native", repositoryId: domain.repositoryId, ref }, correlationId: caller.correlationId }
    return { domain, ref, context, envelope, mutation }
  } catch (error) { domain.close(); throw error }
}

export interface NativeLinkInput { slot: Phase; workstream?: string; reassign?: boolean }
export const nativeLinkSchema = {
  type: "object", properties: {
    slot: { type: "string", pattern: "^(design|engineering|planning|execution|research|research:[a-z0-9][a-z0-9_-]{0,95})$" },
    workstream: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,95}$" },
    reassign: { type: "boolean" },
  }, required: ["slot"], additionalProperties: false,
} as const

export function nativeLinkInput(input: unknown): NativeLinkInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("INVALID_INPUT", "Expected link arguments.")
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !["slot", "workstream", "reassign"].includes(key)) || typeof value.slot !== "string" || !/^(design|engineering|planning|execution|research|research:[a-z0-9][a-z0-9_-]{0,95})$/.test(value.slot) || (value.workstream !== undefined && (typeof value.workstream !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(value.workstream))) || (value.reassign !== undefined && typeof value.reassign !== "boolean")) throw new DomainError("INVALID_INPUT", "Invalid link arguments.")
  return value as unknown as NativeLinkInput
}

/** C11 Phase 1: compact agent-facing projection. Full rows stay server-side;
 * recover them via `sane conversation get`, `sane conversation context`,
 * `sane detail`/`status`/`view`, or `sane sessions` / `sane phase target`. */
export interface NativeContextSummary {
  context: string
  harness: Harness
  workstream: string | null
  phase: Phase | null
}

export function formatNativeContextSummary(snapshot: InvocationContext, phase: Phase | null): NativeContextSummary {
  const workstream = snapshot.workstream?.id ?? null
  const context = [
    "SANE session context:",
    `Workstream: ${workstream ?? "(none)"}`,
    `Management repository: ${snapshot.primaryCheckout}`,
    `Artifacts root: ${snapshot.artifactsRoot ?? "(none)"}`,
    `Implementation root: ${snapshot.executionCheckout}`,
    "Run commands in the implementation root; keep documents at the artifacts root.",
    "Shell calls carry the caller reference automatically.",
  ].join("\n")
  return { context, harness: snapshot.conversation.ref.harness, workstream, phase }
}

function latestNativePhase(domain: RepositoryDomain, ref: ConversationRef, workstreamId: string | null): Phase | null {
  if (!workstreamId) return null
  const active = domain.getWorkstreamStatus(workstreamId).activePhases.filter(a => a.ref.harness === ref.harness && a.ref.authorityId === ref.authorityId && a.ref.nativeId === ref.nativeId)
  return active.length ? active[active.length - 1]!.phase : null
}

/** Server-side caller envelope for MCP handoff transport. Never agent-facing. */
export function nativeCallerEnvelope(caller: NativeCaller): CallerEnvelope {
  const opened = openNativeCaller(caller)
  try { return opened.envelope } finally { opened.domain.close() }
}

/** C11 Phase 4: minimal per-shell-call caller reference. Qualification (enrollment
 * + execution-checkout pin) still runs at hook time via openNativeCaller; only
 * the session-scoped harness + nativeId cross the shell boundary. Authority and
 * absolute paths resolve server-side in openCompactCaller. */
export function nativeCallerReference(caller: NativeCaller): CallerReference {
  const opened = openNativeCaller(caller)
  try { return { version: 1, harness: opened.ref.harness, nativeId: opened.ref.nativeId } } finally { opened.domain.close() }
}

/** Resolve a compact shell reference: repository from cwd discovery, authority
 * from the enrolled conversation row. The nativeId is session-scoped and unique
 * per harness; zero or several matches fail closed. */
export function openCompactCaller(harness: Harness, nativeId: string, cwd: string) {
  const discovery = discoverRepository(cwd), state = inspectRepositoryStore(discovery)
  if (state.state !== "ready") throw new DomainError(state.code, state.message)
  const domain = openRepositoryDomain(state.context)
  try {
    const matches = domain.listConversations().filter(c => c.ref.harness === harness && c.ref.nativeId === nativeId)
    if (matches.length !== 1) throw new DomainError("NATIVE_CONTEXT_UNAVAILABLE", matches.length ? "Native caller reference is ambiguous." : "Native conversation is not enrolled in this repository. Use sane_link explicitly.")
    const ref: ConversationRef = matches[0]!.ref
    const context: InvocationContext = domain.resolveContext(ref)
    return { domain, ref, context }
  } catch (error) { domain.close(); throw error }
}

export function linkNativeCaller(caller: NativeCaller, input: unknown): NativeContextSummary {
  const args = nativeLinkInput(input), opened = openNativeCaller(caller, true)
  try {
    const { domain, ref, mutation } = opened
    const current = opened.context.workstream?.id
    if (args.workstream && current && current !== args.workstream && !args.reassign) throw new DomainError("CONFLICT", "Use reassign to replace existing membership.")
    if (args.workstream) domain.associateConversation(ref, args.workstream, mutation)
    const assignment = domain.assignPhase(ref, args.slot, mutation)
    return formatNativeContextSummary(domain.resolveContext(ref), assignment.phase)
  } finally { opened.domain.close() }
}

export function nativeCallerContext(caller: NativeCaller): NativeContextSummary {
  const opened = openNativeCaller(caller)
  try { return formatNativeContextSummary(opened.context, latestNativePhase(opened.domain, opened.ref, opened.context.workstream?.id ?? null)) } finally { opened.domain.close() }
}
