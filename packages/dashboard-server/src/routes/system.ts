import { Hono } from "hono"

import type { DashboardServerConfig } from "../config.ts"
import type { LiveRefreshHub } from "../live-refresh.ts"
import type { TerminalObservabilityProvider } from "../observability/terminal.ts"

export const DASHBOARD_HEALTH_PATH = "/api/health"

export interface DashboardSystemRoutesDependencies {
  config: DashboardServerConfig
  liveRefresh: LiveRefreshHub
  terminalProvider: TerminalObservabilityProvider
}

export function createSystemRoutes(
  dependencies: DashboardSystemRoutesDependencies,
): Hono {
  const app = new Hono()

  app.get(DASHBOARD_HEALTH_PATH, async (context) => {
    const capability = await dependencies.terminalProvider.getCapability()

    return context.json({
      ok: true,
      server: {
        hostname: dependencies.config.hostname,
        port: dependencies.config.port,
        repoRoot: dependencies.config.repoRoot,
      },
      liveRefresh: {
        subscribers: dependencies.liveRefresh.getSubscriberCount(),
        transport: "sse",
      },
      observability: capability,
      status: {
        canonicalState: "ready",
        terminalViews: "pending-integration",
      },
    })
  })

  return app
}
