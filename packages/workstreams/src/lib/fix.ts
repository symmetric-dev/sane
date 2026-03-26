/**
 * Fix stage generation logic
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "fs"
import { join } from "path"
import { getStreamPlanMdPath } from "./consolidate.ts"
import { getStageApprovalStatus } from "./approval.ts"
import { getWorkstreamGitHubPath } from "./github/workstream-github.ts"
import { loadIndex, saveIndex } from "./index.ts"
import { generateAllPrompts } from "./prompts.ts"
import { getWorkDir } from "./repo.ts"
import { parseStreamDocument } from "./stream-parser.ts"
import {
  formatTaskId,
  formatThreadId,
  parseTaskId,
  parseThreadId,
  readTasksFile,
  writeTasksFile,
} from "./tasks.ts"
import { loadThreads, saveThreads } from "./threads.ts"
import type { ConsolidateError } from "./types.ts"

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

function shiftTaskStages(repoRoot: string, streamId: string, afterStage: number): void {
  const tasksFile = readTasksFile(repoRoot, streamId)
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

function shiftThreadStages(
  repoRoot: string,
  streamId: string,
  afterStage: number,
  promptStageDirNames: Map<number, { oldDir: string; newDir: string }>,
): void {
  const threadsFile = loadThreads(repoRoot, streamId)
  if (!threadsFile) {
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

  saveThreads(repoRoot, streamId, threadsFile)
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

  shiftTaskStages(repoRoot, streamId, afterStage)
  renamePromptStageDirectories(repoRoot, streamId, promptStageDirNames)
  shiftThreadStages(repoRoot, streamId, afterStage, promptStageDirNames)
  shiftStageApprovals(repoRoot, streamId, afterStage)
  shiftGitHubStageMetadata(repoRoot, streamId, afterStage)

  const promptsDir = join(getWorkDir(repoRoot), streamId, "prompts")
  if (existsSync(promptsDir)) {
    generateAllPrompts(repoRoot, streamId)
  }
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

  if (getStageApprovalStatus(stream, previousStageNumber) !== "approved") {
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
