import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from "bun:test"
import { join } from "path"
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "fs"
import {
  generateAllPrompts,
  parseThreadId,
  formatThreadId,
  getPromptContext,
  generateThreadPrompt,
} from "../src/lib/prompts.ts"
import { saveIndex } from "../src/lib/index.ts"
import type { WorkIndex } from "../src/lib/types.ts"
import { bootstrapSqliteStructuredStorage, syncStructuredStorageWorkstreamStateToSqlite } from "../src/lib/sqlite-storage.ts"
import { createEmptyStructuredStorageWorkstreamState } from "../src/lib/structured-storage.ts"

const TEST_DIR = join(import.meta.dir, "temp_prompts_test")
const REPO_ROOT = TEST_DIR

// Sample PLAN.md content for testing
const PLAN_MD_CONTENT = `# Plan: Test Workstream

## Summary

A test workstream for prompt generation.

## References

- ref1
- ref2

## Stages

### Stage 01: Setup

#### Definition

Initial setup stage for the project.

#### Constitution

**Inputs:**

- Input 1

**Structure:**

- Structure 1

**Outputs:**

- Output 1

#### Stage Questions

- [x] Question 1

#### Batches

##### Batch 01: Core Setup

###### Thread 01: Database Setup

**Summary:**

Set up the database schema.

**Details:**

- Create tables
- Add indexes

###### Thread 02: API Setup

**Summary:**

Set up the API endpoints.

**Details:**

- Create routes
- Add middleware

##### Batch 02: Testing Setup

###### Thread 01: Unit Tests

**Summary:**

Set up unit testing infrastructure.

**Details:**

- Configure test runner
- Add test utilities

### Stage 02: Implementation

#### Definition

Main implementation stage.

#### Constitution

**Inputs:**

- Setup complete

**Structure:**

- Implement features

**Outputs:**

- Working features

#### Stage Questions

- [x] All questions resolved

#### Batches

##### Batch 01: Features

###### Thread 01: Feature A

**Summary:**

Implement Feature A.

**Details:**

- Feature A implementation
`

describe("Prompt Generation Library", () => {
  beforeEach(() => {
    // Clean up before each test
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
    mkdirSync(join(TEST_DIR, "work", "test-stream"), { recursive: true })

    // Create index.json
    const index: WorkIndex = {
      version: "1.0.0",
      last_updated: new Date().toISOString(),
      streams: [
        {
          id: "test-stream",
          name: "Test Workstream",
          order: 1,
          size: "short",
          session_estimated: {
            length: 2,
            unit: "session",
            session_minutes: [30, 45],
            session_iterations: [4, 8],
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          path: "work/test-stream",
          generated_by: { workstreams: "1.0.0" },
        },
      ],
    }
    saveIndex(REPO_ROOT, index)

    // Create PLAN.md
    writeFileSync(
      join(REPO_ROOT, "work/test-stream/PLAN.md"),
      PLAN_MD_CONTENT,
    )

    // Create tasks.json (required for getPromptContext)
    const tasksJson = {
      version: "1.0.0",
      stream_id: "test-stream",
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Create database schema",
          thread_name: "Database Setup",
          batch_name: "Core Setup",
          stage_name: "Setup",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
        {
          id: "01.01.01.02",
          name: "Add indexes",
          thread_name: "Database Setup",
          batch_name: "Core Setup",
          stage_name: "Setup",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
        {
          id: "01.01.02.01",
          name: "Create API routes",
          thread_name: "API Setup",
          batch_name: "Core Setup",
          stage_name: "Setup",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
        {
          id: "01.02.01.01",
          name: "Configure test runner",
          thread_name: "Unit Tests",
          batch_name: "Testing Setup",
          stage_name: "Setup",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
        {
          id: "02.01.01.01",
          name: "Implement Feature A",
          thread_name: "Feature A",
          batch_name: "Features",
          stage_name: "Implementation",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
        },
      ],
    }
    writeFileSync(
      join(REPO_ROOT, "work/test-stream/tasks.json"),
      JSON.stringify(tasksJson, null, 2),
    )
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true })
    }
  })

  describe("parseThreadId", () => {
    test("should parse valid thread ID", () => {
      const result = parseThreadId("01.02.03")
      expect(result).toEqual({ stage: 1, batch: 2, thread: 3 })
    })

    test("should return null for invalid format", () => {
      expect(parseThreadId("01.02")).toBeNull()
      expect(parseThreadId("01.02.03.04")).toBeNull()
      expect(parseThreadId("invalid")).toBeNull()
    })
  })

  describe("formatThreadId", () => {
    test("should format thread ID with zero padding", () => {
      expect(formatThreadId(1, 2, 3)).toBe("01.02.03")
      expect(formatThreadId(10, 11, 12)).toBe("10.11.12")
    })
  })

  describe("getPromptContext", () => {
    test("should get context for valid thread", () => {
      const context = getPromptContext(REPO_ROOT, "test-stream", "01.01.01")

      expect(context.threadId).toEqual({ stage: 1, batch: 1, thread: 1 })
      expect(context.streamId).toBe("test-stream")
      expect(context.streamName).toBe("Test Workstream")
      expect(context.thread.name).toBe("Database Setup")
      expect(context.stage.name).toBe("Setup")
      expect(context.batch.name).toBe("Core Setup")
      expect(context.tasks.length).toBe(2) // Two tasks in thread 01.01.01
      expect(context.parallelThreads.length).toBe(1) // API Setup thread
    })

    test("should throw for invalid thread ID format", () => {
      expect(() =>
        getPromptContext(REPO_ROOT, "test-stream", "invalid"),
      ).toThrow(/Invalid thread ID format/)
    })

    test("should throw for non-existent stage", () => {
      expect(() =>
        getPromptContext(REPO_ROOT, "test-stream", "99.01.01"),
      ).toThrow(/Stage 99 not found/)
    })

    test("prefers canonical thread query state for agent and task context", () => {
      const state = createEmptyStructuredStorageWorkstreamState("test-stream")
      state.hierarchy.stages = [
        { id: "01", number: 1, name: "Setup" },
        { id: "02", number: 2, name: "Implementation" },
      ]
      state.hierarchy.batches = [
        { id: "01.01", stageId: "01", number: 1, name: "Core Setup" },
        { id: "01.02", stageId: "01", number: 2, name: "Testing Setup" },
        { id: "02.01", stageId: "02", number: 1, name: "Features" },
      ]
      state.hierarchy.threads = [
        {
          id: "01.01.01",
          stageId: "01",
          batchId: "01.01",
          number: 1,
          name: "Database Setup",
          promptPath: "test-stream/prompts/persisted/database-setup.md",
        },
        { id: "01.01.02", stageId: "01", batchId: "01.01", number: 2, name: "API Setup" },
        { id: "01.02.01", stageId: "01", batchId: "01.02", number: 1, name: "Unit Tests" },
        { id: "02.01.01", stageId: "02", batchId: "02.01", number: 1, name: "Feature A" },
      ]
      state.hierarchy.tasks = [
        {
          id: "01.01.01.01",
          stageId: "01",
          batchId: "01.01",
          threadId: "01.01.01",
          number: 1,
          name: "Canonical schema task",
          status: "pending",
          createdAt: "2026-05-14T00:00:00.000Z",
          updatedAt: "2026-05-14T00:00:00.000Z",
          assignedAgent: "canonical-db-agent",
        },
      ]

      bootstrapSqliteStructuredStorage(REPO_ROOT)
      syncStructuredStorageWorkstreamStateToSqlite(REPO_ROOT, state)

      const context = getPromptContext(REPO_ROOT, "test-stream", "01.01.01")

      expect(context.agentName).toBe("canonical-db-agent")
      expect(context.tasks).toHaveLength(1)
      expect(context.tasks[0]).toMatchObject({
        id: "01.01.01.01",
        name: "Canonical schema task",
      })
    })
  })

  describe("generateThreadPrompt", () => {
    test("should generate markdown prompt", () => {
      const context = getPromptContext(REPO_ROOT, "test-stream", "01.01.01")
      const prompt = generateThreadPrompt(context)

      expect(prompt).toContain("Hello Agent!")
      expect(prompt).toContain("Test Workstream")
      expect(prompt).toContain("Database Setup")
      expect(prompt).toContain("## Thread Summary")
      expect(prompt).toContain("## Thread Details")
      expect(prompt).toContain("Your tasks are:")
      expect(prompt).toContain("01.01.01.01")
    })
  })

  describe("generateAllPrompts", () => {
    test("should generate prompts for all threads", () => {
      const result = generateAllPrompts(REPO_ROOT, "test-stream")

      expect(result.success).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.totalThreads).toBe(4) // 2 in batch 01, 1 in batch 02, 1 in stage 02
      expect(result.generatedFiles.length).toBe(4)

      // Verify file paths follow correct naming convention
      const paths = result.generatedFiles
      expect(paths.some((p) => p.includes("01-setup/01-core-setup/database-setup.md"))).toBe(true)
      expect(paths.some((p) => p.includes("01-setup/01-core-setup/api-setup.md"))).toBe(true)
      expect(paths.some((p) => p.includes("01-setup/02-testing-setup/unit-tests.md"))).toBe(true)
      expect(paths.some((p) => p.includes("02-implementation/01-features/feature-a.md"))).toBe(true)
    })

    test("should create prompt files on disk", () => {
      const result = generateAllPrompts(REPO_ROOT, "test-stream")

      expect(result.success).toBe(true)

      // Verify files exist
      for (const relPath of result.generatedFiles) {
        const fullPath = join(TEST_DIR, "work", relPath)
        expect(existsSync(fullPath)).toBe(true)

        // Verify content
        const content = readFileSync(fullPath, "utf-8")
        expect(content).toContain("Hello Agent!")
      }
    })

    test("should fail gracefully when PLAN.md is missing", () => {
      // Delete PLAN.md
      rmSync(join(REPO_ROOT, "work/test-stream/PLAN.md"))

      const result = generateAllPrompts(REPO_ROOT, "test-stream")

      expect(result.success).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toContain("PLAN.md not found")
    })

    test("should fail gracefully when PLAN.md is invalid", () => {
      // Overwrite with invalid content
      writeFileSync(
        join(REPO_ROOT, "work/test-stream/PLAN.md"),
        "# Not a valid plan",
      )

      const result = generateAllPrompts(REPO_ROOT, "test-stream")

      expect(result.success).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    test("should return correct totalThreads count", () => {
      const result = generateAllPrompts(REPO_ROOT, "test-stream")

      // Count threads in PLAN.md:
      // Stage 01 > Batch 01: Thread 01, Thread 02 (2)
      // Stage 01 > Batch 02: Thread 01 (1)
      // Stage 02 > Batch 01: Thread 01 (1)
      // Total: 4
      expect(result.totalThreads).toBe(4)
    })

    test("should generate files in correct directory structure", () => {
      const result = generateAllPrompts(REPO_ROOT, "test-stream")

      expect(result.success).toBe(true)

      // Check directory structure
      const promptsDir = join(TEST_DIR, "work/test-stream/prompts")
      expect(existsSync(promptsDir)).toBe(true)
      expect(existsSync(join(promptsDir, "01-setup"))).toBe(true)
      expect(existsSync(join(promptsDir, "01-setup/01-core-setup"))).toBe(true)
      expect(existsSync(join(promptsDir, "01-setup/02-testing-setup"))).toBe(true)
      expect(existsSync(join(promptsDir, "02-implementation"))).toBe(true)
      expect(existsSync(join(promptsDir, "02-implementation/01-features"))).toBe(true)
    })
  })
})
