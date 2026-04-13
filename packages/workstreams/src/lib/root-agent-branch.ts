import { randomUUID } from "crypto"
import { loadSupervisorState } from "./supervisor-state.ts"
import type {
  RootAgentBranchRole,
  RootAgentBranchSession,
  RootAgentBranchSource,
  RootAgentBranchStatus,
  RootAgentLineage,
  SupervisorReviewOutcome,
} from "./types.ts"

export interface RootAgentBranchContext {
  rootSessionId: string
  branchSessionId: string
  checkpointSessionId?: string
  checkpointCreatedAt?: string
  parentSessionId?: string
  parentBranchSessionId?: string
  nativeSessionId?: string
  source?: RootAgentBranchSource
}

export function createRootAgentBranchSessionId(role: RootAgentBranchRole): string {
  return `branch-${role}-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export function getRootAgentBranchSource(
  nativeSessionId?: string,
  fallback: RootAgentBranchSource = "repo_local_fallback",
): RootAgentBranchSource {
  return nativeSessionId ? "native_fork" : fallback
}

export function findRootAgentBranchSessionByBranchSessionId(args: {
  repoRoot: string
  streamId: string
  branchSessionId: string
}): RootAgentBranchSession | undefined {
  return loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions.find(
    (branch) => branch.branchSessionId === args.branchSessionId,
  )
}

export function findRootAgentBranchSessionByNativeSessionId(args: {
  repoRoot: string
  streamId: string
  nativeSessionId: string
}): RootAgentBranchSession | undefined {
  return loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions.find(
    (branch) => branch.nativeSessionId === args.nativeSessionId,
  )
}

export function isTerminalRootAgentBranchStatus(
  status: RootAgentBranchStatus | undefined,
): status is Extract<RootAgentBranchStatus, "completed" | "stopped" | "failed"> {
  return status === "completed" || status === "stopped" || status === "failed"
}

export async function waitForRootAgentBranchNativeSessionId(args: {
  repoRoot: string
  streamId: string
  branchSessionId: string
  timeoutMs?: number
  pollIntervalMs?: number
}): Promise<string | undefined> {
  const timeoutMs = Math.max(0, args.timeoutMs ?? 3000)
  const pollIntervalMs = Math.max(1, args.pollIntervalMs ?? 100)
  const deadline = Date.now() + timeoutMs

  while (true) {
    const nativeSessionId = loadSupervisorState(args.repoRoot, args.streamId)?.branch_sessions.find(
      (branch) => branch.branchSessionId === args.branchSessionId,
    )?.nativeSessionId

    if (nativeSessionId) {
      return nativeSessionId
    }

    if (Date.now() >= deadline) {
      return undefined
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

export async function waitForRootAgentBranchTerminalSession(args: {
  repoRoot: string
  streamId: string
  branchSessionId: string
  timeoutMs?: number
  pollIntervalMs?: number
}): Promise<RootAgentBranchSession | undefined> {
  const timeoutMs = Math.max(0, args.timeoutMs ?? 3000)
  const pollIntervalMs = Math.max(1, args.pollIntervalMs ?? 100)
  const deadline = Date.now() + timeoutMs

  while (true) {
    const branch = findRootAgentBranchSessionByBranchSessionId(args)

    if (branch && isTerminalRootAgentBranchStatus(branch.status)) {
      return branch
    }

    if (Date.now() >= deadline) {
      return branch
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

export function buildRootAgentLineage(args: {
  context: RootAgentBranchContext
  branchRole: RootAgentBranchRole
  branchSessionId?: string
  source?: RootAgentBranchSource
}): RootAgentLineage {
  return {
    owner: "root_agent",
    rootSessionId: args.context.rootSessionId,
    branchSessionId: args.branchSessionId ?? args.context.branchSessionId,
    branchRole: args.branchRole,
    ...(args.context.checkpointSessionId
      ? { checkpointSessionId: args.context.checkpointSessionId }
      : {}),
    ...(args.context.checkpointCreatedAt
      ? { checkpointCreatedAt: args.context.checkpointCreatedAt }
      : {}),
    ...(args.context.parentBranchSessionId
      ? { parentBranchSessionId: args.context.parentBranchSessionId }
      : {}),
    ...(args.context.parentSessionId ? { parentSessionId: args.context.parentSessionId } : {}),
    ...(args.context.nativeSessionId ? { nativeSessionId: args.context.nativeSessionId } : {}),
    source: getRootAgentBranchSource(
      args.context.nativeSessionId,
      args.source ?? args.context.source ?? "repo_local_fallback",
    ),
  }
}

export function buildRootAgentBranchSession(args: {
  context: RootAgentBranchContext
  branchRole: RootAgentBranchRole
  status: RootAgentBranchStatus
  branchSessionId?: string
  source?: RootAgentBranchSource
  startedAt?: string
  updatedAt?: string
  completedAt?: string
  runId?: string
  batchId?: string
  threadId?: string
  reviewId?: string
  fixCycleId?: string
  notes?: string
}): RootAgentBranchSession {
  const updatedAt = args.updatedAt ?? new Date().toISOString()
  const lineage = buildRootAgentLineage({
    context: args.context,
    branchRole: args.branchRole,
    branchSessionId: args.branchSessionId,
    source: args.source,
  })

  return {
    ...lineage,
    status: args.status,
    startedAt: args.startedAt ?? updatedAt,
    updatedAt,
    ...(args.completedAt ? { completedAt: args.completedAt } : {}),
    ...(args.runId ? { runId: args.runId } : {}),
    ...(args.batchId ? { batchId: args.batchId } : {}),
    ...(args.threadId ? { threadId: args.threadId } : {}),
    ...(args.reviewId ? { reviewId: args.reviewId } : {}),
    ...(args.fixCycleId ? { fixCycleId: args.fixCycleId } : {}),
    ...(args.notes ? { notes: args.notes } : {}),
  }
}

export function getBranchStatusForReviewOutcome(
  outcome: SupervisorReviewOutcome,
): RootAgentBranchStatus {
  return outcome === "approved" ? "completed" : outcome === "changes_requested" ? "running" : "stopped"
}
