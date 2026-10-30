import type { NativeSourceDescriptor } from "../../sane-core/src/contracts.ts"

export const MEDIA_SHARE_LIMITS = {
  path: 4096,
  items: 16,
  imageBytes: 10 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  totalBytes: 200 * 1024 * 1024,
  sessionBytes: 512 * 1024 * 1024,
  storeBytes: 2 * 1024 * 1024 * 1024,
  shares: 2000,
  sessionShares: 128,
  inputBytes: 128 * 1024,
  pixels: 40_000_000,
  dimension: 16384,
  captureMs: 30000,
  concurrentCaptures: 2,
} as const

export interface MediaShareItemInput { path: string }
export interface MediaShareInput { media: MediaShareItemInput[] }
export interface NativeMediaShareRequest {
  version: 1
  caller: { source: NativeSourceDescriptor; authorityId: string; nativeId: string; cwd: string }
  invocation: { toolCallId: string; messageId?: string; invocationId: string; wrapper?: "execute" }
  input: MediaShareInput
}
export interface MediaShareReceipt {
  type: "sane.media-share"
  version: 1
  shareId: string
  media: MediaShareItemInput[]
}

export const nativeShareMediaDescription = "Show local images and MP4 videos in an App chat gallery. Always supply a media array, even for one file; each item contains only a path. Files are read from the conversation's execution checkout and saved as frozen snapshots, not live file links. Protected paths may be unavailable; this tool does not grant additional workspace access. Supported extensions: png, jpg, jpeg, webp, and mp4 (case-insensitive). PNG/WebP must be static; APNG, animated WebP, fragmented MP4, and unsupported MP4 brands are rejected. Video codec playback depends on the browser. Supply 1–16 files in display order; repeated paths are allowed. Limits: 10 MiB per image, 100 MiB per video, 200 MiB total, and 128 KiB of serialized arguments. Images are limited to 40 million pixels and 16,384 pixels per dimension. Only workspace-relative file paths are accepted, never absolute paths, traversal, backslashes, globs, directories, or URLs. No inline content, captions, supplied metadata, actions, or remote URLs in v1. Available only in App-admitted conversations; does not require workstream enrollment."

// Use the same expression in JSON Schema and the parser. Colons also exclude
// URI schemes and drive prefixes; glob syntax is never expanded or accepted.
const mediaPathPattern = "^(?![\\s\\S]*[\\u0000-\\u001f\\u007f-\\u009f\\\\:*?\\[\\]{}])(?!(?:[\\s\\S]*/)?\\.{1,2}(?:/|$))(?:[^/]+/)*[^/]+\\.(?:[pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP]|[mM][pP]4)$(?![\\s\\S])"
const mediaPath = new RegExp(mediaPathPattern)

export const nativeShareMediaSchema = {
  type: "object", additionalProperties: false, required: ["media"],
  properties: {
    media: {
      type: "array", minItems: 1, maxItems: MEDIA_SHARE_LIMITS.items,
      description: "Ordered local image/MP4 files. Required even for one file; duplicate paths are allowed.",
      items: {
        type: "object", additionalProperties: false, required: ["path"],
        properties: {
          path: {
            type: "string", minLength: 1, maxLength: MEDIA_SHARE_LIMITS.path, pattern: mediaPathPattern,
            description: "File relative to the execution checkout, subject to workspace safe-path policy. Protected paths may be unavailable. No absolute paths, traversal, empty segments, backslashes, globs, directories, or URLs. Supported extensions: png, jpg, jpeg, webp, mp4.",
          },
        },
      },
    },
  },
} as const

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key)) }
// JSON Schema maxLength measures Unicode code points, not UTF-16 code units.
function withinLength(value: string, maximum: number): boolean {
  if (value.length > maximum * 2) return false
  let length = 0
  for (const _ of value) if (++length > maximum) return false
  return true
}

/** Validate only the wire input; filesystem confinement and file decoding belong
 * to the workspace reader. Preserve exact paths, duplicates, and display order. */
export function parseMediaShareInput(input: unknown): MediaShareInput {
  const invalid = (): never => { throw new Error("Invalid media share: supply media with 1–16 relative PNG, JPEG, WebP, or MP4 file paths and no other fields. Absolute paths, traversal, backslashes, globs, directories, and URLs are not accepted.") }
  if (!object(input) || !exact(input, ["media"]) || !Array.isArray(input.media) || input.media.length < 1 || input.media.length > MEDIA_SHARE_LIMITS.items) return invalid()
  const media: MediaShareItemInput[] = []
  for (const item of input.media) {
    if (!object(item) || !exact(item, ["path"]) || typeof item.path !== "string" || !withinLength(item.path, MEDIA_SHARE_LIMITS.path) || !mediaPath.test(item.path)) return invalid()
    media.push({ path: item.path })
  }
  const result = { media }
  const serialized = JSON.stringify(result)
  if (serialized.length > MEDIA_SHARE_LIMITS.inputBytes || new TextEncoder().encode(serialized).length > MEDIA_SHARE_LIMITS.inputBytes) throw new Error("Media share arguments exceed 128 KiB.")
  return result
}
