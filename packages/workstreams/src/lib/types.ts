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
 * | Threads  | ✅ Yes    | Within a batch, threads can run in parallel    |
 * | Tasks    | ❌ No     | Within a thread, tasks are sequential          |
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

import type { ThreadSynthesis } from "./synthesis/types.js"

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
  status?: StreamStatus // computed from tasks or manually set (default: pending)
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
export interface SubTask {
  id: string
  description: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  notes?: string
}

export interface SuperTask {
  id: string
  title: string
  description: string
  subtasks: SubTask[]
}

export interface Stage {
  id: string
  number: number
  title: string
  description: string
  supertasks: SuperTask[]
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

// Task status during implementation
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "cancelled"

// Stream status - computed from tasks or manually set
export type StreamStatus =
  | "pending" // No tasks started (default)
  | "in_progress" // Has tasks in progress
  | "completed" // All tasks completed
  | "on_hold" // Manually paused, won't work on for now

// Approval status for HITL gate
export type ApprovalStatus = "draft" | "approved" | "revoked"

/**
 * Approval metadata for human-in-the-loop gate
 * Workstreams require 2 approvals before starting:
 * 1. Plan approval (PLAN.md structure is correct)
 * 2. Tasks approval (tasks.json exists with tasks)
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
  // Tasks approval gate
  tasks?: {
    status: ApprovalStatus
    approved_at?: string
    task_count?: number // snapshot of task count at approval time
    revoked_at?: string
    revoked_reason?: string
  }
}

// Stage status summary
export type StageStatus = "pending" | "in_progress" | "complete" | "blocked"

// Parsed task from checklist markdown
export interface ParsedTask {
  id: string // e.g., "1.2" for stage 1, task group 1, subtask 2
  description: string
  status: TaskStatus
  stageNumber?: number
  taskGroupNumber: number
  subtaskNumber: number
  lineNumber: number // for editing
}

/**
 * Parsed thread from TASKS.md
 * Captures thread metadata including optional agent assignment
 */
export interface ParsedThread {
  id: number // Thread number within batch
  name: string
  assigned_agent?: string // Agent name extracted from @agent:name syntax
}

/**
 * Result of parsing TASKS.md
 * Includes tasks, thread-level agent assignments, and any parse errors
 */
export interface TasksMdParseResult {
  tasks: Task[]
  threads: ParsedThread[] // Thread metadata with agent assignments
  errors: string[]
}

// Parsed stage from checklist
export interface ParsedStage {
  number: number
  title: string
  status: StageStatus
  tasks: ParsedTask[]
  file: string // which file contains this stage
}

// Workstream progress summary
export interface StreamProgress {
  streamId: string
  streamName: string
  size: StreamSize
  stages: ParsedStage[]
  totalTasks: number
  completedTasks: number
  inProgressTasks: number
  blockedTasks: number
  pendingTasks: number
  percentComplete: number
}

// Update task command options
export interface UpdateTaskOptions {
  streamId: string
  taskId: string // e.g., "01.01.02.03" (stage.batch.thread.task)
  status: TaskStatus
  note?: string
  breadcrumb?: string
}

// Complete workstream command options
export interface CompleteStreamOptions {
  streamId: string
}

// ============================================
// NEW TYPES FOR PLAN.md + tasks.json STRUCTURE
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
 * Thread definition - a parallelizable work unit within a batch
 * Each thread contains multiple tasks
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
 * Task in tasks.json - generated from consolidation
 * ID format: "{stage}.{batch}.{thread}.{task}" (e.g., "01.01.02.03")
 * All components are zero-padded to 2 digits for consistent sorting
 */
export interface Task {
  id: string // e.g., "01.01.02.03" = stage 1, batch 1, thread 2, task 3
  name: string // Task description from PLAN.md
  thread_name: string // Parent thread name for context
  batch_name: string // Parent batch name for context
  stage_name: string // Parent stage name for context
  created_at: string // ISO date
  updated_at: string // ISO date
  status: TaskStatus
  breadcrumb?: string // Last action/status for recovery
  report?: string // Completion summary (for COMPLETION.md aggregation)
  assigned_agent?: string // Agent assigned to this task
  /**
   * @deprecated Session data is now stored in threads.json.
   * Use ThreadsStore functions (getThreadMetadata, etc.) to access session data.
   * This field will be automatically migrated and cleared on first read.
   */
  sessions?: SessionRecord[]
  /**
   * @deprecated Session data is now stored in threads.json.
   * Use ThreadsStore functions (getThreadMetadata, etc.) to access session data.
   * This field will be automatically migrated and cleared on first read.
   */
  currentSessionId?: string
}

/**
 * tasks.json file structure
 */
export interface TasksFile {
  version: string // Schema version, e.g., "1.0.0"
  stream_id: string // Reference to the workstream ID
  last_updated: string // ISO date
  tasks: Task[]
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
  tasksGenerated: Task[]
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
  totalTasks: number
  statusCounts: Record<TaskStatus, number>
  completionRate: number
  blockedRate: number
  cancelledRate: number
  inProgressCount: number
}

/**
 * Blocker analysis result
 */
export interface BlockerAnalysis {
  blockedTasks: Task[]
  blockersByStage: Record<number, Task[]>
  blockersByBatch: Record<string, Task[]> // key is "stage.batch" e.g., "1.00"
  blockedPercentage: number
}

/**
 * Task filter result
 */
export interface FilterResult {
  matchingTasks: Task[]
  matchCount: number
  totalTasks: number
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
  taskCount: number
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
 * Changelog entry for completed tasks
 */
export interface ChangelogEntry {
  taskId: string
  taskName: string
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
 * Agent-to-task assignments are stored in tasks.json (Task.assigned_agent)
 */
export interface AgentsConfig {
  agents: AgentDefinition[]
}

// ============================================
// THREAD METADATA STORE TYPES (threads.json)
// ============================================

/**
 * Thread metadata stored in threads.json
 * Contains session history and github issue links, migrated from tasks.json
 */
export interface ThreadMetadata {
  threadId: string // Format: "SS.BB.TT" (e.g., "01.01.02")
  promptPath?: string // Relative path to prompt file (e.g., "prompts/01-stage/01-batch/thread.md")
  sessions: SessionRecord[] // Session history for this thread
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
 * threads.json file structure
 * Stores thread-level metadata separate from task definitions
 */
export interface ThreadsJson {
  version: string // Schema version, e.g., "1.0.0"
  stream_id: string // Reference to the workstream ID
  last_updated: string // ISO date
  threads: ThreadMetadata[]
}

export type RootAgentBranchRole = "supervision" | "review" | "fix"

export type RootAgentBranchSource = "native_fork" | "repo_local_fallback"

export type RootAgentBranchStatus = "pending" | "running" | "completed" | "stopped" | "failed"

export interface RootAgentLineage {
  owner: "root_agent"
  rootSessionId: string
  branchSessionId: string
  branchRole: RootAgentBranchRole
  checkpointSessionId?: string
  checkpointCreatedAt?: string
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
  runId?: string
  batchId?: string
  threadId?: string
  reviewId?: string
  fixCycleId?: string
  notes?: string
}

// ============================================
// SUPERVISOR RUNTIME STATE TYPES (supervisor-state.json)
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
 * supervisor-state.json file structure.
 * Keeps runtime supervisor control-plane state separate from threads.json.
 */
export interface SupervisorStateFile {
  version: string
  stream_id: string
  last_updated: string
  active_run_id?: string
  runs: SupervisorRunState[]
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
 * Status of an agent session working on a task
 */
export type SessionStatus = "running" | "completed" | "failed" | "interrupted"

/**
 * Record of a single agent session working on a task
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
 * Synthesis agent definition in agents.yaml format
 * Synthesis agents wrap working agents to provide:
 * - Pre-work context preparation
 * - Post-work output summarization
 * - Session continuity management
 */
export interface SynthesisAgentDefinitionYaml {
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
  synthesis_agents?: SynthesisAgentDefinitionYaml[]
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
  promptPath: string
  models: NormalizedModelSpec[] // List of models to try in order (working agent models)
  agentName: string
  // Session tracking (populated before spawn)
  sessionId?: string
  firstTaskId?: string // First task in thread (for session tracking)
  // Synthesis agent fields (optional - if present, post-session synthesis mode is enabled)
  synthesisAgentName?: string
  synthesisModels?: NormalizedModelSpec[] // List of synthesis models to try
}

/**
 * Mapping of thread sessions to pane IDs
 * Used to track which pane is running which thread's session
 */
export interface ThreadSessionMap {
  threadId: string
  sessionId: string
  taskId: string // First task in thread
  paneId: string
  windowIndex: number
}
