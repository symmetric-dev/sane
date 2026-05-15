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

// Structured storage adapters
export {
  createFilesystemStructuredStorageAdapter,
  filesystemStructuredStorageAdapter,
  createFilesystemAuthoritativeSqliteStructuredStorageAdapter,
  filesystemAuthoritativeSqliteStructuredStorageAdapter,
  getStructuredStorageAdapter,
  type FilesystemAuthoritativeSqliteStructuredStorageAdapterOptions,
} from "./lib/storage-adapter.ts"
export {
  getStructuredStorageSqlitePath,
  getSqliteStructuredStorageMirrorState,
  type SqliteStructuredStorageMirrorState,
} from "./lib/sqlite-storage.ts"

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
  parseExecutionStatus,
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
  aggregateExecutionStatus,
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

// Structured storage adapter contracts
export {
  approvalMetadataToStructuredApprovalRecords,
  createEmptyStructuredStorageWorkspaceState,
  createEmptyStructuredStorageWorkstreamState,
  createStreamMetadataFromStructuredStorageRecord,
  createStructuredStorageParitySnapshot,
  createStructuredStorageWorkstreamRecord,
  replaceStructuredApprovals,
  replaceStructuredSupervisionState,
  structuredApprovalRecordsToApprovalMetadata,
  upsertStructuredBatchRun,
  upsertStructuredThreadRuntime,
  type StructuredApprovalRecord,
  type StructuredApprovalScope,
  type StructuredBatchRecord,
  type StructuredStageRecord,
  type StructuredStorageParitySnapshot,
  type StructuredStorageStateAdapter,
  type StructuredStorageWorkspaceState,
  type StructuredStorageWorkstreamRecord,
  type StructuredStorageWorkstreamState,
  type StructuredThreadRecord,
  type StructuredThreadRuntimeRecord,
  type StructuredWorkstreamHierarchy,
} from "./lib/structured-storage.ts"

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
// Execution hierarchy and runtime state helpers
// ============================================

// Thread/execution ID utilities
export {
  listThreadExecutionItemsByThread,
  getThreadExecutionItemCounts,
  getBatchThreadMetadata,
  groupThreadExecutionItems,
  type GroupedThreadExecutionByStageThread,
  type GroupedThreadExecutionByStageBatchThread,
} from "./lib/thread-execution.ts"
export { formatExecutionItemId, parseExecutionItemId } from "./lib/execution-ids.ts"

// Thread runtime metadata
export {
  getThreadMetadata,
  updateThreadMetadataLocked,
} from "./lib/threads.ts"

// PLAN.md parsing
export {
  parseStreamDocument,
  getStreamPreview,
} from "./lib/stream-parser.ts"

// Consolidation (PLAN.md validation)
export {
  getStreamPlanMdPath,
  consolidateStream,
  formatConsolidateResult,
} from "./lib/consolidate.ts"

// Metrics and evaluation
export {
  evaluateStream,
  evaluateAllStreams,
  filterExecutionItems,
  filterExecutionItemsByStatus,
  analyzeBlockers,
  formatMetricsOutput,
  formatBlockerAnalysis,
  aggregateMetrics,
} from "./lib/metrics.ts"

// Supervisor deterministic review helpers
export {
  collectSupervisorReviewInput,
  getReviewAffectedThreadIds,
  runDeterministicSupervisorReview,
  type SupervisorBatchReviewInput,
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
