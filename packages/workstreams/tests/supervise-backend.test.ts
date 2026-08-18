import { describe, expect, test } from "bun:test"

import {
  __test as superviseTest,
  parseExecutionBackend,
  resolveExecutionBackend,
} from "../src/cli/supervise.ts"

describe("supervise execution backend selection", () => {
  test("parses the supported backend values", () => {
    expect(parseExecutionBackend("legacy")).toBe("legacy")
    expect(parseExecutionBackend("sdk")).toBe("sdk")
    expect(
      superviseTest.parseCliArgs([
        "bun",
        "work-supervise",
        "--execution-backend",
        "sdk",
      ]),
    ).toMatchObject({ executionBackend: "sdk" })
  })

  test("rejects invalid and missing backend values with the source name", () => {
    expect(() => parseExecutionBackend("tmux")).toThrow(
      'invalid --execution-backend value "tmux"; expected "legacy" or "sdk"',
    )
    expect(() => parseExecutionBackend(undefined, "WORKSTREAM_EXECUTION_BACKEND")).toThrow(
      'WORKSTREAM_EXECUTION_BACKEND requires a value; expected "legacy" or "sdk"',
    )
    expect(() =>
      superviseTest.parseCliArgs(["bun", "work-supervise", "--execution-backend", "-h"]),
    ).toThrow('Error: --execution-backend requires a value; expected "legacy" or "sdk"')
  })

  test("uses SDK when normal work has no CLI or environment selection", () => {
    expect(resolveExecutionBackend({})).toBe("sdk")
  })

  test("uses the environment default for normal work", () => {
    expect(resolveExecutionBackend({ envValue: "sdk" })).toBe("sdk")
    expect(resolveExecutionBackend({ envValue: "legacy" })).toBe("legacy")
  })

  test("explicit CLI selection overrides the environment default", () => {
    expect(resolveExecutionBackend({ cliBackend: "legacy", envValue: "sdk" })).toBe("legacy")
    expect(resolveExecutionBackend({ cliBackend: "sdk", envValue: "legacy" })).toBe("sdk")
  })

  test("forced work-sdk selection wins over compatible inputs", () => {
    expect(
      resolveExecutionBackend({ forcedBackend: "sdk", cliBackend: "sdk", envValue: "legacy" }),
    ).toBe("sdk")
    expect(resolveExecutionBackend({ forcedBackend: "sdk", envValue: "legacy" })).toBe("sdk")
  })

  test("rejects an explicit CLI conflict with forced work-sdk selection", () => {
    expect(() =>
      resolveExecutionBackend({ forcedBackend: "sdk", cliBackend: "legacy" }),
    ).toThrow(
      'work-sdk supervise is forced to the "sdk" execution backend; --execution-backend legacy is not supported',
    )
  })

  test("rejects invalid environment values", () => {
    expect(() => resolveExecutionBackend({ envValue: "tmux" })).toThrow(
      'invalid WORKSTREAM_EXECUTION_BACKEND value "tmux"; expected "legacy" or "sdk"',
    )
  })
})
