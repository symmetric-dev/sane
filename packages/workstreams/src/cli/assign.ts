/**
 * CLI: Assign Agents to Threads
 *
 * Thread mutation is canonical.
 */

import { getRepoRoot } from "../lib/repo.ts"
import { loadIndex, getResolvedStream } from "../lib/index.ts"
import { loadAgentsConfig, getAgentYaml } from "../lib/agents-yaml.ts"
import { queryThreadsForWorkstream } from "../lib/hierarchy-query.ts"
import { mutateThreadExecution } from "../lib/update.ts"

interface AssignCliArgs {
  repoRoot?: string
  streamId?: string
  thread?: string
  agent?: string
  list: boolean
  clear: boolean
  json: boolean
}

function toPublicThreadAssignmentView(thread: ReturnType<typeof queryThreadsForWorkstream>[number]) {
  return {
    threadId: thread.threadId,
    threadName: thread.threadName,
    stageId: thread.stageId,
    stageName: thread.stageName,
    batchId: thread.batchId,
    batchName: thread.batchName,
    aggregateStatus: thread.aggregateStatus,
    assignedAgent: thread.assignedAgent,
    itemCount: thread.itemCount,
    ...(thread.breadcrumb ? { breadcrumb: thread.breadcrumb } : {}),
    ...(thread.report ? { report: thread.report } : {}),
  }
}

function printHelp(): void {
  console.log(`
work assign - Assign agents to threads

Usage:
  work assign --thread <threadId> --agent <agent>
  work assign --thread <threadId> --clear
  work assign --list

Options:
  --repo-root, -r    Repository root (auto-detected if omitted)
  --stream, -s       Workstream ID or name (uses current if not specified)
  --thread, -th      Thread ID (e.g., "01.01.01")
  --agent, -a        Agent name to assign
  --list             List assigned threads (thread-first view)
  --clear            Remove agent assignment from the resolved thread
  --json, -j         Output as JSON
  --help, -h         Show this help message

Description:
  Assigns agents to execution threads. Agents must be defined first
  in agents.yaml.

Examples:
  # Assign an agent to a thread
  work assign --thread "01.01.01" --agent "backend-expert"

  # List assigned threads
  work assign --list

  # Remove an assignment
  work assign --thread "01.01.01" --clear
`)
}

function parseCliArgs(argv: string[]): AssignCliArgs | null {
  const rawArgs = argv.slice(2)
  const args = rawArgs[0] === "assign" ? rawArgs.slice(1) : rawArgs
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

      default:
        console.error(`Error: Unknown argument: ${arg}`)
        return null
    }
  }

  return parsed
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
      console.log(
        JSON.stringify(
          {
            streamId: stream.id,
            threads: assignedThreads.map(toPublicThreadAssignmentView),
          },
          null,
          2,
        ),
      )
    } else if (assignedThreads.length === 0) {
      console.log(`No threads have agent assignments in workstream "${stream.name}"`)
    } else {
      console.log(`Threads with agent assignments in "${stream.name}":`)
      console.log("")

      for (const thread of assignedThreads) {
        console.log(`  ${thread.threadId} -> ${thread.assignedAgent}`)
        console.log(`    ${thread.threadName}`)
        console.log(`    items: ${thread.itemCount}`)
        console.log("")
      }
    }
    return
  }

  if (cliArgs.clear && cliArgs.agent) {
    console.error("Error: --clear cannot be combined with --agent")
    process.exit(1)
  }

  if (cliArgs.clear && !cliArgs.thread) {
    console.error("Error: --clear requires --thread")
    console.error("\nRun with --help for usage information.")
    process.exit(1)
  }

  if (!cliArgs.clear && (!cliArgs.thread || !cliArgs.agent)) {
    console.error("Error: --agent and --thread are required")
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

  let result
  try {
    result = await mutateThreadExecution({
      repoRoot,
      stream,
      threadId: cliArgs.thread!,
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
          threadId: cliArgs.thread,
          ...(!cliArgs.clear && cliArgs.agent ? { agent: cliArgs.agent } : {}),
          [cliArgs.clear ? "clearedCount" : "assignedCount"]: result.updated ? 1 : 0,
        },
        null,
        2,
      ),
    )
    return
  }

  if (cliArgs.clear) {
    console.log(`Cleared agent assignment from thread ${cliArgs.thread}`)
    return
  }

  console.log(`Assigned "${cliArgs.agent}" to thread ${cliArgs.thread}`)
}

if (import.meta.main) {
  await main()
}
