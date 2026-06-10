/**
 * Types for workstream generation, management, and implementation tracking
 *
 * ## Execution Model
 *
 * Workstreams follow a strict sequential execution model with one exception:
 *
 * | Unit     | Parallel? | Notes                                           |
 * |----------|-----------|------------------------------------------------|
 * | Stages   | ❌ No     | Must complete in order (Stage N blocks N+1)    |
 * | Batches  | ❌ No     | Within a stage, batches are sequential         |
 * | Threads  | ✅ Yes    | Within a batch, threads can run in parallel     |
 * | Steps    | ❌ No     | Within a thread, execution steps are sequential |
 *
 * This model allows parallelization of independent work (threads) while
 * maintaining clear dependencies between phases (stages and batches).
 *
 * ### Why Sequential Stages?
 * Each stage typically produces outputs required by subsequent stages.
 * For example, a "Setup" stage must complete before "Implementation" can begin.
 *
 * ### Why Parallel Threads?
 * Threads represent independent work units that don't depend on each other.
 * Multiple agents can work on different threads simultaneously.
 */

// Stream size categories
export type StreamSize = "short" | "medium" | "long"

// Session estimate at time of stream creation
export interface SessionEstimate {
  length: number // estimated number of sessions
  unit: "session"
  session_minutes: [number, number] // [min, max] e.g., [30, 45]
  session_iterations: [number, number] // [min, max] e.g., [4, 8]
}

// Default session estimates by stream size
export const DEFAULT_SESSION_ESTIMATES: Record<StreamSize, SessionEstimate> = {
  short: {
    length: 2,
    unit: "session",
    session_minutes: [30, 45],
    session_iterations: [4, 8],
  },
  medium: {
    length: 4,
    unit: "session",
    session_minutes: [30, 45],
    session_iterations: [4, 8],
  },
  long: {
    length: 8,
    unit: "session",
    session_minutes: [30, 45],
    session_iterations: [4, 8],
  },
}

// Default structure by stream size
export const DEFAULT_STRUCTURE: Record<
  StreamSize,
  { stages: number; supertasks: number; subtasks: number }
> = {
  short: { stages: 1, supertasks: 1, subtasks: 3 },
  medium: { stages: 3, supertasks: 2, subtasks: 3 },
  long: { stages: 4, supertasks: 3, subtasks: 4 },
}

/**
 * Maximum threads per batch for the 2x2 grid TUI
 *
 * The `work multi` command displays threads in a 2x2 grid layout.
 * With pagination, we support 2 pages of 4 threads each = 8 max.
 * Batches with more threads should be split into multiple batches.
 */
export const MAX_THREADS_PER_BATCH = 8

// Version info for generated workstreams
export interface GeneratedBy {
  workstreams: string // @agenv/workstreams version
}

// Planning session metadata
export interface PlanningSession {
  sessionId: string
  createdAt: string
}

// Individual workstream metadata
export interface StreamMetadata {
  id: string // e.g., "001-migrate-sql-to-orm"
  name: string // e.g., "migrate-sql-to-orm"
  order: number // e.g., 1
  status?: StreamStatus // computed from execution state or manually set (default: pending)
  approval?: ApprovalMetadata // HITL approval gate status (default: draft)
  size: StreamSize
  session_estimated: SessionEstimate
  created_at: string // ISO date
  updated_at: string // ISO date
  path: string // relative path from repo root
  generated_by: GeneratedBy // versions of tools that created this workstream
  files?: string[] // list of file names in the files/ directory
  current_batch?: string // ID of the current batch (e.g. "01.01")
  planningSession?: PlanningSession // planning session metadata
  github?: {
    branch?: string
    completed_at?: string
    pr_number?: number
  }
}

// The index.json structure
export interface WorkIndex {
  version: string
  last_updated: string
  current_stream?: string // ID of the currently active workstream
  streams: StreamMetadata[]
}

// Checklist data structures
export interface SubItem {
  id: string
  description: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  notes?: string
}

export interface SuperItem {
  id: string
  title: string
  description: string
  subitems: SubItem[]
}

export interface Stage {
  id: string
  number: number
  title: string
  description: string
  superitems: SuperItem[]
}

// Template input for checklist generation
export interface ChecklistTemplateInput {
  stream_name: string
  stream_size: StreamSize
  stages?: {
    title: string
    description: string
    supertasks: {
      title: string
      description: string
      subtasks: string[]
    }[]
  }[]
}

// Template placeholders
export interface TemplatePlaceholders {
  STREAM_NAME: string
  STREAM_SIZE: StreamSize
  CREATED_DATE: string
  STAGE_NUMBER?: number
  STAGE_TITLE?: string
  STAGE_DESCRIPTION?: string
}

// Execution status used by runtime state and checklist-derived items.
export type ExecutionStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "cancelled"

// Stream status - computed from execution state or manually set
export type StreamStatus =
  | "pending" // No items started (default)
  | "in_progress" // Has items in progress
  | "completed" // All items completed
  | "on_hold" // Manually paused, won't work on for now

// Approval status for HITL gate
export type ApprovalStatus = "draft" | "approved" | "revoked"

/**
 * Approval metadata for human-in-the-loop gate
 * Workstreams require 2 approvals before starting:
 * 1. Plan approval (PLAN.md structure is correct)
 * 2. Execution approval (canonical thread/stage/batch hierarchy exists)
 */
export interface ApprovalMetadata {
  status: ApprovalStatus
  approved_at?: string // ISO date when approved
  approved_by?: string // Optional: who approved (e.g., "user", "ci", agent name)
  revoked_at?: string // ISO date when revoked (if status changed after approval)
  revoked_reason?: string // Optional: why it was revoked
  plan_hash?: string // SHA-256 hash of PLAN.md at approval time for modification detection
  stages?: Record<
    number,
    {
      status: ApprovalStatus
      approved_at?: string
      approved_by?: string
      revoked_at?: string
      revoked_reason?: string
      commit_sha?: string // SHA of the auto-commit created on stage approval
    }
  >
}

// Stage status summary
export type StageStatus = "pending" | "in_progress" | "complete" | "blocked"

// Parsed execution item from canonical status data
export interface ParsedExecutionItem {
  id: string // e.g., "01.02.03" for stage 1, batch 2, thread 3
  description: string
  status: ExecutionStatus
  stageNumber?: number
  batchNumber?: number
  threadNumber: number
  itemNumber: number // legacy field; thread records use 1
  lineNumber: number // for editing
}

/**
 * Parsed thread from stream planning markdown
 * Captures thread metadata including optional agent assignment
 */
export interface ParsedThread {
  id: number // Thread number within batch
  name: string
  assigned_agent?: string // Agent name extracted from @agent:name syntax
}

/**
 * Result of parsing stream planning markdown
 * Includes execution items, thread-level agent assignments, and any parse errors
 */
export interface StreamPlanParseResult {
  items: ExecutionItem[]
  threads: ParsedThread[] // Thread metadata with agent assignments
  errors: string[]
}

// Parsed stage from checklist
export interface ParsedStage {
  number: number
  title: string
  status: StageStatus
  items: ParsedExecutionItem[]
  file: string // which file contains this stage
}

// Workstream progress summary
export interface StreamProgress {
  streamId: string
  streamName: string
  size: StreamSize
  stages: ParsedStage[]
  totalItems: number
  completedItems: number
  inProgressItems: number
  blockedItems: number
  pendingItems: number
  percentComplete: number
  runtimeSummary?: WorkstreamRuntimeSummary
}

export interface ExecutionStatusCounts {
  total: number
  pending: number
  in_progress: number
  completed: number
  blocked: number
  cancelled: number
  done: number
}

export interface WorkstreamStatusCompletionMetrics {
  total_items: number
  completed_items: number
  cancelled_items: number
  done_items: number
  remaining_items: number
  percent_complete: number
  percent_done: number
}

export interface WorkstreamStatusStageSummary {
  number: number
  stage_id: string
  title: string
  status: StageStatus
  counts: ExecutionStatusCounts
  completion: WorkstreamStatusCompletionMetrics
  items: ParsedExecutionItem[]
}

export interface WorkstreamStatusRuntimeBatchEntry {
  kind: "batch"
  batch_id: string
  execution_status: ExecutionStatus
  runtime_status: RuntimeBatchStatus
  entry_status: "runtime" | "desync"
  summary: WorkstreamRuntimeBatchSummary
}

export interface WorkstreamStatusRuntimeSupervisionEntry {
  kind: "supervision"
  target: string
  stage_id: string
  batch_id?: string
  execution_status?: ExecutionStatus
  is_mismatched_with_execution: boolean
  summary: WorkstreamRuntimeSupervisorRunSummary
}

export interface WorkstreamStatusRuntimeBranchEntry {
  kind: "supervision_branch"
  target: string
  stage_id?: string
  batch_id?: string
  execution_status?: ExecutionStatus
  is_mismatched_with_execution: boolean
  summary: WorkstreamRuntimeBranchSupervisionSummary
}

export type WorkstreamStatusRuntimeEntry =
  | WorkstreamStatusRuntimeBatchEntry
  | WorkstreamStatusRuntimeSupervisionEntry
  | WorkstreamStatusRuntimeBranchEntry

export interface WorkstreamStatusRuntimeSummaryProjection {
  summary: WorkstreamRuntimeSummary
  entries: WorkstreamStatusRuntimeEntry[]
}

export interface WorkstreamStatusStreamMetadata {
  id: string
  name: string
  order: number
  size: StreamSize
  path: string
  created_at: string
  updated_at: string
  generated_by: GeneratedBy
  manual_status?: StreamStatus
  current_batch?: string
  is_current: boolean
  files?: string[]
  planning_session?: PlanningSession
  github?: StreamMetadata["github"]
}

export interface WorkstreamStatusSnapshot {
  stream: WorkstreamStatusStreamMetadata
  aggregate_status: StreamStatus
  counts: ExecutionStatusCounts
  completion: WorkstreamStatusCompletionMetrics
  stages: WorkstreamStatusStageSummary[]
  runtime?: WorkstreamStatusRuntimeSummaryProjection
}

// Complete workstream command options
export interface CompleteStreamOptions {
  streamId: string
}

// ============================================
// Execution hierarchy and runtime envelope types
// ============================================

/**
 * Constitution definition - the "how" of a stage
 *
 * Free-form markdown description of how the stage operates.
 */
export type ConstitutionDefinition = string

/**
 * Stage question - an unknown or research to-do
 */
export interface StageQuestion {
  question: string
  resolved: boolean
  resolution?: string
}

/**
 * Thread definition - a parallelizable work unit within a batch.
 * Each thread can contain multiple execution items.
 */
export interface ThreadDefinition {
  id: number // Thread number within batch (1, 2, 3...)
  name: string
  summary: string // Short description of the thread
  details: string // Any content - implementation notes, dependencies, goals, etc.
}

/**
 * Batch definition - an ordered group of threads within a stage
 * Batches use numeric prefixes for ordering (01, 02...)
 * Common patterns: 01-implementation, 02-testing
 */
export interface BatchDefinition {
  id: number // Batch number within stage (0, 1, 2...)
  prefix: string // Numeric prefix string (e.g., "01")
  name: string // Batch name (e.g., "setup", "implementation")
  summary: string // Short description of the batch
  threads: ThreadDefinition[]
}

/**
 * Stage definition - parsed from PLAN.md
 */
export interface StageDefinition {
  id: number // Stage number (1, 2, 3...)
  name: string
  definition: string // The "what" - what this stage accomplishes
  constitution: ConstitutionDefinition // The "how"
  questions: StageQuestion[]
  batches: BatchDefinition[] // Ordered groups of threads within this stage
}

/**
 * Stream document - the full PLAN.md structure
 */
export interface StreamDocument {
  streamName: string
  summary: string
  references: string[]
  stages: StageDefinition[]
}

/**
 * Canonical execution item.
 * Execution now operates directly on thread records, so the canonical ID
 * matches the thread ID: "{stage}.{batch}.{thread}" (e.g., "01.01.02").
 */
export interface ExecutionItem {
  id: string // e.g., "01.01.02" = stage 1, batch 1, thread 2
  threadId: string
  stageId: string
  batchId: string
  number: number
  name: string
  threadName: string
  batchName: string
  stageName: string
  createdAt: string
  updatedAt: string
  status: ExecutionStatus
  breadcrumb?: string
  report?: string
  assignedAgent?: string
}

export type RuntimeBatchStatus = "pending" | "running" | "completed" | "failed"

export type RuntimeSupervisorStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"
  | "escalated"

export type RuntimeBranchSupervisionStatus = "pending" | "running" | "stopped"

export interface WorkstreamRuntimeBatchSummary {
  batch_id: string
  run_id: string
  status: RuntimeBatchStatus
  updated_at: string
  started_at: string
  completed_at?: string
  stage_name?: string
  batch_name?: string
  thread_summary: {
    total: number
    pending: number
    running: number
    completed: number
    failed: number
  }
}

export interface WorkstreamRuntimeSupervisorRunSummary {
  run_id: string
  stage_id: string
  status: RuntimeSupervisorStatus
  updated_at: string
  started_at: string
  completed_at?: string
  current_batch_id?: string
  last_reviewed_batch_id?: string
  review_passes: number
  stop_reason?: SupervisorStageStopReason
  branch_session_id?: string
  root_session_id?: string
}

export interface WorkstreamRuntimeBranchSupervisionSummary {
  branch_session_id: string
  root_session_id: string
  status: RuntimeBranchSupervisionStatus
  updated_at: string
  scope_level?: "batch" | "stage"
  stage_id?: string
  batch_id?: string
  execution_mode?: RootAgentSupervisionExecutionMode
  current_batch_id?: string
  last_reviewed_batch_id?: string
}

export interface WorkstreamRuntimeSupervisionSummary {
  updated_at: string
  active_run_id?: string
  active_run?: WorkstreamRuntimeSupervisorRunSummary
  latest_run?: WorkstreamRuntimeSupervisorRunSummary
  current_branch?: WorkstreamRuntimeBranchSupervisionSummary
}

export interface WorkstreamRuntimeSummary {
  updated_at: string
  batches: Record<string, WorkstreamRuntimeBatchSummary>
  supervision?: WorkstreamRuntimeSupervisionSummary
}

export interface PersistedBatchStatusThread {
  threadId: string
  threadName: string
  status: RuntimeBatchStatus
  startedAt?: string
  updatedAt: string
  completedAt?: string
  markerDetectedAt?: string
  currentSessionId?: string
  opencodeSessionId?: string
  workingAgentSessionId?: string
  synthesisUpdatedAt?: string
  recoveryNote?: string
}

export interface PersistedBatchStatusSummary {
  total: number
  pending: number
  running: number
  completed: number
  failed: number
}

export interface PersistedBatchStatusFile {
  version: string
  streamId: string
  batchId: string
  runId: string
  tmuxSessionName?: string
  mode: "headless"
  status: RuntimeBatchStatus
  stageName?: string
  batchName?: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  summary: PersistedBatchStatusSummary
  threads: PersistedBatchStatusThread[]
}

/**
 * Canonical persisted runtime state.
 * This unifies thread/session metadata, batch execution state, and
 * supervision control-plane state under one persisted document.
 */
export interface WorkstreamUnifiedRuntimeState {
  version: string
  last_updated: string
  threads: ThreadMetadata[]
  batches: Record<string, PersistedBatchStatusFile>
  supervision: SupervisorStateFile
}

/**
 * Error during consolidation
 */
export interface ConsolidateError {
  line?: number
  section?: string
  message: string
}

/**
 * Result of consolidating PLAN.md into JSON
 */
export interface ConsolidateResult {
  success: boolean
  streamDocument: StreamDocument | null
  tasksGenerated: ExecutionItem[]
  errors: ConsolidateError[]
  warnings: string[]
}

// ============================================
// METRICS & EVALUATION TYPES
// ============================================

/**
 * Evaluation metrics for a workstream
 */
export interface EvaluationMetrics {
  streamId: string
  streamName: string
  totalItems: number
  statusCounts: Record<ExecutionStatus, number>
  completionRate: number
  blockedRate: number
  cancelledRate: number
  inProgressCount: number
}

/**
 * Blocker analysis result
 */
export interface BlockerAnalysis {
  blockedItems: ExecutionItem[]
  blockersByStage: Record<number, ExecutionItem[]>
  blockersByBatch: Record<string, ExecutionItem[]> // key is "stage.batch" e.g., "1.00"
  blockedPercentage: number
}

/**
 * Execution-item filter result
 */
export interface FilterResult {
  matchingItems: ExecutionItem[]
  matchCount: number
  totalItems: number
}

// ============================================
// DOCUMENT & EXPORT TYPES
// ============================================

/**
 * Stage report for progress reports
 */
export interface StageReport {
  stageNumber: number
  stageName: string
  batchCount: number
  threadCount: number
  itemCount: number
  completedCount: number
  blockedCount: number
  inProgressCount: number
}

/**
 * Progress report structure
 */
export interface ProgressReport {
  streamId: string
  streamName: string
  generatedAt: string
  status: StreamStatus
  metrics: EvaluationMetrics
  stageReports: StageReport[]
}

/**
 * Changelog entry for completed execution items
 */
export interface ChangelogEntry {
  itemId: string
  itemName: string
  stageName: string
  threadName: string
  completedAt: string
}

/**
 * Export format options
 */
export type ExportFormat = "md" | "csv" | "json"

// ============================================
// REPORT TEMPLATE TYPES
// ============================================

/**
 * File reference in a report - describes changes made to a file
 */
export interface ReportFileReference {
  path: string
  changes: string
}

/**
 * Accomplishment for a stage - groups key changes
 */
export interface ReportStageAccomplishment {
  stageNumber: number
  stageName: string
  description: string
  keyChanges: string[]
}

/**
 * Parsed sections from a REPORT.md file
 */
export interface ReportTemplate {
  streamId: string
  streamName: string
  reportedDate: string
  summary: string
  accomplishments: ReportStageAccomplishment[]
  fileReferences: ReportFileReference[]
  issues: string
  nextSteps: string
}

/**
 * Validation result for a REPORT.md file
 */
export interface ReportValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

// ============================================
// AGENTS CONFIGURATION TYPES
// ============================================

/**
 * Agent definition - describes an available agent
 * Defined in work/AGENTS.md (shared across all workstreams)
 *
 * Format in AGENTS.md:
 * ### backend-orm-expert
 * **Description:** Specializes in database schema design...
 * **Best for:** Database setup, migration scripts...
 * **Model:** google/gemini-3-flash-preview
 */
export interface AgentDefinition {
  name: string // e.g., "backend-orm-expert" (from H3 heading)
  description: string // Multi-sentence description of specialization
  bestFor: string // Use cases summary
  model: string // Must be in "provider/model" format, e.g., "google/gemini-3-flash-preview", "anthropic/claude-sonnet-4"
}

/**
 * Full agents configuration from AGENTS.md
 * Agent assignments are stored in canonical thread runtime state.
 */
export interface AgentsConfig {
  agents: AgentDefinition[]
}

// ============================================
// THREAD METADATA RUNTIME TYPES
// ============================================

/**
 * Thread metadata stored in canonical runtime state.
 */
export interface ThreadMetadata {
  threadId: string // Format: "SS.BB.TT" (e.g., "01.01.02")
  promptPath?: string // Relative path to prompt file (e.g., "prompts/01-stage/01-batch/thread.md")
  sessions: SessionRecord[] // Session history for this thread
  status?: ExecutionStatus
  createdAt?: string
  updatedAt?: string
  itemName?: string
  breadcrumb?: string
  report?: string
  assigned_agent?: string
  /**
   * Internal session tracking ID for the thread.
   * Used for internal state management and resume functionality.
   */
  currentSessionId?: string
  /**
   * The opencode session ID of the outermost agent.
   * - When synthesis is disabled: This is the working agent's session ID
   * - When synthesis is enabled: This is the synthesis agent's session ID
   * Example: "ses_413402385ffe4rhZzbpafvjAUc"
   */
  opencodeSessionId?: string
  /**
   * The opencode session ID of the working agent specifically.
   * Only set when synthesis is enabled (working agent runs as inner session).
   * Use this when available, falling back to `opencodeSessionId`.
   * Example: "ses_413402385ffe4rhZzbpafvjAUc"
   */
  workingAgentSessionId?: string
  /**
   * Synthesis output summary generated by the synthesis agent.
   * Contains the synthesized summary of the working agent's output.
   * @deprecated Use `synthesis.output` instead. This field is kept for backward compatibility.
   */
  synthesisOutput?: string
  /**
   * Structured synthesis result from the synthesis agent.
   * Contains session ID, output text, and completion timestamp.
   */
  synthesis?: ThreadSynthesis
}

/**
 * Legacy thread metadata artifact shape accepted during migration reads.
 * Canonical persistence lives in structured workstream runtime state.
 */
export interface ThreadsJson {
  version: string // Schema version, e.g., "1.0.0"
  stream_id: string // Reference to the workstream ID
  last_updated: string // ISO date
  threads: ThreadMetadata[]
}

export interface ThreadSynthesis {
  sessionId: string
  output: string
  completedAt: string
}

export type RootAgentBranchRole = "supervision" | "review" | "fix"

export type RootAgentBranchSource = "native_fork" | "repo_local_fallback"

export type RootAgentBranchStatus = "pending" | "running" | "completed" | "stopped" | "failed"

export type RootAgentBranchFinalizationSource =
  | "explicit_finalize"
  | "parent_process_exit_reconciliation"

export type RootAgentBranchFinalizationReason =
  | "persisted_terminal_status"
  | "ended_without_explicit_finalize"
  | "exit_zero_without_usable_finalization"
  | "nonzero_exit"
  | "session_missing_with_recovered_report"
  | "session_missing_without_usable_finalization"

export interface RootAgentBatchBranchScope {
  level: "batch"
  stageId: string
  batchId: string
}

export interface RootAgentStageBranchScope {
  level: "stage"
  stageId: string
}

export type RootAgentBranchScope = RootAgentBatchBranchScope | RootAgentStageBranchScope

export type RootAgentSupervisionExecutionMode = "single_batch_run" | "stage_batch_loop"

export interface RootAgentSupervisionProgress {
  executionMode: RootAgentSupervisionExecutionMode
  currentBatchId?: string
  lastReviewedBatchId?: string
}

export type RootAgentBreakpointSelectionStrategy =
  | "explicit_tag"
  | "previous_user_before_launch"

export type RootAgentBreakpointMode = "prefer_tagged" | "previous_user"

export interface RootAgentBreakpointSelection {
  strategy: RootAgentBreakpointSelectionStrategy
  configuredTags: string[]
  matchedTag?: string
  launchMessageId?: string
  launchMessageIndex?: number
  rationale: string
}

export interface RootAgentCheckpointPointer {
  rootSessionId: string
  checkpointMessageIndex: number
  checkpointCreatedAt: string
  checkpointMessageId?: string
  breakpointSelection?: RootAgentBreakpointSelection
}

export interface RootAgentLineage {
  owner: "root_agent"
  rootSessionId: string
  branchSessionId: string
  branchRole: RootAgentBranchRole
  scope?: RootAgentBranchScope
  /**
   * Stage 13+ metadata-only checkpoint pointer fields.
   * These identify the Root Agent transcript boundary used for branch launch.
   */
  checkpointMessageId?: string
  checkpointMessageIndex?: number
  checkpointCreatedAt?: string
  breakpointSelection?: RootAgentBreakpointSelection
  /**
   * Stage 12 conversational-checkpoint fields retained for migration reads.
   * New writes should prefer metadata-only pointer fields above.
   */
  checkpointSessionId?: string
  parentBranchSessionId?: string
  parentSessionId?: string
  nativeSessionId?: string
  source: RootAgentBranchSource
}

export interface RootAgentBranchSession extends RootAgentLineage {
  status: RootAgentBranchStatus
  startedAt: string
  updatedAt: string
  completedAt?: string
   processEndedAt?: string
   processExitCode?: number
   finalizationSource?: RootAgentBranchFinalizationSource
   finalizationReason?: RootAgentBranchFinalizationReason
  tmuxSessionName?: string
  runId?: string
  batchId?: string
  supervisionProgress?: RootAgentSupervisionProgress
  threadId?: string
  reviewId?: string
  fixCycleId?: string
  notes?: string
}

export interface CurrentBranchSupervisionContext extends RootAgentLineage {
  branchRole: "supervision"
  nativeSessionId: string
  tmuxSessionName?: string
  updatedAt: string
  supervisionProgress?: RootAgentSupervisionProgress
}

// ============================================
// SUPERVISOR RUNTIME STATE TYPES
// ============================================

/**
 * Runtime status for a supervisor-controlled automation run.
 */
export type SupervisorRunStatus =
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"
  | "escalated"

/**
 * Outcome recorded when a supervisor reviews a batch.
 */
export type SupervisorReviewOutcome =
  | "approved"
  | "changes_requested"
  | "escalated"
  | "stopped"

/**
 * Whether a batch review is the initial pass or a follow-up re-review.
 */
export type SupervisorReviewKind = "initial" | "re_review"

/**
 * Lifecycle state for a summarized supervisor issue.
 */
export type SupervisorIssueStatus =
  | "open"
  | "in_progress"
  | "resolved"
  | "escalated"

/**
 * Result of a fix cycle for a reviewed thread.
 */
export type SupervisorFixCycleOutcome =
  | "pending_review"
  | "accepted"
  | "rejected"
  | "escalated"
  | "stopped"

/**
 * Entity a supervisor escalation is targeting.
 */
export type SupervisorEscalationTarget =
  | "thread"
  | "batch"
  | "stage"
  | "operator"

/**
 * Resolution state for a supervisor escalation.
 */
export type SupervisorEscalationStatus =
  | "pending"
  | "acknowledged"
  | "resolved"
  | "deferred"
  | "halted"

/**
 * Reason a supervisor stopped a stage or batch run.
 */
export type SupervisorStageStopReason =
  | "completed"
  | "review_limit_reached"
  | "issues_escalated"
  | "operator_handoff"
  | "blocked"
  | "failed"

/**
 * Metadata for a supervisor automation run.
 * References batch/thread artifacts without storing thread session metadata.
 */
export interface SupervisorRunState {
  runId: string
  stageId: string
  status: SupervisorRunStatus
  startedAt: string
  updatedAt: string
  completedAt?: string
  currentBatchId?: string
  lastReviewedBatchId?: string
  reviewPasses: number
  issueSummaryIds: string[]
  escalationIds: string[]
  rootSessionId?: string
  branchSessionId?: string
  stageStopId?: string
  stopReason?: SupervisorStageStopReason
}

/**
 * Review checkpoint for a batch handled by the supervisor.
 */
export interface SupervisorReviewedBatch {
  reviewId: string
  runId: string
  stageId: string
  batchId: string
  reviewPass: number
  reviewKind?: SupervisorReviewKind
  previousReviewId?: string
  fixCycleId?: string
  reviewedAt: string
  outcome: SupervisorReviewOutcome
  threadIds: string[]
  issueSummaryIds: string[]
  rootSessionId?: string
  branchSessionId?: string
  stopReason?: SupervisorStageStopReason
  notes?: string
}

/**
 * Structured summary of a supervisor-detected issue.
 */
export interface SupervisorIssueSummary {
  summaryId: string
  runId: string
  stageId: string
  batchId: string
  threadId?: string
  status: SupervisorIssueStatus
  summary: string
  severity?: string
  firstObservedAt: string
  lastObservedAt: string
}

/**
 * Fix-cycle state for a specific thread within a reviewed batch.
 */
export interface SupervisorFixCycle {
  cycleId: string
  runId: string
  stageId: string
  batchId: string
  threadId: string
  attemptCount: number
  batchAttempt?: number
  triggeredByReviewId?: string
  reReviewId?: string
  lastAttemptAt: string
  lastOutcome: SupervisorFixCycleOutcome
  issueSummaryIds: string[]
  rootSessionId?: string
  branchSessionId?: string
}

/**
 * Escalation record and current outcome.
 */
export interface SupervisorEscalationRecord {
  escalationId: string
  runId: string
  stageId: string
  batchId?: string
  threadId?: string
  target: SupervisorEscalationTarget
  reason: string
  status: SupervisorEscalationStatus
  escalatedAt: string
  resolvedAt?: string
  rootSessionId?: string
  branchSessionId?: string
  notes?: string
}

/**
 * Persisted reason for stopping work at a stage or batch boundary.
 */
export interface SupervisorStageStop {
  stopId: string
  runId: string
  stageId: string
  batchId?: string
  reason: SupervisorStageStopReason
  summary: string
  stoppedAt: string
  rootSessionId?: string
  branchSessionId?: string
  escalationId?: string
}

/**
 * Legacy supervisor state artifact shape accepted during migration reads.
 * Canonical persistence lives in structured workstream runtime state.
 */
export interface SupervisorStateFile {
  version: string
  stream_id: string
  last_updated: string
  active_run_id?: string
  current_branch_supervision?: CurrentBranchSupervisionContext
  runs: SupervisorRunState[]
  checkpoint_pointers: RootAgentCheckpointPointer[]
  branch_sessions: RootAgentBranchSession[]
  reviewed_batches: SupervisorReviewedBatch[]
  issue_summaries: SupervisorIssueSummary[]
  fix_cycles: SupervisorFixCycle[]
  escalations: SupervisorEscalationRecord[]
  stage_stops: SupervisorStageStop[]
}

// ============================================
// SESSION TRACKING TYPES
// ============================================

/**
 * Status of an agent session working on a thread/item scope
 */
export type SessionStatus = "running" | "completed" | "failed" | "interrupted"

/**
 * Record of a single agent session working on a thread/item scope
 * Tracks execution details for debugging, retry logic, and metrics
 */
export interface SessionRecord {
  sessionId: string // Unique identifier for the session
  agentName: string // Name of the agent that ran this session
  model: string // Model used (e.g., "anthropic/claude-sonnet-4")
  startedAt: string // ISO timestamp when session started
  completedAt?: string // ISO timestamp when session ended (optional for running sessions)
  status: SessionStatus // Current status of the session
  exitCode?: number // Exit code if process completed (0 = success)
  lineage?: RootAgentLineage
}

// ============================================
// YAML-BASED AGENTS CONFIGURATION (agents.yaml)
// ============================================

/**
 * Model specification - can be a simple string or object with variant
 * 
 * Examples:
 *   - "anthropic/claude-sonnet-4-5"
 *   - { model: "google/antigravity-gemini-3-flash", variant: "low" }
 */
export type ModelSpec = string | { model: string; variant?: string }

/**
 * Normalized model specification (always object form)
 */
export interface NormalizedModelSpec {
  model: string
  variant?: string
}

/**
 * Agent definition in agents.yaml format
 * Supports multiple models per agent for retry logic
 */
export interface AgentDefinitionYaml {
  name: string
  description: string
  best_for: string
  models: ModelSpec[] // List of models to try in order on failure
}

/**
 * Root structure of agents.yaml
 */
export interface AgentsConfigYaml {
  agents: AgentDefinitionYaml[]
}

// ============================================
// MULTI COMMAND TYPES (Parallel Execution)
// ============================================

/**
 * Thread information for parallel execution
 * Contains all metadata needed to spawn and track a thread
 */
export interface ThreadInfo {
  threadId: string // "01.01.01"
  threadName: string
  stageName: string
  batchName: string
  promptContent?: string // Generated in memory at execution time; never persisted
  models: NormalizedModelSpec[] // List of models to try in order (working agent models)
  agentName: string
  // Session tracking (populated before spawn)
  sessionId?: string
}

/**
 * Mapping of thread sessions to pane IDs
 * Used to track which pane is running which thread's session
 */
export interface ThreadSessionMap {
  threadId: string
  sessionId: string
  paneId: string
  windowIndex: number
}
