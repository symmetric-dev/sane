/**
 * Prompt generation for workstream threads
 *
 * Generates execution prompts for agents with full thread context,
 * including thread, stage, and batch context for execution.
 */

import { mkdirSync, writeFileSync } from "fs"
import { join, dirname } from "path"
import { getWorkDir } from "./repo.ts"
import {
  queryExecutionItemsForWorkstream,
  queryThreadByIdForWorkstream,
} from "./hierarchy-query.ts"
import { parseStreamDocument } from "./stream-parser.ts"
import { getThreadMetadata, updateThreadMetadata } from "./threads.ts"
import {
  loadWorkstreamPlan,
  formatMissingWorkstreamPlanMessage,
} from "./consolidate.ts"
import { getThreadWorkMdPath, getThreadWorkMdRelativePath, resolveStageDirectoryName } from "./thread-workdocs.ts"
import { existsSync } from "fs"
import type {
  StageDefinition,
  BatchDefinition,
  ThreadDefinition,
  ConsolidateError,
} from "./types.ts"
import type { ExecutionItemQueryRecord } from "./hierarchy-query.ts"

// ============================================
// TYPES
// ============================================

/**
 * Thread identifier - parsed from "stage.batch.thread" format
 * Example: "01.01.02" = Stage 1, Batch 01, Thread 2
 */
export interface ThreadId {
  stage: number
  batch: number
  thread: number
}

/**
 * Context gathered for generating a thread execution prompt
 */
export interface PromptContext {
  threadId: ThreadId
  threadIdString: string
  streamId: string
  streamName: string
  thread: ThreadDefinition
  stage: StageDefinition
  batch: BatchDefinition
  executionItems: ExecutionItemQueryRecord[]
  parallelThreads: ThreadDefinition[]
  references: {
    primaryWorkPath: string
    readmePath: string
    stageRequirementsPath: string
    threadWorkPath: string
  }
  agentName?: string
}

/**
 * Options for generating a prompt
 */
export interface GeneratePromptOptions {
  includeTests?: boolean
  includeParallel?: boolean
}

/**
 * Result of generating all prompts for a workstream
 */
export interface GeneratePromptsResult {
  success: boolean
  generatedFiles: string[] // Relative paths of generated prompt files
  errors: string[] // Error messages for failed generations
  totalThreads: number // Total number of threads found
}

// ============================================
// THREAD ID PARSING
// ============================================

/**
 * Parse thread ID from string format
 * Supports "stage.batch.thread" (e.g., "01.01.02")
 */
export function parseThreadId(threadIdStr: string): ThreadId | null {
  const parts = threadIdStr.split(".")

  if (parts.length !== 3) {
    return null
  }

  const parsed = parts.map((p) => parseInt(p, 10))
  if (parsed.some(isNaN)) {
    return null
  }

  return {
    stage: parsed[0]!,
    batch: parsed[1]!,
    thread: parsed[2]!,
  }
}

/**
 * Format thread ID components to string
 * All components are zero-padded to 2 digits
 */
export function formatThreadId(
  stage: number,
  batch: number,
  thread: number,
): string {
  const stageStr = stage.toString().padStart(2, "0")
  const batchStr = batch.toString().padStart(2, "0")
  const threadStr = thread.toString().padStart(2, "0")
  return `${stageStr}.${batchStr}.${threadStr}`
}

// ============================================
// CONTEXT GATHERING
// ============================================

/**
 * Get the full context needed to generate a thread prompt
 *
 * Gathers:
 * - Thread definition from PLAN.md
 * - Stage and batch context
 * - Thread execution items synthesized from canonical thread runtime state
 * - Parallel threads in the same batch
 * - Agent assignment (if any)
 *
 * Throws if thread not found or PLAN.md parsing fails
 */
export function getPromptContext(
  repoRoot: string,
  streamId: string,
  threadIdStr: string,
): PromptContext {
  // Parse thread ID
  const threadId = parseThreadId(threadIdStr)
  if (!threadId) {
    throw new Error(
      `Invalid thread ID format: "${threadIdStr}". Expected "stage.batch.thread" (e.g., "01.01.02")`,
    )
  }

  // Load PLAN.md
  const loadedPlan = loadWorkstreamPlan(repoRoot, streamId)
  if (!loadedPlan) {
    throw new Error(formatMissingWorkstreamPlanMessage(repoRoot, streamId))
  }

  const errors: ConsolidateError[] = []
  const doc = parseStreamDocument(loadedPlan.content, errors)

  if (!doc) {
    throw new Error(
      `Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`,
    )
  }

  // Find stage
  const stage = doc.stages.find((s) => s.id === threadId.stage)
  if (!stage) {
    const availableStages = doc.stages.map((s) => s.id).join(", ")
    throw new Error(
      `Stage ${threadId.stage} not found. Available stages: ${availableStages || "none"}`,
    )
  }

  // Find batch
  const batch = stage.batches.find((b) => b.id === threadId.batch)
  if (!batch) {
    const availableBatches = stage.batches
      .map((b) => `${b.prefix} (${b.name})`)
      .join(", ")
    throw new Error(
      `Batch ${threadId.batch} not found in stage ${threadId.stage}. Available batches: ${availableBatches || "none"}`,
    )
  }

  // Find thread
  const thread = batch.threads.find((t) => t.id === threadId.thread)
  if (!thread) {
    const availableThreads = batch.threads
      .map((t) => `${t.id} (${t.name})`)
      .join(", ")
    throw new Error(
      `Thread ${threadId.thread} not found in batch ${batch.prefix}. Available threads: ${availableThreads || "none"}`,
    )
  }

  let threadView: ReturnType<typeof queryThreadByIdForWorkstream> = null
  try {
    threadView = queryThreadByIdForWorkstream(repoRoot, streamId, threadIdStr)
  } catch {
    threadView = null
  }

  // Get parallel threads (other threads in the same batch)
  const parallelThreads = batch.threads.filter((t) => t.id !== threadId.thread)

  // Load canonical execution items filtered to this thread
  const threadPrefix = `${threadId.stage.toString().padStart(2, "0")}.${threadId.batch.toString().padStart(2, "0")}.${threadId.thread.toString().padStart(2, "0")}.`
  const executionItems = queryExecutionItemsForWorkstream(repoRoot, streamId)
    .filter((item) => item.id.startsWith(threadPrefix))

  const assignedAgent = threadView?.assignedAgent ?? executionItems.find((item) => item.assignedAgent)?.assignedAgent
  const agentName = assignedAgent
  const stageDirectoryName = resolveStageDirectoryName(repoRoot, streamId, stage.id)
  const workstreamRoot = join("work", streamId)
  const stageRoot = join(workstreamRoot, "stages", stageDirectoryName)
  const threadWorkPath = getThreadWorkMdPath(repoRoot, streamId, threadIdStr)
  const threadWorkPathRelative = join("work", getThreadWorkMdRelativePath(repoRoot, streamId, threadIdStr))

  if (!existsSync(threadWorkPath)) {
    throw new Error(
      `Thread WORK.md not found for ${threadIdStr} at ${threadWorkPathRelative}. Run 'work approve plan', 'work approve revision', or 'work validate work' to create or verify thread WORK.md files before execution.`,
    )
  }

  return {
    threadId,
    threadIdString: threadIdStr,
    streamId,
    streamName: doc.streamName,
    thread,
    stage,
    batch,
    executionItems,
    parallelThreads,
    references: {
      primaryWorkPath: threadWorkPathRelative,
      readmePath: join(workstreamRoot, "README.md"),
      stageRequirementsPath: join(stageRoot, "REQUIREMENTS.md"),
      threadWorkPath: threadWorkPathRelative,
    },
    agentName,
  }
}

// ============================================
// PROMPT GENERATION
// ============================================

/**
 * Generate the thread execution prompt as markdown
 */
export function generateThreadPrompt(
  context: PromptContext,
  _options?: GeneratePromptOptions,
): string {
  const lines: string[] = []

  lines.push(
    `You are an agent working on thread ${context.threadIdString} (${context.thread.name}) in stage ${context.stage.name} in workstream ${context.streamId} (${context.streamName}).`,
  )
  lines.push("")
  lines.push("Use the `implementing-workstream-threads` skill.")
  lines.push("")
  lines.push(`Read this document first: \`${context.references.primaryWorkPath}\`.`)
  lines.push(`Then read stage requirements at \`${context.references.stageRequirementsPath}\` for the required constraints and acceptance criteria.`)
  lines.push(`If you need overall workstream context, read \`${context.references.readmePath}\`.`)
  lines.push("")
  lines.push("Thread objective:")
  lines.push(context.thread.summary || "(No summary provided)")
  lines.push("")

  if (context.thread.details.trim().length > 0) {
    lines.push("Additional thread details:")
    lines.push(context.thread.details)
    lines.push("")
  }

  lines.push(
    `Keep execution state current with \`work update --stream "${context.streamId}" --thread "${context.threadIdString}" --status <status>\`.`,
  )
  lines.push(
    `For thread-scoped \`work\` commands, keep \`--stream "${context.streamId}"\` explicit (for example \`work read --stream "${context.streamId}" --thread "${context.threadIdString}"\` and \`work list --stream "${context.streamId}" --thread "${context.threadIdString}"\`).`,
  )
  lines.push(
    `When the thread is completed or blocked, include a short \`--report\` explaining the outcome.`,
  )

  return lines.join("\n")
}

/**
 * Generate the thread execution prompt as JSON (for programmatic use)
 */
export function generateThreadPromptJson(context: PromptContext): object {
  return {
    threadId: context.threadIdString,
    agentName: context.agentName,
    stream: {
      id: context.streamId,
      name: context.streamName,
    },
    location: {
      stage: {
        id: context.stage.id,
        name: context.stage.name,
      },
      batch: {
        id: context.batch.id,
        prefix: context.batch.prefix,
        name: context.batch.name,
      },
      thread: {
        id: context.thread.id,
        name: context.thread.name,
      },
    },
    thread: {
      summary: context.thread.summary,
      details: context.thread.details,
    },
    references: {
      primaryWorkPath: context.references.primaryWorkPath,
      readmePath: context.references.readmePath,
      stageRequirementsPath: context.references.stageRequirementsPath,
      threadWorkPath: context.references.threadWorkPath,
    },
    executionItems: context.executionItems.map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      breadcrumb: item.breadcrumb,
    })),
    stageContext: {
      definition: context.stage.definition,
      constitution: context.stage.constitution,
    },
    parallelThreads: context.parallelThreads.map((t) => ({
      id: t.id,
      name: t.name,
      summary: t.summary,
    })),
  }
}

// ============================================
// PROMPT FILE OPERATIONS
// ============================================

/**
 * Get the relative path for a prompt file
 * Format: {streamId}/prompts/{stage-prefix}-{stage-name}/{batch-prefix}-{batch-name}/{thread-name}.md
 */
export function getPromptRelativePath(context: PromptContext): string {
  const safeStageName = context.stage.name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase()
  const safeBatchName = context.batch.name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase()
  const safeThreadName = context.thread.name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .toLowerCase()

  const stagePrefix = context.stage.id.toString().padStart(2, "0")

  return join(
    context.streamId,
    "prompts",
    `${stagePrefix}-${safeStageName}`,
    `${context.batch.prefix}-${safeBatchName}`,
    `${safeThreadName}.md`,
  )
}

/**
 * Save a prompt to file and return the relative path
 * Returns null if saving failed
 */
export function savePromptToFile(
  repoRoot: string,
  context: PromptContext,
  content: string,
): string | null {
  const workDir = getWorkDir(repoRoot)
  let persistedPromptPath: string | undefined
  try {
    persistedPromptPath = queryThreadByIdForWorkstream(
      repoRoot,
      context.streamId,
      context.threadIdString,
    )?.promptPath
  } catch {
    persistedPromptPath = undefined
  }
  const relPath =
    persistedPromptPath ??
    getThreadMetadata(repoRoot, context.streamId, context.threadIdString)?.promptPath ??
    getPromptRelativePath(context)
  const fullPath = join(workDir, relPath)

  try {
    mkdirSync(dirname(fullPath), { recursive: true })
    writeFileSync(fullPath, content)
    return relPath
  } catch (e) {
    return null
  }
}

// ============================================
// BATCH PROMPT GENERATION
// ============================================

/**
 * Generate prompts for all threads in a workstream
 *
 * Iterates through all stages, batches, and threads from PLAN.md,
 * generates a prompt for each thread, and saves to disk.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @returns Result with success status, generated files, and any errors
 */
export function generateAllPrompts(
  repoRoot: string,
  streamId: string,
): GeneratePromptsResult {
  const result: GeneratePromptsResult = {
    success: true,
    generatedFiles: [],
    errors: [],
    totalThreads: 0,
  }

  // Load and parse PLAN.md
  const loadedPlan = loadWorkstreamPlan(repoRoot, streamId)
  if (!loadedPlan) {
    result.success = false
    result.errors.push(formatMissingWorkstreamPlanMessage(repoRoot, streamId))
    return result
  }

  const parseErrors: ConsolidateError[] = []
  const doc = parseStreamDocument(loadedPlan.content, parseErrors)

  if (!doc) {
    result.success = false
    result.errors.push(
      `Failed to parse PLAN.md: ${parseErrors.map((e) => e.message).join(", ")}`,
    )
    return result
  }

  // Iterate all stages, batches, and threads
  for (const stage of doc.stages) {
    for (const batch of stage.batches) {
      for (const thread of batch.threads) {
        result.totalThreads++

        const threadIdStr = formatThreadId(stage.id, batch.id, thread.id)

        try {
          const context = getPromptContext(repoRoot, streamId, threadIdStr)
          const prompt = generateThreadPrompt(context)
          const savedPath = savePromptToFile(repoRoot, context, prompt)

          if (savedPath) {
            result.generatedFiles.push(savedPath)
            // Store prompt path in runtime_state.threads for reliable lookup
            updateThreadMetadata(repoRoot, streamId, threadIdStr, {
              promptPath: savedPath,
            })
          } else {
            result.errors.push(
              `Failed to save prompt for thread ${threadIdStr}`,
            )
          }
        } catch (e) {
          result.errors.push(
            `Error generating prompt for thread ${threadIdStr}: ${(e as Error).message}`,
          )
        }
      }
    }
  }

  // Set success to false if any errors occurred
  if (result.errors.length > 0) {
    result.success = false
  }

  return result
}
