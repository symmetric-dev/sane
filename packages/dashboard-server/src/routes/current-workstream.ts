import { Hono } from "hono"
import {
  CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE,
  CURRENT_WORKSTREAM_OBSERVABILITY_ROUTE,
  CURRENT_WORKSTREAM_RUNTIME_ROUTE,
  CURRENT_WORKSTREAM_STATUS_ROUTE,
  CURRENT_WORKSTREAM_SUPERVISION_ROUTE,
  CURRENT_WORKSTREAM_TREE_ROUTE,
} from "../../../workstreams/src/internal/dashboard-contracts.ts"
import { getResolvedWorkstreamTreeSnapshot } from "../../../workstreams/src/internal/server.ts"

import type { DashboardServerConfig } from "../config.ts"
import type { TerminalObservabilityProvider } from "../observability/terminal.ts"
import { readCurrentWorkstreamDashboardSnapshot } from "../snapshot.ts"

export interface DashboardCurrentWorkstreamRoutesDependencies {
  config: DashboardServerConfig
  terminalProvider: TerminalObservabilityProvider
}

export function createCurrentWorkstreamRoutes(
  dependencies: DashboardCurrentWorkstreamRoutesDependencies,
): Hono {
  const app = new Hono()
  const readSnapshot = () =>
    readCurrentWorkstreamDashboardSnapshot({
      repoRoot: dependencies.config.repoRoot,
      terminalProvider: dependencies.terminalProvider,
    })

  app.get(CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE.path, async (context) => {
    const snapshot = await readSnapshot()
    return context.json(snapshot.snapshot)
  })

  app.get(CURRENT_WORKSTREAM_STATUS_ROUTE.path, async (context) => {
    const snapshot = await readSnapshot()
    return context.json(snapshot.status)
  })

  app.get(CURRENT_WORKSTREAM_TREE_ROUTE.path, async (context) => {
    const batchId = context.req.query("batch_id")

    if (batchId) {
      return context.json(
        getResolvedWorkstreamTreeSnapshot(dependencies.config.repoRoot, {
          batchId,
        }),
      )
    }

    const snapshot = await readSnapshot()
    return context.json(snapshot.tree)
  })

  app.get(CURRENT_WORKSTREAM_RUNTIME_ROUTE.path, async (context) => {
    const snapshot = await readSnapshot()
    return context.json(snapshot.runtime)
  })

  app.get(CURRENT_WORKSTREAM_SUPERVISION_ROUTE.path, async (context) => {
    const snapshot = await readSnapshot()
    return context.json(snapshot.supervision)
  })

  app.get(CURRENT_WORKSTREAM_OBSERVABILITY_ROUTE.path, async (context) => {
    const snapshot = await readSnapshot()
    return context.json(snapshot.observability)
  })

  return app
}
