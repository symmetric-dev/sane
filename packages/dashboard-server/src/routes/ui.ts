import { Hono } from "hono"
import { CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE } from "../../../workstreams/src/internal/dashboard-contracts.ts"

import type { DashboardServerConfig } from "../config.ts"
import { DASHBOARD_LIVE_PATH } from "./live.ts"

export const DASHBOARD_HOME_PATH = "/"

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function renderDashboardShell(config: DashboardServerConfig): string {
  const repoRoot = escapeHtml(config.repoRoot)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workstream Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }

      body {
        background: #111;
        color: #f5f5f5;
        margin: 0;
        min-height: 100vh;
      }

      main {
        display: grid;
        gap: 1rem;
        margin: 0 auto;
        max-width: 72rem;
        padding: 2rem 1.5rem 3rem;
      }

      h1,
      h2,
      p,
      ul {
        margin: 0;
      }

      .muted {
        color: #b8b8b8;
      }

      a {
        color: #8ec5ff;
      }

      ul {
        padding-left: 1.25rem;
      }

      li + li {
        margin-top: 0.5rem;
      }

      .pill {
        border: 1px solid #2f4f69;
        border-radius: 999px;
        color: #9ed0ff;
        display: inline-block;
        font-size: 0.8rem;
        margin-left: 0.5rem;
        padding: 0.1rem 0.5rem;
      }

      code {
        color: #fff;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p class="muted">Internal Bun dashboard scaffold</p>
        <h1>Workstream Dashboard</h1>
      </header>

      <section>
        <p>Repo root: <code>${repoRoot}</code></p>
        <p>Binding: <code>${config.hostname}:${config.port}</code></p>
      </section>

      <section>
        <h2>Server status</h2>
        <p id="connection-status" class="muted">Connecting to live updates stream…</p>
        <p id="last-event" class="muted">Waiting for updates…</p>
      </section>

      <section>
        <h2>Current-workstream API routes</h2>
        <ul>
          <li>Inspect the canonical snapshot at <code>/api/current-workstream/snapshot</code>.</li>
          <li>Use the status, tree, runtime, supervision, and observability routes for focused reads.</li>
          <li>Layer tmux observability data without making it authoritative.</li>
          <li>Expose stable read-only terminal routes for ttyd-backed observability sessions.</li>
        </ul>
      </section>

      <section>
        <h2>Terminal observability</h2>
        <p id="terminal-view-summary" class="muted">Loading terminal views…</p>
        <ul id="terminal-view-list">
          <li class="muted">Waiting for snapshot data…</li>
        </ul>
      </section>
    </main>

    <script type="module">
      const status = document.getElementById("connection-status")
      const lastEvent = document.getElementById("last-event")
      const terminalViewSummary = document.getElementById("terminal-view-summary")
      const terminalViewList = document.getElementById("terminal-view-list")
      const source = new EventSource(${JSON.stringify(DASHBOARD_LIVE_PATH)})
      const snapshotPath = ${JSON.stringify(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE.path)}

      function updateStatus(message) {
        if (status) {
          status.textContent = message
        }
      }

      function updateEvent(message) {
        if (lastEvent) {
          lastEvent.textContent = message
        }
      }

      function replaceTerminalViewList(message, views) {
        if (terminalViewSummary) {
          terminalViewSummary.textContent = message
        }

        if (!terminalViewList) {
          return
        }

        terminalViewList.innerHTML = ""

        if (!Array.isArray(views) || views.length === 0) {
          const item = document.createElement("li")
          item.className = "muted"
          item.textContent = "No dashboard-visible terminal sessions are currently available."
          terminalViewList.appendChild(item)
          return
        }

        for (const view of views) {
          const item = document.createElement("li")
          const link = document.createElement("a")
          const pill = document.createElement("span")
          const meta = document.createElement("span")

          link.href = view.routes.view_path
          link.textContent = view.label

          pill.className = "pill"
          pill.textContent = view.status + " · read-only"

          meta.className = "muted"
          meta.textContent = " " + view.session_name

          item.append(link, pill, meta)
          terminalViewList.appendChild(item)
        }
      }

      async function refreshTerminalViews(reason) {
        try {
          const response = await fetch(snapshotPath, { headers: { accept: "application/json" } })
          if (!response.ok) {
            throw new Error("Snapshot request failed with " + response.status)
          }

          const snapshot = await response.json()
          const terminalViews = snapshot?.observability?.terminal_views?.views ?? []
          const availability = snapshot?.observability?.terminal_views?.availability ?? "unknown"

          replaceTerminalViewList(
            "Terminal routes refreshed from " + reason + " (" + availability + ").",
            terminalViews,
          )
        } catch (error) {
          replaceTerminalViewList(
            error instanceof Error ? error.message : "Failed to load terminal views.",
            [],
          )
        }
      }

      source.onopen = () => {
        updateStatus("Live updates connected")
      }

      source.addEventListener("snapshot", () => {
        updateEvent("Snapshot update received")
        void refreshTerminalViews("snapshot event")
      })

      source.addEventListener("observability", () => {
        updateEvent("Observability update received")
        void refreshTerminalViews("observability event")
      })

      source.addEventListener("heartbeat", (event) => {
        updateEvent("Heartbeat: " + event.data)
      })

      source.addEventListener("error", (event) => {
        updateEvent("Stream error payload: " + event.data)
      })

      source.onerror = () => {
        updateStatus("Live updates reconnecting…")
      }

      void refreshTerminalViews("initial load")
    </script>
  </body>
</html>`
}

export function createUiRoutes(config: DashboardServerConfig): Hono {
  const app = new Hono()

  app.get(DASHBOARD_HOME_PATH, () => {
    return new Response(renderDashboardShell(config), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  })

  return app
}
