/**
 * Prompt path resolution utilities
 *
 * Consolidated logic for resolving prompt file paths from thread IDs.
 * Used by multi.ts and related commands that need to locate prompts.
 */

import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { getWorkDir } from "./repo.ts"
import { parseStreamDocument } from "./stream-parser.ts"
import { getThreadMetadata } from "./threads.ts"

/**
 * Options for resolving prompt path when metadata is available
 */
export interface PromptPathMetadata {
  stageNum: number
  stageName: string
  batchNum: number
  batchName: string
  threadName: string
}

/**
 * Sanitize a name for use in file paths
 * Replaces non-alphanumeric characters with dashes and lowercases
 */
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase()
}

/**
 * Build prompt file path from metadata (stage/batch/thread names)
 *
 * This is the more efficient path when metadata is already available,
 * such as when discovering threads from structured workstream state.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param metadata - Stage, batch, and thread metadata
 * @returns Full path to the prompt file
 */
export function resolvePromptPathFromMetadata(
  repoRoot: string,
  streamId: string,
  metadata: PromptPathMetadata,
): string {
  const workDir = getWorkDir(repoRoot)

  const safeStageName = sanitizeName(metadata.stageName)
  const safeBatchName = sanitizeName(metadata.batchName)
  const safeThreadName = sanitizeName(metadata.threadName)

  const stagePrefix = metadata.stageNum.toString().padStart(2, "0")
  const batchPrefix = metadata.batchNum.toString().padStart(2, "0")

  return join(
    workDir,
    streamId,
    "prompts",
    `${stagePrefix}-${safeStageName}`,
    `${batchPrefix}-${safeBatchName}`,
    `${safeThreadName}.md`,
  )
}

/**
 * Resolve prompt file path for a thread
 *
 * First checks persisted thread runtime metadata for a stored path,
 * then falls back to parsing PLAN.md to reconstruct the path.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param threadId - Thread ID in format "SS.BB.TT" (e.g., "01.02.03")
 * @returns Full path to the prompt file, or null if thread not found
 */
export function resolvePromptPath(
  repoRoot: string,
  streamId: string,
  threadId: string,
): string | null {
  const workDir = getWorkDir(repoRoot)
  
  // First, try canonical runtime_state.threads metadata
  const threadMeta = getThreadMetadata(repoRoot, streamId, threadId)
  if (threadMeta?.promptPath) {
    return join(workDir, threadMeta.promptPath)
  }
  
  // Fallback: reconstruct from PLAN.md (legacy behavior)
  const planPath = join(workDir, streamId, "PLAN.md")

  if (!existsSync(planPath)) {
    return null
  }

  const planContent = readFileSync(planPath, "utf-8")
  const errors: { message: string }[] = []
  const doc = parseStreamDocument(planContent, errors)

  if (!doc) {
    return null
  }

  // Parse thread ID: "01.02.03" -> stage 1, batch 2, thread 3
  const parts = threadId.split(".").map((p) => parseInt(p, 10))
  if (parts.length !== 3 || parts.some(isNaN)) {
    return null
  }
  const [stageNum, batchNum, threadNum] = parts

  const stage = doc.stages.find((s) => s.id === stageNum)
  if (!stage) return null

  const batch = stage.batches.find((b) => b.id === batchNum)
  if (!batch) return null

  const thread = batch.threads.find((t) => t.id === threadNum)
  if (!thread) return null

  // Use the metadata-based resolver with discovered names
  return resolvePromptPathFromMetadata(repoRoot, streamId, {
    stageNum: stageNum!,
    stageName: stage.name,
    batchNum: batchNum!,
    batchName: batch.name,
    threadName: thread.name,
  })
}
