import { randomUUID } from "crypto"
import { getResolvedStream, loadIndex } from "./index.ts"
import { loadSupervisorState } from "./supervisor-state.ts"
import type {
  CurrentBranchSupervisionContext,
  RootAgentBranchScope,
  RootAgentBranchFinalizationReason,
  RootAgentBranchFinalizationSource,
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

export interface ResolvedCurrentBranchSupervisionContext {
  streamId: string
  sessionId: string
  source: "current_branch_supervision" | "branch_session_fallback"
  current: CurrentBranchSupervisionContext
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

export function getCurrentRootAgentNativeSessionId(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const key of ["OPENCODE_SESSION_ID", "SESSION_ID"]) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }

  return undefined
}

function isAutoResolvableCurrentBranchStatus(status: RootAgentBranchStatus | undefined): boolean {
  return status === "pending" || status === "running" || status === "stopped"
}

function normalizeCurrentBranchSupervisionContext(args: {
  current: Partial<CurrentBranchSupervisionContext>
  fallbackBranch?: RootAgentBranchSession
}): CurrentBranchSupervisionContext | undefined {
  const fallbackBranch = args.fallbackBranch
  const current = args.current
  const branchRole = current.branchRole ?? fallbackBranch?.branchRole
  const rootSessionId = current.rootSessionId ?? fallbackBranch?.rootSessionId
  const branchSessionId = current.branchSessionId ?? fallbackBranch?.branchSessionId
  const nativeSessionId = current.nativeSessionId ?? fallbackBranch?.nativeSessionId
  const updatedAt = current.updatedAt ?? fallbackBranch?.updatedAt

  if (
    branchRole !== "supervision" ||
    typeof rootSessionId !== "string" ||
    rootSessionId.trim().length === 0 ||
    typeof branchSessionId !== "string" ||
    branchSessionId.trim().length === 0 ||
    typeof nativeSessionId !== "string" ||
    nativeSessionId.trim().length === 0 ||
    typeof updatedAt !== "string" ||
    updatedAt.trim().length === 0
  ) {
    return undefined
  }

  const normalizedScope = normalizeRootAgentBranchScope({
    scope: current.scope,
    batchId:
      current.supervisionProgress?.currentBatchId ??
      (fallbackBranch?.scope?.level === "batch" ? fallbackBranch.scope.batchId : undefined),
    fallbackScope: fallbackBranch?.scope,
  })
  const normalizedProgress = normalizeRootAgentSupervisionProgress({
    branchRole: "supervision",
    scope: normalizedScope,
    batchId:
      current.supervisionProgress?.currentBatchId ??
      fallbackBranch?.supervisionProgress?.currentBatchId ??
      (normalizedScope?.level === "batch" ? normalizedScope.batchId : undefined),
    progress: current.supervisionProgress,
    fallbackProgress: fallbackBranch?.supervisionProgress,
  })

  return {
    owner: "root_agent",
    rootSessionId,
    branchSessionId,
    branchRole: "supervision",
    ...(normalizedScope ? { scope: normalizedScope } : {}),
    ...(current.checkpointMessageId ?? fallbackBranch?.checkpointMessageId
      ? { checkpointMessageId: current.checkpointMessageId ?? fallbackBranch?.checkpointMessageId }
      : {}),
    ...(typeof current.checkpointMessageIndex === "number"
      ? { checkpointMessageIndex: current.checkpointMessageIndex }
      : typeof fallbackBranch?.checkpointMessageIndex === "number"
        ? { checkpointMessageIndex: fallbackBranch.checkpointMessageIndex }
        : {}),
    ...(current.checkpointCreatedAt ?? fallbackBranch?.checkpointCreatedAt
      ? { checkpointCreatedAt: current.checkpointCreatedAt ?? fallbackBranch?.checkpointCreatedAt }
      : {}),
    ...(current.breakpointSelection ?? fallbackBranch?.breakpointSelection
      ? { breakpointSelection: current.breakpointSelection ?? fallbackBranch?.breakpointSelection }
      : {}),
    ...(current.checkpointSessionId ?? fallbackBranch?.checkpointSessionId
      ? { checkpointSessionId: current.checkpointSessionId ?? fallbackBranch?.checkpointSessionId }
      : {}),
    ...(current.parentBranchSessionId ?? fallbackBranch?.parentBranchSessionId
      ? { parentBranchSessionId: current.parentBranchSessionId ?? fallbackBranch?.parentBranchSessionId }
      : {}),
    ...(current.parentSessionId ?? fallbackBranch?.parentSessionId
      ? { parentSessionId: current.parentSessionId ?? fallbackBranch?.parentSessionId }
      : {}),
    nativeSessionId,
    source: current.source ?? fallbackBranch?.source ?? getRootAgentBranchSource(nativeSessionId),
    ...(normalizedProgress ? { supervisionProgress: normalizedProgress } : {}),
    updatedAt,
  }
}

function resolveValidatedCurrentBranchBackingSession(args: {
  branchSessions: RootAgentBranchSession[]
  sessionId: string
  current?: Partial<CurrentBranchSupervisionContext>
}): RootAgentBranchSession | undefined {
  return args.branchSessions.find(
    (branch) =>
      branch.branchRole === "supervision" &&
      branch.nativeSessionId === args.sessionId &&
      isAutoResolvableCurrentBranchStatus(branch.status) &&
      (!args.current?.branchSessionId || branch.branchSessionId === args.current.branchSessionId),
  )
}

function resolveCurrentBranchSupervisionForStream(args: {
  repoRoot: string
  streamId: string
  sessionId: string
}): ResolvedCurrentBranchSupervisionContext | undefined {
  const supervisorState = loadSupervisorState(args.repoRoot, args.streamId)
  if (!supervisorState) {
    return undefined
  }

  const currentBranchSupervision = supervisorState.current_branch_supervision
  const matchingBranch = resolveValidatedCurrentBranchBackingSession({
    branchSessions: supervisorState.branch_sessions,
    sessionId: args.sessionId,
    current: currentBranchSupervision,
  })

  if (currentBranchSupervision?.nativeSessionId === args.sessionId) {
    if (!matchingBranch) {
      return undefined
    }

    const normalizedCurrent = normalizeCurrentBranchSupervisionContext({
      current: currentBranchSupervision,
      fallbackBranch: matchingBranch,
    })

    if (normalizedCurrent) {
      return {
        streamId: args.streamId,
        sessionId: args.sessionId,
        source: "current_branch_supervision",
        current: normalizedCurrent,
      }
    }
  }

  const fallbackBranch = resolveValidatedCurrentBranchBackingSession({
    branchSessions: supervisorState.branch_sessions,
    sessionId: args.sessionId,
  })

  if (!fallbackBranch) {
    return undefined
  }

  const normalizedCurrent = normalizeCurrentBranchSupervisionContext({
    current: {
      owner: "root_agent",
      rootSessionId: fallbackBranch.rootSessionId,
      branchSessionId: fallbackBranch.branchSessionId,
      branchRole: "supervision",
      ...(fallbackBranch.scope ? { scope: fallbackBranch.scope } : {}),
      ...(fallbackBranch.checkpointMessageId
        ? { checkpointMessageId: fallbackBranch.checkpointMessageId }
        : {}),
      ...(typeof fallbackBranch.checkpointMessageIndex === "number"
        ? { checkpointMessageIndex: fallbackBranch.checkpointMessageIndex }
        : {}),
      ...(fallbackBranch.checkpointCreatedAt
        ? { checkpointCreatedAt: fallbackBranch.checkpointCreatedAt }
        : {}),
      ...(fallbackBranch.breakpointSelection
        ? { breakpointSelection: fallbackBranch.breakpointSelection }
        : {}),
      ...(fallbackBranch.checkpointSessionId
        ? { checkpointSessionId: fallbackBranch.checkpointSessionId }
        : {}),
      ...(fallbackBranch.parentBranchSessionId
        ? { parentBranchSessionId: fallbackBranch.parentBranchSessionId }
        : {}),
      ...(fallbackBranch.parentSessionId ? { parentSessionId: fallbackBranch.parentSessionId } : {}),
      nativeSessionId: fallbackBranch.nativeSessionId!,
      source: fallbackBranch.source,
      ...(fallbackBranch.supervisionProgress
        ? { supervisionProgress: fallbackBranch.supervisionProgress }
        : {}),
      updatedAt: fallbackBranch.updatedAt,
    },
    fallbackBranch,
  })

  if (!normalizedCurrent) {
    return undefined
  }

  return {
    streamId: args.streamId,
    sessionId: args.sessionId,
    source: "branch_session_fallback",
    current: normalizedCurrent,
  }
}

export function resolveCurrentBranchSupervisionContext(args: {
  repoRoot: string
  streamId?: string
  sessionId?: string
  env?: Record<string, string | undefined>
}): ResolvedCurrentBranchSupervisionContext | undefined {
  const sessionId = args.sessionId ?? getCurrentRootAgentNativeSessionId(args.env)
  if (!sessionId) {
    return undefined
  }

  const index = loadIndex(args.repoRoot)
  const candidateStreamIds = args.streamId
    ? [getResolvedStream(index, args.streamId).id]
    : Array.from(
        new Set([
          ...(index.current_stream ? [index.current_stream] : []),
          ...index.streams.map((stream) => stream.id),
        ]),
      )

  for (const streamId of candidateStreamIds) {
    const resolved = resolveCurrentBranchSupervisionForStream({
      repoRoot: args.repoRoot,
      streamId,
      sessionId,
    })
    if (resolved) {
      return resolved
    }
  }

  return undefined
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
    ...(args.processEndedAt ? { processEndedAt: args.processEndedAt } : {}),
    ...(typeof args.processExitCode === "number" ? { processExitCode: args.processExitCode } : {}),
    ...(args.finalizationSource ? { finalizationSource: args.finalizationSource } : {}),
    ...(args.finalizationReason ? { finalizationReason: args.finalizationReason } : {}),
    ...(args.tmuxSessionName ? { tmuxSessionName: args.tmuxSessionName } : {}),
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
