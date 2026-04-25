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
      "workstream-title",
      "workstream-meta",
      "connection-status",
      "status-badge",
      "status-summary",
      "runtime-summary",
      "status-stages",
      "tree-body",
      "tree-count",
      "tree-level-controls",
      "terminal-session-summary",
      "terminal-session-list",
      "terminal-view-summary",
      "terminal-view-select",
      "terminal-view-status",
      "terminal-view-details",
      "terminal-view-open-link",
      "terminal-scrollback-meta",
      "terminal-scrollback-frame",
      "terminal-scrollback-editor",
      "terminal-scrollback-fallback",
      "terminal-scrollback-empty",
      "terminal-scrollback-controls",
      "terminal-view-frame",
      "tab-status-overview",
      "tab-work-tree",
      "tab-terminal-views",
      "panel-status-overview",
      "panel-work-tree",
      "panel-terminal-views",
    ]) {
      this.ensureElement(id)
    }

    this.getElementById("tab-status-overview")!.dataset.tabId = "status-overview"
    this.getElementById("tab-work-tree")!.dataset.tabId = "work-tree"
    this.getElementById("tab-terminal-views")!.dataset.tabId = "terminal-views"
    this.getElementById("state-banner")!.dataset.kind = "loading"
    this.getElementById("dashboard")!.hidden = true
    this.getElementById("terminal-view-select")!.value = ""
    this.getElementById("panel-work-tree")!.hidden = true
    this.getElementById("panel-terminal-views")!.hidden = true
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
          done_tasks: 0,
          remaining_tasks: 1,
        },
        stages: [],
      },
      tree: {
        kind: "workstream",
        status: "in_progress",
        displayLabel: "002-web-workstream-dashboard",
        taskCount: 1,
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
  test("shows one major section at a time via tabs", async () => {
    const { document } = runClient({})

    await flushPromises()

    expect(document.getElementById("workstream-title")?.textContent).toBe(
      "Web Workstream Dashboard (002)",
    )
    expect(document.getElementById("panel-status-overview")?.hidden).toBe(false)
    expect(document.getElementById("panel-work-tree")?.hidden).toBe(true)

    document.getElementById("tab-work-tree")?.click()

    expect(document.getElementById("panel-status-overview")?.hidden).toBe(true)
    expect(document.getElementById("panel-work-tree")?.hidden).toBe(false)
    expect(document.getElementById("tab-work-tree")?.dataset.active).toBe("true")
    expect(document.getElementById("tab-status-overview")?.dataset.active).toBe(
      "false",
    )
  })

  test("uses a dropdown selector for terminal views and updates the selected details", async () => {
    const { document } = runClient({})

    await flushPromises()

    const select = document.getElementById("terminal-view-select")
    expect(select?.innerHTML).toContain("Supervision 03 03.01")
    expect(select?.innerHTML).not.toContain("002-supervision-branch-1")
    expect(select?.value).toBe("branch/branch-1")
    expect(document.getElementById("terminal-view-status")?.textContent).toBe("degraded")
    expect(document.getElementById("terminal-view-details")?.innerHTML).toContain(
      "002-supervision-branch-1",
    )
    expect(document.getElementById("terminal-session-list")?.innerHTML).toContain(
      "No matched terminal sessions.",
    )
    expect(document.getElementById("terminal-view-open-link")?.hidden).toBe(false)

    select!.value = "branch/branch-1"
    select?.dispatch("change")

    expect(document.getElementById("terminal-view-frame")?.innerHTML).toContain(
      "/terminal-views/branch%2Fbranch-1/ttyd",
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

    document.getElementById("retry-button")?.click()
    await flushPromises()

    expect(document.getElementById("state-banner")?.hidden).toBe(true)
    expect(document.getElementById("connection-status")?.textContent).toBe(
      "Live updates connected",
    )
    expect(document.getElementById("status-summary")?.innerHTML).toContain(
      "last refresh: manual retry",
    )
  })
})
