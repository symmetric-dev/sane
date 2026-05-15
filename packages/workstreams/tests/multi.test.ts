import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
    buildRootAgentThreadSessionLineage,
    findNextIncompleteBatch,
    findNextIncompleteBatchFromThreads,
    parseCliArgs as parseMultiCliArgs,
    validateCliArgs as validateMultiCliArgs,
} from "../src/cli/multi"
import { getCompletionMarkerPath, getSessionFilePath, buildRunCommand, buildRetryRunCommand } from "../src/lib/opencode"
import type { Task, NormalizedModelSpec } from "../src/lib/types"
import * as notifications from "../src/lib/notifications"
import { mockPlayNotification } from "./helpers"
import { collectThreadInfoFromTasks } from "../src/lib/multi-orchestrator"
import { bootstrapSqliteStructuredStorage, syncStructuredStorageWorkstreamStateToSqlite } from "../src/lib/sqlite-storage"
import { createEmptyStructuredStorageWorkstreamState } from "../src/lib/structured-storage"

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

        test("prefers canonical thread ordering when choosing the next batch", () => {
            expect(findNextIncompleteBatchFromThreads([
                {
                    batchId: "01.02",
                    aggregateStatus: "pending",
                },
                {
                    batchId: "01.01",
                    aggregateStatus: "in_progress",
                },
            ])).toBe("01.01")
        })
    })

    describe("thread discovery", () => {
        test("collects batch threads from canonical hierarchy before compatibility tasks", () => {
            const tempDir = mkdtempSync(join(tmpdir(), "agenv-multi-sqlite-"))
            const testStreamId = "001-thread-first-batch"

            try {
                const workDir = join(tempDir, "work", testStreamId)
                mkdirSync(workDir, { recursive: true })
                writeFileSync(join(workDir, "tasks.json"), JSON.stringify({
                    version: "1.0.0",
                    stream_id: testStreamId,
                    last_updated: new Date().toISOString(),
                    tasks: [
                        {
                            id: "01.02.01.01",
                            name: "compat later task",
                            thread_name: "Compatibility later",
                            batch_name: "Compatibility batch 2",
                            stage_name: "Compatibility stage",
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString(),
                            status: "pending",
                        },
                    ],
                }, null, 2))

                const state = createEmptyStructuredStorageWorkstreamState(testStreamId)
                state.hierarchy.stages = [{ id: "01", number: 1, name: "Stage 1" }]
                state.hierarchy.batches = [
                    { id: "01.01", stageId: "01", number: 1, name: "Batch 1" },
                    { id: "01.02", stageId: "01", number: 2, name: "Batch 2" },
                ]
                state.hierarchy.threads = [
                    {
                        id: "01.01.01",
                        stageId: "01",
                        batchId: "01.01",
                        number: 1,
                        name: "Canonical first thread",
                        promptPath: `${testStreamId}/prompts/01-stage-1/01-batch-1/canonical-first-thread.md`,
                    },
                ]
                state.hierarchy.tasks = [
                    {
                        id: "01.01.01.01",
                        stageId: "01",
                        batchId: "01.01",
                        threadId: "01.01.01",
                        number: 1,
                        name: "Canonical first task",
                        status: "pending",
                        createdAt: "2026-05-14T00:00:00.000Z",
                        updatedAt: "2026-05-14T00:00:00.000Z",
                        assignedAgent: "canonical-agent",
                    },
                ]

                bootstrapSqliteStructuredStorage(tempDir)
                syncStructuredStorageWorkstreamStateToSqlite(tempDir, state)

                const threads = collectThreadInfoFromTasks(tempDir, testStreamId, 1, 1, {
                    agents: [{ name: "canonical-agent", description: "", best_for: "", models: ["anthropic/claude-sonnet-4"] }],
                })

                expect(threads).toHaveLength(1)
                expect(threads[0]).toMatchObject({
                    threadId: "01.01.01",
                    threadName: "Canonical first thread",
                    agentName: "canonical-agent",
                })
                expect(threads[0]?.promptPath).toContain("canonical-first-thread.md")
            } finally {
                rmSync(tempDir, { recursive: true, force: true })
            }
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

        test("buildRootAgentThreadSessionLineage preserves native supervision ancestry", () => {
            expect(buildRootAgentThreadSessionLineage({
                rootSessionId: "root-session-1",
                parentSessionId: "ses_supervision_1",
                parentBranchSessionId: "branch-supervision-1",
                branchRole: "supervision",
            }, "thread-session-1")).toEqual({
                owner: "root_agent",
                rootSessionId: "root-session-1",
                branchSessionId: "thread-session-1",
                branchRole: "supervision",
                parentBranchSessionId: "branch-supervision-1",
                parentSessionId: "ses_supervision_1",
                source: "native_fork",
            })
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

            test("does not include legacy thread session-discovery commands when threadId provided", () => {
                const cmd = buildRunCommand(
                    4096,
                    "anthropic/claude-sonnet-4",
                    "/path/to/prompt.md",
                    "Test Thread",
                    undefined,
                    "01.01.01",
                    { streamId }
                )
                
                expect(cmd).not.toContain("-session.txt")
                expect(cmd).not.toContain('$SESSION_ID')
                expect(cmd).not.toContain("__id=")
                expect(cmd).not.toContain("opencode session list")
                expect(cmd).toContain('--title "Test Thread"')
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

            test("does not reopen opencode session after run", () => {
                const defaultCmd = buildRunCommand(
                    4096,
                    "anthropic/claude-sonnet-4",
                    "/path/to/prompt.md",
                    "Test Thread",
                    undefined,
                    "01.01.01",
                    { streamId }
                )
                const cmd = buildRunCommand(
                    4096,
                    "anthropic/claude-sonnet-4",
                    "/path/to/prompt.md",
                    "Test Thread",
                    undefined,
                    "01.01.01",
                    { headless: true, streamId }
                )

                expect(defaultCmd).not.toContain("opencode --session")
                expect(defaultCmd).not.toContain("Press Enter to close")
                expect(defaultCmd).not.toContain("\n  read")
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

            test("does not include legacy thread session-discovery commands when threadId provided (single model)", () => {
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
                
                expect(cmd).not.toContain("-session.txt")
                expect(cmd).not.toContain('$SESSION_ID')
                expect(cmd).not.toContain("__id=")
                expect(cmd).not.toContain("opencode session list")
                expect(cmd).toContain('--title "Test Thread"')
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

            test("does not include legacy thread session-discovery commands when threadId provided (multiple models)", () => {
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
                
                expect(cmd).not.toContain("-session.txt")
                expect(cmd).not.toContain('$SESSION_ID')
                expect(cmd).not.toContain("__id=")
                expect(cmd).not.toContain("opencode session list")
                expect(cmd).toContain('TITLE="Test Thread"')
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

            test("retry command does not reopen opencode session after run", () => {
                const models: NormalizedModelSpec[] = [
                    { model: "anthropic/claude-sonnet-4" },
                    { model: "google/gemini-pro" }
                ]

                const defaultCmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread",
                    "02.01.01",
                    { streamId }
                )

                const cmd = buildRetryRunCommand(
                    4096,
                    models,
                    "/path/to/prompt.md",
                    "Test Thread",
                    "02.01.01",
                    { headless: true, streamId }
                )

                expect(defaultCmd).not.toContain("opencode --session")
                expect(defaultCmd).not.toContain("Press Enter to close")
                expect(defaultCmd).not.toContain("\n  read")
                expect(cmd).toContain("WORKSTREAM_HEADLESS=1")
                expect(cmd).not.toContain("opencode --session")
                expect(cmd).not.toContain("Press Enter to close")
                expect(cmd).not.toContain("\n  read")
            })
        })
    })

})
