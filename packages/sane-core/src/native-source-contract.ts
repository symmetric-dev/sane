import type { Harness } from "./contracts.ts"

/**
 * Closed format-v1 rules, not a runtime harness registry. A registry must never
 * silently widen an existing descriptor or authority-ID storage format.
 */
export function nativeSourceFormat(harness: unknown):
  | { readonly kind: "local-profile"; readonly locatorKey: "profileRoot" }
  | { readonly kind: "local-registration"; readonly locatorKey: "registrationFile" }
  | { readonly kind: "local-home"; readonly locatorKey: "homeRoot" }
  | undefined {
  switch (harness) {
    case "cc": return { kind: "local-profile", locatorKey: "profileRoot" }
    case "oc": return { kind: "local-registration", locatorKey: "registrationFile" }
    case "gk": return { kind: "local-home", locatorKey: "homeRoot" }
    default: return undefined
  }
}

/** Qualified conversation and receipt harnesses. */
export function isNativeHarness(value: unknown): value is Harness {
  return value === "cc" || value === "oc" || value === "gk"
}

export function validNativeAuthorityId(harness: unknown, value: unknown): value is string {
  return isNativeHarness(harness) && typeof value === "string"
    && new RegExp(`^sane-native-v1:${harness}:[a-f0-9]{64}$`).test(value)
}

/** Compatibility name for source-pin identity validation. */
export function validPinnedAuthorityId(harness: unknown, value: unknown): value is string {
  return validNativeAuthorityId(harness, value)
}
