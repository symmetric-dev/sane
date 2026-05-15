/**
 * Approve CLI - Revision Approval Handler
 *
 * Handles revision approval workflow for adding new stages to existing workstreams.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"

import { approveTasks, checkOpenQuestions } from "../../lib/approval.ts"
import { detectNewStages } from "../../lib/tasks-md.ts"
import { parseStreamDocument } from "../../lib/stream-parser.ts"
import { getWorkDir } from "../../lib/repo.ts"
import { getResolvedStream } from "../../lib/index.ts"
import { getTasks } from "../../lib/tasks.ts"
import { generateAllPrompts } from "../../lib/prompts.ts"
import { syncCompatibilityTasksFromPlan } from "../../lib/task-compatibility.ts"

import type { ApproveCliArgs } from "./utils.ts"

/**
 * Handle revision approval workflow
 *
 * Detects new stages in PLAN.md that don't have corresponding compatibility tasks,
 * validates them, and refreshes execution state directly from the revised plan.
 */
export function handleRevisionApproval(
  repoRoot: string,
  stream: ReturnType<typeof getResolvedStream>,
  cliArgs: ApproveCliArgs
): void {
  const workDir = getWorkDir(repoRoot)
  const streamDir = join(workDir, stream.id)
  const planMdPath = join(streamDir, "PLAN.md")
  // Step 1: Load PLAN.md and parse with parseStreamDocument
  if (!existsSync(planMdPath)) {
    console.error(`Error: PLAN.md not found at ${planMdPath}`)
    process.exit(1)
  }

  const planContent = readFileSync(planMdPath, "utf-8")
  const errors: any[] = []
  const doc = parseStreamDocument(planContent, errors)

  if (!doc) {
    console.error(
      `Error: Failed to parse PLAN.md: ${errors.map((e) => e.message).join(", ")}`
    )
    process.exit(1)
  }

  // Step 2: Load existing tasks from tasks.json
  const existingTasks = getTasks(repoRoot, stream.id)

  // Step 3: Call detectNewStages() and error if no new stages found
  const newStageNumbers = detectNewStages(doc, existingTasks)

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

  // Step 5: Refresh compatibility execution state from the revised plan
  const tasks = syncCompatibilityTasksFromPlan(repoRoot, stream.id, doc)
  approveTasks(repoRoot, stream.id)
  const promptsResult = generateAllPrompts(repoRoot, stream.id)

  // Step 6: Count new compatibility tasks
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
          existingTaskCount: existingTasks.length,
          newStageCount: newStageNumbers.length,
          newPlaceholderCount,
          totalTaskCount: tasks.length,
          newStages: newStageNumbers,
          promptsGenerated: promptsResult.generatedFiles.length,
          promptThreadCount: promptsResult.totalThreads,
          promptErrors: promptsResult.errors,
        },
        null,
        2
      )
    )
  } else {
    console.log(
      `Initialized execution state for ${newPlaceholderCount} new thread${newPlaceholderCount === 1 ? "" : "s"} (${tasks.length} compatibility tasks total)`
    )
    console.log("")
    console.log(
      `New stages: ${newStageNumbers.map((n) => `Stage ${n}`).join(", ")}`
    )
    console.log(
      `Prompts: ${promptsResult.generatedFiles.length}/${promptsResult.totalThreads} generated`,
    )
  }
}
