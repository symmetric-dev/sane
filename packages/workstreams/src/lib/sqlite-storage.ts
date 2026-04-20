import { mkdirSync } from "fs"
import { dirname, join } from "path"

import { Database } from "bun:sqlite"

export const SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION = 1

export const SQLITE_STRUCTURED_STORAGE_TABLES = [
  "structured_storage_metadata",
  "workspace_state",
  "workstreams",
  "stages",
  "batches",
  "threads",
  "tasks",
  "approvals",
  "thread_sessions",
  "batch_runs",
  "batch_run_threads",
  "supervision_state",
  "supervision_runs",
  "supervision_sessions",
] as const

export interface SqliteStructuredStorageBootstrapResult {
  databasePath: string
  schemaVersion: number
  tables: readonly string[]
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS structured_storage_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    current_stream_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS workstreams (
    stream_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    size TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    storage_root TEXT NOT NULL,
    manual_status TEXT,
    current_batch_id TEXT,
    generated_by_json TEXT NOT NULL,
    session_estimated_json TEXT NOT NULL,
    files_json TEXT,
    planning_session_json TEXT,
    github_json TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS stages (
    stream_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, stage_id),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS batches (
    stream_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    batch_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, batch_id),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, stage_id) REFERENCES stages(stream_id, stage_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS threads (
    stream_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    thread_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    prompt_path TEXT,
    current_session_id TEXT,
    opencode_session_id TEXT,
    working_agent_session_id TEXT,
    synthesis_output TEXT,
    synthesis_json TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, thread_id),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, stage_id) REFERENCES stages(stream_id, stage_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, batch_id) REFERENCES batches(stream_id, batch_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    stream_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    task_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    breadcrumb TEXT,
    report TEXT,
    assigned_agent TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, task_id),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, stage_id) REFERENCES stages(stream_id, stage_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, batch_id) REFERENCES batches(stream_id, batch_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, thread_id) REFERENCES threads(stream_id, thread_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    stream_id TEXT NOT NULL,
    approval_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    stage_id TEXT,
    status TEXT NOT NULL,
    approved_at TEXT,
    approved_by TEXT,
    revoked_at TEXT,
    revoked_reason TEXT,
    plan_hash TEXT,
    task_count INTEGER,
    commit_sha TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, approval_key),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, stage_id) REFERENCES stages(stream_id, stage_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS thread_sessions (
    stream_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    model TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    exit_code INTEGER,
    lineage_json TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, thread_id, session_id),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, thread_id) REFERENCES threads(stream_id, thread_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS batch_runs (
    stream_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    tmux_session_name TEXT,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    stage_name TEXT,
    batch_name TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    summary_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, run_id),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, batch_id) REFERENCES batches(stream_id, batch_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS batch_run_threads (
    stream_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    first_task_id TEXT NOT NULL,
    thread_name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    marker_detected_at TEXT,
    current_session_id TEXT,
    opencode_session_id TEXT,
    working_agent_session_id TEXT,
    synthesis_updated_at TEXT,
    recovery_note TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, run_id, thread_id),
    FOREIGN KEY (stream_id, run_id) REFERENCES batch_runs(stream_id, run_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, thread_id) REFERENCES threads(stream_id, thread_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, first_task_id) REFERENCES tasks(stream_id, task_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS supervision_state (
    stream_id TEXT PRIMARY KEY,
    active_run_id TEXT,
    current_branch_supervision_json TEXT,
    checkpoint_pointers_json TEXT NOT NULL DEFAULT '[]',
    reviewed_batches_json TEXT NOT NULL DEFAULT '[]',
    issue_summaries_json TEXT NOT NULL DEFAULT '[]',
    fix_cycles_json TEXT NOT NULL DEFAULT '[]',
    escalations_json TEXT NOT NULL DEFAULT '[]',
    stage_stops_json TEXT NOT NULL DEFAULT '[]',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS supervision_runs (
    stream_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    current_batch_id TEXT,
    last_reviewed_batch_id TEXT,
    review_passes INTEGER NOT NULL DEFAULT 0,
    issue_summary_ids_json TEXT NOT NULL DEFAULT '[]',
    escalation_ids_json TEXT NOT NULL DEFAULT '[]',
    root_session_id TEXT,
    branch_session_id TEXT,
    stage_stop_id TEXT,
    stop_reason TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, run_id),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, stage_id) REFERENCES stages(stream_id, stage_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS supervision_sessions (
    stream_id TEXT NOT NULL,
    branch_session_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    branch_role TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT,
    started_at TEXT,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    process_ended_at TEXT,
    process_exit_code INTEGER,
    finalization_source TEXT,
    finalization_reason TEXT,
    native_session_id TEXT,
    tmux_session_name TEXT,
    run_id TEXT,
    batch_id TEXT,
    thread_id TEXT,
    review_id TEXT,
    fix_cycle_id TEXT,
    scope_json TEXT,
    breakpoint_selection_json TEXT,
    supervision_progress_json TEXT,
    notes TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, branch_session_id),
    FOREIGN KEY (stream_id) REFERENCES workstreams(stream_id) ON DELETE CASCADE,
    FOREIGN KEY (stream_id, run_id) REFERENCES supervision_runs(stream_id, run_id) ON DELETE SET NULL,
    FOREIGN KEY (stream_id, batch_id) REFERENCES batches(stream_id, batch_id) ON DELETE SET NULL,
    FOREIGN KEY (stream_id, thread_id) REFERENCES threads(stream_id, thread_id) ON DELETE SET NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_workstreams_order ON workstreams(order_index)",
  "CREATE INDEX IF NOT EXISTS idx_stages_stream_number ON stages(stream_id, stage_number)",
  "CREATE INDEX IF NOT EXISTS idx_batches_stream_stage_number ON batches(stream_id, stage_id, batch_number)",
  "CREATE INDEX IF NOT EXISTS idx_threads_stream_batch_number ON threads(stream_id, batch_id, thread_number)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_stream_thread_number ON tasks(stream_id, thread_id, task_number)",
  "CREATE INDEX IF NOT EXISTS idx_tasks_stream_status ON tasks(stream_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_thread_sessions_stream_thread_started ON thread_sessions(stream_id, thread_id, started_at)",
  "CREATE INDEX IF NOT EXISTS idx_batch_runs_stream_batch_updated ON batch_runs(stream_id, batch_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_supervision_runs_stream_stage_updated ON supervision_runs(stream_id, stage_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_supervision_sessions_stream_run_updated ON supervision_sessions(stream_id, run_id, updated_at)",
] as const

function getMetadataUpsertStatement(database: Database) {
  return database.query(
    `INSERT INTO structured_storage_metadata (key, value, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
}

export function getSqliteStructuredStoragePath(repoRoot: string): string {
  return join(repoRoot, "work", "db.sqlite")
}

export function openSqliteStructuredStorageDatabase(repoRoot: string): Database {
  const databasePath = getSqliteStructuredStoragePath(repoRoot)
  mkdirSync(dirname(databasePath), { recursive: true })

  const database = new Database(databasePath, { create: true })

  try {
    initializeSqliteStructuredStorageSchema(database, databasePath)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

export function bootstrapSqliteStructuredStorage(
  repoRoot: string,
): SqliteStructuredStorageBootstrapResult {
  const databasePath = getSqliteStructuredStoragePath(repoRoot)
  const database = openSqliteStructuredStorageDatabase(repoRoot)
  database.close()

  return {
    databasePath,
    schemaVersion: SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION,
    tables: SQLITE_STRUCTURED_STORAGE_TABLES,
  }
}

function initializeSqliteStructuredStorageSchema(database: Database, databasePath: string): void {
  database.exec("PRAGMA foreign_keys = ON")
  database.exec("PRAGMA journal_mode = WAL")
  database.exec("PRAGMA synchronous = NORMAL")

  database.exec("BEGIN")

  try {
    for (const statement of SCHEMA_STATEMENTS) {
      database.exec(statement)
    }

    database.exec(
      `INSERT INTO workspace_state (singleton_id, current_stream_id, metadata_json)
       VALUES (1, NULL, '{}')
       ON CONFLICT(singleton_id) DO NOTHING`,
    )

    const upsertMetadata = getMetadataUpsertStatement(database)
    const now = new Date().toISOString()

    upsertMetadata.run("schema_version", String(SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION), now)
    upsertMetadata.run("database_path", databasePath, now)

    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}
