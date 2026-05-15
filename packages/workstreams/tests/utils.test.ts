import { describe, test, expect } from "bun:test"
import {
  toTitleCase,
  getDateString,
  validateStreamName,
  parsePositiveInt,
  statusToCheckbox,
  parseExecutionStatus,
  parseStageStatus,
  setNestedField,
  getNestedField,
  parseValue,
} from "../src/lib/utils"

describe("toTitleCase", () => {
  test("converts single word", () => {
    expect(toTitleCase("hello")).toBe("Hello")
  })

  test("converts kebab-case to Title Case", () => {
    expect(toTitleCase("my-feature")).toBe("My Feature")
  })

  test("converts multi-word kebab-case", () => {
    expect(toTitleCase("add-user-authentication")).toBe(
      "Add User Authentication",
    )
  })

  test("handles numbers in words", () => {
    expect(toTitleCase("v2-api")).toBe("V2 Api")
  })

  test("handles empty string", () => {
    expect(toTitleCase("")).toBe("")
  })
})

describe("getDateString", () => {
  test("returns date in YYYY-MM-DD format", () => {
    const result = getDateString()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("returns today's date", () => {
    const today = new Date().toISOString().split("T")[0]!
    expect(getDateString()).toBe(today)
  })
})

describe("validateStreamName", () => {
  test.each([
    ["my-feature", true],
    ["add-tests", true],
    ["feature", true],
    ["v2", true],
    ["a", true],
    ["123", true],
    ["feature-123", true],
  ])("validateStreamName(%s) returns %s", (name, expected) => {
    expect(validateStreamName(name)).toBe(expected)
  })

  test.each([
    ["My Feature", false],
    ["my_feature", false],
    ["My-Feature", false],
    ["-start-with-dash", false],
    ["end-with-dash-", false],
    ["double--dash", false],
    ["", false],
    ["has spaces", false],
    ["has.dot", false],
  ])("validateStreamName(%s) returns %s", (name, expected) => {
    expect(validateStreamName(name)).toBe(expected)
  })
})

describe("parsePositiveInt", () => {
  test("parses valid positive integers", () => {
    expect(parsePositiveInt("1", "count")).toBe(1)
    expect(parsePositiveInt("42", "count")).toBe(42)
    expect(parsePositiveInt("100", "count")).toBe(100)
  })

  test("throws on zero", () => {
    expect(() => parsePositiveInt("0", "count")).toThrow(
      'count must be a positive integer. Got: "0"',
    )
  })

  test("throws on negative numbers", () => {
    expect(() => parsePositiveInt("-1", "count")).toThrow(
      'count must be a positive integer. Got: "-1"',
    )
  })

  test("throws on non-numeric strings", () => {
    expect(() => parsePositiveInt("abc", "count")).toThrow(
      'count must be a positive integer. Got: "abc"',
    )
  })

  test("truncates floats to integer", () => {
    // parseInt truncates decimal part
    expect(parsePositiveInt("1.5", "count")).toBe(1)
    expect(parsePositiveInt("9.9", "count")).toBe(9)
  })

  test("includes field name in error message", () => {
    expect(() => parsePositiveInt("bad", "stages")).toThrow(
      "stages must be a positive integer",
    )
  })
})

describe("statusToCheckbox", () => {
  test.each([
    ["completed", "[x]"],
    ["in_progress", "[~]"],
    ["blocked", "[!]"],
    ["cancelled", "[-]"],
    ["pending", "[ ]"],
  ] as const)("statusToCheckbox(%s) returns %s", (status, expected) => {
    expect(statusToCheckbox(status)).toBe(expected)
  })
})

describe("parseExecutionStatus", () => {
  test("parses completed status", () => {
    expect(parseExecutionStatus("- [x] Item done")).toBe("completed")
    expect(parseExecutionStatus("- [X] Item done")).toBe("completed")
  })

  test("parses in_progress status", () => {
    expect(parseExecutionStatus("- [~] Working on it")).toBe("in_progress")
  })

  test("parses blocked status", () => {
    expect(parseExecutionStatus("- [!] Blocked by dependency")).toBe("blocked")
  })

  test("parses cancelled status", () => {
    expect(parseExecutionStatus("- [-] No longer needed")).toBe("cancelled")
  })

  test("parses pending status", () => {
    expect(parseExecutionStatus("- [ ] Todo item")).toBe("pending")
  })

  test("returns pending for lines without checkboxes", () => {
    expect(parseExecutionStatus("Some random text")).toBe("pending")
  })
})

describe("parseStageStatus", () => {
  test("parses complete status", () => {
    expect(parseStageStatus("Complete")).toBe("complete")
    expect(parseStageStatus("completed")).toBe("complete")
    expect(parseStageStatus("✅ Done")).toBe("complete")
  })

  test("parses in_progress status", () => {
    expect(parseStageStatus("In Progress")).toBe("in_progress")
    expect(parseStageStatus("progress")).toBe("in_progress")
    expect(parseStageStatus("🔄 Working")).toBe("in_progress")
  })

  test("parses blocked status", () => {
    expect(parseStageStatus("Blocked")).toBe("blocked")
    expect(parseStageStatus("⚠️ Waiting")).toBe("blocked")
  })

  test("returns pending for unrecognized status", () => {
    expect(parseStageStatus("Not Started")).toBe("pending")
    expect(parseStageStatus("")).toBe("pending")
    expect(parseStageStatus("Unknown")).toBe("pending")
  })
})

describe("setNestedField", () => {
  test("sets top-level field", () => {
    const obj: Record<string, unknown> = {}
    setNestedField(obj, "name", "test")
    expect(obj.name).toBe("test")
  })

  test("sets nested field", () => {
    const obj: Record<string, unknown> = {}
    setNestedField(obj, "config.timeout", 5000)
    expect(obj).toEqual({ config: { timeout: 5000 } })
  })

  test("sets deeply nested field", () => {
    const obj: Record<string, unknown> = {}
    setNestedField(obj, "a.b.c.d", "deep")
    expect(obj).toEqual({ a: { b: { c: { d: "deep" } } } })
  })

  test("preserves existing fields", () => {
    const obj: Record<string, unknown> = {
      existing: "value",
      config: { keep: true },
    }
    setNestedField(obj, "config.add", "new")
    expect(obj).toEqual({
      existing: "value",
      config: { keep: true, add: "new" },
    })
  })

  test("overwrites existing values", () => {
    const obj: Record<string, unknown> = { config: { timeout: 1000 } }
    setNestedField(obj, "config.timeout", 5000)
    expect(obj).toEqual({ config: { timeout: 5000 } })
  })

  test("handles empty path gracefully", () => {
    const obj: Record<string, unknown> = { keep: "me" }
    setNestedField(obj, "", "value")
    expect(obj).toEqual({ keep: "me" })
  })
})

describe("getNestedField", () => {
  test("gets top-level field", () => {
    const obj = { name: "test" }
    expect(getNestedField(obj, "name")).toBe("test")
  })

  test("gets nested field", () => {
    const obj = { config: { timeout: 5000 } }
    expect(getNestedField(obj, "config.timeout")).toBe(5000)
  })

  test("gets deeply nested field", () => {
    const obj = { a: { b: { c: { d: "deep" } } } }
    expect(getNestedField(obj, "a.b.c.d")).toBe("deep")
  })

  test("returns undefined for missing field", () => {
    const obj = { name: "test" }
    expect(getNestedField(obj, "missing")).toBeUndefined()
  })

  test("returns undefined for missing nested field", () => {
    const obj = { config: { timeout: 5000 } }
    expect(getNestedField(obj, "config.missing")).toBeUndefined()
  })

  test("returns undefined for path through non-object", () => {
    const obj = { config: "string" }
    expect(getNestedField(obj, "config.timeout")).toBeUndefined()
  })

  test("returns undefined for path through null", () => {
    const obj = { config: null }
    expect(getNestedField(obj, "config.timeout")).toBeUndefined()
  })
})

describe("parseValue", () => {
  describe("booleans", () => {
    test("parses true", () => {
      expect(parseValue("true")).toBe(true)
    })

    test("parses false", () => {
      expect(parseValue("false")).toBe(false)
    })
  })

  describe("numbers", () => {
    test("parses positive integers", () => {
      expect(parseValue("42")).toBe(42)
      expect(parseValue("0")).toBe(0)
    })

    test("parses negative integers", () => {
      expect(parseValue("-5")).toBe(-5)
    })

    test("parses floats", () => {
      expect(parseValue("3.14")).toBe(3.14)
      expect(parseValue("-2.5")).toBe(-2.5)
    })

    test("does not parse partial numbers as numbers", () => {
      expect(parseValue("42px")).toBe("42px")
      expect(parseValue("1.2.3")).toBe("1.2.3")
    })
  })

  describe("JSON", () => {
    test("parses JSON objects", () => {
      expect(parseValue('{"key":"value"}')).toEqual({ key: "value" })
    })

    test("parses JSON arrays", () => {
      expect(parseValue("[1,2,3]")).toEqual([1, 2, 3])
    })

    test("returns string for invalid JSON starting with {", () => {
      expect(parseValue("{invalid}")).toBe("{invalid}")
    })

    test("returns string for invalid JSON starting with [", () => {
      expect(parseValue("[invalid")).toBe("[invalid")
    })
  })

  describe("strings", () => {
    test("returns plain strings as-is", () => {
      expect(parseValue("hello")).toBe("hello")
      expect(parseValue("hello world")).toBe("hello world")
    })

    test("returns empty string", () => {
      expect(parseValue("")).toBe("")
    })

    test("does not trim whitespace", () => {
      expect(parseValue("  spaced  ")).toBe("  spaced  ")
    })
  })
})
