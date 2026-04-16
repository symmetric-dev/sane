#!/usr/bin/env bun

import {
  DEFAULT_DASHBOARD_PORT,
  LOCAL_ONLY_HOSTNAME,
  startDashboardServer,
} from "../src/index.ts"

export interface DashboardServerCliOptions {
  port?: number
  repoRoot?: string
}

function printHelp(): void {
  console.log(`
workstream-dashboard - Internal local dashboard server

Usage:
  bun run ./bin/dashboard-server.ts [options]

Options:
  --repo-root <path>   Repository root to serve (defaults to current directory)
  --port, -p <port>    Local port to bind (defaults to ${DEFAULT_DASHBOARD_PORT})
  --help, -h           Show this help message

Notes:
  - The server is local-only and always binds to ${LOCAL_ONLY_HOSTNAME}
  - This entrypoint is internal-first and not exposed through ag/work in v1
`)
}

function parsePort(rawPort: string): number {
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Invalid port: ${rawPort}`)
  }

  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Port must be between 0 and 65535: ${rawPort}`)
  }

  return port
}

export function parseDashboardServerCliArgs(
  args: string[],
): DashboardServerCliOptions | null {
  const options: DashboardServerCliOptions = {}

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument) {
      continue
    }

    if (argument === "--help" || argument === "-h") {
      return null
    }

    if (argument === "--port" || argument === "-p") {
      const value = args[index + 1]
      if (!value) {
        throw new Error(`${argument} requires a value`)
      }

      options.port = parsePort(value)
      index += 1
      continue
    }

    if (argument.startsWith("--port=")) {
      options.port = parsePort(argument.slice("--port=".length))
      continue
    }

    if (argument === "--repo-root") {
      const value = args[index + 1]
      if (!value) {
        throw new Error("--repo-root requires a value")
      }

      options.repoRoot = value
      index += 1
      continue
    }

    if (argument.startsWith("--repo-root=")) {
      options.repoRoot = argument.slice("--repo-root=".length)
      continue
    }

    throw new Error(`Unknown option: ${argument}`)
  }

  return options
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const parsedArgs = parseDashboardServerCliArgs(argv.slice(2))

  if (parsedArgs === null) {
    printHelp()
    return
  }

  const server = await startDashboardServer(parsedArgs)

  console.log(`Dashboard server listening on ${server.url}`)
  console.log(`Repo root: ${server.config.repoRoot}`)
  console.log("Press Ctrl+C to stop.")

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}; stopping dashboard server...`)
    server.stop()
    process.exit(0)
  }

  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
