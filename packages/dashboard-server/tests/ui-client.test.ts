import { describe, expect, test } from "bun:test"

import { renderDashboardClientScript } from "../src/routes/ui.ts"

class FakeElement {
  id: string
  hidden = false
  dataset: Record<string, string> = {}
  textContent = ""
  value = ""
  disabled = false
  checked = false
  style: Record<string, string> = {}
  private html = ""
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>()
  private readonly attributes = new Map<string, string>()

  constructor(
    id: string,
    private readonly ownerDocument: FakeDocument,
  ) {
    this.id = id
  }

  get innerHTML(): string {
    return this.html
  }

  set innerHTML(value: string) {
    this.html = value

    if (value.includes('id="retry-button"')) {
      this.ownerDocument.ensureElement("retry-button")
      return
    }

    this.ownerDocument.removeElement("retry-button")
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener()
    }
  }

  focus(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return []
  }

  querySelector(_selector: string): FakeElement | null {
    return null
  }

  dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  closest(selector: string): FakeElement | null {
    if (selector === "button[data-terminal-view-id]" && this.dataset.terminalViewId) {
      return this
    }

    if (selector === "input[data-tree-level]" && this.dataset.treeLevel) {
      return this
    }

    return null
  }

  getAttribute(name: string): string | null {
    if (name === "data-tab-id") {
      return this.dataset.tabId ?? null
    }

    if (name === "data-terminal-view-id") {
      return this.dataset.terminalViewId ?? null
    }

    if (name === "data-tree-level") {
      return this.dataset.treeLevel ?? null
    }

    return this.attributes.get(name) ?? null
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>()

  constructor() {
    for (const id of [
      "state-banner",
      "dashboard",
      "dashboard-shell",
      "dashboard-left-pane",
      "dashboard-center-pane",
      "dashboard-right-pane",
      "workstream-title",
      "workstream-meta",
      "connection-status",
      "status-pane-advisory",
      "status-badge",
      "status-summary",
      "runtime-summary",
      "status-stages",
      "status-panel",
      "left-sidebar-nav",
      "left-sidebar-overview-button",
      "left-sidebar-tree-button",
      "tree-body",
      "tree-count",
      "tree-level-controls",
      "tree-panel",
      "terminal-session-summary",
      "terminal-session-list",
        "terminal-view-summary",
        "terminal-view-active-label",
        "terminal-view-select",
        "terminal-view-status",
        "terminal-view-details",
      "terminal-view-open-link",
      "terminal-picker-panel",
      "terminal-panel",
      "terminal-pane-advisory",
      "terminal-scrollback-meta",
      "terminal-scrollback-frame",
      "terminal-scrollback-editor",
      "terminal-scrollback-fallback",
      "terminal-scrollback-empty",
      "terminal-scrollback-controls",
      "terminal-view-frame",
    ]) {
      this.ensureElement(id)
    }

    this.getElementById("state-banner")!.dataset.kind = "loading"
    this.getElementById("terminal-view-select")!.value = ""
  }

  ensureElement(id: string): FakeElement {
    const existing = this.elements.get(id)
    if (existing) {
      return existing
    }

    const element = new FakeElement(id, this)
    this.elements.set(id, element)
    return element
  }

  removeElement(id: string): void {
    this.elements.delete(id)
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null
  }
}

class FakeMessageEvent {
  constructor(readonly data: string) {}
}

class MockEventSource {
  static latest: MockEventSource | null = null

  readonly listeners = new Map<string, Array<(event?: unknown) => void>>()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly url: string) {
    MockEventSource.latest = this
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  open(): void {
    this.onopen?.()
  }

  transportError(): void {
    this.onerror?.()
  }
}

function createSnapshot() {
  return {
    generated_at: "2026-04-16T12:00:00.000Z",
    canonical_state: {
      status: {
        stream: {
          id: "002-web-workstream-dashboard",
          name: "web-workstream-dashboard",
          is_current: true,
        },
        aggregate_status: "in_progress",
        counts: {
          total: 1,
          done: 0,
          in_progress: 1,
          blocked: 0,
          pending: 0,
        },
        completion: {
          percent_done: 0,
          done_items: 0,
          remaining_items: 1,
        },
        stages: [],
      },
      tree: {
        kind: "workstream",
        status: "in_progress",
        displayLabel: "002-web-workstream-dashboard",
        itemCount: 1,
        stages: [],
      },
      runtime: null,
    },
    observability: {
      availability: "ready",
      issues: [],
      tmux: {
        availability: "unavailable",
        sessions: [],
      },
      terminal_views: {
        availability: "degraded",
        views: [
          {
            terminal_view_id: "branch/branch-1",
            label: "Supervision 03 03.01",
            status: "degraded",
            session_name: "002-supervision-branch-1",
            role: "supervision_branch",
            notes: "The tmux session is still observable, but its persisted runtime target is stale.",
            routes: {
              view_path: "/terminal-views/branch%2Fbranch-1",
              ttyd_proxy_path: "/terminal-views/branch%2Fbranch-1/ttyd",
            },
          },
        ],
      },
    },
  }
}

type MockFetch = (input?: string) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

function createFetchMock(...responses: Array<{ ok: boolean; status: number; json: () => Promise<unknown> }>): MockFetch {
  return async (input?: string) => {
    if (typeof input === "string" && input.includes("/api/terminal-views/")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          terminal_view_id: "branch/branch-1",
          session_name: "002-supervision-branch-1",
          captured_at: "2026-04-16T12:00:00.000Z",
          read_only: true,
          status: "available",
          total_lines: 3,
          offset: 0,
          limit: 40,
          end_offset: 3,
          is_at_top: true,
          is_at_bottom: true,
          lines: ["alpha", "beta", "gamma"],
        }),
      }
    }

    const response = responses.shift()
    if (!response) {
      throw new Error("No queued snapshot response")
    }

    return response
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function runClient(args: {
  document?: FakeDocument
  fetchImpl?: MockFetch
}) {
  const document = args.document ?? new FakeDocument()
  const fetchImpl =
    args.fetchImpl ??
    createFetchMock({
      ok: true,
      status: 200,
      json: async () => createSnapshot(),
    })

  const script = renderDashboardClientScript("/tmp/repo")
  const initializeClient = new Function(
    "document",
    "fetch",
    "EventSource",
    "MessageEvent",
    "Element",
    script,
  )

  initializeClient(document, fetchImpl, MockEventSource, FakeMessageEvent, FakeElement)

  return {
    document,
    source: MockEventSource.latest!,
  }
}

describe("dashboard ui live refresh client", () => {
  test("keeps the dashboard shell visible with pane loading advisories before the first snapshot", () => {
    const { document } = runClient({
      fetchImpl: async () => new Promise(() => {}),
    })

    expect(document.getElementById("dashboard")?.hidden).toBe(false)
    expect(document.getElementById("state-banner")?.dataset.kind).toBe("loading")
    expect(document.getElementById("status-pane-advisory")?.hidden).toBe(false)
    expect(document.getElementById("status-pane-advisory")?.textContent).toContain(
      "Loading canonical snapshot",
    )
    expect(document.getElementById("terminal-pane-advisory")?.hidden).toBe(false)
    expect(document.getElementById("terminal-pane-advisory")?.textContent).toContain(
      "Loading read-only terminal panes",
    )
  })

  test("keeps the three shell panes visible together", async () => {
    const { document } = runClient({})

    await flushPromises()

    expect(document.getElementById("workstream-title")?.textContent).toBe(
      "Web Workstream Dashboard (002)",
    )
    expect(document.getElementById("status-panel")?.hidden).toBe(false)
    expect(document.getElementById("dashboard")?.hidden).toBe(false)
    expect(document.getElementById("dashboard-left-pane")?.hidden).toBe(false)
    expect(document.getElementById("dashboard-center-pane")?.hidden).toBe(false)
    expect(document.getElementById("dashboard-right-pane")?.hidden).toBe(false)
    expect(document.getElementById("status-pane-advisory")?.hidden).toBe(true)
    expect(document.getElementById("terminal-pane-advisory")?.hidden).toBe(true)
    expect(document.getElementById("left-sidebar-overview-button")?.dataset.active).toBe("true")
    expect(document.getElementById("left-sidebar-tree-button")?.dataset.active).toBe("false")
    expect(document.getElementById("status-panel")?.hidden).toBe(false)
    expect(document.getElementById("tree-panel")?.hidden).toBe(true)
  })

  test("switches the left sidebar between overview and tree views", async () => {
    const { document } = runClient({})

    await flushPromises()

    document.getElementById("left-sidebar-tree-button")?.click()

    expect(document.getElementById("status-panel")?.hidden).toBe(true)
    expect(document.getElementById("tree-panel")?.hidden).toBe(false)
    expect(document.getElementById("tree-level-controls")?.hidden).toBe(false)
    expect(document.getElementById("dashboard-center-pane")?.hidden).toBe(false)
    expect(document.getElementById("dashboard-right-pane")?.hidden).toBe(false)
    expect(document.getElementById("left-sidebar-overview-button")?.dataset.active).toBe("false")
    expect(document.getElementById("left-sidebar-tree-button")?.dataset.active).toBe("true")

    document.getElementById("left-sidebar-overview-button")?.click()

    expect(document.getElementById("status-panel")?.hidden).toBe(false)
    expect(document.getElementById("tree-panel")?.hidden).toBe(true)
  })

  test("uses a dropdown selector for terminal views and updates the selected details", async () => {
    const { document } = runClient({})

    await flushPromises()

    const select = document.getElementById("terminal-view-select")
    expect(select?.innerHTML).toContain("Supervision 03 03.01")
    expect(select?.innerHTML).not.toContain("002-supervision-branch-1")
    expect(select?.value).toBe("branch/branch-1")
    expect(document.getElementById("terminal-view-active-label")?.hidden).toBe(false)
    expect(document.getElementById("terminal-view-active-label")?.textContent).toBe(
      "Active: Supervision 03 03.01",
    )
    expect(document.getElementById("terminal-view-status")?.textContent).toBe("degraded")
    expect(document.getElementById("terminal-view-details")?.innerHTML).toContain(
      "002-supervision-branch-1",
    )
    expect(document.getElementById("terminal-session-list")?.innerHTML).toContain(
      "No matched terminal sessions.",
    )
    expect(document.getElementById("terminal-view-open-link")?.hidden).toBe(false)
    expect(document.getElementById("terminal-view-frame")?.hidden).toBe(false)
    expect(document.getElementById("terminal-scrollback-frame")?.hidden).toBe(true)
    expect(document.getElementById("terminal-scrollback-controls")?.hidden).toBe(true)

    select!.value = "branch/branch-1"
    select?.dispatch("change")

    expect(document.getElementById("terminal-view-frame")?.innerHTML).toContain(
      "/terminal-views/branch%2Fbranch-1/ttyd",
    )
  })

  test("picks an available default view and highlights the matched terminal session", async () => {
    const snapshot = createSnapshot()
    snapshot.observability.tmux.sessions = [
      {
        session_id: "002-worker-branch-2",
        session_name: "002-worker-branch-2",
        role: "supervision_branch",
        state: "attached",
        observed_at: "2026-04-16T12:00:00.000Z",
        stage_id: "03",
        batch_id: "03.02",
        pane_count: 1,
        correlation: {
          status: "matched",
          target_kind: "supervision_branch",
          target_id: "002-worker-branch-2",
          stage_id: "03",
          batch_id: "03.02",
        },
      },
    ] as any
    snapshot.observability.terminal_views.views.push({
      terminal_view_id: "branch/branch-2",
      label: "Worker 03 03.02",
      status: "available",
      session_name: "002-worker-branch-2",
      role: "supervision_branch",
      notes: "Healthy terminal view.",
      routes: {
        view_path: "/terminal-views/branch%2Fbranch-2",
        ttyd_proxy_path: "/terminal-views/branch%2Fbranch-2/ttyd",
      },
    } as any)

    const { document } = runClient({
      fetchImpl: createFetchMock({
        ok: true,
        status: 200,
        json: async () => snapshot,
      }),
    })

    await flushPromises()

    expect(document.getElementById("terminal-view-select")?.value).toBe("branch/branch-2")
    expect(document.getElementById("terminal-view-active-label")?.textContent).toBe(
      "Active: Worker 03 03.02",
    )
    expect(document.getElementById("terminal-view-details")?.innerHTML).toContain(
      "selected",
    )
    expect(document.getElementById("terminal-session-list")?.innerHTML).toContain(
      'data-active="true"',
    )
    expect(document.getElementById("terminal-session-list")?.innerHTML).toContain(
      "selected",
    )
  })

  test("promotes scrollback into the center pane when ttyd is unavailable", async () => {
    const snapshot = createSnapshot()
    const view = snapshot.observability.terminal_views.views[0]!
    view.status = "unavailable"
    view.notes =
      "The embedded ttyd surface is unavailable, so scrollback is shown instead."

    const { document } = runClient({
      fetchImpl: createFetchMock({
        ok: true,
        status: 200,
        json: async () => snapshot,
      }),
    })

    await flushPromises()
    await flushPromises()

    expect(document.getElementById("terminal-view-select")?.value).toBe("branch/branch-1")
    expect(document.getElementById("terminal-view-frame")?.hidden).toBe(false)
    expect(document.getElementById("terminal-view-frame")?.innerHTML).toContain(
      "Terminal observability unavailable",
    )
    expect(document.getElementById("terminal-view-frame")?.innerHTML).toContain(
      "The embedded ttyd surface is unavailable, so scrollback is shown instead.",
    )
    expect(document.getElementById("terminal-scrollback-frame")?.hidden).toBe(false)
    expect(document.getElementById("terminal-scrollback-controls")?.hidden).toBe(false)
    expect(document.getElementById("terminal-scrollback-meta")?.textContent).toContain(
      "Lines 1–3 of 3",
    )
    expect(document.getElementById("terminal-scrollback-fallback")?.hidden).toBe(false)
    expect(document.getElementById("terminal-scrollback-fallback")?.textContent).toContain(
      "alpha\nbeta\ngamma",
    )
  })

  test("explains the empty terminal picker when no observable views are available", async () => {
    const snapshot = createSnapshot()
    snapshot.observability.terminal_views.views = []

    const { document } = runClient({
      fetchImpl: createFetchMock({
        ok: true,
        status: 200,
        json: async () => snapshot,
      }),
    })

    await flushPromises()
    await flushPromises()

    expect(document.getElementById("terminal-view-select")?.disabled).toBe(true)
    expect(document.getElementById("terminal-view-summary")?.textContent).toContain(
      "degraded, but canonical status remains primary",
    )
    expect(document.getElementById("terminal-view-details")?.innerHTML).toContain(
      "No observable terminal views",
    )
    expect(document.getElementById("terminal-view-frame")?.innerHTML).toContain(
      "No observable terminal views",
    )
    expect(document.getElementById("terminal-scrollback-empty")?.textContent).toContain(
      "Canonical dashboard state remains visible.",
    )
  })

  test("falls back to a remaining terminal view when a later snapshot removes the selected view", async () => {
    const initialSnapshot = createSnapshot()
    initialSnapshot.observability.terminal_views.views.push({
      terminal_view_id: "branch/branch-2",
      label: "Worker 03 03.02",
      status: "available",
      session_name: "002-worker-branch-2",
      role: "implementation_thread",
      notes: "Healthy terminal view.",
      routes: {
        view_path: "/terminal-views/branch%2Fbranch-2",
        ttyd_proxy_path: "/terminal-views/branch%2Fbranch-2/ttyd",
      },
    })

    const laterSnapshot = createSnapshot()
    laterSnapshot.observability.terminal_views.views = [
      {
        terminal_view_id: "branch/branch-2",
        label: "Worker 03 03.02",
        status: "available",
        session_name: "002-worker-branch-2",
        role: "implementation_thread",
        notes: "Healthy terminal view.",
        routes: {
          view_path: "/terminal-views/branch%2Fbranch-2",
          ttyd_proxy_path: "/terminal-views/branch%2Fbranch-2/ttyd",
        },
      },
    ]

    const fetchImpl = createFetchMock(
      {
        ok: true,
        status: 200,
        json: async () => initialSnapshot,
      },
      {
        ok: true,
        status: 200,
        json: async () => laterSnapshot,
      },
    )
    const { document, source } = runClient({ fetchImpl })

    await flushPromises()

    const select = document.getElementById("terminal-view-select")
    select!.value = "branch/branch-1"
    select?.dispatch("change")

    expect(select?.value).toBe("branch/branch-1")

    source.emit("observability")
    await flushPromises()
    await flushPromises()

    expect(select?.value).toBe("branch/branch-2")
    expect(document.getElementById("terminal-view-summary")?.textContent).toContain(
      "canonical status remains primary",
    )
  })

  test("clears the selected terminal view when a later snapshot removes all views", async () => {
    const initialSnapshot = createSnapshot()
    const laterSnapshot = createSnapshot()
    laterSnapshot.observability.terminal_views.views = []

    const fetchImpl = createFetchMock(
      {
        ok: true,
        status: 200,
        json: async () => initialSnapshot,
      },
      {
        ok: true,
        status: 200,
        json: async () => laterSnapshot,
      },
    )
    const { document, source } = runClient({ fetchImpl })

    await flushPromises()

    const select = document.getElementById("terminal-view-select")
    expect(select?.value).toBe("branch/branch-1")

    source.emit("observability")
    await flushPromises()
    await flushPromises()

    expect(select?.disabled).toBe(true)
    expect(select?.innerHTML).toContain("No observable terminal views")
    expect(document.getElementById("terminal-view-active-label")?.hidden).toBe(true)
    expect(document.getElementById("terminal-view-frame")?.innerHTML).toContain(
      "No observable terminal views",
    )
    expect(document.getElementById("terminal-scrollback-empty")?.textContent).toContain(
      "Select a read-only terminal view to inspect tmux scrollback.",
    )
  })

  test("enters reconnecting when the live transport drops after a rendered snapshot", async () => {
    const { document, source } = runClient({})

    await flushPromises()
    source.open()

    expect(document.getElementById("dashboard")?.hidden).toBe(false)
    expect(document.getElementById("state-banner")?.hidden).toBe(true)
    expect(document.getElementById("connection-status")?.textContent).toBe(
      "Live updates connected",
    )

    source.transportError()

    expect(document.getElementById("connection-status")?.textContent).toBe(
      "Live updates reconnecting…",
    )
    expect(document.getElementById("status-pane-advisory")?.hidden).toBe(false)
    expect(document.getElementById("status-pane-advisory")?.textContent).toContain(
      "Live updates reconnecting",
    )
    expect(document.getElementById("terminal-pane-advisory")?.hidden).toBe(false)
    expect(document.getElementById("terminal-pane-advisory")?.textContent).toContain(
      "Read-only terminal panes remain visible",
    )
  })

  test("shows a warning, preserves the snapshot, and recovers through retry after live snapshot errors", async () => {
    const fetchImpl = createFetchMock(
      {
        ok: true,
        status: 200,
        json: async () => createSnapshot(),
      },
      {
        ok: true,
        status: 200,
        json: async () => createSnapshot(),
      },
    )
    const { document, source } = runClient({ fetchImpl })

    await flushPromises()
    source.open()

    source.emit(
      "error",
      new FakeMessageEvent(
        JSON.stringify({
          message: "Snapshot unavailable from the backend.",
          retryable: false,
        }),
      ),
    )

    expect(document.getElementById("dashboard")?.hidden).toBe(false)
    expect(document.getElementById("state-banner")?.hidden).toBe(false)
    expect(document.getElementById("state-banner")?.dataset.kind).toBe("warning")
    expect(document.getElementById("state-banner")?.innerHTML).toContain(
      "Snapshot unavailable from the backend.",
    )
    expect(document.getElementById("state-banner")?.innerHTML).toContain(
      "The dashboard will keep retrying for a fresh canonical snapshot.",
    )
    expect(document.getElementById("connection-status")?.textContent).toBe(
      "Snapshot unavailable",
    )
    expect(document.getElementById("dashboard")?.hidden).toBe(false)
    expect(document.getElementById("status-pane-advisory")?.hidden).toBe(false)
    expect(document.getElementById("status-pane-advisory")?.textContent).toContain(
      "last successful canonical snapshot remains visible",
    )
    expect(document.getElementById("terminal-pane-advisory")?.hidden).toBe(false)
    expect(document.getElementById("terminal-pane-advisory")?.textContent).toContain(
      "dashboard retries for a fresh canonical snapshot",
    )

    document.getElementById("retry-button")?.click()
    await flushPromises()

    expect(document.getElementById("state-banner")?.hidden).toBe(true)
    expect(document.getElementById("connection-status")?.textContent).toBe(
      "Live updates connected",
    )
    expect(document.getElementById("status-pane-advisory")?.hidden).toBe(true)
    expect(document.getElementById("terminal-pane-advisory")?.hidden).toBe(true)
    expect(document.getElementById("status-summary")?.innerHTML).toContain(
      "last refresh: manual retry",
    )
  })
})
