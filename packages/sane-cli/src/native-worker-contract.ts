import { createHash } from "node:crypto"
import { MAX_WORKER_JOBS, WORKER_AGENT_IDS, WORKER_JOB_ID_PATTERN, isWorkerAgentId, workerJobsProblem, type WorkerAgentId } from "../../sane-core/src/agent-catalog.ts"
import { classifyCaller, type CallerEnvelope } from "./cli-arguments.ts"

export const nativeWorkerOperations = ["start", "status", "wait", "acknowledge", "cancel", "cancel_all"] as const
export type NativeWorkerOperation = typeof nativeWorkerOperations[number]
export type NativeWorkerInvocation = { toolCallId: string; messageId?: string; opencode?: { invocationId: string; operation: NativeWorkerOperation; wrapper?: "execute" } }
export type NativeWorkerResultRef = { workerId: string; revision: number; notificationId: string }
export type NativeWorkerAcknowledgement = NativeWorkerResultRef & { state: "pending" | "wait-consumed" | "claimed" | "acceptance-unknown" | "delivered"; acknowledged: boolean }
export type NativeWorkerInputs = {
  start: { worker: WorkerAgentId; prompt: string; context?: string; jobs?: string[] }
  status: { ids?: string[] }
  wait: { ids: string[]; timeoutSec: number }
  acknowledge: { refs: NativeWorkerResultRef[] }
  cancel: { ids: string[]; includeDescendants?: boolean }
  cancel_all: Record<string, never>
}
export type NativeWorkerRequest = { [O in NativeWorkerOperation]: {
  operation: O; caller: CallerEnvelope; invocation: NativeWorkerInvocation
  input: NativeWorkerInputs[O] & (O extends "start" ? { requestId: string } : {})
} }[NativeWorkerOperation]

const uuidPattern = "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$"
const idsSchema = { type: "array", minItems: 1, maxItems: 256, items: { type: "string", pattern: uuidPattern } } as const
const resultRefSchema = { type: "object", properties: { workerId: { type: "string", pattern: uuidPattern }, revision: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, notificationId: { type: "string", minLength: 1, maxLength: 2048, pattern: "^[^\\s\\u0000-\\u001f\\u007f]+$" } }, required: ["workerId", "revision", "notificationId"], additionalProperties: false } as const
export const nativeWorkerSchemas = {
  start: { type: "object", properties: { worker: { type: "string", enum: WORKER_AGENT_IDS }, prompt: { type: "string", minLength: 1, maxLength: 100000, pattern: "\\S" }, context: { type: "string", maxLength: 100000 }, jobs: { type: "array", minItems: 1, maxItems: MAX_WORKER_JOBS, items: { type: "string", pattern: WORKER_JOB_ID_PATTERN } } }, required: ["worker", "prompt"], additionalProperties: false },
  status: { type: "object", properties: { ids: idsSchema }, required: [], additionalProperties: false },
  wait: { type: "object", properties: { ids: idsSchema, timeoutSec: { type: "number", minimum: 0, maximum: 10, default: 0 } }, required: ["ids"], additionalProperties: false },
  acknowledge: { type: "object", properties: { refs: { type: "array", minItems: 1, maxItems: 256, items: resultRefSchema } }, required: ["refs"], additionalProperties: false },
  cancel: { type: "object", properties: { ids: idsSchema, includeDescendants: { type: "boolean" } }, required: ["ids"], additionalProperties: false },
  cancel_all: { type: "object", properties: {}, required: [], additionalProperties: false },
} as const
export const nativeWorkerDescriptions: Record<NativeWorkerOperation, string> = {
  start: "Launch an App-managed worker in the background. Continue useful work, then end your turn; terminal outcomes report back automatically. Waiting is optional. context is explicit supplemental text, not inherited conversation history. jobs assigns registered job IDs and SANE supplies their paths: implementer accepts exactly one, required when called from Execution; fixer, tester and reviewer accept one or more; other roles reject jobs. Workers continue independently when the parent stops.",
  status: "Inspect background workers in this caller's worker tree; omit ids to list them. Background outcomes report back automatically; polling is unnecessary.",
  wait: "Optionally join selected background workers for 0–10 seconds (default 0). A timeout or cancelled wait leaves workers running independently; normally end your turn and await automatic report-back.",
  acknowledge: "Optional: only after receiving and handling results via wait/status, consume your own pending notifications before ending your turn. Copy workerId from worker.id and exact revision/notificationId from latestResult or resultHistory. Only the immediate parent may acknowledge. Receipts report arbitration: claimed, acceptance-unknown or delivered notifications are not consumed. Background report-back remains the default; wait/status never automatically acknowledge.",
  cancel: "Explicitly stop selected background workers independently of the parent. ids are required; includeDescendants explicitly stops their trees. Ending or stopping the parent does not cancel workers.",
  cancel_all: "Explicitly stop all active background workers in this caller's worker tree, independently of parent execution. Scope comes from trusted caller identity; no parent identifier is accepted.",
}
function invalid(message: string): never { throw new Error(`INVALID_INPUT: ${message}`) }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid("Expected worker arguments.")
  return input as Record<string, unknown>
}
function keys(input: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid("Unknown worker argument.")
}
export function nativeWorkerInput<O extends NativeWorkerOperation>(operation: O, input: unknown): NativeWorkerInputs[O] {
  const value = object(input)
  keys(value, Object.keys(nativeWorkerSchemas[operation].properties))
  if (operation === "start") {
    if (!isWorkerAgentId(value.worker) || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 100000 || (value.context !== undefined && (typeof value.context !== "string" || value.context.length > 100000))) invalid("Expected a worker role, nonblank prompt (max 100000 characters), and optional context (max 100000 characters).")
    const jobs = workerJobsProblem(value.worker as WorkerAgentId, value.jobs)
    if (jobs) invalid(jobs)
  } else if (operation === "acknowledge") {
    if (!Array.isArray(value.refs) || !value.refs.length || value.refs.length > 256) invalid("refs must contain 1–256 exact worker result references.")
    for (const input of value.refs as unknown[]) {
      const ref = object(input)
      keys(ref, ["workerId", "revision", "notificationId"])
      if (typeof ref.workerId !== "string" || !new RegExp(uuidPattern).test(ref.workerId) || !Number.isSafeInteger(ref.revision) || (ref.revision as number) < 1 || typeof ref.notificationId !== "string" || ref.notificationId.length > 2048 || !/^[^\s\u0000-\u001f\u007f]+$/.test(ref.notificationId)) invalid("Each ref requires a worker UUID, positive safe-integer revision and nonblank notificationId (max 2048 characters; no whitespace/control characters).")
    }
  } else if (operation !== "cancel_all") {
    if (value.ids !== undefined || operation !== "status") {
      if (!Array.isArray(value.ids) || !value.ids.length || value.ids.length > 256 || value.ids.some(id => typeof id !== "string" || !new RegExp(uuidPattern).test(id))) invalid("ids must contain 1–256 worker UUIDs.")
    }
    if (operation === "wait" && value.timeoutSec !== undefined && (typeof value.timeoutSec !== "number" || !Number.isFinite(value.timeoutSec) || value.timeoutSec < 0 || value.timeoutSec > 10)) invalid("timeoutSec must be finite and between 0 and 10.")
    if (operation === "cancel" && value.includeDescendants !== undefined && typeof value.includeDescendants !== "boolean") invalid("includeDescendants must be boolean.")
  }
  return { ...value, ...(operation === "wait" ? { timeoutSec: value.timeoutSec ?? 0 } : {}) } as NativeWorkerInputs[O]
}
export function nativeWorkerInvocation(input: unknown): NativeWorkerInvocation {
  const value = object(input)
  keys(value, ["toolCallId", "messageId", "opencode"])
  const identity = (v: unknown) => typeof v === "string" && !!v.trim() && v.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(v)
  if (!identity(value.toolCallId) || (value.messageId !== undefined && !identity(value.messageId))) invalid("Trusted worker invocation identity is missing or invalid.")
  if (value.opencode !== undefined) {
    const oc = object(value.opencode)
    keys(oc, ["invocationId", "operation", "wrapper"])
    if (typeof oc.invocationId !== "string" || !new RegExp(uuidPattern).test(oc.invocationId) || !(nativeWorkerOperations as readonly unknown[]).includes(oc.operation) || oc.wrapper !== undefined && oc.wrapper !== "execute" || !identity(value.messageId)) invalid("Invalid trusted OpenCode worker callback provenance.")
  }
  return value as NativeWorkerInvocation
}
/** Stable private admission key. Payload conflicts for this key must be rejected by the bridge. */
export function nativeWorkerRequestId(caller: CallerEnvelope, invocation: NativeWorkerInvocation): string {
  const identity = [caller.source.harness, caller.authorityId, caller.nativeId, invocation.messageId ?? null, invocation.toolCallId, "sane_worker_start"]
  // Preserve existing CC/legacy direct keys. Each OC callback owns its private
  // ID; several nested callbacks can share one visible execute part.
  if (invocation.opencode) identity.push(invocation.opencode.invocationId)
  return `worker:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`
}
/** Bridge syntax boundary; caller enrollment, run resolution and tree authorization remain bridge-owned. */
export function parseNativeWorkerRequest(input: unknown): NativeWorkerRequest {
  const value = object(input)
  keys(value, ["operation", "caller", "invocation", "input"])
  if (!(nativeWorkerOperations as readonly unknown[]).includes(value.operation)) invalid("Unknown worker operation.")
  const operation = value.operation as NativeWorkerOperation
  const classified = classifyCaller({ SANE_CALLER_CONTEXT: JSON.stringify(value.caller) })
  if (classified.actorKind !== "native") return invalid("Qualified caller envelope required.")
  const caller = classified.envelope, invocation = nativeWorkerInvocation(value.invocation)
  if (caller.source.harness === "oc" && !invocation.messageId) invalid("OpenCode message identity required.")
  if (invocation.opencode && (caller.source.harness !== "oc" || invocation.opencode.operation !== operation)) invalid("OpenCode callback provenance does not match source/operation.")
  const raw = { ...object(value.input) }, requestId = raw.requestId
  if (operation === "start") delete raw.requestId
  const args = nativeWorkerInput(operation, raw)
  if (operation === "start" && requestId !== nativeWorkerRequestId(caller, invocation)) invalid("Invalid private worker request identity.")
  return { operation, caller, invocation, input: { ...args, ...(operation === "start" ? { requestId } : {}) } } as NativeWorkerRequest
}

/** Match persisted native evidence, never model-written JavaScript. The OC-only
 * wrapper claim is supplied by our registered plugin's live execute hooks. */
export function matchesOpenCodeWorkerPart(operation: NativeWorkerOperation, invocation: NativeWorkerInvocation, messageId: string, part: { type: string; id?: string; name?: string }): boolean {
  if (messageId !== invocation.messageId || part.type !== "tool" || part.id !== invocation.toolCallId) return false
  if (invocation.opencode && invocation.opencode.operation !== operation) return false
  return invocation.opencode?.wrapper === "execute" ? part.name === "execute" : part.name === `sane_worker_${operation}`
}

/** Compact agent-facing metadata, complete result text. No launch config, input,
 * parent envelope or private notification record. */
export type NativeWorkerSummary = {
  id: string; sessionId: string; runId: string | null; worker?: WorkerAgentId
  state: string; createdAt?: string; updatedAt?: string; cancelRequestedAt?: string
  error?: string; outcome?: { status: string; at: string; summary: string; log: { sessionId: string; runId: string } | null }
  continuation?: { runId: string; state: string; error?: string }
  continuationCancellation?: { requestedAt: string; error?: string }
  initialOutcome?: NativeWorkerSummary["outcome"]
  latestResult?: { revision: number; runId: string | null; notificationId: string; notificationState: string; outcome?: NativeWorkerSummary["outcome"] }
  resultHistory?: { revision: number; runId: string | null; notificationId: string; notificationState: string }[]
}
export type NativeWorkerReply = { worker?: NativeWorkerSummary; workers?: NativeWorkerSummary[]; timedOut?: boolean; receipts?: NativeWorkerAcknowledgement[] }
export function projectNativeWorkerReply(input: unknown): NativeWorkerReply {
  const value = object(input)
  const summary = (input: unknown): NativeWorkerSummary => {
    const src = object(input), out: Record<string, unknown> = {}
    for (const key of ["id", "sessionId", "runId", "worker", "state", "createdAt", "updatedAt", "cancelRequestedAt", "error"]) {
      if (typeof src[key] === "string") out[key] = (src[key] as string).slice(0, key === "error" ? 4000 : 2048)
    }
    if (src.runId === null) out.runId = null
    for (const [key, fields] of [["continuation", ["runId", "state", "error"]], ["continuationCancellation", ["requestedAt", "error"]]] as const) {
      if (src[key] && typeof src[key] === "object") {
        const source = src[key] as Record<string, unknown>, target: Record<string, string> = {}
        for (const field of fields) if (typeof source[field] === "string") target[field] = (source[field] as string).slice(0, field === "error" ? 4000 : 2048)
        out[key] = target
      }
    }
    if (src.outcome && typeof src.outcome === "object" && !Array.isArray(src.outcome)) {
      const source = src.outcome as Record<string, unknown>, outcome: Record<string, unknown> = {}
      for (const key of ["status", "at", "summary"]) if (typeof source[key] === "string") outcome[key] = key === "summary" ? source[key] : (source[key] as string).slice(0, 2048)
      if (source.log === null) outcome.log = null
      else if (source.log && typeof source.log === "object") {
        const log = source.log as Record<string, unknown>
        if (typeof log.sessionId === "string" && typeof log.runId === "string") outcome.log = { sessionId: log.sessionId.slice(0, 2048), runId: log.runId.slice(0, 2048) }
      }
      out.outcome = outcome
    }
    if (Array.isArray(src.results) && src.results.length) {
      const refs = src.results.map(item => {
        const r = object(item), n = object(r.notification)
        return { revision: r.revision as number, runId: typeof r.runId === "string" ? r.runId.slice(0, 2048) : null, notificationId: String(n.id).slice(0, 2048), notificationState: String(n.state).slice(0, 2048) }
      })
      const latest = object(src.results.at(-1))
      out.initialOutcome = out.outcome
      out.outcome = summary({ outcome: latest.outcome }).outcome
      out.latestResult = { ...refs.at(-1), outcome: out.outcome }
      out.resultHistory = refs.slice(-256)
    } else {
      // CLI projects the already projected HTTP reply again; preserve exact revision references.
      const reference = (value: unknown) => {
        const r = object(value)
        return { revision: r.revision as number, runId: typeof r.runId === "string" ? r.runId.slice(0, 2048) : null, notificationId: String(r.notificationId).slice(0, 2048), notificationState: String(r.notificationState).slice(0, 2048) }
      }
      if (src.initialOutcome) out.initialOutcome = summary({ outcome: src.initialOutcome }).outcome
      if (src.latestResult && typeof src.latestResult === "object") out.latestResult = { ...reference(src.latestResult), outcome: summary({ outcome: (src.latestResult as Record<string, unknown>).outcome }).outcome }
      if (Array.isArray(src.resultHistory)) out.resultHistory = src.resultHistory.slice(-256).map(reference)
    }
    return out as NativeWorkerSummary
  }
  const receipts = Array.isArray(value.receipts) ? value.receipts.slice(0, 256).map(input => {
    const receipt = object(input)
    const { workerId, revision, notificationId } = nativeWorkerInput("acknowledge", { refs: [{ workerId: receipt.workerId, revision: receipt.revision, notificationId: receipt.notificationId }] }).refs[0]!
    if (!["pending", "wait-consumed", "claimed", "acceptance-unknown", "delivered"].includes(receipt.state as string) || typeof receipt.acknowledged !== "boolean") invalid("Invalid worker acknowledgement receipt.")
    return { workerId, revision, notificationId, state: receipt.state as NativeWorkerAcknowledgement["state"], acknowledged: receipt.acknowledged }
  }) : undefined
  return { ...(value.worker !== undefined ? { worker: summary(value.worker) } : {}), ...(Array.isArray(value.workers) ? { workers: value.workers.map(summary) } : {}), ...(typeof value.timedOut === "boolean" ? { timedOut: value.timedOut } : {}), ...(receipts ? { receipts } : {}) }
}
