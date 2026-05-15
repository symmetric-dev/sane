/**
 * Approval gate logic for workstreams
 *
 * Implements the Human-In-The-Loop (HITL) approval workflow:
 * - Plans must be approved before tasks can be created
 * - Approval includes a hash of PLAN.md for modification detection
 * - If PLAN.md changes after approval, the approval is auto-revoked
 */

import { createHash } from "crypto"
import { existsSync } from "fs"
import { join } from "path"
import type { ApprovalStatus, StreamMetadata, WorkIndex, ConsolidateError } from "./types.ts"
import { loadIndex } from "./index.ts"
import { getWorkDir } from "./repo.ts"
import { parseStreamDocument } from "./stream-parser.ts"
import { updateStructuredApprovalsSync } from "./storage-adapter.ts"
import { loadWorkstreamApprovalQueryResult, loadWorkstreamHierarchyQueryResult } from "./hierarchy-query.ts"
import { loadWorkstreamPlan } from "./consolidate.ts"

function getIndexedStream(index: WorkIndex, streamIdOrName: string): StreamMetadata {
  const stream = index.streams.find((s) => s.id === streamIdOrName || s.name === streamIdOrName)
  if (!stream) {
    throw new Error(`Workstream "${streamIdOrName}" not found`)
  }

  return stream
}

/**
 * Get the path to PLAN.md for a workstream
 */
export function getPlanMdPath(repoRoot: string, streamId: string): string {
  const workDir = getWorkDir(repoRoot)
  return join(workDir, streamId, "PLAN.md")
}

export interface ResolvedPlanNames {
  streamName: string
  stageNames: Record<number, string>
  streamSource: "plan" | "fallback"
  stageSources: Record<number, "plan">
}

export type ApprovalCommitNamingSkipReason =
  | "unsafe_fallback_stream_name"
  | "unsafe_generic_stream_name"
  | "unsafe_fallback_stage_name"
  | "unsafe_generic_stage_name"

export interface ApprovalCommitNamingStatus {
  trustworthy: boolean
  reason?: ApprovalCommitNamingSkipReason
}

function isPlaceholderName(name: string): boolean {
  const trimmed = name.trim()

  return (
    trimmed.length === 0 ||
    trimmed.includes("<!--") ||
    /^(?:tbd|todo|placeholder|unnamed|untitled|name)$/i.test(trimmed)
  )
}

function isUnsafeStreamApprovalName(stream: StreamMetadata, streamName: string): boolean {
  const trimmed = streamName.trim()

  if (isPlaceholderName(trimmed)) {
    return true
  }

  return (
    trimmed.toLowerCase() === stream.id.toLowerCase() ||
    /^(?:stream|workstream|plan)(?:\s+name)?$/i.test(trimmed)
  )
}

function isUnsafeStageApprovalName(stageNumber: number, stageName: string): boolean {
  const trimmed = stageName.trim()

  if (isPlaceholderName(trimmed)) {
    return true
  }

  return new RegExp(`^stage\\s*0*${stageNumber}\\s*$`, "i").test(trimmed)
}

export function getPlanApprovalCommitNamingStatus(
  repoRoot: string,
  stream: StreamMetadata
): ApprovalCommitNamingStatus {
  const names = resolvePlanNames(repoRoot, stream)

  if (names.streamSource !== "plan") {
    return {
      trustworthy: false,
      reason: "unsafe_fallback_stream_name",
    }
  }

  if (isUnsafeStreamApprovalName(stream, names.streamName)) {
    return {
      trustworthy: false,
      reason: "unsafe_generic_stream_name",
    }
  }

  return { trustworthy: true }
}

export function getStageApprovalCommitNamingStatus(
  repoRoot: string,
  stream: StreamMetadata,
  stageNumber: number
): ApprovalCommitNamingStatus {
  const names = resolveStageApprovalNames(repoRoot, stream, stageNumber)

  if (names.streamSource !== "plan") {
    return {
      trustworthy: false,
      reason: "unsafe_fallback_stream_name",
    }
  }

  if (isUnsafeStreamApprovalName(stream, names.streamName)) {
    return {
      trustworthy: false,
      reason: "unsafe_generic_stream_name",
    }
  }

  if (names.stageSource !== "plan") {
    return {
      trustworthy: false,
      reason: "unsafe_fallback_stage_name",
    }
  }

  if (isUnsafeStageApprovalName(stageNumber, names.stageName)) {
    return {
      trustworthy: false,
      reason: "unsafe_generic_stage_name",
    }
  }

  return { trustworthy: true }
}

/**
 * Resolve workstream and stage names from PLAN.md when available.
 * Falls back to stream metadata and generic stage labels if PLAN.md
 * is missing or cannot be parsed.
 */
export function resolvePlanNames(
  repoRoot: string,
  stream: StreamMetadata
): ResolvedPlanNames {
  const fallback: ResolvedPlanNames = {
    streamName: stream.name,
    stageNames: {},
    streamSource: "fallback",
    stageSources: {},
  }

  const loadedPlan = loadWorkstreamPlan(repoRoot, stream.id)
  if (!loadedPlan) {
    return fallback
  }

  try {
    const errors: ConsolidateError[] = []
    const doc = parseStreamDocument(loadedPlan.content, errors)

    if (!doc) {
      return fallback
    }

    return {
      streamName: doc.streamName.trim() || stream.name,
      stageNames: Object.fromEntries(
        doc.stages
          .filter((stage) => stage.name.trim())
          .map((stage) => [stage.id, stage.name.trim()])
      ),
      streamSource: doc.streamName.trim() ? "plan" : "fallback",
      stageSources: Object.fromEntries(
        doc.stages
          .filter((stage) => stage.name.trim())
          .map((stage) => [stage.id, "plan"])
      ),
    }
  } catch {
    return fallback
  }
}

/**
 * Resolve a stage approval display name with safe fallbacks.
 */
export function resolveStageApprovalNames(
  repoRoot: string,
  stream: StreamMetadata,
  stageNumber: number
): {
  streamName: string
  stageName: string
  streamSource: "plan" | "fallback"
  stageSource: "plan" | "fallback"
} {
  const names = resolvePlanNames(repoRoot, stream)

  return {
    streamName: names.streamName,
    stageName: names.stageNames[stageNumber] ?? `Stage ${stageNumber}`,
    streamSource: names.streamSource,
    stageSource: names.stageSources[stageNumber] ?? "fallback",
  }
}

/**
 * Compute SHA-256 hash of PLAN.md content for modification detection
 */
export function computePlanHash(repoRoot: string, streamId: string): string | null {
  const loadedPlan = loadWorkstreamPlan(repoRoot, streamId)
  if (!loadedPlan) {
    return null
  }

  return createHash("sha256").update(loadedPlan.content).digest("hex")
}

/**
 * Get approval status (defaults to "draft" if not set)
 */
export function getApprovalStatus(stream: StreamMetadata): ApprovalStatus {
  return stream.approval?.status ?? "draft"
}

export function queryApprovalStatus(
  repoRoot: string,
  streamIdOrName: string,
  stream?: StreamMetadata,
): ApprovalStatus {
  return loadWorkstreamApprovalQueryResult(repoRoot, streamIdOrName).approval?.status ?? stream?.approval?.status ?? "draft"
}

/**
 * Check if workstream is approved
 */
export function isApproved(stream: StreamMetadata): boolean {
  return getApprovalStatus(stream) === "approved"
}

/**
 * Check if plan was modified since approval
 */
export function isPlanModified(repoRoot: string, stream: StreamMetadata): boolean {
  if (!stream.approval?.plan_hash) {
    return false // No hash to compare against
  }

  const currentHash = computePlanHash(repoRoot, stream.id)
  if (!currentHash) {
    return true // PLAN.md was deleted
  }

  return currentHash !== stream.approval.plan_hash
}

/**
 * Check if tasks can be created (plan must be approved)
 * Returns { allowed: boolean; reason?: string }
 */
export function canCreateTasks(stream: StreamMetadata): {
  allowed: boolean
  reason?: string
} {
  const status = getApprovalStatus(stream)

  switch (status) {
    case "approved":
      return { allowed: true }
    case "draft":
      return {
        allowed: false,
        reason: "Plan has not been approved. Run 'work approve' to approve it.",
      }
    case "revoked":
      return {
        allowed: false,
        reason: `Plan approval was revoked${stream.approval?.revoked_reason ? `: ${stream.approval.revoked_reason}` : ""}. Run 'work approve' to re-approve.`,
      }
    default:
      return {
        allowed: false,
        reason: `Unknown approval status: ${status}`,
      }
  }
}

/**
 * Approve a workstream
 * Stores the current PLAN.md hash to detect future modifications
 */
export function approveStream(
  repoRoot: string,
  streamIdOrName: string,
  approvedBy?: string
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const stream = getIndexedStream(index, streamIdOrName)
  const planHash = computePlanHash(repoRoot, stream.id)

  if (!planHash) {
    throw new Error(`PLAN.md not found for workstream "${stream.id}"`)
  }

  updateStructuredApprovalsSync({
    repoRoot,
    streamId: stream.id,
    touchStreamUpdatedAt: true,
    writeTasksFileIfMissing: false,
    update: (approval) => ({
      ...stream.approval,
      ...approval,
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      plan_hash: planHash,
    }),
  })

  return getIndexedStream(loadIndex(repoRoot), stream.id)
}

/**
 * Revoke approval for a workstream
 */
export function revokeApproval(
  repoRoot: string,
  streamIdOrName: string,
  reason?: string
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const stream = getIndexedStream(index, streamIdOrName)

  updateStructuredApprovalsSync({
    repoRoot,
    streamId: stream.id,
    touchStreamUpdatedAt: true,
    writeTasksFileIfMissing: false,
    update: (approval) => ({
      ...stream.approval,
      ...approval,
      status: "revoked",
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    }),
  })

  return getIndexedStream(loadIndex(repoRoot), stream.id)
}

/**
 * Check if plan was modified since approval and auto-revoke if so
 * Returns { revoked: boolean; stream: StreamMetadata }
 */
export function checkAndRevokeIfModified(
  repoRoot: string,
  stream: StreamMetadata
): { revoked: boolean; stream: StreamMetadata } {
  if (!isApproved(stream)) {
    return { revoked: false, stream }
  }

  if (!isPlanModified(repoRoot, stream)) {
    return { revoked: false, stream }
  }

  // Auto-revoke due to modification
  const updatedStream = revokeApproval(
    repoRoot,
    stream.id,
    "PLAN.md was modified after approval"
  )

  return { revoked: true, stream: updatedStream }
}

/**
 * Format approval status for display
 */
export function formatApprovalStatus(stream: StreamMetadata): string {
  const status = getApprovalStatus(stream)

  switch (status) {
    case "draft":
      return "[D] draft (not approved)"
    case "approved":
      return "[A] approved"
    case "revoked":
      const reason = stream.approval?.revoked_reason
      return `[R] revoked${reason ? ` (${reason})` : ""}`
    default:
      return `[?] ${status}`
  }
}

/**
 * Get approval status icon for compact display
 */
export function getApprovalIcon(stream: StreamMetadata): string {
  const status = getApprovalStatus(stream)

  switch (status) {
    case "draft":
      return "📝"
    case "approved":
      return "✅"
    case "revoked":
      return "⚠️"
    default:
      return "❓"
  }
}

/**
 * Result of checking for open questions
 */
export interface OpenQuestionsResult {
  hasOpenQuestions: boolean
  openCount: number
  resolvedCount: number
  questions: { stage: number; stageName: string; question: string }[]
}

/**
 * Check for open questions in PLAN.md
 * Returns details about unresolved questions that should block approval
 */
export function checkOpenQuestions(
  repoRoot: string,
  streamId: string
): OpenQuestionsResult {
  const loadedPlan = loadWorkstreamPlan(repoRoot, streamId)
  if (!loadedPlan) {
    return {
      hasOpenQuestions: false,
      openCount: 0,
      resolvedCount: 0,
      questions: [],
    }
  }

  const errors: ConsolidateError[] = []
  const doc = parseStreamDocument(loadedPlan.content, errors)

  if (!doc) {
    return {
      hasOpenQuestions: false,
      openCount: 0,
      resolvedCount: 0,
      questions: [],
    }
  }

  const openQuestions: { stage: number; stageName: string; question: string }[] = []
  let openCount = 0
  let resolvedCount = 0

  for (const stage of doc.stages) {
    for (const q of stage.questions) {
      if (q.resolved) {
        resolvedCount++
      } else if (q.question.trim()) {
        openCount++
        openQuestions.push({
          stage: stage.id,
          stageName: stage.name,
          question: q.question,
        })
      }
    }
  }

  return {
    hasOpenQuestions: openCount > 0,
    openCount,
    resolvedCount,
    questions: openQuestions,
  }
}

/**
 * Get approval status for a specific stage
 */
export function getStageApprovalStatus(
  stream: StreamMetadata,
  stageNumber: number
): ApprovalStatus {
  if (!stream.approval?.stages) {
    return "draft"
  }
  return stream.approval.stages[stageNumber]?.status ?? "draft"
}

export function queryStageApprovalStatus(
  repoRoot: string,
  streamIdOrName: string,
  stageNumber: number,
  stream?: StreamMetadata,
): ApprovalStatus {
  const approval = loadWorkstreamApprovalQueryResult(repoRoot, streamIdOrName).approval
  if (approval?.stages) {
    return approval.stages[stageNumber]?.status ?? "draft"
  }

  return stream ? getStageApprovalStatus(stream, stageNumber) : "draft"
}

function stageExistsInHierarchy(repoRoot: string, streamId: string, stageNumber: number): boolean {
  const normalizedStageId = stageNumber.toString().padStart(2, "0")

  return loadWorkstreamHierarchyQueryResult(repoRoot, streamId).stages.some(
    (stage) => stage.id === normalizedStageId || stage.number === stageNumber,
  )
}

/**
 * Approve a specific stage
 */
export function approveStage(
  repoRoot: string,
  streamIdOrName: string,
  stageNumber: number,
  approvedBy?: string
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const stream = getIndexedStream(index, streamIdOrName)

  if (!stageExistsInHierarchy(repoRoot, stream.id, stageNumber)) {
    throw new Error(`Stage ${stageNumber} does not exist in the workstream hierarchy`)
  }

  if (queryStageApprovalStatus(repoRoot, stream.id, stageNumber, stream) === "approved") {
    return stream
  }

  updateStructuredApprovalsSync({
    repoRoot,
    streamId: stream.id,
    touchStreamUpdatedAt: true,
    writeTasksFileIfMissing: false,
    update: (approval) => {
      const nextApproval = approval ?? { status: "draft" }
      nextApproval.stages = { ...(nextApproval.stages ?? {}) }
      nextApproval.stages[stageNumber] = {
        status: "approved",
        approved_at: new Date().toISOString(),
        approved_by: approvedBy,
      }
      return nextApproval
    },
  })

  return getIndexedStream(loadIndex(repoRoot), stream.id)
}

/**
 * Revoke approval for a specific stage
 */
export function revokeStageApproval(
  repoRoot: string,
  streamIdOrName: string,
  stageNumber: number,
  reason?: string
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const stream = getIndexedStream(index, streamIdOrName)

  if (queryStageApprovalStatus(repoRoot, stream.id, stageNumber, stream) === "draft") {
    throw new Error(`Stage ${stageNumber} is not approved, nothing to revoke`)
  }

  updateStructuredApprovalsSync({
    repoRoot,
    streamId: stream.id,
    touchStreamUpdatedAt: true,
    writeTasksFileIfMissing: false,
    update: (approval) => {
      const nextApproval = approval ?? { status: "draft" }
      nextApproval.stages = { ...(nextApproval.stages ?? {}) }
      nextApproval.stages[stageNumber] = {
        ...nextApproval.stages[stageNumber],
        status: "revoked",
        revoked_at: new Date().toISOString(),
        revoked_reason: reason,
      }
      return nextApproval
    },
  })

  return getIndexedStream(loadIndex(repoRoot), stream.id)
}

/**
 * Store commit SHA in stage approval metadata
 * Called after createStageApprovalCommit succeeds
 */
export function storeStageCommitSha(
  repoRoot: string,
  streamIdOrName: string,
  stageNumber: number,
  commitSha: string
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const stream = getIndexedStream(index, streamIdOrName)

  if (queryStageApprovalStatus(repoRoot, stream.id, stageNumber, stream) === "draft") {
    throw new Error(`Stage ${stageNumber} is not approved`)
  }

  updateStructuredApprovalsSync({
    repoRoot,
    streamId: stream.id,
    touchStreamUpdatedAt: true,
    writeTasksFileIfMissing: false,
    update: (approval) => {
      const nextApproval = approval ?? { status: "draft" }
      nextApproval.stages = { ...(nextApproval.stages ?? {}) }
      nextApproval.stages[stageNumber] = {
        ...nextApproval.stages[stageNumber],
        status: nextApproval.stages[stageNumber]?.status ?? "approved",
        commit_sha: commitSha,
      }
      return nextApproval
    },
  })

  return getIndexedStream(loadIndex(repoRoot), stream.id)
}

// ============================================
// TASKS APPROVAL GATE
// ============================================

/**
 * Result of checking if tasks can be approved
 */
export interface TasksApprovalReadyResult {
  ready: boolean
  reason?: string
  taskCount: number
}

/**
 * Check if compatibility execution state can be approved
 */
export function checkTasksApprovalReady(
  repoRoot: string,
  streamId: string
): TasksApprovalReadyResult {
  const hierarchy = loadWorkstreamHierarchyQueryResult(repoRoot, streamId)

  if (hierarchy.threads.length === 0) {
    return {
      ready: false,
      reason:
        "Execution hierarchy has not been initialized yet. Run 'work approve plan' to seed compatibility tasks from PLAN.md.",
      taskCount: hierarchy.tasks.length,
    }
  }

  return {
    ready: true,
    taskCount: hierarchy.tasks.length,
  }
}

/**
 * Get tasks approval status
 */
export function getTasksApprovalStatus(stream: StreamMetadata): ApprovalStatus {
  return stream.approval?.tasks?.status ?? "draft"
}

export function queryTasksApprovalStatus(
  repoRoot: string,
  streamIdOrName: string,
  stream?: StreamMetadata,
): ApprovalStatus {
  const approval = loadWorkstreamApprovalQueryResult(repoRoot, streamIdOrName).approval
  if (approval?.tasks) {
    return approval.tasks.status
  }

  return stream ? getTasksApprovalStatus(stream) : "draft"
}

export function queryIsFullyApproved(
  repoRoot: string,
  streamIdOrName: string,
  stream?: StreamMetadata,
): boolean {
  return (
    queryApprovalStatus(repoRoot, streamIdOrName, stream) === "approved" &&
    queryTasksApprovalStatus(repoRoot, streamIdOrName, stream) === "approved"
  )
}

export function queryFullApprovalStatus(
  repoRoot: string,
  streamIdOrName: string,
  stream?: StreamMetadata,
): {
  plan: ApprovalStatus
  tasks: ApprovalStatus
  fullyApproved: boolean
} {
  const plan = queryApprovalStatus(repoRoot, streamIdOrName, stream)
  const tasks = queryTasksApprovalStatus(repoRoot, streamIdOrName, stream)

  return {
    plan,
    tasks,
    fullyApproved: plan === "approved" && tasks === "approved",
  }
}

/**
 * Approve tasks
 */
export function approveTasks(
  repoRoot: string,
  streamIdOrName: string
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const stream = getIndexedStream(index, streamIdOrName)

  // Check readiness
  const readyCheck = checkTasksApprovalReady(repoRoot, stream.id)
  if (!readyCheck.ready) {
    throw new Error(readyCheck.reason!)
  }

  updateStructuredApprovalsSync({
    repoRoot,
    streamId: stream.id,
    touchStreamUpdatedAt: true,
    writeTasksFileIfMissing: false,
    update: (approval) => {
      const nextApproval = approval ?? { status: "draft" }
      nextApproval.tasks = {
        status: "approved",
        approved_at: new Date().toISOString(),
        task_count: readyCheck.taskCount,
      }
      return nextApproval
    },
  })

  return getIndexedStream(loadIndex(repoRoot), stream.id)
}

/**
 * Revoke tasks approval
 */
export function revokeTasksApproval(
  repoRoot: string,
  streamIdOrName: string,
  reason?: string
): StreamMetadata {
  const index = loadIndex(repoRoot)
  const stream = getIndexedStream(index, streamIdOrName)

  updateStructuredApprovalsSync({
    repoRoot,
    streamId: stream.id,
    touchStreamUpdatedAt: true,
    writeTasksFileIfMissing: false,
    update: (approval) => {
      const nextApproval = approval ?? { status: "draft" }
      nextApproval.tasks = {
        status: "revoked",
        revoked_at: new Date().toISOString(),
        revoked_reason: reason,
      }
      return nextApproval
    },
  })

  return getIndexedStream(loadIndex(repoRoot), stream.id)
}


// ============================================
// FULL APPROVAL CHECK
// ============================================

export function isFullyApproved(stream: StreamMetadata): boolean {
  return (
    getApprovalStatus(stream) === "approved" &&
    getTasksApprovalStatus(stream) === "approved"
  )
}

/**
 * Get summary of all approval statuses
 */
export function getFullApprovalStatus(stream: StreamMetadata): {
  plan: ApprovalStatus
  tasks: ApprovalStatus
  fullyApproved: boolean
} {
  return {
    plan: getApprovalStatus(stream),
    tasks: getTasksApprovalStatus(stream),
    fullyApproved: isFullyApproved(stream),
  }
}
