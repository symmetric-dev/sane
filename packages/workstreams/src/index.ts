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

// Model/runtime normalization and provider-specific validation
export {
  SUPPORTED_MODEL_RUNTIMES,
  parseModelReference,
  resolveModelSpec,
  normalizeModelReference,
  isValidModelFormat,
  isValidOpenCodeModel,
  isValidCursorModel,
  isValidModelForRuntime,
  validateOpenCodeModel,
  validateCursorModel,
  validateModelForRuntime,
  type ModelResolutionOptions,
  type ParsedModelReference,
} from "./lib/model.ts"

// Provider-neutral agent attempt contracts and explicit fallback policy
export {
  executeAttemptCandidates,
  BatchExecutor,
  prepareSdkBatchRun,
  createDefaultBatchExecutorAdapterFactory,
  executeSdkBatch,
  isSdkBatchExecutorHealthy,
  normalizeAttemptError,
  validateResolvedModelSpec,
  type AgentAttemptAdapter,
  type AgentAttemptError,
  type AgentAssistantEvent,
  type AgentCancelledEvent,
  type AgentCompletedEvent,
  type AgentEvent,
  type AgentEventType,
  type AgentFailedEvent,
  type AgentProgressEvent,
  type AgentProvider,
  type AgentStartedEvent,
  type AgentStatusEvent,
  type AgentToolEvent,
  type AgentUsage,
  type AgentUsageEvent,
  type AttemptAdapterFactory,
  type AttemptCandidateOutcome,
  type AttemptInput,
  type AttemptInputSeed,
  type AttemptResult,
  type AttemptTerminalStatus,
  type CancelResult,
  type CancelStatus,
  type CompletedAttemptResult,
  type ExecutionBackend,
  type ExecuteAttemptCandidatesOptions,
  type ExecuteAttemptCandidatesResult,
  type BatchExecutorAdapterFactory,
  type BatchExecutorOptions,
  type BatchExecutorReadiness,
  type BatchExecutorResult,
  type BatchThreadExecutionResult,
  type PreparedSdkBatchRun,
  type PreparedBatchCandidate,
  type PreparedBatchThread,
  type PreparedSdkBatch,
  type FailedAttemptResult,
  type NativeAttempt,
  type ProviderMetadata,
  type ProviderRuntime,
  type ReconciliationResult,
  type ReconciliationStatus,
  type CancelledAttemptResult,
  ActivityJournal,
  AtomicSnapshotWriter,
  describeAgentEvent,
  ensureRuntimeArtifactFiles,
  formatActivityRecordText,
  projectBatchExecutionSnapshot,
  readActivityJournal,
  resolveRecordedRuntimePath,
  writeAtomicExecutionSnapshot,
  type ActivityKind,
  type ActivityRecord,
  type ActivityRecordInput,
  type AtomicSnapshotWriterOptions,
  type ExecutionSnapshot,
  type ObservabilityFileSystem,
  type ReadActivityFileSystem,
} from "./lib/agent-runtime/index.ts"

// Provider-specific SDK adapter surface; SDK-generated types remain private to
// the adapter module and are not part of the neutral attempt contracts.
export {
  buildOpenCodePromptRequest,
  buildOpenCodeSessionCreateRequest,
  createOpenCodeV1Adapter,
  OpenCodeAdapter,
  OpenCodeV1Adapter,
  parseOpenCodeModel,
  type OpenCodeClientFactory,
  type OpenCodeClientFactoryOptions,
  type OpenCodeClientLike,
  type OpenCodeModelSelection,
  type OpenCodeV1AdapterOptions,
} from "./lib/agent-runtime/providers/opencode.ts"

export {
  buildCursorAgentCreateRequest,
  configureCursorRuntime,
  createCursorAdapter,
  CursorAdapter,
  CursorLocalAdapter,
  CursorV1Adapter,
  parseCursorModel,
  type CursorAdapterOptions,
  type CursorAgentLike,
  type CursorLocalAdapterOptions,
  type CursorModelSelection,
  type CursorRunLike,
  type CursorRuntimeDiagnostics,
  type CursorSdkFactory,
  type CursorSdkLike,
  type CursorSdkLoader,
  type CursorV1AdapterOptions,
} from "./lib/agent-runtime/providers/cursor.ts"

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
