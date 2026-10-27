import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { DomainErrorCode, NativeSourceDescriptor } from "../src/contracts.ts"
import { DomainError } from "../src/errors.ts"
import { normalizeNativeSource } from "../src/native-source.ts"

const temporaryRoot = "/private/var/folders/6v/wnsbl7cj5w96s83lszq3454w0000gn/T/opencode"
const createdDirectories: string[] = []

function fixtureRoot() {
  const root = mkdtempSync(join(realpathSync(temporaryRoot), "native-source-"))
  createdDirectories.push(root)
  return realpathSync(root)
}

afterEach(() => {
  for (const root of createdDirectories.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
})

// Callers need not supply the codec's canonical property insertion order.
const cc = (profileRoot: string): NativeSourceDescriptor => ({ profileRoot, kind: "local-profile", harness: "cc", version: 1 })
const oc = (registrationFile: string): NativeSourceDescriptor => ({ registrationFile, kind: "local-registration", harness: "oc", version: 1 })

function expectSourceError(input: unknown, code: DomainErrorCode, message: string | RegExp) {
  let caught: unknown
  try { normalizeNativeSource(input as NativeSourceDescriptor) } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(DomainError)
  expect((caught as DomainError).code).toBe(code)
  if (typeof message === "string") expect((caught as DomainError).message).toBe(message)
  else expect((caught as DomainError).message).toMatch(message)
}

describe("native source format-v1 codecs", () => {
  test("Claude identity hashes the canonical descriptor in exact field order", () => {
    const root = fixtureRoot()
    const profile = join(root, "profile")
    mkdirSync(profile)
    const authored = `${root}/unused/../profile`
    const input = cc(authored)
    const result = normalizeNativeSource(input)
    const serialized = `{"version":1,"harness":"cc","kind":"local-profile","profileRoot":${JSON.stringify(profile)}}`
    const expectedHash = createHash("sha256").update(serialized, "utf8").digest("hex")

    expect(Object.keys(result.descriptor)).toEqual(["version", "harness", "kind", "profileRoot"])
    expect(JSON.stringify(result.descriptor)).toBe(serialized)
    expect(result.authorityId).toBe(`sane-native-v1:cc:${expectedHash}`)
    expect(input).toEqual(cc(authored))
  })

  test("OpenCode identity hashes the canonical descriptor in exact field order", () => {
    const root = fixtureRoot()
    const registration = join(root, "registration.json")
    writeFileSync(registration, "generated registration fixture")
    const authored = `${root}/unused/../registration.json`
    const input = oc(authored)
    const result = normalizeNativeSource(input)
    const serialized = `{"version":1,"harness":"oc","kind":"local-registration","registrationFile":${JSON.stringify(registration)}}`
    const expectedHash = createHash("sha256").update(serialized, "utf8").digest("hex")

    expect(Object.keys(result.descriptor)).toEqual(["version", "harness", "kind", "registrationFile"])
    expect(JSON.stringify(result.descriptor)).toBe(serialized)
    expect(result.authorityId).toBe(`sane-native-v1:oc:${expectedHash}`)
    expect(input).toEqual(oc(authored))
  })

  test("Claude requires an existing profile directory", () => {
    const path = join(fixtureRoot(), "missing-profile")
    expectSourceError(cc(path), "SOURCE_UNAVAILABLE", /^Native source unavailable at .*missing-profile: .*ENOENT/)
  })

  test("OpenCode permits a missing registration leaf under an existing parent", () => {
    const path = join(fixtureRoot(), "not-created.json")
    const before = normalizeNativeSource(oc(path))
    expect(before.descriptor).toEqual({ version: 1, harness: "oc", kind: "local-registration", registrationFile: path })
    writeFileSync(path, "generated after registration")
    expect(normalizeNativeSource(oc(path))).toEqual(before)
  })

  test("OpenCode requires the registration parent to exist", () => {
    const path = join(fixtureRoot(), "missing-parent", "registration.json")
    expectSourceError(oc(path), "SOURCE_UNAVAILABLE", /^Native source unavailable at .*missing-parent\/registration\.json: .*ENOENT/)
  })

  test("Claude canonicalizes a symlinked parent without rejecting its directory leaf", () => {
    const root = fixtureRoot()
    const parent = join(root, "parent")
    mkdirSync(parent)
    mkdirSync(join(parent, "profile"))
    symlinkSync(parent, join(root, "parent-alias"))
    const canonical = normalizeNativeSource(cc(join(parent, "profile")))
    expect(normalizeNativeSource(cc(join(root, "parent-alias", "profile")))).toEqual(canonical)
    expect(canonical.descriptor).toEqual({ version: 1, harness: "cc", kind: "local-profile", profileRoot: join(parent, "profile") })
  })

  test("OpenCode canonicalizes a symlinked parent even when the leaf is missing", () => {
    const root = fixtureRoot()
    const parent = join(root, "parent")
    mkdirSync(parent)
    symlinkSync(parent, join(root, "parent-alias"))
    const canonical = normalizeNativeSource(oc(join(parent, "registration.json")))
    expect(normalizeNativeSource(oc(join(root, "parent-alias", "registration.json")))).toEqual(canonical)
    expect(canonical.descriptor).toEqual({ version: 1, harness: "oc", kind: "local-registration", registrationFile: join(parent, "registration.json") })
  })

  test("both codecs reject leaf symlinks, including a dangling registration symlink", () => {
    const root = fixtureRoot()
    mkdirSync(join(root, "profile"))
    writeFileSync(join(root, "registration.json"), "generated fixture")
    symlinkSync(join(root, "profile"), join(root, "profile-link"))
    symlinkSync(join(root, "registration.json"), join(root, "registration-link"))
    symlinkSync(join(root, "missing.json"), join(root, "dangling-link"))
    const message = "Native source leaf must not be a symlink or an unexpected file type."
    expectSourceError(cc(join(root, "profile-link")), "INVALID_INPUT", message)
    expectSourceError(oc(join(root, "registration-link")), "INVALID_INPUT", message)
    expectSourceError(oc(join(root, "dangling-link")), "INVALID_INPUT", message)
  })

  test("both codecs reject the wrong leaf file type as invalid input", () => {
    const root = fixtureRoot()
    const file = join(root, "file")
    const directory = join(root, "directory")
    writeFileSync(file, "generated fixture")
    mkdirSync(directory)
    const message = "Native source leaf must not be a symlink or an unexpected file type."
    expectSourceError(cc(file), "INVALID_INPUT", message)
    expectSourceError(oc(directory), "INVALID_INPUT", message)
  })

  test("OpenCode registration contents are not part of source identity", () => {
    const path = join(fixtureRoot(), "registration.json")
    writeFileSync(path, JSON.stringify({ generated: "first" }))
    const before = normalizeNativeSource(oc(path))
    writeFileSync(path, "different generated content, not even JSON")
    expect(normalizeNativeSource(oc(path))).toEqual(before)
  })
})

describe("native source validation before filesystem normalization", () => {
  test("null, missing, and unsupported versions fail before inspecting the harness", () => {
    const message = "Expected native source descriptor version 1."
    for (const input of [null, undefined, {}, { version: 2 }, { version: "1" }]) {
      expectSourceError(input, "INVALID_INPUT", message)
    }
    expectSourceError({ version: 0, get harness() { throw new Error("must not read harness") } }, "INVALID_INPUT", message)
  })

  test("unknown harnesses and mismatched kinds fail before inspecting locators or extra fields", () => {
    const message = "Only local Claude profiles and managed-local OpenCode registration files are supported."
    expectSourceError({ version: 1, harness: "unknown", extra: true, get profileRoot() { throw new Error("must not read locator") } }, "FEATURE_UNAVAILABLE", message)
    expectSourceError({ ...cc("relative"), kind: "local-registration", extra: true, get profileRoot() { throw new Error("must not read locator") } }, "FEATURE_UNAVAILABLE", message)
    expectSourceError({ ...oc("relative"), kind: "local-profile" }, "FEATURE_UNAVAILABLE", message)
    expectSourceError({ version: 1, harness: "cc", profileRoot: "relative" }, "FEATURE_UNAVAILABLE", message)
  })

  test("extra and missing descriptor fields fail before reading or normalizing the locator", () => {
    const message = "Unknown native descriptor fields."
    expectSourceError({ ...cc("relative"), extra: true, get profileRoot() { throw new Error("must not read locator") } }, "INVALID_INPUT", message)
    expectSourceError({ version: 1, harness: "cc", kind: "local-profile" }, "INVALID_INPUT", message)
    expectSourceError({ ...oc("relative"), profileRoot: "wrong-locator" }, "INVALID_INPUT", message)
    expectSourceError({ version: 1, harness: "oc", kind: "local-registration" }, "INVALID_INPUT", message)
  })

  test("relative locators are invalid instead of being resolved against the working directory", () => {
    const message = "Native source locator must be an absolute path."
    expectSourceError(cc("."), "INVALID_INPUT", message)
    expectSourceError(oc("registration.json"), "INVALID_INPUT", message)
  })

  test("NUL-containing absolute locators are invalid before filesystem access", () => {
    const root = fixtureRoot()
    const message = "Native source locator must be an absolute path."
    expectSourceError(cc(`${root}/missing\0profile`), "INVALID_INPUT", message)
    expectSourceError(oc(`${root}/missing\0registration.json`), "INVALID_INPUT", message)
  })

  test("present but non-string locators are invalid rather than source failures", () => {
    const message = "Native source locator must be an absolute path."
    expectSourceError({ ...cc("unused"), profileRoot: null }, "INVALID_INPUT", message)
    expectSourceError({ ...oc("unused"), registrationFile: 42 }, "INVALID_INPUT", message)
  })
})
