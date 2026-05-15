import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { 
    findOpenQuestions, 
    extractInputFileReferences, 
    findMissingInputFiles,
    extractFilesFromThread,
    extractFilesFromText,
    findSharedFilesInParallelThreads,
    findSharedFilesInPlan,
    formatSharedFileWarnings,
    type SharedFileWarning
} from "../src/lib/analysis"
import type { StreamDocument, ThreadDefinition } from "../src/lib/types"

describe("Analysis Logic", () => {

    describe("findOpenQuestions", () => {
        test("finds unchecked items with line numbers", () => {
            const content = `
# Plan
- [ ] Open question 1
- [x] Resolved note 2
- [ ] Open question 3
`
            const result = findOpenQuestions(content)
            expect(result).toHaveLength(2)
            expect(result[0]).toEqual({ line: 3, question: "Open question 1", stage: undefined })
            expect(result[1]).toEqual({ line: 5, question: "Open question 3", stage: undefined })
        })

        test("identifies stage context", () => {
            const content = `
### Stage 1: Planning
- [ ] Question 1

### Stage 2: Execution
- [ ] Question 2
`
            const result = findOpenQuestions(content)
            expect(result).toHaveLength(2)
            expect(result[0]?.question).toBe("Question 1")
            expect(result[0]?.stage).toBe(1)
            expect(result[1]?.question).toBe("Question 2")
            expect(result[1]?.stage).toBe(2)
        })
    })

    describe("extractInputFileReferences", () => {
        test("extracts inputs from Inputs section", () => {
            const content = `
## Stage 1
**Inputs:**
- \`input1.txt\`
- [input2.md](file://input2.md)
- input3.json
`
            const result = extractInputFileReferences(content)
            expect(result).toContain("input1.txt")
            expect(result).toContain("input2.md")
            expect(result).toContain("input3.json")
            expect(result).toHaveLength(3)
        })

        test("ignores files outside Inputs section", () => {
            const content = `
Check \`other.txt\`
**Inputs:**
- \`input.txt\`
`
            const result = extractInputFileReferences(content)
            expect(result).toEqual(["input.txt"])
        })
    })

    describe("findMissingInputFiles", () => {
        let tempDir: string

        beforeEach(async () => {
            tempDir = await mkdtemp(join(tmpdir(), "workstreams-test-"))
        })

        afterEach(async () => {
            await rm(tempDir, { recursive: true, force: true })
        })

        test("reports missing files", () => {
            const missing = findMissingInputFiles(tempDir, join(tempDir, "PLAN.md"), ["missing.txt"])
            expect(missing).toEqual(["missing.txt"])
        })

        test("does not report existing files", async () => {
            await writeFile(join(tempDir, "exists.txt"), "content")
            const missing = findMissingInputFiles(tempDir, join(tempDir, "PLAN.md"), ["exists.txt"])
            expect(missing).toHaveLength(0)
        })

        test("checks relative paths", async () => {
            await mkdir(join(tempDir, "files"))
            await writeFile(join(tempDir, "files/exists.txt"), "content")
            const missing = findMissingInputFiles(tempDir, join(tempDir, "work/PLAN.md"), ["files/exists.txt"])
            // Note: findMissingInputFiles checks relative to Plan or Repo. 
            // If PLAN.md is deep, relative resolution might fail if not careful, but relative to repoRoot (tempDir) should work.
            // implementation: check [planDir/file, repoRoot/file, file]
            expect(missing).toHaveLength(0)
        })
    })

    describe("extractFilesFromThread", () => {
        test("extracts backtick-quoted files", () => {
            const thread: ThreadDefinition = {
                id: 1,
                name: "Test Thread",
                summary: "Modify `src/config.ts` and update settings",
                details: "Edit `lib/utils.ts` to add helper function"
            }
            const files = extractFilesFromThread(thread)
            expect(files).toContain("src/config.ts")
            expect(files).toContain("lib/utils.ts")
        })

        test("extracts path-style files", () => {
            const thread: ThreadDefinition = {
                id: 1,
                name: "Test Thread",
                summary: "Work on src/components/Button.tsx",
                details: "Also update tests/Button.test.ts"
            }
            const files = extractFilesFromThread(thread)
            expect(files).toContain("src/components/Button.tsx")
            expect(files).toContain("tests/Button.test.ts")
        })

        test("deduplicates files", () => {
            const thread: ThreadDefinition = {
                id: 1,
                name: "Test Thread",
                summary: "Edit `config.ts`",
                details: "Update `config.ts` again"
            }
            const files = extractFilesFromThread(thread)
            expect(files.filter(f => f === "config.ts")).toHaveLength(1)
        })
    })

    describe("extractFilesFromText", () => {
        test("extracts various file patterns", () => {
            const text = `
Update \`package.json\` with new deps.
Modify src/index.ts for exports.
See [docs](file://README.md) for reference.
`
            const files = extractFilesFromText(text)
            expect(files).toContain("package.json")
            expect(files).toContain("src/index.ts")
            expect(files).toContain("README.md")
        })

        test("ignores URLs", () => {
            const text = "Check https://example.com/file.txt"
            const files = extractFilesFromText(text)
            expect(files).not.toContain("https://example.com/file.txt")
        })
    })

    describe("findSharedFilesInParallelThreads", () => {
        test("detects shared files in same batch", () => {
            const doc: StreamDocument = {
                streamName: "Test Stream",
                summary: "Test",
                references: [],
                stages: [{
                    id: 1,
                    name: "Stage One",
                    definition: "",
                    constitution: "",
                    questions: [],
                    batches: [{
                        id: 1,
                        prefix: "01",
                        name: "Parallel Batch",
                        summary: "",
                        threads: [
                            {
                                id: 1,
                                name: "Thread A",
                                summary: "Edit `shared.ts`",
                                details: "Modify shared file"
                            },
                            {
                                id: 2,
                                name: "Thread B",
                                summary: "Also edit `shared.ts`",
                                details: "Another modification"
                            }
                        ]
                    }]
                }]
            }

            const warnings = findSharedFilesInParallelThreads(doc)
            expect(warnings).toHaveLength(1)
            expect(warnings[0]!.file).toBe("shared.ts")
            expect(warnings[0]!.threads).toHaveLength(2)
            expect(warnings[0]!.stageId).toBe(1)
            expect(warnings[0]!.batchId).toBe(1)
        })

        test("ignores files in different batches", () => {
            const doc: StreamDocument = {
                streamName: "Test Stream",
                summary: "Test",
                references: [],
                stages: [{
                    id: 1,
                    name: "Stage One",
                    definition: "",
                    constitution: "",
                    questions: [],
                    batches: [
                        {
                            id: 1,
                            prefix: "01",
                            name: "Batch One",
                            summary: "",
                            threads: [{
                                id: 1,
                                name: "Thread A",
                                summary: "Edit `shared.ts`",
                                details: ""
                            }]
                        },
                        {
                            id: 2,
                            prefix: "02",
                            name: "Batch Two",
                            summary: "",
                            threads: [{
                                id: 1,
                                name: "Thread B",
                                summary: "Edit `shared.ts`",
                                details: ""
                            }]
                        }
                    ]
                }]
            }

            const warnings = findSharedFilesInParallelThreads(doc)
            expect(warnings).toHaveLength(0)
        })

        test("ignores single-thread batches", () => {
            const doc: StreamDocument = {
                streamName: "Test Stream",
                summary: "Test",
                references: [],
                stages: [{
                    id: 1,
                    name: "Stage One",
                    definition: "",
                    constitution: "",
                    questions: [],
                    batches: [{
                        id: 1,
                        prefix: "01",
                        name: "Single Thread Batch",
                        summary: "",
                        threads: [{
                            id: 1,
                            name: "Thread A",
                            summary: "Edit `shared.ts`",
                            details: ""
                        }]
                    }]
                }]
            }

            const warnings = findSharedFilesInParallelThreads(doc)
            expect(warnings).toHaveLength(0)
        })
    })

    describe("findSharedFilesInPlan", () => {
        test("detects shared files in parallel threads", () => {
            const content = `# Workstream: Test

## Stage 01: Implementation

### Batch 01: Parallel Work

#### Thread 01: API Work
- [ ] Modify \`src/api.ts\` to add endpoint

#### Thread 02: Service Work
- [ ] Update \`src/api.ts\` with service calls
`
            const warnings = findSharedFilesInPlan(content)
            expect(warnings).toHaveLength(1)
            expect(warnings[0]!.file).toBe("src/api.ts")
            expect(warnings[0]!.threads).toHaveLength(2)
        })

        test("ignores files in different batches", () => {
            const content = `# Workstream: Test

## Stage 01: Implementation

### Batch 01: First Batch

#### Thread 01: Thread A
- [ ] Edit \`shared.ts\`

### Batch 02: Second Batch

#### Thread 01: Thread B
- [ ] Edit \`shared.ts\`
`
            const warnings = findSharedFilesInPlan(content)
            expect(warnings).toHaveLength(0)
        })
    })

    describe("formatSharedFileWarnings", () => {
        test("formats warnings with correct message", () => {
            const warnings: SharedFileWarning[] = [{
                file: "config.ts",
                stageId: 1,
                stageName: "Setup",
                batchId: 2,
                batchName: "Config Batch",
                threads: [
                    { id: 1, name: "Thread A" },
                    { id: 2, name: "Thread B" }
                ]
            }]

            const formatted = formatSharedFileWarnings(warnings)
            expect(formatted).toHaveLength(1)
            expect(formatted[0]).toContain('File "config.ts" is shared across parallel threads, please reconsider planning')
            expect(formatted[0]).toContain("Stage 1 (Setup)")
            expect(formatted[0]).toContain("Batch 2 (Config Batch)")
            expect(formatted[0]).toContain("Thread 1 (Thread A)")
            expect(formatted[0]).toContain("Thread 2 (Thread B)")
        })
    })
})
