import { Hono } from "hono"
import { CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE } from "../../../workstreams/src/internal/dashboard-contracts.ts"

import type { LiveRefreshHub } from "../live-refresh.ts"

export const DASHBOARD_LIVE_PATH = CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE.path

export function createLiveRoutes(liveRefresh: LiveRefreshHub): Hono {
  const app = new Hono()

  app.get(DASHBOARD_LIVE_PATH, (context) =>
    liveRefresh.createResponse(context.req.raw.signal),
  )

  return app
}
