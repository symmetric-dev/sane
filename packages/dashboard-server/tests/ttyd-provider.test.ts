import { describe, expect, test } from "bun:test"

import type {
  DashboardTmuxObservabilitySnapshot,
  DashboardTmuxSessionMetadata,
} from "../../workstreams/src/internal/dashboard-contracts.ts"

import {
  buildTtydLaunchArgs,
  createTtydTerminalObservabilityProvider,
  type SpawnedTtydInstance,
  type TtydProcessLauncher,
} from "../src/index.ts"

function createSession(
  overrides: Partial<DashboardTmuxSessionMetadata> = {},
): DashboardTmuxSessionMetadata {
  return {
    session_id: "$1",
    session_name: "002-implementation-thread-a",
    role: "implementation_thread",
    state: "attached",
    observed_at: "2026-04-16T12:00:00.000Z",
    stage_id: "03",
    batch_id: "03.01",
    thread_id: "03.01.01",
    pane_count: 1,
    correlation: {
      status: "matched",
      target_kind: "implementation_thread",
      target_id: "03.01.01",
      stage_id: "03",
      batch_id: "03.01",
      thread_id: "03.01.01",
    },
    ...overrides,
  }
}

function createTmuxSnapshot(
  sessions: DashboardTmuxSessionMetadata[],
): DashboardTmuxObservabilitySnapshot {
  return {
    checked_at: "2026-04-16T12:00:00.000Z",
    availability: "ready",
    issues: [],
    sessions,
  }
}

function createFakeInstance(port: number): SpawnedTtydInstance & { stopped: boolean } {
  let resolveClosed = () => {}

  return {
    closed: new Promise<void>((resolve) => {
      resolveClosed = resolve
    }),
    pid: port + 1000,
    port,
    stopped: false,
    stop(): void {
      this.stopped = true
      resolveClosed()
    },
    upstreamOrigin: `http://127.0.0.1:${port}`,
    upstreamPath: "/",
  }
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void

  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    void innerReject
  })

  return { promise, resolve }
}

describe("ttyd terminal observability provider", () => {
  test("builds persistent read-only ttyd launch arguments for tmux-backed sessions", () => {
    const args = buildTtydLaunchArgs({
      label: "Implementation 03 03.01",
      port: 43001,
      sessionName: "002-implementation-thread-a",
    })

    expect(args).toContain("tmux")
    expect(args).toContain("attach-session")
    expect(args).toContain("-r")
    expect(args).not.toContain("-W")
    expect(args).not.toContain("-q")
    expect(args).not.toContain("--exit-no-conn")
    expect(args).toEqual([
      "-i",
      "127.0.0.1",
      "-p",
      "43001",
      "-t",
      "disableLeaveAlert=true",
      "-t",
      "disableReconnect=true",
      "-t",
      "disableResizeOverlay=true",
      "-t",
      "titleFixed=Implementation 03 03.01",
      "tmux",
      "attach-session",
      "-r",
      "-t",
      "002-implementation-thread-a",
    ])
  })

  test("tracks stable view mappings and launches ttyd lazily", async () => {
    const launches: Array<{ label: string; sessionName: string; terminalViewId: string }> = []
    const instances: Array<SpawnedTtydInstance & { stopped: boolean }> = []
    const launcher: TtydProcessLauncher = {
      async getCapability() {
        return {
          enabled: true,
          message: "ttyd is available.",
          mode: "ttyd" as const,
        }
      },
      async launch(request) {
        launches.push(request)
        const instance = createFakeInstance(43120)
        instances.push(instance)
        return instance
      },
    }
    const provider = createTtydTerminalObservabilityProvider({ launcher })
    const tmux = createTmuxSnapshot([createSession()])

    const views = await provider.listViews({
      checkedAt: tmux.checked_at,
      tmux,
    })

    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({
      terminal_view_id: "thread/03.01.01",
      session_name: "002-implementation-thread-a",
      label: "Implementation 03 03.01",
      status: "available",
      transport: "ttyd",
      read_only: true,
    })
    expect(launches).toHaveLength(0)

    const target = await provider.resolveViewTarget("thread/03.01.01")
    expect(target).toMatchObject({
      terminalViewId: "thread/03.01.01",
      sessionName: "002-implementation-thread-a",
      upstreamOrigin: "http://127.0.0.1:43120",
      upstreamPath: "/",
      port: 43120,
    })
    expect(launches).toEqual([
      {
        label: "Implementation 03 03.01",
        sessionName: "002-implementation-thread-a",
        terminalViewId: "thread/03.01.01",
      },
    ])

    const sameTarget = await provider.resolveViewTarget("thread/03.01.01")
    expect(sameTarget).toEqual(target)
    expect(launches).toHaveLength(1)

    provider.close()
    expect(instances[0]?.stopped).toBe(true)
  })

  test("cleans up stale processes and surfaces launch failures conservatively", async () => {
    const instance = createFakeInstance(43121)
    let failLaunch = false
    const launcher: TtydProcessLauncher = {
      async getCapability() {
        return {
          enabled: true,
          message: "ttyd is available.",
          mode: "ttyd" as const,
        }
      },
      async launch() {
        if (failLaunch) {
          throw new Error("ttyd failed to start for 002-implementation-thread-b")
        }

        return instance
      },
    }
    const provider = createTtydTerminalObservabilityProvider({ launcher })

    await provider.listViews({
      checkedAt: "2026-04-16T12:00:00.000Z",
      tmux: createTmuxSnapshot([createSession()]),
    })
    await provider.resolveViewTarget("thread/03.01.01")
    expect(instance.stopped).toBe(false)

    await provider.listViews({
      checkedAt: "2026-04-16T12:05:00.000Z",
      tmux: createTmuxSnapshot([]),
    })
    expect(instance.stopped).toBe(true)
    expect(await provider.resolveViewTarget("thread/03.01.01")).toBeNull()

    failLaunch = true
    const degradedSession = createSession({
      session_id: "$2",
      session_name: "002-implementation-thread-b",
      thread_id: "03.01.02",
      correlation: {
        status: "matched",
        target_kind: "implementation_thread",
        target_id: "03.01.02",
        stage_id: "03",
        batch_id: "03.01",
        thread_id: "03.01.02",
      },
    })
    await provider.listViews({
      checkedAt: "2026-04-16T12:10:00.000Z",
      tmux: createTmuxSnapshot([degradedSession]),
    })

    await expect(provider.resolveViewTarget("thread/03.01.02")).rejects.toThrow(
      "ttyd failed to start for 002-implementation-thread-b",
    )

    const viewsAfterFailure = await provider.listViews({
      checkedAt: "2026-04-16T12:15:00.000Z",
      tmux: createTmuxSnapshot([degradedSession]),
    })
    expect(viewsAfterFailure[0]).toMatchObject({
      terminal_view_id: "thread/03.01.02",
      status: "unavailable",
      notes: "ttyd failed to start for 002-implementation-thread-b",
    })
  })

  test("keeps canonical rendering safe when ttyd is missing", async () => {
    let launches = 0
    const provider = createTtydTerminalObservabilityProvider({
      launcher: {
        async getCapability() {
          return {
            enabled: false,
            message: "ttyd is unavailable or not installed on this machine.",
            mode: "ttyd" as const,
          }
        },
        async launch() {
          launches += 1
          return createFakeInstance(43122)
        },
      },
    })

    const [view] = await provider.listViews({
      checkedAt: "2026-04-16T12:00:00.000Z",
      tmux: createTmuxSnapshot([createSession()]),
    })

    expect(view).toMatchObject({
      terminal_view_id: "thread/03.01.01",
      status: "unavailable",
      notes: "ttyd is unavailable or not installed on this machine.",
    })
    expect(await provider.resolveViewTarget("thread/03.01.01")).toBeNull()
    expect(launches).toBe(0)
  })

  test("still launches read-only ttyd for observed exited tmux sessions while keeping missing targets unavailable", async () => {
    let launches = 0
    const provider = createTtydTerminalObservabilityProvider({
      launcher: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd is available.",
            mode: "ttyd" as const,
          }
        },
        async launch() {
          launches += 1
          return createFakeInstance(43123)
        },
      },
    })

    const views = await provider.listViews({
      checkedAt: "2026-04-16T12:00:00.000Z",
      tmux: createTmuxSnapshot([
        createSession({
          session_id: "missing:002-implementation-missing",
          session_name: "002-implementation-missing",
          state: "unknown",
          correlation: {
            status: "missing",
            target_kind: "implementation_thread",
            target_id: "03.01.01",
            stage_id: "03",
            batch_id: "03.01",
            thread_id: "03.01.01",
          },
        }),
        createSession({
          session_id: "$2",
          session_name: "002-implementation-unknown",
          state: "unknown",
          thread_id: "03.01.02",
          correlation: {
            status: "matched",
            target_kind: "implementation_thread",
            target_id: "03.01.02",
            stage_id: "03",
            batch_id: "03.01",
            thread_id: "03.01.02",
          },
        }),
        createSession({
          session_id: "$3",
          session_name: "002-supervision-exited",
          role: "supervision_branch",
          state: "exited",
          correlation: {
            status: "matched",
            target_kind: "supervision_branch",
            target_id: "branch-1",
            stage_id: "03",
            batch_id: "03.01",
          },
        }),
      ]),
    })

    expect(views).toEqual([
      expect.objectContaining({
        terminal_view_id: "thread/03.01.01",
        status: "unavailable",
        notes: "tmux did not observe the referenced session, so no terminal can be launched.",
      }),
      expect.objectContaining({
        terminal_view_id: "thread/03.01.02",
        status: "unavailable",
        notes: "Session state is unknown, so ttyd launch was skipped conservatively.",
      }),
      expect.objectContaining({
        terminal_view_id: "branch/branch-1",
        label: "Supervision 03 03.01",
        status: "available",
      }),
    ])

    expect(await provider.resolveViewTarget("thread/03.01.01")).toBeNull()
    expect(await provider.resolveViewTarget("thread/03.01.02")).toBeNull()
    await expect(provider.resolveViewTarget("branch/branch-1")).resolves.toMatchObject({
      terminalViewId: "branch/branch-1",
      sessionName: "002-supervision-exited",
      port: 43123,
    })
    expect(launches).toBe(1)
  })

  test("restarts ttyd when a terminal view remaps sessions", async () => {
    const launchedForSessions: string[] = []
    const instances: Array<SpawnedTtydInstance & { stopped: boolean }> = []
    const provider = createTtydTerminalObservabilityProvider({
      launcher: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd is available.",
            mode: "ttyd" as const,
          }
        },
        async launch(request) {
          launchedForSessions.push(request.sessionName)
          const instance = createFakeInstance(43124 + instances.length)
          instances.push(instance)
          return instance
        },
      },
    })

    await provider.listViews({
      checkedAt: "2026-04-16T12:00:00.000Z",
      tmux: createTmuxSnapshot([createSession()]),
    })
    const firstTarget = await provider.resolveViewTarget("thread/03.01.01")
    expect(firstTarget).toMatchObject({
      sessionName: "002-implementation-thread-a",
      port: 43124,
    })
    expect(instances[0]?.stopped).toBe(false)

    await provider.listViews({
      checkedAt: "2026-04-16T12:05:00.000Z",
      tmux: createTmuxSnapshot([
        createSession({
          session_id: "$2",
          session_name: "002-implementation-thread-b",
        }),
      ]),
    })

    expect(instances[0]?.stopped).toBe(true)

    const secondTarget = await provider.resolveViewTarget("thread/03.01.01")
    expect(secondTarget).toMatchObject({
      sessionName: "002-implementation-thread-b",
      port: 43125,
    })

    expect(launchedForSessions).toEqual([
      "002-implementation-thread-a",
      "002-implementation-thread-b",
    ])

    provider.close()
    expect(instances[1]?.stopped).toBe(true)
  })

  test("keeps an in-flight ttyd launch stable across snapshot refreshes for the same session", async () => {
    const deferredLaunch = createDeferredPromise<SpawnedTtydInstance & { stopped: boolean }>()
    let launchCount = 0
    const provider = createTtydTerminalObservabilityProvider({
      launcher: {
        async getCapability() {
          return {
            enabled: true,
            message: "ttyd is available.",
            mode: "ttyd" as const,
          }
        },
        async launch() {
          launchCount += 1
          return await deferredLaunch.promise
        },
      },
    })

    await provider.listViews({
      checkedAt: "2026-04-16T12:00:00.000Z",
      tmux: createTmuxSnapshot([createSession()]),
    })

    const targetPromise = provider.resolveViewTarget("thread/03.01.01")

    await provider.listViews({
      checkedAt: "2026-04-16T12:00:05.000Z",
      tmux: createTmuxSnapshot([createSession()]),
    })

    deferredLaunch.resolve(createFakeInstance(43126))

    await expect(targetPromise).resolves.toMatchObject({
      terminalViewId: "thread/03.01.01",
      sessionName: "002-implementation-thread-a",
      port: 43126,
    })
    expect(launchCount).toBe(1)
  })
})
