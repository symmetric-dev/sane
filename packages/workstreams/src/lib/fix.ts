/**
 * Fix stage generation logic
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { getStreamPlanMdPath } from "./consolidate.ts"
import { queryStageApprovalStatus } from "./approval.ts"
import { getWorkstreamGitHubPath } from "./github/workstream-github.ts"
import { atomicWriteFile, loadIndex, saveIndex } from "./index.ts"
import { generateAllPrompts } from "./prompts.ts"
import { getWorkDir } from "./repo.ts"
import {
  loadStructuredWorkspaceStateSync,
  loadStructuredWorkstreamStateSync,
  replaceStructuredWorkspaceStateSync,
  replaceStructuredWorkstreamStateSync,
} from "./storage-adapter.ts"
import { parseStreamDocument } from "./stream-parser.ts"
import { createEmptyStructuredStorageWorkstreamState } from "./structured-storage.ts"
import {
  formatTaskId,
  formatThreadId,
  getTasksFilePath,
  normalizeRuntimeState,
  parseTaskId,
  parseThreadId,
  readTasksFile,
  writeTasksFile,
} from "./tasks.ts"
import type { ConsolidateError, RootAgentLineage, TasksFile, ThreadsJson } from "./types.ts"
import type { StructuredStorageWorkstreamState } from "./structured-storage.ts"

export interface FixStageOptions {
  targetStage: number
  name: string
  description?: string
  afterStage?: number
}

export interface RevisionStageOptions {
  name: string
  description?: string
  afterStage?: number
}

function formatStageLabel(stageNumber: number): string {
  return `Stage ${stageNumber.toString().padStart(2, "0")}`
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()
}

function getPromptStageDirName(stageNumber: number, stageName: string): string {
  return `${stageNumber.toString().padStart(2, "0")}-${sanitizePathSegment(stageName)}`
}

function shiftStageIdentifier(stageId: string | undefined, afterStage: number): string | undefined {
  if (!stageId) {
    return stageId
  }

  const stageNumber = parseInt(stageId, 10)
  if (isNaN(stageNumber) || stageNumber <= afterStage) {
    return stageId
  }

  return (stageNumber + 1).toString().padStart(Math.max(stageId.length, 2), "0")
}

function shiftHierarchicalIdentifier(
  value: string | undefined,
  afterStage: number,
  minimumSegments: number,
): string | undefined {
  if (!value) {
    return value
  }

  const parts = value.split(".")
  if (parts.length < minimumSegments || !parts[0]) {
    return value
  }

  const shiftedStageId = shiftStageIdentifier(parts[0], afterStage)
  if (!shiftedStageId || shiftedStageId === parts[0]) {
    return value
  }

  parts[0] = shiftedStageId
  return parts.join(".")
}

function shiftPromptPath(
  promptPath: string | undefined,
  promptStageDirNames: Map<number, { oldDir: string; newDir: string }>,
  stageNumber: number,
): string | undefined {
  if (!promptPath) {
    return promptPath
  }

  const promptDirs = promptStageDirNames.get(stageNumber)
  if (!promptDirs) {
    return promptPath
  }

  const oldPrefix = `prompts/${promptDirs.oldDir}/`
  const newPrefix = `prompts/${promptDirs.newDir}/`
  if (!promptPath.startsWith(oldPrefix)) {
    return promptPath
  }

  return `${newPrefix}${promptPath.slice(oldPrefix.length)}`
}

function shiftSupervisionProgressIdentifiers<T extends {
  currentBatchId?: string
  lastReviewedBatchId?: string
}>(progress: T | undefined, afterStage: number): T | undefined {
  if (!progress) {
    return progress
  }

  return {
    ...progress,
    ...(progress.currentBatchId
      ? {
          currentBatchId: shiftHierarchicalIdentifier(progress.currentBatchId, afterStage, 2),
        }
      : {}),
    ...(progress.lastReviewedBatchId
      ? {
          lastReviewedBatchId: shiftHierarchicalIdentifier(progress.lastReviewedBatchId, afterStage, 2),
        }
      : {}),
  }
}

function shiftBranchScopeIdentifiers<T extends {
  level: "batch" | "stage"
  stageId: string
  batchId?: string
}>(scope: T | undefined, afterStage: number): T | undefined {
  if (!scope) {
    return scope
  }

  return {
    ...scope,
    stageId: shiftStageIdentifier(scope.stageId, afterStage) ?? scope.stageId,
    ...(scope.level === "batch" && scope.batchId
      ? { batchId: shiftHierarchicalIdentifier(scope.batchId, afterStage, 2) }
      : {}),
  }
}

function shiftStageHeadingNumbers(content: string, afterStage: number): string {
  return content
    .split("\n")
    .map((line) => {
      const match = line.match(/^(\s*###\s+Stage\s+)(\d+)(:\s*.*)$/)
      if (!match) {
        return line
      }

      const currentStage = parseInt(match[2]!, 10)
      if (isNaN(currentStage) || currentStage <= afterStage) {
        return line
      }

      const width = Math.max(match[2]!.length, 2)
      const nextStage = (currentStage + 1).toString().padStart(width, "0")
      return `${match[1]}${nextStage}${match[3]}`
    })
    .join("\n")
}

function findStageInsertIndex(lines: string[], afterStage: number): number {
  let targetStageLineIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(/^###\s+Stage\s+(\d+):/)
    if (!match || !match[1]) {
      continue
    }

    const stageNumber = parseInt(match[1], 10)
    if (stageNumber === afterStage) {
      targetStageLineIndex = i
      continue
    }

    if (targetStageLineIndex !== -1 && stageNumber > afterStage) {
      return i
    }
  }

  if (targetStageLineIndex === -1) {
    return -1
  }

  let insertIndex = lines.length
  for (let i = lines.length - 1; i >= targetStageLineIndex; i--) {
    if (lines[i]?.trim() !== "") {
      insertIndex = i + 1
      break
    }
  }

  return insertIndex
}

function renamePromptStageDirectories(
  repoRoot: string,
  streamId: string,
  promptStageDirNames: Map<number, { oldDir: string; newDir: string }>,
): void {
  const promptsDir = join(getWorkDir(repoRoot), streamId, "prompts")
  if (!existsSync(promptsDir)) {
    return
  }

  const stagesDescending = Array.from(promptStageDirNames.entries()).sort(
    (a, b) => b[0] - a[0],
  )

  for (const [, { oldDir, newDir }] of stagesDescending) {
    const oldPath = join(promptsDir, oldDir)
    const newPath = join(promptsDir, newDir)

    if (!existsSync(oldPath) || existsSync(newPath)) {
      continue
    }

    renameSync(oldPath, newPath)
  }
}

function shiftRootAgentLineage(
  lineage: RootAgentLineage | undefined,
  afterStage: number,
): RootAgentLineage | undefined {
  if (!lineage) {
    return lineage
  }

  return {
    ...lineage,
    ...(lineage.scope ? { scope: shiftBranchScopeIdentifiers(lineage.scope, afterStage) } : {}),
  }
}

function shiftStructuredWorkstreamStateIdentifiers(
  workstreamState: StructuredStorageWorkstreamState,
  afterStage: number,
  promptStageDirNames: Map<number, { oldDir: string; newDir: string }>,
): void {
  workstreamState.hierarchy.stages = workstreamState.hierarchy.stages
    .map((stage) => ({
      ...stage,
      id: shiftStageIdentifier(stage.id, afterStage) ?? stage.id,
      number: stage.number > afterStage ? stage.number + 1 : stage.number,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  workstreamState.hierarchy.batches = workstreamState.hierarchy.batches
    .map((batch) => ({
      ...batch,
      id: shiftHierarchicalIdentifier(batch.id, afterStage, 2) ?? batch.id,
      stageId: shiftStageIdentifier(batch.stageId, afterStage) ?? batch.stageId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  workstreamState.hierarchy.threads = workstreamState.hierarchy.threads
    .map((thread) => {
      const stageNumber = parseInt(thread.stageId, 10)
      return {
        ...thread,
        id: shiftHierarchicalIdentifier(thread.id, afterStage, 3) ?? thread.id,
        stageId: shiftStageIdentifier(thread.stageId, afterStage) ?? thread.stageId,
        batchId: shiftHierarchicalIdentifier(thread.batchId, afterStage, 2) ?? thread.batchId,
        ...(thread.promptPath && !isNaN(stageNumber)
          ? { promptPath: shiftPromptPath(thread.promptPath, promptStageDirNames, stageNumber) }
          : {}),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  workstreamState.hierarchy.tasks = workstreamState.hierarchy.tasks
    .map((task) => ({
      ...task,
      id: shiftHierarchicalIdentifier(task.id, afterStage, 4) ?? task.id,
      stageId: shiftStageIdentifier(task.stageId, afterStage) ?? task.stageId,
      batchId: shiftHierarchicalIdentifier(task.batchId, afterStage, 2) ?? task.batchId,
      threadId: shiftHierarchicalIdentifier(task.threadId, afterStage, 3) ?? task.threadId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  workstreamState.approvals = workstreamState.approvals
    .map((approval) => ({
      ...approval,
      ...(approval.stageId
        ? { stageId: shiftStageIdentifier(approval.stageId, afterStage) ?? approval.stageId }
        : {}),
    }))
    .sort((a, b) => {
      const scopeOrder = a.scope.localeCompare(b.scope)
      if (scopeOrder !== 0) return scopeOrder
      return (a.stageId ?? "").localeCompare(b.stageId ?? "", undefined, { numeric: true })
    })

  workstreamState.threadRuntime = workstreamState.threadRuntime
    .map((thread) => ({
      ...thread,
      threadId: shiftHierarchicalIdentifier(thread.threadId, afterStage, 3) ?? thread.threadId,
      sessions: thread.sessions.map((session) => ({
        ...session,
        ...(session.lineage ? { lineage: shiftRootAgentLineage(session.lineage, afterStage) } : {}),
      })),
    }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId, undefined, { numeric: true }))

  workstreamState.batchRuns = workstreamState.batchRuns
    .map((batchRun) => ({
      ...batchRun,
      batchId: shiftHierarchicalIdentifier(batchRun.batchId, afterStage, 2) ?? batchRun.batchId,
      threads: batchRun.threads.map((thread) => ({
        ...thread,
        threadId: shiftHierarchicalIdentifier(thread.threadId, afterStage, 3) ?? thread.threadId,
        firstTaskId:
          shiftHierarchicalIdentifier(thread.firstTaskId, afterStage, 4) ?? thread.firstTaskId,
      })),
    }))
    .sort((a, b) => a.batchId.localeCompare(b.batchId, undefined, { numeric: true }))

  const supervision = workstreamState.supervision
  workstreamState.supervision = {
    ...supervision,
    ...(supervision.current_branch_supervision
      ? {
          current_branch_supervision: {
            ...supervision.current_branch_supervision,
            ...(supervision.current_branch_supervision.scope
              ? {
                  scope: shiftBranchScopeIdentifiers(
                    supervision.current_branch_supervision.scope,
                    afterStage,
                  ),
                }
              : {}),
            ...(supervision.current_branch_supervision.supervisionProgress
              ? {
                  supervisionProgress: shiftSupervisionProgressIdentifiers(
                    supervision.current_branch_supervision.supervisionProgress,
                    afterStage,
                  ),
                }
              : {}),
          },
        }
      : {}),
    runs: supervision.runs.map((run) => ({
      ...run,
      stageId: shiftStageIdentifier(run.stageId, afterStage) ?? run.stageId,
      ...(run.currentBatchId
        ? { currentBatchId: shiftHierarchicalIdentifier(run.currentBatchId, afterStage, 2) }
        : {}),
      ...(run.lastReviewedBatchId
        ? { lastReviewedBatchId: shiftHierarchicalIdentifier(run.lastReviewedBatchId, afterStage, 2) }
        : {}),
    })),
    branch_sessions: supervision.branch_sessions.map((session) => ({
      ...session,
      ...(session.batchId
        ? { batchId: shiftHierarchicalIdentifier(session.batchId, afterStage, 2) }
        : {}),
      ...(session.threadId
        ? { threadId: shiftHierarchicalIdentifier(session.threadId, afterStage, 3) }
        : {}),
      ...(session.scope ? { scope: shiftBranchScopeIdentifiers(session.scope, afterStage) } : {}),
      ...(session.supervisionProgress
        ? {
            supervisionProgress: shiftSupervisionProgressIdentifiers(
              session.supervisionProgress,
              afterStage,
            ),
          }
        : {}),
    })),
    reviewed_batches: supervision.reviewed_batches.map((review) => ({
      ...review,
      stageId: shiftStageIdentifier(review.stageId, afterStage) ?? review.stageId,
      batchId: shiftHierarchicalIdentifier(review.batchId, afterStage, 2) ?? review.batchId,
      threadIds: review.threadIds.map((threadId) =>
        shiftHierarchicalIdentifier(threadId, afterStage, 3) ?? threadId,
      ),
    })),
    issue_summaries: supervision.issue_summaries.map((issue) => ({
      ...issue,
      stageId: shiftStageIdentifier(issue.stageId, afterStage) ?? issue.stageId,
      batchId: shiftHierarchicalIdentifier(issue.batchId, afterStage, 2) ?? issue.batchId,
      ...(issue.threadId
        ? { threadId: shiftHierarchicalIdentifier(issue.threadId, afterStage, 3) }
        : {}),
    })),
    fix_cycles: supervision.fix_cycles.map((cycle) => ({
      ...cycle,
      stageId: shiftStageIdentifier(cycle.stageId, afterStage) ?? cycle.stageId,
      batchId: shiftHierarchicalIdentifier(cycle.batchId, afterStage, 2) ?? cycle.batchId,
      threadId: shiftHierarchicalIdentifier(cycle.threadId, afterStage, 3) ?? cycle.threadId,
    })),
    escalations: supervision.escalations.map((escalation) => ({
      ...escalation,
      stageId: shiftStageIdentifier(escalation.stageId, afterStage) ?? escalation.stageId,
      ...(escalation.batchId
        ? { batchId: shiftHierarchicalIdentifier(escalation.batchId, afterStage, 2) }
        : {}),
      ...(escalation.threadId
        ? { threadId: shiftHierarchicalIdentifier(escalation.threadId, afterStage, 3) }
        : {}),
    })),
    stage_stops: supervision.stage_stops.map((stageStop) => ({
      ...stageStop,
      stageId: shiftStageIdentifier(stageStop.stageId, afterStage) ?? stageStop.stageId,
      ...(stageStop.batchId
        ? { batchId: shiftHierarchicalIdentifier(stageStop.batchId, afterStage, 2) }
        : {}),
    })),
  }
}

function shiftWorkspaceCurrentBatch(repoRoot: string, streamId: string, afterStage: number): void {
  const workspaceState = loadStructuredWorkspaceStateSync(repoRoot)
  const workstreamRecord = workspaceState.workstreams.find((record) => record.id === streamId)
  if (!workstreamRecord?.currentBatch) {
    return
  }

  const nextCurrentBatch = shiftHierarchicalIdentifier(workstreamRecord.currentBatch, afterStage, 2)
  if (!nextCurrentBatch || nextCurrentBatch === workstreamRecord.currentBatch) {
    return
  }

  workstreamRecord.currentBatch = nextCurrentBatch
  workstreamRecord.updatedAt = new Date().toISOString()
  replaceStructuredWorkspaceStateSync({ repoRoot, workspaceState })
}

function regenerateLegacyRuntimeCompatibilityFiles(args: {
  repoRoot: string
  streamId: string
  writeThreadsFile: boolean
  writeSupervisorStateFile: boolean
  writeBatchStatusFiles: boolean
}): void {
  const tasksFile = readRawTasksFile(args.repoRoot, args.streamId)
  if (!tasksFile?.runtime_state) {
    return
  }

  const streamDir = join(getWorkDir(args.repoRoot), args.streamId)
  const now = new Date().toISOString()

  if (args.writeThreadsFile) {
    const threadsProjection: ThreadsJson = {
      version: "1.0.0",
      stream_id: args.streamId,
      last_updated: now,
      threads: tasksFile.runtime_state.threads,
    }
    atomicWriteFile(join(streamDir, "threads.json"), JSON.stringify(threadsProjection, null, 2))
  }

  if (args.writeSupervisorStateFile) {
    atomicWriteFile(
      join(streamDir, "supervisor-state.json"),
      JSON.stringify(
        {
          ...tasksFile.runtime_state.supervision,
          stream_id: args.streamId,
          last_updated: now,
        },
        null,
        2,
      ),
    )
  }

  if (args.writeBatchStatusFiles) {
    const batchStatusDir = join(streamDir, "batch-status")
    mkdirSync(batchStatusDir, { recursive: true })

    for (const entry of readdirSync(batchStatusDir)) {
      if (entry.endsWith(".json")) {
        rmSync(join(batchStatusDir, entry), { force: true })
      }
    }

    for (const [batchId, batchStatus] of Object.entries(tasksFile.runtime_state.batches)) {
      atomicWriteFile(join(batchStatusDir, `${batchId}.json`), JSON.stringify(batchStatus, null, 2))
    }
  }
}

function readRawTasksFile(repoRoot: string, streamId: string): TasksFile | null {
  const tasksPath = getTasksFilePath(repoRoot, streamId)
  if (!existsSync(tasksPath)) {
    return null
  }

  const tasksFile = JSON.parse(readFileSync(tasksPath, "utf-8")) as {
    version?: string
    stream_id?: string
    last_updated?: string
    runtime_state?: unknown
    tasks?: unknown
  }

  return {
    version: tasksFile.version ?? "2.0.0",
    stream_id: tasksFile.stream_id ?? streamId,
    last_updated: tasksFile.last_updated ?? new Date().toISOString(),
    runtime_state: normalizeRuntimeState(streamId, tasksFile.runtime_state as never),
    tasks: Array.isArray(tasksFile.tasks) ? tasksFile.tasks : [],
  }
}

function shiftTaskStages(repoRoot: string, streamId: string, afterStage: number): void {
  const tasksFile = readRawTasksFile(repoRoot, streamId)
  if (!tasksFile) {
    return
  }

  tasksFile.tasks = tasksFile.tasks
    .map((task) => {
      const parsed = parseTaskId(task.id)
      if (parsed.stage <= afterStage) {
        return task
      }

      return {
        ...task,
        id: formatTaskId(parsed.stage + 1, parsed.batch, parsed.thread, parsed.task),
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))

  writeTasksFile(repoRoot, streamId, tasksFile)
}

function shiftRuntimeStateArtifacts(
  repoRoot: string,
  streamId: string,
  afterStage: number,
  promptStageDirNames: Map<number, { oldDir: string; newDir: string }>,
): void {
  const tasksFile = readRawTasksFile(repoRoot, streamId)
  if (!tasksFile?.runtime_state) {
    return
  }

  tasksFile.runtime_state.threads = tasksFile.runtime_state.threads
    .map((thread) => {
      const shiftedThreadId = shiftHierarchicalIdentifier(thread.threadId, afterStage, 3)
      const stageNumber = parseInt(thread.threadId.split(".")[0] ?? "", 10)

      return {
        ...thread,
        threadId: shiftedThreadId ?? thread.threadId,
        ...(thread.promptPath && !isNaN(stageNumber)
          ? { promptPath: shiftPromptPath(thread.promptPath, promptStageDirNames, stageNumber) }
          : {}),
      }
    })
    .sort((a, b) => a.threadId.localeCompare(b.threadId, undefined, { numeric: true }))

  const shiftedBatches = Object.entries(tasksFile.runtime_state.batches).map(([batchId, batch]) => {
    const shiftedBatchId = shiftHierarchicalIdentifier(batchId, afterStage, 2) ?? batchId
    return [
      shiftedBatchId,
      {
        ...batch,
        batchId: shiftHierarchicalIdentifier(batch.batchId, afterStage, 2) ?? batch.batchId,
        threads: batch.threads.map((thread) => ({
          ...thread,
          threadId: shiftHierarchicalIdentifier(thread.threadId, afterStage, 3) ?? thread.threadId,
          firstTaskId:
            shiftHierarchicalIdentifier(thread.firstTaskId, afterStage, 4) ?? thread.firstTaskId,
        })),
      },
    ] as const
  })

  shiftedBatches.sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
  tasksFile.runtime_state.batches = Object.fromEntries(shiftedBatches)

  const supervision = tasksFile.runtime_state.supervision
  tasksFile.runtime_state.supervision = {
    ...supervision,
    ...(supervision.current_branch_supervision
      ? {
          current_branch_supervision: {
            ...supervision.current_branch_supervision,
            ...(supervision.current_branch_supervision.scope
              ? {
                  scope: shiftBranchScopeIdentifiers(
                    supervision.current_branch_supervision.scope,
                    afterStage,
                  ),
                }
              : {}),
            ...(supervision.current_branch_supervision.supervisionProgress
              ? {
                  supervisionProgress: shiftSupervisionProgressIdentifiers(
                    supervision.current_branch_supervision.supervisionProgress,
                    afterStage,
                  ),
                }
              : {}),
          },
        }
      : {}),
    runs: supervision.runs.map((run) => ({
      ...run,
      stageId: shiftStageIdentifier(run.stageId, afterStage) ?? run.stageId,
      ...(run.currentBatchId
        ? { currentBatchId: shiftHierarchicalIdentifier(run.currentBatchId, afterStage, 2) }
        : {}),
      ...(run.lastReviewedBatchId
        ? { lastReviewedBatchId: shiftHierarchicalIdentifier(run.lastReviewedBatchId, afterStage, 2) }
        : {}),
    })),
    branch_sessions: supervision.branch_sessions.map((session) => ({
      ...session,
      ...(session.batchId
        ? { batchId: shiftHierarchicalIdentifier(session.batchId, afterStage, 2) }
        : {}),
      ...(session.threadId
        ? { threadId: shiftHierarchicalIdentifier(session.threadId, afterStage, 3) }
        : {}),
      ...(session.scope ? { scope: shiftBranchScopeIdentifiers(session.scope, afterStage) } : {}),
      ...(session.supervisionProgress
        ? {
            supervisionProgress: shiftSupervisionProgressIdentifiers(
              session.supervisionProgress,
              afterStage,
            ),
          }
        : {}),
    })),
    reviewed_batches: supervision.reviewed_batches.map((review) => ({
      ...review,
      stageId: shiftStageIdentifier(review.stageId, afterStage) ?? review.stageId,
      batchId: shiftHierarchicalIdentifier(review.batchId, afterStage, 2) ?? review.batchId,
      threadIds: review.threadIds.map((threadId) =>
        shiftHierarchicalIdentifier(threadId, afterStage, 3) ?? threadId,
      ),
    })),
    issue_summaries: supervision.issue_summaries.map((issue) => ({
      ...issue,
      stageId: shiftStageIdentifier(issue.stageId, afterStage) ?? issue.stageId,
      batchId: shiftHierarchicalIdentifier(issue.batchId, afterStage, 2) ?? issue.batchId,
      ...(issue.threadId
        ? { threadId: shiftHierarchicalIdentifier(issue.threadId, afterStage, 3) }
        : {}),
    })),
    fix_cycles: supervision.fix_cycles.map((cycle) => ({
      ...cycle,
      stageId: shiftStageIdentifier(cycle.stageId, afterStage) ?? cycle.stageId,
      batchId: shiftHierarchicalIdentifier(cycle.batchId, afterStage, 2) ?? cycle.batchId,
      threadId: shiftHierarchicalIdentifier(cycle.threadId, afterStage, 3) ?? cycle.threadId,
    })),
    escalations: supervision.escalations.map((escalation) => ({
      ...escalation,
      stageId: shiftStageIdentifier(escalation.stageId, afterStage) ?? escalation.stageId,
      ...(escalation.batchId
        ? { batchId: shiftHierarchicalIdentifier(escalation.batchId, afterStage, 2) }
        : {}),
      ...(escalation.threadId
        ? { threadId: shiftHierarchicalIdentifier(escalation.threadId, afterStage, 3) }
        : {}),
    })),
    stage_stops: supervision.stage_stops.map((stageStop) => ({
      ...stageStop,
      stageId: shiftStageIdentifier(stageStop.stageId, afterStage) ?? stageStop.stageId,
      ...(stageStop.batchId
        ? { batchId: shiftHierarchicalIdentifier(stageStop.batchId, afterStage, 2) }
        : {}),
    })),
  }

  delete tasksFile.runtime_summary
  writeTasksFile(repoRoot, streamId, tasksFile)
}

function shiftLegacySupervisorArtifacts(repoRoot: string, streamId: string, afterStage: number): void {
  const supervisorStatePath = join(getWorkDir(repoRoot), streamId, "supervisor-state.json")
  if (!existsSync(supervisorStatePath)) {
    return
  }

  const supervisorState = JSON.parse(readFileSync(supervisorStatePath, "utf-8")) as Record<string, unknown>
  const currentBranchSupervision =
    supervisorState.current_branch_supervision as
      | {
          scope?: { level: "batch" | "stage"; stageId: string; batchId?: string }
          supervisionProgress?: { currentBatchId?: string; lastReviewedBatchId?: string }
        }
      | undefined
  const runs = Array.isArray(supervisorState.runs) ? supervisorState.runs : []
  const branchSessions = Array.isArray(supervisorState.branch_sessions)
    ? supervisorState.branch_sessions
    : []
  const reviewedBatches = Array.isArray(supervisorState.reviewed_batches)
    ? supervisorState.reviewed_batches
    : []
  const issueSummaries = Array.isArray(supervisorState.issue_summaries)
    ? supervisorState.issue_summaries
    : []
  const fixCycles = Array.isArray(supervisorState.fix_cycles) ? supervisorState.fix_cycles : []
  const escalations = Array.isArray(supervisorState.escalations) ? supervisorState.escalations : []
  const stageStops = Array.isArray(supervisorState.stage_stops) ? supervisorState.stage_stops : []

  writeFileSync(
    supervisorStatePath,
    JSON.stringify(
      {
        ...supervisorState,
        ...(currentBranchSupervision
          ? {
              current_branch_supervision: {
                ...currentBranchSupervision,
                ...(currentBranchSupervision.scope
                  ? {
                      scope: shiftBranchScopeIdentifiers(currentBranchSupervision.scope, afterStage),
                    }
                  : {}),
                ...(currentBranchSupervision.supervisionProgress
                  ? {
                      supervisionProgress: shiftSupervisionProgressIdentifiers(
                        currentBranchSupervision.supervisionProgress,
                        afterStage,
                      ),
                    }
                  : {}),
              },
            }
          : {}),
        runs: runs.map((run) => ({
          ...run,
          ...(typeof run === "object" && run !== null && "stageId" in run
            ? { stageId: shiftStageIdentifier(String(run.stageId), afterStage) }
            : {}),
          ...(typeof run === "object" && run !== null && "currentBatchId" in run && run.currentBatchId
            ? { currentBatchId: shiftHierarchicalIdentifier(String(run.currentBatchId), afterStage, 2) }
            : {}),
          ...(typeof run === "object" && run !== null && "lastReviewedBatchId" in run && run.lastReviewedBatchId
            ? {
                lastReviewedBatchId: shiftHierarchicalIdentifier(
                  String(run.lastReviewedBatchId),
                  afterStage,
                  2,
                ),
              }
            : {}),
        })),
        branch_sessions: branchSessions.map((session) => ({
          ...session,
          ...(typeof session === "object" && session !== null && "batchId" in session && session.batchId
            ? { batchId: shiftHierarchicalIdentifier(String(session.batchId), afterStage, 2) }
            : {}),
          ...(typeof session === "object" && session !== null && "threadId" in session && session.threadId
            ? { threadId: shiftHierarchicalIdentifier(String(session.threadId), afterStage, 3) }
            : {}),
          ...(typeof session === "object" && session !== null && "scope" in session && session.scope
            ? {
                scope: shiftBranchScopeIdentifiers(
                  session.scope as { level: "batch" | "stage"; stageId: string; batchId?: string },
                  afterStage,
                ),
              }
            : {}),
          ...(typeof session === "object" && session !== null && "supervisionProgress" in session && session.supervisionProgress
            ? {
                supervisionProgress: shiftSupervisionProgressIdentifiers(
                  session.supervisionProgress as {
                    currentBatchId?: string
                    lastReviewedBatchId?: string
                  },
                  afterStage,
                ),
              }
            : {}),
        })),
        reviewed_batches: reviewedBatches.map((review) => ({
          ...review,
          ...(typeof review === "object" && review !== null && "stageId" in review
            ? { stageId: shiftStageIdentifier(String(review.stageId), afterStage) }
            : {}),
          ...(typeof review === "object" && review !== null && "batchId" in review
            ? { batchId: shiftHierarchicalIdentifier(String(review.batchId), afterStage, 2) }
            : {}),
          ...(typeof review === "object" && review !== null && "threadIds" in review && Array.isArray(review.threadIds)
            ? {
                threadIds: review.threadIds.map((threadId: unknown) =>
                  shiftHierarchicalIdentifier(String(threadId), afterStage, 3),
                ),
              }
            : {}),
        })),
        issue_summaries: issueSummaries.map((issue) => ({
          ...issue,
          ...(typeof issue === "object" && issue !== null && "stageId" in issue
            ? { stageId: shiftStageIdentifier(String(issue.stageId), afterStage) }
            : {}),
          ...(typeof issue === "object" && issue !== null && "batchId" in issue
            ? { batchId: shiftHierarchicalIdentifier(String(issue.batchId), afterStage, 2) }
            : {}),
          ...(typeof issue === "object" && issue !== null && "threadId" in issue && issue.threadId
            ? { threadId: shiftHierarchicalIdentifier(String(issue.threadId), afterStage, 3) }
            : {}),
        })),
        fix_cycles: fixCycles.map((cycle) => ({
          ...cycle,
          ...(typeof cycle === "object" && cycle !== null && "stageId" in cycle
            ? { stageId: shiftStageIdentifier(String(cycle.stageId), afterStage) }
            : {}),
          ...(typeof cycle === "object" && cycle !== null && "batchId" in cycle
            ? { batchId: shiftHierarchicalIdentifier(String(cycle.batchId), afterStage, 2) }
            : {}),
          ...(typeof cycle === "object" && cycle !== null && "threadId" in cycle
            ? { threadId: shiftHierarchicalIdentifier(String(cycle.threadId), afterStage, 3) }
            : {}),
        })),
        escalations: escalations.map((escalation) => ({
          ...escalation,
          ...(typeof escalation === "object" && escalation !== null && "stageId" in escalation
            ? { stageId: shiftStageIdentifier(String(escalation.stageId), afterStage) }
            : {}),
          ...(typeof escalation === "object" && escalation !== null && "batchId" in escalation && escalation.batchId
            ? { batchId: shiftHierarchicalIdentifier(String(escalation.batchId), afterStage, 2) }
            : {}),
          ...(typeof escalation === "object" && escalation !== null && "threadId" in escalation && escalation.threadId
            ? { threadId: shiftHierarchicalIdentifier(String(escalation.threadId), afterStage, 3) }
            : {}),
        })),
        stage_stops: stageStops.map((stageStop) => ({
          ...stageStop,
          ...(typeof stageStop === "object" && stageStop !== null && "stageId" in stageStop
            ? { stageId: shiftStageIdentifier(String(stageStop.stageId), afterStage) }
            : {}),
          ...(typeof stageStop === "object" && stageStop !== null && "batchId" in stageStop && stageStop.batchId
            ? { batchId: shiftHierarchicalIdentifier(String(stageStop.batchId), afterStage, 2) }
            : {}),
        })),
      },
      null,
      2,
    ),
  )
}

function shiftLegacyBatchStatusArtifacts(repoRoot: string, streamId: string, afterStage: number): void {
  const batchStatusDir = join(getWorkDir(repoRoot), streamId, "batch-status")
  if (!existsSync(batchStatusDir)) {
    return
  }

  for (const entry of readdirSync(batchStatusDir)) {
    if (!entry.endsWith(".json")) {
      continue
    }

    const filePath = join(batchStatusDir, entry)
    const batchStatus = JSON.parse(readFileSync(filePath, "utf-8")) as {
      batchId?: string
      threads?: Array<{ threadId: string; firstTaskId: string }>
    }

    writeFileSync(
      filePath,
      JSON.stringify(
        {
          ...batchStatus,
          ...(batchStatus.batchId
            ? { batchId: shiftHierarchicalIdentifier(batchStatus.batchId, afterStage, 2) }
            : {}),
          threads: Array.isArray(batchStatus.threads)
            ? batchStatus.threads.map((thread) => ({
                ...thread,
                threadId: shiftHierarchicalIdentifier(thread.threadId, afterStage, 3) ?? thread.threadId,
                firstTaskId:
                  shiftHierarchicalIdentifier(thread.firstTaskId, afterStage, 4) ?? thread.firstTaskId,
              }))
            : [],
        },
        null,
        2,
      ),
    )
  }
}

function shiftLegacyThreadArtifacts(
  repoRoot: string,
  streamId: string,
  afterStage: number,
  promptStageDirNames: Map<number, { oldDir: string; newDir: string }>,
): void {
  const threadsPath = join(getWorkDir(repoRoot), streamId, "threads.json")
  if (!existsSync(threadsPath)) {
    return
  }

  const threadsFile = JSON.parse(readFileSync(threadsPath, "utf-8")) as {
    version?: string
    stream_id?: string
    last_updated?: string
    threads?: Array<{ threadId: string; promptPath?: string } & Record<string, unknown>>
  }

  if (!Array.isArray(threadsFile.threads)) {
    return
  }

  threadsFile.threads = threadsFile.threads
    .map((thread) => {
      const parsed = parseThreadId(thread.threadId)
      if (parsed.stage <= afterStage) {
        return thread
      }

      const shiftedThreadId = formatThreadId(parsed.stage + 1, parsed.batch, parsed.thread)
      const promptDirs = promptStageDirNames.get(parsed.stage)
      let promptPath = thread.promptPath

      if (promptPath && promptDirs) {
        const oldPrefix = `prompts/${promptDirs.oldDir}/`
        const newPrefix = `prompts/${promptDirs.newDir}/`
        if (promptPath.startsWith(oldPrefix)) {
          promptPath = `${newPrefix}${promptPath.slice(oldPrefix.length)}`
        }
      }

      return {
        ...thread,
        threadId: shiftedThreadId,
        ...(promptPath !== undefined ? { promptPath } : {}),
      }
    })
    .sort((a, b) => a.threadId.localeCompare(b.threadId, undefined, { numeric: true }))

  writeFileSync(
    threadsPath,
    JSON.stringify(
      {
        ...threadsFile,
        last_updated: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
}

function shiftStageApprovals(repoRoot: string, streamId: string, afterStage: number): void {
  let index
  try {
    index = loadIndex(repoRoot)
  } catch {
    return
  }

  const stream = index.streams.find((item) => item.id === streamId)
  if (!stream?.approval?.stages) {
    return
  }

  const shiftedStages: NonNullable<typeof stream.approval.stages> = {}
  const stageEntries = Object.entries(stream.approval.stages)
    .map(([stageNumber, approval]) => [parseInt(stageNumber, 10), approval] as const)
    .filter(([stageNumber]) => !isNaN(stageNumber))
    .sort((a, b) => a[0] - b[0])

  for (const [stageNumber, approval] of stageEntries) {
    const nextStage = stageNumber > afterStage ? stageNumber + 1 : stageNumber
    shiftedStages[nextStage] = approval
  }

  stream.approval.stages = shiftedStages
  stream.updated_at = new Date().toISOString()
  saveIndex(repoRoot, index)
}

function shiftGitHubStageMetadata(repoRoot: string, streamId: string, afterStage: number): void {
  const githubPath = getWorkstreamGitHubPath(repoRoot, streamId)
  if (!existsSync(githubPath)) {
    return
  }

  const githubData = JSON.parse(readFileSync(githubPath, "utf-8")) as {
    version: string
    stream_id: string
    last_updated: string
    branch?: unknown
    stages: Record<string, unknown>
  }

  const shiftedStages: Record<string, unknown> = {}
  const stageEntries = Object.entries(githubData.stages)
    .map(([stageNumber, stageIssue]) => [parseInt(stageNumber, 10), stageIssue] as const)
    .filter(([stageNumber]) => !isNaN(stageNumber))
    .sort((a, b) => a[0] - b[0])

  for (const [stageNumber, stageIssue] of stageEntries) {
    const nextStage = stageNumber > afterStage ? stageNumber + 1 : stageNumber
    shiftedStages[nextStage.toString().padStart(2, "0")] = stageIssue
  }

  githubData.stages = shiftedStages
  githubData.last_updated = new Date().toISOString()
  writeFileSync(githubPath, JSON.stringify(githubData, null, 2))
}

function shiftStageArtifacts(
  repoRoot: string,
  streamId: string,
  doc: NonNullable<ReturnType<typeof parseStreamDocument>>,
  afterStage: number,
): void {
  const streamDir = join(getWorkDir(repoRoot), streamId)
  const hadLegacyThreadsFile = existsSync(join(streamDir, "threads.json"))
  const hadLegacySupervisorStateFile = existsSync(join(streamDir, "supervisor-state.json"))
  const hadLegacyBatchStatusDir = existsSync(join(streamDir, "batch-status"))

  const promptStageDirNames = new Map<number, { oldDir: string; newDir: string }>()
  for (const stage of doc.stages) {
    if (stage.id <= afterStage) {
      continue
    }

    promptStageDirNames.set(stage.id, {
      oldDir: getPromptStageDirName(stage.id, stage.name),
      newDir: getPromptStageDirName(stage.id + 1, stage.name),
    })
  }

  renamePromptStageDirectories(repoRoot, streamId, promptStageDirNames)

  const tasksFileExists = existsSync(getTasksFilePath(repoRoot, streamId))
  const workstreamState =
    loadStructuredWorkstreamStateSync(repoRoot, streamId) ??
    createEmptyStructuredStorageWorkstreamState(streamId)
  shiftStructuredWorkstreamStateIdentifiers(workstreamState, afterStage, promptStageDirNames)
  replaceStructuredWorkstreamStateSync({
    repoRoot,
    workstreamState,
    touchStreamUpdatedAt: true,
    writeTasksFileIfMissing:
      tasksFileExists ||
      hadLegacyThreadsFile ||
      hadLegacySupervisorStateFile ||
      hadLegacyBatchStatusDir ||
      workstreamState.hierarchy.tasks.length > 0 ||
      workstreamState.threadRuntime.length > 0 ||
      workstreamState.batchRuns.length > 0,
  })

  shiftWorkspaceCurrentBatch(repoRoot, streamId, afterStage)
  shiftGitHubStageMetadata(repoRoot, streamId, afterStage)

  regenerateLegacyRuntimeCompatibilityFiles({
    repoRoot,
    streamId,
    writeThreadsFile: hadLegacyThreadsFile,
    writeSupervisorStateFile: hadLegacySupervisorStateFile,
    writeBatchStatusFiles: hadLegacyBatchStatusDir,
  })
}

function ensureStageApprovedForRevisionInsertion(
  repoRoot: string,
  streamId: string,
  previousStageNumber: number | undefined,
): { success: boolean; message?: string } {
  if (previousStageNumber === undefined) {
    return { success: true }
  }

  let index
  try {
    index = loadIndex(repoRoot)
  } catch (error) {
    return {
      success: false,
      message: `Cannot verify approval for ${formatStageLabel(previousStageNumber)}: ${(error as Error).message}`,
    }
  }

  const stream = index.streams.find((item) => item.id === streamId)
  if (!stream) {
    return {
      success: false,
      message: `Workstream "${streamId}" not found`,
    }
  }

  if (queryStageApprovalStatus(repoRoot, stream.id, previousStageNumber, stream) !== "approved") {
    return {
      success: false,
      message: `${formatStageLabel(previousStageNumber)} must be approved before adding a revision after it`,
    }
  }

  return { success: true }
}

function insertStageTemplate(
  content: string,
  afterStage: number | undefined,
  template: string,
): { success: boolean; content: string; message?: string } {
  if (afterStage === undefined) {
    return {
      success: true,
      content: content.trimEnd() + template,
    }
  }

  const shiftedContent = shiftStageHeadingNumbers(content, afterStage)
  const lines = shiftedContent.split("\n")
  const insertIndex = findStageInsertIndex(lines, afterStage)

  if (insertIndex === -1) {
    return {
      success: false,
      content,
      message: `${formatStageLabel(afterStage)} not found`,
    }
  }

  lines.splice(insertIndex, 0, template)
  return {
    success: true,
    content: lines.join("\n"),
  }
}

export function appendFixBatch(
  repoRoot: string,
  streamId: string,
  options: FixStageOptions,
): { success: boolean; newBatchNumber: number; message: string } {
  const planPath = getStreamPlanMdPath(repoRoot, streamId)
  const content = readFileSync(planPath, "utf-8")
  const errors: ConsolidateError[] = []

  const doc = parseStreamDocument(content, errors)
  if (!doc) {
    return {
      success: false,
      newBatchNumber: 0,
      message: "Failed to parse PLAN.md",
    }
  }

  const stage = doc.stages.find((s) => s.id === options.targetStage)
  if (!stage) {
    return {
      success: false,
      newBatchNumber: 0,
      message: `Stage ${options.targetStage} not found`,
    }
  }

  const lastBatch = stage.batches[stage.batches.length - 1]
  const newBatchNumber = (lastBatch ? lastBatch.id : -1) + 1
  const newBatchPrefix = newBatchNumber.toString().padStart(2, "0")
  const stageIdPadded = options.targetStage.toString().padStart(2, "0")

  const template = `
##### Batch ${newBatchPrefix}: Fix - ${options.name}
###### Thread 01: Fix Implementation
**Summary:**
Addressing issues in Stage ${stageIdPadded}.
${options.description || "Fixes and improvements."}

**Details:**
- [ ] Analyze root cause
- [ ] Implement fix
- [ ] Verify fix
`

  // Find insertion point
  // We want to insert after the current stage's content, which is before the next stage starts
  // or at the end of the file if this is the last stage.

  const lines = content.split("\n")
  let targetStageLineIndex = -1
  let nextStageLineIndex = -1

  // Regex to match "### Stage N: Name"
  const stageRegex = /^### Stage\s+(\d+):/

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(stageRegex)
    if (match && match[1]) {
      const stageNum = parseInt(match[1], 10)
      if (stageNum === options.targetStage) {
        targetStageLineIndex = i
      } else if (
        targetStageLineIndex !== -1 &&
        stageNum > options.targetStage
      ) {
        // Found a stage after our target
        nextStageLineIndex = i
        break
      }
    }
  }

  if (targetStageLineIndex === -1) {
    return {
      success: false,
      newBatchNumber: 0,
      message: `Could not locate Stage ${options.targetStage} header in file`,
    }
  }

  if (nextStageLineIndex !== -1) {
    // Insert before the next stage
    lines.splice(nextStageLineIndex, 0, template)
    writeFileSync(planPath, lines.join("\n"))
  } else {
    // No next stage - insert at end of target stage content
    // Find the last non-empty line to insert after
    let insertIndex = lines.length
    for (let i = lines.length - 1; i >= targetStageLineIndex; i--) {
      if (lines[i]?.trim() !== "") {
        insertIndex = i + 1
        break
      }
    }
    lines.splice(insertIndex, 0, template)
    writeFileSync(planPath, lines.join("\n"))
  }

  return {
    success: true,
    newBatchNumber,
    message: `Appended Batch ${newBatchPrefix} to Stage ${options.targetStage}`,
  }
}

export function appendFixStage(
  repoRoot: string,
  streamId: string,
  options: FixStageOptions,
): { success: boolean; newStageNumber: number; message: string } {
  const planPath = getStreamPlanMdPath(repoRoot, streamId)
  const content = readFileSync(planPath, "utf-8")
  const errors: ConsolidateError[] = []

  const doc = parseStreamDocument(content, errors)
  if (!doc) {
    return {
      success: false,
      newStageNumber: 0,
      message: "Failed to parse PLAN.md",
    }
  }

  if (
    options.afterStage !== undefined &&
    !doc.stages.some((stage) => stage.id === options.afterStage)
  ) {
    return {
      success: false,
      newStageNumber: 0,
      message: `${formatStageLabel(options.afterStage)} not found`,
    }
  }

  const lastStage = doc.stages[doc.stages.length - 1]
  const previousStageNumber = options.afterStage ?? lastStage?.id
  const newStageNumber = options.afterStage !== undefined
    ? options.afterStage + 1
    : (lastStage ? lastStage.id : 0) + 1
  const newStagePadded = newStageNumber.toString().padStart(2, "0")
  const targetStagePadded = options.targetStage.toString().padStart(2, "0")

  const template = `

### Stage ${newStagePadded}: Fix - ${options.name}

#### Definition
Addressing issues found in Stage ${targetStagePadded}.
${options.description || "Fixes and improvements based on evaluation."}

#### Batches
##### Batch 01: Fixes
###### Thread 01: Implementation
**Summary:**
Apply fixes.

**Details:**
- [ ] Analyze root cause
- [ ] Implement fix
- [ ] Verify fix
`

  const insertionResult = insertStageTemplate(content, options.afterStage, template)
  if (!insertionResult.success) {
    return {
      success: false,
      newStageNumber: 0,
      message: insertionResult.message || "Failed to insert stage",
    }
  }

  writeFileSync(planPath, insertionResult.content)

  if (options.afterStage !== undefined) {
    shiftStageArtifacts(repoRoot, streamId, doc, options.afterStage)
  }

  return {
    success: true,
    newStageNumber,
    message: options.afterStage !== undefined
      ? `Inserted ${formatStageLabel(newStageNumber)} after ${formatStageLabel(options.afterStage)} in PLAN.md`
      : `Appended ${formatStageLabel(newStageNumber)} to PLAN.md`,
  }
}

export function appendRevisionStage(
  repoRoot: string,
  streamId: string,
  options: RevisionStageOptions,
): { success: boolean; newStageNumber: number; message: string } {
  const planPath = getStreamPlanMdPath(repoRoot, streamId)
  const content = readFileSync(planPath, "utf-8")
  const errors: ConsolidateError[] = []

  const doc = parseStreamDocument(content, errors)
  if (!doc) {
    return {
      success: false,
      newStageNumber: 0,
      message: "Failed to parse PLAN.md",
    }
  }

  if (
    options.afterStage !== undefined &&
    !doc.stages.some((stage) => stage.id === options.afterStage)
  ) {
    return {
      success: false,
      newStageNumber: 0,
      message: `${formatStageLabel(options.afterStage)} not found`,
    }
  }

  const lastStage = doc.stages[doc.stages.length - 1]
  const previousStageNumber = options.afterStage ?? lastStage?.id
  const approvalCheck = ensureStageApprovedForRevisionInsertion(
    repoRoot,
    streamId,
    previousStageNumber,
  )
  if (!approvalCheck.success) {
    return {
      success: false,
      newStageNumber: 0,
      message: approvalCheck.message || "Failed to validate stage approval",
    }
  }

  const newStageNumber = options.afterStage !== undefined
    ? options.afterStage + 1
    : (lastStage ? lastStage.id : 0) + 1
  const newStagePadded = newStageNumber.toString().padStart(2, "0")

  const template = `

### Stage ${newStagePadded}: Revision - ${options.name}

#### Definition
${options.description || "Additional revision stage for further improvements and refinements."}

#### Constitution
This revision stage adds new functionality or improvements to the workstream.

#### Questions
- What are the key changes being introduced?
- How does this revision integrate with existing stages?

#### Batches
##### Batch 01: ${options.name}
###### Thread 01: Implementation
**Summary:**
Implement ${options.name}.

**Details:**
- [ ] Analyze requirements
- [ ] Implement changes
- [ ] Verify implementation
`

  const insertionResult = insertStageTemplate(content, options.afterStage, template)
  if (!insertionResult.success) {
    return {
      success: false,
      newStageNumber: 0,
      message: insertionResult.message || "Failed to insert stage",
    }
  }

  writeFileSync(planPath, insertionResult.content)

  if (options.afterStage !== undefined) {
    shiftStageArtifacts(repoRoot, streamId, doc, options.afterStage)
  }

  return {
    success: true,
    newStageNumber,
    message: options.afterStage !== undefined
      ? `Inserted ${formatStageLabel(newStageNumber)} after ${formatStageLabel(options.afterStage)} in PLAN.md`
      : `Appended ${formatStageLabel(newStageNumber)} to PLAN.md`,
  }
}
