/**
 * Git utilities for workstream management
 *
 * Re-exports git log parsing functions and types
 */

export {
  // Types
  type WorkstreamTrailers,
  type ParsedCommit,
  type CommitsByStage,
  // Functions
  parseGitLog,
  extractWorkstreamTrailers,
  hasWorkstreamTrailers,
  groupCommitsByStage,
  identifyHumanCommits,
  getWorkstreamCommits,
  getCurrentBranch,
  getDefaultBranch,
} from "./log.ts"

export {
  type GitAutoCommitResult,
  type GitAutoCommitSkipReason,
  executeGitAutoCommit,
  getHeadCommitSha,
  hasStagedChangesToCommit,
} from "./auto-commit-executor.ts"

export {
  type AutoCommitMessage,
  buildPlanApprovalCommitMessage,
  buildStageApprovalCommitMessage,
  buildExecutionApprovalCommitMessage,
  buildWorkstreamCompletionCommitMessage,
  buildWorkstreamStartCommitMessage,
} from "./auto-commit-message.ts"
