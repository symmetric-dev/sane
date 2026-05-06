import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import {
  generateSessionId,
  startTaskSession,
  completeTaskSession,
  getCurrentTaskSession,
  getTaskSessions,
  writeTasksFile,
  readTasksFile,
  startTaskSessionLocked,
  completeTaskSessionLocked,
  startMultipleSessionsLocked,
  completeMultipleSessionsLocked,
} from "../src/lib/tasks"
import { loadThreads } from "../src/lib/threads"
import type { TasksFile } from "../src/lib/types"
import { createTestWorkstream, cleanupTestWorkstream, type TestWorkspace } from "./helpers"

describe("session-tracking", () => {
  let workspace: TestWorkspace
  
  beforeEach(() => {
    workspace = createTestWorkstream()
    const { repoRoot, streamId } = workspace
    
    // Create initial tasks.json with test tasks
    const tasksFile: TasksFile = {
      version: "1.0.0",
      stream_id: streamId,
      last_updated: new Date().toISOString(),
      tasks: [
        {
          id: "01.01.01.01",
          name: "Test task 1",
          thread_name: "Thread One",
          batch_name: "Setup",
          stage_name: "Stage One",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
          sessions: [],
        },
        {
          id: "01.01.01.02",
          name: "Test task 2",
          thread_name: "Thread One",
          batch_name: "Setup",
          stage_name: "Stage One",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          status: "pending",
          sessions: [],
        },
      ],
    }
    writeTasksFile(repoRoot, streamId, tasksFile)
  })

  afterEach(() => {
    cleanupTestWorkstream(workspace)
  })

  describe("generateSessionId", () => {
    test("generates unique session IDs", () => {
      const id1 = generateSessionId()
      const id2 = generateSessionId()

      expect(id1).toMatch(/^ses_[a-z0-9]+_[a-z0-9]+$/)
      expect(id2).toMatch(/^ses_[a-z0-9]+_[a-z0-9]+$/)
      expect(id1).not.toEqual(id2)
    })
  })

  describe("startTaskSession", () => {
    test("creates a session with running status", () => {
      const { repoRoot, streamId } = workspace
      const session = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      expect(session).not.toBeNull()
      expect(session!.sessionId).toMatch(/^ses_/)
      expect(session!.agentName).toBe("test-agent")
      expect(session!.model).toBe("anthropic/claude-sonnet-4")
      expect(session!.status).toBe("running")
      expect(session!.startedAt).toBeDefined()
      expect(session!.completedAt).toBeUndefined()
    })

    test("stores session in threads.json (not tasks.json)", () => {
      const { repoRoot, streamId } = workspace
      const session = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      // Verify threads.json has the session
      const threadsFile = loadThreads(repoRoot, streamId)
      expect(threadsFile).not.toBeNull()
      
      const threadId = "01.01.01" // Thread ID derived from task "01.01.01.01"
      const thread = threadsFile!.threads.find((t) => t.threadId === threadId)
      expect(thread).toBeDefined()
      expect(thread!.currentSessionId).toBe(session!.sessionId)
      expect(thread!.sessions).toHaveLength(1)
      expect(thread!.sessions[0]!.sessionId).toBe(session!.sessionId)

      // Verify tasks.json does NOT have the new session data added
      // (Note: tasks.json may still have empty sessions[] from initial setup, 
      //  but no new session should be written to it)
      const tasksFilePath = join(repoRoot, "work", streamId, "tasks.json")
      const tasksContent = readFileSync(tasksFilePath, "utf-8")
      const tasksFile = JSON.parse(tasksContent) as TasksFile
      const task = tasksFile.tasks.find((t) => t.id === "01.01.01.01")!
      // The task should not have the new session added
      expect(task.currentSessionId).toBeUndefined()
      // If sessions exist, they should be empty (from setup) or not contain the new session
      if (task.sessions) {
        expect(task.sessions.find((s) => s.sessionId === session!.sessionId)).toBeUndefined()
      }
    })

    test("does not project a legacy threads.json file for sqlite-native session writes", () => {
      const { repoRoot, streamId } = workspace

      const session = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      expect(session).not.toBeNull()
      expect(loadThreads(repoRoot, streamId)?.threads.find((thread) => thread.threadId === "01.01.01")).toBeDefined()
      expect(existsSync(join(repoRoot, "work", streamId, "threads.json"))).toBe(false)
    })

    test("returns null for non-existent task", () => {
      const { repoRoot, streamId } = workspace
      const session = startTaskSession(
        repoRoot,
        streamId,
        "99.99.99.99",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      expect(session).toBeNull()
    })
  })

  describe("completeTaskSession", () => {
    test("updates session status and exit code", () => {
      const { repoRoot, streamId } = workspace
      const session = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      const completed = completeTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        session!.sessionId,
        "completed",
        0
      )

      expect(completed).not.toBeNull()
      expect(completed!.status).toBe("completed")
      expect(completed!.exitCode).toBe(0)
      expect(completed!.completedAt).toBeDefined()
    })

    test("clears currentSessionId in threads.json on completion", () => {
      const { repoRoot, streamId } = workspace
      const session = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      completeTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        session!.sessionId,
        "completed",
        0
      )

      // Verify threads.json has cleared currentSessionId
      const threadsFile = loadThreads(repoRoot, streamId)
      const threadId = "01.01.01"
      const thread = threadsFile!.threads.find((t) => t.threadId === threadId)
      expect(thread!.currentSessionId).toBeUndefined()
    })

    test("handles failed status with non-zero exit code", () => {
      const { repoRoot, streamId } = workspace
      const session = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      const completed = completeTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        session!.sessionId,
        "failed",
        1
      )

      expect(completed!.status).toBe("failed")
      expect(completed!.exitCode).toBe(1)
    })
  })

  describe("getCurrentTaskSession", () => {
    test("returns current running session", () => {
      const { repoRoot, streamId } = workspace
      const started = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      const current = getCurrentTaskSession(repoRoot, streamId, "01.01.01.01")

      expect(current).not.toBeNull()
      expect(current!.sessionId).toBe(started!.sessionId)
    })

    test("returns null after session completed", () => {
      const { repoRoot, streamId } = workspace
      const session = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4"
      )

      completeTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        session!.sessionId,
        "completed",
        0
      )

      const current = getCurrentTaskSession(repoRoot, streamId, "01.01.01.01")

      expect(current).toBeNull()
    })
  })

  describe("getTaskSessions", () => {
    test("returns all sessions for a task", () => {
      const { repoRoot, streamId } = workspace
      // Start and complete first session
      const session1 = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "agent-1",
        "model-1"
      )
      completeTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        session1!.sessionId,
        "failed",
        1
      )

      // Start second session (retry)
      const session2 = startTaskSession(
        repoRoot,
        streamId,
        "01.01.01.01",
        "agent-2",
        "model-2"
      )

      const sessions = getTaskSessions(repoRoot, streamId, "01.01.01.01")

      expect(sessions).toHaveLength(2)
      expect(sessions[0]!.agentName).toBe("agent-1")
      expect(sessions[0]!.status).toBe("failed")
      expect(sessions[1]!.agentName).toBe("agent-2")
      expect(sessions[1]!.status).toBe("running")
    })

    test("returns empty array for task with no sessions", () => {
      const { repoRoot, streamId } = workspace
      const sessions = getTaskSessions(repoRoot, streamId, "01.01.01.02")

      expect(sessions).toHaveLength(0)
    })
  })

  describe("locked session operations", () => {
    test("startTaskSessionLocked creates session with provided ID in threads.json", async () => {
      const { repoRoot, streamId } = workspace
      const sessionId = generateSessionId()
      const session = await startTaskSessionLocked(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4",
        sessionId
      )

      expect(session).not.toBeNull()
      expect(session!.sessionId).toBe(sessionId)
      expect(session!.status).toBe("running")

      // Verify session is in threads.json
      const threadsFile = loadThreads(repoRoot, streamId)
      const thread = threadsFile!.threads.find((t) => t.threadId === "01.01.01")
      expect(thread!.currentSessionId).toBe(sessionId)
    })

    test("completeTaskSessionLocked updates session in threads.json", async () => {
      const { repoRoot, streamId } = workspace
      const sessionId = generateSessionId()
      await startTaskSessionLocked(
        repoRoot,
        streamId,
        "01.01.01.01",
        "test-agent",
        "anthropic/claude-sonnet-4",
        sessionId
      )

      const completed = await completeTaskSessionLocked(
        repoRoot,
        streamId,
        "01.01.01.01",
        sessionId,
        "completed",
        0
      )

      expect(completed).not.toBeNull()
      expect(completed!.status).toBe("completed")
      expect(completed!.exitCode).toBe(0)

      // Verify threads.json is updated
      const threadsFile = loadThreads(repoRoot, streamId)
      const thread = threadsFile!.threads.find((t) => t.threadId === "01.01.01")
      expect(thread!.currentSessionId).toBeUndefined()
      expect(thread!.sessions[0]!.status).toBe("completed")
    })

    test("startMultipleSessionsLocked creates multiple sessions atomically in threads.json", async () => {
      const { repoRoot, streamId } = workspace
      const session1Id = generateSessionId()
      const session2Id = generateSessionId()

      const sessions = await startMultipleSessionsLocked(repoRoot, streamId, [
        {
          taskId: "01.01.01.01",
          agentName: "agent-1",
          model: "model-1",
          sessionId: session1Id,
        },
        {
          taskId: "01.01.01.02",
          agentName: "agent-2",
          model: "model-2",
          sessionId: session2Id,
        },
      ])

      expect(sessions).toHaveLength(2)
      expect(sessions[0]!.sessionId).toBe(session1Id)
      expect(sessions[1]!.sessionId).toBe(session2Id)

      // Both tasks are in same thread (01.01.01), so only one thread entry
      const threadsFile = loadThreads(repoRoot, streamId)
      const thread = threadsFile!.threads.find((t) => t.threadId === "01.01.01")
      expect(thread).toBeDefined()
      // Note: Since both tasks are in the same thread, the currentSessionId will be the last one set
      expect(thread!.sessions).toHaveLength(2)

      // Verify tasks.json does NOT have session data
      const tasksFile = readTasksFile(repoRoot, streamId)
      const task1 = tasksFile!.tasks.find((t) => t.id === "01.01.01.01")
      const task2 = tasksFile!.tasks.find((t) => t.id === "01.01.01.02")
      expect(task1!.currentSessionId).toBeUndefined()
      expect(task2!.currentSessionId).toBeUndefined()
    })

    test("completeMultipleSessionsLocked updates multiple sessions atomically in threads.json", async () => {
      const { repoRoot, streamId } = workspace
      const session1Id = generateSessionId()
      const session2Id = generateSessionId()

      // Start sessions first
      await startMultipleSessionsLocked(repoRoot, streamId, [
        {
          taskId: "01.01.01.01",
          agentName: "agent-1",
          model: "model-1",
          sessionId: session1Id,
        },
        {
          taskId: "01.01.01.02",
          agentName: "agent-2",
          model: "model-2",
          sessionId: session2Id,
        },
      ])

      // Complete both sessions
      const completed = await completeMultipleSessionsLocked(repoRoot, streamId, [
        {
          taskId: "01.01.01.01",
          sessionId: session1Id,
          status: "completed",
          exitCode: 0,
        },
        {
          taskId: "01.01.01.02",
          sessionId: session2Id,
          status: "failed",
          exitCode: 1,
        },
      ])

      expect(completed).toHaveLength(2)
      expect(completed[0]!.status).toBe("completed")
      expect(completed[0]!.exitCode).toBe(0)
      expect(completed[1]!.status).toBe("failed")
      expect(completed[1]!.exitCode).toBe(1)

      // Verify threads.json has the completed sessions
      const threadsFile = loadThreads(repoRoot, streamId)
      const thread = threadsFile!.threads.find((t) => t.threadId === "01.01.01")
      expect(thread!.currentSessionId).toBeUndefined()
      expect(thread!.sessions).toHaveLength(2)
    })

    test("handles non-existent tasks gracefully", async () => {
      const { repoRoot, streamId } = workspace
      const sessions = await startMultipleSessionsLocked(repoRoot, streamId, [
        {
          taskId: "99.99.99.99",
          agentName: "agent",
          model: "model",
          sessionId: generateSessionId(),
        },
      ])

      expect(sessions).toHaveLength(0)
    })
  })

  describe.skip("session migration from tasks.json to threads.json", () => {
    test("migrates existing sessions from tasks.json on read", () => {
      const { repoRoot, streamId } = workspace
      // Create a tasks.json with legacy session data
      const workDir = join(repoRoot, "work", streamId)
      const tasksFilePath = join(workDir, "tasks.json")
      
      const legacyTasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Test task 1",
            thread_name: "Thread One",
            batch_name: "Setup",
            stage_name: "Stage One",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "pending",
            sessions: [
              {
                sessionId: "ses_legacy_1",
                agentName: "legacy-agent",
                model: "legacy-model",
                startedAt: new Date().toISOString(),
                status: "completed",
                completedAt: new Date().toISOString(),
                exitCode: 0,
              },
            ],
            currentSessionId: undefined,
          },
        ],
      }
      
      // Write legacy format directly (bypassing writeTasksFile to simulate old data)
      writeFileSync(tasksFilePath, JSON.stringify(legacyTasksFile, null, 2))

      // Read tasks file - this should trigger migration
      const tasksFile = readTasksFile(repoRoot, streamId)

      // Verify tasks.json no longer has session data
      const task = tasksFile!.tasks.find((t) => t.id === "01.01.01.01")!
      expect(task.sessions).toBeUndefined()
      expect(task.currentSessionId).toBeUndefined()

      // Verify threads.json has the migrated session data
      const threadsFile = loadThreads(repoRoot, streamId)
      expect(threadsFile).not.toBeNull()
      
      const thread = threadsFile!.threads.find((t) => t.threadId === "01.01.01")
      expect(thread).toBeDefined()
      expect(thread!.sessions).toHaveLength(1)
      expect(thread!.sessions[0]!.sessionId).toBe("ses_legacy_1")
      expect(thread!.sessions[0]!.agentName).toBe("legacy-agent")
    })

    test("creates backup before migration", () => {
      const { repoRoot, streamId } = workspace
      // Create a tasks.json with legacy session data
      const workDir = join(repoRoot, "work", streamId)
      const tasksFilePath = join(workDir, "tasks.json")
      
      const legacyTasksFile: TasksFile = {
        version: "1.0.0",
        stream_id: streamId,
        last_updated: new Date().toISOString(),
        tasks: [
          {
            id: "01.01.01.01",
            name: "Test task 1",
            thread_name: "Thread One",
            batch_name: "Setup",
            stage_name: "Stage One",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            status: "pending",
            sessions: [
              {
                sessionId: "ses_backup_test",
                agentName: "backup-agent",
                model: "backup-model",
                startedAt: new Date().toISOString(),
                status: "running",
              },
            ],
            currentSessionId: "ses_backup_test",
          },
        ],
      }
      
      writeFileSync(tasksFilePath, JSON.stringify(legacyTasksFile, null, 2))

      // Read tasks file - this should trigger migration and create backup
      readTasksFile(repoRoot, streamId)

      // Check that a backup file was created
      const files = require("fs").readdirSync(workDir)
      const backupFiles = files.filter((f: string) => f.startsWith("tasks.backup-"))
      expect(backupFiles.length).toBeGreaterThan(0)

      // Verify backup contains the original session data
      const backupContent = readFileSync(join(workDir, backupFiles[0]), "utf-8")
      const backupTasksFile = JSON.parse(backupContent) as TasksFile
      expect(backupTasksFile.tasks[0]!.sessions).toHaveLength(1)
      expect(backupTasksFile.tasks[0]!.sessions![0]!.sessionId).toBe("ses_backup_test")
    })
  })
})
