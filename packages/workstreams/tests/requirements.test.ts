import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseRequirementsDocument,
  validateRequirementsDocument,
} from "../src/lib/requirements.ts"

describe("requirements", () => {
  let tempDir: string
  const streamId = "000-test-stream"

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-requirements-test-"))
    await mkdir(join(tempDir, "work", streamId, "resources"), { recursive: true })
    await mkdir(join(tempDir, "packages", "workstreams", "src", "lib"), { recursive: true })
    await writeFile(join(tempDir, "packages", "workstreams", "src", "lib", "generate.ts"), "export {}\n")
    await writeFile(join(tempDir, "work", streamId, "resources", "notes.md"), "notes\n")
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test("parses summary text and bullet sections", () => {
    const content = `# Requirements

## Summary

This workstream updates generation.

More detail here.

## Deliverables

- Add REQUIREMENTS generation

## Dependencies

- ` + "`packages/workstreams/src/lib/generate.ts`" + `

## Resources

- ` + "`resources/notes.md`" + `
`

    const document = parseRequirementsDocument(content)

    expect(document.summary).toContain("This workstream updates generation.")
    expect(document.deliverables.map((entry) => entry.raw)).toEqual([
      "Add REQUIREMENTS generation",
    ])
    expect(document.dependencies[0]?.path).toBe("packages/workstreams/src/lib/generate.ts")
    expect(document.resources[0]?.path).toBe("resources/notes.md")
  })

  test("validates a complete requirements document", () => {
    const content = `# Requirements

## Summary

Implement requirements generation and parsing.

## Deliverables

- REQUIREMENTS template generation

## Dependencies

- ` + "`packages/workstreams/src/lib/generate.ts`" + `

## Resources

- ` + "`resources/notes.md`" + `
`

    const result = validateRequirementsDocument({
      content,
      repoRoot: tempDir,
      streamId,
    })

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test("accepts https URLs in resources without local file checks", () => {
    const content = `# Requirements

## Summary

Implement requirements generation and parsing.

## Deliverables

- REQUIREMENTS template generation

## Dependencies

- ` + "`packages/workstreams/src/lib/generate.ts`" + `

## Resources

- ` + "`https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&year=2024`" + `
`

    const result = validateRequirementsDocument({
      content,
      repoRoot: tempDir,
      streamId,
    })

    expect(result.valid).toBe(true)
    expect(result.document.resources[0]?.path).toBe(
      "https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=pitcher&year=2024",
    )
    expect(result.errors).toEqual([])
  })

  test("reports required heading and empty summary errors", () => {
    const content = `# Requirements

## Summary

<!-- summary goes here -->

## Deliverables

- Ship the parser

## Resources

- ` + "`resources/notes.md`" + `
`

    const result = validateRequirementsDocument({
      content,
      repoRoot: tempDir,
      streamId,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.message)).toContain("Missing required heading: Dependencies")
    expect(result.errors.map((error) => error.message)).toContain("Summary section is empty")
  })

  test("requires at least one deliverable bullet", () => {
    const content = `# Requirements

## Summary

Implement requirements generation and parsing.

## Deliverables

## Dependencies

## Resources
`

    const result = validateRequirementsDocument({
      content,
      repoRoot: tempDir,
      streamId,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.message)).toContain(
      "Deliverables section must contain at least one bullet",
    )
    expect(result.warnings).toContain("Dependencies section is empty")
    expect(result.warnings).toContain("Resources section is empty")
  })

  test("validates dependency entries and existence", () => {
    const content = `# Requirements

## Summary

Implement requirements generation and parsing.

## Deliverables

- Add parser

## Dependencies

- missing code span
- ` + "`../outside.ts`" + `
- ` + "`packages/workstreams/src/lib/missing.ts`" + `

## Resources

- ` + "`resources/notes.md`" + `
`

    const result = validateRequirementsDocument({
      content,
      repoRoot: tempDir,
      streamId,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.message)).toContain(
      "Dependency path entry is missing or invalid",
    )
    expect(result.errors.map((error) => error.message)).toContain(
      "Dependency path does not exist in repo root: packages/workstreams/src/lib/missing.ts",
    )
  })

  test("validates resource entries, location, and existence", () => {
    const content = `# Requirements

## Summary

Implement requirements generation and parsing.

## Deliverables

- Add parser

## Dependencies

- ` + "`packages/workstreams/src/lib/generate.ts`" + `

## Resources

- missing code span
- ` + "`docs/notes.md`" + `
- ` + "`resources/missing.md`" + `
`

    const result = validateRequirementsDocument({
      content,
      repoRoot: tempDir,
      streamId,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.message)).toContain(
      "Resource path entry is missing or invalid",
    )
    expect(result.errors.map((error) => error.message)).toContain(
      "Resource entry must be under resources/: docs/notes.md",
    )
    expect(result.errors.map((error) => error.message)).toContain(
      "Referenced resource file does not exist under the workstream resources directory: resources/missing.md",
    )
  })

  test("rejects malformed or unsupported resource references", () => {
    const content = `# Requirements

## Summary

Implement requirements generation and parsing.

## Deliverables

- Add parser

## Dependencies

- ` + "`packages/workstreams/src/lib/generate.ts`" + `

## Resources

- ` + "`https:/broken.example.com/resource`" + `
- ` + "`ftp://example.com/resource`" + `
`

    const result = validateRequirementsDocument({
      content,
      repoRoot: tempDir,
      streamId,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.message)).toEqual([
      "Resource path entry is missing or invalid",
      "Resource path entry is missing or invalid",
    ])
  })

  test("detects invalid heading order", () => {
    const content = `# Requirements

## Summary

Implement requirements generation and parsing.

## Dependencies

- ` + "`packages/workstreams/src/lib/generate.ts`" + `

## Deliverables

- Add parser

## Resources

- ` + "`resources/notes.md`" + `
`

    const result = validateRequirementsDocument({
      content,
      repoRoot: tempDir,
      streamId,
    })

    expect(result.valid).toBe(false)
    expect(result.errors.map((error) => error.message)).toContain(
      "Required headings must appear in order: Summary, Deliverables, Dependencies, Resources",
    )
  })
})
