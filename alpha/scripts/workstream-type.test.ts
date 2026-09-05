import { describe, expect, test } from "bun:test"

import {
  parseWorkstreamType,
  validateWorkstreamType,
  WorkstreamTypeError,
} from "./workstream-type.ts"

describe("workstream type metadata", () => {
  test("accepts exactly the initial supported types", () => {
    expect(validateWorkstreamType("feature")).toBe("feature")
    expect(parseWorkstreamType("foundation\n")).toBe("foundation")
  })

  test("rejects unsupported, malformed, and non-canonical values", () => {
    expect(() => validateWorkstreamType("legacy")).toThrow(WorkstreamTypeError)
    expect(() => parseWorkstreamType("Feature\n")).toThrow(WorkstreamTypeError)
    expect(() => parseWorkstreamType("feature")).toThrow("trailing newline")
    expect(() => parseWorkstreamType("feature\nfoundation\n")).toThrow("exactly one")
  })
})
