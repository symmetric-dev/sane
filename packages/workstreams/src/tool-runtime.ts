export {
  getResolvedStream,
  loadIndex,
} from "./lib/index.ts"
export {
  buildRootAgentBranchSession,
  createRootAgentBranchSessionId,
  getCurrentRootAgentNativeSessionId,
  findRootAgentBranchSessionForLaunchSessionId,
  findRootAgentBranchSessionByNativeSessionId,
  resolveCurrentBranchSupervisionContext,
  waitForRootAgentBranchNativeSessionId,
  waitForRootAgentBranchTerminalSession,
} from "./lib/root-agent-branch.ts"
export {
  createRootAgentCheckpointPointer,
  formatRootAgentBreakpointSelection,
  formatRootAgentCheckpointPointer,
  getRootAgentCheckpointSessionForkEligibility,
  loadRootAgentCheckpointPointer,
  refreshRootAgentCheckpointPointer,
  validateRootAgentCheckpointPointer,
} from "./lib/root-agent-checkpoint.ts"
export {
  loadSupervisorState,
  upsertCheckpointPointerLocked,
  upsertBranchSessionLocked,
} from "./lib/supervisor-state.ts"
export { parseOpencodeJsonlText } from "./lib/opencode-output.ts"
export {
  exportSession,
  extractLastCompletedAssistantText,
} from "./lib/session-export.ts"
export {
  WORKSTREAM_TOOL_VERSION,
  WORKSTREAM_TOOL_CAPABILITIES,
  createWorkstreamsToolRuntimeInfo,
  formatWorkstreamsToolRuntimeInfo,
} from "./lib/workstream-tool/runtime-info.ts"
export {
  getWorkstreamToolLogPath,
  logWorkstreamToolAsyncStep,
  logWorkstreamToolEvent,
  logWorkstreamToolStep,
} from "./lib/workstream-tool/debug-log.ts"
export {
  createResolvedWorkstreamsToolRuntimeInfo,
  loadWorkstreamsToolRuntime,
  populateResolvedWorkstreamsToolRuntimeInfo,
  readWorkstreamsPackageVersion,
  resetWorkstreamsToolRuntimeCache,
  resolveWorkstreamsRuntimeModulePath,
} from "./tool-runtime-loader.ts"
export {
  isTerminalSupervisionStatus,
  buildFinalizationNotes,
  buildPersistedSupervisionFallback,
  createDefaultFinalizeWorkstreamSupervisionDeps,
  listCandidateStreamIds,
  executeFinalizeWorkstreamSupervision,
} from "./lib/workstream-tool/finalize-supervision.ts"
export type {
  WorkstreamsToolCapabilities,
  WorkstreamsToolRuntimeInfo,
} from "./lib/workstream-tool/runtime-info.ts"
export type {
  WorkstreamsToolRuntimeLoadOptions,
  WorkstreamsToolRuntimeModule,
  WorkstreamsToolRuntimeModuleResolution,
} from "./tool-runtime-loader.ts"
export type {
  FinalizeWorkstreamSupervisionArgs,
  FinalizeWorkstreamSupervisionCurrent,
  FinalizeWorkstreamSupervisionDeps,
  FinalizeWorkstreamSupervisionResolution,
  FinalizeWorkstreamRuntimeDeps,
  FinalizeWorkstreamRuntimeLike,
  SupervisionTerminalStatus,
} from "./lib/workstream-tool/finalize-supervision.ts"
export {
  collectCompletedBranchArtifacts,
  buildSupervisionBranchTitle,
  createDefaultLaunchSupervisionBranchDeps,
  executeLaunchSupervisionBranch,
  formatExistingSupervisionLaunchMessage,
  getDefaultLaunchSupervisionBranchHelpers,
  hasActiveSupervisionSessionHandle,
  isActiveSupervisionBranchStatus,
  parseBreakpointModeArg,
  parseBreakpointTagsArg,
  persistSupervisionBranchState,
  reconcileCompletedBranchState,
  formatSupervisionProcessExitEvidence,
  joinBranchNotes,
} from "./lib/workstream-tool/launch-supervision.ts"
export {
  buildSupervisionPrompt,
  describeScopeLabel,
  doLaunchScopesMatch,
  normalizeOptionalLaunchString,
  resolveLaunchScope,
  resolveLegacyLaunchTarget,
} from "./lib/workstream-tool/launch-supervision-scope.ts"
export {
  DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS,
  DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
  DEFAULT_OPENCODE_COMMAND_TIMEOUT_MS,
  DEFAULT_OPENCODE_SERVER_START_TIMEOUT_MS,
  findNativeSessionIdByTitle,
  prepareMessageBoundaryForkLaunch,
  requestOpencodeJson,
  runCommand,
  runForkedSession,
  runMessageBoundaryForkLaunch,
  startOpencodeServer,
} from "./lib/workstream-tool/launch-supervision-opencode.ts"
export {
  appendSupervisionTmuxObservability,
  createSupervisionTmuxLaunchMetadata,
  createSupervisionTmuxSessionName,
  formatSupervisionTmuxObservability,
  formatWorkstreamTmuxPrefix,
  inspectSupervisionTmuxSession,
  runForkedSessionInTmux,
  tmuxSessionExists,
  validateSupervisionTmuxLaunch,
  waitForTmuxSessionExit,
} from "./lib/workstream-tool/launch-supervision-tmux.ts"
export {
  createDefaultReconcileWorkstreamSupervisionDeps,
  executeReconcileWorkstreamSupervision,
} from "./lib/workstream-tool/reconcile-supervision.ts"
export type {
  LaunchSupervisionBranchDeps,
  LaunchSupervisionRuntimeDeps,
} from "./lib/workstream-tool/launch-supervision.ts"
export type { BranchLaunchScope } from "./lib/workstream-tool/launch-supervision-scope.ts"
export type {
  CheckpointSessionForkEligibility,
} from "./lib/workstream-tool/launch-supervision.ts"
export type {
  ForkedSessionArgs,
  ForkedSessionResult,
  MessageBoundaryForkTransport,
} from "./lib/workstream-tool/launch-supervision-opencode.ts"
export type {
  SupervisionTmuxLaunchMetadata,
  SupervisionTmuxInspection,
} from "./lib/workstream-tool/launch-supervision-tmux.ts"
export type {
  ReconcileWorkstreamSupervisionArgs,
  ReconcileWorkstreamSupervisionDeps,
  ReconcileWorkstreamRuntimeDeps,
} from "./lib/workstream-tool/reconcile-supervision.ts"
