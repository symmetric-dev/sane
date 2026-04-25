import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE,
  CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE,
  CURRENT_WORKSTREAM_OBSERVABILITY_ROUTE,
  CURRENT_WORKSTREAM_RUNTIME_ROUTE,
  CURRENT_WORKSTREAM_STATUS_ROUTE,
  CURRENT_WORKSTREAM_SUPERVISION_ROUTE,
  CURRENT_WORKSTREAM_TREE_ROUTE,
  type CurrentWorkstreamDashboardSnapshot,
} from "../../workstreams/src/internal/dashboard-contracts.ts"
import {
  getResolvedCurrentWorkstreamDashboardObservabilitySnapshot,
  getResolvedWorkstreamStatusSnapshot,
  getResolvedWorkstreamTreeSnapshot,
} from "../../workstreams/src/internal/server.ts"

import {
  LOCAL_ONLY_HOSTNAME,
  createNoopTerminalObservabilityProvider,
  normalizeDashboardServerConfig,
  startDashboardServer,
} from "../src/index.ts"

const servers: Array<{ stop(): void }> = []
const tempDirs: string[] = []

async function createDashboardFixtureRepo(args: {
  includeRuntimeState?: boolean
} = {}): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "agenv-dashboard-server-"))
  const streamId = "002-web-workstream-dashboard"

  tempDirs.push(tempDir)

  await mkdir(join(tempDir, "work", streamId), { recursive: true })
  await writeFile(
    join(tempDir, "work", "index.json"),
    JSON.stringify(
      {
        version: "1.0.0",
        last_updated: "2026-04-15T12:00:00.000Z",
        current_stream: streamId,
        streams: [
          {
            id: streamId,
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
            updated_at: "2026-04-15T12:00:00.000Z",
            path: `work/${streamId}`,
            generated_by: { workstreams: "0.5.1" },
          },
        ],
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(tempDir, "work", streamId, "tasks.json"),
    JSON.stringify(
      {
        version: "2.0.0",
        stream_id: streamId,
        last_updated: "2026-04-15T12:00:00.000Z",
        runtime_summary: {
          updated_at: "2026-04-15T12:00:00.000Z",
          batches: {
            "02.02": {
              batch_id: "02.02",
              run_id: "batch-run-1",
              status: "running",
              updated_at: "2026-04-15T12:00:00.000Z",
              started_at: "2026-04-15T11:30:00.000Z",
              thread_summary: {
                total: 1,
                pending: 0,
                running: 1,
                completed: 0,
                failed: 0,
              },
            },
          },
          supervision: {
            updated_at: "2026-04-15T12:00:00.000Z",
            active_run_id: "supervision-run-1",
            active_run: {
              run_id: "supervision-run-1",
              stage_id: "02",
              status: "running",
              updated_at: "2026-04-15T12:00:00.000Z",
              started_at: "2026-04-15T11:45:00.000Z",
              current_batch_id: "02.02",
              review_passes: 1,
              branch_session_id: "branch-session-1",
              root_session_id: "root-session-1",
            },
          },
        },
        ...(args.includeRuntimeState
          ? {
              runtime_state: {
                version: "1.0.0",
                last_updated: "2026-04-15T12:00:00.000Z",
                threads: [],
                batches: {
                  "02.02": {
                    version: "1.0.0",
                    streamId,
                    batchId: "02.02",
                    runId: "batch-run-1",
                    tmuxSessionName: "002-implementation-real-session",
                    mode: "headless",
                    status: "running",
                    startedAt: "2026-04-15T11:30:00.000Z",
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
                        threadId: "02.02.02",
                        threadName: "tmux discovery and correlation",
                        firstTaskId: "02.02.02.01",
                        status: "running",
                        updatedAt: "2026-04-15T12:00:00.000Z",
                      },
                    ],
                  },
                },
                supervision: {
                  version: "1.0.0",
                  stream_id: streamId,
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
              },
            }
          : {}),
        tasks: [
          {
            id: "02.02.01.01",
            name: "Resolve the current workstream from the workstream index",
            stage_name: "Build the Bun server package and backend snapshot pipeline",
            batch_name: "Implement canonical snapshot assembly and tmux discovery",
            thread_name: "Current-workstream snapshot assembly",
            status: "completed",
            created_at: "2026-04-15T11:00:00.000Z",
            updated_at: "2026-04-15T11:30:00.000Z",
          },
          {
            id: "02.02.01.02",
            name: "Expose snapshot assembly through the dashboard routes",
            stage_name: "Build the Bun server package and backend snapshot pipeline",
            batch_name: "Implement canonical snapshot assembly and tmux discovery",
            thread_name: "Current-workstream snapshot assembly",
            status: "in_progress",
            created_at: "2026-04-15T11:30:00.000Z",
            updated_at: "2026-04-15T12:00:00.000Z",
          },
        ],
      },
      null,
      2,
    ),
  )

  return tempDir
}

function normalizeObservabilityTmux(snapshot: CurrentWorkstreamDashboardSnapshot["observability"]["tmux"]) {
  return {
    availability: snapshot.availability,
    issues: snapshot.issues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      message: issue.message,
      related_ids: issue.related_ids ?? [],
    })),
    sessions: snapshot.sessions.map((session) => ({
      session_name: session.session_name,
      role: session.role,
      batch_id: session.batch_id,
      stage_id: session.stage_id,
      thread_id: session.thread_id,
      run_id: session.run_id,
      window_name: session.window_name,
      pane_count: session.pane_count,
      panes: (session.panes ?? []).map((pane) => ({
        pane_id: pane.pane_id,
        pane_index: pane.pane_index,
        active: pane.active,
        title: pane.title,
        tty: pane.tty,
        current_command: pane.current_command,
        current_path: pane.current_path,
      })),
      correlation: session.correlation,
    })),
  }
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true })
  }
})

describe("dashboard server", () => {
  test("normalizes to localhost-only binding", () => {
    expect(
      normalizeDashboardServerConfig({
        hostname: "127.0.0.1",
        port: 0,
        repoRoot: "/tmp/repo",
      }),
    ).toEqual({
      hostname: LOCAL_ONLY_HOSTNAME,
      port: 0,
      repoRoot: "/tmp/repo",
    })

    expect(() =>
      normalizeDashboardServerConfig({
        hostname: "0.0.0.0",
      }),
    ).toThrow(
      `Dashboard server is local-only and must bind to ${LOCAL_ONLY_HOSTNAME}`,
    )
  })

  test("serves the scaffolded dashboard routes", async () => {
    const repoRoot = await createDashboardFixtureRepo()
    const server = await startDashboardServer({
      port: 0,
      repoRoot,
      terminalProvider: createNoopTerminalObservabilityProvider(),
    })

    servers.push(server)

    expect(server.config.hostname).toBe(LOCAL_ONLY_HOSTNAME)
    expect(server.url.startsWith(`http://${LOCAL_ONLY_HOSTNAME}:`)).toBe(true)

    const healthResponse = await fetch(new URL("/api/health", server.url))
    expect(healthResponse.status).toBe(200)

    const healthPayload = await healthResponse.json()
    expect(healthPayload).toMatchObject({
      ok: true,
      liveRefresh: {
        transport: "sse",
      },
      observability: {
        enabled: false,
        mode: "placeholder",
      },
      server: {
        hostname: LOCAL_ONLY_HOSTNAME,
        repoRoot,
      },
      status: {
        canonicalState: "ready",
        terminalViews: "ready",
      },
    })

    const pageResponse = await fetch(server.url)
    expect(pageResponse.status).toBe(200)

    const pageHtml = await pageResponse.text()
    expect(pageHtml).toContain("Current workstream")
    expect(pageHtml).toContain("Status overview")
    expect(pageHtml).toContain("Work tree")
    expect(pageHtml).toContain("Stage level")
    expect(pageHtml).toContain("Matched terminal sessions")
    expect(pageHtml).not.toContain("Observability notes")
    expect(pageHtml).toContain("Page up")
    expect(pageHtml).toContain("Bottom")
    expect(pageHtml).toContain("terminal-view-status")
    expect(pageHtml).toContain("terminal-scrollback-editor")
    expect(pageHtml).toContain(CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE.path)
    expect(pageHtml).toContain("/api/current-workstream/snapshot")
    expect(pageHtml).toContain("Loading canonical snapshot")

    const faviconResponse = await fetch(new URL("/favicon.ico", server.url))
    expect(faviconResponse.status).toBe(204)

    const snapshotResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE.path, server.url),
    )
    expect(snapshotResponse.status).toBe(200)

    const snapshotPayload =
      (await snapshotResponse.json()) as CurrentWorkstreamDashboardSnapshot
    const expectedTmux = getResolvedCurrentWorkstreamDashboardObservabilitySnapshot(repoRoot).tmux
    expect(snapshotPayload).toMatchObject({
      schema_version: "1.0.0",
      canonical_state: {
        source_of_truth: "tasks.json",
        status: {
          stream: {
            id: "002-web-workstream-dashboard",
            is_current: true,
          },
          aggregate_status: "in_progress",
        },
        tree: {
          streamId: "002-web-workstream-dashboard",
        },
        supervision: {
          active_run_id: "supervision-run-1",
        },
        runtime: {
          summary: {
            supervision: {
              active_run_id: "supervision-run-1",
            },
          },
        },
      },
      observability: {
        terminal_views: {
          availability: "unavailable",
          transport: "ttyd",
          views: [],
        },
      },
    })
    expect(normalizeObservabilityTmux(snapshotPayload.observability.tmux)).toEqual(
      normalizeObservabilityTmux(expectedTmux),
    )

    const statusResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_STATUS_ROUTE.path, server.url),
    )
    expect(statusResponse.status).toBe(200)
    expect(await statusResponse.json()).toEqual(snapshotPayload.canonical_state.status)

    const treeResponse = await fetch(
      new URL(`${CURRENT_WORKSTREAM_TREE_ROUTE.path}?batch_id=2.2`, server.url),
    )
    expect(treeResponse.status).toBe(200)
    expect(await treeResponse.json()).toMatchObject({
      streamId: "002-web-workstream-dashboard",
      stages: [
        {
          id: "02",
        },
      ],
    })

    const runtimeResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_RUNTIME_ROUTE.path, server.url),
    )
    expect(runtimeResponse.status).toBe(200)
    expect(snapshotPayload.canonical_state.runtime).toBeDefined()
    expect(await runtimeResponse.json()).toEqual(snapshotPayload.canonical_state.runtime)

    const supervisionResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_SUPERVISION_ROUTE.path, server.url),
    )
    expect(supervisionResponse.status).toBe(200)
    expect(await supervisionResponse.json()).toEqual(snapshotPayload.canonical_state.supervision)

    const observabilityResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_OBSERVABILITY_ROUTE.path, server.url),
    )
    expect(observabilityResponse.status).toBe(200)
    const observabilityPayload =
      (await observabilityResponse.json()) as CurrentWorkstreamDashboardSnapshot["observability"]
    expect(normalizeObservabilityTmux(observabilityPayload.tmux)).toEqual(
      normalizeObservabilityTmux(expectedTmux),
    )
    expect(observabilityPayload.terminal_views).toMatchObject({
      availability: snapshotPayload.observability.terminal_views.availability,
      transport: snapshotPayload.observability.terminal_views.transport,
      issues: snapshotPayload.observability.terminal_views.issues,
      views: snapshotPayload.observability.terminal_views.views,
    })
  
    const liveResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE.path, server.url),
    )
    expect(liveResponse.status).toBe(200)
    expect(liveResponse.headers.get("content-type")).toContain(
      "text/event-stream",
    )

    const reader = liveResponse.body?.getReader()
    expect(reader).toBeDefined()

    const firstChunk = await reader!.read()
    const firstText = new TextDecoder().decode(firstChunk.value)
    expect(firstText).toContain("event: heartbeat")

    await reader!.cancel()
  })

  test("returns structured route errors for invalid batch filters", async () => {
    const repoRoot = await createDashboardFixtureRepo()
    const server = await startDashboardServer({
      port: 0,
      repoRoot,
      terminalProvider: createNoopTerminalObservabilityProvider(),
    })

    servers.push(server)

    const response = await fetch(
      new URL(`${CURRENT_WORKSTREAM_TREE_ROUTE.path}?batch_id=bad-batch`, server.url),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Invalid batch ID format: "bad-batch"',
    })
  })

  test("keeps canonical snapshot routes available when terminal listing fails", async () => {
    const repoRoot = await createDashboardFixtureRepo()
    const server = await startDashboardServer({
      port: 0,
      repoRoot,
      terminalProvider: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd ready",
            mode: "ttyd" as const,
          }
        },
        async listViews() {
          throw new Error("simulated ttyd provider list failure")
        },
        async resolveViewTarget() {
          return null
        },
        close() {},
      },
    })

    servers.push(server)

    const snapshotResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE.path, server.url),
    )
    expect(snapshotResponse.status).toBe(200)

    const snapshotPayload =
      (await snapshotResponse.json()) as CurrentWorkstreamDashboardSnapshot

    expect(snapshotPayload.canonical_state.status.stream.id).toBe(
      "002-web-workstream-dashboard",
    )
    expect(snapshotPayload.observability.terminal_views).toMatchObject({
      availability: "unavailable",
      transport: "ttyd",
      views: [],
    })
    expect(snapshotPayload.observability.issues).toContainEqual(
      expect.objectContaining({
        code: "ttyd_unavailable",
        message:
          "Terminal observability provider failed while listing views: simulated ttyd provider list failure",
      }),
    )
  })

  test("mirrors the real current-workstream tmux observability helper", async () => {
    const repoRoot = await createDashboardFixtureRepo({ includeRuntimeState: true })
    const server = await startDashboardServer({
      now: () => new Date("2026-04-15T12:00:00.000Z"),
      port: 0,
      repoRoot,
      terminalProvider: createNoopTerminalObservabilityProvider(),
    })

    servers.push(server)

    const snapshotResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE.path, server.url),
    )
    expect(snapshotResponse.status).toBe(200)

    const snapshotPayload =
      (await snapshotResponse.json()) as CurrentWorkstreamDashboardSnapshot
    const expectedTmux = getResolvedCurrentWorkstreamDashboardObservabilitySnapshot(repoRoot).tmux
    expect(normalizeObservabilityTmux(snapshotPayload.observability.tmux)).toEqual(
      normalizeObservabilityTmux(expectedTmux),
    )

    const observabilityResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_OBSERVABILITY_ROUTE.path, server.url),
    )
    expect(observabilityResponse.status).toBe(200)
    const observabilityPayload = (await observabilityResponse.json()) as CurrentWorkstreamDashboardSnapshot["observability"]
    expect(observabilityPayload).toEqual(snapshotPayload.observability)
    expect(normalizeObservabilityTmux(observabilityPayload.tmux)).toEqual(
      normalizeObservabilityTmux(expectedTmux),
    )
    expect(observabilityPayload.terminal_views.availability).toBe("unavailable")
  })

  test("keeps canonical status and tree stable when observability is degraded", async () => {
    const repoRoot = await createDashboardFixtureRepo({ includeRuntimeState: true })
    const server = await startDashboardServer({
      port: 0,
      repoRoot,
      terminalProvider: createNoopTerminalObservabilityProvider(),
    })

    servers.push(server)

    const snapshotResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE.path, server.url),
    )
    expect(snapshotResponse.status).toBe(200)
    const snapshotPayload =
      (await snapshotResponse.json()) as CurrentWorkstreamDashboardSnapshot

    const expectedStatus = getResolvedWorkstreamStatusSnapshot(repoRoot)
    const { runtime: _runtime, ...expectedCanonicalStatus } = expectedStatus
    const expectedTree = getResolvedWorkstreamTreeSnapshot(repoRoot)

    expect(snapshotPayload.canonical_state.status).toEqual(expectedCanonicalStatus)
    expect(snapshotPayload.canonical_state.tree).toEqual(expectedTree)

    const tmuxIssueCodes = snapshotPayload.observability.tmux.issues.map((issue) => issue.code)
    expect(tmuxIssueCodes.some((code) => code === "tmux_unavailable" || code === "tmux_missing_match")).toBe(
      true,
    )

    expect(snapshotPayload.observability.terminal_views).toMatchObject({
      availability: "unavailable",
      issues: [
        expect.objectContaining({
          code: "ttyd_unavailable",
          message: "Terminal observability is scaffolded but not connected yet.",
        }),
      ],
    })

    const statusResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_STATUS_ROUTE.path, server.url),
    )
    expect(statusResponse.status).toBe(200)
    expect(await statusResponse.json()).toEqual(expectedCanonicalStatus)

    const treeResponse = await fetch(
      new URL(CURRENT_WORKSTREAM_TREE_ROUTE.path, server.url),
    )
    expect(treeResponse.status).toBe(200)
    expect(await treeResponse.json()).toEqual(expectedTree)
  })
})
