import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "path"
import { writeFileSync } from "fs"

import {
  addTasks,
  getResolvedStream,
  getTaskById,
  getTaskCounts,
  getTasks,
  getWorkstreamStatusSnapshot,
  loadIndex,
  resolveStreamId,
  saveIndex,
  setCurrentStream,
} from "../src"
import { approveStage, approveStream, approveTasks, getStageApprovalStatus, getTasksApprovalStatus } from "../src/lib/approval"
import { syncBatchStatus } from "../src/lib/batch-monitor"
import { loadSupervisorState, saveSupervisorState } from "../src/lib/supervisor-state"
import { parseTasksMd } from "../src/lib/tasks-md"
import {
  completeTaskSession,
  startTaskSession,
  writeTasksFile,
} from "../src/lib/tasks"
import { getThreadMetadata } from "../src/lib/threads"
import { buildWorkstreamTreeSnapshot } from "../src/lib/tree"
import type { StreamMetadata, SupervisorStateFile, Task, TasksFile, WorkIndex } from "../src/lib/types"
import { updateTask } from "../src/lib/update"
import { cleanupTestWorkstream, createTestWorkstream, type TestWorkspace } from "./helpers"

interface WorkflowPersistenceContractHarness {
  readonly name: string
  createWorkspace: () => TestWorkspace
  cleanupWorkspace: (workspace: TestWorkspace) => void
}

function buildStreamMetadata(args: {
  id: string
  name: string
  order: number
  streamPath?: string
}): StreamMetadata {
  const now = new Date().toISOString()
  return {
    id: args.id,
    name: args.name,
    order: args.order,
    size: "small",
    session_estimated: {
      length: 1,
      unit: "session",
      session_minutes: [30, 45],
      session_iterations: [4, 8],
    },
    created_at: now,
    updated_at: now,
    path: args.streamPath ?? `work/${args.id}`,
    generated_by: { workstreams: "test" },
  }
}

function baseTasksFile(streamId: string): TasksFile {
  return {
    version: "1.0.0",
    stream_id: streamId,
    last_updated: new Date().toISOString(),
    tasks: [
      {
        id: "01.01.01.01",
        name: "Thread one task",
        thread_name: "Thread One",
        batch_name: "Batch One",
        stage_name: "Stage One",
        status: "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "01.01.02.01",
        name: "Thread two task",
        thread_name: "Thread Two",
        batch_name: "Batch One",
        stage_name: "Stage One",
        status: "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ],
  }
}

function parseContractTasksOrThrow(markdown: string, streamId: string): Task[] {
  const result = parseTasksMd(markdown, streamId)
  expect(result.errors).toHaveLength(0)
  return result.tasks
}

function workflowTasksMarkdown(): string {
  return `
# Tasks: contract-stream

## Stage 02: Validation

### Batch 01: Verification

#### Thread 01: Release checks @agent:qa-reviewer
- [ ] Task 02.01.01.02: Verify rollback instructions
- [ ] Task 02.01.01.01: Prepare release checklist

## Stage 01: Persistence

### Batch 02: Read models

#### Thread 02: Status snapshot @agent:backend-analyst
- [ ] Task 01.02.02.01: Expose runtime projection

### Batch 01: Writes

#### Thread 01: Importer @agent:data-migrator
- [ ] Task 01.01.01.02: Preserve workflow state on re-import
- [ ] Task 01.01.01.01: Persist hierarchy rows
`.trim()
}

const filesystemHarness: WorkflowPersistenceContractHarness = {
  name: "filesystem-backed tasks/index persistence",
  createWorkspace: () =>
    createTestWorkstream(`001-contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  cleanupWorkspace: cleanupTestWorkstream,
}

function runWorkflowPersistenceContract(harness: WorkflowPersistenceContractHarness): void {
  describe(harness.name, () => {
    let workspace: TestWorkspace

    beforeEach(() => {
      workspace = harness.createWorkspace()
    })

    afterEach(() => {
      harness.cleanupWorkspace(workspace)
    })

    test("resolves persisted current stream identity through adapter-facing read models", () => {
      const primary = buildStreamMetadata({
        id: workspace.streamId,
        name: "primary-stream",
        order: 1,
      })
      const secondary = buildStreamMetadata({
        id: "002-secondary-stream",
        name: "secondary-stream",
        order: 2,
      })

      const index: WorkIndex = {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        streams: [primary, secondary],
      }

      saveIndex(workspace.repoRoot, index)
      setCurrentStream(workspace.repoRoot, secondary.id)

      const persisted = loadIndex(workspace.repoRoot)
      const currentStreamId = resolveStreamId(persisted, "current")

      expect(resolveStreamId(persisted, undefined)).toBe(secondary.id)
      expect(currentStreamId).toBe(secondary.id)
      expect(getResolvedStream(persisted, "secondary-stream").id).toBe(secondary.id)

      const primarySnapshot = getWorkstreamStatusSnapshot(workspace.repoRoot, primary, currentStreamId)
      const secondarySnapshot = getWorkstreamStatusSnapshot(workspace.repoRoot, secondary, currentStreamId)

      expect(primarySnapshot.stream.is_current).toBe(false)
      expect(secondarySnapshot.stream.is_current).toBe(true)
    })

    test("persists imported hierarchy by stable ids and preserves workflow state on re-import", async () => {
      const stream = buildStreamMetadata({
        id: workspace.streamId,
        name: "contract-stream",
        order: 1,
      })

      saveIndex(workspace.repoRoot, {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        streams: [stream],
      })

      const importedTasks = parseContractTasksOrThrow(workflowTasksMarkdown(), workspace.streamId)
      addTasks(workspace.repoRoot, workspace.streamId, importedTasks)

      const initialSnapshot = buildWorkstreamTreeSnapshot({
        streamId: workspace.streamId,
        tasks: getTasks(workspace.repoRoot, workspace.streamId),
      })

      expect(initialSnapshot.stages.map((stage) => stage.id)).toEqual(["01", "02"])
      expect(initialSnapshot.stages[0]?.batches.map((batch) => batch.id)).toEqual(["01.01", "01.02"])
      expect(initialSnapshot.stages[0]?.batches[0]?.threads[0]).toMatchObject({
        id: "01.01.01",
        assignedAgent: "data-migrator",
      })
      expect(initialSnapshot.stages[0]?.batches[0]?.threads[0]?.tasks.map((task) => task.id)).toEqual([
        "01.01.01.01",
        "01.01.01.02",
      ])

      await updateTask({
        repoRoot: workspace.repoRoot,
        stream,
        taskId: "01.01.01.01",
        status: "completed",
        report: "Hierarchy import validated.",
      })

      const reimportedTasks = parseContractTasksOrThrow(
        workflowTasksMarkdown().replace("Persist hierarchy rows", "Persist hierarchy rows from TASKS.md"),
        workspace.streamId,
      )
      addTasks(workspace.repoRoot, workspace.streamId, reimportedTasks)

      expect(getTaskById(workspace.repoRoot, workspace.streamId, "01.01.01.01")).toMatchObject({
        id: "01.01.01.01",
        name: "Persist hierarchy rows from TASKS.md",
        status: "completed",
      })
      expect(getTaskCounts(workspace.repoRoot, workspace.streamId).total).toBe(5)

      const reimportedSnapshot = buildWorkstreamTreeSnapshot({
        streamId: workspace.streamId,
        tasks: getTasks(workspace.repoRoot, workspace.streamId),
      })

      expect(reimportedSnapshot.stages[1]?.batches[0]?.threads[0]).toMatchObject({
        id: "02.01.01",
        assignedAgent: "qa-reviewer",
      })
      expect(reimportedSnapshot.stages[1]?.batches[0]?.threads[0]?.tasks.map((task) => task.id)).toEqual([
        "02.01.01.01",
        "02.01.01.02",
      ])
    })

    test("persists approval state independently across plan, tasks, and stage scopes", () => {
      const stream = buildStreamMetadata({
        id: workspace.streamId,
        name: "contract-stream",
        order: 1,
      })

      saveIndex(workspace.repoRoot, {
        version: "1.0.0",
        last_updated: new Date().toISOString(),
        streams: [stream],
      })

      writeFileSync(join(workspace.workDir, "TASKS.md"), workflowTasksMarkdown())
      addTasks(
        workspace.repoRoot,
        workspace.streamId,
        parseContractTasksOrThrow(workflowTasksMarkdown(), workspace.streamId),
      )

      approveStage(workspace.repoRoot, workspace.streamId, 2, "stage-reviewer")
      approveTasks(workspace.repoRoot, workspace.streamId)
      approveStream(workspace.repoRoot, workspace.streamId, "plan-reviewer")

      const approvedStream = loadIndex(workspace.repoRoot).streams[0]!

      expect(approvedStream.approval?.status).toBe("approved")
      expect(getTasksApprovalStatus(approvedStream)).toBe("approved")
      expect(approvedStream.approval?.tasks?.task_count).toBe(5)
      expect(getStageApprovalStatus(approvedStream, 1)).toBe("draft")
      expect(getStageApprovalStatus(approvedStream, 2)).toBe("approved")

      approveStage(workspace.repoRoot, workspace.streamId, 1, "stage-reviewer")
      const stageScopedApproval = loadIndex(workspace.repoRoot).streams[0]!
      expect(getStageApprovalStatus(stageScopedApproval, 1)).toBe("approved")
      expect(getStageApprovalStatus(stageScopedApproval, 2)).toBe("approved")
      expect(stageScopedApproval.approval?.tasks?.task_count).toBe(5)
    })

    test("persists task outcome semantics by task identity", async () => {
      const stream = buildStreamMetadata({
        id: workspace.streamId,
        name: "contract-stream",
        order: 1,
      })

      const seededTasks = baseTasksFile(workspace.streamId)
      seededTasks.tasks[0]!.created_at = "2024-01-01T00:00:00.000Z"
      seededTasks.tasks[0]!.updated_at = "2024-01-01T00:00:00.000Z"
      const originalCreatedAt = seededTasks.tasks[0]!.created_at
      writeTasksFile(workspace.repoRoot, workspace.streamId, seededTasks)

      const update = await updateTask({
        repoRoot: workspace.repoRoot,
        stream,
        taskId: "01.01.01.01",
        status: "completed",
        report: "Task finished with persisted report details.",
      })

      expect(update.updated).toBe(true)
      expect(update.task?.status).toBe("completed")
      expect(update.task?.report).toBe("Task finished with persisted report details.")

      const completedTask = getTaskById(workspace.repoRoot, workspace.streamId, "01.01.01.01")
      const untouchedTask = getTaskById(workspace.repoRoot, workspace.streamId, "01.01.02.01")
      expect(completedTask?.status).toBe("completed")
      expect(completedTask?.report).toBe("Task finished with persisted report details.")
      expect(completedTask?.created_at).toBe(originalCreatedAt)
      expect(completedTask?.updated_at).not.toBe(originalCreatedAt)
      expect(untouchedTask?.status).toBe("pending")
    })

    test("persists thread session linkage semantics across start and completion", () => {
      writeTasksFile(workspace.repoRoot, workspace.streamId, baseTasksFile(workspace.streamId))

      const session = startTaskSession(
        workspace.repoRoot,
        workspace.streamId,
        "01.01.01.01",
        "contract-agent",
        "contract-model",
      )

      expect(session).not.toBeNull()
      expect(session?.status).toBe("running")

      const completed = completeTaskSession(
        workspace.repoRoot,
        workspace.streamId,
        "01.01.01.01",
        session!.sessionId,
        "completed",
        0,
      )
      expect(completed?.status).toBe("completed")

      const thread = getThreadMetadata(workspace.repoRoot, workspace.streamId, "01.01.01")
      expect(thread?.currentSessionId).toBeUndefined()
      expect(thread?.sessions.at(-1)?.sessionId).toBe(session!.sessionId)
      expect(thread?.sessions.at(-1)?.status).toBe("completed")
    })

    test("persists batch workflow state and exposes it through runtime read models", async () => {
      const stream = buildStreamMetadata({
        id: workspace.streamId,
        name: "contract-stream",
        order: 1,
      })

      writeTasksFile(workspace.repoRoot, workspace.streamId, baseTasksFile(workspace.streamId))

      startTaskSession(
        workspace.repoRoot,
        workspace.streamId,
        "01.01.01.01",
        "agent-one",
        "model-one",
      )

      const status = await syncBatchStatus({
        repoRoot: workspace.repoRoot,
        streamId: workspace.streamId,
        batchId: "01.01",
      })

      expect(status.status).toBe("running")
      expect(status.summary).toMatchObject({
        total: 2,
        pending: 1,
        running: 1,
        completed: 0,
        failed: 0,
      })
      expect(status.threads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ threadId: "01.01.01", status: "running" }),
          expect.objectContaining({ threadId: "01.01.02", status: "pending" }),
        ]),
      )

      const snapshot = getWorkstreamStatusSnapshot(workspace.repoRoot, stream)
      expect(snapshot.runtime?.entries).toContainEqual(
        expect.objectContaining({
          kind: "batch",
          batch_id: "01.01",
          task_status: "pending",
          runtime_status: "running",
          entry_status: "desync",
        }),
      )
    })

    test("persists supervision state canonically and re-projects workflow runtime views", () => {
      const stream = buildStreamMetadata({
        id: workspace.streamId,
        name: "contract-stream",
        order: 1,
      })

      writeTasksFile(workspace.repoRoot, workspace.streamId, baseTasksFile(workspace.streamId))
      const startedAt = new Date().toISOString()

      const supervisorState: SupervisorStateFile = {
        version: "1.0.0",
        stream_id: workspace.streamId,
        last_updated: startedAt,
        active_run_id: "sup-run-contract",
        current_branch_supervision: {
          owner: "root_agent",
          rootSessionId: "root-session-contract",
          branchSessionId: "branch-session-contract",
          branchRole: "supervision",
          source: "native_fork",
          nativeSessionId: "native-session-contract",
          status: "running",
          startedAt,
          updatedAt: startedAt,
          batchId: "01.01",
          scope: { level: "batch", stageId: "01", batchId: "01.01" },
          supervisionProgress: {
            executionMode: "single_batch_run",
            currentBatchId: "01.01",
          },
        },
        runs: [
          {
            runId: "sup-run-contract",
            stageId: "01",
            status: "running",
            startedAt,
            updatedAt: startedAt,
            currentBatchId: "01.01",
            reviewPasses: 1,
            issueSummaryIds: [],
            escalationIds: [],
          },
        ],
        checkpoint_pointers: [],
        branch_sessions: [],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      }

      saveSupervisorState(workspace.repoRoot, workspace.streamId, supervisorState)

      const persisted = loadSupervisorState(workspace.repoRoot, workspace.streamId)
      expect(persisted?.active_run_id).toBe("sup-run-contract")
      expect(persisted?.runs).toHaveLength(1)

      const snapshot = getWorkstreamStatusSnapshot(workspace.repoRoot, stream)
      expect(snapshot.runtime?.summary.supervision?.active_run_id).toBe("sup-run-contract")
      expect(snapshot.runtime?.entries).toContainEqual(
        expect.objectContaining({
          kind: "supervision",
          target: "01.01",
          stage_id: "01",
          batch_id: "01.01",
        }),
      )
    })
  })
}

describe("workflow persistence semantics contract", () => {
  runWorkflowPersistenceContract(filesystemHarness)
})
