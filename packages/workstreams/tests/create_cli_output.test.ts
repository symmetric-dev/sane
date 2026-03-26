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

  test("draft create output highlights requirements and resources workflow", async () => {
    const { stdout, stderr } = await captureCliOutput(() => {
      createMain(["bun", "work-create", "--name", "test-feature", "--repo-root", tempDir])
    })

    const output = stdout.join("\n")
    expect(stderr).toEqual([])
    expect(output).toContain("Created workstream: 000-test-feature")
    expect(output).toContain("Fill REQUIREMENTS.md and add supporting files under resources/")
    expect(output).toContain("Run: work validate requirements")
    expect(output).toContain("Scaffold plan stages: work plan create --stream \"000-test-feature\" --stages 3")
    expect(output).toContain("REQUIREMENTS.md  (draft requirements, dependencies, and resources)")
    expect(output).toContain("resources/  (supporting files referenced from REQUIREMENTS.md)")
  })

  test("staged create output still highlights requirements validation", async () => {
    const { stdout, stderr } = await captureCliOutput(() => {
      createMain(["bun", "work-create", "--name", "test-feature", "--repo-root", tempDir, "--stages", "2"])
    })

    const output = stdout.join("\n")
    expect(stderr).toEqual([])
    expect(output).toContain("Fill REQUIREMENTS.md and add supporting files under resources/")
    expect(output).toContain("Run: work validate requirements")
    expect(output).toContain("Run: work validate plan")
    expect(output).toContain("PLAN.md     (includes scaffolded stage templates)")
  })
})
