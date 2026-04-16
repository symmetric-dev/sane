import { describe, expect, test } from "bun:test"

import { createUiRoutes } from "../src/routes/ui.ts"

describe("dashboard ui route", () => {
  test("renders canonical-first observability scaffolding", async () => {
    const app = createUiRoutes({
      hostname: "127.0.0.1",
      port: 43119,
      repoRoot: "/tmp/repo",
    })

    const response = await app.request("/")
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain("Current workstream dashboard")
    expect(html).toContain("canonical source: tasks.json")
    expect(html).toContain("Tmux session metadata")
    expect(html).toContain("Read-only terminal views")
    expect(html).toContain("canonical status remains primary")
    expect(html).toContain("Select an available terminal view to embed")
    expect(html).toContain("No available ttyd terminal is ready to embed. Visible views are degraded or unavailable.")
  })
})
