import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { main as validateMain } from "../src/cli/validate.ts"
import { captureCliOutput } from "./helpers/cli-runner.ts"

describe("CLI: validate requirements", () => {
  let tempDir: string
  let originalExit: typeof process.exit

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-validate-requirements-"))
    await mkdir(join(tempDir, ".git"), { recursive: true })
    await mkdir(join(tempDir, "work", "001-test-stream", "resources"), { recursive: true })
    await mkdir(join(tempDir, "packages", "workstreams", "src", "lib"), { recursive: true })

    await writeFile(
      join(tempDir, "work", "index.json"),
      JSON.stringify({
        version: "1.0.0",
        last_updated: "2026-03-26T00:00:00.000Z",
        current_stream: "001-test-stream",
        streams: [
          {
            id: "001-test-stream",
            name: "Test Stream",
            path: "work/001-test-stream",
            order: 1,
            created_at: "2026-03-26T00:00:00.000Z",
            updated_at: "2026-03-26T00:00:00.000Z",
          },
        ],
      }),
    )

    await writeFile(join(tempDir, "packages", "workstreams", "src", "lib", "generate.ts"), "export {}\n")
    await writeFile(join(tempDir, "work", "001-test-stream", "resources", "notes.md"), "notes\n")

    originalExit = process.exit
  })

  afterEach(async () => {
    process.exit = originalExit
    await rm(tempDir, { recursive: true, force: true })
  })

  test("validates REQUIREMENTS.md for the current stream and allows warnings-only results", async () => {
    await writeFile(
      join(tempDir, "work", "001-test-stream", "REQUIREMENTS.md"),
      `# Requirements

## Summary

Implement requirements CLI validation.

## Deliverables

- Add validation command

## Dependencies

## Resources
`,
    )

    const { stdout, stderr } = await captureCliOutput(() => {
      validateMain(["bun", "work-validate", "requirements", "--repo-root", tempDir])
    })

    const output = stdout.join("\n")
    expect(stderr).toEqual([])
    expect(output).toContain("REQUIREMENTS.md validation passed")
    expect(output).toContain("Warnings:")
    expect(output).toContain("Dependencies section is empty")
    expect(output).toContain("Resources section is empty")
  })

  test("supports JSON output and exits non-zero on validation errors", async () => {
    await writeFile(
      join(tempDir, "work", "001-test-stream", "REQUIREMENTS.md"),
      `# Requirements

## Summary

Broken requirements doc.

## Deliverables

- Add validation command

## Dependencies

- missing code span

## Resources

- \`resources/missing.md\`
`,
    )

    process.exit = ((code?: number) => {
      throw new Error(`Process exited with code ${code ?? 0}`)
    }) as typeof process.exit

    const { stdout, stderr } = await captureCliOutput(() => {
      try {
        validateMain(["bun", "work-validate", "requirements", "--repo-root", tempDir, "--json"])
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "Process exited with code 1") {
          throw error
        }
      }
    })

    expect(stderr).toEqual([])

    const parsed = JSON.parse(stdout.join("\n")) as {
      valid: boolean
      errors: string[]
      warnings: string[]
    }

    expect(parsed.valid).toBe(false)
    expect(parsed.errors).toContain("[Dependencies line 13] Dependency path entry is missing or invalid")
    expect(parsed.errors).toContain(
      "[Resources line 17] Referenced resource file does not exist under the workstream resources directory: resources/missing.md",
    )
    expect(parsed.warnings).toEqual([])
  })

  test("validates stage-local requirements without a root REQUIREMENTS.md", async () => {
    await mkdir(join(tempDir, "work", "001-test-stream", "stages", "01"), { recursive: true })
    await mkdir(join(tempDir, "work", "001-test-stream", "stages", "02"), { recursive: true })

    await writeFile(
      join(tempDir, "work", "001-test-stream", "stages", "01", "REQUIREMENTS.md"),
      `# Stage 01 Requirements

## Summary

Implement stage-local requirements validation.

## Deliverables

- Validate filled stage requirements documents

## Dependencies

- \`packages/workstreams/src/lib/generate.ts\`

## Resources

- \`resources/notes.md\`
`,
    )

    await writeFile(
      join(tempDir, "work", "001-test-stream", "stages", "02", "REQUIREMENTS.md"),
      `# Stage 02 Requirements

## Summary

<!-- Describe this stage's goal in freeform markdown. Do not use bullets in this section. -->

## Deliverables

<!-- Keep this section as bullets. List the concrete outputs this stage must produce. -->
- Replace with a concrete stage deliverable

## Dependencies

<!-- Keep this section as bullets. Reference repo-relative code paths in backticks, for example: \`packages/workstreams/src/lib/generate.ts\` -->
- \`packages/workstreams/src/lib/generate.ts\`

## Resources

<!-- Keep this section as bullets. Reference shared resources under \`resources/\` -->
- \`resources/example-notes.md\`
`,
    )

    const { stdout, stderr } = await captureCliOutput(() => {
      validateMain(["bun", "work-validate", "requirements", "--repo-root", tempDir])
    })

    const output = stdout.join("\n")
    expect(stderr).toEqual([])
    expect(output).toContain("REQUIREMENTS.md validation passed")
    expect(output).toContain("Ignored unfilled stage scaffold at")
    expect(output).toContain("stages/02/REQUIREMENTS.md")
  })
})
