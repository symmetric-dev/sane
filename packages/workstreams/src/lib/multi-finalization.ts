import { existsSync, readFileSync } from "fs"
import type { NotificationTracker } from "./notifications.ts"
import {
  cleanupCompletionMarkers,
  cleanupResultFiles,
  cleanupSessionFiles,
} from "./marker-polling.ts"
import {
  getRunResultPath,
  getSessionFilePath,
  getCompletionMarkerPath,
} from "./opencode.ts"
import { completeMultipleSessionsLocked } from "./tasks.ts"
import { updateThreadMetadataLocked } from "./threads.ts"
import { getSessionPaneStatuses, sessionExists } from "./tmux.ts"
import type { ThreadSessionMap } from "./types.ts"

type FinalStatus = "completed" | "failed" | "interrupted"

interface StoredRunResult {
  status: "completed" | "failed"
  exitCode?: number
}

export interface FinalizationCompletion {
  taskId: string
  threadId: string
  sessionId: string
  status: FinalStatus
  exitCode?: number
}

export interface FinalizeMultiRunOptions {
  sessionName: string
  threadSessionMap: ThreadSessionMap[]
  threadIds: string[]
  notificationTracker: NotificationTracker | null
  repoRoot: string
  streamId: string
}

export interface FinalizeMultiRunResult {
  completions: FinalizationCompletion[]
  runningThreadIds: string[]
  sessionStillExists: boolean
  cleanup: {
    completionMarkers: number
    sessionFiles: number
    resultFiles: number
    synthesisFiles: number
  }
  exitCode: number
}

function readStoredRunResult(streamId: string, threadId: string): StoredRunResult | null {
  const resultPath = getRunResultPath(streamId, threadId)
  if (!existsSync(resultPath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(resultPath, "utf-8")) as StoredRunResult
    if (parsed.status === "completed" || parsed.status === "failed") {
      return parsed
    }
  } catch {
    // Ignore malformed result files and fall back to tmux status.
  }

  return null
}

function collectCompletions(
  streamId: string,
  sessionName: string,
  threadSessionMap: ThreadSessionMap[],
  notificationTracker: NotificationTracker | null,
): {
  completions: FinalizationCompletion[]
  runningThreadIds: string[]
  sessionStillExists: boolean
} {
  const sessionStillExists = sessionExists(sessionName)
  const paneStatuses = sessionStillExists ? getSessionPaneStatuses(sessionName) : []
  const completions: FinalizationCompletion[] = []
  const runningThreadIds: string[] = []

  for (const mapping of threadSessionMap) {
    const storedResult = readStoredRunResult(streamId, mapping.threadId)
    if (storedResult) {
      completions.push({
        taskId: mapping.taskId,
        threadId: mapping.threadId,
        sessionId: mapping.sessionId,
        status: storedResult.status,
        exitCode: storedResult.exitCode,
      })

      if (storedResult.status === "failed") {
        notificationTracker?.playError(mapping.threadId)
      }

      console.log(
        `  Thread ${mapping.threadId}: ${storedResult.status}${storedResult.exitCode !== undefined ? ` (exit ${storedResult.exitCode})` : ""}`,
      )
      continue
    }

    const paneStatus = paneStatuses.find((pane) => pane.paneId === mapping.paneId)
    if (paneStatus && !paneStatus.paneDead) {
      runningThreadIds.push(mapping.threadId)
      console.log(`  Thread ${mapping.threadId}: still running`)
      continue
    }

    if (paneStatus?.paneDead) {
      const exitCode = paneStatus.exitStatus ?? undefined
      const status: FinalStatus = exitCode === 0 ? "completed" : "failed"
      completions.push({
        taskId: mapping.taskId,
        threadId: mapping.threadId,
        sessionId: mapping.sessionId,
        status,
        exitCode,
      })

      if (status === "failed") {
        notificationTracker?.playError(mapping.threadId)
      }

      console.log(
        `  Thread ${mapping.threadId}: ${status}${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`,
      )
      continue
    }

    if (!sessionStillExists) {
      if (existsSync(getCompletionMarkerPath(streamId, mapping.threadId))) {
        completions.push({
          taskId: mapping.taskId,
          threadId: mapping.threadId,
          sessionId: mapping.sessionId,
          status: "completed",
        })
        console.log(`  Thread ${mapping.threadId}: completed`)
        continue
      }

      completions.push({
        taskId: mapping.taskId,
        threadId: mapping.threadId,
        sessionId: mapping.sessionId,
        status: "interrupted",
      })
      console.log(`  Thread ${mapping.threadId}: interrupted`)
      continue
    }

    runningThreadIds.push(mapping.threadId)
    console.log(`  Thread ${mapping.threadId}: still running`)
  }

  return { completions, runningThreadIds, sessionStillExists }
}

async function captureArtifacts(
  repoRoot: string,
  streamId: string,
  completedMappings: ThreadSessionMap[],
  verbose: boolean,
): Promise<void> {
  if (completedMappings.length === 0) {
    return
  }

  if (verbose) {
    console.log("\nCapturing opencode session IDs...")
  }

  for (const mapping of completedMappings) {
    const sessionFilePath = getSessionFilePath(streamId, mapping.threadId)

    const updateData: {
      opencodeSessionId?: string
    } = {}

    if (existsSync(sessionFilePath)) {
      try {
        const opencodeSessionId = readFileSync(sessionFilePath, "utf-8").trim()
        if (opencodeSessionId) {
          updateData.opencodeSessionId = opencodeSessionId
        }
      } catch (error) {
        if (verbose) {
          console.log(`  Thread ${mapping.threadId}: failed to read session file (${(error as Error).message})`)
        }
      }
    }

    if (updateData.opencodeSessionId) {
      await updateThreadMetadataLocked(repoRoot, streamId, mapping.threadId, updateData)
    }

    if (updateData.opencodeSessionId) {
      if (verbose) {
        console.log(`  Thread ${mapping.threadId}: captured working session ${updateData.opencodeSessionId}`)
      }
    } else {
      if (verbose) {
        console.log(`  Thread ${mapping.threadId}: no session file found`)
      }
    }
  }
}

export async function applyFinalizationCompletions(options: {
  repoRoot: string
  streamId: string
  completions: FinalizationCompletion[]
  verbose?: boolean
}): Promise<{
  completedThreadIds: string[]
  cleanup: {
    completionMarkers: number
    sessionFiles: number
    resultFiles: number
    synthesisFiles: number
  }
}> {
  const { repoRoot, streamId, completions, verbose = true } = options
  if (completions.length === 0) {
    return {
      completedThreadIds: [],
      cleanup: {
        completionMarkers: 0,
        sessionFiles: 0,
        resultFiles: 0,
        synthesisFiles: 0,
      },
    }
  }

  if (verbose) {
    console.log(`\nUpdating ${completions.length} session statuses in tasks.json...`)
  }
  await completeMultipleSessionsLocked(
    repoRoot,
    streamId,
    completions.map(({ taskId, sessionId, status, exitCode }) => ({
      taskId,
      sessionId,
      status,
      exitCode,
    })),
  )

  const completedThreadIds = Array.from(
    new Set(completions.map((completion) => completion.threadId)),
  )
  const completedMappings = completions.map(({ taskId, threadId, sessionId }) => ({
    taskId,
    threadId,
    sessionId,
    paneId: "",
    windowIndex: -1,
  }))

  await captureArtifacts(repoRoot, streamId, completedMappings, verbose)

  return {
    completedThreadIds,
    cleanup: {
      completionMarkers: cleanupCompletionMarkers(streamId, completedThreadIds),
      sessionFiles: cleanupSessionFiles(streamId, completedThreadIds),
      resultFiles: cleanupResultFiles(streamId, completedThreadIds),
      synthesisFiles: 0,
    },
  }
}

export async function finalizeMultiRun(
  options: FinalizeMultiRunOptions,
): Promise<FinalizeMultiRunResult> {
  const {
    sessionName,
    threadSessionMap,
    notificationTracker,
    repoRoot,
    streamId,
  } = options

  const { completions, runningThreadIds, sessionStillExists } = collectCompletions(
    streamId,
    sessionName,
    threadSessionMap,
    notificationTracker,
  )

  const { cleanup } = await applyFinalizationCompletions({
    repoRoot,
    streamId,
    completions,
  })

  if (sessionStillExists) {
    console.log(`\nWindows remain in tmux session "${sessionName}".`)
    console.log(`To reattach: tmux attach -t "${sessionName}"`)
    console.log(`To kill: tmux kill-session -t "${sessionName}"`)
  }

  return {
    completions,
    runningThreadIds,
    sessionStillExists,
    cleanup,
    exitCode: completions.some((completion) => completion.status !== "completed") ? 1 : 0,
  }
}
