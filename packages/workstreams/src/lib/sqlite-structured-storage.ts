import { mkdirSync } from "fs"
import { join } from "path"
import { Database } from "bun:sqlite"

import { getWorkDir } from "./repo.ts"
import type {
  StructuredStorageWorkspaceState,
  StructuredStorageWorkstreamRecord,
  StructuredStorageWorkstreamState,
  StructuredApprovalRecord,
  StructuredStageRecord,
  StructuredBatchRecord,
  StructuredThreadRecord,
  StructuredTaskRecord,
  StructuredThreadRuntimeRecord,
} from "./structured-storage.ts"
import type {
  PersistedBatchStatusFile,
  PersistedBatchStatusThread,
  SessionRecord,
  SupervisorRunState,
  SupervisorStateFile,
} from "./types.ts"

const SQLITE_DB_FILENAME = "db.sqlite"
const SQLITE_SCHEMA_VERSION = "1"

const STREAM_SCOPED_TABLES = [
  "structured_stages",
  "structured_batches",
  "structured_threads",
  "structured_tasks",
  "structured_approvals",
  "structured_thread_runtime",
  "structured_thread_sessions",
  "structured_batch_runs",
  "structured_batch_run_threads",
  "structured_supervision_state",
  "structured_supervision_runs",
] as const

function jsonStringify(value: unknown): string {
  return JSON.stringify(value)
}

function nullableJsonStringify(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function approvalKey(record: StructuredApprovalRecord): string {
  return `${record.scope}:${record.stageId ?? ""}`
}

function openStructuredStorageDatabase(repoRoot: string): Database {
  mkdirSync(getWorkDir(repoRoot), { recursive: true })
  const db = new Database(getStructuredStorageSqlitePath(repoRoot))

  initializeStructuredStorageSchema(db)
  return db
}

function initializeStructuredStorageSchema(db: Database): void {
  const statements = [
    "create table if not exists structured_meta (key text primary key, value text not null)",
    "create table if not exists structured_workspace_state (workspace_key integer primary key check (workspace_key = 1), current_stream_id text)",
    "create table if not exists structured_workstreams (id text primary key, name text not null, order_index integer not null, size text not null, created_at text not null, updated_at text not null, storage_root text not null, manual_status text, current_batch text, metadata_json text not null)",
    "create table if not exists structured_stages (stream_id text not null, id text not null, number integer not null, name text not null, metadata_json text not null, primary key (stream_id, id))",
    "create table if not exists structured_batches (stream_id text not null, id text not null, stage_id text not null, number integer not null, name text not null, metadata_json text not null, primary key (stream_id, id))",
    "create table if not exists structured_threads (stream_id text not null, id text not null, stage_id text not null, batch_id text not null, number integer not null, name text not null, prompt_path text, metadata_json text not null, primary key (stream_id, id))",
    "create table if not exists structured_tasks (stream_id text not null, id text not null, stage_id text not null, batch_id text not null, thread_id text not null, number integer not null, name text not null, status text not null, created_at text not null, updated_at text not null, breadcrumb text, report text, assigned_agent text, metadata_json text not null, primary key (stream_id, id))",
    "create table if not exists structured_approvals (stream_id text not null, approval_key text not null, scope text not null, stage_id text, status text not null, approved_at text, approved_by text, revoked_at text, revoked_reason text, plan_hash text, task_count integer, commit_sha text, metadata_json text not null, primary key (stream_id, approval_key))",
    "create table if not exists structured_thread_runtime (stream_id text not null, thread_id text not null, current_session_id text, opencode_session_id text, working_agent_session_id text, synthesis_output text, metadata_json text not null, primary key (stream_id, thread_id))",
    "create table if not exists structured_thread_sessions (stream_id text not null, thread_id text not null, session_id text not null, agent_name text not null, model text not null, started_at text, completed_at text, status text not null, exit_code integer, lineage_json text, metadata_json text not null, primary key (stream_id, thread_id, session_id))",
    "create table if not exists structured_batch_runs (stream_id text not null, batch_id text not null, run_id text not null, mode text not null, status text not null, started_at text not null, updated_at text not null, completed_at text, tmux_session_name text, stage_name text, batch_name text, metadata_json text not null, primary key (stream_id, batch_id, run_id))",
    "create table if not exists structured_batch_run_threads (stream_id text not null, batch_id text not null, run_id text not null, thread_id text not null, thread_name text not null, first_task_id text not null, status text not null, updated_at text not null, completed_at text, metadata_json text not null, primary key (stream_id, batch_id, run_id, thread_id))",
    "create table if not exists structured_supervision_state (stream_id text primary key, version text not null, last_updated text not null, active_run_id text, current_branch_supervision_json text, metadata_json text not null)",
    "create table if not exists structured_supervision_runs (stream_id text not null, run_id text not null, stage_id text not null, status text not null, started_at text not null, updated_at text not null, completed_at text, current_batch_id text, review_passes integer not null, metadata_json text not null, primary key (stream_id, run_id))",
  ] as const

  for (const statement of statements) {
    db.run(statement)
  }

  db.run("insert or replace into structured_meta (key, value) values (?, ?)", [
    "schema_version",
    SQLITE_SCHEMA_VERSION,
  ])
}

function deleteRowsOutsideWorkspace(db: Database, streamIds: string[]): void {
  if (streamIds.length === 0) {
    db.run("delete from structured_workstreams")
    for (const table of STREAM_SCOPED_TABLES) {
      db.run(`delete from ${table}`)
    }
    return
  }

  const placeholders = streamIds.map(() => "?").join(", ")
  db.run(`delete from structured_workstreams where id not in (${placeholders})`, streamIds)
  for (const table of STREAM_SCOPED_TABLES) {
    db.run(`delete from ${table} where stream_id not in (${placeholders})`, streamIds)
  }
}

function replaceWorkspaceStateRows(db: Database, workspaceState: StructuredStorageWorkspaceState): void {
  db.run("delete from structured_workspace_state")
  db.run(
    "insert into structured_workspace_state (workspace_key, current_stream_id) values (1, ?)",
    [workspaceState.currentStreamId ?? null],
  )

  db.run("delete from structured_workstreams")
  for (const record of workspaceState.workstreams) {
    db.run(
      "insert into structured_workstreams (id, name, order_index, size, created_at, updated_at, storage_root, manual_status, current_batch, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.id,
        record.name,
        record.order,
        record.size,
        record.createdAt,
        record.updatedAt,
        record.storageRoot,
        record.manualStatus ?? null,
        record.currentBatch ?? null,
        jsonStringify(record satisfies StructuredStorageWorkstreamRecord),
      ],
    )
  }

  deleteRowsOutsideWorkspace(
    db,
    workspaceState.workstreams.map((record) => record.id),
  )
}

function clearWorkstreamRows(db: Database, streamId: string): void {
  for (const table of STREAM_SCOPED_TABLES) {
    db.run(`delete from ${table} where stream_id = ?`, [streamId])
  }
}

function insertStages(db: Database, streamId: string, stages: StructuredStageRecord[]): void {
  for (const stage of stages) {
    db.run(
      "insert into structured_stages (stream_id, id, number, name, metadata_json) values (?, ?, ?, ?, ?)",
      [streamId, stage.id, stage.number, stage.name, jsonStringify(stage)],
    )
  }
}

function insertBatches(db: Database, streamId: string, batches: StructuredBatchRecord[]): void {
  for (const batch of batches) {
    db.run(
      "insert into structured_batches (stream_id, id, stage_id, number, name, metadata_json) values (?, ?, ?, ?, ?, ?)",
      [streamId, batch.id, batch.stageId, batch.number, batch.name, jsonStringify(batch)],
    )
  }
}

function insertThreads(db: Database, streamId: string, threads: StructuredThreadRecord[]): void {
  for (const thread of threads) {
    db.run(
      "insert into structured_threads (stream_id, id, stage_id, batch_id, number, name, prompt_path, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        streamId,
        thread.id,
        thread.stageId,
        thread.batchId,
        thread.number,
        thread.name,
        thread.promptPath ?? null,
        jsonStringify(thread),
      ],
    )
  }
}

function insertTasks(db: Database, streamId: string, tasks: StructuredTaskRecord[]): void {
  for (const task of tasks) {
    db.run(
      "insert into structured_tasks (stream_id, id, stage_id, batch_id, thread_id, number, name, status, created_at, updated_at, breadcrumb, report, assigned_agent, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        streamId,
        task.id,
        task.stageId,
        task.batchId,
        task.threadId,
        task.number,
        task.name,
        task.status,
        task.createdAt,
        task.updatedAt,
        task.breadcrumb ?? null,
        task.report ?? null,
        task.assignedAgent ?? null,
        jsonStringify(task),
      ],
    )
  }
}

function insertApprovals(db: Database, streamId: string, approvals: StructuredApprovalRecord[]): void {
  for (const approval of approvals) {
    db.run(
      "insert into structured_approvals (stream_id, approval_key, scope, stage_id, status, approved_at, approved_by, revoked_at, revoked_reason, plan_hash, task_count, commit_sha, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        streamId,
        approvalKey(approval),
        approval.scope,
        approval.stageId ?? null,
        approval.status,
        approval.approvedAt ?? null,
        approval.approvedBy ?? null,
        approval.revokedAt ?? null,
        approval.revokedReason ?? null,
        approval.planHash ?? null,
        approval.taskCount ?? null,
        approval.commitSha ?? null,
        jsonStringify(approval),
      ],
    )
  }
}

function insertThreadSessions(
  db: Database,
  streamId: string,
  threadId: string,
  sessions: SessionRecord[],
): void {
  for (const session of sessions) {
    db.run(
      "insert into structured_thread_sessions (stream_id, thread_id, session_id, agent_name, model, started_at, completed_at, status, exit_code, lineage_json, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        streamId,
        threadId,
        session.sessionId,
        session.agentName,
        session.model,
        session.startedAt ?? null,
        session.completedAt ?? null,
        session.status,
        session.exitCode ?? null,
        nullableJsonStringify(session.lineage),
        jsonStringify(session),
      ],
    )
  }
}

function insertThreadRuntime(
  db: Database,
  streamId: string,
  threadRuntime: StructuredThreadRuntimeRecord[],
): void {
  for (const record of threadRuntime) {
    db.run(
      "insert into structured_thread_runtime (stream_id, thread_id, current_session_id, opencode_session_id, working_agent_session_id, synthesis_output, metadata_json) values (?, ?, ?, ?, ?, ?, ?)",
      [
        streamId,
        record.threadId,
        record.currentSessionId ?? null,
        record.opencodeSessionId ?? null,
        record.workingAgentSessionId ?? null,
        record.synthesisOutput ?? null,
        jsonStringify(record),
      ],
    )
    insertThreadSessions(db, streamId, record.threadId, record.sessions)
  }
}

function insertBatchRunThreads(
  db: Database,
  streamId: string,
  batchId: string,
  runId: string,
  threads: PersistedBatchStatusThread[],
): void {
  for (const thread of threads) {
    db.run(
      "insert into structured_batch_run_threads (stream_id, batch_id, run_id, thread_id, thread_name, first_task_id, status, updated_at, completed_at, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        streamId,
        batchId,
        runId,
        thread.threadId,
        thread.threadName,
        thread.firstTaskId,
        thread.status,
        thread.updatedAt,
        thread.completedAt ?? null,
        jsonStringify(thread),
      ],
    )
  }
}

function insertBatchRuns(db: Database, streamId: string, batchRuns: PersistedBatchStatusFile[]): void {
  for (const batchRun of batchRuns) {
    db.run(
      "insert into structured_batch_runs (stream_id, batch_id, run_id, mode, status, started_at, updated_at, completed_at, tmux_session_name, stage_name, batch_name, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        streamId,
        batchRun.batchId,
        batchRun.runId,
        batchRun.mode,
        batchRun.status,
        batchRun.startedAt,
        batchRun.updatedAt,
        batchRun.completedAt ?? null,
        batchRun.tmuxSessionName ?? null,
        batchRun.stageName ?? null,
        batchRun.batchName ?? null,
        jsonStringify(batchRun),
      ],
    )
    insertBatchRunThreads(db, streamId, batchRun.batchId, batchRun.runId, batchRun.threads)
  }
}

function insertSupervisionRuns(
  db: Database,
  streamId: string,
  runs: SupervisorRunState[],
): void {
  for (const run of runs) {
    db.run(
      "insert into structured_supervision_runs (stream_id, run_id, stage_id, status, started_at, updated_at, completed_at, current_batch_id, review_passes, metadata_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        streamId,
        run.runId,
        run.stageId,
        run.status,
        run.startedAt,
        run.updatedAt,
        run.completedAt ?? null,
        run.currentBatchId ?? null,
        run.reviewPasses,
        jsonStringify(run),
      ],
    )
  }
}

function replaceWorkstreamStateRows(db: Database, workstreamState: StructuredStorageWorkstreamState): void {
  clearWorkstreamRows(db, workstreamState.streamId)
  insertStages(db, workstreamState.streamId, workstreamState.hierarchy.stages)
  insertBatches(db, workstreamState.streamId, workstreamState.hierarchy.batches)
  insertThreads(db, workstreamState.streamId, workstreamState.hierarchy.threads)
  insertTasks(db, workstreamState.streamId, workstreamState.hierarchy.tasks)
  insertApprovals(db, workstreamState.streamId, workstreamState.approvals)
  insertThreadRuntime(db, workstreamState.streamId, workstreamState.threadRuntime)
  insertBatchRuns(db, workstreamState.streamId, workstreamState.batchRuns)
  db.run(
    "insert into structured_supervision_state (stream_id, version, last_updated, active_run_id, current_branch_supervision_json, metadata_json) values (?, ?, ?, ?, ?, ?)",
    [
      workstreamState.streamId,
      workstreamState.supervision.version,
      workstreamState.supervision.last_updated,
      workstreamState.supervision.active_run_id ?? null,
      nullableJsonStringify(workstreamState.supervision.current_branch_supervision),
      jsonStringify(workstreamState.supervision satisfies SupervisorStateFile),
    ],
  )
  insertSupervisionRuns(db, workstreamState.streamId, workstreamState.supervision.runs)
}

export function getStructuredStorageSqlitePath(repoRoot: string): string {
  return join(getWorkDir(repoRoot), SQLITE_DB_FILENAME)
}

export function syncStructuredStorageWorkspaceStateToSqlite(
  repoRoot: string,
  workspaceState: StructuredStorageWorkspaceState,
): void {
  const db = openStructuredStorageDatabase(repoRoot)

  try {
    const transaction = db.transaction((state: StructuredStorageWorkspaceState) => {
      replaceWorkspaceStateRows(db, state)
    })
    transaction(workspaceState)
  } finally {
    db.close()
  }
}

export function syncStructuredStorageWorkstreamStateToSqlite(
  repoRoot: string,
  workstreamState: StructuredStorageWorkstreamState,
): void {
  const db = openStructuredStorageDatabase(repoRoot)

  try {
    const transaction = db.transaction((state: StructuredStorageWorkstreamState) => {
      replaceWorkstreamStateRows(db, state)
    })
    transaction(workstreamState)
  } finally {
    db.close()
  }
}
