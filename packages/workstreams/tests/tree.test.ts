import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { main } from "../src/cli/tree.ts"
import * as repo from "../src/lib/repo.ts"
import * as index from "../src/lib/index.ts"
import * as tasks from "../src/lib/tasks.ts"
import type { Task, TasksFile, WorkIndex, StreamMetadata, WorkstreamRuntimeSummary } from "../src/lib/types.ts"

describe("work tree", () => {
    let consoleSpy: any
    let exitSpy: any
    let getRepoRootSpy: any
    let loadIndexSpy: any
    let getResolvedStreamSpy: any
        let readTasksFileSpy: any

    beforeEach(() => {
        consoleSpy = spyOn(console, "log").mockImplementation(() => { })
        exitSpy = spyOn(process, "exit").mockImplementation((() => { }) as never)
        getRepoRootSpy = spyOn(repo, "getRepoRoot").mockReturnValue("/tmp/test-repo")

        const mockStream: StreamMetadata = {
            id: "001-test",
            name: "test",
            status: "in_progress",
            session_estimated: { length: 1, unit: "session", session_minutes: [30, 45], session_iterations: [4, 8] },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            path: "work/001-test",
            generated_by: { workstreams: "0.1.0" },
            size: "short",
            order: 1
        }

        loadIndexSpy = spyOn(index, "loadIndex").mockReturnValue({
            version: "1.0.0",
            last_updated: new Date().toISOString(),
            streams: [mockStream]
        } as WorkIndex)

        getResolvedStreamSpy = spyOn(index, "getResolvedStream").mockReturnValue(mockStream)
    })

    afterEach(() => {
        consoleSpy.mockRestore()
        exitSpy.mockRestore()
        getRepoRootSpy.mockRestore()
        loadIndexSpy.mockRestore()
        getResolvedStreamSpy.mockRestore()
        if (readTasksFileSpy) readTasksFileSpy.mockRestore()
    })

    test("displays tree structure correctly", () => {
        const mockTasks: Task[] = [
            {
                id: "01.01.01.01",
                name: "Task 1",
                stage_name: "Planning",
                batch_name: "Setup",
                thread_name: "Init",
                status: "completed",
                created_at: "",
                updated_at: ""
            },
            {
                id: "01.01.01.02",
                name: "Task 2",
                stage_name: "Planning",
                batch_name: "Setup",
                thread_name: "Init",
                status: "in_progress",
                created_at: "",
                updated_at: ""
            }
        ]

        readTasksFileSpy = spyOn(tasks, "readTasksFile").mockReturnValue({
            version: "1.0.0",
            stream_id: "001-test",
            last_updated: new Date().toISOString(),
            tasks: mockTasks,
        } satisfies TasksFile)

        main(["node", "work-tree", "--stream", "001-test"])

        expect(consoleSpy).toHaveBeenCalled()
        const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join("\n")

        // Check for Workstream line
        expect(output).toContain("Workstream: 001-test")

        // Check for Stage
        expect(output).toContain("Stage 01: Planning")

        // Check for Batch
        expect(output).toContain("Batch 01: Setup")

        // Check for Thread
        expect(output).toContain("Thread 01: Init")

        // Check for status icons (implied by functionality, but let's check basic presence)
        // Overall status should be in_progress because one task is in_progress
        expect(output).toContain("[~] Workstream")
    })

    test("handles empty workstream", () => {
        readTasksFileSpy = spyOn(tasks, "readTasksFile").mockReturnValue({
            version: "1.0.0",
            stream_id: "001-test",
            last_updated: new Date().toISOString(),
            tasks: [],
        } satisfies TasksFile)

        main(["node", "work-tree", "--stream", "001-test"])

        expect(consoleSpy).toHaveBeenCalledWith("Workstream: 001-test (Empty)")
    })

    test("shows runtime desync from persisted summary", () => {
        const mockTasks: Task[] = [
            {
                id: "01.01.01.01",
                name: "Task 1",
                stage_name: "Planning",
                batch_name: "Setup",
                thread_name: "Init",
                status: "pending",
                created_at: "",
                updated_at: ""
            }
        ]

        readTasksFileSpy = spyOn(tasks, "readTasksFile").mockReturnValue({
            version: "1.0.0",
            stream_id: "001-test",
            last_updated: new Date().toISOString(),
            runtime_summary: {
                updated_at: new Date().toISOString(),
                batches: {
                    "01.01": {
                        batch_id: "01.01",
                        run_id: "run-1",
                        status: "failed",
                        updated_at: new Date().toISOString(),
                        started_at: new Date().toISOString(),
                        thread_summary: {
                            total: 1,
                            pending: 0,
                            running: 0,
                            completed: 0,
                            failed: 1,
                        },
                    },
                },
            },
            tasks: mockTasks,
        } satisfies TasksFile)

        main(["node", "work-tree", "--stream", "001-test"])

        const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join("\n")
        expect(output).toContain("Runtime: batch 01.01 failed")
        expect(output).toContain("desync: tasks pending, runtime failed (1 failed)")
    })

    test("prefers failed batch notice even when an earlier batch sorts first", () => {
        const mockTasks: Task[] = [
            {
                id: "01.01.01.01",
                name: "Task 1",
                stage_name: "Planning",
                batch_name: "Setup",
                thread_name: "Init",
                status: "completed",
                created_at: "",
                updated_at: ""
            },
            {
                id: "01.02.01.01",
                name: "Task 2",
                stage_name: "Planning",
                batch_name: "Implement",
                thread_name: "Work",
                status: "pending",
                created_at: "",
                updated_at: ""
            }
        ]

        readTasksFileSpy = spyOn(tasks, "readTasksFile").mockReturnValue({
            version: "1.0.0",
            stream_id: "001-test",
            last_updated: new Date().toISOString(),
            runtime_summary: {
                updated_at: new Date().toISOString(),
                batches: {
                    "01.01": {
                        batch_id: "01.01",
                        run_id: "run-1",
                        status: "completed",
                        updated_at: new Date().toISOString(),
                        started_at: new Date().toISOString(),
                        completed_at: new Date().toISOString(),
                        thread_summary: {
                            total: 1,
                            pending: 0,
                            running: 0,
                            completed: 1,
                            failed: 0,
                        },
                    },
                    "01.02": {
                        batch_id: "01.02",
                        run_id: "run-2",
                        status: "failed",
                        updated_at: new Date().toISOString(),
                        started_at: new Date().toISOString(),
                        thread_summary: {
                            total: 1,
                            pending: 0,
                            running: 0,
                            completed: 0,
                            failed: 1,
                        },
                    },
                },
            },
            tasks: mockTasks,
        } satisfies TasksFile)

        main(["node", "work-tree", "--stream", "001-test"])

        const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join("\n")
        expect(output).toContain("Runtime: batch 01.02 failed")
    })

    test("falls back for older tasks.json without runtime summary", () => {
        const mockTasks: Task[] = [
            {
                id: "01.01.01.01",
                name: "Task 1",
                stage_name: "Planning",
                batch_name: "Setup",
                thread_name: "Init",
                status: "pending",
                created_at: "",
                updated_at: ""
            }
        ]

        readTasksFileSpy = spyOn(tasks, "readTasksFile").mockReturnValue({
            version: "1.0.0",
            stream_id: "001-test",
            last_updated: new Date().toISOString(),
            tasks: mockTasks,
        } satisfies TasksFile)
        spyOn(tasks, "getEffectiveRuntimeSummary").mockReturnValue(undefined)

        main(["node", "work-tree", "--stream", "001-test"])

        const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join("\n")
        expect(output).toContain("Workstream: 001-test")
        expect(output).not.toContain("Runtime:")
    })

    test("filters runtime metadata to the selected batch", () => {
        const mockTasks: Task[] = [
            {
                id: "01.01.01.01",
                name: "Task 1",
                stage_name: "Planning",
                batch_name: "Setup",
                thread_name: "Init",
                status: "in_progress",
                created_at: "",
                updated_at: ""
            },
            {
                id: "01.02.01.01",
                name: "Task 2",
                stage_name: "Planning",
                batch_name: "Build",
                thread_name: "Work",
                status: "pending",
                created_at: "",
                updated_at: ""
            }
        ]

        const runtimeSummary: WorkstreamRuntimeSummary = {
            updated_at: new Date().toISOString(),
            batches: {
                "01.01": {
                    batch_id: "01.01",
                    run_id: "run-1",
                    status: "running",
                    updated_at: new Date().toISOString(),
                    started_at: new Date().toISOString(),
                    thread_summary: {
                        total: 1,
                        pending: 0,
                        running: 1,
                        completed: 0,
                        failed: 0,
                    },
                },
                "01.02": {
                    batch_id: "01.02",
                    run_id: "run-2",
                    status: "failed",
                    updated_at: new Date().toISOString(),
                    started_at: new Date().toISOString(),
                    thread_summary: {
                        total: 1,
                        pending: 0,
                        running: 0,
                        completed: 0,
                        failed: 1,
                    },
                },
            },
        }

        readTasksFileSpy = spyOn(tasks, "readTasksFile").mockReturnValue({
            version: "1.0.0",
            stream_id: "001-test",
            last_updated: new Date().toISOString(),
            runtime_summary: runtimeSummary,
            tasks: mockTasks,
        } satisfies TasksFile)
        spyOn(tasks, "getEffectiveRuntimeSummary").mockReturnValue(runtimeSummary)

        main(["node", "work-tree", "--stream", "001-test", "--batch", "01.01"])

        const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join("\n")
        expect(output).toContain("Runtime: batch 01.01 running")
        expect(output).toContain("desync: tasks in progress, runtime running (1 running)")
        expect(output).not.toContain("01.02 failed")
    })

    test("supports unpadded batch ids for runtime filtering", () => {
        const mockTasks: Task[] = [
            {
                id: "01.01.01.01",
                name: "Task 1",
                stage_name: "Planning",
                batch_name: "Setup",
                thread_name: "Init",
                status: "in_progress",
                created_at: "",
                updated_at: ""
            },
            {
                id: "01.02.01.01",
                name: "Task 2",
                stage_name: "Planning",
                batch_name: "Build",
                thread_name: "Work",
                status: "pending",
                created_at: "",
                updated_at: ""
            }
        ]

        const runtimeSummary: WorkstreamRuntimeSummary = {
            updated_at: new Date().toISOString(),
            batches: {
                "01.01": {
                    batch_id: "01.01",
                    run_id: "run-1",
                    status: "running",
                    updated_at: new Date().toISOString(),
                    started_at: new Date().toISOString(),
                    thread_summary: {
                        total: 1,
                        pending: 0,
                        running: 1,
                        completed: 0,
                        failed: 0,
                    },
                },
                "01.02": {
                    batch_id: "01.02",
                    run_id: "run-2",
                    status: "failed",
                    updated_at: new Date().toISOString(),
                    started_at: new Date().toISOString(),
                    thread_summary: {
                        total: 1,
                        pending: 0,
                        running: 0,
                        completed: 0,
                        failed: 1,
                    },
                },
            },
            supervision: {
                updated_at: new Date().toISOString(),
                current_branch: {
                    branch_session_id: "branch-1",
                    root_session_id: "root-1",
                    status: "running",
                    updated_at: new Date().toISOString(),
                    stage_id: "01",
                    batch_id: "01.01",
                    current_batch_id: "01.01",
                },
            },
        }

        readTasksFileSpy = spyOn(tasks, "readTasksFile").mockReturnValue({
            version: "1.0.0",
            stream_id: "001-test",
            last_updated: new Date().toISOString(),
            runtime_summary: runtimeSummary,
            tasks: mockTasks,
        } satisfies TasksFile)
        spyOn(tasks, "getEffectiveRuntimeSummary").mockReturnValue(runtimeSummary)

        main(["node", "work-tree", "--stream", "001-test", "--batch", "1.1"])

        const output = consoleSpy.mock.calls.map((c: any[]) => c[0]).join("\n")
        expect(output).toContain("Runtime: batch 01.01 running")
        expect(output).toContain("desync: tasks in progress, runtime running (1 running)")
        expect(output).not.toContain("01.02 failed")
        expect(output).not.toContain("supervision branch")
    })
})
