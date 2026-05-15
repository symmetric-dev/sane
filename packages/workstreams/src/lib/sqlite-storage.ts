import { existsSync, mkdirSync } from "fs"
import { dirname, join } from "path"

import { Database } from "bun:sqlite"
import {
  normalizeCanonicalBatchIdOrFallback,
  normalizeCanonicalStageIdOrFallback,
  normalizeCanonicalThreadIdOrFallback,
  normalizePersistedBatchStatus,
  normalizePersistedBranchSession,
  normalizePersistedCurrentBranchSupervisionContext,
  normalizePersistedSessionRecord,
  normalizePersistedSupervisorEscalation,
  normalizePersistedSupervisorFixCycle,
  normalizePersistedSupervisorIssueSummary,
  normalizePersistedSupervisorReviewedBatch,
  normalizePersistedSupervisorRunState,
  normalizePersistedSupervisorStageStop,
  normalizePersistedThreadMetadata,
} from "./stage-id.ts"
import type {
  StructuredStorageWorkspaceState,
  StructuredStorageWorkstreamState,
  StructuredApprovalRecord,
  StructuredBatchRecord,
  StructuredStageRecord,
  StructuredThreadRecord,
  StructuredThreadRuntimeRecord,
} from "./structured-storage.ts"
import type {
  PersistedBatchStatusFile,
  PersistedBatchStatusThread,
  RootAgentBranchSession,
  SessionRecord,
  SupervisorRunState,
  SupervisorStateFile,
} from "./types.ts"
import { createEmptySupervisorState } from "./supervisor-state.ts"
import { createEmptyStructuredStorageWorkstreamState as createEmptyWorkstreamState } from "./structured-storage.ts"
import { normalizeLoadedSupervisorState } from "./runtime-state.ts"

export const SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION = 2
const SQLITE_BUSY_TIMEOUT_MS = 5000

export const SQLITE_STRUCTURED_STORAGE_TABLES = [
  "structured_storage_metadata",
  "workspace_state",
  "workstreams",
  "stages",
  "batches",
  "threads",
  "execution_items",
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

export type SqliteStructuredStorageMirrorPhase = "bootstrap" | "workspace" | "workstream"

export interface SqliteStructuredStorageMirrorState {
  repoRoot: string
  databasePath: string
  lastAttemptedAt?: string
  lastSucceededAt?: string
  lastFailedAt?: string
  lastResult?: "success" | "error"
  lastOperation?: string
  lastPhase?: SqliteStructuredStorageMirrorPhase
  lastStreamId?: string
  lastError?: {
    name: string
    message: string
  }
}

const sqliteStructuredStorageMirrorStateByRepoRoot = new Map<string, SqliteStructuredStorageMirrorState>()

interface StructuredExecutionItemRecord {
  id: string
  stageId: string
  batchId: string
  threadId: string
  number: number
  name: string
  status: StructuredThreadRuntimeRecord["status"]
  createdAt: string
  updatedAt: string
  breadcrumb?: string
  report?: string
  assignedAgent?: string
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
  `CREATE TABLE IF NOT EXISTS execution_items (
     stream_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    item_number INTEGER NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    breadcrumb TEXT,
    report TEXT,
    assigned_agent TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (stream_id, item_id),
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
    item_count INTEGER,
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
    first_item_id TEXT NOT NULL,
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
    FOREIGN KEY (stream_id, first_item_id) REFERENCES execution_items(stream_id, item_id) ON DELETE CASCADE
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
  "CREATE INDEX IF NOT EXISTS idx_execution_items_stream_thread_number ON execution_items(stream_id, thread_id, item_number)",
  "CREATE INDEX IF NOT EXISTS idx_execution_items_stream_status ON execution_items(stream_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_thread_sessions_stream_thread_started ON thread_sessions(stream_id, thread_id, started_at)",
  "CREATE INDEX IF NOT EXISTS idx_batch_runs_stream_batch_updated ON batch_runs(stream_id, batch_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_supervision_runs_stream_stage_updated ON supervision_runs(stream_id, stage_id, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_supervision_sessions_stream_run_updated ON supervision_sessions(stream_id, run_id, updated_at)",
] as const

function getMetadataInsertIfMissingStatement(database: Database) {
  return database.query(
    `INSERT INTO structured_storage_metadata (key, value, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO NOTHING`,
  )
}

function configureSqliteStructuredStorageConnection(
  database: Database,
  options?: { readonly?: boolean },
): void {
  database.exec("PRAGMA foreign_keys = ON")
  database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`)

  if (!options?.readonly) {
    database.exec("PRAGMA journal_mode = WAL")
    database.exec("PRAGMA synchronous = NORMAL")
  }
}

function hasCurrentSqliteStructuredStorageSchema(database: Database): boolean {
  const metadataTable = database
    .query<{ name: string }, []>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'structured_storage_metadata'
       LIMIT 1`,
    )
    .get()

  if (!metadataTable) {
    return false
  }

  const schemaVersion = database
    .query<{ value: string }, [string]>(
      "SELECT value FROM structured_storage_metadata WHERE key = ?1 LIMIT 1",
    )
    .get("schema_version")

  return (
    schemaVersion?.value === String(SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION) &&
    sqliteTableExists(database, "execution_items") &&
    sqliteTableColumnExists(database, "execution_items", "item_id") &&
    sqliteTableExists(database, "batch_run_threads") &&
    sqliteTableColumnExists(database, "batch_run_threads", "first_item_id")
  )
}

function sqliteTableExists(database: Database, tableName: string): boolean {
  const row = database
    .query<{ name: string }, [string]>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = ?1
       LIMIT 1`,
    )
    .get(tableName)

  return row?.name === tableName
}

function sqliteTableColumnExists(database: Database, tableName: string, columnName: string): boolean {
  if (!sqliteTableExists(database, tableName)) {
    return false
  }

  const columns = database.query<{ name: string }, []>(`PRAGMA table_info(${tableName})`).all()
  return columns.some((column) => column.name === columnName)
}

export function getSqliteStructuredStoragePath(repoRoot: string): string {
  return join(repoRoot, "work", "db.sqlite")
}

export const getStructuredStorageSqlitePath = getSqliteStructuredStoragePath

function isSqliteStructuredStorageDebugEnabled(): boolean {
  const value = process.env.WORKSTREAM_SQLITE_DUAL_WRITE_DEBUG?.trim().toLowerCase()
  return value === "1" || value === "true"
}

function toSqliteStructuredStorageMirrorError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    }
  }

  return {
    name: "Error",
    message: String(error),
  }
}

export function getSqliteStructuredStorageMirrorState(
  repoRoot: string,
): SqliteStructuredStorageMirrorState | null {
  const state = sqliteStructuredStorageMirrorStateByRepoRoot.get(repoRoot)
  return state ? structuredClone(state) : null
}

export function recordSqliteStructuredStorageMirrorState(args: {
  repoRoot: string
  operation: string
  phase: SqliteStructuredStorageMirrorPhase
  result: "success" | "error"
  streamId?: string
  error?: unknown
}): SqliteStructuredStorageMirrorState {
  const occurredAt = new Date().toISOString()
  const previous = sqliteStructuredStorageMirrorStateByRepoRoot.get(args.repoRoot)
  const next: SqliteStructuredStorageMirrorState = {
    repoRoot: args.repoRoot,
    databasePath: getSqliteStructuredStoragePath(args.repoRoot),
    lastAttemptedAt: occurredAt,
    ...(previous?.lastSucceededAt ? { lastSucceededAt: previous.lastSucceededAt } : {}),
    ...(previous?.lastFailedAt ? { lastFailedAt: previous.lastFailedAt } : {}),
    lastResult: args.result,
    lastOperation: args.operation,
    lastPhase: args.phase,
    ...(args.streamId ? { lastStreamId: args.streamId } : {}),
    ...(previous?.lastError ? { lastError: { ...previous.lastError } } : {}),
  }

  if (args.result === "success") {
    next.lastSucceededAt = occurredAt
    delete next.lastError
  } else {
    next.lastFailedAt = occurredAt
    next.lastError = toSqliteStructuredStorageMirrorError(args.error)

    if (isSqliteStructuredStorageDebugEnabled()) {
      console.warn(
        `Warning: sqlite dual-write ${args.phase} failed during ${args.operation}: ${next.lastError.message}`,
      )
    }
  }

  sqliteStructuredStorageMirrorStateByRepoRoot.set(args.repoRoot, next)
  return structuredClone(next)
}

export function openSqliteStructuredStorageDatabase(repoRoot: string): Database {
  const databasePath = getSqliteStructuredStoragePath(repoRoot)
  mkdirSync(dirname(databasePath), { recursive: true })

  const database = new Database(databasePath, { create: true })

  try {
    configureSqliteStructuredStorageConnection(database)
    if (!hasCurrentSqliteStructuredStorageSchema(database)) {
      initializeSqliteStructuredStorageSchema(database, databasePath)
    }
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
  database.exec("BEGIN IMMEDIATE")

  try {
    for (const statement of SCHEMA_STATEMENTS) {
      database.exec(statement)
    }

    database.exec(
      `INSERT INTO workspace_state (singleton_id, current_stream_id, metadata_json)
       VALUES (1, NULL, '{}')
       ON CONFLICT(singleton_id) DO NOTHING`,
    )

    const insertMetadataIfMissing = getMetadataInsertIfMissingStatement(database)
    const now = new Date().toISOString()

    insertMetadataIfMissing.run("schema_version", String(SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION), now)
    insertMetadataIfMissing.run("database_path", databasePath, now)
    database.run(
      `UPDATE structured_storage_metadata
       SET value = ?2, updated_at = ?3
       WHERE key = ?1`,
      ["schema_version", String(SQLITE_STRUCTURED_STORAGE_SCHEMA_VERSION), now],
    )
    database.run(
      `UPDATE structured_storage_metadata
       SET value = ?2, updated_at = ?3
       WHERE key = ?1`,
      ["database_path", databasePath, now],
    )

    database.exec("COMMIT")
  } catch (error) {
    database.exec("ROLLBACK")
    throw error
  }
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value)
}

function nullableJsonStringify(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function approvalKey(record: StructuredApprovalRecord): string {
  return `${record.scope}:${normalizeCanonicalStageIdOrFallback(record.stageId) ?? record.stageId ?? ""}`
}

function deleteRemovedWorkstreams(database: Database, streamIds: string[]): void {
  if (streamIds.length === 0) {
    database.run("DELETE FROM workstreams")
    return
  }

  const placeholders = streamIds.map(() => "?").join(", ")
  database.run(`DELETE FROM workstreams WHERE stream_id NOT IN (${placeholders})`, streamIds)
}

function compareIds(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true })
}

function compareOptionalIds(left?: string, right?: string): number {
  if (left === right) return 0
  if (!left) return -1
  if (!right) return 1
  return compareIds(left, right)
}

function parseMetadataJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid sqlite metadata_json for ${context}: ${message}`)
  }
}

export function loadSqliteStructuredStorageWorkspaceState(
  repoRoot: string,
): StructuredStorageWorkspaceState | null {
  const databasePath = getSqliteStructuredStoragePath(repoRoot)
  if (!existsSync(databasePath)) {
    return null
  }

  const database = openSqliteStructuredStorageDatabase(repoRoot)

  try {
    const workspaceRow = database
      .query<{ current_stream_id: string | null }, []>(
        "SELECT current_stream_id FROM workspace_state WHERE singleton_id = 1 LIMIT 1",
      )
      .get()
    const workstreams = database
      .query<{ metadata_json: string }, []>(
        "SELECT metadata_json FROM workstreams ORDER BY order_index, stream_id",
      )
      .all()
      .map((row) =>
        parseMetadataJson<StructuredStorageWorkspaceState["workstreams"][number]>(
          row.metadata_json,
          "workstreams",
        )
      )

    return {
      ...(workspaceRow?.current_stream_id ? { currentStreamId: workspaceRow.current_stream_id } : {}),
      workstreams,
    }
  } finally {
    database.close()
  }
}

function normalizeSessionRecord(session: SessionRecord): SessionRecord {
  return normalizePersistedSessionRecord(session)
}

type SqliteThreadMetadataJson = {
  id: string
  stageId: string
  batchId: string
  number: number
  name: string
  promptPath?: string
  hasRuntimeMetadata?: boolean
  status?: StructuredThreadRuntimeRecord["status"]
  createdAt?: string
  updatedAt?: string
  itemName?: string
  breadcrumb?: string
  report?: string
  assignedAgent?: string
  currentSessionId?: string
  opencodeSessionId?: string
  workingAgentSessionId?: string
  synthesisOutput?: string
  synthesis?: StructuredThreadRuntimeRecord["synthesis"]
}

const APPROVAL_SCOPE_ORDER: Record<StructuredApprovalRecord["scope"], number> = {
  plan: 0,
  stage: 1,
}

function parseBatchId(batchId: string): { stageId: string; batchNumber: number } {
  const [stageId = "00", batchNumber = "0"] = batchId.split(".")
  return {
    stageId,
    batchNumber: Number.parseInt(batchNumber, 10) || 0,
  }
}

function parseThreadId(threadId: string): { stageId: string; batchId: string; threadNumber: number } {
  const [stageId = "00", batchNumber = "0", threadNumber = "0"] = threadId.split(".")
  return {
    stageId,
    batchId: `${stageId}.${batchNumber}`,
    threadNumber: Number.parseInt(threadNumber, 10) || 0,
  }
}

function parseExecutionItemId(itemId: string): {
  stageId: string
  batchId: string
  threadId: string
  itemNumber: number
} {
  const [stageId = "00", batchNumber = "0", threadNumber = "0", itemNumber = "0"] = itemId.split(".")
  return {
    stageId,
    batchId: `${stageId}.${batchNumber}`,
    threadId: `${stageId}.${batchNumber}.${threadNumber}`,
    itemNumber: Number.parseInt(itemNumber, 10) || 0,
  }
}

function deriveExecutionItemIdForThread(args: {
  threadId: string
  items: StructuredExecutionItemRecord[]
}): string {
  return args.items.find((item) => item.threadId === args.threadId)?.id ?? `${args.threadId}.01`
}

function stripCompatibilityApprovalFields(
  approval: StructuredApprovalRecord,
): StructuredApprovalRecord {
  return { ...approval }
}

function stripCompatibilityBatchStatusThreadFields(
  thread: PersistedBatchStatusThread,
): PersistedBatchStatusThread {
  const canonicalThread = { ...(thread as PersistedBatchStatusThread & { firstItemId?: string }) }
  delete canonicalThread.firstItemId
  return canonicalThread
}

function stripCompatibilityBatchStatusFields(
  batchRun: PersistedBatchStatusFile,
): PersistedBatchStatusFile {
  return {
    ...batchRun,
    threads: batchRun.threads.map(stripCompatibilityBatchStatusThreadFields),
  }
}

function ensureWorkstreamCatalogRow(database: Database, streamId: string): void {
  const existing = database.query("SELECT stream_id FROM workstreams WHERE stream_id = ? LIMIT 1").get(streamId)
  if (existing) {
    return
  }

  const now = new Date().toISOString()
  database.run(
    `INSERT INTO workstreams (
       stream_id,
       name,
       order_index,
       size,
       created_at,
       updated_at,
       storage_root,
       manual_status,
       current_batch_id,
       generated_by_json,
       session_estimated_json,
       files_json,
       planning_session_json,
       github_json,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      streamId,
      streamId,
      0,
      "short",
      now,
      now,
      `work/${streamId}`,
      null,
      null,
      "{}",
      "{}",
      null,
      null,
      null,
      jsonStringify({ inferred: true, streamId }),
    ],
  )
}

function inferHierarchy(workstreamState: StructuredStorageWorkstreamState): {
  stages: StructuredStageRecord[]
  batches: StructuredBatchRecord[]
  threads: StructuredThreadRecord[]
  items: StructuredExecutionItemRecord[]
} {
  const stages = new Map(workstreamState.hierarchy.stages.map((stage) => [stage.id, { ...stage }] as const))
  const batches = new Map(workstreamState.hierarchy.batches.map((batch) => [batch.id, { ...batch }] as const))
  const threads = new Map(workstreamState.hierarchy.threads.map((thread) => [thread.id, { ...thread }] as const))
  const items = new Map<string, StructuredExecutionItemRecord>()

  const ensureStage = (stageId: string, fallbackName?: string): void => {
    const canonicalStageId = normalizeCanonicalStageIdOrFallback(stageId)
    if (!canonicalStageId || stages.has(canonicalStageId)) return
    stages.set(canonicalStageId, {
      id: canonicalStageId,
      number: Number.parseInt(canonicalStageId, 10) || 0,
      name: fallbackName ?? `Stage ${canonicalStageId}`,
    })
  }

  const ensureBatch = (batchId: string, fallbackName?: string): void => {
    if (batches.has(batchId)) return
    const { stageId, batchNumber } = parseBatchId(batchId)
    ensureStage(stageId)
    batches.set(batchId, {
      id: batchId,
      stageId,
      number: batchNumber,
      name: fallbackName ?? `Batch ${batchId}`,
    })
  }

  const ensureThread = (threadId: string, fallbackName?: string): void => {
    if (threads.has(threadId)) return
    const { stageId, batchId, threadNumber } = parseThreadId(threadId)
    ensureBatch(batchId)
    threads.set(threadId, {
      id: threadId,
      stageId,
      batchId,
      number: threadNumber,
      name: fallbackName ?? `Thread ${threadId}`,
    })
  }

  const ensureItem = (itemId: string, updatedAt?: string): void => {
    if (items.has(itemId)) return
    const { stageId, batchId, threadId, itemNumber } = parseExecutionItemId(itemId)
    ensureThread(threadId)
    const timestamp = updatedAt ?? new Date().toISOString()
    items.set(itemId, {
      id: itemId,
      stageId,
      batchId,
      threadId,
      number: itemNumber,
      name: `Thread ${itemId}`,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
  }

  for (const batch of workstreamState.hierarchy.batches) {
    ensureStage(batch.stageId)
  }
  for (const thread of workstreamState.hierarchy.threads) {
    ensureBatch(thread.batchId)
  }
  for (const runtime of workstreamState.threadRuntime) {
    ensureThread(runtime.threadId)
    const { stageId, batchId } = parseThreadId(runtime.threadId)
    const createdAt = runtime.createdAt ?? new Date().toISOString()
    items.set(runtime.threadId, {
      id: runtime.threadId,
      stageId,
      batchId,
      threadId: runtime.threadId,
      number: 1,
      name: runtime.itemName ?? threads.get(runtime.threadId)?.name ?? runtime.threadId,
      status: runtime.status ?? "pending",
      createdAt,
      updatedAt: runtime.updatedAt ?? createdAt,
      ...(runtime.breadcrumb ? { breadcrumb: runtime.breadcrumb } : {}),
      ...(runtime.report ? { report: runtime.report } : {}),
      ...(runtime.assignedAgent ? { assignedAgent: runtime.assignedAgent } : {}),
    })
  }

  for (const batchRun of workstreamState.batchRuns) {
    ensureBatch(batchRun.batchId, batchRun.batchName)
    for (const thread of batchRun.threads) {
      ensureThread(thread.threadId, thread.threadName)
      ensureItem(thread.threadId, thread.updatedAt)
    }
  }

  for (const run of workstreamState.supervision.runs) {
    ensureStage(run.stageId)
    if (run.currentBatchId) {
      ensureBatch(run.currentBatchId)
    }
    if (run.lastReviewedBatchId) {
      ensureBatch(run.lastReviewedBatchId)
    }
  }

  const branchBatchIds = [
    ...workstreamState.supervision.branch_sessions
      .map((session) => session.batchId)
      .filter((batchId): batchId is string => typeof batchId === "string"),
    ...workstreamState.supervision.branch_sessions
      .map((session) => (session.scope?.level === "batch" ? session.scope.batchId : undefined))
      .filter((batchId): batchId is string => typeof batchId === "string"),
  ]
  for (const batchId of branchBatchIds) {
    ensureBatch(batchId)
  }

  const branchThreadIds = workstreamState.supervision.branch_sessions
    .map((session) => session.threadId)
    .filter((threadId): threadId is string => typeof threadId === "string")
  for (const threadId of branchThreadIds) {
    ensureThread(threadId)
  }

  const scopeStageIds = workstreamState.supervision.branch_sessions
    .map((session) => session.scope?.stageId)
    .filter((stageId): stageId is string => typeof stageId === "string")
  for (const stageId of scopeStageIds) {
    ensureStage(stageId)
  }

  return {
    stages: [...stages.values()].sort((left, right) => compareIds(left.id, right.id)),
    batches: [...batches.values()].sort((left, right) => compareIds(left.id, right.id)),
    threads: [...threads.values()].sort((left, right) => compareIds(left.id, right.id)),
    items: [...items.values()].sort((left, right) => compareIds(left.id, right.id)),
  }
}

function syncWorkspaceRows(database: Database, workspaceState: StructuredStorageWorkspaceState): void {
  database.run(
    `INSERT INTO workspace_state (singleton_id, current_stream_id, metadata_json)
     VALUES (1, ?, '{}')
     ON CONFLICT(singleton_id) DO UPDATE SET current_stream_id = excluded.current_stream_id`,
    [workspaceState.currentStreamId ?? null],
  )

  const upsertWorkstream = database.query(
    `INSERT INTO workstreams (
       stream_id,
       name,
       order_index,
       size,
       created_at,
       updated_at,
       storage_root,
       manual_status,
       current_batch_id,
       generated_by_json,
       session_estimated_json,
       files_json,
       planning_session_json,
       github_json,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(stream_id) DO UPDATE SET
       name = excluded.name,
       order_index = excluded.order_index,
       size = excluded.size,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       storage_root = excluded.storage_root,
       manual_status = excluded.manual_status,
       current_batch_id = excluded.current_batch_id,
       generated_by_json = excluded.generated_by_json,
       session_estimated_json = excluded.session_estimated_json,
       files_json = excluded.files_json,
       planning_session_json = excluded.planning_session_json,
       github_json = excluded.github_json,
       metadata_json = excluded.metadata_json`,
  )

  for (const workstream of workspaceState.workstreams) {
    const normalizedCurrentBatchId =
      normalizeCanonicalBatchIdOrFallback(workstream.currentBatch) ?? workstream.currentBatch ?? null
    const normalizedWorkstream = {
      ...workstream,
      ...(normalizedCurrentBatchId ? { currentBatch: normalizedCurrentBatchId } : {}),
    }

    upsertWorkstream.run(
      workstream.id,
      workstream.name,
      workstream.order,
      workstream.size,
      workstream.createdAt,
      workstream.updatedAt,
      workstream.storageRoot,
      workstream.manualStatus ?? null,
      normalizedCurrentBatchId,
      jsonStringify(workstream.generatedBy),
      jsonStringify(workstream.sessionEstimated),
      nullableJsonStringify(workstream.files),
      nullableJsonStringify(workstream.planningSession),
      nullableJsonStringify(workstream.github),
      jsonStringify(normalizedWorkstream),
    )
  }

  deleteRemovedWorkstreams(
    database,
    workspaceState.workstreams.map((workstream) => workstream.id),
  )
}

function clearWorkstreamRows(database: Database, streamId: string): void {
  database.run("DELETE FROM supervision_sessions WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM batch_run_threads WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM thread_sessions WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM supervision_runs WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM supervision_state WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM batch_runs WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM approvals WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM execution_items WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM threads WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM batches WHERE stream_id = ?", [streamId])
  database.run("DELETE FROM stages WHERE stream_id = ?", [streamId])
}

function insertStages(database: Database, streamId: string, stages: StructuredStageRecord[]): void {
  const insertStage = database.query(
    `INSERT INTO stages (stream_id, stage_id, stage_number, name, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
  )

  for (const stage of stages) {
    insertStage.run(streamId, stage.id, stage.number, stage.name, jsonStringify(stage))
  }
}

function insertBatches(database: Database, streamId: string, batches: StructuredBatchRecord[]): void {
  const insertBatch = database.query(
    `INSERT INTO batches (stream_id, batch_id, stage_id, batch_number, name, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  for (const batch of batches) {
    insertBatch.run(streamId, batch.id, batch.stageId, batch.number, batch.name, jsonStringify(batch))
  }
}

function insertThreads(
  database: Database,
  streamId: string,
  threads: StructuredThreadRecord[],
  runtimeByThreadId: Map<string, StructuredThreadRuntimeRecord>,
): void {
  const insertThread = database.query(
    `INSERT INTO threads (
       stream_id,
       thread_id,
       stage_id,
       batch_id,
       thread_number,
       name,
       prompt_path,
       current_session_id,
       opencode_session_id,
       working_agent_session_id,
       synthesis_output,
       synthesis_json,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const thread of threads) {
    const runtime = runtimeByThreadId.get(thread.id)
    insertThread.run(
      streamId,
      thread.id,
      thread.stageId,
      thread.batchId,
      thread.number,
      thread.name,
      thread.promptPath ?? null,
      runtime?.currentSessionId ?? null,
      runtime?.opencodeSessionId ?? null,
      runtime?.workingAgentSessionId ?? null,
      runtime?.synthesisOutput ?? null,
      nullableJsonStringify(runtime?.synthesis),
      jsonStringify({
        id: thread.id,
        stageId: thread.stageId,
        batchId: thread.batchId,
        number: thread.number,
        name: thread.name,
        ...(thread.promptPath ? { promptPath: thread.promptPath } : {}),
        ...(runtime
          ? {
              hasRuntimeMetadata: true,
              status: runtime.status,
              createdAt: runtime.createdAt,
              updatedAt: runtime.updatedAt,
              itemName: runtime.itemName,
              breadcrumb: runtime.breadcrumb,
              report: runtime.report,
              assignedAgent: runtime.assignedAgent,
              currentSessionId: runtime.currentSessionId,
              opencodeSessionId: runtime.opencodeSessionId,
              workingAgentSessionId: runtime.workingAgentSessionId,
              synthesisOutput: runtime.synthesisOutput,
              synthesis: runtime.synthesis,
            }
          : {}),
      }),
    )
  }
}

function insertExecutionItems(database: Database, streamId: string, items: StructuredExecutionItemRecord[]): void {
  const insertItem = database.query(
    `INSERT INTO execution_items (
       stream_id,
       item_id,
       stage_id,
       batch_id,
       thread_id,
       item_number,
       name,
       status,
       created_at,
       updated_at,
       breadcrumb,
       report,
       assigned_agent,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const item of items) {
    insertItem.run(
      streamId,
      item.id,
      item.stageId,
      item.batchId,
      item.threadId,
      item.number,
      item.name,
      item.status ?? "pending",
      item.createdAt,
      item.updatedAt,
      item.breadcrumb ?? null,
      item.report ?? null,
      item.assignedAgent ?? null,
      jsonStringify(item),
    )
  }
}

function insertApprovals(database: Database, streamId: string, approvals: StructuredApprovalRecord[]): void {
  const insertApproval = database.query(
    `INSERT INTO approvals (
       stream_id,
       approval_key,
       scope,
       stage_id,
       status,
       approved_at,
       approved_by,
       revoked_at,
       revoked_reason,
       plan_hash,
       commit_sha,
       metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const approval of approvals) {
    const normalizedStageId =
      normalizeCanonicalStageIdOrFallback(approval.stageId) ?? approval.stageId ?? null

    insertApproval.run(
      streamId,
      approvalKey(approval),
      approval.scope,
      normalizedStageId,
      approval.status,
      approval.approvedAt ?? null,
      approval.approvedBy ?? null,
      approval.revokedAt ?? null,
      approval.revokedReason ?? null,
      approval.planHash ?? null,
      approval.commitSha ?? null,
      jsonStringify(
        stripCompatibilityApprovalFields({
          ...approval,
          ...(normalizedStageId ? { stageId: normalizedStageId } : {}),
        }),
      ),
    )
  }
}

function filterApprovalsForPersistedHierarchy(
  approvals: StructuredApprovalRecord[],
  stages: StructuredStageRecord[],
): StructuredApprovalRecord[] {
  const validStageIds = new Set(stages.map((stage) => stage.id))

  return approvals.filter((approval) => {
    if (!approval.stageId) {
      return true
    }

    const normalizedStageId = normalizeCanonicalStageIdOrFallback(approval.stageId) ?? approval.stageId
    return validStageIds.has(normalizedStageId)
  })
}

function insertThreadSessions(
  database: Database,
  streamId: string,
  threadId: string,
  sessions: SessionRecord[],
): void {
  const insertSession = database.query(
    `INSERT INTO thread_sessions (
       stream_id,
       thread_id,
       session_id,
       agent_name,
       model,
       started_at,
       completed_at,
       status,
       exit_code,
       lineage_json,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const session of sessions) {
    insertSession.run(
      streamId,
      threadId,
      session.sessionId,
      session.agentName,
      session.model,
      session.startedAt ?? new Date().toISOString(),
      session.completedAt ?? null,
      session.status,
      session.exitCode ?? null,
      nullableJsonStringify(session.lineage),
      jsonStringify(session),
    )
  }
}

function insertThreadRuntime(
  database: Database,
  streamId: string,
  threadRuntime: StructuredThreadRuntimeRecord[],
): void {
  for (const runtime of threadRuntime) {
    insertThreadSessions(database, streamId, runtime.threadId, runtime.sessions)
  }
}

function insertBatchRunThreads(
  database: Database,
  streamId: string,
  runId: string,
  threads: PersistedBatchStatusThread[],
  hierarchyItems: StructuredExecutionItemRecord[],
): void {
  const insertThread = database.query(
    `INSERT INTO batch_run_threads (
       stream_id,
       run_id,
       thread_id,
       first_item_id,
       thread_name,
       status,
       started_at,
       updated_at,
       completed_at,
       marker_detected_at,
       current_session_id,
       opencode_session_id,
       working_agent_session_id,
       synthesis_updated_at,
       recovery_note,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const thread of threads) {
    insertThread.run(
      streamId,
      runId,
      thread.threadId,
      deriveExecutionItemIdForThread({ threadId: thread.threadId, items: hierarchyItems }),
      thread.threadName,
      thread.status,
      thread.startedAt ?? null,
      thread.updatedAt,
      thread.completedAt ?? null,
      thread.markerDetectedAt ?? null,
      thread.currentSessionId ?? null,
      thread.opencodeSessionId ?? null,
      thread.workingAgentSessionId ?? null,
      thread.synthesisUpdatedAt ?? null,
      thread.recoveryNote ?? null,
      jsonStringify(stripCompatibilityBatchStatusThreadFields(thread)),
    )
  }
}

function insertBatchRuns(
  database: Database,
  streamId: string,
  batchRuns: PersistedBatchStatusFile[],
  hierarchyItems: StructuredExecutionItemRecord[],
): void {
  const insertBatchRun = database.query(
    `INSERT INTO batch_runs (
       stream_id,
       run_id,
       batch_id,
       tmux_session_name,
       mode,
       status,
       stage_name,
       batch_name,
       started_at,
       updated_at,
       completed_at,
       summary_json,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const batchRun of batchRuns) {
    insertBatchRun.run(
      streamId,
      batchRun.runId,
      batchRun.batchId,
      batchRun.tmuxSessionName ?? null,
      batchRun.mode,
      batchRun.status,
      batchRun.stageName ?? null,
      batchRun.batchName ?? null,
      batchRun.startedAt,
      batchRun.updatedAt,
      batchRun.completedAt ?? null,
      jsonStringify(batchRun.summary),
      jsonStringify(stripCompatibilityBatchStatusFields(batchRun)),
    )
    insertBatchRunThreads(database, streamId, batchRun.runId, batchRun.threads, hierarchyItems)
  }
}

function insertSupervisionRuns(
  database: Database,
  streamId: string,
  runs: SupervisorRunState[],
): void {
  const insertRun = database.query(
    `INSERT INTO supervision_runs (
       stream_id,
       run_id,
       stage_id,
       status,
       started_at,
       updated_at,
       completed_at,
       current_batch_id,
       last_reviewed_batch_id,
       review_passes,
       issue_summary_ids_json,
       escalation_ids_json,
       root_session_id,
       branch_session_id,
       stage_stop_id,
       stop_reason,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const run of runs) {
    insertRun.run(
      streamId,
      run.runId,
      run.stageId,
      run.status,
      run.startedAt,
      run.updatedAt,
      run.completedAt ?? null,
      run.currentBatchId ?? null,
      run.lastReviewedBatchId ?? null,
      run.reviewPasses,
      jsonStringify(run.issueSummaryIds),
      jsonStringify(run.escalationIds),
      run.rootSessionId ?? null,
      run.branchSessionId ?? null,
      run.stageStopId ?? null,
      run.stopReason ?? null,
      jsonStringify(run),
    )
  }
}

function insertSupervisionSessions(
  database: Database,
  streamId: string,
  sessions: RootAgentBranchSession[],
  availableRunIds: Set<string>,
  availableBatchIds: Set<string>,
  availableThreadIds: Set<string>,
): void {
  const insertSession = database.query(
    `INSERT INTO supervision_sessions (
       stream_id,
       branch_session_id,
       owner,
       root_session_id,
       branch_role,
       source,
       status,
       started_at,
       updated_at,
       completed_at,
       process_ended_at,
       process_exit_code,
       finalization_source,
       finalization_reason,
       native_session_id,
       tmux_session_name,
       run_id,
       batch_id,
       thread_id,
       review_id,
       fix_cycle_id,
       scope_json,
       breakpoint_selection_json,
       supervision_progress_json,
       notes,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (const session of sessions) {
    const runId = session.runId && availableRunIds.has(session.runId) ? session.runId : null
    const batchId = session.batchId && availableBatchIds.has(session.batchId) ? session.batchId : null
    const threadId = session.threadId && availableThreadIds.has(session.threadId) ? session.threadId : null

    insertSession.run(
      streamId,
      session.branchSessionId,
      session.owner,
      session.rootSessionId,
      session.branchRole,
      session.source,
      session.status,
      session.startedAt,
      session.updatedAt,
      session.completedAt ?? null,
      session.processEndedAt ?? null,
      session.processExitCode ?? null,
      session.finalizationSource ?? null,
      session.finalizationReason ?? null,
      session.nativeSessionId ?? null,
      session.tmuxSessionName ?? null,
      runId,
      batchId,
      threadId,
      session.reviewId ?? null,
      session.fixCycleId ?? null,
      nullableJsonStringify(session.scope),
      nullableJsonStringify(session.breakpointSelection),
      nullableJsonStringify(session.supervisionProgress),
      session.notes ?? null,
      jsonStringify(session),
    )
  }
}

function syncWorkstreamRows(
  database: Database,
  workstreamState: StructuredStorageWorkstreamState,
): void {
  ensureWorkstreamCatalogRow(database, workstreamState.streamId)
  const inferredHierarchy = inferHierarchy(workstreamState)
  const persistedApprovals = filterApprovalsForPersistedHierarchy(
    workstreamState.approvals,
    inferredHierarchy.stages,
  )
  clearWorkstreamRows(database, workstreamState.streamId)
  insertStages(database, workstreamState.streamId, inferredHierarchy.stages)
  insertBatches(database, workstreamState.streamId, inferredHierarchy.batches)
  insertThreads(
    database,
    workstreamState.streamId,
    inferredHierarchy.threads,
    new Map(workstreamState.threadRuntime.map((record) => [record.threadId, record] as const)),
  )
  insertExecutionItems(database, workstreamState.streamId, inferredHierarchy.items)
  insertApprovals(database, workstreamState.streamId, persistedApprovals)
  insertThreadRuntime(database, workstreamState.streamId, workstreamState.threadRuntime)
  insertBatchRuns(
    database,
    workstreamState.streamId,
    workstreamState.batchRuns,
    inferredHierarchy.items,
  )

  database.run(
    `INSERT INTO supervision_state (
       stream_id,
       active_run_id,
       current_branch_supervision_json,
       checkpoint_pointers_json,
       reviewed_batches_json,
       issue_summaries_json,
       fix_cycles_json,
       escalations_json,
       stage_stops_json,
       metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workstreamState.streamId,
      workstreamState.supervision.active_run_id ?? null,
      nullableJsonStringify(workstreamState.supervision.current_branch_supervision),
      jsonStringify(workstreamState.supervision.checkpoint_pointers),
      jsonStringify(workstreamState.supervision.reviewed_batches),
      jsonStringify(workstreamState.supervision.issue_summaries),
      jsonStringify(workstreamState.supervision.fix_cycles),
      jsonStringify(workstreamState.supervision.escalations),
      jsonStringify(workstreamState.supervision.stage_stops),
      jsonStringify(workstreamState.supervision),
    ],
  )
  insertSupervisionRuns(database, workstreamState.streamId, workstreamState.supervision.runs)
  insertSupervisionSessions(
    database,
    workstreamState.streamId,
    workstreamState.supervision.branch_sessions,
    new Set(workstreamState.supervision.runs.map((run) => run.runId)),
    new Set(inferredHierarchy.batches.map((batch) => batch.id)),
    new Set(inferredHierarchy.threads.map((thread) => thread.id)),
  )
}

export function syncStructuredStorageWorkspaceStateToSqlite(
  repoRoot: string,
  workspaceState: StructuredStorageWorkspaceState,
): void {
  const database = openSqliteStructuredStorageDatabase(repoRoot)

  try {
    const transaction = database.transaction((state: StructuredStorageWorkspaceState) => {
      syncWorkspaceRows(database, state)
    })
    transaction.immediate(workspaceState)
  } finally {
    database.close()
  }
}

export function syncStructuredStorageWorkstreamStateToSqlite(
  repoRoot: string,
  workstreamState: StructuredStorageWorkstreamState,
): void {
  const database = openSqliteStructuredStorageDatabase(repoRoot)

  try {
    const transaction = database.transaction((state: StructuredStorageWorkstreamState) => {
      syncWorkstreamRows(database, state)
    })
    transaction.immediate(workstreamState)
  } finally {
    database.close()
  }
}

function loadSqliteStructuredStorageWorkstreamStateFromDatabase(
  database: Database,
  streamId: string,
  options?: { normalizeIds?: boolean },
): StructuredStorageWorkstreamState | null {
  const shouldNormalizeIds = options?.normalizeIds !== false
  const stages = database
    .query<{ metadata_json: string }, [string]>(
      "SELECT metadata_json FROM stages WHERE stream_id = ? ORDER BY stage_number, stage_id",
    )
    .all(streamId)
    .map((row) => parseMetadataJson<StructuredStageRecord>(row.metadata_json, "stages"))

  const batches = database
    .query<{ metadata_json: string }, [string]>(
      "SELECT metadata_json FROM batches WHERE stream_id = ? ORDER BY stage_id, batch_number, batch_id",
    )
    .all(streamId)
    .map((row) => parseMetadataJson<StructuredBatchRecord>(row.metadata_json, "batches"))

  const itemRows = database
    .query<{ metadata_json: string }, [string]>(
      "SELECT metadata_json FROM execution_items WHERE stream_id = ? ORDER BY item_id",
    )
    .all(streamId)
  const items = itemRows
    .map((row) => parseMetadataJson<StructuredExecutionItemRecord>(row.metadata_json, "execution_items"))
    .sort((left, right) => compareIds(left.id, right.id))

  const approvalRows = database
    .query<{ metadata_json: string }, [string]>(
      "SELECT metadata_json FROM approvals WHERE stream_id = ? ORDER BY scope, stage_id",
    )
    .all(streamId)
  const approvals = approvalRows
    .map((row) =>
      stripCompatibilityApprovalFields(
        parseMetadataJson<StructuredApprovalRecord>(row.metadata_json, "approvals"),
      ),
    )
    .sort((left, right) => {
      const scopeOrder = APPROVAL_SCOPE_ORDER[left.scope] - APPROVAL_SCOPE_ORDER[right.scope]
      if (scopeOrder !== 0) return scopeOrder
      return compareOptionalIds(left.stageId, right.stageId)
    })

  const threadRows = database
    .query<{ thread_id: string; metadata_json: string }, [string]>(
      "SELECT thread_id, metadata_json FROM threads WHERE stream_id = ? ORDER BY thread_id",
    )
    .all(streamId)
  const sessionRows = database
    .query<{ thread_id: string; metadata_json: string }, [string]>(
      "SELECT thread_id, metadata_json FROM thread_sessions WHERE stream_id = ? ORDER BY thread_id, started_at, session_id",
    )
    .all(streamId)

  const sessionsByThreadId = new Map<string, SessionRecord[]>()
  for (const row of sessionRows) {
    const session = parseMetadataJson<SessionRecord>(
      row.metadata_json,
      `thread_sessions(thread=${row.thread_id})`,
    )
    const sessions = sessionsByThreadId.get(row.thread_id)
    if (sessions) {
      sessions.push(session)
    } else {
      sessionsByThreadId.set(row.thread_id, [session])
    }
  }

  const threads = threadRows
    .map((row) => {
      const metadata = parseMetadataJson<SqliteThreadMetadataJson>(
        row.metadata_json,
        `threads(thread=${row.thread_id})`,
      )
      return {
        id: shouldNormalizeIds
          ? normalizeCanonicalThreadIdOrFallback(metadata.id) ?? metadata.id
          : metadata.id,
        stageId: normalizeCanonicalStageIdOrFallback(metadata.stageId) ?? metadata.stageId,
        batchId: normalizeCanonicalBatchIdOrFallback(metadata.batchId) ?? metadata.batchId,
        number: metadata.number,
        name: metadata.name,
        ...(metadata.promptPath ? { promptPath: metadata.promptPath } : {}),
      } satisfies StructuredThreadRecord
    })
    .sort((left, right) => compareIds(left.id, right.id))

    const threadRuntime = threadRows
      .map((row) => {
        const metadata = parseMetadataJson<SqliteThreadMetadataJson>(
          row.metadata_json,
          `threads(thread=${row.thread_id})`,
        )
        const sessions = (sessionsByThreadId.get(row.thread_id) ?? [])
        .map((session) => (shouldNormalizeIds ? normalizeSessionRecord(session) : session))
        .sort((left, right) => {
          const startedAtOrder = compareOptionalIds(left.startedAt, right.startedAt)
          if (startedAtOrder !== 0) return startedAtOrder
          return compareIds(left.sessionId, right.sessionId)
        })

        if (
          sessions.length === 0 &&
          !metadata.currentSessionId &&
          !metadata.opencodeSessionId &&
          !metadata.workingAgentSessionId &&
          !metadata.synthesisOutput &&
          !metadata.synthesis &&
          !metadata.promptPath &&
          !metadata.hasRuntimeMetadata
        ) {
          return null
        }

        const runtimeRecord = {
          threadId: shouldNormalizeIds
            ? normalizeCanonicalThreadIdOrFallback(metadata.id) ?? metadata.id
            : metadata.id,
          sessions,
          ...(metadata.status ? { status: metadata.status } : {}),
          ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
          ...(metadata.updatedAt ? { updatedAt: metadata.updatedAt } : {}),
          ...(metadata.itemName ? { itemName: metadata.itemName } : {}),
          ...(metadata.breadcrumb ? { breadcrumb: metadata.breadcrumb } : {}),
          ...(metadata.report ? { report: metadata.report } : {}),
          ...(metadata.assignedAgent ? { assignedAgent: metadata.assignedAgent } : {}),
          ...(metadata.currentSessionId ? { currentSessionId: metadata.currentSessionId } : {}),
          ...(metadata.opencodeSessionId ? { opencodeSessionId: metadata.opencodeSessionId } : {}),
          ...(metadata.workingAgentSessionId
            ? { workingAgentSessionId: metadata.workingAgentSessionId }
            : {}),
          ...(metadata.synthesisOutput ? { synthesisOutput: metadata.synthesisOutput } : {}),
          ...(metadata.synthesis ? { synthesis: { ...metadata.synthesis } } : {}),
        } satisfies StructuredThreadRuntimeRecord

        return shouldNormalizeIds
          ? normalizePersistedThreadMetadata(runtimeRecord)
          : runtimeRecord
      })
      .filter((record): record is StructuredThreadRuntimeRecord => record !== null)
      .sort((left, right) => compareIds(left.threadId, right.threadId))

  const batchRunRows = database
    .query<{ metadata_json: string }, [string]>(
      "SELECT metadata_json FROM batch_runs WHERE stream_id = ? ORDER BY batch_id, run_id",
    )
    .all(streamId)
  const batchRuns = batchRunRows
    .map((row) => {
      const batchRun = stripCompatibilityBatchStatusFields(
        parseMetadataJson<PersistedBatchStatusFile>(row.metadata_json, "batch_runs"),
      )
      return shouldNormalizeIds ? normalizePersistedBatchStatus(batchRun) : batchRun
    })
    .sort((left, right) => {
      const batchOrder = compareIds(left.batchId, right.batchId)
      if (batchOrder !== 0) return batchOrder
      return compareIds(left.runId, right.runId)
    })
    .map((batchRun) => ({
      ...batchRun,
      summary: { ...batchRun.summary },
      threads: [...batchRun.threads].sort((left, right) => compareIds(left.threadId, right.threadId)),
    }))

  const supervisionStateRow = database
    .query<{ metadata_json: string }, [string]>(
      "SELECT metadata_json FROM supervision_state WHERE stream_id = ? LIMIT 1",
    )
    .get(streamId)
  const supervision = (() => {
    if (!supervisionStateRow) {
      return createEmptySupervisorState(streamId)
    }

    const parsed = parseMetadataJson<SupervisorStateFile>(
      supervisionStateRow.metadata_json,
      "supervision_state",
    )
    const normalized =
      options?.normalizeIds === false
        ? {
            ...createEmptySupervisorState(streamId),
            ...parsed,
            runs: parsed.runs ?? [],
            checkpoint_pointers: parsed.checkpoint_pointers ?? [],
            branch_sessions: parsed.branch_sessions ?? [],
            ...(parsed.current_branch_supervision
              ? { current_branch_supervision: parsed.current_branch_supervision }
              : {}),
            reviewed_batches: parsed.reviewed_batches ?? [],
            issue_summaries: parsed.issue_summaries ?? [],
            fix_cycles: parsed.fix_cycles ?? [],
            escalations: parsed.escalations ?? [],
            stage_stops: parsed.stage_stops ?? [],
          }
        : normalizeLoadedSupervisorState(streamId, parsed)

    return {
      ...createEmptySupervisorState(streamId),
      ...normalized,
    }
  })()

  if (
    stages.length === 0 &&
    batches.length === 0 &&
    threads.length === 0 &&
    approvals.length === 0 &&
    threadRuntime.length === 0 &&
    batchRuns.length === 0 &&
    supervision.runs.length === 0 &&
    supervision.branch_sessions.length === 0 &&
    !supervision.active_run_id &&
    !supervision.current_branch_supervision
  ) {
    return null
  }

  const workstreamState = createEmptyWorkstreamState(streamId)
  workstreamState.hierarchy = { stages, batches, threads }
  workstreamState.approvals = approvals
  workstreamState.threadRuntime = threadRuntime
  workstreamState.batchRuns = batchRuns
  workstreamState.supervision = supervision
  return workstreamState
}

export function modifySqliteStructuredStorageWorkstreamState<T>(args: {
  repoRoot: string
  streamId: string
  baseState?: StructuredStorageWorkstreamState
  preferBaseState?: boolean
  fn: (workstreamState: StructuredStorageWorkstreamState) => T
}): { result: T; workstreamState: StructuredStorageWorkstreamState } {
  const database = openSqliteStructuredStorageDatabase(args.repoRoot)

  try {
    const transaction = database.transaction(() => {
      const persistedState = loadSqliteStructuredStorageWorkstreamStateFromDatabase(database, args.streamId)
      const currentState =
        (args.preferBaseState
          ? args.baseState ?? persistedState
          : persistedState ?? args.baseState) ?? createEmptyWorkstreamState(args.streamId)
      const mutableState = structuredClone(currentState) as StructuredStorageWorkstreamState
      const result = args.fn(mutableState)
      syncWorkstreamRows(database, mutableState)
      return {
        result,
        workstreamState: structuredClone(mutableState) as StructuredStorageWorkstreamState,
      }
    })

    return transaction.immediate()
  } finally {
    database.close()
  }
}

export function loadSqliteStructuredStorageWorkstreamState(
  repoRoot: string,
  streamId: string,
  options?: { normalizeIds?: boolean },
): StructuredStorageWorkstreamState | null {
  const databasePath = getSqliteStructuredStoragePath(repoRoot)
  if (!existsSync(databasePath)) {
    return null
  }

  const database = openSqliteStructuredStorageDatabase(repoRoot)

  try {
    return loadSqliteStructuredStorageWorkstreamStateFromDatabase(database, streamId, options)
  } finally {
    database.close()
  }
}
