import { describe, expect, test } from "bun:test"
import { isNativeHarness, nativeSourceFormat, validNativeAuthorityId } from "../src/native-source-contract.ts"

describe("browser-safe native source format-v1 contract", () => {
  test("the two supported harnesses have exact closed format metadata", () => {
    expect(nativeSourceFormat("cc")).toEqual({ kind: "local-profile", locatorKey: "profileRoot" })
    expect(nativeSourceFormat("oc")).toEqual({ kind: "local-registration", locatorKey: "registrationFile" })
    expect(isNativeHarness("cc")).toBe(true)
    expect(isNativeHarness("oc")).toBe(true)
  })

  test("unknown, prototype, and non-string harness values are not formats", () => {
    for (const value of ["unknown", "CC", "__proto__", "constructor", "toString", null, undefined, 1, {}, ["cc"]]) {
      expect(nativeSourceFormat(value)).toBeUndefined()
      expect(isNativeHarness(value)).toBe(false)
    }
  })

  test("format metadata cannot be changed through another caller's returned object", () => {
    const claude = nativeSourceFormat("cc")!
    const openCode = nativeSourceFormat("oc")!
    expect(nativeSourceFormat("cc")).not.toBe(claude)
    expect(nativeSourceFormat("oc")).not.toBe(openCode)
    Object.assign(claude, { kind: "changed", locatorKey: "changed" })
    Object.assign(openCode, { kind: "changed", locatorKey: "changed" })
    expect(nativeSourceFormat("cc")).toEqual({ kind: "local-profile", locatorKey: "profileRoot" })
    expect(nativeSourceFormat("oc")).toEqual({ kind: "local-registration", locatorKey: "registrationFile" })
  })
})

describe("native authority ID contract", () => {
  const hash = "0123456789abcdef".repeat(4)

  test("accepts each harness namespace and both lowercase hexadecimal boundaries", () => {
    expect(validNativeAuthorityId("cc", `sane-native-v1:cc:${hash}`)).toBe(true)
    expect(validNativeAuthorityId("oc", `sane-native-v1:oc:${hash}`)).toBe(true)
    expect(validNativeAuthorityId("cc", `sane-native-v1:cc:${"0".repeat(64)}`)).toBe(true)
    expect(validNativeAuthorityId("oc", `sane-native-v1:oc:${"f".repeat(64)}`)).toBe(true)
  })

  test("requires the exact versioned namespace and matching harness", () => {
    expect(validNativeAuthorityId("cc", `sane-native-v1:oc:${hash}`)).toBe(false)
    expect(validNativeAuthorityId("oc", `sane-native-v1:cc:${hash}`)).toBe(false)
    expect(validNativeAuthorityId("cc", `sane-native-v2:cc:${hash}`)).toBe(false)
    expect(validNativeAuthorityId("cc", `native-v1:cc:${hash}`)).toBe(false)
    expect(validNativeAuthorityId("cc", `SANE-native-v1:cc:${hash}`)).toBe(false)
    expect(validNativeAuthorityId("CC", `sane-native-v1:CC:${hash}`)).toBe(false)
    expect(validNativeAuthorityId("unknown", `sane-native-v1:unknown:${hash}`)).toBe(false)
    expect(validNativeAuthorityId("__proto__", `sane-native-v1:__proto__:${hash}`)).toBe(false)
  })

  test("requires exactly 64 lowercase hexadecimal characters", () => {
    expect(validNativeAuthorityId("cc", `sane-native-v1:cc:${hash.slice(1)}`)).toBe(false)
    expect(validNativeAuthorityId("cc", `sane-native-v1:cc:${hash}0`)).toBe(false)
    expect(validNativeAuthorityId("cc", `sane-native-v1:cc:${hash.toUpperCase()}`)).toBe(false)
    expect(validNativeAuthorityId("cc", `sane-native-v1:cc:g${hash.slice(1)}`)).toBe(false)
    expect(validNativeAuthorityId("cc", "sane-native-v1:cc:")).toBe(false)
  })

  test("rejects ordinary whitespace, embedded controls, and unrelated surrounding text", () => {
    const authority = `sane-native-v1:oc:${hash}`
    expect(validNativeAuthorityId("oc", ` ${authority}`)).toBe(false)
    expect(validNativeAuthorityId("oc", `${authority} `)).toBe(false)
    expect(validNativeAuthorityId("oc", `${authority}\t`)).toBe(false)
    expect(validNativeAuthorityId("oc", `sane-native-v1:oc:${hash.slice(0, 32)}\n${hash.slice(32)}`)).toBe(false)
    expect(validNativeAuthorityId("oc", `sane-native-v1:oc:${hash.slice(0, 32)}\0${hash.slice(32)}`)).toBe(false)
    expect(validNativeAuthorityId("oc", `${authority}:extra`)).toBe(false)
  })

  test("rejects non-string authority values and non-string harnesses without coercion", () => {
    for (const value of [null, undefined, 0, {}, [`sane-native-v1:cc:${hash}`]]) {
      expect(validNativeAuthorityId("cc", value)).toBe(false)
    }
    expect(validNativeAuthorityId(null, `sane-native-v1:cc:${hash}`)).toBe(false)
    expect(validNativeAuthorityId({ toString: () => "cc" }, `sane-native-v1:cc:${hash}`)).toBe(false)
  })
})
