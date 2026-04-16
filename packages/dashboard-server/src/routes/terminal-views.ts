import { Hono, type Context } from "hono"
import {
  DASHBOARD_TERMINAL_VIEW_ID_PARAM,
  DASHBOARD_TERMINAL_VIEW_ROUTE_PATH_TEMPLATE,
  DASHBOARD_TERMINAL_VIEW_SCROLLBACK_ROUTE_PATH_TEMPLATE,
  DASHBOARD_TERMINAL_VIEW_TTYD_PROXY_ROUTE_PATH_TEMPLATE,
  type DashboardTerminalViewMetadata,
} from "@agenv/workstreams/internal/dashboard-contracts"

import type { DashboardServerConfig } from "../config.ts"
import type { TerminalObservabilityProvider } from "../observability/terminal.ts"
import {
  readCurrentWorkstreamDashboardSnapshot,
  type CurrentWorkstreamDashboardReadModel,
} from "../snapshot.ts"

export interface DashboardTerminalViewRoutesDependencies {
  config: DashboardServerConfig
  now?: () => Date
  terminalProvider: TerminalObservabilityProvider
  readSnapshot?: () => Promise<CurrentWorkstreamDashboardReadModel>
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function getTerminalViewId(rawValue: string): string {
  try {
    return decodeURIComponent(rawValue)
  } catch {
    return rawValue
  }
}

function findTerminalView(
  snapshot: CurrentWorkstreamDashboardReadModel,
  terminalViewId: string,
): DashboardTerminalViewMetadata | undefined {
  return snapshot.observability.terminal_views.views.find(
    (view) => view.terminal_view_id === terminalViewId,
  )
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1"
}

function isSafeLocalTtydUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

function renderTerminalViewPage(args: {
  terminalView: DashboardTerminalViewMetadata
}): string {
  const terminalView = args.terminalView
  const title = escapeHtml(terminalView.label)
  const sessionName = escapeHtml(terminalView.session_name)
  const status = escapeHtml(terminalView.status)
  const ttydProxyPath = escapeHtml(terminalView.routes.ttyd_proxy_path)
  const scope = [terminalView.stage_id, terminalView.batch_id, terminalView.thread_id, terminalView.role]
    .filter((value): value is string => Boolean(value && value.length > 0))
    .join(" · ")

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
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
        max-width: 96rem;
        padding: 1.5rem;
      }

      a {
        color: #8ec5ff;
      }

      .badge {
        border: 1px solid #2f4f69;
        border-radius: 999px;
        color: #9ed0ff;
        display: inline-block;
        font-size: 0.85rem;
        padding: 0.2rem 0.6rem;
      }

      .muted {
        color: #b8b8b8;
      }

      .frame {
        background: #000;
        border: 1px solid #2a2a2a;
        border-radius: 0.75rem;
        min-height: 70vh;
        overflow: hidden;
      }

      iframe {
        border: 0;
        display: block;
        height: 70vh;
        width: 100%;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <p><a href="/">← Back to dashboard</a></p>
        <h1>${title}</h1>
        <p class="badge">Read-only ttyd observability</p>
        <p class="muted">Session <code>${sessionName}</code>${
          scope.length > 0 ? ` · ${escapeHtml(scope)}` : ""
        }</p>
      </header>

      <section>
        <p class="muted">Status: <strong>${status}</strong></p>
        <p class="muted">This view is scoped to locally managed, read-only observability in v1.</p>
      </section>

      <section class="frame">
        ${
          terminalView.status !== "unavailable"
            ? `<iframe src="${ttydProxyPath}" title="${title}"></iframe>`
            : `<div style="padding: 1.5rem;"><p>This terminal view is not currently available.</p><p class="muted">Return to the dashboard to pick another observable session.</p></div>`
        }
      </section>

      <section>
        ${
          terminalView.status !== "unavailable"
            ? `<p><a href="${ttydProxyPath}" target="_blank" rel="noreferrer">Open ttyd target in a new tab</a></p>`
            : `<p class="muted">The ttyd target will appear here automatically once this read-only view becomes available again.</p>`
        }
      </section>
    </main>
  </body>
</html>`
}

function createTerminalUnavailableResponse(args: {
  context: Context
  terminalViewId: string
  cause?: unknown
}): Response {
  const detail =
    args.cause instanceof Error && args.cause.message.length > 0
      ? ` ${args.cause.message}`
      : ""

  return args.context.json(
    {
      ok: false,
      error: `Terminal view "${args.terminalViewId}" is temporarily unavailable.${detail}`,
    },
    503,
  )
}

export function createTerminalViewRoutes(
  dependencies: DashboardTerminalViewRoutesDependencies,
): Hono {
  const app = new Hono()
  const readSnapshot =
    dependencies.readSnapshot ??
    (() =>
      readCurrentWorkstreamDashboardSnapshot({
        now: dependencies.now,
        repoRoot: dependencies.config.repoRoot,
        terminalProvider: dependencies.terminalProvider,
      }))

  app.get(DASHBOARD_TERMINAL_VIEW_ROUTE_PATH_TEMPLATE, async (context) => {
    const terminalViewId = getTerminalViewId(context.req.param(DASHBOARD_TERMINAL_VIEW_ID_PARAM))
    const snapshot = await readSnapshot()
    const terminalView = findTerminalView(snapshot, terminalViewId)

    if (!terminalView) {
      return context.json(
        {
          ok: false,
          error: `Terminal view "${terminalViewId}" was not found in the current dashboard snapshot.`,
        },
        404,
      )
    }

    return new Response(renderTerminalViewPage({ terminalView }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
    })
  })

  app.get(DASHBOARD_TERMINAL_VIEW_SCROLLBACK_ROUTE_PATH_TEMPLATE, async (context) => {
    const terminalViewId = getTerminalViewId(context.req.param(DASHBOARD_TERMINAL_VIEW_ID_PARAM))
    const snapshot = await readSnapshot()
    const terminalView = findTerminalView(snapshot, terminalViewId)

    if (!terminalView) {
      return context.json(
        {
          ok: false,
          error: `Terminal view "${terminalViewId}" was not found in the current dashboard snapshot.`,
        },
        404,
      )
    }

    const limit = parsePositiveInt(context.req.query("limit"), 1200)
    const offsetQuery = context.req.query("offset")
    const offset = offsetQuery ? parsePositiveInt(offsetQuery, 0) : undefined
    const capturedAt = dependencies.now?.().toISOString() ?? new Date().toISOString()
    const scrollback = dependencies.terminalProvider.readScrollback
      ? await dependencies.terminalProvider.readScrollback({
          capturedAt,
          limit,
          ...(typeof offset === "number" ? { offset } : {}),
          terminalViewId,
        })
      : null

    if (!scrollback) {
      return context.json(
        {
          terminal_view_id: terminalView.terminal_view_id,
          session_name: terminalView.session_name,
          captured_at: capturedAt,
          read_only: true,
          status: "unavailable",
          total_lines: 0,
          offset: 0,
          limit,
          end_offset: 0,
          is_at_top: true,
          is_at_bottom: true,
          lines: [],
          notes: "No tmux scrollback is currently available for this terminal view.",
        },
        503,
      )
    }

    return context.json(scrollback)
  })

  app.get(DASHBOARD_TERMINAL_VIEW_TTYD_PROXY_ROUTE_PATH_TEMPLATE, async (context) => {
    const terminalViewId = getTerminalViewId(context.req.param(DASHBOARD_TERMINAL_VIEW_ID_PARAM))
    const snapshot = await readSnapshot()
    const terminalView = findTerminalView(snapshot, terminalViewId)

    if (!terminalView) {
      return context.json(
        {
          ok: false,
          error: `Terminal view "${terminalViewId}" was not found in the current dashboard snapshot.`,
        },
        404,
      )
    }

    if (terminalView.status === "unavailable") {
      return context.redirect(terminalView.routes.view_path, 307)
    }

    let resolvedTarget
    try {
      resolvedTarget = await dependencies.terminalProvider.resolveViewTarget(terminalViewId)
    } catch (error) {
      return createTerminalUnavailableResponse({
        context,
        terminalViewId,
        cause: error,
      })
    }

    if (!resolvedTarget) {
      return createTerminalUnavailableResponse({
        context,
        terminalViewId,
      })
    }

    const ttydUrl = new URL(resolvedTarget.upstreamPath, resolvedTarget.upstreamOrigin).toString()

    if (!isSafeLocalTtydUrl(ttydUrl)) {
      return context.json(
        {
          ok: false,
          error: "Terminal observability routes only allow local ttyd targets.",
        },
        403,
      )
    }

    return context.redirect(ttydUrl, 307)
  })

  return app
}
