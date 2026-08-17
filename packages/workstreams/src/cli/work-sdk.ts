import { main as batchExecutorMain } from "./batch-executor.ts"
import { main as batchEventsMain } from "./batch-events.ts"
import { main as superviseMain } from "./supervise.ts"

export type WorkSdkCommand = "supervise" | "batch-executor" | "batch-events"

function printHelp(): void {
  console.log(`
work-sdk - Experimental SDK-backed workstream execution CLI

Usage:
  work-sdk supervise [options]
  work-sdk batch-executor --batch-id SS.BB --execution-backend sdk [options]
  work-sdk batch-events --batch SS.BB [options]

Commands:
  supervise       Reuse supervision orchestration with the SDK backend
  batch-executor  Internal detached SDK batch worker
  batch-events    Read or follow the detached SDK activity journal

Run 'work-sdk supervise --help' or 'work-sdk batch-executor --help' for details.
`)
}

export function parseWorkSdkCommand(argv: string[]): {
  command?: WorkSdkCommand
  args: string[]
  help: boolean
} {
  const args = argv.slice(2)
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { args: [], help: true }
  }

  const command = args[0]
  if (command !== "supervise" && command !== "batch-executor" && command !== "batch-events") {
    return { args, help: false }
  }

  return { command, args: args.slice(1), help: false }
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const parsed = parseWorkSdkCommand(argv)
  if (parsed.help) {
    printHelp()
    return 0
  }

  if (!parsed.command) {
    console.error(`Error: unknown work-sdk command "${argv[2] ?? ""}"`)
    console.error("Run 'work-sdk --help' for usage information.")
    return 1
  }

  const subcommandArgv = [argv[0] ?? "bun", `work-sdk-${parsed.command}`, ...parsed.args]
  if (parsed.command === "batch-executor") {
    return batchExecutorMain(subcommandArgv)
  }

  if (parsed.command === "batch-events") {
    return batchEventsMain(subcommandArgv)
  }

  try {
    await superviseMain(subcommandArgv, { executionBackend: "sdk" })
    return 0
  } catch (error) {
    // supervise retains its existing throw-on-timeout/failure semantics. The
    // separate entry point converts that into the worker-style exit code.
    if (error instanceof Error && error.message.length > 0) {
      console.error(error.message)
    }
    return 1
  }
}
