import { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { randomUUID } from "node:crypto"
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs"
import type { BigIntStats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, sep } from "node:path"

const endpoint = "https://cli-chat-proxy.grok.com/v1/images/generations"
const editEndpoint = "https://cli-chat-proxy.grok.com/v1/images/edits"
const model = "grok-imagine-image-2.0"
const imageAspectRatios = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1", "21:9", "5:2", "auto"] as const
const maxResponseBytes = 96 * 1024 * 1024
const maxImageBytes = 16 * 1024 * 1024
const maxReferenceBytes = 16 * 1024 * 1024
const maxTotalReferenceBytes = 40 * 1024 * 1024
const timeoutMs = 180_000
const uncertain = "The image request may already have completed and been billed. No retry was made; do not retry automatically."

class ImagineError extends Error {}
class PreflightAbort extends ImagineError {
  constructor() {
    super("Cancelled or timed out before the image request; no request was sent.")
  }
}

type Image = { index: number; bytes: Buffer; base64: string; mime: string; extension: string }
type SavedImage = { index: number; path: string; relativePath: string; mime: string; bytes: number }
type ImageSave = SavedImage & { status: "saved" | "failed" | "uncertain"; created: boolean; writeComplete: boolean }

function parseInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ImagineError("Expected an object with a prompt.")
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !["prompt", "resolution", "n", "aspect_ratio"].includes(key))) throw new ImagineError("Only prompt, resolution, n, and aspect_ratio are supported.")
  if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 32_000) throw new ImagineError("Prompt must contain 1–32000 characters and cannot be blank.")
  const resolution = value.resolution === undefined ? "1k" : value.resolution
  const n = value.n === undefined ? 1 : value.n
  if (resolution !== "1k" && resolution !== "2k") throw new ImagineError("Resolution must be 1k or 2k.")
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 4) throw new ImagineError("n must be an integer from 1 to 4.")
  const aspect_ratio = imageAspectRatios.find(ratio => ratio === value.aspect_ratio)
  if (value.aspect_ratio !== undefined && (typeof value.aspect_ratio !== "string" || aspect_ratio === undefined)) throw new ImagineError(`Aspect ratio must be one of: ${imageAspectRatios.join(", ")}.`)
  return { prompt: value.prompt, resolution, n, ...(aspect_ratio === undefined ? {} : { aspect_ratio }) }
}

function parseEditInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ImagineError("Expected an object with a prompt and images.")
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !["prompt", "images", "resolution", "n", "aspect_ratio"].includes(key))) throw new ImagineError("Only prompt, images, resolution, n, and aspect_ratio are supported for editing.")
  const args = parseInput({ prompt: value.prompt, resolution: value.resolution, n: value.n })
  if (!Array.isArray(value.images) || value.images.length < 1 || value.images.length > 5) throw new ImagineError("Images must contain 1–5 ordered workspace-relative file paths.")
  const aspect_ratio = value.aspect_ratio === undefined ? "auto" : imageAspectRatios.find(ratio => ratio === value.aspect_ratio)
  if (aspect_ratio === undefined) throw new ImagineError(`Aspect ratio must be one of: ${imageAspectRatios.join(", ")}.`)
  if (value.images.length === 1 && aspect_ratio !== "auto") throw new ImagineError("Fixed aspect ratios are supported only for multi-image editing with 2–5 reference images; with one image, omit aspect_ratio or use auto.")
  const images = Array.from(value.images, path => {
    if (typeof path !== "string" || !path || isAbsolute(path) || /[\\:*?[\]{}()!\u0000-\u001f\u007f]/.test(path) ||
      path.split("/").some(component => !component || component === "." || component === "..")) {
      throw new ImagineError("Reference images must be workspace-relative paths without URLs, data URIs, absolute paths, traversal, backslashes, or glob syntax.")
    }
    return path
  })
  return { ...args, images, aspect_ratio }
}

async function waitForReference<T>(signal: AbortSignal, check: () => void, start: () => Promise<T>) {
  check()
  try {
    const value = await waitFor(signal, start)
    check()
    return value
  } catch (error) {
    check()
    throw error
  }
}

async function inspectReference(root: string, reference: string, signal: AbortSignal, check: () => void) {
  const path = join(root, reference)
  const local = relative(root, path)
  if (!local || isAbsolute(local) || local.split(sep).includes("..")) throw new ImagineError("Reference image escaped the calling checkout.")
  const directory = await waitForReference(signal, check, () => lstat(root, { bigint: true }))
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new ImagineError("Refusing a directory containing a symlink or a non-directory component.")
  let ancestor = root
  const components = reference.split("/")
  for (const component of components.slice(0, -1)) {
    ancestor = join(ancestor, component)
    const stat = await waitForReference(signal, check, () => lstat(ancestor, { bigint: true }))
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ImagineError("Reference image ancestors must be real directories, not symlinks.")
  }
  const stat = await waitForReference(signal, check, () => lstat(path, { bigint: true }))
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ImagineError("Reference images must be regular files, not symlinks or special files.")
  if (await waitForReference(signal, check, () => realpath(path)) !== path) throw new ImagineError("Reference image confinement check failed.")
  return { path, stat }
}

function sameReference(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function readReference(root: string, reference: string, remaining: number, signal: AbortSignal, check: () => void) {
  check()
  let file: Awaited<ReturnType<typeof open>> | undefined
  let pending: Promise<unknown> = Promise.resolve()
  const run = <T>(start: () => Promise<T>) => waitForReference(signal, check, () => {
    const operation = start()
    pending = operation
    return operation
  })
  try {
    try {
      const before = await inspectReference(root, reference, signal, check)
      const handle = await run(() => open(before.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).then(handle => {
        file = handle
        return handle
      }))
      const opened = await run(() => handle.stat({ bigint: true }))
      const after = await inspectReference(root, reference, signal, check)
      if (!opened.isFile() || !sameReference(opened, before.stat) || !sameReference(opened, after.stat)) throw new ImagineError("Reference image changed while opening it.")
      if (opened.size > BigInt(maxReferenceBytes)) throw new ImagineError("Reference image exceeds the client resource cap of 16 MiB per reference (not a provider limit).")
      if (opened.size > BigInt(remaining)) throw new ImagineError("Reference images exceed the client resource cap of 40 MiB total raw bytes (not a provider limit).")
      const chunks: Buffer[] = []
      const limit = Math.min(maxReferenceBytes, remaining)
      let size = 0
      while (true) {
        check()
        const chunk = Buffer.alloc(Math.min(64 * 1024, limit - size + 1))
        const { bytesRead } = await run(() => handle.read(chunk, 0, chunk.length, size))
        check()
        if (!bytesRead) break
        size += bytesRead
        if (size > maxReferenceBytes) throw new ImagineError("Reference image exceeds the client resource cap of 16 MiB per reference (not a provider limit).")
        if (size > remaining) throw new ImagineError("Reference images exceed the client resource cap of 40 MiB total raw bytes (not a provider limit).")
        chunks.push(chunk.subarray(0, bytesRead))
      }
      if (!size) throw new ImagineError("Reference images cannot be empty.")
      const finalOpened = await run(() => handle.stat({ bigint: true }))
      const final = await inspectReference(root, reference, signal, check)
      // Detect ordinary changes, not a race-proof snapshot against malicious same-UID writers.
      if (BigInt(size) !== opened.size || !sameReference(opened, finalOpened) || !sameReference(opened, final.stat)) throw new ImagineError("Reference image changed while reading it.")
      check()
      const bytes = Buffer.concat(chunks, size)
      const type = imageType(bytes)
      return { bytes: size, url: `data:${type.mime};base64,${bytes.toString("base64")}` }
    } finally {
      // Stop waiting on abort, but close once only after a late open/read/stat has settled.
      // The kernel operation itself cannot be interrupted; observe detached cleanup failures.
      const cleanup = pending.then(() => file?.close(), () => file?.close())
      void cleanup.catch(() => {})
      await waitForReference(signal, check, () => cleanup)
    }
  } catch (error) {
    check()
    if (error instanceof ImagineError) throw error
    throw new ImagineError("Cannot safely read a reference image in the calling checkout; no editing request was sent. File details were suppressed.")
  }
}

function assertRuntime(ctx: Plugin.Context) {
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(ctx.app?.version ?? "")
  if (!version || Number(version[1]) !== 2 || Number(version[2]) < 2 ||
    typeof ctx.integration?.connection?.active !== "function" ||
    typeof ctx.integration?.connection?.resolve !== "function" ||
    typeof ctx.permission?.assert !== "function" || typeof ctx.session?.get !== "function" ||
    typeof AbortSignal.any !== "function" || typeof AbortSignal.timeout !== "function" ||
    !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    throw new ImagineError("Grok Imagine requires released OpenCode V2 2.2.0+ with shared OAuth resolution, permission.assert, cancellation, and safe local file APIs. No compatibility fallback is available.")
  }
}

function waitFor<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => {
      cleanup()
      reject(new PreflightAbort())
    }
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    // Only stop waiting: shared OAuth refresh must finish and persist independently.
    // Both handlers also observe late settlement after cancellation; no late continuation sends a POST.
    try {
      start().then(value => {
        cleanup()
        if (signal.aborted) return abort()
        resolve(value)
      }, error => {
        cleanup()
        reject(error)
      })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

async function assertPermission(ctx: Plugin.Context, tool: ToolContext, signal: AbortSignal, action: string, resource: string) {
  await waitFor(signal, () => ctx.permission.assert({
    sessionID: tool.sessionID,
    agent: tool.agent,
    source: { type: "tool", messageID: tool.messageID, id: tool.id },
    action,
    resources: [resource],
    save: [resource],
  }))
}

// Trusted local checkout only: these checks are not race-proof against malicious same-UID ancestor swaps.
function inspectDirectory(path: string) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ImagineError("Refusing a directory containing a symlink or a non-directory component.")
  return stat
}

function checkoutDirectory(directory: string) {
  if (!isAbsolute(directory)) throw new ImagineError("The calling session has no absolute local checkout directory.")
  const root = realpathSync(directory)
  inspectDirectory(root)
  return root
}

function prepareOutput(root: string, id: string) {
  let path = root
  for (const component of [".opencode", "grok-imagine", id]) {
    path = join(path, component)
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || component === id) throw error
    }
    const stat = inspectDirectory(path)
    if (component !== ".opencode" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      throw new ImagineError("Grok Imagine output directories must be owned by the current user and private (mode 0700).")
    }
  }
  if (realpathSync(path) !== path || !path.startsWith(root + sep)) throw new ImagineError("Output directory escaped the calling checkout.")
  return path
}

function saveImages(root: string, directory: string, images: Image[]) {
  const saves: ImageSave[] = []
  for (const image of images) {
    const path = join(directory, `${image.index + 1}.${image.extension}`)
    const receipt: ImageSave = {
      index: image.index, path, relativePath: relative(root, path), mime: image.mime, bytes: image.bytes.length,
      status: "failed", created: false, writeComplete: false,
    }
    let fd: number | undefined
    try {
      for (const path of [root, join(root, ".opencode"), join(root, ".opencode/grok-imagine"), directory]) inspectDirectory(path)
      if (realpathSync(directory) !== directory) throw new ImagineError("Output directory changed.")
      const before = lstatSync(directory)
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      receipt.created = true
      const after = lstatSync(directory)
      if (before.dev !== after.dev || before.ino !== after.ino || realpathSync(directory) !== directory) throw new ImagineError("Output directory changed.")
      const file = fstatSync(fd)
      if (!file.isFile() || file.nlink !== 1) throw new ImagineError("Output is not a private regular file.")
      writeFileSync(fd, image.bytes)
      receipt.writeComplete = true
    } catch {
      // Keep any partial file in place and report its path; never delete or regenerate it automatically.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
          if (receipt.writeComplete) receipt.status = "saved"
        } catch {
          receipt.status = "uncertain"
        }
      }
    }
    saves.push(receipt)
  }
  const saved = saves.filter(receipt => receipt.status === "saved")
  return { saved, saves, failed: saves.length - saved.length }
}

function imageType(bytes: Buffer) {
  // Signature and basic container checks, not full image decode validation.
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 &&
    bytes.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) return { mime: "image/png", extension: "png" }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return { mime: "image/jpeg", extension: "jpg" }
  if (bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return { mime: "image/webp", extension: "webp" }
  throw new ImagineError("Unsupported or invalid image signature; only PNG, JPEG, and WebP are accepted.")
}

function parseImages(value: unknown) {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) throw new ImagineError(`Proxy response did not contain an image data array. ${uncertain}`)
  const data = (value as { data: unknown[] }).data
  const images: Image[] = []
  let invalid = 0
  for (const [index, item] of data.entries()) {
    try {
      if (!item || typeof item !== "object") throw new ImagineError("Invalid image entry.")
      const entry = item as Record<string, unknown>
      const base64 = entry.b64_json
      if (typeof base64 !== "string" || !base64.length || base64.length > 4 * Math.ceil(maxImageBytes / 3) ||
        base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new ImagineError("Invalid image base64.")
      const bytes = Buffer.from(base64, "base64")
      if (bytes.length > maxImageBytes || bytes.toString("base64") !== base64) throw new ImagineError("Invalid image encoding or size.")
      const type = imageType(bytes)
      for (const claimed of [entry.mime, entry.mime_type]) {
        if (claimed !== undefined && claimed !== type.mime) throw new ImagineError("Image MIME does not match its bytes.")
      }
      images.push({ index, bytes, base64, ...type })
    } catch {
      invalid++
    }
  }
  return { images, invalid, returned: data.length }
}

async function readResponse(response: Response) {
  const length = response.headers.get("content-length")
  if (length && /^\d+$/.test(length) && Number(length) > maxResponseBytes) throw new ImagineError(`Proxy response exceeds the 96 MiB limit. ${uncertain}`)
  const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mime !== "application/json" && !mime?.endsWith("+json")) throw new ImagineError(`Proxy response is not JSON. ${uncertain}`)
  if (!response.body) throw new ImagineError(`Proxy returned an empty response. ${uncertain}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxResponseBytes) throw new ImagineError(`Proxy response exceeds the 96 MiB limit. ${uncertain}`)
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown
  } catch {
    throw new ImagineError(`Proxy returned invalid JSON or UTF-8. ${uncertain}`)
  }
}

export const GrokImaginePlugin = Plugin.define({
  id: "grok-imagine",
  async setup(ctx) {
    assertRuntime(ctx)
    await ctx.tool.transform(editor => {
      editor.add({
        name: "grok_image_generate",
        description: "Use Grok Imagine to generate images only when the user asks to create an image. Use 1k and one output by default; request 2k or multiple outputs only when the user explicitly asks. Supply aspect_ratio only when the user explicitly requests an output ratio; otherwise omit it. Generation only: no editing or reference images. Uses existing xAI OAuth with an experimental, unverified CLI proxy image endpoint; aspect-ratio acceptance, entitlement, and billing are unverified. Never retry automatically. Saves and returns every valid output as model-delivery files; text-only models cannot see pixels. Human display is separate (SANE share_media when requested); this tool does not share automatically.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 32_000 },
            aspect_ratio: { type: "string", enum: [...imageAspectRatios], description: "Requested output ratio or auto (service-selected ratio). Supply only when the user explicitly requests a ratio; otherwise omit. CLI proxy acceptance is unverified." },
            resolution: { type: "string", enum: ["1k", "2k"], default: "1k" },
            n: { type: "integer", minimum: 1, maximum: 4, default: 1 },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        options: { permission: "grok_image_generate", codemode: true },
        execute: async (input, tool) => {
          const timeout = AbortSignal.timeout(timeoutMs)
          assertRuntime(ctx)
          if (!tool.signal || typeof tool.signal.aborted !== "boolean") throw new ImagineError("OpenCode must provide the V2 tool cancellation signal.")
          const signal = AbortSignal.any([tool.signal, timeout])
          if (signal.aborted) throw new PreflightAbort()
          const args = parseInput(input)
          await assertPermission(ctx, tool, signal, "grok_image_generate", endpoint)
          const session = await waitFor(signal, () => ctx.session.get({ sessionID: tool.sessionID }))
          // Released Core selects tool snapshots only after matching the native session's full Location.
          // The public session response omits workspaceID; use the bound plugin Location, not host path existence.
          if (ctx.location.workspaceID !== undefined) throw new ImagineError("Grok Imagine only supports local checkout sessions, not remote workspaces.")
          if (session.id !== tool.sessionID || session.location.directory !== ctx.location.directory) throw new ImagineError("The calling session does not match this plugin's local checkout; no generation request was sent.")
          let root: string
          try {
            root = checkoutDirectory(ctx.location.directory)
          } catch (error) {
            if (error instanceof ImagineError) throw error
            throw new ImagineError("Cannot safely locate the calling session's local checkout.")
          }
          const id = randomUUID()
          const output = join(root, ".opencode", "grok-imagine", id)
          await assertPermission(ctx, tool, signal, "edit", join(root, ".opencode", "grok-imagine", "**"))
          let directory: string
          try {
            directory = prepareOutput(root, id)
          } catch (error) {
            if (error instanceof ImagineError) throw error
            throw new ImagineError("Cannot prepare private output files in the calling checkout; no generation request was sent.")
          }
          if (directory !== output) throw new ImagineError("Output confinement check failed; no generation request was sent.")
          let connection: Awaited<ReturnType<typeof ctx.integration.connection.active>>
          try {
            connection = await waitFor(signal, () => ctx.integration.connection.active("xai"))
          } catch (error) {
            if (error instanceof PreflightAbort) throw error
            throw new ImagineError("Cannot select the xAI OAuth connection. Use /connect xAI again; no generation request was sent.")
          }
          if (connection?.type !== "credential" || connection.method !== "oauth") throw new ImagineError("Select an xAI OAuth connection using /connect xAI. Environment variables, API keys, and external credentials are not supported.")
          const body = JSON.stringify({ model, ...args, quality: "auto", response_format: "b64_json" })
          let response: Response | undefined
          let beganPost = false
          try {
            let access: string
            try {
              const credential = await waitFor(signal, () => ctx.integration.connection.resolve(connection))
              if (credential?.type !== "oauth" || !credential.access || !/^[A-Za-z0-9._~+\/-]+=*$/.test(credential.access)) throw new ImagineError("Invalid OAuth access credential.")
              access = credential.access
            } catch (error) {
              if (error instanceof PreflightAbort) throw error
              throw new ImagineError("OpenCode could not resolve xAI OAuth. Use /connect xAI again; no generation request was sent. Credential details were suppressed.")
            }
            if (signal.aborted) throw new PreflightAbort()
            beganPost = true
            response = await fetch(endpoint, {
              method: "POST",
              headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
              body,
              redirect: "error",
              signal,
            })
            access = ""
            if (response.status === 401) throw new ImagineError("xAI rejected OAuth (401). Use /connect xAI again. No retry was made.")
            if (response.status === 403) throw new ImagineError("The fixed CLI proxy refused image generation (403). Proxy support and account entitlement are unverified. No retry was made.")
            if (!response.ok) throw new ImagineError(`CLI proxy image request failed (HTTP ${response.status}). ${uncertain}`)
            const parsed = parseImages(await readResponse(response))
            const { saved, saves, failed } = saveImages(root, directory, parsed.images)
            const warnings: string[] = []
            if (parsed.returned !== args.n) warnings.push(`Output count mismatch: requested ${args.n}, received ${parsed.returned}. Every valid returned image was retained; no retry was made.`)
            if (parsed.invalid) warnings.push(`${parsed.invalid} returned entries were invalid, unsupported, or exceeded the 16 MiB per-image limit; they were not saved or delivered.`)
            if (failed) warnings.push(`${failed} valid images could not be confirmed saved safely. See saves for failed or uncertain status and any partial file paths. They are still included as file content for model delivery; do not regenerate automatically.`)
            if (!parsed.images.length) warnings.push(`No valid images were returned. ${uncertain}`)
            const metadata = { model, resolution: args.resolution, ...(args.aspect_ratio === undefined ? {} : { aspect_ratio: args.aspect_ratio }), requested: args.n, returned: parsed.returned, delivered: parsed.images.length, saved, saves, warnings }
            return {
              content: [
                { type: "text", text: JSON.stringify(metadata) },
                ...parsed.images.map(image => ({ type: "file" as const, uri: `data:${image.mime};base64,${image.base64}`, mime: image.mime, name: `${image.index + 1}.${image.extension}` })),
              ],
              metadata,
            }
          } catch (error) {
            if (error instanceof ImagineError) throw error
            if (!beganPost) throw new ImagineError("Image generation preflight failed; no generation request was sent. Error details were suppressed.")
            throw new ImagineError(`${signal.aborted ? "Image generation was cancelled or timed out." : "Image generation transport or response processing failed."} ${uncertain} Error details were suppressed.`)
          } finally {
            await response?.body?.cancel().catch(() => {})
          }
        },
      })
      editor.add({
        name: "grok_image_edit",
        description: "Use Grok Imagine to edit images only when the user asks for an image edit. Images are 1–5 ordered workspace-relative PNG, JPEG, or WebP paths; their bytes are uploaded to xAI. No URLs, data URIs, absolute paths, traversal, symlinks, backslashes, globs, or masks. With one image, omit aspect_ratio or use auto; it is never sent. With 2–5 images, aspect_ratio defaults to auto (service-selected ratio); use a fixed ratio only when explicitly requested. Use 1k and one output by default; request 2k or multiple outputs only when explicitly requested. Client resource caps are 16 MiB per reference and 40 MiB total raw input, not provider limits; originals are never modified or recompressed. Uses existing xAI OAuth and an experimental, unverified fixed CLI proxy endpoint. The proxy may refuse inputs; editing support, input sizes, aspect ratios, 2k, multiple outputs, entitlement, and billing are unverified. Never retry automatically. Saves and returns every valid output as model-delivery files; text-only models cannot see pixels. Human display is separate (SANE share_media when requested); this tool does not share automatically.",
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 32_000 },
            images: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 },
            aspect_ratio: { type: "string", enum: [...imageAspectRatios], default: "auto", description: "For 2–5 reference images only: fixed output ratio or auto (service-selected ratio). With one image, omit or use auto; the field is never sent and the input ratio is auto-detected." },
            resolution: { type: "string", enum: ["1k", "2k"], default: "1k" },
            n: { type: "integer", minimum: 1, maximum: 4, default: 1 },
          },
          required: ["prompt", "images"],
          additionalProperties: false,
        },
        options: { permission: "grok_image_edit", codemode: true },
        execute: async (input, tool) => {
          const deadline = performance.now() + timeoutMs
          const timeout = AbortSignal.timeout(timeoutMs)
          assertRuntime(ctx)
          if (typeof constants.O_NONBLOCK !== "number") throw new ImagineError("Image editing requires nonblocking safe local file APIs.")
          if (!tool.signal || typeof tool.signal.aborted !== "boolean") throw new ImagineError("OpenCode must provide the V2 tool cancellation signal.")
          const signal = AbortSignal.any([tool.signal, timeout])
          const check = () => {
            if (signal.aborted || performance.now() >= deadline) throw new PreflightAbort()
          }
          check()
          const args = parseEditInput(input)
          check()
          await assertPermission(ctx, tool, signal, "grok_image_edit", editEndpoint)
          const session = await waitFor(signal, () => ctx.session.get({ sessionID: tool.sessionID }))
          if (ctx.location.workspaceID !== undefined) throw new ImagineError("Grok Imagine only supports local checkout sessions, not remote workspaces.")
          if (session.id !== tool.sessionID || session.location.directory !== ctx.location.directory) throw new ImagineError("The calling session does not match this plugin's local checkout; no editing request was sent.")
          let root: string
          try {
            root = checkoutDirectory(ctx.location.directory)
          } catch (error) {
            if (error instanceof ImagineError) throw error
            throw new ImagineError("Cannot safely locate the calling session's local checkout.")
          }
          const references: { url: string }[] = []
          let referenceBytes = 0
          for (const path of args.images) {
            check()
            await assertPermission(ctx, tool, signal, "read", join(root, path))
            const reference = await readReference(root, path, maxTotalReferenceBytes - referenceBytes, signal, check)
            referenceBytes += reference.bytes
            references.push({ url: reference.url })
          }
          check()
          const id = randomUUID()
          const output = join(root, ".opencode", "grok-imagine", id)
          await assertPermission(ctx, tool, signal, "edit", join(root, ".opencode", "grok-imagine", "**"))
          let directory: string
          try {
            directory = prepareOutput(root, id)
          } catch (error) {
            if (error instanceof ImagineError) throw error
            throw new ImagineError("Cannot prepare private output files in the calling checkout; no editing request was sent.")
          }
          if (directory !== output) throw new ImagineError("Output confinement check failed; no editing request was sent.")
          check()
          let connection: Awaited<ReturnType<typeof ctx.integration.connection.active>>
          try {
            connection = await waitFor(signal, () => ctx.integration.connection.active("xai"))
          } catch (error) {
            if (error instanceof PreflightAbort) throw error
            throw new ImagineError("Cannot select the xAI OAuth connection. Use /connect xAI again; no editing request was sent.")
          }
          if (connection?.type !== "credential" || connection.method !== "oauth") throw new ImagineError("Select an xAI OAuth connection using /connect xAI. Environment variables, API keys, and external credentials are not supported.")
          const body = JSON.stringify({
            model, prompt: args.prompt, resolution: args.resolution, n: args.n, quality: "auto", response_format: "b64_json",
            ...(references.length === 1 ? { image: references[0] } : { images: references, aspect_ratio: args.aspect_ratio }),
          })
          let response: Response | undefined
          let beganPost = false
          try {
            let access: string
            try {
              check()
              const credential = await waitFor(signal, () => ctx.integration.connection.resolve(connection))
              if (credential?.type !== "oauth" || !credential.access || !/^[A-Za-z0-9._~+\/-]+=*$/.test(credential.access)) throw new ImagineError("Invalid OAuth access credential.")
              access = credential.access
            } catch (error) {
              if (error instanceof PreflightAbort) throw error
              throw new ImagineError("OpenCode could not resolve xAI OAuth. Use /connect xAI again; no editing request was sent. Credential details were suppressed.")
            }
            check()
            beganPost = true
            response = await fetch(editEndpoint, {
              method: "POST",
              headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
              body,
              redirect: "error",
              signal,
            })
            access = ""
            if (response.status === 401) throw new ImagineError("xAI rejected OAuth (401). Use /connect xAI again. No retry was made.")
            if (response.status === 403) throw new ImagineError("The fixed CLI proxy refused image editing (403). Proxy support and account entitlement are unverified. No retry was made.")
            if (!response.ok) throw new ImagineError(`CLI proxy image editing request failed (HTTP ${response.status}). ${uncertain}`)
            const parsed = parseImages(await readResponse(response))
            const { saved, saves, failed } = saveImages(root, directory, parsed.images)
            const warnings: string[] = []
            if (parsed.returned !== args.n) warnings.push(`Output count mismatch: requested ${args.n}, received ${parsed.returned}. Every valid returned image was retained; no retry was made.`)
            if (parsed.invalid) warnings.push(`${parsed.invalid} returned entries were invalid, unsupported, or exceeded the 16 MiB per-image limit; they were not saved or delivered.`)
            if (failed) warnings.push(`${failed} valid images could not be confirmed saved safely. See saves for failed or uncertain status and any partial file paths. They are still included as file content for model delivery; do not regenerate automatically.`)
            if (!parsed.images.length) warnings.push(`No valid images were returned. ${uncertain}`)
            const metadata = { model, resolution: args.resolution, aspect_ratio: args.aspect_ratio, requested: args.n, references: args.images.length, returned: parsed.returned, delivered: parsed.images.length, saved, saves, warnings }
            return {
              content: [
                { type: "text", text: JSON.stringify(metadata) },
                ...parsed.images.map(image => ({ type: "file" as const, uri: `data:${image.mime};base64,${image.base64}`, mime: image.mime, name: `${image.index + 1}.${image.extension}` })),
              ],
              metadata,
            }
          } catch (error) {
            if (error instanceof ImagineError) throw error
            if (!beganPost) throw new ImagineError("Image editing preflight failed; no editing request was sent. Error details were suppressed.")
            throw new ImagineError(`${signal.aborted ? "Image editing was cancelled or timed out." : "Image editing transport or response processing failed."} ${uncertain} Error details were suppressed.`)
          } finally {
            await response?.body?.cancel().catch(() => {})
          }
        },
      })
    })
  },
})

export default GrokImaginePlugin
