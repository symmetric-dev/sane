import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as createMain } from "../src/cli/create.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("CLI: create", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-create-cli-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("draft create output highlights the minimal initial state", async () => {
    const { stdout, stderr } = await captureCliOutput(() => {
      createMain(["bun", "work-create", "--name", "test-feature", "--repo-root", tempDir])
    })

    const output = stdout.join("\n")
    expect(stderr).toEqual([])
    expect(output).toContain("Created workstream: 000-test-feature")
    expect(output).toContain("Review and update README.md with the overall goal and shared requirements")
    expect(output).toContain("work plan create --stream \"000-test-feature\" --stages 3")
    expect(output).toContain("Fill each stage directory under stages/ with REQUIREMENTS.md, PLAN.md, WORK.md, and specs/")
    expect(output).toContain("README.md   (shared workstream description and requirements)")
    expect(output).toContain("resources/  (supporting files and gathered inputs)")
    expect(output).toContain("stages/     (empty until 'work plan create' scaffolds stage directories)")
  })

  test("create rejects the removed --stages shortcut", async () => {
    const originalExit = process.exit

    try {
      process.exit = ((code?: number) => {
        throw new Error(`Process exited with code ${code ?? 0}`)
      }) as typeof process.exit

      const { stdout, stderr } = await captureCliOutput(() => {
        try {
          createMain(["bun", "work-create", "--name", "test-feature", "--repo-root", tempDir, "--stages", "2"])
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
            throw error
          }
        }
      })

      expect(stdout).toEqual([])
      expect(stderr.join("\n")).toContain("--stages is no longer supported on 'work create'")
      expect(stderr.join("\n")).toContain("work plan create --stages <n>")
    } finally {
      process.exit = originalExit
    }
  })
})
