/**
 * CLI: Prompt
 *
 * Generates execution prompts for agents with full thread context.
 */

import { join } from "path"
import { readFileSync, existsSync } from "fs"
import { getRepoRoot, getWorkDir } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { parseStreamDocument } from "../lib/stream-parser.ts"
import {
  getPromptContext,
  generateThreadPrompt,
  generateThreadPromptJson,
  savePromptToFile,
  type PromptContext,
} from "../lib/prompts.ts"

interface PromptCliArgs {
  repoRoot?: string
  streamId?: string
  threadId?: string
  stage?: string
  batch?: string
  json?: boolean
  noTests?: boolean
  noParallel?: boolean
}

function printHelp(): void {
  console.log(`
work prompt - Generate thread execution prompt for agents

Usage:
  work prompt --thread "01.01.01" [options]

Required:
  --thread, -t     Thread ID in "stage.batch.thread" format (e.g., "01.01.02")
  OR
  --stage, --batch Generate prompts for all threads in a batch
  OR
  --stage          Generate prompts for all threads in a stage
  (No args)        Generate prompts for ENTIRE workstream

Required (only if targeting specific thread):
  --thread         Thread ID

Optional Scope:
  --stage          Stage number
  --batch          Batch number

Optional:
  --stream, -s     Workstream ID or name (uses current if not specified)
  --repo-root, -r  Repository root (auto-detected if omitted)
  --json, -j       Output as JSON instead of markdown
  --no-tests       Exclude test requirements section
  --no-parallel    Exclude parallel threads section
  --help, -h       Show this help message

Description:
  Generates a comprehensive execution prompt for an agent to work on a specific
  thread. The prompt includes:
  - Thread identity/agent context from canonical thread query state when available
  - Thread summary and details from PLAN.md
  - Attached execution state and context for the thread
  - Stage definition and constitution
  - Parallel threads for awareness

Examples:
  work prompt --thread "01.01.01"
  work prompt --thread "01.01.02" --stream "001-my-feature"
  work prompt --thread "01.01.01" --json
  work prompt --stage 1 --batch 1
  work prompt --stage 1 --batch 1
`)
}

function parseCliArgs(argv: string[]): PromptCliArgs | null {
  const args = argv.slice(2)
  const parsed: Partial<PromptCliArgs> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--repo-root":
      case "-r":
        if (!next) {
          console.error("Error: --repo-root requires a value")
          return null
        }
        parsed.repoRoot = next
        i++
        break

      case "--stream":
      case "-s":
      case "--plan":
      case "-p":
        if (!next) {
          console.error("Error: --stream requires a value")
          return null
        }
        parsed.streamId = next
        i++
        break

      case "--thread":
      case "-t":
        if (!next) {
          console.error("Error: --thread requires a value")
          return null
        }
        parsed.threadId = next
        i++
        break

      case "--stage":
        if (!next) {
          console.error("Error: --stage requires a value")
          return null
        }
        parsed.stage = next
        i++
        break

      case "--batch":
        if (!next) {
          console.error("Error: --batch requires a value")
          return null
        }
        parsed.batch = next
        i++
        break

      case "--json":
      case "-j":
        parsed.json = true
        break

      case "--no-tests":
        parsed.noTests = true
        break

      case "--no-parallel":
        parsed.noParallel = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed as PromptCliArgs
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  // Validate arguments
  // If no arguments provided, we generate for the entire stream
  if (cliArgs.threadId && (cliArgs.stage || cliArgs.batch)) {
    console.warn("Warning: --thread provided, ignoring --stage/--batch")
  }

  // Auto-detect repo root if not provided
  let repoRoot: string
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  let index
  try {
    index = loadIndex(repoRoot)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  let stream
  try {
    stream = getResolvedStream(index, cliArgs.streamId)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  // Handle single thread
  if (cliArgs.threadId) {
    let context
    try {
      context = getPromptContext(repoRoot, stream.id, cliArgs.threadId)
    } catch (e) {
      console.error(`Error: ${(e as Error).message}`)
      process.exit(1)
    }

    if (cliArgs.json) {
      const json = generateThreadPromptJson(context)
      console.log(JSON.stringify(json, null, 2))
    } else {
      const prompt = generateThreadPrompt(context, {
        includeTests: !cliArgs.noTests,
        includeParallel: !cliArgs.noParallel,
      })
      savePromptToFile(repoRoot, context, prompt)
    }
    return
  }

  // Handle full stream or stage/batch generation
  if (!cliArgs.threadId) {
    // Parse CLI args for filtering
    const stageNum = cliArgs.stage ? parseInt(cliArgs.stage, 10) : undefined
    const batchNum = cliArgs.batch ? parseInt(cliArgs.batch, 10) : undefined

    if (stageNum !== undefined && isNaN(stageNum)) {
      console.error("Error: stage must be a number")
      process.exit(1)
    }
    if (batchNum !== undefined && isNaN(batchNum)) {
      console.error("Error: batch must be a number")
      process.exit(1)
    }

    // Load and parse PLAN.md
    const workDir = getWorkDir(repoRoot)
    const planPath = join(workDir, stream.id, "PLAN.md")

    if (!existsSync(planPath)) {
      console.error(`Error: PLAN.md not found at ${planPath}`)
      process.exit(1)
    }

    const planContent = readFileSync(planPath, "utf-8")
    const errors: any[] = []
    const doc = parseStreamDocument(planContent, errors)

    if (!doc) {
      console.error("Error parsing PLAN.md")
      process.exit(1)
    }

    // Determine which stages to process
    let stages = doc.stages
    if (stageNum !== undefined) {
      const stage = doc.stages.find((s) => s.id === stageNum)
      if (!stage) {
        console.error(`Error: Stage ${stageNum} not found`)
        process.exit(1)
      }
      stages = [stage]
    }

    const results: any[] = []
    let promptCount = 0

    for (const stage of stages) {
      // Determine which batches to process in this stage
      let batches = stage.batches

      if (batchNum !== undefined) {
        // Apply batch filter if specifically requested
        // Note: If running full stream (no stage arg), filtering by batch ID likely implies
        // "batch X of every stage", which is odd but consistent with args.
        // If running specific stage, it target "batch X of stage Y".
        const batch = stage.batches.find((b) => b.id === batchNum)
        if (batch) {
          batches = [batch]
        } else if (stageNum !== undefined) {
          // If specific stage requested and batch missing, error
          console.error(
            `Error: Batch ${batchNum} not found in stage ${stage.id}`,
          )
          process.exit(1)
        } else {
          // If generic run and this stage allows that batch, fine. If not, skip.
          batches = []
        }
      }

      for (const batch of batches) {
        for (const thread of batch.threads) {
          const threadIdStr = `${stage.id.toString().padStart(2, "0")}.${batch.id.toString().padStart(2, "0")}.${thread.id.toString().padStart(2, "0")}`

          try {
            const context = getPromptContext(repoRoot, stream.id, threadIdStr)

            if (cliArgs.json) {
              results.push(generateThreadPromptJson(context))
            } else {
              const prompt = generateThreadPrompt(context, {
                includeTests: !cliArgs.noTests,
                includeParallel: !cliArgs.noParallel,
              })
              savePromptToFile(repoRoot, context, prompt)
            }
            promptCount++
          } catch (e) {
            console.error(
              `Error generating prompt for ${threadIdStr}: ${(e as Error).message}`,
            )
          }
        }
      }
    }

    if (cliArgs.json) {
      console.log(JSON.stringify(results, null, 2))
    } else {
      console.log(`Generated ${promptCount} prompts.`)
    }
  }
}

// Run if called directly
if (import.meta.main) {
  await main()
}
