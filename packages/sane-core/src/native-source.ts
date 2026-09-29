import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"
import type { NativeAuthority, NativeSourceDescriptor } from "./contracts.ts"
import { DomainError, fail } from "./errors.ts"

/** Configured source identity, deliberately not a native-store attestation. */
export function normalizeNativeSource(input: NativeSourceDescriptor): NativeAuthority {
  if (!input || input.version !== 1) fail("INVALID_INPUT", "Expected native source descriptor version 1.")
  const cc = input.harness === "cc" && input.kind === "local-profile"
  const oc = input.harness === "oc" && input.kind === "local-registration"
  if (!cc && !oc) fail("FEATURE_UNAVAILABLE", "Only local Claude profiles and managed-local OpenCode registration files are supported.")
  const field = cc ? "profileRoot" : "registrationFile"
  if (Object.keys(input).sort().join() !== ["version", "harness", "kind", field].sort().join()) fail("INVALID_INPUT", "Unknown native descriptor fields.")
  const path = cc ? input.profileRoot : (input as Extract<NativeSourceDescriptor, { harness: "oc" }>).registrationFile
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) fail("INVALID_INPUT", "Native source locator must be an absolute path.")
  try {
    const normalized = resolve(path)
    let stat
    try { stat = lstatSync(normalized) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || cc) throw error }
    if (stat?.isSymbolicLink() || (stat && !(cc ? stat.isDirectory() : stat.isFile()))) fail("INVALID_INPUT", "Native source leaf must not be a symlink or an unexpected file type.")
    const canonical = cc ? realpathSync(normalized) : resolve(realpathSync(dirname(normalized)), basename(normalized))
    const descriptor: NativeSourceDescriptor = cc
      ? { version: 1, harness: "cc", kind: "local-profile", profileRoot: canonical }
      : { version: 1, harness: "oc", kind: "local-registration", registrationFile: canonical }
    return { descriptor, authorityId: `sane-native-v1:${descriptor.harness}:${createHash("sha256").update(JSON.stringify(descriptor), "utf8").digest("hex")}` }
  } catch (error) {
    if (error instanceof DomainError) throw error
    return fail("SOURCE_UNAVAILABLE", `Native source unavailable at ${path}: ${(error as Error).message}`)
  }
}
