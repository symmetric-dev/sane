/**
 * Prompt generation for workstream threads
 *
 * Generates execution prompts for agents with full thread context,
 * including tasks, stage definition, parallel threads, and test requirements.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs"
import { join, dirname } from "path"
import { getWorkDir } from "./repo.ts"
import {
  queryTasksForWorkstream,
  queryThreadByIdForWorkstream,
} from "./hierarchy-query.ts"
import { parseStreamDocument } from "./stream-parser.ts"
import { getTasks, parseTaskId } from "./tasks.ts"
import { getThreadMetadata, updateThreadMetadata } from "./threads.ts"
import type {
  Task,
  StageDefinition,
  BatchDefinition,
  ThreadDefinition,
  ConsolidateError,
} from "./types.ts"

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
  tasks: Task[]
  parallelThreads: ThreadDefinition[]
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
 * - Tasks from tasks.json filtered to this thread
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
  const workDir = getWorkDir(repoRoot)
  const planPath = join(workDir, streamId, "PLAN.md")

  if (!existsSync(planPath)) {
    throw new Error(`PLAN.md not found at ${planPath}`)
  }

  const planContent = readFileSync(planPath, "utf-8")
  const errors: ConsolidateError[] = []
  const doc = parseStreamDocument(planContent, errors)

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

  // Load tasks filtered to this thread, preferring canonical thread/query views
  const threadPrefix = `${threadId.stage.toString().padStart(2, "0")}.${threadId.batch.toString().padStart(2, "0")}.${threadId.thread.toString().padStart(2, "0")}.`
  let queriedTasks: Task[] = []
  try {
    queriedTasks = queryTasksForWorkstream(repoRoot, streamId).filter((t) =>
      t.id.startsWith(threadPrefix),
    )
  } catch {
    queriedTasks = []
  }
  const tasks = queriedTasks.length > 0 ? queriedTasks : getTasks(repoRoot, streamId).filter((t) => t.id.startsWith(threadPrefix))

  // Get agent assignment from canonical thread state first, then compatibility tasks.
  const assignedAgent = threadView?.assignedAgent ?? tasks.find((t) => t.assigned_agent)?.assigned_agent
  const agentName = assignedAgent

  return {
    threadId,
    threadIdString: threadIdStr,
    streamId,
    streamName: doc.streamName,
    thread,
    stage,
    batch,
    tasks,
    parallelThreads,
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
  options?: GeneratePromptOptions,
): string {
  const opts = {
    includeTests: true,
    includeParallel: true,
    ...options,
  }

  const lines: string[] = []

  // Greeting
  lines.push(`Hello Agent!`)
  lines.push("")

  // Context
  lines.push(
    `You are working on the "${context.batch.name}" batch at the "${context.stage.name}" stage of the "${context.streamName}" workstream.`,
  )
  lines.push("")

  lines.push("This is your thread:")
  lines.push("")
  // Thread title and id
  lines.push(`"${context.thread.name}" (${context.thread.id})`)
  lines.push("")

  // Thread summary
  lines.push("## Thread Summary")
  lines.push(context.thread.summary || "(No summary provided)")
  lines.push("")

  // Thread details
  lines.push("## Thread Details")
  lines.push(context.thread.details || "(No details provided)")
  lines.push("")

  // Tasks section
  lines.push("Your tasks are:")
  if (context.tasks.length > 0) {
    for (const task of context.tasks) {
      lines.push(`- [ ] ${task.id} ${task.name}`)
    }
  } else {
    lines.push("(No tasks found for this thread)")
  }
  lines.push("")

  // Format batch ID for command suggestion
  const batchId = `${context.stage.id.toString().padStart(2, "0")}.${context.batch.id.toString().padStart(2, "0")}`

  // Skill instruction
  lines.push(
    `When listing threads, use \`work list --batch "${batchId}"\`. Add \`--tasks\` to inspect compatibility tasks.`,
  )
  lines.push("")
  lines.push("Use the `implementing-workstreams` skill.")
  lines.push("")

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
    tasks: context.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      breadcrumb: t.breadcrumb,
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
  const workDir = getWorkDir(repoRoot)
  const planPath = join(workDir, streamId, "PLAN.md")

  if (!existsSync(planPath)) {
    result.success = false
    result.errors.push(`PLAN.md not found at ${planPath}`)
    return result
  }

  const planContent = readFileSync(planPath, "utf-8")
  const parseErrors: ConsolidateError[] = []
  const doc = parseStreamDocument(planContent, parseErrors)

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
