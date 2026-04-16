import type {
  CurrentWorkstreamDashboardCanonicalState,
  CurrentWorkstreamDashboardObservabilitySnapshot,
  CurrentWorkstreamDashboardSnapshot,
  DashboardCanonicalStatusSnapshot,
  DashboardObservabilityIssue,
  DashboardTerminalObservabilitySnapshot,
  DashboardTmuxObservabilitySnapshot,
} from "../../workstreams/src/internal/dashboard-contracts.ts"
import {
  CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_SCHEMA_VERSION,
} from "../../workstreams/src/internal/dashboard-contracts.ts"
import type {
  WorkstreamRuntimeSupervisionSummary,
  WorkstreamStatusRuntimeSummaryProjection,
} from "../../workstreams/src/lib/types.ts"
import type { WorkstreamTreeSnapshot } from "../../workstreams/src/internal/server.ts"
import {
  getResolvedCurrentWorkstreamDashboardObservabilitySnapshot,
  getResolvedWorkstreamStatusSnapshot,
  getResolvedWorkstreamTreeSnapshot,
  resolveWorkstreamReadTarget,
} from "../../workstreams/src/internal/server.ts"

import type {
  TerminalObservabilityCapability,
  TerminalObservabilityProvider,
  TerminalObservabilityView,
} from "./observability/terminal.ts"

export interface CurrentWorkstreamDashboardReadModel {
  canonicalState: CurrentWorkstreamDashboardCanonicalState
  currentStreamId: string
  observability: CurrentWorkstreamDashboardObservabilitySnapshot
  runtime: WorkstreamStatusRuntimeSummaryProjection | null
  snapshot: CurrentWorkstreamDashboardSnapshot
  status: DashboardCanonicalStatusSnapshot
  streamId: string
  supervision: WorkstreamRuntimeSupervisionSummary | null
  tree: WorkstreamTreeSnapshot
}

export interface CurrentWorkstreamDashboardSnapshotOptions {
  now?: () => Date
  repoRoot: string
  terminalProvider: TerminalObservabilityProvider
}

function toCanonicalStatusSnapshot(
  snapshot: ReturnType<typeof getResolvedWorkstreamStatusSnapshot>,
): DashboardCanonicalStatusSnapshot {
  const { runtime: _runtime, ...status } = snapshot
  return status
}

function createUnavailableTerminalCapability(
  message: string,
): TerminalObservabilityCapability {
  return {
    enabled: false,
    message,
    mode: "ttyd",
  }
}

export function buildDashboardTerminalObservabilitySnapshot(args: {
  capability: TerminalObservabilityCapability
  checkedAt: string
  tmux: DashboardTmuxObservabilitySnapshot
  views: TerminalObservabilityView[]
}): DashboardTerminalObservabilitySnapshot {
  const issues: DashboardObservabilityIssue[] = []

  if (!args.capability.enabled) {
    issues.push({
      code: "ttyd_unavailable",
      severity: "warn",
      message: args.capability.message,
    })
  }

  for (const view of args.views) {
    if (view.status === "available") {
      continue
    }

    issues.push({
      code: "terminal_view_unavailable",
      severity: view.status === "degraded" ? "info" : "warn",
      message:
        view.notes && view.notes.length > 0
          ? view.notes
          : view.status === "degraded"
            ? `Read-only ttyd view "${view.label}" is degraded.`
            : `Read-only ttyd view "${view.label}" is unavailable.`,
      related_ids: [view.terminal_view_id],
    })
  }

  return {
    checked_at: args.checkedAt,
    availability: issues.length === 0 ? "ready" : args.capability.enabled ? "degraded" : "unavailable",
    transport: "ttyd",
    issues,
    views: args.views,
  }
}

async function buildObservabilitySnapshot(args: {
  repoRoot: string
  checkedAt: string
  terminalProvider: TerminalObservabilityProvider
}): Promise<CurrentWorkstreamDashboardObservabilitySnapshot> {
  const tmux = getResolvedCurrentWorkstreamDashboardObservabilitySnapshot(
    args.repoRoot,
    undefined,
    { checkedAt: args.checkedAt },
  ).tmux

  let capability: TerminalObservabilityCapability
  let views: TerminalObservabilityView[] = []
  try {
    capability = await args.terminalProvider.getCapability()
  } catch (error) {
    capability = createUnavailableTerminalCapability(
      error instanceof Error
        ? `Terminal observability provider failed: ${error.message}`
        : "Terminal observability provider failed.",
    )
  }

  try {
    views = await args.terminalProvider.listViews({
      checkedAt: args.checkedAt,
      tmux,
    })
  } catch (error) {
    capability = createUnavailableTerminalCapability(
      error instanceof Error
        ? `Terminal observability provider failed while listing views: ${error.message}`
        : "Terminal observability provider failed while listing views.",
    )
    views = []
  }

  const terminalViews = buildDashboardTerminalObservabilitySnapshot({
    capability,
    checkedAt: args.checkedAt,
    tmux,
    views,
  })
  const issues: DashboardObservabilityIssue[] = [...tmux.issues, ...terminalViews.issues]

  return {
    checked_at: args.checkedAt,
    availability: issues.length === 0 ? "ready" : "degraded",
    issues,
    tmux,
    terminal_views: terminalViews,
  }
}

export async function readCurrentWorkstreamDashboardSnapshot(
  options: CurrentWorkstreamDashboardSnapshotOptions,
): Promise<CurrentWorkstreamDashboardReadModel> {
  const now = options.now ?? (() => new Date())
  const generatedAt = now().toISOString()
  const target = resolveWorkstreamReadTarget(options.repoRoot)
  const statusSnapshot = getResolvedWorkstreamStatusSnapshot(
    options.repoRoot,
    target.stream.id,
  )
  const status = toCanonicalStatusSnapshot(statusSnapshot)
  const tree = getResolvedWorkstreamTreeSnapshot(options.repoRoot, {
    streamIdOrName: target.stream.id,
  })
  const runtime = statusSnapshot.runtime ?? null
  const supervision = runtime?.summary.supervision ?? null
  const canonicalState: CurrentWorkstreamDashboardCanonicalState = {
    source_of_truth: "tasks.json",
    status,
    tree,
    supervision,
    ...(runtime ? { runtime } : {}),
  }
  const observability = await buildObservabilitySnapshot({
    repoRoot: options.repoRoot,
    checkedAt: generatedAt,
    terminalProvider: options.terminalProvider,
  })
  const snapshot: CurrentWorkstreamDashboardSnapshot = {
    schema_version: CURRENT_WORKSTREAM_DASHBOARD_SNAPSHOT_SCHEMA_VERSION,
    generated_at: generatedAt,
    canonical_state: canonicalState,
    observability,
  }

  return {
    canonicalState,
    currentStreamId: target.currentStreamId ?? target.stream.id,
    observability,
    runtime,
    snapshot,
    status,
    streamId: target.stream.id,
    supervision: canonicalState.supervision,
    tree,
  }
}
