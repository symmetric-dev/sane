import type {
  WorkstreamRuntimeSupervisionSummary,
  WorkstreamStatusRuntimeSummaryProjection,
  WorkstreamStatusSnapshot,
} from "../lib/types.ts"
import type { WorkstreamTreeSnapshot } from "../lib/tree.ts"

export const CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_SCHEMA_VERSION = "1.0.0" as const

export type DashboardCanonicalStateSource = "structured_runtime"
export type DashboardObservabilityAvailability = "ready" | "degraded" | "unavailable"
export type DashboardObservabilityIssueSeverity = "info" | "warn" | "error"
export type DashboardObservabilityCorrelationStatus = "matched" | "missing" | "stale" | "ambiguous"
export type DashboardTmuxSessionRole = "implementation_thread" | "supervision_run" | "supervision_branch"
export type DashboardTmuxSessionState = "attached" | "detached" | "exited" | "unknown"
export type DashboardTerminalViewStatus = "available" | "degraded" | "unavailable"
export type DashboardTerminalTransport = "ttyd"

export type DashboardCanonicalStatusSnapshot = Omit<WorkstreamStatusSnapshot, "runtime">

export interface DashboardObservabilityIssue {
  code:
    | "tmux_unavailable"
    | "tmux_missing_match"
    | "tmux_stale_match"
    | "tmux_ambiguous_match"
    | "ttyd_unavailable"
    | "terminal_view_unavailable"
  severity: DashboardObservabilityIssueSeverity
  message: string
  related_ids?: string[]
}

export interface DashboardObservabilityCorrelation {
  status: DashboardObservabilityCorrelationStatus
  target_kind: DashboardTmuxSessionRole
  target_id: string
  stage_id?: string
  batch_id?: string
  thread_id?: string
  item_id?: string
  reason?: string
}

export interface DashboardTmuxPaneMetadata {
  pane_id: string
  pane_index: number
  title?: string
  active: boolean
  tty?: string
  current_command?: string
  current_path?: string
}

export interface DashboardTmuxSessionMetadata {
  session_id: string
  session_name: string
  role: DashboardTmuxSessionRole
  state: DashboardTmuxSessionState
  observed_at: string
  stage_id?: string
  batch_id?: string
  thread_id?: string
  run_id?: string
  window_name?: string
  pane_count: number
  panes?: DashboardTmuxPaneMetadata[]
  correlation: DashboardObservabilityCorrelation
}

export interface DashboardTmuxObservabilitySnapshot {
  checked_at: string
  availability: DashboardObservabilityAvailability
  issues: DashboardObservabilityIssue[]
  sessions: DashboardTmuxSessionMetadata[]
}

export const DASHBOARD_TERMINAL_VIEW_PATH_PREFIX = "/terminal-views" as const

export interface DashboardTerminalViewRouteMetadata {
  view_path: string
  ttyd_proxy_path: string
}

export const DASHBOARD_TERMINAL_VIEW_ID_PARAM = "terminalViewId" as const
export const DASHBOARD_TERMINAL_VIEW_ROUTE_PATH_TEMPLATE =
  `${DASHBOARD_TERMINAL_VIEW_PATH_PREFIX}/:${DASHBOARD_TERMINAL_VIEW_ID_PARAM}` as const
export const DASHBOARD_TERMINAL_VIEW_TTYD_PROXY_ROUTE_PATH_TEMPLATE =
  `${DASHBOARD_TERMINAL_VIEW_ROUTE_PATH_TEMPLATE}/ttyd` as const
export const DASHBOARD_TERMINAL_VIEW_SCROLLBACK_ROUTE_PATH_TEMPLATE =
  `/api${DASHBOARD_TERMINAL_VIEW_ROUTE_PATH_TEMPLATE}/scrollback` as const

export interface DashboardTerminalViewMetadata {
  terminal_view_id: string
  label: string
  status: DashboardTerminalViewStatus
  transport: DashboardTerminalTransport
  read_only: true
  session_id: string
  session_name: string
  role: DashboardTmuxSessionRole
  observed_at: string
  stage_id?: string
  batch_id?: string
  thread_id?: string
  routes: DashboardTerminalViewRouteMetadata
  correlation: DashboardObservabilityCorrelation
}

export interface DashboardTerminalScrollbackSnapshot {
  terminal_view_id: string
  session_name: string
  captured_at: string
  read_only: true
  status: "available" | "unavailable"
  pane_id?: string
  pane_title?: string
  total_lines: number
  offset: number
  limit: number
  end_offset: number
  is_at_top: boolean
  is_at_bottom: boolean
  lines: string[]
  notes?: string
}

export interface DashboardTerminalObservabilitySnapshot {
  checked_at: string
  availability: DashboardObservabilityAvailability
  transport: DashboardTerminalTransport
  issues: DashboardObservabilityIssue[]
  views: DashboardTerminalViewMetadata[]
}

export interface CurrentWorkstreamDashboardCanonicalState {
  source_of_truth: DashboardCanonicalStateSource
  status: DashboardCanonicalStatusSnapshot
  tree: WorkstreamTreeSnapshot
  supervision: WorkstreamRuntimeSupervisionSummary | null
  runtime?: WorkstreamStatusRuntimeSummaryProjection
}

export interface CurrentWorkstreamDashboardObservabilitySnapshot {
  checked_at: string
  availability: DashboardObservabilityAvailability
  issues: DashboardObservabilityIssue[]
  tmux: DashboardTmuxObservabilitySnapshot
  terminal_views: DashboardTerminalObservabilitySnapshot
}

export interface CurrentWorkstreamDashboardSnapshot {
  schema_version: typeof CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_SCHEMA_VERSION
  generated_at: string
  canonical_state: CurrentWorkstreamDashboardCanonicalState
  observability: CurrentWorkstreamDashboardObservabilitySnapshot
}

export type DashboardRouteResponseKind = "html" | "json" | "sse"
export type DashboardRouteMethod = "GET"

export interface DashboardRouteQueryParameter {
  name: string
  required: boolean
  description: string
}

interface DashboardRouteContractBase {
  route_id: string
  method: DashboardRouteMethod
  path: string
}

export interface DashboardHtmlRouteContract extends DashboardRouteContractBase {
  response_kind: "html"
  response_content_type: "text/html; charset=utf-8"
}

export interface DashboardJsonRouteContract<ResponseContract extends string = string>
  extends DashboardRouteContractBase {
  response_kind: "json"
  response_content_type: "application/json"
  response_contract: ResponseContract
  query?: readonly DashboardRouteQueryParameter[]
}

export interface DashboardLiveRouteContract<EventContract extends string = string>
  extends DashboardRouteContractBase {
  response_kind: "sse"
  response_content_type: "text/event-stream"
  event_contract: EventContract
}

export const DASHBOARD_PAGE_ROUTE: DashboardHtmlRouteContract = {
  route_id: "dashboard_page",
  method: "GET",
  path: "/",
  response_kind: "html",
  response_content_type: "text/html; charset=utf-8",
}

export const CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE: DashboardJsonRouteContract<
  "CurrentWorkstreamDashboardSnapshot"
> = {
  route_id: "current_workstream_dashboard_snapshot",
  method: "GET",
  path: "/api/current-workstream/snapshot",
  response_kind: "json",
  response_content_type: "application/json",
  response_contract: "CurrentWorkstreamDashboardSnapshot",
}

export const CURRENT_WORKSTREAM_STATUS_ROUTE: DashboardJsonRouteContract<"DashboardCanonicalStatusSnapshot"> = {
  route_id: "current_workstream_status",
  method: "GET",
  path: "/api/current-workstream/status",
  response_kind: "json",
  response_content_type: "application/json",
  response_contract: "DashboardCanonicalStatusSnapshot",
}

export const CURRENT_WORKSTREAM_TREE_ROUTE: DashboardJsonRouteContract<"WorkstreamTreeSnapshot"> = {
  route_id: "current_workstream_tree",
  method: "GET",
  path: "/api/current-workstream/tree",
  response_kind: "json",
  response_content_type: "application/json",
  response_contract: "WorkstreamTreeSnapshot",
  query: [
    {
      name: "batch_id",
      required: false,
      description: "Optional batch filter in zero-padded stage.batch form such as 01.02.",
    },
  ],
}

export const CURRENT_WORKSTREAM_RUNTIME_ROUTE: DashboardJsonRouteContract<
  "WorkstreamStatusRuntimeSummaryProjection | null"
> = {
  route_id: "current_workstream_runtime",
  method: "GET",
  path: "/api/current-workstream/runtime",
  response_kind: "json",
  response_content_type: "application/json",
  response_contract: "WorkstreamStatusRuntimeSummaryProjection | null",
}

export const CURRENT_WORKSTREAM_SUPERVISION_ROUTE: DashboardJsonRouteContract<
  "WorkstreamRuntimeSupervisionSummary | null"
> = {
  route_id: "current_workstream_supervision",
  method: "GET",
  path: "/api/current-workstream/supervision",
  response_kind: "json",
  response_content_type: "application/json",
  response_contract: "WorkstreamRuntimeSupervisionSummary | null",
}

export const CURRENT_WORKSTREAM_OBSERVABILITY_ROUTE: DashboardJsonRouteContract<
  "CurrentWorkstreamDashboardObservabilitySnapshot"
> = {
  route_id: "current_workstream_observability",
  method: "GET",
  path: "/api/current-workstream/observability",
  response_kind: "json",
  response_content_type: "application/json",
  response_contract: "CurrentWorkstreamDashboardObservabilitySnapshot",
}

export interface DashboardLiveSnapshotEvent {
  event: "snapshot"
  data: CurrentWorkstreamDashboardSnapshot
}

export interface DashboardLiveObservabilityEvent {
  event: "observability"
  data: CurrentWorkstreamDashboardObservabilitySnapshot
}

export interface DashboardLiveHeartbeatEvent {
  event: "heartbeat"
  data: {
    generated_at: string
  }
}

export interface DashboardLiveErrorEvent {
  event: "error"
  data: {
    code: string
    message: string
    retryable: boolean
  }
}

export type CurrentWorkstreamDashboardLiveUpdateEvent =
  | DashboardLiveSnapshotEvent
  | DashboardLiveObservabilityEvent
  | DashboardLiveHeartbeatEvent
  | DashboardLiveErrorEvent

export const CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE: DashboardLiveRouteContract<
  "CurrentWorkstreamDashboardLiveUpdateEvent"
> = {
  route_id: "current_workstream_live_updates",
  method: "GET",
  path: "/api/current-workstream/live",
  response_kind: "sse",
  response_content_type: "text/event-stream",
  event_contract: "CurrentWorkstreamDashboardLiveUpdateEvent",
}

export type CurrentWorkstreamDashboardRouteContract =
  | DashboardHtmlRouteContract
  | DashboardJsonRouteContract
  | DashboardLiveRouteContract

export const CURRENT_WORKSTREAM_DASHBOARD_ROUTE_CONTRACTS: readonly CurrentWorkstreamDashboardRouteContract[] = [
  DASHBOARD_PAGE_ROUTE,
  CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_ROUTE,
  CURRENT_WORKSTREAM_STATUS_ROUTE,
  CURRENT_WORKSTREAM_TREE_ROUTE,
  CURRENT_WORKSTREAM_RUNTIME_ROUTE,
  CURRENT_WORKSTREAM_SUPERVISION_ROUTE,
  CURRENT_WORKSTREAM_OBSERVABILITY_ROUTE,
  CURRENT_WORKSTREAM_LIVE_UPDATES_ROUTE,
] as const

export function buildDashboardTerminalViewId(
  session: Pick<
    DashboardTmuxSessionMetadata,
    "session_name" | "role" | "batch_id" | "thread_id" | "run_id" | "correlation"
  >,
): string {
  switch (session.role) {
    case "implementation_thread": {
      const threadId = session.thread_id ?? session.correlation.thread_id
      if (threadId && threadId.length > 0) {
        return `thread/${threadId}`
      }

      const batchId = session.batch_id ?? session.correlation.batch_id
      if (batchId && batchId.length > 0) {
        return `batch/${batchId}`
      }

      break
    }

    case "supervision_run": {
      const runId = session.run_id
      if (runId && runId.length > 0) {
        return `run/${runId}`
      }

      if (
        session.correlation.target_kind === "supervision_run" &&
        session.correlation.target_id !== session.session_name
      ) {
        return `run/${session.correlation.target_id}`
      }

      break
    }

    case "supervision_branch": {
      if (
        session.correlation.target_kind === "supervision_branch" &&
        session.correlation.target_id !== session.session_name
      ) {
        return `branch/${session.correlation.target_id}`
      }

      break
    }
  }

  return `session/${session.session_name}`
}

export function buildDashboardTerminalViewRoutes(terminalViewId: string): DashboardTerminalViewRouteMetadata {
  const encodedTerminalViewId = encodeURIComponent(terminalViewId)
  const viewPath = `${DASHBOARD_TERMINAL_VIEW_PATH_PREFIX}/${encodedTerminalViewId}`

  return {
    view_path: viewPath,
    ttyd_proxy_path: `${viewPath}/ttyd`,
  }
}
