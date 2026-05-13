/**
 * CLI: Tasks
 *
 * Manage TASKS.md generation and serialization.
 *
 * Commands:
 *   work tasks generate   - Create TASKS.md from PLAN.md or existing tasks.json
 *   work tasks serialize  - Convert TASKS.md to tasks.json and delete TASKS.md
 */

import { readFileSync, existsSync, unlinkSync } from "fs"
import { join } from "path"
import { getRepoRoot, getWorkDir } from "../lib/repo.ts"
import { loadIndex, getCurrentStreamId, getStream, atomicWriteFile } from "../lib/index.ts"
import { getStreamPlanMdPath } from "../lib/consolidate.ts"
import { parseStreamDocument } from "../lib/stream-parser.ts"
import { generateTasksMdFromPlan, generateTasksMdFromTasks, parseTasksMd } from "../lib/tasks-md.ts"
import { getTasks, readTasksFile, replaceTasks } from "../lib/tasks.ts"
import { generateAllPrompts } from "../lib/prompts.ts"
import { hydrateLegacyFilesystemStateToSqliteSync } from "../lib/storage-adapter.ts"

interface TasksCliArgs {
  command: "generate" | "serialize"
  streamId?: string
  repoRoot?: string
}

function printHelp(): void {
  console.log(`
work tasks - Manage TASKS.md intermediate file

Usage:
  work tasks <command> [options]

Commands:
  generate    Create TASKS.md from PLAN.md (or existing tasks.json)
  serialize   Convert TASKS.md to tasks.json (updates/adds tasks)

Options:
  --stream, -s <id>   Workstream ID or name (defaults to current)
  --repo-root <path>  Repository root (auto-detected)
  --help, -h          Show this help message

Workflow:
  1. work tasks generate    -> Creates TASKS.md
  2. (Edit TASKS.md)        -> Add/Edit tasks in Markdown
  3. work tasks serialize   -> Updates tasks.json, deletes TASKS.md
`)
}

function parseCliArgs(argv: string[]): TasksCliArgs | null {
  const args = argv.slice(2)

  if (args.length === 0) return null

  const command = args[0]
  if (command !== "generate" && command !== "serialize") {
    if (command === "--help" || command === "-h") {
      printHelp()
      process.exit(0)
    }
    console.error(`Error: Unknown command "${command}". Expected "generate" or "serialize".`)
    return null
  }

  const parsed: Partial<TasksCliArgs> = { command }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]

    switch (arg) {
      case "--stream":
      case "-s":
        if (!next) {
          console.error("Error: --stream requires a value")
          return null
        }
        parsed.streamId = next
        i++
        break

      case "--repo-root":
        if (!next) {
          console.error("Error: --repo-root requires a value")
          return null
        }
        parsed.repoRoot = next
        i++
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed as TasksCliArgs
}

export function main(argv: string[] = process.argv): void {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    printHelp()
    process.exit(1)
  }

  let repoRoot: string
  try {
    repoRoot = cliArgs.repoRoot ?? getRepoRoot()
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }

  try {
    const index = loadIndex(repoRoot)
    const streamIdRaw = cliArgs.streamId || getCurrentStreamId(index)

    if (!streamIdRaw) {
      console.error("Error: No workstream specified and no current workstream set.")
      console.error("Use --stream <id> or set a current workstream.")
      process.exit(1)
    }

    const stream = getStream(index, streamIdRaw)
    const workDir = getWorkDir(repoRoot)
    const streamDir = join(workDir, stream.id)
    const tasksMdPath = join(streamDir, "TASKS.md")
    const tasksJsonPath = join(streamDir, "tasks.json")

    if (cliArgs.command === "generate") {
      // GENERATE TASKS.md

      // Check if TASKS.md already exists
      if (existsSync(tasksMdPath)) {
        console.error(`Error: TASKS.md already exists at ${tasksMdPath}`)
        console.error("Please serialize or delete it before generating a new one.")
        process.exit(1)
      }

      // Check if tasks.json exists and has tasks
      const existingTasks = getTasks(repoRoot, stream.id)

      let content: string
      if (existingTasks.length > 0) {
        console.log(`Generating TASKS.md from ${existingTasks.length} existing tasks...`)
        content = generateTasksMdFromTasks(stream.name, existingTasks)
      } else {
        // Generate from PLAN.md
        console.log("Generating TASKS.md from PLAN.md structure...")
        const planPath = getStreamPlanMdPath(repoRoot, stream.id)
        if (!existsSync(planPath)) {
          console.error(`Error: PLAN.md not found at ${planPath}`)
          process.exit(1)
        }

        const planContent = readFileSync(planPath, "utf-8")
        const errors: any[] = []
        const doc = parseStreamDocument(planContent, errors)

        if (!doc) {
          console.error("Error parsing PLAN.md:")
          errors.forEach(e => console.error(`- ${e.message}`))
          process.exit(1)
        }

        content = generateTasksMdFromPlan(stream.name, doc)
      }

      atomicWriteFile(tasksMdPath, content)
      console.log(`Created: ${tasksMdPath}`)
      console.log("Edit this file to define your tasks, then run 'work tasks serialize'.")

    } else if (cliArgs.command === "serialize") {
      // SERIALIZE TASKS.md -> tasks.json

      if (!existsSync(tasksMdPath)) {
        console.error(`Error: TASKS.md not found at ${tasksMdPath}`)
        console.error("Run 'work tasks generate' first.")
        process.exit(1)
      }

      const content = readFileSync(tasksMdPath, "utf-8")
      const result = parseTasksMd(content, stream.id)

      if (result.errors.length > 0) {
        console.error("Error parsing TASKS.md:")
        result.errors.forEach(e => console.error(`- ${e}`))
        console.error("Please fix the errors in TASKS.md and try again.")
        process.exit(1)
      }

      const newTasks = result.tasks
      console.log(`Parsed ${newTasks.length} tasks from TASKS.md`)

      // Merge with existing tasks? 
      // The strategy is to overwrite tasks.json with what's in TASKS.md, 
      // but preserving created_at/updated_at if IDs match?

      const existingTasks = readTasksFile(repoRoot, stream.id)?.tasks ?? []
      const existingMap = new Map(existingTasks.map(t => [t.id, t]))

      const mergedTasks = newTasks.map(newTask => {
        const existing = existingMap.get(newTask.id)
        if (existing) {
          // Preserve timestamps if not updated, or just update updated_at?
          // If status changed, update updated_at.
          // For now, we take the new task but keep created_at from existing.
          return {
            ...newTask,
            created_at: existing.created_at,
            // updated_at is already set to now() in parseTasksMd
            // Preserve fields that are not in TASKS.md (assigned_agent, breadcrumb, etc.)
            // For report: use newTask.report if present (parsed from TASKS.md), 
            // otherwise preserve existing.report
            assigned_agent: existing.assigned_agent,
            breadcrumb: existing.breadcrumb,
            report: newTask.report ?? existing.report
          }
        }
        return newTask
      })

      replaceTasks(repoRoot, stream.id, mergedTasks)
      hydrateLegacyFilesystemStateToSqliteSync({
        repoRoot,
        streamId: stream.id,
        projectLegacyRuntimeCompatibilityArtifacts: true,
      })
      console.log(`Updated: ${tasksJsonPath}`)

      const promptsResult = generateAllPrompts(repoRoot, stream.id)
      console.log(
        `Prompts: ${promptsResult.generatedFiles.length}/${promptsResult.totalThreads} generated`
      )
      if (!promptsResult.success) {
        console.log("Warning: Some prompts failed to generate:")
        for (const err of promptsResult.errors.slice(0, 3)) {
          console.log(`- ${err}`)
        }
        if (promptsResult.errors.length > 3) {
          console.log(`- ... and ${promptsResult.errors.length - 3} more errors`)
        }
      }

      unlinkSync(tasksMdPath)
      console.log("Deleted TASKS.md")
    }

  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }
}

// Run if called directly
if (import.meta.main) {
  main()
}
