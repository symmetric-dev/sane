import type {
  RootAgentBranchScope,
  RootAgentBranchSession,
  RootAgentBranchFinalizationSource,
  RootAgentBreakpointSelection,
  RootAgentBranchStatus,
  RootAgentSupervisionProgress,
} from "../types.ts"
import { logWorkstreamToolEvent } from "./debug-log.ts"

export type SupervisionTerminalStatus = Extract<
  RootAgentBranchStatus,
  "completed" | "stopped" | "failed"
>

export interface FinalizeWorkstreamSupervisionCurrent {
  rootSessionId: string
  branchSessionId: string
  nativeSessionId?: string
  checkpointMessageId?: string
  checkpointMessageIndex?: number
  checkpointCreatedAt?: string
  breakpointSelection?: RootAgentBreakpointSelection
  checkpointSessionId?: string
  parentSessionId?: string
  scope?: RootAgentBranchScope
  supervisionProgress?: RootAgentSupervisionProgress
}

export interface FinalizeWorkstreamSupervisionResolution {
  streamId: string
  current: FinalizeWorkstreamSupervisionCurrent
  branchSession: RootAgentBranchSession | undefined
  resolutionSource: "current_supervision_context" | "persisted_session_fallback"
}

export interface FinalizeWorkstreamSupervisionDeps {
  getRepoRoot: () => string
  resolveFinalizableSupervision: (args: {
    repoRoot: string
    sessionId: string
    streamId?: string
  }) => Promise<FinalizeWorkstreamSupervisionResolution | undefined>
  buildBranchSession: (args: any) => RootAgentBranchSession | Promise<RootAgentBranchSession>
  persistBranchSession: (
    repoRoot: string,
    streamId: string,
    branchSession: RootAgentBranchSession,
  ) => unknown | Promise<unknown>
  now: () => string
}

export interface FinalizeWorkstreamSupervisionArgs {
  status: SupervisionTerminalStatus
  streamId?: string
  notes?: string
  summary?: string
  reportText?: string
}

export function isTerminalSupervisionStatus(
  status: string | undefined,
): status is SupervisionTerminalStatus {
  return status === "completed" || status === "stopped" || status === "failed"
}

export function buildFinalizationNotes(args: {
  existingNotes?: string
  notes?: string
  summary?: string
  reportText?: string
}): string | undefined {
  const incomingSections = [
    args.notes?.trim(),
    args.summary?.trim() ? `Summary:\n${args.summary.trim()}` : undefined,
    args.reportText?.trim() ? `Final report:\n${args.reportText.trim()}` : undefined,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0))

  const incomingText = incomingSections.join("\n\n").trim()
  const existingNotes = args.existingNotes?.trim()

  if (!incomingText) {
    return existingNotes || undefined
  }

  if (!existingNotes) {
    return incomingText
  }

  if (existingNotes.includes(incomingText)) {
    return existingNotes
  }

  if (incomingText.includes(existingNotes)) {
    return incomingText
  }

  return `${existingNotes}\n\n${incomingText}`
}

export function buildPersistedSupervisionFallback(args: {
  streamId: string
  branchSession: RootAgentBranchSession | undefined
}): FinalizeWorkstreamSupervisionResolution | undefined {
  const branchSession = args.branchSession
  if (
    !branchSession ||
    branchSession.branchRole !== "supervision" ||
    typeof branchSession.rootSessionId !== "string" ||
    typeof branchSession.branchSessionId !== "string"
  ) {
    return undefined
  }

  return {
    streamId: args.streamId,
    current: {
      rootSessionId: branchSession.rootSessionId,
      branchSessionId: branchSession.branchSessionId,
      ...(branchSession.nativeSessionId ? { nativeSessionId: branchSession.nativeSessionId } : {}),
      ...(branchSession.checkpointMessageId
        ? { checkpointMessageId: branchSession.checkpointMessageId }
        : {}),
      ...(typeof branchSession.checkpointMessageIndex === "number"
        ? { checkpointMessageIndex: branchSession.checkpointMessageIndex }
        : {}),
      ...(branchSession.checkpointCreatedAt
        ? { checkpointCreatedAt: branchSession.checkpointCreatedAt }
        : {}),
      ...(branchSession.breakpointSelection
        ? { breakpointSelection: branchSession.breakpointSelection }
        : {}),
      ...(branchSession.checkpointSessionId
        ? { checkpointSessionId: branchSession.checkpointSessionId }
        : {}),
      ...(branchSession.parentSessionId ? { parentSessionId: branchSession.parentSessionId } : {}),
      ...(branchSession.scope ? { scope: branchSession.scope } : {}),
      ...(branchSession.supervisionProgress
        ? { supervisionProgress: branchSession.supervisionProgress }
        : {}),
    },
    branchSession,
    resolutionSource: "persisted_session_fallback",
  }
}

export interface FinalizeWorkstreamRuntimeLike {
  getResolvedStream: (index: any, streamId?: string) => { id: string }
  loadIndex: (repoRoot: string) => any
}

export interface FinalizeWorkstreamRuntimeDeps extends FinalizeWorkstreamRuntimeLike {
  resolveCurrentBranchSupervisionContext?: (args: {
    repoRoot: string
    streamId?: string
    sessionId?: string
  }) =>
    | {
        streamId: string
        current: FinalizeWorkstreamSupervisionCurrent
      }
    | undefined
  loadSupervisorState: (repoRoot: string, streamId: string) => {
    branch_sessions: RootAgentBranchSession[]
  } | undefined
  buildRootAgentBranchSession: (args: any) => RootAgentBranchSession | Promise<RootAgentBranchSession>
  upsertBranchSessionLocked: (
    repoRoot: string,
    streamId: string,
    branchSession: RootAgentBranchSession,
  ) => unknown | Promise<unknown>
  buildPersistedSupervisionFallback?: (args: {
    streamId: string
    branchSession: RootAgentBranchSession | undefined
  }) => FinalizeWorkstreamSupervisionResolution | undefined
}

export function createDefaultFinalizeWorkstreamSupervisionDeps(
  runtime: FinalizeWorkstreamRuntimeDeps,
  options: {
    getRepoRoot?: () => string
    now?: () => string
  } = {},
): FinalizeWorkstreamSupervisionDeps {
  return {
    getRepoRoot: options.getRepoRoot ?? (() => process.cwd()),
    resolveFinalizableSupervision: async ({ repoRoot, sessionId, streamId }) => {
      const resolvedCurrent = runtime.resolveCurrentBranchSupervisionContext?.({
        repoRoot,
        streamId,
        sessionId,
      })

      if (resolvedCurrent?.current?.branchSessionId && resolvedCurrent.streamId) {
        const branchSession = runtime
          .loadSupervisorState(repoRoot, resolvedCurrent.streamId)
          ?.branch_sessions.find(
            (branch) => branch.branchSessionId === resolvedCurrent.current.branchSessionId,
          )

        if (branchSession) {
          return {
            streamId: resolvedCurrent.streamId,
            current: resolvedCurrent.current,
            branchSession,
            resolutionSource: "current_supervision_context",
          } satisfies FinalizeWorkstreamSupervisionResolution
        }
      }

      for (const candidateStreamId of listCandidateStreamIds(runtime, repoRoot, streamId)) {
        const branchSession = runtime
          .loadSupervisorState(repoRoot, candidateStreamId)
          ?.branch_sessions.find(
            (branch) =>
              branch.branchRole === "supervision" && branch.nativeSessionId === sessionId,
          )
        const fallback = runtime.buildPersistedSupervisionFallback
          ? runtime.buildPersistedSupervisionFallback({
              streamId: candidateStreamId,
              branchSession,
            })
          : buildPersistedSupervisionFallback({
              streamId: candidateStreamId,
              branchSession,
            })

        if (fallback) {
          return fallback
        }
      }

      return undefined
    },
    buildBranchSession: (args) => runtime.buildRootAgentBranchSession(args),
    persistBranchSession: (repoRoot, streamId, branchSession) =>
      runtime.upsertBranchSessionLocked(repoRoot, streamId, branchSession),
    now: options.now ?? (() => new Date().toISOString()),
  }
}

export function listCandidateStreamIds(
  runtime: FinalizeWorkstreamRuntimeLike,
  repoRoot: string,
  streamId?: string,
): string[] {
  if (streamId) {
    return [runtime.getResolvedStream(runtime.loadIndex(repoRoot), streamId).id]
  }

  const index = runtime.loadIndex(repoRoot)
  return Array.from(
    new Set([...(index.current_stream ? [index.current_stream] : []), ...index.streams.map((stream: { id: string }) => stream.id)]),
  )
}

export async function executeFinalizeWorkstreamSupervision(
  args: FinalizeWorkstreamSupervisionArgs,
  context: { sessionID?: string },
  deps: FinalizeWorkstreamSupervisionDeps,
): Promise<string> {
  logWorkstreamToolEvent("workstream.finalize", "execute:before", {
    sessionID: context.sessionID,
    status: args.status,
    streamId: args.streamId,
  })
  const sessionId = context.sessionID
  if (!sessionId) {
    logWorkstreamToolEvent("workstream.finalize", "execute:missing-session")
    return "Error: Could not determine current supervision session ID"
  }

  const repoRoot = deps.getRepoRoot()
  logWorkstreamToolEvent("workstream.finalize", "resolve:before", {
    repoRoot,
    sessionId,
    streamId: args.streamId,
  })
  const resolved = await deps.resolveFinalizableSupervision({
    repoRoot,
    sessionId,
    streamId: args.streamId,
  })
  logWorkstreamToolEvent("workstream.finalize", "resolve:after", {
    resolved: Boolean(resolved),
    resolutionSource: resolved?.resolutionSource,
    streamId: resolved?.streamId,
  })

  if (!resolved) {
    logWorkstreamToolEvent("workstream.finalize", "execute:not-found")
    return "Error: Could not find persisted workstream supervision state for the current session."
  }

  const existing = resolved.branchSession
  const requestedStatus = args.status
  const status = isTerminalSupervisionStatus(existing?.status)
    ? existing.status
    : requestedStatus
  const updatedAt = deps.now()
  const completedAt = existing?.completedAt ?? updatedAt
  const notes = buildFinalizationNotes({
    existingNotes: existing?.notes,
    notes: args.notes,
    summary: args.summary,
    reportText: args.reportText,
  })
  const batchId =
    existing?.batchId ?? resolved.current?.supervisionProgress?.currentBatchId
  const finalizationSource: RootAgentBranchFinalizationSource =
    existing?.finalizationSource ?? "explicit_finalize"

  logWorkstreamToolEvent("workstream.finalize", "persist:before", {
    streamId: resolved.streamId,
    branchSessionId: resolved.current.branchSessionId,
    status,
  })
  await deps.persistBranchSession(
    repoRoot,
    resolved.streamId,
    await deps.buildBranchSession({
      context: {
        rootSessionId: resolved.current.rootSessionId,
        branchSessionId: resolved.current.branchSessionId,
        ...(resolved.current.checkpointMessageId
          ? { checkpointMessageId: resolved.current.checkpointMessageId }
          : {}),
        ...(typeof resolved.current.checkpointMessageIndex === "number"
          ? { checkpointMessageIndex: resolved.current.checkpointMessageIndex }
          : {}),
        ...(resolved.current.checkpointCreatedAt
          ? { checkpointCreatedAt: resolved.current.checkpointCreatedAt }
          : {}),
        ...(resolved.current.breakpointSelection
          ? { breakpointSelection: resolved.current.breakpointSelection }
          : {}),
        ...(resolved.current.checkpointSessionId
          ? { checkpointSessionId: resolved.current.checkpointSessionId }
          : {}),
        ...(resolved.current.parentSessionId ? { parentSessionId: resolved.current.parentSessionId } : {}),
        ...(resolved.current.nativeSessionId ? { nativeSessionId: resolved.current.nativeSessionId } : {}),
        ...(existing?.source ? { source: existing.source } : {}),
        ...(existing?.scope ?? resolved.current.scope
          ? { scope: existing?.scope ?? resolved.current.scope }
          : {}),
      },
      branchRole: "supervision",
      status,
      startedAt: existing?.startedAt ?? updatedAt,
      updatedAt,
      completedAt,
      processEndedAt: existing?.processEndedAt,
      processExitCode: existing?.processExitCode,
      finalizationSource,
      finalizationReason: existing?.finalizationReason ?? "persisted_terminal_status",
      runId: existing?.runId,
      ...(batchId ? { batchId } : {}),
      ...(existing?.supervisionProgress
        ? { supervisionProgress: existing.supervisionProgress }
        : resolved.current.supervisionProgress
          ? { supervisionProgress: resolved.current.supervisionProgress }
          : {}),
      ...(notes ? { notes } : {}),
    }),
  )
  logWorkstreamToolEvent("workstream.finalize", "persist:after", {
    streamId: resolved.streamId,
    branchSessionId: resolved.current.branchSessionId,
    status,
  })

  const alreadyFinalized =
    isTerminalSupervisionStatus(existing?.status) && existing?.status === status
  const resolutionDetail =
    resolved.resolutionSource === "persisted_session_fallback"
      ? " Persisted session fallback was used."
      : ""
  const unchangedStatusDetail =
    isTerminalSupervisionStatus(existing?.status) && existing?.status !== requestedStatus
      ? ` Existing terminal status ${existing.status} was preserved.`
      : ""

  const message = alreadyFinalized
    ? `Workstream supervision was already finalized as ${status} for ${resolved.streamId}.${unchangedStatusDetail}${resolutionDetail}`
    : `Marked workstream supervision as ${status} for ${resolved.streamId}.${unchangedStatusDetail}${resolutionDetail}`
  logWorkstreamToolEvent("workstream.finalize", "execute:after", {
    streamId: resolved.streamId,
    status,
    alreadyFinalized,
  })
  return message
}
