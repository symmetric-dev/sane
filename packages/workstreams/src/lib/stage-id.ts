import type {
  CurrentBranchSupervisionContext,
  PersistedBatchStatusFile,
  PersistedBatchStatusThread,
  RootAgentBranchScope,
  RootAgentBranchSession,
  RootAgentLineage,
  RootAgentSupervisionProgress,
  SessionRecord,
  SupervisorEscalationRecord,
  SupervisorFixCycle,
  SupervisorIssueSummary,
  SupervisorReviewedBatch,
  SupervisorRunState,
  SupervisorStageStop,
  ThreadMetadata,
} from "./types.ts"

function trimNonEmpty(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeNumericIdSegment(value?: string): string | undefined {
  const trimmed = trimNonEmpty(value)
  if (!trimmed) {
    return undefined
  }

  const numericMatch = /^0*(\d+)$/.exec(trimmed)
  if (!numericMatch) {
    return undefined
  }

  return numericMatch[1]!.padStart(2, "0")
}

function normalizeCompositeId(
  value: string | undefined,
  width: number,
  firstSegmentNormalizer: (segment?: string) => string | undefined = normalizeNumericIdSegment,
): string | undefined {
  const trimmed = trimNonEmpty(value)
  if (!trimmed) {
    return undefined
  }

  const parts = trimmed.split(".").map((part) => part.trim())
  if (parts.length !== width) {
    return undefined
  }

  const normalized = parts.map((part, index) =>
    index === 0 ? firstSegmentNormalizer(part) : normalizeNumericIdSegment(part),
  )
  if (normalized.some((part) => !part)) {
    return undefined
  }

  return normalized.join(".")
}

export function normalizeCanonicalStageId(stageId?: string): string | undefined {
  const numeric = normalizeNumericIdSegment(stageId)
  if (numeric) {
    return numeric
  }

  const trimmed = trimNonEmpty(stageId)
  if (!trimmed) {
    return undefined
  }

  const labeledMatch = /^stage\s+0*(\d+)(?:\b|\s*:.*)$/i.exec(trimmed)
  if (labeledMatch) {
    return labeledMatch[1]!.padStart(2, "0")
  }

  return undefined
}

export function normalizeCanonicalStageIdOrFallback(stageId?: string): string | undefined {
  return normalizeCanonicalStageId(stageId) ?? trimNonEmpty(stageId)
}

export function normalizeCanonicalBatchId(batchId?: string): string | undefined {
  return normalizeCompositeId(batchId, 2, normalizeCanonicalStageId)
}

export function normalizeCanonicalBatchIdOrFallback(batchId?: string): string | undefined {
  return normalizeCanonicalBatchId(batchId) ?? trimNonEmpty(batchId)
}

export function normalizeCanonicalThreadId(threadId?: string): string | undefined {
  return normalizeCompositeId(threadId, 3, normalizeCanonicalStageId)
}

export function normalizeCanonicalThreadIdOrFallback(threadId?: string): string | undefined {
  return normalizeCanonicalThreadId(threadId) ?? trimNonEmpty(threadId)
}

export function normalizeCanonicalExecutionItemId(itemId?: string): string | undefined {
  return normalizeCompositeId(itemId, 4, normalizeCanonicalStageId)
}

export function normalizeCanonicalExecutionItemIdOrFallback(itemId?: string): string | undefined {
  return normalizeCanonicalExecutionItemId(itemId) ?? trimNonEmpty(itemId)
}

export function inferCanonicalStageIdFromBatchId(batchId?: string): string | undefined {
  return normalizeCanonicalBatchId(batchId)?.split(".")[0]
}

export function inferCanonicalStageIdFromThreadId(threadId?: string): string | undefined {
  return normalizeCanonicalThreadId(threadId)?.split(".")[0]
}

export function inferCanonicalStageIdFromExecutionItemId(itemId?: string): string | undefined {
  return normalizeCanonicalExecutionItemId(itemId)?.split(".")[0]
}

export function inferCanonicalBatchIdFromThreadId(threadId?: string): string | undefined {
  const normalizedThreadId = normalizeCanonicalThreadId(threadId)
  if (!normalizedThreadId) {
    return undefined
  }

  return normalizedThreadId.split(".").slice(0, 2).join(".")
}

export function inferCanonicalBatchIdFromExecutionItemId(itemId?: string): string | undefined {
  const normalizedItemId = normalizeCanonicalExecutionItemId(itemId)
  if (!normalizedItemId) {
    return undefined
  }

  return normalizedItemId.split(".").slice(0, 2).join(".")
}

export function inferCanonicalThreadIdFromExecutionItemId(itemId?: string): string | undefined {
  const normalizedItemId = normalizeCanonicalExecutionItemId(itemId)
  if (!normalizedItemId) {
    return undefined
  }

  return normalizedItemId.split(".").slice(0, 3).join(".")
}

function normalizeBranchScopeStageId(args: {
  stageId?: string
  batchId?: string
  threadId?: string
  itemId?: string
}): string | undefined {
  return (
    normalizeCanonicalStageId(args.stageId) ??
    inferCanonicalStageIdFromBatchId(args.batchId) ??
    inferCanonicalStageIdFromThreadId(args.threadId) ??
    inferCanonicalStageIdFromExecutionItemId(args.itemId) ??
    trimNonEmpty(args.stageId)
  )
}

export function normalizePersistedBranchScope(
  scope?: RootAgentBranchScope,
  fallbackBatchId?: string,
): RootAgentBranchScope | undefined {
  const normalizedFallbackBatchId = normalizeCanonicalBatchIdOrFallback(fallbackBatchId)
  const scopeBatchId = scope?.level === "batch" ? normalizeCanonicalBatchIdOrFallback(scope.batchId) : undefined
  const normalizedBatchId = scopeBatchId ?? normalizedFallbackBatchId

  if (scope?.level === "stage") {
    const stageId = normalizeBranchScopeStageId({ stageId: scope.stageId })
    return stageId
      ? {
          level: "stage",
          stageId,
        }
      : undefined
  }

  if (scope?.level === "batch") {
    const stageId = normalizeBranchScopeStageId({
      stageId: scope.stageId,
      batchId: normalizedBatchId,
    })
    if (!stageId || !normalizedBatchId) {
      return undefined
    }

    return {
      level: "batch",
      stageId,
      batchId: normalizedBatchId,
    }
  }

  const inferredStageId = normalizeBranchScopeStageId({ batchId: normalizedBatchId })
  if (!normalizedBatchId || !inferredStageId) {
    return undefined
  }

  return {
    level: "batch",
    stageId: inferredStageId,
    batchId: normalizedBatchId,
  }
}

export function normalizePersistedSupervisionProgress(args: {
  branchRole?: RootAgentBranchSession["branchRole"]
  scope?: RootAgentBranchScope
  batchId?: string
  progress?: Partial<RootAgentSupervisionProgress>
}): RootAgentSupervisionProgress | undefined {
  if (args.branchRole && args.branchRole !== "supervision" && !args.progress) {
    return undefined
  }

  const normalizedCurrentBatchId =
    normalizeCanonicalBatchIdOrFallback(args.batchId) ??
    normalizeCanonicalBatchIdOrFallback(args.progress?.currentBatchId) ??
    (args.scope?.level === "batch" ? normalizeCanonicalBatchIdOrFallback(args.scope.batchId) : undefined)

  const normalizedLastReviewedBatchId = normalizeCanonicalBatchIdOrFallback(
    args.progress?.lastReviewedBatchId,
  )

  const executionMode =
    args.scope?.level === "stage"
      ? "stage_batch_loop"
      : args.progress?.executionMode ??
        (args.scope?.level === "batch" || normalizedCurrentBatchId ? "single_batch_run" : undefined)

  if (!executionMode && !normalizedCurrentBatchId && !normalizedLastReviewedBatchId) {
    return undefined
  }

  return {
    executionMode: executionMode ?? "single_batch_run",
    ...(normalizedCurrentBatchId ? { currentBatchId: normalizedCurrentBatchId } : {}),
    ...(normalizedLastReviewedBatchId ? { lastReviewedBatchId: normalizedLastReviewedBatchId } : {}),
  }
}

export function normalizePersistedLineage<T extends RootAgentLineage>(lineage: T): T {
  const normalizedScope = normalizePersistedBranchScope(lineage.scope)
  return {
    ...lineage,
    ...(normalizedScope ? { scope: normalizedScope } : {}),
  }
}

export function normalizePersistedSessionRecord(session: SessionRecord): SessionRecord {
  return {
    sessionId: session.sessionId,
    agentName: session.agentName,
    model: session.model,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    status: session.status,
    exitCode: session.exitCode,
    ...(session.lineage ? { lineage: normalizePersistedLineage(session.lineage) } : {}),
  }
}

export function normalizePersistedThreadMetadata(thread: ThreadMetadata): ThreadMetadata {
  return {
    ...thread,
    threadId: normalizeCanonicalThreadIdOrFallback(thread.threadId) ?? thread.threadId,
    sessions: (thread.sessions ?? []).map(normalizePersistedSessionRecord),
    ...(thread.status ? { status: thread.status } : {}),
    ...(thread.createdAt ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.itemName ? { itemName: thread.itemName } : {}),
    ...(thread.breadcrumb ? { breadcrumb: thread.breadcrumb } : {}),
    ...(thread.report ? { report: thread.report } : {}),
    ...(thread.assigned_agent ? { assigned_agent: thread.assigned_agent } : {}),
  }
}

export function normalizePersistedBatchStatusThread(
  thread: PersistedBatchStatusThread,
): PersistedBatchStatusThread {
  const normalizedThreadId = normalizeCanonicalThreadId(thread.threadId) ?? trimNonEmpty(thread.threadId)

  return {
    ...thread,
    ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
  }
}

export function normalizePersistedBatchStatus(
  batchStatus: PersistedBatchStatusFile,
  fallbackBatchId?: string,
): PersistedBatchStatusFile {
  const normalizedBatchId =
    normalizeCanonicalBatchId(batchStatus.batchId) ??
    normalizeCanonicalBatchId(fallbackBatchId) ??
    trimNonEmpty(batchStatus.batchId) ??
    trimNonEmpty(fallbackBatchId) ??
    batchStatus.batchId

  return {
    ...batchStatus,
    batchId: normalizedBatchId,
    threads: (batchStatus.threads ?? []).map(normalizePersistedBatchStatusThread),
  }
}

export function normalizePersistedSupervisorRunState(run: SupervisorRunState): SupervisorRunState {
  const normalizedCurrentBatchId = normalizeCanonicalBatchIdOrFallback(run.currentBatchId)
  const normalizedLastReviewedBatchId = normalizeCanonicalBatchIdOrFallback(run.lastReviewedBatchId)

  return {
    ...run,
    stageId:
      normalizeCanonicalStageId(run.stageId) ??
      inferCanonicalStageIdFromBatchId(normalizedCurrentBatchId) ??
      inferCanonicalStageIdFromBatchId(normalizedLastReviewedBatchId) ??
      trimNonEmpty(run.stageId) ??
      run.stageId,
    ...(normalizedCurrentBatchId ? { currentBatchId: normalizedCurrentBatchId } : {}),
    ...(normalizedLastReviewedBatchId ? { lastReviewedBatchId: normalizedLastReviewedBatchId } : {}),
  }
}

export function normalizePersistedSupervisorReviewedBatch(
  reviewedBatch: SupervisorReviewedBatch,
): SupervisorReviewedBatch {
  const normalizedBatchId = normalizeCanonicalBatchIdOrFallback(reviewedBatch.batchId)
  return {
    ...reviewedBatch,
    stageId:
      normalizeCanonicalStageId(reviewedBatch.stageId) ??
      inferCanonicalStageIdFromBatchId(normalizedBatchId) ??
      trimNonEmpty(reviewedBatch.stageId) ??
      reviewedBatch.stageId,
    batchId: normalizedBatchId ?? reviewedBatch.batchId,
    threadIds: (reviewedBatch.threadIds ?? []).map(
      (threadId) => normalizeCanonicalThreadIdOrFallback(threadId) ?? threadId,
    ),
  }
}

export function normalizePersistedSupervisorIssueSummary(
  issueSummary: SupervisorIssueSummary,
): SupervisorIssueSummary {
  const normalizedThreadId = normalizeCanonicalThreadIdOrFallback(issueSummary.threadId)
  const normalizedBatchId =
    normalizeCanonicalBatchId(issueSummary.batchId) ??
    inferCanonicalBatchIdFromThreadId(normalizedThreadId) ??
    trimNonEmpty(issueSummary.batchId)

  return {
    ...issueSummary,
    stageId:
      normalizeCanonicalStageId(issueSummary.stageId) ??
      inferCanonicalStageIdFromBatchId(normalizedBatchId) ??
      inferCanonicalStageIdFromThreadId(normalizedThreadId) ??
      trimNonEmpty(issueSummary.stageId) ??
      issueSummary.stageId,
    batchId: normalizedBatchId ?? issueSummary.batchId,
    ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
  }
}

export function normalizePersistedSupervisorFixCycle(fixCycle: SupervisorFixCycle): SupervisorFixCycle {
  const normalizedThreadId = normalizeCanonicalThreadIdOrFallback(fixCycle.threadId)
  const normalizedBatchId =
    normalizeCanonicalBatchId(fixCycle.batchId) ??
    inferCanonicalBatchIdFromThreadId(normalizedThreadId) ??
    trimNonEmpty(fixCycle.batchId)

  return {
    ...fixCycle,
    stageId:
      normalizeCanonicalStageId(fixCycle.stageId) ??
      inferCanonicalStageIdFromBatchId(normalizedBatchId) ??
      inferCanonicalStageIdFromThreadId(normalizedThreadId) ??
      trimNonEmpty(fixCycle.stageId) ??
      fixCycle.stageId,
    batchId: normalizedBatchId ?? fixCycle.batchId,
    threadId: normalizedThreadId ?? fixCycle.threadId,
  }
}

export function normalizePersistedSupervisorEscalation(
  escalation: SupervisorEscalationRecord,
): SupervisorEscalationRecord {
  const normalizedThreadId = normalizeCanonicalThreadIdOrFallback(escalation.threadId)
  const normalizedBatchId =
    normalizeCanonicalBatchId(escalation.batchId) ??
    inferCanonicalBatchIdFromThreadId(normalizedThreadId) ??
    trimNonEmpty(escalation.batchId)

  return {
    ...escalation,
    stageId:
      normalizeCanonicalStageId(escalation.stageId) ??
      inferCanonicalStageIdFromBatchId(normalizedBatchId) ??
      inferCanonicalStageIdFromThreadId(normalizedThreadId) ??
      trimNonEmpty(escalation.stageId) ??
      escalation.stageId,
    ...(normalizedBatchId ? { batchId: normalizedBatchId } : {}),
    ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
  }
}

export function normalizePersistedSupervisorStageStop(stageStop: SupervisorStageStop): SupervisorStageStop {
  const normalizedBatchId = normalizeCanonicalBatchIdOrFallback(stageStop.batchId)
  return {
    ...stageStop,
    stageId:
      normalizeCanonicalStageId(stageStop.stageId) ??
      inferCanonicalStageIdFromBatchId(normalizedBatchId) ??
      trimNonEmpty(stageStop.stageId) ??
      stageStop.stageId,
    ...(normalizedBatchId ? { batchId: normalizedBatchId } : {}),
  }
}

export function normalizePersistedBranchSession(
  branchSession: RootAgentBranchSession,
): RootAgentBranchSession {
  const normalizedThreadId = normalizeCanonicalThreadIdOrFallback(branchSession.threadId)
  const normalizedBatchId =
    normalizeCanonicalBatchId(branchSession.batchId) ??
    inferCanonicalBatchIdFromThreadId(normalizedThreadId) ??
    trimNonEmpty(branchSession.batchId)
  const normalizedScope = normalizePersistedBranchScope(branchSession.scope, normalizedBatchId)
  const normalizedProgress = normalizePersistedSupervisionProgress({
    branchRole: branchSession.branchRole,
    scope: normalizedScope,
    batchId: normalizedBatchId,
    progress: branchSession.supervisionProgress,
  })
  const persistedBatchId = normalizedScope?.level === "stage" ? undefined : normalizedBatchId

  const normalizedBranchSession: RootAgentBranchSession = {
    ...branchSession,
    ...(persistedBatchId ? { batchId: persistedBatchId } : {}),
    ...(normalizedThreadId ? { threadId: normalizedThreadId } : {}),
    ...(normalizedScope ? { scope: normalizedScope } : {}),
    ...(normalizedProgress ? { supervisionProgress: normalizedProgress } : {}),
  }

  if (!persistedBatchId && normalizedScope?.level === "stage") {
    delete normalizedBranchSession.batchId
  }

  return normalizedBranchSession
}

export function normalizePersistedCurrentBranchSupervisionContext(
  context: CurrentBranchSupervisionContext,
): CurrentBranchSupervisionContext {
  const normalizedScope = normalizePersistedBranchScope(context.scope)
  const normalizedProgress = normalizePersistedSupervisionProgress({
    branchRole: context.branchRole,
    scope: normalizedScope,
    batchId: normalizedScope?.level === "batch" ? normalizedScope.batchId : undefined,
    progress: context.supervisionProgress,
  })

  return {
    ...context,
    ...(normalizedScope ? { scope: normalizedScope } : {}),
    ...(normalizedProgress ? { supervisionProgress: normalizedProgress } : {}),
  }
}
