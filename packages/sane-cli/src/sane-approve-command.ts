import { executeCliCommand, runCliCommand, type CliRuntime } from "./cli-command.ts"
export const runSaneApproveCommand = (args: string[], runtime?: CliRuntime) => executeCliCommand(["approve", ...args], runtime)
export const runCli = (args: string[]) => runCliCommand(["approve", ...args])
if (import.meta.main) process.exitCode = await runCli(Bun.argv.slice(2))
