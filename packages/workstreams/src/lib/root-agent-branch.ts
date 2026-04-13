import { randomUUID } from "crypto"
import { loadSupervisorState } from "./supervisor-state.ts"
import type {
  RootAgentBranchScope,
  RootAgentBreakpointSelection,
  RootAgentBranchRole,
  RootAgentBranchSession,
  RootAgentBranchSource,
  RootAgentBranchStatus,
  RootAgentLineage,
  RootAgentSupervisionProgress,
  SupervisorReviewOutcome,
} from "./types.ts"

export interface RootAgentBranchContext {
  rootSessionId: string
  branchSessionId: string
  checkpointMessageId?: string
  checkpointMessageIndex?: number
  checkpointCreatedAt?: string
  breakpointSelection?: RootAgentBreakpointSelection
  checkpointSessionId?: string
  parentSessionId?: string
  parentBranchSessionId?: string
  nativeSessionId?: string
  source?: RootAgentBranchSource
  scope?: RootAgentBranchScope
}

function inferStageIdFromBatchId(batchId?: string): string | undefined {
  if (!batchId) {
    return undefined
  }

  const [stageId] = batchId.split(".")
  return stageId && stageId.length > 0 ? stageId : undefined
}

export function normalizeRootAgentBranchScope(args: {
  scope?: RootAgentBranchScope
  batchId?: string
  fallbackScope?: RootAgentBranchScope
}): RootAgentBranchScope | undefined {
  const scope = args.scope ?? args.fallbackScope
  const fallbackBatchId =
    args.fallbackScope?.level === "batch" ? args.fallbackScope.batchId : undefined
  const scopeBatchId = scope?.level === "batch" ? scope.batchId : undefined
  const effectiveBatchId = args.batchId ?? scopeBatchId ?? fallbackBatchId

  if (scope?.level === "stage") {
    return {
      level: "stage",
      stageId: scope.stageId,
    }
  }

  if (scope?.level === "batch") {
    const stageId = scope.stageId ?? inferStageIdFromBatchId(effectiveBatchId)
    const batchId = effectiveBatchId ?? scope.batchId

    if (!stageId || !batchId) {
      return undefined
    }

    return {
      level: "batch",
      stageId,
      batchId,
    }
  }

  const inferredStageId = inferStageIdFromBatchId(effectiveBatchId)
  if (!effectiveBatchId || !inferredStageId) {
    return undefined
  }

  return {
    level: "batch",
    stageId: inferredStageId,
    batchId: effectiveBatchId,
  }
}

export function normalizeRootAgentSupervisionProgress(args: {
  branchRole?: RootAgentBranchRole
  scope?: RootAgentBranchScope
  batchId?: string
  progress?: Partial<RootAgentSupervisionProgress>
  fallbackProgress?: Partial<RootAgentSupervisionProgress>
}): RootAgentSupervisionProgress | undefined {
  const progress = args.progress ?? args.fallbackProgress

  if (args.branchRole && args.branchRole !== "supervision" && !progress) {
    return undefined
  }

  const executionMode =
    args.scope?.level === "stage"
      ? "stage_batch_loop"
      : progress?.executionMode ??
        (args.scope?.level === "batch" || args.batchId ? "single_batch_run" : undefined)

  const currentBatchId =
    args.batchId ??
    progress?.currentBatchId ??
    (args.scope?.level === "batch" ? args.scope.batchId : undefined)

  const lastReviewedBatchId = progress?.lastReviewedBatchId

  if (!executionMode && !currentBatchId && !lastReviewedBatchId) {
    return undefined
  }

  return {
    executionMode: executionMode ?? "single_batch_run",
    ...(currentBatchId ? { currentBatchId } : {}),
    ...(lastReviewedBatchId ? { lastReviewedBatchId } : {}),
  }
}

export function createRootAgentBranchSessionId(role: RootAgentBranchRole): string {
  return `branch-${role}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export function getRootAgentBranchSource(
  nativeSessionId?: string,
  fallback: RootAgentBranchSource = "repo_local_fallback",
): RootAgentBranchSource {
  return nativeSessionId ? "native_fork" : fallback
}

export function findRootAgentBranchSessionByBranchSessionId(args: {
  repoRoot: string
  streamId: string
  branchSessionId: string
}): RootAgentBranchSession | undefined {
  return loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions.find(
    (branch) => branch.branchSessionId === args.branchSessionId,
  )
}

export function findRootAgentBranchSessionByNativeSessionId(args: {
  repoRoot: string
  streamId: string
  nativeSessionId: string
}): RootAgentBranchSession | undefined {
  return loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions.find(
    (branch) => branch.nativeSessionId === args.nativeSessionId,
  )
}

export function findRootAgentBranchSessionForLaunchSessionId(args: {
  repoRoot: string
  streamId: string
  sessionId: string
}): RootAgentBranchSession | undefined {
  const branches = loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions ?? []

  for (let index = branches.length - 1; index >= 0; index -= 1) {
    const branch = branches[index]

    if (!branch) {
      continue
    }

    if (branch.nativeSessionId === args.sessionId) {
      return branch
    }

    if (branch.checkpointSessionId === args.sessionId) {
      return branch
    }

    if (branch.parentSessionId === args.sessionId && branch.rootSessionId !== args.sessionId) {
      return branch
    }
  }

  return undefined
}

export function isTerminalRootAgentBranchStatus(
  status: RootAgentBranchStatus | undefined,
): status is Extract<RootAgentBranchStatus, "completed" | "stopped" | "failed"> {
  return status === "completed" || status === "stopped" || status === "failed"
}

export async function waitForRootAgentBranchNativeSessionId(args: {
  repoRoot: string
  streamId: string
  branchSessionId: string
  timeoutMs?: number
  pollIntervalMs?: number
}): Promise<string | undefined> {
  const timeoutMs = Math.max(0, args.timeoutMs ?? 3000)
  const pollIntervalMs = Math.max(1, args.pollIntervalMs ?? 100)
  const deadline = Date.now() + timeoutMs

  while (true) {
    const nativeSessionId = loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions.find(
      (branch) => branch.branchSessionId === args.branchSessionId,
    )?.nativeSessionId

    if (nativeSessionId) {
      return nativeSessionId
    }

    if (Date.now() >= deadline) {
      return undefined
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

export async function waitForRootAgentBranchTerminalSession(args: {
  repoRoot: string
  streamId: string
  branchSessionId: string
  timeoutMs?: number
  pollIntervalMs?: number
}): Promise<RootAgentBranchSession | undefined> {
  const timeoutMs = Math.max(0, args.timeoutMs ?? 3000)
  const pollIntervalMs = Math.max(1, args.pollIntervalMs ?? 100)
  const deadline = Date.now() + timeoutMs

  while (true) {
    const branch = findRootAgentBranchSessionByBranchSessionId(args)

    if (branch && isTerminalRootAgentBranchStatus(branch.status)) {
      return branch
    }

    if (Date.now() >= deadline) {
      return branch
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

export function buildRootAgentLineage(args: {
  context: RootAgentBranchContext
  branchRole: RootAgentBranchRole
  branchSessionId?: string
  source?: RootAgentBranchSource
  batchId?: string
}): RootAgentLineage {
  const normalizedScope = normalizeRootAgentBranchScope({
    scope: args.context.scope,
    batchId: args.batchId,
  })

  return {
    owner: "root_agent",
    rootSessionId: args.context.rootSessionId,
    branchSessionId: args.branchSessionId ?? args.context.branchSessionId,
    branchRole: args.branchRole,
    ...(args.context.checkpointMessageId
      ? { checkpointMessageId: args.context.checkpointMessageId }
      : {}),
    ...(typeof args.context.checkpointMessageIndex === "number"
      ? { checkpointMessageIndex: args.context.checkpointMessageIndex }
      : {}),
    ...(args.context.checkpointCreatedAt
      ? { checkpointCreatedAt: args.context.checkpointCreatedAt }
      : {}),
    ...(args.context.breakpointSelection
      ? { breakpointSelection: args.context.breakpointSelection }
      : {}),
    ...(args.context.checkpointSessionId
      ? { checkpointSessionId: args.context.checkpointSessionId }
      : {}),
    ...(args.context.parentBranchSessionId
      ? { parentBranchSessionId: args.context.parentBranchSessionId }
      : {}),
    ...(args.context.parentSessionId ? { parentSessionId: args.context.parentSessionId } : {}),
    ...(args.context.nativeSessionId ? { nativeSessionId: args.context.nativeSessionId } : {}),
    source: getRootAgentBranchSource(
      args.context.nativeSessionId,
      args.source ?? args.context.source ?? "repo_local_fallback",
    ),
    ...(normalizedScope ? { scope: normalizedScope } : {}),
  }
}

export function buildRootAgentBranchSession(args: {
  context: RootAgentBranchContext
  branchRole: RootAgentBranchRole
  status: RootAgentBranchStatus
  branchSessionId?: string
  source?: RootAgentBranchSource
  startedAt?: string
  updatedAt?: string
  completedAt?: string
  runId?: string
  batchId?: string
  supervisionProgress?: RootAgentSupervisionProgress
  threadId?: string
  reviewId?: string
  fixCycleId?: string
  notes?: string
}): RootAgentBranchSession {
  const updatedAt = args.updatedAt ?? new Date().toISOString()
  const lineage = buildRootAgentLineage({
    context: args.context,
    branchRole: args.branchRole,
    branchSessionId: args.branchSessionId,
    source: args.source,
    batchId: args.batchId,
  })
  const progressBatchId =
    args.batchId ?? (lineage.scope?.level === "batch" ? lineage.scope.batchId : undefined)
  const persistedBatchId =
    lineage.scope?.level === "stage"
      ? undefined
      : args.batchId ?? (lineage.scope?.level === "batch" ? lineage.scope.batchId : undefined)
  const supervisionProgress = normalizeRootAgentSupervisionProgress({
    branchRole: args.branchRole,
    scope: lineage.scope,
    batchId: progressBatchId,
    progress: args.supervisionProgress,
  })

  return {
    ...lineage,
    status: args.status,
    startedAt: args.startedAt ?? updatedAt,
    updatedAt,
    ...(args.completedAt ? { completedAt: args.completedAt } : {}),
    ...(args.runId ? { runId: args.runId } : {}),
    ...(persistedBatchId ? { batchId: persistedBatchId } : {}),
    ...(supervisionProgress ? { supervisionProgress } : {}),
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.reviewId ? { reviewId: args.reviewId } : {}),
    ...(args.fixCycleId ? { fixCycleId: args.fixCycleId } : {}),
    ...(args.notes ? { notes: args.notes } : {}),
  }
}

export function getBranchStatusForReviewOutcome(
  outcome: SupervisorReviewOutcome,
): RootAgentBranchStatus {
  return outcome === "approved" ? "completed" : outcome === "changes_requested" ? "running" : "stopped"
}
