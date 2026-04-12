import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { findNextIncompleteBatch, parseCliArgs as parseMultiCliArgs, validateCliArgs as validateMultiCliArgs } from "../src/cli/multi"
import { getCompletionMarkerPath, getSessionFilePath, buildRunCommand, buildRetryRunCommand, buildPostSynthesisCommand } from "../src/lib/opencode"
import type { Task, NormalizedModelSpec } from "../src/lib/types"
import * as notifications from "../src/lib/notifications"
import { mockPlayNotification } from "./helpers"

describe("multi cli", () => {
    const streamId = "001-test-stream"

    describe("findNextIncompleteBatch", () => {
        const baseTask: Task = {
            id: "01.01.01.01",
            name: "Test task",
            thread_name: "Thread 1",
            batch_name: "Batch 1",
            stage_name: "Stage 1",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "pending"
        }

        test("returns null for empty task list", () => {
            expect(findNextIncompleteBatch([])).toBeNull()
        })

        test("returns first batch if any task is pending", () => {
            const tasks = [
                { ...baseTask, id: "01.01.01.01", status: "completed" },
                { ...baseTask, id: "01.01.01.02", status: "pending" },
                { ...baseTask, id: "01.02.01.01", status: "pending" }
            ] as Task[]

            // Should return 01.01 because it has a pending task
            expect(findNextIncompleteBatch(tasks)).toBe("01.01")
        })

        test("returns second batch if first is fully complete", () => {
            const tasks = [
                { ...baseTask, id: "01.01.01.01", status: "completed" },
                { ...baseTask, id: "01.01.01.02", status: "completed" },
                { ...baseTask, id: "01.02.01.01", status: "pending" },
                { ...baseTask, id: "01.02.01.02", status: "in_progress" }
            ] as Task[]

            expect(findNextIncompleteBatch(tasks)).toBe("01.02")
        })

        test("returns null if all batches are complete", () => {
            const tasks = [
                { ...baseTask, id: "01.01.01.01", status: "completed" },
                { ...baseTask, id: "01.02.01.01", status: "cancelled" },
                { ...baseTask, id: "02.01.01.01", status: "completed" }
            ] as Task[]

            expect(findNextIncompleteBatch(tasks)).toBeNull()
        })

        test("handles out of order tasks", () => {
            const tasks = [
                { ...baseTask, id: "02.01.01.01", status: "pending" },
                { ...baseTask, id: "01.01.01.01", status: "completed" },
                { ...baseTask, id: "01.02.01.01", status: "completed" }
            ] as Task[]

            // 01.01 and 01.02 are done, 02.01 is pending
            expect(findNextIncompleteBatch(tasks)).toBe("02.01")
        })

        test("handles incomplete batch stuck in in_progress", () => {
            const tasks = [
                { ...baseTask, id: "01.01.01.01", status: "in_progress" },
                { ...baseTask, id: "02.01.01.01", status: "pending" }
            ] as Task[]

            expect(findNextIncompleteBatch(tasks)).toBe("01.01")
        })
    })

    describe("cli args", () => {
        test("parses headless and async flags", () => {
            const cliArgs = parseMultiCliArgs([
                "bun",
                "work",
                "--batch",
                "01.01",
                "--headless",
                "--async",
            ])

            expect(cliArgs).toMatchObject({
                batch: "01.01",
                headless: true,
                async: true,
            })
        })

        test("rejects async mode without headless mode", () => {
            expect(validateMultiCliArgs({ async: true })).toBe("--async requires --headless")
            expect(validateMultiCliArgs({ headless: true, async: true })).toBeNull()
        })
    })

    describe("completion marker files", () => {
        describe("getCompletionMarkerPath", () => {
            test("returns correct path for thread ID", () => {
                expect(getCompletionMarkerPath(streamId, "01.01.01")).toBe("/tmp/workstream-001-test-stream-01.01.01-complete.txt")
                expect(getCompletionMarkerPath(streamId, "02.03.04")).toBe("/tmp/workstream-001-test-stream-02.03.04-complete.txt")
            })

            test("handles various thread ID formats", () => {
                // Standard format
                expect(getCompletionMarkerPath(streamId, "01.02.03")).toContain("01.02.03")
                // Just numbers
                expect(getCompletionMarkerPath(streamId, "1.2.3")).toContain("1.2.3")
            })
        })

        describe("getSessionFilePath", () => {
            test("returns correct path for thread ID", () => {
                expect(getSessionFilePath(streamId, "01.01.01")).toBe("/tmp/workstream-001-test-stream-01.01.01-session.txt")
                expect(getSessionFilePath(streamId, "02.03.04")).toBe("/tmp/workstream-001-test-stream-02.03.04-session.txt")
            })

            test("handles various thread ID formats", () => {
                // Standard format
                expect(getSessionFilePath(streamId, "01.02.03")).toContain("01.02.03")
                expect(getSessionFilePath(streamId, "01.02.03")).toContain("-session.txt")
                // Just numbers
                expect(getSessionFilePath(streamId, "1.2.3")).toContain("1.2.3")
            })
        })

        describe("buildRunCommand with threadId", () => {
            test("includes completion marker write when threadId provided", () => {
                const cmd = buildRunCommand(
                    4096,
                    "anthropic/claude-sonnet-4",
                    "/path/to/prompt.md",
                    "Test Thread",
                    undefined,
                    "01.01.01",
                    { streamId }
                )
                
                // Should contain marker file write command
                expect(cmd).toContain("/tmp/workstream-001-test-stream-01.01.01-complete.txt")
                expect(cmd).toContain('echo "done"')
            })

            test("includes session file write when threadId provided", () => {
                const cmd = buildRunCommand(
                    4096,
                    "anthropic/claude-sonnet-4",
                    "/path/to/prompt.md",
                    "Test Thread",
                    undefined,
                    "01.01.01",
                    { streamId }
                )
                
                // Should contain session file write command
                expect(cmd).toContain("/tmp/workstream-001-test-stream-01.01.01-session.txt")
                expect(cmd).toContain('$SESSION_ID')
            })

            test("does not include marker write when threadId not provided", () => {
                const cmd = buildRunCommand(
                    4096,
                    "anthropic/claude-sonnet-4",
                    "/path/to/prompt.md",
                    "Test Thread"
                )
                
                // Should NOT contain marker file path
                expect(cmd).not.toContain("-complete.txt")
            })

            test("does not include session file write when threadId not provided", () => {
                const cmd = buildRunCommand(
                    4096,
                    "anthropic/claude-sonnet-4",
                    "/path/to/prompt.md",
                    "Test Thread"
                )
                
                // Should NOT contain session file path
                expect(cmd).not.toContain("-session.txt")
            })

            test("headless mode skips session resume and read prompt", () => {
                const cmd = buildRunCommand(
                    4096,
                    "anthropic/claude-sonnet-4",
                    "/path/to/prompt.md",
                    "Test Thread",
                    undefined,
                    "01.01.01",
                    { headless: true, streamId }
                )

                expect(cmd).toContain("WORKSTREAM_HEADLESS=1")
                expect(cmd).not.toContain("opencode --session")
                expect(cmd).not.toContain("Press Enter to close")
                expect(cmd).not.toContain("\n  read")
            })
        })

        describe("buildRetryRunCommand with threadId", () => {
            test("includes completion marker write when threadId provided (single model)", () => {
                const models: NormalizedModelSpec[] = [
                    { model: "anthropic/claude-sonnet-4" }
                ]
                
                const cmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread",
                    "01.02.03",
                    { streamId }
                )
                
                // With single model, delegates to buildRunCommand which includes marker
                expect(cmd).toContain("/tmp/workstream-001-test-stream-01.02.03-complete.txt")
            })

            test("includes session file write when threadId provided (single model)", () => {
                const models: NormalizedModelSpec[] = [
                    { model: "anthropic/claude-sonnet-4" }
                ]
                
                const cmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread",
                    "01.02.03",
                    { streamId }
                )
                
                // With single model, delegates to buildRunCommand which includes session file
                expect(cmd).toContain("/tmp/workstream-001-test-stream-01.02.03-session.txt")
            })

            test("includes completion marker write when threadId provided (multiple models)", () => {
                const models: NormalizedModelSpec[] = [
                    { model: "anthropic/claude-sonnet-4" },
                    { model: "google/gemini-pro" }
                ]
                
                const cmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread",
                    "02.01.01",
                    { streamId }
                )
                
                // With multiple models, should include marker after model attempts
                expect(cmd).toContain("/tmp/workstream-001-test-stream-02.01.01-complete.txt")
            })

            test("includes session file write when threadId provided (multiple models)", () => {
                const models: NormalizedModelSpec[] = [
                    { model: "anthropic/claude-sonnet-4" },
                    { model: "google/gemini-pro" }
                ]
                
                const cmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread",
                    "02.01.01",
                    { streamId }
                )
                
                // With multiple models, should include session file write
                expect(cmd).toContain("/tmp/workstream-001-test-stream-02.01.01-session.txt")
            })

            test("does not include marker write when threadId not provided", () => {
                const models: NormalizedModelSpec[] = [
                    { model: "anthropic/claude-sonnet-4" },
                    { model: "google/gemini-pro" }
                ]
                
                const cmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread"
                )
                
                // Should NOT contain marker file path
                expect(cmd).not.toContain("-complete.txt")
            })

            test("does not include session file write when threadId not provided", () => {
                const models: NormalizedModelSpec[] = [
                    { model: "anthropic/claude-sonnet-4" },
                    { model: "google/gemini-pro" }
                ]
                
                const cmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread"
                )
                
                // Should NOT contain session file path
                expect(cmd).not.toContain("-session.txt")
            })

            test("headless mode skips session resume and read prompt", () => {
                const models: NormalizedModelSpec[] = [
                    { model: "anthropic/claude-sonnet-4" },
                    { model: "google/gemini-pro" }
                ]

                const cmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread",
                    "02.01.01",
                    { headless: true, streamId }
                )

                expect(cmd).toContain("WORKSTREAM_HEADLESS=1")
                expect(cmd).not.toContain("opencode --session")
                expect(cmd).not.toContain("Press Enter to close")
                expect(cmd).not.toContain("\n  read")
            })
        })
    })

    describe("buildPostSynthesisCommand", () => {
        const workingModels: NormalizedModelSpec[] = [
            { model: "anthropic/claude-sonnet-4" }
        ]
        const synthesisModels: NormalizedModelSpec[] = [
            { model: "google/gemini-1.5-pro" }
        ]

        test("runs working agent BEFORE synthesis agent (post-session flow)", () => {
            const cmd = buildPostSynthesisCommand({
                port: 4096,
                workingModels,
                synthesisModels,
                promptPath: "/path/to/prompt.md",
                threadTitle: "Test Thread",
                streamId: "001-test",
                threadId: "01.01.01",
            })

            // Working agent should appear BEFORE synthesis agent in command
            const workingPhaseIndex = cmd.indexOf("Phase 1: Running working agent")
            const synthesisPhaseIndex = cmd.indexOf("Phase 2: Running synthesis agent")
            
            expect(workingPhaseIndex).toBeGreaterThan(-1)
            expect(synthesisPhaseIndex).toBeGreaterThan(-1)
            expect(workingPhaseIndex).toBeLessThan(synthesisPhaseIndex)
        })

        test("working agent runs with TUI (opencode run without --format json)", () => {
            const cmd = buildPostSynthesisCommand({
                port: 4096,
                workingModels,
                synthesisModels,
                promptPath: "/path/to/prompt.md",
                threadTitle: "Test Thread",
                streamId: "001-test",
                threadId: "01.01.01",
            })

            // Working agent's opencode run command should NOT have --format json
            // The working agent command is: cat "..." | opencode run --port ... --model ... --title ...
            // Note: session list uses --format json, but that's for finding the session ID, not running the agent
            
            // Find the working agent run command (the actual opencode run that executes the prompt)
            const workingModelMatch = cmd.match(/cat.*prompt\.md.*opencode run.*--model "anthropic\/claude-sonnet-4".*--title "\$WORK_TITLE"/)
            expect(workingModelMatch).toBeTruthy()
            
            // The working agent run command should NOT have --format json
            const workingRunCmd = workingModelMatch![0]
            expect(workingRunCmd).not.toContain("--format json")
        })

        test("synthesis agent runs headless with --format json", () => {
            const cmd = buildPostSynthesisCommand({
                port: 4096,
                workingModels,
                synthesisModels,
                promptPath: "/path/to/prompt.md",
                threadTitle: "Test Thread",
                streamId: "001-test",
                threadId: "01.01.01",
            })

            // Synthesis section should have --format json (headless mode)
            const phase2Start = cmd.indexOf("Phase 2: Running synthesis agent")
            const phase2Section = cmd.substring(phase2Start)
            
            expect(phase2Section).toContain("--format json")
        })

        test("resumes WORKING agent session (not synthesis)", () => {
            const cmd = buildPostSynthesisCommand({
                port: 4096,
                workingModels,
                synthesisModels,
                promptPath: "/path/to/prompt.md",
                threadTitle: "Test Thread",
                streamId: "001-test",
                threadId: "01.01.01",
            })

            // Should resume with WORK_SESSION_ID (working agent), not synthesis
            expect(cmd).toContain("Opening working session for review")
            expect(cmd).toContain('opencode --session "$WORK_SESSION_ID"')
        })

        test("writes working session ID to session file (not synthesis session)", () => {
            const cmd = buildPostSynthesisCommand({
                port: 4096,
                workingModels,
                synthesisModels,
                promptPath: "/path/to/prompt.md",
                threadTitle: "Test Thread",
                streamId: "001-test",
                threadId: "01.01.01",
            })

            // Should write working session ID to session file
            expect(cmd).toContain('echo "$WORK_SESSION_ID"')
            expect(cmd).toContain('/tmp/workstream-001-test-01.01.01-session.txt')
        })

        test("captures synthesis output to synthesis temp file", () => {
            const cmd = buildPostSynthesisCommand({
                port: 4096,
                workingModels,
                synthesisModels,
                promptPath: "/path/to/prompt.md",
                threadTitle: "Test Thread",
                streamId: "001-test",
                threadId: "01.01.01",
            })

            // Should write synthesis output to JSON file (raw JSONL)
            expect(cmd).toContain('/tmp/workstream-001-test-01.01.01-synthesis.json')
            // Should write synthesis metadata to log file
            expect(cmd).toContain('/tmp/workstream-001-test-01.01.01-synthesis.log')
        })

        test("displays Post-Session Synthesis mode in header", () => {
            const cmd = buildPostSynthesisCommand({
                port: 4096,
                workingModels,
                synthesisModels,
                promptPath: "/path/to/prompt.md",
                threadTitle: "Test Thread",
                streamId: "001-test",
                threadId: "01.01.01",
            })

            expect(cmd).toContain("Mode: Post-Session Synthesis")
        })

        test("headless mode skips working session resume and read prompt", () => {
            const cmd = buildPostSynthesisCommand({
                port: 4096,
                workingModels,
                synthesisModels,
                promptPath: "/path/to/prompt.md",
                threadTitle: "Test Thread",
                streamId: "001-test",
                threadId: "01.01.01",
                headless: true,
            })

            expect(cmd).toContain("WORKSTREAM_HEADLESS=1")
            expect(cmd).not.toContain('opencode --session "$WORK_SESSION_ID"')
            expect(cmd).not.toContain("Press Enter to close")
            expect(cmd).not.toContain("\n  read")
        })
    })
})
