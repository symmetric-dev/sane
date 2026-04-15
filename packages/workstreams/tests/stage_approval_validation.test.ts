
import { describe, test, expect, beforeEach, afterEach, jest, mock } from "bun:test";
import { join } from "path";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { execSync } from "child_process";
import { saveIndex, loadIndex } from "../src/lib/index.ts";
import type { WorkIndex } from "../src/lib/types.ts";
import { saveGitHubConfig } from "../src/lib/github/config.ts";
import { DEFAULT_GITHUB_CONFIG } from "../src/lib/github/types.ts";

const TEST_DIR = join(import.meta.dir, "temp_stage_validation_test");
const REPO_ROOT = TEST_DIR;

describe("Stage Approval Validation", () => {
    beforeEach(() => {
        // Set USER role for approval tests
        process.env.WORKSTREAM_ROLE = "USER";
        
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true });
        }
        mkdirSync(join(TEST_DIR, "work", "stream-001"), { recursive: true });

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

        // Create tasks.json
        const tasksJsonPath = join(REPO_ROOT, "work/stream-001/tasks.json");
        writeFileSync(tasksJsonPath, JSON.stringify({
            version: "1.0.0",
            stream_id: "stream-001",
            last_updated: new Date().toISOString(),
            tasks: [
                {
                    id: "01.01.01.01",
                    name: "Task 1",
                    thread_name: "Thread 1",
                    batch_name: "Batch 1",
                    stage_name: "Stage 1",
                    status: "pending",
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                },
                {
                    id: "02.01.01.01",
                    name: "Task 2 (Stage 2)",
                    thread_name: "Thread 1",
                    batch_name: "Batch 1",
                    stage_name: "Stage 2",
                    status: "pending",
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }
            ]
        }, null, 2));

        writeFileSync(join(REPO_ROOT, "work/stream-001/PLAN.md"), `# Plan: Approval Automation

## Summary
Validate approval flows.

## Stages

### Stage 1: Shared Auto-Commit Infrastructure

#### Stage Definition
Build shared approval commit helpers.

#### Stage Constitution
Keep approval naming consistent.

#### Stage Questions
- [x] None

#### Stage Batches

##### Batch 01: Message Builders and Name Resolution

###### Thread 01: Plan-Derived Naming Helpers

**Summary:** Resolve plan-derived names.

**Details:** Use parsed stage names in approval commit messages.
`);
    });

    afterEach(() => {
        if (existsSync(TEST_DIR)) {
            rmSync(TEST_DIR, { recursive: true });
        }
        // Clean up role setting
        delete process.env.WORKSTREAM_ROLE;
    });

    test("should block stage approval if tasks are pending", async () => {
        const { main } = await import("../src/cli/approve/index.ts");

        // Mock process.exit
        const originalExit = process.exit;
        let exitCode: number | undefined;
        // @ts-ignore
        process.exit = (code?: number) => {
            exitCode = code ?? 0;
            // Throw to stop execution
            throw new Error(`Process exited with code ${code}`);
        };

        const logs: string[] = [];
        const originalError = console.error;
        const originalLog = console.log;
        console.error = (...args) => logs.push(args.join(" "));
        console.log = (...args) => logs.push(args.join(" "));

        try {
            await main(["node", "approve", "stage", "1", "--stream", "stream-001", "--repo-root", REPO_ROOT]);
        } catch (e) {
            // Expected exit
        } finally {
            process.exit = originalExit;
            console.error = originalError;
            console.log = originalLog;
        }

        expect(exitCode).toBe(1);
        const output = logs.join("\n");
        expect(output).toContain("Cannot approve Stage 1 because 1 thread(s) are not approved");
        expect(output).toContain("01.01.01 (Thread 1): 1 task(s) remaining");
    });

    test("should allow stage approval if tasks are completed", async () => {
        // Update tasks.json to completed
        const tasksJsonPath = join(REPO_ROOT, "work/stream-001/tasks.json");
        writeFileSync(tasksJsonPath, JSON.stringify({
            version: "1.0.0",
            stream_id: "stream-001",
            last_updated: new Date().toISOString(),
            tasks: [
                {
                    id: "01.01.01.01",
                    name: "Task 1",
                    thread_name: "Thread 1",
                    batch_name: "Batch 1",
                    stage_name: "Stage 1",
                    status: "completed",
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                },
                {
                    id: "02.01.01.01",
                    name: "Task 2 (Stage 2)",
                    thread_name: "Thread 1",
                    batch_name: "Batch 1",
                    stage_name: "Stage 2",
                    status: "pending", // Stage 2 still pending, shouldn't affect Stage 1
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }
            ]
        }, null, 2));

        const { main } = await import("../src/cli/approve/index.ts");

        const logs: string[] = [];
        const originalError = console.error;
        const originalLog = console.log;
        console.error = (...args) => logs.push(args.join(" "));
        console.log = (...args) => logs.push(args.join(" "));

        try {
            await main(["node", "approve", "stage", "1", "--stream", "stream-001", "--repo-root", REPO_ROOT]);
        } finally {
            console.error = originalError;
            console.log = originalLog;
        }

        const output = logs.join("\n");
        expect(output).toContain("Approved Stage 1");

        // Check index state
        const index = loadIndex(REPO_ROOT);
        const stream = index.streams[0]!;
        expect(stream.approval?.stages?.[1]?.status).toBe("approved");
    });

    test("should allow stage approval with --force even if tasks pending", async () => {
        const { main } = await import("../src/cli/approve/index.ts");

        const logs: string[] = [];
        const originalError = console.error;
        const originalLog = console.log;
        console.error = (...args) => logs.push(args.join(" "));
        console.log = (...args) => logs.push(args.join(" "));

        try {
            await main(["node", "approve", "stage", "1", "--force", "--stream", "stream-001", "--repo-root", REPO_ROOT]);
        } finally {
            console.error = originalError;
            console.log = originalLog;
        }

        const output = logs.join("\n");
        expect(output).toContain("Approved Stage 1");

        // Check index state
        const index = loadIndex(REPO_ROOT);
        const stream = index.streams[0]!;
        expect(stream.approval?.stages?.[1]?.status).toBe("approved");
    });

    test("should auto-commit stage approval even when GitHub integration is disabled", async () => {
        const tasksJsonPath = join(REPO_ROOT, "work/stream-001/tasks.json");
        writeFileSync(tasksJsonPath, JSON.stringify({
            version: "1.0.0",
            stream_id: "stream-001",
            last_updated: new Date().toISOString(),
            tasks: [
                {
                    id: "01.01.01.01",
                    name: "Task 1",
                    thread_name: "Thread 1",
                    batch_name: "Batch 1",
                    stage_name: "Stage 1",
                    status: "completed",
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }
            ]
        }, null, 2));

        execSync("git init", { cwd: REPO_ROOT, stdio: "pipe" });
        execSync("git config user.name \"Test User\"", { cwd: REPO_ROOT, stdio: "pipe" });
        execSync("git config user.email \"test@example.com\"", { cwd: REPO_ROOT, stdio: "pipe" });

        const { main } = await import("../src/cli/approve/index.ts");

        const logs: string[] = [];
        const originalError = console.error;
        const originalLog = console.log;
        console.error = (...args) => logs.push(args.join(" "));
        console.log = (...args) => logs.push(args.join(" "));

        try {
            await main(["node", "approve", "stage", "1", "--stream", "stream-001", "--repo-root", REPO_ROOT]);
        } finally {
            console.error = originalError;
            console.log = originalLog;
        }

        const output = logs.join("\n");
        expect(output).toContain("Approved Stage 1");
        expect(output).toContain("Committed:");

        const subject = execSync("git log -1 --pretty=%s", {
            cwd: REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        const body = execSync("git log -1 --pretty=%b", {
            cwd: REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        expect(subject).toBe("Stage 1 approved: Shared Auto-Commit Infrastructure");
        expect(body).toContain("Approved stage 1 of workstream stream-001.");
        expect(body).toContain("Stream-Id: stream-001");
        expect(body).toContain("Stream-Name: Approval Automation");
        expect(body).toContain("Stage: 1");
        expect(body).toContain("Stage-Name: Shared Auto-Commit Infrastructure");
    });

    test("should not auto-commit stage approval when auto-commit is disabled", async () => {
        const tasksJsonPath = join(REPO_ROOT, "work/stream-001/tasks.json");
        writeFileSync(tasksJsonPath, JSON.stringify({
            version: "1.0.0",
            stream_id: "stream-001",
            last_updated: new Date().toISOString(),
            tasks: [
                {
                    id: "01.01.01.01",
                    name: "Task 1",
                    thread_name: "Thread 1",
                    batch_name: "Batch 1",
                    stage_name: "Stage 1",
                    status: "completed",
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }
            ]
        }, null, 2));

        await saveGitHubConfig(REPO_ROOT, {
            ...DEFAULT_GITHUB_CONFIG,
            enabled: false,
            auto_commit_on_approval: false,
        });

        execSync("git init", { cwd: REPO_ROOT, stdio: "pipe" });
        execSync("git config user.name \"Test User\"", { cwd: REPO_ROOT, stdio: "pipe" });
        execSync("git config user.email \"test@example.com\"", { cwd: REPO_ROOT, stdio: "pipe" });
        execSync("git add -A && git commit -m \"baseline\"", {
            cwd: REPO_ROOT,
            stdio: "pipe",
        });
        const beforeSha = execSync("git rev-parse HEAD", {
            cwd: REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        const { main } = await import("../src/cli/approve/index.ts");

        const logs: string[] = [];
        const originalError = console.error;
        const originalLog = console.log;
        console.error = (...args) => logs.push(args.join(" "));
        console.log = (...args) => logs.push(args.join(" "));

        try {
            await main(["node", "approve", "stage", "1", "--stream", "stream-001", "--repo-root", REPO_ROOT]);
        } finally {
            console.error = originalError;
            console.log = originalLog;
        }

        const output = logs.join("\n");
        expect(output).toContain("Approved Stage 1");
        expect(output).not.toContain("Committed:");
        expect(output).not.toContain("No changes to commit");

        const afterSha = execSync("git rev-parse HEAD", {
            cwd: REPO_ROOT,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        expect(afterSha).toBe(beforeSha);
    });
});
