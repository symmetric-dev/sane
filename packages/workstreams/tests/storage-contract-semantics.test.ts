import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  approvalMetadataToStructuredApprovalRecords,
  createEmptyStructuredStorageWorkstreamState,
  createStructuredStorageWorkstreamRecord,
  filesystemStructuredStorageAdapter,
  getTaskById,
  getWorkstreamStatusSnapshot,
} from "../src"
import type {
  PersistedBatchStatusFile,
  StreamMetadata,
  StructuredStorageWorkstreamState,
  SupervisorStateFile,
  Task,
} from "../src"
import { parseTasksMd } from "../src/lib/tasks-md"
import { cleanupTestWorkstream, createTestWorkstream, type TestWorkspace } from "./helpers"

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
    status: "in_progress",
    approval: {
      status: "approved",
      approved_at: now,
      approved_by: "reviewer",
      plan_hash: "plan-hash",
      tasks: {
        status: "approved",
        approved_at: now,
        task_count: 4,
      },
      stages: {
        1: {
          status: "approved",
          approved_at: now,
          approved_by: "stage-reviewer",
          commit_sha: "abc123",
        },
      },
    },
    size: "short",
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
    current_batch: "01.01",
  }
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

function parseContractTasksOrThrow(markdown: string, streamId: string): Task[] {
  const result = parseTasksMd(markdown, streamId)
  expect(result.errors).toHaveLength(0)
  return result.tasks
}

function buildBatchRun(streamId: string, batchId: string): PersistedBatchStatusFile {
  return {
    version: "1.0.0",
    streamId,
    batchId,
    runId: `run-${batchId}`,
    mode: "headless",
    status: batchId === "01.01" ? "running" : "pending",
    startedAt: "2026-04-19T02:00:00.000Z",
    updatedAt: "2026-04-19T02:05:00.000Z",
    summary: {
      total: batchId === "01.01" ? 2 : 1,
      pending: batchId === "01.01" ? 1 : 1,
      running: batchId === "01.01" ? 1 : 0,
      completed: 0,
      failed: 0,
    },
    threads: [
      {
        threadId: batchId === "01.01" ? "01.01.01" : "01.02.02",
        threadName: batchId === "01.01" ? "Importer" : "Status snapshot",
        firstTaskId: batchId === "01.01" ? "01.01.01.01" : "01.02.02.01",
        status: batchId === "01.01" ? "running" : "pending",
        updatedAt: "2026-04-19T02:05:00.000Z",
      },
    ],
  }
}

function buildSupervisionState(streamId: string): SupervisorStateFile {
  return {
    version: "1.0.0",
    stream_id: streamId,
    last_updated: "2026-04-19T03:00:00.000Z",
    active_run_id: "sup-run-contract",
    current_branch_supervision: {
      owner: "root_agent",
      rootSessionId: "root-session-contract",
      branchSessionId: "branch-session-contract",
      branchRole: "supervision",
      source: "native_fork",
      nativeSessionId: "native-session-contract",
      updatedAt: "2026-04-19T03:00:00.000Z",
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
        startedAt: "2026-04-19T03:00:00.000Z",
        updatedAt: "2026-04-19T03:05:00.000Z",
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
}

function buildStructuredWorkstreamState(streamId: string, tasks: Task[]): StructuredStorageWorkstreamState {
  const state = createEmptyStructuredStorageWorkstreamState(streamId)
  const stageMap = new Map<string, { id: string; number: number; name: string }>()
  const batchMap = new Map<string, { id: string; stageId: string; number: number; name: string }>()
  const threadMap = new Map<string, { id: string; stageId: string; batchId: string; number: number; name: string; promptPath?: string }>()

  for (const task of tasks) {
    const [stageId, batchNumber, threadNumber, taskNumber] = task.id.split(".")
    const batchId = `${stageId}.${batchNumber}`
    const threadId = `${batchId}.${threadNumber}`

    stageMap.set(stageId!, {
      id: stageId!,
      number: Number.parseInt(stageId!, 10),
      name: task.stage_name,
    })
    batchMap.set(batchId, {
      id: batchId,
      stageId: stageId!,
      number: Number.parseInt(batchNumber!, 10),
      name: task.batch_name,
    })
    threadMap.set(threadId, {
      id: threadId,
      stageId: stageId!,
      batchId,
      number: Number.parseInt(threadNumber!, 10),
      name: task.thread_name,
      promptPath: `prompts/${threadId}.md`,
    })

    state.hierarchy.tasks.push({
      id: task.id,
      stageId: stageId!,
      batchId,
      threadId,
      number: Number.parseInt(taskNumber!, 10),
      name: task.name,
      status: task.status,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      ...(task.assigned_agent ? { assignedAgent: task.assigned_agent } : {}),
    })
  }

  state.hierarchy.stages = [...stageMap.values()].sort((left, right) => left.id.localeCompare(right.id))
  state.hierarchy.batches = [...batchMap.values()].sort((left, right) => left.id.localeCompare(right.id))
  state.hierarchy.threads = [...threadMap.values()].sort((left, right) => left.id.localeCompare(right.id))
  state.threadRuntime = state.hierarchy.threads.map((thread) => ({
    threadId: thread.id,
    promptPath: thread.promptPath,
    sessions: thread.id === "01.01.01"
      ? [
          {
            sessionId: "session-importer",
            agentName: "data-migrator",
            model: "model-a",
            startedAt: "2026-04-19T02:00:00.000Z",
            status: "running",
          },
        ]
      : [],
    ...(thread.id === "01.01.01" ? { currentSessionId: "session-importer" } : {}),
    ...(thread.id === "01.01.01" ? { opencodeSessionId: "opencode-importer" } : {}),
  }))
  state.batchRuns = [buildBatchRun(streamId, "01.01"), buildBatchRun(streamId, "01.02")]
  state.supervision = buildSupervisionState(streamId)

  return state
}

describe("workflow persistence semantics contract", () => {
  const storage = filesystemStructuredStorageAdapter
  let workspace: TestWorkspace

  beforeEach(() => {
    workspace = createTestWorkstream(`001-contract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  })

  afterEach(() => {
    cleanupTestWorkstream(workspace)
  })

  test("loads, replaces, and modifies workspace state through the unified contract", async () => {
    const primary = buildStreamMetadata({ id: workspace.streamId, name: "primary-stream", order: 1 })
    const secondary = buildStreamMetadata({ id: "002-secondary-stream", name: "secondary-stream", order: 2 })

    await storage.replaceWorkspaceState(workspace.repoRoot, {
      currentStreamId: secondary.id,
      workstreams: [
        createStructuredStorageWorkstreamRecord(primary),
        createStructuredStorageWorkstreamRecord(secondary),
      ],
    })

    const initialWorkspaceState = await storage.loadWorkspaceState(workspace.repoRoot)
    expect(initialWorkspaceState.currentStreamId).toBe(secondary.id)
    expect(initialWorkspaceState.workstreams.map((stream) => stream.id)).toEqual([
      workspace.streamId,
      secondary.id,
    ])

    await storage.modifyWorkspaceState(workspace.repoRoot, (state) => {
      state.currentStreamId = workspace.streamId
      state.workstreams[0]!.currentBatch = "02.01"
      state.workstreams[0]!.manualStatus = "on_hold"
    })

    const modifiedWorkspaceState = await storage.loadWorkspaceState(workspace.repoRoot)
    expect(modifiedWorkspaceState.currentStreamId).toBe(workspace.streamId)
    expect(modifiedWorkspaceState.workstreams[0]).toMatchObject({
      id: workspace.streamId,
      currentBatch: "02.01",
      manualStatus: "on_hold",
    })
  })

  test("replaces and loads workstream state through the unified contract", async () => {
    const stream = buildStreamMetadata({ id: workspace.streamId, name: "contract-stream", order: 1 })
    const tasks = parseContractTasksOrThrow(workflowTasksMarkdown(), workspace.streamId)
    const state = buildStructuredWorkstreamState(workspace.streamId, tasks)
    state.approvals = approvalMetadataToStructuredApprovalRecords(workspace.streamId, stream.approval)

    await storage.replaceWorkspaceState(workspace.repoRoot, {
      currentStreamId: workspace.streamId,
      workstreams: [createStructuredStorageWorkstreamRecord(stream)],
    })
    await storage.replaceWorkstreamState(workspace.repoRoot, state)

    const persisted = await storage.loadWorkstreamState(workspace.repoRoot, workspace.streamId)
    expect(persisted).not.toBeNull()
    expect(persisted?.hierarchy.stages.map((stage) => stage.id)).toEqual(["01", "02"])
    expect(persisted?.hierarchy.batches.map((batch) => batch.id)).toEqual(["01.01", "01.02", "02.01"])
    expect(persisted?.hierarchy.threads.find((thread) => thread.id === "01.01.01")).toMatchObject({
      name: "Importer",
      promptPath: "prompts/01.01.01.md",
    })
    expect(persisted?.hierarchy.tasks.map((task) => task.id)).toEqual([
      "01.01.01.01",
      "01.01.01.02",
      "01.02.02.01",
      "02.01.01.01",
      "02.01.01.02",
    ])
    expect(persisted?.approvals.map((approval) => `${approval.scope}:${approval.stageId ?? ""}`)).toEqual([
      "plan:",
      "tasks:",
      "stage:01",
    ])
    expect(persisted?.batchRuns.map((batchRun) => batchRun.batchId)).toEqual(["01.01", "01.02"])
    expect(persisted?.supervision.active_run_id).toBe("sup-run-contract")

    const persistedTask = getTaskById(workspace.repoRoot, workspace.streamId, "01.01.01.01")
    expect(persistedTask).toMatchObject({
      id: "01.01.01.01",
      name: "Persist hierarchy rows",
      assigned_agent: "data-migrator",
    })

    const snapshot = getWorkstreamStatusSnapshot(workspace.repoRoot, stream)
    expect(snapshot.runtime?.summary.supervision?.active_run_id).toBe("sup-run-contract")
    expect(snapshot.runtime?.entries).toContainEqual(
      expect.objectContaining({
        kind: "batch",
        batch_id: "01.01",
        runtime_status: "running",
      }),
    )
  })

  test("modifies workstream state through the unified contract while preserving semantics", async () => {
    const stream = buildStreamMetadata({ id: workspace.streamId, name: "contract-stream", order: 1 })
    const tasks = parseContractTasksOrThrow(workflowTasksMarkdown(), workspace.streamId)
    const state = buildStructuredWorkstreamState(workspace.streamId, tasks)
    state.approvals = approvalMetadataToStructuredApprovalRecords(workspace.streamId, stream.approval)

    await storage.replaceWorkspaceState(workspace.repoRoot, {
      currentStreamId: workspace.streamId,
      workstreams: [createStructuredStorageWorkstreamRecord(stream)],
    })
    await storage.replaceWorkstreamState(workspace.repoRoot, state)

    await storage.modifyWorkstreamState(workspace.repoRoot, workspace.streamId, (draft) => {
      const task = draft.hierarchy.tasks.find((entry) => entry.id === "01.01.01.01")
      expect(task).toBeDefined()
      task!.status = "completed"
      task!.report = "Hierarchy import validated."
      task!.updatedAt = "2026-04-19T04:00:00.000Z"

      const tasksApproval = draft.approvals.find((entry) => entry.scope === "tasks")
      expect(tasksApproval).toBeDefined()
      tasksApproval!.taskCount = draft.hierarchy.tasks.length

      const threadRuntime = draft.threadRuntime.find((entry) => entry.threadId === "01.01.01")
      expect(threadRuntime).toBeDefined()
      threadRuntime!.currentSessionId = undefined
      threadRuntime!.sessions[0]!.status = "completed"
      threadRuntime!.sessions[0]!.completedAt = "2026-04-19T04:00:00.000Z"

      draft.supervision.runs[0]!.updatedAt = "2026-04-19T04:00:00.000Z"
      draft.supervision.runs[0]!.reviewPasses = 2
      draft.batchRuns[0]!.summary.completed = 1
      draft.batchRuns[0]!.summary.running = 0
      draft.batchRuns[0]!.threads[0]!.status = "completed"
      draft.batchRuns[0]!.threads[0]!.completedAt = "2026-04-19T04:00:00.000Z"
    })

    const persisted = await storage.loadWorkstreamState(workspace.repoRoot, workspace.streamId)
    expect(persisted?.hierarchy.tasks.find((task) => task.id === "01.01.01.01")).toMatchObject({
      status: "completed",
      report: "Hierarchy import validated.",
    })
    const persistedThreadRuntime = persisted?.threadRuntime.find((thread) => thread.threadId === "01.01.01")
    expect(persistedThreadRuntime?.currentSessionId).toBeUndefined()
    expect(persistedThreadRuntime?.sessions[0]).toMatchObject({ status: "completed" })
    expect(persisted?.approvals.find((approval) => approval.scope === "tasks")?.taskCount).toBe(5)
    expect(persisted?.supervision.runs[0]?.reviewPasses).toBe(2)
    expect(persisted?.batchRuns[0]?.threads[0]?.status).toBe("completed")

    const persistedTask = getTaskById(workspace.repoRoot, workspace.streamId, "01.01.01.01")
    expect(persistedTask).toMatchObject({
      status: "completed",
      report: "Hierarchy import validated.",
    })

    const snapshot = getWorkstreamStatusSnapshot(workspace.repoRoot, stream)
    expect(snapshot.runtime?.summary.supervision?.active_run_id).toBe("sup-run-contract")
    expect(snapshot.runtime?.entries).toContainEqual(
      expect.objectContaining({
        kind: "batch",
        batch_id: "01.01",
        runtime_status: "running",
      }),
    )
  })
})
