import type { BatchStatusFile } from "../batch-status.ts"
import { listThreadExecutionItemsByThreadId } from "../thread-execution.ts"
import { loadThreads } from "../threads.ts"
import { normalizeReviewerResult } from "../reviewer/output.ts"
import type { ReviewerResult } from "../reviewer/types.ts"

export interface SupervisorThreadReviewInput {
  threadId: string
  threadName: string
  status: BatchStatusFile["threads"][number]["status"]
  startedAt?: string
  updatedAt: string
  completedAt?: string
  currentSessionId?: string
  opencodeSessionId?: string
  workingAgentSessionId?: string
  promptPath?: string
  sessionCount: number
  completedSessionCount: number
  itemStatuses: Array<{
    itemId: string
    status: string
    name: string
    report?: string
  }>
}

export interface SupervisorBatchReviewInput {
  streamId: string
  stageId: string
  batchId: string
  runId: string
  stageName?: string
  batchName?: string
  batchStatus: BatchStatusFile
  threads: SupervisorThreadReviewInput[]
}

function getStageId(batchId: string): string {
  const [stageId] = batchId.split(".")
  if (!stageId) {
    throw new Error(`Invalid batch ID \"${batchId}\"`)
  }

  return stageId
}

export function collectSupervisorReviewInput(
  repoRoot: string,
  streamId: string,
  batchStatus: BatchStatusFile,
): SupervisorBatchReviewInput {
  const threadsFile = loadThreads(repoRoot, streamId)

  const threads = batchStatus.threads.map((thread) => {
    const items = listThreadExecutionItemsByThreadId(repoRoot, streamId, thread.threadId)
    const threadMeta = threadsFile?.threads.find((candidate) => candidate.threadId === thread.threadId)

    return {
      threadId: thread.threadId,
      threadName: thread.threadName,
      status: thread.status,
      startedAt: thread.startedAt,
      updatedAt: thread.updatedAt,
      completedAt: thread.completedAt,
      currentSessionId: thread.currentSessionId ?? threadMeta?.currentSessionId,
      opencodeSessionId: thread.opencodeSessionId ?? threadMeta?.opencodeSessionId,
      workingAgentSessionId: thread.workingAgentSessionId ?? threadMeta?.workingAgentSessionId,
      promptPath: threadMeta?.promptPath,
      sessionCount: threadMeta?.sessions.length ?? 0,
      completedSessionCount: threadMeta?.sessions.filter((session) => session.completedAt).length ?? 0,
      itemStatuses: items.map((item) => ({
        itemId: item.id,
        status: item.status,
        name: item.name,
        report: item.report?.trim() || undefined,
      })),
    }
  })

  return {
    streamId,
    stageId: getStageId(batchStatus.batchId),
    batchId: batchStatus.batchId,
    runId: batchStatus.runId,
    stageName: batchStatus.stageName,
    batchName: batchStatus.batchName,
    batchStatus,
    threads,
  }
}

export function getReviewAffectedThreadIds(input: SupervisorBatchReviewInput): string[] {
  const impacted = new Set<string>()

  for (const thread of input.threads) {
    const hasIncompleteItem = thread.itemStatuses.some(
      (task) => task.status !== "completed" && task.status !== "cancelled",
    )

    if (thread.status === "failed" || hasIncompleteItem) {
      impacted.add(thread.threadId)
    }
  }

  return Array.from(impacted).sort()
}

export function runDeterministicSupervisorReview(
  input: SupervisorBatchReviewInput,
): ReviewerResult {
  const issues: ReviewerResult["issues"] = []
  const missingOutputs: string[] = []
  const notes: string[] = [
    `Batch status: ${input.batchStatus.status}`,
    `Threads: ${input.batchStatus.summary.completed}/${input.batchStatus.summary.total} completed`,
  ]

  for (const thread of input.threads) {
    const completedItems = thread.itemStatuses.filter((item) => item.status === "completed")
    const reportedItems = completedItems.filter((item) => item.report)

    notes.push(
      `${thread.threadId}: ${thread.status}, ${reportedItems.length}/${completedItems.length} completed item report(s), ${thread.sessionCount} recorded session(s)`,
    )

    if (thread.status === "failed") {
      issues.push({
        summary: `${thread.threadId} (${thread.threadName}) failed during headless execution.`,
        severity: "high",
        difficulty: "regular",
        ownership: "engineering",
        effort: "items",
        evidence: [
          `Batch status marked thread ${thread.threadId} as failed.`,
          thread.opencodeSessionId ? `opencodeSessionId=${thread.opencodeSessionId}` : null,
          thread.workingAgentSessionId ? `workingAgentSessionId=${thread.workingAgentSessionId}` : null,
          thread.currentSessionId ? `currentSessionId=${thread.currentSessionId}` : null,
          reportedItems.length > 0
            ? `item reports: ${reportedItems.map((item) => `${item.itemId}: ${item.report}`).join(" | ")}`
            : null,
        ].filter(Boolean).join(" "),
        suggestedAction: "Inspect the failed thread session and resolve the blocking implementation issue.",
      })
    }

    const incompleteItems = thread.itemStatuses.filter(
      (item) => item.status !== "completed" && item.status !== "cancelled",
    )
    if (incompleteItems.length > 0) {
      issues.push({
        summary: `${thread.threadId} (${thread.threadName}) still has ${incompleteItems.length} incomplete item(s).`,
        severity: thread.status === "failed" ? "high" : "medium",
        difficulty: "regular",
        ownership: "engineering",
        effort: "items",
        evidence: incompleteItems.map((item) => {
          const reportSuffix = item.report ? ` (${item.report})` : ""
          return `${item.itemId}=${item.status}${reportSuffix}`
        }).join(", "),
        suggestedAction: "Review the remaining items and rerun or follow up before continuing automatically.",
      })
    }
  }

  const normalized = normalizeReviewerResult({
    schemaVersion: "1.0",
    alignment:
      issues.length === 0 && missingOutputs.length === 0
        ? {
            status: "aligned",
            rationale: "All threads completed and no deterministic review issues were detected.",
          }
        : issues.some((issue) => issue.severity === "high")
          ? {
              status: "misaligned",
              rationale: "At least one high-severity execution or completion issue blocks automatic continuation.",
            }
          : {
              status: "partially_aligned",
              rationale: "The batch produced usable output, but follow-up review findings remain.",
            },
    missingOutputs,
    issues,
    confidence: issues.some((issue) => issue.severity === "high") ? "high" : "medium",
    notes,
  })

  if (!normalized.success) {
    throw new Error(
      `Failed to normalize deterministic supervisor review: ${normalized.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join("; ")}`,
    )
  }

  return normalized.value
}
