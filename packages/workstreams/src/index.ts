/**
 * @agenv/workstreams - Workstream management library for AI agents
 *
 * This package provides tools for creating, tracking, and completing
 * implementation workstreams within git repositories.
 */

// Types
export * from "./lib/types.ts"

// Repository utilities
export {
  findRepoRoot,
  getRepoRoot,
  getWorkDir,
  getIndexPath,
} from "./lib/repo.ts"

// Index operations
export {
  getOrCreateIndex,
  loadIndex,
  saveIndex,
  saveIndexSafe,
  modifyIndex,
  findStream,
  getStream,
  getNextOrderNumber,
  formatOrderNumber,
  deleteStream,
  atomicWriteFile,
  // Current stream operations
  getCurrentStreamId,
  getCurrentStream,
  setCurrentStream,
  clearCurrentStream,
  resolveStreamId,
  getResolvedStream,
  // Stream status
  setStreamStatus,
  type DeleteStreamOptions,
  type DeleteStreamResult,
} from "./lib/index.ts"

// Utility functions
export {
  toTitleCase,
  getDateString,
  validateStreamName,
  parsePositiveInt,
  statusToCheckbox,
  parseTaskStatus,
  parseStageStatus,
  setNestedField,
  getNestedField,
  parseValue,
} from "./lib/utils.ts"

// Stream generation
export {
  generateStream,
  createGenerateArgs,
  type GenerateStreamArgs,
  type GenerateStreamResult,
} from "./lib/generate.ts"

// REQUIREMENTS.md generation and validation
export {
  REQUIREMENTS_SECTION_ORDER,
  getRequirementsMdPath,
  generateRequirementsMd,
  parseRequirementsDocument,
  validateRequirementsDocument,
  type RequirementsSectionName,
  type RequirementsBulletEntry,
  type RequirementsDocument,
  type RequirementsValidationError,
  type RequirementsValidationResult,
} from "./lib/requirements.ts"

// Status and progress
export {
  getStreamProgress,
  getWorkstreamStatusSnapshot,
  createWorkstreamStatusSnapshot,
  statusSnapshotToStreamProgress,
  formatProgress,
  formatStatusSnapshot,
  computeStreamStatus,
  computeStreamStatusFromCounts,
  getStreamStatus,
  formatStreamStatusIcon,
  buildStageStatusSummaries,
  calculateStageStatus,
  aggregateTaskStatus,
  getRuntimeSummaryEntries,
  getRuntimeSummaryProjection,
} from "./lib/status.ts"

// Batch status monitoring
export {
  BATCH_STATUS_VERSION,
  getBatchStatusDir,
  getBatchStatusFilePath,
  readBatchStatus,
  writeBatchStatus,
  createBatchStatusFile,
  summarizeBatchThreads,
  isTerminalBatchStatus,
  type BatchStatusFile,
  type BatchStatusSummary,
  type BatchStatusThread,
  type BatchStatusThreadSeed,
  type BatchRunStatus,
  type BatchThreadRunStatus,
} from "./lib/batch-status.ts"
export {
  syncBatchStatus,
  waitForBatchStatus,
  batchStatusExists,
  type SyncBatchStatusOptions,
  type WaitForBatchStatusOptions,
} from "./lib/batch-monitor.ts"

// Supervisor runtime state
export {
  SUPERVISOR_STATE_VERSION,
  getSupervisorStateFilePath,
  createEmptySupervisorState,
  loadSupervisorState,
  saveSupervisorState,
  modifySupervisorState,
  upsertSupervisorRunLocked,
  setActiveSupervisorRunLocked,
  upsertReviewedBatchLocked,
  upsertIssueSummaryLocked,
  upsertFixCycleLocked,
  upsertEscalationOutcomeLocked,
  recordStageStopLocked,
} from "./lib/supervisor-state.ts"

// Task updates
export {
  parseTaskId,
  updateTask,
  type UpdateTaskArgs,
  type UpdateTaskResult,
} from "./lib/update.ts"

// Stream completion
export {
  completeStream,
  updateIndexField,
  formatStreamInfo,
  type CompleteStreamArgs,
  type CompleteStreamResult,
  type UpdateIndexFieldArgs,
  type UpdateIndexFieldResult,
} from "./lib/complete.ts"

// ============================================
// EXPORTS FOR PLAN.md + tasks.json SYSTEM
// ============================================

// Task operations (tasks.json)
export {
  getTasksFilePath,
  createEmptyTasksFile,
  readTasksFile,
  writeTasksFile,
  getTaskById,
  getTasks,
  updateTaskStatus,
  addTasks,
  getTaskCounts,
  groupTasks,
  formatTaskId,
  deleteTask,
  deleteTasksByStage,
  deleteTasksByThread,
  type GroupTasksOptions,
  type GroupedByStageThread,
  type GroupedByStageBatchThread,
} from "./lib/tasks.ts"

// PLAN.md parsing
export {
  parseStreamDocument,
  getStreamPreview,
} from "./lib/stream-parser.ts"

// Consolidation (PLAN.md → tasks.json)
export {
  getStreamPlanMdPath,
  consolidateStream,
  formatConsolidateResult,
} from "./lib/consolidate.ts"

// Metrics and evaluation
export {
  evaluateStream,
  evaluateAllStreams,
  filterTasks,
  filterTasksByStatus,
  analyzeBlockers,
  formatMetricsOutput,
  formatBlockerAnalysis,
  aggregateMetrics,
} from "./lib/metrics.ts"

// Supervisor policy config
export {
  buildSupervisorIssueBreakdown,
  collectSupervisorReviewInput,
  decideSupervisorBatchFollowUp,
  decideSupervisorStageBoundary,
  evaluateSupervisorEscalation,
  getReviewAffectedThreadIds,
  getSupervisorBatchCycleState,
  getDefaultSupervisorConfig,
  getSupervisorConfigPath,
  isSupervisorStageCompleteAfterBatch,
  loadSupervisorConfig,
  runDeterministicSupervisorReview,
  validateAndNormalizeSupervisorConfig,
  SUPERVISOR_CONFIG_FILE,
  SUPERVISOR_DIFFICULTY_VALUES,
  SUPERVISOR_EFFORT_VALUES,
  SUPERVISOR_OWNERSHIP_VALUES,
  SUPERVISOR_SEVERITY_VALUES,
  type SupervisorBatchCycleState,
  type SupervisorBatchFollowUpAction,
  type SupervisorBatchFollowUpDecision,
  type SupervisorBatchFollowUpInput,
  type SupervisorConfig,
  type SupervisorConfigInput,
  type SupervisorContactUserConditions,
  type SupervisorContactUserConditionsInput,
  type SupervisorBatchReviewInput,
  type SupervisorDecisionOutcome,
  type SupervisorDecisionTrigger,
  type SupervisorDecisionTriggerKind,
  type SupervisorDifficulty,
  type SupervisorEscalationDecision,
  type SupervisorEffort,
  type SupervisorEscalationEvaluationInput,
  type SupervisorEscalationConfig,
  type SupervisorEscalationConfigInput,
  type SupervisorEscalationThreshold,
  type SupervisorEscalationThresholdInput,
  type SupervisorIssueBreakdown,
  type SupervisorIssueDimension,
  type SupervisorIssueGroup,
  type SupervisorIssueTaxonomy,
  type SupervisorIssueTaxonomyInput,
  type SupervisorOwnership,
  type SupervisorReviewLimits,
  type SupervisorSeverity,
  type SupervisorStageBoundaryAction,
  type SupervisorStageBoundaryDecision,
  type SupervisorStageBoundaryInput,
  type SupervisorStageCompletionConfig,
  type SupervisorThreadReviewInput,
} from "./lib/supervisor/index.ts"

// Document generation and export
export {
  generateReport,
  formatReportMarkdown,
  generateChangelog,
  formatChangelogMarkdown,
  exportStreamAsCSV,
  exportStreamAsJSON,
  exportStreamAsMarkdown,
  exportStream,
  generateSummary,
} from "./lib/document.ts"

// Prompt generation
export {
  generateAllPrompts,
  getPromptContext,
  generateThreadPrompt,
  generateThreadPromptJson,
  parseThreadId,
  formatThreadId,
  type GeneratePromptsResult,
  type PromptContext,
  type ThreadId,
  type GeneratePromptOptions,
} from "./lib/prompts.ts"

// Reviewer output contract
export {
  REVIEWER_ALIGNMENT_STATUSES,
  REVIEWER_CONFIDENCE_LEVELS,
  REVIEWER_DIFFICULTIES,
  REVIEWER_EFFORTS,
  REVIEWER_OWNERSHIPS,
  REVIEWER_SEVERITIES,
  normalizeReviewerResult,
  parseReviewerResult,
  type ReviewerAlignment,
  type ReviewerAlignmentStatus,
  type ReviewerConfidence,
  type ReviewerDifficulty,
  type ReviewerEffort,
  type ReviewerIssue,
  type ReviewerNormalizeFailure,
  type ReviewerNormalizeResult,
  type ReviewerNormalizeSuccess,
  type ReviewerOwnership,
  type ReviewerResult,
  type ReviewerSeverity,
  type ReviewerValidationError,
} from "./lib/reviewer/index.js"

// Role-based access control
export {
  getCurrentRole,
  canExecuteCommand,
  getRoleDenialMessage,
  getCommandsForRole,
  getAllCommands,
  COMMAND_PERMISSIONS,
  type WorkstreamRole,
  type CommandPermission,
} from "./lib/roles.ts"
