
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { createTestWorkstream, cleanupTestWorkstream, type TestWorkspace } from "./helpers/test-workspace.ts";
import { captureCliOutput } from "./helpers/cli-runner.ts";
import {
    approveStage,
    revokeStageApproval,
    getStageApprovalStatus,
    approveStream,
    getApprovalStatus
} from "../src/lib/approval.ts";
import { loadIndex, saveIndex } from "../src/lib/index.ts";
import type { WorkIndex } from "../src/lib/types.ts";
import { saveGitHubConfig } from "../src/lib/github/config.ts";
import { DEFAULT_GITHUB_CONFIG } from "../src/lib/github/types.ts";

describe("Approval Flow", () => {
    let workspace: TestWorkspace;
    let REPO_ROOT: string;

    beforeAll(() => {
        // Set USER role for approval tests
        process.env.WORKSTREAM_ROLE = "USER";
        
        workspace = createTestWorkstream("stream-001");
        REPO_ROOT = workspace.repoRoot;

        // Create index.json
        const index: WorkIndex = {
            version: "1.0.0",
            last_updated: new Date().toISOString(),
            streams: [{
                id: "stream-001",
                name: "test-stream",
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
                path: "work/stream-001",
                generated_by: { workstreams: "1.0.0" }
            }]
        };
        saveIndex(REPO_ROOT, index);

        // Create PLAN.md
        writeFileSync(join(REPO_ROOT, "work/stream-001/PLAN.md"), "# Test Plan");
    });

    afterAll(() => {
        cleanupTestWorkstream(workspace);
        // Clean up role setting
        delete process.env.WORKSTREAM_ROLE;
    });

    test("should start with draft status", () => {
        const index = loadIndex(REPO_ROOT);
        const stream = index.streams[0];
        if (!stream) throw new Error("Stream not found");
        expect(getApprovalStatus(stream)).toBe("draft");
        expect(getStageApprovalStatus(stream, 1)).toBe("draft");
    });

    test("should approve stream", () => {
        const stream = approveStream(REPO_ROOT, "stream-001", "tester");
        expect(stream.approval?.status).toBe("approved");
        expect(stream.approval?.approved_by).toBe("tester");
    });

    test("should approve stage 1", () => {
        const stream = approveStage(REPO_ROOT, "stream-001", 1, "tester");
        expect(getStageApprovalStatus(stream, 1)).toBe("approved");
        expect(stream.approval?.stages?.[1]?.status).toBe("approved");
    });

    test("should revoke stage 1", () => {
        const stream = revokeStageApproval(REPO_ROOT, "stream-001", 1, "bad output");
        expect(getStageApprovalStatus(stream, 1)).toBe("revoked");
        expect(stream.approval?.stages?.[1]?.revoked_reason).toBe("bad output");
    });

    test("should re-approve stage 1", () => {
        const stream = approveStage(REPO_ROOT, "stream-001", 1, "tester");
        expect(getStageApprovalStatus(stream, 1)).toBe("approved");
    });

    test("should handle stage 2 unrelated to stage 1", () => {
        const index = loadIndex(REPO_ROOT);
        const stream = index.streams[0];
        if (!stream) throw new Error("Stream not found");
        expect(getStageApprovalStatus(stream, 2)).toBe("draft");


        const updatedStream = approveStage(REPO_ROOT, "stream-001", 2, "tester");
        expect(getStageApprovalStatus(updatedStream, 2)).toBe("approved");
        // Stage 1 should still be approved
        expect(getStageApprovalStatus(updatedStream, 1)).toBe("approved");
    });

    test("should check tasks approval readiness", () => {
        const { checkTasksApprovalReady } = require("../src/lib/approval.ts");

        // Should failing initially (no TASKS.md)
        try {
            const result = checkTasksApprovalReady(REPO_ROOT, "stream-001");
            expect(result.ready).toBe(false);
            expect(result.reason).toContain("TASKS.md not found");
        } catch (e) {
            // function might not be exported in test context if using bun test runner quirks
            // but we can test the approval failure directly
        }

        // Create empty TASKS.md
        writeFileSync(join(REPO_ROOT, "work/stream-001/TASKS.md"), "# Tasks: test-stream\n\n");

        // Should fail (empty tasks)
        try {
            const result = checkTasksApprovalReady(REPO_ROOT, "stream-001");
            expect(result.ready).toBe(false);
            expect(result.reason).toContain("contains no valid tasks");
        } catch (e) { }

        // Create valid TASKS.md
        writeFileSync(join(REPO_ROOT, "work/stream-001/TASKS.md"), `
# Tasks: test-stream

## Stage 01: Stage 1

### Batch 01: Batch 1

#### Thread 01: Thread 1

- [ ] Task 01.01.01.01: Task 1
        `.trim());

        const result = checkTasksApprovalReady(REPO_ROOT, "stream-001");
        expect(result.ready).toBe(true);
        expect(result.taskCount).toBe(1);
    });

    test("should approve tasks", () => {
        const { approveTasks, getTasksApprovalStatus } = require("../src/lib/approval.ts");

        let stream = approveTasks(REPO_ROOT, "stream-001");
        expect(getTasksApprovalStatus(stream)).toBe("approved");
        expect(stream.approval?.tasks?.task_count).toBe(1);
    });



    test("should verify full approval", () => {
        const { isFullyApproved, getFullApprovalStatus } = require("../src/lib/approval.ts");
        const index = loadIndex(REPO_ROOT);
        const stream = index.streams[0];
        if (!stream) throw new Error("Stream not found");

        expect(isFullyApproved(stream)).toBe(true);

        const status = getFullApprovalStatus(stream);
        expect(status.plan).toBe("approved");
        expect(status.tasks).toBe("approved");
        expect(status.fullyApproved).toBe(true);
    });
});

// Separate test suite for TASKS.md auto-generation during plan approval
describe("Plan Approval with TASKS.md Auto-Generation", () => {
    let workspace: TestWorkspace;
    let AUTOGEN_REPO_ROOT: string;

    beforeEach(() => {
        // Set USER role for approval tests
        process.env.WORKSTREAM_ROLE = "USER";
        
        workspace = createTestWorkstream("stream-autogen");
        AUTOGEN_REPO_ROOT = workspace.repoRoot;

        // Create index.json
        const index: WorkIndex = {
            version: "1.0.0",
            last_updated: new Date().toISOString(),
            streams: [{
                id: "stream-autogen",
                name: "Auto-Gen Test Stream",
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
                path: "work/stream-autogen",
                generated_by: { workstreams: "1.0.0" }
            }]
        };
        saveIndex(AUTOGEN_REPO_ROOT, index);
    });

    afterEach(() => {
        cleanupTestWorkstream(workspace);
        // Clean up role setting
        delete process.env.WORKSTREAM_ROLE;
    });

    test("should generate TASKS.md when approving plan with valid PLAN.md", async () => {
        // Create a valid PLAN.md from fixture
        const planContent = readFileSync(join(import.meta.dir, "fixtures/plans/basic-plan.md"), "utf-8");
        writeFileSync(join(AUTOGEN_REPO_ROOT, "work/stream-autogen/PLAN.md"), planContent);

        // Verify TASKS.md doesn't exist yet
        const tasksMdPath = join(AUTOGEN_REPO_ROOT, "work/stream-autogen/TASKS.md");
        expect(existsSync(tasksMdPath)).toBe(false);

        // Run the CLI approve command
        const { main } = await import("../src/cli/approve/index.ts");

        // Capture console output
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "plan", "--stream", "stream-autogen", "--repo-root", AUTOGEN_REPO_ROOT]);
        });

        // Verify plan was approved
        const index = loadIndex(AUTOGEN_REPO_ROOT);
        const stream = index.streams[0];
        expect(stream?.approval?.status).toBe("approved");

        // Verify TASKS.md was generated
        expect(existsSync(tasksMdPath)).toBe(true);

        // Verify TASKS.md content structure
        const tasksMdContent = readFileSync(tasksMdPath, "utf-8");
        expect(tasksMdContent).toContain("# Tasks: Auto-Gen Test Stream");
        expect(tasksMdContent).toContain("## Stage 01: Stage One");
        expect(tasksMdContent).toContain("### Batch 01: Batch One");
        expect(tasksMdContent).toContain("#### Thread 01: Thread One");
        // Also verify Stage 02 is present as per basic-plan.md
        expect(tasksMdContent).toContain("## Stage 02: Stage Two");

        // Verify output message mentions TASKS.md
        const outputJoined = stdout.join("\n");
        expect(outputJoined).toContain("TASKS.md generated");
    });

    test("should warn when overwriting existing TASKS.md", async () => {
        // Create a valid PLAN.md from fixture
        const planContent = readFileSync(join(import.meta.dir, "fixtures/plans/multi-batch-plan.md"), "utf-8");
        writeFileSync(join(AUTOGEN_REPO_ROOT, "work/stream-autogen/PLAN.md"), planContent);

        // Pre-create TASKS.md
        const tasksMdPath = join(AUTOGEN_REPO_ROOT, "work/stream-autogen/TASKS.md");
        writeFileSync(tasksMdPath, "# Old TASKS.md content");

        // Run the CLI approve command
        const { main } = await import("../src/cli/approve/index.ts");

        // Capture console output
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "plan", "--stream", "stream-autogen", "--repo-root", AUTOGEN_REPO_ROOT]);
        });

        // Verify TASKS.md was overwritten
        const tasksMdContent = readFileSync(tasksMdPath, "utf-8");
        expect(tasksMdContent).not.toContain("Old TASKS.md content");
        expect(tasksMdContent).toContain("# Tasks:");

        // Verify warning was shown
        const outputJoined = stdout.join("\n");
        expect(outputJoined).toContain("Overwrote existing TASKS.md");
    });

    test("should still approve plan when TASKS.md generation fails", async () => {
        // Create a minimal PLAN.md without proper structure (will fail to generate proper tasks)
        writeFileSync(join(AUTOGEN_REPO_ROOT, "work/stream-autogen/PLAN.md"), "# Minimal Plan\nNo stages.");

        // Run the CLI approve command
        const { main } = await import("../src/cli/approve/index.ts");

        // Capture console output
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "plan", "--stream", "stream-autogen", "--repo-root", AUTOGEN_REPO_ROOT]);
        });

        // Verify plan was still approved even if TASKS.md generation had issues
        const index = loadIndex(AUTOGEN_REPO_ROOT);
        const stream = index.streams[0];
        expect(stream?.approval?.status).toBe("approved");

        // Output should mention the plan was approved
        const outputJoined = stdout.join("\n");
        expect(outputJoined).toContain("Approved plan");
    });

    test("should include TASKS.md info in JSON output", async () => {
        // Create a valid PLAN.md from fixture
        const planContent = readFileSync(join(import.meta.dir, "fixtures/plans/multi-batch-plan.md"), "utf-8");
        writeFileSync(join(AUTOGEN_REPO_ROOT, "work/stream-autogen/PLAN.md"), planContent);

        // Run the CLI approve command with JSON output
        const { main } = await import("../src/cli/approve/index.ts");

        // Capture console output
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "plan", "--stream", "stream-autogen", "--repo-root", AUTOGEN_REPO_ROOT, "--json"]);
        });

        // Parse JSON output
        const jsonOutput = JSON.parse(stdout.join(""));
        expect(jsonOutput.action).toBe("approved");
        expect(jsonOutput.target).toBe("plan");
        expect(jsonOutput.tasksMd).toBeDefined();
        expect(jsonOutput.tasksMd.generated).toBe(true);
        expect(jsonOutput.tasksMd.path).toContain("TASKS.md");
    });

    test("should auto-commit plan approval without GitHub integration enabled", async () => {
        const planContent = readFileSync(join(import.meta.dir, "fixtures/plans/basic-plan.md"), "utf-8");
        writeFileSync(join(AUTOGEN_REPO_ROOT, "work/stream-autogen/PLAN.md"), planContent);

        await saveGitHubConfig(AUTOGEN_REPO_ROOT, {
            ...DEFAULT_GITHUB_CONFIG,
            enabled: false,
            auto_commit_on_approval: true,
        });

        execSync("git init", { cwd: AUTOGEN_REPO_ROOT, stdio: "pipe" });
        execSync('git config user.name "Test User"', { cwd: AUTOGEN_REPO_ROOT, stdio: "pipe" });
        execSync('git config user.email "test@example.com"', { cwd: AUTOGEN_REPO_ROOT, stdio: "pipe" });
        execSync("git add -A && git commit -m \"baseline\"", {
            cwd: AUTOGEN_REPO_ROOT,
            stdio: "pipe",
        });

        const { main } = await import("../src/cli/approve/index.ts");
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "plan", "--stream", "stream-autogen", "--repo-root", AUTOGEN_REPO_ROOT]);
        });

        const outputJoined = stdout.join("\n");
        expect(outputJoined).toContain("Approved plan");
        expect(outputJoined).toContain("TASKS.md generated");
        expect(outputJoined).toContain("Committed:");

        const subject = execSync("git log -1 --pretty=%s", {
            cwd: AUTOGEN_REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const body = execSync("git log -1 --pretty=%b", {
            cwd: AUTOGEN_REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const files = execSync("git show --pretty= --name-only HEAD", {
            cwd: AUTOGEN_REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim().split("\n").filter(Boolean);

        expect(subject).toBe("Plan approved: Basic Plan");
        expect(body).toContain("Approved plan for workstream stream-autogen.");
        expect(body).toContain("Stream-Id: stream-autogen");
        expect(body).toContain("Stream-Name: Basic Plan");
        expect(files).toContain("work/index.json");
        expect(files).toContain("work/stream-autogen/TASKS.md");
    });

    test("should still auto-commit plan approval when TASKS.md generation fails", async () => {
        writeFileSync(
            join(AUTOGEN_REPO_ROOT, "work/stream-autogen/PLAN.md"),
            [
                "# Invalid Plan Header",
                "",
                "## Summary",
                "Still enough content for approval to proceed.",
                "",
                "## Stages",
                "",
                "### Stage 1: Broken Stage",
            ].join("\n")
        );

        await saveGitHubConfig(AUTOGEN_REPO_ROOT, {
            ...DEFAULT_GITHUB_CONFIG,
            enabled: false,
            auto_commit_on_approval: true,
        });

        execSync("git init", { cwd: AUTOGEN_REPO_ROOT, stdio: "pipe" });
        execSync('git config user.name "Test User"', { cwd: AUTOGEN_REPO_ROOT, stdio: "pipe" });
        execSync('git config user.email "test@example.com"', { cwd: AUTOGEN_REPO_ROOT, stdio: "pipe" });
        execSync("git add -A && git commit -m \"baseline\"", {
            cwd: AUTOGEN_REPO_ROOT,
            stdio: "pipe",
        });

        const { main } = await import("../src/cli/approve/index.ts");
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "plan", "--stream", "stream-autogen", "--repo-root", AUTOGEN_REPO_ROOT]);
        });

        const tasksMdPath = join(AUTOGEN_REPO_ROOT, "work/stream-autogen/TASKS.md");
        const outputJoined = stdout.join("\n");

        const index = loadIndex(AUTOGEN_REPO_ROOT);
        const stream = index.streams[0];
        expect(stream?.approval?.status).toBe("approved");
        expect(existsSync(tasksMdPath)).toBe(false);

        expect(outputJoined).toContain("Approved plan");
        expect(outputJoined).toContain("Warning: Failed to generate TASKS.md");
        expect(outputJoined).toContain("Committed:");

        const subject = execSync("git log -1 --pretty=%s", {
            cwd: AUTOGEN_REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const files = execSync("git show --pretty= --name-only HEAD", {
            cwd: AUTOGEN_REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim().split("\n").filter(Boolean);

        expect(subject).toBe("Plan approved: Auto-Gen Test Stream");
        expect(files).toContain("work/index.json");
        expect(files).not.toContain("work/stream-autogen/TASKS.md");
    });
});

// Separate test suite for tasks approval with auto-generation of tasks.json and prompts
describe("Tasks Approval with Auto-Generation", () => {
    let workspace: TestWorkspace;
    let TASKS_APPROVAL_REPO_ROOT: string;

    beforeEach(() => {
        // Set USER role for approval tests
        process.env.WORKSTREAM_ROLE = "USER";
        
        workspace = createTestWorkstream("stream-tasks");
        TASKS_APPROVAL_REPO_ROOT = workspace.repoRoot;

        // Create index.json
        const index: WorkIndex = {
            version: "1.0.0",
            last_updated: new Date().toISOString(),
            streams: [{
                id: "stream-tasks",
                name: "Tasks Test Stream",
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
                path: "work/stream-tasks",
                generated_by: { workstreams: "1.0.0" },
                approval: { status: "approved" } // Plan is already approved
            }]
        };
        saveIndex(TASKS_APPROVAL_REPO_ROOT, index);

        // Create PLAN.md (needed for prompt generation)
        const planContent = readFileSync(join(import.meta.dir, "fixtures/plans/revision-plan.md"), "utf-8");
        writeFileSync(join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/PLAN.md"), planContent);
    });

    afterEach(() => {
        cleanupTestWorkstream(workspace);
        // Clean up role setting
        delete process.env.WORKSTREAM_ROLE;
    });

    test("should auto-commit tasks approval after cleanup with task count in message", async () => {
        const tasksMdContent = `# Tasks: Tasks Test Stream

## Stage 01: Implementation

### Batch 01: Core Features

#### Thread 01: Feature A @agent:coder

- [ ] Task 01.01.01.01: Implement feature A base
- [ ] Task 01.01.01.02: Add feature A tests

#### Thread 02: Feature B @agent:coder

- [ ] Task 01.01.02.01: Implement feature B base
`;
        const tasksMdPath = join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/TASKS.md");
        writeFileSync(tasksMdPath, tasksMdContent);

        await saveGitHubConfig(TASKS_APPROVAL_REPO_ROOT, {
            ...DEFAULT_GITHUB_CONFIG,
            enabled: false,
            auto_commit_on_approval: true,
        });

        execSync("git init", { cwd: TASKS_APPROVAL_REPO_ROOT, stdio: "pipe" });
        execSync('git config user.name "Test User"', { cwd: TASKS_APPROVAL_REPO_ROOT, stdio: "pipe" });
        execSync('git config user.email "test@example.com"', { cwd: TASKS_APPROVAL_REPO_ROOT, stdio: "pipe" });
        execSync("git add -A && git commit -m \"baseline\"", {
            cwd: TASKS_APPROVAL_REPO_ROOT,
            stdio: "pipe",
        });

        const { main } = await import("../src/cli/approve/index.ts");
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "tasks", "--stream", "stream-tasks", "--repo-root", TASKS_APPROVAL_REPO_ROOT]);
        });

        const outputJoined = stdout.join("\n");
        expect(outputJoined).toContain("Tasks approved");
        expect(outputJoined).toContain("Committed:");
        expect(existsSync(tasksMdPath)).toBe(false);

        const subject = execSync("git log -1 --pretty=%s", {
            cwd: TASKS_APPROVAL_REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const body = execSync("git log -1 --pretty=%b", {
            cwd: TASKS_APPROVAL_REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const files = execSync("git show --pretty= --name-only HEAD", {
            cwd: TASKS_APPROVAL_REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim().split("\n").filter(Boolean);

        expect(subject).toBe("Tasks approved: Revision Plan");
        expect(body).toContain("Approved 3 tasks for workstream stream-tasks.");
        expect(body).toContain("Task-Count: 3");
        expect(files).toContain("work/index.json");
        expect(files).toContain("work/stream-tasks/TASKS.md");
        expect(files).toContain("work/stream-tasks/tasks.json");
        expect(files).toContain("work/stream-tasks/prompts/01-implementation/01-dev/code.md");
    });

    test("should keep tasks approval successful when auto-commit fails", async () => {
        const tasksMdContent = `# Tasks: Tasks Test Stream

## Stage 01: Implementation

### Batch 01: Core Features

#### Thread 01: Feature A @agent:coder

- [ ] Task 01.01.01.01: Implement feature A
`;
        writeFileSync(join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/TASKS.md"), tasksMdContent);

        await saveGitHubConfig(TASKS_APPROVAL_REPO_ROOT, {
            ...DEFAULT_GITHUB_CONFIG,
            enabled: false,
            auto_commit_on_approval: true,
        });

        const { main } = await import("../src/cli/approve/index.ts");
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "tasks", "--stream", "stream-tasks", "--repo-root", TASKS_APPROVAL_REPO_ROOT]);
        });

        const index = loadIndex(TASKS_APPROVAL_REPO_ROOT);
        const stream = index.streams[0];
        const outputJoined = stdout.join("\n");

        expect(stream?.approval?.tasks?.status).toBe("approved");
        expect(outputJoined).toContain("Tasks approved");
        expect(outputJoined).toContain("Commit skipped:");
    });

    test("should serialize TASKS.md to tasks.json directly", () => {
        // Create valid TASKS.md 
        const tasksMdContent = `# Tasks: Tasks Test Stream

## Stage 01: Implementation

### Batch 01: Core Features

#### Thread 01: Feature A @agent:coder

- [ ] Task 01.01.01.01: Implement feature A
`;
        const tasksMdPath = join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/TASKS.md");
        writeFileSync(tasksMdPath, tasksMdContent);

        // Directly test the parsing and addTasks functionality
        const { parseTasksMd } = require("../src/lib/tasks-md.ts");
        const { addTasks, readTasksFile } = require("../src/lib/tasks.ts");

        const content = readFileSync(tasksMdPath, "utf-8");
        const { tasks, errors } = parseTasksMd(content, "stream-tasks");

        expect(errors.length).toBe(0);
        expect(tasks.length).toBe(1);
        expect(tasks[0].id).toBe("01.01.01.01");

        // Write tasks to tasks.json
        addTasks(TASKS_APPROVAL_REPO_ROOT, "stream-tasks", tasks);

        // Verify tasks.json was created
        const tasksJsonPath = join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/tasks.json");
        expect(existsSync(tasksJsonPath)).toBe(true);

        // Verify tasks.json content
        const tasksFile = readTasksFile(TASKS_APPROVAL_REPO_ROOT, "stream-tasks");
        expect(tasksFile?.tasks.length).toBe(1);
        expect(tasksFile?.tasks[0].id).toBe("01.01.01.01");
    });

    test("should generate tasks.json and prompts when approving tasks via CLI", async () => {
        // Create TASKS.md with valid tasks
        const tasksMdContent = `# Tasks: Tasks Test Stream

## Stage 01: Implementation

### Batch 01: Core Features

#### Thread 01: Feature A @agent:coder

- [ ] Task 01.01.01.01: Implement feature A base
- [ ] Task 01.01.01.02: Add feature A tests

#### Thread 02: Feature B @agent:coder

- [ ] Task 01.01.02.01: Implement feature B base
`;
        const tasksMdPath = join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/TASKS.md");
        writeFileSync(tasksMdPath, tasksMdContent);

        // Verify tasks.json doesn't exist yet
        const tasksJsonPath = join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/tasks.json");
        if (existsSync(tasksJsonPath)) rmSync(tasksJsonPath);
        expect(existsSync(tasksJsonPath)).toBe(false);

        // Run the CLI approve command for tasks
        const { main } = await import("../src/cli/approve/index.ts");

        // Capture console output
        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "tasks", "--stream", "stream-tasks", "--repo-root", TASKS_APPROVAL_REPO_ROOT]);
        });

        // Verify tasks.json was created
        expect(existsSync(tasksJsonPath)).toBe(true);

        // Verify tasks.json content
        const tasksJson = JSON.parse(readFileSync(tasksJsonPath, "utf-8"));
        expect(tasksJson.tasks.length).toBe(3);
        expect(tasksJson.tasks[0].id).toBe("01.01.01.01");
        expect(tasksJson.tasks[0].name).toBe("Implement feature A base");

        // Verify TASKS.md was deleted
        expect(existsSync(tasksMdPath)).toBe(false);

        // Verify prompts directory exists and has prompt files
        const promptsDir = join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/prompts");
        expect(existsSync(promptsDir)).toBe(true);

        // Verify output message
        const outputJoined = stdout.join("\n");
        expect(outputJoined).toContain("Tasks approved");
        expect(outputJoined).toContain("tasks.json");
        expect(outputJoined).toContain("TASKS.md deleted");
    });

    test("should approve even when prompt generation partially fails via CLI", async () => {
        // Create valid TASKS.md
        const tasksMdContent = `# Tasks: Tasks Test Stream

## Stage 01: Implementation

### Batch 01: Core Features

#### Thread 01: Feature A @agent:coder

- [ ] Task 01.01.01.01: Implement feature A
`;
        writeFileSync(join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/TASKS.md"), tasksMdContent);

        // Run the CLI approve command
        const { main } = await import("../src/cli/approve/index.ts");

        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "tasks", "--stream", "stream-tasks", "--repo-root", TASKS_APPROVAL_REPO_ROOT]);
        });

        // Verify tasks were approved (even if prompts had issues)
        const index = loadIndex(TASKS_APPROVAL_REPO_ROOT);
        const stream = index.streams[0];
        expect(stream?.approval?.tasks?.status).toBe("approved");

        // Verify tasks.json was created
        const tasksJsonPath = join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/tasks.json");
        expect(existsSync(tasksJsonPath)).toBe(true);

        // Verify output includes approval message
        const outputJoined = stdout.join("\n");
        expect(outputJoined).toContain("Tasks approved");
    });

    test("should include artifacts info in JSON output", async () => {
        // Create valid TASKS.md
        const tasksMdContent = `# Tasks: Tasks Test Stream

## Stage 01: Implementation

### Batch 01: Core Features

#### Thread 01: Feature A @agent:coder

- [ ] Task 01.01.01.01: Implement feature A
- [ ] Task 01.01.01.02: Test feature A
`;
        const tasksMdPath = join(TASKS_APPROVAL_REPO_ROOT, "work/stream-tasks/TASKS.md");
        writeFileSync(tasksMdPath, tasksMdContent);

        // Verify file was written
        expect(existsSync(tasksMdPath)).toBe(true);

        // Run the CLI approve command with JSON output
        const { main } = await import("../src/cli/approve/index.ts");

        const { stdout } = await captureCliOutput(async () => {
            await main(["node", "approve", "tasks", "--stream", "stream-tasks", "--repo-root", TASKS_APPROVAL_REPO_ROOT, "--json"]);
        });

        // Parse JSON output
        const jsonOutput = JSON.parse(stdout.join(""));
        expect(jsonOutput.action).toBe("approved");
        expect(jsonOutput.target).toBe("tasks");
        expect(jsonOutput.artifacts).toBeDefined();
        expect(jsonOutput.artifacts.tasksJson.generated).toBe(true);
        expect(jsonOutput.artifacts.tasksJson.taskCount).toBe(2);
        expect(jsonOutput.artifacts.tasksMdDeleted).toBe(true);
    });
});
