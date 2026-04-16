import { describe, expect, test } from "bun:test"

import type { CurrentWorkstreamDashboardReadModel } from "../src/snapshot.ts"
import { createTerminalViewRoutes } from "../src/routes/terminal-views.ts"

const baseReadModel: CurrentWorkstreamDashboardReadModel = {
  canonicalState: {
    source_of_truth: "tasks.json",
    status: {
      stream: {
        id: "002-web-workstream-dashboard",
        name: "web-workstream-dashboard",
        order: 2,
        size: "medium",
        path: "work/002-web-workstream-dashboard",
        created_at: "2026-04-16T12:00:00.000Z",
        updated_at: "2026-04-16T12:00:00.000Z",
        generated_by: { workstreams: "0.5.1" },
        is_current: true,
      },
      aggregate_status: "in_progress",
      counts: {
        total: 1,
        pending: 0,
        in_progress: 1,
        completed: 0,
        blocked: 0,
        cancelled: 0,
        done: 0,
      },
      completion: {
        total_tasks: 1,
        completed_tasks: 0,
        cancelled_tasks: 0,
        done_tasks: 0,
        remaining_tasks: 1,
        percent_complete: 0,
        percent_done: 0,
      },
      stages: [],
    },
    tree: {
      kind: "workstream",
      id: "002-web-workstream-dashboard",
      streamId: "002-web-workstream-dashboard",
      label: "Workstream: 002-web-workstream-dashboard",
      displayLabel: "Workstream: 002-web-workstream-dashboard",
      name: "002-web-workstream-dashboard",
      status: "in_progress",
      taskCount: 1,
      taskCounts: {
        total: 1,
        pending: 0,
        in_progress: 1,
        completed: 0,
        blocked: 0,
        cancelled: 0,
        done: 0,
      },
      stages: [],
    },
  },
  currentStreamId: "002-web-workstream-dashboard",
  observability: {
    checked_at: "2026-04-16T12:00:00.000Z",
    availability: "ready",
    issues: [],
    tmux: {
      checked_at: "2026-04-16T12:00:00.000Z",
      availability: "ready",
      issues: [],
      sessions: [],
    },
    terminal_views: {
      checked_at: "2026-04-16T12:00:00.000Z",
      availability: "ready",
      transport: "ttyd",
      issues: [],
      views: [
        {
          terminal_view_id: "thread/03.01.02",
          label: "Thread 03.01.02 terminal",
          status: "available",
          transport: "ttyd",
          read_only: true,
          session_id: "$1",
          session_name: "002-implementation-abcd12",
          role: "implementation_thread",
          observed_at: "2026-04-16T12:00:00.000Z",
          stage_id: "03",
          batch_id: "03.01",
          thread_id: "03.01.02",
          routes: {
            view_path: "/terminal-views/thread%2F03.01.02",
            ttyd_proxy_path: "/terminal-views/thread%2F03.01.02/ttyd",
          },
          correlation: {
            status: "matched",
            target_kind: "implementation_thread",
            target_id: "03.01.02",
            stage_id: "03",
            batch_id: "03.01",
            thread_id: "03.01.02",
          },
        },
      ],
    },
  },
  runtime: null,
  snapshot: {
    schema_version: "1.0.0",
    generated_at: "2026-04-16T12:00:00.000Z",
    canonical_state: {
      source_of_truth: "tasks.json",
      status: {
        stream: {
          id: "002-web-workstream-dashboard",
          name: "web-workstream-dashboard",
          order: 2,
          size: "medium",
          path: "work/002-web-workstream-dashboard",
          created_at: "2026-04-16T12:00:00.000Z",
          updated_at: "2026-04-16T12:00:00.000Z",
          generated_by: { workstreams: "0.5.1" },
          is_current: true,
        },
        aggregate_status: "in_progress",
        counts: {
          total: 1,
          pending: 0,
          in_progress: 1,
          completed: 0,
          blocked: 0,
          cancelled: 0,
          done: 0,
        },
        completion: {
          total_tasks: 1,
          completed_tasks: 0,
          cancelled_tasks: 0,
          done_tasks: 0,
          remaining_tasks: 1,
          percent_complete: 0,
          percent_done: 0,
        },
        stages: [],
      },
      tree: {
        kind: "workstream",
        id: "002-web-workstream-dashboard",
        streamId: "002-web-workstream-dashboard",
        label: "Workstream: 002-web-workstream-dashboard",
        displayLabel: "Workstream: 002-web-workstream-dashboard",
        name: "002-web-workstream-dashboard",
        status: "in_progress",
        taskCount: 1,
        taskCounts: {
          total: 1,
          pending: 0,
          in_progress: 1,
          completed: 0,
          blocked: 0,
          cancelled: 0,
          done: 0,
        },
        stages: [],
      },
    },
    observability: {
      checked_at: "2026-04-16T12:00:00.000Z",
      availability: "ready",
      issues: [],
      tmux: {
        checked_at: "2026-04-16T12:00:00.000Z",
        availability: "ready",
        issues: [],
        sessions: [],
      },
      terminal_views: {
        checked_at: "2026-04-16T12:00:00.000Z",
        availability: "ready",
        transport: "ttyd",
        issues: [],
        views: [
          {
            terminal_view_id: "thread/03.01.02",
            label: "Thread 03.01.02 terminal",
            status: "available",
            transport: "ttyd",
            read_only: true,
            session_id: "$1",
            session_name: "002-implementation-abcd12",
            role: "implementation_thread",
            observed_at: "2026-04-16T12:00:00.000Z",
            stage_id: "03",
            batch_id: "03.01",
            thread_id: "03.01.02",
            routes: {
              view_path: "/terminal-views/thread%2F03.01.02",
              ttyd_proxy_path: "/terminal-views/thread%2F03.01.02/ttyd",
            },
            correlation: {
              status: "matched",
              target_kind: "implementation_thread",
              target_id: "03.01.02",
              stage_id: "03",
              batch_id: "03.01",
              thread_id: "03.01.02",
            },
          },
        ],
      },
    },
  },
  status: {
    stream: {
      id: "002-web-workstream-dashboard",
      name: "web-workstream-dashboard",
      order: 2,
      size: "medium",
      path: "work/002-web-workstream-dashboard",
      created_at: "2026-04-16T12:00:00.000Z",
      updated_at: "2026-04-16T12:00:00.000Z",
      generated_by: { workstreams: "0.5.1" },
      is_current: true,
    },
    aggregate_status: "in_progress",
    counts: {
      total: 1,
      pending: 0,
      in_progress: 1,
      completed: 0,
      blocked: 0,
      cancelled: 0,
      done: 0,
    },
    completion: {
      total_tasks: 1,
      completed_tasks: 0,
      cancelled_tasks: 0,
      done_tasks: 0,
      remaining_tasks: 1,
      percent_complete: 0,
      percent_done: 0,
    },
    stages: [],
  },
  streamId: "002-web-workstream-dashboard",
  supervision: null,
  tree: {
    kind: "workstream",
    id: "002-web-workstream-dashboard",
    streamId: "002-web-workstream-dashboard",
    label: "Workstream: 002-web-workstream-dashboard",
    displayLabel: "Workstream: 002-web-workstream-dashboard",
    name: "002-web-workstream-dashboard",
    status: "in_progress",
    taskCount: 1,
    taskCounts: {
      total: 1,
      pending: 0,
      in_progress: 1,
      completed: 0,
      blocked: 0,
      cancelled: 0,
      done: 0,
    },
    stages: [],
  },
}

function createDegradedOnlyReadModel(): CurrentWorkstreamDashboardReadModel {
  const degradedReadModel = structuredClone(baseReadModel)
  const degradedView = {
    terminal_view_id: "branch/branch-1",
    label: "Supervision terminal",
    status: "degraded" as const,
    transport: "ttyd" as const,
    read_only: true as const,
    session_id: "$2",
    session_name: "002-supervision-ef3456",
    role: "supervision_branch" as const,
    observed_at: "2026-04-16T12:00:00.000Z",
    stage_id: "03",
    batch_id: "03.02",
    routes: {
      view_path: "/terminal-views/branch%2Fbranch-1",
      ttyd_proxy_path: "/terminal-views/branch%2Fbranch-1/ttyd",
    },
    correlation: {
      status: "matched" as const,
      target_kind: "supervision_branch" as const,
      target_id: "branch-1",
      stage_id: "03",
      batch_id: "03.02",
    },
    notes: "Waiting for the read-only ttyd bridge to recover.",
  }

  degradedReadModel.observability.availability = "degraded"
  degradedReadModel.observability.terminal_views = {
    checked_at: "2026-04-16T12:00:00.000Z",
    availability: "degraded",
    transport: "ttyd",
    issues: [
      {
        code: "terminal_view_unavailable",
        severity: "warn",
        message: "Waiting for the read-only ttyd bridge to recover.",
        related_ids: ["branch/branch-1"],
      },
    ],
    views: [degradedView],
  }

  degradedReadModel.snapshot.observability.availability = "degraded"
  degradedReadModel.snapshot.observability.terminal_views = structuredClone(
    degradedReadModel.observability.terminal_views,
  )

  return degradedReadModel
}

describe("terminal view routes", () => {
  test("renders embedded terminal pages for dashboard-visible read-only views", async () => {
    const app = createTerminalViewRoutes({
      config: {
        hostname: "127.0.0.1",
        port: 3000,
        repoRoot: "/tmp/repo",
      },
      terminalProvider: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd ready",
            mode: "ttyd" as const,
          }
        },
        async listViews(_options) {
          return []
        },
        async resolveViewTarget() {
          return {
            terminalViewId: "thread/03.01.02",
            sessionName: "002-implementation-abcd12",
            upstreamOrigin: "http://127.0.0.1:7681",
            upstreamPath: "/",
            port: 7681,
            pid: 1234,
          }
        },
        close() {},
      },
      readSnapshot: async () => baseReadModel,
    })

    const response = await app.request("/terminal-views/thread%2F03.01.02")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")

    const html = await response.text()
    expect(html).toContain("Read-only ttyd observability")
    expect(html).toContain("002-implementation-abcd12")
    expect(html).toContain('iframe src="/terminal-views/thread%2F03.01.02/ttyd"')
  })

  test("redirects ttyd proxy routes only to local read-only ttyd targets", async () => {
    const app = createTerminalViewRoutes({
      config: {
        hostname: "127.0.0.1",
        port: 3000,
        repoRoot: "/tmp/repo",
      },
      terminalProvider: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd ready",
            mode: "ttyd" as const,
          }
        },
        async listViews(_options) {
          return []
        },
        async resolveViewTarget() {
          return {
            terminalViewId: "thread/03.01.02",
            sessionName: "002-implementation-abcd12",
            upstreamOrigin: "http://127.0.0.1:7681",
            upstreamPath: "/",
            port: 7681,
            pid: 1234,
          }
        },
        close() {},
      },
      readSnapshot: async () => baseReadModel,
    })

    const response = await app.request("/terminal-views/thread%2F03.01.02/ttyd", {
      redirect: "manual",
    })

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("http://127.0.0.1:7681/")
  })

  test("renders a degraded placeholder when the snapshot only exposes degraded terminal views", async () => {
    const app = createTerminalViewRoutes({
      config: {
        hostname: "127.0.0.1",
        port: 3000,
        repoRoot: "/tmp/repo",
      },
      terminalProvider: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd ready",
            mode: "ttyd" as const,
          }
        },
        async listViews(_options) {
          return []
        },
        async resolveViewTarget() {
          throw new Error("should not resolve degraded ttyd targets")
        },
        close() {},
      },
      readSnapshot: async () => createDegradedOnlyReadModel(),
    })

    const response = await app.request("/terminal-views/branch%2Fbranch-1")

    expect(response.status).toBe(200)

    const html = await response.text()
    expect(html).toContain("This terminal view is not currently available.")
    expect(html).toContain("The ttyd target will appear here automatically")
    expect(html).not.toContain('<iframe src="/terminal-views/branch%2Fbranch-1/ttyd"')
  })

  test("redirects degraded ttyd proxy requests back to the terminal placeholder page", async () => {
    const app = createTerminalViewRoutes({
      config: {
        hostname: "127.0.0.1",
        port: 3000,
        repoRoot: "/tmp/repo",
      },
      terminalProvider: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd ready",
            mode: "ttyd" as const,
          }
        },
        async listViews(_options) {
          return []
        },
        async resolveViewTarget() {
          throw new Error("should not resolve degraded ttyd targets")
        },
        close() {},
      },
      readSnapshot: async () => createDegradedOnlyReadModel(),
    })

    const response = await app.request("/terminal-views/branch%2Fbranch-1/ttyd", {
      redirect: "manual",
    })

    expect(response.status).toBe(307)
    expect(response.headers.get("location")).toBe("/terminal-views/branch%2Fbranch-1")
  })

  test("rejects non-local ttyd targets to preserve observability-only scope", async () => {
    const app = createTerminalViewRoutes({
      config: {
        hostname: "127.0.0.1",
        port: 3000,
        repoRoot: "/tmp/repo",
      },
      terminalProvider: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd ready",
            mode: "ttyd" as const,
          }
        },
        async listViews(_options) {
          return []
        },
        async resolveViewTarget() {
          return {
            terminalViewId: "thread/03.01.02",
            sessionName: "002-implementation-abcd12",
            upstreamOrigin: "https://example.com",
            upstreamPath: "/not-local",
            port: 443,
            pid: 1234,
          }
        },
        close() {},
      },
      readSnapshot: async () => baseReadModel,
    })

    const response = await app.request("/terminal-views/thread%2F03.01.02/ttyd")
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Terminal observability routes only allow local ttyd targets.",
    })
  })

  test("returns a terminal-unavailable 503 when lazy ttyd launch fails", async () => {
    const app = createTerminalViewRoutes({
      config: {
        hostname: "127.0.0.1",
        port: 3000,
        repoRoot: "/tmp/repo",
      },
      terminalProvider: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd ready",
            mode: "ttyd" as const,
          }
        },
        async listViews(_options) {
          return []
        },
        async resolveViewTarget() {
          throw new Error("ttyd failed to start for 002-implementation-abcd12")
        },
        close() {},
      },
      readSnapshot: async () => baseReadModel,
    })

    const response = await app.request("/terminal-views/thread%2F03.01.02/ttyd")

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      ok: false,
      error:
        'Terminal view "thread/03.01.02" is temporarily unavailable. ttyd failed to start for 002-implementation-abcd12',
    })
  })
})
