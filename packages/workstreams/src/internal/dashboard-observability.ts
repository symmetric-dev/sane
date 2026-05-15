import { spawnSync } from "node:child_process"

import { normalizeRuntimeState } from "../lib/runtime-state.ts"
import type {
  PersistedBatchStatusFile,
  RootAgentBranchSession,
  StreamMetadata,
  SupervisorRunState,
  WorkstreamUnifiedRuntimeState,
} from "../lib/types.ts"
import type {
  CurrentWorkstreamDashboardObservabilitySnapshot,
  DashboardObservabilityIssue,
  DashboardTmuxObservabilitySnapshot,
  DashboardTmuxPaneMetadata,
  DashboardTmuxSessionMetadata,
  DashboardTmuxSessionRole,
  DashboardTmuxSessionState,
  DashboardTerminalObservabilitySnapshot,
} from "./dashboard-contracts.ts"

const TMUX_FIELD_SEPARATOR = "\t"

interface ObservedTmuxSessionSummary {
  sessionId: string
  sessionName: string
  attached: boolean
}

interface ObservedTmuxPaneState {
  paneId: string
  paneDead: boolean
}

export interface DashboardTmuxSessionInspector {
  isAvailable(): boolean
  listSessions(): ObservedTmuxSessionSummary[]
  listSessionPanes(sessionName: string): DashboardTmuxPaneMetadata[]
  listSessionPaneStates(sessionName: string): ObservedTmuxPaneState[]
  getActiveWindowName(sessionName: string): string | undefined
}

interface DashboardTmuxExpectedTarget {
  sessionName: string
  role: DashboardTmuxSessionRole
  targetId: string
  expectedLive: boolean
  reason: string
  stageId?: string
  batchId?: string
  threadId?: string
  runId?: string
}

function runTmuxCommand(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })

  if (result.error || result.status !== 0) {
    return { ok: false, stdout: "" }
  }

  return {
    ok: true,
    stdout: result.stdout ?? "",
  }
}

function listObservedTmuxSessions(): ObservedTmuxSessionSummary[] {
  const result = runTmuxCommand([
    "list-sessions",
    "-F",
    `#{session_id}${TMUX_FIELD_SEPARATOR}#{session_name}${TMUX_FIELD_SEPARATOR}#{session_attached}`,
  ])

  if (!result.ok) {
    return []
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sessionId, sessionName, attached] = line.split(TMUX_FIELD_SEPARATOR)

      return {
        sessionId: sessionId ?? "",
        sessionName: sessionName ?? "",
        attached: attached === "1",
      }
    })
    .filter((session) => session.sessionId.length > 0 && session.sessionName.length > 0)
}

function listObservedTmuxPanes(sessionName: string): DashboardTmuxPaneMetadata[] {
  const result = runTmuxCommand([
    "list-panes",
    "-s",
    "-t",
    sessionName,
    "-F",
    [
      "#{pane_id}",
      "#{pane_index}",
      "#{pane_title}",
      "#{pane_active}",
      "#{pane_tty}",
      "#{pane_current_command}",
      "#{pane_current_path}",
    ].join(TMUX_FIELD_SEPARATOR),
  ])

  if (!result.ok) {
    return []
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [paneId, paneIndex, title, active, tty, currentCommand, ...currentPathParts] = line.split(
        TMUX_FIELD_SEPARATOR,
      )
      const currentPath = currentPathParts.join(TMUX_FIELD_SEPARATOR)

      return {
        pane_id: paneId ?? "",
        pane_index: Number.parseInt(paneIndex ?? "0", 10),
        ...(title ? { title } : {}),
        active: active === "1",
        ...(tty ? { tty } : {}),
        ...(currentCommand ? { current_command: currentCommand } : {}),
        ...(currentPath ? { current_path: currentPath } : {}),
      }
    })
    .filter((pane) => pane.pane_id.length > 0)
}

function listObservedTmuxPaneStates(sessionName: string): ObservedTmuxPaneState[] {
  const result = runTmuxCommand([
    "list-panes",
    "-s",
    "-t",
    sessionName,
    "-F",
    `#{pane_id}${TMUX_FIELD_SEPARATOR}#{pane_dead}`,
  ])

  if (!result.ok) {
    return []
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [paneId, paneDead] = line.split(TMUX_FIELD_SEPARATOR)

      return {
        paneId: paneId ?? "",
        paneDead: paneDead === "1",
      }
    })
    .filter((pane) => pane.paneId.length > 0)
}

function getObservedTmuxActiveWindowName(sessionName: string): string | undefined {
  const result = runTmuxCommand([
    "list-windows",
    "-t",
    sessionName,
    "-F",
    `#{window_name}${TMUX_FIELD_SEPARATOR}#{window_active}`,
  ])

  if (!result.ok) {
    return undefined
  }

  const windows = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [windowName, active] = line.split(TMUX_FIELD_SEPARATOR)

      return {
        windowName: windowName ?? "",
        active: active === "1",
      }
    })
    .filter((window) => window.windowName.length > 0)

  return windows.find((window) => window.active)?.windowName ?? windows[0]?.windowName
}

function createSystemTmuxInspector(): DashboardTmuxSessionInspector {
  return {
    isAvailable(): boolean {
      const result = spawnSync("tmux", ["-V"], {
        stdio: ["ignore", "ignore", "ignore"],
      })

      return !result.error && result.status === 0
    },
    listSessions(): ObservedTmuxSessionSummary[] {
      return listObservedTmuxSessions()
    },
    listSessionPanes(sessionName: string): DashboardTmuxPaneMetadata[] {
      return listObservedTmuxPanes(sessionName)
    },
    listSessionPaneStates(sessionName: string): ObservedTmuxPaneState[] {
      return listObservedTmuxPaneStates(sessionName)
    },
    getActiveWindowName(sessionName: string): string | undefined {
      return getObservedTmuxActiveWindowName(sessionName)
    },
  }
}

function formatStreamTmuxPrefix(stream: StreamMetadata): string {
  if (typeof stream.order === "number" && Number.isFinite(stream.order) && stream.order >= 0) {
    return Math.trunc(stream.order).toString().padStart(3, "0")
  }

  const match = stream.id.match(/^(\d+)/)
  return match?.[1]?.padStart(3, "0") ?? "000"
}

function getStreamTmuxPrefixes(stream: StreamMetadata): string[] {
  const prefixes = new Set<string>()
  prefixes.add(formatStreamTmuxPrefix(stream))

  const idPrefix = stream.id.match(/^(\d+)/)?.[1]
  if (idPrefix) {
    prefixes.add(idPrefix.padStart(3, "0"))
  }

  return [...prefixes]
}

function matchesWorkstreamTmuxSession(sessionName: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) =>
      sessionName.startsWith(`${prefix}-implementation-`) ||
      sessionName.startsWith(`${prefix}-supervision-`),
  )
}

function inferRoleFromSessionName(sessionName: string): DashboardTmuxSessionRole {
  return sessionName.includes("-supervision-") ? "supervision_branch" : "implementation_thread"
}

function parseStageIdFromBatchId(batchId: string | undefined): string | undefined {
  if (!batchId) {
    return undefined
  }

  const [stageId] = batchId.split(".")
  return stageId && stageId.length > 0 ? stageId.padStart(2, "0") : undefined
}

function isImplementationTargetLive(batch: PersistedBatchStatusFile): boolean {
  return batch.status === "pending" || batch.status === "running"
}

function isSupervisionRunLive(run: SupervisorRunState): boolean {
  return run.status === "running" || run.status === "paused"
}

function isSupervisionBranchLive(branch: RootAgentBranchSession): boolean {
  return branch.status === "pending" || branch.status === "running"
}

function buildImplementationTarget(batch: PersistedBatchStatusFile): DashboardTmuxExpectedTarget | null {
  if (!batch.tmuxSessionName) {
    return null
  }

  const singleThreadId = batch.threads.length === 1 ? batch.threads[0]?.threadId : undefined

  return {
    sessionName: batch.tmuxSessionName,
    role: "implementation_thread",
    targetId: singleThreadId ?? batch.batchId,
    expectedLive: isImplementationTargetLive(batch),
    reason:
      singleThreadId && singleThreadId.length > 0
        ? `Persisted implementation runtime references tmux session \"${batch.tmuxSessionName}\" for thread ${singleThreadId}.`
        : `Persisted implementation runtime references tmux session \"${batch.tmuxSessionName}\" for batch ${batch.batchId}.`,
    stageId: parseStageIdFromBatchId(batch.batchId),
    batchId: batch.batchId,
    ...(singleThreadId ? { threadId: singleThreadId } : {}),
    ...(batch.runId ? { runId: batch.runId } : {}),
  }
}

function buildCurrentSupervisionBranchTarget(
  currentBranch: NonNullable<ReturnType<typeof normalizeRuntimeState>["supervision"]["current_branch_supervision"]>,
  matchingBranch?: RootAgentBranchSession,
): DashboardTmuxExpectedTarget | null {
  if (!currentBranch.tmuxSessionName) {
    return null
  }

  return {
    sessionName: currentBranch.tmuxSessionName,
    role: "supervision_branch",
    targetId: currentBranch.branchSessionId,
    expectedLive: true,
    reason: `Persisted current supervision branch references tmux session \"${currentBranch.tmuxSessionName}\".`,
    ...(currentBranch.scope?.stageId ? { stageId: currentBranch.scope.stageId } : {}),
    ...(currentBranch.scope?.level === "batch" ? { batchId: currentBranch.scope.batchId } : {}),
    ...(matchingBranch?.runId ? { runId: matchingBranch.runId } : {}),
  }
}

function buildActiveSupervisionRunTarget(
  run: SupervisorRunState,
  matchingBranch?: RootAgentBranchSession,
): DashboardTmuxExpectedTarget | null {
  if (!matchingBranch?.tmuxSessionName) {
    return null
  }

  return {
    sessionName: matchingBranch.tmuxSessionName,
    role: "supervision_run",
    targetId: run.runId,
    expectedLive: isSupervisionRunLive(run),
    reason: `Persisted supervision run ${run.runId} references tmux session \"${matchingBranch.tmuxSessionName}\" via branch ${matchingBranch.branchSessionId}.`,
    stageId: run.stageId,
    ...(run.currentBatchId ? { batchId: run.currentBatchId } : {}),
    runId: run.runId,
  }
}

function buildHistoricalSupervisionBranchTarget(
  branch: RootAgentBranchSession,
): DashboardTmuxExpectedTarget | null {
  if (!branch.tmuxSessionName) {
    return null
  }

  return {
    sessionName: branch.tmuxSessionName,
    role: "supervision_branch",
    targetId: branch.branchSessionId,
    expectedLive: isSupervisionBranchLive(branch),
    reason: `Persisted supervision branch ${branch.branchSessionId} references tmux session \"${branch.tmuxSessionName}\".`,
    ...(branch.scope?.stageId ? { stageId: branch.scope.stageId } : {}),
    ...(branch.scope?.level === "batch" ? { batchId: branch.scope.batchId } : {}),
    ...(branch.batchId ? { batchId: branch.batchId } : {}),
    ...(branch.threadId ? { threadId: branch.threadId } : {}),
    ...(branch.runId ? { runId: branch.runId } : {}),
  }
}

function collectExpectedTargets(
  stream: StreamMetadata,
  runtimeState?: WorkstreamUnifiedRuntimeState | null,
): DashboardTmuxExpectedTarget[] {
  const normalizedRuntimeState = normalizeRuntimeState(stream.id, runtimeState)
  const targets: DashboardTmuxExpectedTarget[] = []

  for (const batchId of Object.keys(normalizedRuntimeState.batches).sort()) {
    const target = buildImplementationTarget(normalizedRuntimeState.batches[batchId]!)
    if (target) {
      targets.push(target)
    }
  }

  const supervision = normalizedRuntimeState.supervision
  const consumedBranchIds = new Set<string>()

  if (supervision.current_branch_supervision) {
    const matchingBranch = supervision.branch_sessions.find(
      (branch) => branch.branchSessionId === supervision.current_branch_supervision?.branchSessionId,
    )
    const currentTarget = buildCurrentSupervisionBranchTarget(
      supervision.current_branch_supervision,
      matchingBranch,
    )

    if (currentTarget) {
      targets.push(currentTarget)
      consumedBranchIds.add(currentTarget.targetId)
    }
  }

  const activeRun = supervision.active_run_id
    ? supervision.runs.find((run) => run.runId === supervision.active_run_id)
    : undefined

  if (activeRun?.branchSessionId && !consumedBranchIds.has(activeRun.branchSessionId)) {
    const matchingBranch = supervision.branch_sessions.find(
      (branch) => branch.branchSessionId === activeRun.branchSessionId,
    )
    const activeRunTarget = buildActiveSupervisionRunTarget(activeRun, matchingBranch)

    if (activeRunTarget) {
      targets.push(activeRunTarget)
      consumedBranchIds.add(activeRun.branchSessionId)
    }
  }

  for (const branch of [...supervision.branch_sessions].sort((left, right) =>
    left.branchSessionId.localeCompare(right.branchSessionId, undefined, { numeric: true }),
  )) {
    if (consumedBranchIds.has(branch.branchSessionId)) {
      continue
    }

    const target = buildHistoricalSupervisionBranchTarget(branch)
    if (target) {
      targets.push(target)
    }
  }

  return targets
}

function collectObservedSessions(args: {
  inspector: DashboardTmuxSessionInspector
  exactSessionNames: Set<string>
  prefixes: string[]
}): ObservedTmuxSessionSummary[] {
  return args.inspector
    .listSessions()
    .filter(
      (session) =>
        args.exactSessionNames.has(session.sessionName) ||
        matchesWorkstreamTmuxSession(session.sessionName, args.prefixes),
    )
    .sort((left, right) => left.sessionName.localeCompare(right.sessionName))
}

function getSessionState(
  session: ObservedTmuxSessionSummary,
  paneStates: ObservedTmuxPaneState[],
): DashboardTmuxSessionState {
  if (session.attached) {
    return "attached"
  }

  if (paneStates.length > 0 && paneStates.every((pane) => pane.paneDead)) {
    return "exited"
  }

  return "detached"
}

function createIssue(args: {
  code: DashboardObservabilityIssue["code"]
  message: string
  relatedIds?: string[]
}): DashboardObservabilityIssue {
  return {
    code: args.code,
    severity: args.code === "tmux_stale_match" ? "info" : "warn",
    message: args.message,
    ...(args.relatedIds && args.relatedIds.length > 0 ? { related_ids: args.relatedIds } : {}),
  }
}

function getCommonTargetContext(targets: DashboardTmuxExpectedTarget[]): {
  role: DashboardTmuxSessionRole
  stageId?: string
  batchId?: string
  threadId?: string
  runId?: string
} {
  const first = targets[0]
  if (!first) {
    return { role: "implementation_thread" }
  }

  const shared = <Key extends "stageId" | "batchId" | "threadId" | "runId">(
    key: Key,
  ): DashboardTmuxExpectedTarget[Key] | undefined => {
    const value = first[key]
    return targets.every((target) => target[key] === value) ? value : undefined
  }

  return {
    role: first.role,
    ...(shared("stageId") ? { stageId: shared("stageId") } : {}),
    ...(shared("batchId") ? { batchId: shared("batchId") } : {}),
    ...(shared("threadId") ? { threadId: shared("threadId") } : {}),
    ...(shared("runId") ? { runId: shared("runId") } : {}),
  }
}

function createUnavailableTerminalSnapshot(checkedAt: string): DashboardTerminalObservabilitySnapshot {
  return {
    checked_at: checkedAt,
    availability: "unavailable",
    transport: "ttyd",
    issues: [
      {
        code: "ttyd_unavailable",
        severity: "warn",
        message: "No ttyd-backed views were provisioned.",
      },
    ],
    views: [],
  }
}

export function createDashboardTmuxObservabilitySnapshot(args: {
  stream: StreamMetadata
  runtimeState?: WorkstreamUnifiedRuntimeState | null
  checkedAt?: string
  tmuxInspector?: DashboardTmuxSessionInspector
}): DashboardTmuxObservabilitySnapshot {
  const checkedAt = args.checkedAt ?? new Date().toISOString()
  const inspector = args.tmuxInspector ?? createSystemTmuxInspector()

  if (!inspector.isAvailable()) {
    return {
      checked_at: checkedAt,
      availability: "unavailable",
      issues: [
        {
          code: "tmux_unavailable",
          severity: "warn",
          message: "tmux was not available when observability data was collected.",
        },
      ],
      sessions: [],
    }
  }

  const expectedTargets = collectExpectedTargets(args.stream, args.runtimeState)
  const exactSessionNames = new Set(expectedTargets.map((target) => target.sessionName))
  const prefixes = getStreamTmuxPrefixes(args.stream)
  const observedSessions = collectObservedSessions({ inspector, exactSessionNames, prefixes })
  const observedByName = new Map(observedSessions.map((session) => [session.sessionName, session]))
  const targetsBySessionName = new Map<string, DashboardTmuxExpectedTarget[]>()

  for (const target of expectedTargets) {
    const existing = targetsBySessionName.get(target.sessionName) ?? []
    existing.push(target)
    targetsBySessionName.set(target.sessionName, existing)
  }

  const issues: DashboardObservabilityIssue[] = []
  const sessions: DashboardTmuxSessionMetadata[] = []
  const handledMissingSessionNames = new Set<string>()

  for (const observed of observedSessions) {
    const candidateTargets = targetsBySessionName.get(observed.sessionName) ?? []
    const panes = inspector.listSessionPanes(observed.sessionName)
    const paneStates = inspector.listSessionPaneStates(observed.sessionName)
    const state = getSessionState(observed, paneStates)

    if (candidateTargets.length > 1) {
      const context = getCommonTargetContext(candidateTargets)
      const relatedIds = candidateTargets.map((target) => target.targetId)
      issues.push(
        createIssue({
          code: "tmux_ambiguous_match",
          message: `tmux session \"${observed.sessionName}\" matched multiple persisted runtime targets; correlation was left ambiguous.`,
          relatedIds,
        }),
      )
      sessions.push({
        session_id: observed.sessionId,
        session_name: observed.sessionName,
        role: context.role,
        state,
        observed_at: checkedAt,
        ...(context.stageId ? { stage_id: context.stageId } : {}),
        ...(context.batchId ? { batch_id: context.batchId } : {}),
        ...(context.threadId ? { thread_id: context.threadId } : {}),
        ...(context.runId ? { run_id: context.runId } : {}),
        ...(inspector.getActiveWindowName(observed.sessionName)
          ? { window_name: inspector.getActiveWindowName(observed.sessionName) }
          : {}),
        pane_count: panes.length,
        ...(panes.length > 0 ? { panes } : {}),
        correlation: {
          status: "ambiguous",
          target_kind: context.role,
          target_id: observed.sessionName,
          ...(context.stageId ? { stage_id: context.stageId } : {}),
          ...(context.batchId ? { batch_id: context.batchId } : {}),
          ...(context.threadId ? { thread_id: context.threadId } : {}),
          reason: "Multiple persisted runtime targets referenced the same tmux session name.",
        },
      })
      handledMissingSessionNames.add(observed.sessionName)
      continue
    }

    if (candidateTargets.length === 1) {
      const [target] = candidateTargets
      if (!target) {
        continue
      }

      const correlationStatus = target.expectedLive ? "matched" : "stale"
      if (correlationStatus === "stale") {
        issues.push(
          createIssue({
            code: "tmux_stale_match",
            message: `tmux session \"${observed.sessionName}\" is still observable, but the persisted runtime target ${target.targetId} is no longer active.`,
            relatedIds: [target.targetId],
          }),
        )
      }

      sessions.push({
        session_id: observed.sessionId,
        session_name: observed.sessionName,
        role: target.role,
        state,
        observed_at: checkedAt,
        ...(target.stageId ? { stage_id: target.stageId } : {}),
        ...(target.batchId ? { batch_id: target.batchId } : {}),
        ...(target.threadId ? { thread_id: target.threadId } : {}),
        ...(target.runId ? { run_id: target.runId } : {}),
        ...(inspector.getActiveWindowName(observed.sessionName)
          ? { window_name: inspector.getActiveWindowName(observed.sessionName) }
          : {}),
        pane_count: panes.length,
        ...(panes.length > 0 ? { panes } : {}),
        correlation: {
          status: correlationStatus,
          target_kind: target.role,
          target_id: target.targetId,
          ...(target.stageId ? { stage_id: target.stageId } : {}),
          ...(target.batchId ? { batch_id: target.batchId } : {}),
          ...(target.threadId ? { thread_id: target.threadId } : {}),
          reason: correlationStatus === "matched" ? target.reason : `${target.reason} The persisted target is terminal, so the live tmux session is treated as stale observability data.`,
        },
      })
      handledMissingSessionNames.add(observed.sessionName)
      continue
    }

    const inferredRole = inferRoleFromSessionName(observed.sessionName)
    issues.push(
      createIssue({
        code: "tmux_stale_match",
        message: `tmux session \"${observed.sessionName}\" matched the current workstream naming convention, but no persisted runtime target referenced it.`,
        relatedIds: [observed.sessionName],
      }),
    )
    sessions.push({
      session_id: observed.sessionId,
      session_name: observed.sessionName,
      role: inferredRole,
      state,
      observed_at: checkedAt,
      ...(inspector.getActiveWindowName(observed.sessionName)
        ? { window_name: inspector.getActiveWindowName(observed.sessionName) }
        : {}),
      pane_count: panes.length,
      ...(panes.length > 0 ? { panes } : {}),
      correlation: {
        status: "stale",
        target_kind: inferredRole,
        target_id: observed.sessionName,
        reason:
          "Session name matched the current workstream prefix, but persisted runtime state had no corresponding tmux target.",
      },
    })
  }

  for (const [sessionName, candidateTargets] of [...targetsBySessionName.entries()].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (observedByName.has(sessionName) || handledMissingSessionNames.has(sessionName)) {
      continue
    }

    const liveTargets = candidateTargets.filter((target) => target.expectedLive)
    if (liveTargets.length === 0) {
      continue
    }

    if (candidateTargets.length > 1) {
      const context = getCommonTargetContext(candidateTargets)
      const relatedIds = candidateTargets.map((target) => target.targetId)
      issues.push(
        createIssue({
          code: "tmux_ambiguous_match",
          message: `Persisted runtime state referenced tmux session \"${sessionName}\" from multiple live targets, so no single authoritative correlation was chosen.`,
          relatedIds,
        }),
      )
      sessions.push({
        session_id: `ambiguous:${sessionName}`,
        session_name: sessionName,
        role: context.role,
        state: "unknown",
        observed_at: checkedAt,
        ...(context.stageId ? { stage_id: context.stageId } : {}),
        ...(context.batchId ? { batch_id: context.batchId } : {}),
        ...(context.threadId ? { thread_id: context.threadId } : {}),
        ...(context.runId ? { run_id: context.runId } : {}),
        pane_count: 0,
        correlation: {
          status: "ambiguous",
          target_kind: context.role,
          target_id: sessionName,
          ...(context.stageId ? { stage_id: context.stageId } : {}),
          ...(context.batchId ? { batch_id: context.batchId } : {}),
          ...(context.threadId ? { thread_id: context.threadId } : {}),
          reason: "Multiple live runtime targets referenced the same tmux session name while no tmux session was observed.",
        },
      })
      continue
    }

    const [target] = liveTargets
    if (!target) {
      continue
    }

    issues.push(
      createIssue({
        code: "tmux_missing_match",
        message: `Persisted runtime target ${target.targetId} expected tmux session \"${sessionName}\", but it was not observed.`,
        relatedIds: [target.targetId],
      }),
    )
    sessions.push({
      session_id: `missing:${sessionName}`,
      session_name: sessionName,
      role: target.role,
      state: "unknown",
      observed_at: checkedAt,
      ...(target.stageId ? { stage_id: target.stageId } : {}),
      ...(target.batchId ? { batch_id: target.batchId } : {}),
      ...(target.threadId ? { thread_id: target.threadId } : {}),
      ...(target.runId ? { run_id: target.runId } : {}),
      pane_count: 0,
      correlation: {
        status: "missing",
        target_kind: target.role,
        target_id: target.targetId,
        ...(target.stageId ? { stage_id: target.stageId } : {}),
        ...(target.batchId ? { batch_id: target.batchId } : {}),
        ...(target.threadId ? { thread_id: target.threadId } : {}),
        reason: `${target.reason} The tmux session was not observed at snapshot time, so the match remains missing rather than authoritative process state.`,
      },
    })
  }

  return {
    checked_at: checkedAt,
    availability: issues.length > 0 ? "degraded" : "ready",
    issues,
    sessions,
  }
}

export function createCurrentWorkstreamDashboardObservabilitySnapshot(args: {
  stream: StreamMetadata
  runtimeState?: WorkstreamUnifiedRuntimeState | null
  checkedAt?: string
  tmuxInspector?: DashboardTmuxSessionInspector
}): CurrentWorkstreamDashboardObservabilitySnapshot {
  const checkedAt = args.checkedAt ?? new Date().toISOString()
  const tmux = createDashboardTmuxObservabilitySnapshot({
    stream: args.stream,
    runtimeState: args.runtimeState,
    checkedAt,
    tmuxInspector: args.tmuxInspector,
  })
  const terminalViews = createUnavailableTerminalSnapshot(checkedAt)

  return {
    checked_at: checkedAt,
    availability:
      tmux.availability === "ready" && terminalViews.availability === "ready"
        ? "ready"
        : "degraded",
    issues: [...tmux.issues, ...terminalViews.issues],
    tmux,
    terminal_views: terminalViews,
  }
}
