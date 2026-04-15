import {
  formatRootAgentBreakpointSelection,
  formatRootAgentCheckpointPointer,
} from "../root-agent-checkpoint.ts"
import type {
  RootAgentBranchScope,
  RootAgentBranchSession,
  RootAgentBranchFinalizationReason,
  RootAgentBranchFinalizationSource,
  RootAgentBreakpointMode,
  RootAgentCheckpointPointer,
} from "../types.ts"
import type { SessionExport } from "../session-export.ts"
import {
  DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS,
  DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
  findNativeSessionIdByTitle,
  runCommand,
  runForkedSession,
  runMessageBoundaryForkLaunch,
  type ForkedSessionArgs,
  type ForkedSessionResult,
} from "./launch-supervision-opencode.ts"
import {
  appendSupervisionTmuxObservability,
  createSupervisionTmuxSessionName,
  runForkedSessionInTmux,
  tmuxSessionExists,
  type SupervisionTmuxLaunchMetadata,
} from "./launch-supervision-tmux.ts"
import {
  buildSupervisionPrompt,
  describeScopeLabel,
  doLaunchScopesMatch,
  normalizeOptionalLaunchString,
  resolveLaunchScope,
  resolveLegacyLaunchTarget,
  type BranchLaunchScope,
} from "./launch-supervision-scope.ts"
import { logWorkstreamToolEvent } from "./debug-log.ts"

export type SupervisionTerminalStatus = "completed" | "stopped" | "failed"

const LIVE_SUPERVISION_BRANCH_STATUSES = new Set(["pending", "running"])

export interface CheckpointSessionForkEligibility {
  valid: boolean
  canForkCurrentSession: boolean
  reason?: string
  resolvedMessageId?: string
  resolvedMessageIndex?: number
  latestMessageIndex?: number
}

export interface LaunchSupervisionBranchDeps {
  getRepoRoot: () => string
  getResolvedStreamId: (repoRoot: string, streamId?: string) => string | Promise<string>
  findBranchSessionForLaunchSessionId: (
    repoRoot: string,
    streamId: string,
    sessionId: string,
  ) => RootAgentBranchSession | undefined | Promise<RootAgentBranchSession | undefined>
  findBranchSessionByNativeSessionId: (
    repoRoot: string,
    streamId: string,
    nativeSessionId: string,
  ) => RootAgentBranchSession | undefined | Promise<RootAgentBranchSession | undefined>
  createBranchSessionId: () => string | Promise<string>
  buildBranchSession: (args: any) => RootAgentBranchSession | Promise<RootAgentBranchSession>
  persistBranchSession: (
    repoRoot: string,
    streamId: string,
    branchSession: RootAgentBranchSession,
  ) => unknown | Promise<unknown>
  loadStoredBranchSession: (
    repoRoot: string,
    streamId: string,
    branchSessionId: string,
  ) => RootAgentBranchSession | undefined | Promise<RootAgentBranchSession | undefined>
  findActiveMatchingSupervisionBranch: (args: {
    repoRoot: string
    streamId: string
    rootSessionId: string
    scope?: BranchLaunchScope
  }) => RootAgentBranchSession | undefined | Promise<RootAgentBranchSession | undefined>
  waitForBranchNativeSessionId: (args: {
    repoRoot: string
    streamId: string
    branchSessionId: string
    timeoutMs?: number
    pollIntervalMs?: number
  }) => Promise<string | undefined>
  waitForTerminalBranchSession: (args: {
    repoRoot: string
    streamId: string
    branchSessionId: string
    timeoutMs?: number
    pollIntervalMs?: number
  }) => Promise<RootAgentBranchSession | undefined>
  createSupervisionTmuxSessionName: (streamId: string) => string | Promise<string>
  tmuxSessionExists: (sessionName: string) => boolean | Promise<boolean>
  runForkedSession: (args: ForkedSessionArgs) => Promise<ForkedSessionResult>
  runCommand: typeof runCommand
  findNativeSessionIdByTitle: typeof findNativeSessionIdByTitle
  parseOutput: (
    content: string,
  ) =>
    | { text: string; logs: string[]; success: boolean }
    | Promise<{ text: string; logs: string[]; success: boolean }>
  exportSessionTranscript: (sessionId: string) => Promise<SessionExport>
  refreshCheckpointPointer: (args: {
    repoRoot: string
    streamId: string
    rootSessionId: string
    sessionExport: SessionExport
    checkpointCreatedAt: string
    breakpointTags?: readonly string[]
    breakpointMode?: RootAgentBreakpointMode
  }) => Promise<RootAgentCheckpointPointer>
  getCheckpointSessionForkEligibility: (args: {
    pointer: RootAgentCheckpointPointer
    sessionExport: SessionExport
  }) => CheckpointSessionForkEligibility | Promise<CheckpointSessionForkEligibility>
  extractFinalBranchReport: (sessionExport: SessionExport) => string | Promise<string>
  now: () => string
}

export interface LaunchSupervisionRuntimeDeps {
  getResolvedStream: (index: any, streamId?: string) => { id: string }
  loadIndex: (repoRoot: string) => any
  findRootAgentBranchSessionForLaunchSessionId: (args: {
    repoRoot: string
    streamId: string
    sessionId: string
  }) => RootAgentBranchSession | undefined
  createRootAgentBranchSessionId: (role: string) => string
  buildRootAgentBranchSession: (args: any) => RootAgentBranchSession | Promise<RootAgentBranchSession>
  loadSupervisorState: (repoRoot: string, streamId: string) => {
    branch_sessions: RootAgentBranchSession[]
  } | undefined
  upsertBranchSessionLocked: (
    repoRoot: string,
    streamId: string,
    branchSession: RootAgentBranchSession,
  ) => unknown | Promise<unknown>
  refreshRootAgentCheckpointPointer: LaunchSupervisionBranchDeps["refreshCheckpointPointer"]
  getRootAgentCheckpointSessionForkEligibility: LaunchSupervisionBranchDeps["getCheckpointSessionForkEligibility"]
  waitForRootAgentBranchNativeSessionId: LaunchSupervisionBranchDeps["waitForBranchNativeSessionId"]
  waitForRootAgentBranchTerminalSession: LaunchSupervisionBranchDeps["waitForTerminalBranchSession"]
  parseSynthesisJsonl: LaunchSupervisionBranchDeps["parseOutput"]
  exportSession: LaunchSupervisionBranchDeps["exportSessionTranscript"]
  extractLastCompletedAssistantText: LaunchSupervisionBranchDeps["extractFinalBranchReport"]
  getDefaultLaunchSupervisionBranchHelpers?: () => ReturnType<
    typeof getDefaultLaunchSupervisionBranchHelpers
  >
  runMessageBoundaryForkLaunch?: typeof runMessageBoundaryForkLaunch
  runForkedSessionInTmux?: typeof runForkedSessionInTmux
}

export function parseBreakpointTagsArg(rawValue?: string): string[] | undefined {
  if (typeof rawValue !== "string") {
    return undefined
  }

  const normalized = new Set<string>()
  for (const candidate of rawValue.split(/[\n,]/)) {
    const trimmed = candidate.trim()
    if (trimmed.length > 0) {
      normalized.add(trimmed)
    }
  }

  return normalized.size > 0 ? [...normalized] : undefined
}

export function parseBreakpointModeArg(
  rawValue?: string,
): RootAgentBreakpointMode | undefined {
  if (!rawValue) {
    return undefined
  }

  if (rawValue === "prefer_tagged" || rawValue === "previous_user") {
    return rawValue
  }

  throw new Error(
    `Invalid breakpointMode \"${rawValue}\". Expected \"prefer_tagged\" or \"previous_user\".`,
  )
}

export function isActiveSupervisionBranchStatus(status: string | undefined): boolean {
  return typeof status === "string" && LIVE_SUPERVISION_BRANCH_STATUSES.has(status)
}

export function isTerminalStoppedSupervisionBranch(branch: {
  status?: string
  completedAt?: string
  processEndedAt?: string
  finalizationSource?: string
  finalizationReason?: string
}): boolean {
  if (branch.status !== "stopped") {
    return false
  }

  return (
    (typeof branch.completedAt === "string" && branch.completedAt.trim().length > 0) ||
    (typeof branch.processEndedAt === "string" && branch.processEndedAt.trim().length > 0) ||
    (typeof branch.finalizationSource === "string" && branch.finalizationSource.trim().length > 0) ||
    (typeof branch.finalizationReason === "string" && branch.finalizationReason.trim().length > 0)
  )
}

export function shouldBlockDuplicateSupervisionLaunch(branch: {
  status?: string
  completedAt?: string
  processEndedAt?: string
  finalizationSource?: string
  finalizationReason?: string
}): boolean {
  if (isActiveSupervisionBranchStatus(branch.status)) {
    return true
  }

  return branch.status === "stopped" && !isTerminalStoppedSupervisionBranch(branch)
}

export function hasActiveSupervisionSessionHandle(branch: {
  nativeSessionId?: string
  tmuxSessionName?: string
}): boolean {
  return (
    (typeof branch.nativeSessionId === "string" && branch.nativeSessionId.trim().length > 0) ||
    (typeof branch.tmuxSessionName === "string" && branch.tmuxSessionName.trim().length > 0)
  )
}

export function formatExistingSupervisionLaunchMessage(args: {
  streamId: string
  branch: {
    branchSessionId?: string
    status?: string
    tmuxSessionName?: string
  }
  scope?: BranchLaunchScope
  batch?: string
}): string {
  const scopeLabel = describeScopeLabel(args.scope, args.batch)
  const branchLabel = args.branch.branchSessionId ?? "(unknown branch session)"
  const statusLabel = args.branch.status ?? "unknown"

  return [
    `Refusing duplicate supervision launch for ${scopeLabel} in ${args.streamId}.`,
    `Active nonterminal supervision branch already exists: ${branchLabel} (${statusLabel}).`,
    ...(args.branch.tmuxSessionName
      ? [
          `Attach with \`tmux attach -t ${args.branch.tmuxSessionName}\` to inspect the existing supervision session.`,
        ]
      : ["Existing supervision session has no persisted tmux attach instructions."]),
    "Preserving the existing active supervision scope is safer than launching a second overlapping branch.",
  ].join("\n")
}

export function buildSupervisionBranchTitle(streamId: string, branchSessionId: string): string {
  return `root-supervision-${streamId}-${branchSessionId}`
}

function buildCheckpointCaptureNotes(
  pointer: RootAgentCheckpointPointer,
  scope: BranchLaunchScope | undefined,
  batch?: string,
): string {
  const scopeLabel = describeScopeLabel(scope, batch)
  return [
    `Checkpoint pointer ${formatRootAgentCheckpointPointer(pointer)} captured; launching Root Agent supervision branch for ${scopeLabel}.`,
    ...(pointer.breakpointSelection
      ? [`Breakpoint selection: ${formatRootAgentBreakpointSelection(pointer.breakpointSelection)}`]
      : []),
  ].join("\n")
}

function getCheckpointPointerFromBranchSession(
  branch: RootAgentBranchSession | undefined,
): RootAgentCheckpointPointer | undefined {
  if (!branch?.checkpointCreatedAt || typeof branch.rootSessionId !== "string") {
    return undefined
  }

  if (typeof branch.checkpointMessageIndex !== "number") {
    return undefined
  }

  return {
    rootSessionId: branch.rootSessionId,
    checkpointMessageIndex: branch.checkpointMessageIndex,
    checkpointCreatedAt: branch.checkpointCreatedAt,
    ...(branch.checkpointMessageId ? { checkpointMessageId: branch.checkpointMessageId } : {}),
    ...(branch.breakpointSelection ? { breakpointSelection: branch.breakpointSelection } : {}),
  }
}

function formatCheckpointLaunchFallbackError(args: {
  checkpointPointer: RootAgentCheckpointPointer
  eligibility: CheckpointSessionForkEligibility
  cause?: unknown
}): Error {
  const pointerLabel = formatRootAgentCheckpointPointer(args.checkpointPointer)
  const detail = args.cause
    ? ` Native fork error: ${args.cause instanceof Error ? args.cause.message : String(args.cause)}`
    : ""

  if (!args.checkpointPointer.checkpointMessageId) {
    return new Error(
      `Cannot launch supervision branch from checkpoint pointer ${pointerLabel}: the selected boundary has no stable message ID, so native fork-from-message is unavailable.${
        args.eligibility.canForkCurrentSession
          ? ""
          : ` Plain session --fork would start from the live session tip (message-index ${args.eligibility.latestMessageIndex ?? "unknown"}) instead of the selected boundary (message-index ${args.eligibility.resolvedMessageIndex ?? args.checkpointPointer.checkpointMessageIndex}).`
      }${detail}`,
    )
  }

  return new Error(
    `Native fork-from-message could not launch from checkpoint pointer ${pointerLabel}.${
      args.eligibility.canForkCurrentSession
        ? " Falling back to plain session --fork is only safe when the selected boundary is already the live session tip."
        : ` Plain session --fork would inherit the live session tip (message-index ${args.eligibility.latestMessageIndex ?? "unknown"}) instead of the selected boundary (message-index ${args.eligibility.resolvedMessageIndex ?? args.checkpointPointer.checkpointMessageIndex}).`
    }${detail}`,
  )
}

function getTerminalBranchStatus(
  storedStatus: string | undefined,
  runCode: number,
): SupervisionTerminalStatus {
  if (storedStatus === "completed" || storedStatus === "stopped" || storedStatus === "failed") {
    return storedStatus
  }

  return runCode === 0 ? "completed" : "failed"
}

export function formatSupervisionProcessExitEvidence(exitCode: number): string {
  return `Authoritative process-end evidence: tmux pane exited with status ${exitCode}.`
}

export function joinBranchNotes(...sections: Array<string | undefined>): string {
  const normalized = sections
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value && value.length > 0))

  return Array.from(new Set(normalized)).join("\n\n")
}

function describeBranchFinalizationHandling(args: {
  finalizationSource?: RootAgentBranchFinalizationSource
  finalizationReason?: RootAgentBranchFinalizationReason
}): string | undefined {
  if (args.finalizationSource === "explicit_finalize") {
    return "Explicit supervision finalization was already persisted before parent-side reconciliation."
  }

  switch (args.finalizationReason) {
    case "ended_without_explicit_finalize":
      return "Parent-side reconciliation finalized the branch after process end because no explicit finalize_workstream_supervision call was persisted."
    case "exit_zero_without_usable_finalization":
      return "Parent-side reconciliation finalized the branch after process end with exit code 0, but no usable finalization/report was persisted."
    case "nonzero_exit":
      return "Parent-side reconciliation marked the branch failed after observing a nonzero tmux process exit."
    case "persisted_terminal_status":
      return "Persisted terminal supervision state was already available when the parent reconciled process end."
    case "session_missing_with_recovered_report":
      return "Recovery reconciliation found that the tmux session had already disappeared, but transcript/report evidence was still recoverable, so the branch was safely marked stopped instead of completed."
    case "session_missing_without_usable_finalization":
      return "Recovery reconciliation found that the tmux session had already disappeared and no usable finalization/report was recoverable, so the branch was marked failed rather than inventing success."
    default:
      return undefined
  }
}

export function reconcileCompletedBranchState(args: {
  storedBranch?: RootAgentBranchSession
  runCode: number
  reportText: string
}): {
  status: SupervisionTerminalStatus
  finalizationSource: RootAgentBranchFinalizationSource
  finalizationReason: RootAgentBranchFinalizationReason
  handlingNote: string
} {
  const trimmedReport = args.reportText.trim()
  const storedStatus = args.storedBranch?.status
  const storedSource = args.storedBranch?.finalizationSource

  if (
    storedStatus === "completed" ||
    storedStatus === "stopped" ||
    storedStatus === "failed"
  ) {
    const explicitFinalizeConflictsWithNonzeroExit =
      storedSource === "explicit_finalize" && args.runCode !== 0

    return {
      status: storedStatus,
      finalizationSource: storedSource ?? "explicit_finalize",
      finalizationReason: args.storedBranch?.finalizationReason ?? "persisted_terminal_status",
      handlingNote: explicitFinalizeConflictsWithNonzeroExit
        ? `Persisted explicit supervision finalization takes precedence over the later observed nonzero tmux process exit (${args.runCode}); parent-side reconciliation records process-end metadata without changing the terminal branch status.`
        : storedSource === "parent_process_exit_reconciliation"
          ? "Persisted terminal supervision state already reflected parent-side process-end reconciliation."
          : "Persisted terminal supervision state was already finalized before parent-side process-end reconciliation.",
    }
  }

  if (args.runCode !== 0) {
    return {
      status: getTerminalBranchStatus(args.storedBranch?.status, args.runCode),
      finalizationSource: "parent_process_exit_reconciliation",
      finalizationReason: "nonzero_exit",
      handlingNote: `Parent reconciled branch state after process end because the tmux-hosted opencode run exited nonzero (${args.runCode}).`,
    }
  }

  if (trimmedReport.length > 0) {
    return {
      status: getTerminalBranchStatus(args.storedBranch?.status, args.runCode),
      finalizationSource: "parent_process_exit_reconciliation",
      finalizationReason: "ended_without_explicit_finalize",
      handlingNote:
        "Parent reconciled branch state after process end because no explicit finalize_workstream_supervision call was persisted, but transcript/report evidence was available.",
    }
  }

  return {
    status: getTerminalBranchStatus(args.storedBranch?.status, args.runCode),
    finalizationSource: "parent_process_exit_reconciliation",
    finalizationReason: "exit_zero_without_usable_finalization",
    handlingNote:
      "Parent reconciled branch state after process end with exit code 0, but no usable finalization/report was persisted.",
  }
}

function formatBranchCompletionMessage(args: {
  branchSessionId: string
  checkpointPointer?: RootAgentCheckpointPointer
  nativeSessionId?: string
  tmuxSessionName?: string
  observedPersistedStatus?: string
  status: SupervisionTerminalStatus
  processExitCode: number
  finalizationSource?: RootAgentBranchFinalizationSource
  finalizationReason?: RootAgentBranchFinalizationReason
  summary: string
  reportText: string
  transcript?: SessionExport
  transcriptError?: string
}): string {
  const transcriptLabel = args.transcript
    ? `Transcript export captured (${Array.isArray(args.transcript.messages) ? args.transcript.messages.length : 0} messages).`
    : args.nativeSessionId
      ? `Transcript export unavailable: ${args.transcriptError ?? "unknown export error"}`
      : "Transcript export unavailable: native branch session ID was not resolved."

  const sections = [
    `Supervision branch ${args.branchSessionId}${args.nativeSessionId ? ` (native session ${args.nativeSessionId})` : ""} ${args.status}${args.checkpointPointer ? ` from checkpoint pointer ${formatRootAgentCheckpointPointer(args.checkpointPointer)}` : ""}.`,
    ...(args.checkpointPointer?.breakpointSelection
      ? [`Breakpoint selection: ${formatRootAgentBreakpointSelection(args.checkpointPointer.breakpointSelection)}`]
      : []),
    `Persisted branch status: ${args.status}.`,
    ...(args.tmuxSessionName
      ? [
          `Tmux session: ${args.tmuxSessionName}. Attach with \`tmux attach -t ${args.tmuxSessionName}\` to inspect it.`,
        ]
      : []),
    `Process end evidence: tmux pane exited with status ${args.processExitCode}.`,
    ...(describeBranchFinalizationHandling({
      finalizationSource: args.finalizationSource,
      finalizationReason: args.finalizationReason,
    })
      ? [
          `Finalization handling: ${describeBranchFinalizationHandling({
            finalizationSource: args.finalizationSource,
            finalizationReason: args.finalizationReason,
          })}`,
        ]
      : []),
    transcriptLabel,
  ]

  if (args.observedPersistedStatus && args.observedPersistedStatus !== args.status) {
    sections.push(
      `Pre-final persisted branch status: ${args.observedPersistedStatus} (for example, supervise-pass handoff recorded before parent-side finalization).`,
    )
  }

  if (args.reportText) {
    sections.push(`Extracted final branch report:\n${args.reportText}`)
  }

  if (args.summary && args.summary !== args.reportText) {
    sections.push(`Branch run summary:\n${args.summary}`)
  }

  return sections.join("\n\n")
}

export async function persistSupervisionBranchState(args: {
  deps: LaunchSupervisionBranchDeps
  repoRoot: string
  streamId: string
  rootSessionId: string
  branchSessionId: string
  parentSessionId?: string
  checkpointMessageId?: string
  checkpointMessageIndex?: number
  checkpointCreatedAt?: string
  breakpointSelection?: RootAgentCheckpointPointer["breakpointSelection"]
  checkpointSessionId?: string
  nativeSessionId?: string
  tmuxSessionName?: string
  status: "pending" | "running" | SupervisionTerminalStatus
  startedAt: string
  updatedAt: string
  completedAt?: string
  processEndedAt?: string
  processExitCode?: number
  finalizationSource?: RootAgentBranchFinalizationSource
  finalizationReason?: RootAgentBranchFinalizationReason
  batchId?: string
  runId?: string
  notes: string
  scope?: RootAgentBranchScope
}): Promise<void> {
  logWorkstreamToolEvent("workstream.launch", "persistSupervisionBranchState:before", {
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    status: args.status,
    tmuxSessionName: args.tmuxSessionName,
  })
  await args.deps.persistBranchSession(
    args.repoRoot,
    args.streamId,
    await args.deps.buildBranchSession({
      context: {
        rootSessionId: args.rootSessionId,
        branchSessionId: args.branchSessionId,
        ...(args.checkpointMessageId ? { checkpointMessageId: args.checkpointMessageId } : {}),
        ...(typeof args.checkpointMessageIndex === "number"
          ? { checkpointMessageIndex: args.checkpointMessageIndex }
          : {}),
        ...(args.checkpointCreatedAt ? { checkpointCreatedAt: args.checkpointCreatedAt } : {}),
        ...(args.breakpointSelection ? { breakpointSelection: args.breakpointSelection } : {}),
        ...(args.checkpointSessionId ? { checkpointSessionId: args.checkpointSessionId } : {}),
        parentSessionId: args.parentSessionId ?? args.rootSessionId,
        ...(args.nativeSessionId ? { nativeSessionId: args.nativeSessionId } : {}),
        source: args.nativeSessionId ? "native_fork" : "repo_local_fallback",
        ...(args.scope ? { scope: args.scope } : {}),
      },
      branchRole: "supervision",
      status: args.status,
      startedAt: args.startedAt,
      updatedAt: args.updatedAt,
      completedAt: args.completedAt,
      processEndedAt: args.processEndedAt,
      processExitCode: args.processExitCode,
      finalizationSource: args.finalizationSource,
      finalizationReason: args.finalizationReason,
      tmuxSessionName: args.tmuxSessionName,
      runId: args.runId,
      batchId: args.batchId,
      notes: args.notes,
    }),
  )
  logWorkstreamToolEvent("workstream.launch", "persistSupervisionBranchState:after", {
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    status: args.status,
  })
}

async function resolveCompletedBranchNativeSessionId(args: {
  deps: LaunchSupervisionBranchDeps
  repoRoot: string
  streamId: string
  branchSessionId: string
  title: string
  nativeSessionId?: string
}): Promise<string | undefined> {
  if (args.nativeSessionId) {
    return args.nativeSessionId
  }

  const storedNativeSessionId = await args.deps.waitForBranchNativeSessionId({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    timeoutMs: DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS,
  })

  if (storedNativeSessionId) {
    return storedNativeSessionId
  }

  return args.deps.findNativeSessionIdByTitle(args.repoRoot, args.title)
}

export async function collectCompletedBranchArtifacts(args: {
  deps: LaunchSupervisionBranchDeps
  repoRoot: string
  streamId: string
  branchSessionId: string
  title: string
  nativeSessionId?: string
}): Promise<{
  nativeSessionId?: string
  terminalBranch?: RootAgentBranchSession
  transcript?: SessionExport
  reportText: string
  transcriptError?: string
}> {
  logWorkstreamToolEvent("workstream.launch", "collectCompletedBranchArtifacts:before", {
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    title: args.title,
  })
  const nativeSessionId = await resolveCompletedBranchNativeSessionId(args)
  const terminalBranch = await args.deps.waitForTerminalBranchSession({
    repoRoot: args.repoRoot,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    timeoutMs: DEFAULT_BRANCH_TOOL_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_BRANCH_TOOL_POLL_INTERVAL_MS,
  })

  if (!nativeSessionId) {
    logWorkstreamToolEvent("workstream.launch", "collectCompletedBranchArtifacts:no-native-session", {
      branchSessionId: args.branchSessionId,
    })
    return { terminalBranch, reportText: "" }
  }

  try {
    const transcript = await args.deps.exportSessionTranscript(nativeSessionId)
    const result = {
      nativeSessionId,
      terminalBranch,
      transcript,
      reportText: (await args.deps.extractFinalBranchReport(transcript)).trim(),
    }
    logWorkstreamToolEvent("workstream.launch", "collectCompletedBranchArtifacts:after", {
      branchSessionId: args.branchSessionId,
      nativeSessionId,
      reportTextLength: result.reportText.length,
    })
    return result
  } catch (error: any) {
    logWorkstreamToolEvent("workstream.launch", "collectCompletedBranchArtifacts:export-error", {
      branchSessionId: args.branchSessionId,
      nativeSessionId,
      error,
    })
    return {
      nativeSessionId,
      terminalBranch,
      reportText: "",
      transcriptError: error?.message || String(error),
    }
  }
}

export async function executeLaunchSupervisionBranch(
  args: {
    streamId?: string
    scope?: string
    target?: string
    stage?: string
    batch?: string
    breakpointTags?: string
    breakpointMode?: string
    noServer?: boolean
    silent?: boolean
  },
  context: { sessionID?: string },
  deps: LaunchSupervisionBranchDeps,
): Promise<string> {
  logWorkstreamToolEvent("workstream.launch", "executeLaunchSupervisionBranch:before", {
    sessionID: context.sessionID,
    streamId: args.streamId,
    scope: args.scope,
    target: args.target,
    stage: args.stage,
    batch: args.batch,
  })
  const rootSessionId = context.sessionID

  if (!rootSessionId) {
    logWorkstreamToolEvent("workstream.launch", "executeLaunchSupervisionBranch:missing-session")
    return "Error: Could not determine current Root Agent session ID"
  }

  const repoRoot = deps.getRepoRoot()
  const normalizedStreamId = normalizeOptionalLaunchString(args.streamId)
  const normalizedTarget = resolveLegacyLaunchTarget(args)
  const breakpointTags = parseBreakpointTagsArg(args.breakpointTags)
  const breakpointMode = parseBreakpointModeArg(args.breakpointMode)
  const streamId = await deps.getResolvedStreamId(repoRoot, normalizedStreamId)
  const launchScope = resolveLaunchScope({ scope: args.scope, target: normalizedTarget })
  const resolvedBatchTarget = launchScope?.level === "batch" ? launchScope.batchId : undefined
  logWorkstreamToolEvent("workstream.launch", "executeLaunchSupervisionBranch:resolved-inputs", {
    repoRoot,
    streamId,
    launchScope,
    resolvedBatchTarget,
  })

  const parentBranch = await deps.findBranchSessionForLaunchSessionId(
    repoRoot,
    streamId,
    rootSessionId,
  )
  if (parentBranch) {
    logWorkstreamToolEvent("workstream.launch", "executeLaunchSupervisionBranch:parent-branch-guard", {
      parentBranchId: parentBranch.branchSessionId,
    })
    const parentBranchLabel = parentBranch.branchSessionId ?? rootSessionId
    return [
      "Error: Supervision branches cannot launch additional supervision branches.",
      `Current session is already branch ${parentBranchLabel}.`,
      "Current guard is intentionally one-level only and triggers when the current native session is already recorded as a branch session.",
      "Yield back to the Root Agent so it can inspect persisted branch state and decide the next action.",
    ].join("\n")
  }

  const activeMatchingBranch = await deps.findActiveMatchingSupervisionBranch({
    repoRoot,
    streamId,
    rootSessionId,
    scope: launchScope,
  })
  if (activeMatchingBranch) {
    logWorkstreamToolEvent("workstream.launch", "executeLaunchSupervisionBranch:duplicate-guard", {
      activeBranchId: activeMatchingBranch.branchSessionId,
      status: activeMatchingBranch.status,
      tmuxSessionName: activeMatchingBranch.tmuxSessionName,
    })
    return formatExistingSupervisionLaunchMessage({
      streamId,
      branch: activeMatchingBranch,
      scope: launchScope,
      batch: resolvedBatchTarget,
    })
  }

  const branchSessionId = await deps.createBranchSessionId()
  const title = buildSupervisionBranchTitle(streamId, branchSessionId)
  const startedAt = deps.now()
  const existingBranch = await deps.loadStoredBranchSession(repoRoot, streamId, branchSessionId)
  const tmuxSessionName =
    existingBranch?.tmuxSessionName ??
    (await deps.createSupervisionTmuxSessionName(streamId))

  if (await deps.tmuxSessionExists(tmuxSessionName)) {
    logWorkstreamToolEvent("workstream.launch", "executeLaunchSupervisionBranch:tmux-exists-guard", {
      tmuxSessionName,
    })
    return [
      `Supervision session ${tmuxSessionName} is already running for ${streamId}.`,
      `Attach with \`tmux attach -t ${tmuxSessionName}\` to observe it.`,
      "Refusing to launch another supervision session for the same branch metadata.",
    ].join("\n")
  }

  await persistSupervisionBranchState({
    deps,
    repoRoot,
    streamId,
    rootSessionId,
    branchSessionId,
    status: "pending",
    startedAt,
    updatedAt: startedAt,
    tmuxSessionName,
    batchId: resolvedBatchTarget,
    scope: launchScope,
    notes: `Capturing checkpoint pointer metadata for ${describeScopeLabel(launchScope, resolvedBatchTarget)}; branch is not active yet.`,
  })

  let checkpointPointer: RootAgentCheckpointPointer | undefined

  try {
    const checkpointCreatedAt = deps.now()
    logWorkstreamToolEvent("workstream.launch", "exportSessionTranscript:before", {
      rootSessionId,
    })
    const rootSessionExport = await deps.exportSessionTranscript(rootSessionId)
    logWorkstreamToolEvent("workstream.launch", "exportSessionTranscript:after", {
      rootSessionId,
      messageCount: Array.isArray(rootSessionExport.messages) ? rootSessionExport.messages.length : undefined,
    })
    logWorkstreamToolEvent("workstream.launch", "refreshCheckpointPointer:before", {
      rootSessionId,
    })
    checkpointPointer = await deps.refreshCheckpointPointer({
      repoRoot,
      streamId,
      rootSessionId,
      sessionExport: rootSessionExport,
      checkpointCreatedAt,
      ...(breakpointTags ? { breakpointTags } : {}),
      ...(breakpointMode ? { breakpointMode } : {}),
    })
    logWorkstreamToolEvent("workstream.launch", "refreshCheckpointPointer:after", {
      checkpointMessageId: checkpointPointer.checkpointMessageId,
      checkpointMessageIndex: checkpointPointer.checkpointMessageIndex,
    })

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: rootSessionId,
      checkpointMessageId: checkpointPointer.checkpointMessageId,
      checkpointMessageIndex: checkpointPointer.checkpointMessageIndex,
      checkpointCreatedAt,
      breakpointSelection: checkpointPointer.breakpointSelection,
      status: "pending",
      startedAt,
      updatedAt: deps.now(),
      tmuxSessionName,
      batchId: resolvedBatchTarget,
      scope: launchScope,
      notes: buildCheckpointCaptureNotes(checkpointPointer, launchScope, resolvedBatchTarget),
    })

    const checkpointForkEligibility = await deps.getCheckpointSessionForkEligibility({
      pointer: checkpointPointer,
      sessionExport: rootSessionExport,
    })
    logWorkstreamToolEvent("workstream.launch", "getCheckpointSessionForkEligibility:after", {
      valid: checkpointForkEligibility.valid,
      canForkCurrentSession: checkpointForkEligibility.canForkCurrentSession,
      reason: checkpointForkEligibility.reason,
    })
    if (!checkpointForkEligibility.valid) {
      throw new Error(
        `Checkpoint pointer ${formatRootAgentCheckpointPointer(checkpointPointer)} no longer resolves against the current root transcript (${checkpointForkEligibility.reason ?? "unknown validation failure"}).`,
      )
    }

    const supervisionPrompt = buildSupervisionPrompt({
      scope: launchScope,
      batch: resolvedBatchTarget,
    })
    const capturedCheckpointPointer = checkpointPointer
    const persistNativeSessionId = async (nativeSessionId: string) => {
      const updatedAt = deps.now()
      const storedBranch = await deps.loadStoredBranchSession(repoRoot, streamId, branchSessionId)

      await persistSupervisionBranchState({
        deps,
        repoRoot,
        streamId,
        rootSessionId,
        branchSessionId,
        parentSessionId: storedBranch?.parentSessionId ?? rootSessionId,
        checkpointMessageId:
          storedBranch?.checkpointMessageId ?? capturedCheckpointPointer.checkpointMessageId,
        checkpointMessageIndex:
          storedBranch?.checkpointMessageIndex ?? capturedCheckpointPointer.checkpointMessageIndex,
        checkpointCreatedAt:
          storedBranch?.checkpointCreatedAt ?? capturedCheckpointPointer.checkpointCreatedAt,
        breakpointSelection:
          storedBranch?.breakpointSelection ?? capturedCheckpointPointer.breakpointSelection,
        nativeSessionId,
        status: storedBranch?.status === "running" ? "running" : "pending",
        startedAt: storedBranch?.startedAt ?? startedAt,
        updatedAt,
        tmuxSessionName: storedBranch?.tmuxSessionName ?? tmuxSessionName,
        runId: storedBranch?.runId,
        batchId: storedBranch?.batchId ?? resolvedBatchTarget,
        scope: storedBranch?.scope ?? launchScope,
        notes:
          storedBranch?.notes ??
          buildCheckpointCaptureNotes(capturedCheckpointPointer, launchScope, resolvedBatchTarget),
      })
    }

    let runResult: ForkedSessionResult
    logWorkstreamToolEvent("workstream.launch", "runForkedSession:before", {
      forkMode: checkpointPointer.checkpointMessageId ? "message-or-fallback" : "latest_session_fork",
      tmuxSessionName,
    })
    if (!checkpointPointer.checkpointMessageId) {
      if (!checkpointForkEligibility.canForkCurrentSession) {
        throw formatCheckpointLaunchFallbackError({
          checkpointPointer,
          eligibility: checkpointForkEligibility,
        })
      }

      runResult = await deps.runForkedSession({
        sessionId: rootSessionId,
        repoRoot,
        title,
        prompt: supervisionPrompt,
        forkMode: "latest_session_fork",
        tmuxSessionName,
        onNativeSessionId: persistNativeSessionId,
      })
    } else {
      try {
        runResult = await deps.runForkedSession({
          sessionId: rootSessionId,
          repoRoot,
          title,
          prompt: supervisionPrompt,
          checkpointMessageId: checkpointPointer.checkpointMessageId,
          forkMode: "message",
          tmuxSessionName,
          onNativeSessionId: persistNativeSessionId,
        })
      } catch (error) {
        if (!checkpointForkEligibility.canForkCurrentSession) {
          throw formatCheckpointLaunchFallbackError({
            checkpointPointer,
            eligibility: checkpointForkEligibility,
            cause: error,
          })
        }

        runResult = await deps.runForkedSession({
          sessionId: rootSessionId,
          repoRoot,
          title,
          prompt: supervisionPrompt,
          forkMode: "latest_session_fork",
          tmuxSessionName,
          onNativeSessionId: persistNativeSessionId,
        })
      }
    }
    logWorkstreamToolEvent("workstream.launch", "runForkedSession:after", {
      code: runResult.code,
      nativeSessionId: runResult.nativeSessionId,
      tmuxSessionName: runResult.tmuxSessionName,
    })

    const parsed = await deps.parseOutput(runResult.stdout)
    const fallbackSummary =
      parsed.text.trim() || runResult.stderr.trim() || "(branch session produced no summary)"
    const {
      nativeSessionId,
      terminalBranch,
      transcript,
      reportText,
      transcriptError,
    } = await collectCompletedBranchArtifacts({
      deps,
      repoRoot,
      streamId,
      branchSessionId,
      title,
      nativeSessionId: runResult.nativeSessionId,
    })
    const storedBranch =
      terminalBranch ?? (await deps.loadStoredBranchSession(repoRoot, streamId, branchSessionId))
    const reconciledAt = deps.now()
    const processEndedAt = reconciledAt
    const reconciled = reconcileCompletedBranchState({
      storedBranch,
      runCode: runResult.code,
      reportText,
    })
    const status = reconciled.status
    const summary = reportText || fallbackSummary
    const storedCheckpointPointer = getCheckpointPointerFromBranchSession(storedBranch)
    const completedAt = storedBranch?.completedAt ?? reconciledAt

    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: storedBranch?.parentSessionId ?? rootSessionId,
      checkpointMessageId: storedBranch?.checkpointMessageId ?? checkpointPointer.checkpointMessageId,
      checkpointMessageIndex:
        storedBranch?.checkpointMessageIndex ?? checkpointPointer.checkpointMessageIndex,
      checkpointCreatedAt:
        storedBranch?.checkpointCreatedAt ??
        storedCheckpointPointer?.checkpointCreatedAt ??
        checkpointPointer.checkpointCreatedAt,
      breakpointSelection:
        storedBranch?.breakpointSelection ??
        storedCheckpointPointer?.breakpointSelection ??
        checkpointPointer.breakpointSelection,
      nativeSessionId,
      status,
      startedAt: storedBranch?.startedAt ?? startedAt,
      updatedAt: reconciledAt,
      completedAt,
      processEndedAt,
      processExitCode: runResult.code,
      finalizationSource: reconciled.finalizationSource,
      finalizationReason: reconciled.finalizationReason,
      tmuxSessionName:
        storedBranch?.tmuxSessionName ?? runResult.tmuxSessionName ?? tmuxSessionName,
      runId: storedBranch?.runId,
      batchId: storedBranch?.batchId ?? resolvedBatchTarget,
      scope: storedBranch?.scope ?? launchScope,
      notes: appendSupervisionTmuxObservability(
        joinBranchNotes(
          storedBranch?.notes,
          formatSupervisionProcessExitEvidence(runResult.code),
          reconciled.handlingNote,
          summary,
        ),
        runResult.tmuxMetadata as SupervisionTmuxLaunchMetadata | undefined,
      ),
    })

    const message = formatBranchCompletionMessage({
      branchSessionId,
      checkpointPointer: storedCheckpointPointer ?? checkpointPointer,
      nativeSessionId,
      tmuxSessionName:
        storedBranch?.tmuxSessionName ?? runResult.tmuxSessionName ?? tmuxSessionName,
      observedPersistedStatus: storedBranch?.status,
      status,
      processExitCode: runResult.code,
      finalizationSource: reconciled.finalizationSource,
      finalizationReason: reconciled.finalizationReason,
      summary,
      reportText,
      transcript,
      transcriptError,
    })
    logWorkstreamToolEvent("workstream.launch", "executeLaunchSupervisionBranch:after", {
      branchSessionId,
      status,
      nativeSessionId,
      tmuxSessionName:
        storedBranch?.tmuxSessionName ?? runResult.tmuxSessionName ?? tmuxSessionName,
    })
    return message
  } catch (error: any) {
    logWorkstreamToolEvent("workstream.launch", "executeLaunchSupervisionBranch:error", {
      branchSessionId,
      error,
    })
    const failedAt = deps.now()
    await persistSupervisionBranchState({
      deps,
      repoRoot,
      streamId,
      rootSessionId,
      branchSessionId,
      parentSessionId: rootSessionId,
      checkpointMessageId: checkpointPointer?.checkpointMessageId,
      checkpointMessageIndex: checkpointPointer?.checkpointMessageIndex,
      checkpointCreatedAt: checkpointPointer?.checkpointCreatedAt,
      breakpointSelection: checkpointPointer?.breakpointSelection,
      status: "failed",
      startedAt,
      updatedAt: failedAt,
      completedAt: failedAt,
      tmuxSessionName,
      batchId: resolvedBatchTarget,
      scope: launchScope,
      notes: `Failed to launch Root Agent supervision branch: ${error?.message || error}`,
    })

    return `Supervision branch ${branchSessionId} failed to launch.\n\n${error?.message || error}`
  }
}

export function getDefaultLaunchSupervisionBranchHelpers() {
  return {
    runCommand,
    findNativeSessionIdByTitle,
    runForkedSession,
    runForkedSessionInTmux,
    createSupervisionTmuxSessionName,
    tmuxSessionExists,
    isActiveSupervisionBranchStatus,
    isTerminalStoppedSupervisionBranch,
    shouldBlockDuplicateSupervisionLaunch,
    hasActiveSupervisionSessionHandle,
    doLaunchScopesMatch,
  }
}

export function createDefaultLaunchSupervisionBranchDeps(
  runtime: LaunchSupervisionRuntimeDeps,
  options: {
    getRepoRoot?: () => string
    now?: () => string
  } = {},
): LaunchSupervisionBranchDeps {
  logWorkstreamToolEvent("workstream.launch", "createDefaultLaunchSupervisionBranchDeps:before")
  const deps: LaunchSupervisionBranchDeps = {
    getRepoRoot: options.getRepoRoot ?? (() => process.cwd()),
    getResolvedStreamId: (repoRoot, streamId) =>
      runtime.getResolvedStream(runtime.loadIndex(repoRoot), streamId).id,
    findBranchSessionForLaunchSessionId: (repoRoot, streamId, sessionId) =>
      runtime.findRootAgentBranchSessionForLaunchSessionId({
        repoRoot,
        streamId,
        sessionId,
      }),
    findBranchSessionByNativeSessionId: (repoRoot, streamId, nativeSessionId) =>
      runtime
        .loadSupervisorState(repoRoot, streamId)
        ?.branch_sessions.find((branch) => branch.nativeSessionId === nativeSessionId),
    createBranchSessionId: () => runtime.createRootAgentBranchSessionId("supervision"),
    buildBranchSession: (args) => runtime.buildRootAgentBranchSession(args),
    persistBranchSession: (repoRoot, streamId, branchSession) =>
      runtime.upsertBranchSessionLocked(repoRoot, streamId, branchSession),
    loadStoredBranchSession: (repoRoot, streamId, branchSessionId) =>
      runtime
        .loadSupervisorState(repoRoot, streamId)
        ?.branch_sessions.find((branch) => branch.branchSessionId === branchSessionId),
    findActiveMatchingSupervisionBranch: ({ repoRoot, streamId, rootSessionId, scope }) =>
      runtime
        .loadSupervisorState(repoRoot, streamId)
        ?.branch_sessions.find(
          (branch) =>
            branch.branchRole === "supervision" &&
            branch.rootSessionId === rootSessionId &&
            shouldBlockDuplicateSupervisionLaunch(branch) &&
            hasActiveSupervisionSessionHandle(branch) &&
            doLaunchScopesMatch(branch.scope, scope),
        ),
    waitForBranchNativeSessionId: (args) => runtime.waitForRootAgentBranchNativeSessionId(args),
    waitForTerminalBranchSession: (args) => runtime.waitForRootAgentBranchTerminalSession(args),
    createSupervisionTmuxSessionName: (streamId) =>
      (runtime.getDefaultLaunchSupervisionBranchHelpers?.().createSupervisionTmuxSessionName ??
        createSupervisionTmuxSessionName)(streamId),
    tmuxSessionExists: (sessionName) =>
      (runtime.getDefaultLaunchSupervisionBranchHelpers?.().tmuxSessionExists ??
        tmuxSessionExists)(sessionName),
    runForkedSession: (args) => {
      if (args.tmuxSessionName) {
        return (runtime.runForkedSessionInTmux ?? runForkedSessionInTmux)({
          ...args,
          tmuxSessionName: args.tmuxSessionName,
        })
      }

      if (args.forkMode === "message") {
        if (!args.checkpointMessageId) {
          throw new Error("Message-boundary fork requires checkpointMessageId.")
        }

        return (runtime.runMessageBoundaryForkLaunch ?? runMessageBoundaryForkLaunch)({
          sessionId: args.sessionId,
          repoRoot: args.repoRoot,
          title: args.title,
          prompt: args.prompt,
          checkpointMessageId: args.checkpointMessageId,
          onNativeSessionId: args.onNativeSessionId,
        })
      }

      return (runtime.getDefaultLaunchSupervisionBranchHelpers?.().runForkedSession ??
        runForkedSession)(args)
    },
    runCommand: (...args) =>
      (runtime.getDefaultLaunchSupervisionBranchHelpers?.().runCommand ?? runCommand)(...args),
    findNativeSessionIdByTitle: (...args) =>
      (runtime.getDefaultLaunchSupervisionBranchHelpers?.().findNativeSessionIdByTitle ??
        findNativeSessionIdByTitle)(...args),
    parseOutput: (content) => runtime.parseSynthesisJsonl(content),
    exportSessionTranscript: (sessionId) => runtime.exportSession(sessionId),
    refreshCheckpointPointer: (args) => runtime.refreshRootAgentCheckpointPointer(args),
    getCheckpointSessionForkEligibility: (args) =>
      runtime.getRootAgentCheckpointSessionForkEligibility(args),
    extractFinalBranchReport: (sessionExport) =>
      runtime.extractLastCompletedAssistantText(sessionExport),
    now: options.now ?? (() => new Date().toISOString()),
  }
  logWorkstreamToolEvent("workstream.launch", "createDefaultLaunchSupervisionBranchDeps:after")
  return deps
}
