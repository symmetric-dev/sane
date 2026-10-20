import { CODE_SHARE_LIMITS, parseCodeShareInput, resolveCodeShareLanguage, type CodeShareInput, type CodeShareLanguage } from "../../sane-cli/src/native-share-code-contract"

export { CODE_SHARE_LIMITS, parseCodeShareInput, resolveCodeShareLanguage }
export type { CodeShareHighlight, CodeShareInput, CodeShareLanguage, CodeShareReceipt, NativeCodeShareRequest } from "../../sane-cli/src/native-share-code-contract"

export interface CodeShareRecord {
  version: 1
  id: string
  sessionId: string
  native: { harness: "cc" | "oc"; authorityId: string; nativeId: string }
  anchor: { runId: string; toolCallId: string; messageId: string | null; invocationId: string; wrapper: "execute" | null }
  workspaceId: string
  worktreeId: string
  bindingRevision: string
  sourceRevision: string
  language: CodeShareLanguage
  createdAt: string
  input: CodeShareInput
  code: string
}

export function isCodeShareRecord(value: unknown): value is CodeShareRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as CodeShareRecord
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value)
  if (v.version !== 1 || ![v.id, v.sessionId, v.workspaceId, v.worktreeId, v.bindingRevision, v.sourceRevision, v.createdAt].every(text) || !Number.isFinite(Date.parse(v.createdAt)) || typeof v.code !== "string" || v.code.length > CODE_SHARE_LIMITS.bytes || new TextEncoder().encode(v.code).length > CODE_SHARE_LIMITS.bytes || v.code.includes("\r")) return false
  if (!v.native || !["cc", "oc"].includes(v.native.harness) || ![v.native.authorityId, v.native.nativeId].every(text) || !v.anchor || ![v.anchor.runId, v.anchor.toolCallId, v.anchor.invocationId].every(text) || v.anchor.messageId !== null && !text(v.anchor.messageId) || v.anchor.wrapper !== null && v.anchor.wrapper !== "execute") return false
  try {
    const input = parseCodeShareInput(v.input)
    return v.language === resolveCodeShareLanguage(input.path, input.format) && v.code.split("\n").length === input.endLine - input.startLine + 1
  } catch { return false }
}
