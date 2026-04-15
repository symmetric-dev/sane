/**
 * Shared builders for automated workstream commit messages.
 *
 * These builders keep automated commit subjects and machine-parseable
 * trailers consistent across start/approval/complete flows.
 */

export interface AutoCommitMessage {
  title: string
  body: string
}

export interface WorkstreamCommitContext {
  streamId: string
  streamName: string
}

export interface StageCommitContext extends WorkstreamCommitContext {
  stageNumber: number
  stageName: string
}

export interface CompletionCommitContext extends WorkstreamCommitContext {
  summary?: string
}

export interface TasksApprovalCommitContext extends WorkstreamCommitContext {
  taskCount: number
}

type TrailerValue = string | number | null | undefined

function formatTrailers(entries: Array<[string, TrailerValue]>): string[] {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && `${value}`.trim().length > 0)
    .map(([key, value]) => `${key}: ${value}`)
}

function buildAutoCommitMessage(
  title: string,
  paragraphs: Array<string | undefined>,
  trailers: Array<[string, TrailerValue]>
): AutoCommitMessage {
  const bodyParts = paragraphs
    .map((paragraph) => paragraph?.trim())
    .filter((paragraph): paragraph is string => !!paragraph)

  const trailerLines = formatTrailers(trailers)
  if (trailerLines.length > 0) {
    if (bodyParts.length > 0) {
      bodyParts.push("")
    }
    bodyParts.push(...trailerLines)
  }

  return {
    title,
    body: bodyParts.join("\n"),
  }
}

export function buildWorkstreamStartCommitMessage({
  streamId,
  streamName,
}: WorkstreamCommitContext): AutoCommitMessage {
  return buildAutoCommitMessage(
    "workstream start",
    [`Started workstream ${streamId}.`],
    [
      ["Stream-Id", streamId],
      ["Stream-Name", streamName],
    ]
  )
}

export function buildPlanApprovalCommitMessage({
  streamId,
  streamName,
}: WorkstreamCommitContext): AutoCommitMessage {
  return buildAutoCommitMessage(
    `Plan approved: ${streamName}`,
    [`Approved plan for workstream ${streamId}.`],
    [
      ["Stream-Id", streamId],
      ["Stream-Name", streamName],
    ]
  )
}

export function buildTasksApprovalCommitMessage({
  streamId,
  streamName,
  taskCount,
}: TasksApprovalCommitContext): AutoCommitMessage {
  return buildAutoCommitMessage(
    `Tasks approved: ${streamName}`,
    [`Approved ${taskCount} tasks for workstream ${streamId}.`],
    [
      ["Stream-Id", streamId],
      ["Stream-Name", streamName],
      ["Task-Count", taskCount],
    ]
  )
}

export function buildStageApprovalCommitMessage({
  streamId,
  streamName,
  stageNumber,
  stageName,
}: StageCommitContext): AutoCommitMessage {
  return buildAutoCommitMessage(
    `Stage ${stageNumber} approved: ${stageName}`,
    [`Approved stage ${stageNumber} of workstream ${streamId}.`],
    [
      ["Stream-Id", streamId],
      ["Stream-Name", streamName],
      ["Stage", stageNumber],
      ["Stage-Name", stageName],
    ]
  )
}

export function buildWorkstreamCompletionCommitMessage({
  streamId,
  streamName,
  summary,
}: CompletionCommitContext): AutoCommitMessage {
  return buildAutoCommitMessage(
    `Completed workstream: ${streamName}`,
    [`Completed workstream ${streamId}.`, summary],
    [
      ["Stream-Id", streamId],
      ["Stream-Name", streamName],
    ]
  )
}
