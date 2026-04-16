import { resolve } from "node:path"

export const LOCAL_ONLY_HOSTNAME = "127.0.0.1"
export const DEFAULT_DASHBOARD_PORT = 43119

export interface DashboardServerConfigInput {
  hostname?: string
  port?: number
  repoRoot?: string
}

export interface DashboardServerConfig {
  hostname: string
  port: number
  repoRoot: string
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 0 && port <= 65535
}

export function normalizeDashboardServerConfig(
  input: DashboardServerConfigInput = {},
): DashboardServerConfig {
  if (input.hostname && input.hostname !== LOCAL_ONLY_HOSTNAME) {
    throw new Error(
      `Dashboard server is local-only and must bind to ${LOCAL_ONLY_HOSTNAME}`,
    )
  }

  const port = input.port ?? DEFAULT_DASHBOARD_PORT
  if (!isValidPort(port)) {
    throw new Error(`Port must be an integer between 0 and 65535: ${port}`)
  }

  return {
    hostname: LOCAL_ONLY_HOSTNAME,
    port,
    repoRoot: resolve(input.repoRoot ?? process.cwd()),
  }
}

export function createDashboardServerUrl(
  config: Pick<DashboardServerConfig, "hostname">,
  activePort: number,
): string {
  return `http://${config.hostname}:${activePort}/`
}
