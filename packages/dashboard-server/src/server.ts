import {
  createDashboardServerUrl,
  normalizeDashboardServerConfig,
  type DashboardServerConfig,
  type DashboardServerConfigInput,
} from "./config.ts"
import {
  createLiveRefreshHub,
  type LiveRefreshHub,
} from "./live-refresh.ts"
import {
  type TerminalObservabilityProvider,
} from "./observability/terminal.ts"
import { createTtydTerminalObservabilityProvider } from "./observability/ttyd.ts"
import { createDashboardApp } from "./app.ts"

const DASHBOARD_SERVER_IDLE_TIMEOUT_SECONDS = 30

export interface DashboardServerStartOptions extends DashboardServerConfigInput {
  liveRefresh?: LiveRefreshHub
  terminalProvider?: TerminalObservabilityProvider
}

export interface StartedDashboardServer {
  app: ReturnType<typeof createDashboardApp>
  config: DashboardServerConfig
  liveRefresh: LiveRefreshHub
  server: Bun.Server<undefined>
  stop(): void
  terminalProvider: TerminalObservabilityProvider
  url: string
}

export async function startDashboardServer(
  options: DashboardServerStartOptions = {},
): Promise<StartedDashboardServer> {
  const config = normalizeDashboardServerConfig(options)
  const liveRefresh = options.liveRefresh ?? createLiveRefreshHub()
  const terminalProvider =
    options.terminalProvider ?? createTtydTerminalObservabilityProvider()
  const app = createDashboardApp({
    config,
    liveRefresh,
    terminalProvider,
  })

  const server = Bun.serve({
    fetch: app.fetch,
    hostname: config.hostname,
    idleTimeout: DASHBOARD_SERVER_IDLE_TIMEOUT_SECONDS,
    port: config.port,
  })

  const resolvedPort = typeof server.port === "number" ? server.port : config.port

  return {
    app,
    config: {
      ...config,
      port: resolvedPort,
    },
    liveRefresh,
    server,
    stop() {
      terminalProvider.close()
      liveRefresh.close()
      server.stop(true)
    },
    terminalProvider,
    url: createDashboardServerUrl(config, resolvedPort),
  }
}
