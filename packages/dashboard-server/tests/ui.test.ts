import { describe, expect, test } from "bun:test"

import { createUiRoutes } from "../src/routes/ui.ts"

describe("dashboard ui route", () => {
  test("renders canonical-first dashboard scaffolding", async () => {
    const app = createUiRoutes({
      hostname: "127.0.0.1",
      port: 43119,
      repoRoot: "/tmp/repo",
    })

    const response = await app.request("/")
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain("Current workstream")
    expect(html).toContain("tasks.json")
    expect(html).toContain('role="tablist"')
    expect(html).toContain("Status Overview")
    expect(html).toContain("Work tree")
    expect(html).toContain("Read-only terminal views")
    expect(html).toContain("Stage level")
    expect(html).toContain("Batch level")
    expect(html).toContain("Thread level")
    expect(html).toContain("Task level")
    expect(html).not.toContain("Observability Notes")
    expect(html).not.toContain("Tmux session metadata")
    expect(html).toContain("canonical status remains primary")
    expect(html).toContain("terminal-view-select")
    expect(html).toContain("terminal-view-status")
    expect(html).toContain("Open standalone view")
    expect(html).toContain("Page up")
    expect(html).toContain("Page down")
    expect(html).toContain("Bottom")
    expect(html).toContain("terminal-scrollback-meta")
    expect(html).toContain("Choose a read-only tmux session to inspect from the dashboard.")
    expect(html).toContain("Matched terminal sessions")
    expect(html).toContain("Select an observable terminal view to embed the read-only ttyd session.")
    expect(html).toContain("Select a terminal view to inspect tmux scrollback.")
    expect(html).toContain("terminal-scrollback-editor")
  })

  test("includes reconnecting and snapshot-unavailable live refresh states", async () => {
    const app = createUiRoutes({
      hostname: "127.0.0.1",
      port: 43119,
      repoRoot: "/tmp/repo",
    })

    const response = await app.request("/")
    const html = await response.text()

    expect(html).toContain("Live updates reconnecting…")
    expect(html).toContain("Snapshot unavailable")
    expect(html).toContain("The last successful canonical snapshot remains visible while the backend recovers.")
    expect(html).toContain("state[data-kind=\"warning\"]")
  })
})
