import type {
  RootAgentBranchFinalizationReason,
  RootAgentBranchFinalizationSource,
  RootAgentBranchSession,
} from "../types.ts"
import type { SessionExport } from "../session-export.ts"
import { listCandidateStreamIds, isTerminalSupervisionStatus } from "./finalize-supervision.ts"
import {
  buildSupervisionBranchTitle,
  formatSupervisionProcessExitEvidence,
  joinBranchNotes,
  reconcileCompletedBranchState,
} from "./launch-supervision.ts"
import {
  inspectSupervisionTmuxSession,
  type SupervisionTmuxInspection,
} from "./launch-supervision-tmux.ts"
import { logWorkstreamToolEvent } from "./debug-log.ts"

export interface ReconcileWorkstreamSupervisionArgs {
  streamId?: string
  branchSessionId?: string
}

export interface ReconcileWorkstreamSupervisionDeps {
  getRepoRoot: () => string
  loadCandidateBranches: (args: {
    repoRoot: string
    streamId?: string
    branchSessionId?: string
    rootSessionId?: string
  }) => Array<{ streamId: string; branch: RootAgentBranchSession }>
  buildBranchSession: (args: any) => RootAgentBranchSession | Promise<RootAgentBranchSession>
  persistBranchSession: (
    repoRoot: string,
    streamId: string,
    branchSession: RootAgentBranchSession,
  ) => unknown | Promise<unknown>
  inspectTmuxSession: (sessionName: string) => SupervisionTmuxInspection | Promise<SupervisionTmuxInspection>
  findNativeSessionIdByTitle: (
    repoRoot: string,
    title: string,
  ) => string | undefined | Promise<string | undefined>
  exportSessionTranscript: (sessionId: string) => Promise<SessionExport>
  extractFinalBranchReport: (sessionExport: SessionExport) => string | Promise<string>
  now: () => string
}

export interface ReconcileWorkstreamRuntimeDeps {
  getResolvedStream: (index: any, streamId?: string) => { id: string }
  loadIndex: (repoRoot: string) => any
  loadSupervisorState: (repoRoot: string, streamId: string) => {
    branch_sessions: RootAgentBranchSession[]
  } | undefined
  buildRootAgentBranchSession: (args: any) => RootAgentBranchSession | Promise<RootAgentBranchSession>
  upsertBranchSessionLocked: (
    repoRoot: string,
    streamId: string,
    branchSession: RootAgentBranchSession,
  ) => unknown | Promise<unknown>
  exportSession: (sessionId: string) => Promise<SessionExport>
  extractLastCompletedAssistantText: (sessionExport: SessionExport) => string | Promise<string>
  getDefaultLaunchSupervisionBranchHelpers?: () => {
    findNativeSessionIdByTitle?: (
      repoRoot: string,
      title: string,
    ) => string | undefined | Promise<string | undefined>
  }
}

interface ReconcileEvidence {
  tmux: SupervisionTmuxInspection
  nativeSessionId?: string
  transcript?: SessionExport
  reportText: string
  transcriptError?: string
}

function buildRecoveryHandling(args: { reportText: string }): {
  status: "stopped" | "failed"
  finalizationSource: RootAgentBranchFinalizationSource
  finalizationReason: RootAgentBranchFinalizationReason
  handlingNote: string
} {
  if (args.reportText.trim().length > 0) {
    return {
      status: "stopped",
      finalizationSource: "parent_process_exit_reconciliation",
      finalizationReason: "session_missing_with_recovered_report",
      handlingNote:
        "Recovery reconciliation found that the tmux session no longer existed, but transcript/report evidence was recoverable, so the supervision branch was safely marked stopped instead of completed.",
    }
  }

  return {
    status: "failed",
    finalizationSource: "parent_process_exit_reconciliation",
    finalizationReason: "session_missing_without_usable_finalization",
    handlingNote:
      "Recovery reconciliation found that the tmux session no longer existed and no usable finalization/report was recoverable, so the supervision branch was marked failed rather than inventing success.",
  }
}

function formatTmuxInspectionEvidence(args: {
  branch: RootAgentBranchSession
  tmux: SupervisionTmuxInspection
}): string {
  if (!args.branch.tmuxSessionName) {
    return "No persisted tmux session name was available for recovery inspection."
  }

  if (!args.tmux.exists) {
    return `Recovery inspection: tmux session ${args.branch.tmuxSessionName} no longer exists, so no authoritative pane exit status could be observed.`
  }

  if (args.tmux.paneDead) {
    return `Recovery inspection: tmux session ${args.branch.tmuxSessionName} still exists and its pane is dead${typeof args.tmux.exitStatus === "number" ? ` (exit ${args.tmux.exitStatus})` : ""}.`
  }

  return `Recovery inspection: tmux session ${args.branch.tmuxSessionName} is still live; reconciliation skipped.`
}

async function recoverBranchEvidence(args: {
  deps: ReconcileWorkstreamSupervisionDeps
  repoRoot: string
  streamId: string
  branch: RootAgentBranchSession
  tmux: SupervisionTmuxInspection
}): Promise<ReconcileEvidence> {
  const existingNativeSessionId = args.branch.nativeSessionId?.trim() || undefined
  const title = buildSupervisionBranchTitle(args.streamId, args.branch.branchSessionId)
  const nativeSessionId =
    existingNativeSessionId ??
    (await args.deps.findNativeSessionIdByTitle(args.repoRoot, title))

  if (!nativeSessionId) {
    return {
      tmux: args.tmux,
      reportText: "",
    }
  }

  try {
    const transcript = await args.deps.exportSessionTranscript(nativeSessionId)
    return {
      tmux: args.tmux,
      nativeSessionId,
      transcript,
      reportText: (await args.deps.extractFinalBranchReport(transcript)).trim(),
    }
  } catch (error) {
    return {
      tmux: args.tmux,
      nativeSessionId,
      reportText: "",
      transcriptError: error instanceof Error ? error.message : String(error),
    }
  }
}

function formatReconciledBranchResult(args: {
  streamId: string
  branch: RootAgentBranchSession
  status: "completed" | "stopped" | "failed"
  evidence: ReconcileEvidence
  finalizationReason: RootAgentBranchFinalizationReason
}): string {
  return [
    `- ${args.streamId}:${args.branch.branchSessionId} -> ${args.status}`,
    `  tmux: ${args.branch.tmuxSessionName ?? "(none)"}${args.evidence.tmux.exists ? args.evidence.tmux.paneDead ? `, pane dead${typeof args.evidence.tmux.exitStatus === "number" ? `, exit ${args.evidence.tmux.exitStatus}` : ""}` : ", still live" : ", missing"}`,
    `  native session: ${args.evidence.nativeSessionId ?? "unresolved"}`,
    `  transcript: ${args.evidence.transcript ? "recovered" : args.evidence.nativeSessionId ? `unavailable (${args.evidence.transcriptError ?? "unknown export error"})` : "unavailable (no native session id)"}`,
    `  reason: ${args.finalizationReason}`,
  ].join("\n")
}

export function createDefaultReconcileWorkstreamSupervisionDeps(
  runtime: ReconcileWorkstreamRuntimeDeps,
  options: {
    getRepoRoot?: () => string
    now?: () => string
  } = {},
): ReconcileWorkstreamSupervisionDeps {
  return {
    getRepoRoot: options.getRepoRoot ?? (() => process.cwd()),
    loadCandidateBranches: ({ repoRoot, streamId, branchSessionId, rootSessionId }) => {
      const candidateStreamIds = listCandidateStreamIds(runtime, repoRoot, streamId)
      const allCandidates = candidateStreamIds.flatMap((candidateStreamId) =>
        (runtime.loadSupervisorState(repoRoot, candidateStreamId)?.branch_sessions ?? [])
          .filter(
            (branch) =>
              branch.branchRole === "supervision" &&
              !isTerminalSupervisionStatus(branch.status) &&
              (!branchSessionId || branch.branchSessionId === branchSessionId),
          )
          .map((branch) => ({ streamId: candidateStreamId, branch })),
      )

      if (!rootSessionId) {
        return allCandidates
      }

      const focused = allCandidates.filter(({ branch }) => branch.rootSessionId === rootSessionId)
      return focused.length > 0 ? focused : allCandidates
    },
    buildBranchSession: (args) => runtime.buildRootAgentBranchSession(args),
    persistBranchSession: (repoRoot, streamId, branchSession) =>
      runtime.upsertBranchSessionLocked(repoRoot, streamId, branchSession),
    inspectTmuxSession: inspectSupervisionTmuxSession,
    findNativeSessionIdByTitle: (repoRoot, title) =>
      runtime.getDefaultLaunchSupervisionBranchHelpers?.().findNativeSessionIdByTitle?.(
        repoRoot,
        title,
      ),
    exportSessionTranscript: (sessionId) => runtime.exportSession(sessionId),
    extractFinalBranchReport: (sessionExport) =>
      runtime.extractLastCompletedAssistantText(sessionExport),
    now: options.now ?? (() => new Date().toISOString()),
  }
}

export async function executeReconcileWorkstreamSupervision(
  args: ReconcileWorkstreamSupervisionArgs,
  context: { sessionID?: string },
  deps: ReconcileWorkstreamSupervisionDeps,
): Promise<string> {
  logWorkstreamToolEvent("workstream.reconcile", "execute:before", {
    sessionID: context.sessionID,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
  })
  const repoRoot = deps.getRepoRoot()
  const candidates = deps.loadCandidateBranches({
    repoRoot,
    streamId: args.streamId,
    branchSessionId: args.branchSessionId,
    rootSessionId: context.sessionID,
  })

  if (candidates.length === 0) {
    return "No nonterminal supervision branch sessions matched the requested recovery scope."
  }

  const reconciled: string[] = []
  const skipped: string[] = []

  for (const candidate of candidates) {
    const branch = candidate.branch
    const tmux = branch.tmuxSessionName
      ? await deps.inspectTmuxSession(branch.tmuxSessionName)
      : {
          exists: false,
          paneDead: false,
        }

    if (tmux.exists && !tmux.paneDead) {
      skipped.push(
        `- ${candidate.streamId}:${branch.branchSessionId} skipped; tmux session ${branch.tmuxSessionName} is still live.`,
      )
      continue
    }

    const evidence = await recoverBranchEvidence({
      deps,
      repoRoot,
      streamId: candidate.streamId,
      branch,
      tmux,
    })

    const reconciledState =
      tmux.exists && typeof tmux.exitStatus === "number"
        ? reconcileCompletedBranchState({
            storedBranch: branch,
            runCode: tmux.exitStatus,
            reportText: evidence.reportText,
          })
        : buildRecoveryHandling({ reportText: evidence.reportText })

    const updatedAt = deps.now()
    const completedAt = branch.completedAt ?? updatedAt
    const nextNotes = joinBranchNotes(
      branch.notes,
      formatTmuxInspectionEvidence({ branch, tmux }),
      tmux.exists && typeof tmux.exitStatus === "number"
        ? formatSupervisionProcessExitEvidence(tmux.exitStatus)
        : undefined,
      reconciledState.handlingNote,
      evidence.transcriptError
        ? `Transcript export unavailable during recovery: ${evidence.transcriptError}`
        : undefined,
      evidence.reportText ? `Recovered final branch report:\n${evidence.reportText}` : undefined,
      tmux.paneOutput ? `Captured tmux pane output:\n${tmux.paneOutput}` : undefined,
    )

    await deps.persistBranchSession(
      repoRoot,
      candidate.streamId,
      await deps.buildBranchSession({
        context: {
          rootSessionId: branch.rootSessionId,
          branchSessionId: branch.branchSessionId,
          ...(branch.checkpointMessageId ? { checkpointMessageId: branch.checkpointMessageId } : {}),
          ...(typeof branch.checkpointMessageIndex === "number"
            ? { checkpointMessageIndex: branch.checkpointMessageIndex }
            : {}),
          ...(branch.checkpointCreatedAt
            ? { checkpointCreatedAt: branch.checkpointCreatedAt }
            : {}),
          ...(branch.breakpointSelection ? { breakpointSelection: branch.breakpointSelection } : {}),
          ...(branch.checkpointSessionId ? { checkpointSessionId: branch.checkpointSessionId } : {}),
          ...(branch.parentSessionId ? { parentSessionId: branch.parentSessionId } : {}),
          ...(evidence.nativeSessionId ?? branch.nativeSessionId
            ? { nativeSessionId: evidence.nativeSessionId ?? branch.nativeSessionId }
            : {}),
          ...(branch.source ? { source: branch.source } : {}),
          ...(branch.scope ? { scope: branch.scope } : {}),
        },
        branchRole: "supervision",
        status: reconciledState.status,
        startedAt: branch.startedAt,
        updatedAt,
        completedAt,
        processEndedAt: branch.processEndedAt ?? updatedAt,
        processExitCode: branch.processExitCode ?? tmux.exitStatus,
        finalizationSource: reconciledState.finalizationSource,
        finalizationReason: reconciledState.finalizationReason,
        tmuxSessionName: branch.tmuxSessionName,
        runId: branch.runId,
        batchId: branch.batchId,
        supervisionProgress: branch.supervisionProgress,
        notes: nextNotes,
      }),
    )

    reconciled.push(
      formatReconciledBranchResult({
        streamId: candidate.streamId,
        branch,
        status: reconciledState.status,
        evidence,
        finalizationReason: reconciledState.finalizationReason,
      }),
    )
  }

  if (reconciled.length === 0) {
    return [
      "No supervision sessions needed reconciliation.",
      ...(skipped.length > 0 ? ["", "Skipped:", ...skipped] : []),
    ].join("\n")
  }

  return [
    `Reconciled ${reconciled.length} supervision session${reconciled.length === 1 ? "" : "s"}.`,
    "",
    ...reconciled,
    ...(skipped.length > 0 ? ["", "Skipped:", ...skipped] : []),
  ].join("\n")
}
