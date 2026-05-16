import { existsSync, readFileSync } from "fs"
import { relative } from "path"

import { loadWorkstreamPlan } from "./consolidate.ts"
import { parseStreamDocument } from "./stream-parser.ts"
import { getThreadWorkMdPath, validateThreadWorkMd } from "./thread-workdocs.ts"
import type { ConsolidateError } from "./types.ts"

export interface WorkValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export function validateWorkstreamThreadWorkDocs(
  repoRoot: string,
  streamId: string,
): WorkValidationResult {
  const loadedPlan = loadWorkstreamPlan(repoRoot, streamId)
  if (!loadedPlan) {
    return {
      valid: false,
      errors: [
        `PLAN.md not found for workstream "${streamId}". Create stage-local plans before validating WORK.md files.`,
      ],
      warnings: [],
    }
  }

  const parseErrors: ConsolidateError[] = []
  const doc = parseStreamDocument(loadedPlan.content, parseErrors)
  if (!doc) {
    return {
      valid: false,
      errors: parseErrors.map((error) => `[${error.section || "?"}] ${error.message}`),
      warnings: [...loadedPlan.warnings],
    }
  }

  const errors: string[] = []

  for (const stage of doc.stages) {
    for (const batch of stage.batches) {
      for (const thread of batch.threads) {
        const threadId = `${stage.id.toString().padStart(2, "0")}.${batch.id.toString().padStart(2, "0")}.${thread.id.toString().padStart(2, "0")}`
        const workMdPath = getThreadWorkMdPath(repoRoot, streamId, threadId)
        const relativePath = relative(repoRoot, workMdPath)

        if (!existsSync(workMdPath)) {
          errors.push(`${relativePath}: missing WORK.md for planned thread ${threadId}`)
          continue
        }

        const validation = validateThreadWorkMd(readFileSync(workMdPath, "utf-8"))
        for (const error of validation.errors) {
          errors.push(`${relativePath}: [${error.section}] ${error.message}`)
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [...loadedPlan.warnings],
  }
}
