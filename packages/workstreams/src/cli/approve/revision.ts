/**
 * Approve CLI - Revision Approval Handler
 *
 * Handles revision approval workflow for adding new stages to existing workstreams.
 */

import { join } from "path"

import { checkOpenQuestions } from "../../lib/approval.ts"
import { loadWorkstreamHierarchyQueryResult } from "../../lib/hierarchy-query.ts"
import { parseStreamDocument } from "../../lib/stream-parser.ts"
import { getWorkDir } from "../../lib/repo.ts"
import { getResolvedStream } from "../../lib/index.ts"
import { initializeCanonicalExecutionStateFromPlan } from "../../lib/execution-state.ts"
import { loadWorkstreamPlan } from "../../lib/consolidate.ts"
import { ensureThreadWorkDocsForPlan } from "../../lib/thread-workdocs.ts"

import type { ApproveCliArgs } from "./utils.ts"

/**
 * Handle revision approval workflow
 *
 * Detects new stages in PLAN.md that don't have corresponding canonical hierarchy stages,
 * validates them, and refreshes the execution hierarchy directly from the revised plan.
 */
export function handleRevisionApproval(
  repoRoot: string,
  stream: ReturnType<typeof getResolvedStream>,
  cliArgs: ApproveCliArgs
): void {
  const workDir = getWorkDir(repoRoot)
  const streamDir = join(workDir, stream.id)
  const loadedPlan = loadWorkstreamPlan(repoRoot, stream.id)

  if (!loadedPlan) {
    console.error(`Error: PLAN.md not found for workstream at ${streamDir}`)
    process.exit(1)
  }

  const errors: any[] = []
  const doc = parseStreamDocument(loadedPlan.content, errors)

  if (!doc) {
    console.error(
      `Error: Failed to parse ${loadedPlan.displayPath}: ${errors.map((e) => e.message).join(", ")}`
    )
    process.exit(1)
  }

  // Step 2: Load existing canonical hierarchy state
  const existingHierarchy = loadWorkstreamHierarchyQueryResult(repoRoot, stream.id)
  const existingStageIds = new Set(existingHierarchy.stages.map((stage) => stage.number))

  // Step 3: Call detectNewStages() and error if no new stages found
  const newStageNumbers = doc.stages
    .map((stage) => stage.id)
    .filter((stageId) => !existingStageIds.has(stageId))
    .sort((left, right) => left - right)

  if (newStageNumbers.length === 0) {
    if (cliArgs.json) {
      console.log(
        JSON.stringify(
          {
            action: "blocked",
            target: "revision",
            reason: "no_new_stages",
            streamId: stream.id,
            streamName: stream.name,
          },
          null,
          2
        )
      )
    } else {
      console.error("Error: No new stages to approve")
    }
    process.exit(1)
  }

  // Step 4: Validate new stages have no open questions
  // Reuse checkOpenQuestions logic filtered to new stages
  const questionsResult = checkOpenQuestions(repoRoot, stream.id)

  if (questionsResult.hasOpenQuestions && !cliArgs.force) {
    // Filter questions to only new stages
    const newStageSet = new Set(newStageNumbers)
    const newStageQuestions = questionsResult.questions.filter((q) =>
      newStageSet.has(q.stage)
    )

    if (newStageQuestions.length > 0) {
      if (cliArgs.json) {
        console.log(
          JSON.stringify(
            {
              action: "blocked",
              target: "revision",
              reason: "open_questions_in_new_stages",
              streamId: stream.id,
              streamName: stream.name,
              openQuestions: newStageQuestions,
              openCount: newStageQuestions.length,
            },
            null,
            2
          )
        )
      } else {
        console.error(
          "Error: Cannot approve revision with open questions in new stages"
        )
        console.error("")
        console.error(
          `Found ${newStageQuestions.length} open question(s) in new stages:`
        )
        for (const q of newStageQuestions) {
          console.error(`  Stage ${q.stage} (${q.stageName}): ${q.question}`)
        }
        console.error("")
        console.error("Options:")
        console.error("  1. Resolve questions in PLAN.md (mark with [x])")
        console.error("  2. Use --force to approve anyway")
      }
      process.exit(1)
    }
  }

  // Step 5: Refresh the execution hierarchy from the revised plan
  const threadCount = initializeCanonicalExecutionStateFromPlan(repoRoot, stream.id, doc)
  const workDocsResult = ensureThreadWorkDocsForPlan(repoRoot, stream.id, doc)

  // Step 6: Count new threads introduced by the revision
  let newPlaceholderCount = 0
  const newStageSet = new Set(newStageNumbers)

  for (const stage of doc.stages) {
    if (newStageSet.has(stage.id)) {
      for (const batch of stage.batches) {
        newPlaceholderCount += batch.threads.length
      }
    }
  }

  // Step 7: Output summary
  if (cliArgs.json) {
    console.log(
      JSON.stringify(
        {
          action: "generated",
          target: "revision",
          streamId: stream.id,
          streamName: stream.name,
          existingStageCount: existingHierarchy.stages.length,
          newStageCount: newStageNumbers.length,
          newThreadCount: newPlaceholderCount,
          totalThreadCount: threadCount,
          newStages: newStageNumbers,
          workDocsCreated: workDocsResult.createdFiles.length,
          workDocsPreserved: workDocsResult.preservedFiles.length,
        },
        null,
        2
      )
    )
  } else {
    console.log(
      `Initialized execution hierarchy for ${newPlaceholderCount} new thread${newPlaceholderCount === 1 ? "" : "s"} (${threadCount} threads total)`
    )
    console.log("")
    console.log(
      `New stages: ${newStageNumbers.map((n) => `Stage ${n}`).join(", ")}`
    )
    console.log(
      `Thread WORK.md: ${workDocsResult.createdFiles.length} created, ${workDocsResult.preservedFiles.length} preserved`,
    )
  }
}
