import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSessionExportChildStdio,
  exportSession,
  formatSessionExportCommandFailure,
} from "../src/lib/session-export"

const TEMP_PREFIX = "agenv-session-export-"

describe("exportSession transport", () => {
  const originalPath = process.env.PATH ?? ""
  let fakeBinDir = ""

  beforeEach(async () => {
    fakeBinDir = await mkdtemp(join(tmpdir(), "agenv-fake-opencode-"))
    const fakeOpencodePath = join(fakeBinDir, "opencode")

    await writeFile(
      fakeOpencodePath,
      `#!/usr/bin/env node
const [, , command, sessionId] = process.argv;
if (command !== "export") {
  process.stderr.write(\`unexpected command: \${command}\\n\`)
  process.exit(64)
}

const session = {
  info: {
    id: sessionId,
    title: "Test Session",
    summary: { additions: 0, deletions: 0, files: 0 },
  },
  messages: [
    {
      info: { id: "msg-1", role: "assistant" },
      parts: [{ type: "text", text: "streamed-" + "x".repeat(1024 * 1024) }],
    },
  ],
}

switch (sessionId) {
  case "success":
    process.stdout.write(JSON.stringify(session))
    break
  case "mixed":
    process.stdout.write("info: exporting session\\n")
    process.stdout.write(JSON.stringify(session))
    process.stdout.write("\\nfinished\\n")
    break
  case "malformed":
    process.stdout.write('{"info":')
    process.stderr.write("background logger wrote to stderr\\n")
    break
  case "fail":
    process.stdout.write('{"partial":true')
    process.stderr.write("permission denied\\n")
    process.exit(7)
    break
  default:
    process.stderr.write(\`unexpected session: \${sessionId}\\n\`)
    process.exit(65)
}
`,
    )
    await chmod(fakeOpencodePath, 0o755)
    process.env.PATH = `${fakeBinDir}:${originalPath}`
  })

  afterEach(async () => {
    process.env.PATH = originalPath
    if (fakeBinDir) {
      await rm(fakeBinDir, { recursive: true, force: true })
    }
  })

  async function listSessionExportTempEntries(): Promise<string[]> {
    const entries = await readdir(tmpdir())
    return entries.filter((entry) => entry.startsWith(TEMP_PREFIX)).sort()
  }

  test("streams export stdout to a temp file and parses the JSON", async () => {
    const before = await listSessionExportTempEntries()

    const session = await exportSession("success")

    const after = await listSessionExportTempEntries()
    expect(session.info.id).toBe("success")
    expect(session.messages[0]?.parts[0]).toEqual({
      type: "text",
      text: "streamed-" + "x".repeat(1024 * 1024),
    })
    expect(after).toEqual(before)
  })

  test("preserves mixed stdout recovery while cleaning up temp files", async () => {
    const before = await listSessionExportTempEntries()

    const session = await exportSession("mixed")

    const after = await listSessionExportTempEntries()
    expect(session.info.id).toBe("mixed")
    expect(after).toEqual(before)
  })

  test("reports malformed JSON with stderr diagnostics and cleans up temp files", async () => {
    const before = await listSessionExportTempEntries()

    await expect(exportSession("malformed")).rejects.toThrow(
      /Failed to parse session export JSON: .*stderr was not empty: .*background logger wrote to stderr/i,
    )

    const after = await listSessionExportTempEntries()
    expect(after).toEqual(before)
  })

  test("reports non-zero exits with stdout and stderr previews and cleans up temp files", async () => {
    const before = await listSessionExportTempEntries()

    await expect(exportSession("fail")).rejects.toThrow(
      /failed with exit code 7: Process exited with code 7; stdout preview: .*partial.*stderr preview: .*permission denied/i,
    )

    const after = await listSessionExportTempEntries()
    expect(after).toEqual(before)
  })
})

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

describe("createSessionExportChildStdio", () => {
  test("routes child stdout directly to a file descriptor while keeping stderr piped", () => {
    expect(createSessionExportChildStdio(42)).toEqual(["ignore", 42, "pipe"])
  })
})
