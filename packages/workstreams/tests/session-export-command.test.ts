import { describe, expect, test } from "bun:test"
import { formatSessionExportCommandFailure } from "../src/lib/session-export"

describe("formatSessionExportCommandFailure", () => {
  test("reports non-zero command failures with stdout and stderr previews", () => {
    const error = Object.assign(new Error("spawn failed"), {
      code: 1,
      stdout: "partial json",
      stderr: "permission denied",
    })

    expect(
      formatSessionExportCommandFailure({
        error,
        sessionId: "session_123",
      }),
    ).toMatch(
      /failed with exit code 1: spawn failed; stdout preview: .*partial json.*stderr preview: .*permission denied/i,
    )
  })
})
