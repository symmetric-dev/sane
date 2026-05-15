import { hydrateLegacyFilesystemStateToSqliteSync } from "./storage-adapter.ts"
import { formatTaskId, replaceTasks } from "./tasks.ts"

import type { StreamDocument, Task } from "./types.ts"

function deriveThreadCompatibilityTaskName(summary: string, details: string, threadName: string): string {
  const normalizedSummary = summary.trim()
  if (normalizedSummary.length > 0) {
    return normalizedSummary
  }

  const firstDetailLine = details
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return firstDetailLine && firstDetailLine.length > 0
    ? firstDetailLine
    : threadName
}

export function deriveCompatibilityTasksFromPlan(doc: StreamDocument): Task[] {
  const now = new Date().toISOString()

  return doc.stages.flatMap((stage) =>
    stage.batches.flatMap((batch) =>
      batch.threads.map((thread) => ({
        id: formatTaskId(stage.id, batch.id, thread.id, 1),
        name: deriveThreadCompatibilityTaskName(thread.summary, thread.details, thread.name),
        thread_name: thread.name,
        batch_name: batch.name,
        stage_name: stage.name,
        created_at: now,
        updated_at: now,
        status: "pending" as const,
      })),
    ),
  )
}

export function syncCompatibilityTasksFromPlan(
  repoRoot: string,
  streamId: string,
  doc: StreamDocument,
): Task[] {
  const tasks = deriveCompatibilityTasksFromPlan(doc)
  replaceTasks(repoRoot, streamId, tasks)
  hydrateLegacyFilesystemStateToSqliteSync({
    repoRoot,
    streamId,
    projectLegacyRuntimeCompatibilityArtifacts: true,
  })
  return tasks
}
