import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  findNativeSessionIdByTitle,
  runForkedSession,
} from "../src/lib/workstream-tool/launch-supervision-opencode.ts"

describe("findNativeSessionIdByTitle", () => {
  const originalPath = process.env.PATH ?? ""
  const originalStdout = process.env.FAKE_OPENCODE_STDOUT
  const originalStderr = process.env.FAKE_OPENCODE_STDERR
  const originalExitCode = process.env.FAKE_OPENCODE_EXIT_CODE

  let fakeBinDir = ""
  let repoRoot = ""

  beforeEach(async () => {
    fakeBinDir = await mkdtemp(join(tmpdir(), "agenv-fake-opencode-list-"))
    repoRoot = await mkdtemp(join(tmpdir(), "agenv-fake-opencode-repo-"))
    await mkdir(repoRoot, { recursive: true })

    const fakeOpencodePath = join(fakeBinDir, "opencode")
    await writeFile(
      fakeOpencodePath,
      `#!/usr/bin/env node
const args = process.argv.slice(2)
const expected = ["session", "list", "--max-count", "50", "--format", "json"]
if (JSON.stringify(args) === JSON.stringify(expected)) {
  if (process.env.FAKE_OPENCODE_STDOUT) {
    process.stdout.write(process.env.FAKE_OPENCODE_STDOUT)
  }

  if (process.env.FAKE_OPENCODE_STDERR) {
    process.stderr.write(process.env.FAKE_OPENCODE_STDERR)
  }

  process.exit(Number(process.env.FAKE_OPENCODE_EXIT_CODE ?? "0"))
}

if (args[0] === "run") {
  process.stdout.write('{"type":"text","part":{"text":"## What is Next\\n- ok"}}\\n')
  setTimeout(() => process.exit(0), 1200)
  return
}

if (JSON.stringify(args) !== JSON.stringify(expected)) {
  process.stderr.write("unexpected args: " + JSON.stringify(args) + "\\n")
  process.exit(64)
}
`,
    )
    await chmod(fakeOpencodePath, 0o755)

    process.env.PATH = `${fakeBinDir}:${originalPath}`
    delete process.env.FAKE_OPENCODE_STDOUT
    delete process.env.FAKE_OPENCODE_STDERR
    delete process.env.FAKE_OPENCODE_EXIT_CODE
  })

  afterEach(async () => {
    process.env.PATH = originalPath

    if (originalStdout === undefined) {
      delete process.env.FAKE_OPENCODE_STDOUT
    } else {
      process.env.FAKE_OPENCODE_STDOUT = originalStdout
    }

    if (originalStderr === undefined) {
      delete process.env.FAKE_OPENCODE_STDERR
    } else {
      process.env.FAKE_OPENCODE_STDERR = originalStderr
    }

    if (originalExitCode === undefined) {
      delete process.env.FAKE_OPENCODE_EXIT_CODE
    } else {
      process.env.FAKE_OPENCODE_EXIT_CODE = originalExitCode
    }

    await rm(fakeBinDir, { recursive: true, force: true })
    await rm(repoRoot, { recursive: true, force: true })
  })

  test("returns the matching session id for clean JSON stdout", async () => {
    process.env.FAKE_OPENCODE_STDOUT = JSON.stringify([
      { id: "ses_other", title: "another title" },
      { id: "ses_target", title: "target title" },
    ])

    await expect(findNativeSessionIdByTitle(repoRoot, "target title")).resolves.toBe("ses_target")
  })

  test("returns undefined when stdout is malformed JSON", async () => {
    process.env.FAKE_OPENCODE_STDOUT = '{"id":'

    await expect(findNativeSessionIdByTitle(repoRoot, "target title")).resolves.toBeUndefined()
  })

  test("returns undefined when the requested session title is missing", async () => {
    process.env.FAKE_OPENCODE_STDOUT = JSON.stringify([
      { id: "ses_other", title: "another title" },
    ])

    await expect(findNativeSessionIdByTitle(repoRoot, "target title")).resolves.toBeUndefined()
  })

  test("returns the matching session id when stdout contains noise around JSON", async () => {
    process.env.FAKE_OPENCODE_STDOUT = [
      "info: listing sessions",
      JSON.stringify([{ id: "ses_target", title: "target title" }]),
      "done",
    ].join("\n")

    await expect(findNativeSessionIdByTitle(repoRoot, "target title")).resolves.toBe("ses_target")
  })

  test("runForkedSession resolves native session id even when session list stdout has surrounding noise", async () => {
    process.env.FAKE_OPENCODE_STDOUT = [
      "info: listing sessions",
      JSON.stringify([{ id: "ses_target", title: "target title" }]),
      "done",
    ].join("\n")

    const seenNativeSessionIds: string[] = []
    const result = await runForkedSession(
      {
        sessionId: "root-session-1",
        repoRoot,
        title: "target title",
        prompt: "Please supervise batch 10.01",
        onNativeSessionId: async (nativeSessionId) => {
          seenNativeSessionIds.push(nativeSessionId)
        },
      },
      {
        findNativeSessionIdByTitle,
      },
    )

    expect(result.code).toBe(0)
    expect(result.nativeSessionId).toBe("ses_target")
    expect(seenNativeSessionIds).toEqual(["ses_target"])
  })
})
