import { describe, expect, test } from "bun:test"
import { buildPaneTitle } from "../src/lib/multi-orchestrator.ts"

describe("buildPaneTitle", () => {
  test("prefixes the human-visible title with the thread id", () => {
    expect(
      buildPaneTitle({
        threadId: "01.02.03",
        threadName: "Sync runtime state",
      } as any),
    ).toBe("01.02.03 Sync runtime state")
  })
})
