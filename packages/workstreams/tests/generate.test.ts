import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { existsSync, readdirSync } from "node:fs"
import { generateStream, createGenerateArgs, scaffoldPlanStages } from "../src/lib/generate"
import { loadIndex } from "../src/lib/index"
import { bootstrapSqliteStructuredStorage } from "../src/lib/sqlite-storage"
import { loadCanonicalWorkspaceState } from "../src/lib/workspace-read-model"

describe("createGenerateArgs", () => {
  test("creates args with name and repoRoot", () => {
    const args = createGenerateArgs("my-feature", "/repo")
    expect(args).toEqual({
      name: "my-feature",
      repoRoot: "/repo",
      stages: undefined,
    })
  })

  test("creates args with stages option", () => {
    const args = createGenerateArgs("my-feature", "/repo", 4)
    expect(args).toEqual({
      name: "my-feature",
      repoRoot: "/repo",
      stages: 4,
    })
  })
})

describe("generateStream", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agenv-test-"))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe("directory structure", () => {
    test("creates only the minimal initial workstream layout", async () => {
      const args = createGenerateArgs("test-feature", tempDir)
      const result = generateStream(args)

      expect(result.streamId).toBe("000-test-feature")
      expect(result.streamPath).toBe("work/000-test-feature")

      const streamDir = join(tempDir, "work", "000-test-feature")
      expect(existsSync(streamDir)).toBe(true)
      expect(existsSync(join(streamDir, "README.md"))).toBe(true)
      expect(existsSync(join(streamDir, "docs"))).toBe(true)
      expect(existsSync(join(streamDir, "resources"))).toBe(true)
      expect(existsSync(join(streamDir, "stages"))).toBe(true)
      expect(existsSync(join(streamDir, "PLAN.md"))).toBe(false)
      expect(existsSync(join(streamDir, "REQUIREMENTS.md"))).toBe(false)
      expect(existsSync(join(streamDir, "tasks.json"))).toBe(false)
    })

    test("does not create checklist or principle directories", async () => {
      const args = createGenerateArgs("test-feature", tempDir)
      generateStream(args)

      const streamDir = join(tempDir, "work", "000-test-feature")
      expect(existsSync(join(streamDir, "checklist"))).toBe(false)
      expect(existsSync(join(streamDir, "principle"))).toBe(false)
    })
  })

  describe("README.md generation", () => {
    test("creates README.md with draft workflow guidance", async () => {
      generateStream(createGenerateArgs("test-feature", tempDir))

      const planMdPath = join(tempDir, "work/000-test-feature/README.md")
      const content = await readFile(planMdPath, "utf-8")

      expect(content).toContain("# Test Feature")
      expect(content).toContain("Stream ID: `000-test-feature`")
      expect(content).toContain("`resources/`")
      expect(content).toContain("`docs/`")
      expect(content).toContain("`stages/`")
      expect(content).toContain("## Summary")
      expect(content).toContain("## Deliverables")
      expect(content).toContain("There is no root `REQUIREMENTS.md`, `PLAN.md`, or `TASKS.md`")
      expect(content).toContain("work plan create --stream \"000-test-feature\" --stages <n>")
    })
  })

  describe("stage scaffolding", () => {
    test("creates stage directories with the required stage-local files", async () => {
      generateStream(createGenerateArgs("test-feature", tempDir))
      const result = scaffoldPlanStages(tempDir, "000-test-feature", 1)

      const stageDir = join(tempDir, "work/000-test-feature/stages/01")
      const planContent = await readFile(join(stageDir, "PLAN.md"), "utf-8")
      const requirementsContent = await readFile(join(stageDir, "REQUIREMENTS.md"), "utf-8")
      const workContent = await readFile(join(stageDir, "WORK.md"), "utf-8")

      expect(result.stagesPath).toBe(join(tempDir, "work/000-test-feature/stages"))
      expect(planContent).toContain("# Stage 01 Plan")
      expect(planContent).toContain("## Batches")
      expect(planContent).toContain("### Batch 01:")
      expect(planContent).toContain("#### Thread 01:")
      expect(requirementsContent).toContain("# Stage 01 Requirements")
      expect(requirementsContent).toContain("## Deliverables")
      expect(workContent).toContain("# Stage 01 Work")
      expect(existsSync(join(stageDir, "specs"))).toBe(true)
      expect(readdirSync(stageDir).sort()).toEqual(["PLAN.md", "REQUIREMENTS.md", "WORK.md", "specs"])
    })

    test("scaffolds sequentially numbered stage directories", async () => {
      generateStream(createGenerateArgs("test-feature", tempDir))

      const result = scaffoldPlanStages(tempDir, "000-test-feature", 2)

      expect(result.stageCount).toBe(2)
      expect(existsSync(join(tempDir, "work/000-test-feature/stages/01/PLAN.md"))).toBe(true)
      expect(existsSync(join(tempDir, "work/000-test-feature/stages/02/PLAN.md"))).toBe(true)
      expect(existsSync(join(tempDir, "work/000-test-feature/PLAN.md"))).toBe(false)
    })

    test("fails to scaffold stages when stages/ already contains stage content", async () => {
      generateStream(createGenerateArgs("test-feature", tempDir))
      scaffoldPlanStages(tempDir, "000-test-feature", 1)

      expect(() => scaffoldPlanStages(tempDir, "000-test-feature", 2)).toThrow(
        'stages/ for workstream "000-test-feature" already contains stage content',
      )
    })

    test("stage plan includes version info", async () => {
      generateStream(createGenerateArgs("test-feature", tempDir))
      scaffoldPlanStages(tempDir, "000-test-feature", 1)

      const planMdPath = join(tempDir, "work/000-test-feature/stages/01/PLAN.md")
      const content = await readFile(planMdPath, "utf-8")

      expect(content).toContain("@agenv/workstreams@")
    })

    test("stage plan includes last updated timestamp", async () => {
      generateStream(createGenerateArgs("test-feature", tempDir))
      scaffoldPlanStages(tempDir, "000-test-feature", 1)

      const planMdPath = join(tempDir, "work/000-test-feature/stages/01/PLAN.md")
      const content = await readFile(planMdPath, "utf-8")

      expect(content).toMatch(/\*Last updated: \d{4}-\d{2}-\d{2}\*/)
    })
  })

  describe("deferred planning artifacts", () => {
    test("does not create REQUIREMENTS.md or tasks.json during workstream creation", () => {
      generateStream(createGenerateArgs("test-feature", tempDir))

      const streamDir = join(tempDir, "work", "000-test-feature")
      expect(existsSync(join(streamDir, "REQUIREMENTS.md"))).toBe(false)
      expect(existsSync(join(streamDir, "tasks.json"))).toBe(false)
    })
  })



  describe("index.json updates", () => {
    test("updates index.json with workstream metadata", async () => {
      const args = createGenerateArgs("test-feature", tempDir)
      generateStream(args)

      const index = loadIndex(tempDir)
      expect(index.streams).toHaveLength(1)
      expect(index.streams[0]?.id).toBe("000-test-feature")
      expect(index.streams[0]?.name).toBe("test-feature")
      expect(index.streams[0]?.path).toBe("work/000-test-feature")
    })

    test("stores version in index metadata", async () => {
      const args = createGenerateArgs("test-feature", tempDir)
      generateStream(args)

      const index = loadIndex(tempDir)
      expect(index.streams[0]?.generated_by.workstreams).toBeDefined()
    })

    test("syncs canonical workspace state when sqlite storage is enabled", async () => {
      bootstrapSqliteStructuredStorage(tempDir)

      const args = createGenerateArgs("test-feature", tempDir)
      generateStream(args)

      const workspaceState = loadCanonicalWorkspaceState(tempDir)
      expect(workspaceState.workstreams).toHaveLength(1)
      expect(workspaceState.workstreams[0]).toMatchObject({
        id: "000-test-feature",
        name: "test-feature",
        storageRoot: "work/000-test-feature",
      })

      const index = loadIndex(tempDir)
      expect(index.streams[0]?.id).toBe("000-test-feature")
    })
  })

  describe("workstream ordering", () => {
    test("increments order number for subsequent workstreams", async () => {
      generateStream(createGenerateArgs("first-stream", tempDir))
      generateStream(createGenerateArgs("second-stream", tempDir))
      generateStream(createGenerateArgs("third-stream", tempDir))

      const index = loadIndex(tempDir)
      expect(index.streams[0]?.id).toBe("000-first-stream")
      expect(index.streams[1]?.id).toBe("001-second-stream")
      expect(index.streams[2]?.id).toBe("002-third-stream")
    })
  })

  describe("error handling", () => {
    test("throws on duplicate workstream name", () => {
      const args = createGenerateArgs("test-feature", tempDir)
      generateStream(args)

      expect(() => generateStream(args)).toThrow(
        'Workstream with name "test-feature" already exists',
      )
    })
  })
})
