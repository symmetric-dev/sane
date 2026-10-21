import { CODE_SHARE_LIMITS, codeShareInputSnippets, parseCodeShareInput, parseCodeShareSnippet, resolveCodeShareLanguage, type CodeShareSnippetInput, type CodeShareSnippetsInput, type CodeShareLanguage } from "../../sane-cli/src/native-share-code-contract"

export { CODE_SHARE_LIMITS, codeShareInputSnippets, parseCodeShareInput, resolveCodeShareLanguage }
export type { CodeShareHighlight, CodeShareInput, CodeShareSnippetInput, CodeShareSnippetsInput, CodeShareLanguage, CodeShareReceipt, NativeCodeShareRequest } from "../../sane-cli/src/native-share-code-contract"

interface CodeShareIdentity {
  id: string
  sessionId: string
  native: { harness: "cc" | "oc"; authorityId: string; nativeId: string }
  anchor: { runId: string; toolCallId: string; messageId: string | null; invocationId: string; wrapper: "execute" | null }
  workspaceId: string
  worktreeId: string
  bindingRevision: string
  createdAt: string
}
export interface CodeShareSnapshot {
  sourceRevision: string
  language: CodeShareLanguage
  input: CodeShareSnippetInput
  code: string
}
export interface SingleCodeShareRecord extends CodeShareIdentity, CodeShareSnapshot { version: 1 }
export interface MultiCodeShareRecord extends CodeShareIdentity { version: 2; input: CodeShareSnippetsInput; snippets: CodeShareSnapshot[] }
export type CodeShareRecord = SingleCodeShareRecord | MultiCodeShareRecord

/** Old snapshots are one-page shares; no rewriting of historical records. */
export function codeSharePages(share: CodeShareRecord): readonly CodeShareSnapshot[] {
  return share.version === 1 ? [share] : share.snippets
}

function isSnapshot(value: unknown): value is CodeShareSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as CodeShareSnapshot
  if (typeof v.sourceRevision !== "string" || !/^[a-f0-9]{64}$/.test(v.sourceRevision) || typeof v.code !== "string" || v.code.length > CODE_SHARE_LIMITS.bytes || new TextEncoder().encode(v.code).length > CODE_SHARE_LIMITS.bytes || /[\r\0]/.test(v.code)) return false
  try {
    const input = parseCodeShareSnippet(v.input)
    return v.language === resolveCodeShareLanguage(input.path, input.format) && v.code.split("\n").length === input.endLine - input.startLine + 1
  } catch { return false }
}

export function isCodeShareRecord(value: unknown): value is CodeShareRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as CodeShareRecord
  const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value)
  if ((v.version !== 1 && v.version !== 2) || ![v.id, v.sessionId, v.workspaceId, v.worktreeId, v.bindingRevision, v.createdAt].every(text) || !Number.isFinite(Date.parse(v.createdAt))) return false
  if (!v.native || !["cc", "oc"].includes(v.native.harness) || ![v.native.authorityId, v.native.nativeId].every(text) || !v.anchor || ![v.anchor.runId, v.anchor.toolCallId, v.anchor.invocationId].every(text) || v.anchor.messageId !== null && !text(v.anchor.messageId) || v.anchor.wrapper !== null && v.anchor.wrapper !== "execute") return false
  if (v.version === 1) return isSnapshot(v)
  if (!Array.isArray(v.snippets) || v.snippets.length < 1 || v.snippets.length > CODE_SHARE_LIMITS.snippets || !v.snippets.every(isSnapshot)) return false
  try {
    const input = parseCodeShareInput(v.input)
    return "snippets" in input && input.snippets.length === v.snippets.length
      && input.snippets.every((snippet, index) => JSON.stringify(snippet) === JSON.stringify(parseCodeShareSnippet(v.snippets[index].input)))
      && v.snippets.reduce((bytes, snippet) => bytes + new TextEncoder().encode(snippet.code).length, 0) <= CODE_SHARE_LIMITS.totalBytes
  } catch { return false }
}
