import type { BatchStatusFile } from "../batch-status.ts"
import { getTasksByThread, parseTaskId } from "../tasks.ts"
import { loadThreads } from "../threads.ts"
import { normalizeReviewerResult } from "../reviewer/output.ts"
import type { ReviewerResult } from "../reviewer/types.ts"

export interface SupervisorThreadReviewInput {
  threadId: string
  threadName: string
  status: BatchStatusFile["threads"][number]["status"]
  synthesisOutput?: string
  taskStatuses: Array<{
    taskId: string
    status: string
    name: string
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
    const parsedThread = parseTaskId(`${thread.threadId}.01`)
    const tasks = getTasksByThread(
      repoRoot,
      streamId,
      parsedThread.stage,
      parsedThread.batch,
      parsedThread.thread,
    )
    const threadMeta = threadsFile?.threads.find((candidate) => candidate.threadId === thread.threadId)

    return {
      threadId: thread.threadId,
      threadName: thread.threadName,
      status: thread.status,
      synthesisOutput: threadMeta?.synthesis?.output?.trim() || undefined,
      taskStatuses: tasks.map((task) => ({
        taskId: task.id,
        status: task.status,
        name: task.name,
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
    const hasIncompleteTask = thread.taskStatuses.some(
      (task) => task.status !== "completed" && task.status !== "cancelled",
    )
    const missingSynthesis = thread.status === "completed" && !thread.synthesisOutput

    if (thread.status === "failed" || hasIncompleteTask || missingSynthesis) {
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
    if (thread.status === "failed") {
      issues.push({
        summary: `${thread.threadId} (${thread.threadName}) failed during headless execution.`,
        severity: "high",
        difficulty: "regular",
        ownership: "engineering",
        effort: "tasks",
        evidence: `Batch status marked thread ${thread.threadId} as failed.`,
        suggestedAction: "Inspect the failed thread session and resolve the blocking implementation issue.",
      })
    }

    if (thread.status === "completed" && !thread.synthesisOutput) {
      const summary = `Synthesis output for ${thread.threadId} (${thread.threadName}) is missing.`
      missingOutputs.push(summary)
      issues.push({
        summary,
        severity: "low",
        difficulty: "regular",
        ownership: "engineering",
        effort: "tasks",
        evidence: `No synthesis output was stored in threads.json for ${thread.threadId}.`,
        suggestedAction: "Re-run the thread or regenerate its summary before continuing automatically.",
      })
    }

    const incompleteTasks = thread.taskStatuses.filter(
      (task) => task.status !== "completed" && task.status !== "cancelled",
    )
    if (incompleteTasks.length > 0) {
      issues.push({
        summary: `${thread.threadId} (${thread.threadName}) still has ${incompleteTasks.length} incomplete task(s).`,
        severity: thread.status === "failed" ? "high" : "medium",
        difficulty: "regular",
        ownership: "engineering",
        effort: "tasks",
        evidence: incompleteTasks.map((task) => `${task.taskId}=${task.status}`).join(", "),
        suggestedAction: "Review the remaining tasks and rerun or follow up before continuing automatically.",
      })
    }
  }

  if (missingOutputs.length > 0) {
    notes.push(`Missing outputs: ${missingOutputs.length}`)
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
