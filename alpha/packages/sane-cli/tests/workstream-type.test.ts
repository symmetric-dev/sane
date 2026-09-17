import { describe, expect, test } from "bun:test"

import {
  parseWorkstreamType,
  validateWorkstreamType,
  WorkstreamTypeError,
} from "../src/workstream-type.ts"

describe("workstream type metadata", () => {
  test("accepts exactly the supported types", () => {
    expect(validateWorkstreamType("feature")).toBe("feature")
    expect(validateWorkstreamType("foundation")).toBe("foundation")
    expect(validateWorkstreamType("issue")).toBe("issue")
    expect(validateWorkstreamType("maintenance")).toBe("maintenance")
    expect(parseWorkstreamType("feature\n")).toBe("feature")
    expect(parseWorkstreamType("foundation\n")).toBe("foundation")
    expect(parseWorkstreamType("issue\n")).toBe("issue")
    expect(parseWorkstreamType("maintenance\n")).toBe("maintenance")
  })

  test("rejects unsupported, malformed, and non-canonical values", () => {
    expect(() => validateWorkstreamType("legacy")).toThrow(WorkstreamTypeError)
    expect(() => validateWorkstreamType("unknown")).toThrow(WorkstreamTypeError)
    expect(() => validateWorkstreamType("")).toThrow(WorkstreamTypeError)
    expect(() => validateWorkstreamType("Feature")).toThrow(WorkstreamTypeError)
    expect(() => parseWorkstreamType("Feature\n")).toThrow(WorkstreamTypeError)
    expect(() => parseWorkstreamType("legacy\n")).toThrow(WorkstreamTypeError)
    expect(() => parseWorkstreamType("unknown\n")).toThrow(WorkstreamTypeError)
    expect(() => parseWorkstreamType("feature")).toThrow("trailing newline")
    expect(() => parseWorkstreamType("")).toThrow("trailing newline")
    expect(() => parseWorkstreamType("feature\nfoundation\n")).toThrow("exactly one")
    expect(() => parseWorkstreamType("issue\nmaintenance\n")).toThrow("exactly one")
    expect(() => parseWorkstreamType("\n")).toThrow(WorkstreamTypeError)
  })
})
