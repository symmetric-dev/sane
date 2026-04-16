import { describe, expect, test } from "bun:test"

import {
  createCurrentWorkstreamDashboardObservabilitySnapshot,
  createDashboardTmuxObservabilitySnapshot,
} from "../src/internal/server.ts"
import type { StreamMetadata, TasksFile } from "../src/lib/types.ts"

const stream: StreamMetadata = {
  id: "002-web-workstream-dashboard",
  name: "web-workstream-dashboard",
  order: 2,
  size: "medium",
  session_estimated: {
    length: 4,
    unit: "session",
    session_minutes: [30, 45],
    session_iterations: [4, 8],
  },
  created_at: "2026-04-15T00:00:00.000Z",
  updated_at: "2026-04-15T00:00:00.000Z",
  path: "work/002-web-workstream-dashboard",
  generated_by: { workstreams: "0.5.1" },
}

function createTasksFile(runtimeState: TasksFile["runtime_state"]): TasksFile {
  return {
    version: "2.0.0",
    stream_id: stream.id,
    last_updated: "2026-04-15T12:00:00.000Z",
    runtime_state: runtimeState,
    tasks: [],
  }
}

function createInspector(args: {
  available?: boolean
  sessions?: Array<{ sessionId: string; sessionName: string; attached?: boolean }>
  panesBySession?: Record<
    string,
    Array<{
      pane_id: string
      pane_index: number
      active: boolean
      title?: string
      tty?: string
      current_command?: string
      current_path?: string
    }>
  >
  paneStatesBySession?: Record<string, Array<{ paneId: string; paneDead: boolean }>>
  windowNames?: Record<string, string>
}) {
  const available = args.available ?? true
  const sessions = args.sessions ?? []
  const panesBySession = args.panesBySession ?? {}
  const paneStatesBySession = args.paneStatesBySession ?? {}
  const windowNames = args.windowNames ?? {}

  return {
    isAvailable(): boolean {
      return available
    },
    listSessions() {
      return sessions.map((session) => ({
        sessionId: session.sessionId,
        sessionName: session.sessionName,
        attached: session.attached ?? false,
      }))
    },
    listSessionPanes(sessionName: string) {
      return panesBySession[sessionName] ?? []
    },
    listSessionPaneStates(sessionName: string) {
      return paneStatesBySession[sessionName] ?? []
    },
    getActiveWindowName(sessionName: string) {
      return windowNames[sessionName]
    },
  }
}

describe("dashboard tmux observability", () => {
  test("correlates implementation and supervision sessions conservatively", () => {
    const tasksFile = createTasksFile({
      version: "1.0.0",
      last_updated: "2026-04-15T12:00:00.000Z",
      threads: [],
      batches: {
        "02.02": {
          version: "1.0.0",
          streamId: stream.id,
          batchId: "02.02",
          runId: "run-impl-1",
          tmuxSessionName: "002-implementation-abcd12",
          mode: "headless",
          status: "running",
          startedAt: "2026-04-15T11:55:00.000Z",
          updatedAt: "2026-04-15T12:00:00.000Z",
          summary: {
            total: 2,
            pending: 0,
            running: 2,
            completed: 0,
            failed: 0,
          },
          threads: [
            {
              threadId: "02.02.01",
              threadName: "tmux discovery",
              firstTaskId: "02.02.02.01",
              status: "running",
              updatedAt: "2026-04-15T12:00:00.000Z",
            },
            {
              threadId: "02.02.02",
              threadName: "tmux correlation",
              firstTaskId: "02.02.02.02",
              status: "running",
              updatedAt: "2026-04-15T12:00:00.000Z",
            },
          ],
        },
      },
      supervision: {
        version: "1.0.0",
        stream_id: stream.id,
        last_updated: "2026-04-15T12:00:00.000Z",
        active_run_id: "run-super-1",
        current_branch_supervision: {
          owner: "root_agent",
          rootSessionId: "root-1",
          branchSessionId: "branch-1",
          branchRole: "supervision",
          nativeSessionId: "native-1",
          source: "repo_local_fallback",
          tmuxSessionName: "002-supervision-ef3456",
          updatedAt: "2026-04-15T12:00:00.000Z",
          supervisionProgress: {
            executionMode: "stage_batch_loop",
            currentBatchId: "02.02",
            lastReviewedBatchId: "02.01",
          },
          scope: {
            level: "stage",
            stageId: "02",
          },
        },
        runs: [
          {
            runId: "run-super-1",
            stageId: "02",
            status: "running",
            startedAt: "2026-04-15T11:50:00.000Z",
            updatedAt: "2026-04-15T12:00:00.000Z",
            reviewPasses: 1,
            issueSummaryIds: [],
            escalationIds: [],
            branchSessionId: "branch-1",
            rootSessionId: "root-1",
          },
        ],
        checkpoint_pointers: [],
        branch_sessions: [
          {
            owner: "root_agent",
            rootSessionId: "root-1",
            branchSessionId: "branch-1",
            branchRole: "supervision",
            source: "repo_local_fallback",
            status: "running",
            startedAt: "2026-04-15T11:50:00.000Z",
            updatedAt: "2026-04-15T12:00:00.000Z",
            tmuxSessionName: "002-supervision-ef3456",
            runId: "run-super-1",
          },
        ],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      },
    })

    const snapshot = createDashboardTmuxObservabilitySnapshot({
      stream,
      tasksFile,
      checkedAt: "2026-04-15T12:00:00.000Z",
      tmuxInspector: createInspector({
        sessions: [
          { sessionId: "$1", sessionName: "002-implementation-abcd12" },
          { sessionId: "$2", sessionName: "002-supervision-ef3456", attached: true },
        ],
        panesBySession: {
          "002-implementation-abcd12": [
            {
              pane_id: "%11",
              pane_index: 0,
              active: true,
              title: "tmux discovery",
              current_command: "opencode",
              current_path: "/Users/beto/agenv",
            },
            {
              pane_id: "%12",
              pane_index: 1,
              active: false,
              title: "tmux correlation",
              current_command: "opencode",
              current_path: "/Users/beto/agenv",
            },
          ],
          "002-supervision-ef3456": [
            {
              pane_id: "%21",
              pane_index: 0,
              active: true,
              title: "supervision",
              current_command: "opencode",
              current_path: "/Users/beto/agenv",
            },
          ],
        },
        paneStatesBySession: {
          "002-implementation-abcd12": [
            { paneId: "%11", paneDead: false },
            { paneId: "%12", paneDead: false },
          ],
          "002-supervision-ef3456": [{ paneId: "%21", paneDead: false }],
        },
        windowNames: {
          "002-implementation-abcd12": "Grid",
          "002-supervision-ef3456": "supervision",
        },
      }),
    })

    expect(snapshot.availability).toBe("ready")
    expect(snapshot.issues).toEqual([])
    expect(snapshot.sessions).toHaveLength(2)
    expect(snapshot.sessions[0]).toMatchObject({
      session_id: "$1",
      session_name: "002-implementation-abcd12",
      role: "implementation_thread",
      state: "detached",
      batch_id: "02.02",
      run_id: "run-impl-1",
      pane_count: 2,
      correlation: {
        status: "matched",
        target_kind: "implementation_thread",
        target_id: "02.02",
      },
    })
    expect(snapshot.sessions[1]).toMatchObject({
      session_id: "$2",
      session_name: "002-supervision-ef3456",
      role: "supervision_branch",
      state: "attached",
      stage_id: "02",
      run_id: "run-super-1",
      pane_count: 1,
      correlation: {
        status: "matched",
        target_kind: "supervision_branch",
        target_id: "branch-1",
      },
    })
  })

  test("surfaces missing matches without inventing tmux state", () => {
    const tasksFile = createTasksFile({
      version: "1.0.0",
      last_updated: "2026-04-15T12:00:00.000Z",
      threads: [],
      batches: {
        "02.02": {
          version: "1.0.0",
          streamId: stream.id,
          batchId: "02.02",
          runId: "run-impl-1",
          tmuxSessionName: "002-implementation-missing",
          mode: "headless",
          status: "running",
          startedAt: "2026-04-15T11:55:00.000Z",
          updatedAt: "2026-04-15T12:00:00.000Z",
          summary: {
            total: 1,
            pending: 0,
            running: 1,
            completed: 0,
            failed: 0,
          },
          threads: [
            {
              threadId: "02.02.01",
              threadName: "tmux discovery",
              firstTaskId: "02.02.02.01",
              status: "running",
              updatedAt: "2026-04-15T12:00:00.000Z",
            },
          ],
        },
      },
      supervision: {
        version: "1.0.0",
        stream_id: stream.id,
        last_updated: "2026-04-15T12:00:00.000Z",
        runs: [],
        checkpoint_pointers: [],
        branch_sessions: [],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      },
    })

    const snapshot = createDashboardTmuxObservabilitySnapshot({
      stream,
      tasksFile,
      checkedAt: "2026-04-15T12:00:00.000Z",
      tmuxInspector: createInspector({ sessions: [] }),
    })

    expect(snapshot.availability).toBe("degraded")
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({
        code: "tmux_missing_match",
        related_ids: ["02.02.01"],
      }),
    )
    expect(snapshot.sessions).toContainEqual(
      expect.objectContaining({
        session_id: "missing:002-implementation-missing",
        session_name: "002-implementation-missing",
        state: "unknown",
        correlation: expect.objectContaining({
          status: "missing",
          target_id: "02.02.01",
        }),
      }),
    )
  })

  test("surfaces stale matches for terminal and orphaned tmux sessions", () => {
    const tasksFile = createTasksFile({
      version: "1.0.0",
      last_updated: "2026-04-15T12:00:00.000Z",
      threads: [],
      batches: {
        "02.02": {
          version: "1.0.0",
          streamId: stream.id,
          batchId: "02.02",
          runId: "run-impl-1",
          tmuxSessionName: "002-implementation-stale",
          mode: "headless",
          status: "completed",
          startedAt: "2026-04-15T11:55:00.000Z",
          updatedAt: "2026-04-15T12:00:00.000Z",
          completedAt: "2026-04-15T12:00:00.000Z",
          summary: {
            total: 1,
            pending: 0,
            running: 0,
            completed: 1,
            failed: 0,
          },
          threads: [
            {
              threadId: "02.02.01",
              threadName: "tmux discovery",
              firstTaskId: "02.02.02.01",
              status: "completed",
              updatedAt: "2026-04-15T12:00:00.000Z",
              completedAt: "2026-04-15T12:00:00.000Z",
            },
          ],
        },
      },
      supervision: {
        version: "1.0.0",
        stream_id: stream.id,
        last_updated: "2026-04-15T12:00:00.000Z",
        runs: [],
        checkpoint_pointers: [],
        branch_sessions: [],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      },
    })

    const snapshot = createDashboardTmuxObservabilitySnapshot({
      stream,
      tasksFile,
      checkedAt: "2026-04-15T12:00:00.000Z",
      tmuxInspector: createInspector({
        sessions: [
          { sessionId: "$1", sessionName: "002-implementation-stale" },
          { sessionId: "$2", sessionName: "002-supervision-orphan" },
        ],
        panesBySession: {
          "002-implementation-stale": [{ pane_id: "%11", pane_index: 0, active: true }],
          "002-supervision-orphan": [{ pane_id: "%21", pane_index: 0, active: true }],
        },
        paneStatesBySession: {
          "002-implementation-stale": [{ paneId: "%11", paneDead: false }],
          "002-supervision-orphan": [{ paneId: "%21", paneDead: true }],
        },
      }),
    })

    expect(snapshot.issues.filter((issue) => issue.code === "tmux_stale_match")).toHaveLength(2)
    expect(snapshot.sessions).toContainEqual(
      expect.objectContaining({
        session_name: "002-implementation-stale",
        state: "detached",
        correlation: expect.objectContaining({
          status: "stale",
          target_id: "02.02.01",
        }),
      }),
    )
    expect(snapshot.sessions).toContainEqual(
      expect.objectContaining({
        session_name: "002-supervision-orphan",
        state: "exited",
        correlation: expect.objectContaining({
          status: "stale",
          target_id: "002-supervision-orphan",
        }),
      }),
    )
  })

  test("surfaces ambiguous matches when multiple runtime targets share a tmux session name", () => {
    const tasksFile = createTasksFile({
      version: "1.0.0",
      last_updated: "2026-04-15T12:00:00.000Z",
      threads: [],
      batches: {
        "02.02": {
          version: "1.0.0",
          streamId: stream.id,
          batchId: "02.02",
          runId: "run-impl-1",
          tmuxSessionName: "002-implementation-shared",
          mode: "headless",
          status: "running",
          startedAt: "2026-04-15T11:55:00.000Z",
          updatedAt: "2026-04-15T12:00:00.000Z",
          summary: {
            total: 1,
            pending: 0,
            running: 1,
            completed: 0,
            failed: 0,
          },
          threads: [
            {
              threadId: "02.02.01",
              threadName: "tmux discovery",
              firstTaskId: "02.02.02.01",
              status: "running",
              updatedAt: "2026-04-15T12:00:00.000Z",
            },
          ],
        },
        "02.03": {
          version: "1.0.0",
          streamId: stream.id,
          batchId: "02.03",
          runId: "run-impl-2",
          tmuxSessionName: "002-implementation-shared",
          mode: "headless",
          status: "running",
          startedAt: "2026-04-15T11:56:00.000Z",
          updatedAt: "2026-04-15T12:00:00.000Z",
          summary: {
            total: 1,
            pending: 0,
            running: 1,
            completed: 0,
            failed: 0,
          },
          threads: [
            {
              threadId: "02.03.01",
              threadName: "snapshot observability",
              firstTaskId: "02.03.01.01",
              status: "running",
              updatedAt: "2026-04-15T12:00:00.000Z",
            },
          ],
        },
      },
      supervision: {
        version: "1.0.0",
        stream_id: stream.id,
        last_updated: "2026-04-15T12:00:00.000Z",
        runs: [],
        checkpoint_pointers: [],
        branch_sessions: [],
        reviewed_batches: [],
        issue_summaries: [],
        fix_cycles: [],
        escalations: [],
        stage_stops: [],
      },
    })

    const snapshot = createDashboardTmuxObservabilitySnapshot({
      stream,
      tasksFile,
      checkedAt: "2026-04-15T12:00:00.000Z",
      tmuxInspector: createInspector({
        sessions: [{ sessionId: "$1", sessionName: "002-implementation-shared" }],
        panesBySession: {
          "002-implementation-shared": [{ pane_id: "%11", pane_index: 0, active: true }],
        },
        paneStatesBySession: {
          "002-implementation-shared": [{ paneId: "%11", paneDead: false }],
        },
      }),
    })

    expect(snapshot.availability).toBe("degraded")
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({
        code: "tmux_ambiguous_match",
        related_ids: ["02.02.01", "02.03.01"],
      }),
    )
    expect(snapshot.sessions[0]).toMatchObject({
      session_name: "002-implementation-shared",
      correlation: {
        status: "ambiguous",
        target_id: "002-implementation-shared",
      },
    })
  })

  test("wraps tmux data in the current-workstream observability snapshot", () => {
    const snapshot = createCurrentWorkstreamDashboardObservabilitySnapshot({
      stream,
      tasksFile: createTasksFile({
        version: "1.0.0",
        last_updated: "2026-04-15T12:00:00.000Z",
        threads: [],
        batches: {},
        supervision: {
          version: "1.0.0",
          stream_id: stream.id,
          last_updated: "2026-04-15T12:00:00.000Z",
          runs: [],
          checkpoint_pointers: [],
          branch_sessions: [],
          reviewed_batches: [],
          issue_summaries: [],
          fix_cycles: [],
          escalations: [],
          stage_stops: [],
        },
      }),
      checkedAt: "2026-04-15T12:00:00.000Z",
      tmuxInspector: createInspector({ available: false }),
    })

    expect(snapshot.availability).toBe("degraded")
    expect(snapshot.tmux.availability).toBe("unavailable")
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({
        code: "tmux_unavailable",
      }),
    )
    expect(snapshot.issues).toContainEqual(
      expect.objectContaining({
        code: "ttyd_unavailable",
      }),
    )
    expect(snapshot.terminal_views.availability).toBe("unavailable")
  })
})
