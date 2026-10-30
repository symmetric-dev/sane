import { MEDIA_SHARE_LIMITS, parseMediaShareInput, type StoredMediaShareInput } from "../../sane-cli/src/native-share-media-contract"

export * from "../../sane-cli/src/native-share-media-contract"

export type MediaShareMimeType = "image/png" | "image/jpeg" | "image/webp" | "video/mp4"
export interface MediaShareItem {
  id: string
  path: string
  kind: "image" | "video"
  mimeType: MediaShareMimeType
  bytes: number
  sha256: string
}
export interface MediaShareRecord {
  version: 1
  id: string
  sessionId: string
  native: { harness: "cc" | "oc" | "gk"; authorityId: string; nativeId: string }
  anchor: { runId: string; toolCallId: string; messageId: string | null; invocationId: string; wrapper: "execute" | null }
  workspaceId: string
  worktreeId: string
  bindingRevision: string
  createdAt: string
  input: StoredMediaShareInput
  media: MediaShareItem[]
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key)) }
const token = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$(?![\s\S])/.test(value)
const invocationUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/i
const nativeUUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/i
const mimeByExtension: Record<string, MediaShareMimeType> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp4: "video/mp4" }

/** Public metadata only. Blob locations and binary payloads must never become
 * record fields; strict keys also apply to every nested object. */
export function isMediaShareRecord(value: unknown): value is MediaShareRecord {
  if (!object(value) || !exact(value, ["version", "id", "sessionId", "native", "anchor", "workspaceId", "worktreeId", "bindingRevision", "createdAt", "input", "media"])) return false
  if (value.version !== 1 || !digest(value.id) || ![value.sessionId, value.workspaceId, value.worktreeId, value.bindingRevision, value.createdAt].every(token) || !Number.isFinite(Date.parse(value.createdAt as string))) return false
  const native = value.native, anchor = value.anchor
  if (!object(native) || !exact(native, ["harness", "authorityId", "nativeId"]) || !["cc", "oc", "gk"].includes(native.harness as string) || ![native.authorityId, native.nativeId].every(token)) return false
  if (!object(anchor) || !exact(anchor, ["runId", "toolCallId", "messageId", "invocationId", "wrapper"]) || ![anchor.runId, anchor.toolCallId, anchor.invocationId].every(token) || anchor.messageId !== null && !token(anchor.messageId) || anchor.wrapper !== null && anchor.wrapper !== "execute") return false
  if (native.harness === "oc") {
    if (!token(anchor.messageId) || !invocationUUID.test(anchor.invocationId as string)) return false
  } else if (anchor.wrapper !== null || anchor.invocationId !== anchor.toolCallId) return false
  if (native.harness === "gk" && (!/^sane-native-v1:gk:[a-f0-9]{64}$(?![\s\S])/.test(native.authorityId as string) || !nativeUUID.test(native.nativeId as string))) return false
  try {
    const input = parseMediaShareInput(value.input)
    if (!Array.isArray(value.media) || value.media.length !== input.media.length) return false
    let totalBytes = 0
    const itemIds = new Set<string>()
    for (let index = 0; index < value.media.length; index++) {
      const item: unknown = value.media[index]
      if (!object(item) || !exact(item, ["id", "path", "kind", "mimeType", "bytes", "sha256"]) || !digest(item.id) || !digest(item.sha256) || item.path !== input.media[index]!.path) return false
      if (itemIds.has(item.id)) return false
      itemIds.add(item.id)
      const extension = input.media[index]!.path.slice(input.media[index]!.path.lastIndexOf(".") + 1).toLowerCase()
      const mimeType = mimeByExtension[extension]
      const kind = mimeType === "video/mp4" ? "video" : "image"
      if (!mimeType || item.mimeType !== mimeType || item.kind !== kind || typeof item.bytes !== "number" || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > (kind === "video" ? MEDIA_SHARE_LIMITS.videoBytes : MEDIA_SHARE_LIMITS.imageBytes)) return false
      totalBytes += item.bytes
      if (totalBytes > MEDIA_SHARE_LIMITS.totalBytes) return false
    }
    return true
  } catch { return false }
}
