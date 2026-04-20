
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { loadIndex, saveIndex } from "../src/lib/index.ts";
import type { WorkIndex, Task, StreamDocument } from "../src/lib/types.ts";
import { detectNewStages, generateTasksMdForRevision } from "../src/lib/tasks-md.ts";
import { appendRevisionStage } from "../src/lib/fix.ts";

const TEST_DIR = join(import.meta.dir, "temp_revision_test");
const REPO_ROOT = TEST_DIR;

describe("Revision Workflow", () => {
    beforeEach(() => {
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true });
        }
        mkdirSync(join(TEST_DIR, "work", "stream-rev"), { recursive: true });

        // Create index.json
        const index: WorkIndex = {
            version: "1.0.0",
            last_updated: new Date().toISOString(),
            streams: [{
                id: "stream-rev",
                name: "Revision Test Stream",
                order: 1,
                size: "short",
                session_estimated: {
                    length: 2,
                    unit: "session",
                    session_minutes: [30, 45],
                    session_iterations: [4, 8]
                },
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                path: "work/stream-rev",
                generated_by: { workstreams: "1.0.0" },
                approval: { 
                    status: "approved",
                    tasks: { status: "approved", task_count: 1 }
                }
            }]
        };
        saveIndex(REPO_ROOT, index);
    });

    afterEach(() => {
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true });
        }
    });


    describe("detectNewStages()", () => {
        test("should identify stages without tasks", () => {
            // Mock StreamDocument with 3 stages
            const doc: StreamDocument = {
                streamName: "Test Stream",
                summary: "Test Summary",
                references: [],
                stages: [
                    { 
                        id: 1, 
                        name: "Stage 1", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [] 
                    },
                    { 
                        id: 2, 
                        name: "Stage 2", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [] 
                    },
                    { 
                        id: 3, 
                        name: "Stage 3", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [] 
                    }
                ]
            };

            // Existing tasks only for Stage 1
            const tasks: Task[] = [
                {
                    id: "01.01.01.01",
                    name: "Task 1",
                    stage_name: "Stage 1",
                    batch_name: "Batch 1",
                    thread_name: "Thread 1",
                    status: "completed",
                    created_at: "",
                    updated_at: ""
                }
            ];

            const newStages = detectNewStages(doc, tasks);
            expect(newStages).toEqual([2, 3]);
        });

        test("should return empty array if all stages have tasks", () => {
            const doc: StreamDocument = {
                streamName: "Test Stream",
                summary: "Test Summary",
                references: [],
                stages: [
                    { 
                        id: 1, 
                        name: "Stage 1", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [] 
                    },
                    { 
                        id: 2, 
                        name: "Stage 2", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [] 
                    }
                ]
            };

            const tasks: Task[] = [
                { id: "01.01.01.01", name: "T1", stage_name: "S1", batch_name: "B1", thread_name: "T1", status: "completed", created_at: "", updated_at: "" },
                { id: "02.01.01.01", name: "T2", stage_name: "S2", batch_name: "B1", thread_name: "T1", status: "pending", created_at: "", updated_at: "" }
            ];

            const newStages = detectNewStages(doc, tasks);
            expect(newStages).toEqual([]);
        });

        test("should return all stages if no tasks exist", () => {
            const doc: StreamDocument = {
                streamName: "Test Stream",
                summary: "Test Summary",
                references: [],
                stages: [
                    { 
                        id: 1, 
                        name: "Stage 1", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [] 
                    },
                    { 
                        id: 2, 
                        name: "Stage 2", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [] 
                    }
                ]
            };

            const newStages = detectNewStages(doc, []);
            expect(newStages).toEqual([1, 2]);
        });
    });

    describe("generateTasksMdForRevision()", () => {
        test("should produce hybrid output with existing tasks and new placeholders", () => {
            const doc: StreamDocument = {
                streamName: "Test Stream",
                summary: "Test Summary",
                references: [],
                stages: [
                    { 
                        id: 1, 
                        name: "Existing Stage", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [
                            { 
                                id: 1, 
                                prefix: "01", 
                                name: "Existing Batch", 
                                summary: "Sum",
                                threads: [
                                    { 
                                        id: 1, 
                                        name: "Existing Thread",
                                        summary: "Sum",
                                        details: "Det"
                                    }
                                ]
                            }
                        ]
                    },
                    { 
                        id: 2, 
                        name: "New Stage", 
                        definition: "Def",
                        constitution: "Const",
                        questions: [],
                        batches: [
                            { 
                                id: 1, 
                                prefix: "01", 
                                name: "New Batch", 
                                summary: "Sum",
                                threads: [
                                    { 
                                        id: 1, 
                                        name: "New Thread",
                                        summary: "Sum",
                                        details: "Det"
                                    }
                                ]
                            }
                        ]
                    }
                ]
            };

            const existingTasks: Task[] = [
                {
                    id: "01.01.01.01",
                    name: "Done Task",
                    stage_name: "Existing Stage",
                    batch_name: "Existing Batch",
                    thread_name: "Existing Thread",
                    status: "completed",
                    created_at: "",
                    updated_at: ""
                }
            ];

            const newStageNumbers = [2];

            const output = generateTasksMdForRevision("Test Stream", existingTasks, doc, newStageNumbers);

            // Check existing task preservation
            expect(output).toContain("## Stage 01: Existing Stage");
            expect(output).toContain("- [x] Task 01.01.01.01: Done Task");

            // Check new stage generation
            expect(output).toContain("## Stage 02: New Stage");
            expect(output).toContain("### Batch 01: New Batch");
            expect(output).toContain("#### Thread 01: New Thread");
            expect(output).toContain("- [ ] Task 02.01.01.01:");
        });
    });

    describe("appendRevisionStage()", () => {
        test("should append new stage to PLAN.md", () => {
            // Setup initial PLAN.md
            const planPath = join(REPO_ROOT, "work/stream-rev/PLAN.md");
            const planContent = `# Plan: Revision Test Stream

## Summary
Stream summary.

## Stages

### Stage 01: Initial

#### Definition
Stage definition.

#### Constitution
Stage constitution.

#### Questions
- [ ] Question 1

#### Batches
##### Batch 01: Initial Batch
###### Thread 01: Initial Thread
**Summary:**
Thread summary.
**Details:**
Thread details.
`;
            writeFileSync(planPath, planContent);

            const index = loadIndex(REPO_ROOT);
            index.streams[0]!.approval = {
                status: "approved",
                tasks: { status: "approved", task_count: 1 },
                stages: {
                    1: {
                        status: "approved",
                        approved_at: new Date().toISOString(),
                    },
                },
            };
            saveIndex(REPO_ROOT, index);

            const result = appendRevisionStage(REPO_ROOT, "stream-rev", {
                name: "Review Changes",
                description: "Fixing bugs."
            });

            if (!result.success) {
                console.error("appendRevisionStage failed:", result.message);
            }
            expect(result.success).toBe(true);
            expect(result.newStageNumber).toBe(2);

            const content = readFileSync(planPath, "utf-8");
            expect(content).toContain("### Stage 02: Revision - Review Changes");
            expect(content).toContain("Fixing bugs.");
            expect(content).toContain("##### Batch 01: Review Changes");
        });

        test("should reject append when the current last stage is not approved", () => {
            const planPath = join(REPO_ROOT, "work/stream-rev/PLAN.md");
            const planContent = `# Plan: Revision Test Stream

## Summary
Stream summary.

## Stages

### Stage 01: Initial

#### Definition
Stage definition.

#### Constitution
Stage constitution.

#### Questions
- [x] Question 1

#### Batches
##### Batch 01: Initial Batch
###### Thread 01: Initial Thread
**Summary:**
Thread summary.
**Details:**
Thread details.
`;
            writeFileSync(planPath, planContent);

            const result = appendRevisionStage(REPO_ROOT, "stream-rev", {
                name: "Blocked Append",
                description: "Should fail without prior approval.",
            });

            expect(result.success).toBe(false);
            expect(result.message).toContain("Stage 01 must be approved");

            const unchangedPlan = readFileSync(planPath, "utf-8");
            expect(unchangedPlan).not.toContain("Revision - Blocked Append");
        });

        test("should insert a revision after a specific stage and shift later metadata", () => {
            const planPath = join(REPO_ROOT, "work/stream-rev/PLAN.md");
            const streamDir = join(REPO_ROOT, "work/stream-rev");
            const planContent = `# Plan: Revision Test Stream

## Summary
Stream summary.

## Stages

### Stage 01: Initial

#### Definition
Stage definition.

#### Constitution
Stage constitution.

#### Questions
- [x] Question 1

#### Batches
##### Batch 01: Initial Batch
###### Thread 01: Initial Thread
**Summary:**
Thread summary.
**Details:**
Thread details.

### Stage 02: Follow Up

#### Definition
Follow-up definition.

#### Constitution
Follow-up constitution.

#### Questions
- [x] Question 2

#### Batches
##### Batch 01: Follow Up Batch
###### Thread 01: Follow Up Thread
**Summary:**
Follow-up summary.
**Details:**
Follow-up details.
`;
            writeFileSync(planPath, planContent);

            writeFileSync(
                join(streamDir, "tasks.json"),
                JSON.stringify(
                    {
                        version: "1.0.0",
                        stream_id: "stream-rev",
                        last_updated: new Date().toISOString(),
                        runtime_state: {
                            version: "1.0.0",
                            last_updated: new Date().toISOString(),
                            threads: [
                                {
                                    threadId: "02.01.01",
                                    promptPath: "prompts/02-follow-up/01-follow-up-batch/follow-up-thread.md",
                                    sessions: [],
                                },
                            ],
                            batches: {
                                "02.01": {
                                    version: "1.0.0",
                                    streamId: "stream-rev",
                                    batchId: "02.01",
                                    runId: "02.01-run",
                                    mode: "headless",
                                    status: "running",
                                    stageName: "Follow Up",
                                    batchName: "Follow Up Batch",
                                    startedAt: new Date().toISOString(),
                                    updatedAt: new Date().toISOString(),
                                    summary: {
                                        total: 1,
                                        pending: 0,
                                        running: 1,
                                        completed: 0,
                                        failed: 0,
                                    },
                                    threads: [
                                        {
                                            threadId: "02.01.01",
                                            threadName: "Follow Up Thread",
                                            firstTaskId: "02.01.01.01",
                                            status: "running",
                                            updatedAt: new Date().toISOString(),
                                        },
                                    ],
                                },
                            },
                            supervision: {
                                version: "1.0.0",
                                stream_id: "stream-rev",
                                last_updated: new Date().toISOString(),
                                active_run_id: "run-1",
                                current_branch_supervision: {
                                    owner: "root_agent",
                                    rootSessionId: "root-1",
                                    branchSessionId: "branch-1",
                                    branchRole: "supervision",
                                    scope: {
                                        level: "batch",
                                        stageId: "02",
                                        batchId: "02.01",
                                    },
                                    source: "native_fork",
                                    nativeSessionId: "native-1",
                                    supervisionProgress: {
                                        executionMode: "single_batch_run",
                                        currentBatchId: "02.01",
                                        lastReviewedBatchId: "02.01",
                                    },
                                    updatedAt: new Date().toISOString(),
                                },
                                runs: [
                                    {
                                        runId: "run-1",
                                        stageId: "02",
                                        status: "running",
                                        startedAt: new Date().toISOString(),
                                        updatedAt: new Date().toISOString(),
                                        currentBatchId: "02.01",
                                        lastReviewedBatchId: "02.01",
                                        reviewPasses: 1,
                                        issueSummaryIds: ["issue-1"],
                                        escalationIds: ["esc-1"],
                                        stageStopId: "stop-1",
                                    },
                                ],
                                checkpoint_pointers: [],
                                branch_sessions: [
                                    {
                                        owner: "root_agent",
                                        rootSessionId: "root-1",
                                        branchSessionId: "branch-1",
                                        branchRole: "supervision",
                                        source: "native_fork",
                                        status: "running",
                                        startedAt: new Date().toISOString(),
                                        updatedAt: new Date().toISOString(),
                                        runId: "run-1",
                                        batchId: "02.01",
                                        threadId: "02.01.01",
                                        scope: {
                                            level: "batch",
                                            stageId: "02",
                                            batchId: "02.01",
                                        },
                                        supervisionProgress: {
                                            executionMode: "single_batch_run",
                                            currentBatchId: "02.01",
                                            lastReviewedBatchId: "02.01",
                                        },
                                    },
                                ],
                                reviewed_batches: [
                                    {
                                        reviewId: "review-1",
                                        runId: "run-1",
                                        stageId: "02",
                                        batchId: "02.01",
                                        reviewPass: 1,
                                        reviewedAt: new Date().toISOString(),
                                        outcome: "changes_requested",
                                        threadIds: ["02.01.01"],
                                        issueSummaryIds: ["issue-1"],
                                    },
                                ],
                                issue_summaries: [
                                    {
                                        summaryId: "issue-1",
                                        runId: "run-1",
                                        stageId: "02",
                                        batchId: "02.01",
                                        threadId: "02.01.01",
                                        status: "open",
                                        summary: "Needs follow-up",
                                        firstObservedAt: new Date().toISOString(),
                                        lastObservedAt: new Date().toISOString(),
                                    },
                                ],
                                fix_cycles: [
                                    {
                                        cycleId: "cycle-1",
                                        runId: "run-1",
                                        stageId: "02",
                                        batchId: "02.01",
                                        threadId: "02.01.01",
                                        attemptCount: 1,
                                        lastAttemptAt: new Date().toISOString(),
                                        lastOutcome: "pending_review",
                                        issueSummaryIds: ["issue-1"],
                                    },
                                ],
                                escalations: [
                                    {
                                        escalationId: "esc-1",
                                        runId: "run-1",
                                        stageId: "02",
                                        batchId: "02.01",
                                        threadId: "02.01.01",
                                        target: "thread",
                                        reason: "Needs help",
                                        status: "pending",
                                        escalatedAt: new Date().toISOString(),
                                    },
                                ],
                                stage_stops: [
                                    {
                                        stopId: "stop-1",
                                        runId: "run-1",
                                        stageId: "02",
                                        batchId: "02.01",
                                        reason: "blocked",
                                        summary: "Paused",
                                        stoppedAt: new Date().toISOString(),
                                    },
                                ],
                            },
                        },
                        tasks: [
                            {
                                id: "01.01.01.01",
                                name: "Initial task",
                                stage_name: "Initial",
                                batch_name: "Initial Batch",
                                thread_name: "Initial Thread",
                                status: "completed",
                                created_at: "",
                                updated_at: "",
                            },
                            {
                                id: "02.01.01.01",
                                name: "Follow-up task",
                                stage_name: "Follow Up",
                                batch_name: "Follow Up Batch",
                                thread_name: "Follow Up Thread",
                                status: "pending",
                                created_at: "",
                                updated_at: "",
                            },
                        ],
                    },
                    null,
                    2,
                ),
            );

            mkdirSync(join(streamDir, "batch-status"), { recursive: true });
            writeFileSync(
                join(streamDir, "batch-status", "02.01.json"),
                JSON.stringify(
                    {
                        version: "1.0.0",
                        streamId: "stream-rev",
                        batchId: "02.01",
                        runId: "02.01-run",
                        mode: "headless",
                        status: "running",
                        startedAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        summary: {
                            total: 1,
                            pending: 0,
                            running: 1,
                            completed: 0,
                            failed: 0,
                        },
                        threads: [
                            {
                                threadId: "02.01.01",
                                threadName: "Follow Up Thread",
                                firstTaskId: "02.01.01.01",
                                status: "running",
                                updatedAt: new Date().toISOString(),
                            },
                        ],
                    },
                    null,
                    2,
                ),
            );

            writeFileSync(
                join(streamDir, "supervisor-state.json"),
                JSON.stringify(
                    {
                        version: "1.0.0",
                        stream_id: "stream-rev",
                        last_updated: new Date().toISOString(),
                        active_run_id: "run-1",
                        current_branch_supervision: {
                            owner: "root_agent",
                            rootSessionId: "root-1",
                            branchSessionId: "branch-1",
                            branchRole: "supervision",
                            source: "native_fork",
                            nativeSessionId: "native-1",
                            scope: {
                                level: "batch",
                                stageId: "02",
                                batchId: "02.01",
                            },
                            supervisionProgress: {
                                executionMode: "single_batch_run",
                                currentBatchId: "02.01",
                                lastReviewedBatchId: "02.01",
                            },
                            updatedAt: new Date().toISOString(),
                        },
                        runs: [
                            {
                                runId: "run-1",
                                stageId: "02",
                                status: "running",
                                startedAt: new Date().toISOString(),
                                updatedAt: new Date().toISOString(),
                                currentBatchId: "02.01",
                                lastReviewedBatchId: "02.01",
                                reviewPasses: 1,
                                issueSummaryIds: [],
                                escalationIds: [],
                            },
                        ],
                        checkpoint_pointers: [],
                        branch_sessions: [
                            {
                                owner: "root_agent",
                                rootSessionId: "root-1",
                                branchSessionId: "branch-1",
                                branchRole: "supervision",
                                source: "native_fork",
                                status: "running",
                                startedAt: new Date().toISOString(),
                                updatedAt: new Date().toISOString(),
                                batchId: "02.01",
                                threadId: "02.01.01",
                                scope: {
                                    level: "batch",
                                    stageId: "02",
                                    batchId: "02.01",
                                },
                                supervisionProgress: {
                                    executionMode: "single_batch_run",
                                    currentBatchId: "02.01",
                                    lastReviewedBatchId: "02.01",
                                },
                            },
                        ],
                        reviewed_batches: [],
                        issue_summaries: [],
                        fix_cycles: [],
                        escalations: [],
                        stage_stops: [],
                    },
                    null,
                    2,
                ),
            );

            writeFileSync(
                join(streamDir, "threads.json"),
                JSON.stringify(
                    {
                        version: "1.0.0",
                        stream_id: "stream-rev",
                        last_updated: new Date().toISOString(),
                        threads: [
                            {
                                threadId: "01.01.01",
                                promptPath: "prompts/01-initial/01-initial-batch/initial-thread.md",
                                sessions: [],
                            },
                            {
                                threadId: "02.01.01",
                                promptPath: "prompts/02-follow-up/01-follow-up-batch/follow-up-thread.md",
                                sessions: [],
                            },
                        ],
                    },
                    null,
                    2,
                ),
            );

            mkdirSync(join(streamDir, "prompts", "01-initial", "01-initial-batch"), { recursive: true });
            mkdirSync(join(streamDir, "prompts", "02-follow-up", "01-follow-up-batch"), { recursive: true });
            writeFileSync(
                join(streamDir, "prompts", "01-initial", "01-initial-batch", "initial-thread.md"),
                "initial prompt",
            );
            writeFileSync(
                join(streamDir, "prompts", "02-follow-up", "01-follow-up-batch", "follow-up-thread.md"),
                "follow-up prompt",
            );

            writeFileSync(
                join(streamDir, "github.json"),
                JSON.stringify(
                    {
                        version: "1.0.0",
                        stream_id: "stream-rev",
                        last_updated: new Date().toISOString(),
                        stages: {
                            "01": {
                                issue_number: 101,
                                issue_url: "https://example.com/101",
                                state: "open",
                                created_at: new Date().toISOString(),
                            },
                            "02": {
                                issue_number: 102,
                                issue_url: "https://example.com/102",
                                state: "open",
                                created_at: new Date().toISOString(),
                            },
                        },
                    },
                    null,
                    2,
                ),
            );

            const index = loadIndex(REPO_ROOT);
            index.streams[0]!.approval = {
                status: "approved",
                tasks: { status: "approved", task_count: 2 },
                stages: {
                    1: {
                        status: "approved",
                        approved_at: new Date().toISOString(),
                    },
                    2: {
                        status: "approved",
                        approved_at: new Date().toISOString(),
                    },
                },
            };
            saveIndex(REPO_ROOT, index);

            const result = appendRevisionStage(REPO_ROOT, "stream-rev", {
                name: "Review Changes",
                description: "Inserted after stage 01.",
                afterStage: 1,
            });

            expect(result.success).toBe(true);
            expect(result.newStageNumber).toBe(2);

            const updatedPlan = readFileSync(planPath, "utf-8");
            expect(updatedPlan).toContain("### Stage 02: Revision - Review Changes");
            expect(updatedPlan).toContain("### Stage 03: Follow Up");
            expect(updatedPlan.indexOf("### Stage 02: Revision - Review Changes")).toBeLessThan(
                updatedPlan.indexOf("### Stage 03: Follow Up"),
            );

            const tasksFile = JSON.parse(readFileSync(join(streamDir, "tasks.json"), "utf-8"));
            expect(tasksFile.tasks.some((task: Task) => task.id === "02.01.01.01")).toBe(false);
            expect(tasksFile.tasks.some((task: Task) => task.id === "03.01.01.01")).toBe(true);

            const persistedTasksFile = JSON.parse(readFileSync(join(streamDir, "tasks.json"), "utf-8"));
            expect(persistedTasksFile.runtime_state.threads.some((thread: { threadId: string }) => thread.threadId === "03.01.01")).toBe(true);

            const shiftedThread = persistedTasksFile.runtime_state.threads.find((thread: { threadId: string }) => thread.threadId === "03.01.01");
            expect(shiftedThread?.promptPath).toContain("prompts/03-follow-up/01-follow-up-batch/follow-up-thread.md");
            expect(existsSync(join(streamDir, "prompts", "03-follow-up", "01-follow-up-batch", "follow-up-thread.md"))).toBe(true);

            expect(persistedTasksFile.runtime_state.batches["02.01"]).toBeUndefined();
            expect(persistedTasksFile.runtime_state.batches["03.01"]?.batchId).toBe("03.01");
            expect(persistedTasksFile.runtime_state.batches["03.01"]?.threads[0]?.threadId).toBe("03.01.01");
            expect(persistedTasksFile.runtime_state.batches["03.01"]?.threads[0]?.firstTaskId).toBe("03.01.01.01");

            expect(persistedTasksFile.runtime_state.supervision.current_branch_supervision?.scope?.stageId).toBe("03");
            expect(persistedTasksFile.runtime_state.supervision.current_branch_supervision?.scope?.batchId).toBe("03.01");
            expect(persistedTasksFile.runtime_state.supervision.current_branch_supervision?.supervisionProgress?.currentBatchId).toBe("03.01");
            expect(persistedTasksFile.runtime_state.supervision.runs[0]?.stageId).toBe("03");
            expect(persistedTasksFile.runtime_state.supervision.runs[0]?.currentBatchId).toBe("03.01");
            expect(persistedTasksFile.runtime_state.supervision.branch_sessions[0]?.threadId).toBe("03.01.01");
            expect(persistedTasksFile.runtime_state.supervision.reviewed_batches[0]?.batchId).toBe("03.01");
            expect(persistedTasksFile.runtime_state.supervision.issue_summaries[0]?.threadId).toBe("03.01.01");
            expect(persistedTasksFile.runtime_state.supervision.fix_cycles[0]?.threadId).toBe("03.01.01");
            expect(persistedTasksFile.runtime_state.supervision.escalations[0]?.batchId).toBe("03.01");
            expect(persistedTasksFile.runtime_state.supervision.stage_stops[0]?.stageId).toBe("03");

            const updatedIndex = loadIndex(REPO_ROOT);
            expect(updatedIndex.streams[0]!.approval?.stages?.[2]).toBeUndefined();
            expect(updatedIndex.streams[0]!.approval?.stages?.[3]?.status).toBe("approved");

            const githubData = JSON.parse(readFileSync(join(streamDir, "github.json"), "utf-8"));
            expect(githubData.stages["02"]).toBeUndefined();
            expect(githubData.stages["03"]?.issue_number).toBe(102);

            const legacyBatchStatus = JSON.parse(readFileSync(join(streamDir, "batch-status", "02.01.json"), "utf-8"));
            expect(legacyBatchStatus.batchId).toBe("03.01");
            expect(legacyBatchStatus.threads[0]?.threadId).toBe("03.01.01");
            expect(legacyBatchStatus.threads[0]?.firstTaskId).toBe("03.01.01.01");

            const legacySupervisorState = JSON.parse(readFileSync(join(streamDir, "supervisor-state.json"), "utf-8"));
            expect(legacySupervisorState.current_branch_supervision?.scope?.stageId).toBe("03");
            expect(legacySupervisorState.current_branch_supervision?.scope?.batchId).toBe("03.01");
            expect(legacySupervisorState.runs[0]?.stageId).toBe("03");
            expect(legacySupervisorState.runs[0]?.currentBatchId).toBe("03.01");
            expect(legacySupervisorState.branch_sessions[0]?.threadId).toBe("03.01.01");
        });

        test("should reject insertion after an unapproved stage", () => {
            const planPath = join(REPO_ROOT, "work/stream-rev/PLAN.md");
            const planContent = `# Plan: Revision Test Stream

## Summary
Stream summary.

## Stages

### Stage 01: Initial

#### Definition
Stage definition.

#### Constitution
Stage constitution.

#### Questions
- [x] Question 1

#### Batches
##### Batch 01: Initial Batch
###### Thread 01: Initial Thread
**Summary:**
Thread summary.
**Details:**
Thread details.

### Stage 02: Follow Up

#### Definition
Follow-up definition.

#### Constitution
Follow-up constitution.

#### Questions
- [x] Question 2

#### Batches
##### Batch 01: Follow Up Batch
###### Thread 01: Follow Up Thread
**Summary:**
Follow-up summary.
**Details:**
Follow-up details.
`;
            writeFileSync(planPath, planContent);

            const result = appendRevisionStage(REPO_ROOT, "stream-rev", {
                name: "Blocked Insert",
                description: "Should fail without approval.",
                afterStage: 1,
            });

            expect(result.success).toBe(false);
            expect(result.message).toContain("Stage 01 must be approved");

            const unchangedPlan = readFileSync(planPath, "utf-8");
            expect(unchangedPlan).not.toContain("Revision - Blocked Insert");
            expect(unchangedPlan).toContain("### Stage 02: Follow Up");
        });
    });

    describe("CLI Integration", () => {
        test("should add revision stage via CLI", async () => {
            // Setup initial PLAN.md
            const planPath = join(REPO_ROOT, "work/stream-rev/PLAN.md");
            const planContent = `# Plan: Revision Test Stream

## Summary
Stream summary.

## Stages

### Stage 01: Initial

#### Definition
Stage definition.

#### Constitution
Stage constitution.

#### Questions
- [ ] Question 1

#### Batches
##### Batch 01: Initial Batch
###### Thread 01: Initial Thread
**Summary:**
Thread summary.
**Details:**
Thread details.
`;
            writeFileSync(planPath, planContent);

            const index = loadIndex(REPO_ROOT);
            index.streams[0]!.approval = {
                status: "approved",
                tasks: { status: "approved", task_count: 1 },
                stages: {
                    1: {
                        status: "approved",
                        approved_at: new Date().toISOString(),
                    },
                },
            };
            saveIndex(REPO_ROOT, index);

            // Import CLI
            const { main } = await import("../src/cli/revision.ts");

            // Capture logs
            const logs: string[] = [];
            const originalLog = console.log;
            console.log = (...args) => logs.push(args.join(" "));

            try {
                await main(["node", "revision", "--name", "CLI Test", "--stream", "stream-rev", "--repo-root", REPO_ROOT]);
            } finally {
                console.log = originalLog;
            }

            const content = readFileSync(planPath, "utf-8");
            expect(content).toContain("Revision - CLI Test");
            
            const output = logs.join("\n");
            expect(output).toContain("Appended Stage 02 to PLAN.md");
        });

        test("should insert revision stage after a specific stage via CLI", async () => {
            const planPath = join(REPO_ROOT, "work/stream-rev/PLAN.md");
            const planContent = `# Plan: Revision Test Stream

## Summary
Stream summary.

## Stages

### Stage 01: Initial

#### Definition
Stage definition.

#### Constitution
Stage constitution.

#### Questions
- [x] Question 1

#### Batches
##### Batch 01: Initial Batch
###### Thread 01: Initial Thread
**Summary:**
Thread summary.
**Details:**
Thread details.

### Stage 02: Finalize

#### Definition
Finalize definition.

#### Constitution
Finalize constitution.

#### Questions
- [x] Question 2

#### Batches
##### Batch 01: Final Batch
###### Thread 01: Final Thread
**Summary:**
Final summary.
**Details:**
Final details.
`;
            writeFileSync(planPath, planContent);

            const index = loadIndex(REPO_ROOT);
            index.streams[0]!.approval = {
                status: "approved",
                tasks: { status: "approved", task_count: 1 },
                stages: {
                    1: {
                        status: "approved",
                        approved_at: new Date().toISOString(),
                    },
                },
            };
            saveIndex(REPO_ROOT, index);

            const { main } = await import("../src/cli/revision.ts");

            const logs: string[] = [];
            const originalLog = console.log;
            console.log = (...args) => logs.push(args.join(" "));

            try {
                await main([
                    "node",
                    "revision",
                    "--name",
                    "CLI Insert",
                    "--after-stage",
                    "1",
                    "--stream",
                    "stream-rev",
                    "--repo-root",
                    REPO_ROOT,
                ]);
            } finally {
                console.log = originalLog;
            }

            const content = readFileSync(planPath, "utf-8");
            expect(content).toContain("### Stage 02: Revision - CLI Insert");
            expect(content).toContain("### Stage 03: Finalize");

            const output = logs.join("\n");
            expect(output).toContain("Inserted Stage 02 after Stage 01");
        });
    });
});
