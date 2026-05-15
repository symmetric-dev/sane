import { existsSync, unlinkSync } from "fs"
import {
  cleanupCompletionMarkers,
  cleanupResultFiles,
  cleanupSessionFiles,
} from "./marker-polling.ts"
import {
  getSynthesisLogPath,
  getSynthesisOutputPath,
  getWorkingAgentSessionPath,
} from "./opencode.ts"
import type {
  StructuredThreadRecord,
  StructuredThreadRuntimeRecord,
} from "./structured-storage.ts"
import { modifySqliteCanonicalRuntimeWorkstreamStateSync } from "./storage-adapter.ts"
import { normalizeSupervisorState } from "./runtime-state.ts"
import type {
  CurrentBranchSupervisionContext,
  RootAgentBranchSession,
  SupervisorEscalationRecord,
  SupervisorFixCycle,
  SupervisorIssueSummary,
  SupervisorStateFile,
  SupervisorReviewedBatch,
  SupervisorStageStop,
} from "./types.ts"

export interface ResetBatchStateResult {
  batchId: string
  threadIds: string[]
  itemCount: number
  itemsReset: number
  itemReportsCleared: number
  itemBreadcrumbsCleared: number
  itemRuntimeBatchCleared: boolean
  threadRuntimeEntriesTouched: number
  supervision: {
    runsTouched: number
    branchSessionsRemoved: number
    reviewedBatchesRemoved: number
    issueSummariesRemoved: number
    fixCyclesRemoved: number
    escalationsRemoved: number
    stageStopsRemoved: number
    activeRunCleared: boolean
    currentBranchCleared: boolean
  }
  artifacts: {
    completionMarkersRemoved: number
    sessionFilesRemoved: number
    resultFilesRemoved: number
    workingSessionFilesRemoved: number
    synthesisOutputsRemoved: number
    synthesisLogsRemoved: number
  }
}

function collectBatchThreadIds(threads: Array<Pick<StructuredThreadRecord, "id" | "batchId">>, batchId: string): string[] {
  return threads
    .filter((thread) => thread.batchId === batchId)
    .map((thread) => thread.id)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
}

function clearBatchThreadRuntimeMetadata(
  thread: StructuredThreadRuntimeRecord,
  batchThread?: StructuredThreadRecord,
): {
  next: StructuredThreadRuntimeRecord | null
  changed: boolean
} {
  const next: StructuredThreadRuntimeRecord = {
    threadId: thread.threadId,
    sessions: [],
  }
  let changed = thread.sessions.length > 0

  if (thread.currentSessionId) {
    changed = true
  }
  if (thread.opencodeSessionId) {
    changed = true
  }
  if (thread.workingAgentSessionId) {
    changed = true
  }
  if (thread.synthesisOutput) {
    changed = true
  }
  if (thread.synthesis) {
    changed = true
  }

  const retainEntry = Boolean(batchThread?.promptPath)
  return { next: retainEntry ? next : null, changed }
}

function removeWhere<T>(items: T[], predicate: (value: T) => boolean): { kept: T[]; removed: T[] } {
  const kept: T[] = []
  const removed: T[] = []

  for (const item of items) {
    if (predicate(item)) {
      removed.push(item)
    } else {
      kept.push(item)
    }
  }

  return { kept, removed }
}

function branchSessionMatchesBatch(
  branchSession: RootAgentBranchSession,
  batchId: string,
  threadIds: Set<string>,
): boolean {
  return (
    branchSession.batchId === batchId ||
    (branchSession.scope?.level === "batch" && branchSession.scope.batchId === batchId) ||
    branchSession.supervisionProgress?.currentBatchId === batchId ||
    branchSession.supervisionProgress?.lastReviewedBatchId === batchId ||
    (branchSession.threadId ? threadIds.has(branchSession.threadId) : false)
  )
}

function currentBranchMatchesBatch(
  currentBranch: CurrentBranchSupervisionContext | undefined,
  batchId: string,
): boolean {
  if (!currentBranch) {
    return false
  }

  return (
    (currentBranch.scope?.level === "batch" && currentBranch.scope.batchId === batchId) ||
    currentBranch.supervisionProgress?.currentBatchId === batchId ||
    currentBranch.supervisionProgress?.lastReviewedBatchId === batchId
  )
}

function issueMatchesBatch(
  issue: SupervisorIssueSummary,
  batchId: string,
  threadIds: Set<string>,
): boolean {
  return issue.batchId === batchId || (issue.threadId ? threadIds.has(issue.threadId) : false)
}

function fixCycleMatchesBatch(
  fixCycle: SupervisorFixCycle,
  batchId: string,
  threadIds: Set<string>,
): boolean {
  return fixCycle.batchId === batchId || threadIds.has(fixCycle.threadId)
}

function escalationMatchesBatch(
  escalation: SupervisorEscalationRecord,
  batchId: string,
  threadIds: Set<string>,
): boolean {
  return escalation.batchId === batchId || (escalation.threadId ? threadIds.has(escalation.threadId) : false)
}

function stageStopMatchesBatch(
  stageStop: SupervisorStageStop,
  batchId: string,
): boolean {
  return stageStop.batchId === batchId
}

function cleanupExtraArtifact(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) {
      return false
    }

    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}

interface PrunedSupervisorStateResult {
  supervision: SupervisorStateFile
  runsTouched: number
  branchSessionsRemoved: number
  reviewedBatchesRemoved: number
  issueSummariesRemoved: number
  fixCyclesRemoved: number
  escalationsRemoved: number
  stageStopsRemoved: number
  activeRunCleared: boolean
  currentBranchCleared: boolean
}

function pruneBatchSupervisorState(
  streamId: string,
  supervisorState: Partial<SupervisorStateFile> | undefined,
  batchId: string,
  threadIdSet: Set<string>,
  now: string,
): PrunedSupervisorStateResult {
  const supervision = normalizeSupervisorState(streamId, supervisorState)

  const { kept: keptReviewedBatches, removed: removedReviewedBatches } = removeWhere(
    supervision.reviewed_batches,
    (review: SupervisorReviewedBatch) => review.batchId === batchId,
  )
  supervision.reviewed_batches = keptReviewedBatches

  const { kept: keptIssueSummaries, removed: removedIssueSummaries } = removeWhere(
    supervision.issue_summaries,
    (issue: SupervisorIssueSummary) => issueMatchesBatch(issue, batchId, threadIdSet),
  )
  supervision.issue_summaries = keptIssueSummaries
  const removedIssueSummaryIds = new Set(removedIssueSummaries.map((issue) => issue.summaryId))

  const { kept: keptFixCycles, removed: removedFixCycles } = removeWhere(
    supervision.fix_cycles,
    (fixCycle: SupervisorFixCycle) => fixCycleMatchesBatch(fixCycle, batchId, threadIdSet),
  )
  supervision.fix_cycles = keptFixCycles

  const { kept: keptEscalations, removed: removedEscalations } = removeWhere(
    supervision.escalations,
    (escalation: SupervisorEscalationRecord) => escalationMatchesBatch(escalation, batchId, threadIdSet),
  )
  supervision.escalations = keptEscalations
  const removedEscalationIds = new Set(removedEscalations.map((escalation) => escalation.escalationId))

  const { kept: keptStageStops, removed: removedStageStops } = removeWhere(
    supervision.stage_stops,
    (stageStop: SupervisorStageStop) => stageStopMatchesBatch(stageStop, batchId),
  )
  supervision.stage_stops = keptStageStops
  const removedStageStopIds = new Set(removedStageStops.map((stageStop) => stageStop.stopId))

  const { kept: keptBranchSessions, removed: removedBranchSessions } = removeWhere(
    supervision.branch_sessions,
    (branchSession: RootAgentBranchSession) => branchSessionMatchesBatch(branchSession, batchId, threadIdSet),
  )
  supervision.branch_sessions = keptBranchSessions
  const removedBranchSessionIds = new Set(
    removedBranchSessions.map((branchSession) => branchSession.branchSessionId),
  )

  const relatedRunIds = new Set<string>()
  for (const run of supervision.runs) {
    if (run.currentBatchId === batchId || run.lastReviewedBatchId === batchId) {
      relatedRunIds.add(run.runId)
    }
  }
  for (const review of removedReviewedBatches) {
    relatedRunIds.add(review.runId)
  }
  for (const issue of removedIssueSummaries) {
    relatedRunIds.add(issue.runId)
  }
  for (const fixCycle of removedFixCycles) {
    relatedRunIds.add(fixCycle.runId)
  }
  for (const escalation of removedEscalations) {
    relatedRunIds.add(escalation.runId)
  }
  for (const stageStop of removedStageStops) {
    relatedRunIds.add(stageStop.runId)
  }
  for (const branchSession of removedBranchSessions) {
    if (branchSession.runId) {
      relatedRunIds.add(branchSession.runId)
    }
  }

  let runsTouched = 0
  for (const run of supervision.runs) {
    let changed = false

    if (run.currentBatchId === batchId) {
      delete run.currentBatchId
      changed = true
    }
    if (run.lastReviewedBatchId === batchId) {
      delete run.lastReviewedBatchId
      changed = true
    }
    if (run.stageStopId && removedStageStopIds.has(run.stageStopId)) {
      delete run.stageStopId
      changed = true
    }
    if (run.branchSessionId && removedBranchSessionIds.has(run.branchSessionId)) {
      delete run.branchSessionId
      changed = true
    }

    const nextIssueSummaryIds = run.issueSummaryIds.filter((summaryId) => !removedIssueSummaryIds.has(summaryId))
    if (nextIssueSummaryIds.length !== run.issueSummaryIds.length) {
      run.issueSummaryIds = nextIssueSummaryIds
      changed = true
    }

    const nextEscalationIds = run.escalationIds.filter((escalationId) => !removedEscalationIds.has(escalationId))
    if (nextEscalationIds.length !== run.escalationIds.length) {
      run.escalationIds = nextEscalationIds
      changed = true
    }

    if (changed) {
      run.updatedAt = now
      runsTouched++
    }
  }

  const activeRunCleared =
    typeof supervision.active_run_id === "string" && relatedRunIds.has(supervision.active_run_id)
  if (activeRunCleared) {
    delete supervision.active_run_id
  }

  const currentBranchCleared =
    currentBranchMatchesBatch(supervision.current_branch_supervision, batchId) ||
    (supervision.current_branch_supervision
      ? removedBranchSessionIds.has(supervision.current_branch_supervision.branchSessionId)
      : false)
  if (currentBranchCleared) {
    delete supervision.current_branch_supervision
  }

  supervision.last_updated = now

  return {
    supervision,
    runsTouched,
    branchSessionsRemoved: removedBranchSessions.length,
    reviewedBatchesRemoved: removedReviewedBatches.length,
    issueSummariesRemoved: removedIssueSummaries.length,
    fixCyclesRemoved: removedFixCycles.length,
    escalationsRemoved: removedEscalations.length,
    stageStopsRemoved: removedStageStops.length,
    activeRunCleared,
    currentBranchCleared,
  }
}

export async function resetBatchState(
  repoRoot: string,
  streamId: string,
  batchId: string,
): Promise<ResetBatchStateResult> {
  const result: Omit<ResetBatchStateResult, "artifacts"> & { now: string } =
    modifySqliteCanonicalRuntimeWorkstreamStateSync({ repoRoot, streamId, fn: (workstreamState) => {
      const threadIds = collectBatchThreadIds(workstreamState.hierarchy.threads, batchId)
      if (threadIds.length === 0) {
        throw new Error(`No threads found for batch ${batchId} in stream ${streamId}`)
      }

      const now = new Date().toISOString()
      const threadIdSet = new Set(threadIds)
      const batchThreads = new Map(
        workstreamState.hierarchy.threads.map((thread) => [thread.id, thread] as const),
      )

      let itemsReset = 0
      let itemReportsCleared = 0
      let itemBreadcrumbsCleared = 0
      for (const runtime of workstreamState.threadRuntime) {
        if (!threadIdSet.has(runtime.threadId)) {
          continue
        }
        if (runtime.status !== "pending") {
          itemsReset++
        }
        runtime.status = "pending"
        if (runtime.report !== undefined) {
          delete runtime.report
          itemReportsCleared++
        }
        if (runtime.breadcrumb !== undefined) {
          delete runtime.breadcrumb
          itemBreadcrumbsCleared++
        }
        runtime.updatedAt = now
      }

      const itemRuntimeBatchCleared = workstreamState.batchRuns.some((run) => run.batchId === batchId)
      workstreamState.batchRuns = workstreamState.batchRuns.filter((run) => run.batchId !== batchId)

      let threadRuntimeEntriesTouched = 0
      workstreamState.threadRuntime = workstreamState.threadRuntime.flatMap((thread) => {
        if (!threadIdSet.has(thread.threadId)) {
          return [thread]
        }

        const { next, changed } = clearBatchThreadRuntimeMetadata(
          thread,
          batchThreads.get(thread.threadId),
        )
        if (changed) {
          threadRuntimeEntriesTouched++
        }

        return next ? [next] : []
      })

      const prunedSupervision = pruneBatchSupervisorState(
        streamId,
        workstreamState.supervision,
        batchId,
        threadIdSet,
        now,
      )
      workstreamState.supervision = prunedSupervision.supervision

      return {
        batchId,
        threadIds,
        itemCount: threadIds.length,
        itemsReset,
        itemReportsCleared,
        itemBreadcrumbsCleared,
        itemRuntimeBatchCleared,
        threadRuntimeEntriesTouched,
        supervision: {
          runsTouched: prunedSupervision.runsTouched,
          branchSessionsRemoved: prunedSupervision.branchSessionsRemoved,
          reviewedBatchesRemoved: prunedSupervision.reviewedBatchesRemoved,
          issueSummariesRemoved: prunedSupervision.issueSummariesRemoved,
          fixCyclesRemoved: prunedSupervision.fixCyclesRemoved,
          escalationsRemoved: prunedSupervision.escalationsRemoved,
          stageStopsRemoved: prunedSupervision.stageStopsRemoved,
          activeRunCleared: prunedSupervision.activeRunCleared,
          currentBranchCleared: prunedSupervision.currentBranchCleared,
        },
        now,
      }
    } })

  const { now: _now, ...summary } = result

  const artifacts = {
    completionMarkersRemoved: cleanupCompletionMarkers(streamId, summary.threadIds),
    sessionFilesRemoved: cleanupSessionFiles(streamId, summary.threadIds),
    resultFilesRemoved: cleanupResultFiles(streamId, summary.threadIds),
    workingSessionFilesRemoved: 0,
    synthesisOutputsRemoved: 0,
    synthesisLogsRemoved: 0,
  }

  for (const threadId of summary.threadIds) {
    if (cleanupExtraArtifact(getWorkingAgentSessionPath(streamId, threadId))) {
      artifacts.workingSessionFilesRemoved += 1
    }
    if (cleanupExtraArtifact(getSynthesisOutputPath(streamId, threadId))) {
      artifacts.synthesisOutputsRemoved += 1
    }
    if (cleanupExtraArtifact(getSynthesisLogPath(streamId, threadId))) {
      artifacts.synthesisLogsRemoved += 1
    }
  }
  return {
    ...summary,
    artifacts,
  }
}
