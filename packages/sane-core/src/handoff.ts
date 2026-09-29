import type { HandoffInput } from "./contracts.ts"
import { DomainError } from "./errors.ts"

export const handoffSchema = {
  type: "object", properties: {
    requestId: { type: "string", minLength: 1, maxLength: 200 },
    to: { type: "string", minLength: 1 }, message: { type: "string", minLength: 1, maxLength: 32000 },
    target: { type: "object", properties: { harness: { enum: ["cc", "oc"] }, authorityId: { type: "string" }, nativeId: { type: "string" } }, required: ["harness", "authorityId", "nativeId"], additionalProperties: false },
    createNew: { type: "boolean" }, harness: { enum: ["cc", "oc"] }, checkout: { type: "string" },
  }, required: ["requestId", "to", "message"], additionalProperties: false,
} as const

export function handoffInput(input: unknown): HandoffInput {
  const invalid = (): never => { throw new DomainError("INVALID_INPUT", "Invalid handoff arguments; use an explicit requestId, destination and bounded message.") }
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalid()
  const v = input as Record<string, unknown>
  const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max && !v.includes("\0")
  if (Object.keys(v).some(k => !Object.hasOwn(handoffSchema.properties, k)) || !text(v.requestId, 200) || !text(v.message, 32000) || typeof v.to !== "string" || !/^(design|engineering|planning|execution|research|research:[a-z0-9][a-z0-9_-]{0,95})$/.test(v.to)) return invalid()
  if (v.createNew !== undefined && typeof v.createNew !== "boolean" || v.harness !== undefined && v.harness !== "cc" && v.harness !== "oc" || v.checkout !== undefined && (!text(v.checkout, 4096) || !v.checkout.startsWith("/"))) return invalid()
  let target: HandoffInput["target"]
  if (v.target !== undefined) {
    if (!v.target || typeof v.target !== "object" || Array.isArray(v.target)) return invalid()
    const t = v.target as Record<string, unknown>
    if (Object.keys(t).length !== 3 || t.harness !== "cc" && t.harness !== "oc" || !text(t.authorityId, 200) || !text(t.nativeId, 200)) return invalid()
    target = { harness: t.harness, authorityId: t.authorityId, nativeId: t.nativeId }
  }
  if (v.createNew ? !!target || !v.harness : v.harness !== undefined || v.checkout !== undefined) return invalid()
  return { requestId: v.requestId, to: v.to as HandoffInput["to"], message: v.message, ...(target ? { target } : {}), ...(v.createNew ? { createNew: true, harness: v.harness as HandoffInput["harness"], ...(v.checkout ? { checkout: v.checkout as string } : {}) } : {}) }
}
