import type { HandoffInput } from "./contracts.ts"
import { DomainError } from "./errors.ts"
import { STORED_SLOT_PATTERN, isStoredSlot, canonicalSlot } from "./slots.ts"
import { SUPPORTED_WORKSTREAM_TYPES, isSupportedWorkstreamType } from "./workstream-type.ts"

export const handoffSchema = {
  type: "object", properties: {
    requestId: { type: "string", minLength: 1, maxLength: 200 },
    to: { type: "string", pattern: STORED_SLOT_PATTERN }, message: { type: "string", minLength: 1, maxLength: 32000 },
    target: { type: "object", properties: { harness: { enum: ["cc", "oc"] }, authorityId: { type: "string" }, nativeId: { type: "string" } }, required: ["harness", "authorityId", "nativeId"], additionalProperties: false },
    createNew: { type: "boolean" }, checkout: { type: "string" },
    kickoff: { type: "object", properties: { workstream: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,95}$" }, title: { type: "string", minLength: 1, maxLength: 200 }, type: { enum: [...SUPPORTED_WORKSTREAM_TYPES] } }, required: ["workstream", "title", "type"], additionalProperties: false },
  }, required: ["requestId", "to", "message"], additionalProperties: false,
  allOf: [
    { if: { required: ["createNew"], properties: { createNew: { const: true } } }, then: { not: { required: ["target"] } } },
    { if: { required: ["checkout"] }, then: { required: ["createNew"], properties: { createNew: { const: true } } } },
    { if: { required: ["kickoff"] }, then: { required: ["createNew"], properties: { createNew: { const: true }, to: { const: "design" } } } },
  ],
} as const

export function handoffInput(input: unknown): HandoffInput {
  const invalid = (): never => { throw new DomainError("INVALID_INPUT", "Invalid handoff arguments; use an explicit requestId, destination and bounded message.") }
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid()
  const v = input as Record<string, unknown>
  const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max && !v.includes("\0")
  if (Object.keys(v).some(k => !Object.hasOwn(handoffSchema.properties, k)) || !text(v.requestId, 200) || !text(v.message, 32000) || !isStoredSlot(v.to)) return invalid()
  if (v.createNew !== undefined && typeof v.createNew !== "boolean" || v.checkout !== undefined && (!text(v.checkout, 4096) || !v.checkout.startsWith("/"))) return invalid()
  let target: HandoffInput["target"]
  if (v.target !== undefined) {
    if (!v.target || typeof v.target !== "object" || Array.isArray(v.target)) return invalid()
    const t = v.target as Record<string, unknown>
    if (Object.keys(t).length !== 3 || t.harness !== "cc" && t.harness !== "oc" || !text(t.authorityId, 200) || !text(t.nativeId, 200)) return invalid()
    target = { harness: t.harness, authorityId: t.authorityId, nativeId: t.nativeId }
  }
  if (v.createNew ? !!target : v.checkout !== undefined) return invalid()
  let kickoff: HandoffInput["kickoff"]
  if (v.kickoff !== undefined) {
    if (!v.kickoff || typeof v.kickoff !== "object" || Array.isArray(v.kickoff) || !v.createNew || v.to !== "design") return invalid()
    const k = v.kickoff as Record<string, unknown>
    if (Object.keys(k).length !== 3 || typeof k.workstream !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(k.workstream) || !text(k.title, 200) || !isSupportedWorkstreamType(k.type)) return invalid()
    kickoff = { workstream: k.workstream, title: k.title, type: k.type }
  }
  return { requestId: v.requestId, to: canonicalSlot(v.to), message: v.message, ...(target ? { target } : {}), ...(v.createNew ? { createNew: true, ...(v.checkout ? { checkout: v.checkout as string } : {}) } : {}), ...(kickoff ? { kickoff } : {}) }
}

/** Compare persisted input without rewriting it. Only destination aliases are
 * equivalent; every other payload field (including exact target) stays exact. */
export function equivalentHandoffInputs(a: HandoffInput, b: HandoffInput): boolean {
  if (!isStoredSlot(a.to) || !isStoredSlot(b.to)) return false
  const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left)
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]))
  }
  return equal({ ...a, to: canonicalSlot(a.to) }, { ...b, to: canonicalSlot(b.to) })
}
