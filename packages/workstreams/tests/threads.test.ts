import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  loadThreads,
  saveThreads,
  getThreadMetadata,
  updateThreadMetadata,
  deleteThreadMetadata,
  getAllThreadMetadata,
  createEmptyThreadsFile,
  getThreadsFilePath,
  startThreadSession,
  completeThreadSession,
  startThreadSessionLocked,
  completeThreadSessionLocked,
  startMultipleThreadSessionsLocked,
  completeMultipleThreadSessionsLocked,
  setThreadGitHubIssue,
  getThreadGitHubIssue,
  migrateFromTasksJson,
  validateMigration,
  updateThreadMetadataLocked,
  modifyThreads,
} from "../src/lib/threads"
import type { ThreadsJson, ThreadMetadata, TasksFile, SessionRecord } from "../src/lib/types"
import { generateSessionId } from "../src/lib/tasks"

describe("threads", () => {
  let tempDir: string
  let repoRoot: string
  const streamId = "001-test-stream"

  beforeEach(() => {
    // Create temp directory structure
    tempDir = mkdtempSync(join(tmpdir(), "threads-test-"))
    repoRoot = tempDir
    const workDir = join(repoRoot, "work", streamId)
    mkdirSync(workDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("basic file operations", () => {
    test("loadThreads returns null for non-existent file", () => {
      const result = loadThreads(repoRoot, streamId)
      expect(result).toBeNull()
    })

    test("saveThreads creates file and loadThreads reads it", () => {
      const threadsFile: ThreadsJson = {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        threads: [
          {
            threadId: "01.01.01",
            sessions: [],
          },
        ],
      }

      saveThreads(repoRoot, streamId, threadsFile)

      const filePath = getThreadsFilePath(repoRoot, streamId)
      expect(existsSync(filePath)).toBe(true)

      const loaded = loadThreads(repoRoot, streamId)
      expect(loaded).not.toBeNull()
      expect(loaded!.threads).toHaveLength(1)
      expect(loaded!.threads[0]!.threadId).toBe("01.01.01")
    })

    test("createEmptyThreadsFile creates valid structure", () => {
      const empty = createEmptyThreadsFile(streamId)

      expect(empty.version).toBe("1.0.0")
      expect(empty.stream_id).toBe(streamId)
      expect(empty.threads).toHaveLength(0)
      expect(empty.last_updated).toBeDefined()
    })

    test("getThreadsFilePath returns correct path", () => {
      const path = getThreadsFilePath(repoRoot, streamId)
      expect(path).toContain("work")
      expect(path).toContain(streamId)
      expect(path).toEndWith("threads.json")
    })
  })

  describe("CRUD operations", () => {
    test("getThreadMetadata returns null for non-existent thread", () => {
      const result = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(result).toBeNull()
    })

    test("updateThreadMetadata creates new thread when not exists", () => {
      const thread = updateThreadMetadata(repoRoot, streamId, "01.01.01", {
        sessions: [],
      })

      expect(thread.threadId).toBe("01.01.01")
      expect(thread.sessions).toHaveLength(0)

      const loaded = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(loaded).not.toBeNull()
      expect(loaded!.threadId).toBe("01.01.01")
    })

    test("updateThreadMetadata updates existing thread", () => {
      // Create thread
      updateThreadMetadata(repoRoot, streamId, "01.01.01", {
        sessions: [],
      })

      // Update with currentSessionId
      const updated = updateThreadMetadata(repoRoot, streamId, "01.01.01", {
        currentSessionId: "session-123",
      })

      expect(updated.currentSessionId).toBe("session-123")
    })

    test("deleteThreadMetadata removes thread", () => {
      updateThreadMetadata(repoRoot, streamId, "01.01.01", {
        sessions: [],
      })

      const deleted = deleteThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(deleted).toBe(true)

      const loaded = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(loaded).toBeNull()
    })

    test("deleteThreadMetadata returns false for non-existent thread", () => {
      const deleted = deleteThreadMetadata(repoRoot, streamId, "99.99.99")
      expect(deleted).toBe(false)
    })

    test("getAllThreadMetadata returns all threads", () => {
      updateThreadMetadata(repoRoot, streamId, "01.01.01", { sessions: [] })
      updateThreadMetadata(repoRoot, streamId, "01.01.02", { sessions: [] })
      updateThreadMetadata(repoRoot, streamId, "01.02.01", { sessions: [] })

      const all = getAllThreadMetadata(repoRoot, streamId)
      expect(all).toHaveLength(3)
    })

    test("getAllThreadMetadata returns empty array when no file", () => {
      const all = getAllThreadMetadata(repoRoot, streamId)
      expect(all).toHaveLength(0)
    })

    test("updateThreadMetadata stores opencodeSessionId", () => {
      const thread = updateThreadMetadata(repoRoot, streamId, "01.01.01", {
        sessions: [],
        opencodeSessionId: "ses_413402385ffe4rhZzbpafvjAUc",
      })

      expect(thread.opencodeSessionId).toBe("ses_413402385ffe4rhZzbpafvjAUc")

      const loaded = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(loaded).not.toBeNull()
      expect(loaded!.opencodeSessionId).toBe("ses_413402385ffe4rhZzbpafvjAUc")
    })

    test("updateThreadMetadata can update opencodeSessionId separately", () => {
      // Create thread first
      updateThreadMetadata(repoRoot, streamId, "01.01.01", {
        sessions: [],
      })

      // Update with opcodeSessionId
      const updated = updateThreadMetadata(repoRoot, streamId, "01.01.01", {
        opencodeSessionId: "ses_newSessionId123",
      })

      expect(updated.opencodeSessionId).toBe("ses_newSessionId123")
    })

    test("opencodeSessionId is separate from currentSessionId", () => {
      const thread = updateThreadMetadata(repoRoot, streamId, "01.01.01", {
        sessions: [],
        currentSessionId: "internal-session-id",
        opencodeSessionId: "ses_externalOpencodeSessionId",
      })

      // Both fields should be stored independently
      expect(thread.currentSessionId).toBe("internal-session-id")
      expect(thread.opencodeSessionId).toBe("ses_externalOpencodeSessionId")
    })
  })

  describe("session management", () => {
    test("startThreadSession creates session with running status", () => {
      const sessionId = generateSessionId()
      const session = startThreadSession(
        repoRoot,
        streamId,
        "01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4",
        sessionId
      )

      expect(session.sessionId).toBe(sessionId)
      expect(session.agentName).toBe("test-agent")
      expect(session.model).toBe("anthropic/claude-sonnet-4")
      expect(session.status).toBe("running")
      expect(session.startedAt).toBeDefined()
    })

    test("startThreadSession sets currentSessionId", () => {
      const sessionId = generateSessionId()
      startThreadSession(
        repoRoot,
        streamId,
        "01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4",
        sessionId
      )

      const thread = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(thread!.currentSessionId).toBe(sessionId)
    })

    test("completeThreadSession updates status and clears currentSessionId", () => {
      const sessionId = generateSessionId()
      startThreadSession(
        repoRoot,
        streamId,
        "01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4",
        sessionId
      )

      const completed = completeThreadSession(
        repoRoot,
        streamId,
        "01.01.01",
        sessionId,
        "completed",
        0
      )

      expect(completed).not.toBeNull()
      expect(completed!.status).toBe("completed")
      expect(completed!.exitCode).toBe(0)
      expect(completed!.completedAt).toBeDefined()

      const thread = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(thread!.currentSessionId).toBeUndefined()
    })

    test("completeThreadSession returns null for non-existent session", () => {
      const result = completeThreadSession(
        repoRoot,
        streamId,
        "99.99.99",
        "fake-session",
        "completed"
      )
      expect(result).toBeNull()
    })

    test("multiple sessions are tracked in order", () => {
      const session1Id = generateSessionId()
      const session2Id = generateSessionId()

      startThreadSession(repoRoot, streamId, "01.01.01", "agent-1", "model-1", session1Id)
      completeThreadSession(repoRoot, streamId, "01.01.01", session1Id, "failed", 1)

      startThreadSession(repoRoot, streamId, "01.01.01", "agent-2", "model-2", session2Id)

      const thread = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(thread!.sessions).toHaveLength(2)
      expect(thread!.sessions[0]!.agentName).toBe("agent-1")
      expect(thread!.sessions[0]!.status).toBe("failed")
      expect(thread!.sessions[1]!.agentName).toBe("agent-2")
      expect(thread!.sessions[1]!.status).toBe("running")
    })
  })

  describe("locked operations", () => {
    test("startThreadSessionLocked creates session", async () => {
      const sessionId = generateSessionId()
      const session = await startThreadSessionLocked(
        repoRoot,
        streamId,
        "01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4",
        sessionId
      )

      expect(session.sessionId).toBe(sessionId)
      expect(session.status).toBe("running")
    })

    test("completeThreadSessionLocked updates session", async () => {
      const sessionId = generateSessionId()
      await startThreadSessionLocked(
        repoRoot,
        streamId,
        "01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4",
        sessionId
      )

      const completed = await completeThreadSessionLocked(
        repoRoot,
        streamId,
        "01.01.01",
        sessionId,
        "completed",
        0
      )

      expect(completed).not.toBeNull()
      expect(completed!.status).toBe("completed")
    })

    test("startMultipleThreadSessionsLocked creates multiple sessions atomically", async () => {
      const session1Id = generateSessionId()
      const session2Id = generateSessionId()

      const sessions = await startMultipleThreadSessionsLocked(repoRoot, streamId, [
        {
          threadId: "01.01.01",
          agentName: "agent-1",
          model: "model-1",
          sessionId: session1Id,
        },
        {
          threadId: "01.01.02",
          agentName: "agent-2",
          model: "model-2",
          sessionId: session2Id,
        },
      ])

      expect(sessions).toHaveLength(2)
      expect(sessions[0]!.sessionId).toBe(session1Id)
      expect(sessions[1]!.sessionId).toBe(session2Id)

      const thread1 = getThreadMetadata(repoRoot, streamId, "01.01.01")
      const thread2 = getThreadMetadata(repoRoot, streamId, "01.01.02")

      expect(thread1!.currentSessionId).toBe(session1Id)
      expect(thread2!.currentSessionId).toBe(session2Id)
    })

    test("completeMultipleThreadSessionsLocked updates multiple sessions atomically", async () => {
      const session1Id = generateSessionId()
      const session2Id = generateSessionId()

      await startMultipleThreadSessionsLocked(repoRoot, streamId, [
        { threadId: "01.01.01", agentName: "agent-1", model: "model-1", sessionId: session1Id },
        { threadId: "01.01.02", agentName: "agent-2", model: "model-2", sessionId: session2Id },
      ])

      const completed = await completeMultipleThreadSessionsLocked(repoRoot, streamId, [
        { threadId: "01.01.01", sessionId: session1Id, status: "completed", exitCode: 0 },
        { threadId: "01.01.02", sessionId: session2Id, status: "failed", exitCode: 1 },
      ])

      expect(completed).toHaveLength(2)
      expect(completed[0]!.status).toBe("completed")
      expect(completed[1]!.status).toBe("failed")

      const thread1 = getThreadMetadata(repoRoot, streamId, "01.01.01")
      const thread2 = getThreadMetadata(repoRoot, streamId, "01.01.02")

      expect(thread1!.currentSessionId).toBeUndefined()
      expect(thread2!.currentSessionId).toBeUndefined()
    })

    test("updateThreadMetadataLocked safely updates thread", async () => {
      const thread = await updateThreadMetadataLocked(repoRoot, streamId, "01.01.01", {
        sessions: [],
        currentSessionId: "session-42",
      })

      expect(thread.threadId).toBe("01.01.01")
      expect(thread.currentSessionId).toBe("session-42")
    })

    test("modifyThreads performs atomic read-modify-write", async () => {
      // Create initial thread
      updateThreadMetadata(repoRoot, streamId, "01.01.01", { sessions: [] })

      // Modify atomically
      const result = await modifyThreads(repoRoot, streamId, (threadsFile) => {
        threadsFile.threads.push({
          threadId: "01.01.02",
          sessions: [],
        })
        return threadsFile.threads.length
      })

      expect(result).toBe(2)

      const all = getAllThreadMetadata(repoRoot, streamId)
      expect(all).toHaveLength(2)
    })
  })

  describe("GitHub issue management (deprecated)", () => {
    test("setThreadGitHubIssue is a no-op (deprecated)", () => {
      updateThreadMetadata(repoRoot, streamId, "01.01.01", { sessions: [] })

      // setThreadGitHubIssue is now a no-op, returns null
      const result = setThreadGitHubIssue(repoRoot, streamId, "01.01.01", {
        number: 123,
        url: "https://github.com/test/repo/issues/123",
        state: "open",
      })

      expect(result).toBeNull()
    })

    test("getThreadGitHubIssue returns null (deprecated)", () => {
      updateThreadMetadata(repoRoot, streamId, "01.01.01", { sessions: [] })

      // getThreadGitHubIssue always returns null now
      const issue = getThreadGitHubIssue(repoRoot, streamId, "01.01.01")
      expect(issue).toBeNull()
    })
  })

  describe("migration from tasks.json", () => {
    function createTasksFile(): TasksFile {
      return {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Task 1",
            thread_name: "Thread One",
            batch_name: "Setup",
            stage_name: "Stage One",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "completed",
            sessions: [
              {
                sessionId: "ses_abc123",
                agentName: "test-agent",
                model: "anthropic/claude-sonnet-4",
                startedAt: "2024-01-01T00:00:00.000Z",
                completedAt: "2024-01-01T01:00:00.000Z",
                status: "completed",
                exitCode: 0,
              },
            ],
            currentSessionId: undefined,
          },
          {
            id: "01.01.01.02",
            name: "Task 2",
            thread_name: "Thread One",
            batch_name: "Setup",
            stage_name: "Stage One",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "pending",
            sessions: [
              {
                sessionId: "ses_def456",
                agentName: "test-agent-2",
                model: "google/gemini-2.5-pro",
                startedAt: "2024-01-02T00:00:00.000Z",
                status: "running",
              },
            ],
            currentSessionId: "ses_def456",
          },
          {
            id: "01.01.02.01",
            name: "Task 3",
            thread_name: "Thread Two",
            batch_name: "Setup",
            stage_name: "Stage One",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "pending",
            sessions: [],
          },
        ],
      }
    }

    test("migrateFromTasksJson creates threads.json from tasks.json", () => {
      const tasksFile = createTasksFile()

      const result = migrateFromTasksJson(repoRoot, streamId, tasksFile)

      expect(result.threadsCreated).toBe(2) // 01.01.01 and 01.01.02
      expect(result.sessionsMigrated).toBe(2) // ses_abc123 and ses_def456
      // Note: githubIssuesMigrated was removed - issues now stored in github.json
      expect(result.errors).toHaveLength(0)
    })

    test("migrateFromTasksJson groups tasks by thread", () => {
      const tasksFile = createTasksFile()

      migrateFromTasksJson(repoRoot, streamId, tasksFile)

      const thread1 = getThreadMetadata(repoRoot, streamId, "01.01.01")
      const thread2 = getThreadMetadata(repoRoot, streamId, "01.01.02")

      expect(thread1).not.toBeNull()
      expect(thread1!.sessions).toHaveLength(2) // Sessions from both tasks in thread
      // Note: githubIssue removed - issues now stored in github.json

      expect(thread2).not.toBeNull()
      expect(thread2!.sessions).toHaveLength(0) // Empty sessions array
    })

    test("migrateFromTasksJson preserves currentSessionId", () => {
      const tasksFile = createTasksFile()

      migrateFromTasksJson(repoRoot, streamId, tasksFile)

      const thread = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(thread!.currentSessionId).toBe("ses_def456") // From task 2
    })

    test("migrateFromTasksJson handles invalid task IDs", () => {
      const tasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "invalid-id",
            name: "Bad Task",
            thread_name: "Bad Thread",
            batch_name: "Bad Batch",
            stage_name: "Bad Stage",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "pending",
          },
        ],
      }

      const result = migrateFromTasksJson(repoRoot, streamId, tasksFile)

      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain("Invalid task ID format")
    })

    test("migrateFromTasksJson avoids duplicate sessions", () => {
      const tasksFile = createTasksFile()

      // First migration
      migrateFromTasksJson(repoRoot, streamId, tasksFile)

      // Second migration (should not duplicate)
      const result = migrateFromTasksJson(repoRoot, streamId, tasksFile)

      expect(result.sessionsMigrated).toBe(0) // No new sessions
      expect(result.threadsCreated).toBe(0) // Threads already exist

      const thread = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(thread!.sessions).toHaveLength(2) // Still only 2 sessions
    })

    test("validateMigration returns empty array for successful migration", () => {
      const tasksFile = createTasksFile()
      migrateFromTasksJson(repoRoot, streamId, tasksFile)

      const issues = validateMigration(repoRoot, streamId, tasksFile)

      expect(issues).toHaveLength(0)
    })

    test("validateMigration detects missing threads.json", () => {
      const tasksFile = createTasksFile()

      const issues = validateMigration(repoRoot, streamId, tasksFile)

      expect(issues).toHaveLength(1)
      expect(issues[0]).toContain("threads.json does not exist")
    })

    test("validateMigration detects missing threads", () => {
      const tasksFile = createTasksFile()

      // Create partial threads.json (missing thread 01.01.02)
      saveThreads(repoRoot, streamId, {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        threads: [
          {
            threadId: "01.01.01",
            sessions: [
              {
                sessionId: "ses_abc123",
                agentName: "test-agent",
                model: "anthropic/claude-sonnet-4",
                startedAt: "2024-01-01T00:00:00.000Z",
                status: "completed",
              },
              {
                sessionId: "ses_def456",
                agentName: "test-agent-2",
                model: "google/gemini-2.5-pro",
                startedAt: "2024-01-02T00:00:00.000Z",
                status: "running",
              },
            ],
            // Note: githubIssue removed - issues now stored in github.json
          },
        ],
      })

      const issues = validateMigration(repoRoot, streamId, tasksFile)

      expect(issues.length).toBeGreaterThan(0)
      expect(issues.some((i) => i.includes("Thread 01.01.02 not found"))).toBe(true)
    })
  })

  describe("concurrent access", () => {
    test("parallel locked operations don't corrupt data", async () => {
      // Start multiple sessions in parallel using locked operations
      const sessionIds = Array.from({ length: 5 }, () => generateSessionId())

      const promises = sessionIds.map((sessionId, i) =>
        startThreadSessionLocked(
          repoRoot,
          streamId,
          `01.01.0${i + 1}`,
          `agent-${i}`,
          `model-${i}`,
          sessionId
        )
      )

      await Promise.all(promises)

      // Verify all threads were created
      const all = getAllThreadMetadata(repoRoot, streamId)
      expect(all).toHaveLength(5)

      // Verify each thread has exactly one session
      for (const thread of all) {
        expect(thread.sessions).toHaveLength(1)
        expect(thread.currentSessionId).toBeDefined()
      }
    })

    test("parallel modifyThreads operations are serialized", async () => {
      // Create initial thread
      updateThreadMetadata(repoRoot, streamId, "01.01.01", { sessions: [] })

      // Run multiple modifications in parallel
      const promises = Array.from({ length: 10 }, (_, i) =>
        modifyThreads(repoRoot, streamId, (threadsFile) => {
          const thread = threadsFile.threads.find((t) => t.threadId === "01.01.01")
          if (thread) {
            thread.sessions.push({
              sessionId: `ses_${i}`,
              agentName: `agent-${i}`,
              model: `model-${i}`,
              startedAt: new Date().toISOString(),
              status: "running",
            })
          }
          return i
        })
      )

      await Promise.all(promises)

      // Verify all sessions were added
      const thread = getThreadMetadata(repoRoot, streamId, "01.01.01")
      expect(thread!.sessions).toHaveLength(10)
    })
  })
})
