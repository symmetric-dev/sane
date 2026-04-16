import { Hono } from "hono"

import type { DashboardServerConfig } from "./config.ts"
import type { LiveRefreshHub } from "./live-refresh.ts"
import type { TerminalObservabilityProvider } from "./observability/terminal.ts"
import { createCurrentWorkstreamRoutes } from "./routes/current-workstream.ts"
import { createLiveRoutes } from "./routes/live.ts"
import { createSystemRoutes } from "./routes/system.ts"
import { createUiRoutes } from "./routes/ui.ts"

export interface DashboardAppDependencies {
  config: DashboardServerConfig
  liveRefresh: LiveRefreshHub
  terminalProvider: TerminalObservabilityProvider
}

export function createDashboardApp(dependencies: DashboardAppDependencies): Hono {
  const app = new Hono()

  app.use("*", async (context, next) => {
    context.header("cache-control", "no-store")
    await next()
  })

  app.route("/", createUiRoutes(dependencies.config))
  app.route("/", createCurrentWorkstreamRoutes(dependencies))
  app.route("/", createSystemRoutes(dependencies))
  app.route("/", createLiveRoutes(dependencies.liveRefresh))

  app.notFound((context) => {
    return context.json(
      {
        ok: false,
        error: "Not found",
      },
      404,
    )
  })

  app.onError((error, context) => {
    return context.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    )
  })

  return app
}
