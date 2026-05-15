/**
 * CLI: Assign Agents to Threads
 *
 * Thread mutation is canonical.
 * Compatibility task targeting is an explicit alias for the owning thread.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { getTaskById } from "../lib/tasks.ts"
import { loadAgentsConfig, getAgentYaml } from "../lib/agents-yaml.ts"
import { queryThreadsForWorkstream } from "../lib/hierarchy-query.ts"
import { mutateThreadTasks } from "../lib/update.ts"

interface AssignCliArgs {
  repoRoot?: string
  streamId?: string
  task?: string
  thread?: string
  agent?: string
  list: boolean
  clear: boolean
  json: boolean
}

function printHelp(): void {
  console.log(`
work assign - Assign agents to threads

Usage:
  work assign --thread <threadId> --agent <agent>
  work assign --task <taskId> --agent <agent>
  work assign --thread <threadId> --clear
  work assign --task <taskId> --clear
  work assign --list

Options:
  --repo-root, -r    Repository root (auto-detected if omitted)
  --stream, -s       Workstream ID or name (uses current if not specified)
  --thread, -th      Thread ID (e.g., "01.01.01") (canonical)
  --task, -t         Compatibility task ID alias (e.g., "01.01.02.03")
  --agent, -a        Agent name to assign
  --list             List assigned threads (thread-first view)
  --clear            Remove agent assignment from the resolved thread
  --json, -j         Output as JSON
  --help, -h         Show this help message

Description:
  Assigns agents to execution threads. Agents must be defined first
  in agents.yaml. tasks.json remains a compatibility projection.

Examples:
  # Assign an agent to a thread
  work assign --thread "01.01.01" --agent "backend-expert"

  # Compatibility alias: resolve task -> owning thread -> assign
  work assign --task "01.01.02.03" --agent "backend-orm-expert"

  # List assigned threads
  work assign --list

  # Remove an assignment
  work assign --thread "01.01.01" --clear
`)
}

function parseCliArgs(argv: string[]): AssignCliArgs | null {
  const args = argv.slice(2)
  const parsed: AssignCliArgs = { list: false, clear: false, json: false }

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

      case "--task":
      case "-t":
        if (!next) {
          console.error("Error: --task requires a value (e.g., '01.01.02.03')")
          return null
        }
        parsed.task = next
        i++
        break

      case "--thread":
      case "-th":
        if (!next) {
          console.error("Error: --thread requires a value (e.g., '01.01.01')")
          return null
        }
        parsed.thread = next
        i++
        break

      case "--agent":
      case "-a":
        if (!next) {
          console.error("Error: --agent requires a value")
          return null
        }
        parsed.agent = next
        i++
        break

      case "--list":
        parsed.list = true
        break

      case "--clear":
        parsed.clear = true
        break

      case "--json":
      case "-j":
        parsed.json = true
        break

      case "--help":
      case "-h":
        printHelp()
        process.exit(0)
    }
  }

  return parsed
}

function resolveTargetThread(args: { repoRoot: string; streamId: string; task?: string; thread?: string }): {
  threadId: string
  compatibilityTaskId?: string
} {
  if (args.thread) {
    return { threadId: args.thread }
  }

  const task = getTaskById(args.repoRoot, args.streamId, args.task!)
  if (!task) {
    throw new Error(`Task "${args.task}" not found`)
  }

  return {
    threadId: task.id.split(".").slice(0, 3).join("."),
    compatibilityTaskId: task.id,
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const cliArgs = parseCliArgs(argv)
  if (!cliArgs) {
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

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

  if (cliArgs.list) {
    const assignedThreads = queryThreadsForWorkstream(repoRoot, stream.id).filter(
      (thread) => thread.assignedAgent,
    )

    if (cliArgs.json) {
      console.log(JSON.stringify({ streamId: stream.id, threads: assignedThreads }, null, 2))
    } else if (assignedThreads.length === 0) {
      console.log(`No threads have agent assignments in workstream "${stream.name}"`)
    } else {
      console.log(`Threads with agent assignments in "${stream.name}":`)
      console.log("")

      for (const thread of assignedThreads) {
        console.log(`  ${thread.threadId} -> ${thread.assignedAgent}`)
        console.log(`    ${thread.threadName}`)
        if (thread.representativeTaskId) {
          console.log(`    compatibility task: ${thread.representativeTaskId}`)
        }
        console.log("")
      }
    }
    return
  }

  if (cliArgs.clear && cliArgs.agent) {
    console.error("Error: --clear cannot be combined with --agent")
    process.exit(1)
  }

  if (cliArgs.clear && !cliArgs.task && !cliArgs.thread) {
    console.error("Error: --clear requires --task or --thread")
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  if (!cliArgs.clear && ((!cliArgs.task && !cliArgs.thread) || !cliArgs.agent)) {
    console.error("Error: --agent and either --thread or --task are required")
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  if (!cliArgs.clear) {
    const agentsConfig = loadAgentsConfig(repoRoot)
    if (agentsConfig) {
      const agentDef = getAgentYaml(agentsConfig, cliArgs.agent!)
      if (!agentDef) {
        console.error(`Error: Agent "${cliArgs.agent}" is not defined`)
        console.error("Define it in agents.yaml first.")
        process.exit(1)
      }
    }
  }

  let target
  try {
    target = resolveTargetThread({
      repoRoot,
      streamId: stream.id,
      task: cliArgs.task,
      thread: cliArgs.thread,
    })
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }

  let result
  try {
    result = await mutateThreadTasks({
      repoRoot,
      stream,
      threadId: target.threadId,
      assigned_agent: cliArgs.clear ? "" : cliArgs.agent,
    })
  } catch (e) {
    console.error(`Error: ${(e as Error).message}`)
    process.exit(1)
  }

  if (cliArgs.json) {
    console.log(
      JSON.stringify(
        {
          action: cliArgs.clear ? "cleared" : "assigned",
          streamId: stream.id,
          threadId: target.threadId,
          ...(target.compatibilityTaskId ? { compatibilityTaskId: target.compatibilityTaskId } : {}),
          ...(!cliArgs.clear && cliArgs.agent ? { agent: cliArgs.agent } : {}),
          [cliArgs.clear ? "clearedCount" : "assignedCount"]: result.count,
        },
        null,
        2,
      ),
    )
    return
  }

  if (cliArgs.clear) {
    console.log(
      target.compatibilityTaskId
        ? `Cleared agent assignment from thread ${target.threadId} via compatibility task ${target.compatibilityTaskId}`
        : `Cleared agent assignment from thread ${target.threadId}`,
    )
    return
  }

  console.log(
    target.compatibilityTaskId
      ? `Assigned "${cliArgs.agent}" to thread ${target.threadId} via compatibility task ${target.compatibilityTaskId}`
      : `Assigned "${cliArgs.agent}" to thread ${target.threadId}`,
  )
}

if (import.meta.main) {
  await main()
}
