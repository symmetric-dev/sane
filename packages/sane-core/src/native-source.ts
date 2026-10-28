import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import type { GrokSourceDescriptor, NativeAuthority, NativeSourceDescriptor } from "./contracts.ts"
import { DomainError, fail } from "./errors.ts"
import { nativeSourceFormat } from "./native-source-contract.ts"

// These explicit codecs belong to format v1, not a runtime harness registry.
// Property insertion order is part of the serialized descriptor and its hash.
function normalizeClaudeProfile(path: string): Extract<NativeSourceDescriptor, { harness: "cc" }> {
  const normalized = resolve(path)
  const stat = lstatSync(normalized)
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("INVALID_INPUT", "Native source leaf must not be a symlink or an unexpected file type.")
  const canonical = realpathSync(normalized)
  return { version: 1, harness: "cc", kind: "local-profile", profileRoot: canonical }
}

function normalizeGrokHome(path: string): GrokSourceDescriptor {
  const normalized = resolve(path)
  const stat = lstatSync(normalized)
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("INVALID_INPUT", "Native source leaf must not be a symlink or an unexpected file type.")
  const canonical = realpathSync(normalized)
  return { version: 1, harness: "gk", kind: "local-home", homeRoot: canonical }
}

function normalizeOpenCodeRegistration(path: string): Extract<NativeSourceDescriptor, { harness: "oc" }> {
  const normalized = resolve(path)
  let stat
  try { stat = lstatSync(normalized) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  if (stat?.isSymbolicLink() || (stat && !stat.isFile())) fail("INVALID_INPUT", "Native source leaf must not be a symlink or an unexpected file type.")
  // A missing registration leaf is allowed, but its parent must resolve.
  const canonical = resolve(realpathSync(dirname(normalized)), basename(normalized))
  return { version: 1, harness: "oc", kind: "local-registration", registrationFile: canonical }
}

/** Configured source identity, deliberately not a native-store attestation. */
export function normalizeNativeSource(input: Extract<NativeSourceDescriptor, { harness: "cc" }>): { descriptor: Extract<NativeSourceDescriptor, { harness: "cc" }>; authorityId: string }
export function normalizeNativeSource(input: Extract<NativeSourceDescriptor, { harness: "oc" }>): { descriptor: Extract<NativeSourceDescriptor, { harness: "oc" }>; authorityId: string }
export function normalizeNativeSource(input: GrokSourceDescriptor): Extract<NativeAuthority, { descriptor: GrokSourceDescriptor }>
export function normalizeNativeSource(input: Exclude<NativeSourceDescriptor, GrokSourceDescriptor>): Exclude<NativeAuthority, { descriptor: GrokSourceDescriptor }>
export function normalizeNativeSource(input: NativeSourceDescriptor): NativeAuthority
export function normalizeNativeSource(input: NativeSourceDescriptor): NativeAuthority {
  if (!input || input.version !== 1) fail("INVALID_INPUT", "Expected native source descriptor version 1.")
  const format = nativeSourceFormat(input.harness)
  if (!format || input.kind !== format.kind) fail("FEATURE_UNAVAILABLE", "Only local Claude profiles, managed-local OpenCode registration files and Grok homes are supported.")
  const field = format.locatorKey
  if (Object.keys(input).sort().join() !== ["version", "harness", "kind", field].sort().join()) fail("INVALID_INPUT", "Unknown native descriptor fields.")
  const path = input.harness === "cc" ? input.profileRoot : input.harness === "oc" ? input.registrationFile : input.homeRoot
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) fail("INVALID_INPUT", "Native source locator must be an absolute path.")
  try {
    if (input.harness === "gk") {
      const descriptor = normalizeGrokHome(path)
      return { descriptor, authorityId: `sane-native-v1:gk:${createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex")}` }
    }
    const descriptor = input.harness === "cc" ? normalizeClaudeProfile(path) : normalizeOpenCodeRegistration(path)
    const authorityId = `sane-native-v1:${descriptor.harness}:${createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex")}`
    return { descriptor, authorityId }
  } catch (error) {
    if (error instanceof DomainError) throw error
    return fail("SOURCE_UNAVAILABLE", `Native source unavailable at ${path}: ${(error as Error).message}`)
  }
}
