import { Hono } from "hono"

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
        max-width: 56rem;
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
          <li>Attach read-only terminal view metadata for future ttyd integration.</li>
        </ul>
      </section>
    </main>

    <script type="module">
      const status = document.getElementById("connection-status")
      const lastEvent = document.getElementById("last-event")
      const source = new EventSource(${JSON.stringify(DASHBOARD_LIVE_PATH)})

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

      source.onopen = () => {
        updateStatus("Live updates connected")
      }

      source.addEventListener("snapshot", () => {
        updateEvent("Snapshot update received")
      })

      source.addEventListener("observability", () => {
        updateEvent("Observability update received")
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
