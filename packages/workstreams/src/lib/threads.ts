/**
 * threads.json read/write operations
 *
 * This module handles all operations on the threads.json file which stores
 * thread-level metadata including session history and GitHub issue links.
 * This data is separated from tasks.json to keep task definitions clean.
 */

import { existsSync } from "fs"
import * as lockfile from "proper-lockfile"
import type {
  RootAgentLineage,
  ThreadMetadata,
  ThreadsJson,
  SessionRecord,
  TasksFile,
} from "./types.ts"
import type { ThreadSynthesis } from "./synthesis/types.ts"
import {
  createEmptyTasksFile,
  getTasksFilePath,
  modifyTasksFile,
  normalizeRuntimeState,
  readTasksFile,
  writeTasksFile,
} from "./tasks.ts"

const THREADS_FILE_VERSION = "1.0.0"

/**
 * Get the path to threads.json for a workstream
 */
export function getThreadsFilePath(repoRoot: string, streamId: string): string {
  return getTasksFilePath(repoRoot, streamId)
}

/**
 * Create an empty threads.json structure
 */
export function createEmptyThreadsFile(streamId: string): ThreadsJson {
  return {
    version: THREADS_FILE_VERSION,
    stream_id: streamId,
    last_updated: new Date().toISOString(),
    threads: [],
  }
}

// ============================================
// BASIC READ/WRITE OPERATIONS
// ============================================

/**
 * Read threads.json from a workstream directory
 * Returns null if file doesn't exist
 */
export function loadThreads(
  repoRoot: string,
  streamId: string,
): ThreadsJson | null {
  const tasksFile = readTasksFile(repoRoot, streamId)
  if (!tasksFile) {
    return null
  }

  const runtimeState = normalizeRuntimeState(streamId, tasksFile.runtime_state)
  return {
    version: THREADS_FILE_VERSION,
    stream_id: streamId,
    last_updated: runtimeState.last_updated,
    threads: runtimeState.threads,
  }
}

/**
 * Write threads.json to a workstream directory
 */
export function saveThreads(
  repoRoot: string,
  streamId: string,
  threadsFile: ThreadsJson,
): void {
  const tasksFile = readTasksFile(repoRoot, streamId) ?? createEmptyTasksFile(streamId)
  tasksFile.runtime_state = normalizeRuntimeState(streamId, tasksFile.runtime_state)
  tasksFile.runtime_state.last_updated = new Date().toISOString()
  tasksFile.runtime_state.threads = threadsFile.threads
  delete tasksFile.runtime_summary
  writeTasksFile(repoRoot, streamId, tasksFile)
}

// ============================================
// THREAD METADATA CRUD OPERATIONS
// ============================================

/**
 * Get metadata for a specific thread
 * Returns null if thread not found
 */
export function getThreadMetadata(
  repoRoot: string,
  streamId: string,
  threadId: string,
): ThreadMetadata | null {
  const threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) return null

  return threadsFile.threads.find((t) => t.threadId === threadId) || null
}

/**
 * Update metadata for a specific thread
 * Creates the thread if it doesn't exist
 * Returns the updated thread metadata
 */
export function updateThreadMetadata(
  repoRoot: string,
  streamId: string,
  threadId: string,
  data: Partial<Omit<ThreadMetadata, "threadId">>,
): ThreadMetadata {
  let threadsFile = loadThreads(repoRoot, streamId)

  if (!threadsFile) {
    threadsFile = createEmptyThreadsFile(streamId)
  }

  const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId)

  if (threadIndex === -1) {
    // Create new thread metadata
    const newThread: ThreadMetadata = {
      threadId,
      sessions: data.sessions || [],
      ...(data.promptPath && { promptPath: data.promptPath }),
      ...(data.currentSessionId && { currentSessionId: data.currentSessionId }),
      ...(data.opencodeSessionId && { opencodeSessionId: data.opencodeSessionId }),
    }
    threadsFile.threads.push(newThread)
    saveThreads(repoRoot, streamId, threadsFile)
    return newThread
  }

  // Update existing thread
  const thread = threadsFile.threads[threadIndex]!
  if (data.promptPath !== undefined) thread.promptPath = data.promptPath
  if (data.sessions !== undefined) thread.sessions = data.sessions
  if (data.currentSessionId !== undefined) thread.currentSessionId = data.currentSessionId
  if (data.opencodeSessionId !== undefined) thread.opencodeSessionId = data.opencodeSessionId

  saveThreads(repoRoot, streamId, threadsFile)
  return thread
}

/**
 * Delete thread metadata
 * Returns true if thread was deleted, false if not found
 */
export function deleteThreadMetadata(
  repoRoot: string,
  streamId: string,
  threadId: string,
): boolean {
  const threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) return false

  const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId)
  if (threadIndex === -1) return false

  threadsFile.threads.splice(threadIndex, 1)
  saveThreads(repoRoot, streamId, threadsFile)
  return true
}

/**
 * Get all thread metadata for a workstream
 */
export function getAllThreadMetadata(
  repoRoot: string,
  streamId: string,
): ThreadMetadata[] {
  const threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) return []
  return threadsFile.threads
}

// ============================================
// FILE LOCKING FOR CONCURRENT ACCESS
// ============================================

/**
 * Execute a function with file lock on threads.json
 * Used for safe concurrent writes from multiple parallel threads
 */
async function withThreadsLock<T>(
  threadsPath: string,
  fn: () => T
): Promise<T> {
  if (!existsSync(threadsPath)) {
    const streamId = threadsPath.split("/").at(-2)
    const repoRoot = threadsPath.slice(0, threadsPath.indexOf("/work/"))
    if (streamId && repoRoot) {
      writeTasksFile(repoRoot, streamId, createEmptyTasksFile(streamId))
    }
  }

  const release = await lockfile.lock(threadsPath, {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 500 }
  })
  try {
    return fn()
  } finally {
    await release()
  }
}

/**
 * Update thread metadata with file locking (safe for concurrent access)
 */
export async function updateThreadMetadataLocked(
  repoRoot: string,
  streamId: string,
  threadId: string,
  data: Partial<Omit<ThreadMetadata, "threadId">>,
): Promise<ThreadMetadata> {
  return modifyTasksFile(repoRoot, streamId, () => updateThreadMetadata(repoRoot, streamId, threadId, data))
}

/**
 * Atomic read-modify-write operation on threads.json with file locking
 */
export async function modifyThreads<T>(
  repoRoot: string,
  streamId: string,
  fn: (threadsFile: ThreadsJson) => T
): Promise<T> {
  return modifyTasksFile(repoRoot, streamId, () => {
    let threadsFile = loadThreads(repoRoot, streamId)
    if (!threadsFile) {
      threadsFile = createEmptyThreadsFile(streamId)
    }
    const result = fn(threadsFile)
    saveThreads(repoRoot, streamId, threadsFile)
    return result
  })
}

// ============================================
// SESSION MANAGEMENT ON THREADS
// ============================================

/**
 * Start a new session for a thread
 * Creates a SessionRecord with 'running' status and sets it as currentSessionId
 */
export function startThreadSession(
  repoRoot: string,
  streamId: string,
  threadId: string,
  agentName: string,
  model: string,
  sessionId: string,
  lineage?: RootAgentLineage,
): SessionRecord {
  const session: SessionRecord = {
    sessionId,
    agentName,
    model,
    startedAt: new Date().toISOString(),
    status: "running",
    ...(lineage ? { lineage } : {}),
  }

  let threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) {
    threadsFile = createEmptyThreadsFile(streamId)
  }

  const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId)

  if (threadIndex === -1) {
    // Create new thread with session
    threadsFile.threads.push({
      threadId,
      sessions: [session],
      currentSessionId: sessionId,
    })
  } else {
    // Add session to existing thread
    threadsFile.threads[threadIndex]!.sessions.push(session)
    threadsFile.threads[threadIndex]!.currentSessionId = sessionId
  }

  saveThreads(repoRoot, streamId, threadsFile)
  return session
}

/**
 * Complete a session for a thread
 * Updates the session status and clears currentSessionId
 */
export function completeThreadSession(
  repoRoot: string,
  streamId: string,
  threadId: string,
  sessionId: string,
  status: SessionRecord["status"],
  exitCode?: number,
): SessionRecord | null {
  const threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) return null

  const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId)
  if (threadIndex === -1) return null

  const thread = threadsFile.threads[threadIndex]!
  const sessionIndex = thread.sessions.findIndex((s) => s.sessionId === sessionId)
  if (sessionIndex === -1) return null

  const session = thread.sessions[sessionIndex]!
  session.status = status
  session.completedAt = new Date().toISOString()
  if (exitCode !== undefined) {
    session.exitCode = exitCode
  }

  // Clear currentSessionId
  thread.currentSessionId = undefined

  saveThreads(repoRoot, streamId, threadsFile)
  return session
}

/**
 * Start a session with file locking (safe for concurrent access)
 */
export async function startThreadSessionLocked(
  repoRoot: string,
  streamId: string,
  threadId: string,
  agentName: string,
  model: string,
  sessionId: string,
  lineage?: RootAgentLineage,
): Promise<SessionRecord> {
  const filePath = getThreadsFilePath(repoRoot, streamId)

  return withThreadsLock(filePath, () => {
    return startThreadSession(repoRoot, streamId, threadId, agentName, model, sessionId, lineage)
  })
}

/**
 * Complete a session with file locking (safe for concurrent access)
 */
export async function completeThreadSessionLocked(
  repoRoot: string,
  streamId: string,
  threadId: string,
  sessionId: string,
  status: SessionRecord["status"],
  exitCode?: number,
): Promise<SessionRecord | null> {
  const filePath = getThreadsFilePath(repoRoot, streamId)

  return withThreadsLock(filePath, () => {
    return completeThreadSession(repoRoot, streamId, threadId, sessionId, status, exitCode)
  })
}

/**
 * Start multiple thread sessions atomically with file locking
 */
export async function startMultipleThreadSessionsLocked(
  repoRoot: string,
  streamId: string,
  sessions: Array<{
    threadId: string
    agentName: string
    model: string
    sessionId: string
    lineage?: RootAgentLineage
  }>,
): Promise<SessionRecord[]> {
  const filePath = getThreadsFilePath(repoRoot, streamId)

  return withThreadsLock(filePath, () => {
    let threadsFile = loadThreads(repoRoot, streamId)
    if (!threadsFile) {
      threadsFile = createEmptyThreadsFile(streamId)
    }

    const createdSessions: SessionRecord[] = []
    const now = new Date().toISOString()

    for (const sessionInfo of sessions) {
      const session: SessionRecord = {
        sessionId: sessionInfo.sessionId,
        agentName: sessionInfo.agentName,
        model: sessionInfo.model,
        startedAt: now,
        status: "running",
        ...(sessionInfo.lineage ? { lineage: sessionInfo.lineage } : {}),
      }

      const threadIndex = threadsFile.threads.findIndex(
        (t) => t.threadId === sessionInfo.threadId
      )

      if (threadIndex === -1) {
        threadsFile.threads.push({
          threadId: sessionInfo.threadId,
          sessions: [session],
          currentSessionId: sessionInfo.sessionId,
        })
      } else {
        threadsFile.threads[threadIndex]!.sessions.push(session)
        threadsFile.threads[threadIndex]!.currentSessionId = sessionInfo.sessionId
      }

      createdSessions.push(session)
    }

    saveThreads(repoRoot, streamId, threadsFile)
    return createdSessions
  })
}

/**
 * Complete multiple thread sessions atomically with file locking
 */
export async function completeMultipleThreadSessionsLocked(
  repoRoot: string,
  streamId: string,
  completions: Array<{
    threadId: string
    sessionId: string
    status: SessionRecord["status"]
    exitCode?: number
  }>,
): Promise<SessionRecord[]> {
  const filePath = getThreadsFilePath(repoRoot, streamId)

  return withThreadsLock(filePath, () => {
    const threadsFile = loadThreads(repoRoot, streamId)
    if (!threadsFile) return []

    const updatedSessions: SessionRecord[] = []
    const now = new Date().toISOString()

    for (const completion of completions) {
      const threadIndex = threadsFile.threads.findIndex(
        (t) => t.threadId === completion.threadId
      )
      if (threadIndex === -1) continue

      const thread = threadsFile.threads[threadIndex]!
      const sessionIndex = thread.sessions.findIndex(
        (s) => s.sessionId === completion.sessionId
      )
      if (sessionIndex === -1) continue

      const session = thread.sessions[sessionIndex]!
      session.status = completion.status
      session.completedAt = now
      if (completion.exitCode !== undefined) {
        session.exitCode = completion.exitCode
      }

      thread.currentSessionId = undefined
      updatedSessions.push(session)
    }

    if (updatedSessions.length > 0) {
      saveThreads(repoRoot, streamId, threadsFile)
    }

    return updatedSessions
  })
}

// ============================================
// GITHUB ISSUE MANAGEMENT
// ============================================

/**
 * @deprecated GitHub issue storage has been removed from threads.json.
 * Issues are now stored in github.json per-stage.
 * This function is a no-op kept for backward compatibility.
 */
export function setThreadGitHubIssue(
  _repoRoot: string,
  _streamId: string,
  _threadId: string,
  _issue: { number: number; url: string; state: "open" | "closed" },
): ThreadMetadata | null {
  // No-op: GitHub issues are now stored in github.json per-stage
  return null
}

/**
 * @deprecated GitHub issue storage has been removed from threads.json.
 * Issues are now stored in github.json per-stage.
 * This function returns null for backward compatibility.
 */
export function getThreadGitHubIssue(
  _repoRoot: string,
  _streamId: string,
  _threadId: string,
): null {
  // No-op: GitHub issues are now stored in github.json per-stage
  return null
}

// ============================================
// SYNTHESIS OUTPUT MANAGEMENT
// ============================================

/**
 * Set synthesis output for a thread
 * 
 * Stores the synthesis result from a synthesis agent run.
 * Uses file locking for safe concurrent access.
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param threadId - Thread ID (e.g., "01.02.03")
 * @param synthesis - The synthesis output to store
 * @returns Promise that resolves when the synthesis is saved
 */
export async function setSynthesisOutput(
  repoRoot: string,
  streamId: string,
  threadId: string,
  synthesis: ThreadSynthesis,
): Promise<void> {
  const filePath = getThreadsFilePath(repoRoot, streamId)

  await withThreadsLock(filePath, () => {
    let threadsFile = loadThreads(repoRoot, streamId)
    if (!threadsFile) {
      threadsFile = createEmptyThreadsFile(streamId)
    }

    const threadIndex = threadsFile.threads.findIndex((t) => t.threadId === threadId)

    if (threadIndex === -1) {
      console.warn(`[threads] setSynthesisOutput: Thread ${threadId} not found in stream ${streamId}`)
      return
    }

    threadsFile.threads[threadIndex]!.synthesis = synthesis
    saveThreads(repoRoot, streamId, threadsFile)
  })
}

/**
 * Get synthesis output for a thread
 * 
 * Retrieves the synthesis result if it exists for the thread.
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param threadId - Thread ID (e.g., "01.02.03")
 * @returns The synthesis output if found, null otherwise
 */
export function getSynthesisOutput(
  repoRoot: string,
  streamId: string,
  threadId: string,
): ThreadSynthesis | null {
  const thread = getThreadMetadata(repoRoot, streamId, threadId)
  
  if (!thread) {
    console.warn(`[threads] getSynthesisOutput: Thread ${threadId} not found in stream ${streamId}`)
    return null
  }

  return thread.synthesis || null
}

// ============================================
// CONVENIENCE HELPERS
// ============================================

/**
 * Get the last (most recent) session for a thread
 *
 * Sessions are sorted by startedAt timestamp descending,
 * returning the most recently started session.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param threadId - Thread ID (e.g., "01.02.03")
 * @returns Most recent session record, or null if no sessions exist
 */
export function getLastSessionForThread(
  repoRoot: string,
  streamId: string,
  threadId: string,
): SessionRecord | null {
  const thread = getThreadMetadata(repoRoot, streamId, threadId)
  if (!thread || thread.sessions.length === 0) {
    return null
  }

  // Sort by startedAt descending and return most recent
  const sortedSessions = [...thread.sessions].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  )

  return sortedSessions[0] || null
}

/**
 * Get the opencode session ID for a thread
 *
 * This is the session ID captured from opencode after a multi run,
 * which can be used to resume the session in opencode TUI.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param threadId - Thread ID (e.g., "01.02.03")
 * @returns Opencode session ID string, or null if not set
 */
export function getOpencodeSessionId(
  repoRoot: string,
  streamId: string,
  threadId: string,
): string | null {
  const thread = getThreadMetadata(repoRoot, streamId, threadId)
  return thread?.opencodeSessionId || null
}

/**
 * Set the working agent session ID for a thread (legacy/backwards compatibility)
 *
 * Note: In post-session synthesis mode, the working agent session is stored
 * as the primary opencodeSessionId since synthesis runs headless. This field
 * is maintained for backwards compatibility with older synthesis mode.
 *
 * This session ID can be used to resume the working agent's session directly.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param threadId - Thread ID (e.g., "01.02.03")
 * @param sessionId - The working agent's opencode session ID
 * @returns Updated thread metadata object containing the new workingAgentSessionId
 */
export function setWorkingAgentSessionId(
  repoRoot: string,
  streamId: string,
  threadId: string,
  sessionId: string,
): ThreadMetadata {
  return updateThreadMetadata(repoRoot, streamId, threadId, {
    workingAgentSessionId: sessionId,
  })
}

/**
 * Get the working agent session ID for a thread
 *
 * Returns the opencode session ID of the working agent specifically.
 * When synthesis is enabled, this is different from opencodeSessionId
 * (which would be the synthesis agent's session).
 *
 * Use this when available, falling back to `opencodeSessionId`
 * for backwards compatibility.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param threadId - Thread ID (e.g., "01.02.03")
 * @returns The session ID string if found, or null if the thread has no working agent session
 */
export function getWorkingAgentSessionId(
  repoRoot: string,
  streamId: string,
  threadId: string,
): string | null {
  const thread = getThreadMetadata(repoRoot, streamId, threadId)
  return thread?.workingAgentSessionId || null
}

// ============================================
// MIGRATION UTILITIES
// ============================================

/**
 * Extract thread ID from task ID
 * Task ID format: "SS.BB.TT.NN" -> Thread ID: "SS.BB.TT"
 */
function extractThreadIdFromTaskId(taskId: string): string | null {
  const parts = taskId.split(".")
  if (parts.length !== 4) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}`
}

/**
 * Migration result structure
 */
export interface MigrationResult {
  threadsCreated: number
  sessionsMigrated: number
  errors: string[]
}

/**
 * Migrate session and GitHub issue data from tasks.json to threads.json
 * This is a one-time migration utility for transitioning to the new structure.
 * 
 * The migration:
 * 1. Reads tasks.json and extracts sessions and githubIssue from tasks
 * 2. Groups them by thread ID
 * 3. Creates/updates thread entries in threads.json
 * 4. Does NOT modify tasks.json (caller should clean up after verifying migration)
 * 
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @returns Migration result with counts and any errors
 */
export function migrateFromTasksJson(
  repoRoot: string,
  streamId: string,
  tasksFile: TasksFile,
): MigrationResult {
  const result: MigrationResult = {
    threadsCreated: 0,
    sessionsMigrated: 0,
    errors: [],
  }

  // Load or create threads.json
  let threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) {
    threadsFile = createEmptyThreadsFile(streamId)
  }

  // Build a map of existing threads for quick lookup
  const threadMap = new Map<string, ThreadMetadata>()
  for (const thread of threadsFile.threads) {
    threadMap.set(thread.threadId, thread)
  }

  // Group tasks by thread ID
  const tasksByThread = new Map<string, typeof tasksFile.tasks>()
  for (const task of tasksFile.tasks) {
    const threadId = extractThreadIdFromTaskId(task.id)
    if (!threadId) {
      result.errors.push(`Invalid task ID format: ${task.id}`)
      continue
    }

    if (!tasksByThread.has(threadId)) {
      tasksByThread.set(threadId, [])
    }
    tasksByThread.get(threadId)!.push(task)
  }

  // Process each thread
  for (const [threadId, tasks] of tasksByThread) {
    // Get or create thread metadata
    let thread = threadMap.get(threadId)
    const isNew = !thread

    if (!thread) {
      thread = {
        threadId,
        sessions: [],
      }
      threadMap.set(threadId, thread)
      result.threadsCreated++
    }

    // Collect sessions from all tasks in this thread
    for (const task of tasks) {
      if (task.sessions && task.sessions.length > 0) {
        // Append sessions, avoiding duplicates by sessionId
        const existingSessionIds = new Set(thread.sessions.map((s) => s.sessionId))
        for (const session of task.sessions) {
          if (!existingSessionIds.has(session.sessionId)) {
            thread.sessions.push(session)
            result.sessionsMigrated++
          }
        }
      }

      // Use currentSessionId from first task with one (if thread doesn't have one)
      if (!thread.currentSessionId && task.currentSessionId) {
        thread.currentSessionId = task.currentSessionId
      }
    }

    // GitHub issues are now stored in github.json per-stage, not in threads.json
    // Migration of github_issue is no longer performed
  }

  // Update threads array
  threadsFile.threads = Array.from(threadMap.values()).sort((a, b) =>
    a.threadId.localeCompare(b.threadId, undefined, { numeric: true })
  )

  // Save threads.json
  saveThreads(repoRoot, streamId, threadsFile)

  return result
}

/**
 * Validate that migration was successful by comparing threads.json with tasks.json
 * Returns a list of discrepancies if any
 */
export function validateMigration(
  repoRoot: string,
  streamId: string,
  tasksFile: TasksFile,
): string[] {
  const issues: string[] = []

  const threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) {
    issues.push("threads.json does not exist")
    return issues
  }

  // Build thread map for quick lookup
  const threadMap = new Map<string, ThreadMetadata>()
  for (const thread of threadsFile.threads) {
    threadMap.set(thread.threadId, thread)
  }

  // Check each task's data is reflected in threads.json
  for (const task of tasksFile.tasks) {
    const threadId = extractThreadIdFromTaskId(task.id)
    if (!threadId) continue

    const thread = threadMap.get(threadId)
    if (!thread) {
      issues.push(`Thread ${threadId} not found in threads.json`)
      continue
    }

    // Check sessions are present
    if (task.sessions) {
      for (const session of task.sessions) {
        const found = thread.sessions.some((s) => s.sessionId === session.sessionId)
        if (!found) {
          issues.push(`Session ${session.sessionId} from task ${task.id} not found in thread ${threadId}`)
        }
      }
    }

    // GitHub issues are now stored in github.json per-stage, not in threads.json
    // Migration validation for github_issue is no longer performed
  }

  return issues
}
