/**
 * Consolidation logic for PLAN.md validation
 *
 * This module handles parsing and validating PLAN.md structure.
 * Tasks are managed separately via the add-task command.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type {
  ConsolidateResult,
  ConsolidateError,
  StreamDocument,
} from "./types.ts"
import { parseStreamDocument } from "./stream-parser.ts"
import { getWorkDir } from "./repo.ts"
import { findSharedFilesInParallelThreads, formatSharedFileWarnings } from "./analysis.ts"

export const DRAFT_PLAN_NO_STAGES_WARNING =
  "Draft plan: no stages defined yet. Scaffold stages with 'work plan create'."

/**
 * Get the path to PLAN.md for a workstream
 */
export function getStreamPlanMdPath(repoRoot: string, streamId: string): string {
  const workDir = getWorkDir(repoRoot)
  return join(workDir, streamId, "PLAN.md")
}

/**
 * Validate that PLAN.md has required sections
 */
function validateStreamDocument(
  doc: StreamDocument,
  errors: ConsolidateError[],
  warnings: string[]
): void {
  // Check summary
  if (!doc.summary || doc.summary.trim().length === 0) {
    warnings.push("Summary section is empty")
  }

  // Check stages
  if (doc.stages.length === 0) {
    warnings.push(DRAFT_PLAN_NO_STAGES_WARNING)
    return
  }

  // Validate each stage
  for (const stage of doc.stages) {
    const stagePrefix = `Stage ${stage.id}`

    // Check stage name
    if (!stage.name || stage.name.trim().length === 0 || stage.name.includes("<!--")) {
      warnings.push(`${stagePrefix}: Stage name is empty or contains placeholder`)
    }

    // Check definition
    if (!stage.definition || stage.definition.trim().length === 0) {
      warnings.push(`${stagePrefix}: Stage Definition is empty`)
    }

    // Check batches/threads (optional - threads are documentation)
    const totalThreads = stage.batches.reduce((sum, b) => sum + b.threads.length, 0)
    if (totalThreads === 0) {
      warnings.push(`${stagePrefix}: No threads defined`)
    }

    // Validate each batch and thread
    for (const batch of stage.batches) {
      for (const thread of batch.threads) {
        const threadPrefix = `Stage ${stage.id}, Batch ${batch.prefix}, Thread ${thread.id}`

        // Check thread name
        if (!thread.name || thread.name.trim().length === 0 || thread.name.includes("<!--")) {
          warnings.push(`${threadPrefix}: Thread name is empty or contains placeholder`)
        }
      }
    }
  }
}

/**
 * Consolidate (validate) PLAN.md
 *
 * This validates the PLAN.md structure but does NOT generate tasks.
 * Tasks are managed separately via the add-task command.
 *
 * @param repoRoot - Repository root path
 * @param streamId - Workstream ID
 * @param dryRun - If true, just validate (same behavior, kept for API compatibility)
 * @returns Consolidation result with success status and any errors/warnings
 */
export function consolidateStream(
  repoRoot: string,
  streamId: string,
  _dryRun: boolean = false
): ConsolidateResult {
  const errors: ConsolidateError[] = []
  const warnings: string[] = []

  // Check if PLAN.md exists
  const planMdPath = getStreamPlanMdPath(repoRoot, streamId)
  if (!existsSync(planMdPath)) {
    errors.push({
      section: "File",
      message: `PLAN.md not found at ${planMdPath}`,
    })
    return {
      success: false,
      streamDocument: null,
      tasksGenerated: [],
      errors,
      warnings,
    }
  }

  // Read and parse PLAN.md
  const content = readFileSync(planMdPath, "utf-8")
  const streamDocument = parseStreamDocument(content, errors)

  if (!streamDocument) {
    return {
      success: false,
      streamDocument: null,
      tasksGenerated: [],
      errors,
      warnings,
    }
  }

  // Validate the document
  validateStreamDocument(streamDocument, errors, warnings)

  // Check for files shared across parallel threads
  const sharedFileWarnings = findSharedFilesInParallelThreads(streamDocument)
  warnings.push(...formatSharedFileWarnings(sharedFileWarnings))

  // Consolidation succeeds even with warnings (only errors fail)
  return {
    success: errors.length === 0,
    streamDocument,
    tasksGenerated: [], // Tasks are managed separately
    errors,
    warnings,
  }
}

/**
 * Format consolidation result for console output
 */
export function formatConsolidateResult(result: ConsolidateResult, _dryRun: boolean): string {
  const lines: string[] = []

  if (result.success) {
    lines.push("Validation passed")
    lines.push("")

    if (result.streamDocument) {
      lines.push(`Workstream: ${result.streamDocument.streamName}`)
      lines.push(`Stages: ${result.streamDocument.stages.length}`)

      if (result.streamDocument.stages.length === 0) {
        lines.push("Status: draft plan")
      }

      const batchCount = result.streamDocument.stages.reduce(
        (sum, s) => sum + s.batches.length,
        0
      )
      const threadCount = result.streamDocument.stages.reduce(
        (sum, s) => sum + s.batches.reduce((bSum, b) => bSum + b.threads.length, 0),
        0
      )
      lines.push(`Batches: ${batchCount}`)
      lines.push(`Threads: ${threadCount}`)
    }

    if (result.warnings.length > 0) {
      lines.push("")
      lines.push("Warnings:")
      for (const warning of result.warnings) {
        lines.push(`  - ${warning}`)
      }
    }

    lines.push("")
    lines.push("Use 'work add-task' to add tasks to this workstream.")
  } else {
    lines.push("Validation failed")
    lines.push("")

    if (result.errors.length > 0) {
      lines.push("Errors:")
      for (const error of result.errors) {
        const location = error.section ? `[${error.section}] ` : ""
        lines.push(`  - ${location}${error.message}`)
      }
    }

    if (result.warnings.length > 0) {
      lines.push("")
      lines.push("Warnings:")
      for (const warning of result.warnings) {
        lines.push(`  - ${warning}`)
      }
    }
  }

  return lines.join("\n")
}
