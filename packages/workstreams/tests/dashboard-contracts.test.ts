import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  CURRENT_WORKSTREAM_DASHBOARD_ROUTE_CONTRACTS,
  CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE,
  CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_SCHEMA_VERSION,
  CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE,
  CURRENT_WORKSTREAM_SUPERVISION_ROUTE,
  DASHBOARD_PAGE_ROUTE,
  buildDashboardTerminalViewRoutes,
  type CurrentWorkstreamDashboardSnapshot,
  type DashboardTerminalViewMetadata,
} from "../src/internal/dashboard-contracts.ts"

describe("dashboard contracts", () => {
  test("defines a snapshot contract with explicit canonical and observability sections", () => {
    const snapshot = {
      schema_version: CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_SCHEMA_VERSION,
      generated_at: "2026-04-15T12:00:00.000Z",
      canonical_state: {
        source_of_truth: "tasks.json",
        status: {
          stream: {
            id: "002-web-workstream-dashboard",
            name: "web-workstream-dashboard",
            order: 2,
            size: "medium",
            path: "work/002-web-workstream-dashboard",
            created_at: "2026-04-15T00:00:00.000Z",
            updated_at: "2026-04-15T12:00:00.000Z",
            generated_by: { workstreams: "0.5.1" },
            is_current: true,
          },
          aggregate_status: "in_progress",
          counts: {
            total: 3,
            pending: 1,
            in_progress: 1,
            completed: 1,
            blocked: 0,
            cancelled: 0,
            done: 1,
          },
          completion: {
            total_tasks: 3,
            completed_tasks: 1,
            cancelled_tasks: 0,
            done_tasks: 1,
            remaining_tasks: 2,
            percent_complete: 33,
            percent_done: 33,
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
          taskCount: 3,
          taskCounts: {
            total: 3,
            pending: 1,
            in_progress: 1,
            completed: 1,
            blocked: 0,
            cancelled: 0,
            done: 1,
          },
          stages: [],
        },
        runtime: {
          summary: {
            updated_at: "2026-04-15T12:00:00.000Z",
            batches: {},
          },
          entries: [],
        },
      },
      observability: {
        checked_at: "2026-04-15T12:00:00.000Z",
        availability: "degraded",
        issues: [
          {
            code: "ttyd_unavailable",
            severity: "warn",
            message: "No ttyd-backed views were provisioned.",
          },
        ],
        tmux: {
          checked_at: "2026-04-15T12:00:00.000Z",
          availability: "ready",
          issues: [],
          sessions: [],
        },
        terminal_views: {
          checked_at: "2026-04-15T12:00:00.000Z",
          availability: "unavailable",
          transport: "ttyd",
          issues: [
            {
              code: "ttyd_unavailable",
              severity: "warn",
              message: "No ttyd-backed views were provisioned.",
            },
          ],
          views: [],
        },
      },
    } satisfies CurrentWorkstreamDashboardSnapshot

    expect(snapshot.canonical_state.source_of_truth).toBe("tasks.json")
    expect("observability" in snapshot).toBe(true)
    expect("runtime" in snapshot.canonical_state.status).toBe(false)
  })

  test("publishes stable page, json, and live-update route contracts", () => {
    expect(DASHBOARD_PAGE_ROUTE).toMatchObject({
      route_id: "dashboard_page",
      method: "GET",
      path: "/",
      response_kind: "html",
    })

    expect(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE).toMatchObject({
      route_id: "current_workstream_dashboard_snapshot",
      path: "/api/current-workstream/snapshot",
      response_kind: "json",
      response_contract: "CurrentWorkstreamDashboardSnapshot",
    })

    expect(CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE).toMatchObject({
      route_id: "current_workstream_live_updates",
      path: "/api/current-workstream/live",
      response_kind: "sse",
      event_contract: "CurrentWorkstreamDashboardLiveUpdateEvent",
    })

    expect(CURRENT_WORKSTREAM_SUPERVISION_ROUTE).toMatchObject({
      route_id: "current_workstream_supervision",
      path: "/api/current-workstream/supervision",
      response_kind: "json",
      response_contract: "WorkstreamRuntimeSupervisionSummary | null",
    })

    expect(CURRENT_WORKSTREAM_DASHBOARD_ROUTE_CONTRACTS).toHaveLength(8)
  })

  test("builds stable terminal-view routes for read-only ttyd embeddings", () => {
    const routes = buildDashboardTerminalViewRoutes("thread/01.02.03")

    expect(routes).toEqual({
      view_path: "/terminal-views/thread%2F01.02.03",
      ttyd_proxy_path: "/terminal-views/thread%2F01.02.03/ttyd",
    })

    const view = {
      terminal_view_id: "thread/01.02.03",
      label: "Thread 03 terminal",
      status: "available",
      transport: "ttyd",
      read_only: true,
      session_id: "$1",
      session_name: "ws-002-01.02-thread-03",
      role: "implementation_thread",
      observed_at: "2026-04-15T12:00:00.000Z",
      stage_id: "01",
      batch_id: "01.02",
      thread_id: "01.02.03",
      routes,
      correlation: {
        status: "matched",
        target_kind: "implementation_thread",
        target_id: "01.02.03",
        stage_id: "01",
        batch_id: "01.02",
        thread_id: "01.02.03",
      },
    } satisfies DashboardTerminalViewMetadata

    expect(view.read_only).toBe(true)
    expect(view.routes.ttyd_proxy_path.endsWith("/ttyd")).toBe(true)
  })

  test("publishes dashboard contracts as a package export", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      exports?: Record<string, { types?: string; import?: string }>
    }

    expect(packageJson.exports?.["./internal/dashboard-contracts"]).toEqual({
      types: "./dist/src/internal/dashboard-contracts.d.ts",
      import: "./dist/src/internal/dashboard-contracts.js",
    })
  })
})
