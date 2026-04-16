import { describe, expect, test } from "bun:test"

import { buildDashboardTerminalObservabilitySnapshot } from "../src/snapshot.ts"

describe("dashboard terminal observability snapshot", () => {
  test("maps dashboard-visible tmux sessions to stable read-only ttyd routes", () => {
    const snapshot = buildDashboardTerminalObservabilitySnapshot({
      capability: {
        enabled: true,
        message: "ttyd ready",
        mode: "ttyd",
      },
      checkedAt: "2026-04-16T12:00:00.000Z",
      tmux: {
        checked_at: "2026-04-16T12:00:00.000Z",
        availability: "ready",
        issues: [],
        sessions: [
          {
            session_id: "$1",
            session_name: "002-implementation-abcd12",
            role: "implementation_thread",
            state: "detached",
            observed_at: "2026-04-16T12:00:00.000Z",
            stage_id: "03",
            batch_id: "03.01",
            thread_id: "03.01.02",
            pane_count: 1,
            correlation: {
              status: "matched",
              target_kind: "implementation_thread",
              target_id: "03.01.02",
              stage_id: "03",
              batch_id: "03.01",
              thread_id: "03.01.02",
            },
          },
          {
            session_id: "$2",
            session_name: "002-supervision-ef3456",
            role: "supervision_branch",
            state: "attached",
            observed_at: "2026-04-16T12:00:00.000Z",
            stage_id: "03",
            batch_id: "03.01",
            pane_count: 1,
            correlation: {
              status: "matched",
              target_kind: "supervision_branch",
              target_id: "branch-1",
              stage_id: "03",
              batch_id: "03.01",
            },
          },
        ],
      },
      views: [
        {
          id: "thread/03.01.02",
          label: "Embedded implementation terminal",
          sessionName: "002-implementation-abcd12",
          readOnly: true,
          status: "ready",
          ttydUrl: "http://127.0.0.1:7681/",
        },
        {
          id: "branch/branch-1",
          label: "Embedded supervision terminal",
          sessionName: "002-supervision-ef3456",
          readOnly: true,
          status: "pending",
          notes: "Waiting for the read-only ttyd bridge to finish starting.",
        },
      ],
    })

    expect(snapshot.availability).toBe("degraded")
    expect(snapshot.views).toEqual([
      expect.objectContaining({
        terminal_view_id: "thread/03.01.02",
        label: "Embedded implementation terminal",
        status: "available",
        read_only: true,
        routes: {
          view_path: "/terminal-views/thread%2F03.01.02",
          ttyd_proxy_path: "/terminal-views/thread%2F03.01.02/ttyd",
        },
      }),
      expect.objectContaining({
        terminal_view_id: "branch/branch-1",
        label: "Embedded supervision terminal",
        status: "degraded",
        read_only: true,
        routes: {
          view_path: "/terminal-views/branch%2Fbranch-1",
          ttyd_proxy_path: "/terminal-views/branch%2Fbranch-1/ttyd",
        },
      }),
    ])
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        code: "terminal_view_unavailable",
        message: "Waiting for the read-only ttyd bridge to finish starting.",
        related_ids: ["branch/branch-1"],
      }),
    ])
  })

  test("surfaces ttyd capability failures without inventing routes", () => {
    const snapshot = buildDashboardTerminalObservabilitySnapshot({
      capability: {
        enabled: false,
        message: "ttyd is not installed",
        mode: "ttyd",
      },
      checkedAt: "2026-04-16T12:00:00.000Z",
      tmux: {
        checked_at: "2026-04-16T12:00:00.000Z",
        availability: "ready",
        issues: [],
        sessions: [],
      },
      views: [],
    })

    expect(snapshot).toMatchObject({
      availability: "unavailable",
      transport: "ttyd",
      issues: [
        {
          code: "ttyd_unavailable",
          message: "ttyd is not installed",
        },
      ],
      views: [],
    })
  })
})
