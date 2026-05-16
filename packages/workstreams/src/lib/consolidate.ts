/**
 * Consolidation logic for PLAN.md validation
 *
 * This module handles parsing and validating PLAN.md structure.
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
import { listOrderedStageDirectories } from "./stage-directories.ts"

export const DRAFT_PLAN_NO_STAGES_WARNING =
  "Draft plan: no stages defined yet. Scaffold stages with 'work plan create'."

export interface LoadedWorkstreamPlan {
  content: string
  displayPath: string
  source: "root" | "stages"
  stagePlanPaths: string[]
  skippedStagePlanPaths: string[]
  warnings: string[]
}

/**
 * Get the path to PLAN.md for a workstream
 */
export function getStreamPlanMdPath(repoRoot: string, streamId: string): string {
  const workDir = getWorkDir(repoRoot)
  return join(workDir, streamId, "PLAN.md")
}

export function formatMissingWorkstreamPlanMessage(repoRoot: string, streamId: string): string {
  const workDir = getWorkDir(repoRoot)
  return `No stage-local PLAN.md found under ${join(workDir, streamId, "stages", "*", "PLAN.md")} for workstream "${streamId}" (legacy root PLAN.md also checked at ${getStreamPlanMdPath(repoRoot, streamId)})`
}

export function getStagePlanMdPaths(repoRoot: string, streamId: string): string[] {
  const stagesDir = join(getWorkDir(repoRoot), streamId, "stages")
  return listOrderedStageDirectories(stagesDir)
    .map((entry) => join(stagesDir, entry.name, "PLAN.md"))
    .filter((planPath) => existsSync(planPath))
}

function extractMarkdownSection(content: string, sectionName: string): string {
  const lines = content.split("\n")
  const startIndex = lines.findIndex((line) => line.trim().toLowerCase() === `## ${sectionName}`.toLowerCase())
  if (startIndex === -1) {
    return ""
  }

  const sectionLines: string[] = []
  for (let index = startIndex + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (line.startsWith("## ")) {
      break
    }
    sectionLines.push(line)
  }

  return sectionLines.join("\n").trim()
}

function stripHtmlComments(content: string): string {
  return content.replace(/<!--([\s\S]*?)-->/g, "").trim()
}

function hasVisibleMeaningfulText(content: string): boolean {
  return content
    .split("\n")
    .map((line) => stripHtmlComments(line).replace(/^[-*]\s*/, "").trim())
    .some((line) => line.length > 0 && line !== "[ ]" && line !== "[x]")
}

function hasMeaningfulStageContent(content: string): boolean {
  const summary = hasVisibleMeaningfulText(extractMarkdownSection(content, "Summary"))
  const references = hasVisibleMeaningfulText(extractMarkdownSection(content, "References"))
  const questions = extractMarkdownSection(content, "Questions")
    .split("\n")
    .map((line) => line.replace(/^-\s*\[[ xX]\]\s*/, "").trim())
    .some((line) => hasVisibleMeaningfulText(line))
  const namedBatchOrThread = content
    .split("\n")
    .some((line) => /^(###|####)\s+/.test(line) && !line.includes("<!--"))

  return summary || references || questions || namedBatchOrThread
}

function extractReadmePlanContext(streamDir: string, streamId: string): {
  streamName: string
  summary: string
} {
  const readmePath = join(streamDir, "README.md")
  if (!existsSync(readmePath)) {
    return {
      streamName: streamId,
      summary: "",
    }
  }

  const content = readFileSync(readmePath, "utf-8")
  const headingMatch = content.match(/^#\s+(.+)$/m)

  return {
    streamName: headingMatch?.[1]?.trim() || streamId,
    summary: stripHtmlComments(extractMarkdownSection(content, "Summary")),
  }
}

function toSyntheticStageSection(planPath: string, syntheticStageNumber: number): string {
  const content = readFileSync(planPath, "utf-8")
  const stageDirName = planPath.split("/").slice(-2, -1)[0] ?? "00"
  const definition = stripHtmlComments(extractMarkdownSection(content, "Summary"))
  const questions = extractMarkdownSection(content, "Questions")
  const batches = extractMarkdownSection(content, "Batches")
    .replace(/^####\s+/gm, "###### ")
    .replace(/^###\s+/gm, "##### ")
    .trim()

  return [
    `### Stage ${syntheticStageNumber}: Stage ${stageDirName}`,
    "",
    "#### Stage Definition",
    definition,
    "",
    "#### Stage Constitution",
    "",
    "#### Stage Questions",
    questions,
    "",
    "#### Stage Batches",
    batches,
  ].join("\n")
}

export function loadWorkstreamPlan(repoRoot: string, streamId: string): LoadedWorkstreamPlan | null {
  const rootPlanPath = getStreamPlanMdPath(repoRoot, streamId)
  if (existsSync(rootPlanPath)) {
    return {
      content: readFileSync(rootPlanPath, "utf-8"),
      displayPath: rootPlanPath,
      source: "root",
      stagePlanPaths: [],
      skippedStagePlanPaths: [],
      warnings: [],
    }
  }

  const streamDir = join(getWorkDir(repoRoot), streamId)
  const stagePlanPaths = getStagePlanMdPaths(repoRoot, streamId)
  if (stagePlanPaths.length === 0) {
    return null
  }

  const includedStagePlanPaths: string[] = []
  const skippedStagePlanPaths: string[] = []
  const warnings: string[] = []
  const stageSections: string[] = []

  for (const planPath of stagePlanPaths) {
    const content = readFileSync(planPath, "utf-8")
    if (!hasMeaningfulStageContent(content)) {
      skippedStagePlanPaths.push(planPath)
      warnings.push(`Ignored unfilled stage scaffold at ${planPath}`)
      continue
    }

    includedStagePlanPaths.push(planPath)
    stageSections.push(toSyntheticStageSection(planPath, includedStagePlanPaths.length))
  }

  const readmeContext = extractReadmePlanContext(streamDir, streamId)
  const content = [
    `# Plan: ${readmeContext.streamName}`,
    "",
    "## Summary",
    "",
    readmeContext.summary,
    "",
    "## References",
    "",
    "## Stages",
    "",
    ...stageSections,
  ].join("\n")

  return {
    content,
    displayPath: `${join(streamDir, "stages")}/*/PLAN.md`,
    source: "stages",
    stagePlanPaths: includedStagePlanPaths,
    skippedStagePlanPaths,
    warnings,
  }
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
 * This validates the PLAN.md structure and batch/thread authoring model.
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

  const loadedPlan = loadWorkstreamPlan(repoRoot, streamId)
  if (!loadedPlan) {
    const planMdPath = getStreamPlanMdPath(repoRoot, streamId)
    errors.push({
      section: "File",
      message: `PLAN.md not found at ${planMdPath} and no stage-local plans were found under ${join(getWorkDir(repoRoot), streamId, "stages")}`,
    })
    return {
      success: false,
      streamDocument: null,
      tasksGenerated: [],
      errors,
      warnings,
    }
  }

  warnings.push(...loadedPlan.warnings)

  const streamDocument = parseStreamDocument(loadedPlan.content, errors)

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
    tasksGenerated: [],
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
    lines.push("Next: approve the plan to seed the execution hierarchy.")
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
